export function matchesQuery(haystack, q) {
  if (!q?.trim()) return true
  return String(haystack ?? '').toLowerCase().includes(q.trim().toLowerCase())
}

export function requirementKind(refCode) {
  const code = String(refCode ?? '').toUpperCase()
  if (code.startsWith('NFR')) return 'NFR'
  if (code.startsWith('CON')) return 'CON'
  if (code.startsWith('FR')) return 'FR'
  return 'other'
}
