import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useToast } from '../hooks/useToast.jsx'

const ORIGIN_LABEL = {
  model_unchanged: 'copied from the model',
  model_edited: 'edited from the model',
  architect: 'written by the architect',
}

export function originLabel(origin) {
  return ORIGIN_LABEL[origin] || origin
}

export default function StandingRulePanel({ projectId, decision, components, otherDecisions, onChanged }) {
  const toast = useToast()
  const [rule, setRule] = useState(null)
  const [verdicts, setVerdicts] = useState([])
  const [ruleText, setRuleText] = useState('')
  const [endsWhen, setEndsWhen] = useState('')
  const [labels, setLabels] = useState('')
  const [componentId, setComponentId] = useState(decision.component_id || '')
  const [paths, setPaths] = useState('')
  const [replaceId, setReplaceId] = useState('')
  const [replaceReason, setReplaceReason] = useState('')
  const [error, setError] = useState(null)

  async function load() {
    const { data } = await supabase.from('standing_rules').select('*').eq('decision_rationale_id', decision.id).maybeSingle()
    setRule(data ?? null)
    if (data) {
      const { data: rows } = await supabase
        .from('rule_verdicts')
        .select('id, result, reason, option_text, created_at')
        .eq('standing_rule_id', data.id)
        .order('created_at', { ascending: false })
        .limit(12)
      setVerdicts(rows ?? [])
    } else {
      setVerdicts([])
    }
  }
  useEffect(() => { load() }, [decision.id])

  async function confirmRule(e) {
    e.preventDefault()
    setError(null)
    const coverLabels = labels.split(',').map((s) => s.trim()).filter((s) => s.length >= 3)
    const coverPaths = paths.split(',').map((s) => s.trim()).filter(Boolean)
    const { error: err } = await supabase.from('standing_rules').insert({
      project_id: projectId,
      decision_rationale_id: decision.id,
      rule_text: ruleText.trim(),
      ends_when: endsWhen.trim(),
      covers: {
        component_ids: componentId ? [componentId] : [],
        artifact_ids: [],
        paths: coverPaths,
        config_keys: [],
        labels: coverLabels,
      },
    })
    if (err) return setError(err.message)
    toast.success('Standing rule is in force. Later changes that touch it get a result.')
    setRuleText('')
    setEndsWhen('')
    onChanged?.()
    load()
  }

  async function replaceRule(e) {
    e.preventDefault()
    setError(null)
    const { error: err } = await supabase.rpc('replace_standing_rule', {
      p_rule_id: rule.id,
      p_replacement_decision_id: replaceId,
      p_reason: replaceReason.trim(),
    })
    if (err) return setError(err.message)
    toast.success('The old rule stays in the ledger as replaced.')
    setReplaceReason('')
    onChanged?.()
    load()
  }

  return (
    <div style={{ marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
      <p className="doc-kicker" style={{ marginTop: 0 }}>Standing rule</p>
      {error && <p className="badge danger">{error}</p>}
      {rule ? (
        <>
          <p style={{ marginTop: 0 }}>{rule.rule_text}</p>
          <p className="muted">Allowed to end when: {rule.ends_when}</p>
          <p className="muted">Covers: {(rule.covers?.labels || []).join(', ') || 'no labels'}{(rule.covers?.paths || []).length ? ` · paths ${(rule.covers.paths || []).join(', ')}` : ''}</p>
          <span className={`badge ${rule.status === 'in_force' ? 'ok' : 'muted'}`}>{rule.status === 'in_force' ? 'in force' : 'replaced'}</span>
          {verdicts.length > 0 && (
            <ul>
              {verdicts.map((v) => (
                <li key={v.id}>
                  <span className={`badge ${v.result === 'holds' ? 'ok' : v.result === 'breaks' ? 'danger' : 'warn'}`}>{v.result}</span>{' '}
                  {v.reason}
                </li>
              ))}
            </ul>
          )}
          {rule.status === 'in_force' && (
            <form onSubmit={replaceRule} style={{ marginTop: 8 }}>
              <p className="muted">Replace this rule with another decision. The first row stays.</p>
              <select value={replaceId} onChange={(e) => setReplaceId(e.target.value)} required>
                <option value="">— decision that retires this rule —</option>
                {(otherDecisions || []).filter((d) => d.id !== decision.id).map((d) => (
                  <option key={d.id} value={d.id}>{d.decision_point}</option>
                ))}
              </select>
              <input placeholder="Why the old rule is retired" value={replaceReason} onChange={(e) => setReplaceReason(e.target.value)} required style={{ marginTop: 6 }} />
              <div style={{ marginTop: 6 }}><button type="submit" className="secondary">Replace rule</button></div>
            </form>
          )}
        </>
      ) : (
        <form onSubmit={confirmRule}>
          <p className="muted">Write the rule in a form a later change can be checked against. The model can draft it. You confirm it.</p>
          <input placeholder="What must stay true" value={ruleText} onChange={(e) => setRuleText(e.target.value)} required style={{ marginBottom: 6 }} />
          <input placeholder="Allowed endings, separated by 'or'" value={endsWhen} onChange={(e) => setEndsWhen(e.target.value)} required style={{ marginBottom: 6 }} />
          <input placeholder="Labels this rule covers, comma separated (reservation table, transfer API)" value={labels} onChange={(e) => setLabels(e.target.value)} style={{ marginBottom: 6 }} />
          <input placeholder="File paths, comma separated" value={paths} onChange={(e) => setPaths(e.target.value)} style={{ marginBottom: 6 }} />
          <select value={componentId} onChange={(e) => setComponentId(e.target.value)} style={{ marginBottom: 6 }}>
            <option value="">No specific component</option>
            {(components || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <button type="submit">Confirm standing rule</button>
        </form>
      )}
    </div>
  )
}
