export function initialsFromUser(user) {
  const name = user?.user_metadata?.full_name || user?.user_metadata?.name || ''
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  if (parts.length === 1 && parts[0].length >= 2) return parts[0].slice(0, 2).toUpperCase()
  const email = user?.email || 'U'
  const local = email.split('@')[0] || 'U'
  if (local.length >= 2) return local.slice(0, 2).toUpperCase()
  return (local[0] || 'U').toUpperCase()
}

export function avatarHue(seed) {
  let h = 2166136261
  for (const c of String(seed || 'user')) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  return Math.abs(h) % 360
}

export function avatarImageUrl(user) {
  return user?.user_metadata?.avatar_url
    || user?.identities?.find((i) => i.identity_data?.avatar_url)?.identity_data?.avatar_url
    || null
}
