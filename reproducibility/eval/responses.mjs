function ids(caseRow, ...refs) {
  const map = Object.fromEntries(caseRow.requirements.map((r) => [r.ref_code, r.id]))
  const found = refs.map((ref) => map[ref]).filter(Boolean)
  if (found.length) return found
  return caseRow.requirements.slice(0, 3).map((r) => r.id)
}

export function authoredResponse(caseRow, role) {
  const reqs = caseRow.requirements
  const compound = reqs.filter((r) => /\band\b/i.test(r.title) || (r.body.match(/\band\b/gi) || []).length >= 2)
  const names = caseRow.alternatives
  if (!names?.length) throw new Error(`case ${caseRow.id} missing alternatives`)

  const critic = {
    findings: [
      ...compound.map((r) => ({
        requirement_id: r.id,
        severity: 'medium',
        title: `${r.ref_code} looks compound`,
        body: 'More than one demand in one statement. Split if they can fail independently.',
        suggested_rewrite: `${r.title.split(/ and /i)[0]} shall be specified as its own requirement.`,
        confidence: 'grounded',
        questions: [`Which half of ${r.ref_code} is the acceptance test?`],
      })),
      {
        requirement_id: reqs[0].id,
        severity: 'low',
        title: `${reqs[0].ref_code} naming is clear`,
        body: 'Keep the obligation verb; add a measurable check only if the architect wants a test hook.',
        suggested_rewrite: null,
        confidence: 'partial',
        questions: [],
      },
    ],
  }

  const drivers = {
    drivers: [
      {
        quality_attribute: caseRow.primary_qa || 'security',
        title: `${caseRow.name} primary driver`,
        stimulus: 'Stated load or disclosure event',
        environment: caseRow.domain,
        response: 'System meets the locked NFR without rewriting the requirement set in place',
        source_requirement_ids: ids(caseRow).slice(0, 3),
        confidence: 'grounded',
        questions: ['What is the measurement window?'],
      },
      {
        quality_attribute: 'maintainability',
        title: `${caseRow.name} secondary driver`,
        stimulus: 'A change matching the Door-2 narrative',
        environment: 'approved baseline',
        response: 'Impact is scoped before reconvergence',
        source_requirement_ids: ids(caseRow).slice(0, 1),
        confidence: 'partial',
        questions: ['Which team owns reconvergence?'],
      },
    ],
  }

  const mermaidFor = (a, b, c) => `flowchart LR\n${a}[${a}]-->${b}[${b}]\n${b}-->${c}[${c}]`

  const candidates = {
    candidates: names.map((n, i) => ({
      name: n.name,
      summary: n.name,
      optimizes: n.opt,
      sacrifices: n.sac,
      components: [
        { name: 'Client', responsibility: 'Actor-facing entry' },
        { name: 'Core', responsibility: 'Domain rules' },
        { name: 'Store', responsibility: 'State and evidence' },
      ],
      mermaid: mermaidFor('Client', 'Core', 'Store'),
      confidence: i === 2 ? 'ungrounded' : 'partial',
      questions: ['Does an accepted driver actually demand this split?'],
      knowledge_titles: ['Modular monolith vs services', 'MADR fields'],
    })),
  }

  const challenge = {
    findings: [
      {
        severity: 'high',
        title: 'NFR with no owning component',
        body: `The locked statements in ${caseRow.name} are not yet allocated to components. Approval must wait for citations.`,
        confidence: 'partial',
        questions: ['Which component fails if the primary quality attribute is false?'],
      },
      {
        severity: 'medium',
        title: 'Over-engineering risk on candidate 3',
        body: 'The third candidate fights a constraint in the source document. Treat it as a discarded alternative in the ADR, not a live option.',
        confidence: 'grounded',
        questions: [],
      },
    ],
  }

  const draft_adr = {
    alternatives: names.map((n) => ({ option: n.name, rejection_reason: n.sac })),
    suggested_requirement_ids: ids(caseRow),
    consequences: 'Choosing an option changes deployability and evidence location. Record the rejection reasons.',
    confidence: 'partial',
    questions: [caseRow.decision_point],
    notes_on_missing_context: 'No production metrics in the published excerpt.',
  }

  const scenarios = {
    utility_tree: [
      { quality: caseRow.primary_qa || 'security', attribute: 'primary', scenario: 'Driver from the source document' },
      { quality: 'reliability', attribute: 'availability', scenario: 'Dependency down on the happy path' },
    ],
    scenarios: [
      { title: 'Happy path', stimulus: `Actor exercises ${reqs[0].ref_code}`, environment: 'normal load', response: 'Locked statement holds', kind: 'use', confidence: 'partial', questions: [] },
      { title: 'Dependency loss', stimulus: 'Optional dependency unavailable', environment: 'degraded', response: 'Core FR still holds', kind: 'use', confidence: 'partial', questions: [] },
      { title: 'Door-2 change', stimulus: caseRow.change, environment: 'approved baseline', response: 'New RequirementSet version, prior approved docs remain until review', kind: 'growth', confidence: 'grounded', questions: [] },
      { title: 'Audit export', stimulus: 'Stakeholder asks for evidence', environment: 'after 12 months', response: 'Trail if the source NFR demands it', kind: 'exploratory', confidence: 'partial', questions: [] },
      { title: 'Key rotation', stimulus: 'Compromise of a wrapping key', environment: 'production', response: 'Re-wrap without rewriting requirement bodies', kind: 'exploratory', confidence: 'partial', questions: [] },
      { title: 'Load spike', stimulus: '10x stated load', environment: 'peak', response: 'NFR latency either holds or is explicitly waived', kind: 'use', confidence: 'ungrounded', questions: ['What is the stated load?'] },
    ],
  }

  const views = {
    views: [{ name: 'context', mermaid: mermaidFor('Actor', 'Core', 'Store') }],
  }

  const change_brief = {
    brief: `Door-2 change for ${caseRow.name}: ${caseRow.change}. Scope at least the component that owns ${reqs[0].ref_code}. Do not edit the locked RequirementSet in place.`,
    cannot_infer: ['exact blast radius in source files', 'team roster'],
    confidence: 'partial',
  }

  const generate_hld = {
    hld: {
      summary: `${caseRow.name} HLD for ${caseRow.domain}, sourced from ${caseRow.corpus}. Structure follows the locked published statements; approval is a later gate.`,
      components: [
        { name: 'Client', description: 'Actor-facing entry', needs_detail: true, matched_family_key: null },
        { name: 'Core', description: 'Domain rules', needs_detail: true, matched_family_key: null },
        { name: 'Store', description: 'State and evidence', needs_detail: true, matched_family_key: null },
      ],
    },
    decisions: [
      {
        decision_point: caseRow.decision_point,
        chosen_option: names[0].name,
        alternatives_considered: names.slice(1).map((n) => ({ option: n.name, rejection_reason: n.sac })),
        driving_requirement_ref_codes: reqs.map((r) => r.ref_code).slice(0, 4),
        risk_level: caseRow.primary_qa === 'security' ? 'high' : 'medium',
      },
    ],
    llds: [
      { component_name: 'Core', content: { summary: `Core realises ${reqs[0].ref_code}`, interfaces: ['command', 'query'], data_model: 'domain records' } },
      { component_name: 'Store', content: { summary: 'Store holds state required by the source document', interfaces: ['put', 'get'], data_model: 'records' } },
    ],
  }

  const nfrLike = reqs.filter((r) => /^(NFR|CON|SRS)-/i.test(r.ref_code) || /OS|CMK|ACC|TH/i.test(r.ref_code))
  const ask = {
    answer: `From the locked published set, ${caseRow.name} (${caseRow.corpus}) treats ${nfrLike.map((r) => r.ref_code).join(', ') || reqs.map((r) => r.ref_code).slice(0, 3).join(', ')} as first-class constraints. No approved HLD is in the record yet.`,
    citations: (nfrLike.length ? nfrLike : reqs).map((r) => r.ref_code).slice(0, 4),
    confidence: 'grounded',
    missing: ['approved design document', 'NFR citations on components'],
  }

  const table = { critic, drivers, candidates, challenge, draft_adr, scenarios, views, change_brief, generate_hld, ask }
  const payload = table[role]
  if (!payload) throw new Error(`no authored response for ${role}`)
  return JSON.stringify(payload)
}
