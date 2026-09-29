#!/usr/bin/env node
/**
 * KeelRace artefact reproduction (ICSA AE analogue of TimeArch reproduce.sh).
 *
 *   node scripts/reproduce.mjs           # no API key: replay cassette, write _out/
 *   node scripts/reproduce.mjs --smoke   # one pass, no N=10 loop
 *   node scripts/reproduce.mjs --record  # needs OPENROUTER_API_KEY
 */
import { spawnSync } from 'node:child_process'
import { reproduce, buildAuthoredCassette } from '../reproducibility/eval/engine.mjs'

const args = new Set(process.argv.slice(2))
if (args.has('--build-cassette')) {
  await buildAuthoredCassette()
  console.log('wrote reproducibility/llm-cassette.json and supabase/functions/_shared/llm-cassette.json')
  process.exit(0)
}

const out = await reproduce({
  record: args.has('--record'),
  repeats: args.has('--smoke') ? 1 : 10,
})

const audit = spawnSync(process.execPath, ['scripts/influence-audit.mjs'], { stdio: 'inherit' })
if (audit.status) process.exitCode = audit.status

const s = out.summary
console.log(JSON.stringify({
  mode: out.mode,
  cases: s.n_cases,
  rq1: s.rq1,
  integrity: s.integrity_proportion,
  max_cv: out.variance.max_cv,
  cv_pass: out.variance.pass,
}, null, 2))
