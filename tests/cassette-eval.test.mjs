import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildAuthoredCassette, runOnce, loadCassette, summarise, varianceReport } from '../reproducibility/eval/engine.mjs'
import { mermaidValid, heuristicCritic } from '../reproducibility/eval/hash.mjs'
import { CASES } from '../reproducibility/eval/cases.mjs'

describe('cassette replay (no API key)', () => {
  it('builds a cassette and replays published cases with integrity checks', async () => {
    const cassette = await buildAuthoredCassette()
    assert.ok(Object.keys(cassette.entries).length > 20)
    const rows = await runOnce(cassette, 'replay')
    assert.equal(rows.length, CASES.length)
    assert.ok(CASES.some((c) => c.corpus === 'PURE'))
    assert.ok(CASES.some((c) => c.corpus === 'ArDoCo'))
    const s = summarise(rows)
    for (const row of s.rq1) {
      assert.equal(row.parse, true, row.id)
      assert.equal(row.lock, true, row.id)
      assert.equal(row.generated, true, row.id)
      assert.equal(row.sections, true, row.id)
    }
    for (const [k, v] of Object.entries(s.integrity_proportion)) {
      assert.equal(v, 1, `${k} expected all cases, got ${v}`)
    }
    for (const row of rows) {
      assert.equal(row.candidates, 3)
      assert.equal(row.adr_choice_empty, true)
      assert.equal(row.mermaid_ok, true)
      assert.ok(row.critic_findings >= 1)
    }
  })

  it('N=3 replay has CV 0 (deterministic cassette)', async () => {
    const cassette = loadCassette()
    const runs = []
    for (let i = 0; i < 3; i++) runs.push(await runOnce(cassette, 'replay'))
    const v = varianceReport(runs)
    assert.equal(v.max_cv, 0)
    assert.equal(v.pass, true)
  })

  it('heuristic critic fires on compound published statements without a model', () => {
    const cctns = CASES.find((c) => c.id === 'P3')
    const findings = heuristicCritic(cctns.requirements)
    assert.ok(findings.length > 0)
  })

  it('reports authority ablations and coverage metrics', async () => {
    const cassette = loadCassette()
    const rows = await runOnce(cassette, 'replay')
    const s = summarise(rows)
    assert.equal(s.ablations.all_cases_hold, true)
    assert.equal(s.ablations.mean_authority_hold_rate, 1)
    assert.ok(s.coverage.mean_candidate_tradeoff_coverage === 1)
    assert.equal(s.coverage.adr_empty_rate, 1)
    assert.ok(s.coverage.mean_requirement_citation_coverage > 0)
  })
})
