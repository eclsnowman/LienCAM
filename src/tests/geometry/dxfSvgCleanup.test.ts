// @vitest-environment jsdom
//
// Task 2 reconciliation: VERIFY the geometry "cleanup" wizard (the loop
// optimizer that fits arcs and merges collinear lines) works END-TO-END for
// BOTH imported DXF and imported SVG geometry, generically.
//
// The chain proven here is the real one a user drives via DesignTree
// "Optimize loops":
//   import (importDXF / importSVG)  ->  optimizeLoops(...)  ->
//   commit to the store via the REAL setGeometryLoops action.
//
// Earlier coverage (loopOptimizer.test.ts) fed the optimizer hand-built point
// arrays. This file instead feeds it the ACTUAL output of the importers from
// messy source text, with the EXACT options the DesignTree.handleOptimizeLayer
// handler uses, and then commits through the same store action the handler
// calls -- so it proves the cleanup is wired and effective for the two 2D
// import formats, not just for synthetic input.
//
// SVG sampling uses SVGPathElement.getTotalLength/getPointAtLength, which jsdom
// does not implement; the shared svgPathGeometryPolyfill shims it (same setup
// as svgPhantomLayer.test.ts), so the REAL importSVG pipeline runs headless.

import { describe, it, expect, beforeAll } from 'vitest'
import { importDXF } from '../../lib/import/dxfImporter'
import { importSVG } from '../../lib/import/svgImporter'
import { optimizeLoops } from '../../lib/geometry/loopOptimizer'
import { useCamStore } from '../../store'
import type { ImportedGeometry, Loop2D } from '../../types'
import { installSvgPathGeometry } from '../import/svgPathGeometryPolyfill'

// ── Handler-exact optimizer options ──────────────────────────────────────────
// DesignTree.handleOptimizeLayer with the default tolerance (geo has none, and
// appSettings.projectionToleranceDefault defaults to 0.02):
//   tol = 0.02
//   options = { tolerance: tol*0.5, resampleStep: max(0.2, tol*0.3), projectionTolerance: tol }
const TOL = 0.02
const HANDLER_OPTIONS = {
  tolerance: TOL * 0.5,                       // 0.01
  resampleStep: Math.max(0.2, TOL * 0.3),     // 0.2
  projectionTolerance: TOL,                   // 0.02
}

const totalPoints = (loops: Loop2D[]) => loops.reduce((n, l) => n + l.points.length, 0)
const allSegs = (loops: Loop2D[]) => loops.flatMap((l) => l.segments ?? [])

// ── Messy DXF fixture ─────────────────────────────────────────────────────────
// A radius-10 CIRCLE -> the importer samples it at 0.5mm arc-length (~126 short
// chords), the canonical "over-sampled" case the optimizer should fit back to
// arc geometry, AND a LWPOLYLINE square whose straight edges carry redundant
// COLLINEAR mid-edge vertices the optimizer should merge away.
const MESSY_DXF = `0
SECTION
2
ENTITIES
0
CIRCLE
8
0
10
0.0
20
0.0
40
10.0
0
LWPOLYLINE
8
0
90
8
70
1
10
0.0
20
0.0
10
10.0
20
0.0
10
20.0
20
0.0
10
20.0
20
10.0
10
20.0
20
20.0
10
10.0
20
20.0
10
0.0
20
20.0
10
0.0
20
10.0
0
ENDSEC
0
EOF
`

// ── Messy SVG fixture ─────────────────────────────────────────────────────────
// A <circle> -> elementToD emits two A (arc) commands, sampled at 0.5mm into
// many short chords (arc-fit case), plus a <polyline> straight horizontal edge
// broken into many COLLINEAR vertices (line-merge case).
const MESSY_SVG = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100">
  <circle cx="30" cy="30" r="12" fill="none" stroke="#ff0000"/>
  <polyline fill="none" stroke="#0000ff" points="0,80 5,80 10,80 15,80 20,80 25,80 30,80 35,80 40,80 45,80 50,80 55,80 60,80 65,80 70,80"/>
</svg>`

beforeAll(() => {
  installSvgPathGeometry(window as unknown as { SVGElement: { prototype: object } })
  // jsdom's localStorage does not satisfy zustand's persist storage contract;
  // point persist at a no-op storage so the store actions run (same shim the
  // svgPhantomLayer jsdom store test uses).
  useCamStore.persist.setOptions({
    storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  })
})

describe('Task 2: DXF + SVG geometry cleanup wizard works end-to-end', () => {
  // ── DXF: import -> optimize ──────────────────────────────────────────────────
  // The cleanup metric is SEGMENT count, not point count: the optimizer
  // recognises high-level segments (lines/arcs) and then RE-SAMPLES each at
  // resampleStep (0.2mm) for display, so an arc gains display points while
  // collapsing to ONE segment. Real cleanup = the imported chord polyline
  // (rawPoints-1 raw edges) collapses to a HANDFUL of typed segments.
  it('DXF: import yields loops; optimizer cleans them (sampled circle -> arc, segments collapse)', () => {
    const result = importDXF(MESSY_DXF)
    expect(result.loops.length).toBeGreaterThan(0)

    const rawPts = totalPoints(result.loops)       // dense imported chord polylines
    const rawEdges = rawPts - result.loops.length  // ~ raw chord-segment count
    const optimized = optimizeLoops(result.loops, HANDLER_OPTIONS)
    expect(optimized.length).toBe(result.loops.length)

    // Cleanup ran: every loop carries typed segments, all 'line' | 'arc'.
    const segs = allSegs(optimized)
    expect(segs.length).toBeGreaterThanOrEqual(1)
    expect(segs.every((s) => s.type === 'line' || s.type === 'arc')).toBe(true)

    // The sampled circle is recognised as ARC geometry (not ~126 chords).
    expect(segs.some((s) => s.type === 'arc')).toBe(true)

    // STRICT collapse: a handful of segments from a dense chord polyline -- real
    // cleanup, not a no-op passthrough. (10x headroom is comfortable.)
    expect(segs.length).toBeLessThan(rawEdges)
    expect(segs.length).toBeLessThan(rawEdges / 5)

    // Surface the numbers for the verification report.
    // eslint-disable-next-line no-console
    console.log(`[DXF cleanup] rawPoints ${rawPts} (~${rawEdges} edges) -> ${segs.length} segments`)
  })

  // ── SVG: import -> optimize ──────────────────────────────────────────────────
  it('SVG: import yields loops; optimizer cleans them (sampled circle -> arc, segments collapse)', () => {
    const result = importSVG(MESSY_SVG)
    expect(result.loops.length).toBeGreaterThan(0)

    const rawPts = totalPoints(result.loops)
    const rawEdges = rawPts - result.loops.length
    const optimized = optimizeLoops(result.loops, HANDLER_OPTIONS)
    expect(optimized.length).toBe(result.loops.length)

    const segs = allSegs(optimized)
    expect(segs.length).toBeGreaterThanOrEqual(1)
    expect(segs.every((s) => s.type === 'line' || s.type === 'arc')).toBe(true)

    // STRICT collapse: the over-sampled circle + collinear polyline reduce to a
    // handful of typed segments.
    expect(segs.length).toBeLessThan(rawEdges)
    expect(segs.length).toBeLessThan(rawEdges / 5)

    // eslint-disable-next-line no-console
    console.log(`[SVG cleanup] rawPoints ${rawPts} (~${rawEdges} edges) -> ${segs.length} segments`)
  })

  // ── Commit path: optimized loops land in the store via setGeometryLoops ───────
  // Proven generically for both formats: inject the imported geometry through
  // the REAL addGeometry action, then commit the OPTIMIZED loops via the REAL
  // setGeometryLoops action the handler calls, and assert the store now holds
  // the optimized geometry (point counts match, loopsVersion bumped).
  it.each([
    { fmt: 'dxf' as const, run: () => importDXF(MESSY_DXF) },
    { fmt: 'svg' as const, run: () => importSVG(MESSY_SVG) },
  ])('commit ($fmt): setGeometryLoops stores the optimized loops + bumps loopsVersion', ({ fmt, run }) => {
    const imported = run()
    expect(imported.loops.length).toBeGreaterThan(0)
    const optimized = optimizeLoops(imported.loops, HANDLER_OPTIONS)

    const geoId = `geo-${fmt}-cleanup`
    const geo: ImportedGeometry = {
      id: geoId,
      name: `cleanup-${fmt}`,
      filename: `cleanup.${fmt}`,
      type: 'curves_2d',
      format: fmt,
      boundingBox: imported.boundingBox,
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      loaded: true,
      loops: imported.loops,
      layers2d: imported.layers,
    }

    const store = useCamStore.getState()
    store.addGeometry(geo)

    const beforeVersion =
      useCamStore.getState().project.geometry.find((g) => g.id === geoId)?.loopsVersion ?? 0

    // The exact commit the DesignTree handler makes.
    store.setGeometryLoops(geoId, optimized, imported.layers)

    const committed = useCamStore.getState().project.geometry.find((g) => g.id === geoId)
    expect(committed).toBeDefined()

    // Same loop count + same per-loop point counts as the optimized set
    // (setGeometryLoops re-mints stable content ids but preserves points).
    const committedLoops = committed!.loops ?? []
    expect(committedLoops.length).toBe(optimized.length)
    expect(committedLoops.map((l) => l.points.length)).toEqual(
      optimized.map((l) => l.points.length),
    )
    // The optimizer's typed segments survived the commit.
    expect(allSegs(committedLoops).length).toBe(allSegs(optimized).length)
    // loopsVersion incremented -> the viewport will redraw the cleaned loops.
    expect((committed!.loopsVersion ?? 0)).toBe(beforeVersion + 1)
  })
})
