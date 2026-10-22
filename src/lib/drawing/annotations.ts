// WO-3006 (WO-2750 Slice E): dimensions, round detail views and balloons on a
// drawing, and the repair of a dimension whose face is gone.
//
// docs/design/ASSOCIATIVE-TECHNICAL-DRAWINGS.md sections 4.1, 4.2 and 5. Pure
// functions over plain data, shared by the editor and the tests:
//
//  - A dimension names the part's FACES through Slice A references (a
//    producer-owned StableId plus a witness snapshot) and asks Slice A's
//    resolver (resolve.ts, read-only here) whether each one is still the same
//    face. Its value is recomputed from the CURRENT geometry every time; it
//    is never typed over. Anything not current keeps its last-good value and
//    says why (the editor turns the reason into one sentence, rule 11).
//  - The resolver sees only faces the body really has now: the document's
//    ElementMap keeps a deleted feature's faces, so the map is scoped to the
//    face ids of the body's own tessellation (bodyScopedMap). A deleted hole
//    is missing; it never moves to the identical hole beside it.
//  - A radius is fitted to the face's tessellation nodes, which lie on the
//    surface. A fit that misses a circle by more than RADIUS_FIT_MAX_DEVIATION_MM
//    is "not round", never an approximate number.
//  - Magnification changes paper geometry only. Values are model mm/degrees,
//    formatted at render time in the sheet's unit; tolerances are stored in
//    mm/degrees too, so a unit or precision change never alters them.
//  - Every edit returns a new document with `editedAt` moved; the last-good
//    cache (withLastGood) does not move it.

import type { GeometrySnapshot, TessBuffers } from '../../geom/geom-service'
import type { ElementMap } from '../../doc/element-map'
import { faceSnapshotSignature, resolveDrawingReference, type BrepSourceState, type CurrentSourceState } from './resolve'
import { projectPoint } from './project'
import type {
  DrawingReference,
  DrawingVec3,
  RationalScale,
  ReferenceReason,
  ReferenceResult,
  ReferenceState,
  SourceRevision,
} from './types'
import {
  multiplyScale,
  type DrawingAnnotation,
  type DrawingBalloon,
  type DrawingDimension,
  type DrawingDocument,
  type DrawingMeasurementKind,
  type DrawingRepairRecord,
  type DrawingSheet,
  type DrawingToleranceIntent,
  type DrawingView,
} from './document'
import { effectiveTemplate, generalToleranceValue } from './template'

/** A tessellation node may sit this far off a fitted circle before the face is "not round". */
export const RADIUS_FIT_MAX_DEVIATION_MM = 0.005
/** |n1.n2| above this = parallel planes (resolve.ts uses the same bound for orientation). */
const PARALLEL_DOT_MIN = 0.999
/**
 * Below this the two planes' unit normals agree to float noise (a dot product off 1 by
 * ~1e-10 already reads as ~0.0008 degrees): there is no angle to show. 0.001 degrees is
 * below anything a drawing prints at 2 decimals.
 */
const ANGLE_MIN_DEG = 1e-3
/** A face whose projected area is under this share of its true area is seen edge-on. */
const EDGE_ON_AREA_RATIO = 0.02
/** A plane normal shorter than this on paper is pointing at the viewer. */
const MIN_SHEET_DIRECTION = 0.2
const EXTENSION_GAP_MM = 1
const EXTENSION_OVERSHOOT_MM = 1.5

// ---------------------------------------------------------------------------
// The body as the drawing sees it
// ---------------------------------------------------------------------------

/** The body's faces from its tessellation: per face, its triangles as flat xyz (9 numbers each). */
export interface BodyFaces {
  triangles: Map<string, number[]>
  bboxDiagMm: number
}

export function bodyFacesFromTess(tess: Pick<TessBuffers, 'position' | 'index' | 'triFace' | 'faceIds'>): BodyFaces {
  const triangles = new Map<string, number[]>()
  const p = tess.position
  for (let t = 0; t < tess.triFace.length; t++) {
    const id = tess.faceIds[tess.triFace[t]]
    if (id === undefined) continue
    let list = triangles.get(id)
    if (list === undefined) { list = []; triangles.set(id, list) }
    for (let k = 0; k < 3; k++) {
      const v = tess.index[t * 3 + k]
      list.push(p[v * 3], p[v * 3 + 1], p[v * 3 + 2])
    }
  }
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i + 2 < p.length; i += 3) {
    for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[i + k]); max[k] = Math.max(max[k], p[i + k]) }
  }
  if (p.length < 3) { min = [0, 0, 0]; max = [0, 0, 0] }
  return { triangles, bboxDiagMm: Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) }
}

/**
 * The document's ElementMap seen through the body's live faces. The map keeps
 * the faces of a deleted or suppressed feature as live entries; the body's
 * tessellation says which faces exist now. Methods are bound to the real map.
 */
export function bodyScopedMap(map: ElementMap, liveFaceIds: ReadonlySet<string>): ElementMap {
  return new Proxy(map, {
    get(target, prop) {
      if (prop === 'has') return (id: string) => liveFaceIds.has(id) && target.has(id)
      if (prop === 'liveIds') return () => target.liveIds().filter((id) => liveFaceIds.has(id))
      if (prop === 'isDeleted') return (id: string) => target.isDeleted(id) || (target.has(id) && !liveFaceIds.has(id))
      const value = Reflect.get(target, prop, target) as unknown
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
    },
  })
}

/** The resolver's view of a Model body right now. */
export function brepSourceForBody(doc: DrawingDocument, revision: SourceRevision, map: ElementMap, faces: BodyFaces): BrepSourceState {
  const { observedRevision: _o, kind: _k, ...scope } = doc.source
  return {
    kind: 'model-brep',
    scope,
    revision,
    map: bodyScopedMap(map, new Set(faces.triangles.keys())),
    bboxDiagMm: faces.bboxDiagMm,
  }
}

// ---------------------------------------------------------------------------
// Face facts and measurement
// ---------------------------------------------------------------------------

export interface FaceFacts {
  id: string
  surfaceType: GeometrySnapshot['surfaceType']
  centroid: DrawingVec3
  normal?: DrawingVec3
  axis?: DrawingVec3
  radiusMm?: number
  radiusDeviationMm?: number
  /** the face's tessellation nodes, model mm */
  points: DrawingVec3[]
  snapshot: GeometrySnapshot
}

/** What the drawing knows of one live face: the map's snapshot plus its nodes (and a fitted radius for a cylinder). */
export function faceFacts(map: Pick<ElementMap, 'snapshotOf'>, faces: BodyFaces, id: string): FaceFacts | undefined {
  const tris = faces.triangles.get(id)
  const snapshot = map.snapshotOf(id)
  if (tris === undefined || snapshot === undefined) return undefined
  const points: DrawingVec3[] = []
  for (let i = 0; i + 2 < tris.length; i += 3) points.push([tris[i], tris[i + 1], tris[i + 2]])
  const facts: FaceFacts = {
    id,
    surfaceType: snapshot.surfaceType,
    centroid: xyz(snapshot.centroid),
    normal: snapshot.normal ? unit(xyz(snapshot.normal)) : undefined,
    axis: snapshot.axis ? unit(xyz(snapshot.axis)) : undefined,
    points,
    snapshot,
  }
  if (snapshot.surfaceType === 'cylinder' && facts.axis) {
    const fit = fitCircle(points, facts.axis)
    if (fit !== null) { facts.radiusMm = fit.radius; facts.radiusDeviationMm = fit.maxDeviation }
  }
  return facts
}

/**
 * Least-squares circle through points projected on the plane normal to
 * `axis` (Kasa fit, centred on the mean for conditioning). Null when the
 * points do not span a circle.
 */
export function fitCircle(points: DrawingVec3[], axis: DrawingVec3): { radius: number; center: DrawingVec3; maxDeviation: number } | null {
  if (points.length < 3) return null
  const a = unit(axis)
  const e1 = unit(Math.abs(a[0]) < 0.9 ? cross(a, [1, 0, 0]) : cross(a, [0, 1, 0]))
  const e2 = cross(a, e1)
  const pts = points.map((p) => [dot(p, e1), dot(p, e2)] as const)
  const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length
  const my = pts.reduce((s, p) => s + p[1], 0) / pts.length
  let sxx = 0, sxy = 0, syy = 0, sx = 0, sy = 0, sxz = 0, syz = 0, sz = 0
  for (const [px, py] of pts) {
    const x = px - mx, y = py - my, z = x * x + y * y
    sxx += x * x; sxy += x * y; syy += y * y; sx += x; sy += y; sxz += x * z; syz += y * z; sz += z
  }
  const n = pts.length
  // Solve [sxx sxy sx; sxy syy sy; sx sy n] [D E F]^T = -[sxz syz sz]^T
  const m = [[sxx, sxy, sx, -sxz], [sxy, syy, sy, -syz], [sx, sy, n, -sz]]
  for (let c = 0; c < 3; c++) {
    let pivot = c
    for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[pivot][c])) pivot = r
    if (Math.abs(m[pivot][c]) < 1e-12) return null
    ;[m[c], m[pivot]] = [m[pivot], m[c]]
    for (let r = 0; r < 3; r++) {
      if (r === c) continue
      const f = m[r][c] / m[c][c]
      for (let k = c; k < 4; k++) m[r][k] -= f * m[c][k]
    }
  }
  const D = m[0][3] / m[0][0], E = m[1][3] / m[1][1], F = m[2][3] / m[2][2]
  const cx = -D / 2, cy = -E / 2
  const r2 = cx * cx + cy * cy - F
  if (!(r2 > 0)) return null
  const radius = Math.sqrt(r2)
  let maxDeviation = 0
  for (const [px, py] of pts) maxDeviation = Math.max(maxDeviation, Math.abs(Math.hypot(px - mx - cx, py - my - cy) - radius))
  const u = cx + mx, v = cy + my
  return { radius, center: [e1[0] * u + e2[0] * v, e1[1] * u + e2[1] * v, e1[2] * u + e2[2] * v], maxDeviation }
}

/** Why a set of faces cannot make the asked dimension. The editor says each in one sentence. */
export type MeasureProblem = 'needs-plane' | 'needs-round' | 'not-parallel' | 'parallel' | 'same-face' | 'coplanar' | 'not-round' | 'no-geometry'

export type MeasureResult = { ok: true; value: number; unit: 'mm' | 'deg' } | { ok: false; problem: MeasureProblem }

/** How many faces each kind takes. */
export function facesNeeded(kind: DrawingMeasurementKind): 1 | 2 {
  return kind === 'radius' || kind === 'diameter' ? 1 : 2
}

/** The value a dimension of `kind` reads on these faces, from their current geometry. */
export function measureFaces(kind: DrawingMeasurementKind, faces: Array<FaceFacts | undefined>): MeasureResult {
  if (faces.some((f) => f === undefined) || faces.length !== facesNeeded(kind)) return { ok: false, problem: 'no-geometry' }
  const fs = faces as FaceFacts[]
  if (kind === 'radius' || kind === 'diameter') {
    const f = fs[0]
    if (f.surfaceType !== 'cylinder') return { ok: false, problem: 'needs-round' }
    if (f.radiusMm === undefined || (f.radiusDeviationMm ?? Infinity) > RADIUS_FIT_MAX_DEVIATION_MM) return { ok: false, problem: 'not-round' }
    return { ok: true, value: kind === 'radius' ? f.radiusMm : 2 * f.radiusMm, unit: 'mm' }
  }
  const [a, b] = fs
  if (a.surfaceType !== 'plane' || b.surfaceType !== 'plane' || !a.normal || !b.normal) return { ok: false, problem: 'needs-plane' }
  if (a.id === b.id) return { ok: false, problem: 'same-face' }
  const d = Math.abs(dot(a.normal, b.normal))
  if (kind === 'linear') {
    if (d <= PARALLEL_DOT_MIN) return { ok: false, problem: 'not-parallel' }
    const value = Math.abs(dot(a.normal, sub(b.centroid, a.centroid)))
    if (value < 1e-6) return { ok: false, problem: 'coplanar' }
    return { ok: true, value, unit: 'mm' }
  }
  // Any measurable angle is shown, however small; only faces with no angle between them are refused.
  const degrees = (Math.acos(Math.min(1, d)) * 180) / Math.PI
  if (degrees < ANGLE_MIN_DEG) return { ok: false, problem: 'parallel' }
  return { ok: true, value: degrees, unit: 'deg' }
}

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

/** A face reference minted on the revision the operator picked it on. */
export function makeFaceReference(id: string, doc: DrawingDocument, revision: SourceRevision, facts: FaceFacts): DrawingReference {
  const role = facts.surfaceType === 'plane' ? 'plane' : facts.axis ? 'axis' : 'point'
  const orientation = facts.surfaceType === 'plane' ? facts.normal : facts.axis
  return {
    id,
    source: { ...doc.source, observedRevision: revision },
    selector: { kind: 'face', stableId: facts.id },
    witness: {
      role,
      ...(orientation ? { orientationLocal: [...orientation] as DrawingVec3 } : {}),
      geometrySignature: faceSnapshotSignature(facts.snapshot),
      snapshot: facts.snapshot,
    },
    acceptedRevision: revision,
  }
}

// ---------------------------------------------------------------------------
// Resolving a dimension
// ---------------------------------------------------------------------------

export type DimensionReason = ReferenceReason | MeasureProblem | 'reference-record-missing'

export interface DimensionStatus {
  state: ReferenceState
  reason?: DimensionReason
  /** present only when current: recomputed from the source as it is now */
  value?: number
  unit: 'mm' | 'deg'
  references: ReferenceResult[]
  /** the current faces, in reference order, when every reference is current */
  faces?: FaceFacts[]
  /** viable faces for an explicit repair (never applied automatically) */
  candidates: string[]
  measuredAt?: SourceRevision
}

const STATE_ORDER: ReferenceState[] = ['missing', 'ambiguous', 'stale', 'unsupported', 'updating', 'current']

export function dimensionUnit(kind: DrawingMeasurementKind): 'mm' | 'deg' {
  return kind === 'angle' ? 'deg' : 'mm'
}

export interface DimensionContext {
  source: CurrentSourceState
  facts(id: string): FaceFacts | undefined
}

/** Resolve one dimension against the source as it is now (plan section 4.2 steps 2, 3, 6, 7). */
export function resolveDimension(dim: DrawingDimension, doc: DrawingDocument, ctx: DimensionContext): DimensionStatus {
  const unitOf = dimensionUnit(dim.measurement)
  const refs = dim.referenceIds.map((id) => doc.references.find((r) => r.id === id))
  if (refs.some((r) => r === undefined) || refs.length !== facesNeeded(dim.measurement)) {
    return { state: 'missing', reason: 'reference-record-missing', unit: unitOf, references: [], candidates: [] }
  }
  const results = (refs as DrawingReference[]).map((r) => resolveDrawingReference(r, ctx.source))
  const candidates = [...new Set(results.flatMap((r) => r.candidates))]
  const worst = STATE_ORDER.find((s) => results.some((r) => r.state === s)) ?? 'current'
  if (worst !== 'current') {
    return { state: worst, reason: results.find((r) => r.state === worst)?.reason, unit: unitOf, references: results, candidates, measuredAt: results[0]?.measuredAt }
  }
  const ids = results.map((r) => r.resolvedIds[0])
  if (new Set(ids).size !== ids.length) {
    // Two endpoints now land on one face: stale, never a fresh zero.
    return { state: 'stale', reason: 'endpoints-collapsed', unit: unitOf, references: results, candidates: [...new Set(ids)], measuredAt: results[0].measuredAt }
  }
  const faces = ids.map((id) => ctx.facts(id))
  const measured = measureFaces(dim.measurement, faces)
  if (!measured.ok) {
    return { state: measured.problem === 'no-geometry' || measured.problem === 'not-round' ? 'unsupported' : 'stale', reason: measured.problem, unit: unitOf, references: results, candidates: ids, measuredAt: results[0].measuredAt }
  }
  return { state: 'current', value: measured.value, unit: measured.unit, references: results, faces: faces as FaceFacts[], candidates: [], measuredAt: results[0].measuredAt }
}

// ---------------------------------------------------------------------------
// Sheet geometry
// ---------------------------------------------------------------------------

export type Pt = [number, number]

function viewK(view: DrawingView): number {
  return view.scale.numerator / view.scale.denominator
}

/** A model point on paper in this view (sheet mm, Y down). */
export function modelToSheet(view: DrawingView, p: DrawingVec3): Pt {
  const [u, v] = projectPoint(view.frame, p)
  const k = viewK(view)
  return [view.sheetOriginMm[0] + u * k, view.sheetOriginMm[1] - v * k]
}

/** A model direction on paper in this view (not normalised; short = pointing at the viewer). */
export function directionToSheet(view: DrawingView, d: DrawingVec3): Pt {
  return [dot(d, view.frame.xAxis), -dot(d, view.frame.upAxis)]
}

/** The model point in the view's frame plane under a sheet point. */
export function sheetToModel(view: DrawingView, s: Pt): DrawingVec3 {
  const k = viewK(view)
  const u = (s[0] - view.sheetOriginMm[0]) / k
  const v = (view.sheetOriginMm[1] - s[1]) / k
  const f = view.frame
  return [f.origin[0] + f.xAxis[0] * u + f.upAxis[0] * v, f.origin[1] + f.xAxis[1] * u + f.upAxis[1] * v, f.origin[2] + f.xAxis[2] * u + f.upAxis[2] * v]
}

/** Where a detail view's crop circle sits on its own sheet position, and its paper radius. */
export function detailCircle(view: DrawingView): { center: Pt; radius: number } | undefined {
  if (view.detail === undefined) return undefined
  return { center: modelToSheet(view, view.detail.centerLocalMm), radius: view.detail.radiusMm * viewK(view) }
}

/** The crop circle as drawn on the parent view. */
export function detailCircleOnParent(view: DrawingView, parent: DrawingView): { center: Pt; radius: number } | undefined {
  if (view.detail === undefined) return undefined
  return { center: modelToSheet(parent, view.detail.centerLocalMm), radius: view.detail.radiusMm * viewK(parent) }
}

export interface DimensionGraphic {
  /** extension, dimension and leader lines */
  lines: Array<[Pt, Pt]>
  /** arrowheads: tip and the direction the arrow points */
  arrows: Array<{ tip: Pt; dir: Pt }>
  label: Pt
}

export type DimensionGraphicProblem = 'faces-face-viewer'

/** The extension lines, dimension line, leaders and arrows of a current dimension in its view. */
export function dimensionGraphic(kind: DrawingMeasurementKind, view: DrawingView, faces: FaceFacts[], label: Pt): DimensionGraphic | { problem: DimensionGraphicProblem } {
  if (kind === 'linear') {
    const n3 = faces[0].normal as DrawingVec3
    let n = directionToSheet(view, n3)
    const len = Math.hypot(n[0], n[1])
    if (len < MIN_SHEET_DIRECTION) return { problem: 'faces-face-viewer' }
    n = [n[0] / len, n[1] / len]
    const perp: Pt = [-n[1], n[0]]
    const ends = faces.map((f) => {
      // Start the extension line at the face's extreme toward the label.
      const pts = f.points.map((p) => modelToSheet(view, p))
      const side = Math.sign(dot2(sub2(label, modelToSheet(view, f.centroid)), perp)) || 1
      let best = pts[0]
      for (const p of pts) if (dot2(p, perp) * side > dot2(best, perp) * side) best = p
      const start = best
      const along = dot2(sub2(label, start), perp)
      const foot = add2(start, scale2(perp, along))
      const dir = Math.sign(along) || 1
      return { start: add2(start, scale2(perp, dir * Math.min(EXTENSION_GAP_MM, Math.abs(along)))), foot, overshoot: add2(foot, scale2(perp, dir * EXTENSION_OVERSHOOT_MM)) }
    })
    const [a, b] = ends
    const ab = sub2(b.foot, a.foot)
    const abLen = Math.hypot(ab[0], ab[1]) || 1
    const u: Pt = [ab[0] / abLen, ab[1] / abLen]
    const lines: Array<[Pt, Pt]> = [[a.start, a.overshoot], [b.start, b.overshoot], [a.foot, b.foot]]
    // A label beyond either end extends the dimension line to it.
    const t = dot2(sub2(label, a.foot), u)
    if (t < 0) lines.push([a.foot, add2(a.foot, scale2(u, t))])
    if (t > abLen) lines.push([b.foot, add2(a.foot, scale2(u, t))])
    return { lines, arrows: [{ tip: a.foot, dir: scale2(u, -1) }, { tip: b.foot, dir: u }], label }
  }
  if (kind === 'radius' || kind === 'diameter') {
    const f = faces[0]
    const axis = f.axis as DrawingVec3
    const r = (f.radiusMm ?? 0) * viewK(view)
    const axisOnSheet = directionToSheet(view, axis)
    if (Math.hypot(axisOnSheet[0], axisOnSheet[1]) < 0.15) {
      // Seen end-on: a circle on paper.
      const c = modelToSheet(view, f.centroid)
      const toLabel = sub2(label, c)
      const d = Math.hypot(toLabel[0], toLabel[1]) || 1
      const u: Pt = [toLabel[0] / d, toLabel[1] / d]
      const near = add2(c, scale2(u, r))
      if (kind === 'radius') return { lines: [[c, near], [near, label]], arrows: [{ tip: near, dir: u }], label }
      const far = add2(c, scale2(u, -r))
      return { lines: [[far, near], [near, label]], arrows: [{ tip: near, dir: u }, { tip: far, dir: scale2(u, -1) }], label }
    }
    return leaderTo(view, f, label)
  }
  // Angle: a leader to each face.
  const one = leaderTo(view, faces[0], label)
  const two = leaderTo(view, faces[1], label)
  return { lines: [...one.lines, ...two.lines], arrows: [...one.arrows, ...two.arrows], label }
}

function leaderTo(view: DrawingView, f: FaceFacts, label: Pt): DimensionGraphic {
  let best = modelToSheet(view, f.centroid)
  let bestD = Infinity
  for (const p of f.points) {
    const s = modelToSheet(view, p)
    const d = Math.hypot(s[0] - label[0], s[1] - label[1])
    if (d < bestD) { bestD = d; best = s }
  }
  const dir = sub2(best, label)
  const len = Math.hypot(dir[0], dir[1]) || 1
  return { lines: [[label, best]], arrows: [{ tip: best, dir: [dir[0] / len, dir[1] / len] }], label }
}

/** Where a new dimension's label goes: beside the faces, off the part. */
export function defaultDimensionLabel(kind: DrawingMeasurementKind, view: DrawingView, faces: FaceFacts[]): Pt {
  const centre = view.sheetOriginMm
  if (kind === 'linear' && faces[0].normal) {
    const pts = faces.flatMap((f) => f.points.map((p) => modelToSheet(view, p)))
    const n = directionToSheet(view, faces[0].normal)
    const len = Math.hypot(n[0], n[1]) || 1
    const perp: Pt = [-n[1] / len, n[0] / len]
    const mids = faces.map((f) => modelToSheet(view, f.centroid))
    const mid: Pt = [(mids[0][0] + mids[1][0]) / 2, (mids[0][1] + mids[1][1]) / 2]
    // Put it on the side of the part away from the view's middle, 8 mm clear.
    const side = Math.sign(dot2(sub2(mid, centre), perp)) || -1
    let extent = -Infinity
    for (const p of pts) extent = Math.max(extent, dot2(sub2(p, mid), perp) * side)
    return add2(mid, scale2(perp, side * (Math.max(0, extent) + 8)))
  }
  const anchor = modelToSheet(view, faces[0].centroid)
  const away = sub2(anchor, centre)
  const d = Math.hypot(away[0], away[1])
  const u: Pt = d < 1e-6 ? [0.7071, -0.7071] : [away[0] / d, away[1] / d]
  const r = (faces[0].radiusMm ?? 0) * viewK(view)
  return add2(anchor, scale2(u, r + 10))
}

// ---------------------------------------------------------------------------
// Picking on paper
// ---------------------------------------------------------------------------

/** The sheet bounds of a standard view's geometry (all nodes), mm. */
export function viewBounds(view: DrawingView, faces: BodyFaces): { min: Pt; max: Pt } | undefined {
  let min: Pt = [Infinity, Infinity], max: Pt = [-Infinity, -Infinity]
  for (const tris of faces.triangles.values()) {
    for (let i = 0; i + 2 < tris.length; i += 3) {
      const s = modelToSheet(view, [tris[i], tris[i + 1], tris[i + 2]])
      min = [Math.min(min[0], s[0]), Math.min(min[1], s[1])]
      max = [Math.max(max[0], s[0]), Math.max(max[1], s[1])]
    }
  }
  return Number.isFinite(min[0]) ? { min, max } : undefined
}

/** Which view a sheet point is on: a detail view's circle first, then a standard view's bounds (with `marginMm`). */
export function viewAtPoint(sheet: DrawingSheet, faces: BodyFaces, at: Pt, marginMm = 4): DrawingView | undefined {
  for (const view of sheet.views) {
    const c = detailCircle(view)
    if (c !== undefined && Math.hypot(at[0] - c.center[0], at[1] - c.center[1]) <= c.radius) return view
  }
  for (const view of sheet.views) {
    if (view.detail !== undefined) continue
    const b = viewBounds(view, faces)
    if (b !== undefined && at[0] >= b.min[0] - marginMm && at[0] <= b.max[0] + marginMm && at[1] >= b.min[1] - marginMm && at[1] <= b.max[1] + marginMm) return view
  }
  return undefined
}

/**
 * The face under a sheet point in a view. A face seen edge-on (a box side in
 * the front view, a hole wall seen down its axis) is a line or a ring on
 * paper, so it is picked within `tolMm` of that line and wins over the face
 * behind it; otherwise the nearest face under the point is picked.
 */
export function pickFace(view: DrawingView, faces: BodyFaces, at: Pt, tolMm = 1.5): string | null {
  const k = viewK(view)
  let edgeBest: { id: string; d: number } | null = null
  let areaBest: { id: string; depth: number } | null = null
  for (const [id, tris] of faces.triangles) {
    let area3 = 0, area2 = 0, dmin = Infinity
    for (let i = 0; i + 8 < tris.length; i += 9) {
      const a: DrawingVec3 = [tris[i], tris[i + 1], tris[i + 2]]
      const b: DrawingVec3 = [tris[i + 3], tris[i + 4], tris[i + 5]]
      const c: DrawingVec3 = [tris[i + 6], tris[i + 7], tris[i + 8]]
      area3 += Math.hypot(...cross(sub(b, a), sub(c, a))) / 2
      const sa = modelToSheet(view, a), sb = modelToSheet(view, b), sc = modelToSheet(view, c)
      area2 += Math.abs((sb[0] - sa[0]) * (sc[1] - sa[1]) - (sc[0] - sa[0]) * (sb[1] - sa[1])) / 2
      const bary = barycentric(at, sa, sb, sc)
      if (bary !== null) {
        const depth = dot(sub(a, view.frame.origin), view.frame.towardViewer) * bary[0]
          + dot(sub(b, view.frame.origin), view.frame.towardViewer) * bary[1]
          + dot(sub(c, view.frame.origin), view.frame.towardViewer) * bary[2]
        if (areaBest === null || depth > areaBest.depth + 1e-9) areaBest = { id, depth }
        dmin = 0
      } else {
        dmin = Math.min(dmin, segDist(at, sa, sb), segDist(at, sb, sc), segDist(at, sc, sa))
      }
    }
    const edgeOn = area3 > 0 && area2 / (area3 * k * k) < EDGE_ON_AREA_RATIO
    if (edgeOn && dmin <= tolMm && (edgeBest === null || dmin < edgeBest.d)) edgeBest = { id, d: dmin }
  }
  return edgeBest?.id ?? areaBest?.id ?? null
}

/** The face's triangles on paper, for highlighting a pick. */
export function faceOnSheet(view: DrawingView, faces: BodyFaces, id: string): Pt[][] {
  const tris = faces.triangles.get(id) ?? []
  const out: Pt[][] = []
  for (let i = 0; i + 8 < tris.length; i += 9) {
    out.push([0, 3, 6].map((o) => modelToSheet(view, [tris[i + o], tris[i + o + 1], tris[i + o + 2]])))
  }
  return out
}

function barycentric(p: Pt, a: Pt, b: Pt, c: Pt): [number, number, number] | null {
  const det = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
  if (Math.abs(det) < 1e-12) return null
  const l1 = ((b[1] - c[1]) * (p[0] - c[0]) + (c[0] - b[0]) * (p[1] - c[1])) / det
  const l2 = ((c[1] - a[1]) * (p[0] - c[0]) + (a[0] - c[0]) * (p[1] - c[1])) / det
  const l3 = 1 - l1 - l2
  const e = -1e-9
  return l1 >= e && l2 >= e && l3 >= e ? [l1, l2, l3] : null
}

function segDist(p: Pt, a: Pt, b: Pt): number {
  const ab = sub2(b, a)
  const l2 = ab[0] * ab[0] + ab[1] * ab[1]
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, dot2(sub2(p, a), ab) / l2))
  return Math.hypot(p[0] - a[0] - ab[0] * t, p[1] - a[1] - ab[1] * t)
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

export interface DimensionText {
  main: string
  /** stacked tolerance: upper over lower (deviations or limits) */
  upper?: string
  lower?: string
}

const MM_PER_INCH = 25.4

/** Fewest decimals (at least `min`, at most 4) that show `v` exactly. */
function decimalsFor(v: number, min: number): number {
  for (let d = min; d < 4; d++) if (Math.abs(Number(v.toFixed(d)) - v) < 1e-9) return d
  return 4
}

function signed(v: number, places: number): string {
  const s = Math.abs(v).toFixed(places)
  return v < 0 ? `-${s}` : `+${s}`
}

/**
 * The text a dimension shows, in the sheet's unit. Tolerances stay stored in mm/degrees.
 * `tableValue` is what the sheet's general tolerance table says for this dimension's
 * kind and shown decimals; a general dimension whose pinned value differs from it
 * prints its own +/- so the sheet never implies the table's value.
 */
export function formatDimensionText(
  kind: DrawingMeasurementKind,
  value: number,
  displayUnit: 'mm' | 'inch',
  precision: number,
  tolerance: DrawingToleranceIntent,
  prefix = '',
  suffix = '',
  tableValue?: number,
): DimensionText {
  const isAngle = kind === 'angle'
  const conv = (v: number): number => (isAngle || displayUnit === 'mm' ? v : v / MM_PER_INCH)
  const places = Math.max(0, Math.min(6, Math.round(precision)))
  const symbol = kind === 'radius' ? 'R' : kind === 'diameter' ? '⌀' : ''
  const deg = isAngle ? '°' : ''
  const nominal = `${symbol}${conv(value).toFixed(places)}${deg}`
  const wrap = (s: string): string => `${prefix}${s}${suffix}`
  switch (tolerance.kind) {
    case 'bilateral': {
      const up = conv(tolerance.upper), lo = conv(tolerance.lower)
      const tp = Math.max(decimalsFor(up, places), decimalsFor(lo, places))
      if (Math.abs(up + lo) < 1e-12) return { main: wrap(`${nominal} ±${Math.abs(up).toFixed(tp)}${deg}`) }
      return { main: wrap(nominal), upper: `${signed(up, tp)}${deg}`, lower: `${signed(lo, tp)}${deg}` }
    }
    case 'limits': {
      const up = conv(tolerance.upper), lo = conv(tolerance.lower)
      const tp = Math.max(decimalsFor(up, places), decimalsFor(lo, places))
      return { main: wrap(symbol), upper: `${up.toFixed(tp)}${deg}`, lower: `${lo.toFixed(tp)}${deg}` }
    }
    case 'reference':
      return { main: wrap(`(${nominal})`) }
    case 'general': {
      const pin = tolerance.value
      if (pin === undefined || (tableValue !== undefined && Math.abs(tableValue - pin) < 1e-9)) return { main: wrap(nominal) }
      const v = conv(pin)
      return { main: wrap(`${nominal} ±${v.toFixed(decimalsFor(v, places))}${deg}`) }
    }
    default:
      return { main: wrap(nominal) }
  }
}

// ---------------------------------------------------------------------------
// Edits (each returns a new document; `editedAt` moves to `now`)
// ---------------------------------------------------------------------------

function edited(doc: DrawingDocument, now: string | undefined): DrawingDocument {
  return { ...doc, editedAt: now ?? doc.editedAt }
}

/** An id no annotation, reference or view of the drawing uses: `${prefix}-n`. */
export function nextDrawingItemId(doc: DrawingDocument, prefix: string): string {
  const used = new Set<string>([
    ...doc.annotations.map((a) => a.id),
    ...doc.references.map((r) => r.id),
    ...doc.sheets.flatMap((s) => s.views.map((v) => v.id)),
  ])
  for (let n = 1; ; n++) if (!used.has(`${prefix}-${n}`)) return `${prefix}-${n}`
}

export interface NewDimensionInput {
  kind: DrawingMeasurementKind
  viewId: string
  /** one per face, in pick order; the caller minted them with makeFaceReference */
  references: DrawingReference[]
  labelSheetMm: Pt
  value: number
  revision: SourceRevision
}

/** Add a dimension and its references. It starts with no tolerance and its proved value as last-good. */
export function addDimension(doc: DrawingDocument, input: NewDimensionInput, now?: string): { doc: DrawingDocument; id: string } {
  const id = nextDrawingItemId(doc, 'dim')
  const dim: DrawingDimension = {
    kind: 'dimension',
    id,
    measurement: input.kind,
    referenceIds: input.references.map((r) => r.id),
    viewId: input.viewId,
    labelSheetMm: [...input.labelSheetMm],
    tolerance: { kind: 'none' },
    lastGood: { value: input.value, unit: dimensionUnit(input.kind), measuredAt: input.revision },
  }
  return { doc: edited({ ...doc, references: [...doc.references, ...input.references], annotations: [...doc.annotations, dim] }, now), id }
}

/** Change one annotation's own fields (label place, tolerance, precision, balloon number...). */
export function updateAnnotation(doc: DrawingDocument, id: string, patch: Partial<DrawingDimension> | Partial<DrawingBalloon>, now?: string): DrawingDocument {
  return edited({ ...doc, annotations: doc.annotations.map((a) => (a.id === id ? ({ ...a, ...patch, id: a.id, kind: a.kind } as DrawingAnnotation) : a)) }, now)
}

function dropUnusedReferences(doc: DrawingDocument): DrawingDocument {
  const used = new Set(doc.annotations.flatMap((a) => (a.kind === 'dimension' ? a.referenceIds : a.referenceId ? [a.referenceId] : [])))
  return { ...doc, references: doc.references.filter((r) => used.has(r.id)) }
}

/** Remove annotations; references nothing else uses go with them. */
export function removeAnnotations(doc: DrawingDocument, ids: readonly string[], now?: string): DrawingDocument {
  const gone = new Set(ids)
  return edited(dropUnusedReferences({ ...doc, annotations: doc.annotations.filter((a) => !gone.has(a.id)) }), now)
}

/**
 * Accept a repair: one endpoint of one dimension now names `newRef`. Its
 * tolerance, label place, precision and number are kept; the old and new
 * selectors and the revision are recorded. Other dimensions are untouched.
 */
export function reassociateDimension(doc: DrawingDocument, dimId: string, referenceIndex: number, newRef: DrawingReference, now?: string): DrawingDocument {
  const dim = doc.annotations.find((a): a is DrawingDimension => a.kind === 'dimension' && a.id === dimId)
  if (dim === undefined) return doc
  const oldId = dim.referenceIds[referenceIndex]
  const oldRef = doc.references.find((r) => r.id === oldId)
  if (oldRef === undefined) return doc
  const record: DrawingRepairRecord = {
    ...(now !== undefined ? { at: now } : {}),
    referenceIndex,
    oldReferenceId: oldId,
    newReferenceId: newRef.id,
    oldSelector: oldRef.selector,
    newSelector: newRef.selector,
    revision: newRef.acceptedRevision,
  }
  const referenceIds = dim.referenceIds.map((id, i) => (i === referenceIndex ? newRef.id : id))
  const next: DrawingDocument = {
    ...doc,
    references: [...doc.references, newRef],
    annotations: doc.annotations.map((a) => (a.id === dimId ? { ...dim, referenceIds, repairs: [...(dim.repairs ?? []), record] } : a)),
  }
  return edited(dropUnusedReferences(next), now)
}

/** Opt a dimension into the general tolerance table: it pins the value the table gives now. */
export function generalToleranceFor(doc: DrawingDocument, dim: DrawingDimension, sheetPrecision: number): DrawingToleranceIntent {
  const template = effectiveTemplate(doc.template)
  const precision = dim.precision ?? sheetPrecision
  const value = generalToleranceValue(template.generalTolerances, dim.measurement, precision)
  return { kind: 'general', tableKey: dim.measurement === 'angle' ? 'angular' : String(precision), templateRevision: template.revision, ...(value !== undefined ? { value } : {}) }
}

/** The general tolerance a pinned dimension would take from the table now, when that differs from what it pinned. */
export function generalToleranceUpdate(doc: DrawingDocument, dim: DrawingDimension, sheetPrecision: number): DrawingToleranceIntent | null {
  if (dim.tolerance.kind !== 'general') return null
  const fresh = generalToleranceFor(doc, dim, sheetPrecision)
  if (fresh.kind !== 'general') return null
  return fresh.value === dim.tolerance.value && fresh.tableKey === dim.tolerance.tableKey ? null : fresh
}

/** The next balloon number: one more than the largest on the drawing. */
export function nextBalloonNumber(doc: DrawingDocument): number {
  return doc.annotations.reduce((m, a) => (a.kind === 'balloon' ? Math.max(m, a.number) : m), 0) + 1
}

/** A manual balloon with a sheet anchor (no invented model association). */
export function addBalloon(doc: DrawingDocument, input: { anchorSheetMm: Pt; labelSheetMm: Pt; number?: number; viewId?: string }, now?: string): { doc: DrawingDocument; id: string } {
  const id = nextDrawingItemId(doc, 'balloon')
  const balloon: DrawingBalloon = {
    kind: 'balloon',
    id,
    number: input.number ?? nextBalloonNumber(doc),
    anchorSheetMm: [...input.anchorSheetMm],
    labelSheetMm: [...input.labelSheetMm],
    ...(input.viewId !== undefined ? { viewId: input.viewId } : {}),
  }
  return { doc: edited({ ...doc, annotations: [...doc.annotations, balloon] }, now), id }
}

/** The next detail letter not taken on the drawing: A, B, ... Z, AA, ... */
export function nextDetailLabel(doc: DrawingDocument): string {
  const used = new Set(doc.sheets.flatMap((s) => s.views.map((v) => v.label).filter((l): l is string => l !== undefined)))
  for (let n = 0; ; n++) {
    let label = ''
    let m = n
    do { label = String.fromCharCode(65 + (m % 26)) + label; m = Math.floor(m / 26) - 1 } while (m >= 0)
    if (!used.has(label)) return label
  }
}

export interface NewDetailInput {
  parentViewId: string
  /** crop centre and a point on its circle, picked on the parent view, sheet mm */
  centerSheetMm: Pt
  radiusSheetMm: number
  /** where the detail's centre goes on the sheet */
  placeSheetMm: Pt
  magnification: RationalScale
}

/**
 * A round detail view: the parent's frame, cropped in SOURCE space (centre in
 * model mm, radius in model mm; plan section 4.1), drawn at the parent's
 * scale times its magnification.
 */
export function addDetailView(doc: DrawingDocument, sheetId: string, input: NewDetailInput, now?: string): { doc: DrawingDocument; id: string } {
  const sheet = doc.sheets.find((s) => s.id === sheetId)
  const parent = sheet?.views.find((v) => v.id === input.parentViewId)
  if (sheet === undefined || parent === undefined) return { doc, id: '' }
  const id = nextDrawingItemId(doc, 'detail')
  const { name: _name, ...frame } = parent.frame
  const view: DrawingView = {
    id,
    frame,
    scale: multiplyScale(parent.scale, input.magnification),
    sheetOriginMm: [0, 0],
    showHidden: parent.showHidden,
    label: nextDetailLabel(doc),
    detail: {
      parentViewId: parent.id,
      centerLocalMm: sheetToModel(parent, input.centerSheetMm),
      radiusMm: input.radiusSheetMm / viewK(parent),
      magnification: { ...input.magnification },
    },
  }
  const placed = placeDetail(view, input.placeSheetMm)
  return {
    doc: edited({ ...doc, sheets: doc.sheets.map((s) => (s.id === sheetId ? { ...s, views: [...s.views, placed] } : s)) }, now),
    id,
  }
}

/** Move a detail view so its crop centre sits at `at`. */
export function placeDetail(view: DrawingView, at: Pt): DrawingView {
  if (view.detail === undefined) return view
  const [u, v] = projectPoint(view.frame, view.detail.centerLocalMm)
  const k = viewK(view)
  return { ...view, sheetOriginMm: [at[0] - u * k, at[1] + v * k] }
}

/** Change a detail's magnification, keeping its centre where it is on the sheet. Nominal values never change. */
export function setDetailMagnification(doc: DrawingDocument, viewId: string, magnification: RationalScale, now?: string): DrawingDocument {
  return edited({
    ...doc,
    sheets: doc.sheets.map((s) => ({
      ...s,
      views: s.views.map((v) => {
        if (v.id !== viewId || v.detail === undefined) return v
        const parent = s.views.find((p) => p.id === v.detail?.parentViewId)
        const at = detailCircle(v)?.center
        if (parent === undefined || at === undefined) return v
        return placeDetail({ ...v, scale: multiplyScale(parent.scale, magnification), detail: { ...v.detail, magnification: { ...magnification } } }, at)
      }),
    })),
  }, now)
}

export function moveDetailView(doc: DrawingDocument, viewId: string, at: Pt, now?: string): DrawingDocument {
  return edited({ ...doc, sheets: doc.sheets.map((s) => ({ ...s, views: s.views.map((v) => (v.id === viewId ? placeDetail(v, at) : v)) })) }, now)
}

/** Remove a detail view and the annotations drawn in it, as one edit (Undo brings all back). */
export function removeDetailView(doc: DrawingDocument, viewId: string, now?: string): DrawingDocument {
  const onIt = doc.annotations.filter((a) => (a.kind === 'dimension' || a.kind === 'balloon') && a.viewId === viewId).map((a) => a.id)
  const without = removeAnnotations(doc, onIt, now)
  return { ...without, sheets: without.sheets.map((s) => ({ ...s, views: s.views.filter((v) => v.id !== viewId) })) }
}

/** The sheet's display unit and default precision. Stored values and tolerances are untouched. */
export function setSheetUnits(doc: DrawingDocument, sheetId: string, unit: 'mm' | 'inch', precision: number, now?: string): DrawingDocument {
  return edited({ ...doc, sheets: doc.sheets.map((s) => (s.id === sheetId ? { ...s, unit, precision: Math.max(0, Math.min(4, Math.round(precision))) } : s)) }, now)
}

/** Record proved values as last-good (a cache with provenance, plan 4.2 step 7). Not a drawing edit: `editedAt` stays. */
export function withLastGood(doc: DrawingDocument, updates: ReadonlyArray<{ id: string; value: number; unit: 'mm' | 'deg'; measuredAt: SourceRevision }>): DrawingDocument {
  if (updates.length === 0) return doc
  const byId = new Map(updates.map((u) => [u.id, u]))
  return {
    ...doc,
    annotations: doc.annotations.map((a) => {
      const u = byId.get(a.id)
      return u === undefined || a.kind !== 'dimension' ? a : { ...a, lastGood: { value: u.value, unit: u.unit, measuredAt: u.measuredAt } }
    }),
  }
}

/** True when a proved value differs from what the dimension caches. */
export function lastGoodDiffers(dim: DrawingDimension, value: number, measuredAt: SourceRevision | undefined): boolean {
  const lg = dim.lastGood
  if (lg === undefined) return true
  return Math.abs(lg.value - value) > 1e-9 || lg.measuredAt.geometryFingerprint !== (measuredAt?.geometryFingerprint ?? '')
}

/**
 * The document an Undo/Redo of a drawing edit puts back. The edit's own
 * content comes from `target`; what the PART decided since (observed and
 * last-good revisions, the model-edited date, and a dimension's last-good
 * value while it still names the same faces) stays as it is now, so undoing
 * a tolerance change never rewinds the part.
 */
export function restoreDrawingEdit(target: DrawingDocument, current: DrawingDocument): DrawingDocument {
  const now = new Map(current.annotations.map((a) => [a.id, a]))
  return {
    ...target,
    source: current.source,
    lastGoodRevision: current.lastGoodRevision,
    sourceEditedAt: current.sourceEditedAt,
    editedAt: current.editedAt,
    annotations: target.annotations.map((a) => {
      const c = now.get(a.id)
      if (a.kind !== 'dimension' || c === undefined || c.kind !== 'dimension') return a
      const same = c.referenceIds.length === a.referenceIds.length && c.referenceIds.every((id, i) => id === a.referenceIds[i])
      return same && c.lastGood !== undefined ? { ...a, lastGood: c.lastGood } : a
    }),
  }
}

// ---------------------------------------------------------------------------

function xyz(v: { x: number; y: number; z: number }): DrawingVec3 {
  return [v.x, v.y, v.z]
}
function dot(a: DrawingVec3, b: DrawingVec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
function sub(a: DrawingVec3, b: DrawingVec3): DrawingVec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
function cross(a: DrawingVec3, b: DrawingVec3): DrawingVec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
function unit(a: DrawingVec3): DrawingVec3 {
  const l = Math.hypot(a[0], a[1], a[2])
  return l === 0 ? a : [a[0] / l, a[1] / l, a[2] / l]
}
function dot2(a: Pt, b: Pt): number {
  return a[0] * b[0] + a[1] * b[1]
}
function sub2(a: Pt, b: Pt): Pt {
  return [a[0] - b[0], a[1] - b[1]]
}
function add2(a: Pt, b: Pt): Pt {
  return [a[0] + b[0], a[1] + b[1]]
}
function scale2(a: Pt, k: number): Pt {
  return [a[0] * k, a[1] * k]
}
