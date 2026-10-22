#!/usr/bin/env node
// WO-2334: one credits file feeds the public credits.
//
// src/about/credits.json holds an entry for every project, library, vendored
// WASM, font, model, ported source, paper and shared resource LienCAM stands
// on. This tool:
//   - writes CREDITS.md from it, grouped by category, every entry with its
//     thank-you sentence;
//   - writes site/credits.html (the project site's Credits page) from the same
//     entries, so the site, CREDITS.md and the in-app About dialog share one file;
//   - writes the generated block of THIRD_PARTY_LICENSES.md (between the
//     BEGIN/END GENERATED LICENCE TEXTS markers) from the licence files the
//     entries name - the packages' own LICENSE files where they ship one;
//   - with --check, lists everything LienCAM ships or ports from that has no
//     credits entry (package.json dependencies, vendored WASM, bundled fonts,
//     "Ported from" / "adapted from" headers in src/) and exits 1 if any.
//
//   node tools/release/credits.mjs
//   node tools/release/credits.mjs --check [--credits <file>] [--package-json <file>]
//
// Writes only when the content changed, keeping the file's existing line
// endings, so a second run changes nothing.

import { isMain } from '../lib/is-main.mjs';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const CREDITS_JSON = 'src/about/credits.json'
export const CREDITS_MD = 'CREDITS.md'
export const CREDITS_HTML = 'site/credits.html'
export const LICENCES_MD = 'THIRD_PARTY_LICENSES.md'

const BEGIN_MARKER = '<!-- BEGIN GENERATED LICENCE TEXTS: written by tools/release/credits.mjs from src/about/credits.json; do not edit by hand -->'
const END_MARKER = '<!-- END GENERATED LICENCE TEXTS -->'

const FONT_EXTENSIONS = ['.woff2', '.woff', '.ttf', '.otf', '.typeface.json']
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs']
const PORT_HEADER = /\b(?:ported|adapted)\s+from\b/i

// Headers that say "ported from" about LienCAM's own code (one of our files or
// work orders to another), not an upstream project. Nothing to credit.
export const INTERNAL_PORT_HEADERS = Object.freeze({
  'src/components/icons/cadIcons.tsx': 'ported from our own uix/WO-043 branch',
  'src/lib/machine/simulatedController.ts': 'ported from our own simulatedTransport.ts and GrblController',
})

function posix(path) {
  return path.replaceAll('\\', '/')
}

function lf(text) {
  return text.replace(/\r\n?/g, '\n')
}

export function loadCredits(path = join(ROOT, CREDITS_JSON)) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

// ---------------------------------------------------------------------------
// CREDITS.md
// ---------------------------------------------------------------------------

export function renderCreditsMarkdown(credits) {
  const out = [
    '# Credits',
    '',
    'LienCAM exists because a great many people chose to share their work. Every project, library, font, model,',
    'algorithm, paper and published resource below made some part of it possible. Thank you, all of you.',
    '',
    'This page is generated from `src/about/credits.json` by `tools/release/credits.mjs`; edit the JSON, not this file.',
    'The licence terms and full licence texts for everything that ships with LienCAM are in',
    '[THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).',
    '',
  ]
  for (const category of credits.categories) {
    const entries = credits.entries.filter((entry) => entry.category === category.id)
    if (entries.length === 0) continue
    out.push(`## ${category.title}`, '')
    if (category.intro) out.push(category.intro, '')
    for (const entry of entries) {
      out.push(`### ${entry.name}`, '', entry.thanks, '')
      if (entry.role) out.push(`- In LienCAM: ${entry.role}`)
      if (entry.ships) out.push(`- How it ships: ${entry.ships}`)
      if (entry.license) out.push(`- Licence: ${entry.license}`)
      if (entry.link) out.push(`- Link: ${entry.link}`)
      out.push('')
    }
  }
  const unknown = credits.entries.filter((entry) => !credits.categories.some((c) => c.id === entry.category))
  if (unknown.length > 0) {
    throw new Error(`credits entries with an unknown category: ${unknown.map((e) => `${e.id} (${e.category})`).join(', ')}`)
  }
  return `${out.join('\n').trimEnd()}\n`
}

// ---------------------------------------------------------------------------
// site/credits.html
// ---------------------------------------------------------------------------

const escapeHtml = (text) => String(text).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

export function renderCreditsHtml(credits) {
  const unknown = credits.entries.filter((entry) => !credits.categories.some((c) => c.id === entry.category))
  if (unknown.length > 0) {
    throw new Error(`credits entries with an unknown category: ${unknown.map((e) => `${e.id} (${e.category})`).join(', ')}`)
  }
  const out = [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="UTF-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    '  <meta name="description" content="Every project, library, font, model, algorithm, paper and shared resource LienCAM stands on, with thanks.">',
    '  <title>Credits - LienCAM</title>',
    '  <link rel="icon" type="image/svg+xml" href="/media/favicon.svg">',
    '  <link rel="stylesheet" href="/styles/site.css">',
    '  <style>',
    '    .credits { padding-block: 40px 24px; }',
    '    .credit { padding-block: 18px; border-top: 1px solid var(--border-subtle); overflow-wrap: anywhere; }',
    '    .credit h3 { margin: 0 0 6px; font-size: 1.15rem; }',
    '    .credit p { margin-bottom: 8px; }',
    '    .credit-facts { color: var(--text-secondary); font-size: 15px; }',
    '  </style>',
    '</head>',
    '<body>',
    '  <!-- partial:header -->',
    '  <main id="main">',
    '    <article class="credits" aria-labelledby="credits-heading">',
    '      <!-- Generated by tools/release/credits.mjs from src/about/credits.json; edit the JSON, not this file. -->',
    '      <h1 id="credits-heading">Credits</h1>',
    '      <p>LienCAM exists because a great many people chose to share their work. Every project, library, font, model, algorithm, paper and published resource below made some part of it possible. Thank you, all of you.</p>',
    '      <p>The licence terms and full licence texts for everything that ships with LienCAM are in <a href="https://github.com/eclsnowman/LienCAM/blob/main/THIRD_PARTY_LICENSES.md">THIRD_PARTY_LICENSES.md</a>.</p>',
  ]
  for (const category of credits.categories) {
    const entries = credits.entries.filter((entry) => entry.category === category.id)
    if (entries.length === 0) continue
    out.push(`      <section class="credit-category" id="${escapeHtml(category.id)}" aria-labelledby="${escapeHtml(category.id)}-heading">`)
    out.push(`        <h2 id="${escapeHtml(category.id)}-heading">${escapeHtml(category.title)}</h2>`)
    if (category.intro) out.push(`        <p>${escapeHtml(category.intro)}</p>`)
    for (const entry of entries) {
      out.push(`        <div class="credit" id="credit-${escapeHtml(entry.id)}">`)
      out.push(`          <h3>${escapeHtml(entry.name)}</h3>`)
      out.push(`          <p>${escapeHtml(entry.thanks)}</p>`)
      const facts = []
      if (entry.role) facts.push(`In LienCAM: ${escapeHtml(entry.role)}`)
      if (entry.license) facts.push(`Licence: ${escapeHtml(entry.license)}`)
      if (entry.link) facts.push(`<a href="${escapeHtml(entry.link)}">${escapeHtml(entry.link)}</a>`)
      if (facts.length > 0) out.push(`          <p class="credit-facts">${facts.join(' &middot; ')}</p>`)
      out.push('        </div>')
    }
    out.push('      </section>')
  }
  out.push('    </article>', '  </main>', '  <!-- partial:footer -->', '</body>', '</html>')
  return `${out.join('\n')}\n`
}

// ---------------------------------------------------------------------------
// THIRD_PARTY_LICENSES.md generated block
// ---------------------------------------------------------------------------

export function renderLicenceTexts(credits, root = ROOT) {
  const out = [BEGIN_MARKER, '']
  for (const entry of credits.entries) {
    for (const text of entry.licenseTexts ?? []) {
      const path = join(root, text.from)
      if (!existsSync(path)) {
        throw new Error(`credits entry ${entry.id}: licence text ${text.from} does not exist`)
      }
      out.push(`### ${text.title}`, '', `From \`${text.from}\`.`, '', '````text',
        lf(readFileSync(path, 'utf8')).trimEnd(), '````', '')
    }
  }
  out.push(END_MARKER)
  return out.join('\n')
}

export function spliceLicenceTexts(licencesMarkdown, block) {
  const text = lf(licencesMarkdown)
  const begin = text.indexOf(BEGIN_MARKER)
  const end = text.indexOf(END_MARKER)
  if (begin < 0 || end < begin) {
    throw new Error(`${LICENCES_MD} has no BEGIN/END GENERATED LICENCE TEXTS markers`)
  }
  return text.slice(0, begin) + block + text.slice(end + END_MARKER.length)
}

function writeIfChanged(path, content) {
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : null
  if (existing !== null && lf(existing) === content) return false
  const crlf = existing !== null && existing.includes('\r\n')
  writeFileSync(path, crlf ? content.replace(/\n/g, '\r\n') : content)
  return true
}

export function writeGenerated(root = ROOT) {
  const credits = loadCredits(join(root, CREDITS_JSON))
  const written = []
  if (writeIfChanged(join(root, CREDITS_MD), renderCreditsMarkdown(credits))) written.push(CREDITS_MD)
  if (writeIfChanged(join(root, CREDITS_HTML), renderCreditsHtml(credits))) written.push(CREDITS_HTML)
  const licencesPath = join(root, LICENCES_MD)
  const licences = spliceLicenceTexts(readFileSync(licencesPath, 'utf8'), renderLicenceTexts(credits, root))
  if (writeIfChanged(licencesPath, licences)) written.push(LICENCES_MD)
  return written
}

// ---------------------------------------------------------------------------
// Coverage check
// ---------------------------------------------------------------------------

function walk(root, directory, keep, skip = () => false) {
  const found = []
  const absolute = join(root, directory)
  if (!existsSync(absolute)) return found
  const visit = (path) => {
    for (const name of readdirSync(path).sort()) {
      const child = join(path, name)
      const rel = posix(relative(root, child))
      if (skip(rel)) continue
      if (statSync(child).isDirectory()) visit(child)
      else if (keep(rel)) found.push(rel)
    }
  }
  visit(absolute)
  return found
}

const notProductSource = (rel) =>
  rel === 'src/tests' || rel === 'src/spikes' || rel.endsWith('/evidence') || rel.includes('/node_modules')

/** The leading comment block of a source file, as lines. */
export function leadingComment(source) {
  const lines = lf(source).split('\n')
  const header = []
  let inBlock = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (inBlock) {
      header.push(line)
      if (trimmed.includes('*/')) inBlock = false
      continue
    }
    if (trimmed === '' || trimmed.startsWith('#!') || trimmed.startsWith('//')) {
      header.push(line)
      continue
    }
    if (trimmed.startsWith('/*')) {
      header.push(line)
      inBlock = !trimmed.includes('*/', 2)
      continue
    }
    break
  }
  return header
}

/** Every "Ported from" / "adapted from" line in a source file's header, with the line after it. */
export function portHeaders(source) {
  const header = leadingComment(source)
  const found = []
  header.forEach((line, index) => {
    const match = PORT_HEADER.exec(line)
    if (match) found.push(`${line.slice(match.index)} ${header[index + 1] ?? ''}`.replace(/\s+/g, ' ').trim())
  })
  return found
}

export function creditInventory(root = ROOT, packageJsonPath = join(root, 'package.json')) {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  const sources = walk(root, 'src', (rel) => SOURCE_EXTENSIONS.some((ext) => rel.endsWith(ext)), notProductSource)
  const fontImports = new Set()
  const ports = []
  for (const rel of sources) {
    const source = readFileSync(join(root, rel), 'utf8')
    for (const match of source.matchAll(/['"](three\/examples\/fonts\/[^'"]+)['"]/g)) fontImports.add(match[1])
    for (const text of portHeaders(source)) ports.push({ file: rel, text })
  }
  return {
    dependencies: Object.keys(packageJson.dependencies ?? {}).sort(),
    wasm: [
      ...walk(root, 'src', (rel) => rel.endsWith('.wasm'), notProductSource),
      ...walk(root, 'public', (rel) => rel.endsWith('.wasm')),
      ...walk(root, 'vendor', (rel) => rel.endsWith('.wasm') || rel.endsWith('.tgz')),
    ],
    fonts: [
      ...walk(root, 'public/fonts', (rel) => FONT_EXTENSIONS.some((ext) => rel.endsWith(ext))),
      ...walk(root, 'src', (rel) => /\/fonts\/[^/]+$/.test(rel) && !/\.(txt|md)$/i.test(rel), notProductSource),
      ...[...fontImports].sort(),
    ],
    ports,
  }
}

/** Everything in the inventory that no credits entry covers. Empty means complete. */
export function findCreditGaps({ root = ROOT, credits = loadCredits(join(root, CREDITS_JSON)), packageJsonPath } = {}) {
  const inventory = creditInventory(root, packageJsonPath ?? join(root, 'package.json'))
  const packages = new Set(credits.entries.flatMap((entry) => entry.packages ?? []))
  const files = new Set(credits.entries.flatMap((entry) => entry.files ?? []))
  const markers = credits.entries.flatMap((entry) => entry.sourceMarkers ?? []).map((marker) => marker.toLowerCase())
  const gaps = []
  for (const name of inventory.dependencies) {
    if (!packages.has(name)) gaps.push({ kind: 'dependency', item: name, where: 'package.json dependencies' })
  }
  for (const file of inventory.wasm) {
    if (!files.has(file)) gaps.push({ kind: 'vendored WASM', item: file, where: file })
  }
  for (const file of inventory.fonts) {
    if (!files.has(file)) gaps.push({ kind: 'bundled font', item: file, where: file })
  }
  for (const { file, text } of inventory.ports) {
    if (INTERNAL_PORT_HEADERS[file]) continue
    if (!markers.some((marker) => text.toLowerCase().includes(marker))) {
      gaps.push({ kind: 'ported source', item: text, where: file })
    }
  }
  return gaps
}

function argValue(args, name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

function main(args) {
  if (args.includes('--check')) {
    const creditsPath = argValue(args, '--credits')
    const packageJsonPath = argValue(args, '--package-json')
    const gaps = findCreditGaps({
      credits: creditsPath ? loadCredits(resolve(creditsPath)) : undefined,
      packageJsonPath: packageJsonPath ? resolve(packageJsonPath) : undefined,
    })
    for (const gap of gaps) console.log(`uncredited ${gap.kind}: ${gap.item} (${gap.where})`)
    console.log(gaps.length === 0 ? 'credits: every shipped or ported component has an entry' : `credits: ${gaps.length} uncredited`)
    return gaps.length === 0 ? 0 : 1
  }
  const written = writeGenerated()
  console.log(written.length === 0 ? 'credits: CREDITS.md, site/credits.html and THIRD_PARTY_LICENSES.md already current' : `credits: wrote ${written.join(', ')}`)
  return 0
}

if (isMain(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
