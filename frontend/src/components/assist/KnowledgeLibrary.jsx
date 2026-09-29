import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'

export default function KnowledgeLibrary() {
  const [rows, setRows] = useState([])
  const [error, setError] = useState(null)

  useEffect(() => {
    supabase.from('architecture_knowledge').select('id, framework, category, title, body').order('framework')
      .then(({ data, error: err }) => {
        if (err) setError(err.message)
        else setRows(data ?? [])
      })
  }, [])

  return (
    <div className="card">
      <span className="doc-kicker">Pattern / tactic library</span>
      <h2 className="doc-title">RAG sources already loaded</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        These chunks are global (not per-project). Assist retrieves them by full-text search and cites titles on proposals.
        You do not need to add anything to start. Extra org-specific patterns can be inserted into <code>architecture_knowledge</code> later.
      </p>
      {error && <p className="error">{error}</p>}
      {!error && !rows.length && <p className="muted">No rows yet — migration 0024 may not have been applied.</p>}
      {rows.map((r) => (
        <details key={r.id} className="assist-item">
          <summary><strong>{r.framework}</strong> · {r.title} <span className="badge muted">{r.category}</span></summary>
          <p className="muted">{r.body}</p>
        </details>
      ))}
    </div>
  )
}
