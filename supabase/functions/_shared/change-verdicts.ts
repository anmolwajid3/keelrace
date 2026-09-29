// Writes one verdict per in-force rule the change text overlaps.
// A later call with the same text does not insert again. The caller still
// receives the stored rows, so a break keeps blocking resolve.

export async function writeChangeVerdicts(
  supabase: any,
  args: {
    change_request_id?: string | null;
    signal_id?: string | null;
    project_id?: string | null;
    proposed_text?: string | null;
  },
) {
  let text = args.proposed_text || "";
  let claimed = "";
  let covers: Record<string, unknown> = {};
  let projectId = args.project_id || null;

  if (args.change_request_id) {
    const { data } = await supabase
      .from("change_requests")
      .select("description, proposed_text, claimed_ending, covers, project_id")
      .eq("id", args.change_request_id)
      .maybeSingle();
    if (data) {
      text = data.proposed_text || data.description || text;
      claimed = data.claimed_ending || text;
      covers = data.covers || {};
      projectId = data.project_id;
    }
  } else if (args.signal_id) {
    const { data } = await supabase
      .from("signals")
      .select("description, claimed_ending, project_id")
      .eq("id", args.signal_id)
      .maybeSingle();
    if (data) {
      text = args.proposed_text || data.description || text;
      claimed = data.claimed_ending || text;
      projectId = data.project_id;
    }
  }

  if (!projectId || !text) return [];

  const prefix = args.change_request_id || args.signal_id || projectId;
  const optionKey = `${prefix}:${await shortHash(text)}`;
  const { error } = await supabase.rpc("write_rule_verdicts", {
    p_project_id: projectId,
    p_subject: args.change_request_id ? "change_request" : "signal",
    p_options: [{
      option_key: optionKey,
      option_text: text,
      claimed_ending: claimed,
      covers,
    }],
    p_change_request_id: args.change_request_id ?? null,
    p_signal_id: args.signal_id ?? null,
  });
  if (error) throw error;

  let query = supabase
    .from("rule_verdicts")
    .select("id, result, reason, option_key, standing_rule_id, standing_rules(status, rule_text)")
    .eq("option_key", optionKey);
  if (args.change_request_id) query = query.eq("change_request_id", args.change_request_id);
  else query = query.eq("signal_id", args.signal_id);
  const { data: rows, error: readErr } = await query;
  if (readErr) throw readErr;
  return (rows ?? []).filter((row: any) => row.standing_rules?.status === "in_force");
}

async function shortHash(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
}
