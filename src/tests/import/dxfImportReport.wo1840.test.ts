// @vitest-environment jsdom
//
// WO-1840: after a DXF import the console says what joinSegments closed and
// what the parser dropped silently before - never silence, and no change to
// the joined geometry (rule 11: we still DO the join, we only say so).
//
// Drives the REAL DXF importer through importGeometryFile (the production
// entry), same harness convention as importGeometryFileConsole.test.ts: only
// the IndexedDB-backed cache modules are mocked.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'

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

const { useCamStore } = await import('../../store')

vi.mock('../../lib/geometry2dCache', () => typedMock<typeof import('../../lib/geometry2dCache')>({
  cache2DGeometry: vi.fn(async () => {}),
}))
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}),
}))

const { importGeometryFile, formatDxfImportReport } = await import('../../lib/import/importGeometryFile')
const { importDXF } = await import('../../lib/import/dxfImporter')
const { joinSegments } = await import('../../lib/geometry/path2d')

function dxf(pairs: Array<[number | string, string]>): string {
  return pairs.map(([c, v]) => `${c}\n${v}`).join('\n') + '\n'
}
function dxfFile(name: string, text: string): File {
  return new File([text], name, { type: 'application/dxf' })
}
function makeDeps() {
  return { importBrepGeometry: vi.fn(), addGeometry: vi.fn() }
}

// A triangle whose closing corner is 0.03 mm short (closes: 0.03 < JOIN_TOL
// 0.05) plus a two-segment "C" chain whose free ends are 0.2 mm apart
// (stays open: 0.2 > JOIN_TOL). One gap closed, largest 0.03 mm; one chain
// left open - exactly the WO's acceptance numbers.
const FIXTURE_GAPS = dxf([
  [0, 'SECTION'], [2, 'ENTITIES'],
  [0, 'LINE'], [8, 'Cut'], [10, '0'],  [20, '0'],  [11, '10'],   [21, '0'],
  [0, 'LINE'], [8, 'Cut'], [10, '10'], [20, '0'],  [11, '5'],    [21, '8'],
  [0, 'LINE'], [8, 'Cut'], [10, '5'],  [20, '8'],  [11, '0.03'], [21, '0'],
  [0, 'LINE'], [8, 'Cut'], [10, '30'], [20, '10'], [11, '30'],   [21, '0'],
  [0, 'LINE'], [8, 'Cut'], [10, '30'], [20, '0'],  [11, '30.2'], [21, '10'],
  [0, 'ENDSEC'],
  [0, 'EOF'],
])

// Exact integer corners, no gap at all (last end == first start exactly).
const RECT: Array<[number | string, string]> = [
  [0, 'LINE'], [8, 'Cut'], [10, '0'],  [20, '0'],  [11, '20'], [21, '0'],
  [0, 'LINE'], [8, 'Cut'], [10, '20'], [20, '0'],  [11, '20'], [21, '10'],
  [0, 'LINE'], [8, 'Cut'], [10, '20'], [20, '10'], [11, '0'],  [21, '10'],
  [0, 'LINE'], [8, 'Cut'], [10, '0'],  [20, '10'], [11, '0'],  [21, '0'],
]

const FIXTURE_CLEAN = dxf([
  [0, 'SECTION'], [2, 'ENTITIES'],
  ...RECT,
  [0, 'ENDSEC'],
  [0, 'EOF'],
])

const FIXTURE_SKIPPED = dxf([
  [0, 'SECTION'], [2, 'ENTITIES'],
  ...RECT,
  [0, 'SPLINE'], [8, 'Cut'],
  [0, 'SPLINE'], [8, 'Cut'],
  [0, 'SPLINE'], [8, 'Cut'],
  [0, 'TEXT'], [8, 'Cut'], [1, 'a'],
  [0, 'TEXT'], [8, 'Cut'], [1, 'b'],
  [0, 'TEXT'], [8, 'Cut'], [1, 'c'],
  [0, 'TEXT'], [8, 'Cut'], [1, 'd'],
  [0, 'TEXT'], [8, 'Cut'], [1, 'e'],
  [0, 'TEXT'], [8, 'Cut'], [1, 'f'],
  [0, 'TEXT'], [8, 'Cut'], [1, 'g'],
  [0, 'TEXT'], [8, 'Cut'], [1, 'h'],
  [0, 'TEXT'], [8, 'Cut'], [1, 'i'],
  [0, 'TEXT'], [8, 'Cut'], [1, 'j'],
  [0, 'TEXT'], [8, 'Cut'], [1, 'k'],
  [0, 'TEXT'], [8, 'Cut'], [1, 'l'],
  [0, 'ENDSEC'],
  [0, 'EOF'],
])

beforeEach(() => {
  useCamStore.setState({ consoleEvents: [], consoleReadThroughId: 0 })
})

describe('WO-1840 acceptance: import console event names gaps closed/open and skips', () => {
  it('one 0.03mm gap closed, one 0.2mm gap left open: names both, in one console event', async () => {
    const deps = makeDeps()
    await importGeometryFile(dxfFile('gaps.dxf', FIXTURE_GAPS), deps)

    const events = useCamStore.getState().consoleEvents
    expect(events).toHaveLength(1)
    expect(events[0].severity).toBe('success')
    expect(events[0].source).toBe('import')
    expect(events[0].message).toContain('1 gap closed (largest 0.03mm)')
    expect(events[0].message).toContain('1 chain left open')

    // Geometry itself is unchanged by the report: one closed triangle, one open chain.
    const geo = deps.addGeometry.mock.calls[0][0]
    expect(geo.loops).toHaveLength(2)
    expect(geo.loops.filter((l: { closed: boolean }) => l.closed)).toHaveLength(1)
    expect(geo.loops.filter((l: { closed: boolean }) => !l.closed)).toHaveLength(1)
  })

  it('SPLINE and TEXT entities: names each skipped type with its count', async () => {
    const deps = makeDeps()
    await importGeometryFile(dxfFile('skips.dxf', FIXTURE_SKIPPED), deps)

    const events = useCamStore.getState().consoleEvents
    expect(events).toHaveLength(1)
    expect(events[0].message).toContain('SPLINE x3, TEXT x12 not imported')
  })

  it('a clean closed drawing says so, never silence', async () => {
    const deps = makeDeps()
    await importGeometryFile(dxfFile('clean.dxf', FIXTURE_CLEAN), deps)

    const events = useCamStore.getState().consoleEvents
    expect(events).toHaveLength(1)
    expect(events[0].message).toContain('no gaps closed, nothing skipped')
  })
})

describe('WO-1840: the report is additive only - joined geometry does not change', () => {
  it('joinSegments returns identical loops whether or not a report accumulator is passed', () => {
    const gapSegs = [
      [{ x: 0, y: 0 }, { x: 10, y: 0 }],
      [{ x: 10, y: 0 }, { x: 5, y: 8 }],
      [{ x: 5, y: 8 }, { x: 0.03, y: 0 }],
      [{ x: 30, y: 10 }, { x: 30, y: 0 }],
      [{ x: 30, y: 0 }, { x: 30.2, y: 10 }],
    ]
    const withoutReport = joinSegments(gapSegs, 'L')
    const withReport = joinSegments(gapSegs, 'L', { gapsClosed: 0, largestGapMM: 0, openChains: 0 })
    expect(withReport).toEqual(withoutReport)
  })

  it('a captured-before-change fixture (integer corners, no floating drift) imports the same points and id on re-derive', () => {
    const first = importDXF(FIXTURE_CLEAN)
    expect(first.loops).toHaveLength(1)
    const loop = first.loops[0]
    expect(loop.closed).toBe(true)
    expect(loop.type).toBe('contour')
    // centerLoops shifts the 20x10 rectangle so its bbox center sits at (0,0).
    expect(loop.points).toEqual([
      { x: -10, y: -5 }, { x: 10, y: -5 }, { x: 10, y: 5 }, { x: -10, y: 5 },
    ])

    // Stable-id re-derive (loopId.ts, untouched by this WO): a second import
    // of the same bytes yields the identical id - the join algorithm that
    // produces `points` and feeds the id hash was not touched by this change,
    // only bookkeeping calls were added around it.
    const second = importDXF(FIXTURE_CLEAN)
    expect(second.loops[0].id).toBe(loop.id)
  })
})

describe('WO-1840 negative control: the gap-count assertion depends on the report plumbing', () => {
  it('a suppressed (unwired) report fails the same assertion the acceptance test relies on', () => {
    const suppressed = { gapsClosed: 0, largestGapMM: 0, openChains: 0, skipped: [] }
    expect(formatDxfImportReport(suppressed)).not.toContain('1 gap closed')
    expect(formatDxfImportReport(suppressed)).toBe('no gaps closed, nothing skipped')

    // Wired: the same shape, actually populated from the gap fixture, passes.
    const real = importDXF(FIXTURE_GAPS).report
    expect(formatDxfImportReport(real)).toContain('1 gap closed (largest 0.03mm)')
  })
})
