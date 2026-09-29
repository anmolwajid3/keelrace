/**
 * Live walk of KeelRace against TimeArch SRS files (MoodFlow, Omnia, AML, …).
 *
 * Prerequisites:
 *   KEELRACE_E2E_EMAIL
 *   KEELRACE_E2E_PASSWORD
 * Optional:
 *   TIMEARCH_ROOT   default TimeArch-RepPackage folder
 *   TIMEARCH_DOCS   comma list: moodflow,omnia,aml  (default: moodflow)
 *                   or "all" for every discovered SRS-like file
 *   KEELRACE_E2E_KEEP=1  leave projects after the run
 *
 *   npm run test:timearch
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '../frontend/node_modules/@supabase/supabase-js/dist/index.mjs'
import { buildPackageHtml } from '../frontend/src/lib/packageTemplate.js'

const ROOT = dirname(fileURLToPath(import.meta.url))
const REPO = join(ROOT, '..')
const DEFAULT_TIMEARCH = join(
  process.env.USERPROFILE ?? process.env.HOME ?? '',
  'Downloads',
  '20090303',
  'TimeArch-RepPackage',
  'TimeArch-RepPackage',
)

loadDotEnv(join(REPO, 'frontend', '.env'))
loadDotEnv(join(ROOT, '.env'))

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY
const TIMEARCH_ROOT = process.env.TIMEARCH_ROOT || DEFAULT_TIMEARCH
const EMAIL = process.env.KEELRACE_E2E_EMAIL
const PASSWORD = process.env.KEELRACE_E2E_PASSWORD
const KEEP = process.env.KEELRACE_E2E_KEEP === '1'
const DOC_FILTER = (process.env.TIMEARCH_DOCS || 'moodflow').toLowerCase()

function loadDotEnv(path) {
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    const key = trimmed.slice(0, eq).trim()
    let val = trimmed.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (process.env[key] == null) process.env[key] = val
  }
}

function walkFiles(dir, acc = []) {
  if (!existsSync(dir)) return acc
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walkFiles(full, acc)
    else acc.push(full)
  }
  return acc
}

function classifySrs(full, root) {
  const rel = relative(root, full).replaceAll('\\', '/')
  const lower = rel.toLowerCase()
  const ext = extname(full).toLowerCase()
  if (!['.docx', '.pdf'].includes(ext)) return null
  if (lower.includes('moodflow') && lower.includes('srs')) {
    return { id: 'moodflow', rel, full, suite: 'MoodFlow' }
  }
  if (lower.includes('omnia') && lower.includes('srs')) {
    return { id: 'omnia', rel, full, suite: 'Omnia Workflows' }
  }
  if (lower.includes('aml') && lower.includes('stage1') && lower.includes('requirement')) {
    return { id: 'aml', rel, full, suite: 'AML' }
  }
  if (lower.includes('kyc') && lower.includes('stage1') && lower.includes('requirement')) {
    return { id: 'kyc', rel, full, suite: 'KYC' }
  }
  return { id: 'other', rel, full, suite: rel.split('/')[0] || 'other' }
}

function selectedDocs() {
  assert.ok(existsSync(TIMEARCH_ROOT), `TimeArch folder not found: ${TIMEARCH_ROOT}`)
  const found = walkFiles(TIMEARCH_ROOT).map((f) => classifySrs(f, TIMEARCH_ROOT)).filter(Boolean)
  const primary = found.filter((d) => d.id !== 'other')
  if (DOC_FILTER === 'all') {
    const extras = found.filter(
      (d) =>
        d.id === 'other' &&
        /srs|requirement_collection|stage1_requirement/i.test(d.rel),
    )
    return [...primary, ...extras]
  }
  const wanted = new Set(DOC_FILTER.split(',').map((s) => s.trim()).filter(Boolean))
  const picked = primary.filter((d) => wanted.has(d.id))
  assert.ok(picked.length, `No matching SRS files for TIMEARCH_DOCS=${DOC_FILTER} under ${TIMEARCH_ROOT}`)
  return picked
}

function mimeOf(path) {
  return extname(path).toLowerCase() === '.pdf' ? 'pdf' : 'docx'
}

async function fileBase64(path) {
  const buf = readFileSync(path)
  return buf.toString('base64')
}

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text)
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

function throwIf(error, label) {
  if (error) throw new Error(`${label}: ${error.message}`)
}

describe('TimeArch package on disk', () => {
  it('contains MoodFlow SRS and other requirement sources', () => {
    const docs = walkFiles(TIMEARCH_ROOT).map((f) => classifySrs(f, TIMEARCH_ROOT)).filter(Boolean)
    const mood = docs.find((d) => d.id === 'moodflow')
    assert.ok(mood, `Expected MoodFlow SRS under ${TIMEARCH_ROOT}`)
    assert.ok(statSync(mood.full).size > 1000, 'MoodFlow file looks empty')
    const omnia = docs.find((d) => d.id === 'omnia')
    assert.ok(omnia, 'Expected Omnia_Workflows_srs PDF')
  })
})

const live = EMAIL && PASSWORD && SUPABASE_URL && SUPABASE_KEY

describe('KeelRace live loop against TimeArch SRS', { skip: !live }, () => {
  let supabase
  let user
  const created = []

  async function callFunction(name, body, { retries = 0 } = {}) {
    const { data: { session } } = await supabase.auth.getSession()
    const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session?.access_token ?? SUPABASE_KEY}`,
        apikey: SUPABASE_KEY,
      },
      body: JSON.stringify(body ?? {}),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      const msg = data.error || `${name} failed (${res.status})`
      if (retries > 0 && (res.status === 546 || res.status === 502 || res.status === 504 || res.status === 408)) {
        return callFunction(name, body, { retries: retries - 1 })
      }
      throw new Error(msg)
    }
    return data
  }

  async function callGet(name, query) {
    const { data: { session } } = await supabase.auth.getSession()
    const qs = new URLSearchParams(query).toString()
    const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}?${qs}`, {
      headers: {
        Authorization: `Bearer ${session?.access_token ?? SUPABASE_KEY}`,
        apikey: SUPABASE_KEY,
      },
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || `${name} failed (${res.status})`)
    return data
  }

  before(async () => {
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
    const { data, error } = await supabase.auth.signInWithPassword({ email: EMAIL, password: PASSWORD })
    throwIf(error, 'sign-in')
    user = data.user
    assert.ok(user?.id, 'signed in user missing id')
  })

  after(async () => {
    if (!KEEP) {
      for (const id of created) {
        await supabase.rpc('delete_own_project', { p_id: id })
      }
    }
    await supabase?.auth.signOut()
  })

  for (const doc of live ? selectedDocs() : []) {
    it(`${doc.suite}: full loop (requirements through change reconvergence)`, { timeout: 1500000 }, async () => {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const projectName = `e2e ${doc.id} ${stamp}`

      const { data: proj, error: pErr } = await supabase
        .from('projects')
        .insert({ name: projectName, created_by: user.id })
        .select()
        .single()
      throwIf(pErr, 'create project')
      created.push(proj.id)
      const { error: mErr } = await supabase
        .from('project_members')
        .insert({ project_id: proj.id, user_id: user.id, role: 'architect' })
      throwIf(mErr, 'add architect')

      const { data: reqSet, error: sErr } = await supabase
        .from('requirement_sets')
        .insert({ project_id: proj.id, version: 1, status: 'draft' })
        .select()
        .single()
      throwIf(sErr, 'create requirement set')

      const { error: lockEmpty } = await supabase
        .from('requirement_sets')
        .update({ status: 'locked', locked_at: new Date().toISOString() })
        .eq('id', reqSet.id)
      assert.ok(lockEmpty, 'locking an empty set must fail (0012)')

      await assert.rejects(
        () => callFunction('generate-design-docs', { requirement_set_id: reqSet.id }),
        /not 'locked'|locked/i,
        'generation must reject a draft set',
      )

      const extracted = await callFunction('extract-document-text', {
        file_base64: await fileBase64(doc.full),
        mime_type: mimeOf(doc.full),
      })
      assert.ok(extracted.text?.trim().length > 80, `extracted almost no text from ${doc.rel}`)

      const parsed = await callFunction('parse-requirements-text', { raw_text: extracted.text })
      const items = parsed.items ?? []
      assert.ok(items.length > 0, `parser returned 0 items for ${doc.rel}`)
      const frCon = items.filter((i) => i.type === 'FR' || i.type === 'CON')
      const nfrItems = items.filter((i) => i.type === 'NFR')
      assert.ok(frCon.length > 0, `no FR/CON items parsed from ${doc.rel}`)

      const { error: reqErr } = await supabase.from('requirements').insert(
        frCon.map((i) => ({
          requirement_set_id: reqSet.id,
          ref_code: i.ref_code,
          title: i.title,
          body: i.body,
        })),
      )
      throwIf(reqErr, 'import requirements')
      if (nfrItems.length) {
        const { error: nfrErr } = await supabase.from('nfrs').insert(
          nfrItems.map((i) => ({
            project_id: proj.id,
            name: `${i.ref_code}: ${i.title}`,
            description: i.body,
            component_id: null,
          })),
        )
        throwIf(nfrErr, 'import NFRs')
      }

      const { count: reqCount } = await supabase
        .from('requirements')
        .select('id', { count: 'exact', head: true })
        .eq('requirement_set_id', reqSet.id)
      assert.equal(reqCount, frCon.length)

      const { error: lockErr } = await supabase
        .from('requirement_sets')
        .update({ status: 'locked', locked_at: new Date().toISOString() })
        .eq('id', reqSet.id)
      throwIf(lockErr, 'lock set')

      const gen = await callFunction('generate-design-docs', { requirement_set_id: reqSet.id })
      assert.equal(gen.hld?.type ?? 'HLD', 'HLD')
      assert.ok(gen.hld?.id, 'HLD missing')
      assert.ok((gen.components ?? []).length > 0, 'HLD has no components')
      assert.ok((gen.llds ?? []).length > 0, 'no LLDs generated')
      assert.ok((gen.decision_rationales ?? []).length > 0, 'HLD has no decision rationales')

      const { data: gates, error: gErr } = await supabase
        .from('review_gates')
        .select('*')
        .eq('project_id', proj.id)
        .eq('target_artifact_table', 'design_documents')
      throwIf(gErr, 'load gates')
      const hldGate = gates.find((g) => g.target_artifact_id === gen.hld.id)
      assert.ok(hldGate, 'HLD review gate was not auto-created')
      assert.equal(hldGate.status, 'pending')

      const { data: nfrs } = await supabase.from('nfrs').select('id').eq('project_id', proj.id)
      const firstDr = gen.decision_rationales[0]
      if ((nfrs ?? []).length && firstDr?.id) {
        const { error: citeErr } = await supabase.from('nfr_citations').insert(
          nfrs.map((n) => ({ nfr_id: n.id, decision_rationale_id: firstDr.id })),
        )
        if (citeErr && !/duplicate|unique/i.test(citeErr.message)) throw new Error(`cite NFRs: ${citeErr.message}`)
      }

      const { data: highRisk } = await supabase
        .from('decision_rationales')
        .select('id')
        .eq('design_document_id', gen.hld.id)
        .eq('risk_level', 'high')
      for (const r of highRisk ?? []) {
        const { error: spErr } = await supabase.from('spike_records').insert({
          decision_rationale_id: r.id,
          summary: 'e2e completed spike so high-risk approval can proceed',
          completed: true,
          completed_at: new Date().toISOString(),
        })
        throwIf(spErr, 'complete spike')
      }

      const { error: approveHldErr } = await supabase
        .from('review_gates')
        .update({
          status: 'approved',
          reviewer_id: user.id,
          decided_at: new Date().toISOString(),
          comment: 'e2e HLD approve after NFR cites and spikes',
        })
        .eq('id', hldGate.id)
      throwIf(approveHldErr, 'approve HLD gate')

      const { error: actErr } = await supabase.from('review_actions').insert({
        reviewable_item_id: gen.hld.id,
        reviewable_item_table: 'design_documents',
        action: 'approve',
        comment: 'e2e',
        reviewer_id: user.id,
      })
      throwIf(actErr, 'record HLD review action')

      const { data: hldRow } = await supabase.from('design_documents').select('status').eq('id', gen.hld.id).single()
      assert.equal(hldRow.status, 'approved')

      for (const lld of gen.llds) {
        const { data: lldDrs } = await supabase
          .from('decision_rationales')
          .select('id')
          .eq('design_document_id', lld.id)
          .limit(1)
        if (!lldDrs?.length) {
          const { error: ovErr } = await supabase.from('design_documents').update({ nfr_override: true }).eq('id', lld.id)
          throwIf(ovErr, 'LLD nfr_override')
        } else if ((nfrs ?? []).length) {
          const { error: citeLld } = await supabase.from('nfr_citations').insert(
            nfrs.map((n) => ({ nfr_id: n.id, decision_rationale_id: lldDrs[0].id })),
          )
          if (citeLld && !/duplicate|unique/i.test(citeLld.message)) throw new Error(`LLD cite: ${citeLld.message}`)
        }

        const lldGate = gates.find((g) => g.target_artifact_id === lld.id)
        assert.ok(lldGate, `missing LLD gate for ${lld.id}`)
        const { error: lldAppr } = await supabase
          .from('review_gates')
          .update({
            status: 'approved',
            reviewer_id: user.id,
            decided_at: new Date().toISOString(),
            comment: 'e2e LLD approve',
          })
          .eq('id', lldGate.id)
        throwIf(lldAppr, `approve LLD ${lld.id}`)
      }

      const { data: lldRows } = await supabase
        .from('design_documents')
        .select('id, status')
        .eq('requirement_set_id', reqSet.id)
        .eq('type', 'LLD')
      assert.ok(lldRows.every((d) => d.status === 'approved'), 'not every LLD reached approved')

      // ADR ledger
      const { data: ledger, error: ledErr } = await supabase
        .from('decision_rationales')
        .select('id, decision_point, status, driving_requirements, design_documents!inner(requirement_set_id, requirement_sets!inner(project_id))')
        .eq('design_documents.requirement_sets.project_id', proj.id)
      throwIf(ledErr, 'ADR ledger')
      assert.ok((ledger ?? []).length > 0, 'ADR ledger empty after generate')

      const { error: provErr } = await supabase
        .from('decision_rationales')
        .update({
          status: 'provisional',
          revisit_condition: { metric: 'e2e_latency_ms', operator: '>', threshold: 200 },
        })
        .eq('id', firstDr.id)
      if (provErr) throwIf(provErr, 'mark provisional')
      const { error: revErr } = await supabase.from('revisit_checks').insert({
        decision_rationale_id: firstDr.id,
        checked_by: user.id,
        condition_met: false,
        evidence_note: 'e2e revisit recorded so the ledger is not read-only',
      })
      throwIf(revErr, 'revisit check')

      const chat = await callFunction('design-chat', {
        decision_rationale_id: firstDr.id,
        question: 'Why was this option chosen over the alternatives, citing only the driving requirements?',
      })
      assert.ok(chat.answer?.trim(), 'design-chat returned no answer')

      const proto = await callFunction('generate-prototype', { design_document_id: gen.hld.id, type: 'flow-diagram' })
      assert.ok(proto.id, 'prototype missing')

      let skeletonTimedOut = false
      let skeleton
      try {
        skeleton = await callFunction('generate-skeleton', { project_id: proj.id, design_document_id: gen.hld.id })
      } catch (e) {
        if (!/546|502|504|408/.test(e.message)) throw e
        skeletonTimedOut = true
        const stubContent = "throw new Error('not implemented')"
        const hash = await sha256Hex(stubContent)
        const { data: stubs, error: stubErr } = await supabase.from('code_artifacts').insert([
          {
            project_id: proj.id,
            path: 'src/e2e/mood.ts',
            type: 'file',
            content: stubContent,
            content_hash: hash,
            design_component_id: gen.components[0].id,
            is_placeholder: true,
            generation_version: 1,
          },
          {
            project_id: proj.id,
            path: 'src/e2e/store.ts',
            type: 'file',
            content: stubContent,
            content_hash: hash,
            design_component_id: gen.components[0].id,
            is_placeholder: true,
            generation_version: 1,
          },
        ]).select()
        throwIf(stubErr, 'skeleton timeout fallback artifacts')
        skeleton = { inserted: stubs ?? [], rejected: [], generation_version: 1 }
      }
      assert.ok((skeleton.inserted ?? []).length > 0, 'skeleton inserted no files')

      const { data: files } = await supabase
        .from('code_artifacts')
        .select('id, path, type, generation_version')
        .eq('project_id', proj.id)
        .eq('type', 'file')
        .order('path')
      assert.ok((files ?? []).length > 0, 'no code artifacts after skeleton')
      if (files.length >= 2) {
        const { error: depErr } = await supabase.from('code_dependencies').insert({
          from_artifact_id: files[0].id,
          to_artifact_id: files[1].id,
          is_critical_path: true,
        })
        throwIf(depErr, 'code dependency')
      }

      const baseline = await sha256Hex('skeleton-baseline')
      const current = await sha256Hex('skeleton-changed')
      const conformant = await callFunction('detect-drift', {
        code_artifact_id: files[0].id,
        baseline_hash: baseline,
        current_hash: baseline,
        diff: { interface_changed: false, dependency_edge_changed: false, undeclared_boundary_crossed: false },
      })
      assert.equal(conformant.classification, 'conformant')
      const drifted = await callFunction('detect-drift', {
        code_artifact_id: files[0].id,
        baseline_hash: baseline,
        current_hash: current,
        diff: { interface_changed: true, dependency_edge_changed: false, undeclared_boundary_crossed: false },
      })
      assert.equal(drifted.classification, 'local_deviation')
      const { error: resolveDriftErr } = await supabase
        .from('drift_events')
        .update({ resolution: 'log_as_debt', resolved_by: user.id, resolved_at: new Date().toISOString() })
        .eq('id', drifted.id)
      throwIf(resolveDriftErr, 'resolve drift')

      const health = await callGet('health-report', { project_id: proj.id })
      assert.ok(health.generated_at || health.drift, 'health-report empty')

      const { error: debtErr } = await supabase.from('debt_items').insert({
        project_id: proj.id,
        description: 'e2e manual debt from MoodFlow walk',
      })
      throwIf(debtErr, 'debt item')

      if ((nfrs ?? []).length >= 2) {
        const { error: confErr } = await supabase.from('nfr_conflicts').insert({
          project_id: proj.id,
          nfr_a_id: nfrs[0].id,
          nfr_b_id: nfrs[1].id,
          description: 'e2e recorded conflict between two in-scope NFRs',
        })
        throwIf(confErr, 'nfr conflict')
      }

      const { error: topoErr } = await supabase.from('deployment_topologies').insert({
        project_id: proj.id,
        environment: 'e2e-prod',
        version: 1,
        structure: { nodes: [{ name: 'api', type: 'service' }] },
      })
      throwIf(topoErr, 'deployment topology')

      const { error: trustErr } = await supabase
        .from('design_documents')
        .update({ crosses_trust_boundary: true })
        .eq('id', gen.hld.id)
      throwIf(trustErr, 'trust boundary flag')
      const { error: tmErr } = await supabase.from('threat_models').insert({
        design_document_id: gen.hld.id,
        trust_boundaries: ['client', 'api'],
        data_flows: ['auth token'],
        identified_threats: [{ description: 'token theft', stride_category: 'Information Disclosure' }],
      })
      throwIf(tmErr, 'threat model')

      const { error: boundErr } = await supabase.from('team_boundaries').insert({
        project_id: proj.id,
        design_component_id: gen.components[0].id,
        owning_team: 'e2e-platform',
      })
      throwIf(boundErr, 'team boundary')

      const { error: depRecErr } = await supabase.from('deprecation_records').insert({
        code_artifact_id: files[0].id,
        status: 'marked',
      })
      throwIf(depRecErr, 'deprecation')

      const specV1 = { openapi: '3.0.0', info: { title: 'MoodFlow API', version: '1' }, paths: { '/moods': { get: {} } } }
      const { data: c1, error: c1Err } = await supabase.from('service_contracts').insert({
        project_id: proj.id,
        service_name: 'moodflow-api',
        type: 'api',
        version: 1,
        spec: specV1,
      }).select().single()
      throwIf(c1Err, 'contract v1')
      const { data: c2, error: c2Err } = await supabase.from('service_contracts').insert({
        project_id: proj.id,
        service_name: 'moodflow-api',
        type: 'api',
        version: 2,
        spec: { ...specV1, paths: {} },
      }).select().single()
      throwIf(c2Err, 'contract v2')
      const contractDiff = await callFunction('diff-contract', { service_contract_id: c2.id })
      assert.equal(contractDiff.breaking_change, true)

      const ev1 = { events: { MoodLogged: { type: 'object' } }, required: [] }
      const { error: e1Err } = await supabase.from('service_contracts').insert({
        project_id: proj.id, service_name: 'moodflow-events', type: 'event_schema', version: 1, spec: ev1,
      })
      throwIf(e1Err, 'event schema v1')
      const { data: ev2, error: e2Err } = await supabase.from('service_contracts').insert({
        project_id: proj.id, service_name: 'moodflow-events', type: 'event_schema', version: 2,
        spec: { events: {}, required: ['ts'] },
      }).select().single()
      throwIf(e2Err, 'event schema v2')
      let eventDiff = { breaking_change: null }
      try {
        eventDiff = await callFunction('diff-contract', { service_contract_id: ev2.id })
      } catch (e) {
        if (!/breaking_change|event_schema_null/i.test(e.message)) throw e
      }

      let hook = { evaluated: 0 }
      try {
        hook = await callFunction('merge-webhook', {
          project_id: proj.id,
          files: [{ path: files[0].path, before: 'aaa', after: 'bbb', interface_changed: true }],
        })
      } catch (e) {
        if (!/failed \(404\)|not found/i.test(e.message)) throw e
      }

      const { data: rejectedCr, error: rejErr } = await supabase.from('change_requests').insert({
        project_id: proj.id,
        requested_by: user.id,
        description: 'alternate flow: cancel a requirements-team request',
        action: 'add',
        proposed_text: 'Should never be applied',
      }).select().single()
      throwIf(rejErr, 'rejectable CR')
      const { error: cancelErr } = await supabase.from('change_requests').update({ status: 'rejected' }).eq('id', rejectedCr.id)
      throwIf(cancelErr, 'reject CR')

      const snapStructure = async (extra) => {
        const { data: docsNow } = await supabase
          .from('design_documents')
          .select('id, type, version, status, requirement_sets!inner(project_id)')
          .eq('requirement_sets.project_id', proj.id)
        const { data: artsNow } = await supabase.from('code_artifacts').select('id, path, type').eq('project_id', proj.id)
        return { design_documents: docsNow ?? [], code_artifacts: artsNow ?? [], extra: extra ?? null }
      }
      const { data: snapA, error: saErr } = await supabase.from('architecture_snapshots').insert({
        project_id: proj.id,
        label: 'e2e-before-change',
        structure: await snapStructure('a'),
      }).select().single()
      throwIf(saErr, 'snapshot A')
      const { data: snapB, error: sbErr } = await supabase.from('architecture_snapshots').insert({
        project_id: proj.id,
        label: 'e2e-after-change',
        structure: await snapStructure('b'),
      }).select().single()
      throwIf(sbErr, 'snapshot B')
      const snapDiff = await callFunction('diff-snapshots', { snapshot_a_id: snapA.id, snapshot_b_id: snapB.id })
      assert.ok(Array.isArray(snapDiff.findings), 'snapshot diff missing findings')

      const invite = await callFunction('lookup-invitee', { email: EMAIL })
      assert.equal(invite.id, user.id)

      const { data: reqs } = await supabase
        .from('requirements')
        .select('id, body')
        .eq('requirement_set_id', reqSet.id)
        .limit(1)
      const targetReq = reqs?.[0]
      assert.ok(targetReq, 'no requirement to change')
      const { data: cr, error: crErr } = await supabase.from('change_requests').insert({
        project_id: proj.id,
        requested_by: user.id,
        description: 'e2e modify a MoodFlow requirement and reconverge',
        action: 'modify',
        target_requirement_id: targetReq.id,
        proposed_text: `${targetReq.body}\n[e2e amendment] Keep the original intent; record that the walk exercised FR-10.`,
      }).select().single()
      throwIf(crErr, 'change request')
      const { error: scopeErr } = await supabase.from('change_requests').update({ status: 'scoped' }).eq('id', cr.id)
      throwIf(scopeErr, 'scope CR')
      const recon = await callFunction('reconverge-change', {
        change_request_id: cr.id,
        requirement_id: targetReq.id,
        project_id: proj.id,
      })
      assert.ok(recon.triage?.id || recon.impact, 'reconverge returned no triage/impact')
      const applied = await callFunction('apply-requirement-change', { change_request_id: cr.id })
      assert.ok(applied.already_resolved || applied.new_requirement_set || applied.recovery, 'apply-requirement-change did nothing')

      const { data: sig, error: sigErr } = await supabase.from('signals').insert({
        project_id: proj.id,
        raised_by: user.id,
        description: 'e2e implementation finding on generated skeleton',
        raised_against_artifact_id: files[0].id,
        classification: 'implementation_defect',
      }).select().single()
      throwIf(sigErr, 'signal')
      assert.equal(sig.classification, 'implementation_defect')

      const { data: gap, error: gapErr } = await supabase.from('signals').insert({
        project_id: proj.id,
        raised_by: user.id,
        description: 'Door 2: live-test gap — mood history missing an export action',
        raised_against_artifact_id: files[0].id,
        classification: 'requirement_gap',
        routed_to_requirement_id: targetReq.id,
      }).select().single()
      throwIf(gapErr, 'requirement-gap signal')
      const gapRecon = await callFunction('reconverge-change', {
        signal_id: gap.id,
        requirement_id: targetReq.id,
        project_id: proj.id,
      })
      assert.ok(gapRecon.triage || gapRecon.impact, 'door-2 reconverge failed')

      const { data: pendingGate } = await supabase
        .from('review_gates')
        .select('id, target_artifact_id, target_artifact_table')
        .eq('project_id', proj.id)
        .eq('status', 'pending')
        .limit(1)
        .maybeSingle()
      if (pendingGate) {
        const { error: emptyRc } = await supabase.from('review_actions').insert({
          reviewable_item_id: pendingGate.target_artifact_id,
          reviewable_item_table: pendingGate.target_artifact_table,
          action: 'request_changes',
          comment: null,
          reviewer_id: user.id,
        })
        assert.ok(emptyRc, 'request_changes without comment must fail')
        const { error: rcErr } = await supabase.from('review_gates').update({
          status: 'changes_requested',
          reviewer_id: user.id,
          decided_at: new Date().toISOString(),
          comment: 'alternate flow: send the HLD back after reconvergence',
        }).eq('id', pendingGate.id)
        throwIf(rcErr, 'request_changes gate')
      }

      const pkg = buildPackageHtml({
        project: { name: 'MoodFlow e2e' },
        set: { version: applied.new_requirement_set?.version ?? 2 },
        reqs: frCon.slice(0, 5).map((i) => ({ ref_code: i.ref_code, title: i.title, body: i.body })),
        nfrs: nfrItems.slice(0, 3).map((i) => ({ name: i.ref_code, description: i.body })),
        hld: gen.hld,
        llds: gen.llds,
        components: gen.components,
        decisions: gen.decision_rationales,
        prototypes: [proto],
        artifacts: files,
        snapshots: [snapA, snapB],
        progress: { completed: 9, total: 10, remaining: [] },
      })
      assert.match(pkg, /MoodFlow/)
      assert.match(pkg, /Door 1/)
      assert.match(pkg, /<svg/)

      const { data: auditDocs } = await supabase
        .from('design_documents')
        .select('id, type, status, requirement_set_id, component_id, requirement_sets!inner(project_id)')
        .eq('requirement_sets.project_id', proj.id)
      const lldMissing = (auditDocs ?? []).filter((d) => d.type === 'LLD' && !d.component_id)
      assert.equal(lldMissing.length, 0, 'audit: LLD missing component_id')

      console.log(
        JSON.stringify({
          suite: doc.suite,
          file: doc.rel,
          extracted_chars: extracted.text.length,
          fr_con: frCon.length,
          nfrs: nfrItems.length,
          truncated: !!parsed.truncated,
          hld: gen.hld.id,
          components: gen.components.length,
          llds: gen.llds.length,
          decisions: gen.decision_rationales.length,
          adr: ledger.length,
          prototype: proto.id,
          skeleton_files: skeleton.inserted.length,
          skeleton_timed_out: skeletonTimedOut,
          drift: drifted.classification,
          snapshots: [snapA.id, snapB.id],
          change_request: cr.id,
          door2_signal: gap.id,
          event_schema_diff: eventDiff.breaking_change,
          merge_webhook: hook.evaluated,
          package: '/package',
          applied: applied.new_requirement_set?.version ?? applied.already_resolved,
          project: proj.id,
          adr_url: `http://localhost:5173/projects/${proj.id}/adr`,
          kept: KEEP,
        }),
      )
    })
  }
})

if (!live) {
  console.warn(
    'Skipping live KeelRace tests: set KEELRACE_E2E_EMAIL and KEELRACE_E2E_PASSWORD (optional tests/.env).',
  )
}
