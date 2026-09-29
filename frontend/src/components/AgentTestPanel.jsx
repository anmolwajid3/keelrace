import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth.jsx'
import { runAgentTest } from '../lib/agentTest.js'
import { loadTestAgentAllowed } from '../lib/testAgent.js'
import { supabase } from '../lib/supabase'
import ErrorBanner from './ErrorBanner.jsx'

export default function AgentTestPanel({ projects }) {
  const { user } = useAuth()
  const [allowed, setAllowed] = useState(null)
  const [projectId, setProjectId] = useState('')
  const [file, setFile] = useState(null)
  const [hasReqs, setHasReqs] = useState(null)
  const [log, setLog] = useState([])
  const [findings, setFindings] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)

  useEffect(() => {
    loadTestAgentAllowed(user.id).then(setAllowed)
  }, [user.id])

  useEffect(() => {
    if (!projectId && projects[0]) setProjectId(projects[0].id)
  }, [projects, projectId])

  useEffect(() => {
    if (!projectId) { setHasReqs(null); return }
    let cancelled = false
    supabase.from('requirement_sets').select('id').eq('project_id', projectId)
      .then(async ({ data: sets }) => {
        if (cancelled) return
        const ids = (sets ?? []).map((s) => s.id)
        if (!ids.length) { setHasReqs(false); return }
        const { count } = await supabase.from('requirements').select('id', { count: 'exact', head: true }).in('requirement_set_id', ids)
        if (!cancelled) setHasReqs((count ?? 0) > 0)
      })
    return () => { cancelled = true }
  }, [projectId])

  if (allowed === false) {
    return (
      <div className="card agent-panel" id="agent-test">
        <h2>Agent test</h2>
        <p className="muted">This account is not allowed to run the loop tester. An admin turns that on under Admin.</p>
        <Link to="/admin">Open Admin</Link>
      </div>
    )
  }
  if (allowed === null) return null

  async function run(e) {
    e.preventDefault()
    if (!projectId) return setError('Pick a project.')
    setError(null)
    setBusy(true)
    setLog([])
    setFindings([])
    setResult(null)
    try {
      const out = await runAgentTest({
        projectId,
        file,
        userId: user.id,
        onLog: (line) => setLog((prev) => [...prev, line]),
        onFinding: (row) => setFindings((prev) => [...prev, row]),
      })
      setResult(out)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const failed = findings.filter((f) => f.result === 'fail').length
  const warned = findings.filter((f) => f.result === 'warn').length

  return (
    <div className="card agent-panel" id="agent-test">
      <h2>Agent test</h2>
      <p className="muted">
        Walks a live project the way a person would: lock, generate, cite, spike, approve HLD and LLDs, prototype with loops, traced files, health, contracts, debt, threat model, evidence map, and a saved replayable run — then probes the wrong paths and reports.
      </p>
      {error && <ErrorBanner error={error} />}
      {!projects.length ? (
        <p className="muted">Create a live project first. The LampCheck demo is for How this works, not for this tester.</p>
      ) : (
        <form onSubmit={run}>
          <label className="muted">Project</label>
          <select value={projectId} onChange={(e) => { setProjectId(e.target.value); setFile(null) }}>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          {hasReqs === false && (
            <>
              <label className="muted" style={{ marginTop: 12 }}>Requirements document (.docx or .pdf)</label>
              <p className="muted">This project has no requirements yet. Upload the SRS so the tester can parse it into a requirement set, then walk the loop. If the project already had requirements, you would not upload anything.</p>
              <input type="file" accept=".docx,.pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </>
          )}
          {hasReqs === true && (
            <p className="muted" style={{ marginTop: 12 }}>This project already has a requirement set. The tester will walk those — no document upload.</p>
          )}
          <div style={{ marginTop: 12 }}>
            <button type="submit" disabled={busy || !projectId}>{busy ? 'Testing this project…' : 'Run Agent test'}</button>
          </div>
        </form>
      )}
      {log.length > 0 && <ol className="agent-log">{log.map((line, i) => <li key={i}>{line}</li>)}</ol>}
      {findings.length > 0 && (
        <>
          <p className="muted">{failed} failed · {warned} warnings · {findings.length - failed - warned} passed</p>
          <table>
            <thead><tr><th>Phase</th><th>Check</th><th>Result</th><th>Detail</th></tr></thead>
            <tbody>
              {findings.map((f) => (
                <tr key={f.id}>
                  <td>{f.phase}</td>
                  <td>{f.title}</td>
                  <td><span className={`badge ${f.result === 'pass' ? 'ok' : f.result === 'fail' ? 'danger' : 'warn'}`}>{f.result}</span></td>
                  <td className="muted">{f.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {result && <p>Open <Link to={`/projects/${result.projectId}`}>{result.projectName}</Link></p>}
    </div>
  )
}
