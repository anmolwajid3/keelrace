import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPackageHtml,
  componentDiagramSvg,
  pickCanonicalHld,
  pickCanonicalLlds,
  productTitle,
  prototypeDiagramSvg,
} from '../frontend/src/lib/packageTemplate.js'

describe('architecture package template', () => {
  it('prefers an approved HLD over a newer draft, and names e2e runs from the HLD', () => {
    const hld = pickCanonicalHld([
      { type: 'HLD', version: 2, status: 'draft', id: 'new' },
      { type: 'HLD', version: 1, status: 'approved', id: 'old' },
      { type: 'LLD', version: 2, status: 'draft' },
    ])
    assert.equal(hld.id, 'old')
    const llds = pickCanonicalLlds([
      { component_id: 'c1', version: 1, status: 'approved' },
      { component_id: 'c1', version: 2, status: 'draft' },
      { component_id: 'orphan', version: 1, status: 'draft' },
    ], ['c1'])
    assert.equal(llds.length, 1)
    assert.equal(llds[0].status, 'approved')
    assert.equal(productTitle({ name: 'e2e 2026-04-01' }, { content: { summary: 'Mood tracking stays offline-first.' } }), 'Mood tracking stays offline-first')
  })

  it('marks empty sections and includes layered diagrams when data exists', () => {
    const empty = buildPackageHtml({
      project: { name: 'MoodFlow' },
      progress: { completed: 2, total: 10, remaining: [{ n: 3, label: 'Generate the system map', remain: 'Generate' }] },
    })
    assert.match(empty, /MoodFlow/)
    assert.match(empty, /2\/10/)
    assert.match(empty, /incomplete/)

    const svg = componentDiagramSvg([
      { id: 'a', name: 'Home View' },
      { id: 'b', name: 'Mood Engine' },
      { id: 'c', name: 'Local Repository' },
    ])
    assert.match(svg, /<svg/)
    assert.match(svg, /Experience/)
    assert.match(svg, /Application/)
    assert.match(svg, /Data and sync/)

    const filled = buildPackageHtml({
      project: { name: 'MoodFlow' },
      set: { version: 1 },
      reqs: [{ ref_code: 'FR-1', title: 'Log mood', body: 'User logs a mood' }],
      nfrs: [{ name: 'NFR-1: latency', description: 'p95 < 200ms' }],
      hld: { version: 1, status: 'approved', content: { summary: 'Mobile client plus API' } },
      components: [{ id: 'c1', name: 'Mobile client', description: 'Captures mood entries' }],
      llds: [{ version: 1, status: 'approved', component_id: 'c1', content: { summary: 'MVVM', interfaces: ['REST'], data_model: 'Mood' } }],
      decisions: [{
        decision_point: 'Offline queue',
        chosen_option: 'Outbox',
        risk_level: 'low',
        status: 'approved',
        alternatives_considered: [{ option: 'Direct writes', rejection_reason: 'Fails offline' }],
      }],
      prototypes: [{ type: 'flow-diagram', content: { nodes: [{ id: 'n1', label: 'Log' }], edges: [] } }],
      artifacts: [{ path: 'src/app.ts', type: 'file' }],
      snapshots: [{ id: 's1' }],
      progress: { completed: 10, total: 10, remaining: [] },
    })
    assert.match(filled, /complete enough to circulate/)
    assert.match(filled, /Mobile client/)
    assert.match(filled, /Offline queue/)
    assert.match(filled, /Direct writes/)
    assert.match(filled, /src\/app.ts/)
    assert.match(filled, /Door 1/)
    assert.match(filled, /Door 2/)
    assert.match(filled, /<svg/)
    assert.match(prototypeDiagramSvg({
      nodes: ['Switch', 'Timer', 'LampDriver'],
      edges: ['Switch→Timer', 'Timer→LampDriver'],
    }), /Switch/)
    const looped = prototypeDiagramSvg({
      nodes: [
        { id: 'timer', label: 'Timer', row: 0 },
        { id: 'watch', label: 'Watchdog', row: 1 },
      ],
      edges: [
        { from: 'timer', to: 'timer', label: 'tick', kind: 'loop' },
        { from: 'timer', to: 'watch', label: 'remaining=0', kind: 'safety' },
      ],
    })
    assert.match(looped, /<path/)
    assert.match(looped, /tick/)
    assert.match(looped, /Watchdog/)
  })
})

