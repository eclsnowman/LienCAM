// @vitest-environment jsdom
//
// WO-1900: DXF import gains a "keep drawing origin" option. With it on the
// loops keep the file's own coordinates (the drawing's 0,0 is LienCAM's 0,0);
// with it off (the default) import re-centres exactly as before, so the default
// path stays byte-identical to main. Drives the REAL importer (importDXF) and
// the REAL console report formatter (formatDxfImportReport).
//
// Harness convention copied from dxfImportReport.wo1840.test.ts: jsdom for the
// store import, an in-memory localStorage shim, IndexedDB-backed caches mocked.

import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { typedMock } from '../support/typedMock'
import { dxfGeometryFingerprint } from './dxfGeometryFingerprint.wo3154'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

vi.mock('../../lib/geometry2dCache', () => typedMock<typeof import('../../lib/geometry2dCache')>({
  cache2DGeometry: vi.fn(async () => {}),
}))
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}),
}))

const { importDXF } = await import('../../lib/import/dxfImporter')
const { formatDxfImportReport } = await import('../../lib/import/importGeometryFile')

type Pairs = Array<[number | string, string]>
function dxf(pairs: Pairs): string {
  return [[0, 'SECTION'], [2, 'ENTITIES'], ...pairs, [0, 'ENDSEC'], [0, 'EOF']]
    .map(([c, v]) => `${c}\n${v}`).join('\n') + '\n'
}
function line(x0: number, y0: number, x1: number, y1: number): Pairs {
  return [[0, 'LINE'], [8, 'Cut'], [10, `${x0}`], [20, `${y0}`], [11, `${x1}`], [21, `${y1}`]]
}

// A 20 x 10 rectangle whose part sits at X100 Y50 - the WO's acceptance 1
// fixture. Drawn in file coordinates; its own datum is the drawing origin.
const RECT_AT_100_50 = dxf([
  ...line(100, 50, 120, 50),
  ...line(120, 50, 120, 60),
  ...line(120, 60, 100, 60),
  ...line(100, 60, 100, 50),
])

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../..')

// Default-path digest helper, identical to WO-1890's (minus the report):
// sha256 of JSON.stringify(importDXF(text) minus its `report`, numbers rounded
// to 1e-9), first 16 hex.
function digestOfDefault(text: string): string {
  const { report: _report, ...rest } = importDXF(text)
  return dxfGeometryFingerprint(rest)
}

describe('WO-1900 acceptance 1: a part at X100 Y50', () => {
  it('keepOrigin on imports at exactly the file coordinates', () => {
    const r = importDXF(RECT_AT_100_50, { keepOrigin: true })
    expect(r.report.origin).toBe('drawing')
    expect(r.loops).toHaveLength(1)
    expect(r.loops[0].closed).toBe(true)
    expect(r.loops[0].points).toEqual([
      { x: 100, y: 50 }, { x: 120, y: 50 }, { x: 120, y: 60 }, { x: 100, y: 60 },
    ])
    expect(r.boundingBox.min).toMatchObject({ x: 100, y: 50, z: 0 })
    expect(r.boundingBox.max).toMatchObject({ x: 120, y: 60, z: 0 })
    expect(r.boundingBox.center).toMatchObject({ x: 110, y: 55 })
  })

  it('keepOrigin off (and the default) centres it on its own bbox as today', () => {
    for (const r of [importDXF(RECT_AT_100_50), importDXF(RECT_AT_100_50, { keepOrigin: false })]) {
      expect(r.report.origin).toBe('centred')
      expect(r.loops[0].points).toEqual([
        { x: -10, y: -5 }, { x: 10, y: -5 }, { x: 10, y: 5 }, { x: -10, y: 5 },
      ])
      expect(r.boundingBox.min).toMatchObject({ x: -10, y: -5 })
    }
  })
})

describe('WO-1900 acceptance 2: the default path is byte-identical to main', () => {
  it('passing no options equals explicitly passing keepOrigin false', () => {
    expect(importDXF(RECT_AT_100_50)).toEqual(importDXF(RECT_AT_100_50, { keepOrigin: false }))
  })

  // Captured from main by WO-1890 for these clean files (no overlaps/branches,
  // so WO-1890 left their output unchanged); the default path here must still
  // reproduce them.
  const CLEAN_FILES_FROM_MAIN: Array<[string, string]> = [
    ['Sample Parts/BMG.dxf', '1dacc317db38f3ad'],
    ['src/tests/evidence/WO-1841/bracket-with-spline.dxf', 'bc2068e22225e616'],
  ]
  for (const [file, digest] of CLEAN_FILES_FROM_MAIN) {
    it(file, () => {
      expect(digestOfDefault(readFileSync(join(REPO, file), 'utf8'))).toBe(digest)
    })
  }
})

describe('WO-1900: the WO-1840 console report says which origin was used', () => {
  it('a drawing-origin import says so', () => {
    expect(formatDxfImportReport(importDXF(RECT_AT_100_50, { keepOrigin: true }).report))
      .toContain('drawing origin kept')
  })

  it('the default import is unchanged: no origin note', () => {
    expect(formatDxfImportReport(importDXF(RECT_AT_100_50).report))
      .not.toContain('drawing origin kept')
    expect(formatDxfImportReport(importDXF(RECT_AT_100_50).report))
      .toBe('no gaps closed, nothing skipped')
  })
})
