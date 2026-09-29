// FR-5.4: comparing two ArchitectureSnapshots produces a real structural diff,
// not just "changed: true". Snapshots are immutable (no update policy), so
// this only ever reads.
import { corsHeaders, errorResponse, json, userClient } from "../_shared/lib.ts";

function deepDiff(a: any, b: any, path = ""): string[] {
  const findings: string[] = [];
  const aKeys = a && typeof a === "object" ? Object.keys(a) : [];
  const bKeys = b && typeof b === "object" ? Object.keys(b) : [];
  const allKeys = new Set([...aKeys, ...bKeys]);

  if (Array.isArray(a) || Array.isArray(b)) {
    const aArr = Array.isArray(a) ? a : [];
    const bArr = Array.isArray(b) ? b : [];
    const aSet = new Set(aArr.map((x) => JSON.stringify(x)));
    const bSet = new Set(bArr.map((x) => JSON.stringify(x)));
    for (const item of aSet) if (!bSet.has(item)) findings.push(`removed at ${path}: ${item}`);
    for (const item of bSet) if (!aSet.has(item)) findings.push(`added at ${path}: ${item}`);
    return findings;
  }

  for (const key of allKeys) {
    const p = path ? `${path}.${key}` : key;
    const av = a?.[key];
    const bv = b?.[key];
    if (!(key in (a ?? {}))) {
      findings.push(`added: ${p}`);
    } else if (!(key in (b ?? {}))) {
      findings.push(`removed: ${p}`);
    } else if (typeof av === "object" && typeof bv === "object" && av !== null && bv !== null) {
      findings.push(...deepDiff(av, bv, p));
    } else if (av !== bv) {
      findings.push(`changed: ${p} (${JSON.stringify(av)} -> ${JSON.stringify(bv)})`);
    }
  }
  return findings;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const { snapshot_a_id, snapshot_b_id } = await req.json();
    if (!snapshot_a_id || !snapshot_b_id) return errorResponse("snapshot_a_id and snapshot_b_id required");

    const supabase = userClient(req);
    const { data: a, error: aErr } = await supabase.from("architecture_snapshots").select("*").eq("id", snapshot_a_id).single();
    const { data: b, error: bErr } = await supabase.from("architecture_snapshots").select("*").eq("id", snapshot_b_id).single();
    if (aErr || bErr || !a || !b) return errorResponse("one or both snapshots not found", 404);

    const findings = deepDiff(a.structure, b.structure);
    return json({ snapshot_a: a.label ?? a.id, snapshot_b: b.label ?? b.id, findings });
  } catch (e) {
    console.error(e);
    return errorResponse(String(e), 500);
  }
});
