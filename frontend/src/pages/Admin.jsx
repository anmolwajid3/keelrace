import { LLM_PROVIDERS, loadLlmSettings, saveLlmSettings } from '../lib/settings.js'
import { loadTestAgentAllowed, saveTestAgentAllowed } from '../lib/testAgent.js'
import { useEffect, useState } from 'react'
import { useAuth } from '../hooks/useAuth.jsx'
import { useToast } from '../hooks/useToast.jsx'
import ErrorBanner from '../components/ErrorBanner.jsx'

export default function AdminPage() {
  const { user } = useAuth()
  const toast = useToast()
  const [form, setForm] = useState(loadLlmSettings)
  const [saved, setSaved] = useState(false)
  const [testAgent, setTestAgent] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    loadTestAgentAllowed(user.id).then(setTestAgent)
  }, [user.id])

  function submitLlm(e) {
    e.preventDefault()
    saveLlmSettings(form)
    setSaved(true)
    toast.success('Generation model saved for this organization on this device.')
  }

  async function saveTestAgent(e) {
    e.preventDefault()
    setError(null)
    const err = await saveTestAgentAllowed(user.id, testAgent)
    if (err) return setError(err.message)
    toast.success(testAgent ? 'This account may run Agent test on live projects.' : 'Agent test disabled for this account.')
  }

  return (
    <div className="dash-main">
      <div className="dash-heading">
        <div>
          <p className="kicker">Organization</p>
          <h1>Admin</h1>
          <p className="muted">Who generates design, and who may run Agent test. The tester itself lives on the Projects screen.</p>
        </div>
      </div>
      {error && <ErrorBanner error={error} />}

      <form className="card settings-card" onSubmit={submitLlm}>
        <h2>Generation model</h2>
        <p className="muted">Members do not pick a model. You choose the provider the workspace should use.</p>
        <div className="provider-grid">
          {LLM_PROVIDERS.map((p) => (
            <label key={p.id} className={`provider-card ${form.provider === p.id ? 'selected' : ''}`}>
              <input
                type="radio"
                name="provider"
                value={p.id}
                checked={form.provider === p.id}
                onChange={() => setForm({ ...form, provider: p.id })}
              />
              <strong>{p.label}</strong>
              <span className="muted">{p.hint}</span>
            </label>
          ))}
        </div>
        <label className="muted" style={{ marginTop: 16 }}>Model id (optional)</label>
        <input
          placeholder="e.g. grok-4, claude-sonnet-4, gpt-4.1"
          value={form.model}
          onChange={(e) => setForm({ ...form, model: e.target.value })}
        />
        <div className="row" style={{ marginTop: 16 }}>
          <button type="submit">Save model policy</button>
          {saved && <span className="badge ok">Saved</span>}
        </div>
      </form>

      <form className="card settings-card" onSubmit={saveTestAgent}>
        <h2>Who may run Agent test</h2>
        <p className="muted">The runner is on Projects, against a live project. This only grants permission.</p>
        <label className="muted row" style={{ gap: 8 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={testAgent} onChange={(e) => setTestAgent(e.target.checked)} />
          Allow this account
        </label>
        <div style={{ marginTop: 12 }}><button type="submit">Save permission</button></div>
      </form>
    </div>
  )
}
