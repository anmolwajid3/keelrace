import { useEffect, useState } from 'react'
import JSZip from 'jszip'
import { supabase, callFunction } from '../lib/supabase'
import ListToolbar from './ListToolbar.jsx'
import { IconTrash } from './Icons.jsx'
import ErrorBanner from './ErrorBanner.jsx'
import PageLoading from './PageLoading.jsx'
import DiagramView from './DiagramView.jsx'
import { normalizeFlow } from '../lib/flowShape.js'
import { matchesQuery } from '../lib/text.js'
import { useToast } from '../hooks/useToast.jsx'
import MapAssist from './assist/MapAssist.jsx'

export default function TraceabilityTab({ projectId }) {
  const [components, setComponents] = useState([])
  const [decisionsByComponent, setDecisionsByComponent] = useState({})
  const [generations, setGenerations] = useState([])
  const [activeGeneration, setActiveGeneration] = useState(null)
  const [artifacts, setArtifacts] = useState([])
  const [dependencies, setDependencies] = useState([])
  const [depForm, setDepForm] = useState({ from: '', to: '', critical: false })
  const [openFile, setOpenFile] = useState(null) // artifact id currently expanded
  const [error, setError] = useState(null)
  const [fileSearch, setFileSearch] = useState('')
  const [loading, setLoading] = useState(true)

  async function load(generationOverride) {
    try {
    const { data: comps, error: cErr } = await supabase.from('components').select('*').eq('project_id', projectId)
    if (cErr) {
      setError(cErr.message)
      return
    }
    setComponents(comps ?? [])

    if (comps?.length) {
      const { data: drs } = await supabase.from('decision_rationales').select('id, decision_point, component_id').in('component_id', comps.map((c) => c.id))
      const map = {}
      for (const dr of drs ?? []) {
        map[dr.component_id] = map[dr.component_id] || []
        map[dr.component_id].push(dr)
      }
      setDecisionsByComponent(map)
    }

    const { data: gens } = await supabase
      .from('code_artifacts')
      .select('generation_version')
      .eq('project_id', projectId)
      .order('generation_version', { ascending: false })
    const versions = [...new Set((gens ?? []).map((g) => g.generation_version))]
    setGenerations(versions)
    const activeVersion = generationOverride ?? versions[0] ?? null
    setActiveGeneration(activeVersion)

    if (activeVersion == null) {
      setArtifacts([])
      setDependencies([])
      return
    }

    const { data: arts, error: aErr } = await supabase
      .from('code_artifacts')
      .select('id, path, type, design_component_id, content, generation_version')
      .eq('project_id', projectId)
      .eq('generation_version', activeVersion)
      .order('path')
    if (aErr) return setError(aErr.message)
    setArtifacts(arts ?? [])
    const firstFile = (arts ?? []).find((a) => a.type === 'file')
    setOpenFile(firstFile?.id ?? null)

    if (arts?.length) {
      const { data: deps } = await supabase.from('code_dependencies').select('*').in('from_artifact_id', arts.map((a) => a.id))
      setDependencies(deps ?? [])
    } else {
      setDependencies([])
    }
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [projectId])

  async function addDependency(e) {
    e.preventDefault()
    if (!depForm.from || !depForm.to || depForm.from === depForm.to) return
    const { error } = await supabase.from('code_dependencies').insert({
      from_artifact_id: depForm.from,
      to_artifact_id: depForm.to,
      is_critical_path: depForm.critical,
    })
    if (error) setError(error.message)
    else { setDepForm({ from: '', to: '', critical: false }); load(activeGeneration) }
  }

  async function downloadZip() {
    const files = artifacts.filter((a) => a.type === 'file')
    if (!files.length) {
      setError('This generation has no files to zip.')
      return
    }
    const zip = new JSZip()
    for (const file of files) {
      const path = String(file.path || 'untitled').replace(/^\/+/, '')
      zip.file(path, file.content ?? '')
    }
    const blob = await zip.generateAsync({ type: 'blob' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `skeleton-v${activeGeneration}.zip`
    a.click()
    URL.revokeObjectURL(url)
  }

  async function removeDependency(id) {
    const { error } = await supabase.from('code_dependencies').delete().eq('id', id)
    if (error) setError(error.message)
    else load(activeGeneration)
  }

  const byComponent = {}
  const unlinked = []
  for (const a of artifacts) {
    if (a.design_component_id) {
      byComponent[a.design_component_id] = byComponent[a.design_component_id] || []
      byComponent[a.design_component_id].push(a)
    } else if (a.type === 'file') {
      unlinked.push(a)
    }
  }

  return (
    <div>
      <h1>Diagram ↔ Code Traceability</h1>
      <p className="muted">
        Files are linked to components by identity, not by filename. Prototype and skeleton are created on this page, after Review, so Design Docs is not a second stop.
      </p>
      <BuildOutputs projectId={projectId} onSkeleton={() => load()} />
      {error && <ErrorBanner error={error} />}
      {loading && <PageLoading />}
      <MapAssist projectId={projectId} artifacts={artifacts} onApplied={() => load(activeGeneration)} />
      <ListToolbar search={fileSearch} onSearch={setFileSearch} placeholder="Search files…" />

      {generations.length > 0 && (
        <div className="card row between">
          <div className="row">
            <span className="muted">Skeleton generation:</span>
            <select value={activeGeneration ?? ''} onChange={(e) => load(Number(e.target.value))}>
              {generations.map((v) => <option key={v} value={v}>v{v}{v === generations[0] ? ' (latest)' : ''}</option>)}
            </select>
          </div>
          <button type="button" onClick={downloadZip}>Download zip</button>
        </div>
      )}

      <div className="code-split">
        <div>
          {components.map((comp) => (
            <div key={comp.id} className="card">
              <div className="row between">
                <strong>{comp.name}</strong>
                <span className="muted">{comp.reference_code}</span>
              </div>
              <p className="muted">{comp.description}</p>
              <h3>Shaping decisions</h3>
              <ul>
                {(decisionsByComponent[comp.id] ?? []).map((dr) => <li key={dr.id} className="muted">{dr.decision_point}</li>)}
              </ul>
              {!(decisionsByComponent[comp.id] ?? []).length && <p className="muted">No decisions linked to this component yet.</p>}
              <h3>Files</h3>
              {(byComponent[comp.id] ?? []).filter((a) => matchesQuery(a.path, fileSearch)).map((a) => (
                <FilePreviewButton
                  key={a.id}
                  artifact={a}
                  active={openFile === a.id}
                  onSelect={() => setOpenFile(a.id)}
                />
              ))}
              {!(byComponent[comp.id] ?? []).length && <p className="muted">No files linked yet.</p>}
            </div>
          ))}
          {!components.length && <p className="muted">No components yet — generate an HLD first.</p>}
          <div className="card" style={{ borderColor: 'var(--warn)' }}>
            <strong>Unlinked files</strong>
            <p className="muted">Shown here on purpose, never dropped silently.</p>
            {unlinked.filter((a) => matchesQuery(a.path, fileSearch)).map((a) => (
              <FilePreviewButton key={a.id} artifact={a} active={openFile === a.id} onSelect={() => setOpenFile(a.id)} />
            ))}
            {!unlinked.length && <p className="muted">None — every file traces to a component.</p>}
          </div>
        </div>
        <CodePreview artifact={artifacts.find((a) => a.id === openFile)} />
      </div>

      <h2 style={{ marginTop: 24 }}>Dependency Graph</h2>
      <p className="muted">Feeds FR-4.3 blast-radius severity and FR-7.3/10.4 impact scoping. Scoped to the active generation above.</p>
      <form onSubmit={addDependency} className="card">
        <div className="grid-2">
          <select value={depForm.from} onChange={(e) => setDepForm({ ...depForm, from: e.target.value })} required>
            <option value="">— depends on (from) —</option>
            {artifacts.filter((a) => a.type === 'file').map((a) => <option key={a.id} value={a.id}>{a.path}</option>)}
          </select>
          <select value={depForm.to} onChange={(e) => setDepForm({ ...depForm, to: e.target.value })} required>
            <option value="">— target (to) —</option>
            {artifacts.filter((a) => a.type === 'file').map((a) => <option key={a.id} value={a.id}>{a.path}</option>)}
          </select>
        </div>
        <label className="row muted" style={{ marginTop: 8, gap: 6 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={depForm.critical} onChange={(e) => setDepForm({ ...depForm, critical: e.target.checked })} />
          Critical path
        </label>
        <div style={{ marginTop: 8 }}><button type="submit">Add edge</button></div>
      </form>
      {dependencies.filter((d) => {
        const from = artifacts.find((a) => a.id === d.from_artifact_id)?.path ?? ''
        const to = artifacts.find((a) => a.id === d.to_artifact_id)?.path ?? ''
        return matchesQuery(`${from} ${to}`, fileSearch)
      }).map((d) => {
        const from = artifacts.find((a) => a.id === d.from_artifact_id)?.path ?? d.from_artifact_id
        const to = artifacts.find((a) => a.id === d.to_artifact_id)?.path ?? d.to_artifact_id
        return (
          <div key={d.id} className="card row between">
            <span>{from} → {to}</span>
            <div className="row">
              {d.is_critical_path && <span className="badge danger">critical path</span>}
              <button type="button" className="icon-btn danger-icon" title="Remove edge" aria-label="Remove dependency" onClick={() => removeDependency(d.id)}>
                <IconTrash />
              </button>
            </div>
          </div>
        )
      })}
      {!dependencies.length && <p className="muted">No dependency edges recorded yet.</p>}
    </div>
  )
}

function FilePreviewButton({ artifact, active, onSelect }) {
  if (artifact.type === 'directory') {
    return <p className="muted" style={{ margin: '4px 0' }}>{artifact.path}/ <span className="badge muted">directory</span></p>
  }
  return (
    <button type="button" className={`code-file${active ? ' active' : ''}`} onClick={onSelect}>
      <strong style={{ fontSize: 13 }}>{artifact.path}</strong>
    </button>
  )
}

function CodePreview({ artifact }) {
  if (!artifact || artifact.type === 'directory') {
    return <p className="muted">Select a file to read it here. Download zip saves this generation as a folder.</p>
  }
  return (
    <div>
      <p className="muted" style={{ marginTop: 0 }}>{artifact.path}</p>
      <pre className="code-view">{artifact.content || '(empty file)'}</pre>
    </div>
  )
}

function BuildOutputs({ projectId, onSkeleton }) {
  const toast = useToast()
  const [hld, setHld] = useState(null)
  const [prototypes, setPrototypes] = useState([])
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)

  async function loadHld() {
    const { data: docs, error: docErr } = await supabase
      .from('design_documents')
      .select('id, version, status, type, requirement_sets!inner(project_id)')
      .eq('requirement_sets.project_id', projectId)
      .eq('type', 'HLD')
      .order('version', { ascending: false })
      .limit(1)
    if (docErr) {
      setError(docErr.message)
      return
    }
    const latest = docs?.[0] ?? null
    setHld(latest)
    if (!latest) {
      setPrototypes([])
      return
    }
    const { data: protos } = await supabase
      .from('prototypes')
      .select('*')
      .eq('design_document_id', latest.id)
      .order('generated_at', { ascending: false })
    setPrototypes(protos ?? [])
  }

  useEffect(() => { loadHld() }, [projectId])

  async function genPrototype() {
    if (!hld) return
    setBusy('proto')
    setError(null)
    try {
      await callFunction('generate-prototype', { design_document_id: hld.id, type: 'flow-diagram' })
      await loadHld()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(null)
    }
  }

  async function genSkeleton() {
    if (!hld) return
    setBusy('skel')
    setError(null)
    try {
      const res = await callFunction('generate-skeleton', { project_id: projectId, design_document_id: hld.id })
      const inserted = res.inserted?.length ?? 0
      const rejected = res.rejected?.length ?? 0
      toast.success(`Skeleton v${res.generation_version}: ${inserted} file${inserted === 1 ? '' : 's'}${rejected ? `, ${rejected} rejected` : ''}.`)
      onSkeleton?.()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(null)
    }
  }

  if (!hld) {
    return <p className="muted">The system map is created on Requirements. This page comes after Review.</p>
  }
  if (hld.status !== 'approved') {
    return (
      <div className="card">
        <h2 className="doc-title">Prototype and skeleton wait for approval</h2>
        <p className="muted" style={{ marginBottom: 0 }}>
          Approve the system map and the component designs on Review Queue. Both are created here afterwards.
        </p>
      </div>
    )
  }

  return (
    <div className="card">
      <h2 className="doc-title">Build from the approved map</h2>
      <p className="muted">
        Prototype is a flow of HLD v{hld.version}. Skeleton is the stub files for that map. Download the zip from the generation row once the files are listed.
      </p>
      {error && <ErrorBanner error={error} />}
      <div className="row wrap">
        <button type="button" onClick={genPrototype} disabled={!!busy}>Prototype</button>
        <button type="button" className="secondary" onClick={genSkeleton} disabled={!!busy}>Skeleton</button>
      </div>
      {prototypes.map((p) => {
        const { nodes, edges } = normalizeFlow(p.content)
        return (
          <div key={p.id} style={{ marginTop: 12 }}>
            <strong>Prototype: {p.type}</strong>
            <DiagramView nodes={nodes} edges={edges} height={320} />
          </div>
        )
      })}
    </div>
  )
}
