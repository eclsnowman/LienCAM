// B14 (docs/planning/POST-MERGE-WORKPLAN.md): importing the user's SolidWorks-
// exported DXF (Sample Parts/Leadscrew_Stepper_Mount.DXF) listed layers '0',
// 'FORMAT' and 'SW_CENTERMARKSYMBOL_6' in the sketch-layer chooser, all
// showing 0 loops. The DXF twin of the SVG defs fix (B5).
//
// Two root causes in dxfImporter.ts:
//   1. parseLayers committed every LAYER table record as a Layer2D whether or
//      not any parsed entity (LINE/ARC/CIRCLE/LWPOLYLINE) lives on it. '0' and
//      'FORMAT' are real but EMPTY table layers (SolidWorks sheet-format junk;
//      the title-block annotations are TEXT/INSERT entities the importer never
//      converts).
//   2. parseLayers only closed a LAYER record on the NEXT '0/LAYER' pair, so
//      the LAST record stayed open through the rest of the TABLES section
//      (STYLE, APPID, DIMSTYLE, BLOCK_RECORD). Every later code-2 value
//      overwrote its name; the final commit produced a pseudo-layer named
//      after the last BLOCK_RECORD - 'SW_CENTERMARKSYMBOL_6', a center-mark
//      BLOCK name, not a layer at all - while the real last layer ('Pocket')
//      was never committed and lost its table color to the entity fallback.
//
// Rule under test (same conservative rule as the SVG importer): a layer that
// ends up with ZERO loops after import does not become a Layer2D. Real
// geometry must import exactly as before.
//
// These tests run the REAL import pipeline on the actual repro file, with an
// independent evidence scan of the raw DXF text, plus hand-constructed minimal
// DXF fixtures isolating each root cause.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, beforeAll } from 'vitest'
import { importDXF } from '../../lib/import/dxfImporter'
import type { Import2DResult } from '../../lib/import/svgImporter'

const here = dirname(fileURLToPath(import.meta.url))
const dxfPath = join(here, '../../../Sample Parts/Leadscrew_Stepper_Mount.DXF')
const dxfText = readFileSync(dxfPath, 'utf8')

// -- Independent ground truth from the raw file ------------------------------
// Same two-line code/value pairing convention as the importer's tokenizer,
// but scanned independently so the test does not trust the code under test.

interface Pair { code: number; value: string }

function rawPairs(text: string): Pair[] {
  const lines = text.split(/\r?\n/)
  const pairs: Pair[] = []
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10)
    if (!isNaN(code)) pairs.push({ code, value: lines[i + 1].trim() })
  }
  return pairs
}

// Layer names declared in the LAYER table (record-scoped: a name is only a
// layer name when its record opened with 0/LAYER).
function tableLayerNames(pairs: Pair[]): string[] {
  const names: string[] = []
  let record = ''
  for (const { code, value } of pairs) {
    if (code === 0) { record = value; continue }
    if (record === 'LAYER' && code === 2) { names.push(value); record = '' }
  }
  return names
}

// Layers that own at least one geometry entity in ENTITIES.
const GEO_TYPES = new Set(['LINE', 'ARC', 'CIRCLE', 'LWPOLYLINE'])

function entityGeoLayers(pairs: Pair[]): Map<string, number> {
  const counts = new Map<string, number>()
  let inEntities = false, entityType = ''
  for (const { code, value } of pairs) {
    if (code === 2 && value === 'ENTITIES') { inEntities = true; continue }
    if (code === 0 && value === 'ENDSEC') { inEntities = false; continue }
    if (!inEntities) continue
    if (code === 0) { entityType = value; continue }
    if (code === 8 && GEO_TYPES.has(entityType)) {
      counts.set(value, (counts.get(value) ?? 0) + 1)
    }
  }
  return counts
}

let result: Import2DResult

beforeAll(() => {
  result = importDXF(dxfText)
})

describe('B14 evidence: the repro DXF declares layers that own zero geometry', () => {
  it('LAYER table has 0/FORMAT with no geometry entities; SW_CENTERMARKSYMBOL is a BLOCK name', () => {
    const pairs = rawPairs(dxfText)
    const declared = tableLayerNames(pairs)
    const withGeo = entityGeoLayers(pairs)

    // The SolidWorks export declares 5 layers...
    expect(declared).toEqual(['0', 'FORMAT', 'Holes', 'Outer Contour', 'Pocket'])
    // ...but only 3 own parseable geometry ('0' and 'FORMAT' are empty)
    expect(Array.from(withGeo.keys()).sort()).toEqual(['Holes', 'Outer Contour', 'Pocket'])

    // SW_CENTERMARKSYMBOL_6 is NOT a layer anywhere in the file - it is a
    // BLOCK_RECORD / BLOCK name (the source of the leaked pseudo-layer).
    expect(declared.some(n => n.includes('SW_CENTERMARK'))).toBe(false)
    expect(dxfText).toContain('SW_CENTERMARKSYMBOL_6')
  })
})

describe('B14: zero-loop layers do not become Layer2D', () => {
  it('imports exactly the three geometry-owning layers (no 0/FORMAT/SW_CENTERMARK)', () => {
    const names = result.layers.map(l => l.name).sort()
    expect(names).toEqual(['Holes', 'Outer Contour', 'Pocket'])
    expect(names.some(n => n === '0' || n === 'FORMAT' || n.includes('SW_CENTERMARK'))).toBe(false)
  })

  it('every surviving layer owns at least one loop and every loop points at a real layer', () => {
    const layerIds = new Set(result.layers.map(l => l.id))
    const usedIds = new Set(result.loops.map(l => l.layerId))
    for (const id of layerIds) expect(usedIds.has(id)).toBe(true)
    for (const loop of result.loops) expect(layerIds.has(loop.layerId)).toBe(true)
  })

  it('real geometry imports unchanged: 1 outer contour + 7 holes + 1 pocket', () => {
    const counts = new Map<string, number>()
    for (const l of result.loops) counts.set(l.layerId, (counts.get(l.layerId) ?? 0) + 1)
    expect(counts.get('Outer Contour')).toBe(1)
    expect(counts.get('Holes')).toBe(7)
    expect(counts.get('Pocket')).toBe(1)
    expect(result.loops).toHaveLength(9)
    expect(result.boundingBox.size.x).toBeGreaterThan(0)
    expect(result.boundingBox.size.y).toBeGreaterThan(0)
  })

  it('layers keep their LAYER-table colors (Pocket was losing ACI 3 to the leak)', () => {
    const colorOf = (name: string) => result.layers.find(l => l.name === name)?.color
    expect(colorOf('Holes')).toBe('#40e0d0')          // ACI 4 cyan
    expect(colorOf('Outer Contour')).toBe('#ff80ab')  // ACI 6 magenta
    expect(colorOf('Pocket')).toBe('#4cff88')         // ACI 3 green (was fallback blue)
  })
})

// -- Constructed minimal fixtures (SolidWorks-style, hand-built text DXF) -----

function dxf(pairs: Array<[number | string, string]>): string {
  return pairs.map(([c, v]) => `${c}\n${v}`).join('\n') + '\n'
}

const TABLES_WITH_JUNK: Array<[number | string, string]> = [
  [0, 'SECTION'], [2, 'TABLES'],
  [0, 'TABLE'], [2, 'LAYER'],
  [0, 'LAYER'], [2, '0'], [70, '0'], [62, '7'],
  [0, 'LAYER'], [2, 'FORMAT'], [70, '0'], [62, '7'],
  [0, 'LAYER'], [2, 'Cut'], [70, '0'], [62, '3'],
  [0, 'ENDTAB'],
  // Tables AFTER the layer table: this is what leaked into the open LAYER
  // record and minted the SW_CENTERMARKSYMBOL pseudo-layer.
  [0, 'TABLE'], [2, 'BLOCK_RECORD'],
  [0, 'BLOCK_RECORD'], [2, 'SW_CENTERMARKSYMBOL_6'],
  [0, 'ENDTAB'],
  [0, 'ENDSEC'],
]

describe('B14 minimal fixtures: empty table layers and trailing-table leak', () => {
  it('empty LAYER table entries and BLOCK_RECORD names never become layers', () => {
    const text = dxf([
      ...TABLES_WITH_JUNK,
      [0, 'SECTION'], [2, 'ENTITIES'],
      [0, 'CIRCLE'], [8, 'Cut'], [10, '5.0'], [20, '5.0'], [40, '2.5'],
      [0, 'ENDSEC'],
      [0, 'EOF'],
    ])
    const r = importDXF(text)
    expect(r.layers.map(l => l.name)).toEqual(['Cut'])
    expect(r.layers[0].color).toBe('#4cff88')  // ACI 3 from ITS OWN table record
    expect(r.loops).toHaveLength(1)
    expect(r.loops[0].layerId).toBe('Cut')
  })

  it('a layer whose only entities are unparsed annotation types imports no Layer2D', () => {
    // TEXT on FORMAT is exactly the SolidWorks title-block pattern: the layer
    // exists, its content does not convert, so it must own zero loops -> drop.
    const text = dxf([
      ...TABLES_WITH_JUNK,
      [0, 'SECTION'], [2, 'ENTITIES'],
      [0, 'TEXT'], [8, 'FORMAT'], [10, '0'], [20, '0'], [1, 'TITLE BLOCK'],
      [0, 'CIRCLE'], [8, 'Cut'], [10, '0'], [20, '0'], [40, '4'],
      [0, 'ENDSEC'],
      [0, 'EOF'],
    ])
    const r = importDXF(text)
    expect(r.layers.map(l => l.name)).toEqual(['Cut'])
    expect(r.loops).toHaveLength(1)
  })

  it('a DXF with no parseable geometry at all yields zero layers', () => {
    const text = dxf([
      ...TABLES_WITH_JUNK,
      [0, 'SECTION'], [2, 'ENTITIES'],
      [0, 'TEXT'], [8, 'FORMAT'], [10, '0'], [20, '0'], [1, 'NOTES'],
      [0, 'ENDSEC'],
      [0, 'EOF'],
    ])
    const r = importDXF(text)
    expect(r.loops).toHaveLength(0)
    expect(r.layers).toHaveLength(0)
  })
})
