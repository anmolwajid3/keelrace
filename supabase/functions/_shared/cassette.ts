/**
 * LLM cassette (TimeArch-style replay / record / auto).
 *
 * LLM_MODE:
 *   auto    (default) replay on hit; live if OPENROUTER_API_KEY is set; else miss
 *   replay  never network; miss throws
 *   record  live + append to cassette file when writable
 *   live    always network
 *
 * Lookup order: exact sha256(model+json+messages), canonical (UUIDs stripped),
 * then alias:role:caseFingerprint so frozen evaluation cases hit without an API key.
 */

export type CassetteEntry = {
  content: string;
  alias?: string;
  model?: string;
  recorded_at?: string;
};

export type CassetteFile = {
  version: 1;
  notes?: string;
  entries: Record<string, CassetteEntry>;
};

const LLM_MODE = (Deno.env.get("LLM_MODE") ?? "auto").toLowerCase();
const CASSETTE_PATH =
  Deno.env.get("LLM_CASSETTE_PATH") ??
  new URL("./llm-cassette.json", import.meta.url).pathname;

let cache: CassetteFile | null = null;

export function llmMode() {
  return LLM_MODE;
}

async function loadCassette(): Promise<CassetteFile> {
  if (cache) return cache;
  try {
    const text = await Deno.readTextFile(new URL("./llm-cassette.json", import.meta.url));
    cache = JSON.parse(text) as CassetteFile;
  } catch {
    try {
      const text = await Deno.readTextFile(CASSETTE_PATH);
      cache = JSON.parse(text) as CassetteFile;
    } catch {
      cache = { version: 1, entries: {} };
    }
  }
  if (!cache!.entries) cache!.entries = {};
  return cache!;
}

async function saveCassette(c: CassetteFile) {
  cache = c;
  try {
    await Deno.writeTextFile(CASSETTE_PATH, JSON.stringify(c, null, 2));
  } catch (e) {
    console.warn(`[cassette] write failed: ${(e as Error).message}`);
  }
}

export async function sha256Hex(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function canonicalMessages(messages: { role: string; content: unknown }[]) {
  const strip = (s: string) =>
    s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, "UUID");
  return messages.map((m) => ({
    role: m.role,
    content: typeof m.content === "string" ? strip(m.content) : m.content,
  }));
}

export function detectRole(messages: { role: string; content: unknown }[]) {
  const blob = messages.map((m) => String(m.content ?? "")).join("\n").toLowerCase();
  if (blob.includes("requirements critic")) return "critic";
  if (blob.includes("add-style architectural drivers")) return "drivers";
  if (blob.includes("propose 2 or 3 architecture candidates") || blob.includes("propose exactly 3 named")) return "candidates";
  if (blob.includes("devil's advocate") || blob.includes("devils advocate")) return "challenge";
  if (blob.includes("draft an adr") || blob.includes("leave chosen_option empty")) return "draft_adr";
  if (blob.includes("walk an atam scenario")) return "walk_scenarios";
  if (blob.includes("compare one architecture candidate")) return "compare_candidates";
  if (blob.includes("sensitivity and trade-off")) return "propose_points";
  if (blob.includes("atam/saam") || blob.includes("utility tree")) return "scenarios";
  if (blob.includes("produce mermaid")) return "views";
  if (blob.includes("change-blast brief")) return "change_brief";
  if (blob.includes("file-to-component mappings")) return "map_paths";
  if (blob.includes("this project's recorded architecture")) return "ask";
  if (blob.includes("high-level design") || blob.includes("generating a high-level design")) return "generate_hld";
  if (blob.includes("fix mermaid only")) return "mermaid_fix";
  return "other";
}

export function caseFingerprint(messages: { role: string; content: unknown }[]) {
  const user = messages.filter((m) => m.role === "user").map((m) => String(m.content ?? "")).join("\n");
  const canon = user.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, "UUID");
  const reqLines = canon
    .split(/\n/)
    .map((l) => l.trim())
    .filter((l) => /^(FR|NFR|CON|QA|UC)-\d+/i.test(l) || /[A-Z]{1,6}-\d+:/.test(l))
    .slice(0, 40)
    .join("\n");
  return reqLines || canon.slice(0, 1200);
}

export async function cassetteKeys(
  model: string,
  json: boolean,
  messages: { role: string; content: unknown }[],
) {
  const exactPayload = JSON.stringify({ model, json: !!json, messages });
  const canonPayload = JSON.stringify({ model, json: !!json, messages: canonicalMessages(messages) });
  const exact = await sha256Hex(exactPayload);
  const canonical = await sha256Hex(canonPayload);
  const role = detectRole(messages);
  const fp = await sha256Hex(caseFingerprint(messages));
  const alias = `alias:${role}:${fp.slice(0, 16)}`;
  const roleOnly = `alias:${role}:default`;
  return { exact, canonical, alias, roleOnly, role };
}

export async function cassetteLookup(
  model: string,
  json: boolean,
  messages: { role: string; content: unknown }[],
): Promise<{ content: string; hit: string } | null> {
  const cassette = await loadCassette();
  const keys = await cassetteKeys(model, json, messages);
  for (const [name, key] of [
    ["exact", keys.exact],
    ["canonical", keys.canonical],
    ["alias", keys.alias],
    ["role", keys.roleOnly],
  ] as const) {
    const hit = cassette.entries[key];
    if (hit?.content) return { content: hit.content, hit: name };
  }
  return null;
}

export async function cassetteRecord(
  model: string,
  json: boolean,
  messages: { role: string; content: unknown }[],
  content: string,
) {
  const cassette = await loadCassette();
  const keys = await cassetteKeys(model, json, messages);
  const entry: CassetteEntry = {
    content,
    alias: keys.alias,
    model,
    recorded_at: new Date().toISOString(),
  };
  cassette.entries[keys.exact] = entry;
  cassette.entries[keys.canonical] = entry;
  cassette.entries[keys.alias] = entry;
  await saveCassette(cassette);
}

export { LLM_MODE };
