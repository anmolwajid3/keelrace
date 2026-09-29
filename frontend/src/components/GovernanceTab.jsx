import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import ListToolbar from './ListToolbar.jsx'
import ErrorBanner from './ErrorBanner.jsx'
import PageLoading from './PageLoading.jsx'
import { matchesQuery } from '../lib/text.js'

export default function GovernanceTab({ projectId }) {
  const [topologies, setTopologies] = useState([])
  const [threatDocs, setThreatDocs] = useState([]) // design_documents that cross a trust boundary
  const [threatModels, setThreatModels] = useState({})
  const [deprecations, setDeprecations] = useState([])
  const [artifacts, setArtifacts] = useState([])
  const [error, setError] = useState(null)

  const [envForm, setEnvForm] = useState({ environment: '', structure: '{\n  "nodes": [\n    { "name": "api", "type": "service", "notes": "2 replicas" }\n  ]\n}' })
  const [threatForm, setThreatForm] = useState({})
  const [depSearch, setDepSearch] = useState('')
  const [loading, setLoading] = useState(true)

  async function load() {
    const { data: topo } = await supabase.from('deployment_topologies').select('*').eq('project_id', projectId).order('environment')
    setTopologies(topo ?? [])

    const { data: docs } = await supabase
      .from('design_documents')
      .select('id, type, version, requirement_sets!inner(project_id)')
      .eq('requirement_sets.project_id', projectId)
      .eq('crosses_trust_boundary', true)
    setThreatDocs(docs ?? [])
    if (docs?.length) {
      const { data: tms } = await supabase.from('threat_models').select('*').in('design_document_id', docs.map((d) => d.id))
      const map = {}
      for (const t of tms ?? []) map[t.design_document_id] = t
      setThreatModels(map)
    }

    const { data: arts } = await supabase.from('code_artifacts').select('id, path').eq('project_id', projectId)
    setArtifacts(arts ?? [])
    const { data: deps } = await supabase.from('deprecation_records').select('*, code_artifacts(path)')
    setDeprecations((deps ?? []).filter((d) => (arts ?? []).some((a) => a.id === d.code_artifact_id)))
    setLoading(false)
  }
  useEffect(() => { load() }, [projectId])

  async function addTopology(e) {
    e.preventDefault()
    setError(null)
    let structure
    try { structure = JSON.parse(envForm.structure) } catch { return setError('Structure must be valid JSON') }
    const { data: prior } = await supabase
      .from('deployment_topologies')
      .select('version')
      .eq('project_id', projectId).eq('environment', envForm.environment)
      .order('version', { ascending: false }).limit(1).maybeSingle()
    const { error } = await supabase.from('deployment_topologies').insert({
      project_id: projectId, environment: envForm.environment, version: (prior?.version ?? 0) + 1, structure,
    })
    if (error) setError(error.message)
    else { setEnvForm({ environment: '', structure: '{\n  "nodes": []\n}' }); load() }
  }

  async function addThreatModel(doc) {
    const f = threatForm[doc.id] ?? {}
    const { error } = await supabase.from('threat_models').insert({
      design_document_id: doc.id,
      trust_boundaries: (f.boundaries ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      data_flows: (f.flows ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      identified_threats: (f.threats ?? '').split(',').map((s) => ({ description: s.trim(), stride_category: f.stride ?? 'Other' })).filter((t) => t.description),
    })
    if (error) setError(error.message)
    else load()
  }

  async function markDeprecation(artifactId, status) {
    const { data: existing } = await supabase.from('deprecation_records').select('*').eq('code_artifact_id', artifactId).maybeSingle()
    const { error } = existing
      ? await supabase.from('deprecation_records').update({ status, removed_at: status === 'removed' ? new Date().toISOString() : null }).eq('id', existing.id)
      : await supabase.from('deprecation_records').insert({ code_artifact_id: artifactId, status })
    if (error) setError(error.message)
    else load()
  }

  return (
    <div>
      <h1>Governance</h1>
      {error && <ErrorBanner error={error} />}
      {loading && <PageLoading />}

      <h2>Deployment Topology (FR-9.3)</h2>
      {!topologies.length && <p className="badge warn">No topology defined for any environment yet — flagged incomplete.</p>}
      <form onSubmit={addTopology} className="card">
        <div className="grid-2">
          <input placeholder="Environment (e.g. prod)" value={envForm.environment} onChange={(e) => setEnvForm({ ...envForm, environment: e.target.value })} required />
        </div>
        <textarea rows={4} style={{ marginTop: 8 }} value={envForm.structure} onChange={(e) => setEnvForm({ ...envForm, structure: e.target.value })} />
        <div style={{ marginTop: 8 }}><button type="submit">Save topology version</button></div>
      </form>
      {topologies.map((t) => (
        <div key={t.id} className="card">
          <div className="row between">
            <strong>{t.environment} v{t.version}</strong>
            <span className="muted">{new Date(t.created_at).toLocaleDateString()}</span>
          </div>
          <TopologyView structure={t.structure} />
        </div>
      ))}

      <h2 style={{ marginTop: 24 }}>Threat Models (FR-9.4)</h2>
      <p className="muted">Design documents marked "crosses a trust boundary" (Design Docs tab) without a ThreatModel are flagged here.</p>
      {threatDocs.map((d) => (
        <div key={d.id} className="card">
          <div className="row between">
            <strong>{d.type} v{d.version}</strong>
            {threatModels[d.id] ? <span className="badge ok">has ThreatModel</span> : <span className="badge danger">missing ThreatModel</span>}
          </div>
          {threatModels[d.id] && (
            <div style={{ marginTop: 8 }}>
              <p className="muted">Trust boundaries: {threatModels[d.id].trust_boundaries?.join(', ') || '—'}</p>
              <p className="muted">Data flows: {threatModels[d.id].data_flows?.join(', ') || '—'}</p>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14, marginTop: 8 }}>
                <thead>
                  <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}>
                    <th style={{ padding: 6 }}>Threat</th>
                    <th style={{ padding: 6 }}>STRIDE category</th>
                  </tr>
                </thead>
                <tbody>
                  {(threatModels[d.id].identified_threats ?? []).map((t, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ padding: 6 }}>{t.description}</td>
                      <td style={{ padding: 6 }} className="muted">{t.stride_category}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!threatModels[d.id] && (
            <div style={{ marginTop: 8 }}>
              <input placeholder="Trust boundaries, comma-separated" style={{ marginBottom: 6 }}
                onChange={(e) => setThreatForm({ ...threatForm, [d.id]: { ...threatForm[d.id], boundaries: e.target.value } })} />
              <input placeholder="Data flows, comma-separated" style={{ marginBottom: 6 }}
                onChange={(e) => setThreatForm({ ...threatForm, [d.id]: { ...threatForm[d.id], flows: e.target.value } })} />
              <input placeholder="Identified threats, comma-separated" style={{ marginBottom: 6 }}
                onChange={(e) => setThreatForm({ ...threatForm, [d.id]: { ...threatForm[d.id], threats: e.target.value } })} />
              <select style={{ marginBottom: 6 }} defaultValue="Spoofing"
                onChange={(e) => setThreatForm({ ...threatForm, [d.id]: { ...threatForm[d.id], stride: e.target.value } })}>
                {['Spoofing', 'Tampering', 'Repudiation', 'Information Disclosure', 'Denial of Service', 'Elevation of Privilege'].map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              <button className="secondary" onClick={() => addThreatModel(d)}>Save ThreatModel</button>
            </div>
          )}
        </div>
      ))}
      {!threatDocs.length && <p className="muted">No documents currently marked as crossing a trust boundary.</p>}

      <h2 style={{ marginTop: 24 }}>Deprecation Tracking (FR-9.5)</h2>
      <ListToolbar search={depSearch} onSearch={setDepSearch} placeholder="Search artifacts…" />
      {artifacts.filter((a) => matchesQuery(a.path, depSearch)).map((a) => {
        const rec = deprecations.find((d) => d.code_artifact_id === a.id)
        return (
          <div key={a.id} className="card row between">
            <span>{a.path}</span>
            <div className="row">
              <span className="badge muted">{rec?.status ?? 'active'}</span>
              {(!rec || rec.status === 'marked') && <button className="secondary" onClick={() => markDeprecation(a.id, rec ? 'dependents_migrated' : 'marked')}>{rec ? 'Mark dependents migrated' : 'Mark deprecated'}</button>}
              {rec?.status === 'dependents_migrated' && <button className="danger" onClick={() => markDeprecation(a.id, 'removed')}>Remove</button>}
            </div>
          </div>
        )
      })}
      {!artifacts.length && <p className="muted">No code artifacts yet.</p>}
    </div>
  )
}

function TopologyView({ structure }) {
  const nodes = structure?.nodes ?? []
  if (!nodes.length) return <p className="muted">No nodes defined.</p>
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14, marginTop: 8 }}>
      <thead>
        <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)' }}>
          <th style={{ padding: 6 }}>Node</th>
          <th style={{ padding: 6 }}>Type</th>
          <th style={{ padding: 6 }}>Notes</th>
        </tr>
      </thead>
      <tbody>
        {nodes.map((n, i) => (
          <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
            <td style={{ padding: 6 }}>{n.name ?? n.id ?? `node ${i + 1}`}</td>
            <td style={{ padding: 6 }} className="muted">{n.type ?? '—'}</td>
            <td style={{ padding: 6 }} className="muted">{n.notes ?? ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
