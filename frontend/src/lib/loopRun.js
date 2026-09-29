export async function captureLoopRun(supabase, projectId) {
  const { data: project } = await supabase.from('projects').select('id, name').eq('id', projectId).single()
  const { data: sets } = await supabase.from('requirement_sets').select('id, version, status').eq('project_id', projectId).order('version', { ascending: false })
  const latestSet = sets?.[0] ?? null
  let requirements = []
  if (latestSet) {
    const { data } = await supabase.from('requirements').select('id, ref_code, title, body').eq('requirement_set_id', latestSet.id).order('ref_code')
    requirements = data ?? []
  }
  const { data: nfrs } = await supabase.from('nfrs').select('id, name, description, component_id').eq('project_id', projectId)
  const { data: docs } = await supabase
    .from('design_documents')
    .select('id, type, version, status, content, component_id, nfr_override, requirement_sets!inner(project_id)')
    .eq('requirement_sets.project_id', projectId)
  const docIds = (docs ?? []).map((d) => d.id)
  const { data: components } = await supabase.from('components').select('id, name, description, hld_document_id').eq('project_id', projectId)
  let decisions = []
  if (docIds.length) {
    const { data } = await supabase
      .from('decision_rationales')
      .select('id, design_document_id, decision_point, chosen_option, driving_requirements, component_id, risk_level')
      .in('design_document_id', docIds)
    decisions = data ?? []
  }
  const drIds = decisions.map((d) => d.id)
  let citations = []
  if (drIds.length) {
    const { data } = await supabase.from('nfr_citations').select('nfr_id, decision_rationale_id').in('decision_rationale_id', drIds)
    citations = data ?? []
  }
  const { data: gates } = await supabase.from('review_gates').select('id, phase, status, target_artifact_id, comment, decided_at').eq('project_id', projectId)
  const { data: artifacts } = await supabase.from('code_artifacts').select('id, path, type, design_component_id, generation_version').eq('project_id', projectId)
  const { data: contracts } = await supabase.from('service_contracts').select('id, service_name, type, version').eq('project_id', projectId)
  const workshop = await supabase.from('evaluation_scenarios').select('id, title, in_boundary, kind').eq('project_id', projectId)
  const walksRes = await supabase.from('evaluation_walks').select('id, scenario_id, status, path_summary').eq('project_id', projectId)
  const pointsRes = await supabase.from('evaluation_points').select('id, kind, quality_a, quality_b, status').eq('project_id', projectId)

  return {
    captured_at: new Date().toISOString(),
    project,
    requirement_set: latestSet,
    requirements,
    nfrs: nfrs ?? [],
    documents: docs ?? [],
    components: components ?? [],
    decisions,
    citations,
    gates: gates ?? [],
    artifacts: artifacts ?? [],
    contracts: contracts ?? [],
    evaluation_scenarios: workshop.error ? [] : workshop.data ?? [],
    evaluation_walks: walksRes.error ? [] : walksRes.data ?? [],
    evaluation_points: pointsRes.error ? [] : pointsRes.data ?? [],
  }
}

export function edgesFromRecord(record) {
  const reqById = new Map((record.requirements ?? []).map((r) => [r.id, r]))
  const nfrById = new Map((record.nfrs ?? []).map((n) => [n.id, n]))
  const decById = new Map((record.decisions ?? []).map((d) => [d.id, d]))
  const edges = []
  for (const d of record.decisions ?? []) {
    for (const rid of d.driving_requirements ?? []) {
      const req = reqById.get(rid)
      if (req) edges.push({ kind: 'req-decision', from: req.ref_code, to: d.decision_point, req, decision: d })
    }
  }
  for (const c of record.citations ?? []) {
    const nfr = nfrById.get(c.nfr_id)
    const d = decById.get(c.decision_rationale_id)
    if (nfr && d) edges.push({ kind: 'decision-nfr', from: d.decision_point, to: nfr.name, nfr, decision: d })
  }
  for (const a of (record.artifacts ?? []).filter((x) => x.type === 'file' && x.design_component_id)) {
    const comp = (record.components ?? []).find((c) => c.id === a.design_component_id)
    if (comp) edges.push({ kind: 'component-file', from: comp.name, to: a.path, component: comp, artifact: a })
  }
  return edges
}
