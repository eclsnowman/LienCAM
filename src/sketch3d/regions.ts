// Profile/region output API (WO SKC-4, WP3.6).
//
// Chains a SOLVED sketch3d document's non-construction line/arc/circle
// entities into closed loops, classifies their nesting (outer boundary / hole
// / island-in-hole) via the EXISTING cam3d/geom2d Clipper2 machinery (ruling
// 3 -- "region detection via the EXISTING Clipper2 machinery ... do not
// hand-roll loop detection"), and emits `ProfileRegion`s exactly per the
// FROZEN geom-service.ts v0.4 contract (outer loop + holes, consistent
// winding, per-segment srcId lineage) that GEO's makeExtrude/makeRevolve
// consume directly.
//
// What is genuinely NEW here (confirmed by recon: no existing equivalent):
// chaining raw entities into closed polylines (chainEntitiesIntoLoops) --
// Clipper2 operates on already-closed polygons, it has no opinion on how
// sketch entities join into one. What is REUSED, never reimplemented: nesting
// classification (containment) via cam3d/geom2d's `boolean`/`area`/`netArea`
// wasm-backed primitives -- the exact machinery the 2D CAM lane's own
// region/offset code (src/lib/cam/face2d, src/cam3d/geom2d) is built on.
//
// Construction geometry (ruling 5): entities flagged `construction: true`
// participate in constraints/regions as boundaries-only and are EXCLUDED
// here -- they never contribute a segment to any emitted loop.
//
// Determinism (AC #7): loop chaining starts from a deterministically SORTED
// entity id, never insertion/iteration order; every emitted loop is rotated
// to a canonical starting segment (smallest srcId) and oriented to a fixed
// winding (outer CCW, hole CW -- AC #5's "correct winding"); the top-level
// region array and each region's hole array are both sorted by their
// canonical key. Shuffling the INPUT entities array therefore never changes
// which regions come out, their loop contents, or their array order.

import { area, boolean, ensureGeom2dReady, netArea, type Ring } from '../cam3d/geom2d'
import type { ProfileRegion } from '../geom/geom-service'
import type {
  Sketch3dArcEntity,
  Sketch3dCircleEntity,
  Sketch3dDocument,
  Sketch3dEntity,
  Sketch3dLineEntity,
  Sketch3dVec2,
} from './types'

type ProfileLoop = ProfileRegion['loops'][number]
type ProfileSegment = ProfileLoop[number]
type ProfileArcSegment = Extract<ProfileSegment, { kind: 'arc' }>

const TWO_PI = Math.PI * 2
const SNAP_DIGITS = 6

// ---------------------------------------------------------------------
// Step 1 (new code, see module comment): chain entities into closed loops.
// ---------------------------------------------------------------------

function vertexKey(p: Sketch3dVec2): string {
  return `${p.x.toFixed(SNAP_DIGITS)},${p.y.toFixed(SNAP_DIGITS)}`
}

function arcEndpoint(entity: Sketch3dArcEntity, which: 0 | 1): Sketch3dVec2 {
  const angle = which === 0 ? entity.startAngle : entity.endAngle
  return {
    x: entity.center.x + entity.radius * Math.cos(angle),
    y: entity.center.y + entity.radius * Math.sin(angle),
  }
}

function endpointsOf(entity: Sketch3dLineEntity | Sketch3dArcEntity): [Sketch3dVec2, Sketch3dVec2] {
  return entity.kind === 'line' ? [entity.start, entity.end] : [arcEndpoint(entity, 0), arcEndpoint(entity, 1)]
}

function segmentFor(entity: Sketch3dLineEntity | Sketch3dArcEntity, forward: boolean): ProfileSegment {
  if (entity.kind === 'line') {
    return forward
      ? { kind: 'line', a: [entity.start.x, entity.start.y], b: [entity.end.x, entity.end.y], srcId: entity.id }
      : { kind: 'line', a: [entity.end.x, entity.end.y], b: [entity.start.x, entity.start.y], srcId: entity.id }
  }
  // WO SKC-12: entities are now CAM canonical-CCW (draftEntities.ts's
  // canonicalArcFromThreePoints, mirroring lib/sketch/types.ts's SketchArcEntity invariant) --
  // every stored arc sweeps CCW from startAngle to endAngle via norm(endAngle - startAngle); a
  // major vs minor arc is distinguished by WHICH physical point the constructor assigned to which
  // site, never by a signed/out-of-range delta (see SKETCH-CONVERGENCE-PLAN.md Section 2 for the
  // bug class this replaced). So a forward-walked segment is unconditionally ccw:true; walking the
  // SAME entity backward (the loop chained the opposite direction through it) reverses to
  // ccw:false -- exactly reverseSegment's own convention below.
  return forward
    ? {
        kind: 'arc',
        c: [entity.center.x, entity.center.y],
        r: entity.radius,
        a0: entity.startAngle,
        a1: entity.endAngle,
        ccw: true,
        srcId: entity.id,
      }
    : {
        kind: 'arc',
        c: [entity.center.x, entity.center.y],
        r: entity.radius,
        a0: entity.endAngle,
        a1: entity.startAngle,
        ccw: false,
        srcId: entity.id,
      }
}

interface EndpointRef {
  entityId: string
  /** Which end (0 = start/p0, 1 = end/p1) of that entity sits at this vertex. */
  end: 0 | 1
}

/**
 * Chains non-construction line/arc entities into simple closed loops by
 * following shared endpoints (a coincident constraint makes two entities'
 * endpoints solve to the same point, within floating-point tolerance).
 * Circles need no chaining -- each is already its own closed loop. FAILS
 * LOUD (matches the codebase's fail-loud ethos, e.g. cam3d/geom2d's
 * validateRings) on an open/branching profile (a vertex with degree != 2):
 * WP3.6 region output is defined over CLOSED profiles only.
 */
export function chainEntitiesIntoLoops(entities: Sketch3dEntity[]): ProfileLoop[] {
  const loops: ProfileLoop[] = []

  for (const e of entities) {
    if (e.construction || e.kind !== 'circle') continue
    const circle = e as Sketch3dCircleEntity
    loops.push([
      { kind: 'arc', c: [circle.center.x, circle.center.y], r: circle.radius, a0: 0, a1: TWO_PI, ccw: true, srcId: circle.id },
    ])
  }

  const chainable = entities.filter(
    (e): e is Sketch3dLineEntity | Sketch3dArcEntity => !e.construction && (e.kind === 'line' || e.kind === 'arc'),
  )
  if (chainable.length === 0) return loops

  const endpoints = new Map<string, [Sketch3dVec2, Sketch3dVec2]>()
  const adjacency = new Map<string, EndpointRef[]>()
  for (const e of chainable) {
    const pts = endpointsOf(e)
    endpoints.set(e.id, pts)
    ;([0, 1] as const).forEach((end) => {
      const key = vertexKey(pts[end])
      const ref: EndpointRef = { entityId: e.id, end }
      const list = adjacency.get(key)
      if (list) list.push(ref)
      else adjacency.set(key, [ref])
    })
  }

  for (const [key, refs] of adjacency) {
    if (refs.length !== 2) {
      throw new Error(
        `sketch3d regions: vertex ${key} has degree ${refs.length} (expected exactly 2) -- open or ` +
          `branching sketch profiles are not supported by region output (WP3.6 is defined over closed profiles).`,
      )
    }
  }

  const byId = new Map(chainable.map((e) => [e.id, e]))
  const visited = new Set<string>()
  // Deterministic start order (AC #7): never the caller's array order.
  const orderedIds = [...byId.keys()].sort()

  for (const startId of orderedIds) {
    if (visited.has(startId)) continue
    const loop: ProfileLoop = []
    const loopStartKey = vertexKey(endpoints.get(startId)![0])
    let currentId = startId
    let forward = true
    for (;;) {
      visited.add(currentId)
      const entity = byId.get(currentId)!
      loop.push(segmentFor(entity, forward))
      const [p0, p1] = endpoints.get(currentId)!
      const atKey = vertexKey(forward ? p1 : p0)
      if (atKey === loopStartKey) break
      const next = (adjacency.get(atKey) ?? []).filter((r) => r.entityId !== currentId)
      if (next.length !== 1) {
        throw new Error(`sketch3d regions: vertex ${atKey} did not resolve to exactly one next edge.`)
      }
      currentId = next[0].entityId
      forward = next[0].end === 0
    }
    loops.push(loop)
  }
  return loops
}

// ---------------------------------------------------------------------
// Step 2: tessellate a loop for area/containment math ONLY (never emitted --
// the returned ProfileRegion always keeps exact line/arc segments).
// ---------------------------------------------------------------------

function arcPoint(c: [number, number], r: number, angle: number): [number, number] {
  return [c[0] + r * Math.cos(angle), c[1] + r * Math.sin(angle)]
}

function sampleArc(seg: ProfileArcSegment, samplesPerTurn: number): Array<[number, number]> {
  let span = seg.ccw ? seg.a1 - seg.a0 : seg.a0 - seg.a1
  while (span <= 0) span += TWO_PI
  while (span > TWO_PI + 1e-9) span -= TWO_PI
  const steps = Math.max(2, Math.ceil((span / TWO_PI) * samplesPerTurn))
  const pts: Array<[number, number]> = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const angle = seg.ccw ? seg.a0 + span * t : seg.a0 - span * t
    pts.push(arcPoint(seg.c, seg.r, angle))
  }
  return pts
}

function tessellateLoopToRing(loop: ProfileLoop, samplesPerTurn: number): Ring {
  const pts: Array<[number, number]> = []
  for (const seg of loop) {
    if (seg.kind === 'line') pts.push(seg.a)
    else pts.push(...sampleArc(seg, samplesPerTurn).slice(0, -1))
  }
  const flat = new Float64Array(pts.length * 2)
  pts.forEach(([x, y], i) => {
    flat[2 * i] = x
    flat[2 * i + 1] = y
  })
  return flat
}

// ---------------------------------------------------------------------
// Step 3: orientation + canonical ordering (AC #5 winding, AC #7 determinism).
// ---------------------------------------------------------------------

function reverseSegment(seg: ProfileSegment): ProfileSegment {
  return seg.kind === 'line'
    ? { kind: 'line', a: seg.b, b: seg.a, srcId: seg.srcId }
    : { kind: 'arc', c: seg.c, r: seg.r, a0: seg.a1, a1: seg.a0, ccw: !seg.ccw, srcId: seg.srcId }
}

function reverseLoop(loop: ProfileLoop): ProfileLoop {
  return loop.slice().reverse().map(reverseSegment)
}

function canonicalRotate(loop: ProfileLoop): ProfileLoop {
  let idx = 0
  for (let i = 1; i < loop.length; i++) if (loop[i].srcId < loop[idx].srcId) idx = i
  return [...loop.slice(idx), ...loop.slice(0, idx)]
}

function canonicalKey(loop: ProfileLoop): string {
  return loop.reduce((min, seg) => (seg.srcId < min ? seg.srcId : min), loop[0].srcId)
}

function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

const NESTING_SAMPLES_PER_TURN = 64

/** Package convention (mirrors cam3d/geom2d/rings.ts exactly): outer loops
 *  CCW (positive area), hole loops CW (negative area) -- "correct winding"
 *  per AC #5. Always returns a canonically-rotated loop. */
function orientLoop(loop: ProfileLoop, desired: 'ccw' | 'cw'): ProfileLoop {
  const ring = tessellateLoopToRing(loop, NESTING_SAMPLES_PER_TURN)
  const isCcw = area(ring) > 0
  const oriented = (desired === 'ccw') === isCcw ? loop : reverseLoop(loop)
  return canonicalRotate(oriented)
}

function reverseRing(ring: Ring): Ring {
  const n = ring.length / 2
  const out = new Float64Array(ring.length)
  for (let i = 0; i < n; i++) {
    out[2 * i] = ring[2 * (n - 1 - i)]
    out[2 * i + 1] = ring[2 * (n - 1 - i) + 1]
  }
  return out
}

/** True when `inner` sits (almost) entirely inside `outer`, via the EXISTING
 *  Clipper2 boolean-intersect wrapper (cam3d/geom2d's `boolean`) rather than a
 *  hand-rolled point-in-polygon test (ruling 3). Both rings are forced to a
 *  common CCW orientation first so NonZero-fill intersection measures plain
 *  geometric overlap, independent of the ring's OWN (not-yet-decided) role as
 *  outer/hole in the final region. */
function isContained(inner: Ring, outer: Ring): boolean {
  const a = area(outer) < 0 ? reverseRing(outer) : outer
  const b = area(inner) < 0 ? reverseRing(inner) : inner
  const innerArea = Math.abs(area(b))
  if (innerArea < 1e-9) return false
  const intersection = boolean([a], [b], 'intersect')
  const intersectionArea = Math.abs(netArea(intersection))
  return intersectionArea / innerArea > 0.999
}

/**
 * Groups raw (unclassified) closed loops into regions: even containment
 * depth = a region's OUTER boundary (depth 0 = a top-level region; depth 2 =
 * an island nested inside a hole starts its OWN new region -- "island-in-hole"
 * handled correctly, AC #5); odd depth = a HOLE of the region rooted at its
 * nearest (max-depth) containing ancestor.
 */
function classifyAndBuildRegions(rawLoops: ProfileLoop[]): ProfileLoop[][] {
  const rings = rawLoops.map((loop) => tessellateLoopToRing(loop, NESTING_SAMPLES_PER_TURN))
  const n = rawLoops.length
  const containers: number[][] = rawLoops.map(() => [])
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i !== j && isContained(rings[j], rings[i])) containers[j].push(i)
    }
  }
  const depth = containers.map((list) => list.length)
  const parentOf = (j: number): number => {
    let best = -1
    let bestDepth = -1
    for (const i of containers[j]) {
      if (depth[i] > bestDepth) {
        bestDepth = depth[i]
        best = i
      }
    }
    return best
  }

  const regions = new Map<number, { outer: number; holes: number[] }>()
  for (let idx = 0; idx < n; idx++) {
    if (depth[idx] % 2 === 0) regions.set(idx, { outer: idx, holes: [] })
  }
  for (let idx = 0; idx < n; idx++) {
    if (depth[idx] % 2 !== 1) continue
    const parent = parentOf(idx)
    const region = regions.get(parent)
    if (!region) {
      throw new Error(`sketch3d regions: hole loop ${idx} has no enclosing region (unexpected nesting).`)
    }
    region.holes.push(idx)
  }

  const built = [...regions.values()].map((region) => {
    const outerLoop = orientLoop(rawLoops[region.outer], 'ccw')
    const holeLoops = region.holes
      .map((h) => orientLoop(rawLoops[h], 'cw'))
      .sort((a, b) => compareKeys(canonicalKey(a), canonicalKey(b)))
    return [outerLoop, ...holeLoops]
  })

  return built.sort((a, b) => compareKeys(canonicalKey(a[0]), canonicalKey(b[0])))
}

// ---------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------

/**
 * Computes selectable ProfileRegions from a SOLVED sketch3d document's
 * non-construction geometry, per the frozen geom-service.ts v0.4 contract.
 * `plane` is the sketch's own plane in model space (sketch3d entities are 2D
 * in that plane's local coords, matching ProfileRegion's own convention).
 */
export async function computeProfileRegions(
  document: Sketch3dDocument,
  plane: ProfileRegion['plane'],
): Promise<ProfileRegion[]> {
  await ensureGeom2dReady()
  const rawLoops = chainEntitiesIntoLoops(document.entities)
  if (rawLoops.length === 0) return []
  return classifyAndBuildRegions(rawLoops).map((loops) => ({ sketchId: document.id, plane, loops }))
}
