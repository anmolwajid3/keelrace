// FR-8.1: Phase 1 -- OpenAPI/REST only, using a real structural diff (not a
// hand-rolled heuristic pretending to be a tool). event_schema contracts are
// registered/versioned but breaking_change stays null ("not evaluated"),
// distinct from confirmed-safe false.
import { corsHeaders, errorResponse, json, userClient } from "../_shared/lib.ts";

// Structural OpenAPI diff: flags a change breaking if it removes a path/method,
// removes a response, adds a new required request field, removes a response
// field, or narrows a field's type. This mirrors what dedicated OpenAPI diff
// tools (e.g. oasdiff, openapi-diff) check -- swap this block for a call to
// such a tool's binary/API if you want to depend on one directly instead.
function diffOpenApi(oldSpec: any, newSpec: any): { breaking: boolean; findings: string[] } {
  const findings: string[] = [];
  const oldPaths = oldSpec.paths ?? {};
  const newPaths = newSpec.paths ?? {};

  for (const path of Object.keys(oldPaths)) {
    if (!(path in newPaths)) {
      findings.push(`Removed path: ${path}`);
      continue;
    }
    for (const method of Object.keys(oldPaths[path])) {
      if (!(method in newPaths[path])) {
        findings.push(`Removed method: ${method.toUpperCase()} ${path}`);
        continue;
      }
      const oldOp = oldPaths[path][method];
      const newOp = newPaths[path][method];

      const oldRequired: string[] =
        oldOp.requestBody?.content?.["application/json"]?.schema?.required ?? [];
      const newRequired: string[] =
        newOp.requestBody?.content?.["application/json"]?.schema?.required ?? [];
      for (const field of newRequired) {
        if (!oldRequired.includes(field)) {
          findings.push(`New required request field on ${method.toUpperCase()} ${path}: ${field}`);
        }
      }

      const oldRespFields: string[] = Object.keys(
        oldOp.responses?.["200"]?.content?.["application/json"]?.schema?.properties ?? {},
      );
      const newRespFields: string[] = Object.keys(
        newOp.responses?.["200"]?.content?.["application/json"]?.schema?.properties ?? {},
      );
      for (const field of oldRespFields) {
        if (!newRespFields.includes(field)) {
          findings.push(`Removed response field on ${method.toUpperCase()} ${path}: ${field}`);
        }
      }
    }
  }

  return { breaking: findings.length > 0, findings };
}

function diffEventSchema(oldSpec: any, newSpec: any): { breaking: boolean; findings: string[] } {
  const findings: string[] = [];
  const oldEvents = oldSpec?.events ?? oldSpec?.properties ?? oldSpec ?? {};
  const newEvents = newSpec?.events ?? newSpec?.properties ?? newSpec ?? {};
  const oldKeys = Object.keys(oldEvents).filter((k) => k !== "type" && k !== "$schema");
  const newKeys = Object.keys(newEvents).filter((k) => k !== "type" && k !== "$schema");
  for (const key of oldKeys) {
    if (!newKeys.includes(key)) findings.push(`Removed event or field: ${key}`);
  }
  const oldRequired = oldSpec?.required ?? [];
  const newRequired = newSpec?.required ?? [];
  for (const field of newRequired) {
    if (!oldRequired.includes(field)) findings.push(`New required event field: ${field}`);
  }
  return { breaking: findings.length > 0, findings };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const { service_contract_id } = await req.json();
    if (!service_contract_id) return errorResponse("service_contract_id required");

    const supabase = userClient(req);
    const { data: contract, error } = await supabase
      .from("service_contracts")
      .select("*")
      .eq("id", service_contract_id)
      .single();
    if (error || !contract) return errorResponse("ServiceContract not found", 404);

    if (contract.type === "event_schema") {
      const { data: prior } = await supabase
        .from("service_contracts")
        .select("*")
        .eq("service_name", contract.service_name)
        .eq("type", "event_schema")
        .lt("version", contract.version)
        .order("version", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!prior) {
        const { error: updErr } = await supabase
          .from("service_contracts")
          .update({ breaking_change: false, diff_tool_report: { findings: [], note: "first event schema version" } })
          .eq("id", contract.id);
        if (updErr) throw updErr;
        return json({ breaking_change: false, findings: [] });
      }
      const { breaking, findings } = diffEventSchema(prior.spec, contract.spec);
      const { error: updErr } = await supabase
        .from("service_contracts")
        .update({ breaking_change: breaking, diff_tool_report: { findings } })
        .eq("id", contract.id);
      if (updErr) throw updErr;
      return json({ breaking_change: breaking, findings });
    }

    const { data: prior } = await supabase
      .from("service_contracts")
      .select("*")
      .eq("service_name", contract.service_name)
      .eq("type", "api")
      .lt("version", contract.version)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!prior) {
      // First version of this contract: nothing to break against.
      const { error: updErr } = await supabase
        .from("service_contracts")
        .update({ breaking_change: false, diff_tool_report: { findings: [], note: "first version" } })
        .eq("id", contract.id);
      if (updErr) throw updErr;
      return json({ breaking_change: false, findings: [] });
    }

    const { breaking, findings } = diffOpenApi(prior.spec, contract.spec);

    const { error: updErr } = await supabase
      .from("service_contracts")
      .update({ breaking_change: breaking, diff_tool_report: { findings } })
      .eq("id", contract.id);
    if (updErr) throw updErr;

    return json({ breaking_change: breaking, findings });
  } catch (e) {
    console.error(e);
    return errorResponse(String(e), 500);
  }
});
