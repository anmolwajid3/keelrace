import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth.jsx'
import ConfirmDialog from '../components/ConfirmDialog.jsx'
import ErrorBanner from '../components/ErrorBanner.jsx'
import { useToast } from '../hooks/useToast.jsx'
import { IconArchive, IconPencil, IconRestore, IconTrash } from '../components/Icons.jsx'
import { isDemoProject } from '../lib/demoProject.js'

export default function ProjectList() {
  const { user } = useAuth()
  const toast = useToast()
  const nav = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [projects, setProjects] = useState([])
  const [name, setName] = useState('')
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [visibility, setVisibility] = useState('active')
  const [sort, setSort] = useState('created')
  const [creating, setCreating] = useState(() => searchParams.get('new') === '1')
  const [renameTarget, setRenameTarget] = useState(null)
  const [renameValue, setRenameValue] = useState('')
  const [pendingDelete, setPendingDelete] = useState(null)
  const [deleteTyped, setDeleteTyped] = useState('')
  const [busy, setBusy] = useState(false)

  async function load() {
    setError(null)
    const { data, error } = await supabase.from('projects').select('*').order('created_at', { ascending: false })
    if (error && /kind|schema cache|column/i.test(error.message)) {
      const retry = await supabase.from('projects').select('id, name, created_at, archived_at').order('created_at', { ascending: false })
      if (retry.error) setError(retry.error.message)
      else setProjects(retry.data ?? [])
    } else if (error) setError(error.message)
    else setProjects(data ?? [])
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  useEffect(() => {
    if (searchParams.get('new') === '1') {
      setCreating(true)
      const next = new URLSearchParams(searchParams)
      next.delete('new')
      setSearchParams(next, { replace: true })
    }
  }, [searchParams, setSearchParams])

  async function createProject(e) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    const { data: proj, error } = await supabase
      .from('projects')
      .insert({ name, created_by: user.id })
      .select()
      .single()
    if (error) { setError(error.message); setBusy(false); return }
    await supabase.from('project_members').insert({ project_id: proj.id, user_id: user.id, role: 'architect' })
    setName('')
    setCreating(false)
    setBusy(false)
    load()
  }

  async function renameProject(e) {
    e.preventDefault()
    const trimmed = renameValue.trim()
    if (!renameTarget || !trimmed) return
    const { error } = await supabase.from('projects').update({ name: trimmed }).eq('id', renameTarget.id)
    if (error) setError(error.message)
    else { setRenameTarget(null); load() }
  }

  async function setArchived(project, archived) {
    setError(null)
    const { data, error } = await supabase
      .from('projects')
      .update({ archived_at: archived ? new Date().toISOString() : null })
      .eq('id', project.id)
      .select('id')
    if (error) return setError(error.message)
    if (!data?.length) return setError('Could not archive this project.')
    toast.success(archived ? 'Project archived.' : 'Project restored.')
    load()
  }

  async function deleteProject() {
    if (!pendingDelete) return
    setError(null)
    const { data, error } = await supabase.rpc('delete_own_project', { p_id: pendingDelete.id })
    if (error) return setError(error.message)
    if (!data) return setError('Delete did not apply. You must be the creator or an architect.')
    toast.success('Project deleted.')
    setPendingDelete(null)
    setDeleteTyped('')
    load()
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    let list = projects.filter((p) => {
      if (isDemoProject(p)) return false
      const archived = Boolean(p.archived_at)
      if (visibility === 'active' && archived) return false
      if (visibility === 'archived' && !archived) return false
      if (q && !p.name.toLowerCase().includes(q)) return false
      return true
    })
    if (sort === 'name') list = [...list].sort((a, b) => a.name.localeCompare(b.name))
    else list = [...list].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    return list
  }, [projects, query, visibility, sort])

  const liveCount = projects.filter((p) => !isDemoProject(p) && !p.archived_at).length
  const archivedCount = projects.filter((p) => !isDemoProject(p) && p.archived_at).length

  return (
    <div className="dash-main">
      <div className="dash-heading">
        <div>
          <p className="kicker">Workspace</p>
          <h1>Projects</h1>
          <p className="muted">Open a project to continue its architecture. Demo and How this works stay in the sidebar.</p>
        </div>
        <button type="button" onClick={() => setCreating(true)}>New project</button>
      </div>

      <div className="stat-row">
        <button type="button" className={`stat-card${visibility === 'active' ? ' selected' : ''}`} onClick={() => setVisibility('active')}>
          <span className="stat-value">{loading ? '—' : liveCount}</span>
          <span className="muted">Active</span>
        </button>
        <button type="button" className={`stat-card${visibility === 'archived' ? ' selected' : ''}`} onClick={() => setVisibility('archived')}>
          <span className="stat-value">{loading ? '—' : archivedCount}</span>
          <span className="muted">Archived</span>
        </button>
        <button type="button" className={`stat-card${visibility === 'all' ? ' selected' : ''}`} onClick={() => setVisibility('all')}>
          <span className="stat-value">{loading ? '—' : liveCount + archivedCount}</span>
          <span className="muted">All</span>
        </button>
      </div>

      <div className="project-toolbar">
        <input placeholder="Search by name…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort projects">
          <option value="created">Newest first</option>
          <option value="name">Name A–Z</option>
        </select>
      </div>

      {error && <ErrorBanner error={error} />}
      {loading && <div className="skeleton" style={{ height: 220 }} />}

      {!loading && filtered.length > 0 && (
        <div className="card" style={{ padding: 0, overflow: 'auto' }}>
          <table className="projects-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Created</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => (
                <tr
                  key={p.id}
                  className="clickable-row"
                  tabIndex={0}
                  onClick={() => nav(`/projects/${p.id}`)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); nav(`/projects/${p.id}`) } }}
                >
                  <td>{p.name}</td>
                  <td className="muted">{new Date(p.created_at).toLocaleString()}</td>
                  <td>{p.archived_at ? <span className="badge muted">archived</span> : <span className="badge ok">active</span>}</td>
                  <td onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                    <div className="actions">
                      <button type="button" className="icon-btn" aria-label={`Rename ${p.name}`} title="Rename" onClick={() => { setRenameTarget(p); setRenameValue(p.name) }}>
                        <IconPencil />
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={p.archived_at ? `Restore ${p.name}` : `Archive ${p.name}`}
                        title={p.archived_at ? 'Restore' : 'Archive'}
                        onClick={() => setArchived(p, !p.archived_at)}
                      >
                        {p.archived_at ? <IconRestore /> : <IconArchive />}
                      </button>
                      <button
                        type="button"
                        className="icon-btn danger-icon"
                        aria-label={`Delete ${p.name}`}
                        title="Delete"
                        onClick={() => { setPendingDelete(p); setDeleteTyped('') }}
                      >
                        <IconTrash />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!loading && !filtered.length && (
        <div className="empty-card">
          <h2>{projects.filter((p) => !isDemoProject(p)).length ? 'Nothing matches' : 'No projects yet'}</h2>
          <p className="muted">
            {projects.filter((p) => !isDemoProject(p)).length
              ? 'Try another search or show archived projects.'
              : 'Create a project to start the loop. Open Demo project from the sidebar to see a filled example.'}
          </p>
          <button type="button" onClick={() => setCreating(true)}>New project</button>
        </div>
      )}

      {creating && (
        <ConfirmDialog
          title="New project"
          body="A project is the container for requirement sets, design docs, review gates, and drift."
          confirmLabel={busy ? 'Creating…' : 'Create'}
          confirmDisabled={busy || !name.trim()}
          onCancel={() => { setCreating(false); setName('') }}
          onConfirm={() => document.getElementById('create-project-form')?.requestSubmit()}
        >
          <form id="create-project-form" onSubmit={createProject}>
            <label className="muted">Name</label>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} required placeholder="e.g. MoodFlow" />
          </form>
        </ConfirmDialog>
      )}

      {renameTarget && (
        <ConfirmDialog
          title="Rename project"
          confirmLabel="Save name"
          confirmDisabled={!renameValue.trim()}
          onCancel={() => setRenameTarget(null)}
          onConfirm={() => document.getElementById('rename-project-form')?.requestSubmit()}
        >
          <form id="rename-project-form" onSubmit={renameProject}>
            <label className="muted">Name</label>
            <input autoFocus value={renameValue} onChange={(e) => setRenameValue(e.target.value)} required />
          </form>
        </ConfirmDialog>
      )}

      {pendingDelete && (
        <ConfirmDialog
          title={`Delete “${pendingDelete.name}”?`}
          body="This permanently removes the project and cascaded design artifacts. Archive if you only want it out of the way."
          confirmLabel="Delete project"
          danger
          confirmDisabled={deleteTyped !== pendingDelete.name}
          onCancel={() => setPendingDelete(null)}
          onConfirm={deleteProject}
        >
          <label className="muted" style={{ marginTop: 12 }}>Type the project name to confirm</label>
          <input value={deleteTyped} onChange={(e) => setDeleteTyped(e.target.value)} placeholder={pendingDelete.name} />
        </ConfirmDialog>
      )}
    </div>
  )
}
