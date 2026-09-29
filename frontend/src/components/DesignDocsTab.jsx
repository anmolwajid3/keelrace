import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import DiagramView from './DiagramView.jsx'
import { normalizeFlow } from '../lib/flowShape.js'
import ListToolbar from './ListToolbar.jsx'
import ErrorBanner from './ErrorBanner.jsx'
import PageLoading from './PageLoading.jsx'
import LoopSteps from './LoopSteps.jsx'
import { matchesQuery } from '../lib/text.js'
import { useToast } from '../hooks/useToast.jsx'
import NfrAttachPanel from './NfrAttachPanel.jsx'
import DesignAssist from './assist/DesignAssist.jsx'

function statusBadge(status) {
  const cls = status === 'approved' ? 'ok' : status === 'superseded' ? 'muted' : status === 'under_review' ? 'warn' : 'muted'
  return <span className={`badge ${cls}`}>{status.replace('_', ' ')}</span>
}

function docHeading(d, componentsById) {
  const setV = d.requirement_sets?.version
  if (d.type === 'HLD') {
    const n = d.content?.components?.length
    return {
      kicker: setV ? `From requirement set v${setV}` : 'High-level design',
      title: `System map · HLD v${d.version}`,
      sub: n
        ? `${n} component${n === 1 ? '' : 's'}. ${d.content?.summary ? String(d.content.summary).slice(0, 160) : 'How the product is split.'}`
        : (d.content?.summary ? String(d.content.summary).slice(0, 160) : ''),
    }
  }
  const name = componentsById[d.component_id]?.name
  return {
    kicker: setV ? `From requirement set v${setV}` : 'Low-level design',
    title: name ? `${name} · LLD v${d.version}` : `Component design · LLD v${d.version}`,
    sub: name ? 'Internals, interfaces, and data for this one component.' : 'Low-level design for a single HLD component.',
  }
}

export default function DesignDocsTab({ projectId }) {
  const toast = useToast()
  const [docs, setDocs] = useState([])
  const [gatesByDoc, setGatesByDoc] = useState({})
  const [checks, setChecks] = useState({})
  const [prototypesByDoc, setPrototypesByDoc] = useState({})
  const [topologyCount, setTopologyCount] = useState(0)
  const [componentDiagrams, setComponentDiagrams] = useState({}) // hld doc id -> {nodes, edges}
  const [reconciliations, setReconciliations] = useState({}) // hld doc id -> reconciliation row
  const [componentsById, setComponentsById] = useState({})
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [showHistory, setShowHistory] = useState(false)
  const [spikeDraft, setSpikeDraft] = useState({})
  const [loading, setLoading] = useState(true)

  async function load() {
    try {
    const { data } = await supabase
      .from('design_documents')
      .select('*, requirement_sets!inner(project_id, version)')
      .eq('requirement_sets.project_id', projectId)
      .order('version', { ascending: false })
    setDocs(data ?? [])

    const { data: allComps } = await supabase.from('components').select('id, name, hld_document_id, needs_detail').eq('project_id', projectId)
    const compMap = {}
    for (const c of allComps ?? []) compMap[c.id] = c
    setComponentsById(compMap)

    if (data?.length) {
      const { data: gates } = await supabase
        .from('review_gates')
        .select('*')
        .in('target_artifact_id', data.map((d) => d.id))
        .eq('target_artifact_table', 'design_documents')
      const map = {}
      for (const g of gates ?? []) map[g.target_artifact_id] = g
      setGatesByDoc(map)

      const { data: allNfrs } = await supabase.from('nfrs').select('id, name, description, component_id').eq('project_id', projectId)
      const { data: workshopScenarios } = await supabase.from('evaluation_scenarios').select('id, title, in_boundary').eq('project_id', projectId)
      const { data: workshopWalks } = await supabase.from('evaluation_walks').select('id, scenario_id, status, hld_document_id, candidate_id').eq('project_id', projectId)
      const { data: selectedCands } = await supabase.from('architecture_candidates').select('id').eq('project_id', projectId).eq('status', 'selected')
      const selectedIds = new Set((selectedCands ?? []).map((c) => c.id))
      const inBound = (workshopScenarios ?? []).filter((s) => s.in_boundary)

      const checkMap = {}
      for (const d of data) {
        const { data: rationales } = await supabase
          .from('decision_rationales')
          .select('id, risk_level, risk_set_by, decision_point')
          .eq('design_document_id', d.id)
        const rationaleIds = (rationales ?? []).map((r) => r.id)

        // In-scope components: for an HLD, everything it defines; for an
        // LLD, just its own component. Matches approve_design_document()'s
        // per-component NFR scoping (FR-7.1).
        let inScopeComponentIds = []
        if (d.type === 'HLD') {
          const { data: comps } = await supabase.from('components').select('id').eq('hld_document_id', d.id)
          inScopeComponentIds = (comps ?? []).map((c) => c.id)
        } else if (d.component_id) {
          inScopeComponentIds = [d.component_id]
        }

        const inScopeNfrs = (allNfrs ?? []).filter((n) => !n.component_id || inScopeComponentIds.includes(n.component_id))

        let citedNfrIds = new Set()
        if (rationaleIds.length) {
          const { data: citations } = await supabase.from('nfr_citations').select('nfr_id').in('decision_rationale_id', rationaleIds)
          citedNfrIds = new Set((citations ?? []).map((c) => c.nfr_id))
        }
        const uncited = inScopeNfrs.filter((n) => !citedNfrIds.has(n.id))

        const highRisk = (rationales ?? []).filter((r) => r.risk_level === 'high' && r.risk_set_by === 'human')
        const highRiskDetails = []
        for (const r of highRisk) {
          const { data: spikes } = await supabase.from('spike_records').select('id, summary, completed').eq('decision_rationale_id', r.id)
          if (!(spikes ?? []).some((s) => s.completed)) highRiskDetails.push({ ...r, spikes: spikes ?? [] })
        }

        const unwalked = d.type === 'HLD'
          ? inBound.filter((s) => !(workshopWalks ?? []).some((w) =>
            w.scenario_id === s.id
            && w.status !== 'dismissed'
            && (w.hld_document_id === d.id || selectedIds.has(w.candidate_id))
          ))
          : []

        checkMap[d.id] = {
          uncitedNfrs: uncited.length,
          uncitedList: uncited,
          unspikedHighRisk: highRiskDetails.length,
          highRiskDetails,
          firstRationaleId: rationaleIds[0] ?? null,
          unwalkedScenarios: unwalked,
        }
      }
      setChecks(checkMap)

      const { data: protos } = await supabase.from('prototypes').select('*').in('design_document_id', data.map((d) => d.id))
      const protoMap = {}
      for (const p of protos ?? []) {
        protoMap[p.design_document_id] = protoMap[p.design_document_id] || []
        protoMap[p.design_document_id].push(p)
      }
      setPrototypesByDoc(protoMap)
    }

    const { count } = await supabase.from('deployment_topologies').select('id', { count: 'exact', head: true }).eq('project_id', projectId)
    setTopologyCount(count ?? 0)

    // Component diagram: for each HLD, its components as nodes and
    // component-to-component edges rolled up from file-level dependencies.
    const hldDocs = (data ?? []).filter((d) => d.type === 'HLD')
    const diagramMap = {}
    for (const hld of hldDocs) {
      const { data: comps } = await supabase.from('components').select('id, name').eq('hld_document_id', hld.id)
      if (!comps?.length) continue
      const nodes = comps.map((c) => ({ id: c.id, label: c.name }))
      const { data: artifacts } = await supabase.from('code_artifacts').select('id, design_component_id').eq('project_id', projectId).in('design_component_id', comps.map((c) => c.id))
      const artifactToComponent = new Map((artifacts ?? []).map((a) => [a.id, a.design_component_id]))
      let edges = []
      if (artifacts?.length) {
        const { data: deps } = await supabase.from('code_dependencies').select('from_artifact_id, to_artifact_id').in('from_artifact_id', artifacts.map((a) => a.id))
        const seen = new Set()
        for (const dep of deps ?? []) {
          const fromComp = artifactToComponent.get(dep.from_artifact_id)
          const toComp = artifactToComponent.get(dep.to_artifact_id)
          if (fromComp && toComp && fromComp !== toComp) {
            const key = `${fromComp}->${toComp}`
            if (!seen.has(key)) { seen.add(key); edges.push({ from: fromComp, to: toComp }) }
          }
        }
      }
      diagramMap[hld.id] = { nodes, edges }
    }
    setComponentDiagrams(diagramMap)

    // Pending component reconciliations
    if (hldDocs.length) {
      const { data: recs } = await supabase.from('component_reconciliations').select('*').in('hld_document_id', hldDocs.map((d) => d.id))
      const recMap = {}
      for (const r of recs ?? []) recMap[r.hld_document_id] = r
      setReconciliations(recMap)
    }
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [projectId])

  async function confirmReconciliation(rec) {
    const { data: { user } } = await supabase.auth.getUser()
    const { error } = await supabase
      .from('component_reconciliations')
      .update({ confirmed: true, confirmed_by: user.id, confirmed_at: new Date().toISOString() })
      .eq('id', rec.id)
    if (error) setError(error.message)
    else load()
  }

  async function toggleField(doc, field) {
    const { error } = await supabase.from('design_documents').update({ [field]: !doc[field] }).eq('id', doc.id)
    if (error) setError(error.message)
    else load()
  }

  async function citeNfrsOnDocs(docIds) {
    setError(null)
    let cited = 0
    let overridden = 0
    for (const id of docIds) {
      const check = checks[id]
      if (!check?.uncitedList?.length) continue
      if (!check.firstRationaleId) {
        const { error } = await supabase.from('design_documents').update({ nfr_override: true }).eq('id', id)
        if (error) return setError(error.message)
        overridden++
        continue
      }
      const { error } = await supabase.from('nfr_citations').insert(
        check.uncitedList.map((n) => ({ nfr_id: n.id, decision_rationale_id: check.firstRationaleId })),
      )
      if (error && !/duplicate|unique/i.test(error.message)) return setError(error.message)
      cited++
    }
    toast.success(
      overridden && cited
        ? `Attached quality rules on ${cited} design(s). ${overridden} LLD(s) had no decisions — recorded an explicit NFR override.`
        : overridden
          ? `${overridden} LLD(s) had no decisions to cite, so an explicit NFR override was recorded. You can approve them now.`
          : 'Quality requirements are attached to a recorded decision.',
    )
    load()
  }

  async function finishSpike(dr) {
    const summary = (spikeDraft[dr.id] ?? '').trim()
    if (!summary) return
    setError(null)
    const { data, error } = await supabase.from('spike_records').insert({ decision_rationale_id: dr.id, summary }).select().single()
    if (error) return setError(error.message)
    const { error: cErr } = await supabase.from('spike_records').update({ completed: true, completed_at: new Date().toISOString() }).eq('id', data.id)
    if (cErr) return setError(cErr.message)
    setSpikeDraft({ ...spikeDraft, [dr.id]: '' })
    toast.success('Spike recorded. High-uncertainty is no longer blocking this design.')
    load()
  }

  const visible = useMemo(() => docs.filter((d) => {
    if (typeFilter !== 'all' && d.type !== typeFilter) return false
    if (statusFilter !== 'all' && d.status !== statusFilter) return false
    const name = componentsById[d.component_id]?.name ?? ''
    return matchesQuery(`${d.type} v${d.version} ${name} ${d.content?.summary ?? ''}`, search)
  }), [docs, typeFilter, statusFilter, search, componentsById])

  const latestHldVersion = useMemo(
    () => docs.filter((d) => d.type === 'HLD').reduce((m, d) => Math.max(m, d.version), 0),
    [docs],
  )

  const grouped = useMemo(() => {
    let hlds = visible.filter((d) => d.type === 'HLD')
    if (!showHistory && latestHldVersion) hlds = hlds.filter((d) => d.version === latestHldVersion)
    const llds = visible.filter((d) => d.type === 'LLD')
    const used = new Set()
    const groups = hlds.map((hld) => {
      const children = llds.filter((lld) => {
        const match = componentsById[lld.component_id]?.hld_document_id === hld.id
        if (match) used.add(lld.id)
        return match
      })
      return { hld, children }
    })
    const orphans = llds.filter((l) => !used.has(l.id))
    if (!hlds.length && llds.length) return { groups: [], orphans: llds }
    return { groups, orphans }
  }, [visible, componentsById, showHistory, latestHldVersion])

  function renderDoc(d, nested) {
    const gate = gatesByDoc[d.id]
    const check = checks[d.id] ?? {}
    const heading = docHeading(d, componentsById)
    return (
      <div key={d.id} className="card" style={nested ? { marginBottom: 8 } : undefined}>
        <div className="row between wrap" style={{ alignItems: 'flex-start' }}>
          <div style={{ minWidth: 0 }}>
            <span className="doc-kicker">{heading.kicker} · {d.type}</span>
            <h2 className="doc-title">{heading.title}</h2>
            {heading.sub && <p className="doc-sub">{heading.sub}</p>}
            <div className="row wrap" style={{ marginTop: 8 }}>
              {statusBadge(d.status)}
              {d.needs_review && <span className="badge warn">needs review</span>}
              {gate && <span className={`badge ${gate.status === 'approved' ? 'ok' : 'muted'}`}>gate: {gate.status}</span>}
              {d.status === 'approved' && topologyCount === 0 && (
                <span className="badge warn">incomplete: no deployment topology</span>
              )}
            </div>
          </div>
        </div>

        {d.type === 'HLD' && reconciliations[d.id] && !reconciliations[d.id].confirmed && (
          <div className="card" style={{ background: 'transparent', borderColor: 'var(--danger)' }}>
            <strong>Component reconciliation needed before approval</strong>
            {reconciliations[d.id].vanished_family_keys?.length > 0 && (
              <p className="muted">
                Vanished vs. the prior HLD: {reconciliations[d.id].vanished_family_keys.join(', ')} — confirm this is intentional (removed/renamed beyond recognition), not a matching miss.
              </p>
            )}
            {reconciliations[d.id].new_family_keys?.length > 0 && (
              <p className="muted">New: {reconciliations[d.id].new_family_keys.join(', ')}</p>
            )}
            <button className="secondary" onClick={() => confirmReconciliation(reconciliations[d.id])}>Confirm reconciliation</button>
          </div>
        )}

        {d.status !== 'approved' && (check.uncitedNfrs > 0 || check.unspikedHighRisk > 0 || (check.unwalkedScenarios?.length ?? 0) > 0) && (
          <div className="card" style={{ background: 'transparent', borderColor: 'var(--warn)' }}>
            <p style={{ marginTop: 0 }}><strong>Why you cannot review yet</strong></p>
            <p className="muted">Approval is blocked until quality rules are attached, architect-set high risk has a spike, and in-workshop scenarios have a walk. Walks are on Evidence map / Architect assist. This is not a quality score.</p>
            {check.uncitedNfrs > 0 && (
              <NfrAttachPanel
                projectId={projectId}
                documentId={d.id}
                uncitedNfrs={check.uncitedList}
                onDone={load}
                context={{
                  type: d.type,
                  version: d.version,
                  componentName: componentsById[d.component_id]?.name,
                  components: d.type === 'HLD' ? Object.values(componentsById).filter((c) => c.hld_document_id === d.id) : [],
                }}
              />
            )}
            {check.highRiskDetails?.map((dr) => (
              <div key={dr.id} style={{ marginBottom: 10 }}>
                <p className="muted">High-uncertainty (architect-set): {dr.decision_point}</p>
                <div className="row wrap">
                  <input
                    placeholder="One sentence: what you would verify"
                    value={spikeDraft[dr.id] ?? ''}
                    onChange={(e) => setSpikeDraft({ ...spikeDraft, [dr.id]: e.target.value })}
                  />
                  <button type="button" className="secondary" onClick={() => finishSpike(dr)} disabled={!(spikeDraft[dr.id] ?? '').trim()}>
                    Record spike
                  </button>
                </div>
              </div>
            ))}
            {(check.unwalkedScenarios?.length ?? 0) > 0 && (
              <p className="muted">
                Unwalked workshop scenarios: {check.unwalkedScenarios.map((s) => s.title).join('; ')}. Open Evidence map and walk them, or mark them out of the workshop.
              </p>
            )}
          </div>
        )}

        <details style={{ marginTop: 8 }}>
          <summary className="muted">Advanced flags</summary>
          <label className="muted row" style={{ gap: 6, marginTop: 8 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={d.crosses_trust_boundary} onChange={() => toggleField(d, 'crosses_trust_boundary')} />
            Crosses a trust boundary (optional — only if you want a threat model later)
          </label>
        </details>

        <p className="muted">Generated {new Date(d.generated_at).toLocaleString()} by {d.generated_by_model ?? 'manual'}</p>
        <details open={d.type === 'HLD' && !nested}>
          <summary className="muted">{d.type === 'HLD' ? 'Components and summary' : 'Interfaces and data model'}</summary>
          <DesignDocContent type={d.type} content={d.content} />
        </details>
        {d.type === 'HLD' && componentDiagrams[d.id]?.nodes.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <h3>Components in this HLD</h3>
            <p className="muted">Boxes are components from this design. Arrows appear after a skeleton exists in Diagram / Traceability.</p>
            <DiagramView nodes={componentDiagrams[d.id].nodes} edges={componentDiagrams[d.id].edges} />
          </div>
        )}
        {(prototypesByDoc[d.id] ?? []).map((p) => <PrototypeView key={p.id} prototype={p} />)}
      </div>
    )
  }

  return (
    <div>
      <h1>Design Documents</h1>
      <LoopSteps current="design" projectId={projectId} paths={{ requirements: '..', design: '.', review: '../review', package: '../package' }} />
      <DesignAssist projectId={projectId} />
      {(() => {
        const current = grouped.groups[0]
        if (!current) return null
        const { hld, children } = current
        const check = checks[hld.id] ?? {}
        const blocked = hld.status !== 'approved' && (check.uncitedNfrs > 0 || check.unspikedHighRisk > 0 || (check.unwalkedScenarios?.length ?? 0) > 0)
        return (
          <div className="card work-panel">
            <span className="doc-kicker">This page, once</span>
            <h2 className="doc-title">Current work: HLD v{hld.version}</h2>
            <p className="doc-sub">
              Read the system map and attach the quality rules. Approval is the next page.
              Prototype and skeleton are created on Diagram / Traceability after Review, so this page is not a second stop.
            </p>
            <ol>
              <li>Read the system map card underneath.</li>
              <li>
                If the yellow box is showing, click <strong>Suggest matches</strong> on that card, tick one/many/none (or add your own), then Apply.
                Coarse bulk (every uncited rule onto the first decision) is still available:{' '}
                <button type="button" className="secondary" onClick={() => citeNfrsOnDocs([hld.id, ...children.map((c) => c.id)])}>
                  Attach all uncited rules to the first decision (coarse)
                </button>
              </li>
              <li>
                {blocked
                  ? 'Review is locked until the yellow box is gone.'
                  : (
                    <Link to={`../review?doc=${hld.id}`}>Open Review for this HLD</Link>
                  )}
              </li>
            </ol>
          </div>
        )
      })()}
      {error && <ErrorBanner error={error} />}
      {loading && <PageLoading />}
      <ListToolbar search={search} onSearch={setSearch} placeholder="Search by type, component, or summary…">
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
          <option value="all">All types</option>
          <option value="HLD">HLD (system map)</option>
          <option value="LLD">LLD (one component)</option>
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="all">All statuses</option>
          <option value="draft">draft</option>
          <option value="under_review">under_review</option>
          <option value="approved">approved</option>
          <option value="superseded">superseded</option>
        </select>
        <label className="muted row" style={{ gap: 6, width: 'auto' }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={showHistory} onChange={(e) => setShowHistory(e.target.checked)} />
          Show older generates
        </label>
      </ListToolbar>
      {grouped.groups.map(({ hld, children }) => (
        <div key={hld.id}>
          {renderDoc(hld, false)}
          {children.length > 0 && (
            <details className="lld-stack">
              <summary className="doc-kicker">
                {children.length} component design{children.length === 1 ? '' : 's'} (LLD) — open after the HLD is unblocked
              </summary>
              {children.map((lld) => renderDoc(lld, true))}
            </details>
          )}
        </div>
      ))}
      {grouped.orphans.map((d) => renderDoc(d, false))}
      {!docs.length && <p className="muted">No design documents yet. Lock a RequirementSet and generate from the Requirements tab.</p>}
    </div>
  )
}

function PrototypeView({ prototype }) {
  const { nodes, edges } = normalizeFlow(prototype.content)
  return (
    <div className="card" style={{ marginTop: 8, background: 'transparent' }}>
      <div className="row between">
        <strong>Prototype: {prototype.type}</strong>
        <span className="muted">{new Date(prototype.generated_at).toLocaleDateString()}</span>
      </div>
      <DiagramView nodes={nodes} edges={edges} height={320} />
    </div>
  )
}

function DesignDocContent({ type, content }) {
  if (!content || (Array.isArray(content.components) === false && !content.summary && !content.interfaces)) {
    return <p className="muted">No content yet.</p>
  }
  if (type === 'HLD') {
    return (
      <div>
        {content.summary && <p>{content.summary}</p>}
        {content.components?.length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}>
                <th style={{ padding: 6 }}>Component</th>
                <th style={{ padding: 6 }}>Description</th>
                <th style={{ padding: 6 }}>Needs LLD</th>
              </tr>
            </thead>
            <tbody>
              {content.components.map((c, i) => (
                <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: 6 }}>{c.name}</td>
                  <td style={{ padding: 6 }} className="muted">{c.description}</td>
                  <td style={{ padding: 6 }}>{c.needs_detail ? <span className="badge warn">yes</span> : <span className="badge muted">no</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    )
  }
  // LLD
  return (
    <div>
      {content.summary && <p>{content.summary}</p>}
      {content.interfaces?.length > 0 && (
        <>
          <h3>Interfaces</h3>
          <ul>{content.interfaces.map((i, idx) => <li key={idx} className="muted">{i}</li>)}</ul>
        </>
      )}
      {content.data_model && (
        <>
          <h3>Data model</h3>
          <p className="muted">{content.data_model}</p>
        </>
      )}
    </div>
  )
}
