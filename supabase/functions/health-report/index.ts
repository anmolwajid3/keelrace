// FR-9.1: aggregates open DriftEvents by severity, open DebtItems, unresolved
// NFRConflicts, and provisional decisions with no recent RevisitCheck.
// Every number here is a live query result -- this function does no caching
// and sets no-store so nothing upstream caches it either.
import { corsHeaders, errorResponse, json, userClient } from "../_shared/lib.ts";

const STALENESS_DAYS = 90;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const url = new URL(req.url);
    const project_id = url.searchParams.get("project_id");
    if (!project_id) return errorResponse("project_id query param required");

    const supabase = userClient(req);

    const { data: artifacts } = await supabase.from("code_artifacts").select("id").eq("project_id", project_id);
    const artifactIds = (artifacts ?? []).map((a: any) => a.id);

    const { data: driftEvents } = artifactIds.length
      ? await supabase
          .from("drift_events")
          .select("id, severity, classification, resolution")
          .in("code_artifact_id", artifactIds)
          .is("resolution", null)
      : { data: [] };

    const driftBySeverity = { low: 0, medium: 0, high: 0 };
    for (const e of driftEvents ?? []) {
      if (e.severity) driftBySeverity[e.severity as "low" | "medium" | "high"]++;
    }

    const { data: debtItems } = await supabase
      .from("debt_items")
      .select("id, status")
      .eq("project_id", project_id)
      .eq("status", "open");

    const { data: nfrConflicts } = await supabase
      .from("nfr_conflicts")
      .select("id")
      .eq("project_id", project_id)
      .is("resolution_decision_rationale_id", null);

    // Provisional decisions with no RevisitCheck within STALENESS_DAYS
    const { data: provisional } = await supabase
      .from("decision_rationales")
      .select("id, decision_point, design_document_id")
      .eq("status", "provisional");

    const staleThreshold = new Date(Date.now() - STALENESS_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const neverChecked: any[] = [];
    for (const dr of provisional ?? []) {
      const { data: checks } = await supabase
        .from("revisit_checks")
        .select("checked_at")
        .eq("decision_rationale_id", dr.id)
        .gte("checked_at", staleThreshold)
        .limit(1);
      if (!checks || checks.length === 0) neverChecked.push(dr);
    }

    // FR-9.3: no topology defined for any environment at all
    const { count: topologyCount } = await supabase
      .from("deployment_topologies")
      .select("id", { count: "exact", head: true })
      .eq("project_id", project_id);

    // FR-9.4: trust-boundary-crossing designs with no ThreatModel
    const { data: crossingDocs } = await supabase
      .from("design_documents")
      .select("id, requirement_sets!inner(project_id)")
      .eq("requirement_sets.project_id", project_id)
      .eq("crosses_trust_boundary", true);
    let missingThreatModels = 0;
    if (crossingDocs?.length) {
      const { data: tms } = await supabase
        .from("threat_models")
        .select("design_document_id")
        .in("design_document_id", crossingDocs.map((d: any) => d.id));
      const covered = new Set((tms ?? []).map((t: any) => t.design_document_id));
      missingThreatModels = crossingDocs.filter((d: any) => !covered.has(d.id)).length;
    }

    return new Response(
      JSON.stringify({
        generated_at: new Date().toISOString(),
        drift: { open_by_severity: driftBySeverity, total_open: (driftEvents ?? []).length },
        debt: { open_count: (debtItems ?? []).length },
        nfr_conflicts: { unresolved_count: (nfrConflicts ?? []).length },
        provisional_decisions_never_checked: neverChecked,
        governance: {
          topology_defined: (topologyCount ?? 0) > 0,
          trust_boundary_docs_missing_threat_model: missingThreatModels,
        },
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" } },
    );
  } catch (e) {
    console.error(e);
    return errorResponse(String(e), 500);
  }
});
