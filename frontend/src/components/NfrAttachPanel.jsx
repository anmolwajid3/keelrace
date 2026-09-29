import { useEffect, useState } from 'react'
import { supabase, callFunction } from '../lib/supabase'
import { emptyChoice, heuristicNfrMatches, homelessNfrs, nfrsUnderDecision } from '../lib/nfrSuggest.js'
import { useToast } from '../hooks/useToast.jsx'

export default function NfrAttachPanel({ projectId, documentId, uncitedNfrs = [], onDone, context = {} }) {
  const toast = useToast()
  const [decisions, setDecisions] = useState([])
  const [suggestions, setSuggestions] = useState([])
  const [choices, setChoices] = useState({})
  const [busy, setBusy] = useState(false)
  const [suggesting, setSuggesting] = useState(false)
  const [error, setError] = useState(null)
  const [ownNfr, setOwnNfr] = useState({ name: '', description: '' })

  useEffect(() => {
    let cancelled = false
    async function load() {
      const { data } = await supabase
        .from('decision_rationales')
        .select('id, decision_point, chosen_option, risk_level')
        .eq('design_document_id', documentId)
      if (cancelled) return
      setDecisions(data ?? [])
      const heur = heuristicNfrMatches(uncitedNfrs, data ?? [])
      setSuggestions(heur)
      const next = {}
      for (const n of uncitedNfrs) {
        next[n.id] = emptyChoice(n, data ?? [], heur.find((s) => s.nfr_id === n.id))
      }
      setChoices(next)
    }
    load()
    return () => { cancelled = true }
  }, [documentId, uncitedNfrs.map((n) => n.id).join(',')])

  function patch(nfrId, part) {
    setChoices((prev) => ({ ...prev, [nfrId]: { ...prev[nfrId], ...part } }))
  }

  function toggleDecision(nfrId, drId) {
    const cur = choices[nfrId]?.selected ?? []
    const selected = cur.includes(drId) ? cur.filter((id) => id !== drId) : [...cur, drId]
    patch(nfrId, { selected, mode: 'existing', skip: false })
  }

  function applySuggestionDefaults(list, drs = decisions) {
    const next = {}
    for (const n of uncitedNfrs) {
      next[n.id] = emptyChoice(n, drs, list.find((s) => s.nfr_id === n.id))
    }
    setChoices(next)
  }

  async function suggest() {
    setError(null)
    setSuggesting(true)
    try {
      const res = await callFunction('suggest-nfr-citations', {
        design_document_id: documentId,
        nfr_ids: uncitedNfrs.map((n) => n.id),
      })
      const drs = res.decisions?.length ? res.decisions : decisions
      setSuggestions(res.suggestions ?? [])
      setDecisions(drs)
      applySuggestionDefaults(res.suggestions ?? [], drs)
      toast.success('Candidates ready. Tick one, several, none, or add your own — nothing is saved until you apply.')
    } catch (e) {
      const heur = heuristicNfrMatches(uncitedNfrs, decisions)
      setSuggestions(heur)
      applySuggestionDefaults(heur, decisions)
      setError(`Model suggestion failed (${e.message}). Showing keyword matches instead.`)
    } finally {
      setSuggesting(false)
    }
  }

  async function requirementIds() {
    const { data: doc } = await supabase.from('design_documents').select('requirement_set_id').eq('id', documentId).single()
    const { data: reqs } = await supabase.from('requirements').select('id').eq('requirement_set_id', doc.requirement_set_id).limit(3)
    return (reqs ?? []).map((r) => r.id)
  }

  async function apply() {
    setError(null)
    setBusy(true)
    try {
      const driving = await requirementIds()
      let cited = 0
      let created = 0
      let skipped = 0
      for (const nfr of uncitedNfrs) {
        const c = choices[nfr.id]
        if (!c || c.skip || c.mode === 'none') {
          skipped++
          continue
        }
        let targetIds = [...(c.selected ?? [])]
        if (c.mode === 'new') {
          const point = (c.newPoint ?? '').trim()
          const option = (c.newOption ?? '').trim()
          if (!point || !option) {
            setError(`Add a decision for “${nfr.name}” or pick None.`)
            setBusy(false)
            return
          }
          if (!driving.length) {
            setError('Cannot add a decision until this design cites at least one requirement.')
            setBusy(false)
            return
          }
          const { data: dr, error: drErr } = await supabase.from('decision_rationales').insert({
            design_document_id: documentId,
            decision_point: point,
            chosen_option: option,
            alternatives_considered: [],
            driving_requirements: driving,
            searchable_text: `${point} ${option}`,
            risk_level: 'low',
          }).select('id').single()
          if (drErr) throw new Error(drErr.message)
          targetIds = [dr.id]
          created++
        }
        if (!targetIds.length) {
          skipped++
          continue
        }
        const rows = targetIds.map((id) => ({ nfr_id: nfr.id, decision_rationale_id: id }))
        const { error: cErr } = await supabase.from('nfr_citations').insert(rows)
        if (cErr && !/duplicate|unique/i.test(cErr.message)) throw new Error(cErr.message)
        cited++
      }
      toast.success(
        `Attached ${cited} rule(s)${created ? `, added ${created} decision(s)` : ''}${skipped ? `, skipped ${skipped}` : ''}.`,
      )
      onDone?.()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  async function addOwnNfr(e) {
    e.preventDefault()
    if (!ownNfr.name.trim()) return
    const { error: nErr } = await supabase.from('nfrs').insert({
      project_id: projectId,
      name: ownNfr.name.trim(),
      description: ownNfr.description.trim() || null,
    })
    if (nErr) return setError(nErr.message)
    setOwnNfr({ name: '', description: '' })
    toast.success('Quality rule added. Suggest matches again to attach it.')
    onDone?.()
  }

  const remaining = uncitedNfrs.length
  if (!remaining) return null

  const homeless = homelessNfrs(uncitedNfrs, choices)
  const ownerLabel = context.componentName
    ? `LLD · ${context.componentName}`
    : `HLD v${context.version ?? '?'}`
  const childNames = (context.components ?? []).map((c) => c.name).filter(Boolean)

  return (
    <div className="nfr-attach">
      <ol className="belong-tree">
        <li>
          <strong>{ownerLabel}</strong> owns the decisions below.
          <ul>
            <li>Quality rules belong to <em>a decision</em>, not to the whole document as a pile.</li>
            {childNames.length > 0 && (
              <li>Components under this HLD: {childNames.join(', ')}. Each LLD attaches its own rules separately.</li>
            )}
            {context.componentName && <li>This LLD belongs to component <strong>{context.componentName}</strong> under the parent HLD.</li>}
          </ul>
        </li>
      </ol>
      <p>
        <strong>{remaining} quality rule{remaining === 1 ? '' : 's'} still need a home.</strong>
        {' '}Suggest matches, then tick rules under the decision they belong to. One, many, or none. Nothing saves until you apply.
      </p>
      <div className="row wrap">
        <button type="button" onClick={suggest} disabled={suggesting}>{suggesting ? 'Suggesting…' : 'Suggest matches'}</button>
      </div>
      {error && <p className="muted" style={{ color: 'var(--danger)' }}>{error}</p>}

      {decisions.map((d) => {
        const under = nfrsUnderDecision(uncitedNfrs, choices, d.id)
        return (
          <article key={d.id} className="nfr-choice">
            <p className="doc-kicker">Decision on this {context.componentName ? 'LLD' : 'HLD'}</p>
            <h3 className="doc-title" style={{ marginTop: 0 }}>{d.decision_point}</h3>
            <p className="muted">{d.chosen_option}</p>
            <p className="quiet-hint">{under.length ? `${under.length} rule(s) assigned here` : 'No quality rule assigned yet'}</p>
            <div className="nfr-decision-list">
              {uncitedNfrs.map((nfr) => {
                const sug = suggestions.find((s) => s.nfr_id === nfr.id)
                const suggested = (sug?.suggested_decision_ids ?? []).includes(d.id)
                const checked = (choices[nfr.id]?.selected ?? []).includes(d.id)
                return (
                  <label key={nfr.id} className={`nfr-under ${suggested ? 'suggested' : ''}`}>
                    <input type="checkbox" style={{ width: 'auto', marginTop: 3 }} checked={checked} onChange={() => toggleDecision(nfr.id, d.id)} />
                    <span>
                      <strong>{nfr.name}</strong>
                      {nfr.description ? <span className="muted"> — {nfr.description}</span> : null}
                      {suggested && <span className="badge">suggested</span>}
                    </span>
                  </label>
                )
              })}
            </div>
          </article>
        )
      })}

      {!decisions.length && (
        <p className="muted">This document has no decisions yet. Add one under a homeless rule below.</p>
      )}

      {homeless.length > 0 && (
        <article className="nfr-choice" style={{ borderColor: 'var(--warn)' }}>
          <h3 className="doc-title" style={{ marginTop: 0 }}>Not assigned to a decision yet ({homeless.length})</h3>
          {homeless.map((nfr) => {
            const c = choices[nfr.id] ?? emptyChoice(nfr, decisions)
            const sug = suggestions.find((s) => s.nfr_id === nfr.id)
            return (
              <div key={nfr.id} style={{ marginBottom: 12 }}>
                <strong>{nfr.name}</strong>
                {nfr.description && <p className="muted" style={{ margin: '4px 0' }}>{nfr.description}</p>}
                {sug?.reason && <p className="quiet-hint">{sug.reason}</p>}
                <div className="row wrap">
                  {decisions.length > 0 && (
                    <select
                      value=""
                      onChange={(e) => { if (e.target.value) toggleDecision(nfr.id, e.target.value) }}
                    >
                      <option value="">Assign to a decision…</option>
                      {decisions.map((d) => <option key={d.id} value={d.id}>{d.decision_point}</option>)}
                    </select>
                  )}
                  <button type="button" className="secondary" onClick={() => patch(nfr.id, { mode: 'new', skip: false, selected: [] })}>Add my own decision</button>
                  <button type="button" className="ghost" onClick={() => patch(nfr.id, { mode: 'none', skip: true, selected: [] })}>None</button>
                </div>
                {c.mode === 'new' && !c.skip && (
                  <div className="grid-2" style={{ marginTop: 8 }}>
                    <input placeholder="Decision point" value={c.newPoint ?? ''} onChange={(e) => patch(nfr.id, { newPoint: e.target.value })} />
                    <input placeholder="Chosen option" value={c.newOption ?? ''} onChange={(e) => patch(nfr.id, { newOption: e.target.value })} />
                  </div>
                )}
              </div>
            )
          })}
        </article>
      )}

      <div className="row wrap" style={{ marginTop: 8 }}>
        <button type="button" onClick={apply} disabled={busy}>{busy ? 'Applying…' : 'Apply my choices'}</button>
      </div>

      <form onSubmit={addOwnNfr} className="nfr-own" style={{ marginTop: 12 }}>
        <p className="muted" style={{ marginTop: 0 }}>Missing a quality rule entirely? Add it, then suggest matches again.</p>
        <div className="grid-2">
          <input placeholder="New quality rule name" value={ownNfr.name} onChange={(e) => setOwnNfr({ ...ownNfr, name: e.target.value })} />
          <input placeholder="What it requires" value={ownNfr.description} onChange={(e) => setOwnNfr({ ...ownNfr, description: e.target.value })} />
        </div>
        <div style={{ marginTop: 8 }}><button type="submit" className="secondary" disabled={!ownNfr.name.trim()}>Add quality rule</button></div>
      </form>
    </div>
  )
}
