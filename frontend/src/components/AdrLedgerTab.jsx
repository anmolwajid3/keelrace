import { useEffect, useMemo, useState } from 'react'
import { supabase, callFunction } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth.jsx'
import { useToast } from '../hooks/useToast.jsx'
import { matchesQuery } from '../lib/text.js'
import ConfirmDialog from './ConfirmDialog.jsx'
import ErrorBanner from './ErrorBanner.jsx'
import PageLoading from './PageLoading.jsx'
import AdrAssist from './assist/AdrAssist.jsx'
import StandingRulePanel from './StandingRulePanel.jsx'

export default function AdrLedgerTab({ projectId }) {
  const { user } = useAuth()
  const [rationales, setRationales] = useState([])
  const [docs, setDocs] = useState([])
  const [requirements, setRequirements] = useState([])
  const [components, setComponents] = useState([])
  const [search, setSearch] = useState('')
  const [riskFilter, setRiskFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [provisionalFor, setProvisionalFor] = useState(null)
  const [provForm, setProvForm] = useState({ metric: '', operator: '>', threshold: '' })
  const [revisitFor, setRevisitFor] = useState(null)
  const [revisitNote, setRevisitNote] = useState('')
  const toast = useToast()
  const [chatOpen, setChatOpen] = useState({})
  const [chatMessages, setChatMessages] = useState({})
  const [chatInput, setChatInput] = useState({})
  const [chatBusy, setChatBusy] = useState({})

  async function load() {
    try {
    let query = supabase
      .from('decision_rationales')
      .select('*, design_documents!inner(requirement_set_id, requirement_sets!inner(project_id))')
      .eq('design_documents.requirement_sets.project_id', projectId)
      .order('created_at', { ascending: false })
    const { data, error } = await query
    if (error) setError(error.message)
    else setRationales(data ?? [])

    const { data: dd } = await supabase
      .from('design_documents')
      .select('id, type, version, status, requirement_sets!inner(project_id)')
      .eq('requirement_sets.project_id', projectId)
      .order('version', { ascending: false })
    setDocs(dd ?? [])

    const { data: reqs } = await supabase
      .from('requirements')
      .select('id, ref_code, title, requirement_set_id, requirement_sets!inner(project_id)')
      .eq('requirement_sets.project_id', projectId)
    setRequirements(reqs ?? [])

    const { data: comps } = await supabase.from('components').select('id, name').eq('project_id', projectId)
    setComponents(comps ?? [])
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [projectId])

  const visible = useMemo(() => rationales.filter((dr) => {
    if (riskFilter !== 'all' && dr.risk_level !== riskFilter) return false
    if (statusFilter !== 'all' && dr.status !== statusFilter) return false
    return matchesQuery(`${dr.decision_point} ${dr.chosen_option} ${dr.searchable_text ?? ''}`, search)
  }), [rationales, search, riskFilter, statusFilter])

  async function updateRiskLevel(dr, level) {
    const { error } = await supabase.from('decision_rationales').update({ risk_level: level }).eq('id', dr.id)
    if (error) setError(error.message)
    else load()
  }

  async function confirmRisk(dr) {
    const { error } = await supabase.from('decision_rationales').update({ risk_set_by: 'human' }).eq('id', dr.id)
    if (error) setError(error.message)
    else load()
  }

  async function markProvisional() {
    if (!provisionalFor) return
    const { metric, operator, threshold } = provForm
    if (!metric.trim() || threshold === '') return
    const { error } = await supabase
      .from('decision_rationales')
      .update({
        status: 'provisional',
        revisit_condition: { metric: metric.trim(), operator, threshold: Number(threshold) || threshold },
      })
      .eq('id', provisionalFor.id)
    if (error) setError(error.message)
    else {
      setProvisionalFor(null)
      toast.success('Marked provisional with a revisit condition.')
      load()
    }
  }

  async function recordRevisit() {
    if (!revisitFor) return
    const { error } = await supabase.from('revisit_checks').insert({
      decision_rationale_id: revisitFor.dr.id,
      checked_by: user.id,
      condition_met: revisitFor.conditionMet,
      evidence_note: revisitNote.trim(),
    })
    if (error) setError(error.message)
    else {
      setRevisitFor(null)
      setRevisitNote('')
      toast.success('Revisit check recorded.')
    }
  }

  async function toggleChat(dr) {
    const opening = !chatOpen[dr.id]
    setChatOpen({ ...chatOpen, [dr.id]: opening })
    if (opening && !chatMessages[dr.id]) {
      const { data: thread } = await supabase.from('design_chat_threads').select('id').eq('decision_rationale_id', dr.id).maybeSingle()
      if (thread) {
        const { data: msgs } = await supabase.from('design_chat_messages').select('*').eq('thread_id', thread.id).order('created_at')
        setChatMessages({ ...chatMessages, [dr.id]: msgs ?? [] })
      } else {
        setChatMessages({ ...chatMessages, [dr.id]: [] })
      }
    }
  }

  async function askChat(dr) {
    const question = chatInput[dr.id]
    if (!question?.trim()) return
    setChatBusy({ ...chatBusy, [dr.id]: true })
    try {
      const res = await callFunction('design-chat', { decision_rationale_id: dr.id, question })
      setChatMessages({
        ...chatMessages,
        [dr.id]: [...(chatMessages[dr.id] ?? []), { role: 'user', content: question }, { role: 'assistant', content: res.answer }],
      })
      setChatInput({ ...chatInput, [dr.id]: '' })
    } catch (e) {
      setError(e.message)
    } finally {
      setChatBusy({ ...chatBusy, [dr.id]: false })
    }
  }

  return (
    <div>
      <h1>ADR Ledger</h1>

      <AdrAssist projectId={projectId} docs={docs} requirements={requirements} onRecorded={load} />
      <RecordDecisionForm docs={docs} requirements={requirements} components={components} setError={setError} onRecorded={load} />

      <div className="list-toolbar">
        <input placeholder="Search decisions…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select value={riskFilter} onChange={(e) => setRiskFilter(e.target.value)}>
          <option value="all">All risk</option>
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="all">All status</option>
          <option value="proposed">proposed</option>
          <option value="provisional">provisional</option>
          <option value="approved">approved</option>
          <option value="superseded">superseded</option>
        </select>
      </div>
      {error && <ErrorBanner error={error} />}
      {loading && <PageLoading />}
      {visible.map((dr) => (
        <div key={dr.id} className="card">
          <div className="row between">
            <div className="row">
              <strong>{dr.decision_point}</strong>
              <span className="badge muted">{dr.searchable_text?.startsWith('[manual]') ? 'manual entry' : 'generated'}</span>
            </div>
            <div className="row">
              <span className={`badge ${dr.risk_level === 'high' ? 'danger' : dr.risk_level === 'medium' ? 'warn' : 'muted'}`}>{dr.risk_level} risk</span>
              <span className="badge muted">{dr.risk_set_by === 'human' ? 'architect-set' : 'model guess'}</span>
              <select value={dr.risk_level} onChange={(e) => updateRiskLevel(dr, e.target.value)} style={{ width: 100, padding: '2px 4px', fontSize: 12 }}>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
              </select>
              {dr.risk_set_by !== 'human' && (
                <button type="button" className="secondary" onClick={() => confirmRisk(dr)}>Confirm risk</button>
              )}
              <span className="badge muted">{dr.status}</span>
            </div>
          </div>
          <p><strong>Chosen:</strong> {dr.chosen_option}</p>
          {dr.alternatives_considered?.length > 0 && (
            <details>
              <summary className="muted">Alternatives considered ({dr.alternatives_considered.length})</summary>
              <ul>
                {dr.alternatives_considered.map((a, i) => (
                  <li key={i}><strong>{a.option}</strong> — {a.rejection_reason}</li>
                ))}
              </ul>
            </details>
          )}
          <p className="muted">Cites {dr.driving_requirements?.length ?? 0} requirement(s)</p>
          {dr.status === 'approved' && (
            <button className="secondary" onClick={() => { setProvisionalFor(dr); setProvForm({ metric: '', operator: '>', threshold: '' }) }}>Mark provisional…</button>
          )}
          {dr.status === 'provisional' && (
            <div style={{ marginTop: 8 }}>
              <p className="muted">
                Revisit when {dr.revisit_condition?.metric} {dr.revisit_condition?.operator} {dr.revisit_condition?.threshold}
              </p>
              <div className="row">
                <button className="secondary" onClick={() => { setRevisitFor({ dr, conditionMet: true }); setRevisitNote('') }}>Mark condition met</button>
                <button className="secondary" onClick={() => { setRevisitFor({ dr, conditionMet: false }); setRevisitNote('') }}>Mark not yet met</button>
              </div>
            </div>
          )}

          <StandingRulePanel
            projectId={projectId}
            decision={dr}
            components={components}
            otherDecisions={rationales}
            onChanged={load}
          />

          <details style={{ marginTop: 8 }} open={!!chatOpen[dr.id]}>
            <summary className="muted" onClick={(e) => { e.preventDefault(); toggleChat(dr) }}>
              Ask about this decision (grounded only in it and its cited requirements)
            </summary>
            {chatOpen[dr.id] && (
              <div style={{ marginTop: 8 }}>
                {(chatMessages[dr.id] ?? []).map((m, i) => (
                  <p key={i} className={m.role === 'user' ? '' : 'muted'}>
                    <strong>{m.role === 'user' ? 'You' : 'KeelRace'}:</strong> {m.content}
                  </p>
                ))}
                <div className="row">
                  <input
                    placeholder="Why was this chosen over…?"
                    value={chatInput[dr.id] ?? ''}
                    onChange={(e) => setChatInput({ ...chatInput, [dr.id]: e.target.value })}
                    onKeyDown={(e) => e.key === 'Enter' && askChat(dr)}
                  />
                  <button className="secondary" onClick={() => askChat(dr)} disabled={chatBusy[dr.id]}>
                    {chatBusy[dr.id] ? 'Asking…' : 'Ask'}
                  </button>
                </div>
              </div>
            )}
          </details>
        </div>
      ))}
      {!visible.length && <p className="muted">{rationales.length ? 'No decisions match this search.' : 'No decisions recorded yet.'}</p>}
      {provisionalFor && (
        <ConfirmDialog
          title="Mark provisional"
          body={`Watch a metric for “${provisionalFor.decision_point}”. The decision stays in the ledger until the condition is checked.`}
          confirmLabel="Save condition"
          confirmDisabled={!provForm.metric.trim() || provForm.threshold === ''}
          onCancel={() => setProvisionalFor(null)}
          onConfirm={markProvisional}
        >
          <label className="muted">Metric</label>
          <input placeholder="e.g. p95 latency" value={provForm.metric} onChange={(e) => setProvForm({ ...provForm, metric: e.target.value })} />
          <label className="muted" style={{ marginTop: 8 }}>Operator</label>
          <select value={provForm.operator} onChange={(e) => setProvForm({ ...provForm, operator: e.target.value })}>
            {['>', '<', '>=', '<=', '=='].map((op) => <option key={op} value={op}>{op}</option>)}
          </select>
          <label className="muted" style={{ marginTop: 8 }}>Threshold</label>
          <input placeholder="Value" value={provForm.threshold} onChange={(e) => setProvForm({ ...provForm, threshold: e.target.value })} />
        </ConfirmDialog>
      )}
      {revisitFor && (
        <ConfirmDialog
          title={revisitFor.conditionMet ? 'Record condition met' : 'Record not yet met'}
          body="Add evidence so later reviewers can see why this check was recorded."
          confirmLabel="Record check"
          onCancel={() => setRevisitFor(null)}
          onConfirm={recordRevisit}
        >
          <label className="muted">Evidence note</label>
          <textarea rows={3} value={revisitNote} onChange={(e) => setRevisitNote(e.target.value)} placeholder="What did you observe?" />
        </ConfirmDialog>
      )}
    </div>
  )
}

// Decisions were previously LLM-only, created solely inside generate-design-docs.
// If a reviewer spots a real gap (an NFR nothing addresses, a choice nobody wrote
// down) they had no way to add one without a full regeneration. This is that path
// — same constraint the generated ones have to satisfy (cite >=1 requirement,
// enforced by a DB check), just filled in by a human instead of the LLM.
function RecordDecisionForm({ docs, requirements, components, setError, onRecorded }) {
  const [open, setOpen] = useState(false)
  const [designDocumentId, setDesignDocumentId] = useState('')
  const [decisionPoint, setDecisionPoint] = useState('')
  const [chosenOption, setChosenOption] = useState('')
  const [alternatives, setAlternatives] = useState([{ option: '', rejection_reason: '' }])
  const [drivingReqIds, setDrivingReqIds] = useState(new Set())
  const [riskLevel, setRiskLevel] = useState('low')
  const [componentId, setComponentId] = useState('')
  const [submitting, setSubmitting] = useState(false)

  function toggleReq(id) {
    const next = new Set(drivingReqIds)
    next.has(id) ? next.delete(id) : next.add(id)
    setDrivingReqIds(next)
  }

  function updateAlternative(i, field, value) {
    setAlternatives(alternatives.map((a, idx) => (idx === i ? { ...a, [field]: value } : a)))
  }
  function addAlternativeRow() {
    setAlternatives([...alternatives, { option: '', rejection_reason: '' }])
  }
  function removeAlternativeRow(i) {
    setAlternatives(alternatives.filter((_, idx) => idx !== i))
  }

  function reset() {
    setDesignDocumentId(''); setDecisionPoint(''); setChosenOption('')
    setAlternatives([{ option: '', rejection_reason: '' }])
    setDrivingReqIds(new Set()); setRiskLevel('low'); setComponentId('')
  }

  async function submit(e) {
    e.preventDefault()
    setError(null)
    if (!designDocumentId) return setError('Pick which document this decision belongs to.')
    if (drivingReqIds.size === 0) return setError('A decision must cite at least one requirement — that\'s a database constraint, not just a suggestion.')

    setSubmitting(true)
    const cleanAlternatives = alternatives.filter((a) => a.option.trim())

    const { error } = await supabase.from('decision_rationales').insert({
      design_document_id: designDocumentId,
      decision_point: decisionPoint,
      chosen_option: chosenOption,
      alternatives_considered: cleanAlternatives,
      driving_requirements: [...drivingReqIds],
      searchable_text: `[manual] ${decisionPoint} ${chosenOption}`,
      risk_level: riskLevel,
      risk_set_by: 'human',
      component_id: componentId || null,
    })
    setSubmitting(false)
    if (error) return setError(error.message)

    reset()
    setOpen(false)
    onRecorded()
  }

  return (
    <div className="card">
      <div className="row between">
        <h3 style={{ margin: 0 }}>Record a decision manually</h3>
        <button className="secondary" onClick={() => setOpen(!open)}>{open ? 'Cancel' : 'Add decision'}</button>
      </div>
      {!open && (
        <p className="muted" style={{ marginTop: 6 }}>
          For when you spot a real gap during review — a requirement or NFR nothing addresses — and want to
          record how it's actually handled without regenerating the whole document.
        </p>
      )}
      {open && (
        <form onSubmit={submit} style={{ marginTop: 12 }}>
          <select value={designDocumentId} onChange={(e) => setDesignDocumentId(e.target.value)} required style={{ marginBottom: 8 }}>
            <option value="">— which document is this decision part of? —</option>
            {docs.map((d) => <option key={d.id} value={d.id}>{d.type} v{d.version} ({d.status})</option>)}
          </select>

          <input placeholder="Decision point (e.g. 'How do we handle offline queueing?')" value={decisionPoint} onChange={(e) => setDecisionPoint(e.target.value)} required style={{ marginBottom: 8 }} />
          <input placeholder="Chosen option" value={chosenOption} onChange={(e) => setChosenOption(e.target.value)} required style={{ marginBottom: 8 }} />

          <p className="muted" style={{ marginBottom: 4 }}>Alternatives considered (optional)</p>
          {alternatives.map((a, i) => (
            <div key={i} className="row" style={{ marginBottom: 6 }}>
              <input placeholder="Option" value={a.option} onChange={(e) => updateAlternative(i, 'option', e.target.value)} />
              <input placeholder="Why rejected" value={a.rejection_reason} onChange={(e) => updateAlternative(i, 'rejection_reason', e.target.value)} />
              {alternatives.length > 1 && <button type="button" className="secondary" onClick={() => removeAlternativeRow(i)}>✕</button>}
            </div>
          ))}
          <button type="button" className="secondary" onClick={addAlternativeRow} style={{ marginBottom: 8 }}>+ another alternative</button>

          <p className="muted" style={{ marginBottom: 4, marginTop: 8 }}>
            Driving requirements — must select at least one (this is what makes it a real decision, not a floating opinion)
          </p>
          <div style={{ maxHeight: 160, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6, padding: 8, marginBottom: 8 }}>
            {requirements.map((r) => (
              <label key={r.id} className="row muted" style={{ gap: 6 }}>
                <input type="checkbox" style={{ width: 'auto' }} checked={drivingReqIds.has(r.id)} onChange={() => toggleReq(r.id)} />
                {r.ref_code}: {r.title}
              </label>
            ))}
            {!requirements.length && <p className="muted">No requirements in this project yet.</p>}
          </div>

          <div className="grid-2" style={{ marginBottom: 8 }}>
            <select value={riskLevel} onChange={(e) => setRiskLevel(e.target.value)}>
              <option value="low">low risk</option>
              <option value="medium">medium risk</option>
              <option value="high">high risk</option>
            </select>
            <select value={componentId} onChange={(e) => setComponentId(e.target.value)}>
              <option value="">No specific component</option>
              {components.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>

          <button type="submit" disabled={submitting}>{submitting ? 'Recording…' : 'Record decision'}</button>
        </form>
      )}
    </div>
  )
}