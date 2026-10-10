// INT-17C Stage C1, step 2: the ModelItem/Placement types and the Placement
// Composition Contract's seam function -- introduced additively, wired to zero
// call sites yet (wiring is step 3, coordination/work-orders/INT-17C-C1-PREFLIGHT.md
// section 2). See coordination/work-orders/INT-17C.md, "The Placement
// Composition Contract" section, for the binding name/signature/invariants
// this module implements.
//
// NAMING RULING (INT-17C.md COORDINATOR RULINGS 2026-07-22, item c): the
// placement record type is `ModelItemPlacement`, not the WO prose's shorthand
// `Placement` -- `src/lib/cam/nesting/types.ts:34` already exports an
// unrelated `Placement` (2D nest-instance transform). No collision, no
// ambiguity.
//
// PURITY, and the one place this module's shape deviates from the WO's
// literal two-argument signature (cited in resolveModelItemPlacement's own
// doc comment below): the WO's contract prose gives
// `resolveModelItemPlacement(modelItemId, bodyId?)`, but invariant 2 requires
// this function to be pure and this module to mirror modelOrigin.ts's and
// modelBodyAdapter.ts's "no-store/no-kernel purity" -- both of which are
// stateless, taking their data as explicit parameters, never hidden module
// state (unlike src/doc/documentHolder.ts, which IS a stateful singleton
// service and is not the purity precedent this module cites). Stage C1 (WO
// steps 2-4, this mission's scope) ships no persisted, project-level
// Placement registry -- that is the v12 migration, WO extraction-order step
// 7, explicitly out of this mission's scope. A pure resolver has nothing to
// read unless its caller hands it the records, so `placements` is an added,
// leading parameter. `modelItemId`/`bodyId` keep the contract's exact names
// and order after it.

import type { Vec3 } from '../../types'

/** ModelItem (INT-17C.md "Data model" section): one project-visible authored
 *  unit. `archive` is the existing liencam-3d-zip format (unchanged, per-item
 *  cardinality only) -- the same bytes `src/doc/persist/format.ts`'s
 *  `createDocumentArchive`/`loadDocumentArchive` already produce/consume for
 *  the single legacy document today. `outputBodies` names which
 *  `ModelBodyRef.bodyId`s this item currently produces, for the body-filtered
 *  Placement lookup below. Not yet wired into any registry (WO step 7); this
 *  type ships now so Stage C1's later steps and the v12 migration have a
 *  shape to build toward without a second design pass.
 */
export interface ModelItem {
  id: string
  name: string
  archive: Uint8Array
  outputBodies: string[]
}

/** ModelItemPlacement (INT-17C.md "Data model" section): a project-owned
 *  rigid transform, living outside every model archive. `bodyId` omitted =
 *  the automatic whole-item Placement every new Stage C1 item receives;
 *  `bodyId` present = the body-filtered form the v12 migration needs so each
 *  legacy Stage-1 geometry row's own pose is preserved rather than merged
 *  (WO "Data model" section; Stage C1 ships no UI command to create one by
 *  hand -- it exists in the schema solely for lossless migration).
 */
export interface ModelItemPlacement {
  modelItemId: string
  bodyId?: string
  position: Vec3
  rotation: Vec3
}

/** The rigid transform `resolveModelItemPlacement` returns: the shape already
 *  used by `ImportedGeometry.position`/`.rotation` (position + Euler rotation
 *  in degrees), per the contract's signature note. */
export interface RigidTransform {
  position: Vec3
  rotation: Vec3
}

/** Named, greppable refusal (ADR-0003 fail-loud style, mirroring
 *  `ModelReferenceResolutionError`/`HeightIntentResolutionError`): thrown when
 *  `resolveModelItemPlacement` is asked about an item/body with no valid
 *  Placement record. Contract invariant 4: "no Placement yet" must be
 *  distinguishable from "Placement resolved to identity" -- this error IS
 *  that distinction; it is never thrown for a real, registered record whose
 *  value happens to be identity. */
export class ModelItemPlacementResolutionError extends Error {
  constructor(message: string) {
    super(`ModelItemPlacementResolutionError: ${message}`)
    this.name = 'ModelItemPlacementResolutionError'
  }
}

function placementKey(modelItemId: string, bodyId?: string): string {
  return bodyId !== undefined ? `${modelItemId}:${bodyId}` : modelItemId
}

/** Minimal structural shape a Placement lookup can be built from: today's only
 *  real per-row position/rotation state (`ImportedGeometry.position`/
 *  `.rotation` are non-optional fields, so every existing model row already
 *  carries one). Deliberately narrow, mirroring `modelOrigin.ts`'s
 *  `ModelOriginCandidate` pattern, so callers don't need to import the full
 *  `ImportedGeometry` type just to build a lookup. */
export interface ModelItemPlacementSource {
  id: string
  position: Vec3
  rotation: Vec3
}

/**
 * Build one identity-preserving `ModelItemPlacement` per row, keyed by the
 * row's OWN id -- the only stable per-body identity that exists pre-migration
 * (the real many-`ModelItem` registry doesn't exist until the v12 migration,
 * WO step 7). This function IS "the migration/default path guaranteeing every
 * item HAS one" (per this mission's scope note): every row passed in
 * structurally has a `position`/`.rotation` already (required fields), so the
 * lookup it returns never omits an entry for a row that is actually present
 * -- `resolveModelItemPlacement` only refuses for an id with no MATCHING row
 * at all, the genuine "doesn't exist" case invariant 4 names.
 *
 * This is also the WO's own words made concrete: "Its body returns the
 * resolved item's stored Placement (identity for every item today, because
 * Stage C1 ships no way to move one) -- it is not a fake stub returning a
 * hardcoded identity constant, it is the REAL function reading REAL
 * (currently-always-identity) state" (INT-17C.md, Stage C1, "Placement
 * seam"). A row's own position/rotation ARE that real state today.
 */
export function placementsFromGeometry(
  rows: readonly ModelItemPlacementSource[],
): Map<string, ModelItemPlacement> {
  const map = new Map<string, ModelItemPlacement>()
  for (const row of rows) {
    map.set(placementKey(row.id), {
      modelItemId: row.id,
      position: row.position,
      rotation: row.rotation,
    })
  }
  return map
}

/** Minimal structural shape a persisted `Project.modelItemPlacements` entry
 *  has -- deliberately narrow (not `ModelItemPlacementRecord` from
 *  `src/types/index.ts`) so this stays a leaf module `types/index.ts` can
 *  import FROM without a cycle (that file's own comment on
 *  `ModelItemPlacementRecord` explains the same constraint in reverse). */
export interface ModelItemPlacementRegistryEntry {
  modelItemId: string
  bodyId?: string
  position: Vec3
  rotation: Vec3
}

/**
 * INT-17C Stage C2: build the seam's lookup Map from the REAL, persisted
 * per-project Placement registry (`Project.modelItemPlacements`), instead of
 * `placementsFromGeometry`'s Stage C1 identity-derivation stand-in. This is
 * "the placements-map parameter now fed from project state at every call
 * site" the WO's Stage C2 mission names -- every consumer (viewport draw,
 * Properties Panel, the gizmo commit path) builds its lookup through this
 * function, never by hand, so the key scheme (`modelItemId`[`:bodyId`]) stays
 * in exactly one place.
 */
export function placementRegistry(
  records: readonly ModelItemPlacementRegistryEntry[],
): Map<string, ModelItemPlacement> {
  const map = new Map<string, ModelItemPlacement>()
  for (const record of records) {
    map.set(placementKey(record.modelItemId, record.bodyId), {
      modelItemId: record.modelItemId,
      bodyId: record.bodyId,
      position: record.position,
      rotation: record.rotation,
    })
  }
  return map
}

/**
 * THE Placement seam (INT-17C.md "The Placement Composition Contract").
 * Resolves the rigid transform that maps a Model Item's LOCAL model-space
 * geometry into PROJECT space -- composes ONE step of ADR-0020's existing
 * chain (this function IS `projectPlacement`).
 *
 * Pure (invariant 2): no kernel call, no mutation, no side effect; reads only
 * the `placements` lookup the caller supplies. Fails loud (invariant 4,
 * ADR-0003) rather than defaulting to identity when no record exists for
 * `modelItemId`(+`bodyId`) -- "no Placement yet" is a thrown
 * `ModelItemPlacementResolutionError`, never a silently-substituted identity.
 *
 * `bodyId` omitted resolves the item's one automatic whole-item Placement.
 * `bodyId` present first tries the body-filtered record; if none exists it
 * falls back to the item's whole-item record (Stage C1 ships no UI to CREATE
 * a body-filtered Placement by hand, so today every real lookup this falls
 * back to IS the whole-item record -- the fallback exists so a future
 * caller that starts passing `bodyId` before body-filtered records exist for
 * every item does not regress from "resolves" to "refuses").
 */
export function resolveModelItemPlacement(
  placements: ReadonlyMap<string, ModelItemPlacement>,
  modelItemId: string,
  bodyId?: string,
): RigidTransform {
  const record =
    (bodyId !== undefined ? placements.get(placementKey(modelItemId, bodyId)) : undefined) ??
    placements.get(placementKey(modelItemId))

  if (!record) {
    throw new ModelItemPlacementResolutionError(
      `no Placement record for Model Item "${modelItemId}"` +
        (bodyId !== undefined ? ` (body "${bodyId}")` : '') +
        `. An item/body with no valid Placement refuses by name rather than ` +
        `defaulting to identity or a stale cached value.`,
    )
  }
  return { position: record.position, rotation: record.rotation }
}
