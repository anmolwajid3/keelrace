import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { loadProjectProgress } from '../lib/progress.js'
import { buildPackageHtml, pickCanonicalHld, pickCanonicalLlds, productTitle } from '../lib/packageTemplate.js'
import ErrorBanner from './ErrorBanner.jsx'
import PageLoading from './PageLoading.jsx'
import { useToast } from '../hooks/useToast.jsx'

export default function PackageTab({ projectId }) {
  const toast = useToast()
  const [html, setHtml] = useState('')
  const [progress, setProgress] = useState(null)
  const [filename, setFilename] = useState('architecture-package')
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)

  async function load() {
    setError(null)
    try {
      const progressNow = await loadProjectProgress(supabase, projectId)
      const { data: project } = await supabase.from('projects').select('id, name').eq('id', projectId).single()
      const { data: sets } = await supabase.from('requirement_sets').select('*').eq('project_id', projectId).order('version', { ascending: false })
      const latestSet = sets?.[0]
      let reqs = []
      if (latestSet) {
        const { data } = await supabase.from('requirements').select('ref_code, title, body').eq('requirement_set_id', latestSet.id).order('ref_code')
        reqs = data ?? []
      }
      const { data: nfrs } = await supabase.from('nfrs').select('name, description').eq('project_id', projectId)
      const { data: docs } = await supabase
        .from('design_documents')
        .select('id, type, version, status, content, component_id, requirement_sets!inner(project_id)')
        .eq('requirement_sets.project_id', projectId)
        .order('version', { ascending: false })
      const hld = pickCanonicalHld(docs ?? [])
      const { data: components } = await supabase.from('components').select('id, name, description, hld_document_id').eq('project_id', projectId)
      const scopedComponents = (components ?? []).filter((c) => !hld || c.hld_document_id === hld.id)
      const llds = pickCanonicalLlds((docs ?? []).filter((d) => d.type === 'LLD'), scopedComponents.map((c) => c.id))
      let decisions = []
      if (hld) {
        const { data } = await supabase.from('decision_rationales').select('decision_point, chosen_option, risk_level, status, alternatives_considered').eq('design_document_id', hld.id)
        decisions = data ?? []
      }
      let prototypes = []
      if (hld) {
        const { data } = await supabase.from('prototypes').select('type, content, generated_at').eq('design_document_id', hld.id)
        prototypes = data ?? []
      }
      const { data: artifacts } = await supabase.from('code_artifacts').select('path, type').eq('project_id', projectId).order('path')
      const { data: ruleRows } = await supabase
        .from('standing_rules')
        .select('id, rule_text, ends_when, covers, status')
        .eq('project_id', projectId)
      const ruleIds = (ruleRows ?? []).map((r) => r.id)
      let replacedReason = {}
      if (ruleIds.length) {
        const { data: verdicts } = await supabase
          .from('rule_verdicts')
          .select('standing_rule_id, reason, created_at')
          .in('standing_rule_id', ruleIds)
          .eq('result', 'replaces')
          .order('created_at', { ascending: false })
        for (const v of verdicts ?? []) {
          if (!replacedReason[v.standing_rule_id]) replacedReason[v.standing_rule_id] = v.reason
        }
      }
      const rules = (ruleRows ?? []).map((r) => ({ ...r, replaced_reason: replacedReason[r.id] || '' }))
      const { data: snapshots } = await supabase.from('architecture_snapshots').select('id, label, created_at').eq('project_id', projectId)
      const built = buildPackageHtml({
        project,
        set: latestSet,
        reqs,
        nfrs: nfrs ?? [],
        hld,
        llds,
        components: scopedComponents,
        decisions,
        prototypes,
        artifacts: artifacts ?? [],
        snapshots: snapshots ?? [],
        rules,
        progress: progressNow,
      })
      const title = productTitle(project, hld)
      const slug = String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'architecture'
      setHtml(built)
      setProgress(progressNow)
      setFilename(`${slug}-architecture-v${hld?.version || 1}`)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [projectId])

  function download(filename, text, type) {
    const blob = new Blob([text], { type })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  function downloadHtml() {
    download(`${filename}.html`, html, 'text/html')
    toast.success('HTML package downloaded. Word can open this file; diagrams stay as SVG.')
  }

  function downloadDoc() {
    download(`${filename}.doc`, html, 'application/msword')
    toast.success('Word-compatible .doc downloaded. Open it in Word, then File → Save As → PDF if you need a PDF.')
  }

  function printPdf() {
    const w = window.open('', '_blank')
    if (!w) return setError('Allow pop-ups to print or save as PDF.')
    w.document.write(html)
    w.document.close()
    w.focus()
    w.print()
  }

  const remaining = progress?.remaining ?? []
  const ready = remaining.length === 0

  return (
    <div>
      <h1>Architecture package</h1>
      <p className="muted">
        This is the brief you would take into a review: the rules still in force, the questions that were settled, the answers that were refused, and which component owns which file. Preview it, then export.
      </p>
      {error && <ErrorBanner error={error} />}
      {loading && <PageLoading />}
      {progress && (
        <div className={`card ${ready ? '' : ''}`}>
          <p><strong>{progress.completed}/{progress.total} sections filled.</strong></p>
          {!ready && (
            <p className="muted">Remaining: {remaining.map((s) => `${s.n}. ${s.label}`).join(' · ')}. You can still export a draft; empty sections stay marked.</p>
          )}
          <div className="row wrap">
            <button type="button" onClick={downloadHtml}>Download HTML</button>
            <button type="button" className="secondary" onClick={downloadDoc}>Download Word (.doc)</button>
            <button type="button" className="secondary" onClick={printPdf}>Print / Save as PDF</button>
          </div>
        </div>
      )}
      <div className="card">
        <span className="doc-kicker">Preview</span>
        <h2 className="doc-title">What will be in the file</h2>
        {html && (
          <iframe title="Architecture package preview" className="package-preview" srcDoc={html} />
        )}
      </div>
    </div>
  )
}
