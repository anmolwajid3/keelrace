// FR-10.5: once a change is approved, generate a new version of each affected
// DesignDocument (reusing FR-1.1's versioning -- prior version becomes
// 'superseded', never deleted). The originating ChangeRequest/Signal is marked
// 'resolved' and permanently linked to the document version it produced.
import { corsHeaders, errorResponse, json, userClient } from "../_shared/lib.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const { change_request_id, signal_id, design_document_id } = await req.json();
    if ((!change_request_id && !signal_id) || (change_request_id && signal_id)) {
      return errorResponse("exactly one of change_request_id / signal_id is required");
    }
    if (!design_document_id) return errorResponse("design_document_id (the new version) is required");

    const supabase = userClient(req);

    const { data: newDoc, error: docErr } = await supabase
      .from("design_documents")
      .select("*")
      .eq("id", design_document_id)
      .single();
    if (docErr || !newDoc) return errorResponse("New design_document version not found", 404);

    // Find the prior version of the same document type, within the same
    // project (not the same requirement_set_id -- applying a requirement
    // change produces a brand new RequirementSet version, so the previous
    // HLD/LLD lives under a different requirement_set_id entirely).
    const { data: newSetRow } = await supabase.from("requirement_sets").select("project_id").eq("id", newDoc.requirement_set_id).single();
    const { data: siblingSets } = await supabase.from("requirement_sets").select("id").eq("project_id", newSetRow?.project_id);
    const siblingSetIds = (siblingSets ?? []).map((s: any) => s.id);

    const { data: priorDocs } = await supabase
      .from("design_documents")
      .select("id, version, requirement_set_id")
      .in("requirement_set_id", siblingSetIds)
      .eq("type", newDoc.type)
      .neq("id", newDoc.id)
      .eq("status", "approved") // supersede whatever was the current approved one
      .order("generated_at", { ascending: false })
      .limit(1);
    const prior = priorDocs?.[0];

    if (prior) {
      const { error: supersedeErr } = await supabase
        .from("design_documents")
        .update({ status: "superseded", superseded_by: newDoc.id })
        .eq("id", prior.id);
      if (supersedeErr) throw supersedeErr;
    }

    // Clear needs_review now that the new version resolves it
    await supabase.from("design_documents").update({ needs_review: false }).eq("id", newDoc.id);

    if (change_request_id) {
      const { error } = await supabase
        .from("change_requests")
        .update({ status: "resolved", resolved_document_version_id: newDoc.id })
        .eq("id", change_request_id);
      if (error) throw error;
    } else {
      const { error } = await supabase
        .from("signals")
        .update({ status: "resolved", resolved_document_version_id: newDoc.id })
        .eq("id", signal_id);
      if (error) throw error;
    }

    return json({ new_document: newDoc, superseded: prior ?? null });
  } catch (e) {
    console.error(e);
    return errorResponse(String(e), 500);
  }
});
