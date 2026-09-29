import { createHash } from 'node:crypto'

export function sha256Hex(text) {
  return createHash('sha256').update(text).digest('hex')
}

export function canonicalMessages(messages) {
  const strip = (s) =>
    s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, 'UUID')
  return messages.map((m) => ({
    role: m.role,
    content: typeof m.content === 'string' ? strip(m.content) : m.content,
  }))
}

export function detectRole(messages) {
  const blob = messages.map((m) => String(m.content ?? '')).join('\n').toLowerCase()
  if (blob.includes('requirements critic')) return 'critic'
  if (blob.includes('add-style architectural drivers')) return 'drivers'
  if (blob.includes('propose exactly 3 named') || blob.includes('propose 2 or 3 architecture')) return 'candidates'
  if (blob.includes("devil's advocate")) return 'challenge'
  if (blob.includes('draft an adr') || blob.includes('leave chosen_option empty')) return 'draft_adr'
  if (blob.includes('walk an atam scenario')) return 'walk_scenarios'
  if (blob.includes('compare one architecture candidate')) return 'compare_candidates'
  if (blob.includes('sensitivity and trade-off')) return 'propose_points'
  if (blob.includes('atam/saam') || blob.includes('utility tree')) return 'scenarios'
  if (blob.includes('produce mermaid')) return 'views'
  if (blob.includes('change-blast brief')) return 'change_brief'
  if (blob.includes("this project's recorded architecture")) return 'ask'
  if (blob.includes('generating a high-level design')) return 'generate_hld'
  if (blob.includes('fix mermaid only')) return 'mermaid_fix'
  return 'other'
}

export function caseFingerprint(messages) {
  const user = messages.filter((m) => m.role === 'user').map((m) => String(m.content ?? '')).join('\n')
  const canon = user.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi,
    'UUID',
  )
  const reqLines = canon
    .split(/\n/)
    .map((l) => l.trim())
    .filter((l) => /^(FR|NFR|CON|QA|UC)-\d+/i.test(l) || /[A-Z]{1,6}-\d+:/.test(l))
    .slice(0, 40)
    .join('\n')
  return reqLines || canon.slice(0, 1200)
}

export async function cassetteKeys(model, json, messages) {
  const exact = sha256Hex(JSON.stringify({ model, json: !!json, messages }))
  const canonical = sha256Hex(JSON.stringify({ model, json: !!json, messages: canonicalMessages(messages) }))
  const role = detectRole(messages)
  const fp = sha256Hex(caseFingerprint(messages)).slice(0, 16)
  return {
    exact,
    canonical,
    alias: `alias:${role}:${fp}`,
    roleOnly: `alias:${role}:default`,
    caseAlias: null,
    role,
  }
}

export function mermaidValid(src) {
  if (!src || typeof src !== 'string') return false
  const s = src.trim()
  if (!/^(flowchart|graph|sequenceDiagram|C4Context|C4Container)/m.test(s)) return false
  if (/[A-Za-z][A-Za-z0-9]*[ \t]+[A-Za-z][A-Za-z0-9]*[ \t]*\[/.test(s)) return false
  return s.length < 8000
}

export function heuristicCritic(reqs) {
  const findings = []
  for (const r of reqs) {
    const text = `${r.title} ${r.body}`
    if (/\band\b/i.test(r.title) || (r.body.match(/\band\b/gi) || []).length >= 2) {
      findings.push({
        requirement_id: r.id,
        severity: 'medium',
        title: `${r.ref_code} looks compound`,
        body: 'More than one demand in one statement. Split if they can fail independently.',
        suggested_rewrite: null,
        confidence: 'partial',
        questions: [],
      })
    }
    if (!/\b(shall|must|will|should)\b/i.test(text)) {
      findings.push({
        requirement_id: r.id,
        severity: 'low',
        title: `${r.ref_code} has no obligation verb`,
        body: '29148-style requirements usually use shall/must.',
        suggested_rewrite: null,
        confidence: 'partial',
        questions: ['What test would fail if this were absent?'],
      })
    }
  }
  return findings
}
