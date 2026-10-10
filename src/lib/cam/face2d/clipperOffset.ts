// Robust inward polygon offsetting via clipper2-wasm.
//
// The face ring fills (offset/spiral) need an offsetter that, unlike the naive
// miter `offsetPolygon` in geometry/index.ts, (a) produces SMOOTH offsets (round
// joins, no corner kinks) and (b) returns MULTIPLE disjoint loops when a concave
// region pinches in two under inward offset. That split is what lets the
// contour-parallel / spiral fills handle concave and branched contours (the
// recursive offset-tree) instead of tangling. clipper2's InflatePaths is the
// standard robust offsetter for this.
//
// clipper2-wasm is an Emscripten module loaded asynchronously ONCE. The toolpath
// worker awaits `ensureClipperReady()` before computing a face op, after which
// `offsetInward()` is synchronous — so `buildFaceToolpath` stays synchronous (the
// operation contract). Tests await `ensureClipperReady()` before exercising the
// ring patterns.

// @ts-expect-error - clipper2-wasm's default export is the Emscripten factory; it
// ships no precise typing for the factory call, so treat the module as `any`.
import Clipper2ZFactory from 'clipper2-wasm'
// Vite emits the .wasm as an asset and gives its served URL. Emscripten's default
// `new URL("clipper2z.wasm", import.meta.url)` uses a bare filename that Vite does
// not always emit from inside a bundled Web Worker, so we point `locateFile` at
// this resolved URL in the browser. In Node (vitest) the default path works, so we
// leave it alone there.
import wasmUrl from 'clipper2-wasm/dist/es/clipper2z.wasm?url'

type Pt = { x: number; y: number }

// True under Node (vitest) — there the Emscripten default wasm resolution works.
const isNode = typeof process !== 'undefined' && !!process.versions?.node

/* eslint-disable @typescript-eslint/no-explicit-any */
let mod: any = null
let initPromise: Promise<void> | null = null

/** Initialise clipper2-wasm once. Safe to call repeatedly (returns the same
 *  promise / resolves immediately once ready). */
export function ensureClipperReady(): Promise<void> {
  if (mod) return Promise.resolve()
  if (!initPromise) {
    const opts = isNode ? {} : { locateFile: (p: string) => (p.endsWith('.wasm') ? wasmUrl : p) }
    initPromise = Clipper2ZFactory(opts).then((m: any) => { mod = m })
  }
  return initPromise as Promise<void>
}

/** True once the module is loaded and `offsetInward` may be called. */
export function clipperReady(): boolean {
  return mod !== null
}

// CAM-14: shared fidelity bound for the round-join offset approximation, in mm
// of max SAGITTA (chord-to-arc deviation) — both arcTolerance and the
// sagitta-bounded decimate() below are pinned to this one named constant
// (ADR-0003: no silent tolerance). 0.005mm is a full order of magnitude tighter than the old
// 0.1mm arcTolerance CAM-14 Phase A convicted, comfortably within typical CNC
// router positioning accuracy; src/tests/cam/contourNoViolation.test.ts's
// standing gate asserts clearance >= -0.005mm (the design ceiling itself; R1
// tightened it from the earlier -0.006mm slush bound).
const CORNER_FIDELITY_MM = 0.005

// CAM-14-R1: the pipeline has TWO independent lossy stages between the raw
// clipper offset and the emitted chord — clipper's own round-join tessellation
// (bounded by arcTolerance) and decimate's post-simplification (bounded by its
// own epsilon, below). Each stage's error can point the SAME direction at the
// same point (decimate merges raw points that already sit up to arcTolerance
// off the true profile), so their worst cases ADD, not cancel. Splitting the
// CORNER_FIDELITY_MM budget evenly between the two stages is what makes the
// COMBINED emitted-chord-vs-true-profile deviation bounded by the ceiling
// itself, not by one stage's bound alone (measured: giving each stage the
// full 0.005mm let the combined worst case reach -0.00575mm — see
// coordination/evidence/CAM-14/r1/RADIUS-SWEEP.md's pre-split column).
const HALF_FIDELITY_MM = CORNER_FIDELITY_MM / 2

// clipper2's arcTolerance directly bounds the round-join tessellation's own
// sagitta (it picks the segment count per corner so the chord never deviates
// from the true circular arc by more than this). CAM-14 measured the OLD
// 0.1mm value producing a -0.1000mm corner clearance violation on a 3mm tool
// radius (arcTolerance IS the sagitta ceiling — the measured violation landed
// exactly on it, coordination/evidence/CAM-14/PHASE-A-MEASUREMENTS.md A2/A3).
// Tightened to HALF the shared fidelity bound (see HALF_FIDELITY_MM above) so
// clipper's own tessellation never exceeds it, independent of tool radius
// (arcTolerance is not radius-scaled).
const ARC_TOLERANCE_MM = HALF_FIDELITY_MM

// CAM-14-R1: the R0 fix decimated by absolute chord LENGTH (drop a point once
// the next retained one is >= L away), derived from L <= sqrt(8*epsilon*r) for
// an ASSUMED minimum round-join radius r=0.25mm. That derivation's arithmetic
// was itself correct (sqrt(8*0.005*0.25) = 0.1mm exactly — an earlier report
// mis-stated it as ~0.0775mm), but the min-spacing MECHANISM is unsound at any
// radius smaller than the assumed floor: a fixed spacing has no notion of the
// LOCAL curvature it is merging across, so a chord can legally span several
// raw clipper points on a tight round join and reintroduce sagitta above
// CORNER_FIDELITY_MM (the auditor constructed this with a 0.5mm tool: -0.0198mm,
// 4x past the ceiling). A min-spacing decimator can never be made to bound
// sagitta in general — it decimates on DISTANCE, not on the deviation it causes.
//
// decimate() below therefore drops points by MEASURED deviation instead: it is
// Douglas-Peucker with epsilon = HALF_FIDELITY_MM (the decimate stage's half
// of the shared budget — see HALF_FIDELITY_MM above). This makes the fidelity
// invariant true BY CONSTRUCTION for every retained chord — the max
// perpendicular distance from any point it replaces to the chord itself never
// exceeds epsilon, independent of local radius, tool size, or how densely
// clipper pre-tessellated. (A2 and A3 bottoming out at the IDENTICAL -0.1000mm
// point under the OLD 0.1mm arcTolerance was never evidence that decimate SET
// that floor — it is evidence decimate did not further WORSEN a violation
// arcTolerance's own pre-decimate tessellation had already introduced; the
// sagitta-bounded decimate here still cannot introduce a NEW one.)
const DECIMATE_EPSILON_MM = HALF_FIDELITY_MM

// Shared clipper2 InflatePathsD call: delta<0 = inward, delta>0 = outward.
// JoinType.Round (smooth), EndType.Polygon (closed). miterLimit unused for
// round joins; precision 6 decimals; arcTolerance keeps round joins smooth
// without spraying vertices. Returns the RAW (pre-decimate) loops — callers
// apply their own decimation/filtering.
function inflate(loop: Pt[], delta: number): Pt[][] {
  if (Math.abs(delta) < 1e-9) return [loop.slice()]

  const flat: number[] = []
  for (const p of loop) flat.push(p.x, p.y)

  const paths = new mod.PathsD()
  const inPath = mod.MakePathD(flat)
  paths.push_back(inPath)

  const out = mod.InflatePathsD(paths, delta, mod.JoinType.Round, mod.EndType.Polygon, 2.0, 6, ARC_TOLERANCE_MM)

  const result: Pt[][] = []
  for (let i = 0; i < out.size(); i++) {
    const p = out.get(i)
    const arr: Pt[] = []
    for (let j = 0; j < p.size(); j++) { const pt = p.get(j); arr.push({ x: pt.x, y: pt.y }) }
    result.push(arr)
  }

  // Free the wasm-side temporaries (the worker is short-lived, but stay tidy).
  out.delete?.(); inPath.delete?.(); paths.delete?.()
  return result
}

/**
 * Offset a closed loop by `delta` mm — NEGATIVE shrinks inward, POSITIVE grows
 * outward. Returns zero or more disjoint loops: a concave region can split into
 * several under an inward offset (the offset tree), and clipper properly TRIMS
 * the self-overlap a naive miter offset leaves at concave corners (outward) or
 * convex corners (inward). Loops below `minArea` are dropped. Round joins keep the
 * offsets smooth. Throws if clipper is not yet initialised — call
 * `ensureClipperReady()` first.
 */
export function offsetLoop(loop: Pt[], delta: number, minArea = 0): Pt[][] {
  if (!mod) throw new Error('Face: clipper2 is not initialised (call ensureClipperReady() before offsetLoop).')
  // CAM-14-R1: restore the pre-CAM-14, byte-identical zero-delta contract — an
  // unmodified copy, no decimate, no area filter — rather than routing delta=0
  // through inflate()'s own (unrelated) near-zero guard and then still decimating.
  if (Math.abs(delta) < 1e-9) return [loop.slice()]

  const result: Pt[][] = []
  for (const arr of inflate(loop, delta)) {
    // Decimate to the sagitta ceiling. Each successive inward offset would otherwise
    // ACCUMULATE round-join vertices (offset of an already-rounded ring), so inner
    // rings grow to thousands of points and resampling them blows up.
    const dec = decimate(arr, DECIMATE_EPSILON_MM)
    if (dec.length >= 3 && Math.abs(polyArea(dec)) >= minArea) result.push(dec)
  }
  return result
}

/**
 * Instrumentation-only seam (CAM-14 Phase A): same call as `offsetLoop` but
 * returns the PRE-DECIMATE clipper output — measures how much of the finish
 * offset's deviation from the ideal parallel curve is introduced by the
 * sagitta-bounded decimate() simplification step vs. clipper's own round-join
 * approximation. No production caller uses this; `offsetLoop`'s nonzero-delta
 * behavior is unchanged (byte-identical — see `inflate` factoring above; the
 * zero-delta contract is `offsetLoop`-only, restored in CAM-14-R1).
 */
export function offsetLoopRaw(loop: Pt[], delta: number, minArea = 0): Pt[][] {
  if (!mod) throw new Error('Face: clipper2 is not initialised (call ensureClipperReady() before offsetLoopRaw).')

  const result: Pt[][] = []
  for (const arr of inflate(loop, delta)) {
    if (arr.length >= 3 && Math.abs(polyArea(arr)) >= minArea) result.push(arr)
  }
  return result
}

// Douglas-Peucker simplification with epsilon = the sagitta ceiling: recursively
// keep the point of max perpendicular deviation from its enclosing chord whenever
// that deviation exceeds `epsilonMm`, so every point this DROPS is, by
// construction, within `epsilonMm` of the chord that replaces it — the fidelity
// invariant holds for every retained chord regardless of local curvature (see the
// DECIMATE_EPSILON_MM comment above for why a min-spacing decimator cannot make
// the same guarantee). Endpoints loop[0] and loop[length-1] are always kept,
// matching the prior decimator's treatment of the array as an open path (the
// closing edge back to loop[0] is left to the caller, same as before).
function decimate(loop: Pt[], epsilonMm: number): Pt[] {
  if (loop.length < 4) return loop
  const keep = new Uint8Array(loop.length)
  keep[0] = 1
  keep[loop.length - 1] = 1
  simplifyRange(loop, 0, loop.length - 1, epsilonMm, keep)
  const out: Pt[] = []
  for (let i = 0; i < loop.length; i++) if (keep[i]) out.push(loop[i])
  return out.length >= 3 ? out : loop
}

// Core DP recursion over pts[startIdx..endIdx] (inclusive): finds the point with
// the largest perpendicular distance from the chord pts[startIdx]->pts[endIdx];
// if that distance exceeds epsilon, marks it kept and recurses on both halves.
function simplifyRange(pts: Pt[], startIdx: number, endIdx: number, epsilon: number, keep: Uint8Array): void {
  if (endIdx <= startIdx + 1) return
  const a = pts[startIdx], b = pts[endIdx]
  const dx = b.x - a.x, dy = b.y - a.y
  const lenSq = dx * dx + dy * dy
  let maxDist = -1
  let maxIdx = -1
  for (let i = startIdx + 1; i < endIdx; i++) {
    const p = pts[i]
    // Degenerate (coincident) chord endpoints: fall back to point-to-point
    // distance from `a` rather than dividing by a near-zero length.
    const dist = lenSq < 1e-12
      ? Math.hypot(p.x - a.x, p.y - a.y)
      : Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / Math.sqrt(lenSq)
    if (dist > maxDist) { maxDist = dist; maxIdx = i }
  }
  if (maxDist > epsilon) {
    keep[maxIdx] = 1
    simplifyRange(pts, startIdx, maxIdx, epsilon, keep)
    simplifyRange(pts, maxIdx, endIdx, epsilon, keep)
  }
}

function polyArea(pts: Pt[]): number {
  let s = 0
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length]
    s += a.x * b.y - b.x * a.y
  }
  return s / 2
}
