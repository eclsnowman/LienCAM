// SPDX-License-Identifier: LGPL-2.1-or-later
// Ported from FreeCAD's Adaptive2d (src/Mod/CAM/libarea/Adaptive.cpp and Path Adaptive Python), Copyright (c) 2018 Kresimir Tusek.
// This file remains under LGPL-2.1-or-later; the LienCAM project as a whole is distributed under GPL-3.0-or-later (see /LICENSE).
// Tool geometry and the optimal-load model for the adaptive-clearing engine.
//
// This is the heart of "constant cutting load": the tool is a disk POLYGON, and the
// engagement at any step is the AREA of new material the tool sweeps, per unit of
// travel. The target the steering holds is `optimalCutAreaPerDist`. FreeCAD source:
// ProcessFeature.py (referenceCutArea / fullSlotAreaPerDist / optimalCutAreaPerDist,
// genToolGeometry, getToolCuttingShape, calcCutingArea).
//
// Divergence: works in mm directly (no SCALE_FACTOR) on the double-precision clipper
// API; the FreeCAD +-1 scaled fudge factors (to avoid coincident-edge artifacts) are
// dropped -- in mm they are sub-resolution and clipper2's precision handles them.

// WO-3018: every sampling, steering, sharpening and cap number comes from the policy record.
import { ADAPTIVE_POLICY as AP } from '../../../../kernel/ops/adaptive/policy'
import {
  type Pt, type Loops,
  diskPath, capsulePath, difference, intersection, totalArea,
} from './clipperEngine'

/** WO-1226. The cutting-SIDE split of one step's cut: how much of the material this step
 *  removes lies to the LEFT of the direction of travel, and how much to the RIGHT.
 *
 *  Why this exists. `cutArea` reports HOW MUCH stock the swept tool removes; it never said
 *  WHERE ON THE TOOL that removal happens. The steering search picks a heading by probing
 *  candidate angles and comparing `areaPerDist` against a target band, so two candidates
 *  that remove the SAME area -- one engaging the left of the cutter, one the right -- were
 *  indistinguishable to it. Four attempts to break that tie with a rule sitting on top of
 *  the blind measurement (WO-1198 smoothing, WO-1214 turn hold, WO-1221 hold-yield, and a
 *  bracket-only search) each traded one defect for another. This is the missing quantity.
 *
 *  The split. `from -> to` defines the travel direction u; the LEFT normal is n = perp(u)
 *  = (-u.y, u.x). Every point of the cut region is classified by the sign of (p - from).n:
 *  positive is left of travel, negative is right. The cut polygon is cut by that axis line
 *  and each half measured with the SAME convention `area` uses (absolute shoelace sum, per
 *  loop -- a cut bite, not a region), so `leftArea + rightArea` equals `area` to floating
 *  point. Both are in mm^2, like `area`; divide by the step length for a per-distance load.
 *
 *  Reading it. A full slot is symmetric about the travel axis: left == right, balance 0.
 *  A cut riding a wall on its left engages only the left of the cutter: balance +1. The
 *  mirror image is -1. Nothing here decides anything -- it is the measurement a steering
 *  rule may consult (WO-1226 ships the measurement only; no steering rule reads it yet). */
export interface CutSideSplit {
  /** Cut area lying LEFT of the travel direction (mm^2). */
  readonly leftArea: number
  /** Cut area lying RIGHT of the travel direction (mm^2). */
  readonly rightArea: number
  /** (leftArea - rightArea) / (leftArea + rightArea), in [-1, +1]; 0 when nothing is cut.
   *  +1 = the cut is entirely on the left of the tool, -1 = entirely on the right,
   *  0 = balanced about the travel axis (a full-width slot). */
  readonly sideBalance: number
}

/** What `cutArea` reports for one step. `area` / `areaPerDist` are the original contract and
 *  are unchanged by WO-1226; the `CutSideSplit` fields are that order's pure addition. */
export interface CutAreaResult extends CutSideSplit {
  /** Area of material actually removed by this step (mm^2). */
  readonly area: number
  /** That area per unit of travel -- the load the steering holds against its target. */
  readonly areaPerDist: number
}

export interface ToolGeometry {
  readonly radius: number
  /** Cut area for a full-width (100% stepover) cut, per unit distance. */
  readonly fullSlotAreaPerDist: number
  /** Target load: cut-area-per-distance the steering holds (stepOver x fullSlot). */
  readonly optimalCutAreaPerDist: number
  /** The disk polygon at a given centre. */
  disk(c: Pt): Loops
  /** Newly-swept crescent moving from -> to (cached by displacement), translated to `from`. */
  cutShape(from: Pt, to: Pt): Loops
  /** Area (and area-per-distance) of material actually cut moving from -> to given `cleared`,
   *  plus WO-1226's left/right-of-travel split of that same area (see CutSideSplit). */
  cutArea(from: Pt, to: Pt, cleared: Loops): CutAreaResult
  /** Area of the tool disk at `c` that still bites uncut material (disk minus cleared).
   *  Box-clips `cleared` via the same `clearedNear` cache cutArea uses: disk reach (r) is
   *  smaller than the crescent reach the box was sized for, so far geometry cannot bite the
   *  disk -> the SET result is identical to clipping against the whole monolith, only faster. */
  diskBite(c: Pt, cleared: Loops): number
  /** WO-439 fix 2. The same bite, but counted ONLY inside `region` -- the tool-CENTRE
   *  reachable region (processFeature's cutRegion). `diskBite` counts the whole disk, so a
   *  disk parked on the region wall counts the finishing rim beyond it: material no spiral
   *  pass can ever start on (it belongs to the finishing contour). That rim held the engage
   *  walk hostage -- it always read as an in-band bite, so the walk never honestly
   *  exhausted (step-1 census: moveForwardToCutThreshold returned false ZERO times on three
   *  fixtures). Clipping to `region` asks the honest question instead: is there uncut
   *  material HERE that a pass could actually work on? Separate entry point on purpose --
   *  `diskBite` and `cutArea` keep their exact behaviour for every other caller. */
  diskBiteIn(c: Pt, cleared: Loops, region: Loops): number
  cacheStats(): { hits: number; misses: number; boundClips: number }
}

const dist2 = (a: Pt, b: Pt) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2

/** A step that removed nothing: zero area, and therefore no side to report. */
const NO_CUT = (): CutAreaResult => ({ area: 0, areaPerDist: 0, leftArea: 0, rightArea: 0, sideBalance: 0 })

/** WO-1226. |shoelace area| of `loop` clipped to the half-plane { p : (p - o) . n >= 0 }.
 *
 *  Sutherland-Hodgman against a single half-plane, with the shoelace accumulated as the
 *  clipped ring is emitted rather than materialised -- one pass, and no allocation at all
 *  (the emit step is written out three times instead of being a closure precisely because
 *  this runs on every steering probe). A concave loop can leave the half-plane and re-enter
 *  it; SH then joins those pieces with a zero-width bridge running along the clip line, and
 *  a zero-width bridge contributes exactly zero shoelace area, so the sum is right for any
 *  simple loop, convex or not.
 *
 *  The absolute value per loop is deliberate: it mirrors `totalArea`, the FreeCAD
 *  calcCutingArea convention this file measures cuts with (sum of |Area(poly)|, a bite and
 *  not a signed region). Because both sides use it, leftArea + rightArea == area. */
function halfPlaneAbsArea(loop: readonly Pt[], ox: number, oy: number, nx: number, ny: number): number {
  const n = loop.length
  if (n < 3) return 0
  let acc = 0
  let firstX = 0, firstY = 0, prevX = 0, prevY = 0, started = false
  let px = loop[n - 1].x, py = loop[n - 1].y
  let ps = (px - ox) * nx + (py - oy) * ny
  for (let i = 0; i < n; i++) {
    const p = loop[i]
    const cx = p.x, cy = p.y
    const cs = (cx - ox) * nx + (cy - oy) * ny
    if (cs >= 0) {
      if (ps < 0) { // entering: the crossing point joins the ring first
        const t = ps / (ps - cs), ex = px + (cx - px) * t, ey = py + (cy - py) * t
        if (started) acc += prevX * ey - ex * prevY; else { firstX = ex; firstY = ey; started = true }
        prevX = ex; prevY = ey
      }
      if (started) acc += prevX * cy - cx * prevY; else { firstX = cx; firstY = cy; started = true }
      prevX = cx; prevY = cy
    } else if (ps >= 0) { // leaving: the crossing point ends this piece, the vertex is dropped
      const t = ps / (ps - cs), ex = px + (cx - px) * t, ey = py + (cy - py) * t
      if (started) acc += prevX * ey - ex * prevY; else { firstX = ex; firstY = ey; started = true }
      prevX = ex; prevY = ey
    }
    px = cx; py = cy; ps = cs
  }
  if (!started) return 0
  acc += prevX * firstY - firstX * prevY // close the ring
  return Math.abs(acc) / 2
}

/**
 * Build a ToolGeometry for a given tool radius and step-over fraction (0..1).
 * `arcTol` controls disk faceting (mm); finer = more accurate area, denser polygons.
 *
 * The displacement cache mirrors FreeCAD's getToolCuttingShape cache: the swept
 * crescent depends only on the displacement vector (to - from), which repeats
 * constantly along a pass, so we compute it once at the origin and translate.
 */
export function createToolGeometry(radius: number, stepOver: number, arcTol = 0.02): ToolGeometry {
  const origin: Pt = { x: 0, y: 0 }

  // referenceCutArea: disk minus disk shifted by radius/2 = crescent swept over r/2 at
  // full width. fullSlotAreaPerDist = that area / (r/2).  (ProcessFeature.py:311-322)
  const halfR = radius / 2
  const diskAtOrigin = diskPath(origin, radius, arcTol)
  const diskShifted = diskPath({ x: 0, y: halfR }, radius, arcTol)
  // Absolute sum is fine: the crescent is a single hole-free loop (FreeCAD takes
  // Area(crossing[0]) directly, ProcessFeature.py:317).
  const referenceCutArea = totalArea(difference(diskAtOrigin, diskShifted))
  const fullSlotAreaPerDist = referenceCutArea / halfR
  const optimalCutAreaPerDist = stepOver * fullSlotAreaPerDist

  // Cache the origin-anchored swept crescent, keyed by quantised displacement.
  const shapeCache = new Map<string, Loops>()
  let hits = 0, misses = 0
  const QUANT = AP.sampling.cutAreaCacheQuantMm // mm grid for the cache key

  function cutShapeAtOrigin(dx: number, dy: number): Loops {
    const key = `${Math.round(dx / QUANT)}|${Math.round(dy / QUANT)}`
    const cached = shapeCache.get(key)
    if (cached) { hits++; return cached }
    misses++
    // capsule(origin -> displacement) minus the disk at origin = the NEW crescent.
    const capsule = capsulePath(origin, { x: dx, y: dy }, radius, arcTol)
    const crescent = difference(capsule, diskAtOrigin)
    shapeCache.set(key, crescent)
    return crescent
  }

  function cutShape(from: Pt, to: Pt): Loops {
    const dx = to.x - from.x, dy = to.y - from.y
    if (dx * dx + dy * dy < QUANT * QUANT) return []
    const atOrigin = cutShapeAtOrigin(dx, dy)
    return atOrigin.map(loop => loop.map(p => ({ x: p.x + from.x, y: p.y + from.y })))
  }

  // cleared-bounded cache (FreeCAD's cleared_bounded). The engagement test below clips a
  // small swept crescent against `cleared`, but `cleared` accumulates the WHOLE machined
  // region (thousands of edges), so each clip cost grows with the job while the crescent
  // can only touch material within ~1.75 x radius of the tool. We clip `cleared` once to a
  // box around the tool and reuse that small local polygon for every query inside the box
  // -- the angle search (~12 calls per step at a fixed `from`) and the next several steps.
  // Far geometry cannot intersect the crescent, so the result is identical; only faster.
  const BOUND_HALF = radius * AP.sampling.cutAreaBoundHalfRadii   // box half-extent: larger => fewer (O(cleared)) re-clips
  const BOUND_MARGIN = radius * AP.sampling.cutAreaBoundMarginRadii // > max crescent reach from `from` (|step| + radius); keeps every reused crescent fully inside the box
  let boundRef: Loops | null = null
  let boundCx = 0, boundCy = 0
  let boundLocal: Loops = []
  let boundClips = 0

  function clearedNear(cleared: Loops, c: Pt): Loops {
    if (cleared.length === 0) return []
    if (boundRef === cleared &&
        Math.abs(c.x - boundCx) <= BOUND_HALF - BOUND_MARGIN &&
        Math.abs(c.y - boundCy) <= BOUND_HALF - BOUND_MARGIN) {
      return boundLocal
    }
    const h = BOUND_HALF
    const rect: Loops = [[
      { x: c.x - h, y: c.y - h }, { x: c.x + h, y: c.y - h },
      { x: c.x + h, y: c.y + h }, { x: c.x - h, y: c.y + h },
    ]]
    boundLocal = intersection(cleared, rect)
    boundRef = cleared; boundCx = c.x; boundCy = c.y; boundClips++
    return boundLocal
  }

  // WO-439 fix 2: the SAME box-clip cache, for the cut region diskBiteIn clips against.
  // The region is a per-feature constant with thousands of edges; clipping the whole
  // monolith on every walker probe would cost O(region) per step. Its own cache, because
  // `cleared` grows while the region never changes -- sharing one slot would thrash.
  let regionRef: Loops | null = null
  let regionCx = 0, regionCy = 0
  let regionLocal: Loops = []

  function regionNear(region: Loops, c: Pt): Loops {
    if (region.length === 0) return []
    if (regionRef === region &&
        Math.abs(c.x - regionCx) <= BOUND_HALF - BOUND_MARGIN &&
        Math.abs(c.y - regionCy) <= BOUND_HALF - BOUND_MARGIN) {
      return regionLocal
    }
    const h = BOUND_HALF
    const rect: Loops = [[
      { x: c.x - h, y: c.y - h }, { x: c.x + h, y: c.y - h },
      { x: c.x + h, y: c.y + h }, { x: c.x - h, y: c.y + h },
    ]]
    regionLocal = intersection(region, rect)
    regionRef = region; regionCx = c.x; regionCy = c.y; boundClips++
    return regionLocal
  }

  function cutArea(from: Pt, to: Pt, cleared: Loops): CutAreaResult {
    const d = Math.sqrt(dist2(from, to))
    if (d === 0) return NO_CUT()
    const shape = cutShape(from, to)
    if (shape.length === 0) return NO_CUT()
    // Clip against only the cleared material near the tool (identical result, see above).
    const cut = difference(shape, clearedNear(cleared, from))
    // totalArea (absolute sum) is the faithful port of FreeCAD calcCutingArea
    // (ProcessFeature.py:141 sums math.fabs(Area(poly))): a cut bite, not a region.
    const area = totalArea(cut)
    // WO-1226: split that SAME `cut` by the travel axis. Pure JS over loops clipper has
    // already handed back, so there is no second traversal of `cleared` and no extra wasm
    // call: `area` and `areaPerDist` above are computed exactly as before, and the added
    // cost is one O(vertices of `cut`) pass -- well under the marshalling `difference`
    // already paid to produce those same vertices. (Planning cost measured on the WO-1221
    // corpus census, reported in the order.)
    let leftArea = 0, rightArea = 0
    if (area > 0) {
      const nx = -(to.y - from.y) / d, ny = (to.x - from.x) / d // LEFT normal of travel
      for (const loop of cut) {
        leftArea += halfPlaneAbsArea(loop, from.x, from.y, nx, ny)
        rightArea += halfPlaneAbsArea(loop, from.x, from.y, -nx, -ny)
      }
    }
    const sum = leftArea + rightArea
    return {
      area, areaPerDist: area / d,
      leftArea, rightArea,
      sideBalance: sum > 0 ? (leftArea - rightArea) / sum : 0,
    }
  }

  function diskBite(c: Pt, cleared: Loops): number {
    // disk(c) minus cleared, but cleared box-clipped to the local rect (identical result,
    // see clearedNear). Same box cache cutArea uses; disk reach r < crescent reach.
    const bite = difference(diskPath(c, radius, arcTol), clearedNear(cleared, c))
    return totalArea(bite)
  }

  function diskBiteIn(c: Pt, cleared: Loops, region: Loops): number {
    // disk ∩ region first (cheap: both small once the region is box-clipped), then minus
    // the locally clipped cleared -- same set as clipping against the monoliths, faster.
    const reach = intersection(diskPath(c, radius, arcTol), regionNear(region, c))
    if (reach.length === 0) return 0
    return totalArea(difference(reach, clearedNear(cleared, c)))
  }

  return {
    radius,
    fullSlotAreaPerDist,
    optimalCutAreaPerDist,
    disk: (c: Pt) => diskPath(c, radius, arcTol),
    cutShape,
    cutArea,
    diskBite,
    diskBiteIn,
    cacheStats: () => ({ hits, misses, boundClips }),
  }
}
