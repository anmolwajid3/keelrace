import { corsHeaders, errorResponse, json, userClient, callOpenRouter, assistModel } from "../_shared/lib.ts";
import { constraintVerdict } from "../_shared/rule-check.mjs";
import { persistScenarios, heuristicScenarioList, runWalkScenarios, runCompareCandidates, runProposePoints } from "./qa-workshop.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const body = await req.json();
    const action = String(body.action || "");
    const supabase = userClient(req);
    const { data: userData } = await supabase.auth.getUser();
    const userId = userData?.user?.id;
    if (!userId) return errorResponse("unauthenticated", 401);
    if (!body.project_id) return errorResponse("project_id is required");

    const { data: member } = await supabase.from("projects").select("id, name").eq("id", body.project_id).maybeSingle();
    if (!member) return errorResponse("project not found", 404);

    switch (action) {
      case "critic":
        return json(await runCritic(supabase, body));
      case "drivers":
        return json(await runDrivers(supabase, body));
      case "candidates":
        return json(await runCandidates(supabase, body));
      case "challenge":
        return json(await runChallenge(supabase, body));
      case "draft_adr":
        return json(await runDraftAdr(supabase, body));
      case "scenarios":
        return json(await runScenarios(supabase, body));
      case "walk_scenarios":
        return json(await runWalk(supabase, body));
      case "compare_candidates":
        return json(await runCompare(supabase, body));
      case "propose_points":
        return json(await runPoints(supabase, body));
      case "ask":
        return json(await runAsk(supabase, body, userId));
      case "map_paths":
        return json(await runMapPaths(supabase, body));
      case "change_brief":
        return json(await runChangeBrief(supabase, body));
      case "views":
        return json(await runViews(supabase, body));
      case "notes":
        return json(await runNotes(supabase, body));
      default:
        return errorResponse("Unknown action. Use critic, drivers, candidates, challenge, draft_adr, scenarios, walk_scenarios, compare_candidates, propose_points, ask, map_paths, change_brief, views, notes.");
    }
  } catch (e) {
    console.error(e);
    return errorResponse(String(e), 500);
  }
});

function parseJson(raw: string) {
  try {
    return JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error("Model did not return JSON");
  }
}

function mermaidValid(src: string | null | undefined) {
  if (!src || typeof src !== "string") return false;
  const s = src.trim();
  if (!/^(flowchart|graph|sequenceDiagram|C4Context|C4Container)/m.test(s)) return false;
  if (/[A-Za-z][A-Za-z0-9]*[ \t]+[A-Za-z][A-Za-z0-9]*[ \t]*\[/.test(s)) return false;
  return s.length < 8000;
}

async function retrieveKnowledge(supabase: ReturnType<typeof userClient>, query: string, limit = 5) {
  const words = String(query || "").split(/\W+/).filter((w) => w.length > 3).slice(0, 8);
  const q = words.join(" or ") || "architecture";
  const { data, error } = await supabase
    .from("architecture_knowledge")
    .select("id, framework, category, title, body")
    .textSearch("search_text", q, { type: "websearch", config: "english" })
    .limit(limit);
  if (!error && data?.length) return data;
  const { data: fallback } = await supabase.from("architecture_knowledge").select("id, framework, category, title, body").limit(limit);
  return fallback ?? [];
}

function groundingFrom(chunks: { id: string; framework: string; title: string }[]) {
  return chunks.map((c) => ({ knowledge_id: c.id, framework: c.framework, title: c.title }));
}

async function loadReqs(supabase: ReturnType<typeof userClient>, projectId: string, requirementSetId?: string) {
  let setId = requirementSetId;
  if (!setId) {
    const { data: sets } = await supabase.from("requirement_sets").select("id").eq("project_id", projectId).order("version", { ascending: false }).limit(1);
    setId = sets?.[0]?.id;
  }
  if (!setId) return { setId: null as string | null, reqs: [] as { id: string; ref_code: string; title: string; body: string }[] };
  const { data: reqs } = await supabase.from("requirements").select("id, ref_code, title, body").eq("requirement_set_id", setId).order("ref_code");
  return { setId, reqs: reqs ?? [] };
}

async function loadAcceptedDrivers(supabase: ReturnType<typeof userClient>, projectId: string) {
  const { data } = await supabase.from("architectural_drivers").select("*").eq("project_id", projectId).eq("status", "accepted");
  return data ?? [];
}

function heuristicCritic(reqs: { id: string; ref_code: string; title: string; body: string }[]) {
  const findings: Record<string, unknown>[] = [];
  for (const r of reqs) {
    const text = `${r.title} ${r.body}`;
    if (/\band\b/i.test(r.title) || (r.body.match(/\band\b/gi) || []).length >= 2) {
      findings.push({
        kind: "critic",
        severity: "medium",
        title: `${r.ref_code} looks compound`,
        body: "More than one demand in one statement. Split if they can fail independently.",
        suggested_rewrite: null,
        target: { requirement_id: r.id, ref_code: r.ref_code },
        confidence: "partial",
        questions: [],
      });
    }
    if (!/\b(shall|must|will|should)\b/i.test(text)) {
      findings.push({
        kind: "critic",
        severity: "low",
        title: `${r.ref_code} has no obligation verb`,
        body: "29148-style requirements usually use shall/must. Confirm this is verifiable.",
        target: { requirement_id: r.id, ref_code: r.ref_code },
        confidence: "partial",
        questions: ["What test would fail if this were absent?"],
      });
    }
  }
  return findings;
}

async function runCritic(supabase: ReturnType<typeof userClient>, body: Record<string, unknown>) {
  const projectId = String(body.project_id);
  const { setId, reqs } = await loadReqs(supabase, projectId, body.requirement_set_id as string | undefined);
  if (!reqs.length) throw new Error("No requirements to criticise.");
  const knowledge = await retrieveKnowledge(supabase, "requirement verifiable singular 29148", 4);
  let parsed: { findings?: unknown[] } = { findings: heuristicCritic(reqs) };
  try {
    const raw = await callOpenRouter(
      [
        { role: "system", content: "You are a requirements critic, not an architect. You do not design systems. Output JSON only. Never mark anything approved." },
        {
          role: "user",
          content: `Critique these requirements using ISO/IEC/IEEE 29148 / INCOSE-style rules (singular, verifiable, no hidden design unless it is a constraint).
Knowledge:
${knowledge.map((k) => `- ${k.framework}: ${k.title}: ${k.body}`).join("\n")}

Requirements:
${reqs.map((r) => `${r.id} ${r.ref_code}: ${r.title}\n${r.body}`).join("\n\n")}

Return JSON: { "findings": [{ "requirement_id": "uuid from list", "severity": "low"|"medium"|"high", "title": "", "body": "", "suggested_rewrite": ""|null, "confidence": "grounded"|"partial"|"ungrounded", "questions": ["..."] }] }
Only use requirement ids from the list.`,
        },
      ],
      { model: assistModel("extract"), json: true },
    );
    parsed = parseJson(raw);
  } catch {
    /* keep heuristic */
  }
  const allowed = new Set(reqs.map((r) => r.id));
  const rows = [];
  for (const f of parsed.findings ?? []) {
    const rec = f as Record<string, unknown>;
    const rid = String(rec.requirement_id || "");
    if (!allowed.has(rid)) continue;
    const req = reqs.find((r) => r.id === rid);
    const { data } = await supabase.from("assist_findings").insert({
      project_id: projectId,
      kind: "critic",
      severity: ["low", "medium", "high"].includes(String(rec.severity)) ? rec.severity : "info",
      title: String(rec.title || `${req?.ref_code} issue`).slice(0, 240),
      body: String(rec.body || ""),
      suggested_rewrite: rec.suggested_rewrite ? String(rec.suggested_rewrite) : null,
      target: { requirement_id: rid, ref_code: req?.ref_code, requirement_set_id: setId },
      grounding: groundingFrom(knowledge),
      confidence: ["grounded", "partial", "ungrounded"].includes(String(rec.confidence)) ? rec.confidence : "partial",
    }).select().single();
    if (data) rows.push(data);
  }
  return { findings: rows, model: assistModel("extract"), note: "Suggestions only. Lock and approval stay with the architect." };
}

async function runDrivers(supabase: ReturnType<typeof userClient>, body: Record<string, unknown>) {
  const projectId = String(body.project_id);
  const { setId, reqs } = await loadReqs(supabase, projectId, body.requirement_set_id as string | undefined);
  if (!reqs.length) throw new Error("No requirements.");
  const knowledge = await retrieveKnowledge(supabase, "architectural driver quality attribute scenario ADD", 5);
  const raw = await callOpenRouter(
    [
      { role: "system", content: "You extract ADD-style architectural drivers. You do not choose the architecture. Output JSON only." },
      {
        role: "user",
        content: `From these requirements, propose architectural drivers (quality-attribute scenarios).
Each driver: quality_attribute (ISO 25010 characteristic), title, stimulus, environment, response, response_measure (how you would tell the response happened), tactic (ADD tactic name if known), tactic_element (where the tactic would sit), source_requirement_ids (uuids from the list only), confidence, questions the architect must answer because context is missing.

Knowledge:
${knowledge.map((k) => `- ${k.title}: ${k.body}`).join("\n")}

Requirements:
${reqs.map((r) => `${r.id} ${r.ref_code}: ${r.title} — ${r.body}`).join("\n")}

JSON: { "drivers": [{ "quality_attribute": "", "title": "", "stimulus": "", "environment": "", "response": "", "response_measure": "", "tactic": "", "tactic_element": "", "source_requirement_ids": [], "confidence": "grounded"|"partial"|"ungrounded", "questions": [] }] }
Max 8 drivers. Prefer NFRs and constraints.`,
      },
    ],
    { model: assistModel("extract"), json: true },
  );
  const parsed = parseJson(raw);
  const allowed = new Set(reqs.map((r) => r.id));
  const rows = [];
  for (const d of parsed.drivers ?? []) {
    const rec = d as Record<string, unknown>;
    const ids = (Array.isArray(rec.source_requirement_ids) ? rec.source_requirement_ids : [])
      .map(String)
      .filter((id) => allowed.has(id));
    const { data } = await supabase.from("architectural_drivers").insert({
      project_id: projectId,
      requirement_set_id: setId,
      quality_attribute: String(rec.quality_attribute || "other").slice(0, 80),
      title: String(rec.title || "Driver").slice(0, 200),
      stimulus: rec.stimulus ? String(rec.stimulus) : null,
      environment: rec.environment ? String(rec.environment) : null,
      response: rec.response ? String(rec.response) : null,
      response_measure: rec.response_measure ? String(rec.response_measure) : null,
      tactic: rec.tactic ? String(rec.tactic) : null,
      tactic_element: rec.tactic_element ? String(rec.tactic_element) : null,
      source_requirement_ids: ids,
      status: "proposed",
      grounding: groundingFrom(knowledge),
      confidence: ["grounded", "partial", "ungrounded"].includes(String(rec.confidence)) ? rec.confidence : "partial",
      questions: Array.isArray(rec.questions) ? rec.questions : [],
    }).select().single();
    if (data) rows.push(data);
  }
  return { drivers: rows, note: "Accept drivers before treating them as input to design. The model does not decide which matter." };
}

async function runCandidates(supabase: ReturnType<typeof userClient>, body: Record<string, unknown>) {
  const projectId = String(body.project_id);
  const { setId, reqs } = await loadReqs(supabase, projectId, body.requirement_set_id as string | undefined);
  const drivers = await loadAcceptedDrivers(supabase, projectId);
  const knowledge = await retrieveKnowledge(supabase, "modular monolith services event-driven tactics tradeoff overengineering", 6);
  const raw = await callOpenRouter(
    [
      { role: "system", content: "You propose 2 or 3 architecture candidates. You never pick the winner. Output JSON only." },
      {
        role: "user",
        content: `Propose exactly 3 named architecture candidates for this system. Each must list what it optimizes, what it sacrifices, 3-8 components, a mermaid flowchart with SIMPLE node ids (no spaces in ids), confidence, questions, and knowledge titles used.

Accepted drivers (authoritative if present):
${JSON.stringify(drivers, null, 2).slice(0, 6000) || "(none accepted yet — say so in questions)"}

Requirements:
${reqs.map((r) => `${r.ref_code}: ${r.title}`).join("\n")}

Knowledge:
${knowledge.map((k) => `- ${k.title}: ${k.body}`).join("\n")}

JSON: { "candidates": [{ "name": "", "summary": "", "optimizes": "", "sacrifices": "", "components": [{ "name": "", "responsibility": "" }], "mermaid": "flowchart LR\\nA[Name]-->B[Name]", "confidence": "partial", "questions": [], "knowledge_titles": [] }] }`,
      },
    ],
    { model: assistModel("reason"), json: true },
  );
  const parsed = parseJson(raw);
  const rows = [];
  const batch = crypto.randomUUID();
  const reqTexts = reqs.map((r: { title?: string; body?: string }) => `${r.title || ""} ${r.body || ""}`);
  let index = 0;
  for (const c of parsed.candidates ?? []) {
    const rec = c as Record<string, unknown>;
    let mermaid = rec.mermaid ? String(rec.mermaid) : "";
    let valid = mermaidValid(mermaid);
    if (!valid && mermaid) {
      try {
        const retry = await callOpenRouter(
          [
            { role: "system", content: "Fix mermaid only. flowchart LR, node ids [A-Za-z0-9_]+, labels in [brackets]. JSON {mermaid:string}" },
            { role: "user", content: mermaid },
          ],
          { model: assistModel("extract"), json: true },
        );
        mermaid = String(parseJson(retry).mermaid || mermaid);
        valid = mermaidValid(mermaid);
      } catch { /* keep invalid */ }
    }
    index += 1;
    const name = String(rec.name || "Candidate").slice(0, 120);
    const summary = rec.summary ? String(rec.summary) : "";
    const optimizes = rec.optimizes ? String(rec.optimizes) : "";
    const sacrifices = rec.sacrifices ? String(rec.sacrifices) : "";
    const mark = constraintVerdict(reqTexts, `${name} ${summary} ${optimizes} ${sacrifices}`);
    const { data } = await supabase.from("architecture_candidates").insert({
      project_id: projectId,
      requirement_set_id: setId,
      name,
      summary: summary || null,
      optimizes: optimizes || null,
      sacrifices: sacrifices || null,
      components: rec.components ?? [],
      mermaid,
      mermaid_valid: valid,
      grounding: groundingFrom(knowledge),
      confidence: ["grounded", "partial", "ungrounded"].includes(String(rec.confidence)) ? rec.confidence : "partial",
      questions: Array.isArray(rec.questions) ? rec.questions : [],
      status: "proposed",
      generation_index: index,
      generation_batch: batch,
      constraint_verdict: mark.verdict,
      constraint_reason: mark.reason,
    }).select().single();
    if (data) {
      const labels = (Array.isArray(rec.components) ? rec.components : [])
        .map((comp: { name?: string }) => comp?.name)
        .filter(Boolean);
      await supabase.rpc("write_rule_verdicts", {
        p_project_id: projectId,
        p_subject: "candidate",
        p_candidate_id: data.id,
        p_options: [{
          option_key: data.id,
          option_text: `${name}. ${summary}. ${optimizes}. ${sacrifices}`,
          claimed_ending: summary || name,
          covers: { component_ids: [], artifact_ids: [], paths: [], config_keys: [], labels },
        }],
      });
      await critiqueCandidate(supabase, projectId, data, drivers, knowledge);
      rows.push(data);
    }
  }
  return { candidates: rows, note: "Select one candidate. A constraint break stays on screen. Generation of the official HLD remains a separate human action." };
}

async function critiqueCandidate(supabase: any, projectId: string, candidate: any, drivers: unknown, knowledge: { title: string; body: string }[]) {
  try {
    const raw = await callOpenRouter(
      [
        { role: "system", content: "You are a devil's advocate. Do not produce a new architecture. Output JSON findings only. No numeric quality scores. Argue against this candidate specifically." },
        {
          role: "user",
          content: `Attack this one candidate. Look for missed drivers, hidden coupling, single points of failure, over-engineering, and constraints it breaks.

Drivers: ${JSON.stringify(drivers).slice(0, 4000)}
Candidate: ${JSON.stringify(candidate).slice(0, 6000)}
Knowledge: ${knowledge.map((k) => k.title + ": " + k.body).join("\n")}

JSON: { "findings": [{ "severity": "low"|"medium"|"high", "title": "", "body": "", "confidence": "partial", "questions": [] }] }
Max 6 findings.`,
        },
      ],
      { model: assistModel("reason"), json: true },
    );
    const parsed = parseJson(raw);
    for (const f of parsed.findings ?? []) {
      const rec = f as Record<string, unknown>;
      await supabase.from("assist_findings").insert({
        project_id: projectId,
        kind: "challenger",
        severity: ["low", "medium", "high"].includes(String(rec.severity)) ? rec.severity : "medium",
        title: String(rec.title || "Challenge").slice(0, 240),
        body: String(rec.body || ""),
        target: { candidate_id: candidate.id },
        grounding: groundingFrom(knowledge),
        confidence: ["grounded", "partial", "ungrounded"].includes(String(rec.confidence)) ? rec.confidence : "partial",
      });
    }
  } catch {
    await supabase.from("assist_findings").insert({
      project_id: projectId,
      kind: "challenger",
      severity: candidate.constraint_verdict === "breaks" ? "high" : "medium",
      title: candidate.constraint_verdict === "breaks" ? "Constraint break" : "Rule check",
      body: candidate.constraint_reason
        || "No model critique was available for this candidate. It was still checked against stated constraints and standing rules.",
      target: { candidate_id: candidate.id },
      grounding: [],
      confidence: "grounded",
    });
  }
}

async function runChallenge(supabase: ReturnType<typeof userClient>, body: Record<string, unknown>) {
  const projectId = String(body.project_id);
  const drivers = await loadAcceptedDrivers(supabase, projectId);
  const { data: docs } = await supabase
    .from("design_documents")
    .select("id, type, content, status, requirement_sets!inner(project_id)")
    .eq("requirement_sets.project_id", projectId)
    .eq("type", "HLD")
    .order("version", { ascending: false })
    .limit(1);
  const hld = docs?.[0];
  const { data: selected } = await supabase.from("architecture_candidates").select("*").eq("project_id", projectId).eq("status", "selected").limit(1);
  const target = hld?.content || selected?.[0] || null;
  if (!target) throw new Error("No HLD or selected candidate to challenge.");
  const knowledge = await retrieveKnowledge(supabase, "overengineering tradeoff sensitivity availability security", 5);
  const raw = await callOpenRouter(
    [
      { role: "system", content: "You are a devil's advocate. Do not produce a new architecture. Output JSON findings only. No numeric quality scores." },
      {
        role: "user",
        content: `Attack this baseline. Look for missed drivers, hidden coupling, single points of failure, over-engineering, NFRs with no home.

Drivers: ${JSON.stringify(drivers).slice(0, 4000)}
Baseline: ${JSON.stringify(target).slice(0, 8000)}
Knowledge: ${knowledge.map((k) => k.title + ": " + k.body).join("\n")}

JSON: { "findings": [{ "severity": "low"|"medium"|"high", "title": "", "body": "", "confidence": "partial", "questions": [] }] }
Max 10 findings.`,
      },
    ],
    { model: assistModel("reason"), json: true },
  );
  const parsed = parseJson(raw);
  const rows = [];
  for (const f of parsed.findings ?? []) {
    const rec = f as Record<string, unknown>;
    const { data } = await supabase.from("assist_findings").insert({
      project_id: projectId,
      kind: "challenger",
      severity: ["low", "medium", "high"].includes(String(rec.severity)) ? rec.severity : "medium",
      title: String(rec.title || "Challenge").slice(0, 240),
      body: String(rec.body || ""),
      target: { hld_id: hld?.id ?? null, candidate_id: selected?.[0]?.id ?? null },
      grounding: groundingFrom(knowledge),
      confidence: ["grounded", "partial", "ungrounded"].includes(String(rec.confidence)) ? rec.confidence : "partial",
    }).select().single();
    if (data) rows.push(data);
  }
  return { findings: rows, note: "Dismiss or accept each finding. They do not block Approve by themselves." };
}

async function runDraftAdr(supabase: ReturnType<typeof userClient>, body: Record<string, unknown>) {
  const projectId = String(body.project_id);
  const point = String(body.decision_point || "").trim();
  if (!point) throw new Error("decision_point is required — the architect names the question.");
  const { setId, reqs } = await loadReqs(supabase, projectId);
  const drivers = await loadAcceptedDrivers(supabase, projectId);
  const knowledge = await retrieveKnowledge(supabase, `${point} ADR alternatives consequences`, 5);
  const raw = await callOpenRouter(
    [
      { role: "system", content: "Draft an ADR. Leave chosen_option empty. The human must fill the decision. Output JSON." },
      {
        role: "user",
        content: `Decision point from the architect: ${point}

Drivers: ${JSON.stringify(drivers).slice(0, 4000)}
Requirements: ${reqs.map((r) => `${r.id} ${r.ref_code}: ${r.title}`).join("\n")}
Knowledge: ${knowledge.map((k) => k.title + ": " + k.body).join("\n")}

Also draft the standing rule the architect would confirm, without deciding it is in force:
"rule_text" is one sentence that must stay true. "ends_when" lists the allowed endings, separated by " or ". "cover_labels" are short names of the parts this rule covers (a table, an API, a component).

JSON: { "alternatives": [{ "option": "", "rejection_reason": "" }], "suggested_requirement_ids": [], "consequences": "", "rule_text": "", "ends_when": "", "cover_labels": [], "confidence": "partial", "questions": [], "notes_on_missing_context": "" }
suggested_requirement_ids must be uuids from the list. Do not set a winner.`,
      },
    ],
    { model: assistModel("reason"), json: true },
  );
  const parsed = parseJson(raw);
  const allowed = new Set(reqs.map((r) => r.id));
  const suggested = (parsed.suggested_requirement_ids ?? []).map(String).filter((id: string) => allowed.has(id));
  const { data, error } = await supabase.from("assist_adr_drafts").insert({
    project_id: projectId,
    design_document_id: body.design_document_id || null,
    decision_point: point,
    chosen_option: "",
    alternatives: parsed.alternatives ?? [],
    suggested_requirement_ids: suggested,
    consequences: parsed.consequences || parsed.notes_on_missing_context || null,
    rule_text: parsed.rule_text ? String(parsed.rule_text) : null,
    ends_when: parsed.ends_when ? String(parsed.ends_when) : null,
    cover_labels: Array.isArray(parsed.cover_labels) ? parsed.cover_labels.map(String) : [],
    grounding: groundingFrom(knowledge),
    confidence: parsed.confidence || "partial",
    questions: parsed.questions ?? [],
    status: "draft",
  }).select().single();
  if (error) throw error;
  return { draft: data, note: "Record the ADR yourself. Chosen option stays empty until you type it." };
}

async function runScenarios(supabase: ReturnType<typeof userClient>, body: Record<string, unknown>) {
  const projectId = String(body.project_id);
  const drivers = await loadAcceptedDrivers(supabase, projectId);
  const { reqs } = await loadReqs(supabase, projectId);
  const knowledge = await retrieveKnowledge(supabase, "ATAM utility tree SAAM scenario sensitivity tradeoff", 4);
  let parsed: Record<string, unknown> = heuristicScenarioList(drivers, reqs);
  try {
    const raw = await callOpenRouter(
      [
        { role: "system", content: "Generate ATAM/SAAM evaluation scenarios. Do not score the architecture. JSON only." },
        {
          role: "user",
          content: `Build a utility tree and 6-10 scenarios.
Drivers: ${JSON.stringify(drivers).slice(0, 5000)}
Requirements: ${reqs.map((r) => r.ref_code + " " + r.title).join("; ")}
Knowledge: ${knowledge.map((k) => k.body).join("\n")}

JSON: { "utility_tree": [{ "quality": "", "attribute": "", "scenario": "" }], "scenarios": [{ "title": "", "stimulus": "", "environment": "", "response": "", "kind": "use"|"growth"|"exploratory", "quality": "", "confidence": "partial" }] }`,
        },
      ],
      { model: assistModel("reason"), json: true },
    );
    const modelParsed = parseJson(raw);
    if (Array.isArray(modelParsed.scenarios) && modelParsed.scenarios.length) parsed = modelParsed;
  } catch {
    /* keep heuristic */
  }
  const persisted = await persistScenarios(supabase, projectId, parsed, drivers, knowledge);
  return {
    scenarios: persisted.scenarios,
    utility_tree: persisted.utility_tree,
    note: "Mark scenarios in the workshop boundary, then walk them through components. No scores. In-boundary walks are required before HLD approval.",
  };
}

async function runWalk(supabase: ReturnType<typeof userClient>, body: Record<string, unknown>) {
  const knowledge = await retrieveKnowledge(supabase, "ATAM scenario walkthrough sensitivity", 3);
  return runWalkScenarios(supabase, body, knowledge);
}

async function runCompare(supabase: ReturnType<typeof userClient>, body: Record<string, unknown>) {
  return runCompareCandidates(supabase, body);
}

async function runPoints(supabase: ReturnType<typeof userClient>, body: Record<string, unknown>) {
  const knowledge = await retrieveKnowledge(supabase, "sensitivity trade-off points ATAM", 3);
  return runProposePoints(supabase, body, knowledge);
}

async function runAsk(supabase: ReturnType<typeof userClient>, body: Record<string, unknown>, userId: string) {
  const projectId = String(body.project_id);
  const question = String(body.question || "").trim();
  if (!question) throw new Error("question is required");
  const { reqs, setId } = await loadReqs(supabase, projectId);
  const drivers = await loadAcceptedDrivers(supabase, projectId);
  const { data: decisions } = await supabase
    .from("decision_rationales")
    .select("id, decision_point, chosen_option, driving_requirements, design_documents!inner(requirement_sets!inner(project_id))")
    .eq("design_documents.requirement_sets.project_id", projectId)
    .limit(40);
  const { data: contracts } = await supabase.from("service_contracts").select("service_name, type, version").eq("project_id", projectId);
  const { data: comps } = await supabase.from("components").select("id, name, description").eq("project_id", projectId);
  const { data: files } = await supabase.from("code_artifacts").select("path, design_component_id").eq("project_id", projectId).eq("type", "file").limit(80);
  const knowledge = await retrieveKnowledge(supabase, question, 4);

  const record = {
    requirement_set_id: setId,
    requirements: reqs.map((r) => ({ id: r.id, ref_code: r.ref_code, title: r.title, body: r.body })),
    drivers: drivers.map((d) => ({ id: d.id, title: d.title, quality_attribute: d.quality_attribute, status: d.status })),
    components: comps ?? [],
    decisions: (decisions ?? []).map((d) => ({ id: d.id, decision_point: d.decision_point, chosen_option: d.chosen_option })),
    contracts: contracts ?? [],
    files: files ?? [],
  };

  const raw = await callOpenRouter(
    [
      {
        role: "system",
        content: `You answer questions about THIS project's recorded architecture only.
If the record does not contain the answer, say so. Do not invent components, requirements, or decisions.
Cite ref_codes or decision points you used. Output JSON { "answer": "", "citations": ["FR-1", ...], "confidence": "grounded"|"partial"|"ungrounded", "missing": [] }`,
      },
      {
        role: "user",
        content: `Record:\n${JSON.stringify(record).slice(0, 14000)}\n\nKnowledge (for vocabulary only, not facts about this system):\n${knowledge.map((k) => k.title).join(", ")}\n\nQuestion: ${question}`,
      },
    ],
    { model: assistModel("reason"), json: true },
  );
  const parsed = parseJson(raw);
  const answer = String(parsed.answer || "The record does not contain an answer.");
  const citations = Array.isArray(parsed.citations) ? parsed.citations : [];
  const { error: persistErr } = await supabase.from("assist_ask_messages").insert([
    { project_id: projectId, role: "user", content: question },
    { project_id: projectId, role: "assistant", content: answer, citations },
  ]);
  if (persistErr) console.error("assist_ask persist", persistErr.message);
  return { answer, citations, confidence: parsed.confidence || "partial", missing: parsed.missing || [] };
}

async function runMapPaths(supabase: ReturnType<typeof userClient>, body: Record<string, unknown>) {
  const projectId = String(body.project_id);
  const paths = Array.isArray(body.paths) ? body.paths.map(String).slice(0, 80) : [];
  if (!paths.length) throw new Error("paths[] is required");
  const { data: comps } = await supabase.from("components").select("id, name, description").eq("project_id", projectId);
  if (!comps?.length) throw new Error("No components to map onto. Generate or accept a design first.");
  const raw = await callOpenRouter(
    [
      { role: "system", content: "Propose file-to-component mappings. Use only component ids provided. JSON only. This is a suggestion." },
      {
        role: "user",
        content: `Components:\n${comps.map((c) => `${c.id} ${c.name}: ${c.description || ""}`).join("\n")}\n\nPaths:\n${paths.join("\n")}\n\nJSON: { "mappings": [{ "path": "", "component_id": "uuid", "confidence": "partial", "reason": "" }] }`,
      },
    ],
    { model: assistModel("extract"), json: true },
  );
  const parsed = parseJson(raw);
  const allowed = new Set(comps.map((c) => c.id));
  const allowedPaths = new Set(paths);
  const rows = [];
  for (const m of parsed.mappings ?? []) {
    const rec = m as Record<string, unknown>;
    const cid = String(rec.component_id || "");
    const path = String(rec.path || "");
    if (!allowed.has(cid) || !allowedPaths.has(path)) continue;
    const { data } = await supabase.from("assist_findings").insert({
      project_id: projectId,
      kind: "mapping",
      severity: "info",
      title: `${path} → ${comps.find((c) => c.id === cid)?.name}`,
      body: String(rec.reason || ""),
      target: { path, component_id: cid },
      confidence: ["grounded", "partial", "ungrounded"].includes(String(rec.confidence)) ? rec.confidence : "partial",
    }).select().single();
    if (data) rows.push(data);
  }
  return { mappings: rows, note: "Confirm a mapping to write code_artifacts.design_component_id. Suggestions are not identity." };
}

async function runChangeBrief(supabase: ReturnType<typeof userClient>, body: Record<string, unknown>) {
  const projectId = String(body.project_id);
  const requirementId = body.requirement_id ? String(body.requirement_id) : null;
  const description = String(body.description || "");
  let scope: unknown = null;
  if (requirementId) {
    const { data: directRationales } = await supabase
      .from("decision_rationales")
      .select("id, decision_point, design_document_id, driving_requirements")
      .contains("driving_requirements", [requirementId]);
    const { data: teams } = await supabase.from("team_boundaries").select("owning_team, design_component_id").eq("project_id", projectId);
    const { data: contracts } = await supabase.from("service_contracts").select("service_name, type").eq("project_id", projectId);
    scope = { decisions: directRationales ?? [], teams: teams ?? [], contracts: contracts ?? [] };
  }
  const drivers = await loadAcceptedDrivers(supabase, projectId);
  const raw = await callOpenRouter(
    [
      { role: "system", content: "Write a short change-blast brief from the graph. Do not invent new components. JSON." },
      {
        role: "user",
        content: `Change: ${description}
Requirement id: ${requirementId}
Graph: ${JSON.stringify(scope).slice(0, 8000)}
Drivers: ${JSON.stringify(drivers).slice(0, 3000)}

JSON: { "brief": "", "cannot_infer": [], "confidence": "partial" }`,
      },
    ],
    { model: assistModel("extract"), json: true },
  );
  const parsed = parseJson(raw);
  const { data } = await supabase.from("assist_findings").insert({
    project_id: projectId,
    kind: "brief",
    severity: "info",
    title: "Change blast brief",
    body: String(parsed.brief || ""),
    target: { requirement_id: requirementId, cannot_infer: parsed.cannot_infer ?? [] },
    confidence: parsed.confidence || "partial",
  }).select().single();
  return { finding: data, scope, note: "Triage remains human." };
}

async function runViews(supabase: ReturnType<typeof userClient>, body: Record<string, unknown>) {
  const projectId = String(body.project_id);
  const { data: comps } = await supabase.from("components").select("id, name, description").eq("project_id", projectId);
  const { data: selected } = await supabase.from("architecture_candidates").select("*").eq("project_id", projectId).eq("status", "selected").limit(1);
  const names = (comps?.length ? comps : (selected?.[0]?.components ?? [])).map((c: { name?: string }) => c.name).filter(Boolean);
  if (!names.length) throw new Error("No components to draw.");
  const raw = await callOpenRouter(
    [
      { role: "system", content: "Produce mermaid diagrams. Node ids [A-Za-z0-9_]+ only. JSON." },
      {
        role: "user",
        content: `Components: ${names.join(", ")}
JSON: { "container": "flowchart TB ...", "sequence": "sequenceDiagram ...", "deployment": "flowchart LR ..." }`,
      },
    ],
    { model: assistModel("extract"), json: true },
  );
  const parsed = parseJson(raw);
  const views = ["container", "sequence", "deployment"].map((k) => {
    const src = String(parsed[k] || "");
    return { kind: k, mermaid: src, valid: mermaidValid(src) };
  });
  return { views, note: "Invalid diagrams are shown as errors, not empty boxes." };
}

async function runNotes(supabase: ReturnType<typeof userClient>, body: Record<string, unknown>) {
  const projectId = String(body.project_id);
  const text = body.text ? String(body.text) : "";
  const image_base64 = body.image_base64 ? String(body.image_base64) : "";
  const mime = String(body.mime_type || "image/png");
  if (!text && !image_base64) throw new Error("text or image_base64 is required");
  const userContent: unknown = image_base64
    ? [
      { type: "text", text: `${text || "Extract candidate drivers and components from this whiteboard/slide. Staging only — nothing is locked."}\nJSON { "notes": "", "candidate_drivers": [], "candidate_components": [], "questions": [] }` },
      { type: "image_url", image_url: { url: `data:${mime};base64,${image_base64}` } },
    ]
    : `${text}\nExtract candidate drivers and components as notes only. JSON { "notes": "", "candidate_drivers": [], "candidate_components": [], "questions": [] }`;
  const raw = await callOpenRouter(
    [
      { role: "system", content: "These are workshop notes, not requirements. Do not lock or approve anything. JSON only." },
      { role: "user", content: userContent },
    ],
    { model: assistModel(image_base64 ? "vision" : "extract"), json: true },
  );
  const parsed = parseJson(raw);
  const { data } = await supabase.from("assist_findings").insert({
    project_id: projectId,
    kind: "note",
    severity: "info",
    title: "Workshop notes (not locked)",
    body: JSON.stringify(parsed, null, 2).slice(0, 8000),
    target: parsed,
    confidence: "ungrounded",
  }).select().single();
  return { note_row: data, parsed, warning: "Staging only. Copy into the requirement set yourself before lock." };
}
