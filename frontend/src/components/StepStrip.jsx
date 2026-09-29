import { Link } from 'react-router-dom'

export default function StepStrip({ progress, projectId, compact = false }) {
  if (!progress?.steps) return null
  const href = (to) => `/projects/${projectId}${to ? `/${to}` : ''}`
  const nextId = progress.next?.id
  return (
    <ol className={`step-strip${compact ? ' compact' : ''}`} aria-label="Architecture loop, one step per page">
      {progress.steps.map((s) => {
        const kind = s.done ? 'done' : s.id === nextId ? 'now' : 'todo'
        const status = s.done ? 'completed' : s.id === nextId ? 'in progress' : 'pending'
        return (
          <li key={s.id}>
            <Link
              to={href(s.to)}
              className={`step-chip ${kind}`}
              title={`Step ${s.n}: ${s.label} (${status})`}
            >
              <span className="step-chip-n">{s.n}</span>
              {!compact && <span className="step-chip-label">{s.label}</span>}
            </Link>
          </li>
        )
      })}
    </ol>
  )
}
