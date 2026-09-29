import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { callAssist } from '../../lib/assist.js'
import { useToast } from '../../hooks/useToast.jsx'
import ErrorBanner from '../ErrorBanner.jsx'
import { Confidence, Grounding, Questions, AssistNote } from './AssistBits.jsx'
import MermaidDiagram from '../MermaidDiagram.jsx'

function stableRank(id) {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return h
}

export default function DesignAssist({ projectId, requirementSetId }) {
  const toast = useToast()
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(null)
  const [candidates, setCandidates] = useState([])
  const [findings, setFindings] = useState([])
  const [verdicts, setVerdicts] = useState([])
  const [views, setViews] = useState([])
  const [studyMode, setStudyMode] = useState(false)
  const [precommitment, setPrecommitment] = useState('')

  async function load() {
    const [{ data: c }, { data: f }, { data: project }, { data: v }] = await Promise.all([
      supabase.from('architecture_candidates').select('*').eq('project_id', projectId).order('generation_index', { ascending: true }),
      supabase.from('assist_findings').select('*').eq('project_id', projectId).eq('kind', 'challenger').order('created_at', { ascending: false }),
      supabase.from('projects').select('study_mode, precommitment, precommitment_used').eq('id', projectId).maybeSingle(),
      supabase.from('rule_verdicts').select('id, candidate_id, result, reason').eq('project_id', projectId).eq('subject', 'candidate'),
    ])
    setCandidates(c ?? [])
    setFindings(f ?? [])
    setVerdicts(v ?? [])
    if (project) {
      setStudyMode(!!project.study_mode)
      setPrecommitment(project.precommitment || '')
    }
  }
  useEffect(() => {
    load()
    try {
      const saved = sessionStorage.getItem(`keelrace.views.${projectId}`)
      if (saved) setViews(JSON.parse(saved))
    } catch { /* ignore */ }
  }, [projectId])

  async function run(action) {
    setError(null)
    setBusy(action)
    try {
      const res = await callAssist(action, { project_id: projectId, requirement_set_id: requirementSetId })
      if (action === 'views') {
        const next = res.views ?? []
        setViews(next)
        try { sessionStorage.setItem(`keelrace.views.${projectId}`, JSON.stringify(next)) } catch { /* ignore */ }
      } else toast.success('Proposals saved. You still choose.')
      await load()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(null)
    }
  }

  async function selectCandidate(id) {
    setError(null)
    const { error: a } = await supabase.from('architecture_candidates').update({ status: 'discarded' }).eq('project_id', projectId).eq('status', 'selected')
    if (a) return setError(a.message)
    const { error: b } = await supabase.from('architecture_candidates').update({ status: 'selected' }).eq('id', id)
    if (b) return setError(b.message)
    toast.success('Candidate selected as baseline. Official HLD still needs Generate + Review.')
    load()
  }

  async function discardCandidate(id) {
    const { error: err } = await supabase.from('architecture_candidates').update({ status: 'discarded' }).eq('id', id)
    if (err) return setError(err.message)
    load()
  }

  async function saveStudy(nextMode = studyMode, note = precommitment) {
    const used = note.trim().length > 0
    const { error: err } = await supabase.from('projects').update({
      study_mode: nextMode,
      precommitment: note,
      precommitment_used: used,
    }).eq('id', projectId)
    if (err) return setError(err.message)
    setStudyMode(nextMode)
    toast.success(nextMode ? 'Study mode on. Names stay hidden until you open a card.' : 'Study mode off.')
  }

  function shownCandidates() {
    const visible = candidates.filter((c) => c.status !== 'discarded')
    if (!studyMode) return visible.map((c) => ({ ...c, displayLabel: c.name }))
    const batches = new Map()
    for (const c of visible) {
      const key = c.generation_batch || 'none'
      if (!batches.has(key)) batches.set(key, [])
      batches.get(key).push(c)
    }
    const out = []
    for (const group of batches.values()) {
      const shuffled = [...group].sort((a, b) => stableRank(a.id) - stableRank(b.id))
      shuffled.forEach((c, i) => out.push({ ...c, displayLabel: `Option ${i + 1}` }))
    }
    return out
  }

  async function setFindingStatus(id, status) {
    const { error: err } = await supabase.from('assist_findings').update({ status }).eq('id', id)
    if (err) return setError(err.message)
    load()
  }

  return (
    <div className="card">
      <span className="doc-kicker">Architect assist · N candidates</span>
      <h2 className="doc-title">Candidates, challenger, views</h2>
      <AssistNote>
        Three options, not one buried HLD. Each one is critiqued before you pick. A candidate that breaks a constraint stays on screen and is marked. Select a baseline, then generate the official document.
      </AssistNote>
      {error && <ErrorBanner error={error} />}
      <label className="muted row" style={{ gap: 6, width: 'auto', marginBottom: 8 }}>
        <input
          type="checkbox"
          style={{ width: 'auto' }}
          checked={studyMode}
          onChange={(e) => saveStudy(e.target.checked, precommitment)}
        />
        Study mode — shuffled order, neutral labels. Not the everyday screen.
      </label>
      {studyMode && (
        <div style={{ marginBottom: 8 }}>
          <textarea
            rows={2}
            placeholder="Optional: write the direction you prefer before the options appear. Empty is allowed."
            value={precommitment}
            onChange={(e) => setPrecommitment(e.target.value)}
          />
          <button type="button" className="secondary" onClick={() => saveStudy(true, precommitment)}>Save note</button>
        </div>
      )}
      <div className="row wrap">
        <button type="button" disabled={busy} onClick={() => run('candidates')}>
          {busy === 'candidates' ? 'Proposing…' : 'Propose 3 candidates'}
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={() => run('challenge')}>
          {busy === 'challenge' ? 'Challenging…' : "Devil's advocate"}
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={() => run('views')}>
          {busy === 'views' ? 'Drawing…' : 'Generate views'}
        </button>
      </div>

      <div className="assist-grid">
        {shownCandidates().map((c) => {
          const breaks = verdicts.filter((v) => v.candidate_id === c.id && v.result === 'breaks')
          const mine = findings.filter((f) => f.target?.candidate_id === c.id)
          return (
            <div key={c.id} className="assist-item">
              <div className="row between wrap">
                <strong>{c.displayLabel}</strong>
                <span className={`badge ${c.status === 'selected' ? 'ok' : c.status === 'discarded' ? 'muted' : 'warn'}`}>{c.status}</span>
              </div>
              {c.generation_index != null && <p className="muted">Generated as #{c.generation_index}. Display order does not change that.</p>}
              {c.constraint_verdict === 'breaks' && <p className="badge danger">{c.constraint_reason}</p>}
              {breaks.map((v) => <p key={v.id} className="badge danger">{v.reason}</p>)}
              {studyMode ? (
                <details>
                  <summary className="muted">Wording, optimize, sacrifice</summary>
                  <p><strong>{c.name}</strong></p>
                  <p>{c.summary}</p>
                  <p className="muted">Optimizes: {c.optimizes || '—'}</p>
                  <p className="muted">Sacrifices: {c.sacrifices || '—'}</p>
                </details>
              ) : (
                <>
                  <p>{c.summary}</p>
                  <p className="muted">Optimizes: {c.optimizes || '—'}</p>
                  <p className="muted">Sacrifices: {c.sacrifices || '—'}</p>
                </>
              )}
              <Confidence value={c.confidence} />
              <Questions items={c.questions} />
              <Grounding items={c.grounding} />
              {mine.map((f) => (
                <div key={f.id} style={{ marginTop: 8 }}>
                  <div className="row wrap">
                    <strong>{f.title}</strong>
                    <span className={`badge ${f.severity === 'high' ? 'danger' : 'warn'}`}>{f.severity}</span>
                    <span className="badge muted">{f.status}</span>
                  </div>
                  <p>{f.body}</p>
                  {f.status === 'open' && (
                    <div className="row wrap">
                      <button type="button" className="secondary" onClick={() => setFindingStatus(f.id, 'accepted')}>Keep</button>
                      <button type="button" className="secondary" onClick={() => setFindingStatus(f.id, 'dismissed')}>Dismiss</button>
                    </div>
                  )}
                </div>
              ))}
              {c.mermaid && (
                <details open>
                  <summary className="muted">{c.mermaid_valid === false ? 'Diagram (syntax failed)' : 'Diagram'}</summary>
                  <MermaidDiagram source={c.mermaid} valid={c.mermaid_valid !== false} />
                </details>
              )}
              {c.status === 'proposed' && (
                <div className="row wrap" style={{ marginTop: 8 }}>
                  <button type="button" onClick={() => selectCandidate(c.id)}>Select as baseline</button>
                  <button type="button" className="secondary" onClick={() => discardCandidate(c.id)}>Discard</button>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {findings.filter((f) => !f.target?.candidate_id).map((f) => (
        <div key={f.id} className="assist-item">
          <div className="row between wrap">
            <strong>{f.title}</strong>
            <div className="row wrap">
              <span className={`badge ${f.severity === 'high' ? 'danger' : 'warn'}`}>{f.severity}</span>
              <Confidence value={f.confidence} />
              <span className="badge muted">{f.status}</span>
            </div>
          </div>
          <p>{f.body}</p>
          <Grounding items={f.grounding} />
          {f.status === 'open' && (
            <div className="row wrap" style={{ marginTop: 8 }}>
              <button type="button" className="secondary" onClick={() => setFindingStatus(f.id, 'accepted')}>Keep</button>
              <button type="button" className="secondary" onClick={() => setFindingStatus(f.id, 'dismissed')}>Dismiss</button>
            </div>
          )}
        </div>
      ))}

      {views.map((v) => (
        <div key={v.kind} className="card">
          <h3 style={{ textTransform: 'capitalize', marginTop: 0 }}>{v.kind} view</h3>
          <MermaidDiagram source={v.mermaid} valid={v.valid !== false} />
        </div>
      ))}
    </div>
  )
}
