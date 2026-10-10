import type { Loop2D } from '../../../types'
import type {
  ExpectedProjectSource,
  ProjectCandidate,
  ProjectResolveResult,
  ProjectSourceIdentity,
} from '../../../lib/sketch/projectUse'
import type { FeatureDag } from '../../../doc'
import { parseStableId } from '../../../doc/stable-id'
import { resolvePersistedEdgeId } from '../../../geom/worker/stable-id'
import { edgePlaneCrossing, type PierceCrossing, type ProjectionSourceGeometry, type SketchLocal3 } from '../../../lib/sketch/projectLink'
import type { SketchPierceSource, SketchProjectionLink, Vec2 as SketchVec2 } from '../../../lib/sketch/types'
import { bodyFeatureIds, resolveBodyTargetLineage } from '../bodyLineage'
import { vDot, vSub, vUnit, worldToLocal, type PlaneFrame } from '../../../sketch3d/planeMath'
import type { CachedBody } from '../../../viewport3d/GeometryCache'
import type {
  BodyId,
  BridgeVertexRef,
  EdgePickHit,
  FacePickHit,
  PickHit,
  PickThresholds,
  RayLike,
  StableId,
  VertexPickHit,
} from '../../../viewport3d/types'
import { edgeIdCollisionMessage, edgeIdCollisions } from '../measure/edgeIdCollisions'
import { edgePolyline, faceBoundaryLoops } from './faceBoundary'

/** Runtime completeness source: resolver code and tests both iterate this list. */
export const PROJECT_VISIBILITY_SOURCES = [
  'live-body',
  'tree-eye',
  'hidden-body',
  'isolate-body',
  'hidden-face',
  'isolate-face',
] as const

export type ProjectVisibilitySource = (typeof PROJECT_VISIBILITY_SOURCES)[number]

/** Runtime completeness source for hostile host-input validation tests. */
export const PROJECT_INPUT_VALIDATION_CLASSES = [
  'plane-non-finite',
  'plane-degenerate',
  'edge-threshold',
  'vertex-threshold',
  'visibility-body-ids',
  'visibility-live-body-ids',
  'visibility-tree-visible',
  'visibility-hidden-body-ids',
  'visibility-hidden-face-ids',
  'visibility-isolate-body-ids',
  'visibility-isolate-face-ids',
] as const

export type ProjectInputValidationClass = (typeof PROJECT_INPUT_VALIDATION_CLASSES)[number]

export interface ProjectGeometryVisibility {
  /** Candidate universe before liveness/visibility filters. */
  bodyIds: readonly BodyId[]
  /** Leaf bodies that still own a current cache entry; stale ancestors are absent. */
  liveBodyIds: ReadonlySet<BodyId>
  /** Tree eye state. Missing entries mean visible, matching the workbench. */
  treeVisible: ReadonlyMap<BodyId, boolean>
  hiddenBodyIds: ReadonlySet<BodyId>
  hiddenFaceIds: ReadonlySet<StableId>
  isolate: { bodyIds: ReadonlySet<BodyId>; faceIds: ReadonlySet<StableId> } | null
}

export interface ProjectGeometryCache {
  get(bodyId: BodyId): CachedBody | undefined
}

export interface ProjectGeometryPicker {
  pick(
    bodyId: BodyId,
    ray: RayLike,
    filter: 'edge' | 'face',
    thresholds?: PickThresholds,
  ): PickHit | null
  /** Optional point-granularity capability. Kept separate so existing edge/face adapters remain
   * source-compatible while workbench PickEngine adapters can opt into Project/Use points. */
  pickVertex?(
    bodyId: BodyId,
    ray: RayLike,
    thresholds?: PickThresholds,
  ): PickHit | null
}

export interface ResolveProjectGeometryInput {
  frame: PlaneFrame
  cache: ProjectGeometryCache
  picker: ProjectGeometryPicker
  ray: RayLike
  visibility: ProjectGeometryVisibility
  thresholds?: PickThresholds
  /** World-mm ray-depth tolerance allowing a rim edge to tie its front face. */
  edgeDepthTolerance?: number
  /** Hover identity promised before a click. A changed key/version refuses. */
  expectedSource?: ExpectedProjectSource
  /** WO-1865: a Pierce pick. Only model EDGES are candidates, and an edge seen end-on (its
   *  projection collapses to a point -- the natural pierce: an edge square to the sketch plane)
   *  is a valid pick, since a pierce uses the edge's 3D polyline, not its projection. */
  pierce?: boolean
}

type Vec3 = { x: number; y: number; z: number }

const DEFAULT_EDGE_DEPTH_TOLERANCE = 1e-4
const FRAME_DEGENERATE_EPS = 1e-12

function refusal(reason: string, message: string): ProjectResolveResult {
  return { ok: false, reason, message }
}

function finiteVec3Value(value: unknown): value is { x: number; y: number; z: number } {
  if (typeof value !== 'object' || value === null) return false
  try {
    const point = value as { x?: unknown; y?: unknown; z?: unknown }
    return typeof point.x === 'number' && Number.isFinite(point.x)
      && typeof point.y === 'number' && Number.isFinite(point.y)
      && typeof point.z === 'number' && Number.isFinite(point.z)
  } catch {
    return false
  }
}

function validPlaneFrame(frame: unknown): boolean {
  if (typeof frame !== 'object' || frame === null) return false
  try {
    const value = frame as Partial<PlaneFrame>
    if (!finiteVec3Value(value.origin) || !finiteVec3Value(value.normal) || !finiteVec3Value(value.xDir)) return false
    const normalLength = Math.hypot(value.normal.x, value.normal.y, value.normal.z)
    const xDirLength = Math.hypot(value.xDir.x, value.xDir.y, value.xDir.z)
    if (normalLength <= FRAME_DEGENERATE_EPS || xDirLength <= FRAME_DEGENERATE_EPS) return false
    const crossX = value.normal.y * value.xDir.z - value.normal.z * value.xDir.y
    const crossY = value.normal.z * value.xDir.x - value.normal.x * value.xDir.z
    const crossZ = value.normal.x * value.xDir.y - value.normal.y * value.xDir.x
    return Math.hypot(crossX, crossY, crossZ) > FRAME_DEGENERATE_EPS * normalLength * xDirLength
  } catch {
    return false
  }
}

function readableStringSet(value: unknown): value is ReadonlySet<string> {
  try {
    if (!(value instanceof Set)) return false
    for (const entry of value) {
      if (typeof entry !== 'string' || entry.length === 0) return false
    }
    return Number.isSafeInteger(value.size) && value.size >= 0
  } catch {
    return false
  }
}

function readableVisibility(value: unknown): value is ProjectGeometryVisibility {
  if (typeof value !== 'object' || value === null) return false
  try {
    const visibility = value as Partial<ProjectGeometryVisibility>
    if (!Array.isArray(visibility.bodyIds)
      || !visibility.bodyIds.every((id) => typeof id === 'string' && id.length > 0)
      || !readableStringSet(visibility.liveBodyIds)
      || !(visibility.treeVisible instanceof Map)
      || !readableStringSet(visibility.hiddenBodyIds)
      || !readableStringSet(visibility.hiddenFaceIds)) return false
    for (const [id, shown] of visibility.treeVisible) {
      if (typeof id !== 'string' || id.length === 0 || typeof shown !== 'boolean') return false
    }
    if (visibility.isolate === null) return true
    if (typeof visibility.isolate !== 'object' || visibility.isolate === null) return false
    return readableStringSet(visibility.isolate.bodyIds) && readableStringSet(visibility.isolate.faceIds)
  } catch {
    return false
  }
}

function invalidProjectInput(input: ResolveProjectGeometryInput): ProjectInputValidationClass | null {
  if (!validPlaneFrame(input.frame)) {
    try {
      const frame = input.frame as Partial<PlaneFrame> | null | undefined
      const allFinite = frame !== null && frame !== undefined
        && finiteVec3Value(frame.origin) && finiteVec3Value(frame.normal) && finiteVec3Value(frame.xDir)
      return allFinite ? 'plane-degenerate' : 'plane-non-finite'
    } catch {
      return 'plane-non-finite'
    }
  }
  if (input.thresholds !== undefined) {
    try {
      if (!Number.isFinite(input.thresholds.edge) || input.thresholds.edge <= 0) return 'edge-threshold'
      if (!Number.isFinite(input.thresholds.vertex) || input.thresholds.vertex <= 0) return 'vertex-threshold'
    } catch {
      return 'edge-threshold'
    }
  }
  if (!readableVisibility(input.visibility)) {
    const visibility = input.visibility as Partial<ProjectGeometryVisibility> | null | undefined
    try {
      if (visibility === null || visibility === undefined || !Array.isArray(visibility.bodyIds)
        || !visibility.bodyIds.every((id) => typeof id === 'string' && id.length > 0)) return 'visibility-body-ids'
      if (!readableStringSet(visibility.liveBodyIds)) return 'visibility-live-body-ids'
      if (!(visibility.treeVisible instanceof Map)) return 'visibility-tree-visible'
      for (const [id, shown] of visibility.treeVisible) {
        if (typeof id !== 'string' || id.length === 0 || typeof shown !== 'boolean') return 'visibility-tree-visible'
      }
      if (!readableStringSet(visibility.hiddenBodyIds)) return 'visibility-hidden-body-ids'
      if (!readableStringSet(visibility.hiddenFaceIds)) return 'visibility-hidden-face-ids'
      if (visibility.isolate === null) return null
      if (typeof visibility.isolate !== 'object' || visibility.isolate === null
        || !readableStringSet(visibility.isolate.bodyIds)) return 'visibility-isolate-body-ids'
      if (!readableStringSet(visibility.isolate.faceIds)) return 'visibility-isolate-face-ids'
    } catch {
      return 'visibility-body-ids'
    }
  }
  return null
}

function bodyExcludedBy(
  source: ProjectVisibilitySource,
  bodyId: BodyId,
  visibility: ProjectGeometryVisibility,
): boolean {
  switch (source) {
    case 'live-body': return !visibility.liveBodyIds.has(bodyId)
    case 'tree-eye': return visibility.treeVisible.get(bodyId) === false
    case 'hidden-body': return visibility.hiddenBodyIds.has(bodyId)
    case 'isolate-body': return visibility.isolate !== null && !visibility.isolate.bodyIds.has(bodyId)
    case 'hidden-face':
    case 'isolate-face':
      return false
  }
}

function realAdjacentFaces(edgeId: StableId): StableId[] | null {
  const parsed = parseStableId(edgeId)
  if (parsed.kind !== 'edge') return null
  return parsed.operands.filter((operand) => !operand.isOrphan && !operand.isSeam).map((operand) => operand.raw)
}

function subshapeExcludedBy(
  source: ProjectVisibilitySource,
  hit: FacePickHit | EdgePickHit | VertexPickHit,
  visibility: ProjectGeometryVisibility,
): boolean | 'unresolvable-edge-visibility' {
  if (source !== 'hidden-face' && source !== 'isolate-face') return false

  const faceExcluded = (faceId: StableId): boolean => {
    if (source === 'hidden-face') return visibility.hiddenFaceIds.has(faceId)
    const isolate = visibility.isolate
    return isolate !== null && isolate.faceIds.size > 0 && !isolate.faceIds.has(faceId)
  }
  if (hit.kind === 'face') return faceExcluded(hit.id)

  const adjacent = hit.kind === 'edge'
    ? realAdjacentFaces(hit.id)
    : [...new Set(hit.id.adjacentEdgeIds.flatMap((edgeId) => realAdjacentFaces(edgeId) ?? []))]
  if (adjacent === null || adjacent.length === 0) {
    const faceFilterActive = source === 'hidden-face'
      ? visibility.hiddenFaceIds.size > 0
      : visibility.isolate !== null && visibility.isolate.faceIds.size > 0
    return faceFilterActive ? 'unresolvable-edge-visibility' : false
  }
  // Match rendered visibility: a boundary edge remains visible when at least
  // one real adjacent face remains visible.
  return adjacent.every(faceExcluded)
}

function nearestVisibleHit(
  filter: 'edge' | 'face' | 'vertex',
  input: ResolveProjectGeometryInput,
): { hit: FacePickHit | EdgePickHit | VertexPickHit | null; refusalReason?: string } {
  let best: FacePickHit | EdgePickHit | VertexPickHit | null = null
  for (const bodyId of input.visibility.bodyIds) {
    if (PROJECT_VISIBILITY_SOURCES.some((source) => bodyExcludedBy(source, bodyId, input.visibility))) continue
    const raw = filter === 'vertex'
      ? input.picker.pickVertex?.(bodyId, input.ray, input.thresholds) ?? null
      : input.picker.pick(bodyId, input.ray, filter, input.thresholds)
    if (raw === null || raw.kind !== filter) continue
    if (
      raw.bodyId !== bodyId
      || (raw.kind === 'vertex'
        ? !validVertexRef(raw.id)
        : typeof raw.id !== 'string' || raw.id.length === 0)
      || !Number.isFinite(raw.distance)
      || raw.distance < 0
      || ![raw.point.x, raw.point.y, raw.point.z].every(Number.isFinite)
    ) {
      return { hit: null, refusalReason: 'invalid-pick-hit' }
    }
    let excluded = false
    for (const source of PROJECT_VISIBILITY_SOURCES) {
      const decision = subshapeExcludedBy(source, raw, input.visibility)
      if (decision === 'unresolvable-edge-visibility') return { hit: null, refusalReason: decision }
      if (decision) {
        excluded = true
        break
      }
    }
    if (!excluded && (best === null || raw.distance < best.distance)) best = raw
  }
  return { hit: best }
}

function validVertexRef(ref: BridgeVertexRef): boolean {
  return Array.isArray(ref.adjacentEdgeIds)
    && ref.adjacentEdgeIds.length > 0
    && ref.adjacentEdgeIds.every((id) => typeof id === 'string' && id.length > 0)
}

function finiteRay(ray: RayLike): boolean {
  return [
    ray.origin.x, ray.origin.y, ray.origin.z,
    ray.direction.x, ray.direction.y, ray.direction.z,
  ].every(Number.isFinite)
}

function loopArea(points: ReadonlyArray<{ x: number; y: number }>): number {
  let sum = 0
  for (let index = 0; index < points.length; index++) {
    const next = points[(index + 1) % points.length]
    sum += points[index].x * next.y - next.x * points[index].y
  }
  return Math.abs(sum / 2)
}

function vertexSourceId(hit: VertexPickHit): string {
  const edgeKey = [...hit.id.adjacentEdgeIds].sort().join('|')
  const pointKey = [hit.point.x, hit.point.y, hit.point.z]
    .map((coordinate) => coordinate.toPrecision(17))
    .join(',')
  return `vertex:${edgeKey}@${pointKey}`
}

function sourceKey(hit: FacePickHit | EdgePickHit | VertexPickHit, version: number): {
  stablePickKey: string
  sourceIdentity: ProjectSourceIdentity
} {
  const stableId = hit.kind === 'vertex' ? vertexSourceId(hit) : hit.id
  return {
    stablePickKey: `model-${hit.kind}:${hit.bodyId}:${stableId}`,
    sourceIdentity: { bodyId: hit.bodyId, cacheVersion: version, stableId },
  }
}

function expectedSourceRefusal(
  expected: ExpectedProjectSource | undefined,
  actual: ReturnType<typeof sourceKey>,
): ProjectResolveResult | null {
  if (expected === undefined) return null
  if (
    expected.sourceIdentity.bodyId === actual.sourceIdentity.bodyId
    && expected.sourceIdentity.cacheVersion !== actual.sourceIdentity.cacheVersion
  ) {
    return refusal('stale-source-version', 'Project: source geometry changed; move the pointer and try again')
  }
  if (
    expected.stablePickKey !== actual.stablePickKey
    || expected.sourceIdentity.bodyId !== actual.sourceIdentity.bodyId
    || expected.sourceIdentity.stableId !== actual.sourceIdentity.stableId
  ) {
    return refusal('source-key-changed', 'Project: the source under the pointer changed; try again')
  }
  return null
}

function extractionRefusal(reason: string, detail?: string): ProjectResolveResult {
  return refusal(
    reason,
    `Project: source geometry refused (${reason})${detail === undefined ? '' : `. ${detail}`}`,
  )
}

/**
 * Pure, synchronous workbench source resolver. It reads only the explicit
 * frame/cache/picker/visibility snapshot supplied by its caller and never
 * mutates a sketch or publishes itself to the live workbench port.
 */
export function resolveProjectGeometry(input: ResolveProjectGeometryInput): ProjectResolveResult {
  const invalidInput = invalidProjectInput(input)
  if (invalidInput !== null) {
    return refusal('invalid-project-input', `Project: invalid resolver input (${invalidInput})`)
  }
  const depthTolerance = input.edgeDepthTolerance ?? DEFAULT_EDGE_DEPTH_TOLERANCE
  if (!finiteRay(input.ray) || !Number.isFinite(depthTolerance) || depthTolerance < 0) {
    return refusal('invalid-pick-input', 'Project: ray or depth tolerance is invalid')
  }

  const pierce = input.pierce === true
  const noHit: ReturnType<typeof nearestVisibleHit> = { hit: null }
  const faceResult = pierce ? noHit : nearestVisibleHit('face', input)
  if (faceResult.refusalReason) return extractionRefusal(faceResult.refusalReason)
  const edgeResult = nearestVisibleHit('edge', input)
  if (edgeResult.refusalReason) return extractionRefusal(edgeResult.refusalReason)
  const vertexResult = pierce ? noHit : nearestVisibleHit('vertex', input)
  if (vertexResult.refusalReason) return extractionRefusal(vertexResult.refusalReason)
  const faceHit = faceResult.hit
  const edgeHit = edgeResult.hit
  const vertexHit = vertexResult.hit
  const hit = edgeHit !== null && (faceHit === null || edgeHit.distance <= faceHit.distance + depthTolerance)
    ? edgeHit
    : faceHit
  const selectedHit = vertexHit !== null && (hit === null || vertexHit.distance <= hit.distance + depthTolerance)
    ? vertexHit
    : hit
  if (selectedHit === null) {
    return pierce
      ? refusal('miss', 'Pierce: no model edge under the pointer - click the edge that crosses the sketch plane')
      : refusal('miss', 'Project: no visible vertex, edge, or face under the pointer')
  }

  const body = input.cache.get(selectedHit.bodyId)
  if (body === undefined) return extractionRefusal('cache-entry-missing')
  if (body.bodyId !== selectedHit.bodyId || !Number.isSafeInteger(body.version) || body.version < 1) {
    return extractionRefusal('invalid-cache-entry')
  }
  const key = sourceKey(selectedHit, body.version)
  const expectedRefusal = expectedSourceRefusal(input.expectedSource, key)
  if (expectedRefusal !== null) return expectedRefusal

  const toLocal = (point: { x: number; y: number; z: number }) => worldToLocal(input.frame, point)
  let paths: Loop2D[] = []
  let points: Array<{ x: number; y: number }> | undefined
  let pierceEdge: SketchLocal3[] | undefined
  if (selectedHit.kind === 'edge') {
    pierceEdge = edgeLocal3(body, selectedHit.id, input.frame) ?? undefined
    const extracted = edgePolyline(body, selectedHit.id, toLocal)
    if (!extracted.ok && pierce && extracted.reason === 'collapsed-projection' && pierceEdge !== undefined) {
      // End-on edge: nothing to project, everything to pierce.
      paths = []
    } else if (!extracted.ok) {
      return extractionRefusal(
        extracted.reason,
        extracted.reason === 'edge-id-collision'
          ? edgeIdCollisionMessage(extracted.collisions)
          : undefined,
      )
    } else {
      paths = [{
        id: `${key.stablePickKey}:0`,
        points: extracted.points.map(toLocal),
        closed: false,
        type: 'open',
        layerId: `model:${selectedHit.bodyId}`,
        area: 0,
      }]
    }
  } else if (selectedHit.kind === 'face') {
    const extracted = faceBoundaryLoops(body, selectedHit.id, toLocal)
    if (!extracted.ok) {
      return extractionRefusal(
        extracted.reason,
        extracted.reason === 'edge-id-collision'
          ? edgeIdCollisionMessage(extracted.collisions)
          : undefined,
      )
    }
    paths = extracted.loops.map((loop, index) => {
      const points = loop.map(toLocal)
      return {
        id: `${key.stablePickKey}:${index}`,
        points,
        closed: true,
        type: index === 0 ? 'contour' : 'hole',
        layerId: `model:${selectedHit.bodyId}`,
        area: loopArea(points),
      }
    })
  } else {
    points = [toLocal(selectedHit.point)]
  }

  const current = input.cache.get(selectedHit.bodyId)
  if (current !== body || current.version !== key.sourceIdentity.cacheVersion) {
    return extractionRefusal('cache-version-changed')
  }
  const candidate: ProjectCandidate = {
    paths,
    points,
    sourceKind: selectedHit.kind === 'vertex'
      ? 'model-vertex'
      : selectedHit.kind === 'edge' ? 'model-edge' : 'model-face',
    sourceLabel: selectedHit.kind === 'vertex'
      ? 'Model vertex'
      : `${selectedHit.kind === 'edge' ? 'Edge' : 'Face'} ${selectedHit.id}`,
    stablePickKey: key.stablePickKey,
    sourceIdentity: key.sourceIdentity,
    ...(pierceEdge !== undefined ? { pierceEdge } : {}),
  }
  return { ok: true, candidate }
}

/** WO-1865: world -> sketch-local 3D (x, y in the plane, z = signed height along the normal). */
function worldToLocal3(frame: PlaneFrame, point: Vec3): SketchLocal3 {
  const { x, y } = worldToLocal(frame, point)
  return { x, y, z: vDot(vSub(point, frame.origin), vUnit(frame.normal)) }
}

/** WO-1865: one cached edge's tessellated polyline in sketch-local 3D, or null when the id is
 *  absent, duplicated, non-finite or degenerate. Unlike edgePolyline it never refuses an edge whose
 *  PROJECTION collapses: an edge square to the sketch plane is exactly what a pierce wants. */
function edgeLocal3(body: CachedBody, edgeId: StableId, frame: PlaneFrame): SketchLocal3[] | null {
  if (edgeIdCollisions(body.edgeIds, [edgeId]).length > 0) return null
  const e = body.edgeIds.indexOf(edgeId)
  if (e === -1) return null
  const out: SketchLocal3[] = []
  for (let p = body.edgeOffsets[e]; p < body.edgeOffsets[e + 1]; p++) {
    const world = { x: body.edgePositions[p * 3], y: body.edgePositions[p * 3 + 1], z: body.edgePositions[p * 3 + 2] }
    if (!Number.isFinite(world.x) || !Number.isFinite(world.y) || !Number.isFinite(world.z)) return null
    out.push(worldToLocal3(frame, world))
  }
  if (out.length < 2) return null
  const [first] = out
  return out.some((p) => Math.hypot(p.x - first.x, p.y - first.y, p.z - first.z) > 1e-9) ? out : null
}

// ---- Live references (WO-1864) ---------------------------------------------------------------
//
// Re-resolve a stored Project/Use source after a model change. Reuses the persistent-naming ids
// the pick stored -- no new naming scheme: a face is found by its derived face StableId, an edge
// through resolvePersistedEdgeId (the same exact / migrated / lost / ambiguous rule the kernel's
// resolve() applies to edge ids, run against the live edge-id list the regenerated body's cache
// carries), a vertex as the common end of its resolved adjacent edges. The body is followed to its
// sole live descendant, so a later dress-up feature on the picked body does not orphan the link.
// Anything else is a named miss; the caller keeps the pieces where they last stood.

/** The live body now carrying a stored body id: itself, or its sole live descendant. */
export function projectionLinkBody(
  dag: FeatureDag,
  liveBodyIds: readonly BodyId[],
  storedBodyId: BodyId,
): { ok: true; bodyId: BodyId } | { ok: false; reason: 'body-lost' | 'body-ambiguous' } {
  const resolved = resolveBodyTargetLineage(dag, bodyFeatureIds(dag), liveBodyIds, storedBodyId)
  if (resolved.ok) return { ok: true, bodyId: resolved.bodyId }
  return { ok: false, reason: resolved.reason === 'ambiguous' ? 'body-ambiguous' : 'body-lost' }
}

export interface ResolveProjectionLinkInput {
  link: SketchProjectionLink
  frame: PlaneFrame
  cache: ProjectGeometryCache
  /** projectionLinkBody's answer for link.bodyId. */
  body: ReturnType<typeof projectionLinkBody>
}

/** Parse `vertex:<edge ids joined by |>@<x,y,z>` (vertexSourceId above). */
function parseVertexSourceId(stableId: string): { edgeIds: string[]; point: Vec3 } | null {
  if (!stableId.startsWith('vertex:')) return null
  const at = stableId.lastIndexOf('@')
  if (at <= 'vertex:'.length) return null
  // Edge ids always open with '(' and may themselves contain '@' (disambiguation) or '|'.
  const edgeIds = stableId.slice('vertex:'.length, at).split(/\|(?=\()/).filter((id) => id.length > 0)
  const coords = stableId.slice(at + 1).split(',').map(Number)
  if (edgeIds.length === 0 || coords.length !== 3 || !coords.every(Number.isFinite)) return null
  return { edgeIds, point: { x: coords[0], y: coords[1], z: coords[2] } }
}

function liveEdgeId(body: CachedBody, stableId: string): string | null {
  const resolved = resolvePersistedEdgeId(stableId, body.edgeIds)
  return resolved.status === 'exact' || resolved.status === 'migrated' ? resolved.id : null
}

function distance3(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

/** The current world position of a stored vertex: the end its resolved adjacent edges share. */
function resolveVertex(body: CachedBody, stableId: string): Vec3 | null {
  const parsed = parseVertexSourceId(stableId)
  if (parsed === null) return null
  const ends: Vec3[][] = []
  for (const edgeId of parsed.edgeIds) {
    const live = liveEdgeId(body, edgeId)
    if (live === null) continue
    const polyline = edgePolyline(body, live, (p) => ({ x: p.x, y: p.y }))
    if (!polyline.ok) continue
    ends.push([polyline.points[0], polyline.points[polyline.points.length - 1]])
  }
  if (ends.length === 0) return null
  // Score each candidate end by how far it is from the nearest end of every other resolved edge
  // (the shared corner scores ~0); the stored position only breaks a tie (a lone edge).
  let best: Vec3 | null = null
  let bestScore = Infinity
  for (const candidate of ends.flat()) {
    let score = 0
    for (const other of ends) score += Math.min(distance3(candidate, other[0]), distance3(candidate, other[1]))
    const tieBreak = distance3(candidate, parsed.point) * 1e-9
    if (score + tieBreak < bestScore) {
      bestScore = score + tieBreak
      best = candidate
    }
  }
  const scale = Math.max(1, ...ends.flat().map((p) => Math.max(Math.abs(p.x), Math.abs(p.y), Math.abs(p.z))))
  return ends.length > 1 && bestScore > 1e-6 * scale ? null : best
}

/** Fresh sketch-local geometry for one stored source, or why it cannot be found. */
export function resolveProjectionLinkSource(input: ResolveProjectionLinkInput): ProjectionSourceGeometry {
  if (!input.body.ok) return { ok: false, reason: input.body.reason }
  const body = input.cache.get(input.body.bodyId)
  if (body === undefined) return { ok: false, reason: 'cache-entry-missing' }
  const toLocal = (point: Vec3) => worldToLocal(input.frame, point)
  const layerId = `model:${input.body.bodyId}`
  const { link } = input
  if (link.sourceKind === 'model-edge') {
    const live = liveEdgeId(body, link.stableId)
    if (live === null) return { ok: false, reason: 'edge-lost' }
    const extracted = edgePolyline(body, live, toLocal)
    if (!extracted.ok) return { ok: false, reason: extracted.reason }
    return {
      ok: true,
      paths: [{
        id: `${link.id}:0`, points: extracted.points.map(toLocal), closed: false,
        type: 'open', layerId, area: 0,
      }],
      points: [],
    }
  }
  if (link.sourceKind === 'model-face') {
    if (!body.faceIds.includes(link.stableId)) return { ok: false, reason: 'face-lost' }
    const extracted = faceBoundaryLoops(body, link.stableId, toLocal)
    if (!extracted.ok) return { ok: false, reason: extracted.reason }
    return {
      ok: true,
      paths: extracted.loops.map((loop, index) => {
        const points = loop.map(toLocal)
        return {
          id: `${link.id}:${index}`, points, closed: true,
          type: index === 0 ? 'contour' : 'hole', layerId, area: loopArea(points),
        }
      }),
      points: [],
    }
  }
  const vertex = resolveVertex(body, link.stableId)
  if (vertex === null) return { ok: false, reason: 'vertex-lost' }
  const local = toLocal(vertex)
  if (!Number.isFinite(local.x) || !Number.isFinite(local.y)) return { ok: false, reason: 'non-finite-point' }
  return { ok: true, paths: [], points: [local] }
}

// ---- Pierce (WO-1865) ------------------------------------------------------------------------------
//
// A pierce rides the SAME stored identity as a live projected edge: the body followed to its live
// descendant (projectionLinkBody) and the persistent edge id through resolvePersistedEdgeId
// (liveEdgeId above). Only the last step differs -- the edge is read in sketch-local 3D and
// crossed with the plane (projectLink.edgePlaneCrossing) instead of projected onto it.

export interface ResolvePierceInput {
  source: SketchPierceSource
  frame: PlaneFrame
  cache: ProjectGeometryCache
  /** projectionLinkBody's answer for source.bodyId. */
  body: ReturnType<typeof projectionLinkBody>
  /** The pierced point's last crossing (chooses among several crossings of a curved edge). */
  near: SketchVec2
}

/** Where the stored edge crosses the sketch plane now, or why it does not. */
export function resolvePierceCrossing(input: ResolvePierceInput): PierceCrossing {
  if (!input.body.ok) return { ok: false, reason: input.body.reason }
  const body = input.cache.get(input.body.bodyId)
  if (body === undefined) return { ok: false, reason: 'cache-entry-missing' }
  const live = liveEdgeId(body, input.source.stableId)
  if (live === null) return { ok: false, reason: 'edge-lost' }
  const points = edgeLocal3(body, live, input.frame)
  if (points === null) return { ok: false, reason: 'degenerate-edge' }
  return edgePlaneCrossing(points, input.near)
}
