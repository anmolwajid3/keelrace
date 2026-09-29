// Suggest which existing (or new) decisions address uncited in-scope NFRs.
// Does not write citations — the human picks 1, many, none, or their own.
import { corsHeaders, errorResponse, json, userClient, callOpenRouter } from "../_shared/lib.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { design_document_id, nfr_ids } = await req.json();
    if (!design_document_id) return errorResponse("design_document_id is required");

    const supabase = userClient(req);
    const { data: doc, error: docErr } = await supabase
      .from("design_documents")
      .select("id, type, content, component_id, requirement_set_id")
      .eq("id", design_document_id)
      .single();
    if (docErr || !doc) return errorResponse("design document not found", 404);

    const { data: decisions } = await supabase
      .from("decision_rationales")
      .select("id, decision_point, chosen_option, risk_level")
      .eq("design_document_id", design_document_id);

    const { data: reqSet } = await supabase
      .from("requirement_sets")
      .select("project_id")
      .eq("id", doc.requirement_set_id)
      .single();
    if (!reqSet) return errorResponse("requirement set not found", 404);

    let nfrQuery = supabase.from("nfrs").select("id, name, description, component_id").eq("project_id", reqSet.project_id);
    if (nfr_ids?.length) nfrQuery = nfrQuery.in("id", nfr_ids);
    const { data: nfrs } = await nfrQuery;
    const wanted = (nfrs ?? []).filter((n) => !nfr_ids?.length || nfr_ids.includes(n.id));

    if (!wanted.length) return json({ suggestions: [], decisions: decisions ?? [] });

    const prompt = `You help an architect attach quality rules (NFRs) to architecture decisions.
Do not invent NFR ids or decision ids. Use only the ids listed.

Design (${doc.type}):
${JSON.stringify(doc.content ?? {}, null, 2).slice(0, 6000)}

Existing decisions:
${(decisions ?? []).map((d) => `- id ${d.id}: ${d.decision_point} → ${d.chosen_option}`).join("\n") || "(none)"}

Uncited quality rules:
${wanted.map((n) => `- id ${n.id}: ${n.name} — ${n.description ?? ""}`).join("\n")}

For each quality rule, recommend:
- 0, 1, or several existing decision ids that actually address it
- a one-sentence reason
- if none of the existing decisions address it, propose a new_decision the human can add (decision_point, chosen_option, risk_level)

Return ONLY JSON:
{
  "suggestions": [
    {
      "nfr_id": "uuid",
      "suggested_decision_ids": ["uuid"],
      "reason": "string",
      "new_decision": { "decision_point": "string", "chosen_option": "string", "risk_level": "low" } | null
    }
  ]
}`;

    const raw = await callOpenRouter(
      [
        { role: "system", content: "You output strictly valid JSON, no markdown fences." },
        { role: "user", content: prompt },
      ],
      { json: true },
    );
    const parsed = JSON.parse(raw);
    const allowedNfr = new Set(wanted.map((n) => n.id));
    const allowedDr = new Set((decisions ?? []).map((d) => d.id));
    const suggestions = (parsed.suggestions ?? [])
      .filter((s: { nfr_id: string }) => allowedNfr.has(s.nfr_id))
      .map((s: { nfr_id: string; suggested_decision_ids?: string[]; reason?: string; new_decision?: unknown }) => ({
        nfr_id: s.nfr_id,
        suggested_decision_ids: (s.suggested_decision_ids ?? []).filter((id: string) => allowedDr.has(id)),
        reason: String(s.reason ?? "").slice(0, 400),
        new_decision: s.new_decision && typeof s.new_decision === "object"
          ? {
            decision_point: String((s.new_decision as { decision_point?: string }).decision_point ?? "").slice(0, 240),
            chosen_option: String((s.new_decision as { chosen_option?: string }).chosen_option ?? "").slice(0, 400),
            risk_level: ["low", "medium", "high"].includes((s.new_decision as { risk_level?: string }).risk_level ?? "")
              ? (s.new_decision as { risk_level: string }).risk_level
              : "low",
          }
          : null,
      }));

    const missing = wanted.filter((n) => !suggestions.some((s: { nfr_id: string }) => s.nfr_id === n.id));
    for (const n of missing) {
      suggestions.push({
        nfr_id: n.id,
        suggested_decision_ids: [],
        reason: "No model suggestion — pick existing decisions, add one, or skip.",
        new_decision: {
          decision_point: `How this design meets ${n.name}`,
          chosen_option: (n.description || n.name).slice(0, 240),
          risk_level: "low",
        },
      });
    }

    return json({ suggestions, decisions: decisions ?? [] });
  } catch (e) {
    return errorResponse((e as Error).message, 500);
  }
});
