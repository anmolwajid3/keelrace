export const PACKAGE_STEPS = [
  { id: 'requirements', n: 1, label: 'Requirements', to: '', remain: 'On Requirements: add the requirements, lock the set, then generate the system map. Leave when the map exists.' },
  { id: 'nfrs', n: 2, label: 'Quality rules', to: 'nfrs', remain: 'On NFRs & Risk: record the quality rules. Leave when at least one exists.' },
  { id: 'design', n: 3, label: 'Design Docs', to: 'design', remain: 'On Design Docs: attach those rules to the system map. The next page is Review.' },
  { id: 'review', n: 4, label: 'Review', to: 'review', remain: 'On Review Queue: approve the system map, then the component designs. Leave when both are approved.' },
  { id: 'trace', n: 5, label: 'Diagram and skeleton', to: 'traceability', remain: 'On Diagram / Traceability: generate the prototype and the skeleton, then download the zip.' },
  { id: 'snap', n: 6, label: 'Snapshot', to: 'snapshots', remain: 'On Snapshots: capture the current structure.' },
  { id: 'pkg', n: 7, label: 'Package', to: 'package', remain: 'On Package: read the brief and export it.' },
]

export async function loadProjectProgress(supabase, projectId) {
  const { data: sets } = await supabase
    .from('requirement_sets')
    .select('id, status, version')
    .eq('project_id', projectId)
    .order('version', { ascending: false })
  const latestSet = sets?.[0] ?? null
  const locked = sets?.some((s) => s.status === 'locked') ?? false

  const { count: nfrCount } = await supabase
    .from('nfrs')
    .select('id', { count: 'exact', head: true })
    .eq('project_id', projectId)

  const { data: docs } = await supabase
    .from('design_documents')
    .select('id, type, version, status, hld_component_id, nfr_override, requirement_sets!inner(project_id)')
    .eq('requirement_sets.project_id', projectId)
    .order('version', { ascending: false })
  const hlds = (docs ?? []).filter((d) => d.type === 'HLD')
  const llds = (docs ?? []).filter((d) => d.type === 'LLD')
  const latestHld = hlds[0] ?? null

  let cited = false
  if (latestHld) {
    if (latestHld.nfr_override) cited = true
    else if (!nfrCount) cited = true
    else {
      const { data: drs } = await supabase.from('decision_rationales').select('id').eq('design_document_id', latestHld.id).limit(1)
      const rid = drs?.[0]?.id
      if (rid) {
        const { count } = await supabase.from('nfr_citations').select('nfr_id', { count: 'exact', head: true }).eq('decision_rationale_id', rid)
        cited = (count ?? 0) > 0
      }
    }
  }

  const hldApproved = latestHld?.status === 'approved'
  // Only the current system map's component designs count. A replaced design
  // stays in the table as superseded and must not keep this step open.
  const currentLlds = llds.filter((d) => d.hld_component_id === latestHld?.id && d.status !== 'superseded')
  const lldPending = currentLlds.filter((d) => d.status !== 'approved')
  const lldsOk = !latestHld || currentLlds.length === 0 || lldPending.length === 0

  let protoCount = 0
  if (latestHld) {
    const { count } = await supabase.from('prototypes').select('id', { count: 'exact', head: true }).eq('design_document_id', latestHld.id)
    protoCount = count ?? 0
  }

  const { count: artCount } = await supabase
    .from('code_artifacts')
    .select('id', { count: 'exact', head: true })
    .eq('project_id', projectId)

  const { count: snapCount } = await supabase
    .from('architecture_snapshots')
    .select('id', { count: 'exact', head: true })
    .eq('project_id', projectId)

  const doneMap = {
    requirements: locked && Boolean(latestHld),
    nfrs: (nfrCount ?? 0) > 0,
    design: Boolean(latestHld) && cited,
    review: Boolean(hldApproved) && lldsOk,
    trace: protoCount > 0 && (artCount ?? 0) > 0,
    snap: (snapCount ?? 0) > 0,
    pkg: false,
  }
  // Package step is complete only when the rest of the template can be filled.
  doneMap.pkg = PACKAGE_STEPS.filter((s) => s.id !== 'pkg').every((s) => doneMap[s.id])

  const steps = PACKAGE_STEPS.map((s) => ({ ...s, done: !!doneMap[s.id] }))
  const completed = steps.filter((s) => s.done).length
  const remaining = steps.filter((s) => !s.done)
  const next = remaining[0] ?? null
  return {
    steps,
    completed,
    total: steps.length,
    remaining,
    next,
    latestSet,
    latestHld,
  }
}
