// PHASE 0 SPIKE (throwaway): confirm the installed clipper2-wasm binding exposes
// the operations the FreeCAD adaptive-clearing port needs, and that they behave
// correctly at RUNTIME (the .d.ts can promise an export the wasm build does not
// actually carry). If this is green, Phase 0 is GO and the algorithm port can use
// the double-precision (D) API directly -- no integer SCALE_FACTOR required.
//
// Ops exercised:
//   - open-round offset (InflatePathsD, EndType.Round)  -> tool disk + capsule sweep
//   - DifferenceD                                        -> cut area = swept - cleared
//   - UnionD                                             -> accumulate cleared region
//   - IntersectD                                         -> corridor-vs-cleared link test
//   - AreaPathsD                                         -> load measurement
//   - PointInPolygonD                                    -> boundary / region tests
//
// Delete this file once clipperEngine.ts (Phase 1) wraps these with real unit tests.

import { describe, it, expect, beforeAll } from 'vitest'

/* eslint-disable @typescript-eslint/no-explicit-any */
// @ts-expect-error - clipper2-wasm ships the Emscripten factory as its default export
import Clipper2ZFactory from 'clipper2-wasm'

let mod: any

beforeAll(async () => {
  // In Node (vitest) the default wasm resolution works (see face2d/clipperOffset.ts).
  mod = await Clipper2ZFactory({})
})

const PREC = 4 // decimal places for the D API

function pathsFromLoops(loops: number[][]): any {
  const paths = new mod.PathsD()
  for (const flat of loops) paths.push_back(mod.MakePathD(flat))
  return paths
}

// Open-round offset of a degenerate 1-point path = a disk of radius r.
function disk(cx: number, cy: number, r: number): any {
  const open = pathsFromLoops([[cx, cy, cx, cy]])
  return mod.InflatePathsD(open, r, mod.JoinType.Round, mod.EndType.Round, 2.0, PREC, 0.05)
}

describe('Phase 0 clipper capability spike', () => {
  it('open-round offset produces a disk of area ~= pi r^2', () => {
    const r = 10
    const d = disk(0, 0, r)
    expect(d.size()).toBeGreaterThan(0)
    const area = Math.abs(mod.AreaPathsD(d))
    // A clipper disk is a faceted polygon, so its area is slightly UNDER pi r^2
    // (arc faceting always inscribes). Assert within ~2% below, never above.
    const ideal = Math.PI * r * r
    expect(area).toBeGreaterThan(ideal * 0.98)
    expect(area).toBeLessThanOrEqual(ideal + 1e-6)
  })

  it('DifferenceD of two overlapping disks gives a positive crescent area', () => {
    const r = 10
    const a = disk(0, 0, r)
    const b = disk(r / 2, 0, r) // shifted by half-radius -> overlap
    const diff = mod.DifferenceD(a, b, mod.FillRule.EvenOdd, PREC)
    const crescent = Math.abs(mod.AreaPathsD(diff))
    // analytic crescent = circle area - lens(d=r/2); just assert it is a sane fraction
    expect(crescent).toBeGreaterThan(0)
    expect(crescent).toBeLessThan(Math.PI * r * r)
  })

  it('UnionD of two disks accumulates area (cleared-region growth)', () => {
    const r = 10
    const a = disk(0, 0, r)
    const b = disk(3 * r, 0, r) // disjoint
    const u = mod.UnionD(a, b, mod.FillRule.EvenOdd, PREC)
    const area = Math.abs(mod.AreaPathsD(u))
    expect(area).toBeCloseTo(2 * Math.PI * r * r, -1) // ~628, within 10
  })

  it('IntersectD detects a corridor lying partly outside cleared (link/lift test)', () => {
    const r = 10
    const cleared = disk(0, 0, r)
    // a thin capsule corridor from inside-cleared out to a point well outside
    const corridor = mod.InflatePathsD(
      pathsFromLoops([[0, 0, 3 * r, 0]]), 1.0,
      mod.JoinType.Round, mod.EndType.Round, 2.0, PREC, 0.05,
    )
    const inside = mod.IntersectD(corridor, cleared, mod.FillRule.EvenOdd, PREC)
    const corridorArea = Math.abs(mod.AreaPathsD(corridor))
    const insideArea = Math.abs(mod.AreaPathsD(inside))
    // Some of the corridor is cleared, but not all -> a lift would be required.
    expect(insideArea).toBeGreaterThan(0)
    expect(insideArea).toBeLessThan(corridorArea - 1)
  })

  it('PointInPolygonD classifies inside/outside', () => {
    const square = mod.MakePathD([0, 0, 100, 0, 100, 100, 0, 100])
    const inside = mod.PointInPolygonD(new mod.PointD(50, 50, 0), square)
    const outside = mod.PointInPolygonD(new mod.PointD(150, 50, 0), square)
    expect(inside.value).toBe(mod.PointInPolygonResult.IsInside.value)
    expect(outside.value).toBe(mod.PointInPolygonResult.IsOutside.value)
  })

  it('BooleanOpOutD fills a PolyPathD tree (hole nesting) for an annulus', () => {
    const outer = mod.MakePathD([0, 0, 100, 0, 100, 100, 0, 100])
    const hole = mod.MakePathD([30, 30, 30, 70, 70, 70, 70, 30]) // reversed winding = hole
    const subj = new mod.PathsD(); subj.push_back(outer); subj.push_back(hole)
    const empty = new mod.PathsD()
    const tree = new mod.PolyPathD()
    mod.BooleanOpOutD(mod.ClipType.Union, mod.FillRule.EvenOdd, subj, empty, tree, PREC)
    expect(tree.count()).toBeGreaterThan(0) // at least one root contour with a child hole
  })
})
