// FR-7.4: classify an incoming change as requires_full_review or fast-track.
// Records which factor(s) triggered the classification (never a bare boolean).
import { corsHeaders, errorResponse, json, userClient } from "../_shared/lib.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const { change_request_id, signal_id, impact } = await req.json();
    if (!change_request_id && !signal_id) return errorResponse("change_request_id or signal_id required");
    if ((change_request_id && signal_id) || !impact) {
      return errorResponse("exactly one of change_request_id/signal_id, plus impact, is required");
    }

    const supabase = userClient(req);

    const factors: string[] = [];
    const rationaleCount = impact.traced_decision_rationales?.length ?? 0;
    const docCount = impact.traced_design_documents?.length ?? 0;
    const touchesApproved = (impact.traced_design_documents ?? []).some((d: any) => d.status === "approved");
    const touchesHighRisk = (impact.traced_decision_rationales ?? []).some((r: any) => r.risk_level === "high");

    let verdictQuery = supabase.from("rule_verdicts").select("result, reason, standing_rule_id, standing_rules(rule_text)");
    if (change_request_id) verdictQuery = verdictQuery.eq("change_request_id", change_request_id);
    else verdictQuery = verdictQuery.eq("signal_id", signal_id);
    const { data: verdicts } = await verdictQuery;
    for (const v of verdicts ?? []) {
      const ruleText = (v as any).standing_rules?.rule_text || "a standing rule";
      if (v.result === "breaks") factors.push(`breaks standing rule: ${ruleText}`);
      else if (v.result === "holds") factors.push(`still holds standing rule: ${ruleText}`);
      else if (v.result === "replaces") factors.push(`replaces standing rule: ${ruleText}`);
    }

    if (rationaleCount > 5) factors.push(`touches ${rationaleCount} decision rationales (>5)`);
    if (docCount > 2) factors.push(`touches ${docCount} design documents (>2)`);
    if (touchesApproved) factors.push("touches an already-approved design document");
    if (touchesHighRisk) factors.push("touches a high-risk decision");

    const requiresFullReview = factors.length > 0;
    const reasoning = requiresFullReview
      ? `Full review required: ${factors.join("; ")}`
      : "Fast-track: change is narrowly scoped, touches no approved documents or high-risk decisions";

    const { data: triage, error } = await supabase
      .from("triage_decisions")
      .insert({
        change_request_id: change_request_id ?? null,
        signal_id: signal_id ?? null,
        requires_full_review: requiresFullReview,
        reasoning,
        triggering_factors: factors,
      })
      .select()
      .single();
    if (error) throw error;

    return json(triage);
  } catch (e) {
    console.error(e);
    return errorResponse(String(e), 500);
  }
});
