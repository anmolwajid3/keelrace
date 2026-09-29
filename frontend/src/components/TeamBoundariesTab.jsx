import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import ListToolbar from './ListToolbar.jsx'
import ErrorBanner from './ErrorBanner.jsx'
import PageLoading from './PageLoading.jsx'
import { matchesQuery } from '../lib/text.js'

export default function TeamBoundariesTab({ projectId }) {
  const [components, setComponents] = useState([])
  const [boundaries, setBoundaries] = useState({}) // component_id -> boundary row
  const [error, setError] = useState(null)
  const [editing, setEditing] = useState({})
  const [search, setSearch] = useState('')
  const [ownerFilter, setOwnerFilter] = useState('all')
  const [loading, setLoading] = useState(true)

  async function load() {
    const { data: comps } = await supabase.from('components').select('*').eq('project_id', projectId)
    setComponents(comps ?? [])

    const { data: bounds } = await supabase.from('team_boundaries').select('*').eq('project_id', projectId)
    const map = {}
    for (const b of bounds ?? []) map[b.design_component_id] = b
    setBoundaries(map)
    setLoading(false)
  }
  useEffect(() => { load() }, [projectId])

  async function setOwner(comp) {
    const team = editing[comp.id]
    if (team === undefined) return
    const existing = boundaries[comp.id]
    const { error } = existing
      ? await supabase.from('team_boundaries').update({ owning_team: team || null }).eq('id', existing.id)
      : await supabase.from('team_boundaries').insert({ project_id: projectId, design_component_id: comp.id, owning_team: team || null })
    if (error) setError(error.message)
    else load()
  }

  return (
    <div>
      <h1>Team Boundaries</h1>
      <p className="muted">Maps real Components (from generated HLDs) to an owning team (FR-8.2). Unowned components are flagged, never silently unrouted.</p>
      {error && <ErrorBanner error={error} />}
      {loading && <PageLoading />}
      <ListToolbar search={search} onSearch={setSearch} placeholder="Search components…">
        <select value={ownerFilter} onChange={(e) => setOwnerFilter(e.target.value)}>
          <option value="all">All</option>
          <option value="unowned">Unowned</option>
          <option value="owned">Owned</option>
        </select>
      </ListToolbar>
      {components.filter((comp) => {
        const owner = boundaries[comp.id]?.owning_team
        if (ownerFilter === 'unowned' && owner) return false
        if (ownerFilter === 'owned' && !owner) return false
        return matchesQuery(`${comp.name} ${comp.description ?? ''} ${owner ?? ''}`, search)
      }).map((comp) => {
        const owner = boundaries[comp.id]?.owning_team
        return (
          <div key={comp.id} className="card row between">
            <div>
              <strong>{comp.name}</strong>
              <span className="muted"> {comp.description}</span>
              {!owner && <span className="badge warn" style={{ marginLeft: 8 }}>unowned</span>}
              {owner && <span className="badge ok" style={{ marginLeft: 8 }}>{owner}</span>}
            </div>
            <div className="row">
              <input
                placeholder="Owning team"
                style={{ width: 160 }}
                value={editing[comp.id] ?? owner ?? ''}
                onChange={(e) => setEditing({ ...editing, [comp.id]: e.target.value })}
              />
              <button className="secondary" onClick={() => setOwner(comp)}>Save</button>
            </div>
          </div>
        )
      })}
      {!components.length && <p className="muted">No components yet — generate an HLD first.</p>}
    </div>
  )
}
