// WO UI-24-R2 (root-cause ruling, item b): "skipped[] derives from a CENSUS of every render input
// the component consumes that is not dag-derived (the census method itself committed as a test that
// fails when a new non-dag render input appears)."
//
// This is that census: every `useState`/`useRef` declared directly in SolidsWorkbenchPage.tsx, each
// given an explicit ruling. src/tests/model3d/SolidsWorkbenchPage.stateCensus.test.ts statically
// parses SolidsWorkbenchPage.tsx's own source for every `useState`/`useRef` declaration and asserts
// every single one is a key here -- a FUTURE hook with no entry fails that test, not the loader,
// exactly the "derived, not listed" discipline debugScene.ts's schema validator applies to node/ref
// shapes, applied here to "what render input exists at all".
//
// SCOPE (stated once, honestly): the completeness test's mechanical reach is `useState`/`useRef`
// literally declared in SolidsWorkbenchPage.tsx. A few real render inputs are composite child-hook
// results (`measure`/`appearance`/`section`, each from its own `use*Session` hook file) whose OWN
// internal `useState` calls live in a DIFFERENT file and are outside that mechanical reach --
// documented below anyway (search "composite child-hook"), and their liveness is what
// buildDebugSceneExport's skipped[] checks actually gate on, but the census-completeness test does
// not (cannot, without parsing THOSE files too) enforce their presence the same way.
//
// Rulings:
//  - 'captured'       reflected in DebugSceneExport's own fields; a fresh load reproduces it exactly.
//  - 'skip-when-live'  named in skipped[] by buildDebugSceneExport whenever this state is non-default.
//  - 'transient'       explicitly ruled OUT of this debug channel's scope, reasoning in `note` (this
//                      WO's own allowance: "hover states may be ruled transient... the RULING must be
//                      explicit").
//  - 'internal'        bookkeeping only -- never an independently rendered value a debug-scene viewer
//                      could see on its own (a kernel/runtime handle, a cache, a re-render-trigger
//                      counter mirroring a value already classified elsewhere).

export type CensusRuling = 'captured' | 'skip-when-live' | 'transient' | 'internal'

export interface CensusEntry {
  ruling: CensusRuling
  note: string
}

export const STATE_CENSUS: Readonly<Record<string, CensusEntry>> = {
  // ---- captured directly in DebugSceneExport's own fields ---------------------------------------
  displayMode: { ruling: 'captured', note: 'DebugSceneExport.displayMode field.' },

  // ---- tree/genesis emphasis (audit R1 finding 3) ------------------------------------------------
  selectedId: {
    ruling: 'skip-when-live',
    note: "Combined with hoveredTreeId (glyphNodeId's own precedence) into the genesis emphasis glyph -- named in skipped[] ONLY when it resolves to a GENESIS id (drives a real object added to the three.js scene, buildGenesisGlyph). Selecting an ORDINARY feature changes only the tree-row CSS highlight + a reattach-face-affordance button -- cosmetic, no 3D-scene effect, trivially reproduced by clicking the row again -- so it is deliberately NOT named (would otherwise fire on every scene, since the newly-created feature auto-selects).",
  },
  hoveredTreeId: {
    ruling: 'skip-when-live',
    note: 'Same genesis-only scoping as selectedId -- hovering an ordinary feature row is cosmetic CSS only; hovering a genesis row previews the emphasis glyph and IS named.',
  },

  // ---- UI-4 tool armed + measure/appearance session state (audit R1 finding 3) -------------------
  activeUi4Tool: {
    ruling: 'skip-when-live',
    note: "Which UI-4 tool (measure/appearance) is armed -- toolbar pressed-state, and gates repaintUi4Overlays' body-tint branch. Named in skipped[] whenever not 'none'.",
  },
  kernelCancelEpochRef: { ruling: 'internal', note: "WO-2796: Cancel generation counter - read before Import's async solid-count probe, checked after it, bumped on Cancel so a cancelled import never commits. No scene effect." },
  resizeHoleEditResolveRef: { ruling: 'internal', note: 'WO-2795: token that discards a stale owner-body hole recognition when the Resize Hole edit is begun, finished or re-picked. No scene effect.' },
  activeUi4ToolRef: { ruling: 'internal', note: 'ref mirror of activeUi4Tool kept current for an async effect closure -- see activeUi4Tool.' },
  selectedBodyRowId: {
    ruling: 'skip-when-live',
    note: 'Ordinary BODIES-row selection now drives the shared whole-body orange tint and exact topology outline. Named in skipped[] whenever non-null because that presentation is live interaction state, not dag-derived.',
  },

  // composite child-hook results (see file header SCOPE note) -- documented for a human reader, not
  // reachable by the mechanical useState/useRef parse.
  // measure  (useMeasureSession .state): live-only selection/hover/outcomes -- named in skipped[]
  //          whenever non-default (mode/outcomes/selectedBodyIds/selectedVertex/armedCount/hover).
  // appearance (useAppearanceSession .state): live-only pick target/hover, distinct from the
  //          PERSISTED AppearanceStore colors (already named via appearanceSnapshot) -- named in
  //          skipped[] whenever target/hoveredBodyId is live.

  // WO-2147: the Zebra stripes display toggle (display only, never saved).
  zebra: {
    ruling: 'transient',
    note: 'Zebra stripes display toggle in the Display Mode flyout: a view aid like the projection radios, not saved, never part of the scene the debug channel describes.',
  },
  zebraRef: {
    ruling: 'transient',
    note: 'Mirror of the zebra toggle for the STL creation path; same ruling as zebra.',
  },
  curvature: {
    ruling: 'transient',
    note: 'Curvature colours display toggle in the Display Mode flyout (Form stage 21): a view aid like zebra, not saved.',
  },
  curvatureRef: {
    ruling: 'transient',
    note: 'Mirror of the curvature toggle for the STL creation path; same ruling as curvature.',
  },
  pickHoverInfo: {
    ruling: 'transient',
    note: "Provably gated to the SAME three armed-pick modes (pushPullMode 'arm', dressUpPickMode!=='none', sketchMode 'pick-face' -- handlePickHover's own only three branches) those modes' skipped[] entries already name; cannot be live independent of them.",
  },
  // WO-216 extrude end-condition target picks: armed-pick affordance state,
  // same class as pickHoverInfo - live only while a pick is armed, its
  // hover/preview never survives the pick, and the debug scene reads the
  // DAG's committed extrude target, not the pick in flight.
  extrudeEndTargetPickKind: {
    ruling: 'transient',
    note: 'Which end-target pick mode (face / vertex / part) is armed for the extrude dialog; null outside a pick. Affordance-only, cleared on pick or cancel; the committed target lives in the DAG.',
  },
  extrudeEndTargetHoverBodyId: {
    ruling: 'transient',
    note: 'Body silhouette hovered while a part-mode end-target pick is armed. Same gating as pickHoverInfo; never rendered outside the armed pick.',
  },
  extrudeEndTargetPickRef: {
    ruling: 'internal',
    note: 'Ref mirror of the armed end-target pick (kind + onPicked callback) for the viewport pick callback closure - bookkeeping for the same state extrudeEndTargetPickKind exposes, never rendered.',
  },
  // WO-192 offset-plane face probe ordering.
  offsetPlaneFaceProbeGenerationRef: {
    ruling: 'internal',
    note: 'Monotonic generation counter that rejects stale async face-probe results; pure ordering bookkeeping, no rendered value.',
  },
  offsetPlaneFaceSourceSequenceRef: {
    ruling: 'internal',
    note: 'Sequence id per consecutive face pick so each capture takes its freshly probed frame without DAG residue; ordering bookkeeping only.',
  },
  ambientGenesisGlyphsRef: {
    ruling: 'transient',
    note: 'Mode-owned ambient plane roots rebuilt from canonical genesis ids, the live runtime, and persisted eye preferences; every root is disposed on mode/runtime/visibility change and unmount.',
  },
  referencePlaneGlyphsRef: {
    ruling: 'internal',
    note: "Cache of offset-plane sheet THREE.Object3D handles, rebuilt by its effect from ONLY [runtimeState, dag, dagVersion] -- every visible property (which planes, frames, names, hidden/suppressed) is dag payload (persisted lastGoodFrame), so a fresh load of the captured dag reproduces identical glyphs; the ref adds no independent render input. Distinct from ambientGenesisGlyphsRef ('transient'), whose content also depends on non-dag mode + persisted eye preferences; the build effect's own comment rules these 'document geometry, not transient tool feedback'.",
  },
  hoveredBasePlaneNodeId: {
    ruling: 'transient',
    note: "Pointer-only base-plane emphasis while sketchMode is 'pick-base-plane'; cancel, success, pointer leave, tool switch, and unmount clear it.",
  },
  planePickStatus: {
    ruling: 'transient',
    note: "Pointer-only base-plane picker readout/refusal while sketchMode is 'pick-base-plane'; it has no document or debug-scene meaning.",
  },
  basePlanePickFaceHover: {
    ruling: 'transient',
    note: "SKETCH-ON-FACE-FIX (workplan 4e): true while the unified 'New sketch' pick is hovering a body FACE (not a base plane); drives the crosshair cursor + non-refusal hint styling for that branch. Cleared on cancel/arm/success/pointer-off, same lifecycle as hoveredBasePlaneNodeId; no document or debug-scene meaning.",
  },

  // ---- UI-23 nav pack (merged after UI-24's census was written; classified at the UI-24 merge) ---
  nPickArmed: {
    ruling: 'transient',
    note: 'One-shot keyboard-armed view action (N + click a face -> orientNormalToPoint, disarmed on success or Escape; handleNormalToFacePick). Pure interaction arming with no document effect; its only outcome is the camera pose, which the export already captures via getDebugCameraState.',
  },

  // ---- always-docked Inspect panel: mass properties + measure filter (NEW gap, this WO) ----------
  measureFilterMode: {
    ruling: 'skip-when-live',
    note: "Measure tool's face/edge/vertex/body filter toggle, part of the ALWAYS-mounted Inspect panel (WO UI-13B: 'never toggled in/out of the DOM') -- named in skipped[] whenever not the 'face' default.",
  },
  massBodySelectId: { ruling: 'skip-when-live', note: 'Mass-properties body dropdown selection, always-docked panel -- named in skipped[] whenever non-null.' },
  materialId: { ruling: 'skip-when-live', note: 'Mass-properties material choice, always-docked panel -- named in skipped[] whenever not the BUILTIN_MATERIALS[0] default.' },
  customDensity: { ruling: 'skip-when-live', note: 'Mass-properties custom-density override, always-docked panel -- named in skipped[] whenever not the 2.7 default.' },
  massProps: {
    ruling: 'internal',
    note: 'Pure kernel-computed function of (massBodyId, materialId, customDensity) that auto-recomputes for the first live body the instant one exists -- not a distinguishing user action; a reload reproduces it automatically once its OWN inputs (already classified) match. NOT included in the Inspect-panel skip check (would otherwise fire on every nontrivial scene).',
  },
  massBusy: { ruling: 'skip-when-live', note: 'Mass-properties busy spinner, always-docked panel -- named in skipped[] whenever true.' },
  lastRefusalNotifiedBodyIdRef: {
    ruling: 'internal',
    note: "WO-1455: dedup ref for the console line posted when measure('volume') refuses a body (open shell, not a closed solid) -- the panel itself shows no numbers and no replacement text for it. Not a distinguishing user action; a reload re-derives the same refusal from the live body the next time the effect runs.",
  },

  // ---- previously-shipped skipped[] entries (WO UI-24 / UI-24-R1) -- kept here for closure --------
  sketchMode: { ruling: 'skip-when-live', note: 'Active in-progress sketch session -- named in skipped[] whenever kind !== none.' },
  dialog: { ruling: 'skip-when-live', note: "Open dialog's unsaved draft field values -- named in skipped[] whenever kind !== none." },
  pushPullMode: { ruling: 'skip-when-live', note: "Armed/mounted push-pull gesture -- named in skipped[] whenever kind !== 'none'." },
  pushPullDraftText: {
    ruling: 'transient',
    note: "WO UI-57: the ONE controlled-draft string driving the push/pull AnchoredValueEntry (both the live drag readout and the typed two-stage entry) -- folded into pushPullMode==='mounted''s existing skipped[] entry, not a second independent entry. Replaces the retired pushPullTypedDelta/pushPullTypedDeltaRef (WO UI-16), which this WO's AnchoredValueEntry adoption made vestigial (the delta is now parsed from the draft string as a direct call argument at each call site, never a shared numeric ref).",
  },
  dressUpPickMode: { ruling: 'skip-when-live', note: "Armed dress-up (fillet/chamfer/shell/draft/hole) pick mode -- named in skipped[] whenever kind !== 'none'." },
  resizeHolePickMode: {
    ruling: 'skip-when-live',
    note: "WO UI-58: armed resize-hole pick mode (hover-only 'arm', or 'armed' with a selected hole + the anchored value entry's uncommitted draft diameter) -- named in skipped[] whenever kind !== 'none', same shape as dressUpPickMode above.",
  },
  resizeHoleRecognizing: {
    ruling: 'transient',
    note: "WO UI-58: busy flag for the in-flight per-body recognizeFeatures fetch feeding resizeHoleVerdictsRef -- folded into resizeHolePickMode's own skipped[] entry (its message names 'recognizing features' while true), not a second independent entry, same pattern as pushPullDraftText folding into pushPullMode's entry.",
  },
  resizeHoleVerdictsTick: {
    ruling: 'transient',
    note: 'WO UI-58: re-render trigger bumped whenever resizeHoleVerdictsRef is repopulated -- mirrors ui4RepaintTick/dagVersion; not an independent value.',
  },
  resizeHoleEditRequest: {
    ruling: 'transient',
    note: "BK-174: a pending FeatureTree Edit on an existing resizeHole node, waiting for the recognize-all-live-bodies effect to warm the verdict cache before it auto-resolves into resizeHolePickMode's own 'armed' state (which already carries the outcome via its own skipped[] entry above). Always null by the time any user-visible state settles -- the resolving effect clears it synchronously the instant it acts, same 'in-flight coordination signal, not itself a rendered value' shape as resizeHoleRecognizing.",
  },

  // ---- ephemeral operation-result banners: ruled transient ---------------------------------------
  status: {
    ruling: 'transient',
    note: "Boot/status banner text ('booting...', 'initializing geometry kernel...') -- an export can only run once the page reports ready, so this is always the terminal 'ready' string at export time; not scene state.",
  },
  geometryInitFailed: {
    ruling: 'transient',
    note: 'WO-091: set only once AUTOMATIC geometry-kernel recovery is exhausted, and read only to colour the status line red (there is no control beside it). A remount starts a fresh boot and clears it; it never describes the modeled scene.',
  },
  solverState: {
    ruling: 'transient',
    note: "WO-108: what the CONSTRAINT SOLVER's own boot is doing ('loading' | 'ready' | 'unavailable'), read only to render the status strip's solver disclosure. A remount reboots the solver from 'loading'; it describes a subsystem's liveness, never the modeled scene.",
  },
  solverAvailabilityRef: {
    ruling: 'internal',
    note: "WO-120: the SAME value as solverState, in the form the sketch ports can read (a stable ref published through bindSketchSessionDeps' get solverStatus()). Written only by setSolverAvailability, alongside the state, so the status strip and the action seams cannot disagree. Subsystem liveness, never scene state.",
  },
  solverElapsedS: {
    ruling: 'transient',
    note: 'WO-108: whole seconds the current solver boot has been running, so the loading message keeps moving instead of freezing. Null once the solver settles either way; pure liveness display.',
  },
  exportError: { ruling: 'transient', note: 'STEP-export failure banner -- describes the outcome of a PAST action, not present scene state; stale the instant a new attempt is made.' },
  debugExportError: { ruling: 'transient', note: 'Debug-scene EXPORT failure banner -- same reasoning as exportError.' },
  debugSceneLoadStatus: {
    ruling: 'transient',
    note: "Debug-scene IMPORT result banner ('ok'/error text) -- describes the outcome of the load that just happened, not the loaded scene's own state (which is captured/skipped via every OTHER entry in this census).",
  },
  pushPullRefusal: { ruling: 'transient', note: 'Push/pull gesture refusal-reason banner -- same reasoning as exportError; the gesture itself (if still mounted) is already named via pushPullMode.' },

  // ---- feature-tree folder UI chrome: ruled transient --------------------------------------------
  foldersVersion: { ruling: 'transient', note: 're-render trigger mirroring foldersRef -- not itself a value.' },
  foldersRef: {
    ruling: 'transient',
    note: 'Feature-tree folder membership/organization (TreeFolderStore) -- tree-panel presentation, not 3D scene geometry; the underlying feature/geometry membership IS captured via dag.serialize(), only the folder GROUPING chrome is not. Out of this debug channel\'s stated scope (dag + camera + display + plane visibility).',
  },
  collapsedFoldersRef: { ruling: 'transient', note: 'Which folders are expanded/collapsed in the tree -- same ruling as foldersRef.' },

  // ---- re-render-trigger counters: not independent values ----------------------------------------
  paramsVersion: {
    ruling: 'transient',
    note: "Re-render trigger for the parameters table -- mirrors dag's own parameter nodes ('parameters are ordinary DAG nodes', dag.ts), which ARE captured via dag.serialize(); not an independent value.",
  },
  ui4RepaintTick: {
    ruling: 'transient',
    note: 'Re-render trigger for repaintUi4Overlays -- mirrors pickHighlightSelectionRef/bridge.selection/appearance/measure state, each already classified above; not an independent value.',
  },
  dagVersion: { ruling: 'transient', note: "Re-render trigger mirroring `dag`'s own mutations -- dag itself is captured via dag.serialize(); not an independent value." },

  // ---- kernel/runtime/session handles: not render inputs on their own ----------------------------
  bridgeSession: { ruling: 'internal', note: "GeomBridgeSession object handle -- a wiring seam; its OWN .selection is captured via the measure/appearance/pickHoverInfo entries above." },
  bridgeSessionRef: { ruling: 'internal', note: 'ref mirror of the GeomBridgeSession handle -- see bridgeSession.' },
  runtimeState: { ruling: 'internal', note: "SceneRuntime object handle -- the runtime's actual camera/display output IS captured via the camera/displayMode fields." },
  runtimeRef: { ruling: 'internal', note: 'ref mirror of the SceneRuntime handle -- see runtimeState.' },
  canvasRef: { ruling: 'internal', note: 'the <canvas> DOM node itself.' },
  bootOwnershipEpochRef: {
    ruling: 'internal',
    note: 'MODEL-TRANSITION-RELIABILITY mount-generation counter. It only prevents stale async boot continuations from publishing into a replacement runtime; it is bookkeeping, never an independently rendered value.',
  },
  importStepInputRef: { ruling: 'internal', note: "the hidden <input type=file> DOM node behind the 'Import' rail button (WO INT-6A) -- a wiring seam, never itself a rendered value (its picked File is consumed synchronously by handleImportStepFileChange, not retained here)." },
  pendingImportCacheEvictionRef: { ruling: 'internal', note: 'WO INT-6A-R1: nodeId->cacheKey pairs for deleted import nodes awaiting the doc-close stepCache flush (undo-safe eviction) -- pure IndexedDB-lifecycle bookkeeping, never a rendered value; a debug-scene reload starts this bookkeeping fresh regardless.' },
  addConsoleEventRef: { ruling: 'internal', note: 'stale-closure-safe console-event hook indirection (mount-effect plumbing).' },
  clientRef: { ruling: 'internal', note: 'GeomClient (kernel) handle.' },
  getExportBodiesRef: { ruling: 'internal', note: "WO-2424: latest-closure indirection behind the getExportBodies hook the Export window reads (body ids, names, visibility) -- derived from bodies/visibility state each render, never a rendered value of its own." },
  cacheRef: { ruling: 'internal', note: 'GeometryCache -- tessellation buffers, not a UI-visible value of its own.' },
  meshesRef: { ruling: 'internal', note: 'three.js Mesh/edge-line handles the repaint loop writes into.' },
  bodyInteractionPresentationsRef: {
    ruling: 'internal',
    note: 'Three.js hover/selection overlay handles derived from selectedBodyRowId, armed pick state, and face/edge interaction state; the owning inputs are classified separately.',
  },
  selectedBodyMaterialStatesRef: {
    ruling: 'internal',
    note: 'Original material snapshots used only to restore the modeled-body material after selected-body tinting; not an independently rendered input.',
  },
  bodyHandlesRef: { ruling: 'internal', note: 'kernel BodyHandle map.' },
  visibleRef: {
    ruling: 'internal',
    note: "eye-icon visibility mesh-cache -- WO UI-56: re-derived from each node's own PERSISTED `hidden` flag on every fullResync pass (no longer session-only), so it is ALREADY captured via dag.serialize() itself; the prior dedicated hiddenByEyeIcon skipped[] check was removed as obsolete (WORKER CHARTER item 1: a check that can never fire is not a gate).",
  },
  sketchLinesRef: { ruling: 'internal', note: 'three.js sketch overlay line objects -- visual OUTPUT of sketchMode, not independent state.' },
  touchedPastRef: { ruling: 'internal', note: 'undo/redo dirty-root bookkeeping for fullResync, not a rendered value.' },
  touchedFutureRef: { ruling: 'internal', note: 'redo dirty-root bookkeeping, not a rendered value.' },
  dagRef: { ruling: 'internal', note: '`FeatureDag` instance mirror of `dag` -- captured via dag.serialize().' },
  mapRef: { ruling: 'internal', note: 'ElementMap instance -- regen bookkeeping, not independently rendered.' },
  schedulerRef: { ruling: 'internal', note: 'RegenScheduler instance -- regen bookkeeping.' },
  historyRef: { ruling: 'internal', note: 'CommandHistory instance -- undo/redo bookkeeping; the CURRENT dag state it produces is what is captured.' },
  solveServiceRef: { ruling: 'internal', note: 'sketch constraint-solver service handle.' },
  pickEngineRef: { ruling: 'internal', note: 'PickEngine handle used by handlePickHover -- the OUTCOME (pickHoverInfo) is classified above.' },
  executorRef: { ruling: 'internal', note: 'FeatureOp executor handle.' },
  paramTableRef: { ruling: 'internal', note: 'ParameterTable instance mirror of paramsVersion -- see that entry.' },
  appearanceStoreRef: { ruling: 'internal', note: "AppearanceStore instance -- ALREADY captured via buildDebugSceneExport's own appearanceSnapshot check." },
  visibilityStoreRef: { ruling: 'internal', note: "VisibilityStore instance -- ALREADY captured via buildDebugSceneExport's own visibilitySnapshot check." },
  pristineGeometryRef: { ruling: 'internal', note: 'pre-edit geometry snapshots for visibility diffing -- not a rendered value.' },
  snapshotsCacheRef: { ruling: 'internal', note: 'measure-tool geometry snapshot cache -- not a rendered value.' },
  materialBaselinesRef: { ruling: 'internal', note: 'three.js material baseline cache for display-mode shading -- derived from displayMode (captured) + the material itself.' },
  skipFirstEdgeTechniqueRebuildRef: {
    ruling: 'internal',
    note: 'One-shot effect guard that avoids rebuilding the already-correct initial edge technique; it is lifecycle bookkeeping, not scene state.',
  },
  gridSpacingRef: {
    ruling: 'transient',
    note: "ref mirror of gridSpacing (src/store/camStore.ts's viewer.gridSpacing, a CROSS-APP global preference shared with the CAM viewport) -- not scene-specific state, unrelated to reproducing dag-derived geometry. (gridSpacing itself is a Zustand store selector, not a useState/useRef, so it is outside this census's mechanical reach; documented here for a human reader.)",
  },
  pickHighlightSelectionRef: {
    ruling: 'internal',
    note: "armed pick-mode highlight source -- ALREADY named via each armed pick mode's own skipped[] entry (pushPullMode/dressUpPickMode/sketchMode/resizeHolePickMode).",
  },
  resizeHoleVerdictsRef: {
    ruling: 'internal',
    note: "WO UI-58: per-body recognizeFeatures cache feeding the armed resize-hole pick's hover match/click-select/list -- a cache, not itself a rendered value; its OUTCOME (a hole selected, an entry open) is captured via resizeHolePickMode's own skipped[] entry above.",
  },
  resizeHoleVerdictsDagVersionRef: {
    ruling: 'internal',
    note: 'WO UI-58: the dagVersion resizeHoleVerdictsRef was last built for -- pure cache-invalidation bookkeeping, not a rendered value.',
  },
  resizeHoleRecognitionFailuresRef: {
    ruling: 'internal',
    note: "WO UI-58-R1: per-body recognizeFeatures failure reasons feeding the armed hint's named-failure branch -- a cache alongside resizeHoleVerdictsRef, not itself a rendered value; its OUTCOME (the failure text in the hint) is captured via resizeHolePickMode's own skipped[] entry above, same reasoning as resizeHoleVerdictsRef.",
  },

  // ---- push-pull gesture internals: outcome already named via pushPullMode ----------------------
  pushPullPreviewHandleRef: { ruling: 'internal', note: "uncommitted push-pull preview body handle -- ALREADY named via pushPullMode==='mounted''s skipped[] entry." },
  pushPullPreviewStateRef: { ruling: 'internal', note: "in-flight/pending push-pull delta -- ALREADY named via pushPullMode==='mounted''s skipped[] entry." },
  pushPullGenerationRef: { ruling: 'internal', note: 'push-pull gesture generation counter -- internal single-flight bookkeeping, not a rendered value.' },
  pushPullEndingRef: { ruling: 'internal', note: 'push-pull gesture end-in-progress flag -- internal bookkeeping.' },
  pushPullActiveGestureRef: { ruling: 'internal', note: 'push-pull gesture token -- internal bookkeeping.' },
  pushPullGestureSeqRef: { ruling: 'internal', note: 'push-pull gesture sequence counter -- internal bookkeeping.' },
  visibilityResetSeqRef: { ruling: 'internal', note: 'WO-2711 fullResync visibility-reset sequence counter (a superseded pass leaves the end-of-pass sweep to the newest reset owner) -- internal single-flight bookkeeping, not a rendered value; same class as reresolveSeqRef.' },
  reresolveSeqRef: { ruling: 'internal', note: 'CAM-1-R1 regen re-resolution sequence counter (monotonic seq handed to store.reresolveModelReferences so a stale post-await apply is refused) -- internal single-flight bookkeeping, not a rendered value. Classified at the CAM-1 merge (census cross-merge catch, same class as nPickArmed).' },

  // ---- INT-14 document save/load (classified at the INT-14 merge -- census cross-merge catch, ----
  // ---- same class as nPickArmed/reresolveSeqRef) -------------------------------------------------
  documentSeedRef: {
    ruling: 'internal',
    note: 'One-shot mount-time handoff of the loaded document (takePendingDocumentSeed consumed exactly once, then only read as an initializer guard) seeding dagRef/foldersRef/mapRef -- the seeded document state itself is captured via dag.serialize(); never an independently rendered value.',
  },
  documentSeedLeaseRef: {
    ruling: 'internal',
    note: 'Versioned one-shot seed lease peeked during render and acknowledged only after commit. The lease is transition bookkeeping; its document payload is mirrored by documentSeedRef and the resulting scene state is captured via dag.serialize().',
  },
  buildDocumentSaveInputRef: {
    ruling: 'internal',
    note: 'Latest-closure mirror of buildDocumentSaveInput registered once with registerLiveDocument so a save reads the CURRENT dag/folders/map without re-subscribing -- a function handle, never a rendered value.',
  },
  documentLoadStatus: {
    ruling: 'transient',
    note: "Document open/recovery outcome readout (the 'model: ...' line; set by the seed-consume / body-rebuild-failure paths, ADR-0003 fail-loud surface). A human-facing echo of the load path, not independent scene state: the substance it reports (which features loaded, which body rebuild failed by name) is captured via dag.serialize() and the scene itself, and a fresh load of the same file reproduces it exactly.",
  },

  // ---- INT-13C keyboard ownership (classified at the INT-13C merge -- census cross-merge catch, --
  // ---- same class as nPickArmed/reresolveSeqRef/INT-14) ------------------------------------------
  keyOwnershipRef: {
    ruling: 'internal',
    note: 'Handle to the currently-registered workspace-owned keydown listener so re-scope can detach exactly the listener it armed (register-only-when-null guard) -- listener bookkeeping, never a rendered value; the OUTCOME (which workspace owns chords) is what the INT-13C interleave tests assert.',
  },
  undoRef: {
    ruling: 'internal',
    note: 'Latest-closure mirror of handleUndo read by the workspace-owned key listener -- keeps the chord handler current without re-registering; a function handle, never a rendered value. The history state it drives is already captured via the classified history/dag.',
  },
  redoRef: {
    ruling: 'internal',
    note: 'Latest-closure mirror of handleRedo, same shape and reasoning as undoRef.',
  },
  historyPublisherToken: {
    ruling: 'internal',
    note: 'Stable Symbol identity (useRef(Symbol()).current) naming this mount to publishPartWorkspaceHistory so the D5.4 resolver can attribute and withdraw the Part workspace history publication -- an identity token, never a rendered value.',
  },

  // ---- in-progress sketch internals: outcome already named via sketchMode ------------------------
  sketcherRef: { ruling: 'internal', note: 'in-progress sketch constraint-solver handle -- OUTCOME captured via sketchMode.' },
  sketchFrameRef: { ruling: 'internal', note: "in-progress sketch's plane frame -- OUTCOME captured via sketchMode." },
  sketchSizeHintRef: { ruling: 'internal', note: "in-progress sketch's grid size hint -- cosmetic, part of sketchMode's already-named session." },
  overlayRootRef: { ruling: 'internal', note: 'three.js sketch overlay group handle.' },
  gcsWrapperRef: { ruling: 'internal', note: 'planegcs wasm solver handle.' },

  // ---- body list: derived from dag, not independent state -----------------------------------------
  bodies: { ruling: 'internal', note: 'refreshBodiesList() derives this entirely from bodyFeatureIds(dag) + visibleRef (already classified) + kernel-measured volume -- dag-derived, not independent state.' },

  // ---- export-function self-reference plumbing ----------------------------------------------------
  buildDebugSceneExportRef: { ruling: 'internal', note: 'stale-closure-safe indirection to buildDebugSceneExport itself -- the function under test, not a render input.' },

  // ---- profile-pick / boolean-body-pick armed state (census cross-merge catch, same class as -------
  // ---- nPickArmed/reresolveSeqRef above): both can only be live while their OWNING dialog is open, --
  // ---- already named by the existing dialog.kind !== 'none' skipped[] entry -------------------------
  profilePickMode: {
    ruling: 'transient',
    note: "Extrude/Revolve/Sweep/Loft's own in-viewport profile-pick session (started via onStartProfilePick, which those four dialogs alone receive, only while mounted) -- can only be non-null while dialog.kind is one of those four, which the existing dialog.kind !== 'none' skipped[] entry already names; folded in, not a second independent entry, same pattern as pushPullDraftText folding into pushPullMode.",
  },
  profilePickPreview: {
    ruling: 'transient',
    note: "The armed profile pick's temporary projected outline/readout -- exists only while profilePickMode is live and is cleared with that dialog-scoped pick session; folded into the same open-dialog skipped[] entry.",
  },
  booleanBodyPickRole: {
    ruling: 'transient',
    note: "Armed in-viewport target/tool body pick for the open Boolean dialog -- an effect (`dialog.kind !== 'boolean'` -> cancelBooleanBodyPick()) guarantees this is null whenever dialog.kind !== 'boolean', so it too is already named by the dialog.kind !== 'none' skipped[] entry; folded in, same reasoning as profilePickMode above.",
  },
  booleanBodySelection: {
    ruling: 'transient',
    note: "Boolean dialog's picked target/tool feature ids -- reset to null by the SAME `dialog.kind !== 'boolean'` effect as booleanBodyPickRole; folded into the dialog.kind skipped[] entry for the same reason.",
  },
  booleanBodyHoverId: {
    ruling: 'transient',
    note: "Boolean dialog's in-viewport hover highlight while a pick is armed -- cleared by cancelBooleanBodyPick (itself invoked by the same `dialog.kind !== 'boolean'` effect); folded into the dialog.kind skipped[] entry, same reasoning as booleanBodyPickRole.",
  },
  extrudeTargetPickArmed: {
    ruling: 'transient',
    note: "MW-PICKS-1 (Q-68): armed in-viewport target-body pick for the open Extrude dialog, ported from booleanBodyPickRole -- an effect (`dialog.kind !== 'extrude'` -> cancelExtrudeTargetPick()) guarantees this is false whenever dialog.kind !== 'extrude', so it too is already named by the dialog.kind !== 'none' skipped[] entry; folded in, same reasoning as booleanBodyPickRole.",
  },
  extrudeTargetHoverId: {
    ruling: 'transient',
    note: "Extrude dialog's in-viewport hover highlight while a target pick is armed -- cleared by cancelExtrudeTargetPick (itself invoked by the same `dialog.kind !== 'extrude'` effect); folded into the dialog.kind skipped[] entry, same reasoning as booleanBodyHoverId.",
  },
  defeatureSelectedKeys: {
    ruling: 'transient',
    note: "DEFEATURE-CLICK-PICK (Q-68): the open Defeature dialog's accept mask (which recognized fillets/chamfers are marked for removal), lifted out of the dialog so repaintUi4Overlays can paint the selected face-set tint and a viewport face-click can toggle it. A `prevDialogKindRef` effect clears the pick highlight the instant dialog.kind leaves 'defeature', so this only affects the scene while dialog.kind === 'defeature' -- already named by the dialog.kind !== 'none' skipped[] entry; reopening the dialog re-runs deterministic recognition and re-seeds the same default. Same folded reasoning as booleanBodySelection.",
  },
  defeatureHoverKey: {
    ruling: 'transient',
    note: "Defeature dialog's currently-hovered recognized feature (drives the row highlight + the in-viewport hover face-set tint) -- transient hover state cleared on leaving the dialog, same reasoning/scope as extrudeTargetHoverId/booleanBodyHoverId.",
  },
  defeaturePreviewFeedback: {
    ruling: 'transient',
    note: "Defeature's guarded-preview status and source/preview presentation phase -- it can only be non-idle while dialog.kind === 'defeature', so it is folded into the existing open-dialog skipped[] entry; leaving the dialog restores the source presentation and resets this state to idle.",
  },
  draftPreviewState: {
    ruling: 'transient',
    note: "Draft command's guarded preview status -- live only while the Draft dialog owns a preview session and reset on close; folded into the existing open-dialog skipped[] entry.",
  },
  filletPreviewState: {
    ruling: 'transient',
    note: "Fillet command's guarded preview status -- live only while the Fillet dialog owns a preview session and reset on close; folded into the existing open-dialog skipped[] entry.",
  },
  chamferPreviewState: {
    ruling: 'transient',
    note: "Chamfer command's guarded preview status -- live only while the Chamfer dialog owns a preview session and reset on close; folded into the existing open-dialog skipped[] entry.",
  },
  chamferAdoptionPending: {
    ruling: 'transient',
    note: "Reactive mirror of the accepted-Chamfer adoption lock used to disable workbench history and feature-switching controls while Apply awaits handle disposal/downstream replay; it can only be true while the Chamfer dialog is already named by dialog's skipped[] entry.",
  },
  shellPreviewState: {
    ruling: 'transient',
    note: "Shell command's guarded preview status -- live only while the Shell command strip owns a preview session and reset on close; folded into the existing open-dialog skipped[] entry.",
  },
  shellAdoptionPending: {
    ruling: 'transient',
    note: "Reactive mirror of the accepted-Shell adoption lock used to disable workbench interactions while Apply awaits downstream replay; it can only be true while the Shell command strip is already named by dialog's skipped[] entry.",
  },
  offsetPlanePreviewState: {
    ruling: 'transient',
    note: "Offset Plane command's guarded preview status -- live only while the Offset Plane dialog owns a preview session and reset on close; folded into the existing open-dialog skipped[] entry.",
  },
  extrudePreviewState: {
    ruling: 'transient',
    note: "Extrude command's guarded preview status (WO-035) -- live only while the Extrude dialog owns a preview session and reset on close; folded into the existing open-dialog skipped[] entry.",
  },
  revolvePreviewState: {
    ruling: 'transient',
    note: "Revolve command's guarded preview status (WO-039) -- live only while the Revolve dialog owns a preview session and reset on close; folded into the existing open-dialog skipped[] entry.",
  },
  holePreviewState: {
    ruling: 'transient',
    note: "Hole command's guarded preview status (WO-042) -- live only while the Hole dialog owns a preview session and reset on close; folded into the existing open-dialog skipped[] entry.",
  },
  holePreviewSeed: {
    ruling: 'transient',
    note: 'The live Hole preview intent\'s seed point, painted as the UI-107 seed-point highlight marker only while the Hole dialog is open (WO-042); cleared with the dialog and derived entirely from dialog fields.',
  },
  offsetPlanePreviewHiddenPlaneId: {
    ruling: 'transient',
    note: "Committed offset-plane node whose sheet/emphasis glyphs stay down while its edit session's ghost previews the typed offset -- non-null only while the Offset Plane dialog owns a preview session; cleared on Apply/Cancel/error teardown.",
  },
  offsetPlanePreviewReference: {
    ruling: 'transient',
    note: "Saved source-plane reference highlighted while an Offset Plane preview session is live (UI-107 'visibly highlight the saved references'); non-null only while the dialog owns a session and cleared on teardown.",
  },

  // ---- gesture/mirror/wiring refs newly added alongside the above (census cross-merge catch) --------
  sectionDragGestureRef: {
    ruling: 'internal',
    note: "In-progress section/clip-plane slider drag gesture bookkeeping (pointer id + drag-start axis/pos/height snapshot) -- the plane's CURRENT axis/pos is already captured via section.state's own skipped[] entry; this is pointer-drag arithmetic, never independently rendered.",
  },
  selectedFacePickRef: {
    ruling: 'internal',
    note: "Last ordinary face-click screen point + resolved owner/face, cached only so unified 'New sketch' can replay it through the live picker after arming (revalidating against current geometry rather than trusting a stale id) -- the actual selection/highlight it feeds is captured via bridgeSession's already-classified .selection; losing it on reload just means the user clicks the face again. Reattach remains a separate existing-sketch action.",
  },
  dagVersionRef: { ruling: 'internal', note: 'ref mirror of dagVersion kept current for an async effect closure -- see dagVersion (already classified transient: a re-render trigger, not an independent value).' },
  selectedIdRef: { ruling: 'internal', note: 'ref mirror of selectedId kept current for an async effect closure -- see selectedId (already classified skip-when-live).' },
  pushPullModeRef: { ruling: 'internal', note: 'ref mirror of pushPullMode kept current for an async effect closure -- see pushPullMode (already classified skip-when-live).' },
  booleanBodyPickRequestRef: {
    ruling: 'internal',
    note: "Pending boolean-body-pick request (role/excludedIds/onPicked callback) driving handleBooleanBodyPick's resolution -- wiring plumbing for the armed pick, not itself a rendered value; its OUTCOME (armed role, current hover/selection) is captured via booleanBodyPickRole/booleanBodyHoverId/booleanBodySelection above.",
  },
  extrudeTargetPickRequestRef: {
    ruling: 'internal',
    note: "MW-PICKS-1 (Q-68): pending extrude-target-pick request (excludedIds/onPicked callback) driving handleExtrudeTargetPick's resolution, ported from booleanBodyPickRequestRef -- wiring plumbing for the armed pick, not itself a rendered value; its OUTCOME is captured via extrudeTargetPickArmed/extrudeTargetHoverId above.",
  },
  extrudeTargetHoverAnnouncedRef: {
    ruling: 'internal',
    note: "MW-PICKS-1: last hovered-id ANNOUNCED to the console (contextual-feedback rule, Operator 2026-07-25) -- dedupes the hover console line to one per hover-target CHANGE rather than one per pointermove frame; wiring plumbing, not itself a rendered value (extrudeTargetHoverId above is the rendered/highlighted state).",
  },
  lastHoverPlaneConsoleRef: {
    ruling: 'internal',
    note: "SKETCH-PLANE-INWORKSPACE (Q-68 item 4): last base-plane node id ANNOUNCED to the console during the in-workspace plane pick -- dedupes the 'Armed for selection: <plane>' hover line to one per hover-target CHANGE rather than one per pointermove frame; wiring plumbing, not itself a rendered value (hoveredBasePlaneNodeId/planePickStatus above are the rendered/highlighted state). Same shape as extrudeTargetHoverAnnouncedRef.",
  },
  defeatureSelectedKeysRef: {
    ruling: 'internal',
    note: "DEFEATURE-CLICK-PICK (Q-68): synchronous ref mirror of defeatureSelectedKeys read by the pointer/console paths (a hover line must name include-vs-exclude without waiting for a re-render) -- mirrors an already-classified transient value, never independently rendered.",
  },
  defeatureVerdictsRef: {
    ruling: 'internal',
    note: "DEFEATURE-CLICK-PICK (Q-68): the open dialog's already-computed recognizeFeatures verdicts, cached in a ref so the synchronous face-hover/click handlers can match a face hit against faceIds without re-running recognition (browser-headroom law) -- mirrors dialog.verdicts, not itself a rendered value.",
  },
  defeatureRecognizeBodyIdRef: {
    ruling: 'internal',
    note: "DEFEATURE-CLICK-PICK (Q-68): fallback recognized body id used before a guarded preview publishes its exact selection source; wiring plumbing for the pick, not itself a rendered value.",
  },
  defeaturePreviewSessionRef: {
    ruling: 'internal',
    note: "FeaturePreviewSession owner for Defeature candidate replacement, cancellation, and accepted-candidate adoption -- lifecycle orchestration whose visible status is already classified by defeaturePreviewFeedback.",
  },
  defeaturePreviewIntentRef: {
    ruling: 'internal',
    note: "Latest Defeature preview intent mirrored for stale-result rejection and exact-candidate adoption; derived from the open dialog's selected mask and never independently rendered.",
  },
  defeaturePreviewSourceBodyIdRef: {
    ruling: 'internal',
    note: "Authored presentation body temporarily hidden by the active Defeature preview and restored on cancel/close; lifecycle bookkeeping derived from the session baseline.",
  },
  defeaturePreviewSelectionSourceBodyIdRef: {
    ruling: 'internal',
    note: "Exact cached body id whose pre-feature faces are hover/click targets while the Defeature preview is presented; derived from the active session candidate and cleared on teardown.",
  },
  defeaturePreviewPageGenerationRef: {
    ruling: 'internal',
    note: "Monotonic page-side generation paired with FeaturePreviewSession identity so superseded asynchronous tessellation cannot repaint after replacement or close; never independently rendered.",
  },
  defeatureAdoptionPendingRef: {
    ruling: 'internal',
    note: "One-bit adoption lock preventing concurrent Defeature selection/apply mutations while the accepted candidate is being published; lifecycle bookkeeping, not an independent render input.",
  },
  defeaturePreviewGhostRef: {
    ruling: 'internal',
    note: "Three.js interaction-overlay object for the current Defeature preview hover/selection tint -- an imperative scene handle whose visible state is derived from the already-classified dialog, selection, hover, and preview-feedback values.",
  },
  profilePickOutlinesRef: {
    ruling: 'internal',
    note: "Imperative Three.js outline objects for the transient profile-pick preview; their semantic state is already classified by profilePickPreview/profilePickMode.",
  },
  draftPreviewSessionRef: {
    ruling: 'internal',
    note: "FeaturePreviewSession owner for Draft candidate replacement, cancellation, and adoption; lifecycle orchestration whose visible status is draftPreviewState.",
  },
  draftPreviewIntentRef: {
    ruling: 'internal',
    note: "Latest Draft preview intent used for stale-result rejection and adoption; derived from dialog fields and never independently rendered.",
  },
  draftPreviewSourceBodyIdRef: {
    ruling: 'internal',
    note: "Authored presentation body temporarily hidden by Draft preview and restored on teardown; session-baseline bookkeeping.",
  },
  draftPreviewPageGenerationRef: {
    ruling: 'internal',
    note: "Monotonic page-side generation preventing superseded Draft tessellation from repainting; never independently rendered.",
  },
  draftPreviewGhostRef: {
    ruling: 'internal',
    note: "Imperative Three.js interaction overlay for the current Draft preview; its visible state is derived from dialog selection and draftPreviewState.",
  },
  filletPreviewSessionRef: {
    ruling: 'internal',
    note: "FeaturePreviewSession owner for Fillet candidate replacement, cancellation, and adoption; lifecycle orchestration whose visible status is filletPreviewState.",
  },
  filletPreviewIntentRef: {
    ruling: 'internal',
    note: "Latest Fillet preview intent used for stale-result rejection and adoption; derived from dialog fields and never independently rendered.",
  },
  filletPreviewSourceBodyIdRef: {
    ruling: 'internal',
    note: "Authored presentation body temporarily hidden by Fillet preview and restored on teardown; session-baseline bookkeeping.",
  },
  filletPreviewPageGenerationRef: {
    ruling: 'internal',
    note: "Monotonic page-side generation preventing superseded Fillet tessellation from repainting; never independently rendered.",
  },
  filletPreviewGhostRef: {
    ruling: 'internal',
    note: "Imperative Three.js interaction overlay for the current Fillet preview; its visible state is derived from dialog selection and filletPreviewState.",
  },
  offsetPlanePreviewSessionRef: {
    ruling: 'internal',
    note: "FeaturePreviewSession owner for Offset Plane candidate replacement, cancellation, and commit-time Apply guards; lifecycle orchestration whose visible status is offsetPlanePreviewState.",
  },
  offsetPlanePreviewIntentRef: {
    ruling: 'internal',
    note: "Latest Offset Plane preview intent used for stale-result rejection and the Apply accepted-intent guard; derived from dialog fields and never independently rendered.",
  },
  offsetPlanePreviewPageGenerationRef: {
    ruling: 'internal',
    note: "Monotonic page-side generation preventing a superseded Offset Plane session's ghost paint/restore from acting after teardown; never independently rendered.",
  },
  offsetPlanePreviewGhostRef: {
    ruling: 'internal',
    note: "Imperative Three.js ghost sheet for the current Offset Plane preview; its visible state is derived from dialog fields and offsetPlanePreviewState.",
  },
  extrudePreviewSessionRef: {
    ruling: 'internal',
    note: "FeaturePreviewSession owner for Extrude candidate replacement, cancellation, and commit-time Apply guards (WO-035); lifecycle orchestration whose visible status is extrudePreviewState.",
  },
  extrudePreviewIntentRef: {
    ruling: 'internal',
    note: "Latest Extrude preview intent used for stale-result rejection and the Apply accepted-intent guard; derived from dialog fields and never independently rendered.",
  },
  extrudePreviewPendingRef: {
    ruling: 'internal',
    note: "Settlement promise of the latest Extrude preview request, awaited by the commit-time Apply guard so a click during evaluation commits the accepted candidate or refuses honestly; never independently rendered.",
  },
  extrudePreviewPageGenerationRef: {
    ruling: 'internal',
    note: "Monotonic page-side generation preventing a superseded Extrude session's ghost paint/restore from acting after teardown; never independently rendered.",
  },
  extrudePreviewSourceIdRef: {
    ruling: 'internal',
    note: "Authored presentation body temporarily hidden behind the Extrude preview ghost and restored on teardown; session-baseline bookkeeping.",
  },
  revolvePreviewSessionRef: {
    ruling: 'internal',
    note: "FeaturePreviewSession owner for Revolve candidate replacement, cancellation, and commit-time Apply guards (WO-039); lifecycle orchestration whose visible status is revolvePreviewState.",
  },
  revolvePreviewIntentRef: {
    ruling: 'internal',
    note: "Latest Revolve preview intent used for stale-result rejection and the Apply accepted-intent guard; derived from dialog fields and never independently rendered.",
  },
  revolvePreviewPendingRef: {
    ruling: 'internal',
    note: "Settlement promise of the latest Revolve preview request, awaited by the commit-time Apply guard so a click during evaluation commits the accepted candidate or refuses honestly; never independently rendered.",
  },
  revolvePreviewPageGenerationRef: {
    ruling: 'internal',
    note: "Monotonic page-side generation preventing a superseded Revolve session's ghost paint/restore from acting after teardown; never independently rendered.",
  },
  revolvePreviewSourceIdRef: {
    ruling: 'internal',
    note: "Authored presentation body temporarily hidden behind the Revolve preview ghost (edit mode) and restored on teardown; session-baseline bookkeeping.",
  },
  revolveAxisHighlightRef: {
    ruling: 'internal',
    note: "Imperative Three.js world-Z axis-reference highlight line painted only while the Revolve dialog is open (WO-039, the UI-107 axis-reference highlight) -- its semantic state is the already-classified dialog.kind; added and removed by its own effect.",
  },
  holePreviewSessionRef: {
    ruling: 'internal',
    note: 'FeaturePreviewSession owner for Hole candidate replacement, cancellation, and commit-time Apply guards (WO-042); lifecycle orchestration whose visible status is holePreviewState.',
  },
  holePreviewIntentRef: {
    ruling: 'internal',
    note: 'Latest Hole preview intent used for stale-result rejection and the Apply accepted-intent guard; derived from dialog fields and never independently rendered.',
  },
  holePreviewPendingRef: {
    ruling: 'internal',
    note: 'Settlement promise of the latest Hole preview request, awaited by the commit-time Apply guard so a click during evaluation commits the accepted candidate or refuses honestly; never independently rendered.',
  },
  holePreviewPageGenerationRef: {
    ruling: 'internal',
    note: "Monotonic page-side generation preventing a superseded Hole session's ghost paint/restore from acting after teardown; never independently rendered.",
  },
  holePreviewSourceIdRef: {
    ruling: 'internal',
    note: 'Authored presentation body temporarily hidden behind the Hole preview ghost (the owner in create, the rendered result in edit) and restored on teardown; session-baseline bookkeeping.',
  },
  holeSeedHighlightRef: {
    ruling: 'internal',
    note: 'Imperative Three.js seed-point highlight marker painted only while the Hole dialog is open (WO-042, the UI-107 seed-point highlight) -- its semantic state is the already-classified holePreviewSeed; added and removed by its own effect.',
  },
  holePreviewFaceOverlayRef: {
    ruling: 'internal',
    note: 'Imperative Three.js interaction overlay painting the saved-face highlight over the Hole edit ghost (WO-042); its visible state is derived from the pick-highlight selection and holePreviewState.',
  },
  holeEditSelectionRestoreRef: {
    ruling: 'internal',
    note: 'Snapshot of the pre-edit pick-highlight selection restored when the Hole edit dialog closes; transactional bookkeeping, not an independently rendered input.',
  },
  filletPreviewSelectionRestoreRef: {
    ruling: 'internal',
    note: "Snapshot of the pre-preview Fillet selection restored when the preview is cancelled; transactional bookkeeping, not an independently rendered input.",
  },
  filletEditPickPresentationRestoreRef: {
    ruling: 'internal',
    note: 'Snapshot of the owner and live-leaf visibility replaced while a Fillet edit is picking; imperative scene restoration bookkeeping.',
  },
  skipNextDressUpSelectionClearRef: {
    ruling: 'internal',
    note: 'One-shot guard that preserves the exact pre-command selection and hover while a dress-up interaction tears down; it has no independently rendered state.',
  },
  chamferPreviewSessionRef: {
    ruling: 'internal',
    note: "FeaturePreviewSession owner for Chamfer candidate replacement, cancellation, and adoption; lifecycle orchestration whose visible status is chamferPreviewState.",
  },
  chamferPreviewIntentRef: {
    ruling: 'internal',
    note: "Latest Chamfer preview intent used for stale-result rejection and adoption; derived from dialog fields and never independently rendered.",
  },
  chamferPreviewSourceBodyIdRef: {
    ruling: 'internal',
    note: "Authored presentation body temporarily hidden by Chamfer preview and restored on teardown; session-baseline bookkeeping.",
  },
  chamferPreviewPageGenerationRef: {
    ruling: 'internal',
    note: "Monotonic page-side generation preventing superseded Chamfer tessellation from repainting; never independently rendered.",
  },
  chamferAdoptionPendingRef: {
    ruling: 'internal',
    note: 'Immediate accepted-Chamfer adoption lock read by synchronous undo, intent, and edit-entry routes before the reactive UI mirror renders; transaction bookkeeping whose visible state is chamferAdoptionPending.',
  },
  chamferDownstreamReplayProbeRef: {
    ruling: 'internal',
    note: 'One-shot test-only fault injection immediately before accepted-Chamfer downstream replay; cleared before invocation so the production rollback fullResync remains the authoritative recovery path.',
  },
  chamferPreviewGhostRef: {
    ruling: 'internal',
    note: "Imperative Three.js interaction overlay for the current Chamfer preview; its visible state is derived from dialog selection and chamferPreviewState.",
  },
  chamferPreviewSelectionRestoreRef: {
    ruling: 'internal',
    note: "Snapshot of the pre-preview Chamfer selection restored when the preview is cancelled; transactional bookkeeping, not an independently rendered input.",
  },
  chamferEditPickPresentationRestoreRef: {
    ruling: 'internal',
    note: 'Snapshot of the owner and live-leaf visibility replaced while a Chamfer edit is picking; imperative scene restoration bookkeeping.',
  },
  shellPreviewSessionRef: {
    ruling: 'internal',
    note: 'FeaturePreviewSession owner for Shell candidate replacement, cancellation, and adoption; lifecycle orchestration whose visible status is shellPreviewState.',
  },
  shellPreviewIntentRef: {
    ruling: 'internal',
    note: 'Latest Shell preview intent used for stale-result rejection and adoption; derived from command-strip fields and never independently rendered.',
  },
  shellPreviewSourceBodyIdRef: {
    ruling: 'internal',
    note: 'Authored presentation body temporarily hidden by Shell preview and restored on teardown; session-baseline bookkeeping.',
  },
  shellPreviewPageGenerationRef: {
    ruling: 'internal',
    note: 'Monotonic page-side generation preventing superseded Shell tessellation from repainting; never independently rendered.',
  },
  shellPreviewPresentedRef: {
    ruling: 'internal',
    note: 'Tracks whether Shell has an accepted preview to keep visible during a newer pending request; presentation bookkeeping mirrored by shellPreviewState.',
  },
  shellAdoptionPendingRef: {
    ruling: 'internal',
    note: 'Immediate accepted-Shell adoption lock read by synchronous undo, intent, and edit-entry routes before the reactive UI mirror renders.',
  },
  shellDownstreamReplayProbeRef: {
    ruling: 'internal',
    note: 'One-shot test-only fault injection immediately before accepted-Shell downstream replay; cleared before invocation so fullResync remains the recovery path.',
  },
  shellPreviewGhostRef: {
    ruling: 'internal',
    note: 'Imperative Three.js interaction overlay for the current Shell preview; its visible state is derived from dialog selection and shellPreviewState.',
  },
  shellPreviewSelectionRestoreRef: {
    ruling: 'internal',
    note: 'Snapshot of the pre-preview Shell selection restored on cancel; transactional bookkeeping, not an independently rendered input.',
  },
  shellEditPickPresentationRestoreRef: {
    ruling: 'internal',
    note: 'Snapshot of the owner and live-leaf visibility replaced while a Shell edit is picking; imperative scene restoration bookkeeping.',
  },
  resizeHolePreviewSessionRef: {
    ruling: 'internal',
    note: "FeaturePreviewSession owner for Resize Hole candidate replacement, cancellation, and exact-candidate adoption; visible draft/status state lives in resizeHolePickMode.",
  },
  resizeHolePreviewIntentRef: {
    ruling: 'internal',
    note: 'Latest Resize Hole preview intent used for exact-ready matching and stale-result rejection; derived from resizeHolePickMode.',
  },
  resizeHolePreviewPendingRef: {
    ruling: 'internal',
    note: 'Current Resize Hole preview settlement awaited by immediate Apply; lifecycle bookkeeping mirrored by resizeHolePickMode.preview.',
  },
  resizeHolePreviewSourceBodyIdRef: {
    ruling: 'internal',
    note: 'Authored presentation body temporarily hidden by Resize Hole preview and restored on teardown; session-baseline bookkeeping.',
  },
  resizeHolePreviewPageGenerationRef: {
    ruling: 'internal',
    note: 'Monotonic page-side generation preventing superseded Resize Hole tessellation from repainting; never independently rendered.',
  },
  resizeHolePreviewPresentedRef: {
    ruling: 'internal',
    note: 'Tracks the accepted Resize Hole candidate kept visible while a newer valid diameter is pending; presentation bookkeeping mirrored by resizeHolePickMode.preview.',
  },
  resizeHolePreviewGhostRef: {
    ruling: 'internal',
    note: 'Imperative Three.js interaction overlay for the current Resize Hole preview; its visible state is derived from the selected hole and preview status.',
  },
  resizeHoleSelectionRestoreRef: {
    ruling: 'internal',
    note: 'Exact selection/hover snapshot restored when Resize Hole cancels or returns to its armed pick state; transactional bookkeeping.',
  },
  resizeHoleAdoptionPendingRef: {
    ruling: 'internal',
    note: "Immediate accepted-Resize-Hole adoption lock; its user-visible applying state lives in resizeHolePickMode.preview.",
  },
  resizeHoleDownstreamReplayProbeRef: {
    ruling: 'internal',
    note: 'Test-only one-shot failure injection at Resize Hole downstream replay; never reachable from production UI or independently rendered.',
  },
  defeatureHoverAnnouncedRef: {
    ruling: 'internal',
    note: "DEFEATURE-CLICK-PICK (Q-68): last hovered feature ANNOUNCED to the console -- dedupes the hover console line to one per hovered-feature CHANGE rather than one per pointermove frame; wiring plumbing, not itself a rendered value (defeatureHoverKey above is the rendered/highlighted state). Same shape as extrudeTargetHoverAnnouncedRef.",
  },
  prevDialogKindRef: {
    ruling: 'internal',
    note: "DEFEATURE-CLICK-PICK (Q-68): tracks the prior dialog.kind so the pick-highlight teardown fires ONLY on the defeature -> anything transition (a blanket dialog.kind !== 'defeature' effect would wrongly wipe a toolbar-armed dress-up/resize-hole selection whenever dialog.kind is 'none') -- bookkeeping, never an independently rendered value.",
  },
  pushPullAdoptionProbeRef: {
    ruling: 'internal',
    note: 'Test-only deterministic-interleave hook (setPushPullAdoptionProbe, wired only through createPushPullTestDriver) fired at the live prepared-adoption boundary -- a test seam, never reachable from production UI, not an independently rendered value.',
  },
  packageSketchEntrySnapshotRef: {
    ruling: 'internal',
    note: "One-shot document-bytes snapshot taken at package-sketch session entry, used only to restore state on a reopen-cancellation -- the in-progress session itself is already captured via sketchMode's own skipped[] entry; this is restore-path bookkeeping, not an independently rendered value.",
  },
  themeColorsRef: {
    ruling: 'internal',
    note: "GEO-25: ref mirror of the themeColors memo (derived from useUiPrefs' viewportTheme, itself out of this census's mechanical useState/useRef reach -- an external-store selector, same category as cameraProjection/hiddenGenesisIds above) kept current for deeply-nested/async closures (push-pull Apply candidate replay, the boot ingest loop). A debug-scene reload re-reads the live persisted theme fresh, so this ref carries nothing a reload would lose.",
  },
  skipFirstThemeRebuildRef: {
    ruling: 'internal',
    note: 'GEO-25: one-shot mount guard so the theme-change edge-overlay-rebuild effect does not redundantly rebuild every body immediately after paintCachedBody already built each one with the correct technique -- pure effect-sequencing bookkeeping, never an independently rendered value.',
  },
  undoRedoResyncedNodeRef: {
    ruling: 'internal',
    note: "SKC-78: which package-sketch node the undo/redo dag-resync effect has already resynced for, so it can skip its very first firing on a fresh open/reopen (beginPackageSketch already seeds sketchSessionStore with the freshly-solved document synchronously; resyncing from the still-persisted dag payload one commit later would silently discard that correction) while still resyncing on every REAL later undo/redo. Pure effect-sequencing bookkeeping -- the in-progress session itself is already captured via sketchMode's own skipped[] entry, same category as packageSketchEntrySnapshotRef above.",
  },

  // ---- WO-1935: an imported STL shown in the Model screen as a mesh-backed body -------------------
  // The STL row stays format 'stl' (its ADR-0051 meshEdits journal is the geometry); nothing here
  // writes the DAG or the model document, so none of it is a model-document render input. Which STL
  // is open is the store's modelStlGeoId (an external-store selector, outside this census's
  // mechanical useState/useRef reach, same category as cameraProjection/hiddenGenesisIds above).
  stlBody: {
    ruling: 'transient',
    note: "WO-1935: the open STL body's tree row (geoId, bodyId, name), set once its mesh presentation is built from the STL row and cleared on teardown. A read-only view of an imported STL row, not a model-document node; ruled out of this debug channel's scope -- a debug-scene reload does not reopen the STL (re-opened from the tree, by design).",
  },
  stlBodyVisible: {
    ruling: 'transient',
    note: "WO-1935: the STL body's tree eye toggle; reset to visible each time the STL body is (re)built. Session view state on the read-only STL view, same scope ruling as stlBody.",
  },
  stlSelection: {
    ruling: 'transient',
    note: 'WO-1935: the whole recognised STL feature (or the STL body) picked by click; cleared on rebuild, teardown, and a miss. Selection on the read-only STL view, same scope ruling as stlBody -- no document or debug-scene meaning.',
  },
  stlBodyRef: {
    ruling: 'internal',
    note: 'WO-1935: the imperative Three.js presentation handle (mesh, edges, feature highlights) for the open STL body -- a runtime handle, never an independently rendered value; its visible state is stlBody/stlBodyVisible/stlSelection.',
  },
  stlHoverKeyRef: {
    ruling: 'internal',
    note: 'WO-1935: last hovered STL feature key, dedupes hover repaints to one per hovered-feature CHANGE rather than one per pointermove frame -- same shape as defeatureHoverAnnouncedRef; not itself a rendered value.',
  },
  stlColorRef: {
    ruling: 'internal',
    note: "WO-1935: ref mirror of the STL row's colour (store selector) read by the async STL-body build so a colour change does not rebuild the body -- mirrors a value already held in the store.",
  },
  displayModeRef: {
    ruling: 'internal',
    note: 'WO-1935: ref mirror of displayMode (captured above) read by the async STL-body build so the body is shaded/wireframed to match on first paint -- mirrors a value already classified.',
  },

  // ---- WO-2089 / WO-2090: Chamfer, Shell and Draft on the STL body --------------------------------
  // Same scope ruling as the WO-1935 block above: the STL tools edit the STL row's meshEdits journal,
  // never the DAG or the model document.
  stlChamferEdgesRef: {
    ruling: 'internal',
    note: "WO-2089: ref mirror of the open 'stl-chamfer' dialog's picked edges (empty otherwise), reassigned every render and read by the stable Chamfer preview-intent callback -- mirrors dialog (already classified skip-when-live), not an independent value.",
  },
  stlShellFacesRef: {
    ruling: 'internal',
    note: "WO-2090: ref mirror of the open 'stl-shell' dialog's picked faces (empty otherwise), reassigned every render and read by the stable Shell preview-intent callback -- mirrors dialog (already classified skip-when-live), not an independent value.",
  },
  stlDraftFacesRef: {
    ruling: 'internal',
    note: "WO-2090: ref mirror of the open 'stl-draft' dialog's picked faces (empty otherwise), reassigned every render and read by the stable Draft preview-intent callback -- mirrors dialog (already classified skip-when-live), not an independent value.",
  },
  stlEdgeOverlayRef: {
    ruling: 'internal',
    note: "WO-2089: the three.js LineSegments handle drawing Chamfer's picked + hovered STL edges, disposed and rebuilt by paintStlEdges -- a runtime handle; what it draws is dialog's edges plus stlEdgeHoverRef.",
  },
  stlEdgeHoverRef: {
    ruling: 'transient',
    note: 'WO-2089: the STL sharp edge lit under the cursor while a Chamfer is armed or open, drawn by paintStlEdges and cleared when no Chamfer is armed. A hover state on the open STL body, ruled out of this debug channel\'s scope like stlBody -- a debug-scene reload does not reopen the STL or re-arm a tool.',
  },
  stlRedrawAfterApplyRef: { ruling: 'internal', note: 'WO-2120: marks the STL row whose next redraw follows an applied edit, so the console keeps the "applied" line instead of a reopen line. Plumbing for console wording; draws nothing.' },
  offered: {
    ruling: 'transient',
    note: 'WO-2121: whether the status-bar "Cancel operation" button is showing (a geometry operation has waited over 2 s). Status-bar chrome, not scene content; cleared when the call settles.',
  },
  kernelRestartRef: { ruling: 'internal', note: 'WO-2121: the handle that abandons a never-finishing kernel call and restarts the geometry worker (Cancel). Plumbing, draws nothing.' },
  kernelRestartingRef: { ruling: 'internal', note: 'WO-2121: true while Cancel restarts the geometry worker and rebuilds the model; guards re-entry. Plumbing, draws nothing.' },
}
