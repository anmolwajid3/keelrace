// Closes the loop FR-10.1 describes but nothing previously implemented:
// a ChangeRequest (add/modify/remove) or a requirement_gap Signal doesn't
// just get flagged -- once approved, it has to actually produce a new,
// locked RequirementSet version carrying the change, which then drives a
// fresh generate-design-docs pass (reusing FR-1.1) and resolves back
// through resolve-change (FR-10.5).
//
// A ChangeRequest never edits the locked RequirementSet directly (FR-10.1) --
// this function is exactly the "standalone proposal becomes a new locked
// version" step, run only once a human has approved the change.
import { corsHeaders, errorResponse, json, userClient } from "../_shared/lib.ts";
import { writeChangeVerdicts } from "../_shared/change-verdicts.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const { change_request_id, signal_id, proposed_text } = await req.json();
    if ((!change_request_id && !signal_id) || (change_request_id && signal_id)) {
      return errorResponse("exactly one of change_request_id / signal_id is required");
    }

    const supabase = userClient(req);
    const authHeader = req.headers.get("Authorization")!;
    const base = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    let action: "add" | "modify" | "remove";
    let targetRequirementId: string | null;
    let description: string;
    let text: string | null;
    let projectId: string;
    let sourceRequirementSetId: string;

    if (change_request_id) {
      const { data: cr, error } = await supabase.from("change_requests").select("*").eq("id", change_request_id).single();
      if (error || !cr) return errorResponse("ChangeRequest not found", 404);
      if (cr.status === "resolved") {
        return json({ already_resolved: true, resolved_document_version_id: cr.resolved_document_version_id });
      }
      if (cr.status !== "triaged" && cr.status !== "approved") {
        return errorResponse(`ChangeRequest status is '${cr.status}' -- must be triaged/approved before applying`, 409);
      }
      action = cr.action;
      targetRequirementId = cr.target_requirement_id;
      description = cr.description;
      text = cr.proposed_text;
      projectId = cr.project_id;
      sourceRequirementSetId = targetRequirementId
        ? (await supabase.from("requirements").select("requirement_set_id").eq("id", targetRequirementId).single()).data?.requirement_set_id
        : (await supabase.from("requirement_sets").select("id").eq("project_id", projectId).eq("status", "locked").order("version", { ascending: false }).limit(1).single()).data?.id;
    } else {
      const { data: sig, error } = await supabase.from("signals").select("*").eq("id", signal_id).single();
      if (error || !sig) return errorResponse("Signal not found", 404);
      if (sig.status === "resolved") {
        return json({ already_resolved: true, resolved_document_version_id: sig.resolved_document_version_id });
      }
      if (sig.classification !== "requirement_gap" || !sig.routed_to_requirement_id) {
        return errorResponse("Signal must be classified requirement_gap and routed to a requirement first", 409);
      }
      action = "modify"; // a requirement_gap always means an existing requirement was wrong, never add/remove
      targetRequirementId = sig.routed_to_requirement_id;
      description = sig.description;
      text = proposed_text; // signals don't carry proposed_text themselves -- caller supplies the corrected text
      if (!text) return errorResponse("proposed_text is required to apply a requirement_gap signal");
      const { data: req } = await supabase.from("requirements").select("requirement_set_id, requirement_sets(project_id)").eq("id", targetRequirementId).single();
      sourceRequirementSetId = req?.requirement_set_id;
      projectId = (req as any)?.requirement_sets?.project_id;
    }

    const verdicts = await writeChangeVerdicts(supabase, {
      change_request_id,
      signal_id,
      project_id: projectId,
      proposed_text: text,
    });
    const breaking = (verdicts ?? []).filter((v: { result: string }) => v.result === "breaks");
    if (breaking.length) {
      return json({
        error: `${breaking.length} option(s) break a standing rule. Rewrite the change or record a decision that replaces the rule.`,
        rule_verdicts: verdicts,
      }, 409);
    }

    if (!sourceRequirementSetId) return errorResponse("Could not resolve a source RequirementSet", 422);

    const { data: sourceSet, error: setErr } = await supabase.from("requirement_sets").select("*").eq("id", sourceRequirementSetId).single();
    if (setErr || !sourceSet) return errorResponse("Source RequirementSet not found", 404);

    // --- Idempotency: if a prior call already got partway (or all the way)
    // through this exact change, reuse that work instead of duplicating it.
    // A 'locked' set at version+1 is proof the copy-forward step fully
    // completed (locking only happens after it succeeds); a stray 'draft'
    // one means a prior run died before locking, so it's safe to discard
    // and start clean rather than trying to reconcile a partial copy. ---
    let newSet: any;
    const { data: existingNextVersions } = await supabase
      .from("requirement_sets")
      .select("*")
      .eq("project_id", projectId)
      .eq("version", sourceSet.version + 1);

    const lockedReuse = (existingNextVersions ?? []).find((s: any) => s.status === "locked");
    const staleDraft = (existingNextVersions ?? []).find((s: any) => s.status === "draft");
    if (staleDraft && !lockedReuse) {
      await supabase.from("requirements").delete().eq("requirement_set_id", staleDraft.id);
      await supabase.from("requirement_sets").delete().eq("id", staleDraft.id);
    }

    if (lockedReuse) {
      newSet = lockedReuse;
    } else {
      const { data: existingReqs, error: reqsErr } = await supabase.from("requirements").select("*").eq("requirement_set_id", sourceRequirementSetId);
      if (reqsErr) throw reqsErr;

      // --- Create the new RequirementSet version (draft, then locked below) ---
      const { data: created, error: newSetErr } = await supabase
        .from("requirement_sets")
        .insert({ project_id: projectId, version: sourceSet.version + 1, status: "draft" })
        .select()
        .single();
      if (newSetErr) throw newSetErr;
      newSet = created;

      // --- Copy requirements forward, applying the change ---
      const rowsToInsert = (existingReqs ?? [])
        .filter((r: any) => !(action === "remove" && r.id === targetRequirementId))
        .map((r: any) => ({
          requirement_set_id: newSet.id,
          ref_code: r.ref_code,
          title: r.title,
          body: r.id === targetRequirementId && action === "modify" ? (text ?? r.body) : r.body,
        }));

      if (action === "add") {
        const nextNum = (existingReqs ?? []).length + 1;
        rowsToInsert.push({
          requirement_set_id: newSet.id,
          ref_code: `CR-${nextNum}`,
          title: description.slice(0, 80),
          body: text ?? description,
        });
      }

      const { error: insErr } = await supabase.from("requirements").insert(rowsToInsert);
      if (insErr) throw insErr;

      // --- Lock it (required before generation can run, per FR-1.1's gate) ---
      const { error: lockErr } = await supabase
        .from("requirement_sets")
        .update({ status: "locked", locked_at: new Date().toISOString() })
        .eq("id", newSet.id);
      if (lockErr) throw lockErr;
      newSet.status = "locked";
    }

    // --- Regenerate design docs from the new locked set (reuses FR-1.1),
    // unless a prior partial run already produced an HLD for it. ---
    let generated: any;
    const { data: existingHld } = await supabase
      .from("design_documents")
      .select("*")
      .eq("requirement_set_id", newSet.id)
      .eq("type", "HLD")
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existingHld) {
      generated = { hld: existingHld, reused: true };
    } else {
      const genRes = await fetch(`${base}/functions/v1/generate-design-docs`, {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json", apikey: anonKey },
        body: JSON.stringify({ requirement_set_id: newSet.id }),
      });
      if (!genRes.ok) throw new Error(`generate-design-docs failed: ${await genRes.text()}`);
      generated = await genRes.json();
    }

    // --- Resolve the originating record, linking it to the produced version
    // (FR-10.5). This is a separate HTTP call from generation above, so it
    // can fail independently after generation has already succeeded -- retry
    // once, and if it still fails, return enough to recover manually instead
    // of leaving the change silently stuck. ---
    let resolved: any = null;
    let resolveError: string | null = null;
    for (let attempt = 0; attempt < 2 && !resolved; attempt++) {
      const resolveRes = await fetch(`${base}/functions/v1/resolve-change`, {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json", apikey: anonKey },
        body: JSON.stringify({ change_request_id, signal_id, design_document_id: generated.hld.id }),
      });
      if (resolveRes.ok) {
        resolved = await resolveRes.json();
      } else {
        resolveError = await resolveRes.text();
        if (attempt === 0) await new Promise((r) => setTimeout(r, 500));
      }
    }

    if (!resolved) {
      // Generation succeeded; resolution didn't. Return everything needed
      // to finish this by hand -- calling resolve-change directly with
      // these exact ids -- instead of the change being silently stuck.
      return json(
        {
          new_requirement_set: newSet,
          generated,
          resolve_error: resolveError,
          recovery: {
            note: "generate-design-docs succeeded but resolve-change failed after a retry. Nothing was lost -- call resolve-change directly with the ids below to finish.",
            change_request_id: change_request_id ?? null,
            signal_id: signal_id ?? null,
            design_document_id: generated.hld.id,
          },
        },
        207,
      );
    }

    return json({ new_requirement_set: newSet, generated, resolved });
  } catch (e) {
    console.error(e);
    return errorResponse(String(e), 500);
  }
});
