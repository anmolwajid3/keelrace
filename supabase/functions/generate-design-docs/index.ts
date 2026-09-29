// FR-1.1 + FR-1.2
// Rejects generation if the RequirementSet is not locked (server-side gate).
// Produces exactly one HLD, one LLD per HLD component marked needs_detail,
// and DecisionRationale rows citing real requirement ids. Never overwrites --
// always a new version.
import { corsHeaders, errorResponse, json, userClient, callOpenRouter } from "../_shared/lib.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { requirement_set_id } = await req.json();
    if (!requirement_set_id) return errorResponse("requirement_set_id is required");

    const supabase = userClient(req);

    const { data: reqSet, error: rsErr } = await supabase
      .from("requirement_sets")
      .select("*")
      .eq("id", requirement_set_id)
      .single();
    if (rsErr || !reqSet) return errorResponse("RequirementSet not found", 404);
    const project_id = reqSet.project_id;

    // --- Gate: reject non-locked sets outright, no partial document ---
    if (reqSet.status !== "locked") {
      return errorResponse(
        `RequirementSet is '${reqSet.status}', not 'locked'. Generation rejected.`,
        409,
      );
    }

    const { data: requirements, error: reqErr } = await supabase
      .from("requirements")
      .select("id, ref_code, title, body")
      .eq("requirement_set_id", requirement_set_id);
    if (reqErr) throw reqErr;
    if (!requirements?.length) return errorResponse("RequirementSet has no requirements", 422);

    // Hash of the current requirements' content, in a stable order -- lets
    // the client detect "this is the exact same input as the prior HLD"
    // and confirm before creating a version that's identical in substance.
    // Must match the client-side computation in RequirementsTab.jsx exactly
    // (same field order, same separator, same sort) or the comparison is
    // meaningless.
    const requirementsHash = await hashRequirements(requirements);

    // Determine next version number for this requirement_set's HLD
    const { data: existingDocs } = await supabase
      .from("design_documents")
      .select("id, type, version")
      .eq("requirement_set_id", requirement_set_id)
      .order("version", { ascending: false });

    const priorHld = existingDocs?.find((d) => d.type === "HLD");
    const nextVersion = (priorHld?.version ?? 0) + 1;

    // Fetch the prior HLD's components (if any) so the LLM can carry
    // forward stable family_keys for components it judges unchanged,
    // instead of every regeneration minting entirely fresh identities.
    let priorComponents: { family_key: string; name: string; description: string }[] = [];
    if (priorHld) {
      const { data: pc } = await supabase
        .from("components")
        .select("family_key, name, description")
        .eq("hld_document_id", priorHld.id);
      priorComponents = pc ?? [];
    }

    // --- LLM call: produce HLD structure + components + decisions ---
    const priorComponentsBlock = priorComponents.length
      ? `\nThe PREVIOUS version of this HLD had these components:
${priorComponents.map((c) => `- family_key "${c.family_key}": ${c.name} -- ${c.description}`).join("\n")}
For each component in your output, if it is the same real-world component as one above (even if renamed
or its description changed), set "matched_family_key" to that exact family_key string. If it is new, omit
"matched_family_key" entirely. Do not guess a match if you're not reasonably confident -- an incorrect
match is worse than treating a component as new; a human will review this either way.`
      : "";

    let acceptedDrivers = [];
    let selectedCandidate = null;
    {
      const dRes = await supabase
        .from("architectural_drivers")
        .select("title, quality_attribute, stimulus, environment, response, response_measure, tactic, tactic_element")
        .eq("project_id", project_id)
        .eq("status", "accepted");
      if (!dRes.error) acceptedDrivers = dRes.data ?? [];
      const cRes = await supabase
        .from("architecture_candidates")
        .select("id, name, summary, optimizes, sacrifices, components")
        .eq("project_id", project_id)
        .eq("status", "selected")
        .limit(1);
      if (!cRes.error) selectedCandidate = cRes.data?.[0] ?? null;
    }
    const driversBlock = acceptedDrivers?.length
      ? `\nAccepted architectural drivers (the architect confirmed these; use them as the primary decomposition input):\n${
        acceptedDrivers.map((d) =>
          `- [${d.quality_attribute}] ${d.title}. Stimulus: ${d.stimulus || "—"}. Environment: ${d.environment || "—"}. Response: ${d.response || "—"}. Measure: ${d.response_measure || "—"}. Tactic: ${d.tactic || "—"} on ${d.tactic_element || "—"}.`
        ).join("\n")
      }`
      : "";
    const candidateBlock = selectedCandidate
      ? `\nThe architect selected this candidate as the baseline (still generate a new official HLD version; do not invent a competing split):\nName: ${selectedCandidate.name}\n${selectedCandidate.summary || ""}\nOptimizes: ${selectedCandidate.optimizes || ""}\nSacrifices: ${selectedCandidate.sacrifices || ""}\nComponents: ${
        JSON.stringify(selectedCandidate.components ?? [])
      }`
      : "\nNo candidate is selected. Propose a structure from the requirements and accepted drivers only. Do not claim it was chosen.";

    const prompt = `You are generating a High-Level Design (HLD) from a locked, approved set of requirements.
The architect remains the authority. You fill a draft document; approval is a later human gate.
Requirements:
${requirements.map((r) => `- ${r.ref_code}: ${r.title}\n  ${r.body}`).join("\n")}
${driversBlock}
${candidateBlock}
${priorComponentsBlock}

Return ONLY valid JSON with this exact shape:
{
  "hld": {
    "summary": string,
    "components": [
      { "name": string, "description": string, "needs_detail": boolean, "matched_family_key": string | null }
    ]
  },
  "decisions": [
    {
      "decision_point": string,
      "chosen_option": string,
      "alternatives_considered": [{ "option": string, "rejection_reason": string }],
      "driving_requirement_ref_codes": string[],  // must reference real ref_codes above
      "risk_level": "low" | "medium" | "high"
    }
  ],
  "llds": [
    {
      "component_name": string, // must match an hld component with needs_detail=true
      "content": { "summary": string, "interfaces": string[], "data_model": string }
    }
  ]
}`;

    const raw = await callOpenRouter(
      [
        { role: "system", content: "You output strictly valid JSON, no markdown fences, no prose." },
        { role: "user", content: prompt },
      ],
      { json: true },
    );
    const parsed = JSON.parse(raw);

    // --- Everything from here on writes to the database. There's no single
    // transaction wrapping these calls (they go through PostgREST, not a
    // raw connection), so if any insert fails partway through, we
    // compensate by deleting everything already inserted in this run,
    // rather than leaving an orphaned draft HLD with no LLDs/decisions
    // behind. writeState tracks what to clean up. ---
    const writeState = { hldDocId: null as string | null, componentIds: [] as string[], lldDocIds: [] as string[] };

    try {
      // Insert HLD (new row, never overwrite prior version). Superseding the
      // prior approved HLD happens later, at approval time (inside
      // approve_design_document), NOT here -- superseding it now would leave
      // a window with zero currently-approved HLDs while this draft is still
      // under review.
      const { data: hldDoc, error: hldErr } = await supabase
        .from("design_documents")
        .insert({
          requirement_set_id,
          type: "HLD",
          version: nextVersion,
          status: "draft",
          content: parsed.hld,
          generated_by_model: "openrouter:anthropic/claude-sonnet-4.5",
          requirements_hash: requirementsHash,
        })
        .select()
        .single();
      if (hldErr) throw hldErr;
      writeState.hldDocId = hldDoc.id;

      // Insert a real components row per HLD component, carrying forward
      // family_key when the LLM matched one, minting a fresh sequential one
      // (via the per-project counter, safe under concurrency) otherwise.
      const priorFamilyKeys = new Set(priorComponents.map((c) => c.family_key));
      const matchedFamilyKeys = new Set<string>();
      const componentRows: any[] = [];
      for (const comp of parsed.hld.components ?? []) {
        const claimedKey = comp.matched_family_key;
        let familyKey: string;
        if (claimedKey && priorFamilyKeys.has(claimedKey)) {
          familyKey = claimedKey;
          matchedFamilyKeys.add(claimedKey);
        } else {
          const { data: minted, error: keyErr } = await supabase.rpc("next_component_key", { p_project_id: project_id });
          if (keyErr) throw keyErr;
          familyKey = minted;
        }

        const { data: c, error: cErr } = await supabase
          .from("components")
          .insert({
            project_id,
            hld_document_id: hldDoc.id,
            name: comp.name,
            description: comp.description,
            needs_detail: !!comp.needs_detail,
            family_key: familyKey,
          })
          .select()
          .single();
        if (cErr) throw cErr;
        componentRows.push(c);
        writeState.componentIds.push(c.id);
      }
      const componentByName = new Map(componentRows.map((c) => [c.name, c]));

      const selectedNames = new Set(
        (selectedCandidate?.components ?? []).map((c: { name?: string }) => String(c.name || "").toLowerCase()),
      );
      for (const c of componentRows) {
        const copied = !!(selectedCandidate && selectedNames.has(String(c.name).toLowerCase()));
        await supabase.from("design_provenance").insert({
          project_id,
          design_document_id: hldDoc.id,
          element_key: c.family_key,
          element_label: c.name,
          origin: "model_unchanged",
          source_candidate_id: copied ? selectedCandidate.id : null,
        });
      }

      // Record what changed vs. the prior HLD's component set. This is what
      // the reconciliation gate in approve_design_document() checks -- a
      // human must confirm any vanished family_key before this HLD can be
      // approved.
      if (priorHld) {
        const vanished = [...priorFamilyKeys].filter((k) => !matchedFamilyKeys.has(k));
        const brandNew = componentRows.filter((c) => !priorFamilyKeys.has(c.family_key)).map((c) => c.family_key);
        if (vanished.length || brandNew.length) {
          const { error: recErr } = await supabase.from("component_reconciliations").insert({
            hld_document_id: hldDoc.id,
            vanished_family_keys: vanished,
            new_family_keys: brandNew,
          });
          if (recErr) throw recErr;
        }
      }

      // Insert LLDs -- one per needs_detail component, linked to that
      // component's real id (not the parent HLD's id).
      const needsDetail = componentRows.filter((c) => c.needs_detail);
      const lldDocs: any[] = [];
      for (const comp of needsDetail) {
        const lldContent = parsed.llds?.find((l: any) => l.component_name === comp.name)?.content ?? {};
        const { data: lldDoc, error: lldErr } = await supabase
          .from("design_documents")
          .insert({
            requirement_set_id,
            type: "LLD",
            version: nextVersion,
            status: "draft",
            content: lldContent,
            hld_component_id: hldDoc.id, // parent HLD this LLD elaborates
            component_id: comp.id,       // the actual component it's about
            generated_by_model: "openrouter:anthropic/claude-sonnet-4.5",
          })
          .select()
          .single();
        if (lldErr) throw lldErr;
        lldDocs.push(lldDoc);
        writeState.lldDocIds.push(lldDoc.id);
      }

      // Insert DecisionRationales -- every rationale must cite >=1 real requirement (DB constraint enforces)
      const refCodeToId = new Map(requirements.map((r) => [r.ref_code, r.id]));
      const rationales: any[] = [];
      for (const d of parsed.decisions ?? []) {
        const driving = (d.driving_requirement_ref_codes ?? [])
          .map((rc: string) => refCodeToId.get(rc))
          .filter(Boolean);
        if (driving.length === 0) continue; // zero-citation rationales fail validation -- skip, don't insert invalid
        // best-effort link to the component this decision is about, by name mention
        const matchedComponent = [...componentByName.values()].find((c) =>
          d.decision_point?.toLowerCase().includes(c.name.toLowerCase())
        );
        const { data: dr, error: drErr } = await supabase
          .from("decision_rationales")
          .insert({
            design_document_id: hldDoc.id,
            decision_point: d.decision_point,
            chosen_option: d.chosen_option,
            alternatives_considered: d.alternatives_considered ?? [],
            driving_requirements: driving,
            searchable_text: `${d.decision_point} ${d.chosen_option}`,
            risk_level: d.risk_level ?? "low",
            risk_set_by: "model",
            component_id: matchedComponent?.id ?? null,
          })
          .select()
          .single();
        if (drErr) throw drErr;
        rationales.push(dr);
        await supabase.from("design_provenance").insert({
          project_id,
          design_document_id: hldDoc.id,
          element_key: dr.id,
          element_label: d.decision_point,
          origin: "model_unchanged",
          source_candidate_id: selectedCandidate?.id ?? null,
        });
      }

      return json({ hld: hldDoc, components: componentRows, llds: lldDocs, decision_rationales: rationales });
    } catch (writeErr) {
      await cleanupPartialGeneration(supabase, writeState);
      throw writeErr;
    }
  } catch (e) {
    console.error(e);
    return errorResponse(String(e), 500);
  }
});

// Compensating cleanup: undoes a partially-completed generation run in
// reverse dependency order, so a failure partway through never leaves an
// orphaned draft HLD (with no LLDs/decisions) sitting in the database.
async function cleanupPartialGeneration(
  supabase: any,
  state: { hldDocId: string | null; componentIds: string[]; lldDocIds: string[] },
) {
  try {
    if (state.hldDocId) {
      await supabase.from("design_provenance").delete().eq("design_document_id", state.hldDocId);
      await supabase.from("rule_verdicts").delete().eq("design_document_id", state.hldDocId);
      await supabase.from("decision_rationales").delete().eq("design_document_id", state.hldDocId);
    }
    if (state.lldDocIds.length) {
      await supabase.from("design_documents").delete().in("id", state.lldDocIds);
    }
    if (state.componentIds.length) {
      await supabase.from("components").delete().in("id", state.componentIds);
    }
    if (state.hldDocId) {
      await supabase.from("component_reconciliations").delete().eq("hld_document_id", state.hldDocId);
      await supabase.from("review_gates").delete().eq("target_artifact_id", state.hldDocId).eq("target_artifact_table", "design_documents");
      await supabase.from("design_documents").delete().eq("id", state.hldDocId);
    }
  } catch (cleanupErr) {
    // Cleanup itself failing is logged but doesn't mask the original error
    // -- the caller still sees why generation failed, and the leftover rows
    // are now visible for manual inspection instead of silently retried into.
    console.error("cleanupPartialGeneration failed:", cleanupErr);
  }
}

// Stable, order-independent hash of a requirement set's content. MUST match
// the client-side implementation in RequirementsTab.jsx exactly (sort key,
// field order, separators) -- this is compared byte-for-byte against a
// client-computed hash to decide whether requirements have actually changed.
async function hashRequirements(requirements: { ref_code: string; title: string; body: string }[]): Promise<string> {
  const sorted = [...requirements].sort((a, b) => a.ref_code.localeCompare(b.ref_code));
  const text = sorted.map((r) => `${r.ref_code}|${r.title}|${r.body}`).join("\n");
  const bytes = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
}