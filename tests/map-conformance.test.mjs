npimport { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { edgesFromRecord } from '../frontend/src/lib/loopRun.js'
import { evaluateConformance, verificationBoundaries } from '../frontend/src/lib/conformance.js'

describe('map and conformance', () => {
  it('connects requirements to decisions to NFRs and files', () => {
    const record = {
      requirements: [{ id: 'r1', ref_code: 'FR-1', title: 'Log mood' }],
      decisions: [{ id: 'd1', decision_point: 'Offline first', chosen_option: 'Outbox', driving_requirements: ['r1'] }],
      nfrs: [{ id: 'n1', name: 'Privacy' }],
      citations: [{ nfr_id: 'n1', decision_rationale_id: 'd1' }],
      components: [{ id: 'c1', name: 'Client' }],
      artifacts: [{ id: 'a1', type: 'file', path: 'src/app.ts', design_component_id: 'c1' }],
    }
    const edges = edgesFromRecord(record)
    assert.equal(edges.filter((e) => e.kind === 'req-decision').length, 1)
    assert.equal(edges.filter((e) => e.kind === 'decision-nfr').length, 1)
    assert.equal(edges.filter((e) => e.kind === 'component-file').length, 1)
  })

  it('fails NFR coverage when a rule is uncited', () => {
    const checks = evaluateConformance({
      requirement_set: { version: 1, status: 'locked' },
      requirements: [],
      nfrs: [{ id: 'n1', name: 'Privacy' }],
      citations: [],
      documents: [{ type: 'HLD', version: 1, status: 'approved' }],
      decisions: [],
      artifacts: [],
    })
    assert.equal(checks.find((c) => c.id === 'nfr-cited').pass, false)
    assert.ok(verificationBoundaries().inScope.length)
    assert.ok(verificationBoundaries().outOfScope.length)
  })
})
