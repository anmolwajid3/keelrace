import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import ListToolbar from './ListToolbar.jsx'
import ConfirmDialog from './ConfirmDialog.jsx'
import ErrorBanner from './ErrorBanner.jsx'
import PageLoading from './PageLoading.jsx'
import { IconPencil, IconTrash } from './Icons.jsx'
import { matchesQuery } from '../lib/text.js'

export default function DebtBacklogTab({ projectId }) {
  const [items, setItems] = useState([])
  const [filter, setFilter] = useState('open')
  const [desc, setDesc] = useState('')
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState(null)
  const [pendingDelete, setPendingDelete] = useState(null)
  const [loading, setLoading] = useState(true)

  async function load() {
    let q = supabase.from('debt_items').select('*').eq('project_id', projectId).order('created_at', { ascending: false })
    if (filter !== 'all') q = q.eq('status', filter)
    const { data, error } = await q
    if (error) setError(error.message)
    else setItems(data ?? [])
    setLoading(false)
  }
  useEffect(() => { load() }, [projectId, filter])

  async function addManual(e) {
    e.preventDefault()
    const { error } = await supabase.from('debt_items').insert({ project_id: projectId, description: desc })
    if (error) setError(error.message)
    else { setDesc(''); load() }
  }

  async function setStatus(item, status) {
    const { error } = await supabase.from('debt_items').update({ status, updated_at: new Date().toISOString() }).eq('id', item.id)
    if (error) setError(error.message)
    else load()
  }

  async function saveEdit(e) {
    e.preventDefault()
    if (!editing) return
    const { error } = await supabase.from('debt_items').update({ description: editing.description, updated_at: new Date().toISOString() }).eq('id', editing.id)
    if (error) setError(error.message)
    else { setEditing(null); load() }
  }

  async function deleteItem() {
    if (!pendingDelete) return
    const { error } = await supabase.from('debt_items').delete().eq('id', pendingDelete.id)
    if (error) setError(error.message)
    else { setPendingDelete(null); load() }
  }

  return (
    <div>
      <h1>Debt Backlog</h1>
      <p className="muted">Queryable independent of the health report (FR-9.2) — drift-logged debt and manual entries live here together.</p>
      {error && <ErrorBanner error={error} />}
      {loading && <PageLoading />}

      <form onSubmit={addManual} className="card row">
        <input placeholder="Describe the debt item…" value={desc} onChange={(e) => setDesc(e.target.value)} required />
        <button type="submit">Add</button>
      </form>

      <div className="tabs">
        {['open', 'acknowledged', 'resolved', 'all'].map((f) => (
          <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>{f}</button>
        ))}
      </div>

      <ListToolbar search={search} onSearch={setSearch} placeholder="Search debt…" />

      {items.filter((i) => matchesQuery(i.description, search)).map((i) => (
        <div key={i.id} className="card row between wrap">
          <div style={{ flex: 1, minWidth: 0 }}>
            {editing?.id === i.id ? (
              <form onSubmit={saveEdit} className="row wrap">
                <input value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} required />
                <button type="submit">Save</button>
                <button type="button" className="secondary" onClick={() => setEditing(null)}>Cancel</button>
              </form>
            ) : (
              <>
                <p style={{ margin: 0 }}>{i.description}</p>
                <span className="muted">{new Date(i.created_at).toLocaleDateString()}</span>
              </>
            )}
          </div>
          <div className="row wrap">
            <span className={`badge ${i.status === 'resolved' ? 'ok' : i.status === 'acknowledged' ? 'warn' : 'muted'}`}>{i.status}</span>
            {i.status !== 'acknowledged' && <button className="secondary" onClick={() => setStatus(i, 'acknowledged')}>Acknowledge</button>}
            {i.status !== 'resolved' && <button className="secondary" onClick={() => setStatus(i, 'resolved')}>Resolve</button>}
            <button type="button" className="icon-btn" title="Edit" aria-label="Edit debt" onClick={() => setEditing({ ...i })}><IconPencil /></button>
            <button type="button" className="icon-btn danger-icon" title="Delete" aria-label="Delete debt" onClick={() => setPendingDelete(i)}><IconTrash /></button>
          </div>
        </div>
      ))}
      {!items.length && <p className="muted">Nothing here.</p>}

      {pendingDelete && (
        <ConfirmDialog
          title="Delete this debt item?"
          confirmLabel="Delete"
          danger
          onCancel={() => setPendingDelete(null)}
          onConfirm={deleteItem}
        />
      )}
    </div>
  )
}
