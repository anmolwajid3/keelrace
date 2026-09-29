export async function createGithubGist({ token, filename, files, description }) {
  const body = {
    description: description || 'KeelRace skeleton',
    public: false,
    files: {},
  }
  for (const f of files) {
    const path = f.path || filename
    body.files[path.replaceAll('/', '__')] = { content: f.content || ' ' }
  }
  const res = await fetch('https://api.github.com/gists', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
    },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.message || `GitHub gist failed (${res.status})`)
  return data.html_url
}

export function githubLinked(user) {
  return (user?.identities ?? []).some((i) => i.provider === 'github')
}

export function githubToken(session) {
  if (session?.provider_token && session.user?.app_metadata?.provider === 'github') return session.provider_token
  return session?.provider_token || null
}
