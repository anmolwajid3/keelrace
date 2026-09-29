import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth.jsx'
import { useToast } from '../hooks/useToast.jsx'
import ErrorBanner from '../components/ErrorBanner.jsx'

export default function Login() {
  const { signInWithPassword, signUp } = useAuth()
  const toast = useToast()
  const nav = useNavigate()
  const [mode, setMode] = useState('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [fullName, setFullName] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const { error } =
        mode === 'signin'
          ? await signInWithPassword(email, password)
          : await signUp(email, password, fullName)
      if (error) throw error
      if (mode === 'signin') nav('/projects')
      else toast.success('Check your email to confirm your account, then sign in.')
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-page">
      <Link to="/" className="brand auth-brand">
        <span className="brand-mark">K</span>
        KeelRace
      </Link>
      <form onSubmit={submit} className="card auth-card">
        <h1>{mode === 'signin' ? 'Sign in' : 'Create account'}</h1>
        <p className="muted">{mode === 'signin' ? 'Continue to your workspace.' : 'Confirm by email, then sign in.'}</p>
        {mode === 'signup' && (
          <div style={{ marginBottom: 10 }}>
            <label className="muted">Full name</label>
            <input value={fullName} onChange={(e) => setFullName(e.target.value)} required autoComplete="name" />
          </div>
        )}
        <div style={{ marginBottom: 10 }}>
          <label className="muted">Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
        </div>
        <div style={{ marginBottom: 10 }}>
          <label className="muted">Password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} />
        </div>
        {error && <ErrorBanner error={error} />}
        <button type="submit" disabled={busy} style={{ width: '100%' }}>
          {busy ? 'Working…' : mode === 'signin' ? 'Sign in' : 'Create account'}
        </button>
        <div style={{ marginTop: 12, textAlign: 'center' }}>
          <button type="button" className="ghost" onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setError(null) }}>
            {mode === 'signin' ? 'Need an account? Sign up' : 'Have an account? Sign in'}
          </button>
        </div>
      </form>
    </div>
  )
}
