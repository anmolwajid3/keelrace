import { useEffect, useState } from 'react'
import { supabase, callFunction } from '../lib/supabase'
import ListToolbar from './ListToolbar.jsx'
import ConfirmDialog from './ConfirmDialog.jsx'
import ErrorBanner from './ErrorBanner.jsx'
import PageLoading from './PageLoading.jsx'
import { matchesQuery } from '../lib/text.js'

const ROLES = ['architect', 'tech_lead', 'security_reviewer', 'domain_owner']

export default function TeamTab({ projectId }) {
  const [members, setMembers] = useState([])
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('architect')
  const [phaseScope, setPhaseScope] = useState('')
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')
  const [pendingRemove, setPendingRemove] = useState(null)
  const [loading, setLoading] = useState(true)

  async function load() {
    const { data } = await supabase
      .from('project_members')
      .select('*, profiles(email, full_name)')
      .eq('project_id', projectId)
    setMembers(data ?? [])
    setLoading(false)
  }
  useEffect(() => { load() }, [projectId])

  async function invite(e) {
    e.preventDefault()
    setError(null)
    let profile
    try {
      profile = await callFunction('lookup-invitee', { email: email.trim() })
    } catch (err) {
      return setError(err.message)
    }

    const scope = phaseScope.trim() ? phaseScope.split(',').map((s) => s.trim()).filter(Boolean) : null
    const { error } = await supabase.from('project_members').insert({
      project_id: projectId, user_id: profile.id, role, phase_scope: scope,
    })
    if (error) return setError(error.message)
    setEmail(''); setPhaseScope('')
    load()
  }

  async function removeMember(m) {
    const { error } = await supabase.from('project_members').delete().eq('project_id', projectId).eq('user_id', m.user_id).eq('role', m.role)
    if (error) setError(error.message)
    else load()
  }

  return (
    <div>
      <h1>Team</h1>
      <p className="muted">FR-2.4: a reviewer's authority is checked against their role and phase_scope on every gate decision — this is where that gets set.</p>
      {error && <ErrorBanner error={error} />}
      {loading && <PageLoading />}

      <form onSubmit={invite} className="card">
        <div className="grid-2">
          <input placeholder="Teammate's email (must already have an account)" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <input
          placeholder="Phase scope, comma-separated (e.g. HLD,LLD) — leave blank for all phases"
          style={{ marginTop: 8 }}
          value={phaseScope}
          onChange={(e) => setPhaseScope(e.target.value)}
        />
        <div style={{ marginTop: 8 }}><button type="submit">Add to project</button></div>
      </form>

      <ListToolbar search={search} onSearch={setSearch} placeholder="Search members…" />

      {members.filter((m) => matchesQuery(`${m.profiles?.full_name ?? ''} ${m.profiles?.email ?? ''} ${m.role}`, search)).map((m) => (
        <div key={`${m.user_id}-${m.role}`} className="card row between">
          <div>
            <strong>{m.profiles?.full_name || m.profiles?.email}</strong>
            <span className="muted"> — {m.role}{m.phase_scope?.length ? ` (${m.phase_scope.join(', ')})` : ' (all phases)'}</span>
          </div>
          <button className="secondary" onClick={() => setPendingRemove(m)}>Remove</button>
        </div>
      ))}
      {!members.length && <p className="muted">No members yet.</p>}

      {pendingRemove && (
        <ConfirmDialog
          title={`Remove ${pendingRemove.profiles?.full_name || pendingRemove.profiles?.email}?`}
          body={`This drops the ${pendingRemove.role} role from this project. They will no longer pass FR-2.4 authority checks.`}
          confirmLabel="Remove"
          danger
          onCancel={() => setPendingRemove(null)}
          onConfirm={async () => { await removeMember(pendingRemove); setPendingRemove(null) }}
        />
      )}
    </div>
  )
}
