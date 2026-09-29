import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { callAssist } from '../../lib/assist.js'
import { useToast } from '../../hooks/useToast.jsx'
import ErrorBanner from '../ErrorBanner.jsx'
import { Confidence, Grounding, Questions, AssistNote } from './AssistBits.jsx'

export default function AdrAssist({ projectId, docs, requirements, onRecorded }) {
  const toast = useToast()
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [point, setPoint] = useState('')
  const [drafts, setDrafts] = useState([])
  const [chosen, setChosen] = useState({})

  async function load() {
    const { data } = await supabase.from('assist_adr_drafts').select('*').eq('project_id', projectId).order('created_at', { ascending: false })
    setDrafts(data ?? [])
  }
  useEffect(() => { load() }, [projectId])

  async function draft(e) {
    e.preventDefault()
    if (!point.trim()) return
    setError(null)
    setBusy(true)
    try {
      await callAssist('draft_adr', { project_id: projectId, decision_point: point.trim(), design_document_id: docs?.[0]?.id })
      setPoint('')
      toast.success('Draft filled alternatives only. Chosen option is still yours.')
      await load()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function record(d) {
    const option = (chosen[d.id] ?? '').trim()
    if (!option) return setError('Type the chosen option. The copilot will not pick it.')
    const reqIds = d.suggested_requirement_ids || []
    if (!reqIds.length) return setError('This draft has no suggested requirements. Record the ADR manually and cite drivers.')
    const docId = d.design_document_id || docs?.[0]?.id
    if (!docId) return setError('Generate or pick a design document first.')
    const alts = Array.isArray(d.alternatives) ? d.alternatives : []
    const { data: created, error: err } = await supabase.from('decision_rationales').insert({
      design_document_id: docId,
      decision_point: d.decision_point,
      chosen_option: option,
      alternatives_considered: alts,
      driving_requirements: reqIds,
      searchable_text: `[assist draft] ${d.decision_point} ${option}`,
      risk_level: 'medium',
      risk_set_by: 'human',
    }).select().single()
    if (err) return setError(err.message)
    await supabase.from('design_provenance').insert({
      project_id: projectId,
      design_document_id: docId,
      element_key: created.id,
      element_label: d.decision_point,
      origin: 'architect',
    })
    await supabase.from('assist_adr_drafts').update({ status: 'recorded', chosen_option: option }).eq('id', d.id)
    toast.success('ADR recorded from your choice.')
    onRecorded?.()
    load()
  }

  async function discard(id) {
    await supabase.from('assist_adr_drafts').update({ status: 'discarded' }).eq('id', id)
    load()
  }

  return (
    <div className="card">
      <span className="doc-kicker">ADR copilot</span>
      <h2 className="doc-title">You name the question. You fill the decision.</h2>
      <AssistNote>The model lists alternatives and missing context. Chosen option stays empty until you type it, then Record writes a real ADR with requirement citations.</AssistNote>
      {error && <ErrorBanner error={error} />}
      <form onSubmit={draft} className="row wrap">
        <input placeholder="Decision point (required)" value={point} onChange={(e) => setPoint(e.target.value)} required style={{ flex: 1, minWidth: 220 }} />
        <button type="submit" disabled={busy}>{busy ? 'Drafting…' : 'Draft alternatives'}</button>
      </form>
      {drafts.map((d) => (
        <div key={d.id} className="assist-item">
          <div className="row between wrap">
            <strong>{d.decision_point}</strong>
            <span className="badge muted">{d.status}</span>
          </div>
          <ul>
            {(d.alternatives || []).map((a, i) => (
              <li key={i}><strong>{a.option}</strong> — {a.rejection_reason || 'no rejection yet (you decide)'}</li>
            ))}
          </ul>
          {d.consequences && <p className="muted">{d.consequences}</p>}
          {d.rule_text && (
            <p className="muted">Draft rule (confirm it on the decision after you record): {d.rule_text} Ends when: {d.ends_when || '—'}</p>
          )}
          <Questions items={d.questions} />
          <Grounding items={d.grounding} />
          <p className="muted">
            Suggested citations:{' '}
            {(d.suggested_requirement_ids || []).map((id) => requirements.find((r) => r.id === id)?.ref_code || id.slice(0, 8)).join(', ') || 'none'}
          </p>
          {d.status === 'draft' && (
            <>
              <input
                placeholder="Chosen option — architect fills this"
                value={chosen[d.id] ?? d.chosen_option ?? ''}
                onChange={(e) => setChosen({ ...chosen, [d.id]: e.target.value })}
              />
              <div className="row wrap" style={{ marginTop: 8 }}>
                <button type="button" onClick={() => record(d)}>Record ADR</button>
                <button type="button" className="secondary" onClick={() => discard(d.id)}>Discard draft</button>
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  )
}
