// WO-3275 (UI M2 standard 13): the UI debt ratchet. Counts the patterns the redesign replaces
// (M2-PLAN section 2) in the old screens, compares them with tools/ui-debt.json, and fails when
// any count rises. Counts may only fall: an order that removes debt lowers the record with
// --update, and --update refuses to raise any count.
//
// Scope: src/components/** (except the kit itself, whose inputs legitimately own the raw
// controls), src/ui2/** and src/App.tsx; .ts and .tsx files. The counts are pattern counts on
// source text (comments removed), the same on every host.
//
// Usage: node tools/ui-debt.mjs            check; exit 1 when a count rose
//        node tools/ui-debt.mjs --update   record lower counts (refuses a rise)
//        node tools/ui-debt.mjs --json     print the current counts
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const RECORD_PATH = join(REPO_ROOT, 'tools', 'ui-debt.json')
export const BIG_FILE_LINES = 1000

const SCAN_DIRS = ['src/components', 'src/ui2']
const SCAN_FILES = ['src/App.tsx']
const EXCLUDE_DIRS = ['src/components/kit']

// One intrinsic (lower-case) JSX opening tag, attributes included; quoted attribute values may
// hold any character, and braces nest three deep, which covers arrow functions, object literals
// and template strings inside attribute expressions.
export const INTRINSIC_TAG = /<([a-z][a-z0-9]*)\b((?:"[^"]*"|'[^']*'|[^<>{}"']|\{(?:[^{}]|\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\})*\})*)\/?>/g

/** The counted patterns. Each returns the number of hits in one file's comment-free text. */
export const METRICS = {
  rawSelect: text => count(text, /<select\b/g),
  rawNumberInput: text => intrinsic(text).filter(t => t.tag === 'input' && /\btype\s*=\s*(?:"number"|'number'|\{\s*['"]number['"]\s*\})/.test(t.attrs)).length,
  titleTooltip: text => intrinsic(text).filter(t => /(?:^|\s)title\s*=/.test(t.attrs)).length,
  inlineStyle: text => count(text, /\bstyle\s*=\s*\{\s*\{/g),
  rawHex: text => stringLiterals(text).reduce((n, s) => n + (s.match(HEX_COLOUR) || []).length, 0),
  toFixed: text => count(text, /\.toFixed\s*\(/g),
  parseFloat: text => count(text, /\bparseFloat\s*\(/g),
  keydownListener: text => count(text, /addEventListener\(\s*['"]keydown['"]/g),
  engineImport: text => importSources(text).filter(isEngineSource).length,
}
export const METRIC_NAMES = Object.keys(METRICS)

// A hex colour inside a string: 6 or 8 digits anywhere a CSS value can start, 3 or 4 digits only at
// the string's start or after CSS punctuation, so 'Tool #100' or 'issue #123' is not a colour.
const HEX_COLOUR = /(?:^|(?<=[\s:(,]))#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6})(?![0-9a-zA-Z])|(?:^|(?<=[:(,]\s*|solid\s+))#[0-9a-fA-F]{3,4}(?![0-9a-zA-Z])/g
const FUNCTION_COLOUR = /\b(?:rgba?|hsla?)\s*\(/

/** One string's text holds a raw colour (a hex colour, or rgb()/hsl()). The lint's no-raw-colour
 *  rule and the rawHex count share this definition. */
export function hasRawColour(text) {
  HEX_COLOUR.lastIndex = 0
  return HEX_COLOUR.test(text) || FUNCTION_COLOUR.test(text)
}

function stringLiterals(text) {
  return [...text.matchAll(/'((?:\\.|[^'\\\n])*)'|"((?:\\.|[^"\\\n])*)"|`((?:\\.|[^`\\])*)`/g)].map(m => m[1] ?? m[2] ?? m[3])
}

/** CAM, kernel and wasm internals a screen may not reach into (standard 10). */
export function isEngineSource(spec) {
  return /(^|\/)lib\/cam(\/|$)|(^|\/)cam3d(\/|$)|(^|\/)kernel(\/|$)|wasm/.test(spec)
}

function count(text, re) {
  return (text.match(re) || []).length
}

function intrinsic(text) {
  const out = []
  for (const m of text.matchAll(INTRINSIC_TAG)) out.push({ tag: m[1], attrs: m[2] })
  return out
}

function importSources(text) {
  const out = []
  // static value imports (import type is not a runtime reach) and re-exports
  for (const m of text.matchAll(/\bimport\s+(?!type\b)(?:[^'"`;]*?\bfrom\s*)?['"]([^'"]+)['"]/g)) out.push(m[1])
  for (const m of text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1])
  return out
}

/** Remove block and line comments, leaving strings (and the newlines, so line counts hold). */
export function stripComments(text) {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1]
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1
      while (j < text.length && text[j] !== c && !(c !== '`' && text[j] === '\n')) j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1); i = j; continue
    }
    if (c === '/' && n === '*') {
      const end = text.indexOf('*/', i + 2), stop = end < 0 ? text.length : end + 2
      out += text.slice(i, stop).replace(/[^\n]/g, ''); i = stop - 1; continue
    }
    if (c === '/' && n === '/') {
      const end = text.indexOf('\n', i); const stop = end < 0 ? text.length : end
      i = stop - 1; continue
    }
    out += c
  }
  return out
}

function walk(dir, files) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, files)
    else if (/\.tsx?$/.test(e.name) && !/\.d\.ts$/.test(e.name)) files.push(p)
  }
}

/** The files the ratchet counts under a repository root, as repo-relative '/' paths. */
export function scopeFiles(root = REPO_ROOT) {
  const files = []
  for (const d of SCAN_DIRS) walk(join(root, d), files)
  for (const f of SCAN_FILES) files.push(join(root, f))
  const rel = p => relative(root, p).split(sep).join('/')
  return files
    .map(rel)
    .filter(p => !EXCLUDE_DIRS.some(d => p === d || p.startsWith(d + '/')))
    .sort()
}

/** Current counts under a repository root. */
export function countUiDebt(root = REPO_ROOT) {
  const counts = Object.fromEntries(METRIC_NAMES.map(k => [k, 0]))
  counts.bigFiles = 0
  for (const file of scopeFiles(root)) {
    let source
    try { source = readFileSync(join(root, file), 'utf8') } catch { continue }
    const text = stripComments(source)
    for (const k of METRIC_NAMES) counts[k] += METRICS[k](text)
    if (source.split('\n').length > BIG_FILE_LINES) counts.bigFiles++
  }
  return counts
}

export function readRecord(path = RECORD_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** Every count that rose above the record (a metric the record lacks counts as a rise). */
export function compareUiDebt(record, counts) {
  const rises = []
  for (const [metric, now] of Object.entries(counts)) {
    const was = record.counts?.[metric]
    if (typeof was !== 'number' || now > was) rises.push({ metric, was: was ?? null, now })
  }
  return rises
}

function main(argv) {
  const counts = countUiDebt()
  if (argv.includes('--json')) { console.log(JSON.stringify(counts, null, 2)); return 0 }
  const record = readRecord()
  const rises = compareUiDebt(record, counts)
  if (argv.includes('--update')) {
    if (rises.length) { console.error(`ui-debt: refusing to record a rise: ${rises.map(r => `${r.metric} ${r.was} -> ${r.now}`).join(', ')}`); return 1 }
    writeFileSync(RECORD_PATH, JSON.stringify({ ...record, counts }, null, 2) + '\n')
    console.log('ui-debt: record updated')
    return 0
  }
  for (const m of Object.keys(counts)) console.log(`${m.padEnd(16)} ${String(counts[m]).padStart(6)}  (record ${record.counts?.[m] ?? '-'})`)
  if (rises.length) {
    console.error(`ui-debt: ${rises.length} count(s) rose: ${rises.map(r => `${r.metric} ${r.was} -> ${r.now}`).join(', ')}. Use the kit, tokens, units service or registry instead.`)
    return 1
  }
  console.log('ui-debt: no count rose')
  return 0
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) process.exit(main(process.argv.slice(2)))
