import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth.jsx'
import ListToolbar from './ListToolbar.jsx'
import ErrorBanner from './ErrorBanner.jsx'
import PageLoading from './PageLoading.jsx'
import LoopSteps from './LoopSteps.jsx'
import { matchesQuery } from '../lib/text.js'
import { humanizeError } from '../lib/errors.js'
import { useToast } from '../hooks/useToast.jsx'
import NfrAttachPanel from './NfrAttachPanel.jsx'
import { originLabel } from './StandingRulePanel.jsx'

export default function ReviewQueueTab({ projectId }) {
  const { user } = useAuth()
  const toast = useToast()
  const [params] = useSearchParams()
  const focusDoc = params.get('doc')
  const [showOlder, setShowOlder] = useState(false)
  const [compById, setCompById] = useState({})
  const [gates, setGates] = useState([])
  const [docsByGate, setDocsByGate] = useState({}) // gate.id -> { doc, components, nfrStatus }
  const [comment, setComment] = useState({})
  const [selected, setSelected] = useState(new Set())
  const [batchComment, setBatchComment] = useState('')
  const [batchResults, setBatchResults] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [statusFilter, setStatusFilter] = useState('pending')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [rewriteId, setRewriteId] = useState('')
  const [rewriteText, setRewriteText] = useState('')

  async function load() {
    try {
    const { data } = await supabase
      .from('review_gates')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
    setGates(data ?? [])

    // Pull the actual document content for every gate that targets one, so
    // the reviewer can see what they're deciding on right here, instead of
    // approving/rejecting blind and cross-referencing Design Docs separately.
    const docGates = (data ?? []).filter((g) => g.target_artifact_table === 'design_documents')
    const map = {}
    for (const g of docGates) {
      const { data: doc } = await supabase.from('design_documents').select('*').eq('id', g.target_artifact_id).maybeSingle()
      if (!doc) continue

      let components = []
      let componentName = null
      let provenance = []
      let ruleBreaks = []
      if (doc.type === 'HLD') {
        const { data: comps } = await supabase.from('components').select('id, name, description, needs_detail, family_key').eq('hld_document_id', doc.id)
        components = comps ?? []
        const { data: prov } = await supabase.from('design_provenance').select('*').eq('design_document_id', doc.id)
        provenance = prov ?? []
      } else if (doc.component_id) {
        const { data: one } = await supabase.from('components').select('id, name').eq('id', doc.component_id).maybeSingle()
        componentName = one?.name ?? null
      }

      // Same per-component NFR scoping approve_design_document() enforces --
      // shown here so the reviewer sees the real blocker before clicking,
      // not after.
      let inScopeComponentIds = []
      if (doc.type === 'HLD') inScopeComponentIds = components.map((c) => c.id)
      else if (doc.component_id) inScopeComponentIds = [doc.component_id]

      const { data: allNfrs } = await supabase.from('nfrs').select('id, name, description, component_id').eq('project_id', projectId)
      const inScopeNfrs = (allNfrs ?? []).filter((n) => !n.component_id || inScopeComponentIds.includes(n.component_id))

      const { data: rationales } = await supabase.from('decision_rationales').select('id, chosen_option, alternatives_considered').eq('design_document_id', doc.id)
      await supabase.rpc('keelrace_check_document_rules', { p_document_id: doc.id, p_project_id: projectId })
      const rationaleIds = (rationales ?? []).map((r) => r.id)
      let citedNfrIds = new Set()
      if (rationaleIds.length) {
        const { data: citations } = await supabase.from('nfr_citations').select('nfr_id').in('decision_rationale_id', rationaleIds)
        citedNfrIds = new Set((citations ?? []).map((c) => c.nfr_id))
      }
      const uncitedList = inScopeNfrs.filter((n) => !citedNfrIds.has(n.id))

      let unwalkedScenarios = []
      if (doc.type === 'HLD') {
        const { data: sc } = await supabase.from('evaluation_scenarios').select('id, title, in_boundary').eq('project_id', projectId)
        const { data: wk } = await supabase.from('evaluation_walks').select('scenario_id, status, hld_document_id, candidate_id').eq('project_id', projectId)
        const { data: sel } = await supabase.from('architecture_candidates').select('id').eq('project_id', projectId).eq('status', 'selected')
        const selectedIds = new Set((sel ?? []).map((c) => c.id))
        unwalkedScenarios = (sc ?? []).filter((s) => s.in_boundary && !(wk ?? []).some((w) =>
          w.scenario_id === s.id && w.status !== 'dismissed' && (w.hld_document_id === doc.id || selectedIds.has(w.candidate_id))
        ))
      }

      const { data: docVerdicts } = await supabase
        .from('rule_verdicts')
        .select('id, result, reason, option_text, standing_rules(status, rule_text)')
        .eq('design_document_id', doc.id)
      const liveText = new Set()
      for (const r of rationales ?? []) {
        if (r.chosen_option) liveText.add(r.chosen_option)
        for (const alt of r.alternatives_considered || []) if (alt?.option) liveText.add(alt.option)
      }
      ruleBreaks = (docVerdicts ?? []).filter((v) => v.result === 'breaks' && v.standing_rules?.status === 'in_force' && liveText.has(v.option_text))

      map[g.id] = { doc, components, componentName, uncitedCount: uncitedList.length, uncitedList, decisionCount: rationaleIds.length, unwalkedScenarios, provenance, ruleBreaks }
    }
    setDocsByGate(map)
    const { data: comps } = await supabase.from('components').select('id, hld_document_id').eq('project_id', projectId)
    const cmap = {}
    for (const c of comps ?? []) cmap[c.id] = c
    setCompById(cmap)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [projectId])

  async function decideOne(gate, action, gateComment, batchId = null) {
    const gateStatus = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'changes_requested'
    const { error: gErr } = await supabase
      .from('review_gates')
      .update({ status: gateStatus, reviewer_id: user.id, decided_at: new Date().toISOString(), comment: gateComment || null })
      .eq('id', gate.id)
    if (gErr) throw new Error(gErr.message)

    const { error: aErr } = await supabase.from('review_actions').insert({
      reviewable_item_id: gate.target_artifact_id,
      reviewable_item_table: gate.target_artifact_table,
      batch_id: batchId,
      action,
      comment: gateComment || null,
      reviewer_id: user.id,
    })
    if (aErr) throw new Error(aErr.message)
  }

  async function unblockNfrs(docIds) {
    setError(null)
    let n = 0
    for (const id of docIds) {
      const info = Object.values(docsByGate).find((i) => i.doc?.id === id)
      if (!info || info.doc.nfr_override || !info.uncitedCount) continue
      if (info.decisionCount > 0) {
        const { data: drs } = await supabase.from('decision_rationales').select('id').eq('design_document_id', id).limit(1)
        const rid = drs?.[0]?.id
        if (rid) {
          const { data: nfrs } = await supabase.from('nfrs').select('id').eq('project_id', projectId)
          const { error } = await supabase.from('nfr_citations').insert(
            (nfrs ?? []).map((nfr) => ({ nfr_id: nfr.id, decision_rationale_id: rid })),
          )
          if (error && !/duplicate|unique/i.test(error.message)) return setError(error.message)
        } else {
          const { error } = await supabase.from('design_documents').update({ nfr_override: true }).eq('id', id)
          if (error) return setError(error.message)
        }
      } else {
        const { error } = await supabase.from('design_documents').update({ nfr_override: true }).eq('id', id)
        if (error) return setError(error.message)
      }
      n++
    }
    toast.success(n ? `Unblocked ${n} document(s). You can Approve them now.` : 'Nothing left to unblock.')
    load()
  }

  async function unblockHld() {
    setError(null)
    const g = pinnedHldGate
    const info = g ? docsByGate[g.id] : null
    if (!info?.doc) return setError('No HLD gate on this project. Generate an HLD from Requirements first.')
    const { data: drs } = await supabase.from('decision_rationales').select('id').eq('design_document_id', info.doc.id).limit(1)
    const rid = drs?.[0]?.id
    if (!rid) {
      const { error } = await supabase.from('design_documents').update({ nfr_override: true }).eq('id', info.doc.id)
      if (error) return setError(error.message)
    } else {
      const { data: nfrs } = await supabase.from('nfrs').select('id').eq('project_id', projectId)
      const { error } = await supabase.from('nfr_citations').insert(
        (nfrs ?? []).map((nfr) => ({ nfr_id: nfr.id, decision_rationale_id: rid })),
      )
      if (error && !/duplicate|unique/i.test(error.message)) return setError(error.message)
    }
    toast.success('HLD quality rules are attached. Click Approve on the System map card.')
    load()
  }

  async function approvePinnedHld() {
    setError(null)
    if (!pinnedHldGate || pinnedHldGate.status !== 'pending') return setError('HLD is not pending. If it is already approved, go to step 3.')
    try {
      await decideOne(pinnedHldGate, 'approve', '')
      toast.success('HLD approved.')
      load()
    } catch (e) { setError(e.message) }
  }

  async function approveVisibleLlds() {
    setError(null)
    const targets = lldGates.filter((g) => g.status === 'pending')
    if (!targets.length) return
    setBusy(true)
    const batchId = crypto.randomUUID()
    const results = []
    for (const g of targets) {
      try {
        await decideOne(g, 'approve', '', batchId)
        results.push({ gate: g, ok: true, message: 'done' })
      } catch (e) {
        results.push({ gate: g, ok: false, message: e.message })
      }
    }
    setBatchResults(results)
    setBusy(false)
    load()
  }

  async function decide(gate, action) {
    setError(null)
    const gateComment = comment[gate.id] ?? ''
    if (action === 'request_changes' && !gateComment.trim()) return setError('request_changes requires a non-empty comment')
    try {
      await decideOne(gate, action, gateComment)
      load()
    } catch (e) { setError(e.message) }
  }

  function toggleSelect(id) {
    const next = new Set(selected)
    next.has(id) ? next.delete(id) : next.add(id)
    setSelected(next)
  }

  function selectAllPending() {
    setSelected(new Set(visibleGates.filter((g) => g.status === 'pending').map((g) => g.id)))
  }
  function selectHldOnly() {
    setSelected(new Set(hldGates.filter((g) => g.status === 'pending').map((g) => g.id)))
  }
  function clearSelection() {
    setSelected(new Set())
  }

  async function decideBatch(action) {
    setError(null)
    setBatchResults(null)
    if (action === 'request_changes' && !batchComment.trim()) return setError('request_changes requires a non-empty comment')
    const targets = gates.filter((g) => selected.has(g.id) && g.status === 'pending')
    if (!targets.length) return
    setBusy(true)
    const batchId = crypto.randomUUID()
    const results = []
    for (const g of targets) {
      try {
        await decideOne(g, action, batchComment, batchId)
        results.push({ gate: g, ok: true, message: 'done' })
      } catch (e) {
        results.push({ gate: g, ok: false, message: e.message })
      }
    }
    setBatchResults(results)
    setSelected(new Set())
    setBatchComment('')
    setBusy(false)
    load()
  }

  const failedCount = batchResults?.filter((r) => !r.ok).length ?? 0

  const pinnedHldGate = useMemo(() => {
    let best = null
    for (const g of gates) {
      const d = docsByGate[g.id]?.doc
      if (d?.type !== 'HLD') continue
      if (!best || d.version > (docsByGate[best.id]?.doc?.version ?? 0)) best = g
    }
    return best
  }, [gates, docsByGate])

  const latestHldId = pinnedHldGate ? docsByGate[pinnedHldGate.id]?.doc?.id ?? null : null

  const visibleGates = gates.filter((g) => {
    if (statusFilter === 'pending' && g.status !== 'pending') return false
    if (statusFilter === 'decided' && g.status === 'pending') return false
    const info = docsByGate[g.id]
    if (!showOlder && latestHldId && info?.doc) {
      if (info.doc.type === 'HLD' && info.doc.id !== latestHldId) return false
      if (info.doc.type === 'LLD') {
        const parent = compById[info.doc.component_id]?.hld_document_id
        if (parent && parent !== latestHldId) return false
      }
    }
    return matchesQuery(`${g.phase} ${g.status} ${info?.doc?.type ?? ''} ${info?.doc?.content?.summary ?? ''}`, search)
  }).sort((a, b) => {
    const da = docsByGate[a.id]?.doc
    const db = docsByGate[b.id]?.doc
    if (focusDoc) {
      if (da?.id === focusDoc) return -1
      if (db?.id === focusDoc) return 1
    }
    if (da?.type === 'HLD' && db?.type !== 'HLD') return -1
    if (db?.type === 'HLD' && da?.type !== 'HLD') return 1
    return 0
  })

  const visiblePending = visibleGates.filter((g) => g.status === 'pending')
  const selectedVisible = visiblePending.filter((g) => selected.has(g.id)).length

  const hldGates = visibleGates.filter((g) => docsByGate[g.id]?.doc?.type === 'HLD')
  const lldGates = visibleGates.filter((g) => docsByGate[g.id]?.doc?.type === 'LLD')
  const otherGates = visibleGates.filter((g) => {
    const t = docsByGate[g.id]?.doc?.type
    return t && t !== 'HLD' && t !== 'LLD'
  })

  async function rewriteComponent(e) {
    e.preventDefault()
    if (!rewriteId || !rewriteText.trim()) return
    const { error: err } = await supabase.from('components').update({ description: rewriteText.trim() }).eq('id', rewriteId)
    if (err) return setError(err.message)
    setRewriteText('')
    toast.success('Description saved. If the model wrote it, the origin is now edited.')
    load()
  }

  async function addArchitectComponent(docId) {
    const name = window.prompt('Component name you are adding yourself')
    if (!name?.trim()) return
    const { data: key, error: keyErr } = await supabase.rpc('next_component_key', { p_project_id: projectId })
    if (keyErr) return setError(keyErr.message)
    const { data: row, error: err } = await supabase.from('components').insert({
      project_id: projectId,
      hld_document_id: docId,
      name: name.trim(),
      description: 'Written by the architect.',
      family_key: key,
      needs_detail: false,
    }).select().single()
    if (err) return setError(err.message)
    await supabase.from('design_provenance').insert({
      project_id: projectId,
      design_document_id: docId,
      element_key: row.family_key,
      element_label: row.name,
      origin: 'architect',
    })
    toast.success('Component added as written by you.')
    load()
  }

  function gateTitle(info) {
    if (!info?.doc) return 'Review item'
    if (info.doc.type === 'HLD') return `System map · HLD v${info.doc.version}`
    return `${info.componentName ?? 'Component'} · LLD v${info.doc.version}`
  }

  function renderGate(g, opts = {}) {
    const info = docsByGate[g.id]
    const blocked = ((info?.uncitedCount ?? 0) > 0 && !info?.doc?.nfr_override) || (info?.unwalkedScenarios?.length ?? 0) > 0 || (info?.ruleBreaks?.length ?? 0) > 0
    return (
      <div key={g.id} className={focusDoc && info?.doc?.id === focusDoc ? 'card gate-focus' : 'card'}>
        <div className="row between wrap" style={{ alignItems: 'flex-start' }}>
          <div className="row" style={{ alignItems: 'flex-start', gap: 10, minWidth: 0, flex: 1 }}>
            {g.status === 'pending' && (
              <input
                type="checkbox"
                style={{ width: 'auto', marginTop: 6 }}
                checked={selected.has(g.id)}
                onChange={() => toggleSelect(g.id)}
                aria-label={`Include ${gateTitle(info)} in batch`}
              />
            )}
            <div style={{ minWidth: 0 }}>
              {opts.now && <span className="doc-kicker">Do this now</span>}
              <h2 className="doc-title">{gateTitle(info)}</h2>
              <div className="row wrap" style={{ marginTop: 6 }}>
                <span className={`badge ${g.status === 'approved' ? 'ok' : g.status === 'rejected' ? 'danger' : 'muted'}`}>{g.status}</span>
                {blocked && info.uncitedCount > 0 && !info.doc.nfr_override && <span className="badge danger">{info.uncitedCount} quality rules not attached — Approve is disabled</span>}
                {(info?.unwalkedScenarios?.length ?? 0) > 0 && <span className="badge danger">{info.unwalkedScenarios.length} workshop scenario(s) unwalked — not a score</span>}
                {(info?.ruleBreaks?.length ?? 0) > 0 && <span className="badge danger">{info.ruleBreaks.length} option(s) break a standing rule</span>}
              </div>
            </div>
          </div>
        </div>

        {info && (
          <div style={{ marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
            {info.doc.content?.summary && <p style={{ marginTop: 0 }}>{info.doc.content.summary}</p>}
            {info.doc.type === 'HLD' && info.components.length > 0 && (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 6 }}>
                <thead>
                  <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}>
                    <th style={{ padding: 4 }}>Component</th>
                    <th style={{ padding: 4 }}>Description</th>
                    <th style={{ padding: 4 }}>Who wrote it</th>
                  </tr>
                </thead>
                <tbody>
                  {info.components.map((c) => {
                    const origin = (info.provenance || []).find((p) => p.element_key === c.family_key)
                    return (
                      <tr key={c.id} style={{ borderBottom: '1px solid var(--border)' }}>
                        <td style={{ padding: 4 }}>{c.name}</td>
                        <td style={{ padding: 4 }} className="muted">{c.description}</td>
                        <td style={{ padding: 4 }}>{origin ? originLabel(origin.origin) : 'not recorded'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
            {(info?.ruleBreaks?.length ?? 0) > 0 && (
              <ul>
                {info.ruleBreaks.map((v) => (
                  <li key={v.id}><span className="badge danger">breaks</span> {v.standing_rules?.rule_text}: {v.reason}</li>
                ))}
              </ul>
            )}
            {info?.doc?.type === 'HLD' && (
              <details style={{ marginTop: 8 }}>
                <summary className="muted">Change who a component is attributed to</summary>
                <form onSubmit={rewriteComponent} className="row wrap" style={{ marginTop: 8 }}>
                  <select value={rewriteId} onChange={(e) => setRewriteId(e.target.value)}>
                    <option value="">— component —</option>
                    {info.components.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                  <input placeholder="New description" value={rewriteText} onChange={(e) => setRewriteText(e.target.value)} />
                  <button type="submit" className="secondary">Save edit</button>
                </form>
                <button type="button" className="secondary" style={{ marginTop: 8 }} onClick={() => addArchitectComponent(info.doc.id)}>Add a component I wrote</button>
              </details>
            )}
            {info.doc.type === 'LLD' && (
              <div className="card" style={{ background: 'transparent', margin: '0 0 10px' }}>
                <p className="doc-kicker" style={{ marginTop: 0 }}>What to do on this LLD</p>
                <p style={{ margin: '0 0 8px' }}>
                  This is one component under the HLD, not the whole product. You do <strong>not</strong> need to Approve it to finish MoodFlow.
                  Skip it unless you want to lock this component’s internals.
                </p>
                <p className="muted" style={{ margin: 0 }}>
                  If you do review it: read the summary, open interfaces, then attach the quality rules that belong to <em>this</em> component (privacy, offline, encryption) or leave the card pending.
                </p>
              </div>
            )}
            {info.doc.type === 'LLD' && (
              <details>
                <summary className="muted">Interfaces and data model</summary>
                {info.doc.content?.interfaces?.length > 0 && (
                  <ul style={{ margin: 0 }}>
                    {info.doc.content.interfaces.map((iface, i) => <li key={i} className="muted" style={{ fontSize: 13 }}>{iface}</li>)}
                  </ul>
                )}
                {info.doc.content?.data_model && (
                  <p className="muted" style={{ fontSize: 13, marginTop: 6 }}>{info.doc.content.data_model}</p>
                )}
              </details>
            )}
          </div>
        )}

        {g.status === 'pending' && (
          <div style={{ marginTop: 8 }}>
            {blocked && (
              <div style={{ marginBottom: 10 }}>
                <NfrAttachPanel
                  projectId={projectId}
                  documentId={info.doc.id}
                  uncitedNfrs={info.uncitedList ?? []}
                  onDone={load}
                  context={{
                    type: info.doc.type,
                    version: info.doc.version,
                    componentName: info.componentName,
                    components: info.components ?? [],
                  }}
                />
                {info.decisionCount === 0 && (
                  <p className="muted">
                    No decisions on this LLD yet — add them above, or{' '}
                    <button type="button" className="secondary" onClick={() => unblockNfrs([info.doc.id])}>
                      record an explicit NFR override
                    </button>
                    {' '}if this component truly has nothing to cite.
                  </p>
                )}
              </div>
            )}
            <textarea
              placeholder="Comment (required for request-changes)"
              value={comment[g.id] ?? ''}
              onChange={(e) => setComment({ ...comment, [g.id]: e.target.value })}
              rows={2}
            />
            <div className="row" style={{ marginTop: 8 }}>
              <button onClick={() => decide(g, 'approve')} disabled={blocked}>Approve</button>
              <button className="secondary" onClick={() => decide(g, 'request_changes')}>Request changes</button>
              <button className="danger" onClick={() => decide(g, 'reject')}>Reject</button>
            </div>
          </div>
        )}
        {g.status !== 'pending' && <p className="muted">{g.comment}</p>}
      </div>
    )
  }

  return (
    <div>
      <h1>Review Queue</h1>
      <LoopSteps current="review" projectId={projectId} paths={{ requirements: '..', design: '../design', review: '.', package: '../package' }} />
      <div className="card work-panel">
        <span className="doc-kicker">Review</span>
        <h2 className="doc-title">Decide on the system map, then components</h2>
        <p>
          <strong>Approve</strong> when the split is good enough to become official.
          <strong> Request changes</strong> when it should be rewritten — that needs a comment saying what to change.
          <strong> Reject</strong> when this generate should not be used.
        </p>
        <p className="muted">
          Quality rules must be attached before Approve will stick. In-workshop scenarios must have a component walk. An option that breaks a standing rule blocks Approve until it is rewritten or the rule is replaced. Model-assigned risk does not require a spike until you confirm it on the ADR ledger. Nothing here auto-approves. After the map and the component designs are both approved, Diagram / Traceability is the next page.
        </p>
        <div className="card" style={{ margin: '10px 0 0', background: 'transparent' }}>
          <p className="doc-kicker" style={{ marginTop: 0 }}>Workshop (not a score)</p>
          <p style={{ margin: 0 }}>
            Approve still does not grade the architecture. If scenarios are marked in the workshop, they must be walked through HLD components (or the selected candidate). Sensitivity and trade-off points stay findings.
          </p>
        </div>
        <div className="row wrap">
          <button type="button" onClick={unblockHld}>Attach HLD quality rules</button>
          <button type="button" onClick={approvePinnedHld}>Approve the HLD</button>
          <button
            type="button"
            className="secondary"
            onClick={() => unblockNfrs(lldGates.map((g) => docsByGate[g.id]?.doc?.id).filter(Boolean))}
          >
            Attach LLD quality rules
          </button>
          <button type="button" className="secondary" onClick={approveVisibleLlds} disabled={busy}>Approve pending LLDs</button>
        </div>
      </div>
      <ListToolbar search={search} onSearch={setSearch} placeholder="Search phase or document…">
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="pending">Pending</option>
          <option value="decided">Decided</option>
          <option value="all">All</option>
        </select>
        <label className="muted row" style={{ gap: 6, width: 'auto' }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={showOlder} onChange={(e) => setShowOlder(e.target.checked)} />
          Show older generates
        </label>
      </ListToolbar>
      {error && <ErrorBanner error={error} />}
      {loading && <PageLoading />}

      {batchResults && (
        <div className="card" style={{ borderColor: failedCount ? 'var(--warn)' : 'var(--ok)' }}>
          <div className="row between">
            <strong>Batch result: {batchResults.length - failedCount} succeeded, {failedCount} failed</strong>
            <button className="secondary" onClick={() => setBatchResults(null)}>Dismiss</button>
          </div>
          <ul style={{ marginTop: 8 }}>
            {batchResults.map((r, i) => (
              <li key={i} className={r.ok ? 'muted' : ''}>
                <strong>{r.gate.phase}</strong>{' '}
                {r.ok ? <span className="badge ok">done</span> : <span className="badge danger">{humanizeError(r.message).headline}</span>}
              </li>
            ))}
          </ul>
          {failedCount > 0 && <p className="muted">Failed items are unchanged and still pending — fix what the message says, then retry them individually or in another batch.</p>}
        </div>
      )}

      {visiblePending.length > 0 && (
        <details className="card">
          <summary>Advanced: batch several pending gates</summary>
          <p className="muted">
            Tick the checkbox on each card you want (HLD and/or LLDs below), then run a batch action.
            Select all only fills every tick on this list — use Clear and tick a few instead.
          </p>
          <div className="row wrap">
            <span className="muted">{selectedVisible} of {visiblePending.length} on this list selected</span>
            <button type="button" className="secondary" onClick={selectHldOnly}>Select HLD only</button>
            <button type="button" className="secondary" onClick={selectAllPending}>Select all on this list</button>
            {selected.size > 0 && <button type="button" className="secondary" onClick={clearSelection}>Clear</button>}
          </div>
          <textarea
            placeholder="Batch comment (required for request-changes)"
            value={batchComment}
            onChange={(e) => setBatchComment(e.target.value)}
            rows={2}
            style={{ marginTop: 8 }}
          />
          <div className="row" style={{ marginTop: 8 }}>
            <button onClick={() => decideBatch('approve')} disabled={busy || !selected.size}>Approve selected</button>
            <button className="secondary" onClick={() => decideBatch('request_changes')} disabled={busy || !selected.size}>Request changes on selected</button>
            <button className="danger" onClick={() => decideBatch('reject')} disabled={busy || !selected.size}>Reject selected</button>
          </div>
        </details>
      )}

      {pinnedHldGate && !hldGates.some((g) => g.id === pinnedHldGate.id) && renderGate(pinnedHldGate, { now: true })}
      {hldGates.map((g) => renderGate(g, { now: true }))}
      {lldGates.length > 0 && (
        <details>
          <summary className="doc-kicker">
            {lldGates.length} component designs (LLD) — do steps 3 and 4 after the HLD is approved
          </summary>
          <p className="muted" style={{ margin: '8px 0' }}>
            Batch approve failed because these LLDs have no decisions to cite.{' '}
            <button
              type="button"
              className="secondary"
              onClick={() => unblockNfrs(lldGates.map((g) => docsByGate[g.id]?.doc?.id).filter(Boolean))}
            >
              Record NFR override on all listed LLDs
            </button>
          </p>
          {lldGates.map((g) => renderGate(g))}
        </details>
      )}
      {otherGates.map((g) => renderGate(g))}
      {!visibleGates.length && !loading && <p className="muted">Nothing pending in the current generate.</p>}
    </div>
  )
}