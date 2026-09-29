import { callOpenRouter, assistModel } from "../_shared/lib.ts";

type Sb = {
  from: (t: string) => {
    select: (cols: string) => any;
    insert: (row: Record<string, unknown>) => any;
    eq: (c: string, v: unknown) => any;
  };
};

function parseJson(raw: string) {
  try {
    return JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error("Model did not return JSON");
  }
}

function groundingFrom(chunks: { id: string; framework: string; title: string }[]) {
  return chunks.map((c) => ({ knowledge_id: c.id, framework: c.framework, title: c.title }));
}

export function matchNamedElements(text: string, names: string[]) {
  const t = (text || "").toLowerCase();
  return names.filter((n) => n && t.includes(n.toLowerCase()));
}

export function heuristicWalkPath(scenario: Record<string, unknown>, elementNames: string[]) {
  const blob = `${scenario.title || ""} ${scenario.stimulus || ""} ${scenario.expected_response || scenario.response || ""}`;
  const hit = matchNamedElements(blob, elementNames);
  const used = hit.length ? hit : elementNames.slice(0, 3);
  return {
    affected: used,
    path_summary: used.length
      ? `Walk ${used.join(" → ")} against “${scenario.title || "scenario"}”. No score.`
      : "No named elements matched this scenario. Architect should name the path.",
  };
}

export function heuristicOutcome(candidate: Record<string, unknown>, scenario: Record<string, unknown>) {
  const sac = `${candidate.sacrifices || ""} ${candidate.summary || ""}`.toLowerCase();
  const opt = `${candidate.optimizes || ""}`.toLowerCase();
  const title = `${scenario.title || ""} ${scenario.stimulus || ""}`.toLowerCase();
  const quality = String(scenario.quality || scenario.kind || "").toLowerCase();
  if (sac && (title.split(/\W+/).some((w) => w.length > 4 && sac.includes(w)) || (quality && sac.includes(quality)))) {
    return { qualitative_result: "degrades" as const, rationale: "Candidate text already names a sacrifice that overlaps this scenario. Not a score." };
  }
  if (opt && title.split(/\W+/).some((w) => w.length > 4 && opt.includes(w))) {
    return { qualitative_result: "holds" as const, rationale: "Candidate claims to optimize a concern that appears in this scenario. Architect still walks it." };
  }
  return { qualitative_result: "unknown" as const, rationale: "Record does not say whether this candidate holds the scenario." };
}

async function latestHld(supabase: Sb, projectId: string) {
  const { data: sets } = await supabase.from("requirement_sets").select("id").eq("project_id", projectId);
  const setIds = (sets ?? []).map((s: { id: string }) => s.id);
  if (!setIds.length) return null;
  const { data: docs } = await supabase.from("design_documents").select("id, version, type, requirement_set_id").eq("type", "HLD").order("version", { ascending: false });
  return (docs ?? []).find((d: { requirement_set_id: string }) => setIds.includes(d.requirement_set_id)) ?? null;
}

async function hldComponents(supabase: Sb, hldId: string) {
  const { data } = await supabase.from("components").select("id, name, description").eq("hld_document_id", hldId);
  return data ?? [];
}

export async function persistScenarios(
  supabase: Sb,
  projectId: string,
  parsed: Record<string, unknown>,
  drivers: Record<string, unknown>[],
  knowledge: { id: string; framework: string; title: string }[],
) {
  const tree = Array.isArray(parsed.utility_tree) ? parsed.utility_tree as Record<string, unknown>[] : [];
  const qualityToId = new Map<string, string>();
  for (const row of tree) {
    const quality = String(row.quality || "utility").slice(0, 80);
    if (!qualityToId.has(quality)) {
      const { data } = await supabase.from("evaluation_utility_nodes").insert({
        project_id: projectId,
        quality,
        attribute: null,
        sort_order: qualityToId.size,
      }).select().single();
      if (data?.id) qualityToId.set(quality, data.id);
    }
    if (row.attribute) {
      const parent = qualityToId.get(quality);
      await supabase.from("evaluation_utility_nodes").insert({
        project_id: projectId,
        parent_id: parent || null,
        quality,
        attribute: String(row.attribute).slice(0, 120),
      });
    }
  }

  const scenarios: unknown[] = [];
  const list = Array.isArray(parsed.scenarios) ? parsed.scenarios as Record<string, unknown>[] : [];
  for (const rec of list) {
    const quality = String(rec.quality || rec.quality_attribute || "").toLowerCase();
    const driver = drivers.find((d) => String(d.quality_attribute || "").toLowerCase() === quality)
      || drivers.find((d) => String(d.title || "").toLowerCase().includes(String(rec.title || "").toLowerCase().slice(0, 12)));
    const { data } = await supabase.from("evaluation_scenarios").insert({
      project_id: projectId,
      driver_id: driver?.id || null,
      utility_node_id: qualityToId.get(String(rec.quality || rec.quality_attribute || "")) || null,
      title: String(rec.title || "Scenario").slice(0, 240),
      stimulus: rec.stimulus ? String(rec.stimulus) : null,
      environment: rec.environment ? String(rec.environment) : null,
      expected_response: rec.response || rec.expected_response ? String(rec.response || rec.expected_response) : null,
      kind: ["use", "growth", "exploratory"].includes(String(rec.kind)) ? rec.kind : "use",
      in_boundary: false,
      grounding: groundingFrom(knowledge),
      confidence: ["grounded", "partial", "ungrounded"].includes(String(rec.confidence)) ? rec.confidence : "partial",
    }).select().single();
    if (data) scenarios.push(data);
  }
  return { scenarios, utility_tree: tree };
}

export function heuristicScenarioList(drivers: Record<string, unknown>[], reqs: { ref_code: string; title: string }[]) {
  const scenarios = [];
  for (const d of drivers.slice(0, 6)) {
    scenarios.push({
      title: d.title || "Driver scenario",
      stimulus: d.stimulus || "",
      environment: d.environment || "",
      response: d.response || "",
      kind: "use",
      quality: d.quality_attribute,
      confidence: "partial",
    });
  }
  if (!scenarios.length) {
    for (const r of reqs.slice(0, 4)) {
      scenarios.push({
        title: `${r.ref_code} ${r.title}`,
        stimulus: r.title,
        environment: "as specified",
        response: "system responds as required",
        kind: "use",
        confidence: "ungrounded",
      });
    }
  }
  return { utility_tree: drivers.map((d) => ({ quality: d.quality_attribute, attribute: d.title, scenario: d.title })), scenarios };
}

export async function runWalkScenarios(supabase: Sb, body: Record<string, unknown>, knowledge: { id: string; framework: string; title: string }[]) {
  const projectId = String(body.project_id);
  const { data: scenarios } = await supabase.from("evaluation_scenarios").select("*").eq("project_id", projectId);
  const inBound = (scenarios ?? []).filter((s: { in_boundary: boolean }) => s.in_boundary);
  const target = inBound.length ? inBound : (scenarios ?? []);
  if (!target.length) throw new Error("Generate scenarios first, then mark which ones are in the workshop boundary.");

  const { data: candidates } = await supabase.from("architecture_candidates").select("id, name, summary, components, status").eq("project_id", projectId);
  const selected = (candidates ?? []).filter((c: { status: string }) => c.status === "selected");
  const hld = await latestHld(supabase, projectId);
  const comps = hld ? await hldComponents(supabase, hld.id) : [];
  const hldNames = comps.map((c: { name: string }) => c.name);

  const walks = [];
  for (const s of target) {
    if (hld && comps.length) {
      let path = heuristicWalkPath(s, hldNames);
      try {
        const raw = await callOpenRouter(
          [
            { role: "system", content: "Walk an ATAM scenario through named components only. No scores. JSON only." },
            {
              role: "user",
              content: `Scenario: ${JSON.stringify({ title: s.title, stimulus: s.stimulus, environment: s.environment, expected_response: s.expected_response })}
Components (use these names only): ${JSON.stringify(comps)}
JSON: { "affected_names": ["..."], "path_summary": "A then B then C", "confidence": "partial" }`,
            },
          ],
          { model: assistModel("reason"), json: true },
        );
        const parsed = parseJson(raw);
        const names = Array.isArray(parsed.affected_names) ? parsed.affected_names.map(String) : [];
        const allowed = new Set(hldNames.map((n: string) => n.toLowerCase()));
        const affected = names.filter((n: string) => allowed.has(n.toLowerCase()));
        if (affected.length) path = { affected, path_summary: String(parsed.path_summary || path.path_summary) };
      } catch { /* heuristic */ }
      const { data: already } = await supabase.from("evaluation_walks").select("id").eq("scenario_id", s.id).eq("hld_document_id", hld.id).maybeSingle();
      if (!already?.id) {
        const { data } = await supabase.from("evaluation_walks").insert({
          project_id: projectId,
          scenario_id: s.id,
          hld_document_id: hld.id,
          affected_components: path.affected.map((name: string) => {
            const c = comps.find((x: { name: string }) => x.name === name);
            return { id: c?.id, name };
          }),
          path_summary: path.path_summary,
          confidence: "partial",
          status: "proposed",
        }).select().single();
        if (data) walks.push(data);
      }
    }

    const candList = selected.length ? selected : (candidates ?? []).filter((c: { status: string }) => c.status !== "discarded");
    for (const cand of candList.slice(0, 3)) {
      const names = ((cand.components as { name?: string }[]) ?? []).map((c) => c.name || "").filter(Boolean);
      const path = heuristicWalkPath(s, names);
      const { data: existingRows } = await supabase.from("evaluation_walks").select("id, candidate_id").eq("scenario_id", s.id);
      if ((existingRows ?? []).some((w: { candidate_id: string }) => w.candidate_id === cand.id)) continue;
      const { data } = await supabase.from("evaluation_walks").insert({
        project_id: projectId,
        scenario_id: s.id,
        candidate_id: cand.id,
        affected_components: path.affected.map((name: string) => ({ name })),
        path_summary: path.path_summary,
        confidence: "partial",
        status: "proposed",
      }).select().single();
      if (data) walks.push(data);
    }
  }
  return { walks, note: "Walks are proposed paths through elements. Accept them in the workshop. They are not a grade." , grounding: groundingFrom(knowledge) };
}

export async function runCompareCandidates(supabase: Sb, body: Record<string, unknown>) {
  const projectId = String(body.project_id);
  const { data: scenarios } = await supabase.from("evaluation_scenarios").select("*").eq("project_id", projectId);
  const inBound = (scenarios ?? []).filter((s: { in_boundary: boolean }) => s.in_boundary);
  const target = inBound.length ? inBound : (scenarios ?? []);
  const { data: candidates } = await supabase.from("architecture_candidates").select("*").eq("project_id", projectId);
  const live = (candidates ?? []).filter((c: { status: string }) => c.status !== "discarded");
  if (!target.length || !live.length) throw new Error("Need scenarios and at least one non-discarded candidate.");

  const outcomes = [];
  for (const cand of live) {
    for (const s of target) {
      let row = heuristicOutcome(cand, s);
      try {
        const raw = await callOpenRouter(
          [
            { role: "system", content: "Compare one architecture candidate to one scenario. holds, degrades, or unknown. Never a number. JSON only." },
            {
              role: "user",
              content: `Candidate: ${JSON.stringify({ name: cand.name, summary: cand.summary, optimizes: cand.optimizes, sacrifices: cand.sacrifices })}
Scenario: ${JSON.stringify({ title: s.title, stimulus: s.stimulus, expected_response: s.expected_response })}
JSON: { "qualitative_result": "holds"|"degrades"|"unknown", "rationale": "" }`,
            },
          ],
          { model: assistModel("reason"), json: true },
        );
        const parsed = parseJson(raw);
        if (["holds", "degrades", "unknown"].includes(String(parsed.qualitative_result))) {
          row = { qualitative_result: parsed.qualitative_result, rationale: String(parsed.rationale || row.rationale) };
        }
      } catch { /* heuristic */ }
      const { data: existing } = await supabase.from("evaluation_outcomes").select("id").eq("scenario_id", s.id).eq("candidate_id", cand.id).maybeSingle();
      if (existing?.id) continue;
      const { data } = await supabase.from("evaluation_outcomes").insert({
        project_id: projectId,
        scenario_id: s.id,
        candidate_id: cand.id,
        qualitative_result: row.qualitative_result,
        rationale: row.rationale,
        status: "proposed",
      }).select().single();
      if (data) outcomes.push(data);
    }
  }
  return { outcomes, note: "Same scenarios against each candidate. holds/degrades/unknown is a workshop finding, not a score and not an approval." };
}

export async function runProposePoints(supabase: Sb, body: Record<string, unknown>, knowledge: { id: string; framework: string; title: string }[]) {
  const projectId = String(body.project_id);
  const { data: candidates } = await supabase.from("architecture_candidates").select("*").eq("project_id", projectId);
  const { data: scenarios } = await supabase.from("evaluation_scenarios").select("id, title").eq("project_id", projectId);
  const live = (candidates ?? []).filter((c: { status: string }) => c.status !== "discarded");
  const points = [];
  let parsedPoints: Record<string, unknown>[] = [];
  try {
    const raw = await callOpenRouter(
      [
        { role: "system", content: "Propose ATAM sensitivity and trade-off points. No numeric scores. JSON only." },
        {
          role: "user",
          content: `Candidates: ${JSON.stringify(live).slice(0, 8000)}
Scenarios: ${(scenarios ?? []).map((s: { title: string }) => s.title).join("; ")}
JSON: { "points": [{ "kind": "sensitivity"|"tradeoff", "quality_a": "", "quality_b": ""|null, "element_name": "", "body": "", "confidence": "partial" }] }
Max 8. A sensitivity point names one quality. A trade-off names two.`,
        },
      ],
      { model: assistModel("reason"), json: true },
    );
    parsedPoints = parseJson(raw).points ?? [];
  } catch {
    parsedPoints = [];
  }
  if (!parsedPoints.length) {
    for (const c of live) {
      if (c.optimizes) {
        parsedPoints.push({
          kind: "sensitivity",
          quality_a: String(c.optimizes).slice(0, 80),
          element_name: c.name,
          body: `${c.name} is sensitive to ${c.optimizes}.`,
        });
      }
      if (c.optimizes && c.sacrifices) {
        parsedPoints.push({
          kind: "tradeoff",
          quality_a: String(c.optimizes).slice(0, 80),
          quality_b: String(c.sacrifices).slice(0, 80),
          element_name: c.name,
          body: `${c.name} trades ${c.optimizes} against ${c.sacrifices}.`,
        });
      }
    }
  }
  for (const rec of parsedPoints.slice(0, 8)) {
    const kind = rec.kind === "tradeoff" ? "tradeoff" : "sensitivity";
    const { data } = await supabase.from("evaluation_points").insert({
      project_id: projectId,
      kind,
      quality_a: String(rec.quality_a || "quality").slice(0, 120),
      quality_b: kind === "tradeoff" ? String(rec.quality_b || rec.quality_a || "").slice(0, 120) : null,
      element_name: rec.element_name ? String(rec.element_name) : null,
      body: String(rec.body || "").slice(0, 2000),
      status: "proposed",
    }).select().single();
    if (data) points.push(data);
  }
  return { points, note: "Sensitivity and trade-off points are findings. Accepting them does not approve the HLD.", grounding: groundingFrom(knowledge) };
}
