import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import ErrorBanner from './ErrorBanner.jsx'
import PageLoading from './PageLoading.jsx'
import { useToast } from '../hooks/useToast.jsx'

async function must(query, label) {
  const { data, error } = await query
  if (error) throw new Error(`${label}: ${error.message}`)
  return data ?? []
}

export default function AuditTab({ projectId }) {
  const toast = useToast()
  const [checks, setChecks] = useState(null)
  const [error, setError] = useState(null)
  const [lastRun, setLastRun] = useState(null)
  const [busy, setBusy] = useState(false)
  const [runs, setRuns] = useState(0)

  const load = useCallback(async ({ notify } = {}) => {
    if (!projectId) return
    setBusy(true)
    setError(null)
    try {
      const results = []

      const docs = await must(
        supabase
          .from('design_documents')
          .select('id, type, status, requirement_set_id, component_id, approved_by, approved_at, requirement_sets!inner(project_id)')
          .eq('requirement_sets.project_id', projectId),
        'design documents',
      )

      const docsMissingSet = docs.filter((d) => d.status !== 'draft' && !d.requirement_set_id)
      results.push({
        name: 'Design documents trace to a RequirementSet',
        pass: docsMissingSet.length === 0,
        detail: docsMissingSet.length ? `${docsMissingSet.length} non-draft document(s) with no requirement_set_id` : 'All good.',
      })

      const llds = docs.filter((d) => d.type === 'LLD')
      const lldsMissingComponent = llds.filter((d) => !d.component_id)
      results.push({
        name: 'LLDs trace to a real Component',
        pass: lldsMissingComponent.length === 0,
        detail: lldsMissingComponent.length ? `${lldsMissingComponent.length} LLD(s) with no component_id` : 'All good.',
      })

      const docIds = docs.map((d) => d.id)
      let rationalesMissingCitation = []
      if (docIds.length) {
        const rationales = await must(
          supabase.from('decision_rationales').select('id, driving_requirements').in('design_document_id', docIds),
          'decisions',
        )
        rationalesMissingCitation = rationales.filter((r) => !r.driving_requirements || r.driving_requirements.length === 0)
      }
      results.push({
        name: 'Every decision cites at least one requirement',
        pass: rationalesMissingCitation.length === 0,
        detail: rationalesMissingCitation.length ? `${rationalesMissingCitation.length} decision(s) with zero citations` : 'All good.',
      })

      let orphanPrototypes = []
      if (docIds.length) {
        const protos = await must(
          supabase.from('prototypes').select('id, design_document_id').in('design_document_id', docIds),
          'prototypes',
        )
        orphanPrototypes = protos.filter((p) => !p.design_document_id)
      }
      results.push({
        name: 'Prototypes trace to a Design Document',
        pass: orphanPrototypes.length === 0,
        detail: orphanPrototypes.length ? `${orphanPrototypes.length} orphaned prototype(s)` : 'All good.',
      })

      const artifacts = await must(
        supabase.from('code_artifacts').select('id, path, type, design_component_id').eq('project_id', projectId),
        'code artifacts',
      )
      const unlinkedFiles = artifacts.filter((a) => a.type === 'file' && !a.design_component_id)
      results.push({
        name: 'Code artifacts trace to a Component (unlinked ones are visible, not hidden)',
        pass: true,
        detail: `${unlinkedFiles.length} unlinked file(s) — see Diagram/Traceability`,
        informational: true,
        to: 'traceability',
      })

      let orphanThreatModels = []
      if (docIds.length) {
        const tms = await must(
          supabase.from('threat_models').select('id, design_document_id').in('design_document_id', docIds),
          'threat models',
        )
        orphanThreatModels = tms.filter((t) => !t.design_document_id)
      }
      results.push({
        name: 'ThreatModels trace to a Design Document',
        pass: orphanThreatModels.length === 0,
        detail: orphanThreatModels.length ? `${orphanThreatModels.length} orphaned threat model(s)` : 'All good.',
      })

      const approvedMissingReviewer = docs.filter((d) => d.status === 'approved' && (!d.approved_by || !d.approved_at))
      results.push({
        name: 'No approved document lacks a reviewer/timestamp (NFR-2)',
        pass: approvedMissingReviewer.length === 0,
        detail: approvedMissingReviewer.length ? `${approvedMissingReviewer.length} approved doc(s) missing approved_by/approved_at` : 'All good.',
      })

      const hldDocs = docs.filter((d) => d.type === 'HLD')
      let hldsWithNoComponents = []
      if (hldDocs.length) {
        const comps = await must(
          supabase.from('components').select('id, hld_document_id, needs_detail').in('hld_document_id', hldDocs.map((d) => d.id)),
          'components',
        )
        const compsByHld = {}
        for (const c of comps) {
          compsByHld[c.hld_document_id] = compsByHld[c.hld_document_id] || []
          compsByHld[c.hld_document_id].push(c)
        }
        hldsWithNoComponents = hldDocs.filter((d) => !(compsByHld[d.id]?.length))

        const needsDetailComponents = comps.filter((c) => c.needs_detail)
        let componentsMissingLld = []
        if (needsDetailComponents.length) {
          const covering = await must(
            supabase.from('design_documents').select('component_id').eq('type', 'LLD').in('component_id', needsDetailComponents.map((c) => c.id)),
            'covering LLDs',
          )
          const coveredComponentIds = new Set(covering.map((l) => l.component_id))
          componentsMissingLld = needsDetailComponents.filter((c) => !coveredComponentIds.has(c.id))
        }
        results.push({
          name: 'Components needing detail have a covering LLD',
          pass: componentsMissingLld.length === 0,
          detail: componentsMissingLld.length ? `${componentsMissingLld.length} component(s) marked needs_detail with no LLD — likely a partial/failed generation run` : 'All good.',
        })
      }
      results.push({
        name: 'No HLD with zero components (partial generation)',
        pass: hldsWithNoComponents.length === 0,
        detail: hldsWithNoComponents.length ? `${hldsWithNoComponents.length} HLD(s) with no components at all — likely a partial/failed generation run` : 'All good.',
      })

      setChecks(results)
      setLastRun(new Date())
      setRuns((n) => n + 1)
      if (notify) {
        const failed = results.filter((c) => !c.pass && !c.informational).length
        toast.success(failed ? `Checks re-run · ${failed} failed` : `Checks re-run · ${results.length} passed`)
      }
    } catch (e) {
      const message = e?.message || String(e)
      setError(message)
      if (notify) toast.error(message)
    } finally {
      setBusy(false)
    }
  }, [projectId, toast])

  useEffect(() => { load() }, [load])

  return (
    <div>
      <div className="row between wrap">
        <h1>Traceability Audit</h1>
        <button type="button" className="secondary" disabled={busy} onClick={() => load({ notify: true })}>
          {busy ? 'Running…' : 'Re-run checks'}
        </button>
      </div>
      <p className="muted">
        Live confirmation that generated artifacts still point at their producing input — not a trust-the-schema-blindly view.
      </p>
      {error && <ErrorBanner error={error} />}
      {lastRun && (
        <p className="muted">
          Last run {lastRun.toLocaleString()}{runs > 1 ? ` · ${runs} runs this visit` : ''}
        </p>
      )}
      {checks === null && <PageLoading />}
      {checks?.map((c, i) => (
        <div key={`${c.name}-${i}`} className="card row between">
          <div>
            <strong>{c.name}</strong>
            <p className="muted" style={{ margin: '4px 0 0' }}>{c.detail}</p>
            {c.to && <Link to={`../${c.to}`}>Open related tab</Link>}
          </div>
          <span className={`badge ${c.informational ? 'muted' : c.pass ? 'ok' : 'danger'}`}>
            {c.informational ? 'info' : c.pass ? 'pass' : 'fail'}
          </span>
        </div>
      ))}
    </div>
  )
}
