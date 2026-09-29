import { useEffect, useState } from 'react'
import { supabase, callFunction } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth.jsx'
import ListToolbar from './ListToolbar.jsx'
import ConfirmDialog from './ConfirmDialog.jsx'
import ErrorBanner from './ErrorBanner.jsx'
import PageLoading from './PageLoading.jsx'
import { matchesQuery } from '../lib/text.js'
import { useToast } from '../hooks/useToast.jsx'
import ChangeAssist from './assist/ChangeAssist.jsx'

export default function ChangesTab({ projectId }) {
  const { user } = useAuth()
  const toast = useToast()
  const [tab, setTab] = useState('change_requests')
  const [changeRequests, setChangeRequests] = useState([])
  const [signals, setSignals] = useState([])
  const [requirements, setRequirements] = useState([])
  const [docs, setDocs] = useState([])
  const [error, setError] = useState(null)
  const [busyId, setBusyId] = useState(null)
  const [reconResult, setReconResult] = useState(null)
  const [triageHistory, setTriageHistory] = useState([])

  const [crForm, setCrForm] = useState({ description: '', action: 'add', target_requirement_id: '', proposed_text: '', claimed_ending: '', labels: '' })
  const [crVerdicts, setCrVerdicts] = useState({})
  const [sigForm, setSigForm] = useState({ description: '', raised_against_artifact_id: '' })
  const [codeArtifacts, setCodeArtifacts] = useState([])
  const [crStatus, setCrStatus] = useState('open')
  const [crSearch, setCrSearch] = useState('')
  const [sigSearch, setSigSearch] = useState('')
  const [gapTarget, setGapTarget] = useState(null)
  const [gapReqId, setGapReqId] = useState('')
  const [gapSearch, setGapSearch] = useState('')
  const [fixTarget, setFixTarget] = useState(null)
  const [fixText, setFixText] = useState('')
  const [loading, setLoading] = useState(true)

  async function loadAll() {
    try {
    const { data: crs } = await supabase.from('change_requests').select('*').eq('project_id', projectId).order('created_at', { ascending: false })
    setChangeRequests(crs ?? [])
    const ids = (crs ?? []).map((c) => c.id)
    if (ids.length) {
      const { data: v } = await supabase.from('rule_verdicts').select('id, change_request_id, result, reason').in('change_request_id', ids)
      const grouped = {}
      for (const row of v ?? []) {
        grouped[row.change_request_id] = grouped[row.change_request_id] || []
        grouped[row.change_request_id].push(row)
      }
      setCrVerdicts(grouped)
    } else {
      setCrVerdicts({})
    }
    const { data: sigs } = await supabase.from('signals').select('*').eq('project_id', projectId).order('created_at', { ascending: false })
    setSignals(sigs ?? [])
    const { data: reqs } = await supabase
      .from('requirements')
      .select('id, ref_code, title, requirement_set_id, requirement_sets!inner(project_id)')
      .eq('requirement_sets.project_id', projectId)
    setRequirements(reqs ?? [])
    const { data: dd } = await supabase
      .from('design_documents')
      .select('id, type, version, status, requirement_sets!inner(project_id)')
      .eq('requirement_sets.project_id', projectId)
      .order('version', { ascending: false })
    setDocs(dd ?? [])

    const { data: arts } = await supabase.from('code_artifacts').select('id, path').eq('project_id', projectId).eq('type', 'file').order('path')
    setCodeArtifacts(arts ?? [])

    // Triage history (FR-7.4): persisted view, not just the one-off card shown right after reconvergence.
    const crIds = (crs ?? []).map((c) => c.id)
    const sigIds = (sigs ?? []).map((s) => s.id)
    const triageRows = []
    if (crIds.length) {
      const { data } = await supabase.from('triage_decisions').select('*').in('change_request_id', crIds)
      triageRows.push(...(data ?? []).map((t) => ({ ...t, source: 'change_request', sourceDescription: crs.find((c) => c.id === t.change_request_id)?.description })))
    }
    if (sigIds.length) {
      const { data } = await supabase.from('triage_decisions').select('*').in('signal_id', sigIds)
      triageRows.push(...(data ?? []).map((t) => ({ ...t, source: 'signal', sourceDescription: sigs.find((s) => s.id === t.signal_id)?.description })))
    }
    triageRows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    setTriageHistory(triageRows)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { loadAll() }, [projectId])

  // ---- Door 1: stakeholder-requested change ----
  async function submitChangeRequest(e) {
    e.preventDefault()
    setError(null)
    const { error } = await supabase.from('change_requests').insert({
      project_id: projectId,
      requested_by: user.id,
      description: crForm.description,
      action: crForm.action,
      target_requirement_id: crForm.action === 'add' ? null : crForm.target_requirement_id || null,
      proposed_text: crForm.proposed_text,
      claimed_ending: crForm.claimed_ending || null,
      covers: {
        component_ids: [],
        artifact_ids: [],
        paths: [],
        config_keys: [],
        labels: crForm.labels.split(',').map((s) => s.trim()).filter((s) => s.length >= 3),
      },
    })
    if (error) return setError(error.message)
    setCrForm({ description: '', action: 'add', target_requirement_id: '', proposed_text: '', claimed_ending: '', labels: '' })
    loadAll()
  }

  async function scopeChangeRequest(cr) {
    const { error } = await supabase.from('change_requests').update({ status: 'scoped' }).eq('id', cr.id)
    if (error) setError(error.message)
    else loadAll()
  }

  async function reconvergeCR(cr) {
    if (!cr.target_requirement_id) { setError('This change request has no target requirement to scope from (action=add has none yet).'); return }
    setBusyId(cr.id)
    setError(null)
    try {
      const res = await callFunction('reconverge-change', {
        change_request_id: cr.id,
        requirement_id: cr.target_requirement_id,
        project_id: projectId,
      })
      setReconResult(res)
      loadAll()
    } catch (e) { setError(e.message) } finally { setBusyId(null) }
  }

  async function resolveCR(cr) {
    setBusyId(cr.id)
    setError(null)
    try {
      const res = await callFunction('apply-requirement-change', { change_request_id: cr.id })
      if (res.already_resolved) {
        toast.info('This change request was already resolved.')
      } else if (res.recovery) {
        setError(`Generation succeeded but linking it back to the change failed: ${res.resolve_error}. Nothing was lost — try Apply & regenerate again; it will reuse the generated version rather than duplicating it.`)
      } else {
        toast.success(`Applied. RequirementSet v${res.new_requirement_set.version} is generated and design docs were regenerated.`)
      }
      loadAll()
    } catch (e) { setError(e.message) } finally { setBusyId(null) }
  }

  // ---- Door 2: found during build/after delivery ----
  async function submitSignal(e) {
    e.preventDefault()
    setError(null)
    const { error } = await supabase.from('signals').insert({
      project_id: projectId,
      raised_by: user.id,
      description: sigForm.description,
      raised_against_artifact_id: sigForm.raised_against_artifact_id || null,
    })
    if (error) return setError(error.message)
    setSigForm({ description: '', raised_against_artifact_id: '' })
    loadAll()
  }

  async function classifySignal(sig, classification) {
    if (classification === 'requirement_gap') {
      setGapTarget(sig)
      setGapReqId('')
      setGapSearch('')
      return
    }
    const { error } = await supabase.from('signals').update({ classification, routed_to_requirement_id: null }).eq('id', sig.id)
    if (error) setError(error.message)
    else loadAll()
  }

  async function confirmGap() {
    if (!gapTarget || !gapReqId) return
    const { error } = await supabase.from('signals').update({ classification: 'requirement_gap', routed_to_requirement_id: gapReqId }).eq('id', gapTarget.id)
    if (error) setError(error.message)
    else { setGapTarget(null); loadAll() }
  }

  async function reconvergeSignal(sig) {
    if (sig.classification !== 'requirement_gap' || !sig.routed_to_requirement_id) {
      setError('Only requirement_gap signals with a routed requirement proceed into the shared flow.')
      return
    }
    setBusyId(sig.id)
    setError(null)
    try {
      const res = await callFunction('reconverge-change', {
        signal_id: sig.id,
        requirement_id: sig.routed_to_requirement_id,
        project_id: projectId,
      })
      setReconResult(res)
      loadAll()
    } catch (e) { setError(e.message) } finally { setBusyId(null) }
  }

  async function applySignalFix(sig) {
    setFixTarget(sig)
    setFixText('')
  }

  async function confirmFix() {
    if (!fixTarget || !fixText.trim()) return
    setBusyId(fixTarget.id)
    setError(null)
    try {
      const res = await callFunction('apply-requirement-change', { signal_id: fixTarget.id, proposed_text: fixText.trim() })
      if (res.already_resolved) {
        setError('This signal was already resolved by a prior call.')
      } else if (res.recovery) {
        setError(`Generation succeeded but linking it back to the signal failed: ${res.resolve_error}. Nothing was lost — try again; it will reuse the generated version rather than duplicating it.`)
      }
      setFixTarget(null)
      loadAll()
    } catch (e) { setError(e.message) } finally { setBusyId(null) }
  }

  async function rejectCR(cr) {
    const { error } = await supabase.from('change_requests').update({ status: 'rejected' }).eq('id', cr.id)
    if (error) setError(error.message)
    else loadAll()
  }

  return (
    <div>
      <h1>Changes & Signals</h1>
      <div className="grid-2" style={{ marginBottom: 16 }}>
        <div className="card">
          <span className="doc-kicker">Door 1</span>
          <h2 className="doc-title">From the requirements team</h2>
          <p className="muted">Business, product, or whoever owns the SRS asks for an add/modify/remove. This never edits a locked set in place.</p>
        </div>
        <div className="card">
          <span className="doc-kicker">Door 2</span>
          <h2 className="doc-title">Found later</h2>
          <p className="muted">Something discovered in implementation, live testing, deployment, or operations. Classify as a defect or a requirement gap.</p>
        </div>
      </div>
      <p className="muted">Both doors join one downstream flow: impact scope → triage → route to owners → regenerate a new requirement-set version.</p>
      <ChangeAssist
        projectId={projectId}
        requirementId={crForm.target_requirement_id || null}
        description={crForm.description || sigForm.description}
      />
      {error && <ErrorBanner error={error} />}
      {loading && <PageLoading />}

      {reconResult && (
        <div className="card">
          <div className="row between"><h2>Reconvergence result</h2><button className="secondary" onClick={() => setReconResult(null)}>Dismiss</button></div>
          <p><strong>Triage:</strong> {reconResult.triage?.requires_full_review ? 'Full review required' : 'Fast-track'} — {reconResult.triage?.reasoning}</p>
          <p><strong>Flagged documents:</strong> {reconResult.flagged_document_ids?.length ?? 0}</p>
          {reconResult.routing?.unowned_component_ids?.length > 0 && (
            <p className="badge warn">{reconResult.routing.unowned_component_ids.length} component(s) unowned — flagged, not silently unrouted</p>
          )}
        </div>
      )}

      <div className="tabs">
        <button className={tab === 'change_requests' ? 'active' : ''} onClick={() => setTab('change_requests')}>Door 1: Change Requests</button>
        <button className={tab === 'signals' ? 'active' : ''} onClick={() => setTab('signals')}>Door 2: Signals</button>
      </div>

      {tab === 'change_requests' && (
        <>
          <form onSubmit={submitChangeRequest} className="card">
            <h3>New change request</h3>
            <textarea placeholder="Description" value={crForm.description} onChange={(e) => setCrForm({ ...crForm, description: e.target.value })} required rows={2} />
            <div className="grid-2" style={{ marginTop: 8 }}>
              <select value={crForm.action} onChange={(e) => setCrForm({ ...crForm, action: e.target.value })}>
                <option value="add">add</option>
                <option value="modify">modify</option>
                <option value="remove">remove</option>
              </select>
              <select value={crForm.target_requirement_id} onChange={(e) => setCrForm({ ...crForm, target_requirement_id: e.target.value })} disabled={crForm.action === 'add'}>
                <option value="">— target requirement —</option>
                {requirements.map((r) => <option key={r.id} value={r.id}>{r.ref_code}: {r.title}</option>)}
              </select>
            </div>
            <textarea placeholder="Proposed text" value={crForm.proposed_text} onChange={(e) => setCrForm({ ...crForm, proposed_text: e.target.value })} rows={2} style={{ marginTop: 8 }} />
            <input placeholder="How this change ends a standing rule (the allowed ending, or the new one)" value={crForm.claimed_ending} onChange={(e) => setCrForm({ ...crForm, claimed_ending: e.target.value })} style={{ marginTop: 8 }} />
            <input placeholder="Labels it touches, comma separated (reservation table, transfer API)" value={crForm.labels} onChange={(e) => setCrForm({ ...crForm, labels: e.target.value })} style={{ marginTop: 8 }} />
            <div style={{ marginTop: 8 }}><button type="submit">Submit</button></div>
          </form>

          <ListToolbar search={crSearch} onSearch={setCrSearch} placeholder="Search change requests…">
            <select value={crStatus} onChange={(e) => setCrStatus(e.target.value)}>
              <option value="open">Open</option>
              <option value="all">All statuses</option>
              <option value="submitted">submitted</option>
              <option value="scoped">scoped</option>
              <option value="triaged">triaged</option>
              <option value="resolved">resolved</option>
              <option value="rejected">rejected</option>
            </select>
          </ListToolbar>

          {changeRequests.filter((cr) => {
            const open = !['resolved', 'rejected'].includes(cr.status)
            if (crStatus === 'open' && !open) return false
            if (crStatus !== 'open' && crStatus !== 'all' && cr.status !== crStatus) return false
            return matchesQuery(`${cr.action} ${cr.description} ${cr.status}`, crSearch)
          }).map((cr) => (
            <div key={cr.id} className="card">
              <div className="row between">
                <strong>{cr.action}</strong>
                <span className="badge muted">{cr.status}</span>
              </div>
              <p>{cr.description}</p>
              {cr.claimed_ending && <p className="muted">Claimed ending: {cr.claimed_ending}</p>}
              {(crVerdicts[cr.id] || []).map((v) => (
                <p key={v.id}><span className={`badge ${v.result === 'holds' ? 'ok' : v.result === 'breaks' ? 'danger' : 'warn'}`}>{v.result}</span> {v.reason}</p>
              ))}
              <div className="row">
                {cr.status === 'submitted' && <button className="secondary" onClick={() => scopeChangeRequest(cr)}>Mark scoped</button>}
                {cr.status === 'scoped' && cr.action === 'add' && (
                  <button onClick={() => resolveCR(cr)} disabled={busyId === cr.id}>Apply & regenerate (no existing requirement to scope from)</button>
                )}
                {cr.status === 'scoped' && cr.action !== 'add' && (
                  <button onClick={() => reconvergeCR(cr)} disabled={busyId === cr.id}>Run reconvergence</button>
                )}
                {cr.status === 'triaged' && <button onClick={() => resolveCR(cr)} disabled={busyId === cr.id}>Apply & regenerate</button>}
                {['submitted', 'scoped'].includes(cr.status) && <button className="secondary" onClick={() => rejectCR(cr)}>Cancel</button>}
              </div>
            </div>
          ))}
        </>
      )}

      {tab === 'signals' && (
        <>
          <form onSubmit={submitSignal} className="card">
            <h3>New signal (found during build / after delivery)</h3>
            <textarea placeholder="What was found?" value={sigForm.description} onChange={(e) => setSigForm({ ...sigForm, description: e.target.value })} required rows={2} />
            <select
              style={{ marginTop: 8 }}
              value={sigForm.raised_against_artifact_id}
              onChange={(e) => setSigForm({ ...sigForm, raised_against_artifact_id: e.target.value })}
            >
              <option value="">— which artifact (optional) —</option>
              {codeArtifacts.map((a) => <option key={a.id} value={a.id}>{a.path}</option>)}
            </select>
            <div style={{ marginTop: 8 }}><button type="submit">Submit</button></div>
          </form>

          <ListToolbar search={sigSearch} onSearch={setSigSearch} placeholder="Search signals…" />

          {signals.filter((s) => matchesQuery(`${s.description} ${s.classification ?? ''}`, sigSearch)).map((s) => (
            <div key={s.id} className="card">
              <div className="row between">
                <span>{s.description}</span>
                <span className="badge muted">{s.classification ?? 'unclassified'}</span>
              </div>
              {s.raised_against_artifact_id && (
                <p className="muted">Against: {codeArtifacts.find((a) => a.id === s.raised_against_artifact_id)?.path ?? s.raised_against_artifact_id}</p>
              )}
              <div className="row" style={{ marginTop: 8 }}>
                {!s.classification && (
                  <>
                    <button className="secondary" onClick={() => classifySignal(s, 'implementation_defect')}>Implementation defect</button>
                    <button className="secondary" onClick={() => classifySignal(s, 'requirement_gap')}>Requirement gap</button>
                  </>
                )}
                {s.classification === 'requirement_gap' && s.status === 'open' && (
                  <>
                    <button onClick={() => reconvergeSignal(s)} disabled={busyId === s.id}>Run reconvergence</button>
                    <button className="secondary" onClick={() => applySignalFix(s)} disabled={busyId === s.id}>Apply corrected requirement text</button>
                  </>
                )}
              </div>
            </div>
          ))}
        </>
      )}

      <h2 style={{ marginTop: 24 }}>Triage History</h2>
      <p className="muted">FR-7.4: persisted, not just the one-off card shown right after reconvergence.</p>
      {triageHistory.map((t) => (
        <div key={t.id} className="card">
          <div className="row between">
            <span className="muted">{t.source === 'change_request' ? 'Change request' : 'Signal'}: {t.sourceDescription}</span>
            <span className={`badge ${t.requires_full_review ? 'warn' : 'ok'}`}>{t.requires_full_review ? 'full review' : 'fast-track'}</span>
          </div>
          <p className="muted">{t.reasoning}</p>
          {t.triggering_factors?.length > 0 && (
            <ul>{t.triggering_factors.map((f, i) => <li key={i} className="muted">{f}</li>)}</ul>
          )}
          <span className="muted">{new Date(t.created_at).toLocaleString()}</span>
        </div>
      ))}
      {!triageHistory.length && <p className="muted">No triage decisions yet.</p>}

      {gapTarget && (
        <ConfirmDialog
          title="Route as a requirement gap"
          body="Pick the requirement this finding traces to."
          confirmLabel="Save routing"
          confirmDisabled={!gapReqId}
          onCancel={() => setGapTarget(null)}
          onConfirm={confirmGap}
        >
          <input
            placeholder="Filter requirements…"
            value={gapSearch}
            onChange={(e) => setGapSearch(e.target.value)}
            style={{ marginBottom: 8 }}
          />
          <select value={gapReqId} onChange={(e) => setGapReqId(e.target.value)} required>
            <option value="">— requirement —</option>
            {requirements.filter((r) => matchesQuery(`${r.ref_code} ${r.title}`, gapSearch)).map((r) => (
              <option key={r.id} value={r.id}>{r.ref_code}: {r.title}</option>
            ))}
          </select>
        </ConfirmDialog>
      )}

      {fixTarget && (
        <ConfirmDialog
          title="Apply corrected requirement text"
          body="This creates a new RequirementSet and regenerates design docs."
          confirmLabel="Apply"
          confirmDisabled={!fixText.trim()}
          onCancel={() => setFixTarget(null)}
          onConfirm={confirmFix}
        >
          <textarea rows={4} value={fixText} onChange={(e) => setFixText(e.target.value)} placeholder="Corrected requirement text" />
        </ConfirmDialog>
      )}
    </div>
  )
}
