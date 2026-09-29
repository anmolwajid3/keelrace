import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { callAssist } from '../../lib/assist.js'
import ErrorBanner from '../ErrorBanner.jsx'
import { Confidence, AssistNote } from './AssistBits.jsx'

export default function ChangeAssist({ projectId, requirementId, description }) {
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [briefs, setBriefs] = useState([])

  async function load() {
    const { data } = await supabase.from('assist_findings').select('*').eq('project_id', projectId).eq('kind', 'brief').order('created_at', { ascending: false }).limit(8)
    setBriefs(data ?? [])
  }
  useEffect(() => { load() }, [projectId])

  async function run() {
    setError(null)
    setBusy(true)
    try {
      await callAssist('change_brief', { project_id: projectId, requirement_id: requirementId || null, description: description || '' })
      await load()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card">
      <span className="doc-kicker">Change blast</span>
      <h2 className="doc-title">Narrative from the graph</h2>
      <AssistNote>This is a briefing, not triage. Door 1 / Door 2 still need a human decision.</AssistNote>
      {error && <ErrorBanner error={error} />}
      <button type="button" disabled={busy} onClick={run}>{busy ? 'Writing…' : 'Write blast brief'}</button>
      {briefs.map((b) => (
        <div key={b.id} className="assist-item">
          <Confidence value={b.confidence} />
          <p>{b.body}</p>
          {b.target?.cannot_infer?.length > 0 && (
            <p className="muted">Cannot infer: {b.target.cannot_infer.join('; ')}</p>
          )}
        </div>
      ))}
    </div>
  )
}
