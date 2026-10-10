// WO SKC-15B (S3), the mount: the workbench's own reactivity for a live sketch session.
//
// WHY THIS EXISTS AT ALL. `SketcherOverlaysPort`'s members are React HOOKS, called in render, so
// the port object must be referentially stable for the life of the mount -- a MODULE CONST (the
// do-not-redo rule from SKC-14C: "ports are MODULE CONSTS or stable refs, never built per-render").
// A module const cannot read the page's `useState`. CAM solves this by handing the package seven
// `useCamStore` selectors; the workbench has no store, and SKC-14B closed the CAM-store window
// (`src/store/index.ts` is frozen, and reopening it is a bounce).
//
// So the workbench brings the smallest possible reactivity of its own: the exact
// subscribe/getSnapshot pair the keystone `src/tests/sketch/sketcherOverlays.test.tsx` uses for its
// store-free host ("the cheapest correct thing a host with no framework can do"), and the same
// hand-rolled shape the package's own `toolStore.ts` / `menuStore.ts` already use. No
// state-management dependency enters the workbench, and no sketch state enters the CAM store.
//
// TWO SLOTS, deliberately separate:
//
//   * STATE (`SketchSessionState`) -- what the overlays subscribe to. Small, immutable, replaced
//     wholesale so `useSyncExternalStore`'s Object.is bail-out works per selector.
//   * DEPS (`SketchSessionDeps`) -- the page's `FeatureDag` / `CommandHistory` / `RegenScheduler` /
//     solver wrapper, published ONCE from the page's mount effect (the same one-write-path shape
//     `camOverlaysPort.ts` uses for `setCamOverlaySurface`). These are stable refs, never state:
//     nothing re-renders when they arrive.
//
// The DAG node payload remains the DOCUMENT OF RECORD -- `sketch` below is a mirror the overlays
// and the interaction layer read, and every write goes to BOTH (see workbenchSketchDocumentPort.ts).
// Nothing is persisted from here.
import type { CommandHistory, FeatureDag, RegenScheduler } from '../../../doc'
import type { GcsWrapper } from '@salusoft89/planegcs'
import type { PlaneFrame } from '../../../sketch3d/planeMath'
import type { SketchDimEditorState, SketcherOverlaySurface } from '../../../lib/sketch/sketcher'
import type { ProjectSourceResolverContext } from '../../../lib/sketch/sketcher/ports'
import type { ProjectResolveResult } from '../../../lib/sketch/projectUse'
import type {
  Sketch, SketchNoticeSeverity, SketchViewState,
} from '../../../lib/sketch/sketcher'
import type { SketchPointEntity } from '../../../lib/sketch/types'
import type { BlockEditSessionMeta } from '../../../lib/sketch/blocks'
import type { Units } from '../../../lib/ui/unitFormat'
import { resolveSolverAvailability, type SolverAvailability } from './solverAvailability'
import {
  injectWorkbenchOrigin,
  WORKBENCH_ORIGIN_ENTITY_ID,
  WORKBENCH_ORIGIN_FIX_ID,
  WORKBENCH_AXIS_X_ENTITY_ID,
  WORKBENCH_AXIS_X_FIX_ID,
  WORKBENCH_AXIS_Y_ENTITY_ID,
  WORKBENCH_AXIS_Y_FIX_ID,
} from './workbenchOriginAnchor'

/** WO SKC-49: the view-state Sets are built ONCE at module scope, not per getViewState() call --
 *  they are immutable (the two axis ids never change), and sketchLayer.ts's own Object.is
 *  shallowEqual bail-out (setState) depends on referential stability wherever possible. */
const AXIS_ENTITY_IDS: ReadonlySet<string> = new Set([WORKBENCH_AXIS_X_ENTITY_ID, WORKBENCH_AXIS_Y_ENTITY_ID])
const AXIS_FIX_IDS: ReadonlySet<string> = new Set([WORKBENCH_AXIS_X_FIX_ID, WORKBENCH_AXIS_Y_FIX_ID])

/** Everything a live workbench sketch session holds. `active: false` is the whole rest-state: at
 *  rest the sketch DOM does not exist (every overlay gates on `useIsSketchActive`). */
export interface SketchSessionState {
  active: boolean
  /** Reactive mirror of the host's async solver getter. Definition badges
   *  subscribe here because a mutable getter alone cannot wake React. */
  solverAvailability: SolverAvailability
  /** The CAM `Sketch` under edit -- NOT a Sketch3dDocument. See the payload trap in the SKC-15
   *  report: CAM's model is the SUPERSET, there is no reverse converter, and round-tripping through
   *  Sketch3dDocument would silently drop splines/text/ellipses. */
  sketch: Sketch | null
  /** The DAG node id (`sketch3d:<rawId>`) whose payload carries `sketch`. */
  sketchNodeId: string | null
  /** The plane the session is drawn on (a base plane or a face-plane datum). */
  frame: PlaneFrame | null
  /** Sketch-scoped selection. NOT the DAG/tree selection the page's `selectedId` holds. */
  selectedIds: string[]
  dimEditor: SketchDimEditorState | null
  /** Always null: the workbench arms no text tool. Kept because the port's shape demands it, and a
   *  NAMED always-null is a contract, where a missing member is a crash. */
  textEditId: string | null
  /** WO SKC-17 (BK-123(2)): CAM parity for the constraint-glyph show/hide toggle
   *  (useCamStore.sketchGlyphsVisible). A display PREFERENCE, not per-document state -- like CAM's
   *  field, it survives across `begin()`/`end()` (a session boundary is not a reason to re-show
   *  glyphs the user just hid) and only a fresh page load or the `__reset()` test seam clears it. */
  glyphsVisible: boolean
  /** SKC-BLOCKS Stage 4 (workbench parity): the block currently open for edit-in-place, or null.
   *  Mirrors CAM's `sketchBlockEditId` store field -- the toolbox banner, the shared package's
   *  context menu gate, and its Enter/Esc key routing (sketchInteraction.ts) all read this through
   *  `workbenchOverlaysPort.useBlockEditId` / `workbenchSketchDocumentPort.getBlockEditId`. */
  blockEditId: string | null
  /** The edited block's ORIGINAL (pre-detach) non-member entity ids -- `BlockEditSessionMeta.outerIds`,
   *  captured at begin. `getViewState` ghosts everything else while a session is open (CAM's
   *  `sketchBlockEditOuterIds` twin). Null when no session is open. */
  blockEditOuterIds: readonly string[] | null
}

const REST: SketchSessionState = {
  active: false, solverAvailability: 'not-started', sketch: null, sketchNodeId: null, frame: null,
  selectedIds: [], dimEditor: null, textEditId: null, glyphsVisible: true,
  blockEditId: null, blockEditOuterIds: null,
}

/** The page's long-lived objects. Published once from its mount effect; never reactive. */
export interface SketchSessionDeps {
  dag: FeatureDag
  history: CommandHistory
  scheduler: RegenScheduler
  /** Live pitch used by both the visible workbench sketch grid and package snapping. */
  getGridSpacing?: () => number
  /** WO-1485: the live display-units preference (`appSettings.displayUnits`), supplied by the page
   *  the same way `getGridSpacing` is. Optional so test harnesses that predate it keep compiling;
   *  the document port falls back to 'mm' (the canonical unit) when it is absent. Presentation
   *  only -- stored geometry is always mm. */
  getDisplayUnits?: () => Units
  /** The synchronous planegcs wrapper (`createGcsWrapper()`, awaited once at page boot).
   *
   *  NULL until that boot resolves, and the port must survive it: a sketch drawn before the solver
   *  is ready is committed UNSOLVED rather than crashing, and says so. This is not hypothetical --
   *  `createGcsWrapper` loads a wasm module. Every read of it below is guarded BY NAME. */
  wrapper: GcsWrapper | null
  /** WO-120: WHY the wrapper is null, when it is.
   *
   *  A null wrapper used to mean two different things -- "not ready yet" and
   *  "its bounded recovery is spent and it is never coming" -- and the seams
   *  that read it could not tell them apart, so they told the user to wait
   *  forever (see solverAvailability.ts for the full defect). The host now
   *  NAMES the state instead of leaving it to be inferred.
   *
   *  A stable ref like every other member here, read through a getter on the
   *  page (`get solverStatus()`) so the async boot needs no re-bind -- exactly
   *  how `wrapper` itself is published.
   *
   *  Optional only so the test harnesses that predate it keep compiling;
   *  `resolveSolverAvailability` defaults an absent value to 'loading', which
   *  is precisely what every seam assumed before this WO. */
  solverStatus?: SolverAvailability
  /** Presentation sink -> the page's BottomConsole. */
  notice: (message: string, severity: SketchNoticeSeverity) => void
  /** Optional host-geometry reader for Project / Use. The package owns the pointer gesture and
   *  passes one raw event context through this seam; the workbench resolves its live body cache. */
  resolveProjectSource?: (context: ProjectSourceResolverContext) => ProjectResolveResult
  /** "The sketch node's payload changed": the page marks it dirty, re-runs regen, and re-renders.
   *  The port never touches the scheduler itself -- one owner of the regen call. */
  onDocumentChanged: (nodeId: string) => void
  /** WO SKC-15C-R1 (B2): "a package undo step just entered `history`". The port pushes exactly one
   *  `Command` per gesture onto the workbench `CommandHistory` (see `commitSketch`); the page keeps a
   *  PARALLEL touched-id stack (`touchedPastRef`) that `handleUndo`/`handleRedo` pop to know which
   *  nodes to re-dirty and resync. Before this callback, package commands entered `history` WITHOUT a
   *  parallel entry, so the two stacks drifted: one workbench Undo mutated the DAG but never resynced
   *  the live package document (the S3 gate blocker). The port fires this the ONCE per gesture that it
   *  actually executes a command, and the page records `[nodeId]` and clears the redo tail -- keeping
   *  the two stacks in lockstep exactly as every dialog/suppress/reorder command already does. */
  onHistoryStep: (nodeId: string) => void
}

type Listener = () => void

class SketchSessionStore {
  private state: SketchSessionState = REST
  private deps: SketchSessionDeps | null = null
  private readonly listeners = new Set<Listener>()
  private solverAvailabilityPoll: ReturnType<typeof setInterval> | null = null

  getState = (): SketchSessionState => this.state

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  setState = (patch: Partial<SketchSessionState>): void => {
    const next = { ...this.state, ...patch }
    // Reference-stable when nothing changed: the overlays' per-selector Object.is bail-out depends
    // on it, and a live rAF loop must not churn on an unrelated write.
    if (shallowEqual(next, this.state)) return
    this.state = next
    for (const l of [...this.listeners]) l()
  }

  /** Enter a session on `frame`, editing the sketch carried by `sketchNodeId`.
   *
   *  WO UI-50C-R2 (write-path census, document-boundary ingestion) NAMED
   *  RULING: `sketch` is whatever the host's dag node payload carried.
   *  This does NOT re-normalize it here -- the DOCUMENT OF RECORD is the
   *  dag node payload (this file's own header: "Nothing is persisted from
   *  here"), and the page's ONE ingestion boundary
   *  (`FeatureDag.restore`, SolidsWorkbenchPage.tsx) already normalizes
   *  every sketch-bearing payload UNCONDITIONALLY before any `begin()` call
   *  can ever read it -- mirroring `migrateProjectData`'s own unconditional
   *  load-boundary precedent. A SECOND normalization here, of the SESSION
   *  MIRROR only, was tried and reverted: it made a corrupted document look
   *  clean to `toggleDimensionDriving`'s own `!dim.driving` gate WITHOUT
   *  ever writing the fix through to the dag (mirror and payload are two
   *  copies; only a real commit -- `append`/`replace` -- syncs them), so
   *  the corrupted payload silently survived AND the deliberate
   *  driving->reference repair action stopped working
   *  (`workbenchSketchMount.test.ts`'s own toggle-repair test caught this
   *  live). Every OTHER path that can populate a dag node's `sketch`
   *  payload is either the guarded FeatureDag.restore boundary above, a
   *  freshly tool-authored sketch (never forges driving:true by
   *  construction), or a prior GUARDED commit (append/replace, both
   *  normalized) -- so there is nothing left for this call to ingest
   *  unnormalized. */
  begin = (sketchNodeId: string, frame: PlaneFrame, sketch: Sketch): void => {
    this.setState({
      active: true,
      sketchNodeId,
      frame,
      sketch: injectWorkbenchOrigin(sketch, frame),
      selectedIds: [],
      dimEditor: null,
      textEditId: null,
    })
  }

  /** Leave the session. Every field returns to rest -- a stale `sketch` outliving `active: false`
   *  is how an overlay paints over a document that is no longer open. `glyphsVisible` is carried
   *  through: it is a display PREFERENCE (CAM parity), not session state, so finishing a sketch must
   *  not silently re-show glyphs the user just hid. */
  end = (): void => {
    this.blockEditMeta = null
    this.blockEditReturnSketch = null
    this.setState({
      ...REST,
      glyphsVisible: this.state.glyphsVisible,
      solverAvailability: this.state.solverAvailability,
    })
  }

  /** WO SKC-17 (BK-123(2)): the CAM `toggleSketchGlyphs` twin. A pure store flip is not enough --
   *  the package's layer only re-reads `glyphsVisible` when `Sketcher.updateSketch(sketch, view)` is
   *  next called (sketchLayer.ts's `update()` only reassigns `this.view` when one is passed), and
   *  nothing else re-renders on a plain state change. Re-firing `onDocumentChanged` (the SAME deps
   *  callback every commit already drives, now carrying `getViewState()` -- see the page's
   *  `bindSketchSessionDeps`) is the one already-wired path from HERE to the live layer without a
   *  second page-side seam. It also marks the node dirty for the next regen pass, which is harmless
   *  (a pure display toggle changes no geometry, so a re-run produces the identical profile) and
   *  cheaper than adding a repaint-only deps member the page would have to wire on top of it. */
  toggleGlyphsVisible = (): void => {
    this.setState({ glyphsVisible: !this.state.glyphsVisible })
    const { sketchNodeId } = this.state
    if (sketchNodeId !== null) this.deps?.onDocumentChanged(sketchNodeId)
  }

  /** The view state the package's `Sketcher.layer` needs to render selection highlight + gate its
   *  constraint-glyph badges (`SketchViewState.glyphsVisible`, sketchLayer.ts:1472). A fresh object
   *  each call -- the layer's `update()` only reassigns `this.view` when one is passed, so the
   *  mount's `updateSketch(sketch, getViewState())` calls (bindSketchSessionDeps' onDocumentChanged,
   *  beginPackageSketch's initial paint, the undo/redo resync effect) are what actually carries this
   *  preference into the shared package -- see those three call sites' comments for why the mount,
   *  not this store, must be the one to pass it (the package's `updateSketch` is the only public seam
   *  a host has for view state; nothing here forks package internals). Never used while `!active`:
   *  every caller already guards on the session being live. */
  getViewState = (): SketchViewState => {
    const originAnchorEntity = this.state.sketch?.entities.find(
      (entity): entity is SketchPointEntity =>
        entity.id === WORKBENCH_ORIGIN_ENTITY_ID && entity.kind === 'point',
    )
    return {
      selectedIds: new Set(this.state.selectedIds),
      glyphsVisible: this.state.glyphsVisible,
      editingId: null,
      caretIndex: null,
      originAnchorId: WORKBENCH_ORIGIN_ENTITY_ID,
      originAnchorFixId: WORKBENCH_ORIGIN_FIX_ID,
      axisEntityIds: AXIS_ENTITY_IDS,
      axisFixIds: AXIS_FIX_IDS,
      // SKC-BLOCKS Stage 4: while a block edit-in-place session is open, ghost everything that is
      // NOT part of the edited block (the captured outerIds), excluding the origin/axis anchors --
      // those are the shared session backdrop, not "the rest of the sketch", exactly like CAM's own
      // Viewport.tsx filter (SKETCH_ORIGIN_ENTITY_ID / CAM_AXIS_ENTITY_IDS).
      blockEditGhostIds: this.state.blockEditId !== null
        ? new Set(
            (this.state.blockEditOuterIds ?? []).filter(
              (id) => id !== WORKBENCH_ORIGIN_ENTITY_ID && !AXIS_ENTITY_IDS.has(id),
            ),
          )
        : undefined,
      ...(originAnchorEntity === undefined ? {} : { originAnchorEntity }),
    }
  }

  // ---- Block edit-in-place session bookkeeping (SKC-BLOCKS Stage 4) -----------------------------
  //
  // Mirrors CAM's module-scope `sketchBlockEditMeta`/`sketchBlockEditReturnSketch` vars (src/store/
  // index.ts) -- but as private fields on this class store, since the workbench has no module-level
  // "the store" the way CAM's zustand slice does. `blockEditId`/`blockEditOuterIds` above are the
  // REACTIVE half (state, for the banner/ghost/context-menu); `meta`/`returnSketch` are the id/frame
  // + pre-edit-snapshot bookkeeping only `workbenchSketchDocumentPort`'s begin/finish/cancel commands
  // need, so they never enter `SketchSessionState` (no overlay reads them).
  private blockEditMeta: BlockEditSessionMeta | null = null
  private blockEditReturnSketch: Sketch | null = null

  /** Open a block edit-in-place session. Called by `workbenchSketchDocumentPort.beginBlockEdit`
   *  AFTER the detached document has already been committed through the one write path -- this only
   *  records the session cursor + the bookkeeping finish/cancel need. */
  beginBlockEditSession = (blockId: string, meta: BlockEditSessionMeta, returnSketch: Sketch): void => {
    this.blockEditMeta = meta
    this.blockEditReturnSketch = returnSketch
    this.setState({ blockEditId: blockId, blockEditOuterIds: meta.outerIds })
  }

  /** The captured session metadata, or null when no session is open. */
  getBlockEditMeta = (): BlockEditSessionMeta | null => this.blockEditMeta

  /** The pre-edit document, for `cancelBlockEdit` to restore verbatim. */
  getBlockEditReturnSketch = (): Sketch | null => this.blockEditReturnSketch

  /** Close the session. The caller (finish/cancel) has already committed the resulting document
   *  through the one write path -- this only clears the cursor + bookkeeping. */
  endBlockEditSession = (): void => {
    this.blockEditMeta = null
    this.blockEditReturnSketch = null
    this.setState({ blockEditId: null, blockEditOuterIds: null })
  }

  // ---- Deps: the page's one write path (mirrors camOverlaysPort's setCamOverlaySurface) --------

  private stopSolverAvailabilityPoll = (): void => {
    if (this.solverAvailabilityPoll === null) return
    clearInterval(this.solverAvailabilityPoll)
    this.solverAvailabilityPoll = null
  }

  private syncSolverAvailability = (): void => {
    const solverAvailability = resolveSolverAvailability(this.deps)
    this.setState({ solverAvailability })
    if (solverAvailability === 'ready' || solverAvailability === 'unavailable') {
      this.stopSolverAvailabilityPoll()
    }
  }

  bindDeps = (deps: SketchSessionDeps | null): void => {
    this.stopSolverAvailabilityPoll()
    this.deps = deps
    this.syncSolverAvailability()
    // SolidsWorkbenchPage publishes wrapper/solverStatus through getters so
    // async boot does not rebuild the deps object. Poll only while that boot
    // can still change, and mirror each transition through setState so every
    // subscribed host receives a real notification (WO-201).
    if (
      deps !== null
      && this.state.solverAvailability !== 'ready'
      && this.state.solverAvailability !== 'unavailable'
    ) {
      this.solverAvailabilityPoll = setInterval(this.syncSolverAvailability, 25)
    }
  }

  /** The bound deps, or null before the page's mount effect has run / after its cleanup. Every
   *  caller must handle null rather than assert -- a keyboard shortcut can outlive a mount teardown
   *  by a frame (the same reason `sketcherDocument()` returns nullable). */
  getDeps = (): SketchSessionDeps | null => this.deps

  // ---- The projection surface, published by the mount effect (null before/after it) ------------

  private surface: SketcherOverlaySurface | null = null
  setSurface = (s: SketcherOverlaySurface | null): void => {
    this.surface = s
  }
  getSurface = (): SketcherOverlaySurface | null => this.surface

  /** Test seam ONLY. */
  __reset = (): void => {
    this.stopSolverAvailabilityPoll()
    this.state = REST
    this.deps = null
    this.surface = null
    this.blockEditMeta = null
    this.blockEditReturnSketch = null
    for (const l of [...this.listeners]) l()
  }
}

/** Arrays compare by CONTENT (selectedIds is rebuilt on every marquee move); everything else by
 *  identity. Without the array case the overlays re-render on every pointermove of a marquee. */
function shallowEqual(a: SketchSessionState, b: SketchSessionState): boolean {
  for (const k of Object.keys(a) as Array<keyof SketchSessionState>) {
    const av = a[k]
    const bv = b[k]
    if (Array.isArray(av) && Array.isArray(bv)) {
      if (av.length !== bv.length || av.some((x, i) => x !== bv[i])) return false
    } else if (av !== bv) {
      return false
    }
  }
  return true
}

/** THE workbench sketch session. One per process, like the package's own tool/menu stores. */
export const sketchSessionStore = new SketchSessionStore()

// DEV-only read handle for console / Playwright gate probes -- mirrors the
// __camStore dev seed (demoSeed.ts registerSketchDevSeed). The workbench sketch
// session has no other global read hook, so headed captures cannot otherwise
// inspect its live block-definition/instance state. Guarded so it never ships;
// distinct name (not the __cncViewport bridge INT-13B forbids the workbench from
// touching).
if (import.meta.env?.DEV) {
  ;(globalThis as unknown as { __sketchSessionStore?: SketchSessionStore }).__sketchSessionStore = sketchSessionStore
}
