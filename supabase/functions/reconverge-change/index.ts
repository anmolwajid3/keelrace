// FR-10.4: the single downstream pipeline both doors converge into.
// A ChangeRequest reaching 'scoped' (Door 1) or a Signal classified
// 'requirement_gap' (Door 2) call this. It:
//   1. impact-scopes (reuses FR-7.3) from the affected requirement
//   2. triages (reuses FR-7.4)
//   3. routes to the owning TeamBoundary (reuses FR-8.2)
//   4. flags exactly the traced set needs_review=true -- nothing else touched
import { corsHeaders, errorResponse, json, userClient } from "../_shared/lib.ts";
import { writeChangeVerdicts } from "../_shared/change-verdicts.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const { change_request_id, signal_id, requirement_id, project_id } = await req.json();
    if ((!change_request_id && !signal_id) || (change_request_id && signal_id)) {
      return errorResponse("exactly one of change_request_id / signal_id is required");
    }
    if (!requirement_id || !project_id) return errorResponse("requirement_id and project_id are required");

    const supabase = userClient(req);
    await writeChangeVerdicts(supabase, { change_request_id, signal_id, project_id });
    const authHeader = req.headers.get("Authorization")!;
    const base = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    // --- Step 1: impact scoping ---
    const impactRes = await fetch(`${base}/functions/v1/impact-scope`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json", apikey: anonKey },
      body: JSON.stringify({ requirement_id }),
    });
    if (!impactRes.ok) throw new Error(`impact-scope failed: ${await impactRes.text()}`);
    const impact = await impactRes.json();

    // --- Step 2: triage ---
    const triageRes = await fetch(`${base}/functions/v1/triage-change`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json", apikey: anonKey },
      body: JSON.stringify({ change_request_id, signal_id, impact }),
    });
    if (!triageRes.ok) throw new Error(`triage-change failed: ${await triageRes.text()}`);
    const triage = await triageRes.json();

    // --- Step 3: routing (FR-8.2) ---
    // Route via each traced decision's component_id (the real Component
    // entity), not the decision_rationale id itself.
    const rationaleIds = (impact.traced_decision_rationales ?? []).map((r: any) => r.id);
    let componentIds: string[] = [];
    if (rationaleIds.length) {
      const { data: drs } = await supabase.from("decision_rationales").select("id, component_id").in("id", rationaleIds);
      componentIds = [...new Set((drs ?? []).map((d: any) => d.component_id).filter(Boolean))];
    }
    let routedTeams: any[] = [];
    let unowned: string[] = [];
    if (componentIds.length) {
      const { data: boundaries } = await supabase
        .from("team_boundaries")
        .select("design_component_id, owning_team")
        .in("design_component_id", componentIds);
      const ownedIds = new Set((boundaries ?? []).map((b: any) => b.design_component_id));
      routedTeams = boundaries ?? [];
      unowned = componentIds.filter((id: string) => !ownedIds.has(id));
    }

    // --- Step 4: flag exactly the traced set needs_review, nothing else ---
    const docIds = (impact.traced_design_documents ?? []).map((d: any) => d.id);
    if (docIds.length) {
      const { error: flagErr } = await supabase
        .from("design_documents")
        .update({ needs_review: true })
        .in("id", docIds);
      if (flagErr) throw flagErr;
    }

    // Record the trace rows for auditability (change_impact_traces)
    if (rationaleIds.length) {
      const rows = rationaleIds.map((decision_rationale_id: string) => ({
        change_request_id: change_request_id ?? null,
        signal_id: signal_id ?? null,
        decision_rationale_id,
      }));
      const { error: traceErr } = await supabase.from("change_impact_traces").insert(rows);
      if (traceErr) throw traceErr;
    }

    // Advance the originating record's status
    if (change_request_id) {
      await supabase.from("change_requests").update({ status: "triaged" }).eq("id", change_request_id);
    } else {
      // Signal has no explicit 'triaged' status in the enum set beyond open/resolved;
      // classification + traces above already record progress toward resolution.
    }

    return json({
      impact,
      triage,
      routing: { routed_teams: routedTeams, unowned_component_ids: unowned },
      flagged_document_ids: docIds,
    });
  } catch (e) {
    console.error(e);
    return errorResponse(String(e), 500);
  }
});
