export function matchNamedElements(text, names) {
  const t = String(text || '').toLowerCase()
  return (names || []).filter((n) => n && t.includes(String(n).toLowerCase()))
}

export function heuristicWalkPath(scenario, elementNames) {
  const blob = `${scenario.title || ''} ${scenario.stimulus || ''} ${scenario.expected_response || scenario.response || ''}`
  const hit = matchNamedElements(blob, elementNames)
  const used = hit.length ? hit : (elementNames || []).slice(0, 3)
  return {
    affected: used,
    path_summary: used.length
      ? `Walk ${used.join(' → ')} against “${scenario.title || 'scenario'}”. No score.`
      : 'No named elements matched this scenario. Architect should name the path.',
  }
}

export function heuristicOutcome(candidate, scenario) {
  const sac = `${candidate.sacrifices || ''} ${candidate.summary || ''}`.toLowerCase()
  const opt = `${candidate.optimizes || ''}`.toLowerCase()
  const title = `${scenario.title || ''} ${scenario.stimulus || ''}`.toLowerCase()
  const quality = String(scenario.quality || scenario.kind || '').toLowerCase()
  if (sac && (title.split(/\W+/).some((w) => w.length > 4 && sac.includes(w)) || (quality && sac.includes(quality)))) {
    return { qualitative_result: 'degrades', rationale: 'Candidate text already names a sacrifice that overlaps this scenario. Not a score.' }
  }
  if (opt && title.split(/\W+/).some((w) => w.length > 4 && opt.includes(w))) {
    return { qualitative_result: 'holds', rationale: 'Candidate claims to optimize a concern that appears in this scenario. Architect still walks it.' }
  }
  return { qualitative_result: 'unknown', rationale: 'Record does not say whether this candidate holds the scenario.' }
}

export function workshopWalksComplete(scenarios, walks) {
  const inBound = (scenarios || []).filter((s) => s.in_boundary)
  if (!inBound.length) return true
  return inBound.every((s) => (walks || []).some((w) => w.scenario_id === s.id && w.status !== 'dismissed'))
}
