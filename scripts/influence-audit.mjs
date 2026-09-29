#!/usr/bin/env node
/**
 * Standing-rule and soft-authority audit. No API key. No participant claim.
 *
 *   node scripts/influence-audit.mjs
 *
 * Writes reproducibility/_out/influence-audit.json
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  classifyOption,
  constraintVerdict,
  influenceShare,
  replacementVerdict,
  splitEndings,
} from '../supabase/functions/_shared/rule-check.mjs'
import { CASES } from '../reproducibility/eval/cases.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'reproducibility', '_out')

const allowed = splitEndings(
  'confirmed, rejected, or the timeout stored on that row',
)

const reservation = [
  {
    name: 'sweeper writes the same terminal event',
    option: 'A sweeper writes the same terminal event the rule already requires',
    expect: 'holds',
  },
  {
    name: 'ttl deletes the hold',
    option: 'A 15-minute TTL deletes the hold with no terminal event',
    expect: 'breaks',
  },
  {
    name: 'handler deletes the row',
    option: 'The API handler deletes the row on read timeout',
    expect: 'breaks',
  },
  {
    name: 'quotes the allowed timeout',
    option: 'The sweeper records the timeout stored on that row',
    expect: 'holds',
  },
].map((row) => {
  const got = classifyOption(allowed, row.option, row.option)
  return { ...row, result: got.result, reason: got.reason, pass: got.result === row.expect }
})

const replaceByProse = classifyOption(
  allowed,
  'Replace the rule with a 15-minute timer',
  'Replace the rule with a 15-minute timer',
)
const replaceByDecision = replacementVerdict('The product now wants silent expiry, and ADR-22 records that.')

const keepass = CASES.find((c) => c.id === 'P1')
const keepassTexts = keepass.requirements.map((r) => `${r.title} ${r.body}`)
const keepassCloud = constraintVerdict(keepassTexts, 'Cloud password service for sync')
const keepassLocal = constraintVerdict(keepassTexts, 'Local encrypted file plus a composite master key')

const workedProvenance = [
  { origin: 'model_unchanged' },
  { origin: 'model_unchanged' },
  { origin: 'model_edited' },
  { origin: 'architect' },
]

const failures = reservation.filter((r) => !r.pass)
if (failures.length) {
  console.error(failures)
  process.exitCode = 1
}
if (replaceByProse.result !== 'breaks') {
  console.error('prose that says replace must still break until a decision is recorded')
  process.exitCode = 1
}
if (replaceByDecision.result !== 'replaces') {
  console.error('a written replacement reason must be replaces')
  process.exitCode = 1
}
if (keepassCloud.verdict !== 'breaks' || keepassLocal.verdict !== 'clear') {
  console.error({ keepassCloud, keepassLocal })
  process.exitCode = 1
}

const report = {
  note: 'This file checks the rule classifier and a worked provenance example. It does not claim a person was steered. A lower influence share is not a better architecture.',
  reservation,
  replace_by_prose: replaceByProse,
  replace_when_a_decision_is_named: replaceByDecision,
  keepass_constraint: {
    cloud_candidate: keepassCloud,
    local_candidate: keepassLocal,
  },
  influence_share_formula: 'count(origin = model_unchanged) / count(provenance rows)',
  worked_example_influence_share: influenceShare(workedProvenance),
  critique_length_by_generation_index: 'Read assist_findings.target.candidate_id joined to architecture_candidates.generation_index. This script does not query a database.',
}

mkdirSync(outDir, { recursive: true })
const dest = join(outDir, 'influence-audit.json')
writeFileSync(dest, JSON.stringify(report, null, 2))
console.log(process.exitCode ? 'influence audit failed' : `wrote ${dest}`)
