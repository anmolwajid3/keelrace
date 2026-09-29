import { useEffect, useState } from 'react'
import { supabase, callFunction } from '../lib/supabase'
import ListToolbar from './ListToolbar.jsx'
import ErrorBanner from './ErrorBanner.jsx'
import PageLoading from './PageLoading.jsx'
import { matchesQuery } from '../lib/text.js'

export default function SnapshotsTab({ projectId }) {
  const [snapshots, setSnapshots] = useState([])
  const [label, setLabel] = useState('')
  const [selA, setSelA] = useState('')
  const [selB, setSelB] = useState('')
  const [diffResult, setDiffResult] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)

  async function load() {
    const { data } = await supabase.from('architecture_snapshots').select('*').eq('project_id', projectId).order('created_at', { ascending: false })
    setSnapshots(data ?? [])
    setLoading(false)
  }
  useEffect(() => { load() }, [projectId])

  async function createSnapshot(e) {
    e.preventDefault()
    setError(null)
    // Capture current structure: design docs + code artifacts + dependencies, as-is right now.
    const { data: docs } = await supabase
      .from('design_documents')
      .select('id, type, version, status, requirement_sets!inner(project_id)')
      .eq('requirement_sets.project_id', projectId)
    const { data: artifacts } = await supabase.from('code_artifacts').select('id, path, type, design_component_id').eq('project_id', projectId)
    const { data: deps } = artifacts?.length
      ? await supabase.from('code_dependencies').select('*').in('from_artifact_id', artifacts.map((a) => a.id))
      : { data: [] }

    const structure = { design_documents: docs ?? [], code_artifacts: artifacts ?? [], code_dependencies: deps ?? [] }
    const { error } = await supabase.from('architecture_snapshots').insert({ project_id: projectId, label, structure })
    if (error) return setError(error.message)
    setLabel('')
    load()
  }

  async function diff() {
    if (!selA || !selB) return
    setBusy(true)
    setError(null)
    try {
      const res = await callFunction('diff-snapshots', { snapshot_a_id: selA, snapshot_b_id: selB })
      setDiffResult(res)
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  return (
    <div>
      <h1>Architecture Snapshots</h1>
      <p className="muted">Immutable once created (FR-5.4) — no update policy exists on this table.</p>
      {error && <ErrorBanner error={error} />}
      {loading && <PageLoading />}

      <form onSubmit={createSnapshot} className="card row">
        <input placeholder="Label (e.g. 'post Q3 migration')" value={label} onChange={(e) => setLabel(e.target.value)} required />
        <button type="submit">Capture snapshot</button>
      </form>

      <div className="card">
        <h3>Compare two snapshots</h3>
        <div className="grid-2">
          <select value={selA} onChange={(e) => setSelA(e.target.value)}>
            <option value="">— snapshot A —</option>
            {snapshots.map((s) => <option key={s.id} value={s.id}>{s.label} ({new Date(s.created_at).toLocaleDateString()})</option>)}
          </select>
          <select value={selB} onChange={(e) => setSelB(e.target.value)}>
            <option value="">— snapshot B —</option>
            {snapshots.map((s) => <option key={s.id} value={s.id}>{s.label} ({new Date(s.created_at).toLocaleDateString()})</option>)}
          </select>
        </div>
        <div style={{ marginTop: 8 }}><button onClick={diff} disabled={busy || !selA || !selB}>Diff</button></div>
        {diffResult && (
          <ul style={{ marginTop: 8 }}>
            {diffResult.findings.map((f, i) => <li key={i} className="muted">{f}</li>)}
            {!diffResult.findings.length && <li className="muted">No structural differences.</li>}
          </ul>
        )}
      </div>

      <ListToolbar search={search} onSearch={setSearch} placeholder="Search snapshot labels…" />

      {snapshots.filter((s) => matchesQuery(s.label, search)).map((s) => (
        <div key={s.id} className="card row between">
          <span>{s.label}</span>
          <span className="muted">{new Date(s.created_at).toLocaleString()}</span>
        </div>
      ))}
    </div>
  )
}
