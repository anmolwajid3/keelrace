// FR-1.3: prototype generation, gated on design_document.status === 'approved'.
// Always traces to the exact document version. Regenerating after supersession
// requires an explicit new call against the new version (no implicit chaining).
import { corsHeaders, errorResponse, json, userClient, callOpenRouter } from "../_shared/lib.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const { design_document_id, type } = await req.json();
    if (!design_document_id || !["wireframe", "flow-diagram"].includes(type)) {
      return errorResponse("design_document_id and valid type are required");
    }

    const supabase = userClient(req);
    const { data: doc, error } = await supabase
      .from("design_documents")
      .select("*")
      .eq("id", design_document_id)
      .single();
    if (error || !doc) return errorResponse("DesignDocument not found", 404);

    if (doc.status !== "approved") {
      return errorResponse(`DesignDocument status is '${doc.status}', must be 'approved'`, 409);
    }

    const prompt = `Given this approved design document content (JSON): ${JSON.stringify(doc.content)}
Produce a ${type} for user-facing components only. Return ONLY valid JSON:
{ "nodes": [{ "id": string, "label": string, "kind": string }], "edges": [{ "from": string, "to": string, "label": string }] }`;

    const raw = await callOpenRouter(
      [
        { role: "system", content: "Output strictly valid JSON only." },
        { role: "user", content: prompt },
      ],
      { json: true },
    );

    const { data: proto, error: pErr } = await supabase
      .from("prototypes")
      .insert({
        design_document_id: doc.id, // traces to exact version, not "latest"
        type,
        content: JSON.parse(raw),
      })
      .select()
      .single();
    if (pErr) throw pErr;

    return json(proto);
  } catch (e) {
    console.error(e);
    return errorResponse(String(e), 500);
  }
});
