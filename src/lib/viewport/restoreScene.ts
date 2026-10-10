// Shared scene-restore for every project-level reload path.
//
// B2 (docs/planning/POST-MERGE-WORKPLAN.md): the geometry-restore logic used
// to live only inside Viewport.tsx as a useCallback, reachable through React
// effects keyed on project.id (File > Open) or viewportRefreshTrigger (undo /
// sketch bake). Re-opening a .camproject whose id matched the current project
// (save -> reload page -> open it back) never fired the id-keyed effect, so
// the scene stayed stale; and even id-changing opens skipped the stock
// rebuild. Extracting the restore here lets the store's loadProjectFromFile
// action drive the SAME full rebuild the page-refresh and undo paths perform,
// unconditionally.
//
// This module must not import the store (the store imports it) - store-side
// actions are passed in via RestoreSceneHooks.

import { loadCachedSTL } from '../stlCache'
import * as stepCache from '../stepCache'
import { readStep, setBrepPayload } from '../cam/geometry/occt/model/modelClient'
import { validateBrepModelPayload } from '../projectBinaries'
import { deflectionForQuality } from '../cam/geometry/occt/model/quality'
import { load2DGeometry } from '../geometry2dCache'
import { loadCachedModelBodyDisplay } from '../modelBodyDisplayCache'
import type { ImportedGeometry, PhysicalStock, SceneStock, NestRecord, ModelBodyDisplay } from '../../types'
import type { BrepModelPayload } from '../cam/geometry/occt/model/types'
import { resolveNestSourceLoops } from './nestSources'
import { seedPlacementIds, nestOwnedGeometryIds, visibleSeedLoops } from '../cam/nesting/seedSelectors'
// Coordinate hierarchy Phase 4 - Item 1: route part PLACEMENT reads through the
// single world-transform seam. Identity under Option 1 (snapshot-identical),
// but it is the one site a workspace tier / stored-relative transform composes.
import { partWorldTransform } from '../../store/partTransform'
import { useCamStore } from '../../store'
import {
  LEGACY_MODEL_ITEM_ID,
  peekDurableDocumentRevision,
  hydrateDocumentCheckpoint,
  stashLoadedDocument,
} from '../../doc/documentHolder'
import { resolveModelReferenceFrame } from '../cam/modelReferenceFrame'

/**
 * Read the user's B-rep render fidelity from the live store and resolve it to a
 * BRepMesh deflection for reloaded STEP parts. Store access is RUNTIME-only here
 * (called inside the async reload, never at module-eval time) so the static
 * `../../store` import does not invert the store -> restoreScene load order; the
 * binding is fully initialized by the time this runs. Defensive: any failure
 * (store double in a unit test, undefined setting) returns undefined so readStep
 * falls back to the kernel's built-in tessellation defaults.
 */
function resolveBrepDeflection(): { linearDeflection: number; angularDeflection: number } | undefined {
  try {
    const q = useCamStore.getState().appSettings?.brepTessellationQuality
    return q ? deflectionForQuality(q) : undefined
  } catch {
    return undefined
  }
}

/** WO INT-17C Stage C2: same RUNTIME-only, defensive store-read idiom as
 *  `resolveBrepDeflection` immediately above (this module's own header
 *  comment explains why: a static top-level store import would invert the
 *  store -> restoreScene load order, but a call INSIDE a function body,
 *  never at module-eval time, is safe). Reading `Project.modelItemPlacements`
 *  live here -- instead of threading it through every caller of
 *  `restoreGeometryToViewport` as a new parameter -- keeps every existing
 *  call site (tests included) byte-identical in shape; only the model-row
 *  draw BEHAVIOR changes, exactly as the Placement Composition Contract's
 *  invariant 5 promises ("every consumer wired against the function
 *  signature needs zero code changes; only the function's internals
 *  change"), one layer up from `resolveModelItemPlacement` itself. Any
 *  failure (a pure fixture / unit test with no live store) degrades to an
 *  empty registry, which `resolveModelItemPlacement` then refuses loud for
 *  -- never a silent identity substitution.
 */
function liveModelItemPlacements(): readonly { modelItemId: string; bodyId?: string; position: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number } }[] {
  try {
    return useCamStore.getState().project.modelItemPlacements ?? []
  } catch {
    return []
  }
}

/**
 * WO-353: detect a PARTIAL WRITE across an edit's three independent
 * persistence layers (docs/research/model-edit-refresh-gap.md section 3) --
 * the general store's cached `item.documentRevision` (layer a) disagreeing
 * with what the document checkpoint actually wrote durably (layer b) -- and
 * recover it, rather than let a boot silently trust a mesh that may be
 * self-consistently stale (section 5's "silently reverted" danger: layer a's
 * `ref.version` and layer c's display cache CAN agree with each other while
 * both are behind the document the user actually last edited).
 *
 * BOOT-ONLY (WO-353 audit fix). This function must only run for a restore
 * that follows a real reachability gap in `project.modelItems[].documentRevision`
 * -- a fresh page load or a File>Open, where the JS heap (and this module's
 * own documentHolder state) was just rebuilt from possibly-desynced storage.
 * The caller, `restoreGeometryToViewport`'s `checkDocumentConsistency` flag,
 * is what scopes that: it must stay `false` for the undo/redo and sketch-bake
 * rebuild (`Viewport.tsx`'s `viewportRefreshTrigger` effect), because on THAT
 * path `item.documentRevision` legitimately lags the current durable revision
 * for an unrelated reason -- undo/redo restores an OLDER `project` snapshot
 * wholesale (`store/index.ts`'s `restoreSketchFromHistorySeam`), and that
 * snapshot's cached revision can predate a later edit's autosave flush with no
 * write ever having been lost. Reading that as a partial write blanked the
 * model, overwrote the revision undo had just restored, and stashed the
 * pre-undo document -- see this WO's audit section.
 *
 * Cheap in the ordinary (consistent) case: one revision-only read
 * (`peekDurableDocumentRevision`, no decode) per Model Item, memoized by the
 * caller across every body row that item owns -- never per body, and never a
 * full hydrate unless a mismatch is actually found.
 *
 * On a mismatch: reconciles the store's cached revision to the durable
 * truth (`recordModelItemDocumentCheckpoint`, the same action
 * `openModelItem`/`flushModelItemDocument` already use) and pre-stashes the
 * recovered document (`stashLoadedDocument`) so the NEXT Model-workspace
 * mount regenerates from the right generation automatically -- the "boot
 * path... falls back to a full in-session regeneration automatically"
 * the WO asks for, without ever silently drawing a mesh this function cannot
 * prove is current. Named and loud either way (console.warn on recovery,
 * console.error on a genuinely unrecoverable document) -- never silent.
 *
 * Returns false only when a real mismatch was found (the caller must not
 * trust this item's cached/row-carried display this pass). Returns true for
 * the ordinary consistent case AND for an item with nothing durable to
 * compare yet -- neither is a defect. Never throws: this runs on the render
 * path, not the navigation path, so a genuinely unrecoverable document stays
 * loud (console.error) but degrades to "not trusted", never a crash -- the
 * same fail-soft contract already governing every other branch below.
 */
async function checkModelItemDocumentConsistency(
  projectId: string,
  modelItemId: string,
): Promise<boolean> {
  let item: { documentState?: string; documentStorageKey?: string; documentRevision?: number } | undefined
  try {
    item = useCamStore.getState().project.modelItems?.find((m) => m.id === modelItemId)
  } catch {
    return true
  }
  if (
    !item ||
    item.documentState !== 'authored' ||
    !item.documentStorageKey ||
    item.documentRevision === undefined
  ) {
    return true
  }
  let durableRevision: number | undefined
  try {
    durableRevision = await peekDurableDocumentRevision(projectId, modelItemId)
  } catch {
    return true
  }
  if (durableRevision === undefined || durableRevision === item.documentRevision) return true
  try {
    const checkpoint = await hydrateDocumentCheckpoint(
      projectId, modelItemId, item.documentStorageKey, item.documentRevision,
    )
    stashLoadedDocument(checkpoint.bytes, modelItemId)
    useCamStore.getState().recordModelItemDocumentCheckpoint(modelItemId, checkpoint.revision)
    console.warn(
      `WO-353: Model Item "${modelItemId}" had a partial write across reload -- the cached ` +
        `document revision (${item.documentRevision}) did not match what was actually durable ` +
        `(${checkpoint.revision}). Recovered the durable checkpoint; this item's modeled bodies ` +
        'will re-derive their display the next time the Part workspace regenerates rather than ' +
        'trusting a possibly stale cached mesh.',
    )
  } catch (err) {
    console.error(
      `WO-353: Model Item "${modelItemId}"'s document could not be reconciled at boot (` +
        `${err instanceof Error ? err.message : String(err)}); its cached mesh will not be trusted ` +
        'until the Model workspace is opened directly.',
    )
  }
  return false
}

type Vec3Like = { x: number; y: number; z: number }
type LoopLike = {
  id: string
  points: Array<{ x: number; y: number }>
  closed: boolean
  layerId: string
}
type LayerLike = {
  id: string
  color: string
  visible: boolean
  projectionPlane?: { origin: Vec3Like; xAxis: Vec3Like; yAxis: Vec3Like }
}

/** Store actions the restore needs (passed in to avoid a store import cycle). */
export interface RestoreSceneHooks {
  patchGeometry: (
    id: string,
    // INT-17A-R1 C1: `modelBody` joins the patchable set so a display payload
    // recovered from the durable cache is written BACK onto the entry. Without
    // that, the mesh would be drawn but the store row would stay half-hydrated -
    // and a subsequent .camproject save would write an entry with no display.
    updates: Partial<Pick<ImportedGeometry, 'hidden' | 'projectionTolerance' | 'boundingBox' | 'modelBody'>>,
  ) => void
  setBrepImportError: (msg: string | null) => void
}

/** The CNCViewport surface the restore touches (structural, so tests can bind
 *  real prototype methods onto a minimal instance - typedZTransform pattern). */
export interface RestoreViewport {
  addSTL: (
    buffer: ArrayBuffer, id: string, name: string,
    position?: Vec3Like, rotation?: Vec3Like, color?: string,
  ) => Promise<{ min: Vec3Like; max: Vec3Like }>
  setSTLVisible: (id: string, visible: boolean) => void
  setPartLoopsOnFacePlane: (geoId: string, loops: LoopLike[], layers: LayerLike[]) => void
  setPartProjectedLoops: (partId: string, loops: LoopLike[], layers: LayerLike[]) => void
  addBrepModel: (
    id: string, payload: BrepModelPayload, name: string,
    position?: Vec3Like, rotation?: Vec3Like, color?: string,
  ) => void
  // INT-17A Stage 1: draw a Model-workbench body from its PERSISTED tessellation
  // (ModelBodyDisplay). This is the reload path that makes a model card draw with
  // the Part tab never (re)visited (B2a / CAN-FAIL-CASE 1) - no kernel, no regen.
  addModelBody: (
    id: string, display: ModelBodyDisplay, name: string,
    position?: Vec3Like, rotation?: Vec3Like, color?: string,
  ) => void
  add2DGeometry: (
    id: string, loops: LoopLike[], layers: LayerLike[],
    position?: Vec3Like, rotation?: Vec3Like,
  ) => void
  // Instanced nest render (ADR 0024, P3.2). Optional so existing test doubles
  // and any minimal RestoreViewport binding stay valid; absent => nests skip.
  // seedInstanceIds + seedSourcesById drive the refined seed-slot render (ADR
  // 0025 §2): the lower-left placement per source is coloured with the LIVE
  // source's per-layer colors and gets a --vp-seed outline.
  addNestInstances?: (
    nestId: string,
    sheet: { width: number; height: number },
    placements: Array<{ partId: string; instanceId: string; x: number; y: number; rotationDeg: number; depth: number }>,
    sourceLoopsById: Map<string, Array<{ points: Array<{ x: number; y: number }> }>>,
    seedInstanceIds?: Set<string>,
    seedSourcesById?: Map<string, {
      loops: Array<{ points: Array<{ x: number; y: number }>; layerId: string }>
      layers: Array<{ id: string; color: string; visible: boolean }>
    }>,
  ) => void
  setNestVisible?: (nestId: string, visible: boolean) => void
  /** Position the nest render group at its world origin (D3 move-coupling). The
   *  sheet + placements are group-relative, so this single move rides them all.
   *  Optional so minimal bindings / test doubles stay valid. */
  setNestGroupPosition?: (nestId: string, x: number, y: number) => void
}

/** Full-reload surface: what a project-level reload (File > Open) drives. */
export interface ReloadableViewport extends RestoreViewport {
  clearScene: () => void
  rebuildStock: (config?: SceneStock) => void
}

/** Restore a STEP part from its selection-capable display cache when valid. The
 *  raw STEP + worker path remains the exact fallback for legacy/corrupt caches
 *  and the source of truth for later kernel derivations (ADR 0018 D2). */
async function restoreBrepPart(
  vp: RestoreViewport,
  geo: ImportedGeometry,
  worldPos: Vec3Like,
  worldRot: Vec3Like,
  hooks: RestoreSceneHooks,
  isCurrent: () => boolean,
): Promise<void> {
  try {
    const displayPromise = (async () => {
      try {
        return typeof stepCache.loadCachedStepDisplay === 'function'
          ? await stepCache.loadCachedStepDisplay(geo.id)
          : null
      } catch {
        return null
      }
    })()
    const [bytes, displayRecord] = await Promise.all([
      stepCache.loadCachedStep(geo.id), displayPromise,
    ])
    if (!isCurrent()) return
    if (!bytes) {
      const msg = `B-rep reload failed for "${geo.name}" (${geo.filename}): `
        + 'cached STEP bytes are missing from IndexedDB. Re-import the file.'
      console.error(msg)
      hooks.setBrepImportError(msg)
      return
    }
    const sourceSha256 = typeof stepCache.computeStepSha256 === 'function'
      ? await stepCache.computeStepSha256(bytes)
      : null
    if (!isCurrent()) return
    const cachedDisplay = displayRecord
      && displayRecord.displayContractVersion === stepCache.STEP_DISPLAY_CONTRACT_VERSION
      && sourceSha256 !== null
      && displayRecord.sourceSha256 === sourceSha256
      ? validateBrepModelPayload(displayRecord.payload)
      : null
    if (cachedDisplay && sourceSha256) {
      const hadReusableAo = cachedDisplay.mesh.ao !== undefined
      vp.addBrepModel(geo.id, cachedDisplay, geo.name, worldPos, worldRot, geo.color)
      if (geo.hidden) vp.setSTLVisible(geo.id, false)
      setBrepPayload(geo.id, cachedDisplay, {
        displayContractVersion: stepCache.STEP_DISPLAY_CONTRACT_VERSION,
        sourceSha256,
        tessellation: displayRecord!.tessellation,
      })
      // Old display records remain compatible: addBrepModel performs the one
      // legacy AO bake and attaches it to this same payload. Upgrade the cache
      // after draw so the next open installs AO without any raycasts.
      if (!hadReusableAo && cachedDisplay.mesh.ao
        && typeof stepCache.cacheStepDisplay === 'function') {
        void stepCache.cacheStepDisplay(
          geo.id, cachedDisplay, sourceSha256, displayRecord!.tessellation,
        ).catch((err) => {
          console.warn(`STEP display AO cache upgrade failed for "${geo.name}":`, err)
        })
      }
      return
    }
    // Re-tessellate at the user's current render-fidelity so reopened projects
    // (and a live Settings quality change) honor the choice (same source as
    // import). Read the live store lazily at call-time (NOT a module-level store
    // import, which would invert the store->restoreScene dependency); defensive
    // so a test double or an uninitialized store falls back to kernel defaults.
    const tess = resolveBrepDeflection()
    const payload = await readStep(geo.id, bytes, geo.filename, undefined, tess)
    if (!isCurrent()) return
    vp.addBrepModel(geo.id, payload, geo.name, worldPos, worldRot, geo.color)
    if (geo.hidden) vp.setSTLVisible(geo.id, false)
    setBrepPayload(geo.id, payload)
    if (sourceSha256 && typeof stepCache.cacheStepDisplay === 'function') {
      void stepCache.cacheStepDisplay(geo.id, payload, sourceSha256, tess ?? null).catch((err) => {
        console.warn(`STEP display cache write failed for "${geo.name}":`, err)
      })
    }
  } catch (err) {
    if (!isCurrent()) return
    const msg = `B-rep reload failed for "${geo.name}": ${
      err instanceof Error ? err.message : String(err)}`
    console.error(msg)
    hooks.setBrepImportError(msg)
  }
}

/** Live re-tessellation of every ALREADY-LOADED B-rep (STEP) part at the store's
 *  current `brepTessellationQuality` (F3). Mirrors the reload path exactly
 *  (restoreBrepPart -> readStep + addBrepModel), so per-part world placement,
 *  color, and hidden state are preserved (addBrepModel REPLACES the same-id group
 *  in place; the id-keyed selection survives). STL parts are untouched. No-op when
 *  no B-rep parts are loaded.
 *
 *  Stale-result guard: the caller passes an `isCurrent` predicate that returns
 *  false once a NEWER quality change has superseded this run. Each part is checked
 *  AFTER its async worker round-trip and the result is dropped (the part is NOT
 *  re-attached) when superseded, so a fast tier flip never leaves stale geometry. */
export async function retessellateBrepParts(
  vp: RestoreViewport,
  geometry: ImportedGeometry[],
  hooks: RestoreSceneHooks,
  stocks: ReadonlyArray<PhysicalStock> = [],
  ownedSeedIds: ReadonlySet<string> = new Set(),
  isCurrent: () => boolean = () => true,
): Promise<void> {
  for (const geo of geometry) {
    if (geo.format !== 'step') continue          // B-rep only; STL/2D untouched
    if (ownedSeedIds.has(geo.id)) continue        // nest-owned source: rendered only in the nest
    if (!isCurrent()) return                       // superseded before this part started
    const { position: worldPos, rotation: worldRot } = partWorldTransform(geo, stocks)
    const tess = resolveBrepDeflection()
    try {
      const bytes = await stepCache.loadCachedStep(geo.id)
      if (!bytes) {
        const msg = `B-rep re-tessellation failed for "${geo.name}" (${geo.filename}): `
          + 'cached STEP bytes are missing from IndexedDB. Re-import the file.'
        console.error(msg)
        hooks.setBrepImportError(msg)
        continue
      }
      const sourceSha256 = typeof stepCache.computeStepSha256 === 'function'
        ? await stepCache.computeStepSha256(bytes)
        : null
      const payload = await readStep(geo.id, bytes, geo.filename, undefined, tess)
      // Drop a superseded result rather than swapping in now-stale geometry.
      if (!isCurrent()) return
      vp.addBrepModel(geo.id, payload, geo.name, worldPos, worldRot, geo.color)
      if (geo.hidden) vp.setSTLVisible(geo.id, false)
      setBrepPayload(geo.id, payload)
      if (sourceSha256 && typeof stepCache.cacheStepDisplay === 'function') {
        void stepCache.cacheStepDisplay(geo.id, payload, sourceSha256, tess ?? null).catch((err) => {
          console.warn(`STEP display cache write failed for "${geo.name}":`, err)
        })
      }
    } catch (err) {
      if (!isCurrent()) return
      const msg = `B-rep re-tessellation failed for "${geo.name}": ${
        err instanceof Error ? err.message : String(err)}`
      console.error(msg)
      hooks.setBrepImportError(msg)
    }
  }
}

/** Restore a project's geometry list into the viewport (caches -> scene).
 *  Body moved verbatim from Viewport.tsx restoreGeometry (B2).
 *
 *  Phase 4 Item 1: part placement is derived via `partWorldTransform` (the
 *  single world-transform seam) rather than reading `geo.position` /
 *  `geo.rotation` ad-hoc. `stocks` is the future compose context; under
 *  Option 1 the seam is the identity, so omitting it is snapshot-identical. */
export async function restoreGeometryToViewport(
  vp: RestoreViewport,
  geometry: ImportedGeometry[],
  hooks: RestoreSceneHooks,
  stocks: ReadonlyArray<PhysicalStock> = [],
  // Geometry ids that are a nest's integrated seed copy (ownerNestId set). These
  // copies live ONLY inside the nest render (seed slot + copies), so they must
  // NOT also render as a standalone part (deep-copy seed model, ADR 0025 §2).
  // Pre-existing workspace geometry (ownerNestId undefined) is absent from this
  // set and still renders standalone. Empty/omitted => render everything.
  ownedSeedIds: ReadonlySet<string> = new Set(),
  // INT-17A-R2 C2: the open Project.id, which SCOPES the durable model-body
  // display lookup. Entry ids are `modelbody:<bodyId>` and bodyIds restart at F1
  // in every project, so without it project B could restore project A's
  // tessellation. OPTIONAL and fail-closed: a caller that cannot name the
  // project (a pure fixture) simply gets no cache recovery and the ordinary
  // re-derive path, rather than an unscoped read.
  projectId?: string,
  isCurrent: () => boolean = () => true,
  // WO-353 audit fix: BOOT-ONLY gate for the cross-layer document-consistency
  // check below. `true` (the default) is correct for every reload that
  // rebuilds this module's caller from possibly-desynced storage -- a fresh
  // page load and File>Open/New Project (`reloadProjectScene`'s only two
  // callers, store/index.ts). It must be explicitly `false` for the
  // undo/redo and sketch-bake rebuild (Viewport.tsx's `viewportRefreshTrigger`
  // effect): that path restores an OLDER in-memory `project` snapshot whose
  // cached `documentRevision` can legitimately lag the current durable
  // revision with no write ever lost, and the check has no way to tell that
  // apart from a real partial write -- see checkModelItemDocumentConsistency's
  // own doc comment above.
  checkDocumentConsistency: boolean = true,
): Promise<void> {
  // WO-353: per-call memo so every body row under the SAME Model Item shares
  // one consistency check rather than re-deriving it (and re-reading durable
  // storage) once per body.
  const modelItemTrust = new Map<string, Promise<boolean>>()
  const isModelItemDocumentTrustworthy = (modelItemId: string): Promise<boolean> => {
    if (projectId === undefined || !checkDocumentConsistency) return Promise.resolve(true)
    let pending = modelItemTrust.get(modelItemId)
    if (!pending) {
      pending = checkModelItemDocumentConsistency(projectId, modelItemId)
      modelItemTrust.set(modelItemId, pending)
    }
    return pending
  }
  for (const geo of geometry) {
    if (!isCurrent()) return
    if (ownedSeedIds.has(geo.id)) continue   // nest-owned source: rendered only in the nest
    const { position: worldPos, rotation: worldRot } = partWorldTransform(geo, stocks)
    if (geo.format === 'stl') {
      try {
        const buffer = await loadCachedSTL(geo.id)
        if (buffer) {
          if (!isCurrent()) return
          const bb = await vp.addSTL(buffer, geo.id, geo.name, worldPos, worldRot, geo.color)
          if (!isCurrent()) return
          if (geo.hidden) vp.setSTLVisible(geo.id, false)
          // Heal legacy zero bounding boxes (STL imports before H1-B never
          // persisted one): the auto-stock derivation and model_top/bottom
          // height modes need the real local bbox. One-time per project.
          const bbZero = geo.boundingBox.min.x === geo.boundingBox.max.x
            && geo.boundingBox.min.y === geo.boundingBox.max.y
            && geo.boundingBox.min.z === geo.boundingBox.max.z
          if (bb && bbZero) {
            hooks.patchGeometry(geo.id, {
              boundingBox: {
                min: bb.min, max: bb.max,
                size: { x: bb.max.x - bb.min.x, y: bb.max.y - bb.min.y, z: bb.max.z - bb.min.z },
                center: {
                  x: (bb.min.x + bb.max.x) / 2,
                  y: (bb.min.y + bb.max.y) / 2,
                  z: (bb.min.z + bb.max.z) / 2,
                },
              },
            })
          }
        }
      } catch { /* cache miss - part stays unloaded */ }
      // Restore projected loops in correct space (world-plane vs local)
      const layers = geo.layers2d ?? []
      const loops  = geo.loops ?? []
      if (!isCurrent()) return
      if (loops.length > 0) {
        const worldLayerIds = new Set(layers.filter(l => l.projectionPlane).map(l => l.id))
        const worldLoops = loops.filter(l => worldLayerIds.has(l.layerId))
        const localLoops = loops.filter(l => !worldLayerIds.has(l.layerId))
        if (worldLoops.length > 0) vp.setPartLoopsOnFacePlane(geo.id, worldLoops, layers)
        if (localLoops.length > 0) vp.setPartProjectedLoops(geo.id, localLoops, layers.filter(l => !l.projectionPlane))
      }
    } else if (geo.format === 'step') {
      await restoreBrepPart(vp, geo, worldPos, worldRot, hooks, isCurrent)
    } else if (geo.format === 'model') {
      // INT-17A Stage 1 (B2a): a modeled body draws from the tessellation
      // persisted directly on the entry - NO kernel, NO regen, NO Part-tab mount.
      // This is exactly the reload-into-CAM path where the Model workspace was
      // never (re)visited (CAN-FAIL-CASE 1). A malformed/absent payload is a loud
      // skip, not a crash that takes down the whole scene restore.
      if (!geo.modelBody) {
        console.error(
          `INT-17A: model geometry "${geo.name}" (${geo.id}) has no modelBody handle at all; ` +
            `its card will not draw. This is a defect - a model entry must always carry modelBody.`,
        )
      } else {
        const modelItemId = geo.modelItemId ?? LEGACY_MODEL_ITEM_ID
        // WO-353: a Model Item whose cached document revision does not match
        // what is actually durable had a partial write across this reload --
        // neither the row's own display nor the version-scoped display cache
        // can be trusted to be CURRENT, only to be self-consistent (section 5's
        // "silently reverted" danger). Recovered rather than trusted: fall
        // through to the same "undrawn, will regen" path an ordinary cache
        // miss already takes, never draw a mesh this pass cannot vouch for.
        const documentTrustworthy = await isModelItemDocumentTrustworthy(modelItemId)
        if (!isCurrent()) return
        // INT-17A-R1 C1: display absent = a localStorage-refresh rehydrate (it is
        // stripped there for quota). Round 1 skipped here and waited for the Part
        // tab to remount, which broke B2a on the refresh axis (audit finding 1).
        // Recover it from the durable IndexedDB cache instead - the SAME move the
        // stl/step/2d branches above make, in the same await loop, with no Part
        // tab, no Model kernel and no regen pass.
        let display = documentTrustworthy ? geo.modelBody.display : undefined
        if (!display && projectId !== undefined && documentTrustworthy) {
          // INT-17A-R2 C2: the lookup carries the identity the payload must have
          // been derived from - this project, this entry, this bodyId, at THIS
          // ref.version. R1 asked only for the entry id, so a body re-derived
          // since the cache was written restored its OLD tessellation onto the
          // NEW ref, and a different project reusing `modelbody:F1` restored the
          // wrong body outright. A mismatch is a named miss (below), never a
          // silently wrong shape.
          display = (await loadCachedModelBodyDisplay({
            projectId,
            geometryId: geo.id,
            bodyId: geo.modelBody.ref.bodyId,
            version: geo.modelBody.ref.version,
          }).catch(() => null)) ?? undefined
          if (!isCurrent()) return
        }
        if (display && display !== geo.modelBody.display) {
          // Write the recovery back so the store row is whole (live viewport
          // key, DesignTree, and a later save all read the same entry).
          hooks.patchGeometry(geo.id, { modelBody: { ...geo.modelBody, display } })
        } else if (!display) {
          // Cache miss: no record, a record whose identity does not match this
          // ref (R2 C2), or no projectId to scope the lookup with. NOT an error
          // and NOT a crash - the entry re-derives the moment the Part workspace
          // next mounts. Named so it is greppable if it ever recurs.
          console.warn(
            `INT-17A: modeled body "${geo.name}" (${geo.id}) has no display payload and none ` +
              `in the durable cache valid for ref version ${geo.modelBody.ref.version}; ` +
              `it will draw once the Part workspace next regenerates.`,
          )
        }
        if (display) {
          // WO INT-17C Stage C2 (Placement Composition Contract invariant 1):
          // a model row's world pose comes from its Placement record, NOT
          // `worldPos`/`worldRot` (== `geo.position`/`geo.rotation`, which
          // stay identity forever for a model row -- updateGeometryTransform
          // refuses to write them, C1 step 3b). Fail loud (invariant 4): no
          // resolvable Placement means this body does not draw, logged by
          // name, rather than silently falling back to the stale identity
          // `worldPos` computed above.
          try {
            const { position: modelPos, rotation: modelRot } = resolveModelReferenceFrame(
              liveModelItemPlacements(), modelItemId, geo.modelBody.ref.bodyId,
            )
            vp.addModelBody(geo.id, display, geo.name, modelPos, modelRot, geo.color)
            if (geo.hidden) vp.setSTLVisible(geo.id, false)
          } catch (err) {
            console.error(
              `INT-17C: model body "${geo.id}" (item "${modelItemId}") could not be drawn:`, err,
            )
          }
        }
      }
    } else if (geo.format === 'svg' || geo.format === 'dxf' || geo.format === 'sketch') {
      // Prefer loops already stored in the project object; fall back to
      // IndexedDB (sketch-container loops always live in the project).
      const loops   = geo.loops   ?? (await load2DGeometry(geo.id).catch(() => null))?.loops
      const layers  = geo.layers2d ?? (await load2DGeometry(geo.id).catch(() => null))?.layers
      if (!isCurrent()) return
      if (loops && layers) {
        vp.add2DGeometry(geo.id, loops, layers, worldPos, worldRot)
      }
    }
  }
}

/** Restore a project's stored nests into the viewport (ADR 0024, P3.2). For each
 *  NestRecord with placements, resolve its source-part loops from project.geometry
 *  (NO duplication — the renderer instances the single source per placement) and
 *  call addNestInstances, then honour record.visible. Skips nests with no
 *  placements (un-computed) and no-ops when the viewport lacks the nest API.
 *
 *  Refined seed model (ADR 0025 §2): the SEED is the lower-left placement instance
 *  per source IN the nest. We pass the seed instanceIds plus, for each source, the
 *  LIVE ImportedGeometry's loops (with layerId) + layers so the renderer colours
 *  the seed slot with the source's REAL per-layer colors (the nest's stored loops
 *  may be stripped of layerId) — a HARD constraint (seed loops are never recolored). */
export function restoreNestsToViewport(
  vp: RestoreViewport,
  nests: NestRecord[] | undefined,
  geometry: ImportedGeometry[],
): void {
  if (!nests || nests.length === 0 || !vp.addNestInstances) return
  for (const nest of nests) {
    if (nest.placements.length === 0) continue
    const sourceLoopsById = resolveNestSourceLoops(nest, geometry)
    if (sourceLoopsById.size === 0) continue

    // Seed slots: instanceIds + the live source's layer-coloured loops.
    const seedInstanceIds = seedPlacementIds(nest)
    const seedSourcesById = new Map<string, {
      loops: Array<{ id: string; points: Array<{ x: number; y: number }>; layerId: string }>
      layers: Array<{ id: string; color: string; visible: boolean }>
    }>()
    for (const src of nest.sources) {
      const geo = geometry.find(g => g.id === src.geometryId)
      if (!geo) continue
      const layers = (geo.layers2d ?? []).map(l => ({ id: l.id, color: l.color, visible: l.visible }))
      // Seed-slot honours per-layer visibility (seed layer eyes): a loop on a
      // hidden layer is dropped from the slot render. Pure helper shared with the
      // unit test so the filter rule lives in one place. The loop `id` is carried
      // through so the seed-slot Line can be loop-picked when authoring a seed op
      // (line.name = loop.id, mirroring add2DGeometry).
      const loops = visibleSeedLoops(
        (geo.loops ?? [])
          .filter(l => l.closed && l.points.length >= 3)
          .map(l => ({ id: l.id, points: l.points.map(p => ({ x: p.x, y: p.y })), layerId: l.layerId })),
        layers,
      )
      if (loops.length === 0) continue
      seedSourcesById.set(src.geometryId, { loops, layers })
    }

    vp.addNestInstances(
      nest.id, nest.sheet, nest.placements, sourceLoopsById,
      seedInstanceIds, seedSourcesById,
    )
    // D3 move-coupling: the group is authored at local (0,0); ride it to the
    // nest's world origin (sheet + parts + seed slot follow). Default 0,0 leaves
    // legacy nests where they render today.
    const origin = nest.origin ?? { x: 0, y: 0 }
    if (origin.x !== 0 || origin.y !== 0) {
      vp.setNestGroupPosition?.(nest.id, origin.x, origin.y)
    }
    if (nest.visible === false) vp.setNestVisible?.(nest.id, false)
  }
}

/** Full scene reload for a freshly-set project: clear, restore geometry, then
 *  rebuild stock from the PROJECT's sceneStock (not the viewport's stale
 *  config). Same end-state the page-refresh and undo paths produce.
 *
 *  Both of this function's callers (store/index.ts: File>Open, New Project)
 *  are boot-like -- a project is being freshly installed, never an in-session
 *  undo/redo -- so this relies on restoreGeometryToViewport's
 *  `checkDocumentConsistency` default (`true`) rather than threading its own
 *  parameter through. Do not add an undo/refresh caller of this function
 *  without also revisiting that default (WO-353 audit fix). */
export async function reloadProjectScene(
  vp: ReloadableViewport,
  project: {
    /** INT-17A-R2 C2: scopes the durable model-body display cache lookup. */
    id?: string
    geometry: ImportedGeometry[]
    sceneStock: SceneStock
    stocks?: PhysicalStock[]
    nests?: NestRecord[]
  },
  hooks: RestoreSceneHooks,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  if (!isCurrent()) return
  vp.clearScene()
  if (project.geometry.length > 0) {
    // Phase 4 Item 1: pass the project's physical stocks as the world-transform
    // compose context (identity under Option 1; the seam for a future tier).
    // Nest-owned sources are suppressed from the standalone render (ADR 0025 §2).
    await restoreGeometryToViewport(
      vp, project.geometry, hooks, project.stocks ?? [],
      nestOwnedGeometryIds({ geometry: project.geometry }),
      project.id,
      isCurrent,
    )
  }
  if (!isCurrent()) return
  // Instanced nests render after their source geometry exists (ADR 0024, P3.2).
  restoreNestsToViewport(vp, project.nests, project.geometry)
  if (!isCurrent()) return
  vp.rebuildStock(project.sceneStock)
}
