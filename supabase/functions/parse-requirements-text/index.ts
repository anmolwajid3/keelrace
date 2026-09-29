// Turns raw SRS-document text (however it got here -- extracted from a
// .docx/.pdf upload, or pasted directly) into a structured, reviewable list
// of requirements. This never writes to the database itself -- it returns
// candidates for the person to check, edit, deselect, or reclassify before
// anything is actually imported, exactly like generate-design-docs never
// auto-approves what it produces.
import { corsHeaders, errorResponse, json, userClient, callOpenRouter } from "../_shared/lib.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const { raw_text } = await req.json();
    if (!raw_text?.trim()) return errorResponse("raw_text is required");

    // Confirm the caller is authenticated at all (RLS on the actual import
    // inserts is what really protects the data; this just rejects anonymous use).
    const supabase = userClient(req);
    const { data: userData } = await supabase.auth.getUser();
    if (!userData?.user) return errorResponse("unauthenticated", 401);

    const prompt = `Extract every requirement, non-functional requirement, and constraint from this
software requirements document. Preserve original IDs (FR-001, NFR-014, CON-003, etc.) exactly as
written when the document gives one. If an ID is referenced elsewhere in the document (e.g. in a
traceability matrix or quality-attributes table) but its own definition text isn't given anywhere in
this excerpt, do NOT invent text for it -- omit it entirely rather than guessing.

Classify each item as one of:
- "FR": a functional requirement (a feature/capability/flow the system must have)
- "NFR": a non-functional/performance/quality requirement (numeric thresholds, -ilities, quality attributes)
- "CON": a constraint (a limitation on technology, platform, business model, or process)

Document:
"""
${raw_text.slice(0, 40000)}
"""

Return ONLY valid JSON, no markdown fences, no prose:
{
  "items": [
    { "ref_code": string, "type": "FR" | "NFR" | "CON", "title": string, "body": string }
  ]
}`;

    const raw = await callOpenRouter(
      [
        { role: "system", content: "You output strictly valid JSON, no markdown fences, no prose. You never invent requirement text that isn't grounded in the source document." },
        { role: "user", content: prompt },
      ],
      { json: true },
    );
    const parsed = JSON.parse(raw);

    const items = (parsed.items ?? []).filter((i: any) => i.ref_code && i.title && i.body && ["FR", "NFR", "CON"].includes(i.type));
    return json({ items, truncated: raw_text.length > 40000 });
  } catch (e) {
    console.error(e);
    return errorResponse(String(e), 500);
  }
});