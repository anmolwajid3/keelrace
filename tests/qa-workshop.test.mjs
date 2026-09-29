import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { heuristicWalkPath, heuristicOutcome, workshopWalksComplete } from '../frontend/src/lib/qaWorkshop.js'
import { evaluateConformance } from '../frontend/src/lib/conformance.js'

describe('QA workshop heuristics', () => {
  it('walks name components mentioned in the scenario', () => {
    const path = heuristicWalkPath(
      { title: 'GPIO stuck after timeout', stimulus: 'Watchdog sees LampDriver still powered' },
      ['Switch', 'Timer', 'Watchdog', 'LampDriver'],
    )
    assert.ok(path.affected.includes('Watchdog'))
    assert.ok(path.affected.includes('LampDriver'))
    assert.equal(/score/i.test(path.path_summary) && /No score/.test(path.path_summary), true)
  })

  it('does not invent a numeric grade when a candidate sacrifices the scenario', () => {
    const out = heuristicOutcome(
      { name: 'Cloud countdown', sacrifices: 'CON-1. Lamp does nothing offline', optimizes: 'fleet dashboard' },
      { title: 'On, off, and timer with no network', stimulus: 'machine offline' },
    )
    assert.equal(out.qualitative_result, 'degrades')
    assert.equal(typeof out.rationale, 'string')
    assert.equal(/\d+(\.\d+)?\/(10|100)/.test(out.rationale), false)
  })

  it('treats in-boundary scenarios without a walk as incomplete', () => {
    const scenarios = [
      { id: 's1', in_boundary: true },
      { id: 's2', in_boundary: false },
    ]
    assert.equal(workshopWalksComplete(scenarios, []), false)
    assert.equal(workshopWalksComplete(scenarios, [{ scenario_id: 's1', status: 'accepted' }]), true)
    assert.equal(workshopWalksComplete(scenarios, [{ scenario_id: 's1', status: 'dismissed' }]), false)
  })

  it('conformance lists workshop walks as a check, not a score', () => {
    const checks = evaluateConformance({
      requirement_set: { version: 1, status: 'locked' },
      requirements: [],
      nfrs: [],
      citations: [],
      documents: [{ type: 'HLD', version: 1, status: 'approved' }],
      decisions: [],
      artifacts: [],
      evaluation_scenarios: [{ id: 's1', in_boundary: true }],
      evaluation_walks: [],
    })
    const w = checks.find((c) => c.id === 'workshop-walks')
    assert.ok(w)
    assert.equal(w.pass, false)
    assert.equal(w.informational, false)
  })
})
