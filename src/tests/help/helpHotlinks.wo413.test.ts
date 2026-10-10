// WO-413 - the probe-routine help section's teeth, and the link census.
//   - the "What the errors mean" table has one row per RoutineErrorCode the
//     format module DECLARES (harvested from the type unions, not a copied list)
//   - every anchor a product HelpLink asks for exists in its topic
//   - the surfaces Operator named carry a HelpLink (source-level, so a removed link
//     fails by name)

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { loadTopic } from '../../help/registry'
import { helpIndexEntry } from '../../help/registry'
import { errorCodeAnchor } from '../../help/helpOpen'
import type { HelpSection } from '../../help/types'

const SRC_ROOT = fileURLToPath(new URL('../../', import.meta.url))

function harvestErrorCodes(): string[] {
  const source = readFileSync(join(SRC_ROOT, 'lib', 'machine', 'probeRoutineFormat.ts'), 'utf8')
  const codes = new Set<string>()
  for (const typeName of ['ProbeRoutineStaticErrorCode', 'ProbeRoutineExpansionErrorCode', 'ProbeRoutineRunErrorCode']) {
    const block = source.match(new RegExp(`export type ${typeName} =([^]*?)\\r?\\n\\r?\\n`))?.[1]
    expect(block, `${typeName} not found in probeRoutineFormat.ts`).toBeTruthy()
    for (const m of block!.matchAll(/'(E_[A-Z0-9_]+)'/g)) codes.add(m[1])
  }
  return [...codes].sort()
}

function anchorsOf(sections: HelpSection[]): Set<string> {
  const anchors = new Set<string>()
  for (const s of sections) {
    if (s.kind === 'heading') anchors.add(s.anchor)
    if (s.kind === 'table') for (const r of s.rows) if (r.anchor) anchors.add(r.anchor)
  }
  return anchors
}

describe('WO-413: the probe-routine help section', () => {
  it('has a "what the errors mean" row, in plain words, for every RoutineErrorCode the format declares', async () => {
    const topic = await loadTopic('probe-routines')
    expect(topic).toBeTruthy()
    const codes = harvestErrorCodes()
    expect(codes.length, `error-code harvest collapsed: ${codes.join(', ')}`).toBeGreaterThanOrEqual(30)
    const table = topic!.sections.find((s): s is Extract<HelpSection, { kind: 'table' }> => s.kind === 'table' && s.columns[0] === 'Code')
    expect(table).toBeTruthy()
    const rowsByCode = new Map(table!.rows.map((r) => [r.cells[0], r]))
    const missing = codes.filter((c) => !rowsByCode.has(c))
    expect(missing, `codes without a help row: ${missing.join(', ')}`).toEqual([])
    const stale = [...rowsByCode.keys()].filter((c) => !codes.includes(c))
    expect(stale, `help rows for codes the format no longer declares: ${stale.join(', ')}`).toEqual([])
    for (const code of codes) {
      const row = rowsByCode.get(code)!
      expect(row.anchor, `${code} row has no anchor`).toBe(errorCodeAnchor(code))
      expect(row.cells[2].length, `${code} row is a placeholder`).toBeGreaterThan(40)
      expect(row.cells[2], `${code} explanation just repeats the code`).not.toMatch(/^E_/)
    }
  })

  it('covers the sections Operator asked for, each under its own anchor', async () => {
    const topic = await loadTopic('probe-routines')
    const anchors = anchorsOf(topic!.sections)
    for (const a of ['what-is', 'inputs', 'steps', 'check-preview', 'proposals', 'provenance', 'import-export', 'restore-factory', 'errors']) {
      expect(anchors.has(a), `probe-routines is missing the "${a}" section`).toBe(true)
    }
    const text = topic!.sections.map((s) => ('text' in s ? s.text : s.kind === 'steps' ? s.steps.join(' ') : s.kind === 'table' ? s.rows.map((r) => r.cells.join(' ')).join(' ') : '')).join(' ')
    for (const word of ['Confirm', 'FACTORY', 'USER', 'IMPORTED', 'reviewed', 'Restore factory routines', 'liencam-probe.json', 'path is clear']) {
      expect(text, `probe-routines never mentions "${word}"`).toContain(word)
    }
  })
})

/** Every `<HelpLink topic="x" anchor="y"` in product source (src/ minus tests). */
function harvestHelpLinks(): Array<{ file: string; topic: string; anchor: string | null }> {
  const out: Array<{ file: string; topic: string; anchor: string | null }> = []
  const testsDir = join(SRC_ROOT, 'tests')
  const walk = (dir: string) => {
    if (dir === testsDir) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (/\.tsx$/.test(entry.name)) {
        const text = readFileSync(p, 'utf8')
        for (const m of text.matchAll(/<HelpLink\b([^>]*)>/g)) {
          const topic = m[1].match(/\btopic="([a-z0-9-]+)"/)?.[1]
          if (!topic) continue
          const anchor = m[1].match(/\banchor="([a-z0-9-]+)"/)?.[1] ?? null
          out.push({ file: p.slice(SRC_ROOT.length).replace(/\\/g, '/'), topic, anchor })
        }
      }
    }
  }
  walk(SRC_ROOT)
  return out
}

describe('WO-413: the hotlink census', () => {
  it('every HelpLink in product source names a real topic, and any literal anchor exists in it', async () => {
    const links = harvestHelpLinks()
    expect(links.length, 'no HelpLinks found in product source - harvest rotted?').toBeGreaterThanOrEqual(8)
    for (const link of links) {
      expect(helpIndexEntry(link.topic), `${link.file}: HelpLink topic "${link.topic}" is not in the help index`).toBeTruthy()
      if (link.anchor) {
        const topic = await loadTopic(link.topic)
        expect(anchorsOf(topic!.sections).has(link.anchor), `${link.file}: anchor "${link.anchor}" is not in topic ${link.topic}`).toBe(true)
      }
    }
  })

  it('the surfaces Operator named carry a help link', () => {
    const byFile = new Map<string, Set<string>>()
    for (const l of harvestHelpLinks()) {
      if (!byFile.has(l.file)) byFile.set(l.file, new Set())
      byFile.get(l.file)!.add(l.topic)
    }
    const expectLink = (file: string, topic: string) =>
      expect(byFile.get(file)?.has(topic) ?? false, `${file} has no HelpLink to ${topic}`).toBe(true)
    expectLink('components/machine/ProbeRoutineEditor.tsx', 'probe-routines')
    expectLink('components/machine/ProbeRoutinePreview.tsx', 'probe-routines')
    expectLink('components/machine/ProbingPanel.tsx', 'probing-tab')
    expectLink('components/machine/ProgramPreview.tsx', 'program-context')
    expectLink('components/modals/PostProcessModal.tsx', 'post-include-context')
  })
})
