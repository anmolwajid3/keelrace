import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { callAssist } from '../../lib/assist.js'
import { useToast } from '../../hooks/useToast.jsx'
import ErrorBanner from '../ErrorBanner.jsx'
import { Confidence, Grounding, Questions, AssistNote } from './AssistBits.jsx'

export default function RequirementsAssist({ projectId, requirementSetId, setStatus }) {
  const toast = useToast()
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(null)
  const [findings, setFindings] = useState([])
  const [drivers, setDrivers] = useState([])
  const [notes, setNotes] = useState([])
  const [noteText, setNoteText] = useState('')
  const [imageName, setImageName] = useState('')

  async function load() {
    const [{ data: f }, { data: d }, { data: n }] = await Promise.all([
      supabase.from('assist_findings').select('*').eq('project_id', projectId).eq('kind', 'critic').order('created_at', { ascending: false }),
      supabase.from('architectural_drivers').select('*').eq('project_id', projectId).order('created_at', { ascending: false }),
      supabase.from('assist_findings').select('*').eq('project_id', projectId).eq('kind', 'note').order('created_at', { ascending: false }).limit(8),
    ])
    setFindings(f ?? [])
    setDrivers(d ?? [])
    setNotes(n ?? [])
  }
  useEffect(() => { load() }, [projectId])

  async function run(action) {
    setError(null)
    setBusy(action)
    try {
      await callAssist(action, { project_id: projectId, requirement_set_id: requirementSetId })
      toast.success('Proposals saved. Nothing is locked or approved.')
      await load()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(null)
    }
  }

  async function setFindingStatus(id, status) {
    const { error: err } = await supabase.from('assist_findings').update({ status }).eq('id', id)
    if (err) return setError(err.message)
    load()
  }

  async function applyRewrite(f) {
    if (setStatus === 'locked') return setError('Unlock is not available here. Copy the rewrite into a new draft set.')
    const rid = f.target?.requirement_id
    if (!rid || !f.suggested_rewrite) return
    const { error: err } = await supabase.from('requirements').update({ body: f.suggested_rewrite }).eq('id', rid)
    if (err) return setError(err.message)
    await supabase.from('assist_findings').update({ status: 'applied' }).eq('id', f.id)
    toast.success('Rewrite applied to the draft requirement. Review the wording.')
    load()
  }

  async function setDriverStatus(id, status) {
    const { error: err } = await supabase.from('architectural_drivers').update({ status }).eq('id', id)
    if (err) return setError(err.message)
    load()
  }

  async function submitNotes(e) {
    e.preventDefault()
    setError(null)
    setBusy('notes')
    try {
      const file = e.target.image?.files?.[0]
      let image_base64 = ''
      let mime_type = 'image/png'
      if (file) {
        if (file.size > 4_000_000) throw new Error('Image must be under 4 MB.')
        mime_type = file.type || 'image/png'
        const buf = await file.arrayBuffer()
        const bytes = new Uint8Array(buf)
        let binary = ''
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
        image_base64 = btoa(binary)
      }
      await callAssist('notes', { project_id: projectId, text: noteText, image_base64, mime_type })
      setNoteText('')
      setImageName('')
      e.target.reset?.()
      toast.success('Notes staged. They are not requirements.')
      await load()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="card">
      <span className="doc-kicker">Architect assist · propose only</span>
      <h2 className="doc-title">Requirement critic, drivers, workshop notes</h2>
      <AssistNote>
        The model can flag wording and extract ADD-style drivers. You accept drivers before they feed design. Workshop images never lock the set.
      </AssistNote>
      {error && <ErrorBanner error={error} />}
      <div className="row wrap">
        <button type="button" disabled={!requirementSetId || busy} onClick={() => run('critic')}>
          {busy === 'critic' ? 'Critiquing…' : 'Run requirement critic'}
        </button>
        <button type="button" className="secondary" disabled={!requirementSetId || busy} onClick={() => run('drivers')}>
          {busy === 'drivers' ? 'Extracting…' : 'Propose driver cards'}
        </button>
      </div>

      {findings.map((f) => (
        <div key={f.id} className="assist-item">
          <div className="row between wrap">
            <strong>{f.title}</strong>
            <div className="row wrap">
              <span className={`badge ${f.severity === 'high' ? 'danger' : f.severity === 'medium' ? 'warn' : 'muted'}`}>{f.severity}</span>
              <Confidence value={f.confidence} />
              <span className="badge muted">{f.status}</span>
            </div>
          </div>
          <p style={{ marginBottom: 6 }}>{f.body}</p>
          {f.suggested_rewrite && <pre className="code-view">{f.suggested_rewrite}</pre>}
          <Grounding items={f.grounding} />
          {f.status === 'open' && (
            <div className="row wrap" style={{ marginTop: 8 }}>
              {f.suggested_rewrite && setStatus !== 'locked' && (
                <button type="button" className="secondary" onClick={() => applyRewrite(f)}>Apply rewrite to draft</button>
              )}
              <button type="button" className="secondary" onClick={() => setFindingStatus(f.id, 'accepted')}>Keep</button>
              <button type="button" className="secondary" onClick={() => setFindingStatus(f.id, 'dismissed')}>Dismiss</button>
            </div>
          )}
        </div>
      ))}

      <h3>Drivers</h3>
      {!drivers.length && <p className="muted">No driver cards yet.</p>}
      {drivers.map((d) => (
        <div key={d.id} className="assist-item">
          <div className="row between wrap">
            <strong>[{d.quality_attribute}] {d.title}</strong>
            <div className="row wrap">
              <Confidence value={d.confidence} />
              <span className={`badge ${d.status === 'accepted' ? 'ok' : d.status === 'rejected' ? 'muted' : 'warn'}`}>{d.status}</span>
            </div>
          </div>
          <p className="muted" style={{ marginBottom: 4 }}>Stimulus: {d.stimulus || '—'}</p>
          <p className="muted" style={{ marginBottom: 4 }}>Environment: {d.environment || '—'}</p>
          <p className="muted" style={{ marginBottom: 4 }}>Response: {d.response || '—'}</p>
          {d.response_measure && <p className="muted" style={{ marginBottom: 4 }}>Measure: {d.response_measure}</p>}
          {d.tactic && <p className="muted">Tactic: {d.tactic}{d.tactic_element ? ` on ${d.tactic_element}` : ''}</p>}
          <Questions items={d.questions} />
          <Grounding items={d.grounding} />
          {d.status === 'proposed' && (
            <div className="row wrap" style={{ marginTop: 8 }}>
              <button type="button" onClick={() => setDriverStatus(d.id, 'accepted')}>Accept driver</button>
              <button type="button" className="secondary" onClick={() => setDriverStatus(d.id, 'rejected')}>Reject</button>
            </div>
          )}
        </div>
      ))}

      <h3>Workshop notes (not locked)</h3>
      <form onSubmit={submitNotes}>
        <textarea rows={3} placeholder="Paste meeting notes, or attach a whiteboard photo." value={noteText} onChange={(e) => setNoteText(e.target.value)} />
        <div className="row wrap" style={{ marginTop: 8 }}>
          <input type="file" name="image" accept="image/*" onChange={(e) => setImageName(e.target.files?.[0]?.name || '')} />
          {imageName && <span className="muted">{imageName}</span>}
          <button type="submit" disabled={busy === 'notes'}>{busy === 'notes' ? 'Staging…' : 'Stage notes'}</button>
        </div>
      </form>
      {notes.map((n) => (
        <details key={n.id} className="assist-item">
          <summary>{n.title} · {new Date(n.created_at).toLocaleString()}</summary>
          <pre className="code-view">{n.body}</pre>
        </details>
      ))}
    </div>
  )
}
