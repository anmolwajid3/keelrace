import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import ListToolbar from './ListToolbar.jsx'
import ConfirmDialog from './ConfirmDialog.jsx'
import ErrorBanner from './ErrorBanner.jsx'
import PageLoading from './PageLoading.jsx'
import { IconPencil, IconTrash } from './Icons.jsx'
import { matchesQuery } from '../lib/text.js'

export default function NfrsRiskTab({ projectId }) {
  const [nfrs, setNfrs] = useState([])
  const [components, setComponents] = useState([])
  const [rationales, setRationales] = useState([])
  const [citations, setCitations] = useState({}) // nfr_id -> Set(decision_rationale_id)
  const [spikes, setSpikes] = useState({}) // decision_rationale_id -> [spike_records]
  const [conflicts, setConflicts] = useState([])
  const [error, setError] = useState(null)

  const [nfrForm, setNfrForm] = useState({ name: '', description: '', component_id: '' })
  const [conflictForm, setConflictForm] = useState({ nfr_a_id: '', nfr_b_id: '', description: '' })
  const [spikeSummary, setSpikeSummary] = useState({})
  const [search, setSearch] = useState('')
  const [citeFilter, setCiteFilter] = useState('all')
  const [editing, setEditing] = useState(null)
  const [pendingDelete, setPendingDelete] = useState(null)
  const [loading, setLoading] = useState(true)

  async function load() {
    try {
    const { data: n } = await supabase.from('nfrs').select('*').eq('project_id', projectId).order('name')
    setNfrs(n ?? [])

    const { data: comps } = await supabase.from('components').select('id, name').eq('project_id', projectId)
    setComponents(comps ?? [])

    const { data: drs } = await supabase
      .from('decision_rationales')
      .select('id, decision_point, risk_level, risk_set_by, design_documents!inner(requirement_sets!inner(project_id))')
      .eq('design_documents.requirement_sets.project_id', projectId)
    setRationales(drs ?? [])

    if (n?.length) {
      const { data: cites } = await supabase.from('nfr_citations').select('*').in('nfr_id', n.map((x) => x.id))
      const map = {}
      for (const c of cites ?? []) {
        map[c.nfr_id] = map[c.nfr_id] || new Set()
        map[c.nfr_id].add(c.decision_rationale_id)
      }
      setCitations(map)
    }

    const highRisk = (drs ?? []).filter((r) => r.risk_level === 'high' && r.risk_set_by === 'human')
    if (highRisk.length) {
      const { data: sp } = await supabase.from('spike_records').select('*').in('decision_rationale_id', highRisk.map((r) => r.id))
      const smap = {}
      for (const s of sp ?? []) {
        smap[s.decision_rationale_id] = smap[s.decision_rationale_id] || []
        smap[s.decision_rationale_id].push(s)
      }
      setSpikes(smap)
    }

    const { data: conf } = await supabase.from('nfr_conflicts').select('*, decision_rationales(decision_point)').eq('project_id', projectId)
    setConflicts(conf ?? [])
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [projectId])

  async function addNfr(e) {
    e.preventDefault()
    const { error } = await supabase.from('nfrs').insert({
      project_id: projectId,
      name: nfrForm.name,
      description: nfrForm.description,
      component_id: nfrForm.component_id || null,
    })
    if (error) setError(error.message)
    else { setNfrForm({ name: '', description: '', component_id: '' }); load() }
  }

  async function saveNfr(e) {
    e.preventDefault()
    if (!editing) return
    const { error } = await supabase.from('nfrs').update({
      name: editing.name,
      description: editing.description,
      component_id: editing.component_id || null,
    }).eq('id', editing.id)
    if (error) setError(error.message)
    else { setEditing(null); load() }
  }

  async function deleteNfr() {
    if (!pendingDelete) return
    const { error } = await supabase.from('nfrs').delete().eq('id', pendingDelete.id)
    if (error) setError(error.message)
    else { setPendingDelete(null); load() }
  }

  async function toggleCitation(nfr, dr) {
    const cited = citations[nfr.id]?.has(dr.id)
    const { error } = cited
      ? await supabase.from('nfr_citations').delete().eq('nfr_id', nfr.id).eq('decision_rationale_id', dr.id)
      : await supabase.from('nfr_citations').insert({ nfr_id: nfr.id, decision_rationale_id: dr.id })
    if (error) setError(error.message)
    else load()
  }

  async function addSpike(dr) {
    const summary = spikeSummary[dr.id]
    if (!summary) return
    const { error } = await supabase.from('spike_records').insert({ decision_rationale_id: dr.id, summary })
    if (error) setError(error.message)
    else { setSpikeSummary({ ...spikeSummary, [dr.id]: '' }); load() }
  }

  async function completeSpike(spike) {
    const { error } = await supabase.from('spike_records').update({ completed: true, completed_at: new Date().toISOString() }).eq('id', spike.id)
    if (error) setError(error.message)
    else load()
  }

  async function addConflict(e) {
    e.preventDefault()
    const { error } = await supabase.from('nfr_conflicts').insert({ project_id: projectId, ...conflictForm })
    if (error) setError(error.message)
    else { setConflictForm({ nfr_a_id: '', nfr_b_id: '', description: '' }); load() }
  }

  async function resolveConflict(conflict, decisionRationaleId) {
    if (!decisionRationaleId) return
    const { error } = await supabase.from('nfr_conflicts').update({ resolution_decision_rationale_id: decisionRationaleId }).eq('id', conflict.id)
    if (error) setError(error.message)
    else load()
  }

  const highRiskRationales = rationales.filter((r) => r.risk_level === 'high' && r.risk_set_by === 'human')
  const nfrName = (id) => nfrs.find((n) => n.id === id)?.name ?? id

  return (
    <div>
      <h1>NFRs & Risk</h1>
      <p className="muted">This is where FR-7.1 (NFR coverage), FR-7.2 (architect-set high-risk spikes), and FR-5.3 (NFR conflicts) — all enforced at approval time — actually get satisfied. A model-guessed risk_level does not open a spike gate.</p>
      {error && <ErrorBanner error={error} />}
      {loading && <PageLoading />}

      <h2>Non-Functional Requirements</h2>
      <p className="muted">FR-7.1, now scoped: a project-wide NFR must be cited before ANY document is approved; a component-scoped NFR only blocks approval of documents that actually involve that component.</p>
      <form onSubmit={addNfr} className="card">
        <div className="grid-2">
          <input placeholder="Name (e.g. Availability)" value={nfrForm.name} onChange={(e) => setNfrForm({ ...nfrForm, name: e.target.value })} required />
          <input placeholder="Description" value={nfrForm.description} onChange={(e) => setNfrForm({ ...nfrForm, description: e.target.value })} />
        </div>
        <select style={{ marginTop: 8 }} value={nfrForm.component_id} onChange={(e) => setNfrForm({ ...nfrForm, component_id: e.target.value })}>
          <option value="">Project-wide (applies to every document)</option>
          {components.map((c) => <option key={c.id} value={c.id}>Scoped to: {c.name}</option>)}
        </select>
        <div style={{ marginTop: 8 }}><button type="submit">Add NFR</button></div>
      </form>

      <ListToolbar search={search} onSearch={setSearch} placeholder="Search NFRs…">
        <select value={citeFilter} onChange={(e) => setCiteFilter(e.target.value)}>
          <option value="all">All coverage</option>
          <option value="cited">Cited</option>
          <option value="uncited">Uncited</option>
        </select>
      </ListToolbar>

      {nfrs.filter((n) => {
        const cited = (citations[n.id]?.size ?? 0) > 0
        if (citeFilter === 'cited' && !cited) return false
        if (citeFilter === 'uncited' && cited) return false
        return matchesQuery(`${n.name} ${n.description ?? ''}`, search)
      }).map((n) => (
        <div key={n.id} className="card">
          {editing?.id === n.id ? (
            <form onSubmit={saveNfr}>
              <div className="grid-2">
                <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} required />
                <input value={editing.description ?? ''} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
              </div>
              <select style={{ marginTop: 8 }} value={editing.component_id ?? ''} onChange={(e) => setEditing({ ...editing, component_id: e.target.value })}>
                <option value="">Project-wide</option>
                {components.map((c) => <option key={c.id} value={c.id}>Scoped to: {c.name}</option>)}
              </select>
              <div className="row" style={{ marginTop: 8 }}>
                <button type="submit">Save</button>
                <button type="button" className="secondary" onClick={() => setEditing(null)}>Cancel</button>
              </div>
            </form>
          ) : (
            <>
          <div className="row between">
            <div className="row wrap">
              <strong>{n.name}</strong>
              {n.component_id
                ? <span className="badge muted">scoped: {components.find((c) => c.id === n.component_id)?.name ?? n.component_id}</span>
                : <span className="badge warn">project-wide</span>}
            </div>
            <div className="row">
              <span className="muted">{citations[n.id]?.size ?? 0} decision(s) citing this</span>
              <button type="button" className="icon-btn" title="Edit" aria-label={`Edit ${n.name}`} onClick={() => setEditing({ ...n, component_id: n.component_id ?? '' })}><IconPencil /></button>
              <button type="button" className="icon-btn danger-icon" title="Delete" aria-label={`Delete ${n.name}`} onClick={() => setPendingDelete(n)}><IconTrash /></button>
            </div>
          </div>
          <p className="muted">{n.description}</p>
          <details>
            <summary className="muted">Cite from a decision</summary>
            <div style={{ marginTop: 8 }}>
              {rationales.map((dr) => (
                <label key={dr.id} className="row muted" style={{ gap: 6 }}>
                  <input type="checkbox" style={{ width: 'auto' }} checked={!!citations[n.id]?.has(dr.id)} onChange={() => toggleCitation(n, dr)} />
                  {dr.decision_point}
                </label>
              ))}
              {!rationales.length && <p className="muted">No decisions yet.</p>}
            </div>
          </details>
            </>
          )}
        </div>
      ))}
      {!nfrs.length && <p className="muted">No NFRs defined yet — approval will treat "no NFRs" as trivially satisfied.</p>}

      <h2 style={{ marginTop: 24 }}>High-Risk Decisions & Spikes</h2>
      {highRiskRationales.map((dr) => {
        const drSpikes = spikes[dr.id] ?? []
        const hasCompleted = drSpikes.some((s) => s.completed)
        return (
          <div key={dr.id} className="card">
            <div className="row between">
              <strong>{dr.decision_point}</strong>
              <span className={`badge ${hasCompleted ? 'ok' : 'danger'}`}>{hasCompleted ? 'spike completed' : 'blocks approval'}</span>
            </div>
            {drSpikes.map((s) => (
              <div key={s.id} className="row between" style={{ marginTop: 6 }}>
                <span className="muted">{s.summary}</span>
                {!s.completed
                  ? <button className="secondary" onClick={() => completeSpike(s)}>Mark complete</button>
                  : <span className="badge ok">completed</span>}
              </div>
            ))}
            <div className="row" style={{ marginTop: 8 }}>
              <input placeholder="New spike summary" value={spikeSummary[dr.id] ?? ''} onChange={(e) => setSpikeSummary({ ...spikeSummary, [dr.id]: e.target.value })} />
              <button className="secondary" onClick={() => addSpike(dr)}>Add spike</button>
            </div>
          </div>
        )
      })}
      {!highRiskRationales.length && <p className="muted">No architect-confirmed high-risk decisions currently. Model-assigned high risk is visible on the ADR ledger until you confirm it.</p>}

      <h2 style={{ marginTop: 24 }}>NFR Conflicts</h2>
      <form onSubmit={addConflict} className="card">
        <div className="grid-2">
          <select value={conflictForm.nfr_a_id} onChange={(e) => setConflictForm({ ...conflictForm, nfr_a_id: e.target.value })} required>
            <option value="">— NFR A —</option>
            {nfrs.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
          </select>
          <select value={conflictForm.nfr_b_id} onChange={(e) => setConflictForm({ ...conflictForm, nfr_b_id: e.target.value })} required>
            <option value="">— NFR B —</option>
            {nfrs.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
          </select>
        </div>
        <textarea placeholder="Describe the conflict" style={{ marginTop: 8 }} value={conflictForm.description} onChange={(e) => setConflictForm({ ...conflictForm, description: e.target.value })} required />
        <div style={{ marginTop: 8 }}><button type="submit">Record conflict</button></div>
      </form>

      {conflicts.map((c) => (
        <div key={c.id} className="card">
          <div className="row between">
            <span>{nfrName(c.nfr_a_id)} vs {nfrName(c.nfr_b_id)}</span>
            <span className={`badge ${c.resolution_decision_rationale_id ? 'ok' : 'danger'}`}>{c.resolution_decision_rationale_id ? 'resolved' : 'unresolved — blocks approval'}</span>
          </div>
          <p className="muted">{c.description}</p>
          {!c.resolution_decision_rationale_id && (
            <select onChange={(e) => resolveConflict(c, e.target.value)} defaultValue="">
              <option value="" disabled>Resolve with decision…</option>
              {rationales.map((dr) => <option key={dr.id} value={dr.id}>{dr.decision_point}</option>)}
            </select>
          )}
          {c.resolution_decision_rationale_id && <p className="muted">Resolved by: {c.decision_rationales?.decision_point}</p>}
        </div>
      ))}

      {pendingDelete && (
        <ConfirmDialog
          title={`Delete NFR “${pendingDelete.name}”?`}
          body="Citations to this NFR will go with it. Approval coverage will be recomputed on the next review."
          confirmLabel="Delete NFR"
          danger
          onCancel={() => setPendingDelete(null)}
          onConfirm={deleteNfr}
        />
      )}
    </div>
  )
}
