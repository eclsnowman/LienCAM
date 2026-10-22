import type { Backend, BooleanOperation, Loop, Loops, Point } from './contracts'
import { profiles } from './profiles'

/** Inject the actual module after its existing ensure*Ready call. No WASM
 * lifetime, singleton, store or engine import crosses the kernel boundary. */
export function faceAdapter(native: {
  offsetLoop(loop: Loop, delta: number, minArea?: number): Loops
}, membership?: (point: Point, loop: Loop) => boolean): Backend {
  return {
    profile: profiles.face, offsetModes: ['region'], joins: ['round'], booleans: [], emptyBooleanOperand: false,
    offset: (loops, delta, opts) => loops.flatMap(loop => native.offsetLoop(loop, delta, opts.minArea)),
    membership,
  }
}
export function adaptiveAdapter(native: {
  offsetClosed(loops: Loops, delta: number, arcTol?: number): Loops
  offsetOpenRound(loop: Loop, delta: number, arcTol?: number): Loops
  union(a: Loops, b: Loops): Loops
  difference(a: Loops, b: Loops): Loops
  intersection(a: Loops, b: Loops): Loops
  pointInPolygon(point: Point, loop: Loop): -1 | 0 | 1
}): Backend {
  return {
    profile: profiles.adaptive, offsetModes: ['region', 'open-round'], joins: ['round'],
    booleans: ['union', 'difference', 'intersect'], emptyBooleanOperand: true,
    offset: (loops, delta, opts) => opts.mode === 'open-round'
      ? loops.flatMap(loop => native.offsetOpenRound(loop, delta, opts.arcTolerance))
      : native.offsetClosed(loops, delta, opts.arcTolerance),
    boolean: (a, b, op) => op === 'union' ? native.union(a, b) : op === 'difference' ? native.difference(a, b) : native.intersection(a, b),
    membership: native.pointInPolygon,
  }
}
interface PolyNode { contour: Loop; isHole: boolean; children: PolyNode[] }
export function vcarveAdapter(native: {
  offsetLoops(loops: Loops, delta: number, arcTol?: number): Loops
  unionNonZeroTree(loops: Loops): PolyNode[]
  differenceTree(a: Loops, b: Loops): PolyNode[]
  treeToOrientedLoops(tree: PolyNode[]): Loops
}): Backend {
  return {
    profile: profiles.vcarve, offsetModes: ['region'], joins: ['round'],
    booleans: ['union', 'difference'], emptyBooleanOperand: true,
    offset: (loops, delta, opts) => native.offsetLoops(loops, delta, opts.arcTolerance),
    boolean: (a, b, op) => native.treeToOrientedLoops(op === 'union' ? native.unionNonZeroTree([...a, ...b]) : native.differenceTree(a, b)),
  }
}
export function toRings(loops: Loops): Float64Array[] {
  return loops.map(loop => new Float64Array(loop.flatMap(p => [p.x, p.y])))
}
export function fromRings(rings: readonly Float64Array[]): Loops {
  return rings.map(ring => Array.from({ length: ring.length / 2 }, (_, i) => ({ x: ring[i * 2], y: ring[i * 2 + 1] })))
}
export function cam3dAdapter(native: {
  offset(rings: readonly Float64Array[], delta: number, opts?: { joinType?: 'round' | 'miter' | 'square'; arcTolerance?: number }): Float64Array[]
  boolean(a: readonly Float64Array[], b: readonly Float64Array[], op: BooleanOperation): Float64Array[]
}): Backend {
  return {
    profile: profiles.cam3d, offsetModes: ['region'], joins: ['round', 'miter', 'square'],
    booleans: ['union', 'difference', 'intersect', 'xor'], emptyBooleanOperand: false,
    offset: (loops, delta, opts) => fromRings(native.offset(toRings(loops), delta, { joinType: opts.join, arcTolerance: opts.arcTolerance })),
    boolean: (a, b, op) => fromRings(native.boolean(toRings(a), toRings(b), op)),
  }
}
export function scriptAdapter(native: {
  offsetOpenChain(loop: Loop, delta: number, miterLimit?: number): Loop
  pointInPolygon(point: Point, loop: Loop): boolean
}): Backend {
  return {
    profile: profiles.script, offsetModes: ['open-side'], joins: ['miter'], booleans: [], emptyBooleanOperand: false,
    // Signed side, including negative/left offsets; deliberately no region "inside".
    // Pruning remains a separate caller step, exactly as in contour2d.ts.
    offset: (loops, delta) => loops.map(loop => native.offsetOpenChain(loop, delta, 4)),
    membership: native.pointInPolygon,
  }
}
