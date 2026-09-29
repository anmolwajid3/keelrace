const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'for', 'in', 'on', 'at', 'by', 'with',
  'from', 'that', 'this', 'is', 'be', 'are', 'as', 'it', 'its', 'must', 'shall',
  'will', 'can', 'not', 'no', 'yes', 'user', 'system', 'app',
])

export function tokenize(text = '') {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP.has(t))
}

export function heuristicNfrMatches(nfrs = [], decisions = []) {
  return nfrs.map((nfr) => {
    const tokens = tokenize(`${nfr.name} ${nfr.description}`)
    const scored = decisions.map((d) => {
      const dtoks = new Set(tokenize(`${d.decision_point} ${d.chosen_option}`))
      const overlap = tokens.filter((t) => dtoks.has(t))
      return { id: d.id, score: overlap.length, overlap }
    }).sort((a, b) => b.score - a.score)
    const best = scored.filter((s) => s.score > 0).slice(0, 3)
    const newDecision = best.length
      ? null
      : {
        decision_point: `How this design meets ${nfr.name}`,
        chosen_option: (nfr.description || nfr.name).slice(0, 240),
        risk_level: 'low',
      }
    return {
      nfr_id: nfr.id,
      suggested_decision_ids: best.map((b) => b.id),
      reason: best.length
        ? `Likely match: shared terms (${best[0].overlap.slice(0, 5).join(', ') || 'related wording'}).`
        : 'No existing decision talks about this. Add one, pick one by hand, or skip it.',
      new_decision: newDecision,
    }
  })
}

export function emptyChoice(nfr, decisions, suggestion) {
  const suggested = new Set(suggestion?.suggested_decision_ids ?? [])
  const selected = decisions.filter((d) => suggested.has(d.id)).map((d) => d.id)
  const mode = selected.length ? 'existing' : (suggestion?.new_decision ? 'new' : (decisions.length ? 'existing' : 'new'))
  return {
    nfrId: nfr.id,
    mode,
    selected,
    newPoint: suggestion?.new_decision?.decision_point ?? `How this design meets ${nfr.name}`,
    newOption: suggestion?.new_decision?.chosen_option ?? (nfr.description || ''),
    skip: false,
  }
}

export function nfrsUnderDecision(nfrs, choices, decisionId) {
  return nfrs.filter((n) => (choices[n.id]?.selected ?? []).includes(decisionId))
}

export function homelessNfrs(nfrs, choices) {
  return nfrs.filter((n) => {
    const c = choices[n.id]
    if (!c) return true
    if (c.skip || c.mode === 'none') return true
    if (c.mode === 'new') return false
    return !(c.selected ?? []).length
  })
}
