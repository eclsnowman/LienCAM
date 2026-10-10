import { operatorText } from '../i18n/locales/en/console-and-operator-messages'
// WO-114: the modeled-body EDGE-CHAIN binding for contour_2d.
//
// A picked edge chain on a modeled body is the MOST SPECIFIC machining binding
// an operation can carry - the operator named the exact border contour - so it
// outranks a picked face, a persisted section snapshot and the whole-body
// profile default. This module owns three things and nothing else:
//
//   1. deriveModelBodyEdges - persisted edge ids -> world-space Loop2D[], or a
//      NAMED refusal. Re-resolved on EVERY compute, never a cached polyline, so
//      a model rebuild either binds the same physical edges or fails loud.
//   2. The two-axis capability gate the wizard asks before offering the pick
//      (op-type axis + viewport axis).
//   3. modelEdgeChainBodyMismatch - the SOURCE-SWITCH guard. This is the whole
//      reason WO-114 exists; see the block comment above it.
//
// WHY THIS LIVES IN src/store/ AND NOT src/lib/cam/modelBodyDerive.ts (where
// its sibling derives live): WO-114's owned-paths cover src/store/ plus exactly
// one file in src/lib/cam/ (types.ts, for the 'edge-chain' role member).
// src/lib/cam/ as a directory belongs to WO-134, and the runner refuses
// overlapping leases. So this follows the existing precedent of
// src/store/opGeometryFieldContract.ts and src/store/opModelOriginGuard.ts:
// CAM policy that the store owns, living beside the store. The four small pure
// geometry helpers below (pointInPolygon / loopCentroid / polygonArea /
// reclassifyLoopsByNesting) are REPLICATED from modelBodyDerive.ts rather than
// exported from it for the same lane reason - each is a handful of lines with
// no state, and the alternative was editing a file this WO may not touch.
// Merging them back into one home is a natural follow-on once WO-134 lands.
//
// IDENTITY (the WO-095 investigation's finding, unchanged): a modeled body's
// edges DO carry a durable identity. An edge id is DERIVED from the sorted pair
// of its adjacent FACE ids (src/doc/stable-id.ts edgeId: "(A^B)"), so it
// survives whatever its faces survive - it is not an index and not a kernel
// enumeration ordinal. Where two physically distinct edges collapse onto the
// same face pair, GEO-16 appends a geometric disambiguator ("(A^B)@m..._l...").
// Both forms are already captured per body in ModelBodyDisplay.edgeIds,
// parallel to edgeOffsets.
//
// REBUILD SURVIVAL is NOT re-invented here. It delegates to the kernel lane's
// own resolvePersistedEdgeId, the single function that already owns "persisted
// edge id -> current edge id" and already refuses BY NAME rather than guessing:
//   - 'exact'     -> the id is present once; the same physical edge. Bind.
//   - 'migrated'  -> the id is gone but its face pair now owns exactly ONE
//                    current edge, so lineage names the survivor. Bind, and
//                    REPORT it in `migratedEdgeIds` - never silently.
//   - 'ambiguous' -> the face pair owns >= 2 current edges and the persisted id
//                    is not one of them. Rebinding would be a GUESS. REFUSE.
//   - 'lost'      -> the face pair owns no current edge. REFUSE.
// A wrong edge is a wrong toolpath and this product cuts metal, so the two
// unresolvable arms throw a named ModelBodyDeriveError (ADR-0003) instead of
// falling back to an index, a nearest-edge search, or a stale cached polyline.
//
// GEOMETRY comes from the SAME persisted display payload the face path uses -
// the CSR edge polylines (edgePositions + edgeOffsets), never a kernel call -
// and the world-space bake goes through resolveModelReferenceFrame exactly as
// every sibling derive does.

import type { ImportedGeometry, Loop2D, ModelBodyDisplay, PhysicalStock, SceneStock, Setup } from '../types'
import type { OperationType } from '../types'
import { isModelOriginGeometry, MODEL_BODY_BINDING_CAPABILITIES } from '../lib/cam/modelOrigin'
import { ModelBodyDeriveError, placedWorldPositions } from '../lib/cam/modelBodyDerive'
import { resolveModelReferenceFrame } from '../lib/cam/modelReferenceFrame'
import type { ModelItemPlacementRegistryEntry } from '../lib/cam/modelItemPlacement'
import { buildLoops, dp } from '../lib/geometry/stlProjection'
import { resolvePersistedEdgeId } from '../geom/worker/stable-id'
import { edgeChainUnsupportedMessage } from '../lib/machine/operatorMessages'
import {
  transformLoopPoints, isTiltedOffZ, type GeoPose,
  effectiveWcsOriginZ, resolveModelSourceOwningStockBounds,
} from './dispatchGeo'

/** Replicated verbatim -- the same precedent modelBodyAdapter.ts and
 *  modelBodyDerive.ts both document (each stays free of a src/doc/ dependency).
 *  Must equal src/doc/documentHolder.ts's LEGACY_MODEL_ITEM_ID byte-for-byte;
 *  pinned by this module's own test. */
const LEGACY_MODEL_ITEM_ID = 'legacy'

/** Missing item identity is the legacy item scope, never a wildcard. */
export function modelEdgeChainItemScope(modelItemId: string | null | undefined): string {
  return modelItemId ?? LEGACY_MODEL_ITEM_ID
}

/** The ModelReference role a picked modeled-body edge chain persists under.
 *  Named once here so the wizard, the store branch and the tests cannot drift
 *  on a string literal. */
export const MODEL_EDGE_CHAIN_ROLE = 'edge-chain' as const

// ── The capability gate ─────────────────────────────────────────────────────
//
// "Pick edges" on a MODELED BODY needs TWO independent things to be true, and
// they are deliberately two separate helpers because they fail for different
// reasons:
//
//  1. THE OP-TYPE AXIS. Can the CAM lane bind a picked edge chain for THIS
//     operation type and actually compute it? The picked edges derive to
//     world-space Loop2D[], so the answer is exactly "does this op consume a
//     modeled body as a computeSupported 'profile' binding" - read off
//     MODEL_BODY_BINDING_CAPABILITIES rather than hand-listed, so the two
//     records cannot drift.
//  2. THE VIEWPORT AXIS. Can the 3D view actually report an edge HIT on a
//     modeled body? WO-113 landed that capability on the production
//     CNCViewport (src/components/viewport/CNCViewport.ts), but the wizard
//     still PROBES the live handle rather than assuming it, so a stubbed or
//     older handle never arms a picker that cannot fire.

/** The optional capability a viewport handle advertises when its edge-mode
 *  raycast CAN return a modeled-body edge hit (`isModelEdge`, indexed into
 *  ModelBodyDisplay.edgeIds). Landed on the production CNCViewport by WO-113. */
export const MODEL_EDGE_PICK_VIEWPORT_CAPABILITY = 'supportsModelEdgePick'

export interface ModelBodyEdgeChainCapability {
  supported: boolean
  /** Refusal BY NAME when unsupported; empty string when supported. */
  reason: string
}

/** WO-114 shipped Contour; WO-1924 adds the rest of the computable profile
 *  family (Pocket, Adaptive Clearing); WO-1939 adds Engrave, which follows the
 *  picked edges as paths; WO-1940 adds V-carve, which carves the closed region
 *  they bound; WO-1941 adds Chamfer, which bevels the closed loop they form.
 *  Each has its own wizard save site. */
const MODEL_EDGE_CHAIN_OP_TYPES: readonly OperationType[] = [
  'contour_2d', 'pocket_2d', 'adaptive_clearing_2d', 'engrave', 'vcarve', 'chamfer',
]

/** 'edge-paths' families that still need a CLOSED chain, with the reason the
 *  closed-chain refusal gives. A V-carve fills the region the edges bound, so
 *  an open chain has no inside to carve. WO-1941: the chamfer engine
 *  (chamfer2d.ts) cuts closed loops only - it drops an open path, exactly as it
 *  does for an open path drawn in a sketch - so an open chain is refused at the
 *  pick rather than accepted and then silently cut as nothing. */
const CLOSED_CHAIN_REFUSALS: Partial<Record<OperationType, string>> = {
  vcarve:
    operatorText('modelEdgeChainBinding1'),
  chamfer:
    operatorText('modelEdgeChainBinding2'),
}

/** Can a picked chain on `opType` be an OPEN path? True for the 'edge-paths'
 *  families that cut along the edges themselves (Engrave); a profile family
 *  and V-carve need a closed border. Store compute and the wizard pass this to
 *  deriveModelBodyEdges so both derive the chain the same way. */
export function modelEdgeChainAllowsOpenPaths(opType: OperationType): boolean {
  return MODEL_BODY_BINDING_CAPABILITIES[opType].mode === 'edge-paths'
    && CLOSED_CHAIN_REFUSALS[opType] === undefined
}

/** The deriveModelBodyEdges options for a chain picked on `opType`. WO-1940: a
 *  V-carve's closed-chain refusal names the V-carve, not a contour; WO-1941
 *  likewise for a Chamfer. */
export function modelEdgeChainDeriveOptions(opType: OperationType): DeriveModelBodyEdgesOptions {
  const closedChainRefusal = CLOSED_CHAIN_REFUSALS[opType]
  return {
    openPaths: modelEdgeChainAllowsOpenPaths(opType),
    ...(closedChainRefusal !== undefined ? { closedChainRefusal } : {}),
  }
}

/**
 * Can a picked modeled-body EDGE CHAIN be bound and computed for `opType`?
 * Derived from MODEL_BODY_BINDING_CAPABILITIES, never a parallel hand-
 * maintained list.
 *
 * An op type must BOTH read as a computable 'profile' or 'edge-paths' binding
 * AND be named in MODEL_EDGE_CHAIN_OP_TYPES: the list records which types have
 * a wizard save site that persists the chain. Store compute's profile branch
 * consumes the derived chain loops for every such type alike.
 */
export function modelBodyEdgeChainBindingCapability(
  opType: OperationType,
): ModelBodyEdgeChainCapability {
  const capability = MODEL_BODY_BINDING_CAPABILITIES[opType]
  const profileComputable =
    (capability.mode === 'profile' || capability.mode === 'edge-paths') && capability.computeSupported
  if (MODEL_EDGE_CHAIN_OP_TYPES.includes(opType) && profileComputable) {
    return { supported: true, reason: '' }
  }
  if (profileComputable) {
    return {
      supported: false,
      reason:
        operatorText('modelEdgeChainBinding3', { value1: String(opType), value2: String(MODEL_EDGE_CHAIN_OP_TYPES.map((t) => `"${t}"`).join(', ')) }),
    }
  }
  return {
    supported: false,
    reason:
      edgeChainUnsupportedMessage(opType, capability.mode),
  }
}

/** Boolean form of modelBodyEdgeChainBindingCapability. */
export function modelBodyEdgeChainBindingSupported(opType: OperationType): boolean {
  return modelBodyEdgeChainBindingCapability(opType).supported
}

/**
 * Does this viewport handle advertise modeled-body edge hits? Probed on the
 * live handle (not assumed) so the wizard never arms a picker that can never
 * fire.
 */
export function viewportSupportsModelEdgePick(vp: unknown): boolean {
  if (vp === null || typeof vp !== 'object') return false
  const probe = (vp as Record<string, unknown>)[MODEL_EDGE_PICK_VIEWPORT_CAPABILITY]
  if (typeof probe !== 'function') return false
  return (probe as () => unknown).call(vp) === true
}

/**
 * The ONE gate the operation wizard uses to decide whether to render a
 * modeled-body "Pick edges" button: both axes must be true. Anything else and
 * the affordance stays hidden rather than arming a pick that cannot be honoured.
 */
export function modelBodyEdgePickOffered(opType: OperationType, vp: unknown): boolean {
  return modelBodyEdgeChainBindingSupported(opType) && viewportSupportsModelEdgePick(vp)
}

// ── The source-switch guard (THE defect WO-114 exists to close) ─────────────
//
// WO-095's audit, finding 3: after picking an edge chain on modeled body A, the
// wizard's geometry selector only called setGeoId - it did not clear the chain,
// and the "should this chain be persisted" predicate checked only that the new
// source was a model and the op type was supported. It never checked that the
// chain's bodyId matched the SELECTED body's id. Saving after a switch to body
// B therefore persisted A's edge reference with B as the operation source.
// Store compute then searched for an edge-chain reference ON B, did not find
// one, and silently fell through to B's face / section / whole-body profile.
//
// The operator picked an edge on one body, changed the source, saved, and got a
// toolpath computed from something they never chose - with no error at all.
//
// So the mismatch is answered ONCE, here, and BOTH seams call it: the wizard
// (which drops the chain and says so, rather than persisting it) and the store
// compute branch (which REFUSES BY NAME rather than falling through). Two
// independent layers deliberately: a wizard-only fix would leave every already-
// saved project carrying a mismatched reference exposed to the silent
// fall-through, and a store-only fix would let the wizard keep minting them.

/** The minimum an edge-chain draft/reference needs to be checked against a body. */
export interface ModelEdgeChainBinding {
  modelItemId?: string | null
  bodyId: string
  edgeStableIds: string[]
}

export interface ModelEdgeChainSource {
  modelItemId?: string | null
  bodyId?: string | null
  /** WO-1410: the source body's stable lineage root (ModelBodyRef.lineageId).
   *  Set only by modelReferenceSourceIdentity, and only when this source is the
   *  SOLE live body of that lineage in its Model Item. Absent = exact ids only. */
  lineageId?: string | null
  /** WO-1410: item-scoped "which lineage did this (possibly superseded) body id
   *  belong to". Undefined for an unknown id or an id another live body holds. */
  lineageOfBodyId?: (bodyId: string) => string | undefined
}

/** Compound identity shared by every CAM reference bound to an operation's
 *  selected modeled-body source. Raw body ids are only item-local.
 *
 *  WO-1410: a feature edit (resize a hole, push/pull) publishes the SAME part
 *  under a new leaf body id. A reference saved on an earlier leaf of the SAME
 *  lineage in the SAME Model Item still belongs to this source, so it matches
 *  and the subshape resolver downstream decides exact / migrated / ambiguous /
 *  lost. Anything else - another item, another lineage, or no lineage evidence
 *  at all - stays a mismatch. */
export function modelReferenceMatchesSource(
  reference: { modelItemId?: string | null; bodyId: string },
  source: ModelEdgeChainSource | null | undefined,
): boolean {
  if (!source?.bodyId) return false
  if (modelEdgeChainItemScope(reference.modelItemId) !== modelEdgeChainItemScope(source.modelItemId)) return false
  if (reference.bodyId === source.bodyId) return true
  if (!source.lineageId || !source.lineageOfBodyId) return false
  return source.lineageOfBodyId(reference.bodyId) === source.lineageId
}

/**
 * WO-1410: the ONE builder of a lineage-aware source identity for the store's
 * compute guards. `modelItemId` is the item scope the caller already uses for
 * this source; `historicalLineageOf` maps a superseded leaf id to its lineage
 * root from the item's model document (optional - without it only the current
 * leaf and the lineage root itself are recognised).
 *
 * Lineage evidence is withheld (exact ids only) when another live row in the
 * same item claims the same lineage, and a reference id that is some OTHER live
 * body's current id never resolves by lineage: both would be guesses.
 */
export function modelReferenceSourceIdentity(
  source: ImportedGeometry | undefined,
  modelItemId: string | null | undefined,
  geometry: readonly ImportedGeometry[],
  historicalLineageOf?: (bodyId: string) => string | undefined,
): ModelEdgeChainSource | undefined {
  if (!source || !isModelOriginGeometry(source)) return undefined
  const bodyId = source.modelBody?.ref.bodyId
  const identity: ModelEdgeChainSource = { modelItemId, bodyId }
  const lineageId = source.modelBody?.ref.lineageId
  if (!bodyId || !lineageId) return identity
  const scope = modelEdgeChainItemScope(modelItemId)
  const siblings = geometry.filter((g) => (
    g.id !== source.id
      && isModelOriginGeometry(g)
      && g.modelBody !== undefined
      && modelEdgeChainItemScope(g.modelItemId) === scope
  ))
  if (siblings.some((g) => (g.modelBody!.ref.lineageId ?? g.modelBody!.ref.bodyId) === lineageId)) {
    return identity
  }
  const liveSiblingBodyIds = new Set(siblings.map((g) => g.modelBody!.ref.bodyId))
  return {
    ...identity,
    lineageId,
    lineageOfBodyId: (referenceBodyId) => {
      if (liveSiblingBodyIds.has(referenceBodyId)) return undefined
      if (referenceBodyId === lineageId) return lineageId
      return historicalLineageOf?.(referenceBodyId)
    },
  }
}

/**
 * TRUE when `chain` was picked on a DIFFERENT body than `bodyId` names.
 *
 * A null/absent chain is not a mismatch (there is nothing bound). An absent
 * `bodyId` - a source that is not a modeled body at all, or one whose identity
 * has not synced - IS a mismatch while a chain is held: the chain cannot
 * possibly belong to it, and silently keeping the chain is the exact failure
 * this guard exists to stop.
 */
export function modelEdgeChainBodyMismatch(
  chain: ModelEdgeChainBinding | null | undefined,
  source: ModelEdgeChainSource | null | undefined,
): boolean {
  if (!chain) return false
  return !modelReferenceMatchesSource(chain, source)
}

function identityLabel(modelItemId: string | null | undefined, bodyId: string | null | undefined): string {
  return operatorText('modelEdgeChainBinding4', { value1: String(bodyId ?? operatorText('modelEdgeChainBinding5')), value2: String(modelEdgeChainItemScope(modelItemId)) })
}

/** The user-facing / operation-facing refusal for a mismatch, worded the same
 *  wherever it surfaces (wizard notice and store compute error alike) so the
 *  operator reads one sentence, not two dialects of it. */
export function modelEdgeChainMismatchMessage(
  chain: { modelItemId?: string | null; bodyId: string },
  sourceSubject: string,
  source: ModelEdgeChainSource | null | undefined,
): string {
  const sourceIdentity = source?.bodyId
    ? ` (${identityLabel(source.modelItemId, source.bodyId)})`
    : ''
  return (
    operatorText('modelEdgeChainBinding6', { value1: String(identityLabel(chain.modelItemId, chain.bodyId)), value2: String(sourceSubject), value3: String(sourceIdentity) })
  )
}

// ── deriveModelBodyEdges ────────────────────────────────────────────────────

/** How one picked edge id resolved against the body's CURRENT tessellation. */
export interface ModelEdgeResolution {
  /** the id the operation persisted at pick time. */
  persistedId: string
  /** the current-tessellation id it bound to. */
  resolvedId: string
  /** true when it bound by LINEAGE (the pair's lone survivor), not byte-identity. */
  migrated: boolean
}

export interface ModelBodyEdgeResult {
  /** World-space Loop2D[] chained from the picked edges: closed loops first,
   *  then (only when the caller allowed them) open paths. */
  loops: Loop2D[]
  /** Per-picked-edge resolution record, in the order the ids were supplied. */
  resolutions: ModelEdgeResolution[]
  /** Subset of `resolutions` that rebound by lineage - the caller MUST surface
   *  these (an approximate rebind is never silent). */
  migratedEdgeIds: string[]
  /** The common world Z the picked edge chain lies on. */
  z: number
}

/** mm tolerance for "these picked edges all lie on one Z plane". Same value and
 *  rationale as modelBodyDerive's FACE_Z_EPS: a 2.5D contour needs one flat
 *  cut plane. */
const EDGE_Z_EPS = 1e-3

/** Same defaults the whole-body profile derive uses, so a picked edge chain is
 *  not held to a different fidelity bar than the body outline beside it. */
const DEFAULT_SIMPLIFICATION_TOLERANCE = 0.02 // mm
const minPerimeterFor = (tol: number) => Math.max(0.1, tol * 6)

export interface DeriveModelBodyEdgesOptions {
  /** WO-1939: keep chains that do not close as OPEN paths (Engrave) instead of
   *  refusing them. Absent/false keeps the closed-border rule profile families
   *  need, byte-identical to before. */
  openPaths?: boolean
  /** WO-1940: why this operation needs a closed chain, naming it ("A V-carve
   *  needs a closed region ..."). Absent keeps the contour wording. */
  closedChainRefusal?: string
}

/** Layer id stamped on loops derived from a picked modeled-body edge chain,
 *  mirroring deriveModelBodyFace's 'model_face_layer'. */
export const MODEL_EDGE_LAYER_ID = 'model_edge_layer'

/**
 * WO-1941: the WCS Z of the plane a picked edge chain lies on - the chain's own
 * "geometry face". A Chamfer's default datum is the face its edge sits on; for
 * a sketch that is the sketch's plane, and for a picked model chain it is the
 * plane of the picked edges (deriveModelBodyEdges already refuses a chain that
 * is not planar and horizontal). Without this, the default datum asked the
 * modeled body for a height reference and was refused (dispatchGeo resolveTopZ).
 */
export function modelEdgeChainPlaneWcsZ(input: {
  opType: OperationType
  geo: ImportedGeometry
  edgeStableIds: readonly string[]
  setup: Setup
  geometryAll: ImportedGeometry[]
  sceneStock: SceneStock
  stocks: ReadonlyArray<PhysicalStock>
  placementRecords: readonly ModelItemPlacementRegistryEntry[]
}): number {
  const derived = deriveModelBodyEdges(
    input.geo, input.edgeStableIds, input.placementRecords, modelEdgeChainDeriveOptions(input.opType),
  )
  // derived.z is already WORLD Z (placement composed). Express it against the
  // same effective WCS baseline every model-aware Z resolver uses
  // (resolveGeometryZToFramesModelAware), so the chain plane and a stock-top
  // datum on the same body cannot disagree about where the WCS sits.
  const { bounds } = resolveModelSourceOwningStockBounds(
    input.geo, input.geometryAll, input.sceneStock, input.stocks, input.placementRecords,
  )
  return derived.z - effectiveWcsOriginZ(input.setup.wcs, bounds)
}

/**
 * The stand-in geometry an op computes from once its picked edge chain is
 * derived: the body with the chain's loops in place of its own. WO-1941: a
 * Chamfer's Smart Height binds each loop by its SOURCE LAYER
 * (deriveChamferEdgeBindings), so for a Chamfer the stand-in also carries the
 * layer the chain loops name - without it every chain loop reads as orphaned.
 * Other families get exactly the stand-in they had before. The wizard and
 * store compute both build it here, so both bind the same evidence.
 */
export function modelEdgeChainSourceGeometry(
  opType: OperationType,
  geo: ImportedGeometry,
  loops: Loop2D[],
): ImportedGeometry {
  if (opType !== 'chamfer') return { ...geo, loops }
  return {
    ...geo,
    loops,
    layers2d: [
      ...(geo.layers2d ?? []).filter((layer) => layer.id !== MODEL_EDGE_LAYER_ID),
      { id: MODEL_EDGE_LAYER_ID, name: operatorText('modelEdgeChainBinding7'), color: '#888888', visible: true },
    ],
  }
}

// Replicated from modelBodyDerive.ts (see the lane note at the top of this
// file). Loop classification is by NESTING, not by signed area: a Model-kernel
// tessellation's triangle winding convention is unverified and has been
// observed to flip, so a sign-based contour/hole split misclassifies loops.
function pointInPolygon(pt: { x: number; y: number }, poly: ReadonlyArray<{ x: number; y: number }>): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y
    const xj = poly[j].x, yj = poly[j].y
    const crosses = (yi > pt.y) !== (yj > pt.y)
    if (crosses && pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
function loopCentroid(points: ReadonlyArray<{ x: number; y: number }>): { x: number; y: number } {
  let sx = 0, sy = 0
  for (const p of points) { sx += p.x; sy += p.y }
  return { x: sx / points.length, y: sy / points.length }
}
function polygonArea(points: ReadonlyArray<{ x: number; y: number }>): number {
  let a = 0
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length
    a += points[i].x * points[j].y - points[j].x * points[i].y
  }
  return Math.abs(a) / 2
}
/** Same 10-micron vertex snap stlProjection's buildLoops chains on, so the
 *  open-path chainer below joins exactly the endpoints buildLoops joins. */
const CHAIN_SNAP = 0.01
const chainKey = (p: { x: number; y: number }) =>
  `${Math.round(p.x / CHAIN_SNAP)},${Math.round(p.y / CHAIN_SNAP)}`

/**
 * WO-1939: chain picked segments into polylines, OPEN ones included - the
 * open-capable sibling of buildLoops, which drops every chain that does not
 * close. Walks start at odd-degree vertices (path ends) first, so an open run
 * is traced end to end; what remains is cycles. Every segment is consumed
 * exactly once, so a branching pick becomes several paths, never a lost edge.
 */
function chainSegmentsWithOpenPaths(
  segs: ReadonlyArray<[{ x: number; y: number }, { x: number; y: number }]>,
): Array<{ points: Array<{ x: number; y: number }>; closed: boolean }> {
  const from: string[] = [], to: string[] = [], used: boolean[] = []
  const vertexEdges = new Map<string, number[]>()
  const vertexPoint = new Map<string, { x: number; y: number }>()
  for (const [a, b] of segs) {
    const ka = chainKey(a), kb = chainKey(b)
    if (ka === kb) continue
    if (!vertexPoint.has(ka)) vertexPoint.set(ka, a)
    if (!vertexPoint.has(kb)) vertexPoint.set(kb, b)
    const e = from.length
    from.push(ka); to.push(kb); used.push(false)
    for (const k of [ka, kb]) {
      const list = vertexEdges.get(k)
      if (list) list.push(e)
      else vertexEdges.set(k, [e])
    }
  }
  const chains: Array<{ points: Array<{ x: number; y: number }>; closed: boolean }> = []
  const walk = (startKey: string) => {
    const keys = [startKey]
    let curr = startKey
    for (;;) {
      const next = (vertexEdges.get(curr) ?? []).find((e) => !used[e])
      if (next === undefined) break
      used[next] = true
      curr = from[next] === curr ? to[next] : from[next]
      keys.push(curr)
      if (curr === startKey) break
    }
    const closed = keys.length > 3 && keys[keys.length - 1] === startKey
    if (closed) keys.pop()
    chains.push({ points: keys.map((k) => vertexPoint.get(k)!), closed })
  }
  for (const [key, edges] of vertexEdges) {
    if (edges.length % 2 === 1) {
      while (edges.some((e) => !used[e])) walk(key)
    }
  }
  for (let e = 0; e < from.length; e++) {
    if (!used[e]) walk(from[e])
  }
  return chains
}

function reclassifyLoopsByNesting(loops: readonly Loop2D[]): Loop2D[] {
  // AREA-ORDERED containment, largest first: a loop is a 'hole' only if its
  // centroid falls inside a LARGER loop. Checking only against larger loops
  // avoids the concentric-shapes trap a bidirectional test falls into.
  const byArea = [...loops].sort((a, b) => polygonArea(b.points) - polygonArea(a.points))
  return byArea.map((loop, i) => {
    const larger = byArea.slice(0, i)
    const c = loopCentroid(loop.points)
    const nested = larger.some((other) => pointInPolygon(c, other.points))
    return { ...loop, type: nested ? 'hole' : 'contour' }
  })
}

/** The CSR edge-table checks, in one place, so pick time and compute time
 *  refuse identically. Returns the validated table or throws BY NAME. */
function validatedEdgeTable(
  geo: ImportedGeometry,
  display: ModelBodyDisplay | undefined,
): ModelBodyDisplay & { edgeIds: string[] } {
  if (!display || display.edgePositions.length === 0 || display.edgeOffsets.length < 2) {
    throw new ModelBodyDeriveError(
      operatorText('modelEdgeChainBinding8', { value1: String(geo.name) }),
    )
  }
  // Absent edgeIds is the pre-VIEWPORT-BODY-PRESENTATION-UNIFY payload. Per that
  // field's own contract a consumer must NOT invent identities - refuse and say
  // how to fix it, never fall back to a positional index.
  if (!display.edgeIds || display.edgeIds.length === 0) {
    throw new ModelBodyDeriveError(
      operatorText('modelEdgeChainBinding9', { value1: String(geo.name) }),
    )
  }
  // CSR invariant: one offset per edge plus the trailing sentinel. A payload that
  // breaks it would silently slice the wrong polyline for every edge past the
  // break, so it is a refusal, not a clamp.
  if (display.edgeOffsets.length !== display.edgeIds.length + 1) {
    throw new ModelBodyDeriveError(
      operatorText('modelEdgeChainBinding10', { value1: String(geo.name), value2: String(display.edgeIds.length), value3: String(display.edgeOffsets.length), value4: String(display.edgeIds.length + 1) }),
    )
  }
  return display as ModelBodyDisplay & { edgeIds: string[] }
}

/**
 * Derive a picked EDGE CHAIN on a modeled body as world-space Loop2D[], keyed
 * by the edges' ElementMap stableIds. `placementRecords` mirrors every sibling
 * derive's purity contract (the project's `modelItemPlacements`, passed in).
 *
 * `persistedEdgeIds` are the ids the operation stored at pick time. They are
 * re-resolved against the body's CURRENT tessellation on every call, which is
 * what makes a bound edge survive a model rebuild or refuse out loud.
 */
export function deriveModelBodyEdges(
  geo: ImportedGeometry,
  persistedEdgeIds: readonly string[],
  placementRecords: readonly ModelItemPlacementRegistryEntry[],
  options: DeriveModelBodyEdgesOptions = {},
): ModelBodyEdgeResult {
  if (!isModelOriginGeometry(geo)) {
    throw new ModelBodyDeriveError(
      operatorText('modelEdgeChainBinding11', { value1: String(geo.name), value2: String(geo.format) }),
    )
  }
  if (persistedEdgeIds.length === 0) {
    throw new ModelBodyDeriveError(
      operatorText('modelEdgeChainBinding12', { value1: String(geo.name) }),
    )
  }

  const display = validatedEdgeTable(geo, geo.modelBody?.display)
  const currentIds = display.edgeIds
  const resolutions: ModelEdgeResolution[] = []
  for (const persistedId of persistedEdgeIds) {
    const res = resolvePersistedEdgeId(persistedId, currentIds)
    switch (res.status) {
      case 'exact':
        resolutions.push({ persistedId, resolvedId: res.id, migrated: false })
        break
      case 'migrated':
        resolutions.push({ persistedId, resolvedId: res.id, migrated: true })
        break
      case 'ambiguous':
        throw new ModelBodyDeriveError(
          operatorText('modelEdgeChainBinding13', { value1: String(geo.name), value2: String(persistedId), value3: String(res.count), value4: String(res.base) }),
        )
      case 'lost':
        throw new ModelBodyDeriveError(
          operatorText('modelEdgeChainBinding14', { value1: String(geo.name), value2: String(persistedId) }),
        )
      default: {
        const _exhaustive: never = res
        throw new ModelBodyDeriveError(operatorText('modelEdgeChainBinding15', { value1: String(JSON.stringify(_exhaustive)) }))
      }
    }
  }

  const itemId = geo.modelItemId ?? LEGACY_MODEL_ITEM_ID
  const bodyId = geo.modelBody?.ref.bodyId
  let frame: { position: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number } }
  try {
    frame = resolveModelReferenceFrame(placementRecords, itemId, bodyId)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new ModelBodyDeriveError(
      operatorText('modelEdgeChainBinding16', { value1: String(geo.name), value2: String(message) }),
    )
  }
  // WO-1561: a tilted or flipped Placement bakes the full placement into the
  // edge polylines first, so the chain is traced in world XY exactly as on the
  // placed body and must lie on one horizontal plane AS PLACED. A Z-preserving
  // Placement keeps the local trace + XY rotation below.
  const tilted = isTiltedOffZ(frame.rotation)
  const edgePositions = tilted ? placedWorldPositions(display.edgePositions, frame) : display.edgePositions

  // Gather each resolved edge's CSR polyline as XY segments, and check as we go
  // that the whole picked set lies on ONE Z plane (the 2.5D rule
  // deriveModelBodyFace applies to a face, applied here to the chain).
  const segs: Array<[{ x: number; y: number }, { x: number; y: number }]> = []
  let minLocalZ = Infinity, maxLocalZ = -Infinity
  for (const { resolvedId, persistedId } of resolutions) {
    const edgeIndex = currentIds.indexOf(resolvedId)
    if (edgeIndex === -1) {
      // Unreachable: resolvePersistedEdgeId only returns ids drawn from currentIds.
      throw new ModelBodyDeriveError(
        operatorText('modelEdgeChainBinding17', { value1: String(geo.name), value2: String(resolvedId), value3: String(persistedId) }),
      )
    }
    const start = display.edgeOffsets[edgeIndex]
    const end = display.edgeOffsets[edgeIndex + 1]
    if (!(end > start + 1)) {
      throw new ModelBodyDeriveError(
        operatorText('modelEdgeChainBinding18', { value1: String(geo.name), value2: String(persistedId) }),
      )
    }
    for (let p = start; p < end; p++) {
      const z = edgePositions[p * 3 + 2]
      if (z < minLocalZ) minLocalZ = z
      if (z > maxLocalZ) maxLocalZ = z
    }
    for (let p = start; p + 1 < end; p++) {
      const a = p * 3, b = (p + 1) * 3
      segs.push([
        { x: edgePositions[a], y: edgePositions[a + 1] },
        { x: edgePositions[b], y: edgePositions[b + 1] },
      ])
    }
  }
  if (tilted && maxLocalZ - minLocalZ > EDGE_Z_EPS) {
    throw new ModelBodyDeriveError(
      operatorText('modelEdgeChainBinding19', { value1: String(geo.name), value2: String((maxLocalZ - minLocalZ).toFixed(4)) }),
    )
  }
  if (maxLocalZ - minLocalZ > EDGE_Z_EPS) {
    throw new ModelBodyDeriveError(
      operatorText('modelEdgeChainBinding20', { value1: String(geo.name), value2: String((maxLocalZ - minLocalZ).toFixed(4)) }),
    )
  }

  const tol = DEFAULT_SIMPLIFICATION_TOLERANCE
  const minPerim = minPerimeterFor(tol)

  // WO-1939: an edge-paths consumer (Engrave) cuts ALONG the picked edges, so a
  // chain that does not close is an open path to follow, not a broken border.
  let rawChains: Array<Array<{ x: number; y: number }>>
  const openPaths: Loop2D[] = []
  if (options.openPaths) {
    rawChains = []
    for (const chain of chainSegmentsWithOpenPaths(segs)) {
      if (chain.closed) {
        rawChains.push(chain.points)
        continue
      }
      const simplified = dp(chain.points, tol)
      const length = simplified.reduce((sum, p, i) => (
        i === 0 ? 0 : sum + Math.hypot(p.x - simplified[i - 1].x, p.y - simplified[i - 1].y)
      ), 0)
      if (simplified.length < 2 || length < minPerim) continue
      openPaths.push({
        id: '',
        points: simplified.map((p) => ({ x: p.x, y: p.y })),
        closed: false,
        type: 'open',
        layerId: MODEL_EDGE_LAYER_ID,
        area: 0,
      })
    }
  } else {
    rawChains = buildLoops(segs)
  }

  // buildLoops keeps only chains that CLOSE, so an open/broken pick would other-
  // wise vanish silently. Compare what it consumed against what we handed it and
  // refuse by name instead (the "no silent wrong answer" rule).
  const consumedPoints = rawChains.reduce((sum, chain) => sum + chain.length, 0)
  if (!options.openPaths && (rawChains.length === 0 || consumedPoints < segs.length)) {
    throw new ModelBodyDeriveError(
      operatorText('modelEdgeChainBinding21', { value1: String(geo.name), value2: String(segs.length), value3: String(consumedPoints), value4: String(rawChains.length), value5: String((options.closedChainRefusal
          ?? operatorText('modelEdgeChainBinding22'))) }),
    )
  }

  const rawLocalLoops: Loop2D[] = []
  for (const chain of rawChains) {
    if (chain.length < 3) continue
    const simplified = dp(chain, tol)
    if (simplified.length < 3) continue
    const perim = simplified.reduce((s, p, i) => {
      const n = simplified[(i + 1) % simplified.length]
      return s + Math.hypot(n.x - p.x, n.y - p.y)
    }, 0)
    if (perim < minPerim) continue
    rawLocalLoops.push({
      id: '',
      points: simplified.map((p) => ({ x: p.x, y: p.y })),
      closed: true,
      type: 'contour', // placeholder - reclassifyLoopsByNesting below is authoritative
      layerId: MODEL_EDGE_LAYER_ID,
      area: polygonArea(simplified),
    })
  }
  if (rawLocalLoops.length === 0 && openPaths.length === 0) {
    throw new ModelBodyDeriveError(
      operatorText('modelEdgeChainBinding23', { value1: String(geo.name) }),
    )
  }
  const localLoops = [...reclassifyLoopsByNesting(rawLocalLoops), ...openPaths]

  const pose: GeoPose = { position: frame.position, rotation: frame.rotation }
  const loops: Loop2D[] = localLoops.map((loop, i) => ({
    ...loop,
    // Stable, content-free ids so the op's loopIds (when it carries any) and
    // the derived set cannot alias a DIFFERENT geometry's loop ids.
    id: `mde:${i}`,
    points: tilted ? loop.points : transformLoopPoints(loop.points, pose),
  }))

  return {
    loops,
    resolutions,
    migratedEdgeIds: resolutions.filter((r) => r.migrated).map((r) => r.persistedId),
    z: (minLocalZ + maxLocalZ) / 2 + (tilted ? 0 : frame.position.z),
  }
}
