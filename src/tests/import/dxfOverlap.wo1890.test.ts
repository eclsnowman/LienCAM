// @vitest-environment jsdom
//
// WO-1890: a doubled DXF line imports as one contour. Before this, chaining
// only removed duplicate POINTS, so a traced-over line either chained on as a
// second pass over the same edge (cut twice) or broke the contour open, and at
// a branching endpoint the chainer took whichever match it found last.
//
// Drives the REAL importer: importDXF for the geometry, and importGeometryFile
// (the production entry) for what reaches the part. Only the IndexedDB-backed
// cache modules are mocked, same harness as dxfImportReport.wo1840.test.ts.

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

const { importGeometryFile } = await import('../../lib/import/importGeometryFile')
const { importDXF } = await import('../../lib/import/dxfImporter')
const { joinSegments, mergeOverlaps } = await import('../../lib/geometry/path2d')
type JoinReport = import('../../lib/geometry/path2d').JoinReport

type Pairs = Array<[number | string, string]>
function dxf(pairs: Pairs): string {
  return [[0, 'SECTION'], [2, 'ENTITIES'], ...pairs, [0, 'ENDSEC'], [0, 'EOF']]
    .map(([c, v]) => `${c}\n${v}`).join('\n') + '\n'
}
function line(x0: number, y0: number, x1: number, y1: number): Pairs {
  return [[0, 'LINE'], [8, 'Cut'], [10, `${x0}`], [20, `${y0}`], [11, `${x1}`], [21, `${y1}`]]
}
function closedPoly(pts: Array<[number, number]>): Pairs {
  return [
    [0, 'LWPOLYLINE'], [8, 'Cut'], [90, `${pts.length}`], [70, '1'],
    ...pts.flatMap(([x, y]): Pairs => [[10, `${x}`], [20, `${y}`]]),
  ]
}

// 20 x 10 rectangle as four LINEs, the bottom edge drawn a second time.
const RECT_EDGE_TWICE = dxf([
  ...line(0, 0, 20, 0),
  ...line(20, 0, 20, 10),
  ...line(20, 10, 0, 10),
  ...line(0, 10, 0, 0),
  ...line(0, 0, 20, 0),
])

describe('WO-1890 acceptance 1: a rectangle with one edge drawn twice', () => {
  it('imports as one closed contour and the report says 1 overlap merged', () => {
    const r = importDXF(RECT_EDGE_TWICE)
    expect(r.loops).toHaveLength(1)
    expect(r.loops[0].closed).toBe(true)
    expect(r.loops[0].type).toBe('contour')
    // Centred 20 x 10 rectangle: four corners, no edge walked twice.
    expect(r.loops[0].points).toEqual([
      { x: -10, y: -5 }, { x: 10, y: -5 }, { x: 10, y: 5 }, { x: -10, y: 5 },
    ])
    expect(r.report.overlapsMerged).toBe(1)
  })

  it('through the production import entry, the part gets that one closed contour', async () => {
    const deps = { importBrepGeometry: vi.fn(), addGeometry: vi.fn() }
    await importGeometryFile(new File([RECT_EDGE_TWICE], 'doubled.dxf', { type: 'application/dxf' }), deps)
    const geo = deps.addGeometry.mock.calls[0][0]
    expect(geo.loops).toHaveLength(1)
    expect(geo.loops[0].closed).toBe(true)
    expect(geo.loops[0].points).toHaveLength(4)
  })

  it('the same edge drawn reversed merges too', () => {
    const r = importDXF(dxf([
      ...line(0, 0, 20, 0), ...line(20, 0, 20, 10), ...line(20, 10, 0, 10), ...line(0, 10, 0, 0),
      ...line(20, 0, 0, 0),
    ]))
    expect(r.loops).toHaveLength(1)
    expect(r.loops[0].closed).toBe(true)
    expect(r.report.overlapsMerged).toBe(1)
  })

  it('a LINE traced over one edge of a closed polyline is dropped, the polyline stays', () => {
    const r = importDXF(dxf([
      ...closedPoly([[0, 0], [20, 0], [20, 10], [0, 10]]),
      ...line(5, 10, 15, 10),
    ]))
    expect(r.loops).toHaveLength(1)
    expect(r.loops[0].closed).toBe(true)
    expect(r.loops[0].points).toHaveLength(4)
    expect(r.report.overlapsMerged).toBe(1)
  })

  it('a LINE that runs past a polyline edge keeps only the part nothing else draws', () => {
    // Top edge 0..20 at y=10; the LINE runs 10..30, so 20..30 survives as its own open chain.
    const r = importDXF(dxf([
      ...closedPoly([[0, 0], [20, 0], [20, 10], [0, 10]]),
      ...line(10, 10, 30, 10),
    ]))
    const closed = r.loops.filter(l => l.closed)
    const open = r.loops.filter(l => !l.closed)
    expect(closed).toHaveLength(1)
    expect(closed[0].points).toHaveLength(4)
    expect(open).toHaveLength(1)
    // Centred on the 30 x 10 bbox (x 0..30 -> -15..15): the tail runs from x=5 to x=15.
    expect(open[0].points.map(p => p.x).sort((a, b) => a - b)).toEqual([5, 15])
    expect(r.report.overlapsMerged).toBe(1)
  })

  it('a closed polyline drawn twice imports as one contour', () => {
    const rect: Array<[number, number]> = [[0, 0], [20, 0], [20, 10], [0, 10]]
    const r = importDXF(dxf([...closedPoly(rect), ...closedPoly(rect)]))
    expect(r.loops).toHaveLength(1)
    expect(r.report.overlapsMerged).toBe(1)
  })

  it('two closed polylines that share an edge stay two outlines (authored shapes are never cut)', () => {
    const r = importDXF(dxf([
      ...closedPoly([[0, 0], [10, 0], [10, 10], [0, 10]]),
      ...closedPoly([[10, 0], [20, 0], [20, 10], [10, 10]]),
    ]))
    expect(r.loops.filter(l => l.closed)).toHaveLength(2)
    expect(r.report.overlapsMerged).toBe(0)
  })
})

describe('WO-1890 acceptance 2: collinear segments that overlap', () => {
  it('two segments overlapping by 5 mm become one segment spanning both', () => {
    const r = importDXF(dxf([...line(0, 0, 20, 0), ...line(15, 0, 35, 0)]))
    expect(r.loops).toHaveLength(1)
    // 0..35 centred -> -17.5..17.5: one segment, two points.
    expect(r.loops[0].points).toEqual([{ x: -17.5, y: 0 }, { x: 17.5, y: 0 }])
    expect(r.report.overlapsMerged).toBe(1)
  })

  it('segments that only touch end to end are not an overlap', () => {
    const r = importDXF(dxf([...line(0, 0, 20, 0), ...line(20, 0, 35, 0)]))
    expect(r.loops).toHaveLength(1)
    expect(r.loops[0].points).toHaveLength(3)
    expect(r.report.overlapsMerged).toBe(0)
  })

  it('parallel segments further apart than the join tolerance are not merged', () => {
    const r = importDXF(dxf([...line(0, 0, 20, 0), ...line(5, 0.2, 25, 0.2)]))
    expect(r.loops).toHaveLength(2)
    expect(r.report.overlapsMerged).toBe(0)
  })

  it('a circle traced round twice as short chords is never collapsed into a straight line', () => {
    // A projected helix: two turns of 0.12 mm chords on r=1.9, the second turn
    // sampled half a step off the first. Pairwise the chords sit within the join
    // tolerance of each other's lines; a transitive merge used to walk round the
    // circle and emit a diameter.
    const segs: Array<Array<{ x: number; y: number }>> = []
    const r = 1.9, n = 100
    for (const phase of [0, 0.5]) {
      for (let i = 0; i < n; i++) {
        const a0 = 2 * Math.PI * (i + phase) / n, a1 = 2 * Math.PI * (i + 1 + phase) / n
        segs.push([{ x: r * Math.cos(a0), y: r * Math.sin(a0) }, { x: r * Math.cos(a1), y: r * Math.sin(a1) }])
      }
    }
    const loops = joinSegments(segs, 'L')
    for (const loop of loops) {
      for (const p of loop.points) expect(Math.abs(Math.hypot(p.x, p.y) - r)).toBeLessThan(0.05)
      for (let k = 1; k < loop.points.length; k++) {
        const a = loop.points[k - 1], b = loop.points[k]
        const mid = Math.hypot((a.x + b.x) / 2, (a.y + b.y) / 2)
        expect(Math.abs(mid - r)).toBeLessThan(0.05)
      }
    }
  })
})

describe('WO-1890: a merged group stays on one line', () => {
  it('a gentle arc traced twice in long chords merges locally but never straightens the arc', () => {
    // R = 1000 mm, 5 mm chords (0.005 rad apart - "parallel" pairwise), second
    // pass half a chord off. Every neighbour pair is collinear within tolerance,
    // so only the group-wide check stops the merge running the whole arc flat.
    const R = 1000, step = 5 / R, n = 60
    const at = (a: number) => ({ x: R * Math.sin(a), y: R - R * Math.cos(a) })
    const segs: Array<Array<{ x: number; y: number }>> = []
    for (const phase of [0, 0.5]) {
      for (let i = 0; i < n; i++) segs.push([at((i + phase) * step), at((i + 1 + phase) * step)])
    }
    expect(mergeOverlaps(segs).merged).toBeGreaterThan(0)
    const onArc = (p: { x: number; y: number }) => Math.abs(Math.hypot(p.x, p.y - R) - R)
    for (const loop of joinSegments(segs, 'L')) {
      for (let k = 1; k < loop.points.length; k++) {
        const a = loop.points[k - 1], b = loop.points[k]
        expect(onArc({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })).toBeLessThan(0.06)
      }
    }
  })
})

describe('WO-1890 branch rule: straightest, then shortest, closing first', () => {
  it('at a T the chain continues straight instead of taking the last-filed branch', () => {
    const report: JoinReport = { gapsClosed: 0, largestGapMM: 0, openChains: 0 }
    const loops = joinSegments([
      [{ x: 0, y: 0 }, { x: 10, y: 0 }],
      [{ x: 10, y: 0 }, { x: 20, y: 0 }],
      [{ x: 10, y: 0 }, { x: 10, y: 10 }], // filed last: "last match" took this
    ], 'L', report)
    expect(loops[0].points).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }])
    expect(loops[1].points).toEqual([{ x: 10, y: 0 }, { x: 10, y: 10 }])
    expect(report.branchPoints).toBe(1)
  })

  it('equally straight branches: the shorter one is taken', () => {
    const loops = joinSegments([
      [{ x: 0, y: 0 }, { x: 10, y: 0 }],
      [{ x: 10, y: 0 }, { x: 13, y: 3 }],   // +45 deg, short
      [{ x: 10, y: 0 }, { x: 20, y: -10 }], // -45 deg, long, filed last
    ], 'L')
    expect(loops[0].points).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 13, y: 3 }])
  })

  it('a chain that comes back to its start closes instead of running on down a branch there', () => {
    const loops = joinSegments([
      [{ x: 0, y: 0 }, { x: 10, y: 0 }],
      [{ x: 10, y: 0 }, { x: 10, y: 10 }],
      [{ x: 10, y: 10 }, { x: 0, y: 10 }],
      [{ x: 0, y: 10 }, { x: 0, y: 0 }],
      [{ x: 0, y: 0 }, { x: -5, y: 0 }], // a lead-in touching the start corner
    ], 'L')
    expect(loops.filter(l => l.closed)).toHaveLength(1)
    expect(loops.find(l => l.closed)!.points).toHaveLength(4)
    expect(loops.filter(l => !l.closed)).toHaveLength(1)
  })
})

// Captured from main (commit 05fea2a61, before this change) with the same
// digest: sha256 of JSON.stringify(importDXF(text) minus its `report`, numbers rounded to 1e-9), first
// 16 hex. A file with no overlaps and no branches must import byte-identical.
const CLEAN_FILES_FROM_MAIN: Array<[string, string]> = [
  ['Sample Parts/BMG.dxf', '1dacc317db38f3ad'],
  ['Sample Parts/BootL.dxf', '1b9427584f51f523'],
  ['Sample Parts/Contour-Test-A-InsideCorner-Notch.dxf', '4a0f71ad66fb1aae'],
  ['Sample Parts/Contour-Test-B-OutsideCorner-TwinTabs.dxf', '1d4950c711bea8d3'],
  ['Sample Parts/Contour-Test-C-Waist-Splits.dxf', 'ef8482e2da819c95'],
  ['Sample Parts/Leadscrew_Stepper_Mount.DXF', '4060bfd082721648'],
  ['src/tests/evidence/WO-1841/bracket-with-spline.dxf', 'bc2068e22225e616'],
  ['src/tests/evidence/WO-1860/fixture.dxf', '3e93b8df0d964204'],
]

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../..')

describe('WO-1890 acceptance 3: a clean DXF imports identical to main', () => {
  for (const [file, digest] of CLEAN_FILES_FROM_MAIN) {
    it(file, () => {
      const text = readFileSync(join(REPO, file), 'utf8')
      const { report, ...rest } = importDXF(text)
      // Numbers rounded to 1e-9 before hashing: curve tessellation differs in the
      // last bits between x86 (dev box) and arm64 (the Spark gate) - not a geometry
      // change. Any real change still moves the digest. (architect 2026-09-23)
      expect(dxfGeometryFingerprint(rest)).toBe(digest)
      expect(report.overlapsMerged).toBe(0)
      expect(report.branchPoints).toBe(0)
    })
  }
})
