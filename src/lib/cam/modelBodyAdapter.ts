// INT-17A Stage 1: body-to-CAM-geometry adapter (B1/B3).
//
// Turns each LIVE Model-workbench body into ONE first-class CAM geometry entry
// (ruling 2: per-BODY granularity, dozens of cards not hundreds of faces) and
// reconciles the CAM geometry list against the live body set on every regen -
// add / update / delete / rename, exhaustively, with a STABLE entry id per body
// so a regen updates the SAME entry instead of churning ids or spawning
// duplicates.
//
// IDENTITY LAW (DECISIONS 2026-07-18 ruling 1): a model-backed entry rides the
// Model kernel's ElementMap identity EXCLUSIVELY. This module NEVER imports or
// calls importBrepGeometry / readStep / cacheStep / setBrepPayload - it only
// shapes plain data. The identity handle it carries is `modelBody.ref`
// (bodyId + ElementMap stableIds), never an occt-model `{geoId,kind,index}`.
//
// PURE: no store, no viewport, no kernel. Every function is a total, testable
// transform over plain data, so the store action and the unit tests exercise the
// exact same reconciliation.

import type {
  BoundingBox,
  ImportedGeometry,
  ModelBody,
  ModelBodyDisplay,
  ModelBodyRef,
  Project,
} from '../../types'

/** Replicated here verbatim -- NOT imported -- so this pure adapter module
 *  (no store, no viewport, no kernel; see this file's own header) stays free
 *  of any src/doc/ dependency. Mirrors src/store/migrations/projectMigrations.ts's
 *  own MIGRATION_LEGACY_MODEL_ITEM_ID precedent, which states the SAME
 *  reasoning verbatim. Must equal src/doc/documentHolder.ts's
 *  LEGACY_MODEL_ITEM_ID byte-for-byte -- int17aModelBodySync.test.ts pins
 *  this so the constants can never silently drift.
 *
 *  WO INT-17C Stage C1 CLOSURE (gap 2): the item-scope sentinel every
 *  pre-closure call site implicitly used without ever naming it -- every
 *  existing model row and every existing `syncModelBodies` caller omitted
 *  `modelItemId` entirely, which is the SAME thing as scoping to this
 *  constant. Introducing it now, and scoping reconciliation by it, is what
 *  closes the preflight-flagged risk (census 1b): two Model Items whose
 *  bodies mint the same raw bodyId no longer collide on one CAM geometry
 *  row, because they no longer share one flat, item-blind bodyId namespace. */
const LEGACY_MODEL_ITEM_ID = 'legacy'

/** The effective item-scope of a (possibly omitted) modelItemId -- omitted
 *  means "the legacy item", exactly as every pre-closure call site already
 *  behaved. */
function itemScope(modelItemId: string | undefined): string {
  return modelItemId ?? LEGACY_MODEL_ITEM_ID
}

/** The stable, deterministic CAM geometry-entry id for a Model body. The map
 *  "BodyId -> entry id" (B3) IS this derivation: bodyId is immutable (a DAG node
 *  id, caller-assigned, never minted by the DAG - src/doc/dag.ts), so the same
 *  body always resolves to the same entry id with no side table to drift.
 *
 *  `modelItemId` (CLOSURE gap 2, optional, added parameter): omitted or equal
 *  to the legacy item keeps the ORIGINAL, unscoped `modelbody:${bodyId}` id --
 *  byte-identical to every pre-closure call and every existing test
 *  (int17aModelBodyAdapter.test.ts calls this with ONE argument and pins the
 *  unscoped form exactly). A real non-legacy item folds its own id into the
 *  entry id, so two items whose live bodies mint the same raw bodyId (a real
 *  risk -- bodyId is a per-item DAG node id, not project-wide-unique) can
 *  never collide on one CAM geometry entry id either. */
export function modelBodyEntryId(bodyId: string, modelItemId?: string): string {
  const scope = itemScope(modelItemId)
  return scope === LEGACY_MODEL_ITEM_ID ? `modelbody:${bodyId}` : `modelbody:${scope}:${bodyId}`
}

/** True iff an entry is a model-backed CAM entry. Keyed on BOTH the format value
 *  and the presence of the durable handle, so a malformed half-entry is never
 *  mistaken for a real one. */
export function isModelBodyEntry(geo: ImportedGeometry): boolean {
  return geo.format === 'model' && geo.modelBody !== undefined
}

/** NAV-BODY-ROW: the exact CAM geometry row for a live Model body, scoped by
 *  item exactly like `reconcileModelBodies` itself (`itemScope`) -- the ONE
 *  forward lookup ("given a body, which CAM row") every nav-carry consumer
 *  (Feature Tree body row -> CAM Geometry row) should use, rather than
 *  re-deriving the `modelbody:<bodyId>` id shape by hand. That shape is NOT
 *  reliable for a GEO-UNIFY Stage 4 adopted body: `adoptStepRowAsModelBody`
 *  preserves the ORIGINAL imported-STEP row's id verbatim (continuity for
 *  every id-keyed op/stock/folder reference), so a wrapped body's row id can
 *  be anything, not just `modelBodyEntryId`'s derived form. Undefined when no
 *  live CAM row exists yet for this body (an unsynced/never-regenerated body)
 *  -- callers must omit the nav affordance rather than dead-end on a stale
 *  id, per the WO's own "omitted, not disabled" rule. */
export function findModelBodyGeometryRow(
  geometry: readonly ImportedGeometry[],
  bodyId: string,
  modelItemId?: string,
): ImportedGeometry | undefined {
  const scope = itemScope(modelItemId)
  return geometry.find(
    (g) =>
      isModelBodyEntry(g) &&
      (g.modelBody!.ref.bodyId === bodyId || g.modelBody!.ref.lineageId === bodyId) &&
      itemScope(g.modelItemId) === scope,
  )
}

/** A live body as the Model workbench enumerates it: immutable id + display name.
 *  Order is the workbench's body order (drives the CAM list order for new cards). */
export interface LiveModelBody {
  bodyId: string
  /** Stable original-body identity. Omitted only by legacy/test callers, where
   *  the current leaf is also the lineage root. */
  lineageId?: string
  name: string
}

/** A body whose display payload was (re)derived THIS pass - the changed bodies
 *  (pass.executed) plus any live body that has no CAM entry yet. Carries the
 *  fresh tessellation + ElementMap identity handle. */
export interface DerivedModelBody {
  bodyId: string
  /** Same stable identity carried by the matching LiveModelBody. */
  lineageId?: string
  version: number
  stableIds: string[]
  display: ModelBodyDisplay
}

/** Reconciliation input: the FULL live body set (for delete/rename) + the subset
 *  freshly re-derived this pass (for update/add). Splitting them is what keeps
 *  the perf gate honest (G3): an edit re-derives only the changed body, yet the
 *  full `live` list still drives exhaustive delete reconciliation. */
export interface ModelBodySyncInput {
  live: LiveModelBody[]
  derived: DerivedModelBody[]
  // WO INT-17C Stage C1 CLOSURE (gap 2): which Model Item's bodies this sync
  // call is reconciling. Omitted = the legacy item (LEGACY_MODEL_ITEM_ID
  // above) -- every pre-closure caller omits it, and that is what makes
  // their behavior stay byte-identical: an omitted `modelItemId` on the
  // input matches an omitted `modelItemId` on every pre-existing legacy row
  // (see itemScope), so nothing about the single-item case changes shape.
  modelItemId?: string
  /**
   * WO-1413: rows a PRIOR reconcile for this same scope dropped
   * (`ModelBodyReconcileResult.removedRows`) that the CALLER HAS ALREADY
   * PROVEN belong to the live body they are keyed under, keyed by lineage id.
   * A live body with no CURRENT entry (this pass's ADD path) but a matching
   * entry here is built from THAT row via `buildModelBodyGeometry`'s `existing`
   * parameter -- the identical carry-forward an ordinary regen's UPDATE path
   * already gets -- instead of from a blank slate. Omitted or empty is
   * byte-identical to every pre-WO-1413 caller (the plain ADD path).
   *
   * THE PROOF IS THE CALLER'S, AND IT CANNOT BE MADE HERE. Nothing this
   * function can see distinguishes "the delete that dropped the row was
   * undone" from "a different feature was created and re-minted the freed
   * id": `nextId` hands out the LOWEST FREE feature id, a root feature's
   * lineage id IS its feature id, and stable ids are DERIVED NAMES
   * (`<featureId>:XTR:<sketchEntityId>:side` -- src/doc/stable-id.ts,
   * docs/stable-id-spec.md), not shape fingerprints, so re-extruding the same
   * sketch at a different depth reproduces the deleted body's id set exactly.
   * Two audits (2026-09-15) failed lineage-id matching and then stable-id
   * matching for precisely this reason. Only the model document's own command
   * history can answer it, and only the caller can see that history -- so this
   * map is a proven-identity handoff, never a candidate list to re-judge here.
   */
  recoverableRows?: ReadonlyMap<string, ImportedGeometry>
}

/**
 * The perf-critical selection (ruling 4 / G3): given the live body ids, the ids
 * that actually regenerated this pass (pass.executed), and the bodies that
 * already have a CAM entry, return the ids that must be (re)derived - the changed
 * bodies PLUS any live body that has no entry yet. A body that neither changed nor
 * lacks an entry keeps its persisted display and is NOT re-derived, so a
 * single-body edit re-derives exactly ONE body regardless of how many bodies are
 * live. THIS is the invariant the perf gate asserts (can-fail): the returned
 * length tracks the changed set, never the total body count.
 */
export function selectBodiesToDerive(
  liveBodyIds: string[],
  executedIds: string[],
  existingBodyIds: ReadonlySet<string>,
): string[] {
  const executed = new Set(executedIds)
  return liveBodyIds.filter((id) => executed.has(id) || !existingBodyIds.has(id))
}

export interface ModelBodyReconcileResult {
  geometry: ImportedGeometry[]
  /** bodyIds newly added as CAM entries this reconcile. */
  added: string[]
  /** bodyIds whose entry was updated (fresh display and/or rename). */
  updated: string[]
  /** bodyIds whose CAM entry was removed (body no longer live). */
  removed: string[]
  /** LIVE bodyIds that have NO existing entry AND no derived payload this pass -
   *  they cannot be drawn. Never expected in normal flow (the hook forces a
   *  re-derive for entry-less bodies); surfaced so the caller can fail LOUD
   *  rather than silently drop a body (charter rule 2). */
  missing: string[]
  /** GEO-UNIFY Stage 4 / INT-IMPORT-EDIT stage 1: the geo ids of pending STEP
   *  rows ADOPTED as this item's first body this pass (id preserved, format
   *  flipped to 'model', in-place). The store tears down the stale occt brep
   *  payload/mesh for each so the body does not draw twice. Empty on every
   *  ordinary sync. */
  adopted: string[]
  /** WO-1413: every row DROPPED this pass by the DELETE case, keyed by its own
   *  lineage id. A model-body row is the ONLY place a saved Section/projection
   *  snapshot (`layers2d`/`loops`/`sketches`/`loopsVersion`) lives, and this
   *  function's DELETE case is where it stops existing -- handing the dropped
   *  rows back lets the caller retain one for a body that may come back, so a
   *  delete undone at the Model document's own (CAM-undo-independent) history
   *  can rebuild from the body's own prior row. Empty on every pass with no
   *  deletions. See `ModelBodySyncInput.recoverableRows` for why only the
   *  caller may decide a returned row is recoverable. */
  removedRows: Map<string, ImportedGeometry>
}

function boundingBoxFromDisplay(display: ModelBodyDisplay): BoundingBox {
  const [minX, minY, minZ] = display.bbox.min
  const [maxX, maxY, maxZ] = display.bbox.max
  return {
    min: { x: minX, y: minY, z: minZ },
    max: { x: maxX, y: maxY, z: maxZ },
    size: { x: maxX - minX, y: maxY - minY, z: maxZ - minZ },
    center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 },
  }
}

/** Build a fresh model-backed ImportedGeometry from a derived body, preserving
 *  the user-facing display state (color / hidden) of a prior entry when one
 *  exists so a regen never resets the swatch or the visibility eye. Model
 *  vertices are native model-space coordinates (like addBrepModel, they are NOT
 *  recentred), so position/rotation stay identity.
 *
 *  `modelItemId` (CLOSURE gap 2, optional): the owning Model Item, threaded
 *  into both the scoped entry id (modelBodyEntryId) and the row's own
 *  `modelItemId` field. An EXISTING row's own `modelItemId` always wins over
 *  the caller's current scope (mirrors every other "preserve existing" field
 *  immediately below) -- ownership is set once, at creation, never silently
 *  reassigned by a later regen. The legacy scope writes `undefined` (omits
 *  the field), byte-identical to every pre-closure row. */
export function buildModelBodyGeometry(
  live: LiveModelBody,
  derived: DerivedModelBody,
  existing?: ImportedGeometry,
  modelItemId?: string,
): ImportedGeometry {
  const lineageId = live.lineageId ?? derived.lineageId ?? derived.bodyId
  const ref: ModelBodyRef = {
    bodyId: derived.bodyId,
    lineageId,
    stableIds: derived.stableIds,
    version: derived.version,
  }
  const modelBody: ModelBody = { ref, display: derived.display }
  const scope = itemScope(modelItemId)
  const ownerModelItemId = existing?.modelItemId ?? (scope === LEGACY_MODEL_ITEM_ID ? undefined : scope)
  return {
    id: existing?.id ?? modelBodyEntryId(lineageId, modelItemId),
    name: live.name,
    // Model bodies have no source file; the display name is the filename slot
    // too (the tree renames this field, mirroring the STEP import path).
    filename: live.name,
    type: 'model',
    format: 'model',
    boundingBox: boundingBoxFromDisplay(derived.display),
    faceCount: undefined,
    position: existing?.position ?? { x: 0, y: 0, z: 0 },
    rotation: existing?.rotation ?? { x: 0, y: 0, z: 0 },
    color: existing?.color,
    loaded: true,
    hidden: existing?.hidden,
    // Section/projection layers are point-in-time CAM snapshots. A model regen
    // refreshes the 3D body but must preserve those rows so their provenance
    // can be compared and warned, never silently delete them.
    ...(existing?.layers2d !== undefined ? { layers2d: existing.layers2d } : {}),
    ...(existing?.sketches !== undefined ? { sketches: existing.sketches } : {}),
    ...(existing?.loops !== undefined ? { loops: existing.loops } : {}),
    ...(existing?.loopsVersion !== undefined ? { loopsVersion: existing.loopsVersion } : {}),
    folderId: existing?.folderId,
    stockId: existing?.stockId,
    stockIdLocked: existing?.stockIdLocked,
    modelBody,
    ...(ownerModelItemId !== undefined ? { modelItemId: ownerModelItemId } : {}),
  }
}

/** GEO-UNIFY Stage 4 / INT-IMPORT-EDIT stage 1 (plan sec 2): ADOPT a wrapped
 *  STEP row as the Model Item's first body. Builds the model-backed row from
 *  the pending row via `buildModelBodyGeometry` -- which already preserves the
 *  row's id (the no-churn continuity that keeps every geometryId-based op
 *  parameter, stock membership and folder intact), plus its color/hidden/
 *  folder/stock fields -- then applies the two adoption-specific overrides the
 *  plan names:
 *   1. reset position/rotation to identity -- the world pose now lives in the
 *      item's whole-item Placement record (seeded at wrap time from the STEP
 *      row's OWN pose: the no-jump guarantee). A model row is native model-space
 *      coords + placement; buildModelBodyGeometry carried the STEP row's seated
 *      `position` forward via `existing?.position`, so it must be cleared here.
 *   2. carry the baked 2D projections/sections (layers2d + sketches + loops)
 *      forward -- point-in-time snapshot data (ADR-0011), geometrically
 *      identical since the same STEP bytes re-import, so existing 2D ops that
 *      reference them keep working across the wrap.
 *  `pendingModelItemId` is naturally CLEARED: buildModelBodyGeometry returns a
 *  fresh row from an explicit field list that never includes it. */
export function adoptStepRowAsModelBody(
  live: LiveModelBody,
  derived: DerivedModelBody,
  pendingRow: ImportedGeometry,
  modelItemId?: string,
): ImportedGeometry {
  const built = buildModelBodyGeometry(live, derived, pendingRow, modelItemId)
  return {
    ...built,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    ...(pendingRow.layers2d !== undefined ? { layers2d: pendingRow.layers2d } : {}),
    ...(pendingRow.sketches !== undefined ? { sketches: pendingRow.sketches } : {}),
    ...(pendingRow.loops !== undefined ? { loops: pendingRow.loops } : {}),
    ...(pendingRow.loopsVersion !== undefined ? { loopsVersion: pendingRow.loopsVersion } : {}),
  }
}

/** Rebuild an existing entry with a new NAME only (rename path) - display,
 *  handle, id and every user-facing field are byte-identical otherwise. */
function renameEntry(existing: ImportedGeometry, name: string): ImportedGeometry {
  return existing.name === name && existing.filename === name
    ? existing
    : { ...existing, name, filename: name }
}

/** Refresh the current leaf + stable lineage even when the tessellation did not
 *  need re-derivation. This is also the compatibility upgrade for a pre-fix row
 *  whose current leaf still matches but whose ref has no lineageId yet. */
function refreshEntryIdentity(existing: ImportedGeometry, live: LiveModelBody): ImportedGeometry {
  const lineageId = live.lineageId ?? live.bodyId
  const renamed = renameEntry(existing, live.name)
  const ref = renamed.modelBody!.ref
  if (ref.bodyId === live.bodyId && ref.lineageId === lineageId) return renamed
  return {
    ...renamed,
    modelBody: {
      ...renamed.modelBody!,
      ref: { ...ref, bodyId: live.bodyId, lineageId },
    },
  }
}

/**
 * The exhaustive reconciliation (B3): map the live body set + the freshly
 * re-derived subset onto the CAM geometry list, enumerating every path -
 *
 *   ADD    - a live body with no existing entry (must be in `derived`).
 *   UPDATE - a live body present in `derived` and already having an entry:
 *            replace display + handle in place, same id.
 *   RENAME - a live body NOT re-derived this pass whose name changed: name
 *            update only, same id and display.
 *   DELETE - an existing model entry whose body is no longer live: dropped, and
 *            its id returned so the caller tears the viewport mesh down loudly.
 *   KEEP   - a live body not re-derived and not renamed: byte-identical.
 *
 * Non-model geometry is preserved in place and in order. Existing model entries
 * keep their array position (no reorder churn); genuinely NEW bodies are
 * appended in live order after the existing entries.
 *
 * WO INT-17C Stage C1 CLOSURE (gap 2): scoped by `input.modelItemId`
 * (`itemScope`, defaults to the legacy item). A model row belonging to a
 * DIFFERENT item is now treated exactly like non-model geometry -- passed
 * through untouched, never reconciled against THIS call's `live`/`derived`
 * sets. Before this fix, every model row in `current` shared one flat,
 * item-blind bodyId namespace: syncing item B's bodies walked item A's rows
 * too, found A's bodyId absent from B's `live` list, and silently DELETED
 * them (`removed.push`) -- a live regression this function's own DELETE
 * case, read in isolation, could never reveal, because it looked identical
 * to "A's body was genuinely deleted". The preflight's own risk (census 1b)
 * named the bodyId-collision half of this hazard; the cross-item deletion
 * half is the sharper one this closure found by tracing the actual code.
 */
export function reconcileModelBodies(
  current: ImportedGeometry[],
  input: ModelBodySyncInput,
): ModelBodyReconcileResult {
  const scope = itemScope(input.modelItemId)
  const liveById = new Map(input.live.map((b) => [b.bodyId, b]))
  const liveByLineage = new Map(input.live.map((b) => [b.lineageId ?? b.bodyId, b]))
  const derivedById = new Map(input.derived.map((b) => [b.bodyId, b]))
  const matchedLiveBodyIds = new Set<string>()

  const added: string[] = []
  const updated: string[] = []
  const removed: string[] = []
  const missing: string[] = []
  const adopted: string[] = []
  const removedRows = new Map<string, ImportedGeometry>()

  // GEO-UNIFY Stage 4 / INT-IMPORT-EDIT stage 1: pending STEP rows wrapped as
  // THIS item and waiting to become its first body. Kept in array order; the
  // first genuinely-new body (pass 2 below) adopts the first pending row -- a
  // single-body wrap has exactly one of each. Scoped: a pending row wrapped for
  // a DIFFERENT item is never adopted here (it is a non-model row that passes
  // through pass 1 untouched, and its scope will not match this sync's).
  const pendingRows = current.filter(
    (g) => g.pendingModelItemId === scope && !isModelBodyEntry(g),
  )
  let pendingIdx = 0

  // Pass 1: walk the CURRENT array, preserving order. Non-model entries AND
  // model entries owned by a DIFFERENT item pass through untouched; only
  // model entries in THIS sync's own scope are updated/renamed/kept, or
  // dropped when their body is gone.
  const nextGeometry: ImportedGeometry[] = []
  for (const geo of current) {
    if (!isModelBodyEntry(geo) || itemScope(geo.modelItemId) !== scope) {
      nextGeometry.push(geo)
      continue
    }
    const ref = geo.modelBody!.ref
    const bodyId = ref.bodyId
    const live =
      (ref.lineageId !== undefined ? liveByLineage.get(ref.lineageId) : undefined) ??
      liveById.get(bodyId)
    if (live === undefined) {
      removed.push(bodyId)
      // WO-1413: the row (and the saved Section it alone carries) stops
      // existing here. Hand it back so the caller can retain it against the
      // body coming back -- see removedRows' own doc comment.
      removedRows.set(ref.lineageId ?? bodyId, geo)
      continue
    }
    matchedLiveBodyIds.add(live.bodyId)
    const derived = derivedById.get(live.bodyId)
    if (derived !== undefined) {
      nextGeometry.push(buildModelBodyGeometry(live, derived, geo, input.modelItemId))
      updated.push(live.bodyId)
    } else {
      const refreshed = refreshEntryIdentity(geo, live)
      nextGeometry.push(refreshed)
      if (refreshed !== geo) updated.push(live.bodyId)
    }
  }

  // Pass 2: append genuinely new bodies in live order (an existing entry
  // WITHIN THIS SCOPE was handled in pass 1; a live body with no entry in
  // THIS scope is an ADD -- even if a DIFFERENT item already owns an entry
  // for the same raw bodyId string -- or, if it also has no derived
  // payload, a MISSING - it cannot be drawn).
  for (const live of input.live) {
    if (matchedLiveBodyIds.has(live.bodyId)) continue
    const derived = derivedById.get(live.bodyId)
    if (derived === undefined) {
      missing.push(live.bodyId)
      continue
    }
    // GEO-UNIFY Stage 4: a wrapped STEP row waiting to be adopted as this
    // item's first body is REPLACED in place (its array slot, set in pass 1
    // when it passed through as a non-model row, is overwritten) so its tree
    // position + id survive the flip to format:'model'. No pending row (or all
    // already claimed) -> an ordinary appended ADD, exactly as before.
    const pendingRow = pendingRows[pendingIdx]
    if (pendingRow !== undefined) {
      pendingIdx += 1
      const adoptedRow = adoptStepRowAsModelBody(live, derived, pendingRow, input.modelItemId)
      const slot = nextGeometry.findIndex((g) => g.id === pendingRow.id)
      if (slot >= 0) nextGeometry[slot] = adoptedRow
      else nextGeometry.push(adoptedRow)
      added.push(live.bodyId)
      adopted.push(pendingRow.id)
      continue
    }
    // WO-1413: a live body with no CURRENT entry may still have a row the
    // caller retained for it and PROVED is its own (recoverableRows' doc
    // comment states the proof obligation and why it cannot be made here).
    // Building from that row carries its Section/projection snapshot -- and
    // color/hidden/folder/stock, exactly like an ordinary UPDATE -- instead of
    // starting from nothing. No entry: the plain ADD row, unchanged.
    const recovered = input.recoverableRows?.get(live.lineageId ?? live.bodyId)
    nextGeometry.push(buildModelBodyGeometry(live, derived, recovered, input.modelItemId))
    added.push(live.bodyId)
  }

  return { geometry: nextGeometry, added, updated, removed, missing, adopted, removedRows }
}

export interface ModelBodyLineageIndex {
  modelItemId?: string
  /** Historical and current body feature id -> stable lineage root. */
  lineageByBodyId: ReadonlyMap<string, string>
}

export interface ModelBodyBindingRepair {
  setupId: string
  operationId: string
  fromGeometryId: string
  toGeometryId: string
  lineageId: string
}

function bodyIdFromModelBodyEntryId(id: string, scope: string): string | undefined {
  if (scope !== LEGACY_MODEL_ITEM_ID) {
    const prefix = `modelbody:${scope}:`
    return id.startsWith(prefix) && id.length > prefix.length
      ? id.slice(prefix.length)
      : undefined
  }

  const explicitLegacyPrefix = `modelbody:${LEGACY_MODEL_ITEM_ID}:`
  if (id.startsWith(explicitLegacyPrefix) && id.length > explicitLegacyPrefix.length) {
    return id.slice(explicitLegacyPrefix.length)
  }
  const legacyPrefix = 'modelbody:'
  if (!id.startsWith(legacyPrefix) || id.length === legacyPrefix.length) return undefined
  const bodyId = id.slice(legacyPrefix.length)
  // A scoped row belongs to a model item, never to the legacy document.
  return bodyId.includes(':') ? undefined : bodyId
}

/** BUG-AC-FRAME-2026-08-01: repair projects saved after the old leaf-keyed
 *  reconciler had already churned a modeled-body row id. The embedded model
 *  document supplies the only authoritative old-leaf -> lineage mapping, so a
 *  dangling operation is remapped only when its historical leaf and exactly
 *  one surviving row resolve to the same item-scoped lineage. Ambiguous or
 *  unrecognized ids stay untouched for the dispatch-time fail-loud backstop.
 *
 * The same pass backfills ref.lineageId on surviving pre-fix rows. Pure: callers
 * provide already-decoded lineage indexes; no document/store dependency lives
 * in this adapter. */
export function repairDanglingModelBodyBindings(
  project: Project,
  indexes: readonly ModelBodyLineageIndex[],
): { project: Project; repairs: ModelBodyBindingRepair[] } {
  const indexByScope = new Map(indexes.map((entry) => [itemScope(entry.modelItemId), entry.lineageByBodyId]))
  const targetByScopeAndLineage = new Map<string, ImportedGeometry | null>()
  let geometryChanged = false
  const geometry = project.geometry.map((geo) => {
    if (!isModelBodyEntry(geo)) return geo
    const scope = itemScope(geo.modelItemId)
    const lineageId = geo.modelBody!.ref.lineageId ?? indexByScope.get(scope)?.get(geo.modelBody!.ref.bodyId)
    if (lineageId === undefined) return geo
    const candidate = geo.modelBody!.ref.lineageId === lineageId
      ? geo
      : {
          ...geo,
          modelBody: {
            ...geo.modelBody!,
            ref: { ...geo.modelBody!.ref, lineageId },
          },
        }
    if (candidate !== geo) geometryChanged = true
    const key = `${scope}\u0000${lineageId}`
    targetByScopeAndLineage.set(key, targetByScopeAndLineage.has(key) ? null : candidate)
    return candidate
  })

  const liveGeometryIds = new Set(geometry.map((geo) => geo.id))
  const repairs: ModelBodyBindingRepair[] = []
  let setupsChanged = false
  const setups = project.setups.map((setup) => {
    let setupChanged = false
    const operations = setup.operations.map((operation) => {
      const geometryId = operation.params?.geometryId
      if (typeof geometryId !== 'string' || liveGeometryIds.has(geometryId)) return operation

      let match: { target: ImportedGeometry; lineageId: string } | undefined
      for (const [scope, lineageByBodyId] of indexByScope) {
        const historicalBodyId = bodyIdFromModelBodyEntryId(geometryId, scope)
        if (historicalBodyId === undefined) continue
        const lineageId = lineageByBodyId.get(historicalBodyId)
        if (lineageId === undefined) continue
        const target = targetByScopeAndLineage.get(`${scope}\u0000${lineageId}`)
        if (target === undefined || target === null) continue
        if (match !== undefined && match.target.id !== target.id) {
          match = undefined
          break
        }
        match = { target, lineageId }
      }
      if (match === undefined) return operation

      const {
        computeTimeMs: _computeTimeMs,
        estimatedCutTimeMs: _estimatedCutTimeMs,
        estimatedCutTimeMsError: _estimatedCutTimeMsError,
        progress: _progress,
        progressPhase: _progressPhase,
        generationFingerprint: _generationFingerprint,
        errorMessage: _errorMessage,
        ...rest
      } = operation
      void _computeTimeMs
      void _estimatedCutTimeMs
      void _estimatedCutTimeMsError
      void _progress
      void _progressPhase
      void _generationFingerprint
      void _errorMessage
      setupChanged = true
      setupsChanged = true
      repairs.push({
        setupId: setup.id,
        operationId: operation.id,
        fromGeometryId: geometryId,
        toGeometryId: match.target.id,
        lineageId: match.lineageId,
      })
      return {
        ...rest,
        status: 'outdated' as const,
        params: { ...operation.params, geometryId: match.target.id },
        modelReferenceNote:
          'This modeled-body binding was repaired after the model history changed - regenerate before posting.',
      }
    })
    return setupChanged ? { ...setup, operations } : setup
  })

  if (!geometryChanged && !setupsChanged) return { project, repairs }
  return {
    project: {
      ...project,
      ...(geometryChanged ? { geometry } : {}),
      ...(setupsChanged ? { setups } : {}),
    },
    repairs,
  }
}
