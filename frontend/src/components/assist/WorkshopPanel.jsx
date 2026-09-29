import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { callAssist } from '../../lib/assist.js'
import ErrorBanner from '../ErrorBanner.jsx'
import { Confidence, AssistNote } from './AssistBits.jsx'

export function WorkshopPanel({ projectId }) {
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(null)
  const [nodes, setNodes] = useState([])
  const [scenarios, setScenarios] = useState([])
  const [walks, setWalks] = useState([])
  const [outcomes, setOutcomes] = useState([])
  const [points, setPoints] = useState([])
  const [candidates, setCandidates] = useState([])

  async function load() {
    const [n, s, w, o, p, c] = await Promise.all([
      supabase.from('evaluation_utility_nodes').select('*').eq('project_id', projectId).order('sort_order'),
      supabase.from('evaluation_scenarios').select('*').eq('project_id', projectId).order('created_at'),
      supabase.from('evaluation_walks').select('*').eq('project_id', projectId).order('created_at'),
      supabase.from('evaluation_outcomes').select('*').eq('project_id', projectId),
      supabase.from('evaluation_points').select('*').eq('project_id', projectId).order('created_at'),
      supabase.from('architecture_candidates').select('id, name, status').eq('project_id', projectId),
    ])
    if (n.error) throw new Error(n.error.message)
    setNodes(n.data ?? [])
    setScenarios(s.data ?? [])
    setWalks(w.data ?? [])
    setOutcomes(o.data ?? [])
    setPoints(p.data ?? [])
    setCandidates(c.data ?? [])
  }

  useEffect(() => {
    load().catch((e) => setError(e.message))
  }, [projectId])

  async function run(action) {
    setError(null)
    setBusy(action)
    try {
      await callAssist(action, { project_id: projectId })
      await load()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(null)
    }
  }

  async function setBoundary(id, inBoundary) {
    const { error: err } = await supabase.from('evaluation_scenarios').update({ in_boundary: inBoundary }).eq('id', id)
    if (err) setError(err.message)
    else load()
  }

  async function setRowStatus(table, id, status) {
    const { error: err } = await supabase.from(table).update({ status }).eq('id', id)
    if (err) setError(err.message)
    else load()
  }

  const inBound = scenarios.filter((s) => s.in_boundary)
  const unwalked = inBound.filter((s) => !walks.some((w) => w.scenario_id === s.id && w.status !== 'dismissed'))
  const candById = useMemo(() => Object.fromEntries(candidates.map((c) => [c.id, c])), [candidates])

  const matrix = useMemo(() => {
    const cols = candidates.filter((c) => c.status !== 'discarded')
    return { cols, rows: inBound.length ? inBound : scenarios }
  }, [candidates, inBound, scenarios])

  return (
    <div className="card">
      <span className="doc-kicker">ATAM / SAAM workshop</span>
      <h2 className="doc-title">Scenarios, walks, and trade-off points — no scores</h2>
      <AssistNote>
        Mark which scenarios are in this review. Walk them through components. Compare the same scenarios to each candidate as holds / degrades / unknown.
        Accepting a point does not approve the HLD. In-boundary scenarios without a walk block HLD approval.
      </AssistNote>
      {error && <ErrorBanner error={error} />}
      <div className="row wrap">
        <button type="button" disabled={!!busy} onClick={() => run('scenarios')}>{busy === 'scenarios' ? 'Building…' : 'Generate scenarios'}</button>
        <button type="button" className="secondary" disabled={!!busy} onClick={() => run('walk_scenarios')}>{busy === 'walk_scenarios' ? 'Walking…' : 'Walk through components'}</button>
        <button type="button" className="secondary" disabled={!!busy} onClick={() => run('compare_candidates')}>{busy === 'compare_candidates' ? 'Comparing…' : 'Compare candidates'}</button>
        <button type="button" className="secondary" disabled={!!busy} onClick={() => run('propose_points')}>{busy === 'propose_points' ? 'Proposing…' : 'Propose sensitivity / trade-off points'}</button>
      </div>
      {unwalked.length > 0 && (
        <p className="muted" style={{ marginTop: 8 }}>
          {unwalked.length} in-boundary scenario(s) have no walk yet — HLD Approve will fail until you walk them or mark them out of the workshop.
        </p>
      )}

      {nodes.length > 0 && (
        <>
          <h3>Utility tree</h3>
          <ul>
            {nodes.map((n) => (
              <li key={n.id}>
                <strong>{n.quality}</strong>
                {n.attribute ? ` · ${n.attribute}` : ''}
              </li>
            ))}
          </ul>
        </>
      )}

      <h3>Scenarios</h3>
      {!scenarios.length && <p className="muted">No scenarios yet.</p>}
      {scenarios.map((s) => (
        <div key={s.id} className="assist-item">
          <div className="row between wrap">
            <strong>{s.title}</strong>
            <span className={`badge ${s.in_boundary ? 'ok' : 'muted'}`}>{s.in_boundary ? 'in workshop' : 'out of boundary'}</span>
          </div>
          <p className="muted" style={{ marginBottom: 4 }}>Stimulus: {s.stimulus || '—'}</p>
          <p className="muted" style={{ marginBottom: 4 }}>Environment: {s.environment || '—'}</p>
          <p className="muted">Expected response: {s.expected_response || '—'}</p>
          <p className="muted">Kind: {s.kind}</p>
          <Confidence value={s.confidence} />
          <div className="row wrap" style={{ marginTop: 8 }}>
            <button type="button" className="secondary" onClick={() => setBoundary(s.id, true)}>In workshop</button>
            <button type="button" className="secondary" onClick={() => setBoundary(s.id, false)}>Out of boundary</button>
          </div>
          {walks.filter((w) => w.scenario_id === s.id).map((w) => (
            <div key={w.id} style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
              <p style={{ margin: 0 }}>{w.path_summary}</p>
              <p className="muted">
                Elements: {(w.affected_components || []).map((c) => c.name).join(' → ') || '—'}
                {w.candidate_id ? ` · candidate ${candById[w.candidate_id]?.name || ''}` : ' · HLD'}
              </p>
              <span className="badge muted">{w.status}</span>
              {w.status === 'proposed' && (
                <div className="row wrap" style={{ marginTop: 6 }}>
                  <button type="button" className="secondary" onClick={() => setRowStatus('evaluation_walks', w.id, 'accepted')}>Accept walk</button>
                  <button type="button" className="secondary" onClick={() => setRowStatus('evaluation_walks', w.id, 'dismissed')}>Dismiss</button>
                </div>
              )}
            </div>
          ))}
        </div>
      ))}

      {matrix.cols.length > 0 && matrix.rows.length > 0 && (
        <>
          <h3>Candidate × scenario</h3>
          <p className="muted">holds / degrades / unknown only. There is no quality number.</p>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}>
                  <th style={{ padding: 4 }}>Scenario</th>
                  {matrix.cols.map((c) => (
                    <th key={c.id} style={{ padding: 4 }}>{c.name}{c.status === 'selected' ? ' (selected)' : ''}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {matrix.rows.map((s) => (
                  <tr key={s.id} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: 4 }}>{s.title}</td>
                    {matrix.cols.map((c) => {
                      const cell = outcomes.find((o) => o.scenario_id === s.id && o.candidate_id === c.id)
                      return (
                        <td key={c.id} style={{ padding: 4 }}>
                          {cell ? (
                            <>
                              <span className={`badge ${cell.qualitative_result === 'holds' ? 'ok' : cell.qualitative_result === 'degrades' ? 'warn' : 'muted'}`}>{cell.qualitative_result}</span>
                              {cell.status === 'proposed' && (
                                <button type="button" className="secondary" style={{ marginLeft: 6 }} onClick={() => setRowStatus('evaluation_outcomes', cell.id, 'accepted')}>Keep</button>
                              )}
                            </>
                          ) : <span className="muted">—</span>}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h3>Sensitivity and trade-off points</h3>
      {!points.length && <p className="muted">No points yet. Propose them after you have candidates.</p>}
      {points.map((pt) => (
        <div key={pt.id} className="assist-item">
          <div className="row between wrap">
            <strong>{pt.kind === 'tradeoff' ? 'Trade-off' : 'Sensitivity'}: {pt.quality_a}{pt.quality_b ? ` vs ${pt.quality_b}` : ''}</strong>
            <span className="badge muted">{pt.status}</span>
          </div>
          {pt.element_name && <p className="muted">Element: {pt.element_name}</p>}
          <p>{pt.body}</p>
          {pt.status === 'proposed' && (
            <div className="row wrap">
              <button type="button" className="secondary" onClick={() => setRowStatus('evaluation_points', pt.id, 'accepted')}>Accept finding</button>
              <button type="button" className="secondary" onClick={() => setRowStatus('evaluation_points', pt.id, 'dismissed')}>Dismiss</button>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
