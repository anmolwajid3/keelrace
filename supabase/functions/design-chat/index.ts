// FR-1.2: "DesignChatThread lets a human ask follow-up questions against a
// specific DecisionRationale, grounded only in that rationale and its cited
// requirements." We build the prompt from exactly those two things and
// nothing else, and store the exchange for the record.
import { corsHeaders, errorResponse, json, userClient, callOpenRouter } from "../_shared/lib.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const { decision_rationale_id, question } = await req.json();
    if (!decision_rationale_id || !question) return errorResponse("decision_rationale_id and question are required");

    const supabase = userClient(req);
    const { data: userData } = await supabase.auth.getUser();
    const userId = userData?.user?.id;
    if (!userId) return errorResponse("unauthenticated", 401);

    const { data: dr, error: drErr } = await supabase
      .from("decision_rationales")
      .select("id, decision_point, chosen_option, alternatives_considered, driving_requirements")
      .eq("id", decision_rationale_id)
      .single();
    if (drErr || !dr) return errorResponse("DecisionRationale not found", 404);

    const { data: requirements } = await supabase
      .from("requirements")
      .select("ref_code, title, body")
      .in("id", dr.driving_requirements ?? []);

    // find-or-create the single thread for this rationale
    let { data: thread } = await supabase
      .from("design_chat_threads")
      .select("*")
      .eq("decision_rationale_id", decision_rationale_id)
      .maybeSingle();
    if (!thread) {
      const { data: newThread, error: tErr } = await supabase
        .from("design_chat_threads")
        .insert({ decision_rationale_id, created_by: userId, title: dr.decision_point })
        .select()
        .single();
      if (tErr) throw tErr;
      thread = newThread;
    }

    const { data: priorMessages } = await supabase
      .from("design_chat_messages")
      .select("role, content")
      .eq("thread_id", thread.id)
      .order("created_at", { ascending: true });

    const groundingPrompt = `You answer questions about ONE architecture decision. You may reference ONLY the
decision below and the requirements that drove it. If the answer isn't contained in this material, say so
explicitly rather than speculating or pulling in outside knowledge.

Decision point: ${dr.decision_point}
Chosen option: ${dr.chosen_option}
Alternatives considered: ${JSON.stringify(dr.alternatives_considered)}

Driving requirements (the ONLY source of "why"):
${(requirements ?? []).map((r) => `- ${r.ref_code}: ${r.title}\n  ${r.body}`).join("\n")}`;

    const messages = [
      { role: "system", content: groundingPrompt },
      ...(priorMessages ?? []).map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: question },
    ];

    const answer = await callOpenRouter(messages);

    await supabase.from("design_chat_messages").insert([
      { decision_rationale_id, thread_id: thread.id, role: "user", content: question },
      { decision_rationale_id, thread_id: thread.id, role: "assistant", content: answer },
    ]);

    return json({ thread_id: thread.id, answer });
  } catch (e) {
    console.error(e);
    return errorResponse(String(e), 500);
  }
});
