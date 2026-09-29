import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth.jsx'
import { captureLoopRun, edgesFromRecord } from '../lib/loopRun.js'
import { evaluateConformance, verificationBoundaries } from '../lib/conformance.js'
import ErrorBanner from './ErrorBanner.jsx'
import PageLoading from './PageLoading.jsx'
import { useToast } from '../hooks/useToast.jsx'
import { AskArchitecture } from './assist/AskAssist.jsx'
import { WorkshopPanel } from './assist/WorkshopPanel.jsx'

export default function MapVerifyTab({ projectId }) {
  const { user } = useAuth()
  const toast = useToast()
  const [live, setLive] = useState(null)
  const [runs, setRuns] = useState([])
  const [viewing, setViewing] = useState(null)
  const [label, setLabel] = useState('')
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('map')

  async function load() {
    try {
      const record = await captureLoopRun(supabase, projectId)
      setLive(record)
      const { data } = await supabase.from('loop_runs').select('id, label, created_at, created_by').eq('project_id', projectId).order('created_at', { ascending: false })
      setRuns(data ?? [])
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [projectId])

  async function saveRun(e) {
    e.preventDefault()
    setError(null)
    const record = await captureLoopRun(supabase, projectId)
    const { error: err } = await supabase.from('loop_runs').insert({
      project_id: projectId,
      created_by: user.id,
      label: label.trim() || `Run ${new Date().toLocaleString()}`,
      record,
    })
    if (err) return setError(err.message)
    setLabel('')
    toast.success('Run saved. Open it below to replay from the record — the live project is unchanged.')
    load()
  }

  async function openRun(id) {
    const { data, error: err } = await supabase.from('loop_runs').select('*').eq('id', id).single()
    if (err) return setError(err.message)
    setViewing(data)
    setTab('map')
  }

  const record = viewing?.record ?? live
  const edges = useMemo(() => (record ? edgesFromRecord(record) : []), [record])
  const checks = useMemo(() => (record ? evaluateConformance(record) : []), [record])
  const bounds = verificationBoundaries()
  const byReq = new Map()
  for (const e of edges.filter((x) => x.kind === 'req-decision')) {
    const key = e.req.ref_code
    if (!byReq.has(key)) byReq.set(key, { req: e.req, decisions: [] })
    byReq.get(key).decisions.push(e.decision)
  }
  const nfrByDecision = new Map()
  for (const e of edges.filter((x) => x.kind === 'decision-nfr')) {
    const list = nfrByDecision.get(e.decision.id) || []
    list.push(e.nfr)
    nfrByDecision.set(e.decision.id, list)
  }
  const filesByComp = new Map()
  for (const e of edges.filter((x) => x.kind === 'component-file')) {
    const list = filesByComp.get(e.component.id) || []
    list.push(e.artifact)
    filesByComp.set(e.component.id, list)
  }

  return (
    <div>
      <h1>Evidence map</h1>
      <p className="muted">
        A structured map from requirement → decision → quality evidence, plus the skeleton files that implement the component.
        Save a run to freeze this map; Replay opens that saved record without changing the live project.
      </p>
      {error && <ErrorBanner error={error} />}
      {loading && <PageLoading />}
      <AskArchitecture projectId={projectId} />
      <WorkshopPanel projectId={projectId} />

      <div className="row wrap">
        <button type="button" className={tab === 'map' ? '' : 'secondary'} onClick={() => setTab('map')}>Evidence map</button>
        <button type="button" className={tab === 'runs' ? '' : 'secondary'} onClick={() => setTab('runs')}>Replayable runs</button>
        <button type="button" className={tab === 'bounds' ? '' : 'secondary'} onClick={() => setTab('bounds')}>Conformance</button>
      </div>

      {viewing && (
        <div className="card" style={{ borderColor: 'var(--accent)' }}>
          <div className="row between wrap">
            <strong>Replaying: {viewing.label}</strong>
            <button type="button" className="secondary" onClick={() => setViewing(null)}>Back to live</button>
          </div>
          <p className="muted" style={{ marginBottom: 0 }}>Captured {new Date(viewing.created_at).toLocaleString()}. Read-only.</p>
        </div>
      )}

      {tab === 'map' && record && (
        <>
          <div className="card" style={{ padding: 0, overflow: 'auto' }}>
            <table className="projects-table">
              <thead>
                <tr>
                  <th>Requirement</th>
                  <th>Decision</th>
                  <th>Evidence (quality)</th>
                  <th>Component files</th>
                </tr>
              </thead>
              <tbody>
                {[...byReq.values()].flatMap(({ req, decisions }) => decisions.map((d) => {
                  const nfrs = nfrByDecision.get(d.id) ?? []
                  const files = filesByComp.get(d.component_id) ?? []
                  return (
                    <tr key={`${req.id}-${d.id}`}>
                      <td><strong>{req.ref_code}</strong> {req.title}</td>
                      <td>{d.decision_point} → {d.chosen_option}</td>
                      <td>{nfrs.length ? nfrs.map((n) => n.name).join(', ') : '—'}</td>
                      <td>{files.length ? files.map((a) => a.path).join(', ') : '—'}</td>
                    </tr>
                  )
                }))}
                {byReq.size === 0 && (
                  <tr><td colSpan={4} className="muted">No requirement → decision links yet. Generate an HLD.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <ol className="belong-tree">
            <li>
              <strong>Project</strong> {record.project?.name}
              <ul>
                <li>
                  <strong>Requirement set</strong> {record.requirement_set ? `v${record.requirement_set.version} (${record.requirement_set.status})` : 'none'}
                  <ul>
                    {[...byReq.values()].map(({ req, decisions }) => (
                      <li key={req.id}>
                        <strong>{req.ref_code}</strong> {req.title}
                        <ul>
                          {decisions.map((d) => (
                            <li key={d.id}>
                              Decision: {d.decision_point} → {d.chosen_option}
                              <ul>
                                {(nfrByDecision.get(d.id) ?? []).map((n) => (
                                  <li key={n.id}>Evidence (quality): {n.name}</li>
                                ))}
                                {!(nfrByDecision.get(d.id) ?? []).length && <li className="muted">No quality rule cited on this decision yet</li>}
                              </ul>
                            </li>
                          ))}
                        </ul>
                      </li>
                    ))}
                    {byReq.size === 0 && <li className="muted">No requirement → decision links yet. Generate an HLD.</li>}
                  </ul>
                </li>
                <li>
                  <strong>Components and skeleton files</strong>
                  <ul>
                    {(record.components ?? []).map((c) => (
                      <li key={c.id}>
                        {c.name}
                        <ul>
                          {(filesByComp.get(c.id) ?? []).map((a) => <li key={a.id}><code>{a.path}</code></li>)}
                          {!(filesByComp.get(c.id) ?? []).length && <li className="muted">No files yet</li>}
                        </ul>
                      </li>
                    ))}
                  </ul>
                </li>
              </ul>
            </li>
          </ol>
        </>
      )}

      {tab === 'bounds' && (
        <>
          <div className="grid-2">
            <div className="card">
              <h2 className="doc-title">In the verification boundary</h2>
              <ul>{bounds.inScope.map((x) => <li key={x}>{x}</li>)}</ul>
            </div>
            <div className="card">
              <h2 className="doc-title">Outside it</h2>
              <ul>{bounds.outOfScope.map((x) => <li key={x}>{x}</li>)}</ul>
            </div>
          </div>
          {(checks).map((c) => (
            <div key={c.id} className="card row between">
              <div>
                <strong>{c.name}</strong>
                <p className="muted" style={{ margin: 0 }}>{c.detail}</p>
              </div>
              <span className={`badge ${c.informational ? 'muted' : c.pass ? 'ok' : 'danger'}`}>
                {c.informational ? 'info' : c.pass ? 'pass' : 'fail'}
              </span>
            </div>
          ))}
        </>
      )}

      {tab === 'runs' && (
        <>
          <h2>Replayable runs</h2>
          <p className="muted">Each saved run stores the requirement set, decisions, citations, gates, and files as they were. Replay reads that JSON — it does not mutate the project.</p>
          <form onSubmit={saveRun} className="card row wrap">
            <input placeholder="Label this run (e.g. after HLD approve)" value={label} onChange={(e) => setLabel(e.target.value)} />
            <button type="submit">Save run from live project</button>
          </form>
          {runs.map((r) => (
            <div key={r.id} className="card row between wrap">
              <span>{r.label} <span className="muted">{new Date(r.created_at).toLocaleString()}</span></span>
              <button type="button" className="secondary" onClick={() => openRun(r.id)}>Replay</button>
            </div>
          ))}
          {!runs.length && !loading && <p className="muted">No runs saved yet. Capture one after a review so you can show what was true at that moment.</p>}
        </>
      )}
    </div>
  )
}
