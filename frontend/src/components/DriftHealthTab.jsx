import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import ListToolbar from './ListToolbar.jsx'
import ErrorBanner from './ErrorBanner.jsx'
import PageLoading from './PageLoading.jsx'
import { matchesQuery } from '../lib/text.js'

export default function DriftHealthTab({ projectId }) {
  const [report, setReport] = useState(null)
  const [driftEvents, setDriftEvents] = useState([])
  const [unevaluated, setUnevaluated] = useState([])
  const [error, setError] = useState(null)
  const [classFilter, setClassFilter] = useState('all')
  const [severityFilter, setSeverityFilter] = useState('all')
  const [resolutionFilter, setResolutionFilter] = useState('open')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)

  async function loadReport() {
    setError(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/health-report?project_id=${projectId}`
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${session?.access_token}`, apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY },
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setReport(data)
    } catch (e) { setError(e.message) }
  }

  async function loadDriftEvents() {
    const { data: artifacts } = await supabase.from('code_artifacts').select('id, path').eq('project_id', projectId)
    const ids = (artifacts ?? []).map((a) => a.id)
    if (!ids.length) { setDriftEvents([]); return }
    const { data } = await supabase
      .from('drift_events')
      .select('*, code_artifacts(path)')
      .in('code_artifact_id', ids)
      .order('detected_at', { ascending: false })
    setDriftEvents(data ?? [])
  }

  useEffect(() => {
    Promise.all([loadReport(), loadDriftEvents(), loadUnevaluated()]).finally(() => setLoading(false))
  }, [projectId])

  async function loadUnevaluated() {
    const { data } = await supabase.from('unevaluated_artifacts').select('*').eq('project_id', projectId)
    setUnevaluated(data ?? [])
  }

  async function resolveDrift(event, resolution) {
    const { error } = await supabase
      .from('drift_events')
      .update({ resolution })
      .eq('id', event.id)
    if (error) setError(error.message)
    else { loadDriftEvents(); loadReport() }
  }

  return (
    <div>
      <div className="row between wrap">
        <h1>Drift & Health</h1>
        <button className="secondary" onClick={() => { loadReport(); loadDriftEvents(); loadUnevaluated() }}>Refresh</button>
      </div>
      {error && <ErrorBanner error={error} />}
      {loading && <PageLoading />}
      {report && (
        <div className="card">
          <h2>Architecture Health Report</h2>
          <p className="muted">Live — generated {new Date(report.generated_at).toLocaleTimeString()}</p>
          <div className="grid-2">
            <div>
              <h3>Open drift</h3>
              <p>Low: {report.drift.open_by_severity.low} · Medium: {report.drift.open_by_severity.medium} · <strong>High: {report.drift.open_by_severity.high}</strong></p>
            </div>
            <div>
              <h3>Debt / conflicts</h3>
              <p>Open debt: {report.debt.open_count} · Unresolved NFR conflicts: {report.nfr_conflicts.unresolved_count}</p>
            </div>
          </div>
          <div style={{ marginTop: 8 }}>
            <h3>Governance</h3>
            {!report.governance.topology_defined && <p className="badge warn">No deployment topology defined for any environment</p>}
            {report.governance.topology_defined && <p className="badge ok">Deployment topology defined</p>}
            {report.governance.trust_boundary_docs_missing_threat_model > 0 && (
              <p className="badge danger">{report.governance.trust_boundary_docs_missing_threat_model} trust-boundary-crossing document(s) missing a ThreatModel</p>
            )}
          </div>
          {report.provisional_decisions_never_checked?.length > 0 && (
            <>
              <h3>Provisional decisions, never checked (90d+)</h3>
              <ul>{report.provisional_decisions_never_checked.map((d) => <li key={d.id}>{d.decision_point}</li>)}</ul>
            </>
          )}
        </div>
      )}

      {unevaluated.length > 0 && (
        <div className="card" style={{ borderColor: 'var(--danger)' }}>
          <strong>Unevaluated changes (NFR-5)</strong>
          <p className="muted">Modified more recently than their last DriftEvent — a merge with no corresponding evaluation.</p>
          <ul>
            {unevaluated.map((u) => (
              <li key={u.code_artifact_id}>
                {u.path} — {u.last_evaluated_at ? `last evaluated ${new Date(u.last_evaluated_at).toLocaleString()}` : 'never evaluated'}
              </li>
            ))}
          </ul>
        </div>
      )}

      <h2>Drift Events</h2>
      <ListToolbar search={search} onSearch={setSearch} placeholder="Search file path…">
        <select value={classFilter} onChange={(e) => setClassFilter(e.target.value)}>
          <option value="all">All classes</option>
          <option value="conformant">conformant</option>
          <option value="local_deviation">local_deviation</option>
          <option value="architectural_drift">architectural_drift</option>
        </select>
        <select value={severityFilter} onChange={(e) => setSeverityFilter(e.target.value)}>
          <option value="all">All severity</option>
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
        </select>
        <select value={resolutionFilter} onChange={(e) => setResolutionFilter(e.target.value)}>
          <option value="open">Open</option>
          <option value="resolved">Resolved</option>
          <option value="all">All</option>
        </select>
      </ListToolbar>
      {driftEvents.filter((e) => {
        if (classFilter !== 'all' && e.classification !== classFilter) return false
        if (severityFilter !== 'all' && e.severity !== severityFilter) return false
        if (resolutionFilter === 'open' && e.resolution) return false
        if (resolutionFilter === 'resolved' && !e.resolution) return false
        return matchesQuery(e.code_artifacts?.path, search)
      }).map((e) => (
        <div key={e.id} className="card">
          <div className="row between">
            <span>{e.code_artifacts?.path}</span>
            <div className="row">
              <span className={`badge ${e.classification === 'architectural_drift' ? 'danger' : e.classification === 'local_deviation' ? 'warn' : 'ok'}`}>{e.classification}</span>
              {e.severity && <span className="badge muted">{e.severity} · blast radius {e.blast_radius_count}</span>}
            </div>
          </div>
          {!e.resolution && e.classification !== 'conformant' && (
            <div className="row" style={{ marginTop: 8 }}>
              <button className="secondary" onClick={() => resolveDrift(e, 'update_documentation')}>Update docs</button>
              <button className="secondary" onClick={() => resolveDrift(e, 'log_as_debt')}>Log as debt</button>
            </div>
          )}
          {e.resolution && <span className="badge ok">resolved: {e.resolution}</span>}
        </div>
      ))}
          {!driftEvents.length && <p className="muted">No drift events. POST to detect-drift or merge-webhook from CI with the changed file paths.</p>}
    </div>
  )
}
