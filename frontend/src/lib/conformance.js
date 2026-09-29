export function verificationBoundaries() {
  return {
    inScope: [
      'Locked requirements and constraints',
      'HLD/LLD decisions and NFR citations',
      'Review gates (who approved, when)',
      'Contracts between components',
      'Skeleton files linked to a component identity',
      'In-boundary evaluation scenarios and their walks (not scores)',
    ],
    outOfScope: [
      'Pixel-perfect UI and visual design',
      'Implementation defects found later (Door 2 / Signal)',
      'Runtime production metrics unless an NFR names them',
      'Code that was never emitted as a traced skeleton',
      'Numeric quality scores or chatbot grades of the architecture',
    ],
  }
}

export function evaluateConformance(record) {
  const reqs = record.requirements ?? []
  const decisions = record.decisions ?? []
  const citations = record.citations ?? []
  const nfrs = record.nfrs ?? []
  const docs = record.documents ?? []
  const artifacts = record.artifacts ?? []
  const citedNfr = new Set(citations.map((c) => c.nfr_id))
  const driving = new Set(decisions.flatMap((d) => d.driving_requirements ?? []))
  const hld = docs.filter((d) => d.type === 'HLD').sort((a, b) => b.version - a.version)[0]
  const llds = docs.filter((d) => d.type === 'LLD')
  const files = artifacts.filter((a) => a.type === 'file')
  const unlinked = files.filter((a) => !a.design_component_id)
  const scenarios = record.evaluation_scenarios ?? []
  const walks = record.evaluation_walks ?? []
  const inBound = scenarios.filter((s) => s.in_boundary)
  const walked = inBound.filter((s) => walks.some((w) => w.scenario_id === s.id && w.status !== 'dismissed'))

  return [
    {
      id: 'reqs-locked',
      name: 'Requirements are locked',
      pass: record.requirement_set?.status === 'locked',
      detail: record.requirement_set ? `Set v${record.requirement_set.version} is ${record.requirement_set.status}` : 'No requirement set',
    },
    {
      id: 'reqs-have-decisions',
      name: 'Every FR is driving at least one decision',
      pass: reqs.filter((r) => String(r.ref_code).toUpperCase().startsWith('FR')).every((r) => driving.has(r.id)),
      detail: `${driving.size} requirement id(s) cited by decisions`,
    },
    {
      id: 'nfr-cited',
      name: 'Every quality rule is cited (or the HLD has an override)',
      pass: nfrs.length === 0 || nfrs.every((n) => citedNfr.has(n.id)) || Boolean(hld?.nfr_override),
      detail: `${citedNfr.size}/${nfrs.length} quality rules cited`,
    },
    {
      id: 'hld-approved',
      name: 'Latest HLD is approved',
      pass: hld?.status === 'approved',
      detail: hld ? `HLD v${hld.version} is ${hld.status}` : 'No HLD',
    },
    {
      id: 'lld-component',
      name: 'Every LLD belongs to a component',
      pass: llds.every((d) => d.component_id),
      detail: `${llds.filter((d) => d.component_id).length}/${llds.length} LLDs linked`,
    },
    {
      id: 'files-linked',
      name: 'Skeleton files trace to a component (unlinked is visible, not a hard fail)',
      pass: true,
      informational: true,
      detail: files.length ? `${unlinked.length} unlinked of ${files.length} file(s)` : 'No skeleton yet',
    },
    {
      id: 'workshop-walks',
      name: 'In-boundary scenarios have a walk (not a score)',
      pass: inBound.length === 0 || walked.length === inBound.length,
      informational: false,
      detail: inBound.length ? `${walked.length}/${inBound.length} in-boundary scenario(s) walked` : 'No in-boundary scenarios',
    },
  ]
}
