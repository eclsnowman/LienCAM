#!/usr/bin/env node
// WO-2409: one roadmap file feeds the public roadmap.
//
// docs/roadmap/roadmap.json holds every future-work row (id, theme, item, goal,
// status, note, priority, plus the internal source and size), the "where we are"
// and "where we are aiming" text, and the fixed status words. This tool writes
//   - ROADMAP.md at the repo root, and
//   - site/roadmap.html (the project site's Roadmap page, in the site frame)
// from it. Both show Item, Goal, Status and Priority grouped by theme, and never
// the internal Source or Size columns or the lifecycle fields (links, decisions,
// history; WO-2985). Rows whose status is "idea" are listed under "Ideas" instead
// of their theme; a superseded row (links.supersededBy) is not listed.
//
//   node tools/release/roadmap.mjs            write the two files
//   node tools/release/roadmap.mjs --check    exit 1 if either file is stale
//
// Writes only when the content changed, keeping the file's existing line
// endings, so a second run changes nothing.

import { isMain } from '../lib/is-main.mjs';
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const ROADMAP_JSON = 'docs/roadmap/roadmap.json'
export const ROADMAP_MD = 'ROADMAP.md'
export const ROADMAP_HTML = 'site/roadmap.html'
export const IDEAS = 'Ideas'

const GENERATED = 'generated from docs/roadmap/roadmap.json - edit that file'
const REPO = 'https://github.com/eclsnowman/LienCAM'

const lf = (text) => text.replace(/\r\n?/g, '\n')
const escapeHtml = (text) => String(text).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
const escapeCell = (text) => String(text).replaceAll('|', '\\|')

export function loadRoadmap(path = join(ROOT, ROADMAP_JSON)) {
  return validateRoadmap(JSON.parse(readFileSync(path, 'utf8')))
}

// WO-2985: the internal lifecycle fields (docs/design/WO-2961-roadmap-oracle.md sec. 4). Written by
// tools/roadmap/lifecycle.mjs; validated here; never rendered on the public pages.
const ROW_ID = /^R-\d{3,}$/
const ORDER_ID = /^WO-\d+[A-Z]?$/
const REQUEST_ID = /^(issue|discussion)-\d+$/
const DATE = /^\d{4}-\d{2}-\d{2}/
const isList = (value, test) => Array.isArray(value) && value.every((v) => typeof v === 'string' && test.test(v))

function validateLifecycle(row, ids) {
  const fail = (what) => { throw new Error(`roadmap: ${row.id} ${what}`) }
  if (row.links !== undefined) {
    const { orders, requests, supersededBy, duplicates, ...extra } = row.links ?? {}
    if (typeof row.links !== 'object' || row.links === null || Array.isArray(row.links)) fail('links must be an object')
    if (Object.keys(extra).length) fail(`links has unknown field(s) ${Object.keys(extra).join(', ')}`)
    if (orders !== undefined && !isList(orders, ORDER_ID)) fail('links.orders must list WO-nnnn ids')
    if (requests !== undefined && !isList(requests, REQUEST_ID)) fail('links.requests must list issue-<n> or discussion-<n> ids')
    if (supersededBy !== undefined && (!ROW_ID.test(supersededBy) || supersededBy === row.id || !ids.has(supersededBy))) fail(`links.supersededBy "${supersededBy}" is not another row`)
    if (duplicates !== undefined && (!isList(duplicates, ROW_ID) || duplicates.some((d) => d === row.id || !ids.has(d)))) fail('links.duplicates must list other rows')
  }
  if (row.decisions !== undefined) {
    if (!Array.isArray(row.decisions)) fail('decisions must be a list')
    for (const d of row.decisions) {
      if (!d || !d.ref || !DATE.test(d.at ?? '') || typeof d.words !== 'string' || !d.by) fail('decisions entries need ref, at (YYYY-MM-DD), words and by')
    }
  }
  if (row.history !== undefined) {
    if (!Array.isArray(row.history)) fail('history must be a list')
    for (const h of row.history) if (!h || !DATE.test(h.at ?? '') || !h.by) fail('history entries need at (YYYY-MM-DD) and by')
  }
}

export function validateRoadmap(roadmap) {
  const words = new Set(roadmap.statuses.map((s) => s.id))
  const priorities = new Set(roadmap.priorities.map((p) => p.id))
  const ids = new Set()
  for (const row of roadmap.rows) {
    if (ids.has(row.id)) throw new Error(`roadmap: duplicate id ${row.id}`)
    ids.add(row.id)
    if (!words.has(row.status)) throw new Error(`roadmap: ${row.id} has status "${row.status}", not one of ${[...words].join(', ')}`)
    if (!roadmap.themes.includes(row.theme)) throw new Error(`roadmap: ${row.id} has unknown theme "${row.theme}"`)
    if (row.priority != null && row.priority !== 'idea' && !priorities.has(row.priority)) throw new Error(`roadmap: ${row.id} has unknown priority ${row.priority}`)
  }
  for (const row of roadmap.rows) validateLifecycle(row, ids)
  return roadmap
}

const statusLabel = (roadmap, row) => roadmap.statuses.find((s) => s.id === row.status).label
const priorityLabel = (roadmap, row) => {
  if (row.priority === 'idea') return 'Idea'
  if (row.priority == null) return '-'
  return roadmap.priorities.find((p) => p.id === row.priority).label
}

// [{ title, rows }] in theme order, then Ideas. A superseded row (links.supersededBy) stays in the file and
// leaves the public list (WO-2985).
export function groupRows(roadmap) {
  const shown = roadmap.rows.filter((r) => !r.links?.supersededBy)
  const groups = roadmap.themes
    .map((title) => ({ title, rows: shown.filter((r) => r.theme === title && r.status !== 'idea') }))
    .filter((g) => g.rows.length > 0)
  const ideas = shown.filter((r) => r.status === 'idea')
  if (ideas.length > 0) groups.push({ title: IDEAS, rows: ideas })
  return groups
}

export function renderMarkdown(roadmap) {
  const out = [
    '# LienCAM roadmap',
    '',
    `<!-- ${GENERATED} -->`,
    '',
    '## Where we are',
    '',
    roadmap.whereWeAre,
    '',
    '## Where we are aiming',
    '',
    roadmap.whereWeAim,
    '',
    '## How to read this',
    '',
    'Status:',
    '',
    ...roadmap.statuses.map((s) => `- **${s.label}** - ${s.meaning}`),
    '',
    'Priority:',
    '',
    ...roadmap.priorities.map((p) => `- **${p.label}** - ${p.meaning}`),
    '',
    `Have a request? Open an idea in [Discussions](${REPO}/discussions); it gets a number (R-nnn) and a row here with the status Idea.`,
    '',
  ]
  for (const group of groupRows(roadmap)) {
    out.push(`## ${group.title}`, '', '| ID | Item | Goal | Status | Priority |', '|---|---|---|---|---|')
    for (const row of group.rows) {
      const status = row.note ? `**${statusLabel(roadmap, row)}** - ${row.note}` : `**${statusLabel(roadmap, row)}**`
      out.push(`| ${row.id} | ${escapeCell(row.item)} | ${escapeCell(row.goal)} | ${escapeCell(status)} | ${priorityLabel(roadmap, row)} |`)
    }
    out.push('')
  }
  return `${out.join('\n').trimEnd()}\n`
}

const slug = (title) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

export function renderHtml(roadmap) {
  const out = [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="UTF-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    '  <meta name="description" content="Where LienCAM is today, where it is going, and the status of every future capability.">',
    '  <title>LienCAM - Roadmap</title>',
    '  <link rel="icon" type="image/svg+xml" href="/media/favicon.svg">',
    '  <link rel="stylesheet" href="/styles/site.css">',
    '  <style>',
    '    .roadmap-table { width: 100%; border-collapse: collapse; font-size: 16px; }',
    '    .roadmap-table th, .roadmap-table td { text-align: left; vertical-align: top; padding: 12px 14px; border-bottom: 1px solid var(--border-subtle); }',
    '    .roadmap-table thead { background: var(--surface-1); }',
    '    .roadmap-table .item { font-weight: 600; }',
    '    .roadmap-table .status-word { font-weight: 700; }',
    '    .roadmap-table [data-status="alpha"] .status-word, .roadmap-table [data-status="done"] .status-word { color: var(--text-active); }',
    '    .roadmap-table [data-status="experimental"] .status-word, .roadmap-table [data-status="idea"] .status-word { color: var(--text-secondary); }',
    '    .roadmap-table .note { display: block; color: var(--text-secondary); font-size: 14px; }',
    '    .roadmap-key { color: var(--text-secondary); font-size: 15px; }',
    '    @media (max-width: 600px) {',
    '      .roadmap-table thead { position: absolute; left: -9999px; }',
    '      .roadmap-table, .roadmap-table tbody, .roadmap-table tr, .roadmap-table td { display: block; }',
    '      .roadmap-table tr { padding-block: 14px; border-bottom: 1px solid var(--border-subtle); }',
    '      .roadmap-table td { padding: 3px 0; border: 0; overflow-wrap: anywhere; }',
    '      .roadmap-table td[data-label]::before { content: attr(data-label) ": "; color: var(--text-secondary); font-size: 13px; }',
    '    }',
    '  </style>',
    '</head>',
    '<body>',
    '  <!-- partial:header -->',
    '  <main id="main">',
    `    <!-- ${GENERATED} (tools/release/roadmap.mjs) -->`,
    '    <section aria-labelledby="roadmap-heading">',
    '      <h1 id="roadmap-heading">Roadmap</h1>',
    '      <h2>Where we are</h2>',
    `      <p>${escapeHtml(roadmap.whereWeAre)}</p>`,
    '      <h2>Where we are aiming</h2>',
    `      <p>${escapeHtml(roadmap.whereWeAim)}</p>`,
    '      <h2>How to read this</h2>',
    '      <p class="roadmap-key"><strong>Status:</strong></p>',
    '      <ul class="roadmap-key">' + roadmap.statuses.map((s) => `<li><strong>${escapeHtml(s.label)}</strong> - ${escapeHtml(s.meaning)}</li>`).join('') + '</ul>',
    '      <p class="roadmap-key"><strong>Priority:</strong></p>',
    '      <ul class="roadmap-key">' + roadmap.priorities.map((p) => `<li><strong>${escapeHtml(p.label)}</strong> - ${escapeHtml(p.meaning)}</li>`).join('') + '</ul>',
    `      <p>Have a request? Open an idea in <a href="{{route:community}}">Discussions</a>; it gets a number and a row here. The same list is in <a href="${REPO}/blob/main/ROADMAP.md">ROADMAP.md</a>.</p>`,
    '    </section>',
  ]
  for (const group of groupRows(roadmap)) {
    const id = `theme-${slug(group.title)}`
    out.push(`    <section id="${id}" aria-labelledby="${id}-heading">`,
      `      <h2 id="${id}-heading">${escapeHtml(group.title)}</h2>`,
      '      <table class="roadmap-table">',
      '        <thead><tr><th scope="col">Item</th><th scope="col">Goal</th><th scope="col">Status</th><th scope="col">Priority</th></tr></thead>',
      '        <tbody>')
    for (const row of group.rows) {
      const note = row.note ? `<span class="note">${escapeHtml(row.note)}</span>` : ''
      out.push(`          <tr id="${escapeHtml(row.id.toLowerCase())}" data-status="${escapeHtml(row.status)}">`,
        `            <td class="item" data-label="Item">${escapeHtml(row.item)} <span class="note">${escapeHtml(row.id)}</span></td>`,
        `            <td data-label="Goal">${escapeHtml(row.goal)}</td>`,
        `            <td data-label="Status"><span class="status-word">${escapeHtml(statusLabel(roadmap, row))}</span>${note}</td>`,
        `            <td data-label="Priority">${escapeHtml(priorityLabel(roadmap, row))}</td>`,
        '          </tr>')
    }
    out.push('        </tbody>', '      </table>', '    </section>')
  }
  out.push('  </main>', '  <!-- partial:footer -->', '</body>', '</html>')
  return `${out.join('\n')}\n`
}

function writeIfChanged(path, content) {
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : null
  if (existing !== null && lf(existing) === content) return false
  const crlf = existing !== null && existing.includes('\r\n')
  writeFileSync(path, crlf ? content.replace(/\n/g, '\r\n') : content)
  return true
}

export function outputs(roadmap) {
  return [[ROADMAP_MD, renderMarkdown(roadmap)], [ROADMAP_HTML, renderHtml(roadmap)]]
}

export function writeGenerated(root = ROOT) {
  const roadmap = loadRoadmap(join(root, ROADMAP_JSON))
  return outputs(roadmap).filter(([file, content]) => writeIfChanged(join(root, file), content)).map(([file]) => file)
}

export function findStale(root = ROOT) {
  const roadmap = loadRoadmap(join(root, ROADMAP_JSON))
  return outputs(roadmap)
    .filter(([file, content]) => !existsSync(join(root, file)) || lf(readFileSync(join(root, file), 'utf8')) !== content)
    .map(([file]) => file)
}

function main(args) {
  if (args.includes('--check')) {
    const stale = findStale()
    for (const file of stale) console.log(`roadmap: ${file} is stale - run node tools/release/roadmap.mjs`)
    console.log(stale.length === 0 ? 'roadmap: ROADMAP.md and site/roadmap.html are current' : `roadmap: ${stale.length} stale`)
    return stale.length === 0 ? 0 : 1
  }
  const written = writeGenerated()
  console.log(written.length === 0 ? 'roadmap: ROADMAP.md and site/roadmap.html already current' : `roadmap: wrote ${written.join(', ')}`)
  return 0
}

if (isMain(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
