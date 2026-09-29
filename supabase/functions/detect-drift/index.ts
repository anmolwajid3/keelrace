// A code change is drift when it breaks a standing rule that covers the file.
// Same hash is conformant. A hash change that still uses an allowed ending is
// a local deviation. Caller-supplied interface/dependency booleans are ignored.
import { corsHeaders, errorResponse, json, userClient } from "../_shared/lib.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const { code_artifact_id, baseline_hash, current_hash, diff } = await req.json();
    if (!code_artifact_id || !baseline_hash || !current_hash) {
      return errorResponse("code_artifact_id, baseline_hash, current_hash are required");
    }

    const supabase = userClient(req);
    const { data: artifact, error: artErr } = await supabase
      .from("code_artifacts")
      .select("id, project_id, path, design_component_id")
      .eq("id", code_artifact_id)
      .single();
    if (artErr || !artifact) return errorResponse("code artifact not found", 404);

    if (baseline_hash === current_hash) {
      const { data: event, error } = await supabase
        .from("drift_events")
        .insert({ code_artifact_id, baseline_hash, current_hash, classification: "conformant", severity: "low" })
        .select()
        .single();
      if (error) throw error;
      return json(event);
    }

    const summary = String(diff?.summary || diff?.claimed_ending || "");
    const claimed = String(diff?.claimed_ending || summary);
    const covers = {
      component_ids: artifact.design_component_id ? [artifact.design_component_id] : [],
      artifact_ids: [artifact.id],
      paths: artifact.path ? [artifact.path] : [],
      config_keys: [],
      labels: [],
    };

    const { data: verdicts, error: vErr } = await supabase.rpc("write_rule_verdicts", {
      p_project_id: artifact.project_id,
      p_subject: "drift",
      p_options: [{
        option_key: `${code_artifact_id}:${current_hash}`,
        option_text: summary || claimed || "code changed",
        claimed_ending: claimed,
        covers,
      }],
      p_code_artifact_id: code_artifact_id,
    });
    if (vErr) throw vErr;

    const rows = verdicts ?? [];
    const breaking = rows.filter((v: { result: string }) => v.result === "breaks");
    const classification = breaking.length ? "architectural_drift" : "local_deviation";
    const { count, critical } = await blastRadius(supabase, code_artifact_id);
    const severity = breaking.length || critical || count >= 11 ? "high" : count >= 3 ? "medium" : "low";

    const { data: event, error } = await supabase
      .from("drift_events")
      .insert({
        code_artifact_id,
        baseline_hash,
        current_hash,
        classification,
        severity,
        blast_radius_count: count,
        rule_verdict_id: breaking[0]?.id ?? rows[0]?.id ?? null,
      })
      .select()
      .single();
    if (error) throw error;

    return json({ ...event, rule_verdicts: rows });
  } catch (e) {
    console.error(e);
    return errorResponse(String(e), 500);
  }
});

async function blastRadius(supabase: any, artifactId: string): Promise<{ count: number; critical: boolean }> {
  const visited = new Set<string>();
  const queue = [artifactId];
  let critical = false;
  while (queue.length) {
    const current = queue.shift()!;
    const { data: edges } = await supabase
      .from("code_dependencies")
      .select("to_artifact_id, is_critical_path")
      .eq("from_artifact_id", current);
    for (const e of edges ?? []) {
      if (e.is_critical_path) critical = true;
      if (!visited.has(e.to_artifact_id)) {
        visited.add(e.to_artifact_id);
        queue.push(e.to_artifact_id);
      }
    }
  }
  return { count: visited.size, critical };
}
