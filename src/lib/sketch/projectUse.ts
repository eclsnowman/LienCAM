// Project / Use source resolution and commits.
//
// The shared tool accepts four source kinds through one atomic candidate contract. CAM keeps
// producing one baked layer loop; model projection can provide one open edge or a face's grouped
// outer + hole loops, or one picked model vertex. A candidate is committed all-or-nothing and
// every refusal is named.
//
// WO-1864: the commit built here is fixed geometry. At the commit site a MODEL candidate's pieces
// are then stamped with a live link to their source (projectLink.linkProjectedEntities), which the
// workbench regen pass follows when the model changes. A CAM layer loop stays a static copy.

import type { ImportedGeometry, Loop2D, Vec2 } from '../../types'
import type { FixConstraint, SketchConstraint, SketchEntity } from './types'
import { liftLoops } from './lift'

/** Runtime source of truth. Tests census this value, so adding a kind cannot silently miss a case. */
export const PROJECT_SOURCE_KINDS = [
  'cam-layer-loop',
  'model-face',
  'model-edge',
  'model-vertex',
] as const

export type ProjectSourceKind = (typeof PROJECT_SOURCE_KINDS)[number]

/** Cache identity carried by model candidates. CAM layer loops do not need one. */
export interface ProjectSourceIdentity {
  bodyId: string
  cacheVersion: number
  stableId: string
}

/** Full hover/click promise for one revision of one source pick. */
export interface ExpectedProjectSource {
  stablePickKey: string
  sourceIdentity: ProjectSourceIdentity
}

export interface ProjectCandidate {
  /** Paths committed atomically. A face supplies outer + holes; an edge supplies one open path. */
  paths: readonly Loop2D[]
  /** Point sources committed atomically. Model vertex picks currently supply exactly one. */
  points?: readonly Vec2[]
  sourceKind: ProjectSourceKind
  sourceLabel: string
  /** Stable hover/click identity within the source revision. */
  stablePickKey: string
  sourceIdentity?: ProjectSourceIdentity
  /** WO-1865: a model EDGE's own polyline in sketch-local 3D (x, y in the plane, z = height
   *  above it), so a Pierce pick can find where the edge crosses the plane. Model edges only. */
  pierceEdge?: ReadonlyArray<{ x: number; y: number; z: number }>
}

export type ProjectResolveResult =
  | { ok: true; candidate: ProjectCandidate }
  | { ok: false; reason: string; message: string }

export function projectRefusal(reason: string, message: string): ProjectResolveResult {
  return { ok: false, reason, message }
}

/** True when a layer's loops may be consumed by the project tool from the given sketch. */
export function isProjectableLayer(
  geo: ImportedGeometry,
  layer: { id: string; visible: boolean; projectionPlane?: unknown },
  activeSketchLayerId: string | null,
): boolean {
  if (geo.format !== 'dxf' && geo.format !== 'svg' && geo.format !== 'sketch') return false
  if (layer.projectionPlane) return false
  if (!layer.visible) return false
  if (layer.id === activeSketchLayerId) return false
  return true
}

/** Every CAM loop the project tool may hover/click, with its owning layer. */
export function projectCandidates(
  geometry: readonly ImportedGeometry[],
  activeSketchLayerId: string | null,
): ProjectCandidate[] {
  const out: ProjectCandidate[] = []
  for (const geo of geometry) {
    for (const layer of geo.layers2d ?? []) {
      if (!isProjectableLayer(geo, layer, activeSketchLayerId)) continue
      for (const loop of geo.loops ?? []) {
        if (loop.layerId !== layer.id) continue
        out.push({
          paths: [loop],
          sourceKind: 'cam-layer-loop',
          sourceLabel: layer.name,
          stablePickKey: `cam-layer-loop:${layer.id}:${loop.id}`,
        })
      }
    }
  }
  return out
}

function segDist(a: Vec2, b: Vec2, p: Vec2): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 < 1e-18) return Math.hypot(p.x - a.x, p.y - a.y)
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

/** Distance from p to a path's rendered polyline (including its closing edge when closed). */
export function loopDistance(loop: Loop2D, p: Vec2): number {
  const pts = loop.points
  if (pts.length === 0) return Infinity
  if (pts.length === 1) return Math.hypot(p.x - pts[0].x, p.y - pts[0].y)
  let best = Infinity
  const last = loop.closed ? pts.length : pts.length - 1
  for (let i = 0; i < last; i++) {
    best = Math.min(best, segDist(pts[i], pts[(i + 1) % pts.length], p))
  }
  return best
}

/** Nearest atomic candidate within tol of the cursor, or a named miss. */
export function resolveProjectHit(
  candidates: readonly ProjectCandidate[],
  world: Vec2,
  tol: number,
): ProjectResolveResult {
  if (![world.x, world.y, tol].every(Number.isFinite) || tol < 0) {
    return projectRefusal('invalid-pointer', 'Project: pointer or tolerance is not finite')
  }
  let best: ProjectCandidate | null = null
  let bestD = tol
  for (const candidate of candidates) {
    for (const path of candidate.paths) {
      const d = loopDistance(path, world)
      if (d <= bestD) {
        bestD = d
        best = candidate
      }
    }
  }
  return best === null
    ? projectRefusal('miss', 'Project: click a loop on another visible layer')
    : { ok: true, candidate: best }
}

/** Preview outline for one open/closed path. */
export function loopOutline(loop: Loop2D): Vec2[] {
  const pts = loop.points.map((p) => ({ x: p.x, y: p.y }))
  if (loop.closed && pts.length > 1) pts.push({ x: pts[0].x, y: pts[0].y })
  return pts
}

/** Disconnected preview paths for one atomic candidate. Points use a small cross in the same
 * project-preview color as curves, sized from the caller's screen-derived world tolerance. */
export function projectPreviewPaths(candidate: ProjectCandidate, pointMarkerHalfSize = 0.5): Vec2[][] {
  const markerHalfSize = Number.isFinite(pointMarkerHalfSize) && pointMarkerHalfSize > 0
    ? pointMarkerHalfSize
    : 0.5
  return [
    ...candidate.paths.map(loopOutline),
    ...(candidate.points ?? []).flatMap((point) => [
      [
        { x: point.x - markerHalfSize, y: point.y },
        { x: point.x + markerHalfSize, y: point.y },
      ],
      [
        { x: point.x, y: point.y - markerHalfSize },
        { x: point.x, y: point.y + markerHalfSize },
      ],
    ]),
  ]
}

export interface ProjectCommit {
  entities: SketchEntity[]
  constraints: SketchConstraint[]
}

export type ProjectCommitResult =
  | { ok: true; commit: ProjectCommit }
  | { ok: false; reason: 'empty-path-group' | 'invalid-coordinate' | 'unliftable-path'; message: string }

function pathHasFiniteCoordinates(path: Loop2D): boolean {
  if (!path.points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))) return false
  return (path.segments ?? []).every((segment) =>
    Number.isFinite(segment.to.x)
    && Number.isFinite(segment.to.y)
    && (segment.type === 'line'
      || (Number.isFinite(segment.center.x)
        && Number.isFinite(segment.center.y)
        && Number.isFinite(segment.radius)
        && segment.radius > 0)),
  )
}

/** Convert every candidate path/point atomically into fixed sketch entities. */
export function buildProjectCommit(
  candidate: ProjectCandidate,
  construction: boolean,
  newId: () => string = () => crypto.randomUUID(),
): ProjectCommitResult {
  const points = candidate.points ?? []
  if (candidate.paths.length === 0 && points.length === 0) {
    return { ok: false, reason: 'empty-path-group', message: 'Project: source has no projectable geometry' }
  }
  const invalid = candidate.paths.find((path) => !pathHasFiniteCoordinates(path))
  if (invalid) {
    return {
      ok: false,
      reason: 'invalid-coordinate',
      message: `Project: path "${invalid.id}" contains an invalid coordinate`,
    }
  }
  if (!points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))) {
    return {
      ok: false,
      reason: 'invalid-coordinate',
      message: `Project: source "${candidate.sourceLabel}" contains an invalid point coordinate`,
    }
  }
  const lifted = liftLoops([...candidate.paths], { newId })
  if (
    candidate.paths.length > 0
    && (lifted.entities.length === 0 || lifted.liftedLoops !== candidate.paths.length)
  ) {
    return {
      ok: false,
      reason: 'unliftable-path',
      message: `Project: source "${candidate.sourceLabel}" has an unliftable path`,
    }
  }
  const entities: SketchEntity[] = [
    ...points.map((point): SketchEntity => ({
      id: newId(),
      kind: 'point',
      construction,
      provenance: 'projected',
      at: { x: point.x, y: point.y },
    })),
    ...lifted.entities.map((entity): SketchEntity => ({
      ...entity,
      construction,
      provenance: 'projected',
    })),
  ]
  const fixes: FixConstraint[] = entities.map((entity) => ({
    id: newId(),
    kind: 'fix',
    entityId: entity.id,
    projectionGrounding: true,
  }))
  // Fix-per-entity grounds every copy (unchanged); lifted.constraints additionally ties
  // adjacent entities together at each original chain joint, so an edit that frees one
  // entity's Fix (e.g. chamfer) does not leave its untouched neighbor's joint free to
  // separate (WO-1476 -- liftLoops already computes these, buildProjectCommit just
  // discarded them).
  const constraints: SketchConstraint[] = [...fixes, ...lifted.constraints]
  return { ok: true, commit: { entities, constraints } }
}
