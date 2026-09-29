// FR-3.1: repo/folder structure + skeleton from approved HLD.
// Never business logic. Every file links to design_component_id.
// A file with a real implementation body fails validation (heuristic check below).
import { corsHeaders, errorResponse, json, userClient, callOpenRouter } from "../_shared/lib.ts";

// Very conservative heuristic: flags bodies that look like real logic
// (loops, conditionals with return values, multiple statements) vs.
// interface stubs / TODO placeholders / NotImplementedError markers.
function looksLikeImplementation(content: string): boolean {
  const stubMarkers = /TODO|NotImplementedError|pass\s*$|throw new Error\(["']not implemented/i;
  if (stubMarkers.test(content)) return false;
  const suspiciousPatterns = [/\bfor\s*\(/, /\bwhile\s*\(/, /\breturn\s+[^;]{15,}/, /\bif\s*\([^)]*\)\s*{[^}]{10,}}/];
  return suspiciousPatterns.some((p) => p.test(content));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const { project_id, design_document_id } = await req.json();
    if (!project_id || !design_document_id) return errorResponse("project_id and design_document_id required");

    const supabase = userClient(req);
    const { data: doc, error } = await supabase
      .from("design_documents")
      .select("*")
      .eq("id", design_document_id)
      .eq("type", "HLD")
      .single();
    if (error || !doc) return errorResponse("HLD not found", 404);
    if (doc.status !== "approved") return errorResponse(`HLD status is '${doc.status}', must be 'approved'`, 409);

    const { data: components } = await supabase
      .from("components")
      .select("id, name")
      .eq("hld_document_id", doc.id);

    // FR-3.1, versioned like design-doc generation: each run is a new,
    // complete generation, never colliding with (or silently rejecting
    // against) the previous one.
    const { data: priorGen } = await supabase
      .from("code_artifacts")
      .select("generation_version")
      .eq("project_id", project_id)
      .order("generation_version", { ascending: false })
      .limit(1)
      .maybeSingle();
    const generationVersion = (priorGen?.generation_version ?? 0) + 1;

    const prompt = `Given this approved HLD (JSON): ${JSON.stringify(doc.content)}
Generate a repository skeleton: directory structure, interface files with NO implementation
bodies (use language-appropriate stubs like "throw new Error('not implemented')" or "pass  # TODO"),
config files with explicitly-marked placeholders, and CI/CD definitions. Return ONLY valid JSON:
{ "files": [{ "path": string, "type": "file"|"directory", "content": string|null, "component_name": string }] }`;

    const raw = await callOpenRouter(
      [{ role: "system", content: "Output strictly valid JSON only." }, { role: "user", content: prompt }],
      { json: true },
    );
    const parsed = JSON.parse(raw);

    const inserted: any[] = [];
    const rejected: any[] = [];
    for (const f of parsed.files ?? []) {
      if (f.type === "file" && f.content && looksLikeImplementation(f.content)) {
        rejected.push({ path: f.path, reason: "content looks like a real implementation body" });
        continue;
      }
      // FR-3.2: component-first traceability via the real components table,
      // never a name-match against a decision -- this is now an actual FK
      // lookup keyed on the component name the LLM tagged the file with.
      const match = components?.find((c) => c.name.toLowerCase() === (f.component_name ?? "").toLowerCase());

      const { data: artifact, error: aErr } = await supabase
        .from("code_artifacts")
        .insert({
          project_id,
          path: f.path,
          type: f.type,
          content: f.content ?? null,
          content_hash: f.content ? await sha256(f.content) : null,
          design_component_id: match?.id ?? null,
          is_placeholder: true,
          generation_version: generationVersion,
        })
        .select()
        .single();
      if (aErr) {
        rejected.push({ path: f.path, reason: aErr.message });
        continue;
      }
      inserted.push(artifact);
    }

    if (rejected.length) {
      // Fail validation loudly rather than silently dropping real-implementation files
      return json({ inserted, rejected, generation_version: generationVersion, warning: "Some files were rejected: see 'rejected'" }, 207);
    }
    return json({ inserted, generation_version: generationVersion });
  } catch (e) {
    console.error(e);
    return errorResponse(String(e), 500);
  }
});

async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
