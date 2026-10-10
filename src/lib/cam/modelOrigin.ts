import type { OperationType } from '../../types'

// INT-17A-R1: the ONE model-origin predicate every consumer seam refuses on.
//
// Round 1 shipped the origin gate at the seams the preflight's consumer list
// named (op picker, DesignTree delete, viewport render). The audit then found
// four INDIRECT routes that reached a model entry anyway - a rehydrate blob, an
// `__all__` aggregation, an `undefined`-becomes-default fallthrough, and a
// cascade delete. Every one of them was a reader that never asked about origin.
//
// The lesson is the shared-resolver one: an origin rule spelled out at each
// call site is an origin rule that a NEW call site silently opts out of. So the
// predicate lives here, once, and every accept path that must refuse a modeled
// body imports it and refuses BY NAME via `modelOriginRefusal` - so the refusal
// is greppable, testable, and says which seam turned the entry away and why.
//
// Stage 1 is READ-ONLY for modeled geometry: a modeled body is a projection of
// a live Model-workbench body, not a CAM-owned artifact. It may be listed,
// drawn, coloured, hidden and folded; it may NOT be cut, deleted, stock-bound,
// or aggregated into an operation. Stage 3 is where ops on modeled geometry
// arrive, and it will relax these seams deliberately, one at a time.

/** The `format` value a Model-workbench body carries as a CAM geometry entry. */
export const MODEL_ORIGIN_FORMAT = 'model' as const

/** Structural minimum this predicate needs - deliberately NOT ImportedGeometry,
 *  so pure modules (stockAssignment, migrateHierarchy) can use it against their
 *  own narrowed row shapes without importing the full geometry type. */
export interface ModelOriginCandidate {
  format?: string
}

/**
 * TRUE when this geometry entry is a Model-workbench body surfaced in CAM.
 *
 * Keyed on `format` ALONE, deliberately: `type`, `loops` and `modelBody` are all
 * shapes a later stage (or a hostile/legacy row) can change, and the audit's
 * `__all__` bypass was found with a hand-built `{format:'model', type:'brep',
 * loops:[...]}` row that satisfied every shape-based gate. Origin is the thing
 * that does not change, so origin is what the refusals key on.
 */
export function isModelOriginGeometry(geo: ModelOriginCandidate | null | undefined): boolean {
  return geo?.format === MODEL_ORIGIN_FORMAT
}

/**
 * CAM-BINDING Stage 1 (coordination/work-orders/CAM-BINDING.md): TRUE when a
 * model-origin entry may be selected as an operation's declared SOURCE - the
 * op-picker gate the charter opens deliberately, one seam at a time.
 *
 * Deliberately a SEPARATE, narrower predicate from `isModelOriginGeometry`,
 * not a relaxation of it: every other consumer (stock membership, delete,
 * nest aggregation - DesignTree.tsx, dispatchGeo.ts, store/index.ts,
 * migrateHierarchy.ts, stockAssignment.ts) must keep refusing on
 * `isModelOriginGeometry` completely unchanged. Only the op-source-list seams
 * (NewOperationModal.tsx's `operationSourceGeometries`/`parallel3dSolids`
 * filters) call this one instead.
 *
 * Today it is TRUE for every live modeled body - Stage 1 picks at whole-BODY
 * granularity, the only granularity INT-17A's adapter surfaces a modeled body
 * at (one CAM geometry entry per body, no face-level identity yet). Kept as
 * its own named function, not inlined as `isModelOriginGeometry(geo)`, so a
 * later stage (Stage 5's face-level picking, or a future per-body opt-out)
 * can narrow THIS predicate without touching what stock/delete/aggregate
 * refuse on.
 *
 * Selecting it as a source does not mean it can COMPUTE: Stage 1's compute
 * boundary (src/store/index.ts's `computeOperationToolpath`, the
 * `guardOperationModelOrigin` catch) still refuses to build a toolpath from a
 * model-origin source - it just refuses with a distinct, named 'unsupported'
 * status (OperationStatus) instead of a hard 'error', because Stage 1 makes
 * the SELECTION legitimate even though the COMPUTE is not yet built (Stage 2).
 */
export function isModelOpSourceEligible(geo: ModelOriginCandidate | null | undefined): boolean {
  return isModelOriginGeometry(geo)
}

/**
 * The geometry intent a CAM operation needs when its source is a modeled body.
 *
 * `computeSupported` is deliberately separate from `mode`: it records both the
 * operation's eventual consumption shape and whether today's direct-binding
 * pipeline implements that shape. This keeps future cylinder/edge widening
 * explicit without making an unfinished route look usable.
 */
export type ModelBodyBindingMode =
  | 'profile'
  | 'hole-targets'
  | 'cylinder-targets'
  | 'solid'
  | 'edge-paths'
  | 'unsupported'

export type ModelBodyBindingCapability =
  | { mode: 'profile' | 'hole-targets' | 'cylinder-targets' | 'solid' | 'edge-paths'; computeSupported: true }
  | {
      mode: 'profile' | 'hole-targets' | 'cylinder-targets' | 'solid' | 'edge-paths' | 'unsupported'
      computeSupported: false
    }

/**
 * Exhaustive modeled-body binding capability map.
 *
 * Store compute routing and the operation wizard both consume this record, so
 * an operation cannot advertise a modeled-body affordance the store will later
 * refuse. Adaptive Clearing is profile-equivalent to Pocket; stock-boundary
 * modeled-boss avoidance remains a separate concern.
 */
export const MODEL_BODY_BINDING_CAPABILITIES: Readonly<
  Record<OperationType, ModelBodyBindingCapability>
> = {
  // WO-1963: Face fills the body's top-down profile through the same derive
  // Contour/Pocket/Adaptive Clearing use.
  face: { mode: 'profile', computeSupported: true },
  contour_2d: { mode: 'profile', computeSupported: true },
  pocket_2d: { mode: 'profile', computeSupported: true },
  adaptive_clearing_2d: { mode: 'profile', computeSupported: true },
  drill: { mode: 'hole-targets', computeSupported: true },
  bore: { mode: 'cylinder-targets', computeSupported: true },
  // WO-1942: Thread Mill threads the picked hole (internal) or boss (external).
  thread_mill: { mode: 'cylinder-targets', computeSupported: true },
  // WO-1939: Engrave follows a picked edge chain, open paths included.
  engrave: { mode: 'edge-paths', computeSupported: true },
  // WO-1940: V-carve carves the closed region a picked edge chain bounds.
  vcarve: { mode: 'edge-paths', computeSupported: true },
  // WO-1941: Chamfer bevels the closed loop a picked edge chain forms.
  chamfer: { mode: 'edge-paths', computeSupported: true },
  // WO-1954: Parallel 3D finishes the body's tessellated solid through the
  // same PartMesh adapter Adaptive 3D uses.
  parallel_3d: { mode: 'solid', computeSupported: true },
  // WO-1956: Waterline 3D slices the same tessellated solid, through the same
  // adapter.
  waterline_3d: { mode: 'solid', computeSupported: true },
  adaptive_3d: { mode: 'solid', computeSupported: true },
  // WO-1957: Scallop 3D follows the same tessellated solid, through the same
  // adapter (it shares Parallel 3D's orchestrator).
  scallop_3d: { mode: 'solid', computeSupported: true },
  // WO-1958: Steep/Shallow 3D splits the same tessellated solid into its
  // waterline and area passes, through the same adapter (it shares Parallel
  // 3D's orchestrator).
  steep_shallow_3d: { mode: 'solid', computeSupported: true },
  // WO-1959: Pencil 3D traces the inside corners of the same tessellated solid,
  // through the same adapter (it shares Parallel 3D's orchestrator).
  pencil_3d: { mode: 'solid', computeSupported: true },
}

/** Replicated here verbatim -- NOT imported -- the SAME precedent
 *  modelBodyAdapter.ts's own identical comment documents (this module also
 *  stays free of a src/doc/ dependency). Must equal
 *  src/doc/documentHolder.ts's `LEGACY_MODEL_ITEM_ID` byte-for-byte --
 *  modelOriginResolveOwningModelItem.intModelUnify.test.ts asserts this so
 *  the constants can never silently drift. */
const LEGACY_MODEL_ITEM_ID = 'legacy'

/** Structural minimum `resolveOwningModelItemId` needs beyond
 *  `ModelOriginCandidate` -- the row's own (possibly absent) ownership tag. */
export interface ModelItemOwnedCandidate extends ModelOriginCandidate {
  modelItemId?: string
}

/**
 * INT-MODEL-UNIFY: which Model Item a geometry row belongs to, for every nav
 * path that ROUTES to a model's editor (the Model tab's selection-aware
 * entry, and DesignTree's "Edit model" pencil button + context-menu item --
 * the three paths UI-EDIT-MODEL-FROM-BODY named, per the shared-resolver
 * discipline: one resolver, every pick type).
 *
 * A model-origin row minted while scoped to the legacy item never carries
 * `modelItemId` on the row itself -- modelBodyAdapter.ts's
 * `buildModelBodyGeometry` writes it `undefined` there BY DESIGN, byte-
 * identical to every pre-Stage-C1 row, so migration's own "unclaimed row"
 * detector (`typeof g.modelItemId !== 'string'`) keeps working. That left the
 * legacy item's own rows invisible to every consumer that read
 * `geo.modelItemId` directly, even after the legacy item is claimed into
 * `project.modelItems` (INT-MODEL-UNIFY's own store-level fix). This is the
 * ONE place that fills the gap back in with the same legacy-id fallback
 * every other consumer already implicitly defaults to (`itemScope` in
 * modelBodyAdapter.ts, `MIGRATION_LEGACY_MODEL_ITEM_ID` in
 * projectMigrations.ts) -- so a legacy-origin row is navigable exactly like
 * any other model-origin row, without touching the adapter's own pinned
 * "leave it undefined" row-shape contract.
 *
 * Returns undefined for a non-model row (nothing to route to) -- the caller
 * still owns deciding whether the resolved id names a REAL record in
 * `project.modelItems` (a stale/deleted id must still fall through, exactly
 * as today).
 */
export function resolveOwningModelItemId(
  geo: ModelItemOwnedCandidate | null | undefined,
): string | undefined {
  if (!isModelOriginGeometry(geo)) return undefined
  return geo?.modelItemId ?? LEGACY_MODEL_ITEM_ID
}

/** Structural minimum `isWrappableStepRow` needs -- the row format plus the
 *  nest-seed ownership tag (a nest's integrated seed copy is not independently
 *  editable). */
export interface StepRowCandidate {
  format?: string
  ownerNestId?: string
}

/**
 * GEO-UNIFY Stage 4 / INT-IMPORT-EDIT stage 1: TRUE when a CAM geometry row is
 * a plain imported STEP part that "Edit as model" can wrap into a Model Item.
 *
 * The ONE predicate all three nav paths gate their affordance on (context menu,
 * inline PenTool button, selection-aware Model tab) -- the shared-resolver
 * discipline, the same one `resolveOwningModelItemId` follows for the post-wrap
 * model-origin paths. Keyed on `format === 'step'` and NOT a nest seed copy;
 * STL rows (mesh, no B-rep) and every non-STEP row are excluded here so their
 * affordance never appears (the honest-refusal pattern the STL matrix row
 * documents). Body-count / missing-bytes are NOT pre-filtered here on purpose:
 * they are refused BY NAME at click time by wrapImportedStepAsModelItem, so the
 * multi-body/missing-bytes refusal always has a reachable, named home
 * (ADR-0003) rather than being silently hidden -- and `solidCount` may be
 * unknown on a cold reload anyway.
 */
export function isWrappableStepRow(geo: StepRowCandidate | null | undefined): boolean {
  return geo?.format === 'step' && !geo?.ownerNestId
}

/**
 * MSH-3 wiring / INT-IMPORT-EDIT stage 4 (REV-ENG rung 0): TRUE when a CAM
 * geometry row is a plain imported STL mesh that "Edit as model" can wrap into a
 * Model Item (via the prismatic mesh -> B-rep converter). The STL analog of
 * `isWrappableStepRow`: keyed on `format === 'stl'` and NOT a nest seed copy.
 *
 * Curved / non-watertight / degenerate meshes are NOT pre-filtered here on
 * purpose -- the affordance appears for ANY plain STL row, and the wrap action
 * REFUSES those BY NAME at click time with the converter's own typed,
 * region-naming message (ADR-0003), so the refusal always has a reachable,
 * named home rather than being silently hidden. (Whether a mesh is prismatic is
 * unknowable without running the converter, so hiding the affordance would make
 * that refusal unreachable -- worse under ADR-0003.)
 */
export function isWrappableMeshRow(geo: StepRowCandidate | null | undefined): boolean {
  return geo?.format === 'stl' && !geo?.ownerNestId
}

/**
 * The ONE predicate all three "Edit as model" nav paths (context menu, inline
 * PenTool button, selection-aware Model tab) gate their affordance on -- the
 * shared-resolver discipline: one gate, every wrappable pick type. TRUE for a
 * plain imported STEP part OR a plain imported STL mesh; every OTHER format is
 * excluded (and the wrap action refuses them by name if reached). The two
 * format branches route inside `wrapImportedGeometryAsModelItem`.
 */
export function isWrappableGeometryRow(geo: StepRowCandidate | null | undefined): boolean {
  return isWrappableStepRow(geo) || isWrappableMeshRow(geo)
}

/**
 * The named refusal message for a seam that turned a modeled entry away.
 * `seam` is the function/UI that refused; `subject` identifies the entry.
 * Used for throws, console.error and user-facing notices alike so a refusal
 * reads the same wherever it surfaces.
 */
export function modelOriginRefusal(seam: string, subject: string, consequence: string): string {
  return (
    `${seam}: refusing modeled geometry "${subject}". A modeled body is a ` +
    `read-only projection of a live Model-workbench body in Stage 1 (INT-17A), ` +
    `so ${consequence}`
  )
}
