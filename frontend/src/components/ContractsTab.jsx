import { useEffect, useState } from 'react'
import { supabase, callFunction } from '../lib/supabase'
import ListToolbar from './ListToolbar.jsx'
import ErrorBanner from './ErrorBanner.jsx'
import PageLoading from './PageLoading.jsx'
import { matchesQuery } from '../lib/text.js'

export default function ContractsTab({ projectId }) {
  const [contracts, setContracts] = useState([])
  const [form, setForm] = useState({
    service_name: '',
    type: 'api',
    spec: `{
  "openapi": "3.0.0",
  "info": { "title": "service", "version": "1.0.0" },
  "paths": {
    "/health": { "get": { "summary": "Liveness" } }
  }
}`,
  })
  const [error, setError] = useState(null)
  const [busyId, setBusyId] = useState(null)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)

  async function load() {
    const { data } = await supabase.from('service_contracts').select('*').eq('project_id', projectId).order('created_at', { ascending: false })
    setContracts(data ?? [])
    setLoading(false)
  }
  useEffect(() => { load() }, [projectId])

  async function register(e) {
    e.preventDefault()
    setError(null)
    let spec
    try { spec = JSON.parse(form.spec) } catch { setError('Spec must be valid JSON'); return }

    const { data: prior } = await supabase
      .from('service_contracts')
      .select('version')
      .eq('project_id', projectId)
      .eq('service_name', form.service_name)
      .eq('type', form.type)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle()
    const version = (prior?.version ?? 0) + 1

    const { data: inserted, error } = await supabase.from('service_contracts').insert({
      project_id: projectId,
      service_name: form.service_name,
      type: form.type,
      version,
      spec,
    }).select().single()
    if (error) return setError(error.message)

    // FR-8.1: run the diff immediately on registration for api contracts,
    // instead of leaving it as a manual step someone has to remember to do.
    if (version > 1) {
      try { await callFunction('diff-contract', { service_contract_id: inserted.id }) } catch (e) { setError(e.message) }
    }
    load()
  }

  async function diff(contract) {
    setBusyId(contract.id)
    setError(null)
    try {
      await callFunction('diff-contract', { service_contract_id: contract.id })
      load()
    } catch (e) { setError(e.message) } finally { setBusyId(null) }
  }

  return (
    <div>
      <h1>Service Contracts</h1>
      <p className="muted">OpenAPI and event schemas both get a structural diff when a new version is registered. Event schemas used to stay “not evaluated”; they now record breaking findings the same way APIs do.</p>
      {error && <ErrorBanner error={error} />}
      {loading && <PageLoading />}

      <form onSubmit={register} className="card">
        <div className="grid-2">
          <input placeholder="Service name" value={form.service_name} onChange={(e) => setForm({ ...form, service_name: e.target.value })} required />
          <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
            <option value="api">api (OpenAPI)</option>
            <option value="event_schema">event_schema</option>
          </select>
        </div>
        <textarea style={{ marginTop: 8 }} rows={6} value={form.spec} onChange={(e) => setForm({ ...form, spec: e.target.value })} />
        <div style={{ marginTop: 8 }}><button type="submit">Register version</button></div>
      </form>

      <ListToolbar search={search} onSearch={setSearch} placeholder="Search service name…" />

      {contracts.filter((c) => matchesQuery(`${c.service_name} ${c.type}`, search)).map((c) => (
        <div key={c.id} className="card">
          <div className="row between">
            <strong>{c.service_name} v{c.version}</strong>
            <span className="badge muted">{c.type}</span>
          </div>
          <div className="row" style={{ marginTop: 4 }}>
            {c.breaking_change === null && <span className="badge muted">not evaluated</span>}
            {c.breaking_change === true && <span className="badge danger">breaking</span>}
            {c.breaking_change === false && <span className="badge ok">safe</span>}
            {c.type === 'api' && (
              <button className="secondary" onClick={() => diff(c)} disabled={busyId === c.id}>Run diff</button>
            )}
          </div>
          {c.diff_tool_report?.findings?.length > 0 && (
            <ul>{c.diff_tool_report.findings.map((f, i) => <li key={i} className="muted">{f}</li>)}</ul>
          )}
          <details>
            <summary className="muted">Spec paths</summary>
            <SpecTable spec={c.spec} />
          </details>
        </div>
      ))}
      {!contracts.length && <p className="muted">No contracts registered yet.</p>}
    </div>
  )
}

function SpecTable({ spec }) {
  const paths = spec?.paths
  if (!paths || !Object.keys(paths).length) return <p className="muted">No paths defined.</p>
  const rows = []
  for (const [path, methods] of Object.entries(paths)) {
    for (const method of Object.keys(methods)) {
      rows.push({ path, method })
    }
  }
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14, marginTop: 8 }}>
      <thead>
        <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}>
          <th style={{ padding: 6 }}>Method</th>
          <th style={{ padding: 6 }}>Path</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
            <td style={{ padding: 6 }}>{r.method.toUpperCase()}</td>
            <td style={{ padding: 6 }} className="muted">{r.path}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
