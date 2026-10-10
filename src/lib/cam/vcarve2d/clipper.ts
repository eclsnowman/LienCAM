// Polygon booleans and offsets for the V-carve engine, on clipper2-wasm.
//
// Why a third wrapper (face2d/clipperOffset.ts and adaptiveClearing2d/engine/
// clipperEngine.ts already exist): V-carve needs a NON-ZERO union to weld
// overlapping outlines (script text, touching letters) into one region while
// keeping letter counters as holes, and it needs the result as a nesting tree.
// Both existing wrappers expose even-odd booleans only and keep their module
// handle private, and the adaptive engine directory belongs to a live order.
// The marshalling rules below are copied from clipperEngine.ts; keep them.
//
// The toolpath worker awaits `ensureVCarveClipperReady()` before computing a
// V-carve, after which everything here is synchronous.

/* eslint-disable @typescript-eslint/no-explicit-any */
// @ts-expect-error - clipper2-wasm's default export is the untyped Emscripten factory.
import Clipper2ZFactory from 'clipper2-wasm'
import wasmUrl from 'clipper2-wasm/dist/es/clipper2z.wasm?url'

export type Pt = { x: number; y: number }
export type Loop = Pt[]
export type Loops = Pt[][]

/** A contour with its directly nested holes; each hole's children are the next
 *  outer contours (clipper nesting). */
export interface PolyNode {
  contour: Loop
  isHole: boolean
  children: PolyNode[]
}

const PREC = 4 // decimal places: 0.1 micron, plenty for mm CAM
const isNode = typeof process !== 'undefined' && !!(process as any).versions?.node

let mod: any = null
let initPromise: Promise<void> | null = null

export function ensureVCarveClipperReady(): Promise<void> {
  if (mod) return Promise.resolve()
  if (!initPromise) {
    const opts = isNode ? {} : { locateFile: (p: string) => (p.endsWith('.wasm') ? wasmUrl : p) }
    initPromise = Clipper2ZFactory(opts).then((m: any) => { mod = m })
  }
  return initPromise as Promise<void>
}

export function vcarveClipperReady(): boolean {
  return mod !== null
}

function requireMod(): any {
  if (!mod) throw new Error('V-carve: clipper2 not initialised (call ensureVCarveClipperReady() first)')
  return mod
}

/** Run `fn`, deleting every wasm handle registered via `own` on the way out. */
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

function pathDToLoop(p: any): Loop {
  const n = p.size()
  const v = p.view() // Float64Array over wasm memory, stride 3 (x, y, z)
  if (v.length !== n * 3) throw new Error(`V-carve: unexpected PathD.view() layout (${v.length} doubles for ${n} points)`)
  const loop: Loop = new Array(n)
  for (let j = 0, k = 0; j < n; j++, k += 3) loop[j] = { x: v[k], y: v[k + 1] }
  return loop
}

function fromPathsD(paths: any): Loops {
  const out: Loops = []
  const n = paths.size()
  for (let i = 0; i < n; i++) {
    const p = paths.get(i) // heap copy: must be deleted
    try { out.push(pathDToLoop(p)) } finally { p.delete() }
  }
  return out
}

function readPolyTree(node: any): PolyNode[] {
  const out: PolyNode[] = []
  for (let i = 0; i < node.count(); i++) {
    const child = node.child(i) // reference into the tree: never delete
    const poly = child.polygon() // heap copy: must be deleted
    let contour: Loop
    try { contour = pathDToLoop(poly) } finally { poly.delete() }
    out.push({ contour, isHole: child.isHole(), children: readPolyTree(child) })
  }
  return out
}

/** Non-zero union of oriented loops (outers counter-clockwise, holes clockwise)
 *  returned as a nesting tree. Overlapping outers weld; holes survive where
 *  they are not covered by another outer. */
export function unionNonZeroTree(loops: Loops): PolyNode[] {
  if (loops.length === 0) return []
  const m = requireMod()
  return withWasm(own => {
    const subj = own(toPathsD(loops))
    const clip = own(new m.PathsD())
    const tree = own(new m.PolyPathD())
    m.BooleanOpOutD(m.ClipType.Union, m.FillRule.NonZero, subj, clip, tree, PREC)
    return readPolyTree(tree)
  })
}

/** Offset closed loops (outers CCW, holes CW, treated together with the
 *  positive fill rule) by `delta` (negative = inward) with round joins, and
 *  return the nesting tree of the result. */
export function offsetTree(loops: Loops, delta: number, arcTol = 0.01): PolyNode[] {
  if (loops.length === 0) return []
  const m = requireMod()
  return withWasm(own => {
    const paths = own(toPathsD(loops))
    const inflated = own(m.InflatePathsD(paths, delta, m.JoinType.Round, m.EndType.Polygon, 2.0, PREC, arcTol))
    const clip = own(new m.PathsD())
    const tree = own(new m.PolyPathD())
    m.BooleanOpOutD(m.ClipType.Union, m.FillRule.Positive, inflated, clip, tree, PREC)
    return readPolyTree(tree)
  })
}

/** subject minus clip, both sets of oriented loops, positive fill rule. */
export function differenceTree(subject: Loops, clip: Loops): PolyNode[] {
  if (subject.length === 0) return []
  const m = requireMod()
  return withWasm(own => {
    const s = own(toPathsD(subject))
    const c = own(toPathsD(clip))
    const tree = own(new m.PolyPathD())
    m.BooleanOpOutD(m.ClipType.Difference, m.FillRule.Positive, s, c, tree, PREC)
    return readPolyTree(tree)
  })
}

/** Plain-loops variant of a positive-fill offset (used for ring fills). */
export function offsetLoops(loops: Loops, delta: number, arcTol = 0.01): Loops {
  if (loops.length === 0) return []
  const m = requireMod()
  return withWasm(own => {
    const paths = own(toPathsD(loops))
    const res = own(m.InflatePathsD(paths, delta, m.JoinType.Round, m.EndType.Polygon, 2.0, PREC, arcTol))
    const clip = own(new m.PathsD())
    const united = own(m.UnionD(res, clip, m.FillRule.Positive, PREC))
    return fromPathsD(united)
  })
}

/** Signed area: positive for counter-clockwise loops. */
export function loopArea(loop: Loop): number {
  let a = 0
  for (let i = 0, n = loop.length; i < n; i++) {
    const p = loop[i], q = loop[(i + 1) % n]
    a += p.x * q.y - q.x * p.y
  }
  return a / 2
}

/** Flatten a nesting tree into oriented loops: every contour CCW if it is an
 *  outer, CW if it is a hole, at every nesting level. */
export function treeToOrientedLoops(nodes: PolyNode[]): Loops {
  const out: Loops = []
  const walk = (list: PolyNode[]) => {
    for (const n of list) {
      const ccw = loopArea(n.contour) > 0
      const want = !n.isHole
      out.push(ccw === want ? n.contour : [...n.contour].reverse())
      walk(n.children)
    }
  }
  walk(nodes)
  return out
}
