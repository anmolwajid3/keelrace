/**
 * Prints frontend/public/keelrace-user-guide.html to the sidebar PDF.
 * The HTML is the designed guide (cover, tables, callouts). Run:
 *   node scripts/write-keelrace-guide-pdf.mjs
 */
import { spawnSync } from 'child_process'
import { existsSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { pathToFileURL } from 'url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HTML = join(ROOT, 'frontend', 'public', 'keelrace-user-guide.html')
const OUT = join(ROOT, 'frontend', 'public', 'keelrace-user-guide.pdf')

const candidates = [
  process.env.BROWSER,
  join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
].filter(Boolean)

const browser = candidates.find((p) => existsSync(p))
if (!browser) {
  console.error('No Edge or Chrome found. Set BROWSER to a Chromium executable.')
  process.exit(1)
}

const fileUrl = pathToFileURL(HTML).href
const result = spawnSync(browser, [
  '--headless',
  '--disable-gpu',
  '--no-pdf-header-footer',
  `--print-to-pdf=${OUT}`,
  fileUrl,
], { stdio: 'inherit' })

if (result.status !== 0) {
  console.error(`Print failed (${result.status})`)
  process.exit(result.status || 1)
}
console.log(`Wrote ${OUT} from the designed HTML guide`)
