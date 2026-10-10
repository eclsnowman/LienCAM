// WO-2192 (workholding assemblies, slice 5): hold-down CLAMPS placed along a
// stock or part edge, the way a contour tab is placed along its loop.
//
// docs/design/WORKHOLDING-ASSEMBLIES.md, "Clamp workflows": a clamp is a
// one-component definition (kind 'clamp') placed by setup-scoped instances.
// A clamp placed on an edge keeps a BOUNDARY anchor on its instance:
//   target { stock | part, id, loopId } + normalized arc fraction
//   + normal offset (mm, outward) + turn (deg).
// Its world pose is computed here from that anchor and written to the
// instance's worldPose (and lastResolvedWorldPose), so the ONE resolver - and
// with it the viewport, CAM keep-out and simulation contact (slice 3) - reads
// the clamp exactly where the edge puts it. When the stock or part changes the
// store re-runs followBoundaryClamps and the clamp follows its edge; when the
// edge is gone the clamp keeps its last pose and its properties say "edge
// reference lost" (product choice A). Nothing here refuses or warns.
//
// The edges ("loops"), all closed, counter-clockwise seen from above, in world
// XY at the top of their body:
//   - a stock (project.stocks): its world box outline, loop id 'outline',
//     starting at its min-X/min-Y corner;
//   - a part with volume (STL/STEP/Model): the outline of its display bounding
//     box at its scene pose seen from above (the convex hull of the eight
//     corners), loop id 'outline';
//   - a flat part (DXF/SVG/sketch): each closed loop at the row's pose, by its
//     own loop id.
// The clamp frame: origin on the edge (plus the offset along the outward
// normal), at the top of the body; +X along the edge (the way the loop runs),
// +Y into the material, +Z up. The turn spins it about Z.

import type {
  ImportedGeometry, PhysicalStock, Project, Vec3, WorkholdingDefinition, WorkholdingInstance,
  WorkholdingModel, WorkholdingPlacement, WorkholdingPose,
} from '../../types'
import { poseToMat4, transformPoint } from './pose'
import { markedRowWorldPose } from './resolveWorkholding'
import { displayBoundingBox } from './shapes'

type ClampProject = Pick<Project, 'geometry' | 'modelItemPlacements' | 'stocks' | 'workholding'>

export type ClampTargetKind = 'stock' | 'part'
export type BoundaryPlacement = Extract<WorkholdingPlacement, { kind: 'boundary' }>
export type BoundaryTarget = BoundaryPlacement['target']

/** The loop id of a stock's box outline and of a solid part's outline. */
export const OUTLINE_LOOP_ID = 'outline'

/** One closed edge a clamp can sit on: world XY points (CCW, not repeated) at height z. */
export interface ClampBoundary {
  readonly target: BoundaryTarget
  /** For the placer and the properties panel: the stock or part name. */
  readonly name: string
  readonly points: ReadonlyArray<{ x: number; y: number }>
  readonly z: number
  /** Total length, mm. */
  readonly length: number
}

// ── Edges ────────────────────────────────────────────────────────────────────

function stockWorldBox(stock: PhysicalStock): { min: Vec3; max: Vec3 } {
  // store/stockAssignment.ts stockWorldBounds: explicit = position + size; derived = bounds as stored.
  if (stock.mode === 'explicit') {
    const p = stock.position
    const s = stock.bounds.size
    return { min: { ...p }, max: { x: p.x + s.x, y: p.y + s.y, z: p.z + s.z } }
  }
  return { min: { ...stock.bounds.min }, max: { ...stock.bounds.max } }
}

function signedArea(points: ReadonlyArray<{ x: number; y: number }>): number {
  let a = 0
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const q = points[(i + 1) % points.length]
    a += p.x * q.y - q.x * p.y
  }
  return a / 2
}

function loopLength(points: ReadonlyArray<{ x: number; y: number }>): number {
  let l = 0
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const q = points[(i + 1) % points.length]
    l += Math.hypot(q.x - p.x, q.y - p.y)
  }
  return l
}

/** Counter-clockwise, with repeated points (and a repeated closing point) removed. */
function cleanLoop(points: ReadonlyArray<{ x: number; y: number }>): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = []
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue
    const last = out[out.length - 1]
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 1e-9) out.push({ x: p.x, y: p.y })
  }
  while (out.length > 1 && Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) <= 1e-9) out.pop()
  return signedArea(out) < 0 ? out.reverse() : out
}

/** Andrew's monotone chain: the convex hull, counter-clockwise, starting at min X (then min Y). */
function convexHull(points: ReadonlyArray<{ x: number; y: number }>): Array<{ x: number; y: number }> {
  const pts = [...points].sort((a, b) => (a.x - b.x) || (a.y - b.y))
  if (pts.length < 3) return pts
  const cross = (o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const lower: Array<{ x: number; y: number }> = []
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 1e-9) lower.pop()
    lower.push(p)
  }
  const upper: Array<{ x: number; y: number }> = []
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 1e-9) upper.pop()
    upper.push(p)
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)]
}

function boundary(target: BoundaryTarget, name: string, points: ReadonlyArray<{ x: number; y: number }>, z: number): ClampBoundary | null {
  const clean = cleanLoop(points)
  const length = loopLength(clean)
  if (clean.length < 3 || !(length > 0) || !Number.isFinite(z)) return null
  return { target, name, points: clean, z, length }
}

function stockBoundary(stock: PhysicalStock): ClampBoundary | null {
  const { min, max } = stockWorldBox(stock)
  if (!(max.x > min.x && max.y > min.y)) return null
  return boundary(
    { kind: 'stock', id: stock.id, loopId: OUTLINE_LOOP_ID }, stock.name || 'Stock',
    [{ x: min.x, y: min.y }, { x: max.x, y: min.y }, { x: max.x, y: max.y }, { x: min.x, y: max.y }], max.z,
  )
}

/** Rows a part edge can be on: not workholding, not a nest's own copy, not a clamp or vise shape. */
function isClampablePart(row: ImportedGeometry, componentRows: ReadonlySet<string>): boolean {
  return row.workholding !== true && !row.ownerNestId && !componentRows.has(row.id)
}

function partBoundaries(row: ImportedGeometry, project: ClampProject): ClampBoundary[] {
  const pose = markedRowWorldPose(row, project.modelItemPlacements ?? [])
  if (!pose) return []
  const m = poseToMat4(pose)
  const box = displayBoundingBox(row)
  const name = row.name || row.id
  if (box) {
    const corners: Vec3[] = []
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
      corners.push(transformPoint(m, { x, y, z }))
    }
    const b = boundary(
      { kind: 'part', id: row.id, loopId: OUTLINE_LOOP_ID }, name,
      convexHull(corners), Math.max(...corners.map((c) => c.z)),
    )
    return b ? [b] : []
  }
  const out: ClampBoundary[] = []
  for (const loop of row.loops ?? []) {
    if (!loop.closed || loop.points.length < 3) continue
    const pts = loop.points.map((p) => transformPoint(m, { x: p.x, y: p.y, z: 0 }))
    const b = boundary(
      { kind: 'part', id: row.id, loopId: loop.id }, loop.name ? `${name} - ${loop.name}` : name,
      pts, Math.max(...pts.map((p) => p.z)),
    )
    if (b) out.push(b)
  }
  return out
}

function shapeRows(model: WorkholdingModel | undefined): Set<string> {
  return new Set((model?.definitions ?? []).flatMap((d) => d.components.map((c) => c.geometryId)))
}

/** Every edge of `kind` a clamp can be placed on. */
export function clampBoundaries(project: ClampProject, kind: ClampTargetKind): ClampBoundary[] {
  if (kind === 'stock') {
    return (project.stocks ?? []).map(stockBoundary).filter((b): b is ClampBoundary => b !== null)
  }
  const shapes = shapeRows(project.workholding)
  return project.geometry.filter((g) => isClampablePart(g, shapes)).flatMap((g) => partBoundaries(g, project))
}

/** The edge an anchor names, or null when it is gone (the stock, part or loop no longer exists). */
export function resolveClampBoundary(project: ClampProject, target: BoundaryTarget): ClampBoundary | null {
  if (target.kind === 'stock') {
    const stock = (project.stocks ?? []).find((s) => s.id === target.id)
    const b = stock ? stockBoundary(stock) : null
    return b && b.target.loopId === target.loopId ? b : null
  }
  const row = project.geometry.find((g) => g.id === target.id)
  if (!row || !isClampablePart(row, shapeRows(project.workholding))) return null
  return partBoundaries(row, project).find((b) => b.target.loopId === target.loopId) ?? null
}

// ── Along an edge ────────────────────────────────────────────────────────────

/** A fraction brought into [0, 1): a slide past the loop's start comes round again. */
export function wrapFraction(f: number): number {
  if (!Number.isFinite(f)) return 0
  const w = f - Math.floor(f)
  return w >= 1 ? 0 : w
}

export interface BoundaryPoint {
  readonly x: number
  readonly y: number
  /** Unit direction the loop runs at this point. */
  readonly tangent: { x: number; y: number }
  /** Unit outward normal (away from the material). */
  readonly normal: { x: number; y: number }
}

/** The point at `fraction` of the loop's length from its start, with its direction. */
export function pointAtFraction(b: ClampBoundary, fraction: number): BoundaryPoint {
  let s = wrapFraction(fraction) * b.length
  const n = b.points.length
  for (let i = 0; i < n; i++) {
    const p = b.points[i]
    const q = b.points[(i + 1) % n]
    const len = Math.hypot(q.x - p.x, q.y - p.y)
    if (len <= 0) continue
    if (s <= len || i === n - 1) {
      const t = Math.min(1, Math.max(0, s / len))
      const tx = (q.x - p.x) / len
      const ty = (q.y - p.y) / len
      return { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t, tangent: { x: tx, y: ty }, normal: { x: ty, y: -tx } }
    }
    s -= len
  }
  const p = b.points[0]
  return { x: p.x, y: p.y, tangent: { x: 1, y: 0 }, normal: { x: 0, y: -1 } }
}

/** The nearest point of the loop to `at` (world XY): its fraction and distance. */
export function nearestFraction(b: ClampBoundary, at: { x: number; y: number }): { fraction: number; distance: number } {
  let best = { fraction: 0, distance: Infinity }
  let walked = 0
  const n = b.points.length
  for (let i = 0; i < n; i++) {
    const p = b.points[i]
    const q = b.points[(i + 1) % n]
    const dx = q.x - p.x
    const dy = q.y - p.y
    const len2 = dx * dx + dy * dy
    const len = Math.sqrt(len2)
    if (len2 > 0) {
      const t = Math.min(1, Math.max(0, ((at.x - p.x) * dx + (at.y - p.y) * dy) / len2))
      const d = Math.hypot(p.x + dx * t - at.x, p.y + dy * t - at.y)
      if (d < best.distance) best = { fraction: wrapFraction((walked + t * len) / b.length), distance: d }
    }
    walked += len
  }
  return best
}

/** The nearest edge point among `boundaries`, or null when there is none. */
export function nearestBoundaryPoint(
  boundaries: readonly ClampBoundary[],
  at: { x: number; y: number },
): { boundary: ClampBoundary; fraction: number; distance: number } | null {
  let best: { boundary: ClampBoundary; fraction: number; distance: number } | null = null
  for (const b of boundaries) {
    const hit = nearestFraction(b, at)
    if (!best || hit.distance < best.distance) best = { boundary: b, ...hit }
  }
  return best
}

const deg = (rad: number) => {
  const d = (rad * 180) / Math.PI
  return Object.is(d, -0) ? 0 : d
}

/** Where a clamp anchored at `fraction` of `b` sits: on the edge, `normalOffsetMm` outward, turned by the edge + `yawOffsetDeg`. */
export function clampPoseOnBoundary(
  b: ClampBoundary,
  fraction: number,
  normalOffsetMm: number,
  yawOffsetDeg: number,
): WorkholdingPose {
  const at = pointAtFraction(b, fraction)
  const off = Number.isFinite(normalOffsetMm) ? normalOffsetMm : 0
  const turn = Number.isFinite(yawOffsetDeg) ? yawOffsetDeg : 0
  return {
    position: { x: at.x + at.normal.x * off, y: at.y + at.normal.y * off, z: b.z },
    rotation: { x: 0, y: 0, z: deg(Math.atan2(at.tangent.y, at.tangent.x)) + turn },
  }
}

// ── Definitions and instances ────────────────────────────────────────────────

/** Bodies a clamp can be made from: marked workholding, not already some definition's shape, with volume. */
export function clampBodyCandidates(geometry: readonly ImportedGeometry[], model: WorkholdingModel | undefined): ImportedGeometry[] {
  const shapes = shapeRows(model)
  return geometry.filter((g) => g.workholding === true && !shapes.has(g.id) && displayBoundingBox(g) !== null)
}

/**
 * A clamp definition made from one body. The body keeps the turn it has in the
 * scene; its bounding box is centred on the clamp origin in X and Y, bottom on
 * the clamp's Z 0 - so a clamp on an edge straddles the edge, resting on top.
 * Null when the body is not in the project or has no place or no volume.
 */
export function buildClampDefinition(
  project: Pick<Project, 'geometry' | 'modelItemPlacements'>,
  geometryId: string,
  name: string | undefined,
  definitionId: string,
): WorkholdingDefinition | null {
  const row = project.geometry.find((g) => g.id === geometryId)
  const box = row ? displayBoundingBox(row) : null
  const pose = row ? markedRowWorldPose(row, project.modelItemPlacements ?? []) : null
  if (!row || !box || !pose) return null
  const turnOnly = poseToMat4({ position: { x: 0, y: 0, z: 0 }, rotation: pose.rotation })
  const lo = { x: Infinity, y: Infinity, z: Infinity }
  const hi = { x: -Infinity, y: -Infinity, z: -Infinity }
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
    const p = transformPoint(turnOnly, { x, y, z })
    lo.x = Math.min(lo.x, p.x); lo.y = Math.min(lo.y, p.y); lo.z = Math.min(lo.z, p.z)
    hi.x = Math.max(hi.x, p.x); hi.y = Math.max(hi.y, p.y); hi.z = Math.max(hi.z, p.z)
  }
  return {
    id: definitionId,
    revision: 1,
    name: name?.trim() || row.name || 'Clamp',
    kind: 'clamp',
    components: [{
      id: 'body',
      name: row.name || 'Clamp body',
      geometryId: row.id,
      localPose: {
        position: { x: -(lo.x + hi.x) / 2, y: -(lo.y + hi.y) / 2, z: -lo.z },
        rotation: { ...pose.rotation },
      },
    }],
  }
}

/** The clamp's length along the edge (its footprint along clamp X), mm; 0 when unknown. */
export function clampWidthAlongEdge(project: Pick<Project, 'geometry'>, definition: WorkholdingDefinition): number {
  let lo = Infinity
  let hi = -Infinity
  for (const component of definition.components) {
    const row = project.geometry.find((g) => g.id === component.geometryId)
    const box = row ? displayBoundingBox(row) : null
    if (!box) continue
    const m = poseToMat4(component.localPose)
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
      const p = transformPoint(m, { x, y, z })
      lo = Math.min(lo, p.x); hi = Math.max(hi, p.x)
    }
  }
  return hi > lo ? hi - lo : 0
}

export function isClampDefinition(d: WorkholdingDefinition | undefined): boolean {
  return d?.kind === 'clamp'
}

/** Every clamp definition, with its placed instances (in instance order). */
export function clampDefinitions(model: WorkholdingModel | undefined): Array<{
  definition: WorkholdingDefinition; instances: WorkholdingInstance[]
}> {
  return (model?.definitions ?? []).filter(isClampDefinition).map((definition) => ({
    definition,
    instances: (model?.instances ?? []).filter((i) => i.definitionId === definition.id),
  }))
}

/** One placed clamp and its definition, or null when `instanceId` is not a clamp. */
export function clampInstance(model: WorkholdingModel | undefined, instanceId: string | null | undefined): {
  instance: WorkholdingInstance; definition: WorkholdingDefinition
} | null {
  const instance = model?.instances.find((i) => i.id === instanceId)
  const definition = model?.definitions.find((d) => d.id === instance?.definitionId)
  return instance && definition && isClampDefinition(definition) ? { instance, definition } : null
}

/** True when a clamp's edge is gone: it keeps its last pose, and its properties say so. */
export function clampEdgeLost(project: ClampProject, instance: WorkholdingInstance): boolean {
  const p = instance.placement
  return p?.kind === 'boundary' && resolveClampBoundary(project, p.target) === null
}

/** A boundary anchor and the pose it resolves to (worldPose = lastResolvedWorldPose). */
export function anchorOnBoundary(
  b: ClampBoundary,
  fraction: number,
  normalOffsetMm: number,
  yawOffsetDeg: number,
): { placement: BoundaryPlacement; worldPose: WorkholdingPose } {
  const f = wrapFraction(fraction)
  const worldPose = clampPoseOnBoundary(b, f, normalOffsetMm, yawOffsetDeg)
  return {
    worldPose,
    placement: {
      kind: 'boundary',
      target: { ...b.target },
      fraction: f,
      normalOffsetMm: Number.isFinite(normalOffsetMm) ? normalOffsetMm : 0,
      yawOffsetDeg: Number.isFinite(yawOffsetDeg) ? yawOffsetDeg : 0,
      lastResolvedWorldPose: worldPose,
    },
  }
}

/** An anchored instance moved to a new fraction / offset / turn on its own edge; null when the edge is gone. */
export function reanchor(
  project: ClampProject,
  instance: WorkholdingInstance,
  patch: { fraction?: number; normalOffsetMm?: number; yawOffsetDeg?: number },
): WorkholdingInstance | null {
  const p = instance.placement
  if (p?.kind !== 'boundary') return null
  const b = resolveClampBoundary(project, p.target)
  if (!b) return null
  const { placement, worldPose } = anchorOnBoundary(
    b, patch.fraction ?? p.fraction, patch.normalOffsetMm ?? p.normalOffsetMm, patch.yawOffsetDeg ?? p.yawOffsetDeg,
  )
  return { ...instance, placement, worldPose }
}

function samePose(a: WorkholdingPose | undefined, b: WorkholdingPose | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

const near = (a: number, b: number) => Math.abs(a - b) <= 1e-9

/** True when two anchored clamps sit at the same place on the same edge (to a nanometre). */
export function sameClampPlace(a: WorkholdingInstance, b: WorkholdingInstance): boolean {
  const p = a.placement
  const q = b.placement
  if (p?.kind !== 'boundary' || q?.kind !== 'boundary') return JSON.stringify(a) === JSON.stringify(b)
  const u = a.worldPose
  const v = b.worldPose
  return JSON.stringify(p.target) === JSON.stringify(q.target) &&
    near(p.normalOffsetMm, q.normalOffsetMm) && near(p.yawOffsetDeg, q.yawOffsetDeg) &&
    near(u.position.x, v.position.x) && near(u.position.y, v.position.y) && near(u.position.z, v.position.z) &&
    near(u.rotation.x, v.rotation.x) && near(u.rotation.y, v.rotation.y) && near(u.rotation.z, v.rotation.z)
}

/**
 * Every edge-anchored clamp put back on its edge: the model with each moved
 * clamp's worldPose and lastResolvedWorldPose rewritten, or the SAME model
 * when every clamp is already where its edge puts it (or its edge is gone -
 * then it keeps its last pose).
 */
export function followBoundaryClamps(project: ClampProject): WorkholdingModel | undefined {
  const model = project.workholding
  if (!model?.instances.some((i) => i.placement?.kind === 'boundary')) return model
  let changed = false
  const instances = model.instances.map((instance) => {
    const next = reanchor(project, instance, {})
    if (!next || (samePose(next.worldPose, instance.worldPose) && samePose(
      (next.placement as BoundaryPlacement).lastResolvedWorldPose,
      (instance.placement as BoundaryPlacement).lastResolvedWorldPose,
    ))) return instance
    changed = true
    return next
  })
  return changed ? { ...model, instances } : model
}
