// FR-7.3 (also reused by FR-10.4 step 1): walk backward from the affected
// Requirement, following every decision_rationales.driving_requirements link
// that cites it. Returns the actual traversed list -- never a bare count --
// so callers/UI can show *why* something is in scope.
import { corsHeaders, errorResponse, json, userClient } from "../_shared/lib.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const { requirement_id } = await req.json();
    if (!requirement_id) return errorResponse("requirement_id is required");

    const supabase = userClient(req);

    // Direct citations: decision_rationales whose driving_requirements array contains this requirement
    const { data: directRationales, error } = await supabase
      .from("decision_rationales")
      .select("id, decision_point, design_document_id, driving_requirements")
      .contains("driving_requirements", [requirement_id]);
    if (error) throw error;

    const rationaleIds = (directRationales ?? []).map((r: any) => r.id);
    const docIds = [...new Set((directRationales ?? []).map((r: any) => r.design_document_id))];

    let docs: any[] = [];
    if (docIds.length) {
      const { data } = await supabase.from("design_documents").select("id, type, version, status").in("id", docIds);
      docs = data ?? [];
    }

    return json({
      requirement_id,
      traced_decision_rationales: directRationales ?? [],
      traced_design_documents: docs,
      // "explainable -- the actual traversed list, not a bare count"
      summary: {
        rationale_count: rationaleIds.length,
        document_count: docs.length,
      },
    });
  } catch (e) {
    console.error(e);
    return errorResponse(String(e), 500);
  }
});
