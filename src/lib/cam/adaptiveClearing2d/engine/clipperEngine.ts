// SPDX-License-Identifier: LGPL-2.1-or-later
// Ported from FreeCAD's Adaptive2d (src/Mod/CAM/libarea/Adaptive.cpp and Path Adaptive Python), Copyright (c) 2018 Kresimir Tusek.
// This file remains under LGPL-2.1-or-later; the LienCAM project as a whole is distributed under GPL-3.0-or-later (see /LICENSE).
// Clipper wrapper for the adaptive-clearing engine (FreeCAD Adaptive2d port).
//
// The Tusek algorithm is built almost entirely out of polygon clipping: the tool
// is a disk POLYGON, a step's cut is a swept capsule DIFFERENCE the cleared region,
// the cleared region is an accumulated UNION, and the keep-down/lift link test is a
// corridor INTERSECT cleared. This module gives the rest of the engine a small,
// plain-JS-typed surface over clipper2-wasm so no wasm handles leak past it.
//
// Divergence from FreeCAD: the reference uses pyclipper (integer-only Clipper1) and
// scales mm -> int by SCALE_FACTOR. clipper2-wasm ships the double-precision (D) API
// (verified in the Phase 0 spike), so this engine works directly in mm with a fixed
// decimal precision. No SCALE_FACTOR.
//
// NOTE: this owns its OWN clipper2-wasm init, independent of face2d/clipperOffset.ts,
// to keep the engine self-contained. That means a second wasm module instance in a
// worker that also runs face ops. TODO(consolidate): hoist a single shared clipper
// module under geometry/ once the engine lands and face2d can migrate onto it.

/* eslint-disable @typescript-eslint/no-explicit-any */
// @ts-expect-error - clipper2-wasm's default export is the untyped Emscripten factory.
import Clipper2ZFactory from 'clipper2-wasm'
import wasmUrl from 'clipper2-wasm/dist/es/clipper2z.wasm?url'

export type Pt = { x: number; y: number }
export type Loop = Pt[]
export type Loops = Pt[][]

/** A node of an offset/boolean PolyTree: a contour plus its directly nested holes,
 *  whose own children are the next outer contours, recursively (clipper nesting). */
export interface PolyNode {
  contour: Loop
  isHole: boolean
  children: PolyNode[]
}

const PREC = 4 // decimal places for the D API (0.1 micron) -- plenty for mm CAM
const isNode = typeof process !== 'undefined' && !!(process as any).versions?.node

let mod: any = null
let initPromise: Promise<void> | null = null

/** Initialise clipper2-wasm once for the engine. Safe to call repeatedly. */
export function ensureEngineClipperReady(): Promise<void> {
  if (mod) return Promise.resolve()
  if (!initPromise) {
    const opts = isNode ? {} : { locateFile: (p: string) => (p.endsWith('.wasm') ? wasmUrl : p) }
    initPromise = Clipper2ZFactory(opts).then((m: any) => { mod = m })
  }
  return initPromise as Promise<void>
}

/** True once the wasm module is loaded and the ops below may be called. */
export function engineClipperReady(): boolean {
  return mod !== null
}

function requireMod(): any {
  if (!mod) throw new Error('adaptive engine: clipper2 not initialised (call ensureEngineClipperReady() first)')
  return mod
}

/** Current wasm linear-memory size in bytes (debug/leak probes). Emscripten memory
 *  only ever grows, so a plateau here means handle cleanup is working. */
export function engineWasmHeapBytes(): number {
  return requireMod().HEAPU8.buffer.byteLength
}

// --- marshalling (plain JS <-> wasm), always freeing wasm temporaries ----------
//
// embind disposal rules for this build (dist/clipper2z.d.ts + verified empirically,
// distinct $$.ptr per call = a fresh wasm-heap allocation):
//   - every class instance has a real .delete(); call it directly. NEVER `delete?.()`
//     -- optional chaining silently no-ops if a build renames disposal, and a silent
//     no-op here is exactly the leak this module exists to prevent.
//   - PathsD.get(i), PathD.get(j) and PolyPathD.polygon() return a NEW wasm-heap COPY
//     on EVERY call; each must be deleted or it leaks permanently (emscripten memory
//     never shrinks). Un-deleted get() copies were the heap-exhaustion leak that
//     aborted long jobs (and capped test suites at ~12 engine runs per process).
//   - PolyPathD.child(i) returns a REFERENCE into the tree (same $$.ptr each call);
//     deleting it would destroy the tree's own node. Do NOT delete child handles.
//   - PathD.view() returns a Float64Array over wasm memory, stride 3 (x, y, z): no
//     handle to free and no per-vertex PointD copies. The view is invalidated by
//     memory growth, so copy out immediately and drop it.

/** Run `fn`, deleting every wasm handle registered via `own` on the way out
 *  (success or throw). Deletion is deterministic and in reverse creation order. */
function withWasm<T>(fn: (own: (h: any) => any) => T): T {
  const owned: any[] = []
  const own = (h: any) => { owned.push(h); return h }
  try {
    return fn(own)
  } finally {
    for (let i = owned.length - 1; i >= 0; i--) owned[i].delete()
  }
}

function toPathsD(loops: Loops): any {
  const m = requireMod()
  const paths = new m.PathsD()
  try {
    for (const loop of loops) {
      if (loop.length === 0) continue
      const flat: number[] = []
      for (const p of loop) flat.push(p.x, p.y)
      const pd = m.MakePathD(flat)
      try { paths.push_back(pd) } finally { pd.delete() }
    }
  } catch (e) {
    paths.delete()
    throw e
  }
  return paths
}

/** Copy one PathD out to plain JS via its typed-array view (zero per-vertex handles).
 *  Does NOT delete `p` -- the caller owns it. */
function pathDToLoop(p: any): Loop {
  const n = p.size()
  const v = p.view() // Float64Array over wasm memory, stride 3: x, y, z
  if (v.length !== n * 3) throw new Error(`adaptive engine: unexpected PathD.view() layout (${v.length} doubles for ${n} points)`)
  const loop: Loop = new Array(n)
  for (let j = 0, k = 0; j < n; j++, k += 3) loop[j] = { x: v[k], y: v[k + 1] }
  return loop
}

function fromPathsD(paths: any): Loops {
  const out: Loops = []
  const n = paths.size()
  for (let i = 0; i < n; i++) {
    const p = paths.get(i) // heap COPY -- must be deleted (see disposal rules above)
    try { out.push(pathDToLoop(p)) } finally { p.delete() }
  }
  return out
}

const EVEN_ODD = () => requireMod().FillRule.EvenOdd

// --- tool geometry -------------------------------------------------------------

/** Disk polygon of radius r centred at c: open-round offset of a degenerate point.
 *  arcTol controls faceting (smaller = rounder/denser). FreeCAD: genToolGeometry. */
export function diskPath(c: Pt, r: number, arcTol = 0.02): Loops {
  const m = requireMod()
  return withWasm(own => {
    const open = own(toPathsD([[c, c]])) // two coincident points = a "point" open path
    const res = own(m.InflatePathsD(open, r, m.JoinType.Round, m.EndType.Round, 2.0, PREC, arcTol))
    return fromPathsD(res)
  })
}

/** Capsule (stadium) polygon: open-round offset of segment a->b by r. The shape a
 *  round tool sweeps moving from a to b. FreeCAD: getToolCuttingShape's cover area. */
export function capsulePath(a: Pt, b: Pt, r: number, arcTol = 0.02): Loops {
  const m = requireMod()
  return withWasm(own => {
    const open = own(toPathsD([[a, b]]))
    const res = own(m.InflatePathsD(open, r, m.JoinType.Round, m.EndType.Round, 2.0, PREC, arcTol))
    return fromPathsD(res)
  })
}

/** Open-round offset of a whole polyline by r in ONE clipper call: the corridor a
 *  round tool of radius r sweeps along `path`. Equivalent to unioning a capsule per
 *  segment, but without the O(N) pairwise unions. Returns [] for a degenerate path. */
export function offsetOpenRound(path: Pt[], r: number, arcTol = 0.02): Loops {
  if (path.length < 2) return []
  const m = requireMod()
  return withWasm(own => {
    const open = own(toPathsD([path]))
    const res = own(m.InflatePathsD(open, r, m.JoinType.Round, m.EndType.Round, 2.0, PREC, arcTol))
    return fromPathsD(res)
  })
}

// --- offsets -------------------------------------------------------------------

/** Closed-polygon offset (delta<0 shrinks inward, >0 grows). Round joins. May
 *  return several disjoint loops (a concave region splits under inward offset). */
export function offsetClosed(loops: Loops, delta: number, arcTol = 0.02): Loops {
  if (loops.length === 0) return []
  const m = requireMod()
  return withWasm(own => {
    const paths = own(toPathsD(loops))
    const res = own(m.InflatePathsD(paths, delta, m.JoinType.Round, m.EndType.Polygon, 2.0, PREC, arcTol))
    return fromPathsD(res)
  })
}

/** Closed-polygon offset returned as a nesting PolyTree (parent contours + hole
 *  children), via offset -> Union-into-tree. FreeCAD: PyclipperOffset.Execute2. */
export function offsetClosedTree(loops: Loops, delta: number, arcTol = 0.02): PolyNode[] {
  const offsetLoops = offsetClosed(loops, delta, arcTol)
  if (offsetLoops.length === 0) return []
  const m = requireMod()
  return withWasm(own => {
    const subj = own(toPathsD(offsetLoops))
    const clip = own(new m.PathsD())
    const tree = own(new m.PolyPathD())
    m.BooleanOpOutD(m.ClipType.Union, EVEN_ODD(), subj, clip, tree, PREC)
    return readPolyTree(tree)
  })
}

function readPolyTree(node: any): PolyNode[] {
  const out: PolyNode[] = []
  for (let i = 0; i < node.count(); i++) {
    const child = node.child(i) // REFERENCE into the tree -- must NOT be deleted
    const poly = child.polygon() // heap COPY -- must be deleted
    let contour: Loop
    try { contour = pathDToLoop(poly) } finally { poly.delete() }
    out.push({ contour, isHole: child.isHole(), children: readPolyTree(child) })
  }
  return out
}

// --- boolean ops ---------------------------------------------------------------

export function difference(subject: Loops, clip: Loops): Loops {
  const m = requireMod()
  return withWasm(own => {
    const s = own(toPathsD(subject)); const c = own(toPathsD(clip))
    const res = own(m.DifferenceD(s, c, EVEN_ODD(), PREC))
    return fromPathsD(res)
  })
}

export function union(a: Loops, b: Loops): Loops {
  const m = requireMod()
  return withWasm(own => {
    const s = own(toPathsD(a)); const c = own(toPathsD(b))
    const res = own(m.UnionD(s, c, EVEN_ODD(), PREC))
    return fromPathsD(res)
  })
}

export function intersection(a: Loops, b: Loops): Loops {
  const m = requireMod()
  return withWasm(own => {
    const s = own(toPathsD(a)); const c = own(toPathsD(b))
    const res = own(m.IntersectD(s, c, EVEN_ODD(), PREC))
    return fromPathsD(res)
  })
}

// --- queries -------------------------------------------------------------------

/** Sum of |area| of each loop -- the FreeCAD CUT-BITE convention (calcCutingArea,
 *  ProcessFeature.py:141 and EngagementPoint.py:187 both sum math.fabs(Area(poly))).
 *  Correct ONLY for hole-free measurements like a swept crescent clipped against
 *  cleared. NOT a material quantity: on a region with holes (e.g. remaining =
 *  cutRegion - cleared, where cleared pockets punch holes) every hole counts as
 *  POSITIVE material, so the total GROWS as material is removed -- use netArea. */
export function totalArea(loops: Loops): number {
  let a = 0
  for (const loop of loops) a += Math.abs(loopArea(loop))
  return a
}

/** NET signed area of a clipper-output loop set: outer contours carry positive
 *  shoelace area, holes negative (clipper2 EvenOdd output orientation), so holes
 *  SUBTRACT. This is the material quantity of a region. Only meaningful on loop
 *  sets with clipper-normalized winding (boolean/offset outputs). FreeCAD has no
 *  equivalent -- its reference algorithm never measures a remaining region (no
 *  reseed; ProcessFeature.py:541-542 just breaks when the engage walk exhausts). */
export function netArea(loops: Loops): number {
  let a = 0
  for (const loop of loops) a += loopArea(loop)
  return a
}

/** Signed shoelace area of one loop (plain JS, no wasm round-trip). */
export function loopArea(loop: Loop): number {
  let s = 0
  for (let i = 0; i < loop.length; i++) {
    const p = loop[i], q = loop[(i + 1) % loop.length]
    s += p.x * q.y - q.x * p.y
  }
  return s / 2
}

/** -1 outside, 0 on boundary, +1 inside (matches FreeCAD/pyclipper PointInPolygon). */
export function pointInPolygon(pt: Pt, loop: Loop): -1 | 0 | 1 {
  const m = requireMod()
  return withWasm(own => {
    const flat: number[] = []
    for (const p of loop) flat.push(p.x, p.y)
    const path = own(m.MakePathD(flat))
    const ptd = own(new m.PointD(pt.x, pt.y, 0)) // was leaked pre-fix (never deleted)
    const res = m.PointInPolygonD(ptd, path) // enum value: plain JS object, nothing to delete
    if (res.value === m.PointInPolygonResult.IsInside.value) return 1
    if (res.value === m.PointInPolygonResult.IsOutside.value) return -1
    return 0
  })
}

/** Translate every loop by (dx,dy). Plain JS (cheaper than a wasm round-trip). */
export function translate(loops: Loops, dx: number, dy: number): Loops {
  return loops.map(loop => loop.map(p => ({ x: p.x + dx, y: p.y + dy })))
}
