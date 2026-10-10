/* CW-part winding regression gate for the nesting engine.
 *
 * ROOT CAUSE this gate guards (diagnosed with evidence): the orbiting
 * noFitPolygon (nfp.ts, ported from SVGnest) only closes its orbit when its input
 * rings use the SVGnest "counterclockwise" winding (negative SVGnest polygonArea,
 * which equals geometric CCW = project signedArea >= 0). The DXF importer yields
 * CLOCKWISE outer rings for some real parts (BootL.dxf, Leadscrew_Stepper_Mount.DXF
 * import to geometric-CW outers; BMG.dxf imports CCW). The engine never normalized
 * winding, so noFitPolygon(cwPart, cwPart) returned ZERO loops. An empty obstacle
 * NFP then hit a silent `continue` in placeParts (placement.ts): the obstacle
 * dropped out of the forbidden `combined` region, the feasible region became the
 * full inner-fit, and every copy picked the SAME lower-left point and STACKED
 * (complete overlap). This also let the min-area solver accept an impossibly small
 * sheet (fastPlace reported all-placed on stacked parts -> >100% utilization).
 *
 * The fix: ensureCCW every NFP/placement PROXY ring at prep time (packNest in
 * index.ts, buildInstances in solver.ts, the window + candidate rings in
 * placeInWindows) BEFORE noFitPolygon sees it, plus an ADR-0003 fail-loud in
 * placeParts so a still-empty NFP marks the part UNPLACED instead of stacking.
 *
 * These gates FAIL on the pre-fix engine (overlapping/stacked CW parts;
 * >100% solver utilization) and PASS after the fix. Importer reuse: importDXF()
 * (pure string parser, runs in the node vitest env), same as perf.test.ts.
 *
 * Run: npx vitest run src/tests/cam/nesting/winding-cw.test.ts
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import type { Vec2 } from '../../../types/index'
import { importDXF } from '../../../lib/import/dxfImporter'
import { packNest, solveNest, transformRing } from '../../../lib/cam/nesting'
import type { NestPart, NestRequest, Placement } from '../../../lib/cam/nesting'
import { intersect, pointInPolygon } from '../../../lib/cam/nesting/geometry'
import { signedArea } from '../../../lib/cam/geometry'
import { ensureEngineClipperReady } from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'

const __dirname = dirname(fileURLToPath(import.meta.url))
// winding-cw.test.ts lives at src/tests/cam/nesting/ -> four levels up to root.
const REPO = resolve(__dirname, '../../../..')
const SAMPLES = resolve(REPO, 'Sample Parts')
const SEED = 1337

/** Load a DXF as a NestPart: outer = largest-area closed loop, holes = the rest
 *  (same convention as perf.test.ts / the visual harness). */
function loadPart(file: string, id: string): NestPart {
  const txt = readFileSync(resolve(SAMPLES, file), 'utf8')
  const res = importDXF(txt)
  const closed = res.loops.filter((l) => l.closed && l.points.length >= 3)
  if (closed.length === 0) throw new Error(`${file}: no closed loops`)
  const sorted = [...closed].sort((a, b) => b.area - a.area)
  return { id, outer: sorted[0].points, holes: sorted.slice(1).map((l) => l.points) }
}

/** Full-resolution placed ring for a placement (original outer, transformed). */
function placedRing(p: Placement, parts: NestPart[]): Vec2[] {
  const src = parts.find((q) => q.id === p.partId)!
  return transformRing(src.outer, p.rotationDeg, p.x, p.y)
}

/**
 * Do two placed rings overlap on positive area? Reusable helper: edge crossing OR
 * a vertex of one strictly interior to the other (same construction as
 * packer.test.ts / inside-window.test.ts). Run against FULL-resolution geometry.
 */
function overlap(a: Vec2[], b: Vec2[]): boolean {
  const ac = [...a, a[0]]
  const bc = [...b, b[0]]
  if (intersect(ac, bc)) return true
  for (const v of a) if (pointInPolygon(v, b) === true) return true
  for (const v of b) if (pointInPolygon(v, a) === true) return true
  return false
}

/** True if any two placements in the set overlap on full-resolution geometry. */
function anyOverlap(placements: Placement[], parts: NestPart[]): boolean {
  const rings = placements.map((p) => placedRing(p, parts))
  for (let i = 0; i < rings.length; i++) {
    for (let j = i + 1; j < rings.length; j++) {
      if (overlap(rings[i], rings[j])) return true
    }
  }
  return false
}

/** Count distinct placement poses (x,y,rot) -> proves they are not all stacked. */
function distinctPoses(placements: Placement[]): number {
  const keys = new Set(
    placements.map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.rotationDeg}`)
  )
  return keys.size
}

function baseReq(parts: { part: NestPart; quantity: number }[], over: Partial<NestRequest> = {}): NestRequest {
  return {
    parts,
    sheet: { width: 300, height: 300 },
    style: 'ninety',
    spacing: { partGap: 3, sheetMargin: 5, windowGap: 2 },
    solver: { kind: 'fixSheet' },
    seed: SEED,
    ...over,
  }
}

describe('nesting winding: CW-imported real parts do not stack', () => {
  beforeAll(async () => {
    await ensureEngineClipperReady()
  })

  it('confirms BootL.dxf imports CLOCKWISE (project signedArea < 0)', () => {
    const bootL = loadPart('BootL.dxf', 'bootl')
    // The bug only manifests for CW imports; this anchors that BootL really is the
    // CW part the gate exists for (geometric CW = project signedArea < 0).
    expect(signedArea(bootL.outer)).toBeLessThan(0)
  })

  it('packs BootL x4 on a fixed sheet with NO overlap and DISTINCT poses', async () => {
    const bootL = loadPart('BootL.dxf', 'bootl')
    const req = baseReq([{ part: bootL, quantity: 4 }], { sheet: { width: 300, height: 300 } })
    const res = await packNest(req)

    // all four must place (the sheet is large; pre-fix they "placed" by stacking).
    expect(res.placements.length).toBe(4)
    // THE stacking bug: pre-fix all copies share one lower-left pose. Post-fix the
    // NFP-difference forces distinct, non-overlapping poses.
    expect(distinctPoses(res.placements)).toBe(4)
    expect(anyOverlap(res.placements, [bootL])).toBe(false)
  }, 30000) // ~3s isolated but no prior explicit timeout (default 5000ms) left
  // almost no headroom under full-suite parallel contention (same flake class
  // the sibling tests below already guard with a generous bound) - INT-H1-R1.

  it('packs a mix of real parts (BMG + BootL + Leadscrew x4 each) with zero overlaps', async () => {
    const bmg = loadPart('BMG.dxf', 'bmg')
    const bootL = loadPart('BootL.dxf', 'bootl')
    const lead = loadPart('Leadscrew_Stepper_Mount.DXF', 'lead')
    const parts = [bmg, bootL, lead]
    const req = baseReq(
      [
        { part: bmg, quantity: 4 },
        { part: bootL, quantity: 4 },
        { part: lead, quantity: 4 },
      ],
      { sheet: { width: 400, height: 400 } }
    )
    const res = await packNest(req)

    // mixed CW + CCW parts must coexist without overlapping on full geometry.
    expect(res.placements.length).toBeGreaterThan(1)
    expect(anyOverlap(res.placements, parts)).toBe(false)
  }, 60000) // BMG's dense NFP makes the mixed pack slow; generous bound, runs once

  it('solver (fixQty, none-locked) on BootL x6 yields utilization <= 100% and no overlap', async () => {
    const bootL = loadPart('BootL.dxf', 'bootl')
    const req = baseReq([{ part: bootL, quantity: 6 }], {
      solver: { kind: 'fixQty', lockedAxis: 'none' },
    })
    const res = await solveNest(req)

    // pre-fix: stacked parts let the min-area solver shrink the sheet until the
    // SAME point holds all six -> placed source area >> sheet area -> util > 1.
    expect(res.utilization).toBeLessThanOrEqual(1)
    // and the layout the solver returns must be genuinely non-overlapping.
    expect(anyOverlap(res.placements, [bootL])).toBe(false)
  }, 60000) // the min-area width scan runs several packs; generous bound, runs once

  it('is deterministic on a CW part (two packs deep-equal)', async () => {
    const bootL = loadPart('BootL.dxf', 'bootl')
    const req = baseReq([{ part: bootL, quantity: 4 }], { sheet: { width: 300, height: 300 } })
    const a = await packNest(req)
    const b = await packNest(req)
    expect(a).toEqual(b)
  }, 30000) // two packs back-to-back; generous bound, runs once
})
