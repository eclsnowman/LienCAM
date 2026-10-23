import { operatorText } from '../i18n/locales/en/console-and-operator-messages'
// Pure dispatch-time geometry helpers for computeOperationToolpath.
//
// B-rep derived layers (Layer2D.frame === 'geometry_local') store loop points,
// projection-plane Z, selectedFaceZ, and HoleFeature Z values in RAW MODEL
// coordinates — the model worker reads the cached STEP shape, which never sees
// the viewport gizmo transform. The store applies the owning geometry's
// transform at dispatch, mirroring the existing DXF/SVG loop branch and the
// WCS snap recompute (applyGeoSnapToSetups). Extracted here as pure functions
// so the math is unit-testable without the viewport or a worker.

import type {
  Vec2, Vec3, Layer2D, HoleFeature, HeightParams, ImportedGeometry,
  Setup, SceneStock, FixedStockItem, PhysicalStock, ProjectionZAnchor,
  CylinderFeature,
} from '../types'
import type { ChamferHeightReference, LoopData } from '../lib/cam/types'
import { deriveStockBounds, stockWorldBounds } from './stockAssignment'
import { isModelOriginGeometry, modelOriginRefusal } from '../lib/cam/modelOrigin'
import { resolveModelReferenceFrame } from '../lib/cam/modelReferenceFrame'
import type { ModelItemPlacementRegistryEntry } from '../lib/cam/modelItemPlacement'
import { rotationMatrixXYZ } from '../lib/geometry/rotationMatrixXYZ'

// Replicated here verbatim -- NOT imported -- mirroring modelBodyAdapter.ts's
// and modelBodyDerive.ts's own documented precedent for this exact constant
// (see modelBodyDerive.ts's header for the full rationale). Must equal
// src/doc/documentHolder.ts's LEGACY_MODEL_ITEM_ID byte-for-byte.
const LEGACY_MODEL_ITEM_ID = 'legacy'

/** An empty placement-records list, shared so every call site that has no
 *  Placement context yet (e.g. a pure-fixture test, or a caller that predates
 *  CAM-BINDING Stage 3) gets the EXACT byte-identical pre-Stage-3 behavior for
 *  model-origin geometry: it contributes no bounds (see modelBodyWorldBounds),
 *  never a crash, never a silently wrong box. */
export const NO_PLACEMENTS: readonly ModelItemPlacementRegistryEntry[] = []

// ─────────────────────────────────────────────────────────────────────────────
// INT-17A-R2 C1: THE compute boundary guard.
//
// R1 put the model-origin exclusion at resolveOpGeometrySources - the seam that
// turns an op's `geometryId` into its SOURCE ROWS. The audit then showed the
// coordinate/height resolvers below are handed the WHOLE project.geometry
// collection on a SEPARATE argument (store/index.ts `geometryForResolve`), so a
// loop-bearing modeled row walked straight back into compute and made a
// LEGITIMATE all-parts op throw "not assigned to an existing stock" - because
// R1's own C3 rule is that a modeled body is never stock-bound.
//
// The auditor's third finding proposed answering this with a wider reader
// census. DECISIONS.md 2026-07-18 (SKC-59 census two-bounce STOP, part 3) rules
// that class of criterion out: "before demanding a derived census, ask whether a
// boundary invariant enforces the same truth at the data's arrival point -
// prefer the boundary guard". That is exactly the shape here. The geometry
// COLLECTION arrives at these resolvers through their `geometry` parameter, so
// the invariant is enforced THERE, once, at arrival:
//
//   - every caller is covered by construction - present, future, aliased
//     through a parameter, or reached via a helper the census could not name;
//   - no enumeration is needed for SAFETY, which is what makes the census a
//     tripwire rather than a proof obligation;
//   - the refusal is NAMED and user-visible (store/index.ts surfaces
//     ModelOriginComputeError as the operation's errorMessage, exactly like
//     OwningStockError), so a modeled body is never a silent empty resolution.
//
// Two directions, deliberately different:
//   REFERENCED by id -> THROW. The op is asking to cut/reference this specific
//     body. Silence there reads as "computed fine" and is how a wrong toolpath
//     ships (ADR-0003).
//   PRESENT in the collection -> FILTER. The op is not about this body at all;
//     blocking a good op because a modeled card exists elsewhere in the project
//     is the fail-closed defect the audit actually reproduced.
// ─────────────────────────────────────────────────────────────────────────────

/** Fail-loud error for an operation that references model-origin geometry.
 *  Tagged like OwningStockError so the dispatch surfaces it as the op's
 *  errorMessage instead of throwing into the void (ADR-0003). */
export class ModelOriginComputeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModelOriginComputeError'
  }
}

/**
 * The ONE named compute-boundary seam. Call it where a geometry COLLECTION
 * arrives at a compute/resolution helper.
 *
 * THROWS ModelOriginComputeError when any of `referencedIds` names a
 * model-origin row (the op is explicitly asking for that body), otherwise
 * returns the collection with model-origin rows removed.
 *
 * IDEMPOTENT: the resolvers nest (resolveTopZ -> resolveOwningStock ->
 * owningStockWorldBounds), so a second application must be a no-op, not a
 * second policy decision. Returns the SAME array reference when nothing is
 * filtered, so an ordinary project pays one predicate pass and no allocation.
 *
 * `'__all__'` and `''` are aggregate/stock-mode sentinels, not geometry ids, and
 * are ignored as references - an all-parts op references no single body.
 */
function assertNoModelOriginReference<T extends { id: string; format?: string }>(
  geometry: ReadonlyArray<T>,
  referencedIds: ReadonlyArray<string | undefined>,
): void {
  for (const id of referencedIds) {
    if (id === undefined || id === '' || id === '__all__') continue
    const referenced = geometry.find((g) => g.id === id)
    if (isModelOriginGeometry(referenced)) {
      // CAM-BINDING Stage 1: this same throw fires for BOTH an op's declared
      // PRIMARY source (guardOperationModelOrigin's top-level call, index.ts)
      // and a deeper coordinate/height REFERENCE (resolveOwningStock/
      // resolveTopZ/etc below). The primary-source caller DISCARDS this
      // message and substitutes its own Stage-1-aware one (OperationStatus
      // 'unsupported', not 'error') - so in practice only the reference case
      // ever surfaces this exact text to a user.
      throw new ModelOriginComputeError(
        modelOriginRefusal(
          operatorText('dispatchGeo1'),
          (referenced as { name?: string }).name || id,
          operatorText('dispatchGeo2'),
        ),
      )
    }
  }
}

/** WO-1572: TRUE when this row is marked workholding (a vise, clamp or
 *  fixture). Workholding is never stock, never a part and never cut. */
export function isWorkholdingGeometry(geo: { workholding?: boolean } | null | undefined): boolean {
  return geo?.workholding === true
}

export function computeGeometryScope<T extends { id: string; format?: string; stockId?: string }>(
  geometry: ReadonlyArray<T>,
  ...referencedIds: ReadonlyArray<string | undefined>
): T[] {
  assertNoModelOriginReference(geometry, referencedIds)
  const eligible = geometry.filter((g) => !isModelOriginGeometry(g))
  return eligible.length === geometry.length ? (geometry as T[]) : eligible
}

/**
 * CAM-BINDING Stage 3 follow-on opt-in (mistral-stock-heights trial, audited -
 * see coordination/model-trials/longhorizon-2026-07/mistral-stock-heights/
 * report.md + audit.md). IDENTICAL to computeGeometryScope except a
 * model-origin row deliberately LOCKED to a stock (stockId !== undefined -
 * Stage 3's "use this body as stock" flow) is NOT excluded.
 *
 * SCOPE THIS NARROWLY - it is only safe where the resulting collection flows
 * exclusively into PLACEMENT-COMPOSING readers (geometryWorldBounds /
 * modelBodyWorldBounds, reached via owningStockWorldBounds ->
 * deriveStockBounds). A model row's OWN position/rotation stay IDENTITY
 * forever (INT-17C) - its real world pose lives only in the Placement
 * registry - so any consumer that reads geo.position / geo.boundingBox
 * DIRECTLY (resolveModelBottomZ, and resolveTopZ's model_top/geometry_face
 * aggregate branches) must never see rows scoped by this function: audit.md
 * Q1 reproduced exactly that class of defect live (a stock-bound model row
 * with local bbox min.z=-50 dragged an '__all__' bottom plane to -50
 * regardless of where the body was actually placed). Wired ONLY into
 * resolveTopZ's own stock_top/stock_bottom branch, and threaded from there
 * into resolveOwningStock / owningStockWorldBounds via their
 * `includeStockBoundModelRows` flag - audit.md Q2's consumer-safety table
 * cleared exactly these call sites, in this flow only. Do NOT wire this into
 * resolveModelBottomZ or a resolveOwningStock call reached from it.
 */
export function computeGeometryScopeIncludingStockBoundModelRows<
  T extends { id: string; format?: string; stockId?: string },
>(geometry: ReadonlyArray<T>, ...referencedIds: ReadonlyArray<string | undefined>): T[] {
  assertNoModelOriginReference(geometry, referencedIds)
  const eligible = geometry.filter((g) => !isModelOriginGeometry(g) || g.stockId !== undefined)
  return eligible.length === geometry.length ? (geometry as T[]) : eligible
}

/** Minimal geometry pose: world position + Euler rotation in DEGREES.
 *  rotation is optional at runtime: geometry persisted before the field
 *  existed (or created by a path that skips it) rehydrates without one. */
export interface GeoPose {
  position: Vec3
  rotation?: Vec3
}

/**
 * Map geometry-local XY points to world XY: rotate by the geometry's EFFECTIVE
 * Z angle (degrees, about the origin) then translate by position.x/y. Exactly
 * the math of the DXF/SVG dispatch branch and applyGeoSnapToSetups.
 *
 * NOT rotation.z verbatim: the viewport syncs the gizmo back through a
 * quaternion -> Euler XYZ round-trip, and a Z-preserving rotation has TWO
 * Euler representations — canonical (0, 0, theta) and flipped
 * (180, 180, theta - 180). For the flipped triple rotation.z alone is wrong
 * by 180 deg; effectiveZRotationDeg extracts the true angle from the rotation
 * matrix so both representations transform identically. Genuine X/Y tilt is
 * NOT handled — callers must reject tilted sources first (ADR 0003 loud
 * failure; see findTiltedGeometryLocalSource).
 */
export function transformLoopPoints(points: ReadonlyArray<Vec2>, geo: GeoPose): Vec2[] {
  // Missing rotation (older saved projects / partially-initialized geometry)
  // reads as zero — this runs BEFORE the tilt guard at dispatch, so it must
  // not throw on a geometry that predates the rotation field.
  const rotRad = (effectiveZRotationDeg(geo.rotation) * Math.PI) / 180
  const cosR = Math.cos(rotRad)
  const sinR = Math.sin(rotRad)
  return points.map(p => ({
    x: p.x * cosR - p.y * sinR + geo.position.x,
    y: p.x * sinR + p.y * cosR + geo.position.y,
  }))
}

/**
 * Synthesize avoid-ISLAND loops for the standing BOSSES of a B-rep part so a
 * stock-boundary pocket clears AROUND them instead of cutting into them.
 *
 * PURE geometry (no store access, no await): filters the cylinder features to
 * `kind === 'boss'`, builds an N-point (default 64) CCW circle in the part's
 * MODEL-LOCAL frame at each boss center (matching the 64-point circle synthesis
 * in deriveBrepLayer), then maps it to WORLD via transformLoopPoints(geo) so it
 * lands in the same frame as the already-world stock footprint loop. Each loop
 * is tagged `type: 'hole'` so classifyLoops (pocket2d) routes it as an ISLAND,
 * not as the boundary. Bores (inward voids) are ignored — they are not standing
 * material. This is geometry/avoidance ONLY; it never touches cut depth.
 */
export function bossIslandLoops(
  features: ReadonlyArray<CylinderFeature>,
  geo: GeoPose,
  segments = 64,
): LoopData[] {
  const out: LoopData[] = []
  for (const f of features) {
    if (f.kind !== 'boss') continue
    const r = f.diameter / 2
    const local: Vec2[] = Array.from({ length: segments }, (_, k) => {
      const a = (2 * Math.PI * k) / segments
      return { x: f.center[0] + r * Math.cos(a), y: f.center[1] + r * Math.sin(a) }
    })
    // LoopData carries id/points/closed/type only (no area field); set those.
    out.push({
      id: `__boss_island_${out.length}__`,
      points: transformLoopPoints(local, geo),
      closed: true,
      type: 'hole',
    })
  }
  return out
}

/**
 * Smart "clear to the deck" depth for a stock-boundary rough (pocket/adaptive)
 * on ONE part. The deck is the lowest boss BASE: the world Z where standing
 * bosses meet the body, i.e. min(bottomZ) over the part's boss cylinders plus
 * the part's geometry-local-to-world Z offset (geomPositionZ — CylinderFeature
 * bottomZ is GEOMETRY-LOCAL, see types/index.ts). Returns a planeOffset =
 * deckWorldZ - stockTopWorldZ, which is NEGATIVE for a normal part whose deck
 * sits below the stock top, so resolveStockBottomPlane pins the cut bottom at
 * the deck and the rough clears down to it, leaving bosses standing.
 *
 * Returns null when the part has NO bosses (a flat/2D part — caller keeps its
 * fixed fallback depth). CONTRACT for the degenerate case where the deck is at
 * or above the stock top: the arithmetic is returned as-is (>= 0). The caller
 * is responsible for only applying a NEGATIVE result (the modal applies the
 * offset only when off < 0), so a non-negative result naturally keeps the
 * fallback rather than producing an upward "cut".
 *
 * Pure: no worker calls, no store access — the async deriveCylinders /
 * getStockBounds lookups live in the store action that feeds this helper.
 */
export function deckRoughOffset(
  cylinders: ReadonlyArray<{ kind: string; bottomZ: number }>,
  geomPositionZ: number,
  stockTopWorldZ: number,
): number | null {
  let deckLocal = Infinity
  for (const c of cylinders) {
    if (c.kind === 'boss') deckLocal = Math.min(deckLocal, c.bottomZ)
  }
  if (!isFinite(deckLocal)) return null
  return deckLocal + geomPositionZ - stockTopWorldZ
}

/**
 * True when the layer's loops are already WORLD coordinates and must be sent
 * as-is at dispatch (STL projections bake world coords at projection time).
 * geometry_local layers also carry a projectionPlane but need the transform.
 */
export function isWorldBakedLayer(layer: Pick<Layer2D, 'projectionPlane' | 'frame'>): boolean {
  return layer.projectionPlane !== undefined && layer.frame !== 'geometry_local'
}

/**
 * World Z of a layer's projection plane. geometry_local planes store the model
 * Z, so the owning geometry's position.z is added; world-baked planes (STL
 * projections) are returned verbatim.
 */
export function layerPlaneWorldZ(
  layer: Pick<Layer2D, 'projectionPlane' | 'frame'>,
  geo: GeoPose,
): number | undefined {
  if (!layer.projectionPlane) return undefined
  return layer.projectionPlane.origin.z + (layer.frame === 'geometry_local' ? geo.position.z : 0)
}

/**
 * Predicate: is this source geometry's captured Z a GEOMETRY-LOCAL model Z that
 * must have position.z added to reach world? TRUE for any defined source geo.
 *
 * Background (H0, escape-hatch E2): selectedFaceZ is captured ONLY by the B-rep
 * (step) wizard (NewOperationModal runBrepDerive / runBrepFaceDerives /
 * runCylinderLoopDerive), always in the geometry-LOCAL model frame. The legacy
 * selectedFaceWorldZ keyed the position.z add on `format === 'step'`, an
 * INCONSISTENT proxy vs its siblings layerPlaneWorldZ / holeBottomWorldZ (both
 * key on layer.frame === 'geometry_local'). Universalizing to "any defined geo"
 * is byte-identical for every REACHABLE case today (the only producers are step
 * sources) yet stays correct the day a non-step geometry-local source feeds a
 * selected_face Z. A missing source geo (deleted, or geometryId '__all__')
 * stays verbatim (no position.z to add). World-baked STL projection layers are
 * NOT a concern here: selectedFaceZ is never captured from one (this converter
 * only handles selectedFaceZ, not layer planes).
 */
export function isGeometryLocalSource(
  geo: Pick<ImportedGeometry, 'format'> | undefined,
): boolean {
  return geo !== undefined
}

/**
 * Pure coordinate converter (H0 locked seam): express a GEOMETRY-LOCAL model Z
 * in the WORLD and WCS frames in one call, so the dispatch, the modal preview,
 * and the properties panel all agree on the selected-face Z (ADR-0020 rule 5).
 *
 *   worldZ = localZ + (isGeometryLocalSource(geo) ? geo.position.z : 0)
 *   wcsZ   = worldZ - setup.wcs.origin.z
 *
 * `localZ` is a geometry-local model Z (exactly as selectedFaceZ is stored).
 * When `geo` is undefined (deleted geometry / geometryId '__all__') worldZ is
 * the localZ verbatim. wcsZ is WCS-RELATIVE: resolveHeights (heights.ts) adds
 * wcs.origin.z back to every plane at the very end, so the dispatch payload must
 * carry the WCS-relative value, never re-add the origin (ADR-0002).
 */
/** CAM-DRILL-FIX3: world-Z of a geometry row's own ORIGIN - geo.position.z
 *  for a regular row, or a model-origin row's real PLACEMENT position.z
 *  (composed via resolveModelReferenceFrame) for a model-origin row, whose
 *  own geo.position stays IDENTITY forever (INT-17C; the real world pose
 *  lives only in the Placement registry - mirrors modelBodyWorldBounds's
 *  identical rationale for bounding boxes, just for a scalar Z). Falls back
 *  to geo.position.z (always 0 for a model row) when no Placement record
 *  resolves, so a caller with no placement context (the NO_PLACEMENTS
 *  default) stays byte-identical to pre-CAM-DRILL-FIX3 behavior - never a
 *  crash, mirroring modelBodyWorldBounds's own catch-and-fall-back
 *  precedent. */
function modelGeoOriginZ(
  geo: Pick<ImportedGeometry, 'position' | 'format' | 'modelItemId' | 'modelBody'>,
  placementRecords: readonly ModelItemPlacementRegistryEntry[],
): number {
  if (!isModelOriginGeometry(geo)) return geo.position.z
  try {
    const itemId = geo.modelItemId ?? LEGACY_MODEL_ITEM_ID
    const bodyId = geo.modelBody?.ref.bodyId
    return resolveModelReferenceFrame(placementRecords, itemId, bodyId).position.z
  } catch {
    return geo.position.z
  }
}

export function resolveGeometryZToFrames(
  localZ: number,
  geo: Pick<ImportedGeometry, 'format' | 'position' | 'modelItemId' | 'modelBody'> | undefined,
  setup: { wcs: { origin: { z: number } } },
  // CAM-DRILL-FIX3: optional Placement context (default NO_PLACEMENTS, the
  // exact pre-existing fallback every other placement-aware resolver in this
  // file uses) so a model-origin `geo` composes its REAL world position
  // instead of its permanently-identity geo.position.z. Omitting it is
  // byte-identical to before this lane for every caller that predates it.
  placementRecords: readonly ModelItemPlacementRegistryEntry[] = NO_PLACEMENTS,
  // CAM-DRILL-FIX3: optional override for the WCS-Z baseline the worldZ is
  // expressed relative to. When provided (resolveGeometryZToFramesModelAware
  // computes it via effectiveWcsOriginZ), used INSTEAD of the raw
  // setup.wcs.origin.z - the same "possibly stale for a model-only derived
  // stock" fix CAM-DRILL-FIX2 proved out for resolveTopZ, reused here rather
  // than re-derived. Omitting it keeps today's exact behavior.
  wcsOriginZOverride?: number,
): { worldZ: number; wcsZ: number } {
  const worldZ = localZ + (isGeometryLocalSource(geo) ? modelGeoOriginZ(geo!, placementRecords) : 0)
  const originZ = wcsOriginZOverride ?? setup.wcs.origin.z
  return { worldZ, wcsZ: worldZ - originZ }
}

/** WCS origin at z=0: lets selectedFaceWorldZ reuse the converter's worldZ
 *  (which is setup-independent) without fabricating a Setup. */
const ZERO_WCS = { wcs: { origin: { z: 0 } } } as const

/**
 * World Z for heights.selectedFaceZ. Thin wrapper that returns the converter's
 * worldZ (ONE code path; see resolveGeometryZToFrames / isGeometryLocalSource).
 * The modal stores the derive-time geometry-local MODEL Z (HeightParams
 * .selectedFaceZ); a defined source geo gets its position.z added, a missing
 * source (deleted / '__all__') is verbatim.
 */
export function selectedFaceWorldZ(
  selectedFaceZ: number,
  sourceGeo: Pick<ImportedGeometry, 'format' | 'position'> | undefined,
): number {
  return resolveGeometryZToFrames(selectedFaceZ, sourceGeo, ZERO_WCS).worldZ
}

/**
 * CAM-DRILL-FIX3: model-aware wrapper around resolveGeometryZToFrames for the
 * selected_face / per-hole / per-cylinder / per-loop bottom-of-cut resolvers
 * in store/index.ts and the Properties panel's read-only Bottom display. For
 * a model-origin `geo`, composes BOTH fixes CAM-DRILL-FIX1 (real
 * Placement-aware position, not the row's own permanently-identity
 * geo.position) and CAM-DRILL-FIX2 (the effective, corner-pin-mirrored WCS
 * baseline, not the possibly-stale raw setup.wcs.origin.z) already proved
 * out for resolveTopZ's stock_top/stock_bottom branch - reused here via
 * resolveModelSourceOwningStockBounds + effectiveWcsOriginZ (both defined
 * below), not re-derived a third time. For a non-model `geo` this is
 * BYTE-IDENTICAL to calling resolveGeometryZToFrames directly - no behavior
 * change for the vastly more common regular-geometry case.
 *
 * THROWS OwningStockError under the exact same multi-stock / no-stock
 * conditions resolveTopZ does (ADR-0003 fail-loud) - callers must be
 * try/catch-protected the same way resolveOpRefZ's own callers already are.
 * See resolveGeometryZToFramesModelAwareSafe for a call site that must not
 * throw.
 */
export function resolveGeometryZToFramesModelAware(
  localZ: number,
  geo: ImportedGeometry | undefined,
  setup: Setup,
  geometryAll: ImportedGeometry[],
  sceneStock: SceneStock,
  stocks: ReadonlyArray<PhysicalStock>,
  placementRecords: readonly ModelItemPlacementRegistryEntry[] = NO_PLACEMENTS,
): { worldZ: number; wcsZ: number } {
  if (geo && isModelOriginGeometry(geo)) {
    const { bounds } = resolveModelSourceOwningStockBounds(geo, geometryAll, sceneStock, stocks, placementRecords)
    const effectiveWcsZ = effectiveWcsOriginZ(setup.wcs, bounds)
    return resolveGeometryZToFrames(localZ, geo, setup, placementRecords, effectiveWcsZ)
  }
  return resolveGeometryZToFrames(localZ, geo, setup)
}

/**
 * Non-throwing sibling of resolveGeometryZToFramesModelAware, for call sites
 * reached AFTER an op's ordering/try-catch gate has already passed (the
 * per-hole/per-cylinder/per-loop DATA refinements in store/index.ts, which
 * run outside the try block that surfaces OwningStockError as the op's
 * errorMessage). Falls back to the exact pre-CAM-DRILL-FIX3 computation
 * (resolveGeometryZToFrames with no placement/WCS override) on any
 * resolution failure - never a NEW crash, only an improved value for the
 * common (single- or zero-stock) case CAM-DRILL-EVIDENCE actually hit.
 */
export function resolveGeometryZToFramesModelAwareSafe(
  localZ: number,
  geo: ImportedGeometry | undefined,
  setup: Setup,
  geometryAll: ImportedGeometry[],
  sceneStock: SceneStock,
  stocks: ReadonlyArray<PhysicalStock>,
  placementRecords: readonly ModelItemPlacementRegistryEntry[] = NO_PLACEMENTS,
): { worldZ: number; wcsZ: number } {
  try {
    return resolveGeometryZToFramesModelAware(localZ, geo, setup, geometryAll, sceneStock, stocks, placementRecords)
  } catch {
    return resolveGeometryZToFrames(localZ, geo, setup)
  }
}

/**
 * GEOMETRY-LOCAL model Z of the cut FLOOR implied by an op's cylinder-derived
 * selection: scan every layer's cylinder features, keep those whose loopId is in
 * `loopIds` AND whose kind is 'boss' or 'bore', and return the MIN bottomZ (the
 * deepest base = the floor the cut must reach), or undefined when none match.
 *
 * Pure (no store access): the recompute-time smart cut-floor heal in
 * computeOperationToolpath uses this to re-bind a saved boundary op to the
 * cylinder base without the user re-picking faces. Model-local Z, exactly as
 * selectedFaceZ is stored (dispatch converts it through resolveGeometryZToFrames).
 */
export function resolveCylinderFloorZ(
  geo: Pick<ImportedGeometry, 'layers2d'>,
  loopIds: ReadonlyArray<string>,
): number | undefined {
  if (loopIds.length === 0) return undefined
  const ids = new Set(loopIds)
  let minZ = Infinity
  for (const layer of geo.layers2d ?? []) {
    for (const c of layer.cylinders ?? []) {
      if (c.loopId === undefined || !ids.has(c.loopId)) continue
      if (c.kind !== 'boss' && c.kind !== 'bore') continue
      if (c.bottomZ < minZ) minZ = c.bottomZ
    }
  }
  return Number.isFinite(minZ) ? minZ : undefined
}

/**
 * World Z of a detected hole's bottom. HoleFeature Z values on geometry_local
 * layers are model coords; legacy untagged layers are left verbatim (their
 * loops are also dispatched untransformed — keep XY and Z consistent).
 */
export function holeBottomWorldZ(
  hole: Pick<HoleFeature, 'bottomZ'>,
  layer: Pick<Layer2D, 'frame'>,
  geo: GeoPose & Pick<ImportedGeometry, 'format' | 'modelItemId' | 'modelBody'>,
  // CAM-DRILL-FIX3: optional Placement context (default NO_PLACEMENTS, same
  // fallback precedent as resolveGeometryZToFrames) so a detected hole on a
  // model-origin body composes the body's REAL world position instead of its
  // permanently-identity geo.position.z. Omitting it is byte-identical to
  // before this lane.
  placementRecords: readonly ModelItemPlacementRegistryEntry[] = NO_PLACEMENTS,
): number {
  if (layer.frame !== 'geometry_local') return hole.bottomZ
  return hole.bottomZ + modelGeoOriginZ(geo, placementRecords)
}

/**
 * Tilt tolerance in DEGREES, measured as the ANGLE between the rotated model
 * +Z axis and world +Z — NOT per-Euler-component. Per-component checks are
 * representation-dependent: Euler XYZ (180, 180, theta) is geometrically the
 * pure Z rotation Rz(theta - 180) (zero tilt), yet has X/Y components of 180
 * that no component epsilon forgives. The geometric predicate below is
 * representation-independent. 0.01 deg over a 300 mm part is a ~50-micron Z
 * error bound — below machining tolerance — while any intentional tilt
 * (>= 0.1 deg) still fails loud. Gizmo float residue (~1e-7 deg, the fc4650b
 * case) maps to v.z ~ 1 and passes.
 */
export const TILT_TOLERANCE_DEG = 0.01

// Moved to lib/geometry/rotationMatrixXYZ.ts (WO-1574) so lib/cam callers
// (which may not import store) can use it too; re-exported here so every
// existing store caller keeps compiling unchanged.
export { rotationMatrixXYZ }

/** Image of the model +Z axis under the geometry rotation: v = R * (0,0,1).
 *  v.z = 1 means Z-preserving (any Euler representation), v.z = -1 upside down. */
export function rotatedZAxis(rotation: Partial<Vec3> | undefined): Vec3 {
  return rotationMatrixXYZ(rotation).col3
}

/**
 * EFFECTIVE Z rotation angle in DEGREES, extracted from the rotation matrix
 * (atan2 of the rotated X axis, u = R * (1,0,0)). For Z-preserving rotations
 * this is the true in-plane angle regardless of Euler representation:
 * Euler (180, 180, -10) -> 170, same as canonical (0, 0, 170). For tilted or
 * flipped rotations the value is the XY projection's angle — callers refuse
 * those at dispatch (classifyRotationOffZ), so it is never load-bearing there.
 */
export function effectiveZRotationDeg(rotation: Partial<Vec3> | undefined): number {
  const u = rotationMatrixXYZ(rotation).col1
  return (Math.atan2(u.y, u.x) * 180) / Math.PI
}

export type RotationOffZKind = 'aligned' | 'tilted' | 'flipped'

/**
 * Geometric off-Z classification. 'aligned': model +Z still points up within
 * TILT_TOLERANCE_DEG (includes flipped-representation pure-Z rotations and
 * gizmo float residue). 'flipped': +Z maps to -Z (model upside down — the XY
 * map is a MIRROR, so Z-plane derives would be mirrored; refused in v1 with
 * its own message). 'tilted': anything in between (genuine X/Y tilt).
 * Missing rotation (older saved projects) reads as zero -> 'aligned'.
 */
export function classifyRotationOffZ(rotation: Partial<Vec3> | undefined): RotationOffZKind {
  const vz = rotatedZAxis(rotation).z
  const cosTol = Math.cos((TILT_TOLERANCE_DEG * Math.PI) / 180)
  if (vz >= cosTol) return 'aligned'
  if (vz <= -cosTol) return 'flipped'
  return 'tilted'
}

/** True when the rotation is NOT Z-preserving (tilted or flipped). */
export function isTiltedOffZ(rotation: Partial<Vec3> | undefined): boolean {
  return classifyRotationOffZ(rotation) !== 'aligned'
}

/** Tilt angle in DEGREES between the rotated model +Z axis and world +Z
 *  (0 = aligned, 180 = upside down). For the guard's error message. */
export function tiltAngleDeg(rotation: Partial<Vec3> | undefined): number {
  const vz = Math.min(1, Math.max(-1, rotatedZAxis(rotation).z))
  return (Math.acos(vz) * 180) / Math.PI
}

/**
 * ADR 0003 loud-failure guard: B-rep derived layers are Z-plane data (the
 * worker enforces +/-Z-normal planes at derive time), so a model tilted about
 * X or Y invalidates every geometry_local layer, selected-face bottom, and
 * detected-hole depth — and v1 has no re-derive for non-Z-normal planes.
 * Returns the first source geometry that is tilted or flipped AND feeds
 * geometry-local data into this op (with its classification, so the caller
 * can word the error), or null when dispatch is safe. Plain 2D sources (no
 * geometry_local layers, no holes, selected_face unset) are never flagged.
 * "Tilted"/"flipped" are the GEOMETRIC predicates (classifyRotationOffZ) —
 * flipped-representation pure-Z rotations, gizmo float residue, and missing
 * rotation fields must not trip the guard.
 */
// ---- AUTO-stock derived bounds (H1 commit B, R4 "stock follows reality") ----
//
// The store previously had NO auto-stock bounds: the viewport computed the
// auto box from its THREE meshes (z hardcoded to the table), the corner pick
// read the rendered box, and resolveTopZ silently degraded stock_top to the
// WCS plane in auto mode. deriveAutoStockBounds is the store-side source of
// truth the corner pick, WCS re-derivation (applyAutoStockToSetups) and
// resolveTopZ all consume; CNCViewport.rebuildStock mirrors the same Z rules
// for display (one-directional: store derives, viewport renders).

/** World-space AABB of a LOCAL-space min/max box, rotated by `rotation`
 *  (Euler degrees) then translated by `position`. Shared by the brep/mesh
 *  branch below and CAM-BINDING Stage 3's model-body branch (modelBodyWorldBounds)
 *  - the SAME 8-corner-rotation math, ported not re-derived, so a model body's
 *  bbox transforms exactly like an imported mesh's already does. */
function worldBoundsFromLocalCorners(
  localMin: Vec3,
  localMax: Vec3,
  position: Vec3,
  rotation: Partial<Vec3> | undefined,
): { min: Vec3; max: Vec3 } {
  const R = rotationMatrixXYZ(rotation)
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (const cx of [localMin.x, localMax.x]) {
    for (const cy of [localMin.y, localMax.y]) {
      for (const cz of [localMin.z, localMax.z]) {
        const x = R.col1.x * cx + R.col2.x * cy + R.col3.x * cz + position.x
        const y = R.col1.y * cx + R.col2.y * cy + R.col3.y * cz + position.y
        const z = R.col1.z * cx + R.col2.z * cy + R.col3.z * cz + position.z
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (z < minZ) minZ = z
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
        if (z > maxZ) maxZ = z
      }
    }
  }
  return { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } }
}

/**
 * CAM-BINDING Stage 3: world-space AABB of a model-backed CAM entry, or null
 * when it contributes nothing (no tessellated display yet, a degenerate
 * bbox, or no resolvable Placement) - mirroring every other null case in
 * geometryWorldBounds below, never a throw (this function feeds passive,
 * whole-collection aggregates like deriveAutoStockBounds; a single bad row
 * must not break every OTHER geometry's stock math).
 *
 * A model row's OWN position/rotation stay identity forever (Stage 2's own
 * documented invariant - INT-17C's updateGeometryTransform refuses to write
 * them for a model-origin row); its real world pose lives in the Placement
 * registry instead, so this resolves it through the ONE named seam
 * (resolveModelReferenceFrame, the coordinator MANDATE) rather than reading
 * geo.position/geo.rotation like the branch below does for every other type.
 *
 * `placementRecords` is the project's `modelItemPlacements` array (or a
 * caller's live-store equivalent), passed explicitly - mirrors
 * resolveModelReferenceFrame's own purity contract. A caller with no
 * Placement context (predates Stage 3, or a pure-fixture test) passes
 * nothing and gets the pre-Stage-3 "contributes no bounds" answer, never a
 * crash or a silently wrong box.
 */
function modelBodyWorldBounds(
  geo: ImportedGeometry,
  placementRecords: readonly ModelItemPlacementRegistryEntry[],
): { min: Vec3; max: Vec3 } | null {
  const display = geo.modelBody?.display
  if (!display) return null
  const [minX, minY, minZ] = display.bbox.min
  const [maxX, maxY, maxZ] = display.bbox.max
  if (minX === maxX && minY === maxY && minZ === maxZ) return null
  const itemId = geo.modelItemId ?? LEGACY_MODEL_ITEM_ID
  const bodyId = geo.modelBody?.ref.bodyId
  let frame: { position: Vec3; rotation: Vec3 }
  try {
    frame = resolveModelReferenceFrame(placementRecords, itemId, bodyId)
  } catch {
    // No resolvable Placement yet for this body - contributes no bounds,
    // exactly like the "empty 2D source" / "unpopulated boundingBox" null
    // cases below. Never a silent WRONG box; never a crash of the whole
    // aggregate this row happens to be folded into.
    return null
  }
  return worldBoundsFromLocalCorners(
    { x: minX, y: minY, z: minZ },
    { x: maxX, y: maxY, z: maxZ },
    frame.position,
    frame.rotation,
  )
}

/** World-space AABB of one geometry as the AUTO stock sees it, or null when
 *  it contributes nothing (empty 2D source, or a mesh whose boundingBox was
 *  never populated - legacy STL imports; healed on viewport restore).
 *  - model (CAM-BINDING Stage 3): modelBodyWorldBounds above - the body's
 *    own tessellated bbox, composed through resolveModelReferenceFrame
 *    (`placementRecords`) since a model row's own position/rotation stay
 *    identity. THIS DIRECTLY REVERSES the pre-Stage-3 "a model-backed CAM
 *    entry is READ-ONLY, it contributes no bounds" refusal that used to live
 *    here - a modeled body is now stock-eligible, matching an imported part.
 *  - 2D (curves_2d): tight XY from the transformed loop points (exactly the
 *    polylines the viewport renders), flat AT position.z (zero Z thickness).
 *    The viewport lifts the rendered LINES by CNCViewport.Z2D (0.3mm) only to
 *    dodge z-fighting with the table - that render lift is NOT real material
 *    and must never enter the logical stock top, the WCS Z, or any cut plane
 *    (Operator ruling 2026-06-13: a 5mm stock on a flat DXF must give WCS Z 5.0 and a
 *    Geometry+0 bottom of -5.0, never 5.3 / -5.3). rebuildStock collapses the
 *    same lift on its side so render and math agree.
 *  - 3D (mesh/brep): the local boundingBox corners through the full XYZ
 *    rotation + position. Exact for axis-aligned and 90-degree rotations;
 *    conservative (slightly loose vs the rendered mesh-tight box) for
 *    arbitrary angles.
 *
 *  `placementRecords` (CAM-BINDING Stage 3, optional, default NO_PLACEMENTS):
 *  the project's `modelItemPlacements` array. Only read for a model-origin
 *  `geo`; every other branch ignores it. Omitting it is byte-identical to
 *  the pre-Stage-3 behavior for a model row (null, never a crash) - safe for
 *  a caller that has not yet been taught to pass it. */
export function geometryWorldBounds(
  geo: ImportedGeometry,
  placementRecords: readonly ModelItemPlacementRegistryEntry[] = NO_PLACEMENTS,
): { min: Vec3; max: Vec3 } | null {
  if (isModelOriginGeometry(geo)) return modelBodyWorldBounds(geo, placementRecords)
  if (geo.type === 'curves_2d') {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const loop of geo.loops ?? []) {
      for (const p of transformLoopPoints(loop.points, geo)) {
        if (p.x < minX) minX = p.x
        if (p.y < minY) minY = p.y
        if (p.x > maxX) maxX = p.x
        if (p.y > maxY) maxY = p.y
      }
    }
    if (!Number.isFinite(minX)) return null
    return {
      min: { x: minX, y: minY, z: geo.position.z },
      max: { x: maxX, y: maxY, z: geo.position.z },
    }
  }
  const bb = geo.boundingBox
  const degenerate =
    bb.max.x === bb.min.x && bb.max.y === bb.min.y && bb.max.z === bb.min.z
  if (degenerate) return null
  return worldBoundsFromLocalCorners(bb.min, bb.max, geo.position, geo.rotation)
}

/**
 * Derived world-space AABB of the AUTO stock: combined geometry bounds padded
 * by autoOffsetXY on each X/Y side and autoOffsetZTop above the highest point.
 * The BASE follows the combined geometry min Z (R4: a part raised off the
 * table raises the stock with it - never a thicker block growing up from z=0),
 * then autoOffsetZBottom extends it further DOWN to reserve material for
 * backside / flip machining (0 = the legacy base === min Z). Pure-2D all-z0
 * scenes derive base z=0 / top = Z2D lift + zTop, byte-equal to what the
 * viewport has always rendered. Returns null when the stock mode is not 'auto'
 * or no geometry contributes bounds.
 */
export function deriveAutoStockBounds(
  geometry: ReadonlyArray<ImportedGeometry>,
  sceneStock: Pick<SceneStock, 'mode' | 'autoOffsetXY' | 'autoOffsetZTop' | 'autoOffsetZBottom'>,
  placementRecords: readonly ModelItemPlacementRegistryEntry[] = NO_PLACEMENTS,
): { min: Vec3; max: Vec3 } | null {
  if (sceneStock.mode !== 'auto') return null
  let box: { min: Vec3; max: Vec3 } | null = null
  for (const geo of geometry) {
    // WO-1572: a vise or clamp holds the stock; it never sizes it.
    if (isWorkholdingGeometry(geo)) continue
    const b = geometryWorldBounds(geo, placementRecords)
    if (!b) continue
    if (!box) {
      box = { min: { ...b.min }, max: { ...b.max } }
    } else {
      box.min.x = Math.min(box.min.x, b.min.x)
      box.min.y = Math.min(box.min.y, b.min.y)
      box.min.z = Math.min(box.min.z, b.min.z)
      box.max.x = Math.max(box.max.x, b.max.x)
      box.max.y = Math.max(box.max.y, b.max.y)
      box.max.z = Math.max(box.max.z, b.max.z)
    }
  }
  if (!box) return null
  const off = sceneStock.autoOffsetXY
  return {
    min: { x: box.min.x - off, y: box.min.y - off, z: box.min.z - (sceneStock.autoOffsetZBottom ?? 0) },
    max: { x: box.max.x + off, y: box.max.y + off, z: box.max.z + sceneStock.autoOffsetZTop },
  }
}

// ---- Symbolic Z-anchor support (Item 4) ------------------------------------
//
// A projection plane placed on a stock-relative PRESET (Stock top / Stock
// bottom) stores a ProjectionZAnchor instead of freezing origin.z. The Z is
// re-resolved live whenever the stock bounds move, so the placed loops ride the
// stock (the height-vocabulary pattern, ADR 0002). Floor is constant; absolute
// (or no anchor) keeps the stored origin.z untouched.

/** Resolve a ProjectionZAnchor to an absolute world Z, or null when the caller
 *  must keep the existing origin.z (absolute, no anchor, or stock-relative with
 *  no stock bounds available). Mirrors the viewport picker's preset Z math
 *  (stock top = max.z, stock bottom = min.z) so picker-time and resolver-time Z
 *  agree. */
export function resolveAnchoredZ(
  zAnchor: ProjectionZAnchor | undefined,
  stockBounds: { min: { z: number }; max: { z: number } } | null,
): number | null {
  if (!zAnchor) return null
  switch (zAnchor.ref) {
    case 'absolute':
      return null
    case 'floor':
      return 0 + zAnchor.offset
    case 'stock-top':
      return stockBounds ? stockBounds.max.z + zAnchor.offset : null
    case 'stock-bottom':
      return stockBounds ? stockBounds.min.z + zAnchor.offset : null
    default:
      return null
  }
}

/** Union world-space Z extent of the SCENE stock, mirroring what the viewport
 *  bakes into _stockBounds (which the picker presets read): in AUTO mode the
 *  deriveAutoStockBounds box; in FIXED mode the union of every fixed block (or
 *  the single default block when fixedStocks is empty, matching the viewport's
 *  __default__ fallback). Returns null when nothing contributes (no geometry in
 *  auto mode) so resolveAnchoredZ leaves stock-relative origins untouched. */
export function computeSceneStockBounds(
  geometry: ReadonlyArray<ImportedGeometry>,
  sceneStock: SceneStock,
  placementRecords: readonly ModelItemPlacementRegistryEntry[] = NO_PLACEMENTS,
): { min: Vec3; max: Vec3 } | null {
  if (sceneStock.mode === 'auto') {
    return deriveAutoStockBounds(geometry, sceneStock, placementRecords)
  }
  // Fixed: union of the named blocks, or the single default block at the origin
  // when none are named (same fallback the viewport buildStockBox path uses).
  const blocks: FixedStockItem[] =
    sceneStock.fixedStocks && sceneStock.fixedStocks.length > 0
      ? sceneStock.fixedStocks
      : [{
          id: '__default__', name: operatorText('dispatchGeo3'),
          width: sceneStock.fixedWidth, height: sceneStock.fixedHeight,
          depth: sceneStock.fixedDepth, position: { x: 0, y: 0, z: 0 },
        }]
  let box: { min: Vec3; max: Vec3 } | null = null
  for (const b of blocks) {
    const min: Vec3 = { x: b.position.x, y: b.position.y, z: b.position.z }
    const max: Vec3 = {
      x: b.position.x + b.width,
      y: b.position.y + b.height,
      z: b.position.z + b.depth,
    }
    if (!box) box = { min: { ...min }, max: { ...max } }
    else {
      box.min.x = Math.min(box.min.x, min.x)
      box.min.y = Math.min(box.min.y, min.y)
      box.min.z = Math.min(box.min.z, min.z)
      box.max.x = Math.max(box.max.x, max.x)
      box.max.y = Math.max(box.max.y, max.y)
      box.max.z = Math.max(box.max.z, max.z)
    }
  }
  return box
}

// ---- Coordinate hierarchy Phase 2: owning-stock resolution -----------------
//
// The reference-plane resolvers (resolveTopZ / resolveModelBottomZ) used to read
// FLAT project-wide aggregates: deriveAutoStockBounds over ALL geometry, or the
// single pinned FixedStockItem, or Math.max/Math.min over ALL geometry. With the
// coordinate hierarchy every geometry has physical membership in a PhysicalStock
// (ImportedGeometry.stockId), so a cut's reference plane must come from the
// OWNING stock's frame - not a project-wide blend that, on a multi-part / multi-
// stock job, silently mixes parts at different Z (the B22 cross-part bug). These
// helpers resolve that owning stock and its world bounds, fail-loud per ADR-0003.

/** Structured fail-loud error for unresolvable coordinate ownership (ADR-0003).
 *  Tagged like planeOrderingError's contract so the dispatch can surface it as
 *  the op's errorMessage instead of throwing into the void. */
export class OwningStockError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OwningStockError'
  }
}

/** Structured fail-loud error for a 'picked_plane' reference whose datum surface
 *  is missing (never picked, or its geometry was deleted) - ADR-0003. Tagged like
 *  OwningStockError so every resolveTopZ caller can surface it as the op's
 *  errorMessage (or a "no plane" preview) instead of throwing into the void. */
export class ReferencePlaneError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReferencePlaneError'
  }
}

/**
 * Resolve the single PhysicalStock whose coordinate frame a cut references.
 *
 *  - geometryId !== '__all__': the named geometry's owning stock. THROWS
 *    OwningStockError when the geometry is missing, has no stockId, or its
 *    stockId matches no stock (ADR-0003: no silent project-wide fallback).
 *  - geometryId === '__all__': the lone stock shared by every SELECTABLE
 *    geometry (loops present). Exactly one distinct existing owner -> it.
 *    More than one -> THROWS (one op cannot reference two coordinate frames).
 *    Zero selectable, or any unassigned/dangling owner -> THROWS.
 */
export function resolveOwningStock(
  geometryId: string,
  geometryAll: ReadonlyArray<ImportedGeometry>,
  stocks: ReadonlyArray<PhysicalStock>,
  // CAM-BINDING Stage 3 follow-on (audited, default false = STRICT/HEAD
  // behavior). true ONLY when called from resolveTopZ's stock_top/
  // stock_bottom branch, which passes an already stock-bound-model-row-
  // inclusive `geometryAll` and needs THIS function's own re-scoping to
  // agree, not silently strip the row back out (see
  // computeGeometryScopeIncludingStockBoundModelRows's doc comment).
  // resolveModelBottomZ's own call (default false) must NEVER pass true.
  includeStockBoundModelRows = false,
): PhysicalStock {
  // INT-17A-R2 C1: arrival-point guard. A modeled body referenced BY ID is a
  // named refusal; one merely PRESENT in the project is filtered, so it can
  // neither become a phantom '__all__' owner nor make the unassigned check
  // block a legitimate op (the audit's reproduction).
  const geometry = includeStockBoundModelRows
    ? computeGeometryScopeIncludingStockBoundModelRows(geometryAll, geometryId)
    : computeGeometryScope(geometryAll, geometryId)
  const byId = (id: string | undefined): PhysicalStock | undefined =>
    id === undefined ? undefined : stocks.find((s) => s.id === id)

  if (geometryId !== '__all__') {
    const geo = geometry.find((g) => g.id === geometryId)
    if (!geo) {
      throw new OwningStockError(
        operatorText('dispatchGeo4', { value1: String(geometryId) }),
      )
    }
    if (geo.stockId === undefined) {
      throw new OwningStockError(
        operatorText('dispatchGeo5', { value1: String(geo.name), value2: String(geo.id) }),
      )
    }
    const stock = byId(geo.stockId)
    if (!stock) {
      throw new OwningStockError(
        operatorText('dispatchGeo6', { value1: String(geo.name), value2: String(geo.id), value3: String(geo.stockId) }),
      )
    }
    return stock
  }

  // '__all__': every selectable (has-loops) geometry must share ONE owner.
  const selectable = geometry.filter((g) => (g.loops?.length ?? 0) > 0)
  if (selectable.length === 0) {
    throw new OwningStockError(
      operatorText('dispatchGeo7'),
    )
  }
  const unassigned = selectable.filter(
    (g) => g.stockId === undefined || byId(g.stockId) === undefined,
  )
  if (unassigned.length > 0) {
    const names = unassigned.map((g) => `"${g.name}"`).join(', ')
    throw new OwningStockError(
      operatorText('dispatchGeo8', { value1: String(unassigned.length), value2: String(names) }),
    )
  }
  const distinctIds = [...new Set(selectable.map((g) => g.stockId as string))]
  if (distinctIds.length > 1) {
    const named = distinctIds
      .map((id) => {
        const s = byId(id)
        return s ? `"${s.name}" (${s.id})` : `"${id}"`
      })
      .join(', ')
    throw new OwningStockError(
      operatorText('dispatchGeo9', { value1: String(named) }),
    )
  }
  return byId(distinctIds[0])!
}

/**
 * World-space AABB of the owning stock.
 *  - explicit: stockWorldBounds (position + bounds.size span).
 *  - derived:  deriveStockBounds (member-filtered: geometry.stockId === stock.id)
 *              padded by the SAME autoOffset rules deriveAutoStockBounds uses, so
 *              a normal single-stock project resolves IDENTICALLY to the old flat
 *              deriveAutoStockBounds(all geometry) path. THROWS when the derive
 *              yields no contributing members (ADR-0003 fail-loud).
 */
export function owningStockWorldBounds(
  stock: PhysicalStock,
  geometryAll: ReadonlyArray<ImportedGeometry>,
  sceneStock: Pick<SceneStock, 'autoOffsetXY' | 'autoOffsetZTop' | 'autoOffsetZBottom' | 'autoStocks'>,
  placementRecords: readonly ModelItemPlacementRegistryEntry[] = NO_PLACEMENTS,
  // CAM-BINDING Stage 3 follow-on (audited, default false = STRICT/HEAD
  // behavior). true ONLY from resolveTopZ's stock_top/stock_bottom branch -
  // deriveStockBounds below reads geometry through geometryWorldBounds, which
  // DOES compose a model row's Placement (audit.md Q2 cleared this consumer).
  includeStockBoundModelRows = false,
): { min: Vec3; max: Vec3 } {
  // INT-17A-R2 C1: arrival-point guard. A DERIVED stock's bounds come from its
  // member geometry, so a modeled body that somehow carried a stockId would
  // otherwise inflate the stock box the WCS and every reference plane sit on.
  // Idempotent when resolveTopZ already scoped (it passes the scoped list).
  //
  // CAM-BINDING Stage 3 follow-on (audited): the opt-in above lets a
  // deliberately stock-bound model-origin row (stockId !== undefined)
  // contribute, ONLY when the caller has verified (as resolveTopZ's
  // stock_top/stock_bottom branch does) that the row reaches this function's
  // placement-composing deriveStockBounds path, not a direct
  // position/boundingBox read.
  const geometry = includeStockBoundModelRows
    ? computeGeometryScopeIncludingStockBoundModelRows(geometryAll)
    : computeGeometryScope(geometryAll)
  if (stock.mode === 'explicit') return stockWorldBounds(stock)
  // Resolve the PER-STOCK auto offsets for this derived stock, EXACTLY mirroring
  // applyAutoStockToSetups (store/index.ts) so the height resolver derives the
  // stock top from the SAME offset the WCS corner was derived with. Falling back
  // to the global sceneStock offsets when no named AutoStockItem exists. Using
  // the global offset here while the WCS used the per-stock offset is the
  // offset-source mismatch that floats stock_top above the stock.
  const item = sceneStock.autoStocks?.find(a => a.id === stock.id)
  const offsets = item
    ? { autoOffsetXY: item.autoOffsetXY, autoOffsetZTop: item.autoOffsetZTop, autoOffsetZBottom: item.autoOffsetZBottom ?? 0 }
    : { autoOffsetXY: sceneStock.autoOffsetXY, autoOffsetZTop: sceneStock.autoOffsetZTop, autoOffsetZBottom: sceneStock.autoOffsetZBottom ?? 0 }
  const b = deriveStockBounds(stock, geometry, offsets, placementRecords)
  if (!b) {
    throw new OwningStockError(
      operatorText('dispatchGeo10', { value1: String(stock.name), value2: String(stock.id) }),
    )
  }
  return { min: { ...b.min }, max: { ...b.max } }
}

/**
 * CAM-DRILL-FIX3: the effective (corner-pin-aware) WCS-Z baseline every
 * model-source height/Z resolver must subtract, extracted from CAM-DRILL-
 * FIX2's inline resolveTopZ branch so it is defined ONCE and reused - not
 * mirrored a second/third time as the same staleness defect recurred in the
 * selected_face / per-hole / per-cylinder / per-loop resolvers in
 * store/index.ts (CAM-DRILL-FIX3's own fix).
 *
 * For a REGULAR (real-geometry) derived stock, applyAutoStockToSetups
 * (store/index.ts) keeps a corner-pinned WCS's origin.z EXACTLY at that
 * stock's own resolved top/bottom face (cornerOriginFromBox) every time the
 * stock's bounds change - so the raw wcs.origin.z IS already the effective
 * value there; this function only diverges from it for a model-only derived
 * stock, whose origin.z stays frozen/stale (deriveStockBounds never sees a
 * Stage-2 model row - INT-17A-R1 C3). It mirrors what applyAutoStockToSetups
 * WOULD have set origin.z to, computed here at READ time, never written back
 * (the WCS/stock-assignment level stays untouched, same as FIX2).
 *
 * ONLY when the WCS is actually corner-pinned (cornerRow/cornerCol set, not
 * vertex-snapped - the exact condition applyAutoStockToSetups itself gates
 * its own re-derivation on) does this diverge from the raw origin.z; a
 * manually-placed or vertex-snapped WCS has no "would-be" formula to mirror
 * and falls through to the real origin.z unchanged.
 */
export function effectiveWcsOriginZ(
  wcs: Pick<Setup['wcs'], 'origin' | 'cornerRow' | 'cornerCol' | 'cornerFace' | 'snapGeoId'>,
  bounds: { min: Vec3; max: Vec3 } | undefined,
): number {
  const cornerPinned = wcs.cornerRow != null && wcs.cornerCol != null && !wcs.snapGeoId
  if (cornerPinned && bounds) {
    return wcs.cornerFace === 'bottom' ? bounds.min.z : bounds.max.z
  }
  return wcs.origin.z
}

/**
 * CAM-DRILL-FIX1/FIX3: resolve a model-source op's OWNING STOCK world bounds -
 * the shared machinery every model-sourced Z resolver (stock_top/bottom via
 * resolveTopZ below, and the selected_face/per-hole/per-cylinder/per-loop
 * resolvers in store/index.ts) needs to compose a model row's real,
 * Placement-aware position. Exactly ONE PhysicalStock in the project -> use
 * it (stamping the model row's id onto a shallow copy so deriveStockBounds'
 * membership filter picks it up, mirroring the existing owned-nest-seed
 * "effective stockId" substitution pattern); zero -> deriveAutoStockBounds
 * fallback; more than one -> typed OwningStockError refusal, never a guess at
 * which stock a modeled body belongs to (CAM-DRILL-FIX1.report.md's staged
 * open question).
 */
export function resolveModelSourceOwningStockBounds(
  modelSource: ImportedGeometry,
  geometryAll: ImportedGeometry[],
  sceneStock: SceneStock,
  stocks: ReadonlyArray<PhysicalStock>,
  placementRecords: readonly ModelItemPlacementRegistryEntry[] = NO_PLACEMENTS,
): { bounds: { min: Vec3; max: Vec3 }; owning: PhysicalStock | undefined } {
  const subject = modelSource.name || modelSource.id
  if (stocks.length > 1) {
    throw new OwningStockError(
      operatorText('dispatchGeo11', { value1: String(subject), value2: String(stocks.length) }),
    )
  }
  const otherGeometry = computeGeometryScope(geometryAll)
  const geometryForBounds = [...otherGeometry, modelSource]
  if (stocks.length === 1) {
    const owning = stocks[0]
    const stamped = geometryForBounds.map((g) =>
      g.id === modelSource.id ? { ...g, stockId: owning.id } : g)
    return { bounds: owningStockWorldBounds(owning, stamped, sceneStock, placementRecords, true), owning }
  }
  const auto = deriveAutoStockBounds(geometryForBounds, sceneStock, placementRecords)
  if (!auto) {
    throw new OwningStockError(
      operatorText('dispatchGeo12', { value1: String(subject) }),
    )
  }
  return { bounds: auto, owning: undefined }
}

/**
 * CAM-DRILL-FIX3: non-throwing sibling of effectiveWcsOriginZ for the
 * per-hole/per-cylinder/per-loop DATA resolvers in store/index.ts (drill's
 * perHoleDepth, bore's perBoreDepth, contour's per-loop selected_face map) -
 * all reached AFTER an op's ordering/try-catch gate has already passed, so
 * none of them may throw. Returns the raw `setup.wcs.origin.z` unchanged for
 * a non-model `geo` (byte-identical to every call site's pre-CAM-DRILL-FIX3
 * behavior) or when the owning-stock context cannot be resolved (falls back
 * rather than crashing a dispatch that already passed its ordering check);
 * otherwise the effective corner-pin-mirrored baseline, exactly like the
 * op-level resolveGeometryZToFramesModelAware path uses.
 */
export function safeEffectiveWcsOriginZ(
  geo: ImportedGeometry | undefined,
  setup: Setup,
  geometryAll: ImportedGeometry[],
  sceneStock: SceneStock,
  stocks: ReadonlyArray<PhysicalStock>,
  placementRecords: readonly ModelItemPlacementRegistryEntry[] = NO_PLACEMENTS,
): number {
  if (!geo || !isModelOriginGeometry(geo)) return setup.wcs.origin.z
  try {
    const { bounds } = resolveModelSourceOwningStockBounds(geo, geometryAll, sceneStock, stocks, placementRecords)
    return effectiveWcsOriginZ(setup.wcs, bounds)
  } catch {
    return setup.wcs.origin.z
  }
}

/**
 * Narrow a candidate geometry list to those that OWN the operation's selected
 * loops (params.loopIds). ADR-0020 doctrine rule 2: a height-derived plane for
 * a '__all__' op must come from the geometry the op actually cuts, not every
 * part on the owning stock. ImportedGeometry.loops is Loop2D[] with stable l.id
 * (ADR-0019). When loopIds is empty (the op's "all closed loops" contract) the
 * candidates pass through unchanged - byte-identical to the prior behavior. The
 * owners.length>0?owners:candidates guard preserves today's behavior when the
 * selection is derived/world-baked and the ids are not found on g.loops (no
 * second fail-loud, ADR-0003).
 */
export function geometriesOwningSelection(
  candidates: ReadonlyArray<ImportedGeometry>,
  loopIds: ReadonlyArray<string>,
): ReadonlyArray<ImportedGeometry> {
  if (loopIds.length === 0) return candidates
  const owners = candidates.filter(g => g.loops?.some(l => loopIds.includes(l.id)))
  return owners.length > 0 ? owners : candidates
}

// Resolve the WCS-relative Z of the reference plane for any operation.
// Returns the resolved plane height (WCS-relative) to be injected into the
// worker payload's heights object. Moved here from store/index.ts (H1,
// docs/planning/HEIGHTS-AUDIT-AND-PLAN.md) so it is unit-testable and
// reusable by the height-mode resolution below; behavior unchanged.
export function resolveTopZ(
  heightReference: ChamferHeightReference,
  planeOffset: number,
  setup: Setup,
  sceneStock: SceneStock,
  geometryAll: ImportedGeometry[],
  geometryId: string,
  stocks: ReadonlyArray<PhysicalStock> = [],
  loopIds: ReadonlyArray<string> = [],
  referencePlaneGeo?: { geoId: string; faceIndex: number; localZ: number },
  placementRecords: readonly ModelItemPlacementRegistryEntry[] = NO_PLACEMENTS,
): number {
  const wcsZ = setup.wcs.origin.z
  // 'absolute' / 'machine_floor' / 'wcs_plane' resolve to a fixed plane and
  // touch NO geometry at all - checked BEFORE the arrival-point guard below
  // (CAM-BINDING Stage 2): a model-sourced op using one of these (the case
  // Stage 2 supports, since a modeled body has no CAM-owned stock frame
  // until Stage 3) must not be refused by a guard whose value none of these
  // three branches ever reads. 'machine_floor'/'wcs_plane' matter here
  // specifically because they are the only geometry-free reference kinds
  // actually reachable by clicking the real op wizard's Heights-tab dropdown
  // for a fresh op - 'absolute' is legacy/back-compat only, no longer
  // offered there (src/components/ui/RefPlaneSelect.tsx), so without this
  // pair a model-sourced op would have no UI-reachable way to compute at
  // all. Every OTHER reference kind (stock_top/stock_bottom/geometry_face/
  // model_top/picked_plane - all genuinely need real geometry/stock) still
  // arrives at the guard exactly as before - narrowing scope, not removing
  // the check. Formulas match this function's own pre-existing branches for
  // these two reference kinds (moved up from below, not reimplemented).
  if (heightReference === 'absolute') return planeOffset
  if (heightReference === 'machine_floor') return -wcsZ + planeOffset
  if (heightReference === 'wcs_plane') return 0 + planeOffset

  // CAM-DRILL-FIX1 (src/store/dispatchGeo.ts): a Stage-2-legit op (drill /
  // contour_2d / pocket_2d) whose OWN declared source directly IS a modeled
  // body must resolve stock_top/stock_bottom against that body's OWNING
  // STOCK, not refuse it as an illegitimate "coordinate/height reference".
  // By the time resolveTopZ is reached with `geometryId` naming a model row,
  // store/index.ts's guardOperationModelOrigin + the Stage 2 derive-then-bind
  // compute (computeOperationToolpath) have ALREADY legitimized this body as
  // the op's real, derived source (CAM-BINDING Stage 1/2; CAM-DRILL-ADAPTER
  // for drill specifically) - the general "REFERENCED by id -> THROW" rule
  // below exists for a DIFFERENT case (some OTHER op pulling a modeled body
  // in as someone else's coordinate reference), which is still refused
  // unchanged, since this branch matches ONLY `geometryId` itself.
  //
  // This is narrower than f4ba754be's stock-BOUND opt-in
  // (computeGeometryScopeIncludingStockBoundModelRows, stockId !== undefined,
  // Stage 3's "use body as stock" flow): a Stage-2 source row structurally
  // CANNOT carry a stockId (assignGeometryToStocks / migrateHierarchy always
  // clear it - stockAssignment.ts), so the owning stock is resolved a
  // different, still-narrow way: EXACTLY ONE PhysicalStock in the project ->
  // that one (mirrors the Setup modal's own "auto-bind the sole stock
  // candidate" UX - CAM-DRILL-EVIDENCE.report.md step 3). Zero or more than
  // one -> typed refusal (OwningStockError), never a guess at which stock a
  // modeled body belongs to (CAM-DRILL-FIX1.report.md stages this as an open
  // question rather than picking one silently).
  //
  // Every OTHER model-origin row in the project (i.e. NOT this op's own
  // geometryId) is still stripped exactly as computeGeometryScope always
  // strips it (via `otherGeometry` below) - this branch adds back only the
  // ONE row the op itself declared as its source, stamping the resolved
  // stock's id onto a SHALLOW COPY (mirroring the existing owned-nest-seed
  // "effective stockId" substitution pattern in store/index.ts's
  // geometryForResolve) so owningStockWorldBounds's real, audited
  // deriveStockBounds membership + Placement-composition logic picks it up
  // unchanged. resolveModelBottomZ is NOT touched - it keeps reading
  // geo.position/boundingBox directly and must never see a model row
  // reached through this path (the f4ba754be audit's -50 hazard class).
  if (heightReference === 'stock_top' || heightReference === 'stock_bottom') {
    const modelSource = geometryAll.find((g) => g.id === geometryId)
    if (modelSource && isModelOriginGeometry(modelSource)) {
      // CAM-DRILL-FIX1: resolve the op's OWNING STOCK (exactly one PhysicalStock
      // in the project -> use it; zero -> deriveAutoStockBounds fallback; more
      // than one -> typed OwningStockError refusal) via the shared helper -
      // see resolveModelSourceOwningStockBounds for the full rationale.
      const { bounds, owning } = resolveModelSourceOwningStockBounds(
        modelSource, geometryAll, sceneStock, stocks, placementRecords,
      )
      // CAM-DRILL-FIX2: the Setup's EFFECTIVE (corner-pin-mirrored) WCS-Z
      // baseline, not the possibly-stale raw setup.wcs.origin.z - see
      // effectiveWcsOriginZ for the full rationale. Shared with
      // store/index.ts's selected_face / per-hole / per-cylinder / per-loop
      // resolvers (resolveGeometryZToFrames*ModelAware*) so the formula lives
      // in exactly one place.
      const effectiveWcsZ = effectiveWcsOriginZ(setup.wcs, bounds)
      const refZ = (heightReference === 'stock_top' ? bounds.max.z : bounds.min.z) - effectiveWcsZ
      const workOffset = owning?.workOffset?.z ?? 0
      return refZ + workOffset + planeOffset
    }
  }

  // INT-17A-R2 C1: arrival-point guard, covering BOTH ids this resolver can
  // reference - the op's own geometryId AND the picked-plane datum's geoId. The
  // picked plane never passes through geometryId, so scoping the collection
  // alone would have degraded it into a misleading "no surface has been picked"
  // ReferencePlaneError instead of naming the real reason.
  const geometry = computeGeometryScope(geometryAll, geometryId, referencePlaneGeo?.geoId)

  // 'picked_plane' (MANUAL datum): the operator clicked a model face; its
  // geometry-local Z (referencePlaneGeo.localZ) is the reference plane, with
  // planeOffset applied on top. This is DISTINCT from the smart 'selected_face'
  // bottom-override (heights.selectedFaceZ) so the two never collide. FAIL LOUD
  // (ADR 0003) when the reference is 'picked_plane' but no surface was picked or
  // the picked geometry was deleted - never silently fall back to 0.
  if (heightReference === 'picked_plane') {
    if (!referencePlaneGeo) {
      throw new ReferencePlaneError(
        operatorText('dispatchGeo13'),
      )
    }
    const pickedGeo = geometry.find(g => g.id === referencePlaneGeo.geoId)
    if (!pickedGeo) {
      throw new ReferencePlaneError(
        operatorText('dispatchGeo14'),
      )
    }
    return resolveGeometryZToFrames(referencePlaneGeo.localZ, pickedGeo, setup).wcsZ + planeOffset
  }

  const workOffsetZ = (s: PhysicalStock): number => s.workOffset?.z ?? 0

  // Coordinate hierarchy Phase 2: when the project carries PhysicalStocks (every
  // migrated project does), resolve stock-derived planes from the OWNING stock's
  // world bounds - not a project-wide aggregate. resolveOwningStock fail-louds
  // (ADR-0003) on a multi-stock '__all__' selection / unassigned geometry BEFORE
  // any value is blended across parts (the B22 cross-part correctness win). When
  // stocks is empty (in-memory scenes that never went through the migrator, and
  // the pure-helper fixtures) the LEGACY flat path below runs unchanged - so a
  // 6-arg call resolves byte-identically to before. A normal single-stock
  // project resolves IDENTICALLY either way: owningStockWorldBounds(derived) ==
  // deriveAutoStockBounds(all geometry) by construction (deriveStockBounds).
  if (stocks.length > 0
      && (heightReference === 'stock_top' || heightReference === 'stock_bottom')) {
    // CAM-BINDING Stage 3 follow-on (mistral-stock-heights trial, audited -
    // coordination/model-trials/longhorizon-2026-07/mistral-stock-heights/).
    // A SEPARATE relaxed scope, computed HERE rather than reusing the shared
    // strict `geometry` above, so a stock-bound model row can contribute to
    // stock_top/stock_bottom ONLY - it must never leak into the model_top /
    // geometry_face aggregate branches below (they read geo.position /
    // geo.boundingBox DIRECTLY, no placement composition, which is exactly
    // the audit's Q1 defect class: a stock-bound row's LOCAL bbox, not its
    // real placed position). resolveOwningStock / owningStockWorldBounds
    // thread the SAME opt-in internally so their own idempotent re-scoping
    // does not silently strip the row back out.
    const scopedForStock = computeGeometryScopeIncludingStockBoundModelRows(
      geometryAll, geometryId, referencePlaneGeo?.geoId,
    )
    const owning = resolveOwningStock(geometryId, scopedForStock, stocks, true)
    const b = owningStockWorldBounds(owning, scopedForStock, sceneStock, placementRecords, true)
    const refZ = (heightReference === 'stock_top' ? b.max.z : b.min.z) - wcsZ
    return refZ + workOffsetZ(owning) + planeOffset
  }

  // --- Legacy flat path (no PhysicalStocks supplied) ---------------------------

  // AUTO stock (H1 commit B): stock_top/stock_bottom read the store-derived
  // auto bounds - the same box the corner pick and applyAutoStockToSetups use.
  // Previously this branch fell through to fixedStocks (a stock that is not
  // even displayed in auto mode) or silently degraded to the WCS plane.
  if (sceneStock.mode === 'auto'
      && (heightReference === 'stock_top' || heightReference === 'stock_bottom')) {
    const auto = deriveAutoStockBounds(geometry, sceneStock)
    const refZ = auto
      ? (heightReference === 'stock_top' ? auto.max.z : auto.min.z) - wcsZ
      : 0
    return refZ + planeOffset
  }

  // Find the FixedStockItem bound to this setup's WCS (mirrors the pinning logic in outdateWcsForStock)
  const fixed = sceneStock.fixedStocks
  const { stockId } = setup.wcs
  const stock: FixedStockItem | undefined =
    stockId       ? fixed.find(s => s.id === stockId) :
    fixed.length === 1 ? fixed[0] :
    undefined

  if (heightReference === 'stock_top') {
    const refZ = stock ? (stock.position.z + stock.depth) - wcsZ : 0
    return refZ + planeOffset
  }
  if (heightReference === 'stock_bottom') {
    const refZ = stock ? stock.position.z - wcsZ : 0
    return refZ + planeOffset
  }
  if (heightReference === 'model_top') {
    if (geometryId === '__all__') {
      // All-parts model top. With PhysicalStocks present, scope the aggregate to
      // the OWNING stock's MEMBER geometry (resolveOwningStock's multi-stock
      // guard threw first if the selection spanned stocks); without them, the
      // legacy flat all-geometry aggregate runs.
      const members = geometriesOwningSelection(
        stocks.length > 0
          ? (() => {
              const owning = resolveOwningStock(geometryId, geometry, stocks)
              return geometry.filter(g => g.stockId === owning.id)
            })()
          : geometry,
        loopIds,
      )
      const tops = members.map(g => g.position.z + g.boundingBox.max.z)
      const refZ = tops.length ? Math.max(...tops) - wcsZ : 0
      return refZ + planeOffset
    }
    const geo = geometry.find(g => g.id === geometryId)
    const refZ = geo ? (geo.position.z + geo.boundingBox.max.z) - wcsZ : 0
    return refZ + planeOffset
  }
  if (heightReference === 'geometry_face') {
    // "Geometry" = the plane the actual imported LINES/LOOPS sit on, NOT the
    // bounding-box top (Operator ruling 2026-06-13: a part's bbox.max.z is its thickness/
    // height, which silently pushed the reference off the geometry plane). For
    // flat 2D imports the loops sit at the geometry's position.z; projected
    // layers carry the explicit plane they were projected onto.
    const geoFaceZ = (g: ImportedGeometry, loopIds: ReadonlyArray<string> = []) => {
      // WO-3066: an STL edge chain carries the part-local Z it lies at (one
      // chain layer holds every Z, so the layer has no plane of its own).
      // The picked chains' plane is that Z on the part, the highest of them
      // the way layer planes aggregate below.
      // A part tipped about X or Y has no single plane for a chain; it keeps
      // the fallbacks below.
      const level = Math.abs(g.rotation.x) < 1e-9 && Math.abs(g.rotation.y) < 1e-9
      const chainZs = loopIds.length === 0 || !level ? [] : (g.loops ?? [])
        .filter(lp => loopIds.includes(lp.id) && lp.z !== undefined)
        .map(lp => lp.z as number)
      if (chainZs.length > 0) return g.position.z + Math.max(...chainZs)
      // Per-layer projection planes are set when loops come from STL/face
      // projections - that IS the plane the projected lines are on.
      // B-rep derived planes (frame 'geometry_local') store the MODEL Z;
      // layerPlaneWorldZ adds g.position.z for those (world-baked pass through).
      // Per ADR-0020, geometry_face is the plane of the op's SELECTED loops'
      // OWNING layer, not the geometry-wide max - otherwise deriving a new (high)
      // layer for one op leaks its plane into every other op on the same geometry.
      let layers = g.layers2d ?? []
      if (loopIds.length > 0) {
        const ownerIds = new Set(
          (g.loops ?? []).filter(lp => loopIds.includes(lp.id)).map(lp => lp.layerId),
        )
        const owned = layers.filter(l => ownerIds.has(l.id))
        // No owning layer found (orphan / cross-geometry loopIds): fall back to
        // the legacy aggregate over ALL layers rather than crashing.
        if (owned.length > 0) layers = owned
      }
      const layerZs = layers
        .map(l => layerPlaneWorldZ(l, g))
        .filter((z): z is number => z !== undefined)
      if (layerZs.length > 0) return Math.max(...layerZs)
      if (g.projectionPlane) return g.projectionPlane.origin.z
      // Plain imported 2D (DXF/SVG/sketch): the loops are flat at position.z.
      return g.position.z
    }
    if (geometryId === '__all__') {
      // All-parts mode: the highest geometry plane across loaded parts. Do NOT
      // floor at wcsZ - geometry usually sits BELOW the WCS (which is on the
      // stock top), and the old Math.max(..., wcsZ) seed silently snapped the
      // reference up to the WCS plane (B17: "Geometry" ignored, used stock top).
      // With PhysicalStocks present, scope to the OWNING stock's MEMBER geometry
      // (multi-stock '__all__' already threw in resolveOwningStock); without
      // them, the legacy flat all-geometry aggregate runs.
      const members = geometriesOwningSelection(
        stocks.length > 0
          ? (() => {
              const owning = resolveOwningStock(geometryId, geometry, stocks)
              return geometry.filter(g => g.stockId === owning.id)
            })()
          : geometry,
        loopIds,
      )
      const faces = members.map(g => geoFaceZ(g, loopIds))
      const faceWorldZ = faces.length ? Math.max(...faces) : wcsZ
      return (faceWorldZ - wcsZ) + planeOffset
    }
    const geo = geometry.find(g => g.id === geometryId)
    // Missing geometry: there is no geometry plane to reference; fall back to
    // the WCS plane (offset only). A FOUND geometry uses its actual plane.
    const faceWorldZ = geo ? geoFaceZ(geo, loopIds) : wcsZ
    return (faceWorldZ - wcsZ) + planeOffset
  }
  // 'machine_floor' and 'wcs_plane' are handled above, before the
  // arrival-point guard (CAM-BINDING Stage 2) - unreachable here by
  // construction; this line only exists to satisfy the function's return
  // type for the closed ChamferHeightReference union.
  return 0 + planeOffset
}

/**
 * WCS-relative Z of the model BOTTOM reference plane (bottomHeightMode
 * 'model_bottom'): world bounding-box min Z of the source geometry minus
 * wcsOrigin.z. geometryId '__all__' takes the LOWEST bottom across all
 * loaded geometry (the parallel of resolveTopZ's geometry_face max). A
 * missing geometry falls back to 0 (the WCS plane) - same fallback as
 * resolveTopZ's model_top branch. The caller adds the user's bottomHeight
 * as a signed offset from this plane.
 */
export function resolveModelBottomZ(
  geometryAll: ReadonlyArray<ImportedGeometry>,
  geometryId: string,
  wcsZ: number,
  stocks: ReadonlyArray<PhysicalStock> = [],
  loopIds: ReadonlyArray<string> = [],
): number {
  // INT-17A-R2 C1: arrival-point guard (see computeGeometryScope). Without it a
  // modeled body parked low in Z silently dragged the '__all__' bottom plane
  // down - a wrong cut depth, not merely a blocked op.
  //
  // DELIBERATELY STAYS STRICT (mistral-stock-heights audit.md Q1/Q2): this
  // function reads `g.position.z + g.boundingBox.min.z` DIRECTLY below - a
  // model row's own position is IDENTITY forever (INT-17C), its real world
  // pose lives only in the Placement registry, so a stock-bound model row let
  // in here would contribute its LOCAL (unplaced) bbox instead of its real
  // world Z - the exact HIGH-severity regression the audit reproduced live
  // (local bbox min.z=-50 dragged the '__all__' bottom plane to -50
  // regardless of the body's real placement). Never call this with
  // computeGeometryScopeIncludingStockBoundModelRows, and never pass
  // includeStockBoundModelRows=true to the resolveOwningStock call below.
  const geometry = computeGeometryScope(geometryAll, geometryId)
  // '__all__' with PhysicalStocks present: constrain the Math.min to the OWNING
  // stock's MEMBER geometry (resolveOwningStock throws first if the selection
  // spans stocks). Without stocks (legacy/in-memory), the flat all-geometry min
  // runs unchanged. Single-geometry is unaffected either way. ADR-0020 rule 2:
  // the aggregate is then narrowed to the geometry owning the selected loopIds.
  const geos = geometryId === '__all__'
    ? geometriesOwningSelection(
        stocks.length > 0
          ? (() => {
              const owning = resolveOwningStock(geometryId, geometry, stocks)
              return geometry.filter(g => g.stockId === owning.id)
            })()
          : geometry,
        loopIds,
      )
    : geometry.filter(g => g.id === geometryId)
  if (geos.length === 0) return 0
  const worldMin = Math.min(...geos.map(g => g.position.z + g.boundingBox.min.z))
  return worldMin - wcsZ
}

/**
 * R3 plane-ordering validation (docs/planning/HEIGHTS-AUDIT-AND-PLAN.md):
 * clearance >= retract >= feed >= top > bottom. All inputs are WCS-relative
 * (clearance/retract/feed carry no modes; top/bottom are the RESOLVED
 * planes), so they are directly comparable. Returns a plain-language error
 * naming the offending planes and values, or null when the ordering holds.
 * ADR 0003: the caller blocks dispatch on a non-null return - never a
 * silent wrong toolpath.
 */
export function planeOrderingError(
  heights: Pick<HeightParams, 'clearanceHeight' | 'retractHeight' | 'feedHeight'>,
  resolvedTop: number,
  resolvedBottom: number,
): string | null {
  const f = (n: number) => String(Number(n.toFixed(3)))
  if (heights.clearanceHeight < heights.retractHeight) {
    return operatorText('dispatchGeo15', { value1: String(f(heights.clearanceHeight)), value2: String(f(heights.retractHeight)) })
  }
  if (heights.retractHeight < heights.feedHeight) {
    return operatorText('dispatchGeo16', { value1: String(f(heights.retractHeight)), value2: String(f(heights.feedHeight)) })
  }
  if (heights.feedHeight < resolvedTop) {
    return operatorText('dispatchGeo17', { value1: String(f(heights.feedHeight)), value2: String(f(resolvedTop)) })
  }
  if (resolvedBottom >= resolvedTop) {
    return operatorText('dispatchGeo18', { value1: String(f(resolvedBottom)), value2: String(f(resolvedTop)) })
  }
  return null
}

/**
 * B24 co-move: when a part is laid on a face (a rigid MOVE), the top plane
 * re-resolves to the moved stock but the user-configured approach planes
 * (feed/retract) carry RAW absolute panel values, so feed gets stranded below
 * the re-resolved top and the op falsely fails the "Feed height below top
 * height" ordering check. The fix preserves the GAP the user configured above
 * the material: feed and retract co-move with the resolved top by the same
 * delta. Clearance stays machine-absolute (it protects clamps/fixtures, not the
 * part), so a clearance that ends up below the moved retract/feed STILL fails
 * loud via planeOrderingError - that is a genuine "clearance too low for the
 * laid-on part", not suppressed here.
 *
 * All values are WCS-relative (resolveHeights adds wcsOrigin.z later to all five
 * planes uniformly). When top is in 'absolute' mode, resolvedTop === rawPanelTop
 * so topDelta === 0 and nothing moves - correct and intended.
 *
 * Pure: returns a new HeightParams with feedHeight/retractHeight shifted by
 * (resolvedTop - rawPanelTop); clearanceHeight/topHeight/bottomHeight unchanged.
 */
export function coMoveApproachPlanes(
  heights: HeightParams,
  resolvedTop: number,
  rawPanelTop: number,
): HeightParams {
  const topDelta = resolvedTop - rawPanelTop
  return {
    ...heights,
    feedHeight:    heights.feedHeight    + topDelta,
    retractHeight: heights.retractHeight + topDelta,
  }
}

export function findTiltedGeometryLocalSource(
  geoSources: ReadonlyArray<ImportedGeometry>,
  heights: Pick<HeightParams, 'bottomHeightMode' | 'selectedFaceZ'>,
): { geo: ImportedGeometry; kind: 'tilted' | 'flipped' } | null {
  const usesSelectedFace =
    heights.bottomHeightMode === 'selected_face' && heights.selectedFaceZ !== undefined
  const consumesGeometryLocal = (g: ImportedGeometry): boolean =>
    (g.layers2d ?? []).some(l => l.frame === 'geometry_local' || (l.holes?.length ?? 0) > 0)
    || (g.format === 'step' && usesSelectedFace)
  for (const g of geoSources) {
    const kind = classifyRotationOffZ(g.rotation)
    if (kind !== 'aligned' && consumesGeometryLocal(g)) return { geo: g, kind }
  }
  return null
}
