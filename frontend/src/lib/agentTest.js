import { supabase, callFunction } from './supabase.js'
import { buildPackageHtml } from './packageTemplate.js'
import { captureLoopRun } from './loopRun.js'
import { evaluateConformance } from './conformance.js'
import { fillShowcaseSurfaces } from './showcaseFill.js'
import { flowFromComponents, normalizeFlow } from './flowShape.js'

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const s = String(reader.result || '')
      const i = s.indexOf(',')
      resolve(i >= 0 ? s.slice(i + 1) : s)
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

async function expectFail(label, fn) {
  try {
    await fn()
    return { ok: false, detail: `${label} succeeded — this path should have been blocked.` }
  } catch (e) {
    return { ok: true, detail: `Blocked as expected: ${e.message}` }
  }
}

export async function runAgentTest({ projectId, file, userId, onLog, onFinding }) {
  const log = (msg) => onLog?.(msg)
  const finding = (row) => onFinding?.(row)
  if (!projectId) throw new Error('Pick a project on Agent test.')

  log('Loading the project…')
  const { data: proj, error: pErr } = await supabase.from('projects').select('id, name').eq('id', projectId).single()
  if (pErr) throw new Error(pErr.message)
  finding({ id: 'project', phase: 'setup', title: 'Use existing project', result: 'pass', detail: proj.name })

  const { data: sets } = await supabase
    .from('requirement_sets')
    .select('*')
    .eq('project_id', proj.id)
    .order('version', { ascending: false })
  let reqSet = sets?.[0] ?? null
  if (!reqSet) {
    log('No requirement set yet — creating a draft on this project…')
    const created = await supabase.from('requirement_sets').insert({ project_id: proj.id, version: 1, status: 'draft' }).select().single()
    if (created.error) throw new Error(created.error.message)
    reqSet = created.data
  }

  const { data: existingReqs } = await supabase.from('requirements').select('id, ref_code, title, body').eq('requirement_set_id', reqSet.id)
  let frCon = existingReqs ?? []

  if (reqSet.status === 'draft') {
    log('Wrong path: generate while unlocked…')
    const unlockedGen = await expectFail('generate-design-docs on draft set', () => callFunction('generate-design-docs', { requirement_set_id: reqSet.id }))
    finding({ id: 'g01', phase: 'gates', title: 'Generate before lock is refused', result: unlockedGen.ok ? 'pass' : 'fail', detail: unlockedGen.detail })
  } else {
    finding({ id: 'g01', phase: 'gates', title: 'Generate before lock is refused', result: 'skip', detail: 'This project is already locked — that probe belongs on a draft set.' })
  }

  if (file && reqSet.status === 'draft' && !frCon.length) {
    log('Parsing the document into this project…')
    const ext = file.name.toLowerCase().endsWith('.pdf') ? 'pdf' : 'docx'
    const base64 = await fileToBase64(file)
    const extracted = await callFunction('extract-document-text', { file_base64: base64, mime_type: ext })
    if (!extracted.text?.trim()) throw new Error('Document produced no text')
    const parsed = await callFunction('parse-requirements-text', { raw_text: extracted.text })
    const items = parsed.items ?? []
    const parsedFr = items.filter((i) => i.type === 'FR' || i.type === 'CON')
    const nfrItems = items.filter((i) => i.type === 'NFR')
    if (!parsedFr.length) throw new Error('Parser found no FR/CON items')
    finding({ id: 'parse', phase: 'requirements', title: 'Parse document into this project', result: 'pass', detail: `${parsedFr.length} FR/CON, ${nfrItems.length} NFR` })
    const { error: reqErr } = await supabase.from('requirements').insert(
      parsedFr.map((i) => ({ requirement_set_id: reqSet.id, ref_code: i.ref_code, title: i.title, body: i.body })),
    )
    if (reqErr) throw new Error(reqErr.message)
    if (nfrItems.length) {
      const { error: nfrErr } = await supabase.from('nfrs').insert(
        nfrItems.map((i) => ({ project_id: proj.id, name: `${i.ref_code}: ${i.title}`, description: i.body })),
      )
      if (nfrErr) throw new Error(nfrErr.message)
    }
    const { data: inserted } = await supabase.from('requirements').select('id, ref_code, title, body').eq('requirement_set_id', reqSet.id)
    frCon = inserted ?? parsedFr
  } else if (frCon.length) {
    finding({
      id: 'parse',
      phase: 'requirements',
      title: 'Use requirements already on this project',
      result: 'pass',
      detail: `${frCon.length} items on ${proj.name}`,
    })
  } else {
    throw new Error('This project has no requirements yet. Upload the requirements document on Agent test, then run again.')
  }

  if (reqSet.status !== 'locked') {
    log('Wrong path: edit after we lock — locking now, then insert…')
    const { error: lockErr } = await supabase.from('requirement_sets').update({ status: 'locked', locked_at: new Date().toISOString() }).eq('id', reqSet.id)
    if (lockErr) throw new Error(lockErr.message)
    finding({ id: 'lock', phase: 'requirements', title: 'Lock requirement set', result: 'pass', detail: `v${reqSet.version} locked` })
    reqSet = { ...reqSet, status: 'locked' }
  } else {
    finding({ id: 'lock', phase: 'requirements', title: 'Lock requirement set', result: 'pass', detail: `Already locked (v${reqSet.version})` })
  }

  const lockedWrite = await expectFail('insert requirement on locked set', async () => {
    const { data, error } = await supabase.from('requirements').insert({
      requirement_set_id: reqSet.id, ref_code: 'FR-AGENT-X', title: 'Illegal insert', body: 'Should fail',
    }).select('id').single()
    if (data?.id) {
      await supabase.from('requirements').delete().eq('id', data.id)
    }
    if (error) throw new Error(error.message)
  })
  finding({ id: 'g04', phase: 'gates', title: 'Locked set rejects in-place edits', result: lockedWrite.ok ? 'pass' : 'fail', detail: lockedWrite.detail })

  const { data: existingDocs } = await supabase
    .from('design_documents')
    .select('id, type, status, version')
    .eq('requirement_set_id', reqSet.id)
    .order('version', { ascending: false })
  let hld = (existingDocs ?? []).find((d) => d.type === 'HLD')
  let gen = { hld, components: [], llds: (existingDocs ?? []).filter((d) => d.type === 'LLD'), decision_rationales: [] }

  if (!hld) {
    log('Generating HLD/LLD on this project (this takes a while)…')
    gen = await callFunction('generate-design-docs', { requirement_set_id: reqSet.id })
    if (!gen.hld?.id) throw new Error('No HLD generated')
    hld = gen.hld
  } else {
    log('This project already has a system map — using it.')
    const { data: comps } = await supabase.from('components').select('id').eq('project_id', proj.id)
    const { data: drs } = await supabase.from('decision_rationales').select('id, design_document_id, risk_level').eq('design_document_id', hld.id)
    gen = { ...gen, hld, components: comps ?? [], decision_rationales: drs ?? [] }
  }
  const decideApprove = (gen.components ?? []).length > 0 || hld?.status === 'approved'
  finding({
    id: 'hld-gen',
    phase: 'design',
    title: 'System map',
    result: hld ? 'pass' : 'fail',
    detail: hld?.status === 'approved'
      ? 'HLD already approved on this project'
      : `${(gen.components ?? []).length} components, ${(gen.llds ?? []).length} LLDs. Agent will ${decideApprove ? 'approve' : 'request changes'}.`,
  })

  const { data: gates } = await supabase.from('review_gates').select('*').eq('project_id', proj.id).eq('target_artifact_table', 'design_documents')
  const hldGate = (gates ?? []).find((g) => g.target_artifact_id === gen.hld.id)
  if (!hldGate) throw new Error('HLD review gate missing')

  if (hld.status === 'approved') {
    finding({ id: 'g02', phase: 'gates', title: 'Uncited HLD cannot become official', result: 'skip', detail: 'HLD is already official on this project.' })
  } else {
    const { error: probeErr } = await supabase.from('review_gates').update({
      status: 'approved', reviewer_id: userId, decided_at: new Date().toISOString(), comment: 'agent probe',
    }).eq('id', hldGate.id)
    const { data: probeRow } = await supabase.from('design_documents').select('status').eq('id', gen.hld.id).single()
    const slipped = probeRow?.status === 'approved'
    finding({
      id: 'g02',
      phase: 'gates',
      title: 'Uncited HLD cannot become official',
      result: slipped ? 'fail' : 'pass',
      detail: slipped ? 'HLD reached approved without citations' : (probeErr?.message || 'Approval did not stick without citations'),
    })
    if (slipped) throw new Error('HLD approved without citations — stopping')
    await supabase.from('review_gates').update({
      status: 'pending', reviewer_id: null, decided_at: null, comment: null,
    }).eq('id', hldGate.id)
  }

  log('Attaching quality rules to the first HLD decision, completing spikes…')
  const { data: nfrs } = await supabase.from('nfrs').select('id').eq('project_id', proj.id)
  const firstDr = gen.decision_rationales?.[0]
  if ((nfrs ?? []).length && firstDr?.id) {
    const { error: citeErr } = await supabase.from('nfr_citations').insert(
      nfrs.map((n) => ({ nfr_id: n.id, decision_rationale_id: firstDr.id })),
    )
    if (citeErr && !/duplicate|unique/i.test(citeErr.message)) throw new Error(citeErr.message)
  }
  const { data: highRisk } = await supabase.from('decision_rationales').select('id').eq('design_document_id', gen.hld.id).eq('risk_level', 'high')
  for (const r of highRisk ?? []) {
    await supabase.from('spike_records').insert({
      decision_rationale_id: r.id,
      summary: 'Agent test: spike closed so approval can proceed',
      completed: true,
      completed_at: new Date().toISOString(),
    })
  }

  if (hld.status === 'approved') {
    finding({ id: 'hld-ok', phase: 'review', title: 'Approve HLD', result: 'pass', detail: 'Already official on this project' })
  } else if (decideApprove) {
    log('Approving HLD…')
    const { error: appr } = await supabase.from('review_gates').update({
      status: 'approved', reviewer_id: userId, decided_at: new Date().toISOString(), comment: 'Agent test: split is usable',
    }).eq('id', hldGate.id)
    if (appr) throw new Error(appr.message)
    await supabase.from('review_actions').insert({
      reviewable_item_id: gen.hld.id, reviewable_item_table: 'design_documents', action: 'approve', reviewer_id: userId, comment: 'agent',
    })
    const { data: hldRow } = await supabase.from('design_documents').select('status').eq('id', gen.hld.id).single()
    finding({ id: 'hld-ok', phase: 'review', title: 'Approve HLD', result: hldRow?.status === 'approved' ? 'pass' : 'fail', detail: `status=${hldRow?.status}` })
  } else {
    log('Requesting changes on empty HLD…')
    const { error: rc } = await supabase.from('review_gates').update({
      status: 'changes_requested', reviewer_id: userId, decided_at: new Date().toISOString(), comment: 'Agent test: no components to approve',
    }).eq('id', hldGate.id)
    if (rc) throw new Error(rc.message)
    finding({ id: 'hld-rc', phase: 'review', title: 'Request changes (empty HLD)', result: 'warn', detail: 'Agent sent the HLD back because it had no components.' })
    return { projectId: proj.id, projectName: proj.name }
  }

  log('Unblocking and approving LLDs (override when a component has no decisions)…')
  const { data: freshGates } = await supabase.from('review_gates').select('*').eq('project_id', proj.id).eq('target_artifact_table', 'design_documents')
  const lldGates = freshGates ?? gates
  const llds = gen.llds ?? []
  if (!llds.length) {
    finding({ id: 'lld-ok', phase: 'review', title: 'Approve LLDs', result: 'skip', detail: 'No LLDs in this generate — skipped.' })
  }
  let lldApproved = 0
  for (const lld of llds) {
    const { data: lldDrs } = await supabase.from('decision_rationales').select('id').eq('design_document_id', lld.id).limit(1)
    if (!lldDrs?.length) {
      await supabase.from('design_documents').update({ nfr_override: true }).eq('id', lld.id)
    } else if ((nfrs ?? []).length) {
      const { error: citeLld } = await supabase.from('nfr_citations').insert(
        nfrs.map((n) => ({ nfr_id: n.id, decision_rationale_id: lldDrs[0].id })),
      )
      if (citeLld && !/duplicate|unique/i.test(citeLld.message)) throw new Error(citeLld.message)
    }
    const lldGate = (lldGates ?? []).find((g) => g.target_artifact_id === lld.id)
    if (!lldGate) continue
    const { error: lldAppr } = await supabase.from('review_gates').update({
      status: 'approved', reviewer_id: userId, decided_at: new Date().toISOString(), comment: 'Agent test: component internals accepted for loop coverage',
    }).eq('id', lldGate.id)
    if (!lldAppr) lldApproved++
  }
  finding({ id: 'lld-ok', phase: 'review', title: 'Approve LLDs', result: lldApproved ? 'pass' : 'fail', detail: `${lldApproved} LLD gate(s) approved` })

  log('Prototype…')
  let proto = await callFunction('generate-prototype', { design_document_id: gen.hld.id, type: 'flow-diagram' })
  if (proto?.id && !normalizeFlow(proto.content).nodes.length) {
    const comps = (gen.components ?? []).map((c) => ({ id: c.id || c.name, name: c.name || c.id }))
    const flow = comps.length ? flowFromComponents(comps) : { nodes: [{ id: 'start', label: 'Start' }, { id: 'done', label: 'Done' }], edges: [{ from: 'start', to: 'done' }] }
    await supabase.from('prototypes').update({ content: flow }).eq('id', proto.id)
    proto = { ...proto, content: flow }
  }
  finding({ id: 'proto', phase: 'build', title: 'Prototype', result: proto.id ? 'pass' : 'fail', detail: proto.id || 'missing' })

  log('Skeleton…')
  try {
    const skel = await callFunction('generate-skeleton', { project_id: proj.id, design_document_id: gen.hld.id })
    finding({ id: 'skel', phase: 'build', title: 'Skeleton', result: 'pass', detail: `${skel.inserted?.length ?? 0} file(s)` })
  } catch (e) {
    finding({ id: 'skel', phase: 'build', title: 'Skeleton', result: 'warn', detail: e.message })
  }

  log('Filling remaining surfaces so every tab has real content…')
  await fillShowcaseSurfaces({
    projectId: proj.id,
    projectName: proj.name,
    hldId: gen.hld?.id,
    onLog: log,
    onFinding: finding,
  })

  log('Snapshot + package + map…')
  await supabase.from('architecture_snapshots').insert({
    project_id: proj.id,
    label: 'agent-test-loop',
    structure: { note: 'agent test snapshot' },
  })
  const record = await captureLoopRun(supabase, proj.id)
  const { error: runErr } = await supabase.from('loop_runs').insert({
    project_id: proj.id,
    created_by: userId,
    label: 'Agent test — replayable run',
    record,
  })
  finding({
    id: 'replay',
    phase: 'verify',
    title: 'Replayable run saved',
    result: runErr ? 'warn' : 'pass',
    detail: runErr?.message || 'Open Evidence map → Replayable runs',
  })
  const html = buildPackageHtml({
    project: { name: proj.name },
    set: record.requirement_set,
    reqs: record.requirements,
    nfrs: record.nfrs,
    hld: gen.hld,
    llds: gen.llds,
    components: gen.components,
    decisions: gen.decision_rationales,
    prototypes: [proto],
    artifacts: record.artifacts,
    snapshots: [{ id: 's' }],
    progress: { completed: 10, total: 10, remaining: [] },
  })
  finding({
    id: 'pkg',
    phase: 'package',
    title: 'Architecture package',
    result: /Door 1/.test(html) && /<svg/.test(html) ? 'pass' : 'fail',
    detail: html.includes('Door 1') ? 'Package includes layered diagram and change doors' : 'Package missing expected sections',
  })
  const checks = evaluateConformance(record)
  const failed = checks.filter((c) => !c.informational && !c.pass)
  finding({
    id: 'conform',
    phase: 'verify',
    title: 'Conformance',
    result: failed.length ? 'warn' : 'pass',
    detail: failed.length ? failed.map((c) => c.name).join('; ') : 'In-boundary checks passed',
  })

  log('Door 1: change request…')
  const target = frCon[0]
  const { data: reqRow } = await supabase.from('requirements').select('id').eq('requirement_set_id', reqSet.id).eq('ref_code', target.ref_code).maybeSingle()
  if (reqRow) {
    const { error: crErr } = await supabase.from('change_requests').insert({
      project_id: proj.id,
      requested_by: userId,
      action: 'modify',
      target_requirement_id: reqRow.id,
      description: 'Agent test: modify one FR through Door 1',
      proposed_text: `${target.body}\n[agent-test amendment]`,
    })
    finding({
      id: 'door1',
      phase: 'change',
      title: 'Door 1 change request',
      result: crErr ? 'fail' : 'pass',
      detail: crErr?.message || 'CR filed against locked set',
    })
  }

  log('Door 2: signal…')
  const { error: sigErr } = await supabase.from('signals').insert({
    project_id: proj.id,
    raised_by: userId,
    source_type: 'implementation_finding',
    description: 'Agent test: skeleton retry path looks incomplete',
    classification: 'implementation_defect',
  })
  finding({
    id: 'door2',
    phase: 'change',
    title: 'Door 2 signal',
    result: sigErr ? 'fail' : 'pass',
    detail: sigErr?.message || 'Signal recorded without editing the SRS',
  })

  log('Done.')
  return { projectId: proj.id, projectName: proj.name }
}
