import { useEffect, useMemo, useState } from 'react'
import { supabase, callFunction } from '../lib/supabase'
import ListToolbar from './ListToolbar.jsx'
import ConfirmDialog from './ConfirmDialog.jsx'
import ErrorBanner from './ErrorBanner.jsx'
import PageLoading from './PageLoading.jsx'
import LoopSteps from './LoopSteps.jsx'
import { IconPencil, IconTrash } from './Icons.jsx'
import { matchesQuery, requirementKind } from '../lib/text.js'
import { useToast } from '../hooks/useToast.jsx'
import RequirementsAssist from './assist/RequirementsAssist.jsx'

export default function RequirementsTab({ projectId }) {
  const toast = useToast()
  const [sets, setSets] = useState([])
  const [activeSet, setActiveSet] = useState(null)
  const [requirements, setRequirements] = useState([])
  const [refCode, setRefCode] = useState('')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [kindFilter, setKindFilter] = useState('all')
  const [editing, setEditing] = useState(null)
  const [pendingDelete, setPendingDelete] = useState(null)
  const [pendingRegen, setPendingRegen] = useState(null)

  async function loadSets() {
    const { data } = await supabase.from('requirement_sets').select('*').eq('project_id', projectId).order('version')
    setSets(data ?? [])
    if (data?.length && !activeSet) setActiveSet(data[data.length - 1])
    else setLoading(false)
  }
  async function loadRequirements(setId) {
    const { data } = await supabase.from('requirements').select('*').eq('requirement_set_id', setId).order('ref_code')
    setRequirements(data ?? [])
    setLoading(false)
  }

  useEffect(() => { loadSets() }, [projectId])
  useEffect(() => { if (activeSet) loadRequirements(activeSet.id) }, [activeSet])

  async function createSet() {
    const nextVersion = (sets[sets.length - 1]?.version ?? 0) + 1
    const { data, error } = await supabase
      .from('requirement_sets')
      .insert({ project_id: projectId, version: nextVersion, status: 'draft' })
      .select()
      .single()
    if (error) return setError(error.message)
    setSets([...sets, data])
    setActiveSet(data)
  }

  async function addRequirement(e) {
    e.preventDefault()
    if (!activeSet) return
    const { error } = await supabase
      .from('requirements')
      .insert({ requirement_set_id: activeSet.id, ref_code: refCode, title, body })
    if (error) return setError(error.message)
    setRefCode(''); setTitle(''); setBody('')
    loadRequirements(activeSet.id)
  }

  async function saveRequirement(e) {
    e.preventDefault()
    if (!editing) return
    const { error } = await supabase
      .from('requirements')
      .update({ ref_code: editing.ref_code, title: editing.title, body: editing.body })
      .eq('id', editing.id)
    if (error) return setError(error.message)
    setEditing(null)
    loadRequirements(activeSet.id)
  }

  async function deleteRequirement() {
    if (!pendingDelete) return
    const { error } = await supabase.from('requirements').delete().eq('id', pendingDelete.id)
    if (error) return setError(error.message)
    setPendingDelete(null)
    loadRequirements(activeSet.id)
  }

  async function copyToNewDraft() {
    if (!activeSet) return
    setError(null)
    const nextVersion = (sets[sets.length - 1]?.version ?? 0) + 1
    const { data: created, error } = await supabase
      .from('requirement_sets')
      .insert({ project_id: projectId, version: nextVersion, status: 'draft' })
      .select()
      .single()
    if (error) return setError(error.message)
    if (requirements.length) {
      const { error: copyErr } = await supabase.from('requirements').insert(
        requirements.map((r) => ({ requirement_set_id: created.id, ref_code: r.ref_code, title: r.title, body: r.body })),
      )
      if (copyErr) return setError(copyErr.message)
    }
    setSets([...sets, created])
    setActiveSet(created)
  }

  const visibleReqs = useMemo(() => requirements.filter((r) => {
    if (kindFilter !== 'all' && requirementKind(r.ref_code) !== kindFilter) return false
    return matchesQuery(`${r.ref_code} ${r.title} ${r.body}`, search)
  }), [requirements, search, kindFilter])

  async function lockSet() {
    if (!requirements.length) return setError('This RequirementSet has 0 requirements — use either the Import section above OR the manual form below (your choice, not both required) to add at least one before locking.')
    const { error } = await supabase
      .from('requirement_sets')
      .update({ status: 'locked', locked_at: new Date().toISOString() })
      .eq('id', activeSet.id)
    if (error) return setError(error.message)
    setActiveSet({ ...activeSet, status: 'locked' })
    loadSets()
  }

  // Must match hashRequirements() in the generate-design-docs edge function
  // exactly -- same sort key, field order, and separators -- or the
  // "unchanged since last generation" comparison is meaningless.
  async function hashRequirements(reqs) {
    const sorted = [...reqs].sort((a, b) => a.ref_code.localeCompare(b.ref_code))
    const text = sorted.map((r) => `${r.ref_code}|${r.title}|${r.body}`).join('\n')
    const bytes = new TextEncoder().encode(text)
    const hashBuffer = await crypto.subtle.digest('SHA-256', bytes)
    return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('')
  }

  async function runGenerate() {
    setBusy(true)
    setError(null)
    try {
      await callFunction('generate-design-docs', { requirement_set_id: activeSet.id })
      toast.success('HLD/LLD generation complete — open Design Docs to review.')
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
      setPendingRegen(null)
    }
  }

  async function generate() {
    setError(null)
    try {
      const currentHash = await hashRequirements(requirements)
      const { data: priorHld } = await supabase
        .from('design_documents')
        .select('version, requirements_hash')
        .eq('requirement_set_id', activeSet.id)
        .eq('type', 'HLD')
        .order('version', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (priorHld?.requirements_hash === currentHash) {
        setPendingRegen({ from: priorHld.version, next: priorHld.version + 1 })
        return
      }
      await runGenerate()
    } catch (e) {
      setError(e.message)
    }
  }

  return (
    <div>
      <div className="row between">
        <h1>Requirements</h1>
        <button onClick={createSet}>New RequirementSet</button>
      </div>
      <LoopSteps current="requirements" projectId={projectId} paths={{ requirements: '.', design: 'design', review: 'review', package: 'package' }} />
      <p className="muted">On this page: lock the set, then generate the system map. The next page is NFRs &amp; Risk.</p>
      <RequirementsAssist projectId={projectId} requirementSetId={activeSet?.id} setStatus={activeSet?.status} />

      <div className="row" style={{ marginBottom: 16, flexWrap: 'wrap' }}>
        {sets.map((s) => (
          <button
            key={s.id}
            className={activeSet?.id === s.id ? '' : 'secondary'}
            onClick={() => setActiveSet(s)}
          >
            v{s.version} <span className={`badge ${s.status === 'locked' ? 'ok' : 'muted'}`}>{s.status}</span>
          </button>
        ))}
      </div>

      {activeSet && (
        <>
          <div className="card">
            <div className="row between">
              <h2>RequirementSet v{activeSet.version}</h2>
              <div className="row wrap">
                <button className="secondary" onClick={copyToNewDraft}>Copy to new draft</button>
                {activeSet.status !== 'locked' && <button onClick={lockSet}>Lock</button>}
                <button onClick={generate} disabled={activeSet.status !== 'locked' || busy}>
                  {busy ? 'Generating…' : 'Generate HLD/LLD (FR-1.1)'}
                </button>
              </div>
            </div>
            {activeSet.status !== 'locked' && (
              <p className="muted">Generation is rejected server-side until this set is locked.</p>
            )}
          </div>

          {activeSet.status !== 'locked' && (
            <>
              <ImportSection
                projectId={projectId}
                requirementSetId={activeSet.id}
                onImported={() => loadRequirements(activeSet.id)}
                setError={setError}
              />

              <form onSubmit={addRequirement} className="card">
                <h3>Add one requirement manually</h3>
                <p className="muted" style={{ marginTop: 0 }}>Use this for anything the import above didn't cover, or if you're not starting from a document at all.</p>
                <div className="grid-2" style={{ marginBottom: 8 }}>
                  <input placeholder="Ref code e.g. FR-1.1" value={refCode} onChange={(e) => setRefCode(e.target.value)} required />
                  <input placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} required />
                </div>
                <textarea placeholder="Body" value={body} onChange={(e) => setBody(e.target.value)} rows={3} required />
                <div style={{ marginTop: 8 }}>
                  <button type="submit">Add</button>
                </div>
              </form>
            </>
          )}

          {error && <ErrorBanner error={error} />}
          {loading && <PageLoading />}

          <ListToolbar search={search} onSearch={setSearch} placeholder="Search ref, title, or body…">
            <select value={kindFilter} onChange={(e) => setKindFilter(e.target.value)}>
              <option value="all">All kinds</option>
              <option value="FR">FR</option>
              <option value="NFR">NFR</option>
              <option value="CON">CON</option>
              <option value="other">Other</option>
            </select>
          </ListToolbar>

          {visibleReqs.map((r) => {
            const kind = requirementKind(r.ref_code)
            return (
              <div key={r.id} className="card">
                {editing?.id === r.id ? (
                  <form onSubmit={saveRequirement}>
                    <div className="grid-2" style={{ marginBottom: 8 }}>
                      <input value={editing.ref_code} onChange={(e) => setEditing({ ...editing, ref_code: e.target.value })} required />
                      <input value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} required />
                    </div>
                    <textarea rows={3} value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} required />
                    <div className="row" style={{ marginTop: 8 }}>
                      <button type="submit">Save</button>
                      <button type="button" className="secondary" onClick={() => setEditing(null)}>Cancel</button>
                    </div>
                  </form>
                ) : (
                  <>
                    <div className="card-head">
                      <div className="row wrap">
                        <strong>{r.ref_code}</strong>
                        <span className="badge muted">{kind}</span>
                        <span className="muted">{r.title}</span>
                      </div>
                      {activeSet.status !== 'locked' && (
                        <div className="row">
                          <button type="button" className="icon-btn" aria-label={`Edit ${r.ref_code}`} title="Edit" onClick={() => setEditing({ ...r })}>
                            <IconPencil />
                          </button>
                          <button type="button" className="icon-btn danger-icon" aria-label={`Delete ${r.ref_code}`} title="Delete" onClick={() => setPendingDelete(r)}>
                            <IconTrash />
                          </button>
                        </div>
                      )}
                    </div>
                    <p className="muted">{r.body}</p>
                  </>
                )}
              </div>
            )
          })}
          {!visibleReqs.length && <p className="muted">{requirements.length ? 'No requirements match this search.' : 'No requirements yet.'}</p>}
        </>
      )}

      {pendingDelete && (
        <ConfirmDialog
          title={`Delete ${pendingDelete.ref_code}?`}
          body="Only allowed while this set is still a draft. After lock, use Changes & Signals."
          confirmLabel="Delete"
          danger
          onCancel={() => setPendingDelete(null)}
          onConfirm={deleteRequirement}
        />
      )}
      {pendingRegen && (
        <ConfirmDialog
          title="Requirements unchanged"
          body={`Input matches HLD v${pendingRegen.from}. Generating anyway creates v${pendingRegen.next} from the same requirements.`}
          confirmLabel={busy ? 'Generating…' : 'Generate anyway'}
          confirmDisabled={busy}
          onCancel={() => setPendingRegen(null)}
          onConfirm={runGenerate}
        />
      )}
    </div>
  )
}

// Always visible alongside manual add, never a replacement for it. Upload a
// .docx/.pdf or paste extracted text; everything found is shown for review
// (edit, deselect, reclassify) before anything is actually imported. FR and
// CON items become Requirements; NFR items become project-wide NFRs (the
// NFRs & Risk tab is still where you'd add a few more of those by hand).
function ImportSection({ projectId, requirementSetId, onImported, setError }) {
  const toast = useToast()
  const [mode, setMode] = useState('file') // 'file' | 'paste'
  const [file, setFile] = useState(null)
  const [pastedText, setPastedText] = useState('')
  const [extracting, setExtracting] = useState(false)
  const [items, setItems] = useState(null) // null = not yet extracted
  const [selected, setSelected] = useState({}) // index -> boolean
  const [importing, setImporting] = useState(false)

  async function fileToBase64(f) {
    const buf = await f.arrayBuffer()
    let binary = ''
    const bytes = new Uint8Array(buf)
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
    return btoa(binary)
  }

  async function extract() {
    setExtracting(true)
    setError(null)
    setItems(null)
    try {
      let rawText = pastedText

      if (mode === 'file') {
        if (!file) { setError('Choose a .docx or .pdf file first.'); setExtracting(false); return }
        const ext = file.name.toLowerCase().endsWith('.pdf') ? 'pdf' : 'docx'
        const base64 = await fileToBase64(file)
        const extractRes = await callFunction('extract-document-text', { file_base64: base64, mime_type: ext })
        rawText = extractRes.text
      }

      if (!rawText?.trim()) { setError('No text to parse — upload a file or paste some text first.'); setExtracting(false); return }

      const res = await callFunction('parse-requirements-text', { raw_text: rawText })
      const parsedItems = res.items ?? []
      setItems(parsedItems)
      const initialSelection = {}
      parsedItems.forEach((_, i) => { initialSelection[i] = true })
      setSelected(initialSelection)
      if (res.truncated) setError('Note: the document was long and got truncated for parsing — check the end of your source for anything missed, and add it manually if needed.')
    } catch (e) {
      setError(e.message)
    } finally {
      setExtracting(false)
    }
  }

  function updateItem(i, field, value) {
    setItems(items.map((it, idx) => (idx === i ? { ...it, [field]: value } : it)))
  }

  async function importSelected() {
    setImporting(true)
    setError(null)
    try {
      const toImport = items.filter((_, i) => selected[i])
      const frConItems = toImport.filter((i) => i.type === 'FR' || i.type === 'CON')
      const nfrItems = toImport.filter((i) => i.type === 'NFR')

      if (frConItems.length) {
        const { error } = await supabase.from('requirements').insert(
          frConItems.map((i) => ({ requirement_set_id: requirementSetId, ref_code: i.ref_code, title: i.title, body: i.body })),
        )
        if (error) throw error
      }
      if (nfrItems.length) {
        const { error } = await supabase.from('nfrs').insert(
          nfrItems.map((i) => ({ project_id: projectId, name: `${i.ref_code}: ${i.title}`, description: i.body, component_id: null })),
        )
        if (error) throw error
      }

      toast.success(`Imported ${frConItems.length} requirement(s)/constraint(s) and ${nfrItems.length} NFR(s). NFRs appear on the NFRs & Risk tab.`)
      setItems(null)
      setFile(null)
      setPastedText('')
      onImported()
    } catch (e) {
      setError(e.message)
    } finally {
      setImporting(false)
    }
  }

  const selectedCount = Object.values(selected).filter(Boolean).length

  return (
    <div className="card">
      <h3>Import from a document</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        Already have an SRS with FRs, NFRs, and constraints laid out? Bring it in instead of retyping it.
        FR/CON items become Requirements below; NFR items go to the NFRs & Risk tab.
      </p>

      <div className="tabs" style={{ marginBottom: 12 }}>
        <button className={mode === 'file' ? 'active' : ''} onClick={() => setMode('file')}>Upload .docx/.pdf</button>
        <button className={mode === 'paste' ? 'active' : ''} onClick={() => setMode('paste')}>Paste text</button>
      </div>

      {mode === 'file' ? (
        <input type="file" accept=".docx,.pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      ) : (
        <textarea
          placeholder="Paste the document's text here…"
          value={pastedText}
          onChange={(e) => setPastedText(e.target.value)}
          rows={6}
        />
      )}

      <div style={{ marginTop: 8 }}>
        <button onClick={extract} disabled={extracting}>{extracting ? 'Extracting…' : 'Extract & parse'}</button>
      </div>

      {items && (
        <div style={{ marginTop: 16 }}>
          <div className="row between">
            <strong>Review before importing</strong>
            <span className="muted">{selectedCount} of {items.length} selected</span>
          </div>
          {items.map((it, i) => (
            <div key={i} className="card" style={{ background: 'transparent' }}>
              <div className="row" style={{ gap: 8 }}>
                <input type="checkbox" style={{ width: 'auto' }} checked={!!selected[i]} onChange={(e) => setSelected({ ...selected, [i]: e.target.checked })} />
                <input style={{ width: 100 }} value={it.ref_code} onChange={(e) => updateItem(i, 'ref_code', e.target.value)} />
                <select style={{ width: 90 }} value={it.type} onChange={(e) => updateItem(i, 'type', e.target.value)}>
                  <option value="FR">FR</option>
                  <option value="NFR">NFR</option>
                  <option value="CON">CON</option>
                </select>
                <input style={{ flex: 1 }} value={it.title} onChange={(e) => updateItem(i, 'title', e.target.value)} />
              </div>
              <textarea style={{ marginTop: 6 }} rows={2} value={it.body} onChange={(e) => updateItem(i, 'body', e.target.value)} />
            </div>
          ))}
          {!items.length && <p className="muted">Nothing recognizable was found — try pasting the text instead, or add requirements manually below.</p>}
          {items.length > 0 && (
            <button onClick={importSelected} disabled={importing || !selectedCount} style={{ marginTop: 8 }}>
              {importing ? 'Importing…' : `Import ${selectedCount} selected`}
            </button>
          )}
        </div>
      )}
    </div>
  )
}