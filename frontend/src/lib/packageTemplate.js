import { normalizeFlow, flowFromComponents } from './flowShape.js'

function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function nl(s) {
  return esc(s).replaceAll('\n', '<br/>')
}

function asList(value) {
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
  if (typeof value === 'string' && value.trim()) {
    return value.split(/;\s+|,\s+(?=[A-Za-z_]\w*\()/).map((s) => s.trim()).filter(Boolean)
  }
  return []
}

export function layerFor(name = '') {
  const n = name.toLowerCase()
  if (/(view|widget|onboarding|settings|chart|visual|ui|theme|navigat|home)/.test(n)) return 'Experience'
  if (/(repository|storage|persist|sync|cloud|database|sql|encrypt)/.test(n)) return 'Data and sync'
  if (/(viewmodel|engine|manager|service|iap|export|notif|controller|analytics)/.test(n)) return 'Application'
  return 'Supporting'
}

function wrapLines(text, max = 22) {
  const words = String(text || '').split(/\s+/)
  const lines = []
  let cur = ''
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w
    if (next.length > max && cur) {
      lines.push(cur)
      cur = w
    } else cur = next
  }
  if (cur) lines.push(cur)
  return lines.slice(0, 3)
}

export function componentDiagramSvg(components = []) {
  const items = components.map((c) => ({
    id: c.id,
    name: c.name || 'Component',
    layer: layerFor(c.name),
    desc: c.description || '',
  }))
  if (!items.length) return ''

  const layers = ['Experience', 'Application', 'Data and sync', 'Supporting']
    .map((name) => ({ name, items: items.filter((i) => i.layer === name) }))
    .filter((l) => l.items.length)

  const colW = 168
  const colH = 52
  const gap = 12
  const padX = 24
  const padY = 36
  const maxCols = 4
  let y = padY
  const layerBlocks = []
  for (const layer of layers) {
    const cols = Math.min(maxCols, layer.items.length)
    const rows = Math.ceil(layer.items.length / cols)
    const width = padX * 2 + cols * colW + (cols - 1) * gap
    layerBlocks.push({ layer, cols, rows, y, width })
    y += 28 + rows * (colH + gap) + 16
  }
  const width = Math.max(720, ...layerBlocks.map((b) => b.width))
  const height = y + 8

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
    <rect width="${width}" height="${height}" fill="#f8fafc"/>
    ${layerBlocks.map((b) => {
      const { layer, cols, rows, y: top } = b
      const boxes = layer.items.map((item, i) => {
        const r = Math.floor(i / cols)
        const c = i % cols
        const x = padX + c * (colW + gap)
        const boxY = top + 24 + r * (colH + gap)
        const lines = wrapLines(item.name, 20)
        const text = lines.map((ln, li) => `<tspan x="${x + colW / 2}" dy="${li === 0 ? 0 : 13}">${esc(ln)}</tspan>`).join('')
        return `<g>
          <rect x="${x}" y="${boxY}" width="${colW}" height="${colH}" rx="8" fill="#fff" stroke="#4338ca" stroke-width="1.2"/>
          <text x="${x + colW / 2}" y="${boxY + 22}" text-anchor="middle" font-size="11" font-family="Segoe UI, system-ui, sans-serif" fill="#1e1b4b">${text}</text>
        </g>`
      }).join('')
      return `<g>
        <text x="${padX}" y="${top + 14}" font-size="12" font-weight="700" font-family="Segoe UI, system-ui, sans-serif" fill="#4338ca">${esc(layer.name)}</text>
        ${boxes}
      </g>`
    }).join('')}
  </svg>`
}

export function prototypeDiagramSvg(content) {
  const { nodes, edges } = normalizeFlow(content)
  if (!nodes.length) return '<p class="empty">No flow recorded yet.</p>'
  const boxW = 120
  const boxH = 38
  const gapX = 36
  const rowIds = [...new Set(nodes.map((n) => n.row ?? 0))].sort((a, b) => a - b)
  const cols = Math.max(1, ...rowIds.map((r) => nodes.filter((n) => (n.row ?? 0) === r).length))
  const width = Math.max(720, 48 + cols * (boxW + gapX))
  const height = 88 + rowIds.length * 110
  const pos = {}
  rowIds.forEach((row, ri) => {
    const inRow = nodes.filter((n) => (n.row ?? 0) === row)
    inRow.forEach((node, i) => {
      pos[node.id] = {
        x: 36 + i * (boxW + gapX) + boxW / 2,
        y: 56 + ri * 110,
        label: node.label || node.id,
      }
    })
  })
  const strokeFor = (kind) => (kind === 'alt' ? '#b45309' : kind === 'safety' ? '#b91c1c' : kind === 'loop' ? '#0f766e' : '#64748b')
  const paths = edges.map((e, i) => {
    const a = pos[e.from]
    const b = pos[e.to]
    if (!a || !b) return ''
    const color = strokeFor(e.kind)
    if (e.from === e.to) {
      const d = `M ${a.x + 10} ${a.y - boxH / 2} C ${a.x + 52} ${a.y - 48}, ${a.x + 52} ${a.y + 8}, ${a.x + boxW / 2 - 4} ${a.y}`
      const lx = a.x + 58
      const ly = a.y - 28
      return `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.4" marker-end="url(#arr)"/>${e.label ? `<text x="${lx}" y="${ly}" font-size="9" fill="${color}">${esc(e.label)}</text>` : ''}`
    }
    const mx = (a.x + b.x) / 2
    const my = (a.y + b.y) / 2
    const dx = b.x - a.x
    const dy = b.y - a.y
    const dist = Math.hypot(dx, dy) || 1
    const curve = (e.kind === 'loop' || e.kind === 'alt' || e.kind === 'safety' || a.x > b.x ? 1 : 0) * (22 + (i % 3) * 8)
    const cxp = mx + (-dy / dist) * curve
    const cyp = my + (dx / dist) * curve
    const d = `M ${a.x} ${a.y} Q ${cxp} ${cyp} ${b.x} ${b.y}`
    return `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.4" marker-end="url(#arr)"/>${e.label ? `<text x="${cxp}" y="${cyp - 6}" font-size="9" text-anchor="middle" fill="${color}">${esc(e.label)}</text>` : ''}`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
    <defs><marker id="arr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><polygon points="0 0, 8 3, 0 6" fill="#64748b"/></marker></defs>
    <rect width="${width}" height="${height}" fill="#f8fafc"/>
    ${paths}
    ${nodes.map((node) => {
      const p = pos[node.id]
      const lines2 = wrapLines(p.label, 16)
      const text = lines2.map((ln, li) => `<tspan x="${p.x}" dy="${li === 0 ? 0 : 12}">${esc(ln)}</tspan>`).join('')
      return `<g>
        <rect x="${p.x - boxW / 2}" y="${p.y - boxH / 2}" width="${boxW}" height="${boxH}" rx="8" fill="#eef2ff" stroke="#4338ca"/>
        <text x="${p.x}" y="${p.y - (lines2.length - 1) * 6}" text-anchor="middle" font-size="11" font-family="Segoe UI, system-ui, sans-serif" fill="#1e1b4b">${text}</text>
      </g>`
    }).join('')}
  </svg>`
}

export function productTitle(project, hld) {
  const raw = project?.name || 'Architecture'
  if (/^e2e\b/i.test(raw)) {
    const summary = hld?.content?.summary || ''
    const first = summary.split(/[.!?]/)[0]
    if (first && first.length > 12 && first.length < 80) return first.trim()
    return 'Product architecture'
  }
  return raw
}

function groupReqs(reqs = []) {
  const buckets = { FR: [], NFR: [], CON: [], Other: [] }
  for (const r of reqs) {
    const code = (r.ref_code || '').toUpperCase()
    if (code.startsWith('FR')) buckets.FR.push(r)
    else if (code.startsWith('NFR')) buckets.NFR.push(r)
    else if (code.startsWith('CON')) buckets.CON.push(r)
    else buckets.Other.push(r)
  }
  return buckets
}

function reqTable(rows, caption) {
  if (!rows.length) return ''
  return `<h3>${esc(caption)} (${rows.length})</h3>
  <table>
    <thead><tr><th style="width:88px">ID</th><th>What it asks for</th></tr></thead>
    <tbody>${rows.map((r) => `<tr><td><strong>${esc(r.ref_code)}</strong></td><td><strong>${esc(r.title)}</strong><div class="quiet">${nl(r.body)}</div></td></tr>`).join('')}</tbody>
  </table>`
}

function nfrGroups(nfrs = []) {
  const groups = { Performance: [], Reliability: [], Security: [], Usability: [], Other: [] }
  for (const n of nfrs) {
    const t = `${n.name} ${n.description}`.toLowerCase()
    if (/(launch|latency|load|ms|scalab|respons)/.test(t)) groups.Performance.push(n)
    else if (/(crash|uptime|offline|reliab|battery)/.test(t)) groups.Reliability.push(n)
    else if (/(encrypt|privacy|gdpr|track|secure)/.test(t)) groups.Security.push(n)
    else if (/(usable|thumb|navigat|voice|access|theme)/.test(t)) groups.Usability.push(n)
    else groups.Other.push(n)
  }
  return Object.entries(groups).filter(([, rows]) => rows.length)
}

export function pickCanonicalHld(docs = []) {
  const hlds = docs.filter((d) => d.type === 'HLD')
  return hlds.find((d) => d.status === 'approved')
    || hlds.find((d) => d.status !== 'superseded')
    || hlds[0]
    || null
}

export function pickCanonicalLlds(llds = [], componentIds = []) {
  const idset = new Set(componentIds)
  const relevant = llds.filter((d) => d.component_id && idset.has(d.component_id))
  const byComp = new Map()
  for (const d of relevant) {
    const prev = byComp.get(d.component_id)
    const score = (x) => (x.status === 'approved' ? 2 : x.status === 'draft' ? 0 : 1) * 1000 + (x.version || 0)
    if (!prev || score(d) >= score(prev)) byComp.set(d.component_id, d)
  }
  return [...byComp.values()]
}

export function buildPackageHtml(bundle) {
  const {
    project, set, reqs, nfrs, hld, llds, components, decisions, prototypes, artifacts, snapshots, rules, progress,
  } = bundle
  const title = productTitle(project, hld)
  const when = new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  const done = progress?.completed ?? 0
  const total = progress?.total ?? 10
  const remaining = progress?.remaining ?? []
  const buckets = groupReqs(reqs)
  const nfrBy = nfrGroups(nfrs)
  const comps = components ?? []
  const catalog = comps.map((c) => {
    const lld = (llds ?? []).find((d) => d.component_id === c.id)
    return { ...c, layer: layerFor(c.name), lld }
  })

  const adrBlocks = (decisions ?? []).map((d, i) => {
    const alts = Array.isArray(d.alternatives_considered) ? d.alternatives_considered : []
    return `<article class="adr">
      <h3>ADR ${i + 1}. ${esc(d.decision_point)}</h3>
      <p><span class="pill">${esc(d.status || 'recorded')}</span> <span class="pill">${esc(d.risk_level || 'unrated')} risk</span></p>
      <p><strong>We chose:</strong> ${esc(d.chosen_option)}</p>
      ${alts.length ? `<p><strong>We rejected:</strong></p><ul>${alts.map((a) => `<li>${esc(a.option || a)}${a.rejection_reason ? ` — ${esc(a.rejection_reason)}` : ''}</li>`).join('')}</ul>` : ''}
    </article>`
  }).join('')

  const lldBlocks = catalog.filter((c) => c.lld).map((c) => {
    const d = c.lld
    const ifaces = asList(d.content?.interfaces)
    return `<article class="lld">
      <h3>${esc(c.name)}</h3>
      <p class="quiet">${esc(c.layer)} · LLD v${d.version} · ${esc(d.status)}</p>
      <p>${nl(d.content?.summary || c.description)}</p>
      ${ifaces.length ? `<p><strong>Interfaces</strong></p><ul>${ifaces.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      ${d.content?.data_model ? `<p><strong>Data</strong></p><p>${nl(d.content.data_model)}</p>` : ''}
    </article>`
  }).join('')

  const files = artifacts ?? []
  const dirs = {}
  for (const a of files) {
    const dir = a.path?.includes('/') ? a.path.split('/').slice(0, -1).join('/') : '(root)'
    dirs[dir] = dirs[dir] || []
    dirs[dir].push(a)
  }
  const tree = Object.entries(dirs).map(([dir, list]) => `<p class="quiet">${esc(dir)}/</p><ul>${list.map((a) => `<li><code>${esc(a.path)}</code></li>`).join('')}</ul>`).join('')

  const protoSource = (prototypes ?? []).find((p) => normalizeFlow(p.content).nodes.length)
    || { type: 'flow-diagram', content: flowFromComponents(components) }
  const protoFlow = normalizeFlow(protoSource.content)
  const protoBlocks = protoFlow.nodes.length
    ? `<h3>Primary user flow</h3>
    <p class="quiet">This is the flow the approved design claims to support. Use it to walk a review, not as pixel-perfect UI.</p>
    ${prototypeDiagramSvg(protoFlow)}`
    : '<p class="empty">No prototype generated. Generate a flow diagram on the approved HLD so reviewers can walk the product.</p>'

  const summary = hld?.content?.summary
    || 'This package collects the locked requirements, the proposed system map, the decisions that justify it, and the skeleton that traces back to those decisions.'

  const liveRules = (rules ?? []).filter((r) => r.status === 'in_force')
  const retiredRules = (rules ?? []).filter((r) => r.status === 'replaced')
  const ruleItems = (rows) => rows.map((r) => {
    const covers = r.covers || {}
    const labels = Array.isArray(covers.labels) ? covers.labels : []
    const paths = Array.isArray(covers.paths) ? covers.paths : []
    const cover = [...labels, ...paths].filter(Boolean).join(', ')
    return `<li><strong>${esc(r.rule_text)}</strong><div class="quiet">Allowed to end when: ${esc(r.ends_when || '—')}${cover ? `. Covers: ${esc(cover)}` : ''}${r.replaced_reason ? `. Retired because: ${esc(r.replaced_reason)}` : ''}</div></li>`
  }).join('')
  const rulesBlock = `<h3>In force</h3>
    ${liveRules.length ? `<ul>${ruleItems(liveRules)}</ul>` : '<p class="empty">No standing rule is in force. A decision becomes a rule only after you confirm it on the ADR ledger.</p>'}
    <h3>Retired</h3>
    ${retiredRules.length ? `<ul>${ruleItems(retiredRules)}</ul>` : '<p class="quiet">Nothing has been retired. A rule leaves force only when you point at a different decision and write why.</p>'}`

  const toc = [
    ['1', 'What the architect is accountable for', 'purpose'],
    ['2', 'What we must build', 'reqs'],
    ['3', 'Quality bar', 'nfrs'],
    ['4', 'System map', 'hld'],
    ['5', 'Component catalog', 'catalog'],
    ['6', 'Component designs', 'lld'],
    ['7', 'Decisions (ADRs)', 'adr'],
    ['8', 'Flows', 'flow'],
    ['9', 'Starting code', 'skel'],
    ['10', 'How this design changes', 'change'],
  ]

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/>
<title>${esc(title)} — Architecture design document</title>
<style>
  :root { --ink:#0f172a; --muted:#475569; --line:#cbd5e1; --band:#1e1b4b; --paper:#fff; }
  @page { size: A4; margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body { margin: 0; color: var(--ink); font: 12.5px/1.5 "Segoe UI", Calibri, system-ui, sans-serif; background: #e2e8f0; }
  .page { max-width: 820px; margin: 0 auto; background: var(--paper); padding: 36px 40px 56px; }
  .cover { background: var(--band); color: #eef2ff; padding: 36px 40px; margin: -36px -40px 28px; }
  .cover h1 { margin: 8px 0 0; font-size: 28px; line-height: 1.2; }
  .kicker { letter-spacing: .12em; text-transform: uppercase; font-size: 11px; opacity: .8; }
  h2 { font-size: 18px; border-bottom: 2px solid var(--band); padding-bottom: 6px; margin: 28px 0 12px; }
  h3 { font-size: 14px; margin: 18px 0 8px; }
  p, li { color: var(--ink); }
  .quiet { color: var(--muted); font-size: 12px; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0 16px; }
  th, td { border: 1px solid var(--line); padding: 8px 10px; vertical-align: top; text-align: left; }
  th { background: #f1f5f9; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
  .pill { display: inline-block; border: 1px solid #c7d2fe; background: #eef2ff; color: #3730a3; border-radius: 999px; padding: 1px 8px; font-size: 11px; margin-right: 6px; }
  .todo { background: #fff7ed; border: 1px solid #fdba74; padding: 12px 16px; border-radius: 8px; }
  .adr, .lld { border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; margin: 10px 0; page-break-inside: avoid; }
  svg { display: block; max-width: 100%; height: auto; margin: 8px 0 16px; border: 1px solid var(--line); border-radius: 8px; }
  nav ol { columns: 2; }
  .meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 24px; font-size: 13px; margin-top: 16px; }
  code { font-family: Consolas, "Courier New", monospace; font-size: 11.5px; }
  .empty { color: var(--muted); font-style: italic; }
  @media print { body { background: #fff; } .page { max-width: none; padding: 0; } .cover { margin: 0 0 20px; } }
</style></head><body><div class="page">
  <header class="cover">
    <div class="kicker">Architecture design document</div>
    <h1>${esc(title)}</h1>
    <div class="meta-grid">
      <div>Status: ${esc(hld?.status || 'draft')}</div>
      <div>Requirement set ${set ? `v${set.version}` : '—'}</div>
      <div>HLD ${hld ? `v${hld.version}` : 'not generated'}</div>
      <div>Exported ${esc(when)}</div>
      <div>${comps.length} components</div>
      <div>${(decisions || []).length} recorded decisions</div>
    </div>
  </header>

  ${remaining.length ? `<div class="todo"><strong>This export is incomplete (${done}/${total} loop steps done).</strong> A reviewer can still read what exists. Missing: ${remaining.map((s) => esc(s.label)).join('; ')}.</div>` : `<p><strong>Loop complete (${done}/${total}).</strong> This package is complete enough to circulate for review.</p>`}

  <nav>
    <h2>Contents</h2>
    <ol>${toc.map(([n, label]) => `<li>${n}. ${esc(label)}</li>`).join('')}</ol>
  </nav>

  <h2 id="purpose">1. What the architect is accountable for</h2>
  <p>${esc(summary)}</p>
  <p>Read this page before the rest. It is the list you would defend in a review, and the list a later change is checked against. A sentence here stays in force until you replace it with another decision and a written reason. Prose that says “replace the rule” does not replace it.</p>
  ${rulesBlock}
  <p class="quiet">Language, database product, and hosting are decisions only when they appear in the settled questions below. If they are missing, they have not been decided.</p>

  <h2 id="reqs">2. What we must build</h2>
  ${reqs?.length ? `${reqTable(buckets.FR, 'Capabilities (functional)')}${reqTable(buckets.CON, 'Constraints')}${reqTable(buckets.Other, 'Other requirements')}` : '<p class="empty">No requirements locked yet.</p>'}

  <h2 id="nfrs">3. Quality bar</h2>
  ${nfrs?.length ? nfrBy.map(([name, rows]) => `<h3>${esc(name)}</h3><ul>${rows.map((n) => `<li><strong>${esc(n.name)}</strong> — ${esc(n.description)}</li>`).join('')}</ul>`).join('') : '<p class="empty">No NFRs recorded. Approval will keep blocking until they are cited or explicitly overridden.</p>'}

  <h2 id="hld">4. System map</h2>
  ${hld ? `<p>This is HLD v${hld.version} (${esc(hld.status)}). Components are grouped by layer so a reviewer can see the split without a hairball diagram.</p>${componentDiagramSvg(comps)}` : '<p class="empty">No HLD generated yet.</p>'}

  <h2 id="catalog">5. Component catalog</h2>
  ${catalog.length ? `<table><thead><tr><th>Component</th><th>Layer</th><th>Role</th></tr></thead><tbody>
    ${catalog.map((c) => `<tr><td><strong>${esc(c.name)}</strong></td><td>${esc(c.layer)}</td><td>${esc(c.description || c.lld?.content?.summary || '—')}</td></tr>`).join('')}
  </tbody></table>` : '<p class="empty">No components.</p>'}

  <h2 id="lld">6. Component designs</h2>
  ${lldBlocks || '<p class="empty">No LLDs linked to this HLD.</p>'}

  <h2 id="adr">7. Settled questions</h2>
  <p>Each question has one answer that won and the answers that were turned down. A later design that picks a turned-down answer is a new decision, not a small edit.</p>
  ${adrBlocks || '<p class="empty">No architecture decisions recorded.</p>'}

  <h2 id="flow">8. Flows</h2>
  ${protoBlocks}

  <h2 id="skel">9. Starting code</h2>
  ${files.length ? `<p>${files.filter((a) => a.type === 'file').length} file(s) in the latest traced skeleton. Open Diagram / Traceability in KeelRace to download a zip. Paths below are identities, not a Git repo.</p>${tree}` : '<p class="empty">No skeleton yet. Generate one from the approved HLD.</p>'}
  ${(snapshots ?? []).length ? `<p class="quiet">${snapshots.length} architecture snapshot(s) captured (${snapshots.map((s) => esc(s.label || 'untitled')).join(', ')}).</p>` : ''}

  <h2 id="change">10. How this design changes</h2>
  <p><strong>Door 1 — requirements / business.</strong> Someone who owns the SRS files a Change Request (add, modify, or remove). KeelRace does not edit a locked set. It scopes impact, triages, routes to component owners, and only then produces a new requirement-set version and a new design.</p>
  <p><strong>Door 2 — found later.</strong> Implementation, live testing, deployment, or operations raises a Signal. Classify it as an implementation defect (fix in code, maybe log debt) or a requirement gap (it joins Door 1’s pipeline).</p>
</div></body></html>`
}
