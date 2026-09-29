import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { callAssist } from '../../lib/assist.js'
import { useToast } from '../../hooks/useToast.jsx'
import ErrorBanner from '../ErrorBanner.jsx'
import { Confidence, AssistNote } from './AssistBits.jsx'

export default function MapAssist({ projectId, artifacts = [], onApplied }) {
  const toast = useToast()
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [rows, setRows] = useState([])

  async function load() {
    const { data } = await supabase.from('assist_findings').select('*').eq('project_id', projectId).eq('kind', 'mapping').order('created_at', { ascending: false })
    setRows(data ?? [])
  }
  useEffect(() => { load() }, [projectId])

  async function propose() {
    const paths = artifacts.filter((a) => a.type === 'file' && a.path).map((a) => a.path)
    if (!paths.length) return setError('No file paths to map.')
    setError(null)
    setBusy(true)
    try {
      await callAssist('map_paths', { project_id: projectId, paths })
      await load()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  async function apply(f) {
    const path = f.target?.path
    const component_id = f.target?.component_id
    if (!path || !component_id) return
    const { error: err } = await supabase.from('code_artifacts').update({ design_component_id: component_id }).eq('project_id', projectId).eq('path', path)
    if (err) return setError(err.message)
    await supabase.from('assist_findings').update({ status: 'applied' }).eq('id', f.id)
    toast.success('Mapping written as a foreign key. Identity is now the component id.')
    onApplied?.()
    load()
  }

  async function dismiss(id) {
    await supabase.from('assist_findings').update({ status: 'dismissed' }).eq('id', id)
    load()
  }

  return (
    <div className="card">
      <span className="doc-kicker">Brownfield map</span>
      <h2 className="doc-title">Path → component proposals</h2>
      <AssistNote>Filenames are not identity. Confirm a mapping to set design_component_id. Reject the rest.</AssistNote>
      {error && <ErrorBanner error={error} />}
      <button type="button" disabled={busy} onClick={propose}>{busy ? 'Proposing…' : 'Propose mappings'}</button>
      {rows.map((f) => (
        <div key={f.id} className="assist-item">
          <div className="row between wrap">
            <strong>{f.title}</strong>
            <Confidence value={f.confidence} />
          </div>
          <p className="muted">{f.body}</p>
          {f.status === 'open' && (
            <div className="row wrap">
              <button type="button" onClick={() => apply(f)}>Confirm mapping</button>
              <button type="button" className="secondary" onClick={() => dismiss(f.id)}>Reject</button>
            </div>
          )}
          {f.status !== 'open' && <span className="badge muted">{f.status}</span>}
        </div>
      ))}
    </div>
  )
}
