export function normalizeFlow(content) {
  const rawNodes = content?.nodes ?? content?.steps ?? []
  const rawEdges = content?.edges ?? content?.links ?? []
  const nodes = rawNodes.map((n, i) => {
    if (typeof n === 'string') return { id: slug(n), label: n }
    const label = n.label || n.name || n.title || n.id || `Step ${i + 1}`
    const id = String(n.id || n.key || slug(label))
    return { id, label, kind: n.kind, row: n.row }
  }).filter((n) => n.id)
  const idSet = new Set(nodes.map((n) => n.id))
  const byLabel = new Map(nodes.map((n) => [n.label.toLowerCase(), n.id]))
  const edges = rawEdges.map((e) => {
    if (typeof e === 'string') {
      const parts = e.split(/\s*(?:→|->|=>|to)\s*/i).filter(Boolean)
      if (parts.length < 2) return null
      return { from: resolve(parts[0], idSet, byLabel), to: resolve(parts[1], idSet, byLabel), label: e }
    }
    const from = resolve(e.from ?? e.source ?? e.src, idSet, byLabel)
    const to = resolve(e.to ?? e.target ?? e.dst, idSet, byLabel)
    if (!from || !to) return null
    return { from, to, label: e.label, kind: e.kind }
  }).filter(Boolean)
  return { nodes, edges }
}

function slug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'node'
}

function resolve(value, idSet, byLabel) {
  if (value == null) return null
  const s = String(value)
  if (idSet.has(s)) return s
  const slugged = slug(s)
  if (idSet.has(slugged)) return slugged
  return byLabel.get(s.toLowerCase()) ?? null
}

export function flowFromComponents(components = []) {
  const nodes = components.map((c) => ({ id: c.id || slug(c.name), label: c.name }))
  const edges = nodes.slice(1).map((n, i) => ({ from: nodes[i].id, to: n.id }))
  return { nodes, edges }
}
