import { readFileSync } from 'fs'
import { createClient } from '../frontend/node_modules/@supabase/supabase-js/dist/index.mjs'

function load(p) {
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i < 0) continue
    const k = t.slice(0, i).trim()
    const v = t.slice(i + 1).trim()
    if (process.env[k] == null) process.env[k] = v
  }
}
load('./frontend/.env')
load('./tests/.env')

const url = process.env.VITE_SUPABASE_URL
const key = process.env.VITE_SUPABASE_PUBLISHABLE_KEY
const sb = createClient(url, key)

const { error: authErr } = await sb.auth.signInWithPassword({
  email: process.env.KEELRACE_E2E_EMAIL,
  password: process.env.KEELRACE_E2E_PASSWORD,
})
if (authErr) {
  console.log(JSON.stringify({ step: 'auth', ok: false, error: authErr.message }))
  process.exit(1)
}

const { data: knowledge, error: kErr } = await sb
  .from('architecture_knowledge')
  .select('framework, category, title')
  .order('framework')

const { data: projects, error: pErr } = await sb
  .from('projects')
  .select('id, name, archived_at, kind')
  .is('archived_at', null)
  .order('created_at', { ascending: false })
  .limit(12)

const pick = (projects ?? []).find((p) => p.kind !== 'demo') || projects?.[0]
const out = {
  knowledgeOk: !kErr,
  knowledgeError: kErr?.message ?? null,
  knowledgeCount: knowledge?.length ?? 0,
  titles: (knowledge ?? []).map((r) => `${r.framework}: ${r.title}`),
  projectsError: pErr?.message ?? null,
  projectCount: projects?.length ?? 0,
  project: pick ? { id: pick.id, name: pick.name } : null,
}

if (!pick) {
  console.log(JSON.stringify({ ...out, assist: 'no project' }, null, 2))
  process.exit(0)
}

const { data: sets } = await sb.from('requirement_sets').select('id, status, version').eq('project_id', pick.id).order('version', { ascending: false }).limit(1)
const { count: reqCount } = await sb.from('requirements').select('id', { count: 'exact', head: true }).eq('requirement_set_id', sets?.[0]?.id ?? '00000000-0000-0000-0000-000000000000')

async function call(action, extra = {}) {
  const started = Date.now()
  try {
    const data = await sb.functions.invoke('architect-assist', {
      body: { action, project_id: pick.id, requirement_set_id: sets?.[0]?.id, ...extra },
    })
    return {
      action,
      ms: Date.now() - started,
      error: data.error?.message ?? null,
      keys: data.data && typeof data.data === 'object' ? Object.keys(data.data) : [],
      note: data.data?.note ?? null,
      counts: {
        findings: data.data?.findings?.length,
        drivers: data.data?.drivers?.length,
        candidates: data.data?.candidates?.length,
        mappings: data.data?.mappings?.length,
        scenarios: data.data?.scenarios?.length,
        walks: data.data?.walks?.length,
        outcomes: data.data?.outcomes?.length,
        points: data.data?.points?.length,
      },
      sampleGrounding: data.data?.findings?.[0]?.grounding || data.data?.drivers?.[0]?.grounding || data.data?.candidates?.[0]?.grounding || data.data?.draft?.grounding || null,
    }
  } catch (e) {
    return { action, ms: Date.now() - started, error: String(e) }
  }
}

const assist = []
if ((reqCount ?? 0) > 0) {
  assist.push(await call('critic'))
  assist.push(await call('drivers'))
} else {
  assist.push({ action: 'critic', skipped: 'no requirements' })
}
assist.push(await call('ask', { question: 'Which requirements exist and which decisions cite them?' }))

out.reqSet = sets?.[0] ?? null
out.reqCount = reqCount ?? 0
out.assist = assist
console.log(JSON.stringify(out, null, 2))
