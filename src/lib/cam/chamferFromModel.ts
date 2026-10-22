// WO-3021: a Chamfer operation that takes its path, width and depth from a
// chamfer the part already has.
//
// the operator (2026-10-21): "Do we have the ability to select a 2d modeled chamfer and
// have it know the path, and the correct setting to reproduce it, then use
// those?" This file is that answer. It reads what the part PROVES and turns it
// into exactly the inputs chamfer2d already takes - nothing in the cutting math
// changes:
//
//   loop          the chamfer's LOWER edge, where the bevel meets the wall.
//                 With the tool tip on that edge at the modeled depth, the
//                 bit's cone reaches the top face exactly at the bevel's top
//                 edge (for a bit of the chamfer's own angle).
//   side          outer when the bevel sits inside the loop (a part's outside
//                 edge), inner when it sits outside it (a hole's mouth).
//   chamferWidth  the modeled DEPTH: chamfer2d's chamferWidth is the Z drop
//                 below the reference face.
//   reference     the chamfer's TOP edge Z. Chamfers at different top heights,
//                 depths or angles become separate passes.
//
// Where the chamfers come from: an STL part's own bytes and a modeled body's
// own tessellation are read by the mesh recogniser's proved edge blends
// (src/mesh/recognition, read-only here); a STEP part by the model kernel's
// feature recognition (chamferPlanar, chamferChain), measured on the kernel's
// tessellation of those faces. Each proved chamfer band is measured from its
// own triangles: its Z extent is the depth, their slopes the angle. Nothing here guesses: a chamfer that is not proved is not
// listed, and a proved one a chamfer bit cannot cut from above (an inside
// corner, an underside edge) is listed as skipped with the reason.

import type { MeshBuffers, Vec3 } from '../../mesh/types'
import { recognizeEdgeBlends } from '../../mesh/recognition'
import { meshRecenterShift } from '../../mesh/recognition/toolpathTargets'
import { resolveEditedStlMesh } from '../../mesh/edit/resolve'
import type { ImportedGeometry, Loop2D, PhysicalStock, SceneStock, Setup, Vec2 } from '../../types'
import type * as DispatchGeo from '../../store/dispatchGeo'
import type { ModelItemPlacementRegistryEntry } from './modelItemPlacement'
import { resolveModelReferenceFrame } from './modelReferenceFrame'
import { placedWorldPositions } from './modelBodyDerive'
import type { ChamferParams } from './types'

/** The model item an older modeled body belongs to (modelBodyDerive's own). */
const LEGACY_MODEL_ITEM = 'legacy'
/** Values the recogniser measures carry float32 noise from the file
 *  (0.24999999999999956); the operation gets them to a tenth of a micron. */
const VALUE_QUANTUM_MM = 1e-4
/** How far a facet may sit above the band's lowest point and still be part of
 *  its lower edge, mm. */
const RAIL_EPS_MM = 1e-3
/** Two chamfers whose top Z or depth differ by less than this share a pass. */
const GROUP_EPS_MM = 1e-3
/** ...and whose angles differ by less than this, degrees. */
const GROUP_EPS_DEG = 0.1
/** A bit whose angle is within this of the chamfer's cuts the modeled bevel;
 *  past it the dialog says what the bit will cut instead, degrees. */
export const ANGLE_NOTE_EPS_DEG = 0.5

type GeoPose = DispatchGeo.GeoPose

/** The store's frame resolvers (the ones the compute uses). lib/cam may not
 *  import the store, so the caller hands them in. */
export interface ChamferFrames {
  transformLoopPoints: typeof DispatchGeo.transformLoopPoints
  resolveGeometryZToFramesModelAwareSafe: typeof DispatchGeo.resolveGeometryZToFramesModelAwareSafe
  resolveTopZ: typeof DispatchGeo.resolveTopZ
}

export type ModeledChamferSource = 'mesh' | 'model' | 'step'

/** One chamfer the part proves, in the part's own (local) frame. */
export interface ModeledChamfer {
  /** the recogniser's id for the band (`chamfer-<smallest facet>`) */
  featureId: string
  /** Z of the bevel's top edge, part-local mm */
  topZ: number
  /** Z of the bevel's lower edge (where it meets the wall), part-local mm */
  bottomZ: number
  /** topZ - bottomZ: what chamfer2d calls chamferWidth */
  depthMm: number
  /** how far the bevel reaches across the top face, mm */
  widthMm: number
  /** the bevel face's angle measured from the vertical tool axis - the same
   *  convention as Tool.angleFromAxisDeg (45 = what a 90 deg bit cuts) */
  angleFromAxisDeg: number
  /** the bevel's lower edge as segments, part-local */
  lowerEdge: Array<[Vec3, Vec3]>
  /** the centre of each bevel facet, part-local XY (decides outer/inner) */
  bandPoints: Vec2[]
}

export interface ModeledChamferSkip {
  featureId: string
  reason: 'inside-corner' | 'underside'
}

export interface ModeledChamferScan {
  chamfers: ModeledChamfer[]
  skipped: ModeledChamferSkip[]
}

const round = (v: number, q = VALUE_QUANTUM_MM) => Math.round(v / q) * q
const clean = (v: number) => Number(round(v).toFixed(4))

function triangleIndexBySource(mesh: MeshBuffers, sourceFacetIds?: ArrayLike<number>): Map<number, number> {
  const map = new Map<number, number>()
  const count = mesh.indices.length / 3
  for (let t = 0; t < count; t++) map.set(sourceFacetIds ? sourceFacetIds[t] : t, t)
  return map
}

function vertex(mesh: MeshBuffers, index: number, shift: Vec3): Vec3 {
  const o = index * 3
  return [mesh.positions[o] + shift[0], mesh.positions[o + 1] + shift[1], mesh.positions[o + 2] + shift[2]]
}

function meshBandTriangles(mesh: MeshBuffers, facetIds: readonly number[], triOf: Map<number, number>, shift: Vec3): Vec3[][] {
  const tris: Vec3[][] = []
  for (const id of facetIds) {
    const t = triOf.get(id)
    if (t === undefined) continue
    tris.push([0, 1, 2].map(k => vertex(mesh, mesh.indices[t * 3 + k], shift)))
  }
  return tris
}

/** Measure one proved chamfer band from its own triangles. */
function measureBand(
  featureId: string,
  shape: 'convex' | 'concave',
  tris: readonly Vec3[][],
): ModeledChamfer | ModeledChamferSkip | null {
  if (tris.length === 0) return null
  let minZ = Infinity; let maxZ = -Infinity
  let slopeArea = 0; let upArea = 0; let downArea = 0; let area = 0
  const bandPoints: Vec2[] = []
  for (const [a, b, c] of tris) {
    for (const p of [a, b, c]) { minZ = Math.min(minZ, p[2]); maxZ = Math.max(maxZ, p[2]) }
    const u: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const v: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
    const n: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
    const len = Math.hypot(n[0], n[1], n[2])
    if (len < 1e-12) continue
    const triArea = len / 2
    const nz = n[2] / len
    area += triArea
    if (nz > 0) upArea += triArea; else downArea += triArea
    // angle of the face from the vertical axis = 90 deg - its tilt from horizontal
    slopeArea += triArea * (90 - Math.acos(Math.min(1, Math.abs(nz))) * 180 / Math.PI)
    bandPoints.push({ x: (a[0] + b[0] + c[0]) / 3, y: (a[1] + b[1] + c[1]) / 3 })
  }
  if (area === 0) return null
  if (shape === 'concave') return { featureId, reason: 'inside-corner' }
  if (downArea > upArea) return { featureId, reason: 'underside' }

  const lowerEdge: Array<[Vec3, Vec3]> = []
  const low = (p: Vec3) => p[2] <= minZ + RAIL_EPS_MM
  for (const tri of tris) {
    for (let k = 0; k < 3; k++) {
      const p = tri[k]; const q = tri[(k + 1) % 3]
      if (low(p) && low(q)) lowerEdge.push([p, q])
    }
  }
  if (lowerEdge.length === 0) return null
  const angleFromAxisDeg = slopeArea / area
  const depthMm = maxZ - minZ
  return {
    featureId,
    topZ: clean(maxZ),
    bottomZ: clean(minZ),
    depthMm: clean(depthMm),
    widthMm: clean(depthMm * Math.tan(angleFromAxisDeg * Math.PI / 180)),
    angleFromAxisDeg: Number(angleFromAxisDeg.toFixed(3)),
    lowerEdge,
    bandPoints,
  }
}

/**
 * Every chamfer the mesh proves, measured. `recentre` applies the STL
 * recentring every imported STL gets in the viewport (XY centre to the origin,
 * bottom to Z 0), so the result is in the same local frame as its loops.
 */
export function modeledChamfersOnMesh(
  mesh: MeshBuffers,
  sourceFacetIds?: Uint32Array,
  options: { recentre?: boolean } = {},
): ModeledChamferScan {
  const shift: Vec3 = options.recentre ? meshRecenterShift(mesh) : [0, 0, 0]
  const triOf = triangleIndexBySource(mesh, sourceFacetIds)
  const chamfers: ModeledChamfer[] = []
  const skipped: ModeledChamferSkip[] = []
  for (const blend of recognizeEdgeBlends(mesh, sourceFacetIds).blends) {
    if (blend.kind !== 'chamfer') continue
    const measured = measureBand(blend.id, blend.shape, meshBandTriangles(mesh, blend.sourceFacetIds, triOf, shift))
    if (!measured) continue
    if ('reason' in measured) skipped.push(measured)
    else chamfers.push(measured)
  }
  return { chamfers, skipped }
}

/** A body the model kernel tessellated, with each triangle's B-rep face. */
export interface KernelTessellation {
  position: ArrayLike<number>
  index: ArrayLike<number>
  /** triangle i belongs to face faceIds[triFace[i]] */
  triFace: ArrayLike<number>
  faceIds: readonly string[]
}

/** The part of a model-kernel feature verdict this file reads. */
export interface KernelChamferVerdict {
  featureKey: string
  featureClass: string
  /** 'add' = removing it fills material back: the chamfer took an outside corner off */
  effect: 'add' | 'remove'
  faceIds: readonly string[]
}

/**
 * Every chamfer the model kernel proves on a B-rep body (a STEP part), measured
 * on the kernel's own tessellation of its faces. The kernel names the faces
 * (chamferPlanar, chamferChain - a chain runs round rounded corners, which a
 * mesh cannot prove); the triangles of those faces give the depth, the angle
 * and the lower edge exactly as a mesh band does.
 */
export function modeledChamfersOnKernelBody(
  tess: KernelTessellation,
  verdicts: readonly KernelChamferVerdict[],
): ModeledChamferScan {
  const chamfers: ModeledChamfer[] = []
  const skipped: ModeledChamferSkip[] = []
  const triCount = Math.floor(tess.index.length / 3)
  const at = (i: number): Vec3 => [tess.position[i * 3], tess.position[i * 3 + 1], tess.position[i * 3 + 2]]
  for (const verdict of verdicts) {
    if (verdict.featureClass !== 'chamferPlanar' && verdict.featureClass !== 'chamferChain') continue
    const faces = new Set(verdict.faceIds)
    const tris: Vec3[][] = []
    for (let t = 0; t < triCount; t++) {
      if (!faces.has(tess.faceIds[tess.triFace[t]])) continue
      tris.push([at(tess.index[t * 3]), at(tess.index[t * 3 + 1]), at(tess.index[t * 3 + 2])])
    }
    const measured = measureBand(verdict.featureKey, verdict.effect === 'add' ? 'convex' : 'concave', tris)
    if (!measured) continue
    if ('reason' in measured) skipped.push(measured)
    else chamfers.push(measured)
  }
  return { chamfers, skipped }
}

// ------------------------------------------------------------ loop matching

/** Arc-length intervals [start, end] (mm) along a loop's own point order,
 *  measured from points[0]; end may pass the loop's length (it wraps past
 *  points[0]). chamfer2d cuts a loop listed here only over these intervals. */
export type ChamferLoopExtent = Array<[number, number]>

/** One modeled chamfer along one part loop: the faces of one section that
 *  join up into one stretch of it. A loop the bevel does not run all the way
 *  round carries the stretch it does: the operation machines that and never
 *  the loop's unmodeled edges. */
export interface ModeledChamferLoop {
  /** the list row: the loop id, or `<loop id>#<n>` for a loop's second and
   *  later stretch */
  rowId: string
  loopId: string
  side: 'outer' | 'inner'
  /** the chamfers along this loop (recogniser ids) */
  featureIds: string[]
  topZ: number
  depthMm: number
  widthMm: number
  angleFromAxisDeg: number
  /** absent when the chamfers run the whole loop */
  extent?: ChamferLoopExtent
  /** how far they run along it, mm, and the loop's own length */
  coveredMm: number
  loopLengthMm: number
}

function pointSegmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x; const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  const t = len2 < 1e-18 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

function distanceToLoop(p: Vec2, points: readonly Vec2[], closed: boolean): number {
  let best = Infinity
  const n = points.length
  const last = closed ? n : n - 1
  for (let i = 0; i < last; i++) best = Math.min(best, pointSegmentDistance(p, points[i], points[(i + 1) % n]))
  return best
}

function insideLoop(p: Vec2, points: readonly Vec2[]): boolean {
  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i]; const b = points[j]
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

/** A gap this short between two stretches of bevel along a loop is the
 *  same bevel (tessellation and projection noise), mm. */
const EXTENT_GAP_MM = 0.2

function loopLengths(points: readonly Vec2[]): number[] {
  const cum = [0]
  for (let i = 0; i < points.length; i++) {
    const a = points[i]; const b = points[(i + 1) % points.length]
    cum.push(cum[i] + Math.hypot(b.x - a.x, b.y - a.y))
  }
  return cum
}

/** Where along a closed loop (mm from points[0]) the point nearest p sits. */
function loopParam(p: Vec2, points: readonly Vec2[], cum: readonly number[]): number {
  let best = Infinity; let at = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i]; const b = points[(i + 1) % points.length]
    const dx = b.x - a.x; const dy = b.y - a.y
    const len2 = dx * dx + dy * dy
    const t = len2 < 1e-18 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
    const d = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
    if (d < best) { best = d; at = cum[i] + t * (cum[i + 1] - cum[i]) }
  }
  return at
}

/** Each lower-edge segment as an arc-length span along the loop. */
function segmentSpans(
  segments: ReadonlyArray<[Vec2, Vec2]>,
  points: readonly Vec2[],
  cum: readonly number[],
): Array<[number, number]> {
  const total = cum[cum.length - 1]
  const spans: Array<[number, number]> = []
  for (const [p, q] of segments) {
    const a = loopParam(p, points, cum); const b = loopParam(q, points, cum)
    const forward = ((b - a) % total + total) % total
    // A rail segment is short against its loop: it runs the short way round.
    if (forward <= total / 2) spans.push([a, a + forward])
    else spans.push([b, b + (total - forward)])
  }
  return spans
}

/** Whether two spans along a loop of length `total` meet (either may wrap). */
function spansMeet(x: readonly [number, number], y: readonly [number, number], total: number): boolean {
  return [-total, 0, total].some(shift =>
    x[0] <= y[1] + shift + EXTENT_GAP_MM && y[0] + shift <= x[1] + EXTENT_GAP_MM)
}

/** Arc-length spans along a closed loop of length `total`, merged: null
 *  extent when they cover the whole loop. */
function mergeSpans(
  input: ReadonlyArray<readonly [number, number]>,
  total: number,
): { extent: ChamferLoopExtent | null; coveredMm: number; loopLengthMm: number } {
  const spans = input.map(([a, b]): [number, number] => [a, b])
  if (spans.length === 0 || total <= 0) return { extent: [], coveredMm: 0, loopLengthMm: total }
  spans.sort((x, y) => x[0] - y[0])
  const merged: Array<[number, number]> = []
  for (const [a, b] of spans) {
    const last = merged[merged.length - 1]
    if (last && a <= last[1] + EXTENT_GAP_MM) last[1] = Math.max(last[1], b)
    else merged.push([a, b])
  }
  // The stretch that starts near the loop's end may carry on past points[0].
  if (merged.length > 1) {
    const first = merged[0]; const last = merged[merged.length - 1]
    if (last[1] + EXTENT_GAP_MM >= total + first[0]) {
      last[1] = Math.max(last[1], total + first[1])
      merged.shift()
    }
  }
  const coveredMm = Math.min(total, merged.reduce((sum, [a, b]) => sum + (b - a), 0))
  if (merged.length === 1 && merged[0][1] - merged[0][0] >= total - EXTENT_GAP_MM) {
    return { extent: null, coveredMm: total, loopLengthMm: total }
  }
  const extent: ChamferLoopExtent = merged.map(([a, b]) => {
    const start = a >= total ? a - total : a
    return [clean(start), clean(start + (b - a))]
  })
  return { extent, coveredMm, loopLengthMm: total }
}

/** The sample points of a lower edge: every end and every midpoint. */
function lowerEdgeSamples(chamfer: ModeledChamfer): Vec2[] {
  const out: Vec2[] = []
  for (const [p, q] of chamfer.lowerEdge) {
    out.push({ x: p[0], y: p[1] }, { x: (p[0] + q[0]) / 2, y: (p[1] + q[1]) / 2 })
  }
  return out
}

/**
 * Which part loops run along the chamfers' lower edges, and how far. A loop
 * baked in world coordinates (an STL projection) is compared after the part's
 * pose; a local one as it is - each loop takes whichever frame its points
 * actually sit in. A chamfer belongs to ONE loop: the first in the part's own
 * loop order whose path its whole lower edge lies on. A part projected twice
 * lists the same outline twice; the first copy takes it, as it is the one the
 * operator sees first in the list.
 *
 * Chamfers of one section (top height, depth, angle) on one loop make one
 * row. The row carries the stretch of the loop their lower edges run along:
 * one bevelled edge of a square is that edge, never the square (WO-3021 audit
 * finding 1), and a second section on the same loop is its own row with its
 * own stretch, never folded into the first.
 */
export function matchModeledChamfersToLoops(
  chamfers: readonly ModeledChamfer[],
  loops: readonly Loop2D[],
  pose: GeoPose,
  transformLoopPoints: ChamferFrames['transformLoopPoints'],
): ModeledChamferLoop[] {
  const candidates = loops.filter(l => l.closed && l.points.length >= 3)
  type Hit = { chamfer: ModeledChamfer; segments: Array<[Vec2, Vec2]> }
  const byLoop = new Map<string, Hit[]>()
  const sideOf = new Map<string, 'outer' | 'inner'>()
  for (const chamfer of chamfers) {
    const local = lowerEdgeSamples(chamfer)
    const posed = transformLoopPoints(local, pose)
    const posedBand = transformLoopPoints(chamfer.bandPoints, pose)
    const tolerance = Math.min(0.05, chamfer.depthMm * 0.2, chamfer.widthMm * 0.2)
    let hit: { loop: Loop2D; band: readonly Vec2[]; samples: readonly Vec2[] } | null = null
    for (const loop of candidates) {
      for (const [samples, band] of [[posed, posedBand], [local, chamfer.bandPoints]] as const) {
        if (samples.every(p => distanceToLoop(p, loop.points, true) <= tolerance)) { hit = { loop, band, samples }; break }
      }
      if (hit) break
    }
    if (!hit) continue
    // lowerEdgeSamples lists each segment as (start, midpoint); its end is the
    // same segment's end in that frame.
    const ends = hit.samples === posed
      ? transformLoopPoints(chamfer.lowerEdge.map(([, q]) => ({ x: q[0], y: q[1] })), pose)
      : chamfer.lowerEdge.map(([, q]) => ({ x: q[0], y: q[1] }))
    const segments = chamfer.lowerEdge.map((_, i): [Vec2, Vec2] => [hit!.samples[i * 2], ends[i]])
    const list = byLoop.get(hit.loop.id) ?? []
    list.push({ chamfer, segments })
    byLoop.set(hit.loop.id, list)
    if (!sideOf.has(hit.loop.id)) {
      // The bevel sits over the material: inside the loop on a part's outside
      // edge (cut from outside it), outside the loop at a hole's mouth.
      const inside = hit.band.filter(p => insideLoop(p, hit!.loop.points)).length
      sideOf.set(hit.loop.id, inside * 2 >= hit.band.length ? 'outer' : 'inner')
    }
  }
  const sameSection = (a: ModeledChamfer, b: ModeledChamfer) =>
    Math.abs(a.topZ - b.topZ) < GROUP_EPS_MM && Math.abs(a.depthMm - b.depthMm) < GROUP_EPS_MM &&
    Math.abs(a.angleFromAxisDeg - b.angleFromAxisDeg) < GROUP_EPS_DEG
  const out: ModeledChamferLoop[] = []
  for (const loop of candidates) {
    const hits = byLoop.get(loop.id)
    if (!hits) continue
    const sections: Hit[][] = []
    for (const h of hits) {
      const section = sections.find(sec => sameSection(sec[0].chamfer, h.chamfer))
      if (section) section.push(h)
      else sections.push([h])
    }
    // One row per connected stretch of one section: the faces of one modeled
    // bevel join up along the loop, so a Pick takes that bevel and never a
    // separate bevel of the same size elsewhere on the loop (All combines
    // them into one pass in chamferPassesFromModel).
    const cum = loopLengths(loop.points)
    const total = cum[cum.length - 1]
    const rows: Array<{ hits: Hit[]; covered: ReturnType<typeof mergeSpans> }> = []
    for (const section of sections) {
      const covered = mergeSpans(segmentSpans(section.flatMap(h => h.segments), loop.points, cum), total)
      if (!covered.extent) {
        rows.push({ hits: section, covered })
        continue
      }
      for (const stretch of covered.extent) {
        const own = section.filter(h => segmentSpans(h.segments, loop.points, cum).some(span => spansMeet(span, stretch, total)))
        rows.push({ hits: own, covered: { extent: [stretch], coveredMm: stretch[1] - stretch[0], loopLengthMm: total } })
      }
    }
    // The stretch that runs along most of the loop first; equal ones in the
    // loop's own order.
    const startOf = (r: typeof rows[number]) => r.covered.extent?.[0]?.[0] ?? 0
    rows.sort((a, b) => b.covered.coveredMm - a.covered.coveredMm || startOf(a) - startOf(b))
    rows.forEach(({ hits: own, covered }, n) => {
      const main = own[0].chamfer
      out.push({
        rowId: n === 0 ? loop.id : `${loop.id}#${n + 1}`,
        loopId: loop.id,
        side: sideOf.get(loop.id)!,
        featureIds: own.map(h => h.chamfer.featureId).sort(),
        topZ: main.topZ,
        depthMm: main.depthMm,
        widthMm: main.widthMm,
        angleFromAxisDeg: main.angleFromAxisDeg,
        ...(covered.extent ? { extent: covered.extent } : {}),
        coveredMm: clean(covered.coveredMm),
        loopLengthMm: clean(covered.loopLengthMm),
      })
    })
  }
  return out
}

// ------------------------------------------------------------------- passes

/** What the operation records about where its values came from. Stored as
 *  `params.modeledChamfer`; params round-trip verbatim through save/load. */
export interface ModeledChamferRecord {
  geometryId: string
  source: ModeledChamferSource
  featureIds: string[]
  /** part-local Z of the bevel's top edge */
  topZ: number
  depthMm: number
  widthMm: number
  angleFromAxisDeg: number
  /** what the modeled chamfer filled in; a hand edit of any of these makes the
   *  record no longer describe the op, and it stops being shown or kept */
  filled?: ModeledChamferFill
}

export interface ModeledChamferFill {
  loopIds: string[]
  /** the stretches of those loops the chamfers run along (absent: whole loops) */
  loopExtents?: Record<string, ChamferLoopExtent>
  chamferWidth: number
  heightReference: ChamferParams['heightReference']
  planeOffset: number
}

/** One chamfer2d pass: loops that share a top height, a depth and an angle. */
export interface ChamferFromModelPass {
  loopIds: string[]
  loopSides: Record<string, 'outer' | 'inner'>
  /** the stretch of each loop a partial bevel runs along; a loop not listed
   *  is bevelled all the way round */
  loopExtents: Record<string, ChamferLoopExtent>
  /** the modeled depth - chamfer2d's chamferWidth */
  chamferWidth: number
  record: ModeledChamferRecord
}

export function chamferPassesFromModel(
  matches: readonly ModeledChamferLoop[],
  geometryId: string,
  source: ModeledChamferSource,
): ChamferFromModelPass[] {
  const passes: ChamferFromModelPass[] = []
  for (const m of matches) {
    const pass = passes.find(p =>
      Math.abs(p.record.topZ - m.topZ) < GROUP_EPS_MM &&
      Math.abs(p.record.depthMm - m.depthMm) < GROUP_EPS_MM &&
      Math.abs(p.record.angleFromAxisDeg - m.angleFromAxisDeg) < GROUP_EPS_DEG)
    if (pass) {
      if (pass.loopIds.includes(m.loopId)) {
        // A second chamfer of this section on the same loop: the pass cuts
        // both stretches (the whole loop when they meet all the way round).
        const had = pass.loopExtents[m.loopId]
        const merged = had && m.extent ? mergeSpans([...had, ...m.extent], m.loopLengthMm).extent : null
        if (merged && merged.length > 0) pass.loopExtents[m.loopId] = merged
        else delete pass.loopExtents[m.loopId]
      } else {
        pass.loopIds.push(m.loopId)
        if (m.extent) pass.loopExtents[m.loopId] = m.extent.map(([a, b]): [number, number] => [a, b])
      }
      pass.loopSides[m.loopId] = m.side
      pass.record.featureIds = [...new Set([...pass.record.featureIds, ...m.featureIds])].sort()
      continue
    }
    passes.push({
      loopIds: [m.loopId],
      loopSides: { [m.loopId]: m.side },
      loopExtents: m.extent ? { [m.loopId]: m.extent.map(([a, b]): [number, number] => [a, b]) } : {},
      chamferWidth: m.depthMm,
      record: {
        geometryId, source, featureIds: [...m.featureIds],
        topZ: m.topZ, depthMm: m.depthMm, widthMm: m.widthMm, angleFromAxisDeg: m.angleFromAxisDeg,
      },
    })
  }
  // Highest first, then the wider bevel: the order the Full Suite cuts them.
  return passes.sort((a, b) => b.record.topZ - a.record.topZ || b.chamferWidth - a.chamferWidth)
}

/** Where a pass's reference plane is: the Full Suite's hand-built chamfers
 *  write the bevel's top edge as Stock bottom + its height above it; a part
 *  whose stock the dialog cannot resolve gets the same Z as an absolute WCS Z. */
export interface ChamferPassDatum {
  heightReference: 'stock_bottom' | 'absolute'
  planeOffset: number
}

export function chamferPassDatum(topWcsZ: number, stockBottomWcsZ: number | undefined): ChamferPassDatum {
  return stockBottomWcsZ === undefined || !Number.isFinite(stockBottomWcsZ)
    ? { heightReference: 'absolute', planeOffset: clean(topWcsZ) }
    : { heightReference: 'stock_bottom', planeOffset: clean(topWcsZ - stockBottomWcsZ) }
}

/** The project facts a pass's reference plane is resolved against. */
export interface ChamferDatumContext {
  setup: Setup
  geometry: ImportedGeometry[]
  sceneStock: SceneStock
  stocks?: ReadonlyArray<PhysicalStock>
  placements?: readonly ModelItemPlacementRegistryEntry[]
  frames: ChamferFrames
}

/** A pass's top edge as the operation's reference plane, resolved with the
 *  same resolvers the compute uses (part-local Z to WCS; the setup's stock). */
export function modeledPassDatum(pass: ChamferFromModelPass, ctx: ChamferDatumContext): ChamferPassDatum {
  const geo = ctx.geometry.find(g => g.id === pass.record.geometryId)
  const topWcsZ = ctx.frames.resolveGeometryZToFramesModelAwareSafe(
    pass.record.topZ, geo, ctx.setup, ctx.geometry, ctx.sceneStock, ctx.stocks ?? [], ctx.placements ?? [],
  ).wcsZ
  let stockBottomWcsZ: number | undefined
  try {
    stockBottomWcsZ = ctx.frames.resolveTopZ('stock_bottom', 0, ctx.setup, ctx.sceneStock, ctx.geometry, pass.record.geometryId,
      ctx.stocks ?? [], [], undefined, ctx.placements ?? [])
  } catch {
    // No stock this part can be measured from: the same Z, as a WCS Z.
    stockBottomWcsZ = undefined
  }
  return chamferPassDatum(topWcsZ, stockBottomWcsZ)
}

export type ChamferParamsFromModel = ChamferParams & { modeledChamfer: ModeledChamferRecord }

const copyExtents = (extents: Record<string, ChamferLoopExtent>): Record<string, ChamferLoopExtent> =>
  Object.fromEntries(Object.entries(extents).map(([id, spans]) => [id, spans.map(([a, b]): [number, number] => [a, b])]))

/** The Chamfer params one pass fills. Everything else (tip offset, overlap,
 *  direction, entry) stays what the operator has. */
export function chamferParamsFromPass(
  base: ChamferParams,
  geometryId: string,
  pass: ChamferFromModelPass,
  datum: ChamferPassDatum,
): ChamferParamsFromModel {
  // A picked datum face belongs to a typed reference; the pass replaces it,
  // and its own stretches replace any the op had.
  const { referencePlaneGeo: _picked, loopExtents: _previous, ...rest } = base
  const partial = Object.keys(pass.loopExtents).length > 0
  return {
    ...rest,
    geometryId,
    loopIds: [...pass.loopIds],
    loopSides: { ...pass.loopSides },
    ...(partial ? { loopExtents: copyExtents(pass.loopExtents) } : {}),
    chamferWidth: pass.chamferWidth,
    heightReference: datum.heightReference,
    planeOffset: datum.planeOffset,
    modeledChamfer: {
      ...pass.record,
      featureIds: [...pass.record.featureIds],
      filled: {
        loopIds: [...pass.loopIds],
        ...(partial ? { loopExtents: copyExtents(pass.loopExtents) } : {}),
        chamferWidth: pass.chamferWidth, heightReference: datum.heightReference, planeOffset: datum.planeOffset,
      },
    },
  }
}

/** The one line owed when the bit's angle is not the chamfer's: what it will
 *  cut instead. null when they agree. The caller words it (i18n). */
export interface ChamferAngleNote {
  bitIncludedDeg: number
  chamferIncludedDeg: number
  depthMm: number
  /** the width the bit cuts at the modeled depth */
  cutWidthMm: number
  modeledWidthMm: number
}

export function chamferAngleNote(
  record: Pick<ModeledChamferRecord, 'angleFromAxisDeg' | 'depthMm' | 'widthMm'>,
  bitAngleFromAxisDeg: number | undefined,
): ChamferAngleNote | null {
  if (bitAngleFromAxisDeg === undefined || !Number.isFinite(bitAngleFromAxisDeg)) return null
  if (Math.abs(bitAngleFromAxisDeg - record.angleFromAxisDeg) <= ANGLE_NOTE_EPS_DEG) return null
  return {
    bitIncludedDeg: Number((bitAngleFromAxisDeg * 2).toFixed(1)),
    chamferIncludedDeg: Number((record.angleFromAxisDeg * 2).toFixed(1)),
    depthMm: record.depthMm,
    cutWidthMm: clean(record.depthMm * Math.tan(bitAngleFromAxisDeg * Math.PI / 180)),
    modeledWidthMm: record.widthMm,
  }
}

/** How much of its selected loops an operation cuts when a modeled chamfer
 *  runs along only part of them: the stretches' total length and how many
 *  loops carry one. null when every selected loop is cut all the way round. */
export function chamferStretchOf(params: Record<string, unknown> | undefined): { stretchMm: number; loops: number } | null {
  const extents = params?.loopExtents as Record<string, ChamferLoopExtent> | undefined
  const loops = Array.isArray(params?.loopIds) ? (params.loopIds as string[]) : []
  if (!extents || typeof extents !== 'object') return null
  const cut = loops.filter(id => Array.isArray(extents[id]) && extents[id].length > 0)
  if (cut.length === 0) return null
  const stretchMm = cut.reduce((sum, id) => sum + extents[id].reduce((s2, [a, b2]) => s2 + Math.max(0, b2 - a), 0), 0)
  return { stretchMm: clean(stretchMm), loops: cut.length }
}

/** The record an operation carries, or undefined (any older op). */
export function modeledChamferRecordOf(params: Record<string, unknown> | undefined): ModeledChamferRecord | undefined {
  const value = params?.modeledChamfer as ModeledChamferRecord | undefined
  if (!value || typeof value !== 'object' || !Array.isArray(value.featureIds)) return undefined
  // The record speaks for the op only while the op still has what it filled in.
  const filled = value.filled
  if (!filled || params?.geometryId !== value.geometryId) return undefined
  const loops = Array.isArray(params?.loopIds) ? (params.loopIds as string[]) : []
  const sameLoops = loops.length === filled.loopIds.length && filled.loopIds.every(id => loops.includes(id))
  const sameExtents = JSON.stringify(params?.loopExtents ?? {}) === JSON.stringify(filled.loopExtents ?? {})
  if (!sameLoops || !sameExtents || params?.chamferWidth !== filled.chamferWidth
    || params?.heightReference !== filled.heightReference || params?.planeOffset !== filled.planeOffset) return undefined
  return value
}

// ------------------------------------------------------------ app entry point

/** The part rows this file reads: an STL, a modeled body, or a STEP body. */
export type ChamferSourceGeometry = Pick<ImportedGeometry,
  'id' | 'type' | 'format' | 'loops' | 'position' | 'rotation' | 'meshEdits' | 'modelBody' | 'modelItemId'>

export interface ModeledChamferLoaders {
  loadStl: (id: string) => Promise<ArrayBuffer | null>
  loadStep: (id: string) => Promise<ArrayBuffer | null>
  /** The model kernel's reading of a STEP part: its chamfer verdicts and the
   *  tessellation of its faces. */
  readStepChamfers: (bytes: ArrayBuffer) => Promise<{ tessellation: KernelTessellation; verdicts: KernelChamferVerdict[] }>
  placements: readonly ModelItemPlacementRegistryEntry[]
  frames: ChamferFrames
}

export interface ModeledChamfersOnPart {
  source: ModeledChamferSource
  loops: ModeledChamferLoop[]
  passes: ChamferFromModelPass[]
  skipped: ModeledChamferSkip[]
  /** proved chamfers no closed loop of the part runs along */
  unmatched: number
  /** Unmatched chamfers the part's own Section at Z gives a loop for: a
   *  freshly modeled body has no loops until one is derived, and this is
   *  where the dialog derives the ones its chamfers need. */
  pending: ModeledChamferPending[]
}

/** A chamfer no loop runs along yet, and the Section at Z that gives it one:
 *  just under its lower edge, in the Z the section takes (world Z for a
 *  modeled body, the part's own Z for a STEP body). */
export interface ModeledChamferPending {
  featureId: string
  topZ: number
  depthMm: number
  widthMm: number
  angleFromAxisDeg: number
  sectionZ: number
}

/** How far under a chamfer's lower edge its section is cut: into the wall,
 *  clear of the edge itself, mm. */
const SECTION_BELOW_MM = 0.05

/** The Section at Z that gives each unmatched chamfer its loop. An STL part
 *  has no section route, and a chamfer whose lower edge does not lie level in
 *  the frame the section is cut in has none. */
export function pendingModeledChamfers(
  chamfers: readonly ModeledChamfer[],
  source: ModeledChamferSource,
  frame?: GeoPose,
): ModeledChamferPending[] {
  if (source === 'mesh') return []
  const out: ModeledChamferPending[] = []
  for (const chamfer of chamfers) {
    const flat = chamfer.lowerEdge.flatMap(([p, q]) => [...p, ...q])
    const zs: number[] = []
    if (source === 'model') {
      // A tilted or flipped body's bevel is not cut from above in its own
      // frame; its section would not run under the lower edge.
      const r = frame?.rotation ?? { x: 0, y: 0, z: 0 }
      const level = (deg: number) => Math.abs(((deg % 360) + 360) % 360) < 1e-6
      if (!frame || !level(r.x) || !level(r.y)) continue
      const placed = placedWorldPositions(flat, { position: frame.position, rotation: frame.rotation ?? { x: 0, y: 0, z: 0 } })
      for (let i = 2; i < placed.length; i += 3) zs.push(placed[i])
    } else {
      for (let i = 2; i < flat.length; i += 3) zs.push(flat[i])
    }
    const lo = Math.min(...zs); const hi = Math.max(...zs)
    if (!(hi - lo <= RAIL_EPS_MM * 10)) continue
    out.push({
      featureId: chamfer.featureId,
      topZ: chamfer.topZ, depthMm: chamfer.depthMm, widthMm: chamfer.widthMm, angleFromAxisDeg: chamfer.angleFromAxisDeg,
      sectionZ: clean(lo - Math.min(SECTION_BELOW_MM, chamfer.depthMm * 0.25)),
    })
  }
  return out
}

/** The part's chamfers in its own frame, and the pose its loops are placed by. */
async function partChamfersOf(
  geo: ChamferSourceGeometry,
  loaders: ModeledChamferLoaders,
): Promise<{ source: ModeledChamferSource; scan: ModeledChamferScan; pose: GeoPose; frame?: GeoPose } | null> {
  if (geo.type === 'mesh' && geo.format === 'stl') {
    const bytes = await loaders.loadStl(geo.id)
    if (!bytes) return null
    const resolved = resolveEditedStlMesh(bytes, geo.meshEdits)
    return { source: 'mesh', scan: modeledChamfersOnMesh(resolved.mesh, resolved.sourceFacetIds, { recentre: true }), pose: geo }
  }
  if (geo.format === 'model') {
    // A modeled body carries its own tessellation; the mesh recogniser reads it.
    const display = geo.modelBody?.display
    if (!display || display.indices.length === 0) return null
    const pose = resolveModelReferenceFrame(loaders.placements, geo.modelItemId ?? LEGACY_MODEL_ITEM, geo.modelBody?.ref.bodyId)
    const mesh = { positions: Float32Array.from(display.positions), indices: Uint32Array.from(display.indices) }
    return { source: 'model', scan: modeledChamfersOnMesh(mesh), pose, frame: pose }
  }
  if (geo.format === 'step') {
    const bytes = await loaders.loadStep(geo.id)
    if (!bytes) return null
    const read = await loaders.readStepChamfers(bytes)
    return { source: 'step', scan: modeledChamfersOnKernelBody(read.tessellation, read.verdicts), pose: geo }
  }
  return null
}

/**
 * Every modeled chamfer on one part, as Chamfer passes over its own loops.
 * null when the part has no mesh to read yet (not loaded, a 2D drawing).
 */
export async function modeledChamfersOnPart(
  geo: ChamferSourceGeometry,
  loaders: ModeledChamferLoaders,
): Promise<ModeledChamfersOnPart | null> {
  const part = await partChamfersOf(geo, loaders)
  if (!part) return null
  const { scan } = part
  const loops = matchModeledChamfersToLoops(scan.chamfers, geo.loops ?? [], part.pose, loaders.frames.transformLoopPoints)
  const matched = new Set(loops.flatMap(l => l.featureIds))
  const unmatched = scan.chamfers.filter(c => !matched.has(c.featureId))
  return {
    source: part.source,
    loops,
    passes: chamferPassesFromModel(loops, geo.id, part.source),
    skipped: scan.skipped,
    unmatched: unmatched.length,
    pending: pendingModeledChamfers(unmatched, part.source, part.frame),
  }
}
