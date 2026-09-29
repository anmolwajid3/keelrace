// Extracts plain text from an uploaded .docx (via mammoth) or .pdf (via
// unpdf, built for edge runtimes -- no native deps, works on raw bytes).
// This is the highest-risk piece of the import feature: both libraries are
// pulled in via npm: specifiers at Supabase's deploy time, and neither has
// been exercised against the actual Supabase Edge Runtime here. If mammoth
// or unpdf don't work cleanly in that environment, the fallback is: paste
// the extracted text directly into the Requirements tab's textarea instead
// of uploading a file -- parse-requirements-text works on raw text either
// way and doesn't care how you got it.
import { corsHeaders, errorResponse, json } from "../_shared/lib.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const { file_base64, mime_type } = await req.json();
    if (!file_base64 || !mime_type) return errorResponse("file_base64 and mime_type are required");
    if (!["docx", "pdf"].includes(mime_type)) return errorResponse("mime_type must be 'docx' or 'pdf'");

    const bytes = Uint8Array.from(atob(file_base64), (c) => c.charCodeAt(0));
    let text: string;

    if (mime_type === "docx") {
      const { default: mammoth } = await import("npm:mammoth@1.8.0");
      const { Buffer } = await import("node:buffer");
      const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
      text = result.value;
    } else {
      const { getDocumentProxy, extractText } = await import("npm:unpdf@0.11.0");
      const pdf = await getDocumentProxy(bytes);
      const extracted = await extractText(pdf, { mergePages: true });
      text = Array.isArray(extracted.text) ? extracted.text.join("\n") : extracted.text;
    }

    if (!text?.trim()) return errorResponse("No text could be extracted from this file", 422);
    return json({ text });
  } catch (e) {
    console.error(e);
    return errorResponse(
      `${String(e)} -- if this keeps failing, paste the document's text directly into the Requirements tab instead of uploading the file.`,
      500,
    );
  }
});