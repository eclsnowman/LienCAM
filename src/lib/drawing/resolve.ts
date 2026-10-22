// WO-2750 Slice A (WO-2981): drawing reference resolution.
//
// Drawing policy layered on the EXISTING identity machinery (plan section 4.2).
// It reads the ElementMap and the mesh edge-chain / feature results; it changes
// neither. The ElementMap is tuned for modeling references, where a split
// winner or a unique geometric look-alike is a fair guess. A dimension is a
// promise about a size on paper, so this layer is stricter:
//
//   - exact membership or ONE live lineage successor can be current, and only
//     after the witness still means the same thing (role and orientation);
//   - a split, a geometric look-alike, or changed import bytes never rebind;
//     the viable targets come back as candidates for an explicit repair;
//   - a deleted hole beside an identical hole is missing, never the neighbour;
//   - two dimension endpoints that now land on one entity are stale, never a
//     fresh zero;
//   - a mesh reference is current only on a proved one-to-one chain or feature
//     support match under the same detector settings; query ids and source
//     facet numbers are never consulted.
//
// Pure functions over plain data: no kernel, no worker, no Date.now.

import type { GeometrySnapshot } from '../../geom/geom-service'
import type { ElementMap } from '../../doc/element-map'
import { compareIds, parseStableId } from '../../doc/stable-id'
import type { MeshEdgeChain } from '../../mesh/edgeChains'
import type { MeshFeatureRecognition } from '../../mesh/recognition/types'
import type {
  DrawingReference,
  DrawingSource,
  DrawingVec3,
  ReferenceReason,
  ReferenceResult,
  ReferenceState,
  SourceRevision,
  WitnessRole,
} from './types'

// Orientation must survive within the ElementMap's own geometric thresholds.
const ORIENTATION_DOT_MIN = 0.999
// Geometric look-alike search (candidates only): ElementMap's step-3 numbers.
const CANDIDATE_CENTROID_FRACTION = 0.005
const CANDIDATE_AREA_MIN = 0.8
const CANDIDATE_AREA_MAX = 1.25
const AXIAL = new Set(['cylinder', 'cone', 'torus'])
// Mesh fingerprints snap to this grid (mm and unit-vector components).
const MESH_SNAP_MM = 0.01
const MESH_SNAP_DIR = 1e-3

// ---------------------------------------------------------------------------
// Current source state, as the document layer hands it to the resolver.
// ---------------------------------------------------------------------------

export interface BrepSourceState {
  kind: 'model-brep' | 'imported-brep'
  scope: Omit<DrawingSource, 'observedRevision' | 'kind'>
  revision: SourceRevision
  /** the body's current ElementMap (incremental or freshly replayed) */
  map: ElementMap
  /** bbox diagonal for the look-alike candidate search, mm */
  bboxDiagMm: number
  /**
   * Edge ids the current body really has (TessBuffers.edgeIds). Faces that
   * survive do not prove their edge does: a fillet keeps both faces and
   * removes the edge between them. Without this set an edge reference is
   * unsupported, never current.
   */
  liveEdgeIds?: ReadonlySet<string>
  /** Vertex ids the current body really has; same rule as liveEdgeIds. */
  liveVertexIds?: ReadonlySet<string>
}

/** One recognized mesh feature reduced to what can be proved across a reorder. */
export interface MeshFeatureSupport {
  featureKind: string
  supportFingerprint: string
}

export interface MeshSourceState {
  kind: 'mesh'
  scope: Omit<DrawingSource, 'observedRevision' | 'kind'>
  revision: SourceRevision
  /** chains of the EDITED mesh (resolveEditedStlMesh), never the original bytes */
  chains: MeshEdgeChain[]
  features: MeshFeatureSupport[]
  /** fingerprint of weld/angle/detector settings the chains and features used */
  settingsFingerprint: string
  /** resolveEditedStlMesh stopped the journal replay */
  replayStopped?: { reason: string }
}

export interface AbsentSourceState {
  kind: 'absent'
}

export type CurrentSourceState = BrepSourceState | MeshSourceState | AbsentSourceState

// ---------------------------------------------------------------------------
// Fingerprints
// ---------------------------------------------------------------------------

export function sameRevision(a: SourceRevision | undefined, b: SourceRevision | undefined): boolean {
  if (!a || !b) return false
  return a.geometryFingerprint === b.geometryFingerprint
    && a.frameFingerprint === b.frameFingerprint
    && a.producerVersion === b.producerVersion
    && (a.journalFingerprint ?? '') === (b.journalFingerprint ?? '')
}

function snap(value: number, grid: number): string {
  const v = Math.round(value / grid) * grid
  return (Object.is(v, -0) ? 0 : v).toFixed(Math.max(0, Math.ceil(-Math.log10(grid))))
}

/**
 * Order-free signature of a mesh chain's geometry: its points snapped to a
 * 0.01 mm grid, sorted. Two chains that share it are the same polyline,
 * whatever triangle or vertex order produced them.
 */
export function meshChainSignature(chain: MeshEdgeChain): string {
  const pts = chain.points.map(p => p.map(c => snap(c, MESH_SNAP_MM)).join(','))
  pts.sort()
  return `${chain.closed ? 'c' : 'o'}|${pts.join(';')}`
}

/**
 * What a fitted feature IS, independent of facet numbering: kind, axis line,
 * diameters and depth (or the pocket/slot box). Recognition query ids
 * (`kind-<smallest facet id>`) are deliberately not part of it.
 */
export function summarizeMeshFeatures(recognition: MeshFeatureRecognition): MeshFeatureSupport[] {
  const out: MeshFeatureSupport[] = []
  for (const f of recognition.features) {
    const d = canonicalAxis(f.axis.direction)
    // Project the origin onto the plane through 0 normal to the axis so the
    // fingerprint names the axis LINE, not the fitted seed point on it.
    const o = f.axis.origin
    const t = o[0] * d[0] + o[1] * d[1] + o[2] * d[2]
    const foot: DrawingVec3 = [o[0] - t * d[0], o[1] - t * d[1], o[2] - t * d[2]]
    // Where along that line it sits: two coaxial bores of one size (a clevis)
    // differ only here. Stations are measured along the feature's own
    // direction from its origin; map them onto the canonical axis.
    const raw = unitOf(f.axis.direction)
    const sign = raw[0] * d[0] + raw[1] * d[1] + raw[2] * d[2] < 0 ? -1 : 1
    const base = o[0] * raw[0] + o[1] * raw[1] + o[2] * raw[2]
    const stations = f.bands.flatMap(b => b.axialRangeMm).map(r => sign * (base + r))
    const span = stations.length > 0 ? [Math.min(...stations), Math.max(...stations)] : [t, t]
    out.push({
      featureKind: f.kind,
      supportFingerprint: [
        f.kind,
        foot.map(c => snap(c, MESH_SNAP_MM)).join(','),
        d.map(c => snap(c, MESH_SNAP_DIR)).join(','),
        f.diametersMm.map(v => snap(v, MESH_SNAP_MM)).join('/'),
        snap(f.depthMm, MESH_SNAP_MM),
        span.map(v => snap(v, MESH_SNAP_MM)).join('..'),
      ].join('|'),
    })
  }
  for (const p of recognition.pockets) {
    const corners = p.corners.map(c => c.map(v => snap(v, MESH_SNAP_MM)).join(',')).sort()
    out.push({ featureKind: p.kind, supportFingerprint: [p.kind, corners.join(';'), snap(p.depthMm, MESH_SNAP_MM)].join('|') })
  }
  return out
}

function unitOf(d: DrawingVec3): DrawingVec3 {
  const len = Math.hypot(d[0], d[1], d[2]) || 1
  return [d[0] / len, d[1] / len, d[2] / len]
}

function canonicalAxis(d: DrawingVec3): DrawingVec3 {
  const u = unitOf(d)
  // An axis is a line: pick the sign whose first clearly nonzero component is positive.
  const lead = Math.abs(u[0]) > MESH_SNAP_DIR ? u[0] : Math.abs(u[1]) > MESH_SNAP_DIR ? u[1] : u[2]
  return lead < 0 ? [-u[0], -u[1], -u[2]] : u
}

/** Signature text for a BREP face witness (stored beside the snapshot). */
export function faceSnapshotSignature(s: GeometrySnapshot): string {
  const v = (p?: { x: number; y: number; z: number }) => (p ? [p.x, p.y, p.z].map(c => snap(c, MESH_SNAP_MM)).join(',') : '-')
  return [s.surfaceType, v(s.centroid), snap(s.area, MESH_SNAP_MM), v(s.normal), v(s.axis)].join('|')
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

function result(ref: DrawingReference, state: ReferenceState, extra: Partial<ReferenceResult> = {}): ReferenceResult {
  return { referenceId: ref.id, state, resolvedIds: [], via: 'none', candidates: [], ...extra }
}

function scopeMatches(ref: DrawingReference, scope: BrepSourceState['scope']): boolean {
  const s = ref.source
  return s.modelItemId === scope.modelItemId
    && s.documentId === scope.documentId
    && s.lineageId === scope.lineageId
    && (s.importAssetId ?? '') === (scope.importAssetId ?? '')
    && (s.importSolidKey ?? '') === (scope.importSolidKey ?? '')
}

/** Resolve one stored drawing reference against the source as it is now. */
export function resolveDrawingReference(ref: DrawingReference, source: CurrentSourceState): ReferenceResult {
  if (source.kind === 'absent') return result(ref, 'missing', { reason: 'source-missing' })
  // Scope first: never cross to a same-named part or a matching id in another item.
  if (!scopeMatches(ref, source.scope)) return result(ref, 'missing', { reason: 'scope-mismatch' })
  if (ref.source.kind !== source.kind) return result(ref, 'unsupported', { reason: 'source-kind-changed' })
  if (source.kind === 'mesh') return resolveMesh(ref, source)
  return resolveBrep(ref, source)
}

function resolveBrep(ref: DrawingReference, source: BrepSourceState): ReferenceResult {
  const sel = ref.selector
  if (sel.kind !== 'face' && sel.kind !== 'edge' && sel.kind !== 'vertex') {
    return result(ref, 'unsupported', { reason: 'source-kind-changed' })
  }
  const measuredAt = source.revision
  if (source.kind === 'imported-brep') {
    // Import face numbers are frozen per import revision and per kernel build.
    // Changed bytes or a different build without a proven lineage mapping
    // means the same `face#i` string may name a different face: repair only.
    if ((ref.source.importContentFingerprint ?? '') !== (source.scope.importContentFingerprint ?? '')) {
      return result(ref, 'stale', { reason: 'import-replaced-without-lineage', candidates: seedCandidates(sel.stableId, source.map), measuredAt })
    }
    if (ref.acceptedRevision.producerVersion !== source.revision.producerVersion) {
      return result(ref, 'stale', { reason: 'producer-changed', candidates: seedCandidates(sel.stableId, source.map), measuredAt })
    }
  }
  if (sel.kind === 'face') return resolveFace(ref, sel.stableId, source)
  return resolveCompound(ref, sel.stableId, source)
}

function seedCandidates(id: string, map: ElementMap): string[] {
  return map.has(id) ? [id] : []
}

/** Live lineage descendants of `id`, sorted (ElementMap keeps its own BFS private). */
function liveDescendants(map: ElementMap, id: string): string[] {
  const found = new Set<string>()
  const seen = new Set<string>()
  const stack = [id]
  while (stack.length > 0) {
    const cur = stack.pop() as string
    if (seen.has(cur)) continue
    seen.add(cur)
    for (const kid of map.successorsOf(cur)) {
      if (map.has(kid)) found.add(kid)
      stack.push(kid)
    }
  }
  return [...found].sort(compareIds)
}

function resolveFace(ref: DrawingReference, id: string, source: BrepSourceState): ReferenceResult {
  const { map } = source
  const em = map.resolve(id, 'single-face')
  const elementMap = { status: em.status, via: em.via, boundTo: em.boundTo }
  const measuredAt = source.revision
  let bound: string | undefined
  let via: 'exact' | 'lineage' = 'exact'
  if (map.has(id)) {
    bound = id
  } else {
    const kids = liveDescendants(map, id)
    if (kids.length === 1) {
      bound = kids[0]
      via = 'lineage'
    } else if (kids.length > 1) {
      // A split. ElementMap may name an overlap winner; a dimension does not
      // take it on trust (plan 4.2 step 2).
      return result(ref, 'ambiguous', { reason: 'split', candidates: kids, elementMap, measuredAt })
    }
  }
  if (!bound) {
    const look = lookAlikes(ref.witness.snapshot, source)
    if (look.length > 0) {
      return result(ref, 'ambiguous', { reason: 'geometric-candidate-only', candidates: look, elementMap, measuredAt })
    }
    return result(ref, 'missing', { reason: map.isDeleted(id) ? 'deleted' : 'not-found', elementMap, measuredAt })
  }
  const witness = checkWitness(ref.witness.role, ref.witness.orientationLocal, map.snapshotOf(bound))
  if (witness) return result(ref, 'stale', { reason: witness, candidates: [bound], elementMap, measuredAt })
  return result(ref, 'current', { resolvedIds: [bound], via, elementMap, measuredAt })
}

/**
 * Edge / vertex ids are derived from their adjacent faces
 * (docs/stable-id-spec.md "Edge IDs"). Every named face must be current on its
 * own, AND the rebuilt id must be in the body's live edge (or vertex) set:
 * two faces can both survive while the edge between them is filleted,
 * chamfered or cut away.
 */
function resolveCompound(ref: DrawingReference, id: string, source: BrepSourceState): ReferenceResult {
  const measuredAt = source.revision
  const parsed = parseStableId(id)
  if (parsed.kind !== 'edge') return result(ref, 'unsupported', { reason: 'malformed-selector' })
  const isVertex = ref.selector.kind === 'vertex'
  const liveSet = isVertex ? source.liveVertexIds : source.liveEdgeIds
  const faces = parsed.operands.filter(o => !o.isSeam && !o.isOrphan).map(o => o.raw)
  if (faces.length === 0) return result(ref, 'unsupported', { reason: 'malformed-selector' })
  const resolvedFaces: string[] = []
  let via: 'exact' | 'lineage' = 'exact'
  for (const face of faces) {
    const sub = resolveFace({ ...ref, witness: { ...ref.witness, role: 'point', orientationLocal: undefined, snapshot: undefined } }, face, source)
    if (sub.state !== 'current') return { ...sub, referenceId: ref.id }
    resolvedFaces.push(sub.resolvedIds[0])
    if (sub.via === 'lineage') via = 'lineage'
  }
  if (new Set(resolvedFaces).size !== resolvedFaces.length) {
    // Two adjacent faces became one: the edge no longer exists as stored.
    return result(ref, 'stale', { reason: 'endpoints-collapsed', candidates: [...new Set(resolvedFaces)], measuredAt })
  }
  // Rebuild the id from the faces it resolved to: a face that rode lineage
  // renames the edge. Seam / orphan operands stay as stored.
  const rest = parsed.operands.filter(o => o.isSeam || o.isOrphan).map(o => o.raw)
  const operands = isVertex ? [...resolvedFaces, ...rest].sort(compareIds) : [...[...resolvedFaces].sort(compareIds), ...rest]
  const rebuilt = `(${operands.join('∧')})${parsed.disambiguator ? `@${parsed.disambiguator}` : ''}`
  if (!liveSet) return result(ref, 'unsupported', { reason: 'topology-unavailable', candidates: [rebuilt], measuredAt })
  if (!liveSet.has(rebuilt)) {
    // GEO-16 twins: two edges on one face pair carry a geometric `@` token,
    // which moves when the geometry does (a resized hole). Live edges on the
    // same pair are repair choices, never an automatic pick.
    const base = rebuilt.slice(0, rebuilt.length - (parsed.disambiguator ? parsed.disambiguator.length + 1 : 0))
    const twins = [...liveSet].filter(e => e === base || e.startsWith(`${base}@`)).sort(compareIds)
    if (twins.length > 0) return result(ref, 'ambiguous', { reason: 'edge-twin-changed', candidates: twins, measuredAt })
    // Both faces live, the edge between them gone (fillet, chamfer, cut).
    return result(ref, 'missing', { reason: 'edge-gone', candidates: [], measuredAt })
  }
  return result(ref, 'current', { resolvedIds: [rebuilt], via, measuredAt })
}

const ROLE_SURFACES: Record<WitnessRole, ReadonlySet<string> | 'any'> = {
  point: 'any',
  endpoint: 'any',
  curve: 'any',
  plane: new Set(['plane']),
  axis: new Set(['cylinder', 'cone', 'torus']),
  center: new Set(['cylinder', 'cone', 'torus', 'sphere']),
}

function checkWitness(role: WitnessRole, orientation: DrawingVec3 | undefined, snapNow: GeometrySnapshot | undefined): ReferenceReason | undefined {
  const allowed = ROLE_SURFACES[role]
  if (allowed !== 'any') {
    if (!snapNow || !allowed.has(snapNow.surfaceType)) return 'witness-role-mismatch'
  }
  if (orientation && snapNow) {
    if (snapNow.surfaceType === 'plane' && snapNow.normal) {
      // A plane witness is signed: a face that now faces the other way is a different face.
      if (dot3(unit(orientation), unit([snapNow.normal.x, snapNow.normal.y, snapNow.normal.z])) <= ORIENTATION_DOT_MIN) {
        return 'witness-orientation-changed'
      }
    } else if (AXIAL.has(snapNow.surfaceType) && snapNow.axis) {
      if (Math.abs(dot3(unit(orientation), unit([snapNow.axis.x, snapNow.axis.y, snapNow.axis.z]))) <= ORIENTATION_DOT_MIN) {
        return 'witness-orientation-changed'
      }
    }
  }
  return undefined
}

/** Live faces that look like the witness snapshot. Repair candidates only. */
function lookAlikes(snapThen: GeometrySnapshot | undefined, source: BrepSourceState): string[] {
  if (!snapThen) return []
  const tol = source.bboxDiagMm * CANDIDATE_CENTROID_FRACTION
  const out: string[] = []
  for (const id of source.map.liveIds()) {
    const s = source.map.snapshotOf(id)
    if (!s || s.surfaceType !== snapThen.surfaceType) continue
    const d = Math.hypot(s.centroid.x - snapThen.centroid.x, s.centroid.y - snapThen.centroid.y, s.centroid.z - snapThen.centroid.z)
    if (d >= tol) continue
    const ratio = snapThen.area === 0 ? 1 : s.area / snapThen.area
    if (ratio < CANDIDATE_AREA_MIN || ratio > CANDIDATE_AREA_MAX) continue
    if (checkWitness('point', orientationOf(snapThen), s)) continue
    out.push(id)
  }
  return out.sort(compareIds)
}

function orientationOf(s: GeometrySnapshot): DrawingVec3 | undefined {
  const v = s.normal ?? s.axis
  return v ? [v.x, v.y, v.z] : undefined
}

function resolveMesh(ref: DrawingReference, source: MeshSourceState): ReferenceResult {
  const sel = ref.selector
  const measuredAt = source.revision
  if (sel.kind !== 'mesh-chain' && sel.kind !== 'mesh-feature') {
    return result(ref, 'unsupported', { reason: 'source-kind-changed' })
  }
  // A replay stop is stale source content, not a completed update.
  if (source.replayStopped) return result(ref, 'stale', { reason: 'mesh-replay-stopped', measuredAt })
  if (sel.settingsFingerprint !== source.settingsFingerprint) {
    return result(ref, 'unsupported', { reason: 'detector-settings-changed', measuredAt })
  }
  if (sel.kind === 'mesh-chain') {
    // The chain id is geometry-derived, so a reorder keeps it. It is current
    // only when exactly one chain carries it AND that chain's own geometry
    // still matches the stored witness signature.
    const same = source.chains.filter(c => c.id === sel.chainId)
    if (same.length === 1 && meshChainSignature(same[0]) === ref.witness.geometrySignature) {
      return result(ref, 'current', { resolvedIds: [same[0].id], via: sameRevision(ref.acceptedRevision, source.revision) ? 'exact' : 'lineage', measuredAt })
    }
    const bySignature = source.chains.filter(c => meshChainSignature(c) === ref.witness.geometrySignature).map(c => c.id)
    return result(ref, 'stale', { reason: 'mesh-chain-not-proved', candidates: [...new Set([...same.map(c => c.id), ...bySignature])].sort(compareIds), measuredAt })
  }
  const matches = source.features.filter(f => f.featureKind === sel.featureKind && f.supportFingerprint === sel.supportFingerprint)
  if (matches.length === 1) {
    return result(ref, 'current', { resolvedIds: [matches[0].supportFingerprint], via: sameRevision(ref.acceptedRevision, source.revision) ? 'exact' : 'lineage', measuredAt })
  }
  return result(ref, matches.length > 1 ? 'ambiguous' : 'stale', {
    reason: 'mesh-feature-not-proved',
    candidates: source.features.filter(f => f.featureKind === sel.featureKind).map(f => f.supportFingerprint).sort(),
    measuredAt,
  })
}

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------

export interface DimensionResolution {
  state: ReferenceState
  reason?: ReferenceReason
  references: ReferenceResult[]
  /** nominal value in mm; only present when every reference is current */
  valueMm?: number
  measuredAt?: SourceRevision
}

const STATE_ORDER: ReferenceState[] = ['missing', 'ambiguous', 'stale', 'unsupported', 'updating', 'current']

/**
 * Resolve a two-reference linear dimension between parallel planes. The value
 * is recomputed from the CURRENT source geometry, never typed over; a stale
 * or collapsed endpoint keeps the dimension's last-good value (owned by the
 * caller) and reports why instead of printing a fresh number.
 */
export function resolveLinearPlaneDimension(refs: [DrawingReference, DrawingReference], source: CurrentSourceState): DimensionResolution {
  const results = refs.map(r => resolveDrawingReference(r, source))
  const worst = STATE_ORDER.find(s => results.some(r => r.state === s)) ?? 'current'
  if (worst !== 'current') {
    return { state: worst, reason: results.find(r => r.state === worst)?.reason, references: results }
  }
  const [a, b] = results.map(r => r.resolvedIds)
  if (a.some(id => b.includes(id))) {
    return { state: 'stale', reason: 'endpoints-collapsed', references: results }
  }
  if (source.kind === 'absent' || source.kind === 'mesh') return { state: 'unsupported', references: results }
  const sa = source.map.snapshotOf(a[0])
  const sb = source.map.snapshotOf(b[0])
  if (!sa?.normal || !sb?.normal || Math.abs(dot3(unit(xyz(sa.normal)), unit(xyz(sb.normal)))) <= ORIENTATION_DOT_MIN) {
    return { state: 'unsupported', reason: 'witness-role-mismatch', references: results }
  }
  const n = unit(xyz(sa.normal))
  const valueMm = Math.abs(dot3(n, [sb.centroid.x - sa.centroid.x, sb.centroid.y - sa.centroid.y, sb.centroid.z - sa.centroid.z]))
  return { state: 'current', references: results, valueMm, measuredAt: source.revision }
}

/**
 * Publish guard (plan 4.2 step 7): a result computed against an older source
 * revision must not land after a newer edit, or in another item.
 */
export function canPublish(res: { measuredAt?: SourceRevision }, current: SourceRevision): boolean {
  return sameRevision(res.measuredAt, current)
}

// ---------------------------------------------------------------------------

function xyz(v: { x: number; y: number; z: number }): DrawingVec3 {
  return [v.x, v.y, v.z]
}

function dot3(a: DrawingVec3, b: DrawingVec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function unit(v: DrawingVec3): DrawingVec3 {
  const len = Math.hypot(v[0], v[1], v[2])
  return len === 0 ? v : [v[0] / len, v[1] / len, v[2] / len]
}
