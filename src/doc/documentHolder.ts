// WO INT-14: the LIVE modeling-document holder -- the seam the store reaches
// the parametric model through on save/load.
//
// WHY A MODULE AND NOT A COMPONENT HANDLE (the P2 seam, INT-14 preflight
// amendment 1). The live document is `dagRef`, a React ref on
// SolidsWorkbenchPage (SolidsWorkbenchPage.tsx:1175). That component is
// LAZILY mounted: the embedded mount is gated on `workbenchEverMounted`
// (App.tsx:273-283), which only flips true the first time the user enters the
// Part workspace. So at save time the workbench may never have mounted at all,
// and the only pre-existing seam into it (window.__solidsWorkbenchHooks,
// SolidsWorkbenchPage.tsx:5079) is test-only and is DELETED on unmount
// (:5237). Reaching the document through the component would therefore mean:
// load a model-bearing .camproject -> never open the Model workspace -> save ->
// the model is SILENTLY DROPPED. That is the exact outcome this WO exists to
// prevent ("saving the project saves the model, loading brings it back
// exactly"), so the holder lives HERE, at module scope, outliving every mount.
//
// The three duties, each a named export below:
//   (a) LOAD-STASH   -- stashLoadedDocument() parks the loaded document even
//                       when the workbench is unmounted.
//   (b) MOUNT-SEED   -- takePendingDocumentSeed() hands it to the workbench
//                       when (if ever) it mounts, seeding dagRef from the file
//                       instead of `new FeatureDag()`.
//   (c) SAVE PASS-THROUGH -- collectDocumentArchive() re-emits the loaded bytes
//                       UNCHANGED when no workbench ever mounted to own them.
//                       A mounted workbench's live document always wins.
//
// Shape mirrors the getViewportHandle precedent (store/index.ts:133): a
// guarded module-level accessor the store calls, no-op when absent. Unlike
// that one this holds no `window` global at all -- the state is module scope,
// so there is no unguarded global on the production save path (amendment 8).
//
// This module OWNS the autosave controller's lifecycle for the same reason it
// owns the document: an autosave scoped to the mount effect would die with the
// lazy mount (amendment 7).
//
// INT-17C Stage C1 step 4 (strangler pattern, preflight extraction-order step
// 4). Every `let` below generalizes into a `Map<modelItemId, T>`, keyed by an
// explicit, OPTIONAL trailing `modelItemId` parameter that defaults to ONE
// hardcoded legacy key (`LEGACY_MODEL_ITEM_ID`). Every existing call site --
// this module's own production callers in store/index.ts and
// SolidsWorkbenchPage.tsx, and every existing test -- keeps calling with no
// `modelItemId` argument, so it keeps landing on the SAME single map entry it
// always implicitly owned: externally unchanged, single-document semantics,
// now routed through a map with exactly one entry. The keyed API exists (a
// future caller CAN pass a real `modelItemId`) but nothing multi-item is
// wired to it yet -- that is Stage C1 step 5 (SolidsWorkbenchPage.tsx's
// remount-key generalization), out of this mission's scope.
//
// `documentStorage` (the OPFS/injected storage BACKEND) is the one piece of
// state that deliberately stays a single, un-keyed module `let`: its own doc
// comment below already states "Single-owned deliberately (WO INT-14-R1)" --
// generalizing it per-item would mean two items could point autosave and
// recovery at DIFFERENT backends, exactly the split this module's own
// precedent forbids. A future multi-item stage still shares one backend,
// disambiguated by `documentId`/`modelItemId` keys within it, not by
// multiple backend instances.

import {
  AutosaveController,
  autosaveDataKey,
  createDocumentArchive,
  loadDocumentArchive,
  replaceArchiveDrawings,
  readAutosaveSnapshot,
  removeAutosaveSnapshot,
  writeAutosaveSnapshot,
  recoverAutosave,
  OpfsDocumentStorage,
  InMemoryDocumentStorage,
  type AutosaveRecovery,
  type BinaryDocumentStorage,
  type DocumentSaveInput,
  type LoadedDocument,
} from './persist'
import { isGenesisNodeId } from './genesis'
import { ElementMap, type DeltaSnapshots } from './element-map'
import { applyFeatureDelta } from './replay'
import type { ElementMapDelta } from '../geom/geom-service'
import { FeatureDag } from './dag'
import {
  drawingRecordsEmpty,
  readDrawingRecords,
  writeDrawingRecords,
  type DrawingRecords,
} from '../lib/drawing/document'
import type { JsonValue } from './persist'
import type { ModelSession } from './modelSession'

/** The one hardcoded key every pre-Stage-C1 caller implicitly owns. Not a
 *  real Model Item id (no such registry exists yet -- that is the v12
 *  migration, WO step 7) -- just the strangler seam's single legacy bucket. */
export const LEGACY_MODEL_ITEM_ID = 'legacy'

/** What a mounted workbench hands back on save: the fully-assembled archive
 *  input, or null when the document holds nothing but its genesis fixtures
 *  (Origin + XY/XZ/YZ) -- i.e. the user has modelled nothing. See
 *  `isEmptyDocument`. */
export type DocumentCollector = () => DocumentSaveInput | null

const liveCollectors = new Map<string, DocumentCollector>()
/** The bytes of the document the CURRENT project was loaded with, kept verbatim
 *  so an unmounted workbench's save re-emits them without a lossy re-encode. */
const passThroughArchives = new Map<string, Uint8Array>()
/**
 * WO-2987 (WO-2750 Slice B): each Model Item's technical drawings, as the raw
 * `{ documents }` JSON the archive carries. The mounted workbench's collector
 * (SolidsWorkbenchPage buildDocumentSaveInput) knows nothing about drawings, so
 * the holder owns them: every route that loads, replaces or drops an item's
 * archive sets or clears this entry beside it, and every route that builds an
 * archive from a live collector folds it back in (`withHeldDrawings`). That is
 * what keeps a mounted save, an unmount stash and an autosave from dropping a
 * drawing the workbench never saw -- including a drawing from a newer build
 * that this one can only carry, not read. Keyed by modelItemId like the maps
 * above, so two items with the same local drawing ids stay apart. Empty
 * entries are never stored (no entry == no drawings).
 */
const heldDrawings = new Map<string, JsonValue>()

function holdDrawings(modelItemId: string, drawings: JsonValue): void {
  if (drawingRecordsEmpty(readDrawingRecords(drawings))) heldDrawings.delete(modelItemId)
  else heldDrawings.set(modelItemId, drawings)
}

/** The live collector's input with the item's held drawings folded in. A document the workbench calls empty (genesis only) is NOT empty while it holds a drawing: the drawing outlives its body (plan section 3, "Deleting the source body retains the drawing"). A collector that supplies its own `drawings` wins. */
function withHeldDrawings(input: DocumentSaveInput | null, modelItemId: string): DocumentSaveInput | null {
  const held = heldDrawings.get(modelItemId)
  if (held === undefined) return input
  if (input === null) return { dag: new FeatureDag(), elementMapDeltas: [], drawings: held }
  return input.drawings === undefined ? { ...input, drawings: held } : input
}
/**
 * A restored document awaiting a COMMITTED mount.
 *
 * React is allowed to call a component during a speculative render and throw
 * that render away (StrictMode deliberately does this in development). A
 * render must therefore only PEEK at this lease. The committed workbench
 * acknowledges the exact lease from an effect; a stale acknowledgement cannot
 * delete a newer seed that arrived while the old render was in flight.
 */
export interface PendingDocumentSeedLease {
  readonly revision: number
  readonly seed: LoadedDocument
}

const pendingSeeds = new Map<string, PendingDocumentSeedLease>()
let nextPendingSeedRevision = 1

function makePendingSeedLease(seed: LoadedDocument): PendingDocumentSeedLease {
  return {
    revision: nextPendingSeedRevision++,
    seed,
  }
}
const generations = new Map<string, number>()
const generationListeners = new Map<string, Set<() => void>>()

// ---------------------------------------------------------------------------
// Lineage history (WO INT-14-R1 BLOCKER 1)
// ---------------------------------------------------------------------------
//
// THE DEFECT THIS EXISTS TO CLOSE. Every mounted save used to hard-code
// `elementMapDeltas: []`, on the reasoning that the loader rebuilds the map by
// calling dag.regenerate(map) anyway (format.ts:132-134). That reasoning is
// wrong, and the way it is wrong loses data. regenerate() RESOLVES each node's
// refs THROUGH the map; it does not reconstruct the map. The map's lineage
// edges -- "the face once called TOP is now called FRAG" -- exist ONLY because
// some op emitted a delta recording that edge (element-map.ts's recordLineage).
// With an empty delta array the restored map has no edges at all, so a stored
// reference to a HISTORICAL id has no path to its survivor: resolve() falls
// through step 1 (not live), step 2 (no descendants), step 3 (no snapshot) to
// step 4, LOST -- and a feature that was healthy before the save reopens
// degraded, with REFERENCE_UNRESOLVED. docs/stable-id-spec.md's whole
// topological-naming promise is that persisted history, not luck, is what makes
// an old id resolvable; [] threw the history away.
//
// THE FIX, and why it is a subclass rather than a second ledger. There is
// exactly ONE production site where a delta enters the live map:
// RegenScheduler's `applyFeatureDelta(this.map, result.elementMap)`
// (regen/scheduler.ts:272). Recording at the map itself therefore catches every
// delta by construction -- including any future producer -- whereas a
// hand-maintained array beside the map would silently miss whatever forgets to
// append to it. It also cannot drift from the map's real contents: the entry is
// written on the same call that mutates the map.
//
// GROWTH, stated honestly. The history is append-only and order-preserving,
// which is what makes replaying it reproduce the live map EXACTLY (same deltas,
// same order, and applyDelta is deterministic). It is not compacted, and the
// cost is real: each open re-executes every feature (the restore's fullResync),
// so each save/load cycle appends roughly one delta per feature. Truncating to
// "the last delta per feature" would be smaller and WRONG -- an edge recorded
// by a feature that has since been deleted (the TOP -> FRAG case above) is
// never re-emitted, so dropping the old entry is precisely the lineage erasure
// this block exists to prevent. Fidelity wins; a bounded compaction that can
// prove it preserves reachability is future work, not a silent trim.
export class RecordingElementMap extends ElementMap {
  private readonly history: ElementMapDelta[] = []

  override applyDelta(delta: ElementMapDelta, snapshots?: DeltaSnapshots): this {
    this.history.push(recordableDelta(delta, snapshots))
    return super.applyDelta(delta, snapshots)
  }

  /** The delta history to persist: what this map was actually built from. */
  deltaHistory(): ElementMapDelta[] {
    return [...this.history]
  }
}

/**
 * Fold the snapshots the map ACTUALLY consumed into the recorded delta's own
 * inline `geometry` field, so a replay of the record reproduces this exact
 * application.
 *
 * Necessary because applyDelta's effective snapshot source is
 * `snapshots ?? delta.geometry` (element-map.ts) -- a COMPANION map, when
 * present, wholly replaces the inline field rather than merging with it. A
 * producer on the pre-ICR-1 side channel therefore hands geometry that lives
 * nowhere in `delta`; recording `delta` verbatim would persist a delta whose
 * replay is blind exactly where the live map could see, and resolution steps 2
 * and 3 need those snapshots (split disambiguation, geometric fallback).
 * Writing the effective map into `geometry` makes the record self-contained,
 * which is what the archive stores and what format.ts's loader replays with no
 * companion argument.
 */
function recordableDelta(delta: ElementMapDelta, snapshots?: DeltaSnapshots): ElementMapDelta {
  const effective = snapshots ?? delta.geometry
  return effective === undefined ? { ...delta } : { ...delta, geometry: { ...effective } }
}

/**
 * Build the workbench's live map, SEEDED from the opened document.
 *
 * The second half of BLOCKER 1 ("seed the live scheduler/map from the loaded
 * document consistently"). The page used to construct `new ElementMap()`
 * unconditionally while seeding `dagRef` from the loaded document -- so the dag
 * arrived carrying references the loader had already resolved against a
 * POPULATED map (format.ts:131-134), and then met an EMPTY one. The first live
 * regenerate would re-resolve those same references and lose them.
 *
 * Seeding replays the document's own deltas through applyFeatureDelta -- the
 * identical seam and order format.ts:133 uses -- so the live map lands in the
 * same state the loader's map held, and the history starts as the file's
 * history. One mechanism serves both halves: seed by replay, and the replay IS
 * the recorded history.
 */
export function seedRecordingElementMap(seed: LoadedDocument | null): RecordingElementMap {
  const map = new RecordingElementMap()
  if (seed !== null) {
    for (const delta of seed.elementMapDeltas) applyFeatureDelta(map, delta)
  }
  return map
}

/**
 * A document is EMPTY when every node in it is a genesis fixture. A fresh
 * workbench is born with Origin + XY/XZ/YZ already seeded (SKC-15,
 * SolidsWorkbenchPage.tsx:1172-1189), so "the user clicked the Model tab once
 * and clicked back" must NOT start writing a `document` field into every
 * 2D-only .camproject from then on (that would break AC3's no-perturbation
 * contract for the most ordinary case there is).
 */
export function isEmptyDocument(dag: FeatureDag): boolean {
  return dag.nodeIds().every((id) => isGenesisNodeId(id))
}

/**
 * A mounted workbench registers its live document here. Returns the
 * unregister function for the mount effect's cleanup.
 *
 * The cleanup is identity-guarded (`liveCollectors.get(modelItemId) ===
 * collect`) because React can mount the replacement BEFORE unmounting the old
 * tree: an unguarded cleanup would then null out the NEW mount's collector
 * and every later save would silently fall back to the stale pass-through
 * bytes. This ordering is not hypothetical -- it is exactly what a
 * remount-on-load does (see `getDocumentGeneration`), and it has its own
 * committed interleave test.
 *
 * STASH ON UNMOUNT (closes the INT-17C C1 switch-away hazard the C1 closure
 * disclosed: "switching the active Model Item unmounts the outgoing item's
 * live document with no stash-on-unmount path -- its in-memory edits are lost
 * the moment you switch away"). Before this, `collectDocumentArchive`'s own
 * precedence -- live collector, THEN pass-through, THEN undefined -- had a
 * hole: a brand-new (never-loaded-from-file) Model Item has no pass-through
 * entry, so the instant its live collector is removed (Finish, or opening a
 * DIFFERENT item -- both remount the embedded host on `modelItemId`,
 * App.tsx/SolidsWorkbenchPage.tsx's `key`), a save silently produced NO
 * archive for it at all, and reopening it started a fresh, empty document.
 * Both symptoms had one root cause: nothing captured the outgoing state at
 * the exact moment it stopped being live. This closes it by round-tripping
 * the collector's CURRENT state through the exact same archive encode/decode
 * a real save+reload already uses (`createDocumentArchive` +
 * `stashLoadedDocument`) -- so after this, an unmounted item's last in-memory
 * state is both what a save re-emits (pass-through) AND what a later reopen
 * reseeds from (pending seed), identical to how a freshly opened file
 * behaves. `collect()` reads plain in-memory objects (dag/map/folders,
 * SolidsWorkbenchPage.tsx's `buildDocumentSaveInput`) with no canvas/kernel
 * dependency, so calling it from this cleanup is exactly as safe as autosave
 * already calling it independent of mount timing (documentHolder.ts's own
 * save-seam comment on `collectDocumentArchive`). A null input (genesis-only,
 * e.g. every feature was deleted before switching away) is the same
 * "legitimately empty" case `collectDocumentArchive` already honors, so it
 * clears any stale stash rather than leaving old content behind. A throwing
 * collector fails SAFE, not loud: an unmount cannot be aborted, so the
 * alternative to swallowing here is losing the item's edits with no message
 * at all -- console.error at least names it for anyone checking devtools.
 *
 * EDIT-MODEL-REGRESSION (2026-07-24, Operator): the legacy id USED TO be
 * unconditionally exempt from this stash on the reasoning that "the legacy
 * single-document mount's `modelItemId` never changes across an ordinary
 * CAM<->Part workspace switch (App.tsx hides it with CSS instead of
 * remounting it), so it only unmounts when the whole page goes away." That
 * was true until GEO-UNIFY-S1b's Model workspace HEADER shipped a real
 * switcher: opening a DIFFERENT Model Item from inside the workspace (or
 * reopening the legacy item after doing so) changes `activeModelItemId`,
 * which changes SolidsWorkbenchPage's own remount `key` -- so the legacy
 * mount now unmounts mid-session exactly like any non-legacy item does, and
 * with the stash skipped, reopening it landed on a brand-new EMPTY document
 * (Operator's screenshot: "PROJECT MODEL", 0 bodies, 4 features -- genesis only).
 * Root-caused via src/tests/model3d/editModelRegression.report.test.tsx
 * (RED against the pre-fix code: build the legacy item's content, Finish,
 * open a second item -- forcing the legacy mount to unmount -- reopen the
 * legacy item and its own feature rows are gone).
 *
 * The fix narrows the exemption to `!embedded` instead of `id === legacy`:
 * the ONLY place a bare, load-free remount of the legacy slot is a real,
 * sanctioned "start empty" contract is the STANDALONE `?lab3d=1` dev route
 * (SolidsWorkbenchPage.documentPersist.test.tsx's "opening a project while
 * the workbench is mounted replaces the model in place" -- a second bare
 * mount of that route must NOT resurrect the previous mount's unsaved
 * in-memory build; the sanctioned way to keep it is Save + reopen through
 * loadProjectFromFile, which the very same test proves separately). The
 * EMBEDDED host (App.tsx's `<SolidsWorkbenchPage embedded .../>`, the ONLY
 * mount the real product ever renders) has no such "start empty" contract
 * for ANY id, legacy included -- every embedded unmount there is a genuine
 * in-app navigation event (Finish, a Model Item switch, or the item being
 * reopened), so it always stashes, exactly like a non-legacy item already
 * did. `embedded` is passed in by the caller (SolidsWorkbenchPage.tsx's own
 * `embedded` prop) rather than re-derived here, keeping this module free of
 * any React/App coupling.
 *
 * NO-OP GUARD (INT-17C Stage C2: React StrictMode dev double-mount crash
 * fix, root-caused after the DEV app -- localhost:5173, which mounts
 * <StrictMode><App/></StrictMode>, src/main.tsx:32 -- crash-looped with
 * "Maximum update depth exceeded" the instant the DesignTree "+" created a
 * New Model Item). This cleanup used to call clearLoadedDocument /
 * stashLoadedDocument -- and therefore bumpGeneration -- UNCONDITIONALLY on
 * every unmount. That is correct for a real content change, but StrictMode's
 * dev double-invoke runs mount -> cleanup -> mount for every effect
 * (deliberately, to catch exactly this class of non-idempotent cleanup), so
 * the simulated cleanup fires with the document in the SAME state it was in
 * at mount -- most sharply for a brand-new Model Item, whose document is
 * genesis-only, so `collect()` returns null both times. The resulting
 * generation bump is not cosmetic: SolidsWorkbenchPage keys its child on
 * `${modelItemId}:${documentGeneration}` (SolidsWorkbenchPage.tsx:1489), so
 * that spurious bump remounts the very component whose cleanup produced it
 * -- and the fresh mount's own StrictMode double-invoke does the same thing
 * again, forever.
 *
 * The fix (below) compares the freshly observed state against what is
 * ALREADY held. Identical bytes are parked as a pending lease WITHOUT a
 * generation bump; changed bytes use stashLoadedDocument and do bump. This
 * is re-entrant-safe under StrictMode while still preserving an unchanged
 * A -> B -> A switch: acknowledging A's original seed no longer leaves A
 * with pass-through bytes but no future mount seed.
 */
export function registerLiveDocument(
  collect: DocumentCollector,
  modelItemId: string = LEGACY_MODEL_ITEM_ID,
  embedded: boolean = true,
): () => void {
  liveCollectors.set(modelItemId, collect)
  return () => {
    if (liveCollectors.get(modelItemId) !== collect) return
    liveCollectors.delete(modelItemId)
    // EDIT-MODEL-REGRESSION: the exemption is now `!embedded`, not "id is
    // legacy" -- see this function's own doc comment above.
    if (!embedded) return
    try {
      const input = withHeldDrawings(collect(), modelItemId)
      if (input === null) {
        // No-op guard (INT-17C Stage C2: React StrictMode dev double-mount
        // crash fix). Nothing to clear when nothing is held: a repeat
        // "still genesis-only" observation (StrictMode's simulated
        // mount->cleanup->mount, or a cascade this module's own bump
        // caused) must not re-bump a generation that a real clear already
        // brought to "no document" -- see the NO-OP GUARD block above.
        if (passThroughArchives.has(modelItemId) || pendingSeeds.has(modelItemId)) {
          clearLoadedDocument(modelItemId)
        }
      } else {
        const bytes = createDocumentArchive(input)
        const existing = passThroughArchives.get(modelItemId)
        // Byte-for-byte identical to what is already stashed: a repeat
        // observation of UNCHANGED content, not a new edit. Re-stashing
        // would buy nothing (the held bytes already ARE this content) and
        // re-bumping the generation is the infinite loop -- see above.
        if (existing === undefined || !archivesEqual(existing, bytes)) {
          stashLoadedDocument(bytes, modelItemId)
        } else if (!pendingSeeds.has(modelItemId)) {
          // The committed mount acknowledged its seed, so byte-identical does
          // NOT mean there is nothing to do: a real A -> B switch still needs a
          // seed parked for the next A mount. Park without bumping generation.
          // This is also safe during StrictMode's simulated cleanup: the same
          // component remains mounted, and avoiding a generation bump prevents
          // the old remount loop while leaving the future seed ready.
          pendingSeeds.set(
            modelItemId,
            makePendingSeedLease(loadDocumentArchive(bytes)),
          )
        }
      }
    } catch (err) {
      console.error(
        `INT-17C: could not stash Model Item "${modelItemId}"'s document on unmount; ` +
          'its edits since the last save may be lost if the project is saved before this item is reopened.',
        err,
      )
    }
  }
}

/** Byte-for-byte archive comparison for registerLiveDocument's NO-OP GUARD
 *  above. Local and deliberately tiny: this is not a general utility, just
 *  what the guard needs to tell "unchanged" from "genuinely different"
 *  without decoding either side. */
function archivesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// WO-2978 (WO-2951 Order A): the live ModelSession per model item.
//
// The mounted workbench builds one ModelSession (modelSession.ts) from the
// document it was seeded with and registers it here, beside its collector, so
// anything that needs the live model -- the page today, the modeling command
// registry next (WO-2951 Order B) -- reaches the SAME dag/history/scheduler
// by model item id, without a component handle. Same identity-guarded shape
// as registerLiveDocument: an unregister only removes its own session, so
// React StrictMode's mount -> cleanup -> mount (or a remount racing an old
// cleanup) never drops the session that is actually live. Unregistering does
// nothing else -- the collector's cleanup above owns stashing the document.
// ---------------------------------------------------------------------------
const liveSessions = new Map<string, ModelSession>()

/** Makes `session` the live session for its model item; returns the
 *  unregister (a no-op once another session has replaced it). */
export function registerModelSession(session: ModelSession): () => void {
  liveSessions.set(session.modelItemId, session)
  return () => {
    if (liveSessions.get(session.modelItemId) === session) liveSessions.delete(session.modelItemId)
  }
}

/** The live session for `modelItemId`, or undefined when no workbench mount
 *  holds that item's document right now. */
export function getModelSession(modelItemId: string = LEGACY_MODEL_ITEM_ID): ModelSession | undefined {
  return liveSessions.get(modelItemId)
}

/** Is a workbench currently holding the live document? (Test/report seam.) */
export function hasLiveDocument(modelItemId: string = LEGACY_MODEL_ITEM_ID): boolean {
  return liveCollectors.has(modelItemId)
}

/**
 * Decode + stash a loaded project's embedded document archive.
 *
 * Throws (ADR-0003, fail loud): loadDocumentArchive raises
 * FutureSchemaVersionError for a document stamped newer than this build
 * (versioning.ts:47) and plain Errors for corrupted/incomplete zip bytes
 * (format.ts:123,202). NOTHING is stashed and NO generation is published when
 * it throws -- the holder keeps the state it had, and the caller
 * (loadProjectFromFile) aborts the whole open. A half-stashed document is
 * exactly the silent partial ADR-0003 forbids.
 */
export function stashLoadedDocument(
  bytes: Uint8Array,
  modelItemId: string = LEGACY_MODEL_ITEM_ID,
): LoadedDocument {
  const loaded = loadDocumentArchive(bytes)
  pendingSeeds.set(modelItemId, makePendingSeedLease(loaded))
  passThroughArchives.set(modelItemId, new Uint8Array(bytes))
  holdDrawings(modelItemId, loaded.drawings)
  bumpGeneration(modelItemId)
  return loaded
}

/**
 * Drop any held document. Called when a project with NO embedded document is
 * opened: the previously-loaded model belongs to the PREVIOUS project and must
 * not survive into this one (the same ghost-document reasoning
 * loadProjectFromFile already applies to the active sketch, store/index.ts:3958).
 */
export function clearLoadedDocument(modelItemId: string = LEGACY_MODEL_ITEM_ID): void {
  pendingSeeds.delete(modelItemId)
  passThroughArchives.delete(modelItemId)
  heldDrawings.delete(modelItemId)
  bumpGeneration(modelItemId)
}

/** Atomically replace the current project's complete holder contents.
 *
 * Every archive is decoded before any live map changes. Once validation
 * succeeds, the synchronous commit clears the previous project's collectors,
 * pending/pass-through documents, and controllers, installs all incoming
 * documents, then publishes one generation bump per affected item. The shared
 * durable storage backend is deliberately retained.
 */
export function replaceLoadedDocumentArchives(
  archives: ReadonlyMap<string, Uint8Array>,
  commitOwner?: () => void,
): void {
  const decoded = new Map<string, LoadedDocument>()
  for (const [modelItemId, bytes] of archives) {
    decoded.set(modelItemId, loadDocumentArchive(bytes))
  }

  const affectedIds = new Set<string>([
    ...liveCollectors.keys(),
    ...passThroughArchives.keys(),
    ...pendingSeeds.keys(),
    ...heldDrawings.keys(),
    ...controllers.keys(),
    ...archives.keys(),
  ])
  liveCollectors.clear()
  passThroughArchives.clear()
  pendingSeeds.clear()
  heldDrawings.clear()
  for (const modelItemId of [...controllers.keys()]) {
    disposeDocumentAutosave(modelItemId)
  }
  for (const [modelItemId, bytes] of archives) {
    pendingSeeds.set(
      modelItemId,
      makePendingSeedLease(decoded.get(modelItemId)!),
    )
    passThroughArchives.set(modelItemId, new Uint8Array(bytes))
    holdDrawings(modelItemId, decoded.get(modelItemId)!.drawings)
  }
  // Install the owning project after the holder maps exist but before any
  // generation listener can remount a workbench against them.
  commitOwner?.()
  for (const modelItemId of affectedIds) bumpGeneration(modelItemId)
}

/**
 * Non-destructively read the seed lease for a prospective mount.
 *
 * This function is render-safe: any number of speculative/StrictMode renders
 * may observe the same lease without consuming it.
 */
export function peekPendingDocumentSeed(
  modelItemId: string = LEGACY_MODEL_ITEM_ID,
): PendingDocumentSeedLease | null {
  return pendingSeeds.get(modelItemId) ?? null
}

/**
 * Consume a seed only after the workbench that rendered from it commits.
 *
 * Identity plus revision make this an exact acknowledgement. If a newer load
 * replaced the pending seed between render and commit, the old workbench
 * cannot consume the replacement.
 */
export function acknowledgePendingDocumentSeed(
  lease: PendingDocumentSeedLease,
  modelItemId: string = LEGACY_MODEL_ITEM_ID,
): boolean {
  const pending = pendingSeeds.get(modelItemId)
  if (pending !== lease || pending.revision !== lease.revision) return false
  pendingSeeds.delete(modelItemId)
  return true
}

/**
 * Legacy imperative consumer retained for non-React callers and older focused
 * tests. Production React mounts must use peek + acknowledge so render stays
 * side-effect free.
 */
export function takePendingDocumentSeed(modelItemId: string = LEGACY_MODEL_ITEM_ID): LoadedDocument | null {
  const lease = peekPendingDocumentSeed(modelItemId)
  if (lease === null) return null
  acknowledgePendingDocumentSeed(lease, modelItemId)
  return lease.seed
}

/**
 * THE SAVE SEAM. Returns the document archive bytes to embed, or undefined
 * when this project has no modeling document (-> the store omits the field
 * entirely, mirroring collectProjectBinaries' undefined-when-empty contract,
 * projectBinaries.ts:98).
 *
 * Precedence, and why:
 *   1. a mounted workbench's LIVE document -- it owns the truth, including
 *      every edit made since the load.
 *   2. the loaded bytes VERBATIM (pass-through) -- no workbench ever mounted,
 *      so nothing has touched the model; re-emitting the original bytes is
 *      both lossless and the only way the never-visited-Model-workspace save
 *      keeps the model.
 *   3. undefined -- no document at all (a 2D-only project).
 */
export function collectDocumentArchive(modelItemId: string = LEGACY_MODEL_ITEM_ID): Uint8Array | undefined {
  const liveCollector = liveCollectors.get(modelItemId)
  if (liveCollector !== undefined) {
    const input = withHeldDrawings(liveCollector(), modelItemId)
    if (input === null) return undefined
    return createDocumentArchive(input)
  }
  const passThrough = passThroughArchives.get(modelItemId)
  if (passThrough === undefined && heldDrawings.has(modelItemId)) {
    // A drawing with no model archive behind it (the item's body is gone, or the
    // workbench never held one): the drawing is still the item's content.
    return createDocumentArchive(withHeldDrawings(null, modelItemId)!)
  }
  return passThrough
}

/**
 * WO-2987: the item's drawings, readable ones typed and anything this build
 * cannot read kept in `preserved`. Empty when it has none.
 */
export function getDrawingRecords(modelItemId: string = LEGACY_MODEL_ITEM_ID): DrawingRecords {
  return readDrawingRecords(heldDrawings.get(modelItemId))
}

/**
 * WO-2987: replace the item's drawings (the editor's write seam; Slice C wires
 * the caller). Part of the item's archive from the next save, autosave or
 * unmount stash on, and marks the item dirty like any model edit. Pass the
 * `preserved` entries from `getDrawingRecords` back unchanged.
 */
export function setDrawingRecords(records: DrawingRecords, modelItemId: string = LEGACY_MODEL_ITEM_ID): void {
  const raw = writeDrawingRecords(records)
  holdDrawings(modelItemId, raw)
  // No workbench holds this item: its save re-emits the pass-through bytes, so
  // bring those up to date now (only the drawings entry changes).
  const passThrough = passThroughArchives.get(modelItemId)
  if (!liveCollectors.has(modelItemId) && passThrough !== undefined) {
    passThroughArchives.set(modelItemId, replaceArchiveDrawings(passThrough, heldDrawings.get(modelItemId)))
  }
  markDocumentDirty(modelItemId)
}

// ---------------------------------------------------------------------------
// Remount generation
// ---------------------------------------------------------------------------
//
// Loading a project while the workbench is ALREADY mounted cannot be served by
// re-seating dagRef: `paramTable` and `history` are constructed ONCE from the
// dag instance at mount (SolidsWorkbenchPage.tsx:1238-1245), and the body/mesh/
// outline caches are all keyed off it. Swapping the ref would leave every one of
// them bound to the OLD document -- a half-restored workbench, which is the
// silent-partial ADR-0003 forbids. Publishing a generation the workbench keys
// its subtree on remounts it instead, so EVERY document-derived construct is
// rebuilt from the seed by the same code path a fresh mount already uses. No
// mount-site edit is needed: both mounts render the same component (P3), so both
// inherit this by construction.

export function subscribeDocumentGeneration(
  listener: () => void,
  modelItemId: string = LEGACY_MODEL_ITEM_ID,
): () => void {
  let listeners = generationListeners.get(modelItemId)
  if (listeners === undefined) {
    listeners = new Set()
    generationListeners.set(modelItemId, listeners)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getDocumentGeneration(modelItemId: string = LEGACY_MODEL_ITEM_ID): number {
  return generations.get(modelItemId) ?? 0
}

function bumpGeneration(modelItemId: string): void {
  generations.set(modelItemId, (generations.get(modelItemId) ?? 0) + 1)
  const listeners = generationListeners.get(modelItemId)
  if (listeners !== undefined) for (const listener of [...listeners]) listener()
}

// ---------------------------------------------------------------------------
// Autosave (INT-14 amendment 7) -- WIRING of the shipped DOC-3 controller.
// ---------------------------------------------------------------------------
//
// Nothing here re-implements autosave: AutosaveController (autosave.ts:22) owns
// the debounce and the R2/R3 write-ordering invariants; OpfsDocumentStorage
// (opfs-storage.ts:7) owns the OPFS backing. This module supplies the two things
// the controller was always missing -- a `save` callback that returns
// createDocumentArchive bytes, and a lifecycle. The lifecycle lives HERE, not in
// the mount effect, so autosave spans the lazy mount (amendment 7).

const controllers = new Map<string, AutosaveController>()
const controllerDocumentIds = new Map<string, string>()
const storageOperationChains = new Map<string, Promise<void>>()

/** Serialize every complete snapshot transaction for one project+item key.
 * This chain is shared by autosave controllers, File Open, hydration, and
 * deletion. It survives controller disposal/reset so a delayed operation from
 * the previous owner can never land after a replacement write or delete. */
function enqueueStorageOperation<T>(
  documentId: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = storageOperationChains.get(documentId) ?? Promise.resolve()
  const run = previous.then(task)
  const settled = run.then(
    () => undefined,
    () => undefined,
  )
  storageOperationChains.set(documentId, settled)
  void settled.finally(() => {
    if (storageOperationChains.get(documentId) === settled) {
      storageOperationChains.delete(documentId)
    }
  })
  return run
}

/**
 * The ONE storage backend autosave writes to and recovery reads from.
 *
 * Single-owned deliberately (WO INT-14-R1), and deliberately NOT keyed by
 * `modelItemId` even after Stage C1 step 4's generalization above -- see this
 * module's own header note. Recovery runs at OPEN, before the workbench has
 * mounted to start autosave, so the two reached storage through separate
 * `new OpfsDocumentStorage()` defaults at separate moments -- an arrangement
 * where a backend override could apply to one and not the other, i.e.
 * autosave writing somewhere recovery never looks. Constructed LAZILY because
 * OPFS is a browser capability: merely importing this module must not demand
 * it (jsdom has none, and the recovery entry point is on the ordinary
 * project-open path, not behind a feature check).
 */
let documentStorage: BinaryDocumentStorage | null = null

function currentDocumentStorage(): BinaryDocumentStorage {
  if (documentStorage === null) {
    const hasOpfs =
      typeof navigator !== 'undefined' &&
      typeof (navigator.storage as { getDirectory?: unknown } | undefined)?.getDirectory === 'function'
    documentStorage = hasOpfs
      ? new OpfsDocumentStorage()
      : new InMemoryDocumentStorage()
  }
  return documentStorage
}

/** Point autosave AND recovery at a storage backend; null restores the OPFS
 *  default. The injection seam for tests and for any future non-OPFS host. */
export function setDocumentStorage(storage: BinaryDocumentStorage | null): void {
  documentStorage = storage
}

/** Each Model Item owns an independent durable archive. The old project-only
 * id made every item in a multi-model project overwrite the same OPFS file. */
export function documentIdForProject(
  projectId: string,
  modelItemId: string = LEGACY_MODEL_ITEM_ID,
): string {
  return `project-${projectId}--model-${modelItemId}`
}

export function documentCheckpointStorageKey(
  projectId: string,
  modelItemId: string = LEGACY_MODEL_ITEM_ID,
): string {
  return autosaveDataKey(documentIdForProject(projectId, modelItemId))
}

/**
 * Start (or re-target) autosave for a project. Idempotent for the same id, so
 * the workbench mounting/unmounting never churns the controller. Re-targeting a
 * DIFFERENT project disposes the old controller first (its debounce timer must
 * not fire a write against the new project's document).
 */
export function startDocumentAutosave(
  options: {
    documentId: string
    storage?: BinaryDocumentStorage
    debounceMs?: number
    onFlushed?: (revision: number) => void
  },
  modelItemId: string = LEGACY_MODEL_ITEM_ID,
): AutosaveController {
  // An explicit storage re-points the module's single owner, so recovery reads
  // the same place this controller writes (see currentDocumentStorage).
  if (options.storage !== undefined) documentStorage = options.storage
  const existing = controllers.get(modelItemId)
  if (existing !== undefined && controllerDocumentIds.get(modelItemId) === options.documentId) {
    existing.setOnFlushed(options.onFlushed)
    return existing
  }
  disposeDocumentAutosave(modelItemId)
  controllerDocumentIds.set(modelItemId, options.documentId)
  const controller = new AutosaveController({
    documentId: options.documentId,
    storage: currentDocumentStorage(),
    debounceMs: options.debounceMs ?? 1000,
    onFlushed: options.onFlushed,
    serializeWrite: (task) => enqueueStorageOperation(options.documentId, task),
    // The save callback IS the WO's autosave parity: the same
    // collectDocumentArchive the manual save uses, so autosaved bytes and saved
    // bytes are produced by one path and recover through one path.
    save: async () => {
      const bytes = collectDocumentArchive(modelItemId)
      if (bytes === undefined) {
        // Fail loud rather than write an empty blob that a later recovery would
        // restore as "your model, now empty". markDocumentDirty only fires with
        // a live document, so reaching this is a real defect, not a normal path.
        throw new Error(
          'INT-14 autosave: the modeling document vanished between markDirty and flush; refusing to autosave an empty document.',
        )
      }
      return bytes
    },
  })
  controllers.set(modelItemId, controller)
  return controller
}

// WO-2698: how many model-document edits this session has made. The
// controller's own dirty flag only means "not yet autosaved" (a flush clears
// it), so New's "unsaved?" question compares this count against the one
// recorded when the project was last opened, started or saved to a file.
let documentEditCount = 0

/** The dag-mutation signal. No-op with no controller or no live document --
 *  an unmounted workbench's pass-through bytes are already durable in the file
 *  and nothing is editing them. */
export function markDocumentDirty(modelItemId: string = LEGACY_MODEL_ITEM_ID): void {
  const controller = controllers.get(modelItemId)
  if (controller === undefined || !liveCollectors.has(modelItemId)) return
  documentEditCount += 1
  controller.markDirty()
}

/** WO-2698: the running count of model-document edits (markDocumentDirty). */
export function modelDocumentEditCount(): number {
  return documentEditCount
}

/**
 * The manual save's clean-mark (autosave.ts:87's generation-guarded contract).
 *
 * Storage failures are SWALLOWED here, deliberately and only here: this is
 * autosave bookkeeping that runs AFTER a manual save has already succeeded, so
 * an unwritable OPFS (a browser without it, a private context, a full quota)
 * must not turn a good save into an error the user sees -- their file is
 * already on disk. The cost of failing to clean the flag is at worst a spurious
 * "recover?" offer on the next open, which is the safe direction to fail. The
 * SAVE path itself fails loud (store/index.ts): this is not that path.
 */
export async function markDocumentClean(modelItemId: string = LEGACY_MODEL_ITEM_ID): Promise<void> {
  const controller = controllers.get(modelItemId)
  if (controller === undefined) return
  try {
    await controller.markClean()
  } catch (err) {
    console.warn('INT-14: autosave clean-marking failed after a successful save (the saved file is unaffected):', err)
  }
}

export function getAutosaveController(modelItemId: string = LEGACY_MODEL_ITEM_ID): AutosaveController | null {
  return controllers.get(modelItemId) ?? null
}

export interface DurableDocumentCheckpoint {
  revision: number
  storageKey: string
  bytes: Uint8Array
  /** Set only when hydrateDocumentCheckpoint recovered from a caller's stale
   *  cached revision expectation instead of refusing to open (WO-348). One
   *  plain sentence: what was recovered, and that edits since the checkpoint
   *  may be missing. The caller decides where to surface it (not a modal). */
  recoveryNotice?: string
}

/**
 * WO-353: a REVISION-ONLY, no-decode peek at the durable checkpoint.
 *
 * The boot-time cross-layer consistency check (restoreScene.ts) needs to ask
 * "does the store's cached `item.documentRevision` still match what autosave
 * actually wrote?" for every open Model Item on every ordinary reload -- the
 * common case, where the answer is yes. `hydrateDocumentCheckpoint` answers
 * that question too, but it also decodes and validates the archive, which
 * this cheap check must not pay for until a mismatch is actually found.
 * Never throws and never stashes: undefined means "nothing durable yet",
 * which is the ordinary pre-first-checkpoint state, not a refusal.
 */
export async function peekDurableDocumentRevision(
  projectId: string,
  modelItemId: string = LEGACY_MODEL_ITEM_ID,
): Promise<number | undefined> {
  const documentId = documentIdForProject(projectId, modelItemId)
  const storage = currentDocumentStorage()
  const snapshot = await enqueueStorageOperation(
    documentId,
    () => readAutosaveSnapshot(storage, documentId),
  )
  return snapshot?.revision
}

/** Force the current live/pass-through document through the same serialized
 * OPFS writer autosave uses. Undefined is the explicit genesis-only state. */
export async function flushDocumentCheckpoint(
  projectId: string,
  modelItemId: string = LEGACY_MODEL_ITEM_ID,
): Promise<DurableDocumentCheckpoint | undefined> {
  const documentId = documentIdForProject(projectId, modelItemId)
  const storage = currentDocumentStorage()
  const bytes = collectDocumentArchive(modelItemId)
  if (bytes === undefined) {
    await enqueueStorageOperation(
      documentId,
      () => removeAutosaveSnapshot(storage, documentId),
    )
    return undefined
  }
  loadDocumentArchive(bytes)
  const controller = startDocumentAutosave({ documentId }, modelItemId)
  controller.markDirty()
  await controller.flush()
  const snapshot = await enqueueStorageOperation(
    documentId,
    () => readAutosaveSnapshot(storage, documentId),
  )
  if (!snapshot) {
    throw new Error(`Durable checkpoint for Model Item "${modelItemId}" was not written.`)
  }
  loadDocumentArchive(snapshot.bytes)
  return {
    revision: snapshot.revision,
    storageKey: documentCheckpointStorageKey(projectId, modelItemId),
    bytes: snapshot.bytes,
  }
}

/** File Open already owns validated archive bytes. Persist those bytes
 * directly so an old still-mounted collector from the previous project cannot
 * win collectDocumentArchive's live-first precedence during React's remount.
 * This is a STAGED write: do not dispose the current controller here. A failed
 * or stale Open still owns the old project and its live autosave. The successful
 * replaceLoadedDocumentArchives commit disposes it atomically. */
export async function storeDocumentCheckpointBytes(
  projectId: string,
  modelItemId: string,
  bytes: Uint8Array,
): Promise<DurableDocumentCheckpoint> {
  loadDocumentArchive(bytes)
  const documentId = documentIdForProject(projectId, modelItemId)
  const storage = currentDocumentStorage()
  await enqueueStorageOperation(
    documentId,
    () => writeAutosaveSnapshot(storage, documentId, bytes, 1),
  )
  return {
    revision: 1,
    storageKey: documentCheckpointStorageKey(projectId, modelItemId),
    bytes: new Uint8Array(bytes),
  }
}

/**
 * Read and validate an authored item before Model is allowed to mount.
 * The caller owns navigation and must re-check its request epoch before
 * stashing these bytes; this function deliberately has no holder side effect.
 *
 * WO-348: a revision mismatch used to hard-refuse here ("Durable checkpoint
 * revision mismatch ... CAM was left unchanged so the model cannot be
 * silently replaced by an empty document"), locking the operator out of a
 * model that was, in fact, sitting right there on disk. `expectedRevision` is
 * only ever the CALLER's cached, possibly-stale expectation (store/index.ts's
 * `item.documentRevision`), never a second copy of the truth -- the durable
 * snapshot this function just read IS the truth. So a mismatch here means the
 * cache drifted, not that the document is unrecoverable: decode succeeds
 * below, this function trusts disk, and returns the recovered checkpoint with
 * `recoveryNotice` set instead of throwing. Neither source silently wins,
 * though -- the notice exists so a caller can tell the operator plainly
 * ("recovered from a saved checkpoint; recent edits may be missing") rather
 * than swap generations under them with no word said. An identity mismatch
 * (wrong item/project entirely) and a missing or undecodable snapshot are
 * different failures -- the document genuinely cannot be trusted or read at
 * all -- and keep refusing exactly as before.
 */
export async function hydrateDocumentCheckpoint(
  projectId: string,
  modelItemId: string,
  expectedStorageKey: string,
  expectedRevision?: number,
): Promise<DurableDocumentCheckpoint> {
  const actualKey = documentCheckpointStorageKey(projectId, modelItemId)
  if (expectedStorageKey !== actualKey) {
    throw new Error(`Durable checkpoint identity mismatch for Model Item "${modelItemId}".`)
  }
  const documentId = documentIdForProject(projectId, modelItemId)
  const storage = currentDocumentStorage()
  const snapshot = await enqueueStorageOperation(
    documentId,
    () => readAutosaveSnapshot(storage, documentId),
  )
  if (!snapshot) {
    throw new Error(`Durable checkpoint is missing for Model Item "${modelItemId}".`)
  }
  // Decode BEFORE checking the revision: an undecodable snapshot must refuse
  // regardless of what the caller expected, and a mismatch can only recover
  // once the disk bytes are proven readable.
  loadDocumentArchive(snapshot.bytes)
  let recoveryNotice: string | undefined
  if (expectedRevision !== undefined && snapshot.revision !== expectedRevision) {
    recoveryNotice =
      `This model was recovered from a saved checkpoint (revision ${snapshot.revision}, ` +
      `expected ${expectedRevision}); edits made after that checkpoint may not be included.`
    console.warn(`[documentHolder] ${recoveryNotice} (Model Item "${modelItemId}")`)
  }
  return {
    revision: snapshot.revision,
    storageKey: actualKey,
    bytes: snapshot.bytes,
    ...(recoveryNotice !== undefined ? { recoveryNotice } : {}),
  }
}

/** Structural minimum `ensureDocumentArchiveHydrated` needs from a Model Item
 *  record -- narrowed so this module never imports the full `ModelItemRecord`
 *  type from src/types. */
export interface DocumentArchiveCandidate {
  documentState?: string
  documentStorageKey?: string
  documentRevision?: number
}

/**
 * WO-362 audit fix: the "genuinely cannot recover" outcome of
 * `ensureDocumentArchiveHydrated`, distinguished by TYPE (not by message
 * text) from every other error a caller of this module might throw.
 *
 * Why a type and not a string match: `hydrateDocumentCheckpoint`'s own thrown
 * messages ("Durable checkpoint is missing for Model Item ...", "...identity
 * mismatch...") are load-bearing for `src/tests/doc/revisionMismatchRecovery.wo348.test.ts`
 * and `src/tests/evidence/WO-348/reproduce.mjs`, neither of which is in this
 * WO's owned-paths -- this module must not change what `hydrateDocumentCheckpoint`
 * itself throws. Wrapping instead of rewriting keeps that contract intact
 * while still giving `ensureDocumentArchiveHydrated`'s ONE caller (SetupModal)
 * a reliable `instanceof` check to translate into a plain, actionable sentence
 * instead of this module's internal vocabulary ("durable checkpoint", a raw
 * Model Item id) -- the dead end the audit named at SetupModal.tsx:845.
 */
export class DocumentHydrationFailedError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = 'DocumentHydrationFailedError'
  }
}

/**
 * WO-362: a reader (CAM's bore-pick headless replay, `recognizeModelBodyHoles`
 * / `readModelBodyFaceFacts`) asks `collectDocumentArchive(modelItemId)` for a
 * document this module has never held in THIS page load -- an ordinary
 * browser refresh (or a tab that opened straight into CAM/Setup) leaves
 * `liveCollectors`/`passThroughArchives` empty even though the persisted
 * project still names a real, durable checkpoint for that item
 * (`documentStorageKey`/`documentRevision`, the same fields `openModelItem`
 * already trusts to re-enter the Model workspace). Operator's own evidence file
 * (src/tests/evidence/WO-362) proves the checkpoint is genuinely there: the
 * refusal is a reachability gap, not a missing document. This is `openModelItem`'s
 * own authored/documentStorageKey recovery step (store/index.ts), factored out
 * so a READ path can self-heal the same way the Model-tab NAVIGATION path
 * already does, without requiring the user to visit that tab first.
 *
 * No-ops (never throws) for every "genuinely nothing durable to recover" shape
 * -- an already-hydrated document, an absent item record, or an item that was
 * never authored / never got a storage key. Those are the ordinary "no model"
 * states every caller already refuses on by name. A REAL I/O or decode
 * failure inside `hydrateDocumentCheckpoint` -- the "genuinely cannot recover"
 * case -- propagates wrapped in `DocumentHydrationFailedError` (WO-362 audit
 * fix), so the caller can tell it apart from every other rejection by TYPE and
 * show its own plain, actionable sentence instead of this module's internal
 * vocabulary ("durable checkpoint", a raw Model Item id) or the generic "no 3D
 * model to read" this function exists to stop misreporting.
 */
export async function ensureDocumentArchiveHydrated(
  projectId: string,
  modelItemId: string,
  item: DocumentArchiveCandidate | undefined,
): Promise<void> {
  if (collectDocumentArchive(modelItemId) !== undefined) return
  if (item === undefined || item.documentState !== 'authored' || !item.documentStorageKey) return
  let checkpoint: DurableDocumentCheckpoint
  try {
    checkpoint = await hydrateDocumentCheckpoint(
      projectId, modelItemId, item.documentStorageKey, item.documentRevision,
    )
  } catch (err) {
    throw new DocumentHydrationFailedError(err)
  }
  stashLoadedDocument(checkpoint.bytes, modelItemId)
}

export async function removeDocumentCheckpoint(
  projectId: string,
  modelItemId: string = LEGACY_MODEL_ITEM_ID,
): Promise<void> {
  const documentId = documentIdForProject(projectId, modelItemId)
  const storage = currentDocumentStorage()
  disposeDocumentAutosave(modelItemId)
  await enqueueStorageOperation(
    documentId,
    () => removeAutosaveSnapshot(storage, documentId),
  )
}

export function disposeDocumentAutosave(modelItemId: string = LEGACY_MODEL_ITEM_ID): void {
  controllers.get(modelItemId)?.dispose()
  controllers.delete(modelItemId)
  controllerDocumentIds.delete(modelItemId)
}

/**
 * Recovery, half one: READ an unclean autosave blob for a project, if one
 * exists. Returns undefined when the last session ended clean (the ordinary
 * case) or nothing was ever autosaved -- recoverAutosave's own contract
 * (autosave.ts:138-146).
 *
 * Deliberately does NOT stash: a recovery is the user's decision, not ours (a
 * blob that is newer than the file may be work they want, or a crashed
 * experiment they do not). The caller asks; `acceptDocumentAutosaveRecovery`
 * below is the only way an answer of "yes" becomes state.
 */
export async function readDocumentAutosaveRecovery(projectId: string): Promise<AutosaveRecovery | undefined> {
  const documentId = documentIdForProject(projectId)
  const storage = currentDocumentStorage()
  return enqueueStorageOperation(
    documentId,
    () => recoverAutosave(storage, documentId),
  )
}

/**
 * Recovery, half two: ACCEPT a recovery -- the ONE function that validates and
 * stashes recovered bytes.
 *
 * WO INT-14-R1 (audit MAJOR). The previous shape only ever returned raw bytes
 * while its comment claimed they routed through stashLoadedDocument; nothing
 * did the routing, and the only test that appeared to prove it called
 * stashLoadedDocument itself, by hand, right after -- so the test passed while
 * the product had no recovery path at all. Routing HERE is what makes the claim
 * true: a recovered document decodes, validates and seeds through exactly the
 * path a file open uses, which also means it inherits that path's fail-loud
 * behavior on a newer/corrupted blob (ADR-0003) rather than needing its own.
 */
export function acceptDocumentAutosaveRecovery(
  recovery: AutosaveRecovery,
  modelItemId: string = LEGACY_MODEL_ITEM_ID,
): LoadedDocument {
  return stashLoadedDocument(recovery.bytes, modelItemId)
}

/** Full teardown. Tests use this to guarantee module state never leaks between
 *  cases; the store uses it on New Project.
 *
 *  Clears every key's document/autosave state, not just the legacy one (a
 *  reset is a full teardown regardless of how many items exist), then bumps
 *  every known key's generation -- exact parity with the pre-step-4
 *  singleton, which always incremented its one `generation` counter and
 *  notified current subscribers on every reset call, regardless of prior
 *  state. Generation counts and subscriptions themselves are NOT cleared
 *  here (the singleton never cleared them either): a listener is owned by a
 *  mounted component and is removed only by its own unsubscribe, never by a
 *  reset -- clearing it here would silently drop a still-mounted component's
 *  ability to hear the NEXT load. */
export function resetDocumentHolder(): void {
  liveCollectors.clear()
  liveSessions.clear()
  passThroughArchives.clear()
  pendingSeeds.clear()
  heldDrawings.clear()
  documentStorage = null
  for (const modelItemId of [...controllers.keys()]) disposeDocumentAutosave(modelItemId)
  const knownIds = new Set<string>([...generations.keys(), ...generationListeners.keys(), LEGACY_MODEL_ITEM_ID])
  for (const modelItemId of knownIds) bumpGeneration(modelItemId)
}

/** WO INT-17C Stage C3: per-item teardown for a DELETED Model Item — the
 *  scoped sibling of resetDocumentHolder's full-project reset above. Deleting
 *  one item must not touch any other item's live document, autosave
 *  controller, or pending seed, so this only ever clears the ONE modelItemId
 *  key from every map, mirroring resetDocumentHolder's own per-key shape
 *  (autosave disposed first, generation bumped last so any still-subscribed
 *  listener — a component that has not yet unmounted — observes "no
 *  document" rather than stale state).
 *
 *  INT-MODEL-UNIFY revision: this USED to say "never call with
 *  LEGACY_MODEL_ITEM_ID — project.modelItems only ever grows non-legacy
 *  entries after v12" — that was true only because nothing ever claimed the
 *  legacy slot into project.modelItems at runtime (the exact gap this WO
 *  closes: a project modeled via the plain Model tab produced real geometry
 *  with no visible/deletable Model Item row). The legacy item is now a
 *  first-class ModelItemRecord like any other once claimed (enterModelWorkspace
 *  / openModelItem's self-heal, store/index.ts) — rename already worked on
 *  it with no exclusion, and delete now does too: removeModelItem's own
 *  cascade (resolveOwningModelItemId-scoped, modelOrigin.ts) removes its
 *  owned geometry rows and calls this function exactly like for any other
 *  item, correctly tearing down its live/pending/autosave state so the
 *  legacy `document` slot is genuinely empty afterward (the next save omits
 *  the field, matching "the item that could regenerate it is gone").
 *  Generation listeners/subscriptions themselves are NOT cleared here, same
 *  reasoning as resetDocumentHolder: they are owned by whatever component
 *  subscribed and are removed only by its own unsubscribe. */
export function disposeModelItem(modelItemId: string): void {
  liveCollectors.delete(modelItemId)
  liveSessions.delete(modelItemId)
  passThroughArchives.delete(modelItemId)
  pendingSeeds.delete(modelItemId)
  heldDrawings.delete(modelItemId)
  disposeDocumentAutosave(modelItemId)
  bumpGeneration(modelItemId)
}
