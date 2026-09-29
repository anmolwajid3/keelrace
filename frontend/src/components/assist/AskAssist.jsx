import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { callAssist } from '../../lib/assist.js'
import ErrorBanner from '../ErrorBanner.jsx'
import { AssistNote } from './AssistBits.jsx'

export function AskArchitecture({ projectId }) {
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [question, setQuestion] = useState('')
  const [messages, setMessages] = useState([])

  async function load() {
    const { data } = await supabase.from('assist_ask_messages').select('*').eq('project_id', projectId).order('created_at').limit(40)
    setMessages(data ?? [])
  }
  useEffect(() => { load() }, [projectId])

  async function ask(e) {
    e.preventDefault()
    if (!question.trim()) return
    setError(null)
    setBusy(true)
    try {
      const res = await callAssist('ask', { project_id: projectId, question: question.trim() })
      const now = Date.now()
      setMessages((prev) => [
        ...prev,
        { id: `u-${now}`, role: 'user', content: question.trim(), citations: [] },
        { id: `a-${now}`, role: 'assistant', content: res.answer, citations: res.citations ?? [] },
      ])
      setQuestion('')
      await load()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card">
      <span className="doc-kicker">Ask this architecture</span>
      <h2 className="doc-title">Answers from the recorded graph</h2>
      <AssistNote>If a requirement, decision, or file is not in the project, the model must say so. This is not a general chat.</AssistNote>
      {error && <ErrorBanner error={error} />}
      <div className="assist-chat">
        {messages.map((m) => (
          <div key={m.id} className={`assist-msg ${m.role}`}>
            <p style={{ margin: 0 }}>{m.content}</p>
            {m.role === 'assistant' && m.citations?.length > 0 && (
              <p className="muted" style={{ margin: '4px 0 0' }}>Cited: {m.citations.join(', ')}</p>
            )}
          </div>
        ))}
      </div>
      <form onSubmit={ask} className="row wrap" style={{ marginTop: 8 }}>
        <input placeholder="e.g. Which decision owns FR-2?" value={question} onChange={(e) => setQuestion(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
        <button type="submit" disabled={busy}>{busy ? 'Looking up…' : 'Ask'}</button>
      </form>
    </div>
  )
}

