// CI / merge webhook. A changed file is architectural drift when it breaks
// a standing rule that covers that file. Interface booleans are not the classification.
import { corsHeaders, errorResponse, json, userClient } from "../_shared/lib.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const body = await req.json();
    const project_id = body.project_id;
    const files = body.files ?? body.commits ?? [];
    if (!project_id) return errorResponse("project_id is required");
    if (!Array.isArray(files) || !files.length) return errorResponse("files[] is required");

    const supabase = userClient(req);
    const { data: userData } = await supabase.auth.getUser();
    if (!userData?.user) return errorResponse("unauthenticated", 401);

    const events = [];
    for (const file of files) {
      const path = file.path || file.filename;
      if (!path) continue;
      const { data: artifact } = await supabase
        .from("code_artifacts")
        .select("id, content_hash")
        .eq("project_id", project_id)
        .eq("path", path)
        .order("generation_version", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!artifact) {
        events.push({ path, skipped: "no traced skeleton file for this path" });
        continue;
      }
      const baseline = file.before || file.baseline_hash || artifact.content_hash || "missing";
      const current = file.after || file.current_hash || artifact.content_hash || "missing";
      const summary = String(file.summary || file.diff?.summary || file.diff?.claimed_ending || "");
      const claimed = String(file.claimed_ending || file.diff?.claimed_ending || summary);
      let classification = "conformant";
      let verdictId: string | null = null;
      if (baseline !== current) {
        const { data: full } = await supabase
          .from("code_artifacts")
          .select("id, project_id, path, design_component_id")
          .eq("id", artifact.id)
          .maybeSingle();
        const { data: verdicts } = await supabase.rpc("write_rule_verdicts", {
          p_project_id: full?.project_id || project_id,
          p_subject: "drift",
          p_options: [{
            option_key: `${artifact.id}:${current}`,
            option_text: summary || claimed || "code changed",
            claimed_ending: claimed,
            covers: {
              component_ids: full?.design_component_id ? [full.design_component_id] : [],
              artifact_ids: [artifact.id],
              paths: full?.path ? [full.path] : [path],
              config_keys: [],
              labels: [],
            },
          }],
          p_code_artifact_id: artifact.id,
        });
        const breaking = (verdicts ?? []).filter((v: { result: string }) => v.result === "breaks");
        classification = breaking.length ? "architectural_drift" : "local_deviation";
        verdictId = breaking[0]?.id ?? verdicts?.[0]?.id ?? null;
      }
      const { data: event, error } = await supabase
        .from("drift_events")
        .insert({
          code_artifact_id: artifact.id,
          baseline_hash: baseline,
          current_hash: current,
          classification,
          severity: classification === "architectural_drift" ? "high" : "low",
          rule_verdict_id: verdictId,
        })
        .select()
        .single();
      if (error) throw error;
      events.push(event);
    }

    return json({ project_id, evaluated: events.length, events });
  } catch (e) {
    console.error(e);
    return errorResponse(String(e), 500);
  }
});
