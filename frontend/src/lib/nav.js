export const PROJECT_NAV = [
  {
    label: 'In order',
    items: [
      { to: '', label: 'Requirements', end: true, progressIds: ['requirements'] },
      { to: 'nfrs', label: 'NFRs & Risk', progressIds: ['nfrs'] },
      { to: 'design', label: 'Design Docs', progressIds: ['design'] },
      { to: 'review', label: 'Review Queue', progressIds: ['review'] },
      { to: 'traceability', label: 'Diagram / Traceability', progressIds: ['trace'] },
      { to: 'snapshots', label: 'Snapshots', progressIds: ['snap'] },
      { to: 'package', label: 'Package', progressIds: ['pkg'] },
    ],
  },
  {
    label: 'Library',
    aside: true,
    blurb: 'Not another pass. Open one when that question shows up.',
    items: [
      { to: 'assist', label: 'Architect assist', use: 'Compare splits before the official map. Nothing here approves.' },
      { to: 'adr', label: 'ADR Ledger', use: 'The questions you settled, and the rule each one left behind.' },
      { to: 'map', label: 'Evidence map', use: 'Why a component exists: requirement, decision, then file.' },
      { to: 'health', label: 'Drift & Health', use: 'After a file changes: still allowed, or it breaks a rule.' },
      { to: 'contracts', label: 'Contracts', use: 'The API or event shape between two components.' },
      { to: 'changes', label: 'Changes & Signals', use: 'A new requirement, or something found after the set was locked.' },
      { to: 'debt', label: 'Debt Backlog', use: 'Work you are leaving on purpose, written down.' },
      { to: 'governance', label: 'Governance', use: 'Where it runs, and a threat note if a boundary is crossed.' },
      { to: 'teams', label: 'Team Boundaries', use: 'Which team owns which component.' },
      { to: 'team', label: 'Members', use: 'Who is allowed to approve.' },
      { to: 'audit', label: 'Traceability Audit', use: 'A check that documents, decisions, and files still point at each other.' },
    ],
  },
]

export function navItemStatus(item, progress) {
  const ids = item.progressIds
  if (!ids?.length || !progress?.steps) {
    return { kind: 'idle', title: item.label }
  }
  const steps = progress.steps.filter((s) => ids.includes(s.id))
  if (!steps.length) return { kind: 'idle', title: item.label }
  const nextId = progress.next?.id
  const unfinished = steps.find((s) => !s.done)
  if (!unfinished) return { kind: 'done', title: `${item.label} — completed` }
  if (ids.includes(nextId)) return { kind: 'now', title: `${item.label} — in progress (${progress.next.label})` }
  if (steps.some((s) => s.done)) return { kind: 'now', title: `${item.label} — in progress` }
  return { kind: 'todo', title: `${item.label} — pending` }
}
