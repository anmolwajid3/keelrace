import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { emptyChoice, heuristicNfrMatches, homelessNfrs, nfrsUnderDecision, tokenize } from '../frontend/src/lib/nfrSuggest.js'

describe('nfr suggest', () => {
  it('maps privacy NFR onto an encryption decision, not an unrelated one', () => {
    const nfrs = [
      { id: 'n1', name: 'Privacy', description: 'Encrypt mood entries at rest' },
      { id: 'n2', name: 'Launch time', description: 'Home must render in 400ms' },
    ]
    const decisions = [
      { id: 'd1', decision_point: 'Storage encryption', chosen_option: 'SQLCipher encrypts entries at rest' },
      { id: 'd2', decision_point: 'Chart library', chosen_option: 'Use SVG sparkline widgets' },
    ]
    const out = heuristicNfrMatches(nfrs, decisions)
    assert.deepEqual(out[0].suggested_decision_ids, ['d1'])
    assert.ok(out[1].new_decision)
    assert.equal(out[1].suggested_decision_ids.length, 0)
    const choice = emptyChoice(nfrs[0], decisions, out[0])
    assert.equal(choice.mode, 'existing')
    assert.deepEqual(choice.selected, ['d1'])
    assert.ok(tokenize('Encrypt mood entries').includes('encrypt'))
  })

  it('treats unassigned rules as homeless and assigned ones as under a decision', () => {
    const nfrs = [{ id: 'n1' }, { id: 'n2' }]
    const choices = {
      n1: { selected: ['d1'], mode: 'existing', skip: false },
      n2: { selected: [], mode: 'existing', skip: false },
    }
    assert.deepEqual(nfrsUnderDecision(nfrs, choices, 'd1').map((n) => n.id), ['n1'])
    assert.deepEqual(homelessNfrs(nfrs, choices).map((n) => n.id), ['n2'])
  })
})
