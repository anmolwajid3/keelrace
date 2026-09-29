import { confidenceBadge } from '../../lib/assist.js'

export function Confidence({ value }) {
  const b = confidenceBadge(value)
  return <span className={`badge ${b.cls}`}>{b.label}</span>
}

export function Grounding({ items }) {
  if (!items?.length) return null
  return (
    <p className="muted" style={{ marginBottom: 0 }}>
      Sources: {items.map((g) => g.title || g.framework).filter(Boolean).join(' · ')}
    </p>
  )
}

export function Questions({ items }) {
  if (!items?.length) return null
  return (
    <ul className="assist-questions">
      {items.map((q, i) => <li key={i}>{q}</li>)}
    </ul>
  )
}

export function AssistNote({ children }) {
  return <p className="muted" style={{ marginTop: 0 }}>{children}</p>
}
