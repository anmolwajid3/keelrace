import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { cassetteLookup, cassetteRecord, LLM_MODE } from "./cassette.ts";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// Client that acts AS the calling user (respects RLS) -- use for reads/writes
// that should be subject to the same policies the user has.
export function userClient(req: Request) {
  const authHeader = req.headers.get("Authorization")!;
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );
}

// Service-role client -- bypasses RLS. Use ONLY for system-triggered writes
// (e.g. detect-drift running on a CI webhook, not on behalf of one user).
export function serviceClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

function stripFence(content: string, json: boolean) {
  if (!json) return content;
  let out = content.trim();
  const fenced = out.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/);
  if (fenced) out = fenced[1].trim();
  return out;
}

export async function callOpenRouter(
  messages: { role: string; content: unknown }[],
  opts: { model?: string; json?: boolean } = {},
) {
  const model = opts.model ?? "anthropic/claude-sonnet-4.5";
  const json = !!opts.json;
  const mode = LLM_MODE;

  if (mode === "replay" || mode === "auto") {
    const hit = await cassetteLookup(model, json, messages);
    if (hit) return stripFence(hit.content, json);
    if (mode === "replay") {
      throw new Error(
        `[llm] replay miss (model=${model}). Re-record with LLM_MODE=record or run scripts/reproduce.mjs.`,
      );
    }
  }

  const apiKey = Deno.env.get("OPENROUTER_API_KEY");
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY secret not set (and no cassette hit)");
  }

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      ...(json ? { response_format: { type: "json_object" } } : {}),
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter error ${res.status}: ${text}`);
  }
  const data = await res.json();
  let content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenRouter returned no content");
  content = stripFence(content, json);

  if (mode === "record") {
    await cassetteRecord(model, json, messages, content);
  }

  return content as string;
}

/** Small/fast for extract & classify; stronger model for trade-offs. */
export function assistModel(kind: "extract" | "reason" | "vision") {
  if (kind === "extract") return Deno.env.get("KEELRACE_EXTRACT_MODEL") || "openai/gpt-4o-mini";
  if (kind === "vision") return Deno.env.get("KEELRACE_VISION_MODEL") || "openai/gpt-4o-mini";
  return Deno.env.get("KEELRACE_REASON_MODEL") || "anthropic/claude-sonnet-4.5";
}

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export function errorResponse(message: string, status = 400) {
  return json({ error: message }, status);
}