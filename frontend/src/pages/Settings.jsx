import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth.jsx'
import { githubLinked } from '../lib/githubSkeleton.js'
import { useToast } from '../hooks/useToast.jsx'
import ErrorBanner from '../components/ErrorBanner.jsx'

export default function SettingsPage() {
  const { user, session } = useAuth()
  const toast = useToast()
  const [password, setPassword] = useState('')
  const [password2, setPassword2] = useState('')
  const [error, setError] = useState(null)
  const [profile, setProfile] = useState({ skeleton_destination: 'download', github_repo: '' })
  const linked = githubLinked(user)

  useEffect(() => {
    supabase.from('profiles').select('skeleton_destination, github_repo').eq('id', user.id).maybeSingle()
      .then(({ data }) => {
        if (data) setProfile({
          skeleton_destination: data.skeleton_destination || 'download',
          github_repo: data.github_repo || '',
        })
      })
  }, [user.id])

  async function saveProfile(e) {
    e.preventDefault()
    setError(null)
    const { error: err } = await supabase.from('profiles').update({
      skeleton_destination: profile.skeleton_destination,
      github_repo: profile.github_repo || null,
    }).eq('id', user.id)
    if (err) return setError(err.message)
    toast.success('Profile saved.')
  }

  async function changePassword(e) {
    e.preventDefault()
    setError(null)
    if (password !== password2) return setError('Passwords do not match.')
    const { error: err } = await supabase.auth.updateUser({ password })
    if (err) return setError(err.message)
    setPassword('')
    setPassword2('')
    toast.success('Password updated.')
  }

  async function linkGithub() {
    setError(null)
    const { error: err } = await supabase.auth.linkIdentity({
      provider: 'github',
      options: { redirectTo: `${window.location.origin}/settings` },
    })
    if (err) setError(err.message)
  }

  return (
    <div className="dash-main">
      <div className="dash-heading">
        <div>
          <p className="kicker">Account</p>
          <h1>Profile settings</h1>
          <p className="muted">{user?.email}. Password, GitHub, and where skeletons download. Generation models are set by an admin, not here.</p>
        </div>
      </div>
      {error && <ErrorBanner error={error} />}

      <form className="card settings-card" onSubmit={changePassword}>
        <h2>Password</h2>
        <div className="grid-2">
          <input type="password" placeholder="New password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={6} autoComplete="new-password" />
          <input type="password" placeholder="Confirm" value={password2} onChange={(e) => setPassword2(e.target.value)} minLength={6} autoComplete="new-password" />
        </div>
        <div style={{ marginTop: 12 }}><button type="submit" disabled={!password}>Update password</button></div>
      </form>

      <div className="card settings-card">
        <h2>GitHub</h2>
        <p className="muted">Link GitHub so a skeleton can be sent as a private gist instead of only a zip.</p>
        <p>{linked ? <span className="badge ok">GitHub linked</span> : <span className="badge muted">Not linked</span>}</p>
        {!linked && <button type="button" onClick={linkGithub}>Link GitHub</button>}
        {session?.provider_token && <p className="muted">Provider token present for this session.</p>}
      </div>

      <form className="card settings-card" onSubmit={saveProfile}>
        <h2>Where skeletons go</h2>
        <label className="muted row" style={{ gap: 8 }}>
          <input type="radio" name="dest" checked={profile.skeleton_destination === 'download'} onChange={() => setProfile({ ...profile, skeleton_destination: 'download' })} />
          Download a .zip
        </label>
        <label className="muted row" style={{ gap: 8, marginTop: 6 }}>
          <input type="radio" name="dest" checked={profile.skeleton_destination === 'gist'} onChange={() => setProfile({ ...profile, skeleton_destination: 'gist' })} />
          Private GitHub gist
        </label>
        <label className="muted" style={{ marginTop: 12 }}>Preferred repo (owner/name)</label>
        <input placeholder="acme/moodflow" value={profile.github_repo} onChange={(e) => setProfile({ ...profile, github_repo: e.target.value })} />
        <div style={{ marginTop: 12 }}><button type="submit">Save destination</button></div>
      </form>

      <p className="muted"><Link to="/projects">Back to projects</Link></p>
    </div>
  )
}
