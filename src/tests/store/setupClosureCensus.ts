// CAM-12-R3 - the committed dereference-closure census.
//
// Every entry below maps ONE field path that tools/deriveSetupClosure.mjs
// mechanically derived (a real ts.Program AST scan over every checker-resolved
// Setup/WCS/Stock/Operation access in src/ - see that script's header) to how
// this WO's reconcile boundary treats it. loadCensusCam12.test.ts diffs the
// LIVE derivation against `CENSUS_PATHS` below on every run: a path the
// extraction finds that is missing from this table is a RED failure NAMING
// the path (the STOP-ruling mechanism - see coordination/DECISIONS.md
// "2026-07-15 - CAM-12 two-bounce STOP"). Adding a field to the table without
// the extraction independently finding it is equally wrong (the table would
// silently over-claim coverage), so the test also asserts the reverse
// direction: no CENSUS_PATHS entry may be absent from the live derivation.
//
// SCOPE BOUNDARY (preflight-verified, binding): only Setup, WCS, Stock, and
// Operation are tracked; fields of records OUTSIDE these four (geometry,
// nests, tools, stocks collection, machine) are OUT OF SCOPE for this WO even
// where a Setup consumer reaches them by id. Vec3-typed fields (origin, xAxis,
// yAxis, zAxis, snapLocalPt) are LEAVES validated as a shape ("present as an
// object with finite numeric x/y/z"), never recursed into per-axis. Primitive
// fields are leaves ("declared primitive type or absent"). By-id reference
// fields (wcs.stockId, wcs.snapGeoId, op.toolId) are validated for TYPE only
// (string-or-absent) - dangling ids are refusal-safe by construction (every
// consumer resolves them through .find/.some and tolerates undefined).
//
// CATEGORIES:
//   'quarantine-setup'    - a malformed value drops the WHOLE setup (the R1/R2
//                            malformed-record downgrade, extended this round).
//   'quarantine-op'       - a malformed value drops just that ONE op (existing
//                            R1 machinery, extended this round for params/
//                            heights); siblings + the setup are untouched.
//   'tolerated'           - dereferenced somewhere in src/, but the shape
//                            CANNOT throw at the load/first-render boundary
//                            (a safe comparison, a null-guarded helper, or a
//                            template-string/arithmetic use that coerces
//                            rather than throwing) - no quarantine rule, but
//                            still needs a fuzz case proving no-throw.
//   'residual-pre-boundary' - dereferenced BEFORE this WO's reconcile boundary
//                            can even run (persistMigrate's pre-v1 migration
//                            chain, migrateHierarchy.ts - a file OUTSIDE this
//                            WO's ownership manifest). Documented + proven,
//                            NOT fixed - see the migrate-path posture note at
//                            the bottom of this file and the R3 test describe
//                            block "migrate-path residual".
export type ClosureCategory =
  | 'quarantine-setup'
  | 'quarantine-op'
  | 'tolerated'
  | 'residual-pre-boundary'

export interface ClosureCensusEntry {
  path: string
  category: ClosureCategory
  rule: string
}

export const CENSUS: ClosureCensusEntry[] = [
  // ---- Setup ----
  { path: 'Setup.id', category: 'tolerated', rule: 'string-or-absent; .find()/=== comparisons never throw regardless of runtime type' },
  { path: 'Setup.name', category: 'tolerated', rule: 'string-or-absent; matchesFilter short-circuits on the default empty query before ever calling .toLowerCase() on it' },
  { path: 'Setup.operations', category: 'quarantine-setup', rule: 'R1/R2 floor: must be an Array' },
  { path: 'Setup.stock', category: 'quarantine-setup', rule: 'R3 NEW: must be a non-null object (PropertiesPanel.tsx:691 setup.stock.type - the ONLY Stock field any consumer dereferences)' },
  { path: 'Setup.wcs', category: 'quarantine-setup', rule: 'R3 NEW: must be a non-null object with finite origin/xAxis/yAxis/zAxis (isMalformedWcs) - orthonormality NOT required' },
  { path: 'Setup.operationFolders', category: 'tolerated', rule: 'Operation-folder UI grouping (folders v1). CAM-12-R3-R4 fix: DesignTree.tsx now Array.isArray-guards it before .filter/collectOperationFolderTreeIds (a malformed-but-truthy persisted value previously reached those unguarded and threw at first render, same class as contourTabPreview.loops below); the folder-CRUD dispatch sites in store/index.ts (add/remove/rename/enable) are event-gated only, never on the automatic load path.' },
  { path: 'Setup.defaultHeightIntent', category: 'tolerated', rule: 'setupDefaultHeightIntent() reads it through nullish coalescing and supplies the default intent when absent; a malformed value can affect later event-gated editing or regeneration, but cannot throw on the automatic load/first-render path.' },
  // ---- Census re-cut 2026-08-20: 16 field paths dereferenced in src/ since the last census (fixture stack / support plane WO-227, flip setups WO-288, Smart Height V2, program context WO-379/WO-412) ----
  { path: 'Setup.fixtureStack', category: 'tolerated', rule: 'WO-227 fixture stack. Viewport.tsx reads it only as `setup.fixtureStack ?? []` (JSON key) and through resolveSetupSupportPlane -> setupFixtureStack (lib/cam/types.ts), which Array.isArray-guards and per-item shape-coerces before use; SetupModal edits are event-gated. A malformed persisted value resolves to an empty stack, never throws.' },
  { path: 'Setup.supportPlane', category: 'tolerated', rule: 'WO-227 support plane. Viewport.tsx reads it as `setup.supportPlane ?? null` (JSON key) and through resolveSetupSupportPlane -> setupSupportPlane (lib/cam/types.ts), which falls back to the default mode when `stored.mode` is not a known literal and Number.isFinite-guards offset/customZ - a malformed value resolves to the default plane, never throws.' },
  { path: 'Setup.notes', category: 'tolerated', rule: 'Free-text setup notes. Only carried verbatim into the program-context snapshot (lib/machine/programContext.ts buildProgramContext, built at post time / Program-tab load - user-gated, never on the automatic load/first-render path); no method is ever called on it.' },
  { path: 'Setup.flipOf', category: 'tolerated', rule: 'WO-288 second-side relationship. removeSetup (store/index.ts) reads it optional-chained (`st.flipOf?.setupId`, event-gated); ProbingPanel.tsx truthy-checks it then passes `setup.flipOf.setupId`/`.axis` to planSecondSideSetup, which resolves the parent by .find and returns a FLIP_PARENT_MISSING refusal for any unresolvable id - a wrong-typed value reads as a dangling relationship, never throws; programContext carries it verbatim (post time).' },

  // ---- WCS (nested under Setup.wcs; only reachable once Setup.wcs itself passes the object check above) ----
  { path: 'WCS.origin', category: 'quarantine-setup', rule: 'R3 NEW: part of the wcs shape predicate - finite Vec3 leaf' },
  { path: 'WCS.xAxis', category: 'quarantine-setup', rule: 'R3 NEW: part of the wcs shape predicate - finite Vec3 leaf' },
  { path: 'WCS.yAxis', category: 'quarantine-setup', rule: 'R3 NEW: part of the wcs shape predicate - finite Vec3 leaf' },
  { path: 'WCS.zAxis', category: 'quarantine-setup', rule: 'R3 NEW: part of the wcs shape predicate - finite Vec3 leaf' },
  { path: 'WCS.stockId', category: 'tolerated', rule: 'by-id ref, string-or-absent; every consumer (SimulationPanel :653, DesignTree stockInvalid, syncStockSimSurface) tolerates a dangling/absent id' },
  { path: 'WCS.label', category: 'tolerated', rule: 'string-or-absent; matchesFilter short-circuits on the default empty query (same reasoning as Setup.name)' },
  { path: 'WCS.id', category: 'tolerated', rule: 'string-or-absent; SetupModal only (event-gated), never dereferenced on the load/first-render path' },
  { path: 'WCS.fixtureOffset', category: 'tolerated', rule: 'number-or-absent; g10Line/dimWord and PostProcessModal are post-time/user-gated, no load-path throw' },
  { path: 'WCS.cornerRow', category: 'tolerated', rule: 'number-or-absent; migrate/event-gated (deriveOriginBinding, SetupModal), safe compares only' },
  { path: 'WCS.cornerCol', category: 'tolerated', rule: 'number-or-absent; migrate/event-gated, safe compares only' },
  { path: 'WCS.cornerFace', category: 'tolerated', rule: 'string-or-absent; migrate/event-gated, safe compares only' },
  { path: 'WCS.snapGeoId', category: 'tolerated', rule: 'by-id ref, string-or-absent; migrate/event-gated, .find()-style resolution tolerates absence' },
  { path: 'WCS.snapLocalPt', category: 'tolerated', rule: 'Vec3 leaf, but migrateHierarchy.ts cloneVec(v) is already null-safe (`v ? {...} : ZERO_VEC`) - cannot throw' },
  { path: 'WCS.originBinding', category: 'residual-pre-boundary', rule: 'migrateHierarchy.ts:261 (the always-reached migration step; :96\'s isFullyMigrated fast-path also reads it, gated behind hasDerived) dereferences setup.wcs.originBinding for PRE-V1 blobs BEFORE this WO\'s reconcile boundary runs; see the migrate-path posture note below - documented, not fixed (migrateHierarchy.ts is outside this WO\'s ownership manifest)' },

  // ---- Stock (nested under Setup.stock) ----
  { path: 'Stock.type', category: 'tolerated', rule: 'string leaf read at PropertiesPanel.tsx:691 for DISPLAY only - a non-string type renders oddly but does not throw; the throw risk is `stock` itself being null (Setup.stock\'s own quarantine-setup rule above), not this field\'s shape' },
  { path: 'Stock.width', category: 'tolerated', rule: 'number-or-absent; the ONLY consumer is lib/machine/programContext.ts authoredStockSnapshot/authoredStockBounds (`stock.width ?? null` / `Math.max(0, stock.width ?? 0)` - nullish-coalesced, arithmetic coerces rather than throws), built at post time / Program-tab load - user-gated, never on the automatic load/first-render path.' },
  { path: 'Stock.height', category: 'tolerated', rule: 'number-or-absent; the ONLY consumer is lib/machine/programContext.ts authoredStockSnapshot/authoredStockBounds (`stock.height ?? null` / `Math.max(0, stock.height ?? 0)` - nullish-coalesced, arithmetic coerces rather than throws), built at post time / Program-tab load - user-gated, never on the automatic load/first-render path.' },
  { path: 'Stock.depth', category: 'tolerated', rule: 'number-or-absent; the ONLY consumer is lib/machine/programContext.ts authoredStockSnapshot/authoredStockBounds (`stock.depth ?? null` / `Math.max(0, stock.depth ?? 0)` - nullish-coalesced, arithmetic coerces rather than throws), built at post time / Program-tab load - user-gated, never on the automatic load/first-render path.' },
  { path: 'Stock.diameter', category: 'tolerated', rule: 'number-or-absent; the ONLY consumer is lib/machine/programContext.ts authoredStockSnapshot/authoredStockBounds (`stock.diameter ?? null` / `Math.max(0, stock.diameter ?? 0)` - nullish-coalesced, arithmetic coerces rather than throws), built at post time / Program-tab load - user-gated, never on the automatic load/first-render path.' },
  { path: 'Stock.length', category: 'tolerated', rule: 'number-or-absent; the ONLY consumer is lib/machine/programContext.ts authoredStockSnapshot/authoredStockBounds (`stock.length ?? null` / `Math.max(0, stock.length ?? 0)` - nullish-coalesced, arithmetic coerces rather than throws), built at post time / Program-tab load - user-gated, never on the automatic load/first-render path.' },
  { path: 'Stock.offsetX', category: 'tolerated', rule: 'number-or-absent; the ONLY consumer is lib/machine/programContext.ts authoredStockSnapshot (`stock.offsetX ?? 0`, nullish-coalesced into the snapshot), built at post time / Program-tab load - user-gated, never on the automatic load/first-render path.' },
  { path: 'Stock.offsetY', category: 'tolerated', rule: 'number-or-absent; the ONLY consumer is lib/machine/programContext.ts authoredStockSnapshot (`stock.offsetY ?? 0`, nullish-coalesced into the snapshot), built at post time / Program-tab load - user-gated, never on the automatic load/first-render path.' },
  { path: 'Stock.offsetZTop', category: 'tolerated', rule: 'number-or-absent; the ONLY consumer is lib/machine/programContext.ts authoredStockSnapshot (`stock.offsetZTop ?? 0`, nullish-coalesced into the snapshot), built at post time / Program-tab load - user-gated, never on the automatic load/first-render path.' },
  { path: 'Stock.offsetZBottom', category: 'tolerated', rule: 'number-or-absent; the ONLY consumer is lib/machine/programContext.ts authoredStockSnapshot (`stock.offsetZBottom ?? 0`, nullish-coalesced into the snapshot), built at post time / Program-tab load - user-gated, never on the automatic load/first-render path.' },
  { path: 'Stock.material', category: 'tolerated', rule: "string-or-absent; lib/machine/programContext.ts carries it verbatim into the stock snapshot (`setup.stock?.material ?? ''` and `material: setup.stock.material`) at post time / Program-tab load - user-gated; no method is ever called on it, never throws." },

  // ---- Operation ----
  { path: 'Operation.id', category: 'tolerated', rule: 'string-or-absent; safe compares only' },
  { path: 'Operation.name', category: 'tolerated', rule: 'string-or-absent; embedded in downgrade/console messages (template-string coercion, never throws) and DesignTree filter (default-query short-circuit, same as Setup.name)' },
  { path: 'Operation.type', category: 'tolerated', rule: 'string leaf; Viewport.tsx op.type !== \'adaptive_3d\' safe compare only' },
  { path: 'Operation.enabled', category: 'tolerated', rule: 'boolean leaf; used only in truthy filters (.filter(o => o.enabled)), any value is safe' },
  { path: 'Operation.status', category: 'quarantine-op', rule: 'R1 floor: computing heals to outdated; ready without a present toolpath downgrades to outdated (opHasPresentToolpath)' },
  { path: 'Operation.toolId', category: 'tolerated', rule: 'by-id ref, string-or-absent; toolLibrary.find(t => t.id === op.toolId) tolerates a dangling/absent id' },
  { path: 'Operation.geometrySelections', category: 'tolerated', rule: 'array field read only in event-gated paths (geometry-delete outdate sweep, Regen compute, modal editors) - never on the automatic load/first-render path' },
  { path: 'Operation.modelReferences', category: 'tolerated', rule: 'CAM-1 model-reference re-resolution runs on Regen (user-initiated compute), never automatically on load' },
  { path: 'Operation.modelReferenceNote', category: 'tolerated', rule: 'string-or-absent, rendered in PropertiesPanel/DesignTree tooltips only when the op is already \'degraded\'/\'outdated\' - template-string/optional-chain use, never throws' },
  { path: 'Operation.outdatedReason', category: 'tolerated', rule: 'WO-2663 object-or-absent; DesignTree/PropertiesPanel render it only when truthy and the op is \'outdated\', and outdatedReasonText switches on `.kind` with a default - a wrong-typed value reads as the generic "inputs" reason, never throws; the store compares it by identity only' },
  { path: 'Operation.heights', category: 'quarantine-op', rule: 'R3 NEW: must be a non-null object (Viewport.tsx:742 activeOp.heights.clearanceHeight throws on null/absent when height planes are shown)' },
  { path: 'Operation.passes', category: 'tolerated', rule: 'operation-specific params object, read only by NewOperationModal (event-gated: opening the op editor) and compute-time (Regen) - never on the automatic load path' },
  { path: 'Operation.linking', category: 'tolerated', rule: 'operation-specific params object, event-gated (NewOperationModal) and compute-time only, same reasoning as passes' },
  { path: 'Operation.feedrateOverride', category: 'tolerated', rule: 'optional object; PropertiesPanel/NewOperationModal are event-gated, compute-time resolveFeedrates() reads it only during Regen' },
  { path: 'Operation.params', category: 'quarantine-op', rule: 'R3 NEW: must be a non-null object (SimulationPanel.tsx toolpathKey selector reads `(o.params as {geometryId?}).geometryId` unguarded - throws on null/absent for any enabled op, at first render)' },
  { path: 'Operation.toolpathMoves', category: 'quarantine-op', rule: 'R1 floor: opHasPresentToolpath requires a non-empty array of finite-coordinate moves for a \'ready\' op to keep its status' },
  { path: 'Operation.computeTimeMs', category: 'tolerated', rule: 'number-or-absent, display/arithmetic only (never throws); already cleared on any downgrade by stripComputeClaim' },
  { path: 'Operation.estimatedCutTimeMs', category: 'tolerated', rule: 'number-or-absent, display/arithmetic only (never throws); already cleared on any downgrade by stripComputeClaim' },
  { path: 'Operation.estimatedCutTimeMsError', category: 'tolerated', rule: 'SIM-7 estimate-refusal message: string-or-absent; truthy checks + title/display render only (DesignTree.tsx find predicate, PropertiesPanel.tsx conditional render) - never throws. Classified at CAM-12 merge reassembly per its estimatedCutTimeMs sibling (census fired RED on the SIM-7 merge exactly as designed).' },
  { path: 'Operation.errorMessage', category: 'tolerated', rule: 'string-or-absent, rendered/template-string only, never throws' },
  { path: 'Operation.progress', category: 'tolerated', rule: 'number-or-absent, display/arithmetic only; already cleared on any downgrade by stripComputeClaim' },
  { path: 'Operation.progressPhase', category: 'tolerated', rule: 'string-or-absent, display only; already cleared on any downgrade by stripComputeClaim' },
  { path: 'Operation.folderId', category: 'tolerated', rule: 'Operation-folder UI grouping (folders v1); DesignTree.tsx only ever compares it with nullish-coalesce (`op.folderId ?? null) === folderId`) or a Set.has() lookup - safe for any runtime type, dangling ids tolerated by construction' },
  { path: 'Operation.diagnostics', category: 'tolerated', rule: 'Structured strategy diagnostics (adaptive-rough region counts). PropertiesPanel.tsx reads only `op.diagnostics?.adaptiveRough` - optional-chained, a wrong-typed value reads as undefined and never throws' },
  { path: 'Operation.generationFingerprint', category: 'tolerated', rule: "CAM-15 generation-freshness stamp. Read only via `typeof operation.generationFingerprint === 'string'` (operationGenerationIsCurrent) and a plain `===` comparison against the freshly recomputed hash (reconcileProjectGenerationFreshness) - never dereferenced as an object, never throws regardless of shape" },
  // Operation.heightSource: RETIRED (2e5678b7 Smart Height V2-only cutover removed the field; no consumer in src/ dereferences it) - the row is gone so the reverse-direction stale-entry check stays honest.
  { path: 'Operation.resolvedHeights', category: 'tolerated', rule: "CAM-15 resolved-height snapshot. Every load-path read is version-gated (`op.resolvedHeights?.version === 1` before dereferencing `.wcs`/`.machine`) in reconcileProjectGenerationFreshness/operationGenerationIsCurrent and PropertiesPanel.tsx's displayBottom. CAM-12-R3-R4 fix: PropertiesPanel.tsx's topZAbs previously read `.machine.top` unguarded (no version check) and threw on a malformed-but-present value; now gated the same way displayBottom already was." },
  { path: 'Operation.smartHeight', category: 'tolerated', rule: "Smart Height V2 authority envelope. Every automatic load/first-render read goes through validatePersistedSmartHeightState (lib/cam/smartHeights/authority.ts: a `record()` shape check that RETURNS {ok:false} for null/number/string/{}; used by reconcileProjectGenerationFreshness/operationGenerationIsCurrent and PropertiesPanel.tsx) or is an `=== undefined` compare / JSON.stringify key. The throwing readers (ensureOperationSmartHeightAuthority, the store's Parallel-3D runtime resolution) run only inside compute (Regen) or an event-gated save - never on load." },
  { path: 'Operation.resolvedHeightPlan', category: 'tolerated', rule: "Smart Height V2 resolved plan snapshot. Load-path reads are version-gated (`op.resolvedHeightPlan?.version === 2`) in reconcileProjectGenerationFreshness/operationGenerationIsCurrent; NewOperationModalBody is event-gated; programContext carries it verbatim at post time. Census re-cut 2026-08-20 FIX: PropertiesPanel.tsx fell back to the persisted plan unguarded and dereferenced `resolvedHeightPlan?.machining.cutterCenterEnd` (threw at first render for a malformed-but-present value such as {} or 42); now gated on `.version === 2` the same way generationFingerprint.ts already was." },
  { path: 'Operation.contourTabPreview', category: 'tolerated', rule: "Tabs v2 D3 derived preview (finish-contour loops + tabTopZ), written by the store after dispatch - never user-authored. CAM-12-R3-R4 fix: Viewport.tsx and PropertiesPanel.tsx (contourTabPreviewReady + beginTabEdit) now Array.isArray-guard `.loops` before `.length`/iteration; a malformed-but-truthy persisted value previously threw unguarded at first render. WO-1818 RESOLVED: persistPartialize and saveProjectToFile/packageProjectToFile (store/index.ts) both now strip this field via persistenceRegistry.ts's stripOperationForPersistence (treatment 'always-strip') - the localStorage rehydrate blob and the saved .camproject file both drop it, so a downgraded/reloaded op can no longer carry a stale preview that disagrees with its (cleared) toolpath; the next contour compute re-derives it." },
  { path: 'Operation.reachShortfall', category: 'tolerated', rule: "WO-1683: the reach trim's stopped-short fact (reachedZ/askedZ/uncutMm), written by the store after dispatch - never user-authored. DesignTree.tsx's reachShortfallBadge and PropertiesPanel.tsx both gate on isValidReachShortfall (ReachShortfallNotice.tsx: a Number.isFinite check on all three fields) before reading any of them - a malformed-but-truthy persisted value reads as absent, never throws." },
]

/** Fast lookup by path for the diff test. */
export const CENSUS_PATHS = new Set(CENSUS.map((e) => e.path))

// ---- MIGRATE-PATH POSTURE (WO requirement 7) ----
//
// persistMigrate itself dereferences setup.wcs.originBinding for pre-v1 blobs
// (migrateHierarchy.ts:261, the migration step's `project.setups.map(setup =>
// { if (setup.wcs.originBinding != null) ... })` - ALWAYS reached for a
// genuine v0 blob; isFullyMigrated's :96 fast-path reads the same field but is
// gated behind `hasDerived`, which is false for a fresh v0 project, so :261 is
// the reproducible site - REPRODUCED empirically below, not assumed) BEFORE
// the reconcile boundary (reconcileLoadedOpLifecycle) ever runs;
// current-schema (v6) blobs short-circuit the migration chain entirely
// (runMigrationChain returns the input unchanged when from === current,
// projectMigrations.ts) and are unaffected. The v0->v1 step (the only one
// reaching migrateProjectToHierarchy) runs ONLY when a project's OWN
// schemaVersion is 0/absent - i.e. this is reachable only for a genuinely
// pre-v1 (pre-2026, or hand-stripped) project document.
//
// CHARACTERIZED (not fixed - migrateHierarchy.ts is outside this WO's
// ownership manifest, and the fix would live there, not in the owned
// reconcile/persist region). This throw lands DIFFERENTLY depending on which
// of the two real callers reaches it (both traced + reproduced empirically,
// see the "CAM-12-R3: migrate-path residual" describe block):
//
//  1. FILE-OPEN leg (loadProjectFromFile, store/index.ts): ALREADY COVERED,
//     pre-existing, unrelated to this WO. `migrateProjectData(parsed)` runs
//     inside its own try/catch (re-throwing only for UnknownSchemaVersionError,
//     store/index.ts ~:3510-3518), which is itself inside the action's OUTER
//     `catch { pushTransientFooterNotice(..., 'Failed to read the file...',
//     'error', ...) }` (store/index.ts ~:3645). A malformed pre-v1 FILE
//     therefore surfaces a visible (if generic) error notice - no crash, no
//     ErrorBoundary, no silent data loss.
//  2. REFRESH/REHYDRATE leg (zustand persist's `migrate` option, this store's
//     `persistMigrate`): NAMED RESIDUAL, uncovered. zustand's persist
//     middleware (node_modules/zustand/esm/middleware.mjs `hydrate()`) invokes
//     `options.migrate` inside a `.then()` chained off `storage.getItem()` -
//     but ONLY when the persisted WRAPPER version (this store's `version: 2`
//     option, a SEPARATE number from the project's own `schemaVersion`)
//     differs from the currently-configured one (i.e. only once, on a
//     zustand-wrapper version bump - ordinary refreshes never re-invoke
//     `migrate` at all, since the wrapper version already matches). A
//     synchronous throw there rejects that promise and skips straight to the
//     internal `.catch((e) => { postRehydrationCallback?.(undefined, e) })` -
//     this store configures no `onRehydrateStorage`, so `postRehydrationCallback`
//     is undefined and the error is swallowed with NO console output, NO
//     ErrorBoundary trip, and `set(stateFromStorage, true)` (persist.mjs line
//     419) is NEVER reached. Net effect: hydration silently aborts and the
//     store stays on its freshly-created DEFAULT project - a SILENT full
//     reversion to a blank project, not a crash. Real, reproducible, but
//     narrow (pre-v1 blob only, AND only on a zustand-wrapper version bump,
//     e.g. an app upgrade) - named here rather than left undiscovered, per
//     requirement 7.
export const MIGRATE_PATH_POSTURE =
  'DOC-7 closed: hierarchy migration skips malformed setup.wcs records so ' +
  'persistMigrate preserves the legacy project; persistMerge then quarantines ' +
  'only the malformed setup through the shared load-boundary reconciliation.'
