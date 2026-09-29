import { useId, useMemo } from 'react'

export default function DiagramView({ nodes, edges, height = 360 }) {
  const markerId = useId().replace(/:/g, '')
  const width = 720
  const pad = 64
  const cx = width / 2
  const cy = height / 2
  const radius = Math.min(width, height) / 2 - pad
  const nodeRadius = 36

  const positions = useMemo(() => {
    const map = {}
    const n = nodes.length || 1
    nodes.forEach((node, i) => {
      const angle = (2 * Math.PI * i) / n - Math.PI / 2
      map[node.id] = { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) }
    })
    return map
  }, [nodes, cx, cy, radius])

  const byId = useMemo(() => Object.fromEntries(nodes.map((n) => [n.id, n.label])), [nodes])

  if (!nodes.length) return <p className="muted">Nothing to diagram yet.</p>

  const strokeFor = (kind) => {
    if (kind === 'alt') return 'var(--warn)'
    if (kind === 'safety') return 'var(--danger)'
    if (kind === 'loop') return 'var(--ok)'
    return 'var(--muted)'
  }

  const kindsUsed = new Set(edges.map((e) => e.kind).filter(Boolean))

  return (
    <div className="diagram-frame">
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
        <defs>
          <marker id={markerId} markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
            <polygon points="0 0, 8 3, 0 6" fill="var(--muted)" />
          </marker>
        </defs>
        {edges.map((e, i) => {
          const from = positions[e.from]
          const to = positions[e.to]
          if (!from || !to) return null
          const color = strokeFor(e.kind)
          if (e.from === e.to) {
            const d = `M ${from.x + 8} ${from.y - nodeRadius} C ${from.x + 54} ${from.y - 72}, ${from.x + 54} ${from.y + 12}, ${from.x + nodeRadius} ${from.y}`
            return (
              <g key={i}>
                <path d={d} fill="none" stroke={color} strokeWidth="1.6" markerEnd={`url(#${markerId})`} />
                {e.label && <text x={from.x + 58} y={from.y - 40} fontSize="10" fill={color}>{e.label}</text>}
              </g>
            )
          }
          const dx = to.x - from.x
          const dy = to.y - from.y
          const dist = Math.hypot(dx, dy) || 1
          const startX = from.x + (dx / dist) * nodeRadius
          const startY = from.y + (dy / dist) * nodeRadius
          const endX = to.x - (dx / dist) * (nodeRadius + 8)
          const endY = to.y - (dy / dist) * (nodeRadius + 8)
          const curve = 18 + (i % 4) * 10
          const cpx = (startX + endX) / 2 + (-dy / dist) * curve
          const cpy = (startY + endY) / 2 + (dx / dist) * curve
          return (
            <g key={i}>
              <path
                d={`M ${startX} ${startY} Q ${cpx} ${cpy} ${endX} ${endY}`}
                fill="none"
                stroke={color}
                strokeWidth="1.6"
                markerEnd={`url(#${markerId})`}
              />
              {e.label && (
                <text x={cpx} y={cpy - 4} textAnchor="middle" fontSize="10" fill={color}>{e.label}</text>
              )}
            </g>
          )
        })}
        {nodes.map((node) => {
          const pos = positions[node.id]
          if (!pos) return null
          const label = String(node.label || node.id || '')
          const shown = label.length > 18 ? `${label.slice(0, 16)}…` : label
          return (
            <g key={node.id}>
              <circle cx={pos.x} cy={pos.y} r={nodeRadius} fill="var(--panel)" stroke="var(--accent)" strokeWidth="1.5" />
              <text x={pos.x} y={pos.y + 4} textAnchor="middle" fontSize="10" fill="var(--text)">{shown}</text>
            </g>
          )
        })}
      </svg>
      {kindsUsed.size > 0 && (
        <ul className="diagram-legend">
          <li><span className="diagram-dot" style={{ background: 'var(--muted)' }} />Happy path</li>
          <li><span className="diagram-dot" style={{ background: 'var(--ok)' }} />Loop</li>
          <li><span className="diagram-dot" style={{ background: 'var(--warn)' }} />Alternate</li>
          <li><span className="diagram-dot" style={{ background: 'var(--danger)' }} />Safety / edge</li>
        </ul>
      )}
      {kindsUsed.size === 0 && (
        <ul className="diagram-legend">
          {nodes.map((n) => (
            <li key={n.id}><span className="diagram-dot" />{n.label}</li>
          ))}
        </ul>
      )}
      {edges.length > 0 && (
        <p className="faint" style={{ margin: '0 12px 10px' }}>
          {edges.map((e) => `${byId[e.from] ?? '?'} → ${byId[e.to] ?? '?'}${e.label ? ` (${e.label})` : ''}`).join(' · ')}
        </p>
      )}
    </div>
  )
}
