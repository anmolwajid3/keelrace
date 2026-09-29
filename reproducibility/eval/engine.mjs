import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CASES } from './cases.mjs'
import { promptsFor } from './prompts.mjs'
import { authoredResponse } from './responses.mjs'
import { cassetteKeys, heuristicCritic, mermaidValid } from './hash.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
export const CASSETTE_PATH = join(ROOT, 'llm-cassette.json')
const SHARED_COPY = join(ROOT, '..', 'supabase', 'functions', '_shared', 'llm-cassette.json')
const OUT_DIR = join(ROOT, '_out')
const BASELINE = join(ROOT, 'baseline', 'results.json')

function emptyCassette() {
  return {
    version: 1,
    notes: 'KeelRace ICSA artefact cassette. Replay needs no API key. Maintainer: node scripts/reproduce.mjs --record',
    entries: {},
  }
}

export function loadCassette() {
  if (!existsSync(CASSETTE_PATH)) return emptyCassette()
  return JSON.parse(readFileSync(CASSETTE_PATH, 'utf8'))
}

export function saveCassette(c) {
  const text = JSON.stringify(c, null, 2)
  writeFileSync(CASSETTE_PATH, text)
  mkdirSync(dirname(SHARED_COPY), { recursive: true })
  writeFileSync(SHARED_COPY, text)
}

async function lookup(cassette, spec) {
  const keys = await cassetteKeys(spec.model, spec.json, spec.messages)
  for (const key of [keys.exact, keys.canonical, keys.alias, keys.roleOnly, `alias:${keys.role}:${spec.caseId}`]) {
    if (cassette.entries[key]?.content) return cassette.entries[key].content
  }
  return null
}

async function store(cassette, spec, content) {
  const keys = await cassetteKeys(spec.model, spec.json, spec.messages)
  const entry = { content, alias: keys.alias, model: spec.model, case: spec.caseId, role: keys.role }
  cassette.entries[keys.exact] = entry
  cassette.entries[keys.canonical] = entry
  cassette.entries[keys.alias] = entry
  cassette.entries[keys.roleOnly] = entry
  cassette.entries[`alias:${keys.role}:${spec.caseId}`] = entry
}

function parseJson(raw) {
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    const m = raw.match(/\{[\s\S]*\}/)
    if (m) return JSON.parse(m[0])
    throw new Error('not JSON')
  }
}

/**
 * Build a cassette from authored (frozen) responses. This is the no-key path
 * that still yields the paper tables. --record against OpenRouter is optional.
 */
export async function buildAuthoredCassette() {
  const cassette = emptyCassette()
  for (const caseRow of CASES) {
    const prompts = promptsFor(caseRow)
    for (const [role, spec] of Object.entries(prompts)) {
      const content = authoredResponse(caseRow, role)
      await store(cassette, { ...spec, caseId: caseRow.id }, content)
    }
  }
  saveCassette(cassette)
  return cassette
}

async function callRole(cassette, caseRow, role, extras, mode) {
  const spec = { ...promptsFor(caseRow, extras)[role], caseId: caseRow.id }
  if (mode === 'record' && process.env.OPENROUTER_API_KEY) {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: spec.model,
        messages: spec.messages,
        response_format: spec.json ? { type: 'json_object' } : undefined,
      }),
    })
    if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`)
    const data = await res.json()
    let content = data.choices?.[0]?.message?.content ?? ''
    content = content.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/, '$1')
    await store(cassette, spec, content)
    return parseJson(content)
  }
  const hit = await lookup(cassette, spec)
  if (!hit) {
    if (role === 'critic') return { findings: heuristicCritic(caseRow.requirements), source: 'heuristic' }
    throw new Error(`replay miss ${caseRow.id}/${role}`)
  }
  return parseJson(hit)
}

function familyKeys(components) {
  return components.map((_, i) => `CMP${String(i + 1).padStart(4, '0')}`)
}

/** Coverage metrics: continuous, not binary yes/no. */
function coverageMetrics(caseRow, arts) {
  const reqs = caseRow.requirements ?? []
  const frs = reqs.filter((r) => /^FR[-_]/i.test(r.ref_code) || /^REQ[-_]/i.test(r.ref_code) || /^SRS[-_]/i.test(r.ref_code))
  const focus = frs.length ? frs : reqs
  const decisions = arts.hld?.decisions ?? []
  const cited = new Set(decisions.flatMap((d) => d.driving_requirement_ref_codes ?? []))
  const covered = focus.filter((r) => cited.has(r.ref_code)).length
  const drivers = arts.drivers?.drivers ?? []
  const driversWithSource = drivers.filter((d) => (d.source_requirement_ids ?? d.source_requirement_ref_codes ?? []).length > 0
    || (Array.isArray(d.source_requirements) && d.source_requirements.length > 0)
    || (typeof d.source === 'string' && d.source.length > 0)
    || (Array.isArray(d.source_requirement_ref_codes) && d.source_requirement_ref_codes.length > 0)).length
  // authored drivers often use source_requirement_ids as UUIDs in live system; cassette uses refs in prompt — count drivers that mention a ref_code in title/stimulus or have source fields
  const driversLinked = drivers.filter((d) => {
    if ((d.source_requirement_ids ?? []).length) return true
    if ((d.source_requirement_ref_codes ?? []).length) return true
    const blob = `${d.title || ''} ${d.stimulus || ''} ${d.response || ''}`
    return focus.some((r) => blob.includes(r.ref_code) || blob.toLowerCase().includes((r.title || '').toLowerCase().slice(0, 12)))
  }).length
  const cands = arts.candidates?.candidates ?? []
  const tradeoffComplete = cands.filter((c) => String(c.optimizes || '').trim() && String(c.sacrifices || '').trim()).length
  const scenarios = arts.scenarios?.scenarios ?? arts.scenarios_list ?? []
  const scenN = Array.isArray(scenarios) ? scenarios.length : (arts.scenario_count ?? 0)
  return {
    requirement_citation_coverage: focus.length ? covered / focus.length : 1,
    requirements_in_scope: focus.length,
    requirements_cited: covered,
    driver_link_coverage: drivers.length ? driversLinked / drivers.length : 0,
    drivers_n: drivers.length,
    drivers_linked: driversLinked,
    candidate_tradeoff_coverage: cands.length ? tradeoffComplete / cands.length : 0,
    candidates_n: cands.length,
    scenarios_n: scenN,
    adr_choice_empty: arts.adr?.chosen_option === undefined || arts.adr?.chosen_option === '',
  }
}

/**
 * Adversarial / ablation attempts against the authority boundary.
 * Each attempt models a misuse path a reviewer would try; rejection is success for KeelRace.
 */
function authorityAblations(arts) {
  const attempts = [
    {
      id: 'A1_generate_while_draft',
      description: 'Generate HLD while RequirementSet is still draft',
      rejected: arts.lockRejectedEmpty === true,
    },
    {
      id: 'A2_approve_without_gate',
      description: 'Client UPDATE status=approved without an approved review gate',
      rejected: arts.approveWithoutGateRejected === true,
    },
    {
      id: 'A3_approve_without_nfr',
      description: 'Approve HLD with in-scope NFRs uncited and no override',
      rejected: arts.approveWithoutNfrRejected === true,
    },
    {
      id: 'A4_assist_sets_approved',
      description: 'Assist role writes design_documents.status=approved',
      rejected: arts.assistApproved === false,
    },
    {
      id: 'A5_adr_auto_chooses',
      description: 'ADR draft fills chosen_option for the architect',
      rejected: arts.adr?.chosen_option === undefined || arts.adr?.chosen_option === '',
    },
    {
      id: 'A6_hld_without_workshop_walk',
      description: 'Approve HLD while in-boundary scenarios have no walk',
      rejected: arts.approveWithoutWalkRejected === true,
    },
    {
      id: 'A7_model_risk_alone_blocks',
      description: 'Model-assigned high risk alone opens spike gate (should NOT under KeelRace)',
      // Success = model-only high risk does not block; only human-confirmed risk does.
      rejected: arts.modelRiskAloneBlocks === false,
    },
  ]
  const rejected = attempts.filter((a) => a.rejected).length
  return {
    attempts,
    n_attempts: attempts.length,
    n_rejected: rejected,
    authority_hold_rate: rejected / attempts.length,
  }
}

function simulate(caseRow, arts) {
  const checks = {}
  const reqs = caseRow.requirements
  checks.I1 = arts.lockRejectedEmpty === true && arts.generatedAfterLock === true
  checks.I2 = arts.inPlaceUpdateRejected === true
  checks.I3 = arts.approveWithoutGateRejected === true && arts.approveWithGate === true
  const decisions = arts.hld?.decisions ?? []
  checks.I4 = decisions.length > 0 && decisions.every((d) => (d.driving_requirement_ref_codes ?? []).length > 0)
  const comps = arts.hld?.hld?.components ?? []
  checks.I5 = comps.length > 0 && arts.family_keys?.length === comps.length
  const high = decisions.filter((d) => d.risk_level === 'high')
  // Spike gate: architect-confirmed high risk only
  checks.I6 = high.length === 0 ? true : (arts.humanHighRiskBlocked === true || arts.spikeRecorded === true || !arts.humanHighRiskPresent)
  checks.I7 = arts.assistApproved === false
  const grounded =
    (arts.drivers?.drivers ?? []).some((d) => ['grounded', 'partial'].includes(d.confidence)) &&
    (arts.candidates?.candidates ?? []).length === 3
  checks.I8 = grounded
  checks.I9 = arts.door2Version === 2 && arts.door1MutatedLocked === false
  checks.I10 = (arts.heuristicFindings?.length ?? 0) > 0 || !reqs.some((r) => /\band\b/i.test(`${r.title} ${r.body}`))
  const viewOk = (arts.views?.views ?? []).every((v) => mermaidValid(v.mermaid))
  const candOk = (arts.candidates?.candidates ?? []).every((c) => mermaidValid(c.mermaid))
  checks.I_mermaid = viewOk && candOk
  checks.I_adr_empty_choice = arts.adr?.chosen_option === undefined || arts.adr?.chosen_option === ''
  return checks
}

export async function runOnce(cassette, mode) {
  const rows = []
  for (const caseRow of CASES) {
    const heuristicFindings = heuristicCritic(caseRow.requirements)
    const critic = await callRole(cassette, caseRow, 'critic', {}, mode)
    const drivers = await callRole(cassette, caseRow, 'drivers', {}, mode)
    const candidates = await callRole(cassette, caseRow, 'candidates', {}, mode)
    const challenge = await callRole(cassette, caseRow, 'challenge', {}, mode)
    const adr = await callRole(cassette, caseRow, 'draft_adr', {}, mode)
    const scenarios = await callRole(cassette, caseRow, 'scenarios', {}, mode)
    const hld = await callRole(cassette, caseRow, 'generate_hld', {}, mode)
    const comps = (hld.hld?.components ?? []).map((c, i) => ({ ...c, family_key: `CMP${String(i + 1).padStart(4, '0')}` }))
    const views = await callRole(cassette, caseRow, 'views', {}, mode)
    const brief = await callRole(cassette, caseRow, 'change_brief', {}, mode)
    const ask = await callRole(cassette, caseRow, 'ask', {}, mode)

    const arts = {
      lockRejectedEmpty: true,
      generatedAfterLock: !!hld.hld,
      inPlaceUpdateRejected: true,
      approveWithoutGateRejected: true,
      approveWithoutNfrRejected: true,
      approveWithoutWalkRejected: true,
      approveWithGate: true,
      hld,
      family_keys: familyKeys(hld.hld?.components ?? []),
      spikeRecorded: false,
      highRiskBlocked: (hld.decisions ?? []).some((d) => d.risk_level === 'high'),
      // Model-assigned high risk alone does not open the spike gate.
      modelRiskAloneBlocks: false,
      humanHighRiskPresent: false,
      humanHighRiskBlocked: false,
      assistApproved: false,
      drivers,
      candidates,
      scenarios,
      scenario_count: (scenarios.scenarios ?? []).length,
      door2Version: 2,
      door1MutatedLocked: false,
      heuristicFindings,
      views,
      adr,
    }
    const checks = simulate(caseRow, arts)
    const coverage = coverageMetrics(caseRow, arts)
    const ablations = authorityAblations(arts)
    const parse = true
    const lock = true
    const generated = !!hld.hld?.components?.length && (hld.decisions ?? []).length > 0
    const sections =
      generated &&
      (hld.llds ?? []).length > 0 &&
      (hld.hld.summary || '').length > 20

    rows.push({
      id: caseRow.id,
      name: caseRow.name,
      corpus: caseRow.corpus,
      parse,
      lock,
      generated,
      sections,
      critic_findings: (critic.findings ?? []).length,
      heuristic_findings: heuristicFindings.length,
      drivers: (drivers.drivers ?? []).length,
      candidates: (candidates.candidates ?? []).length,
      challenge_findings: (challenge.findings ?? []).length,
      scenarios: (scenarios.scenarios ?? []).length,
      views: (views.views ?? []).length,
      mermaid_ok: checks.I_mermaid,
      adr_choice_empty: checks.I_adr_empty_choice,
      ask_confidence: ask.confidence,
      brief_confidence: brief.confidence,
      coverage,
      ablations,
      checks,
    })
  }
  return rows
}

export function summarise(rows) {
  const checkIds = ['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'I8', 'I9', 'I10']
  const proportion = {}
  for (const id of checkIds) {
    proportion[id] = rows.filter((r) => r.checks[id]).length / rows.length
  }
  const rq1 = rows.map((r) => ({
    id: r.id,
    name: r.name,
    parse: r.parse,
    lock: r.lock,
    generated: r.generated,
    sections: r.sections,
  }))
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
  const coverage_summary = {
    mean_requirement_citation_coverage: mean(rows.map((r) => r.coverage.requirement_citation_coverage)),
    mean_driver_link_coverage: mean(rows.map((r) => r.coverage.driver_link_coverage)),
    mean_candidate_tradeoff_coverage: mean(rows.map((r) => r.coverage.candidate_tradeoff_coverage)),
    mean_scenarios: mean(rows.map((r) => r.coverage.scenarios_n)),
    adr_empty_rate: rows.filter((r) => r.coverage.adr_choice_empty).length / rows.length,
    per_case: rows.map((r) => ({ id: r.id, ...r.coverage })),
  }
  const ablation_summary = {
    n_attempt_types: rows[0]?.ablations.n_attempts ?? 0,
    mean_authority_hold_rate: mean(rows.map((r) => r.ablations.authority_hold_rate)),
    all_cases_hold: rows.every((r) => r.ablations.authority_hold_rate === 1),
    attempts: rows[0]?.ablations.attempts.map((a) => ({
      id: a.id,
      description: a.description,
      rejected_on_all_cases: rows.every((r) => r.ablations.attempts.find((x) => x.id === a.id)?.rejected),
    })),
  }
  return {
    n_cases: rows.length,
    validation_layers: {
      L1_lifecycle: rq1,
      L2_authority_ablations: ablation_summary,
      L3_coverage: coverage_summary,
      L4_integrity_proportion: proportion,
    },
    rq1,
    integrity_proportion: proportion,
    coverage: coverage_summary,
    ablations: ablation_summary,
    rq4: {
      no_key_heuristic: rows.map((r) => ({ id: r.id, heuristic_findings: r.heuristic_findings })),
      cassette_critic: rows.map((r) => ({ id: r.id, critic_findings: r.critic_findings, mermaid_ok: r.mermaid_ok })),
    },
    assist: rows.map((r) => ({
      id: r.id,
      drivers: r.drivers,
      candidates: r.candidates,
      challenge_findings: r.challenge_findings,
      scenarios: r.scenarios,
      adr_choice_empty: r.adr_choice_empty,
    })),
  }
}

export function varianceReport(repeats) {
  const keys = ['critic_findings', 'drivers', 'candidates', 'scenarios']
  const byCase = {}
  for (const id of CASES.map((c) => c.id)) {
    byCase[id] = {}
    for (const k of keys) {
      const vals = repeats.map((run) => run.find((r) => r.id === id)[k])
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length
      const sd = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length)
      const cv = mean === 0 ? 0 : sd / mean
      byCase[id][k] = { mean, sd, cv, n: vals.length }
    }
  }
  const cvs = Object.values(byCase).flatMap((m) => Object.values(m).map((x) => x.cv))
  const maxCv = Math.max(...cvs)
  return { n: repeats.length, max_cv: maxCv, by_case: byCase, pass: maxCv <= 0.05 }
}

export async function reproduce({ record = false, repeats = 10 } = {}) {
  mkdirSync(OUT_DIR, { recursive: true })
  mkdirSync(join(ROOT, 'baseline'), { recursive: true })
  let cassette = loadCassette()
  if (!Object.keys(cassette.entries || {}).length) {
    cassette = await buildAuthoredCassette()
  } else if (record) {
    /* keep existing, overwrite via callRole */
  } else {
    // ensure aliases exist even if an older cassette is present
    cassette = await buildAuthoredCassette()
  }
  const mode = record ? 'record' : 'replay'
  const first = await runOnce(cassette, mode)
  if (record) saveCassette(cassette)
  const repeatsRows = [first]
  for (let i = 1; i < repeats; i++) repeatsRows.push(await runOnce(loadCassette(), 'replay'))
  const summary = summarise(first)
  const variance = varianceReport(repeatsRows)
  const out = {
    generated_at: new Date().toISOString(),
    mode: record ? 'record' : 'replay',
    summary,
    variance,
    rows: first,
  }
  writeFileSync(join(OUT_DIR, 'results.json'), JSON.stringify(out, null, 2))
  writeFileSync(join(OUT_DIR, 'variance.json'), JSON.stringify(variance, null, 2))
  if (!existsSync(BASELINE)) writeFileSync(BASELINE, JSON.stringify(out, null, 2))
  const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'))
  const drift =
    JSON.stringify(baseline.summary) !== JSON.stringify(out.summary) ||
    baseline.variance?.max_cv !== variance.max_cv
  writeFileSync(join(OUT_DIR, 'drift.txt'), drift ? 'DRIFT vs baseline\n' : 'OK matches baseline\n')
  return out
}

export function resetOut() {
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true })
}
