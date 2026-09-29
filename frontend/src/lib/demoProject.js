import { supabase } from './supabase'
import { captureLoopRun } from './loopRun.js'

export const DEMO_NAME = 'LampCheck (demo)'
export const DEMO_SEED = 'lampcheck-demo-6'

const HLD_CONTENT = {
  summary: 'LampCheck is a desk lamp with a happy path, a timer loop, an alternate “extend” path, and a safety cut if the driver stays powered after timeout. Four components on one device. No cloud.',
  components: [
    { name: 'Switch', description: 'Reads press / double-press and emits intent. Holds no policy.', needs_detail: true },
    { name: 'Timer', description: 'Owns remaining seconds. Ticks until zero, then commands a cut. A second press while on extends the window.', needs_detail: true },
    { name: 'Watchdog', description: 'If the driver is still powered after remaining hits zero, force another cut. This is the safety loop, not the happy path.', needs_detail: true },
    { name: 'LampDriver', description: 'Applies power and reports whether the bulb is actually on. Never decides policy.', needs_detail: true },
  ],
}

function lldContent(name, body) {
  return {
    component: name,
    interfaces: [`${name}.apply(intent)`],
    data_model: body,
  }
}

async function insertOrThrow(table, row) {
  const { data, error } = await supabase.from(table).insert(row).select().single()
  if (error) throw new Error(`${table}: ${error.message}`)
  return data
}

async function approveDocument(projectId, doc, userId) {
  const { data: gates, error: gErr } = await supabase
    .from('review_gates')
    .select('id')
    .eq('project_id', projectId)
    .eq('target_artifact_id', doc.id)
    .eq('target_artifact_table', 'design_documents')
  if (gErr) throw new Error(`review_gates: ${gErr.message}`)
  const g = gates?.[0]
  if (!g) throw new Error(`No review gate for ${doc.type} ${doc.id}`)
  const { error } = await supabase.from('review_gates').update({
    status: 'approved',
    reviewer_id: userId,
    decided_at: new Date().toISOString(),
    comment: 'Demo seed: example approval so the loop is complete.',
  }).eq('id', g.id)
  if (error) throw new Error(`Approve ${doc.type}: ${error.message}`)
  const { data: after, error: aErr } = await supabase.from('design_documents').select('id, status').eq('id', doc.id).single()
  if (aErr) throw new Error(aErr.message)
  if (after.status !== 'approved') {
    throw new Error(`Approve ${doc.type} did not stick (status ${after.status}). High-risk decisions need a completed spike.`)
  }
}

export async function findDemoProject(userId) {
  const { data, error } = await supabase
    .from('projects')
    .select('id, name, kind, created_at, archived_at')
    .eq('created_by', userId)
    .order('created_at', { ascending: true })
  if (error) throw new Error(error.message)
  return (data ?? []).find((p) => p.kind === 'demo' || p.name === DEMO_NAME) ?? null
}

export async function ensureDemoProject(userId) {
  const existing = await findDemoProject(userId)
  if (existing) {
    const { data: snaps } = await supabase
      .from('architecture_snapshots')
      .select('label')
      .eq('project_id', existing.id)
    const seeded = (snaps ?? []).some((s) => s.label === DEMO_SEED)
    const { count: topo } = await supabase
      .from('deployment_topologies')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', existing.id)
    const { count: contracts } = await supabase
      .from('service_contracts')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', existing.id)
    if (seeded && (topo ?? 0) > 0 && (contracts ?? 0) > 0) return existing
    await supabase.rpc('delete_own_project', { p_id: existing.id })
  }

  let proj
  const withKind = await supabase
    .from('projects')
    .insert({ name: DEMO_NAME, created_by: userId, kind: 'demo' })
    .select('id, name, kind, created_at, archived_at')
    .single()
  if (withKind.error && /kind|schema cache|column/i.test(withKind.error.message)) {
    const fallback = await supabase
      .from('projects')
      .insert({ name: DEMO_NAME, created_by: userId })
      .select('id, name, created_at, archived_at')
      .single()
    if (fallback.error) throw new Error(fallback.error.message)
    proj = { ...fallback.data, kind: 'demo' }
  } else if (withKind.error) {
    throw new Error(withKind.error.message)
  } else {
    proj = withKind.data
  }

  await supabase.from('project_members').insert({ project_id: proj.id, user_id: userId, role: 'architect' })
  await seedDemoContents(proj.id, userId)
  return proj
}

async function seedDemoContents(projectId, userId) {
  const set = await insertOrThrow('requirement_sets', { project_id: projectId, version: 1, status: 'draft' })

  const reqs = [
    { ref_code: 'FR-1', title: 'Turn the lamp on and off', body: 'A person presses the switch. The bulb follows within one tick.' },
    { ref_code: 'FR-2', title: 'Auto-off timer', body: 'While on, the lamp turns itself off after N minutes. Default 20. Range 1–120. The countdown is a loop, not a one-shot.' },
    { ref_code: 'FR-3', title: 'Safety cut if still powered', body: 'If remaining time hits zero and the driver still reports powered, Watchdog must force another cut. Do not assume the first cut landed.' },
    { ref_code: 'FR-4', title: 'Double-press extends the window', body: 'A second press while the lamp is already on adds another N minutes instead of toggling off. That is an alternate path, not the happy path.' },
    { ref_code: 'CON-1', title: 'Works with no network', body: 'Timer, watchdog, and switch must work with the machine offline. No account, no cloud.' },
  ]
  const insertedReqs = []
  for (const r of reqs) {
    insertedReqs.push(await insertOrThrow('requirements', { requirement_set_id: set.id, ...r }))
  }

  const nfrSafe = await insertOrThrow('nfrs', {
    project_id: projectId,
    name: 'NFR-S: bulb safety',
    description: 'Driver must not leave the bulb powered if the timer says off.',
  })
  const nfrAvail = await insertOrThrow('nfrs', {
    project_id: projectId,
    name: 'NFR-A: local availability',
    description: 'On/off and timer survive a missing network.',
  })

  const { error: lockErr } = await supabase
    .from('requirement_sets')
    .update({ status: 'locked', locked_at: new Date().toISOString() })
    .eq('id', set.id)
  if (lockErr) throw new Error(lockErr.message)

  const hld = await insertOrThrow('design_documents', {
    requirement_set_id: set.id,
    type: 'HLD',
    version: 1,
    status: 'draft',
    content: HLD_CONTENT,
    generated_by_model: 'demo-seed',
    nfr_override: true,
  })

  const switchC = await insertOrThrow('components', {
    project_id: projectId, hld_document_id: hld.id, name: 'Switch', family_key: 'CMP0001',
    description: 'Physical or UI switch. Emits on/off intent. Holds no timer state.',
  })
  const timerC = await insertOrThrow('components', {
    project_id: projectId, hld_document_id: hld.id, name: 'Timer', family_key: 'CMP0002',
    description: 'Minutes remaining. Ticks until zero, then commands a cut. Double-press extends.',
  })
  const watchdogC = await insertOrThrow('components', {
    project_id: projectId, hld_document_id: hld.id, name: 'Watchdog', family_key: 'CMP0004',
    description: 'Safety loop: if the driver stays powered after timeout, force another cut.',
  })
  const driverC = await insertOrThrow('components', {
    project_id: projectId, hld_document_id: hld.id, name: 'LampDriver', family_key: 'CMP0003',
    description: 'Applies power to the bulb and reports actual powered state. Policy lives in Timer and Watchdog.',
  })

  const lldSwitch = await insertOrThrow('design_documents', {
    requirement_set_id: set.id, type: 'LLD', version: 1, status: 'draft',
    hld_component_id: hld.id, component_id: switchC.id, nfr_override: true,
    content: lldContent('Switch', 'No persistent store. Last intent is in memory.'),
    generated_by_model: 'demo-seed',
  })
  const lldTimer = await insertOrThrow('design_documents', {
    requirement_set_id: set.id, type: 'LLD', version: 1, status: 'draft',
    hld_component_id: hld.id, component_id: timerC.id, nfr_override: true,
    content: lldContent('Timer', 'state: off | on | cutting. remaining_seconds. minutes_setting 1–120. tick() is the countdown loop.'),
    generated_by_model: 'demo-seed',
  })
  const lldWatch = await insertOrThrow('design_documents', {
    requirement_set_id: set.id, type: 'LLD', version: 1, status: 'draft',
    hld_component_id: hld.id, component_id: watchdogC.id, nfr_override: true,
    content: lldContent('Watchdog', 'armed when remaining hits 0. If driver.powered is still true, emit force-cut until it reports off.'),
    generated_by_model: 'demo-seed',
  })
  const lldDriver = await insertOrThrow('design_documents', {
    requirement_set_id: set.id, type: 'LLD', version: 1, status: 'draft',
    hld_component_id: hld.id, component_id: driverC.id, nfr_override: true,
    content: lldContent('LampDriver', 'powered boolean. apply(on) and report(). No network client.'),
    generated_by_model: 'demo-seed',
  })

  const fr1 = insertedReqs[0].id
  const fr2 = insertedReqs[1].id
  const fr3 = insertedReqs[2].id
  const fr4 = insertedReqs[3].id
  const con1 = insertedReqs[4].id

  const d1 = await insertOrThrow('decision_rationales', {
    design_document_id: hld.id,
    component_id: timerC.id,
    decision_point: 'Where does auto-off live?',
    chosen_option: 'Timer owns remaining time. Switch only emits intent. Driver only applies power.',
    alternatives_considered: [{ option: 'Driver counts minutes', rejection_reason: 'Safety policy would sit next to hardware.' }],
    driving_requirements: [fr2, fr1],
    searchable_text: 'timer owns auto-off',
    risk_level: 'medium',
  })
  const d2 = await insertOrThrow('decision_rationales', {
    design_document_id: hld.id,
    component_id: driverC.id,
    decision_point: 'Does LampCheck need a server?',
    chosen_option: 'No. All three components run on the local device.',
    alternatives_considered: [{ option: 'Cloud timer', rejection_reason: 'CON-1 forbids a network dependency.' }],
    driving_requirements: [con1],
    searchable_text: 'offline local only',
    risk_level: 'low',
  })

  const d3 = await insertOrThrow('decision_rationales', {
    design_document_id: hld.id,
    component_id: watchdogC.id,
    decision_point: 'What if the first cut does not land?',
    chosen_option: 'Watchdog keeps commanding cut until the driver reports off. Timer does not assume success.',
    alternatives_considered: [{ option: 'Trust the first apply(false)', rejection_reason: 'A stuck GPIO would leave the bulb on after timeout (FR-3).' }],
    driving_requirements: [fr3],
    searchable_text: 'watchdog force cut',
    risk_level: 'high',
    risk_set_by: 'human',
  })
  const d4 = await insertOrThrow('decision_rationales', {
    design_document_id: hld.id,
    component_id: switchC.id,
    decision_point: 'Second press while already on?',
    chosen_option: 'Treat it as extend, not toggle-off. Off is a long-press or explicit off intent.',
    alternatives_considered: [{ option: 'Every press toggles', rejection_reason: 'People bump the switch while reading; that would kill the lamp (FR-4).' }],
    driving_requirements: [fr4, fr1],
    searchable_text: 'double press extend',
    risk_level: 'medium',
  })

  await supabase.from('nfr_citations').insert([
    { nfr_id: nfrSafe.id, decision_rationale_id: d1.id },
    { nfr_id: nfrSafe.id, decision_rationale_id: d2.id },
    { nfr_id: nfrSafe.id, decision_rationale_id: d3.id },
    { nfr_id: nfrAvail.id, decision_rationale_id: d2.id },
    { nfr_id: nfrAvail.id, decision_rationale_id: d4.id },
  ])

  await insertOrThrow('spike_records', {
    decision_rationale_id: d3.id,
    summary: 'Stuck-on GPIO was reproduced on the workshop UART. Force-cut until report() is false. One apply(false) is not enough.',
    completed: true,
    completed_at: new Date().toISOString(),
  })

  await insertOrThrow('decision_rationales', {
    design_document_id: lldTimer.id,
    component_id: timerC.id,
    decision_point: 'How is remaining time stored?',
    chosen_option: 'Integer seconds in process memory. Reset on power-off.',
    alternatives_considered: [{ option: 'Persist to disk', rejection_reason: 'A desk lamp should not resume a stale countdown after a crash.' }],
    driving_requirements: [fr2],
    searchable_text: 'timer memory seconds',
    risk_level: 'low',
  })

  await seedWorkshopGate(projectId, hld, { switchC, timerC, watchdogC, driverC })

  for (const doc of [hld, lldSwitch, lldTimer, lldWatch, lldDriver]) {
    await approveDocument(projectId, doc, userId)
  }

  await insertOrThrow('prototypes', {
    design_document_id: hld.id,
    type: 'flow-diagram',
    content: {
      title: 'LampCheck paths — happy, loop, alternate, safety',
      nodes: [
        { id: 'person', label: 'Person', row: 0 },
        { id: 'switch', label: 'Switch', row: 0 },
        { id: 'timer', label: 'Timer', row: 0 },
        { id: 'driver', label: 'LampDriver', row: 0 },
        { id: 'bulb', label: 'Bulb', row: 0 },
        { id: 'watchdog', label: 'Watchdog', row: 1 },
      ],
      edges: [
        { from: 'person', to: 'switch', label: 'press', kind: 'happy' },
        { from: 'switch', to: 'timer', label: 'intent:on', kind: 'happy' },
        { from: 'timer', to: 'timer', label: 'tick remaining', kind: 'loop' },
        { from: 'timer', to: 'driver', label: 'apply', kind: 'happy' },
        { from: 'driver', to: 'bulb', label: 'power', kind: 'happy' },
        { from: 'driver', to: 'timer', label: 'powered?', kind: 'loop' },
        { from: 'person', to: 'switch', label: 'double-press', kind: 'alt' },
        { from: 'switch', to: 'timer', label: 'extend +N', kind: 'alt' },
        { from: 'timer', to: 'watchdog', label: 'remaining=0', kind: 'safety' },
        { from: 'watchdog', to: 'driver', label: 'force-cut', kind: 'safety' },
        { from: 'driver', to: 'watchdog', label: 'still on', kind: 'safety' },
      ],
    },
  })

  const switchFile = await insertOrThrow('code_artifacts', {
    project_id: projectId, path: 'src/switch.ts', type: 'file', generation_version: 1,
    content: `export type Intent = 'on' | 'off' | 'extend'

const DOUBLE_MS = 280

export function classifyPress(nowMs: number, lastPressMs: number | null, lampOn: boolean): Intent {
  if (lampOn && lastPressMs != null && nowMs - lastPressMs < DOUBLE_MS) return 'extend'
  return lampOn ? 'off' : 'on'
}

export function debounce(nowMs: number, lastEmitMs: number | null, floorMs = 40): boolean {
  return lastEmitMs == null || nowMs - lastEmitMs >= floorMs
}
`,
    is_placeholder: false, design_component_id: switchC.id,
  })
  const timerFile = await insertOrThrow('code_artifacts', {
    project_id: projectId, path: 'src/timer.ts', type: 'file', generation_version: 1,
    content: `export type TimerState = 'off' | 'on' | 'cutting'

export type Timer = {
  state: TimerState
  remaining: number
  minutes: number
}

export function start(t: Timer): Timer {
  return { ...t, state: 'on', remaining: t.minutes * 60 }
}

export function extend(t: Timer): Timer {
  if (t.state !== 'on') return t
  return { ...t, remaining: t.remaining + t.minutes * 60 }
}

/** Countdown loop. Call once per second while on. */
export function tick(t: Timer): Timer {
  if (t.state !== 'on') return t
  const remaining = Math.max(0, t.remaining - 1)
  if (remaining === 0) return { ...t, remaining, state: 'cutting' }
  return { ...t, remaining }
}

export function shouldCut(t: Timer): boolean {
  return t.state === 'cutting' || (t.state === 'on' && t.remaining <= 0)
}
`,
    is_placeholder: false, design_component_id: timerC.id,
  })
  const watchdogFile = await insertOrThrow('code_artifacts', {
    project_id: projectId, path: 'src/watchdog.ts', type: 'file', generation_version: 1,
    content: `import { shouldCut, type Timer } from './timer'

/** Safety loop: do not trust a single apply(false). Keep cutting while hardware still reports on. */
export function forceCut(timer: Timer, powered: boolean, attempts = 0): { cut: boolean; attempts: number } {
  if (!shouldCut(timer)) return { cut: false, attempts }
  if (!powered) return { cut: false, attempts }
  return { cut: true, attempts: attempts + 1 }
}

export function stuckOn(timer: Timer, powered: boolean): boolean {
  return shouldCut(timer) && powered
}
`,
    is_placeholder: false, design_component_id: watchdogC.id,
  })
  const driverFile = await insertOrThrow('code_artifacts', {
    project_id: projectId, path: 'src/driver.ts', type: 'file', generation_version: 1,
    content: `/** Hardware GPIO. Policy lives in Timer and Watchdog. */
export type Driver = { powered: boolean }

export function applyPower(driver: Driver, on: boolean): Driver {
  return { powered: on }
}

export function report(driver: Driver): boolean {
  return driver.powered
}
`,
    is_placeholder: false, design_component_id: driverC.id,
  })
  await insertOrThrow('code_artifacts', {
    project_id: projectId, path: 'src/index.ts', type: 'file', generation_version: 1,
    content: `import { classifyPress } from './switch'
import { start, extend, tick, type Timer } from './timer'
import { applyPower, report, type Driver } from './driver'
import { forceCut } from './watchdog'

export function loop(timer: Timer, driver: Driver, nowMs: number, lastPress: number | null, press: boolean) {
  let t = timer
  let d = driver
  if (press) {
    const intent = classifyPress(nowMs, lastPress, d.powered)
    if (intent === 'on') { t = start(t); d = applyPower(d, true) }
    if (intent === 'extend') t = extend(t)
    if (intent === 'off') { t = { ...t, state: 'off', remaining: 0 }; d = applyPower(d, false) }
  } else if (t.state === 'on') {
    t = tick(t)
  }
  const cut = forceCut(t, report(d))
  if (cut.cut) d = applyPower(d, false)
  if (!report(d) && t.state === 'cutting') t = { ...t, state: 'off' }
  return { timer: t, driver: d }
}
`,
    is_placeholder: false, design_component_id: timerC.id,
  })
  await supabase.from('code_dependencies').insert([
    { from_artifact_id: switchFile.id, to_artifact_id: timerFile.id, is_critical_path: true },
    { from_artifact_id: timerFile.id, to_artifact_id: driverFile.id, is_critical_path: true },
    { from_artifact_id: watchdogFile.id, to_artifact_id: driverFile.id, is_critical_path: true },
    { from_artifact_id: watchdogFile.id, to_artifact_id: timerFile.id, is_critical_path: false },
  ])

  await insertOrThrow('deployment_topologies', {
    project_id: projectId,
    environment: 'desk',
    version: 1,
    structure: {
      nodes: [
        { name: 'LampCheck firmware', type: 'device', notes: 'Switch + Timer + LampDriver on one MCU. Offline.' },
        { name: 'Bulb', type: 'hardware', notes: 'Powered only by LampDriver.' },
      ],
    },
  })
  await insertOrThrow('deployment_topologies', {
    project_id: projectId,
    environment: 'workshop',
    version: 1,
    structure: {
      nodes: [
        { name: 'Host debug UART', type: 'tool', notes: 'Optional serial log. Not required for FR-1/FR-2.' },
        { name: 'LampCheck firmware', type: 'device', notes: 'Same binary as desk.' },
      ],
    },
  })

  await insertOrThrow('service_contracts', {
    project_id: projectId,
    service_name: 'lampcheck-local',
    type: 'api',
    version: 1,
    breaking_change: false,
    spec: {
      openapi: '3.0.0',
      info: { title: 'LampCheck local', version: '1.0.0' },
      paths: {
        '/power': { post: { summary: 'Ask Timer to apply on/off' } },
        '/timer': {
          get: { summary: 'Read remaining seconds' },
          put: { summary: 'Set auto-off minutes (1–120)' },
        },
      },
    },
  })
  await insertOrThrow('service_contracts', {
    project_id: projectId,
    service_name: 'lamp.events',
    type: 'event_schema',
    version: 1,
    breaking_change: false,
    spec: {
      name: 'lamp.power',
      fields: { on: 'boolean', source: 'switch | timer' },
    },
  })

  await supabase.from('team_boundaries').insert([
    { project_id: projectId, design_component_id: switchC.id, owning_team: 'Device UI' },
    { project_id: projectId, design_component_id: timerC.id, owning_team: 'Device logic' },
    { project_id: projectId, design_component_id: watchdogC.id, owning_team: 'Safety' },
    { project_id: projectId, design_component_id: driverC.id, owning_team: 'Firmware' },
  ])

  await seedArchitectAssist(projectId, userId, {
    setId: set.id,
    hldId: hld.id,
    insertedReqs,
    fr1,
    fr2,
    fr3,
    fr4,
    con1,
    switchC,
    timerC,
    watchdogC,
    driverC,
    switchFile,
    timerFile,
    watchdogFile,
    driverFile,
  })

  await insertOrThrow('architecture_snapshots', {
    project_id: projectId,
    label: DEMO_SEED,
    structure: {
      components: ['Switch', 'Timer', 'Watchdog', 'LampDriver'],
      environments: ['desk', 'workshop'],
      note: 'Filled example: four-module MCU, assist drivers/candidates recorded, happy/loop/extend/safety paths.',
    },
  })

  await insertOrThrow('change_requests', {
    project_id: projectId,
    requested_by: userId,
    action: 'modify',
    target_requirement_id: fr2,
    description: 'Demo Door 1: default auto-off should be 15 minutes, not 20.',
    proposed_text: 'While on, the lamp turns itself off after N minutes. Default 15. Range 1–120.',
  })
  await insertOrThrow('signals', {
    project_id: projectId,
    raised_by: userId,
    source_type: 'implementation_finding',
    description: 'Demo Door 2: GPIO report() is still simulated in the workshop UART. Not a requirements edit.',
    classification: 'implementation_defect',
  })

  const record = await captureLoopRun(supabase, projectId)
  await supabase.from('loop_runs').insert({
    project_id: projectId,
    created_by: userId,
    label: 'After HLD approve — example replay',
    record,
  })
}

function grounding(knowledge, titles) {
  return titles.map((title) => {
    const row = knowledge.find((k) => k.title === title)
    return row
      ? { knowledge_id: row.id, framework: row.framework, title: row.title }
      : { title }
  })
}

async function seedWorkshopGate(projectId, hld, comps) {
  const utilRel = await insertOrThrow('evaluation_utility_nodes', {
    project_id: projectId, quality: 'reliability', attribute: 'safety cut', sort_order: 0,
  })
  const utilAvail = await insertOrThrow('evaluation_utility_nodes', {
    project_id: projectId, quality: 'availability', attribute: 'offline operation', sort_order: 1,
  })
  const s1 = await insertOrThrow('evaluation_scenarios', {
    project_id: projectId,
    utility_node_id: utilRel.id,
    title: 'GPIO stuck high after timeout',
    stimulus: 'Remaining = 0, LampDriver still reports powered.',
    environment: 'Desk MCU, workshop UART connected.',
    expected_response: 'Watchdog force-cuts until report() is false.',
    kind: 'exploratory',
    in_boundary: true,
    confidence: 'grounded',
  })
  const s2 = await insertOrThrow('evaluation_scenarios', {
    project_id: projectId,
    utility_node_id: utilAvail.id,
    title: 'Reading at the desk, accidental second press',
    stimulus: 'Double-press while on.',
    environment: 'Person at the desk.',
    expected_response: 'Remaining += N minutes, lamp stays on.',
    kind: 'use',
    in_boundary: true,
    confidence: 'grounded',
  })
  await insertOrThrow('evaluation_scenarios', {
    project_id: projectId,
    title: 'Fleet dashboard for remaining time',
    stimulus: 'Operator wants every lamp’s remaining minutes in a browser.',
    environment: 'WAN.',
    expected_response: 'Out of evaluation — CON-1.',
    kind: 'growth',
    in_boundary: false,
    confidence: 'grounded',
  })
  await insertOrThrow('evaluation_walks', {
    project_id: projectId,
    scenario_id: s1.id,
    hld_document_id: hld.id,
    affected_components: [
      { id: comps.timerC.id, name: 'Timer' },
      { id: comps.watchdogC.id, name: 'Watchdog' },
      { id: comps.driverC.id, name: 'LampDriver' },
    ],
    path_summary: 'Timer remaining=0 → Watchdog force-cut → LampDriver report until false. No score.',
    confidence: 'grounded',
    status: 'accepted',
  })
  await insertOrThrow('evaluation_walks', {
    project_id: projectId,
    scenario_id: s2.id,
    hld_document_id: hld.id,
    affected_components: [
      { id: comps.switchC.id, name: 'Switch' },
      { id: comps.timerC.id, name: 'Timer' },
    ],
    path_summary: 'Switch classifies double-press as extend → Timer adds N minutes. LampDriver stays powered.',
    confidence: 'grounded',
    status: 'accepted',
  })
}

async function seedArchitectAssist(projectId, userId, ctx) {
  const { data: knowledge } = await supabase
    .from('architecture_knowledge')
    .select('id, framework, title')
  const k = knowledge ?? []
  const iso = grounding(k, ['Requirements must be verifiable'])
  const add = grounding(k, [
    'Architectural drivers come before structure',
    'Iterate tactics, then allocate',
    'Quality model for NFRs',
  ])
  const tactics = grounding(k, [
    'Modular monolith vs services',
    'Do not copy cloud topology by default',
    'Availability tactics',
  ])
  const atam = grounding(k, ['Utility tree and scenarios', 'Scenario walkthroughs'])
  const ozkaya = grounding(k, ['As-built is context'])
  const madr = grounding(k, ['MADR fields'])

  const { fr1, fr2, fr3, fr4, con1, setId, hldId } = ctx
  const { switchC, timerC, watchdogC, driverC } = ctx
  const { switchFile, timerFile, watchdogFile, driverFile } = ctx

  await insertOrThrow('assist_findings', {
    project_id: projectId,
    kind: 'critic',
    severity: 'low',
    title: 'FR-2 does not define a tick',
    body: '“The countdown is a loop, not a one-shot” is design colour. I still need a measurable period (1 Hz on the MCU is what we ship). Left the locked text alone; captured it on the Timer driver instead.',
    suggested_rewrite: 'While on, remaining time decreases once per second until zero, then the lamp turns off. Default N is 20 minutes. Range 1–120.',
    target: { requirement_id: fr2, ref_code: 'FR-2', requirement_set_id: setId },
    grounding: iso,
    confidence: 'grounded',
    status: 'accepted',
  })
  await insertOrThrow('assist_findings', {
    project_id: projectId,
    kind: 'critic',
    severity: 'medium',
    title: 'CON-1 looks compound',
    body: 'Model wanted this split into three shalls. I dismissed it. “No account, no cloud” is one deployment constraint, not three features.',
    target: { requirement_id: con1, ref_code: 'CON-1', requirement_set_id: setId },
    grounding: iso,
    confidence: 'partial',
    status: 'dismissed',
  })

  await insertOrThrow('architectural_drivers', {
    project_id: projectId,
    requirement_set_id: setId,
    quality_attribute: 'reliability',
    title: 'Safety cut if the first apply(false) lies',
    stimulus: 'Remaining hits zero and LampDriver still reports powered.',
    environment: 'Desk MCU, GPIO may stick high.',
    response: 'Watchdog keeps commanding cut until report() is false. Bulb is dark.',
    response_measure: 'GPIO report() is false within N force-cut attempts.',
    tactic: 'fault detection / retry',
    tactic_element: 'Watchdog',
    source_requirement_ids: [fr3],
    status: 'accepted',
    grounding: add,
    confidence: 'grounded',
    questions: ['How many force-cut attempts before we treat hardware as failed?'],
  })
  await insertOrThrow('architectural_drivers', {
    project_id: projectId,
    requirement_set_id: setId,
    quality_attribute: 'availability',
    title: 'On, off, and timer with no network',
    stimulus: 'Person presses the switch with the machine offline.',
    environment: 'No account, no cloud, no NTP.',
    response: 'Bulb follows intent; countdown still runs.',
    response_measure: 'On/off and remaining seconds work with the network unplugged.',
    tactic: 'bound network dependency (none)',
    tactic_element: 'all four modules on MCU',
    source_requirement_ids: [con1, fr1, fr2],
    status: 'accepted',
    grounding: add,
    confidence: 'grounded',
    questions: [],
  })
  await insertOrThrow('architectural_drivers', {
    project_id: projectId,
    requirement_set_id: setId,
    quality_attribute: 'usability',
    title: 'Second press extends, it does not toggle off',
    stimulus: 'Lamp is already on; person double-presses within 280 ms.',
    environment: 'Reading at the desk; accidental bump is common.',
    response: 'Remaining increases by N minutes. Lamp stays on.',
    source_requirement_ids: [fr4, fr1],
    status: 'accepted',
    grounding: add,
    confidence: 'grounded',
    questions: ['Long-press vs explicit off — which one do we ship on the first board?'],
  })
  await insertOrThrow('architectural_drivers', {
    project_id: projectId,
    requirement_set_id: setId,
    quality_attribute: 'performance efficiency',
    title: 'Countdown is a 1 Hz loop, not a one-shot timer callback',
    stimulus: 'Lamp is on.',
    environment: 'Same MCU as Switch and Driver.',
    response: 'Remaining decreases once per second until zero.',
    source_requirement_ids: [fr2],
    status: 'accepted',
    grounding: add,
    confidence: 'partial',
    questions: ['Crystal accuracy vs “close enough for a desk lamp”.'],
  })
  await insertOrThrow('architectural_drivers', {
    project_id: projectId,
    requirement_set_id: setId,
    quality_attribute: 'scalability',
    title: 'Independent scale-out of timer vs driver',
    stimulus: 'Fleet of lamps, independent deploy.',
    environment: 'Imagined multi-tenant cloud.',
    response: 'Not a driver for this product.',
    source_requirement_ids: [],
    status: 'rejected',
    grounding: tactics,
    confidence: 'ungrounded',
    questions: ['Who asked for this? Nobody on the SRS.'],
  })

  const candMcu = await insertOrThrow('architecture_candidates', {
    project_id: projectId,
    requirement_set_id: setId,
    name: 'Four modules, one MCU',
    summary: 'Switch, Timer, Watchdog, LampDriver as compile-time modules on one firmware image. No network client.',
    optimizes: 'CON-1, FR-3 isolation of safety from happy path, cheap desk hardware.',
    sacrifices: 'No remote management. Watchdog and Timer both know “remaining hit zero”.',
    components: [
      { name: 'Switch', responsibility: 'Intent only.' },
      { name: 'Timer', responsibility: 'Remaining seconds, extend, first cut.' },
      { name: 'Watchdog', responsibility: 'Force-cut until report() is false.' },
      { name: 'LampDriver', responsibility: 'GPIO apply/report. No policy.' },
    ],
    mermaid: 'flowchart LR\nSwitch[Switch]-->Timer[Timer]\nTimer-->LampDriver[LampDriver]\nTimer-->Watchdog[Watchdog]\nWatchdog-->LampDriver',
    mermaid_valid: true,
    grounding: tactics,
    confidence: 'grounded',
    questions: ['Do Switch and Timer share a press timestamp, or does Switch classify first?'],
    status: 'selected',
  })
  const candCloud = await insertOrThrow('architecture_candidates', {
    project_id: projectId,
    requirement_set_id: setId,
    name: 'Cloud countdown',
    summary: 'Phone app talks to a hosted timer; bulb is a dumb relay.',
    optimizes: 'Fleet dashboards, remote default of N.',
    sacrifices: 'CON-1. Lamp does nothing in a basement with no Wi‑Fi.',
    components: [
      { name: 'Mobile app', responsibility: 'Presses.' },
      { name: 'Cloud timer', responsibility: 'Minutes remaining.' },
      { name: 'Relay', responsibility: 'Power.' },
    ],
    mermaid: 'flowchart LR\nApp[App]-->Cloud[CloudTimer]\nCloud-->Relay[Relay]',
    mermaid_valid: true,
    grounding: tactics,
    confidence: 'grounded',
    questions: [],
    status: 'discarded',
  })
  await insertOrThrow('architecture_candidates', {
    project_id: projectId,
    requirement_set_id: setId,
    name: 'Four microservices',
    summary: 'Switch, Timer, Watchdog, Driver as separately deployed services.',
    optimizes: 'Team autonomy that we do not have.',
    sacrifices: 'Latency, clocks, and a network we forbade.',
    components: [
      { name: 'switch-svc', responsibility: 'Intents over HTTP.' },
      { name: 'timer-svc', responsibility: 'Countdown.' },
      { name: 'watchdog-svc', responsibility: 'Safety.' },
      { name: 'driver-svc', responsibility: 'GPIO via another hop.' },
    ],
    mermaid: 'flowchart LR\nA[switch-svc]-->B[timer-svc]\nB-->C[watchdog-svc]\nC-->D[driver-svc]',
    mermaid_valid: true,
    grounding: tactics,
    confidence: 'grounded',
    questions: [],
    status: 'discarded',
  })

  const { data: workshopScenarios } = await supabase.from('evaluation_scenarios').select('id, title, in_boundary').eq('project_id', projectId)
  for (const s of workshopScenarios ?? []) {
    if (!s.in_boundary) continue
    await insertOrThrow('evaluation_outcomes', {
      project_id: projectId,
      scenario_id: s.id,
      candidate_id: candMcu.id,
      qualitative_result: 'holds',
      rationale: 'Four modules on one MCU can walk this scenario on-device. Not a score.',
      status: 'accepted',
    })
    await insertOrThrow('evaluation_outcomes', {
      project_id: projectId,
      scenario_id: s.id,
      candidate_id: candCloud.id,
      qualitative_result: 'degrades',
      rationale: 'Cloud countdown fails CON-1 / offline. Unknown whether a hosted GPIO watchdog even exists.',
      status: 'accepted',
    })
    await insertOrThrow('evaluation_walks', {
      project_id: projectId,
      scenario_id: s.id,
      candidate_id: candMcu.id,
      affected_components: candMcu.components,
      path_summary: `Same in-boundary scenario on selected candidate “${candMcu.name}”.`,
      confidence: 'grounded',
      status: 'accepted',
    })
  }
  await insertOrThrow('evaluation_points', {
    project_id: projectId,
    kind: 'sensitivity',
    quality_a: 'reliability',
    element_name: 'Watchdog',
    body: 'Whether force-cut retries until report() is false is a sensitivity point for FR-3. Changing retry count changes the safety loop, not a numeric grade.',
    status: 'accepted',
  })
  await insertOrThrow('evaluation_points', {
    project_id: projectId,
    kind: 'tradeoff',
    quality_a: 'safety isolation',
    quality_b: 'duplicated timeout knowledge',
    element_name: 'Timer / Watchdog',
    body: 'Keeping Watchdog out of LampDriver duplicates “remaining hit zero”. That is the trade-off I accepted.',
    status: 'accepted',
  })

  await insertOrThrow('assist_findings', {
    project_id: projectId,
    kind: 'challenger',
    severity: 'medium',
    title: 'Timeout knowledge is split across Timer and Watchdog',
    body: 'Both know remaining hit zero. That is a sensitivity point if we later change what “cut” means. I kept it: I would rather duplicate the condition than put safety policy inside LampDriver.',
    target: { hld_id: hldId },
    grounding: tactics,
    confidence: 'partial',
    status: 'accepted',
  })
  await insertOrThrow('assist_findings', {
    project_id: projectId,
    kind: 'challenger',
    severity: 'low',
    title: 'No cloud control plane',
    body: 'Dismissed. CON-1 already killed that candidate. This is not a missed driver; it is the one I rejected.',
    target: { hld_id: hldId },
    grounding: tactics,
    confidence: 'grounded',
    status: 'dismissed',
  })

  await insertOrThrow('assist_adr_drafts', {
    project_id: projectId,
    design_document_id: hldId,
    decision_point: 'Where does auto-off live?',
    chosen_option: 'Timer owns remaining time. Switch only emits intent. Driver only applies power.',
    alternatives: [
      { option: 'Driver counts minutes', rejection_reason: 'Safety policy would sit next to hardware.' },
      { option: 'Cloud timer', rejection_reason: 'CON-1. Offline lamp would never turn off.' },
    ],
    suggested_requirement_ids: [fr2, fr1],
    consequences: 'Watchdog still needs a signal that remaining hit zero — that coupling is the finding I kept on the challenger.',
    grounding: madr,
    confidence: 'grounded',
    questions: ['Off via long-press — same decision or a later ADR?'],
    status: 'recorded',
  })
  await insertOrThrow('assist_adr_drafts', {
    project_id: projectId,
    design_document_id: hldId,
    decision_point: 'Second press while already on?',
    chosen_option: '',
    alternatives: [
      { option: 'Every press toggles', rejection_reason: '' },
      { option: 'Treat as extend', rejection_reason: '' },
    ],
    suggested_requirement_ids: [fr4, fr1],
    consequences: 'I already recorded this on the ledger. Left this draft discarded so you can see an empty chosen option.',
    grounding: madr,
    confidence: 'partial',
    questions: ['I fill chosen option. The copilot does not.'],
    status: 'discarded',
  })

  await insertOrThrow('assist_findings', {
    project_id: projectId,
    kind: 'scenario',
    severity: 'info',
    title: 'GPIO stuck high after timeout',
    body: 'Stimulus: remaining = 0, driver.powered = true.\nEnvironment: desk MCU, workshop UART connected.\nResponse: Watchdog force-cuts until report() is false.\nKind: exploratory',
    target: { kind: 'exploratory', utility_tree: [{ quality: 'reliability', attribute: 'safety cut', scenario: 'stuck GPIO' }] },
    grounding: atam,
    confidence: 'grounded',
    status: 'accepted',
  })
  await insertOrThrow('assist_findings', {
    project_id: projectId,
    kind: 'scenario',
    severity: 'info',
    title: 'Reading at the desk, accidental second press',
    body: 'Stimulus: double-press while on.\nEnvironment: person at the desk.\nResponse: remaining += N minutes, lamp stays on.\nKind: use',
    target: { kind: 'use' },
    grounding: atam,
    confidence: 'grounded',
    status: 'accepted',
  })
  await insertOrThrow('assist_findings', {
    project_id: projectId,
    kind: 'scenario',
    severity: 'info',
    title: 'Fleet dashboard for remaining time',
    body: 'Stimulus: operator wants every lamp’s remaining minutes in a browser.\nEnvironment: WAN.\nResponse: out of evaluation — CON-1.\nKind: growth',
    target: { kind: 'growth' },
    grounding: atam,
    confidence: 'grounded',
    status: 'dismissed',
  })

  await insertOrThrow('assist_ask_messages', {
    project_id: projectId,
    role: 'user',
    content: 'Who owns remaining time, and which requirement forced that?',
    created_by: userId,
  })
  await insertOrThrow('assist_ask_messages', {
    project_id: projectId,
    role: 'assistant',
    content: 'Timer owns remaining time. The recorded decision “Where does auto-off live?” cites FR-2 (auto-off timer) and FR-1 (on/off). Switch only emits intent. LampDriver only applies power. CON-1 is why that decision also rejects a cloud timer.',
    citations: ['FR-2', 'FR-1', 'CON-1', 'Where does auto-off live?'],
    created_by: userId,
  })

  await insertOrThrow('assist_findings', {
    project_id: projectId,
    kind: 'brief',
    severity: 'info',
    title: 'Change blast brief',
    body: 'Door 1 wants default N from 20 to 15 (FR-2). Blast: Timer (owns remaining), Device logic (team), lampcheck-local PUT /timer, the HLD decision “Where does auto-off live?”, and the replayable evidence map. Watchdog is untouched unless we change what zero means. Cannot infer: whether product still wants 1–120 as the range.',
    target: { requirement_id: fr2, cannot_infer: ['Whether the 1–120 range stays'] },
    confidence: 'partial',
    status: 'accepted',
  })

  const mapRows = [
    [switchFile, switchC, 'src/switch.ts classifies press/extend. Confirmed as Switch.'],
    [timerFile, timerC, 'src/timer.ts is remaining seconds. Confirmed as Timer.'],
    [watchdogFile, watchdogC, 'src/watchdog.ts force-cuts. Confirmed as Watchdog.'],
    [driverFile, driverC, 'src/driver.ts is GPIO. Confirmed as LampDriver.'],
  ]
  for (const [file, comp, reason] of mapRows) {
    await insertOrThrow('assist_findings', {
      project_id: projectId,
      kind: 'mapping',
      severity: 'info',
      title: `${file.path} → ${comp.name}`,
      body: reason,
      target: { path: file.path, component_id: comp.id },
      grounding: ozkaya,
      confidence: 'grounded',
      status: 'applied',
    })
  }

  await insertOrThrow('assist_findings', {
    project_id: projectId,
    kind: 'note',
    severity: 'info',
    title: 'Workshop notes (not locked)',
    body: JSON.stringify({
      notes: 'Whiteboard 12 Sep: four boxes on one board. No Wi-Fi module. Watchdog is a second cut, not a nicer Timer.',
      candidate_drivers: ['offline', 'stuck GPIO', 'extend on double-press'],
      candidate_components: ['Switch', 'Timer', 'Watchdog', 'LampDriver'],
      questions: ['Long-press for off — next ADR, not this board.'],
    }, null, 2),
    target: { staging: true },
    confidence: 'ungrounded',
    status: 'accepted',
  })
}

export function isDemoProject(p) {
  return p?.kind === 'demo' || p?.name === DEMO_NAME
}
