/** Sidebar-friendly title for generated/test project names. */
export function projectNavMeta(project) {
  const full = String(project?.name || 'Untitled')
  const kind = /^agent-test\b/i.test(full) ? 'agent test' : /^e2e\b/i.test(full) ? 'e2e' : null
  let title = full
    .replace(/^agent-test\s+/i, '')
    .replace(/^e2e\s+/i, '')
    .replace(/\s*20\d{2}-\d{2}-\d{2}T[\d\-:.Z]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!title) title = kind ? 'Project' : full
  title = title.charAt(0).toUpperCase() + title.slice(1)
  const when = project?.created_at
    ? new Date(project.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : ''
  return { title, kind, when, full }
}
