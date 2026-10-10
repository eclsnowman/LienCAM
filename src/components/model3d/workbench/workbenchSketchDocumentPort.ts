// WO SKC-15B (S3), item 1: the DAG-backed `SketchDocumentPort` -- all 33 members (SKC-46 added the
// staged-size memory pair, 27 -> 29; SKC-BLOCKS Stage 4 added the optional block-edit-in-place
// quartet -- getBlockEditId/beginBlockEdit/finishBlockEdit/cancelBlockEdit -- 29 -> 33).
//
// The twin of `camSketchDocumentPort` (src/store/index.ts, frozen). Where CAM's implementation
// reads/writes a zustand slice and posts to a solver WORKER, this one reads/writes a `FeatureDag`
// node payload and solves SYNCHRONOUSLY in-process on a `GcsWrapper`. Neither history type leaks
// into the package (plan R3): CAM pushes a snapshot onto `sketchHistory`, the workbench pushes a
// `Command` onto `CommandHistory`, and the package knows about neither.
//
// Everything here is a READ of data the host owns, a semantic COMMIT, or a presentation sink. There
// is no branch on the armed tool anywhere below -- that is what makes a second version of the felt
// behavior impossible to write here.
//
// ---- THE PAYLOAD (the SKC-15 report's data-loss trap) ----------------------------------------
//
// The workbench DAG has always stored a `Sketch3dDocument`. THE Sketcher edits a CAM `Sketch`. A
// forward converter exists (solveBridge.ts:198) but there is NO reverse one, and CAM's model is the
// SUPERSET -- round-tripping would silently drop splines, text, ellipses and elliptical arcs. So a
// package-authored sketch node carries a NEW payload field, `sketch`, ALONGSIDE the old `document`
// field. Nothing converts. The executor branches on which is present:
//   * `payload.sketch`   -> this mount wrote it. Profile via workbench/sketchProfile.ts.
//   * `payload.document` -> the old sketch3d path wrote it. Untouched by this WO (S5 deletes it).
//   * `payload.profile`  -> written by BOTH, read by extrude/revolve/sweep/loft unchanged.
//
// ---- THE UNDO ADAPTER (ports.ts:98, "the constraint that decides whether S3 can land at all") ---
//
// The package guarantees ONE undo step per gesture: it latches `SketchUndoSink.beginGesture()` into
// the first mutation of a gesture and swallows the rest; non-gesture commits call `beginStep()`.
// Both land on `openStep()` below, and each such call is exactly one gesture.
//
// The subtlety is that `CommandHistory.execute(cmd)` RUNS `cmd.do(dag)`. We cannot execute at the
// start of a gesture (we do not yet know the final payload) and we cannot construct an
// `EditFeaturePayloadCommand` at the END of one (its `do()` captures the CURRENT payload as the
// undo target -- which by then is the already-dragged state, so undo would restore the drag).
//
// So: `openStep()` snapshots `before`. The FIRST mutation of the step builds a `SketchStepCommand`
// carrying that `before`, and hands it to `history.execute()`; the command's first `do()` is a
// deliberate no-op because the mutation has ALREADY landed in the dag. Every LATER mutation of the
// same gesture (each `dragMove`, each `moveDimLabel` of a label drag) updates that command's
// `after` in place. Result: one command per gesture, `undo()` lands at pre-gesture, `redo()`
// re-applies the gesture's FINAL state. A gesture that mutates nothing never opens a step and never
// costs the user a wasted Ctrl+Z.
import type { Command, FeatureDag } from '../../../doc'
import type { PlaneFrame } from '../../../sketch3d/planeMath'
import type { SketchDocumentPort, SketchNoticeSeverity } from '../../../lib/sketch/sketcher'
import type {
  Sketch, SketchConstraint, SketchEntity, Vec2,
} from '../../../lib/sketch/sketcher'
import type { ToolCommit } from '../../../lib/sketch/tools/toolMachine'
import { toggleConstructionFlags } from '../../../lib/sketch/tools/toolMachine'
import type { SketchDocTransform } from '../../../lib/sketch/tools/trimTool'
import { deleteFromSketch } from '../../../lib/sketch/deleteSelection'
import {
  beginBlockEdit as beginBlockEditPure, finishBlockEdit as finishBlockEditPure,
} from '../../../lib/sketch/blocks'
import { appendDragSnapConstraint } from '../../../lib/sketch/dragSnap'
import { splineControlPointDragTarget } from '../../../lib/sketch/spline'
import { solveSketchOnWrapper, type DragRequest, type DragTarget } from '../../../lib/sketch/solver/gcsMapping'
import {
  remeasureReferenceDimensions, angleLabelDragValueOverride,
} from '../../../lib/sketch/tools/dimTool'
import type { Units } from '../../../lib/ui/unitFormat'
// SKC-46: staged-size memory shares CAM's uiPrefs persist surface (sketcher parity: one memory,
// both hosts) -- the same file the workbench already reads for camera projection / panel prefs.
import { useUiPrefs } from '../../../store/uiPrefs'
import { sketchSessionStore, type SketchSessionDeps } from './sketchSessionStore'
import { resolveSolverAvailability, unsolvedDocumentNotice } from './solverAvailability'
import {
  injectWorkbenchOrigin,
  stripWorkbenchOrigin,
  isInjectedSketchAnchorId,
} from './workbenchOriginAnchor'

// ---- The undoable step -------------------------------------------------------------------------

/**
 * ONE gesture's worth of sketch payload change, as a `Command`.
 *
 * `alreadyApplied` starts true because the mutation that built this command has already written the
 * dag (the package mutates first, then we record). `CommandHistory.execute()` calls `do()` once,
 * immediately -- that call is the no-op. A later `redo()` calls `do()` again, and by then the flag
 * is false, so it really applies `after`.
 */
class SketchStepCommand implements Command {
  readonly label = 'editSketchStep'
  private readonly id: string
  private readonly before: Record<string, unknown>
  private after: Record<string, unknown>
  private alreadyApplied = true

  constructor(id: string, before: Record<string, unknown>, after: Record<string, unknown>) {
    this.id = id
    this.before = before
    this.after = after
  }

  /** Later mutations inside the SAME gesture extend this step rather than opening a new one. */
  extend(after: Record<string, unknown>): void {
    this.after = after
  }

  do(dag: FeatureDag): void {
    if (this.alreadyApplied) {
      // The very first execute(): the gesture's write is already in the dag. Re-writing it here
      // would be harmless but pointless; skipping keeps `execute()` free of a redundant payload
      // churn that would invalidate the node's regen state for no reason.
      this.alreadyApplied = false
      return
    }
    dag.setPayload(this.id, this.after)
  }

  undo(dag: FeatureDag): void {
    dag.setPayload(this.id, this.before)
    // A subsequent redo() must APPLY, not skip.
    this.alreadyApplied = false
  }

  serialize(): unknown {
    return { type: 'editSketchStep', id: this.id }
  }
}

/** The step currently open, or null between gestures. */
interface OpenStep {
  nodeId: string
  before: Record<string, unknown>
  cmd: SketchStepCommand | null
}
let openStep: OpenStep | null = null

/** Test seam ONLY: the module-level step latch must not leak between tests. */
export function __resetSketchDocumentPort(): void {
  openStep = null
  dragPlan = null
}

// ---- Small helpers -----------------------------------------------------------------------------

function deps(): SketchSessionDeps | null {
  return sketchSessionStore.getDeps()
}

/** The live payload of the session's sketch node, or null when there is no session. */
function currentPayload(): Record<string, unknown> | null {
  const d = deps()
  const { sketchNodeId } = sketchSessionStore.getState()
  if (d === null || sketchNodeId === null) return null
  return d.dag.getNode(sketchNodeId)?.payload ?? null
}

/**
 * THE single write path. Mirrors the new `sketch` into BOTH the session store (what the overlays and
 * the interaction layer read) and the dag node payload (the document of record), records the write
 * into the open undo step if one is open, and tells the page to re-run regen.
 */
function commitSketch(next: Sketch, opts?: { clearSelection?: boolean }): void {
  const d = deps()
  const { sketchNodeId, frame } = sketchSessionStore.getState()
  if (d === null || sketchNodeId === null) return
  if (frame === null) {
    d.notice('Sketch edit refused: the active workbench sketch has no plane frame.', 'error')
    return
  }

  const prior = d.dag.getNode(sketchNodeId)?.payload
  if (prior === undefined) return
  const sessionNext = injectWorkbenchOrigin(next, frame)
  const nextPayload: Record<string, unknown> = { ...prior, sketch: stripWorkbenchOrigin(sessionNext) }
  d.dag.setPayload(sketchNodeId, nextPayload)

  sketchSessionStore.setState({
    sketch: sessionNext,
    ...(opts?.clearSelection ? { selectedIds: [] } : {}),
  })

  if (openStep !== null && openStep.nodeId === sketchNodeId) {
    if (openStep.cmd === null) {
      openStep.cmd = new SketchStepCommand(sketchNodeId, openStep.before, nextPayload)
      d.history.execute(openStep.cmd) // first do() is a no-op; the write above already landed
      // WO SKC-15C-R1 (B2): tell the page a package undo step just entered `history`, so its parallel
      // touched-id stack stays in lockstep. Fired EXACTLY here -- the ONE place per gesture where a
      // Command is actually pushed (later mutations of the SAME gesture call `extend`, which pushes
      // nothing). Without this, `handleUndo` popped an empty parallel stack, `history.undo()` reverted
      // the DAG payload, and nothing resynced the live document (the S3 gate blocker).
      d.onHistoryStep(sketchNodeId)
    } else {
      openStep.cmd.extend(nextPayload)
    }
  }

  d.onDocumentChanged(sketchNodeId)
}

/**
 * Open ONE undoable step. Called exactly once per gesture (the package latches it) and once per
 * non-gesture commit. Opening a new step FINALIZES the previous one implicitly -- its command is
 * already in history with its final `after`, so there is nothing to flush.
 */
function openStepNow(): void {
  const { sketchNodeId } = sketchSessionStore.getState()
  const payload = currentPayload()
  if (sketchNodeId === null || payload === null) return
  openStep = { nodeId: sketchNodeId, before: payload, cmd: null }
}

/**
 * Solve `sketch` in-process and return the settled document.
 *
 * REFUSES BY NAME rather than crashing when the wasm solver has not booted (`wrapper === null`):
 * the geometry the user drew is kept exactly as drawn,
 * `solveStatus` stays null (UNKNOWN, which every downstream gate already handles -- see CAM's
 * `beginSketchDrag`: "status null = never solved (UNKNOWN): the gate must not refuse off a status
 * that doesn't exist"), and the user is told once. Never NaN, never a throw.
 *
 * NOT exported: every caller below hands it a sketch that already carries the injected workbench
 * origin/axis anchors (`sketchSessionStore.getState().sketch`, or -- for the SKC-78 open path --
 * `resolveOpenSketch`'s own inject step). Solving WITHOUT them would either mis-map any origin/axis-
 * referencing dimension (their target entity ids would not exist) or under-constrain a sketch that
 * depends on them. `resolveOpenSketch` is the one seam a caller outside this module needs.
 */
function solved(sketch: Sketch, drag?: DragRequest): Sketch {
  const d = deps()
  if (d === null) return { ...sketch, solveStatus: null }
  if (d.wrapper === null) {
    // WO-120: WHICH null is this? 'loading' and 'unavailable' are different
    // facts and the user needs the difference: one is worth waiting for and the
    // other never will be. Severity stays 'warning' in both cases -- a
    // solverless workbench is DEGRADED, not broken (everything still works,
    // sketches just commit as drawn), and the same reasoning picked
    // var(--warning) over danger red on the status strip.
    d.notice(unsolvedDocumentNotice(resolveSolverAvailability(d)), 'warning')
    return { ...sketch, solveStatus: null }
  }
  let outcome
  try {
    outcome = solveSketchOnWrapper(d.wrapper, sketch, drag)
  } catch (err) {
    // A mapping error in the solver is a bug, not a user error -- but it must not take the sketch
    // session down with it. Named, surfaced, geometry preserved as drawn, and
    // the failed verdict replaces any stale successful status (WO-201).
    const failureMessage = err instanceof Error ? err.message : String(err)
    d.notice(`The constraint solver failed: ${failureMessage}`, 'error')
    return {
      ...sketch,
      solveStatus: {
        dof: 0,
        conflicting: [],
        redundant: [],
        fullyDefinedEntities: sketch.solveStatus?.fullyDefinedEntities,
        solveFailed: true,
        failureMessage,
      },
    }
  }
  if (!outcome.ok) {
    d.notice(outcome.message, outcome.reason === 'conflicting' ? 'warning' : 'error')
    return { ...sketch, solveStatus: outcome.status }
  }
  return {
    ...sketch,
    entities: outcome.entities,
    dimensions: remeasureReferenceDimensions(outcome.entities, sketch.dimensions, sketch.constraints),
    solveStatus: outcome.status,
  }
}

/**
 * SKC-78: force a fresh solve of a sketch node's PERSISTED (raw, un-injected) payload, for the
 * host's open path -- `SolidsWorkbenchPage.beginPackageSketch` calls this before
 * `sketchSessionStore.begin()` even opens a session, so the status chip is never seeded from a
 * stale/wrong persisted `solveStatus` (SKC-77's after-capture: a document saved mid-bug kept
 * showing its stale DoF count until the user's first edit happened to trigger a solve; CAM's own
 * `setActiveSketch`, src/store/index.ts:8907, already makes this guarantee on every document open).
 *
 * Runs the EXACT inject -> solve -> strip round trip `commitSketch` runs on every live edit
 * (`sessionNext = injectWorkbenchOrigin(next, frame)`, `solved(...)`, `stripWorkbenchOrigin(...)`
 * before the result reaches the dag payload) -- the raw payload never carries the origin/axis
 * anchors (`commitSketch` always strips them before persisting), so solving it directly, unijected,
 * would mis-map any dimension/constraint that references them. Returns a value in the SAME shape
 * `node.payload.sketch` is always stored in (stripped), so a caller can write the result straight
 * back with no further conversion. Requires `sketchSessionStore`'s deps to already be bound (reads
 * the wrapper/notice sink through `deps()`, same as every other member here).
 */
export function resolveOpenSketch(rawSketch: Sketch, frame: PlaneFrame): Sketch {
  const resolved = stripWorkbenchOrigin(solved(injectWorkbenchOrigin(rawSketch, frame)))
  // WO-108: if the solver was not there, `solved()` warned and handed the sketch
  // straight back -- INCLUDING the persisted solveStatus this function exists to
  // distrust. Displaying that number claims a verification that never happened,
  // which is SKC-78's own defect wearing a different hat.
  //
  // This became reachable in normal use when WO-108 stopped gating Ready on the
  // constraint solver: a workbench is now usable in the window before the solver
  // lands, so a sketch really can be opened with `wrapper === null`. Null is the
  // UNKNOWN every downstream gate already handles (see solved()'s header), so the
  // chip reads "not solved" instead of a stale, confident, wrong DoF count.
  if (deps()?.wrapper == null && resolved.solveStatus !== null) {
    return { ...resolved, solveStatus: null }
  }
  return resolved
}

/**
 * WO-1864: solve a sketch node's persisted (raw) payload after the regen pass rewrote its linked
 * projected pieces to follow the model, so everything constrained to them moves in the SAME pass.
 * The same inject -> solve -> strip round trip as `resolveOpenSketch`, with the wrapper handed in
 * by the host (the regen pass runs with or without a live session) and NO notices: this runs on
 * every model change, and a solve that does not converge is reported through the persisted
 * `solveStatus` the sketch already shows, never a toast per resync. Geometry is never lost -- a
 * missing solver or a failed solve keeps the rewritten pieces where the model put them.
 */
export function solveRelinkedSketch(
  rawSketch: Sketch,
  frame: PlaneFrame,
  wrapper: SketchSessionDeps['wrapper'],
): Sketch {
  if (wrapper === null) return { ...rawSketch, solveStatus: null }
  const injected = injectWorkbenchOrigin(rawSketch, frame)
  try {
    const outcome = solveSketchOnWrapper(wrapper, injected)
    if (!outcome.ok) return stripWorkbenchOrigin({ ...injected, solveStatus: outcome.status })
    return stripWorkbenchOrigin({
      ...injected,
      entities: outcome.entities,
      dimensions: remeasureReferenceDimensions(outcome.entities, injected.dimensions, injected.constraints),
      solveStatus: outcome.status,
    })
  } catch (err) {
    const failureMessage = err instanceof Error ? err.message : String(err)
    return {
      ...rawSketch,
      solveStatus: {
        dof: 0, conflicting: [], redundant: [],
        fullyDefinedEntities: rawSketch.solveStatus?.fullyDefinedEntities,
        solveFailed: true, failureMessage,
      },
    }
  }
}

// ---- The select-tool drag ----------------------------------------------------------------------

/** The pinned point sites and the grab origin, for the life of one drag gesture. */
interface DragPlan {
  targets: Array<{ point: DragTarget['point']; orig: Vec2 }>
  grab: Vec2
}
let dragPlan: DragPlan | null = null

/** Which point sites a grab on `e` pins. Mirrors CAM's `beginSketchDrag`. */
function dragTargetsFor(e: SketchEntity, grab: Vec2, tolWorld: number): DragPlan['targets'] | null {
  if (e.kind === 'point') return [{ point: { entityId: e.id, site: 'self' }, orig: e.at }]
  if (e.kind === 'line') {
    const dStart = Math.hypot(grab.x - e.start.x, grab.y - e.start.y)
    const dEnd = Math.hypot(grab.x - e.end.x, grab.y - e.end.y)
    // Grab near an endpoint drags that endpoint alone; grabbing the body drags the line rigidly.
    if (dStart <= tolWorld && dStart <= dEnd) return [{ point: { entityId: e.id, site: 'start' }, orig: e.start }]
    if (dEnd <= tolWorld) return [{ point: { entityId: e.id, site: 'end' }, orig: e.end }]
    return [
      { point: { entityId: e.id, site: 'start' }, orig: e.start },
      { point: { entityId: e.id, site: 'end' }, orig: e.end },
    ]
  }
  if (e.kind === 'circle' || e.kind === 'arc' ||
      e.kind === 'ellipse' || e.kind === 'elliptical-arc') {
    return [{ point: { entityId: e.id, site: 'center' }, orig: e.center }]
  }
  // WO-1861: a grab on a control point of a control-point spline drags that
  // point alone (CAM's beginSketchDrag does the same).
  if (e.kind === 'spline') {
    const target = splineControlPointDragTarget(e, grab, tolWorld)
    if (target) return [target]
  }
  // Spline bodies / text have no canonical center and no whole-shape drag
  // contract here. Refusing by name beats streaming a silent no-op undo step.
  return null
}

// ---- THE PORT ----------------------------------------------------------------------------------
//
// A MODULE CONST, not a per-render object (SKC-14C do-not-redo). Everything it needs arrives through
// `sketchSessionStore`'s deps slot, published once by the page's mount effect.

export const workbenchSketchDocumentPort: SketchDocumentPort = {
  // ==== (a) Reads: data the host owns ============================================================

  // 1
  getSketch: (): Sketch | null => sketchSessionStore.getState().sketch,

  // 2. A tool click must NEVER silently no-op (ADR-0003). The workbench always enters a session
  //    with a sketch node already created on a plane (a blank document needs a plane, and planes are
  //    the host's), so this returns the open document. It returns null -- rather than inventing a
  //    plane -- when there is no session: the package then treats the click as a no-op it can
  //    explain, instead of writing geometry into a document that has nowhere to live.
  ensureSketch: (): Sketch | null => sketchSessionStore.getState().sketch,

  // 3. WO-1485: the SAME live display-units preference CAM's viewport consumes
  //    (`appSettings.displayUnits`), reached through the deps slot the page publishes -- exactly the
  //    pattern used by `getGridSpacing` below. The document is always mm; this is presentation only.
  //    The fallback keeps isolated/tests hosts (and any host before bindDeps) at mm.
  getDisplayUnits: (): Units => deps()?.getDisplayUnits?.() ?? 'mm',

  // 4. The visible workbench plane grid and the snap engine must consume the
  //    same live pitch. The fallback keeps isolated/tests hosts compatible.
  getGridSpacing: (): number => deps()?.getGridSpacing?.() ?? 10,

  // 5. CAM's fallback source remains an empty 2D-layer list in the workbench. Model geometry is
  //    supplied through resolveProjectSource below, so the package keeps one pointer owner and one
  //    hover/click identity path rather than teaching this port a second gesture engine.
  getProjectCandidates: () => [],

  resolveProjectSource: (context) => {
    const resolver = deps()?.resolveProjectSource
    return resolver === undefined
      ? {
          ok: false,
          reason: 'workbench-project-resolver-unavailable',
          message: 'Project: workbench model geometry is not ready',
        }
      : resolver(context)
  },

  // 6
  getSelection: (): readonly string[] => sketchSessionStore.getState().selectedIds,

  // 7
  setSelection: (ids: string[]): void => {
    sketchSessionStore.setState({ selectedIds: ids })
  },

  // ==== Staged-size memory (SKC-46) =============================================================
  // 7a. Shares CAM's `liencam-ui-prefs` persist surface -- sketcher parity: one memory, both hosts.
  //     `useUiPrefs` is a plain module-singleton store (the same category as `sketchSessionStore`
  //     this file already imports directly), not a per-session DAG resource, so it does not go
  //     through `SketchSessionDeps` (that slot is documented "nothing is persisted from here").
  getLastStagedSize: (kind: 'fillet' | 'chamfer'): number | null =>
    kind === 'fillet'
      ? useUiPrefs.getState().lastFilletRadius
      : useUiPrefs.getState().lastChamferSetback,
  // 7b
  setLastStagedSize: (kind: 'fillet' | 'chamfer', value: number): void => {
    if (kind === 'fillet') useUiPrefs.getState().setLastFilletRadius(value)
    else useUiPrefs.getState().setLastChamferSetback(value)
  },

  // ==== (c) Presentation ========================================================================

  // 8. Routed to the page's BottomConsole (already mounted). The package decides WHAT to say and
  //    WHEN; the host decides where it appears.
  notice: (message: string, severity: SketchNoticeSeverity = 'info'): void => {
    deps()?.notice(message, severity)
  },

  // ==== (b) Commits =============================================================================

  // 9. THE undo adapter. Non-gesture commits (the confirm overlay's Apply, a typed draw value,
  //    Enter-to-finish a spline) open their own step here. Pointer gestures never call this: they
  //    latch `SketchUndoSink.beginGesture` in the component, which lands on the same `openStepNow`.
  beginStep: (): void => {
    openStepNow()
  },

  // 10
  append: (
    commit: ToolCommit,
    inferred: SketchConstraint[],
    opts?: { openDimensionEditor?: boolean; clearSelection?: boolean },
  ): void => {
    const s = sketchSessionStore.getState().sketch
    if (s === null) return
    const next: Sketch = {
      ...s,
      entities: [...s.entities, ...commit.entities],
      constraints: [...s.constraints, ...commit.constraints, ...inferred],
      dimensions: [...s.dimensions, ...(commit.dimensions ?? [])],
    }
    commitSketch(solved(next), opts)

    // A freshly placed DRIVING dimension opens its value editor immediately, pre-filled with the
    // measured value (the intended behavior; CAM's chunk-1 path). CAM additionally runs a VERDICT solve
    // that auto-removes a conflicting placement -- that rides its solver worker's request/response
    // protocol, which this synchronous mount does not have. Here the solve above has ALREADY run,
    // so a conflicting dimension is reported by `solved()`'s notice and the editor still opens on
    // the measured value, which is the state the user needs to fix it from.
    const placedDim = opts?.openDimensionEditor ? commit.dimensions?.[0] : undefined
    if (placedDim !== undefined) {
      sketchSessionStore.setState({ dimEditor: { dimId: placedDim.id, isNew: true } })
    }
  },

  // 11. MODIFY tools (trim / fillet / chamfer) hand back full replacement arrays.
  replace: (next: SketchDocTransform, opts?: { clearSelection?: boolean }): void => {
    const s = sketchSessionStore.getState().sketch
    if (s === null) return
    commitSketch(solved({ ...s, ...next, dimensions: next.dimensions }), opts)
  },

  // 12. Selected entities win: flip THEIR flags as one undo step. Construction affects rendering and
  //     the profile filter, never the constraint network -- no re-solve. Returning false (the
  //     selection matched no entity) hands the decision back to the package, which then toggles its
  //     own draw-as-construction MODE.
  toggleSelectionConstruction: (): boolean => {
    const { sketch, selectedIds } = sketchSessionStore.getState()
    if (sketch === null) return false
    const flipped = toggleConstructionFlags(sketch.entities, selectedIds)
    if (!flipped) return false
    const sel = new Set(selectedIds)
    const n = sketch.entities.filter((e) => sel.has(e.id)).length
    openStepNow()
    commitSketch({ ...sketch, entities: flipped })
    // NEVER silent: a flip on a possibly off-screen selection flashes what happened.
    deps()?.notice(`Toggled construction on ${n} ${n === 1 ? 'entity' : 'entities'}`, 'info')
    return true
  },

  // 13. Delete / Backspace and the MODIFY panel's Delete button share this, so it owns its own step.
  deleteSelection: (): void => {
    const { sketch, selectedIds } = sketchSessionStore.getState()
    if (sketch === null || selectedIds.length === 0) return
    // WO SKC-49: the guard now excludes the origin AND both injected axis lines -- otherwise
    // Ctrl+A/Delete removes them, cascades away every axis-referencing dimension, and the anchor
    // silently resurrects (undefined-of-them) at the next re-inject with the dims gone.
    const anchorSelected = selectedIds.some(isInjectedSketchAnchorId)
    const deletableIds = selectedIds.filter((id) => !isInjectedSketchAnchorId(id))
    if (deletableIds.length === 0) {
      deps()?.notice('Origin/axis anchors cannot be deleted.', 'warning')
      return
    }
    if (anchorSelected) {
      deps()?.notice('Origin/axis anchors were excluded from Delete.', 'info')
    }
    // THE one delete-cascade (src/lib/sketch/deleteSelection.ts) -- removes the entities and every
    // constraint/dimension that references them. Forking it here is exactly the divergence this
    // program keeps deleting.
    const r = deleteFromSketch(sketch, deletableIds)
    if (!r) {
      // Ids matched nothing in the document (a stale selection). Drop them from the selection and
      // open NO undo step -- a no-edit must not cost the user a Ctrl+Z.
      const stale = new Set(selectedIds)
      sketchSessionStore.setState({ selectedIds: selectedIds.filter((x) => !stale.has(x)) })
      return
    }
    openStepNow()
    const surviving = new Set<string>(r.entities.map((e) => e.id))
    commitSketch(solved({ ...sketch, ...r }))
    sketchSessionStore.setState({ selectedIds: selectedIds.filter((id) => surviving.has(id)) })
  },

  // ==== (b) Select-tool drag (the host solves via temporary constraints) =========================

  // 14. Returns false when the host refuses the drag; the component then ignores the gesture and
  //     `beforeMutate` never fires. Every refusal below is BY NAME.
  dragBegin: (entityId: string, grab: Vec2, tolWorld: number, beforeMutate: () => void): boolean => {
    const { sketch } = sketchSessionStore.getState()
    if (sketch === null) return false
    const e = sketch.entities.find((x) => x.id === entityId)
    if (e === undefined) return false

    // Grounded geometry is immovable by definition.
    const grounded = sketch.constraints.some(
      (c) => c.kind === 'fix' && (c.entityId === entityId || c.point?.entityId === entityId),
    )
    if (grounded) return false

    const status = sketch.solveStatus
    // status null = never solved (UNKNOWN). The gate must not refuse off a status that does not
    // exist -- the drag solve enforces the constraint network either way.
    if (status !== null && status.conflicting.length > 0) return false
    if (status !== null && status.solveFailed) return false
    if (status !== null && status.dof === 0) return false // fully defined: nothing to drag

    const targets = dragTargetsFor(e, grab, tolWorld)
    if (targets === null) return false // unsupported kind, refused by name (see dragTargetsFor)

    // ONE undo step for the whole gesture. Opened HERE, after every refusal gate has passed and
    // immediately before the first document write -- exactly the contract ports.ts describes.
    beforeMutate()
    dragPlan = { targets, grab }
    return true
  },

  // 15
  dragMove: (world: Vec2): void => {
    const plan = dragPlan
    const s = sketchSessionStore.getState().sketch
    if (plan === null || s === null) return
    const dx = world.x - plan.grab.x
    const dy = world.y - plan.grab.y
    const drag: DragRequest = {
      targets: plan.targets.map((t) => ({ point: t.point, to: { x: t.orig.x + dx, y: t.orig.y + dy } })),
    }
    // Synchronous. CAM debounces because its solve crosses a worker boundary; this one does not.
    commitSketch(solved(s, drag))
  },

  // 16. Settle on the document's own constraint network (drop = adopt), exactly like CAM's
  //     `endSketchDrag`: the temporary drag pins are soft (planegcs tag -1) and must not survive.
  dragEnd: (constraint): void => {
    const s = sketchSessionStore.getState().sketch
    if (dragPlan === null) return
    dragPlan = null
    if (s !== null) commitSketch(solved(constraint ? appendDragSnapConstraint(s, constraint) : s))
    openStep = null // the gesture is over; the next one snapshots afresh
  },

  // ==== (b) Dimension labels ====================================================================

  // 17. Pure display data for a plain move -- never a solve. The canvas leader-line drag and the DOM
  //     value-label drag share this; both are one gesture, so both extend the single open step.
  //     SKC-56: an angle dim's label crossing into a DIFFERENT sector is the one exception -- it
  //     re-derives the driven value too (same helper the CAM store's updateDimensionLabel uses, so
  //     the two hosts can never diverge) and runs a REAL solve so the geometry catches up (design
  //     point 3: "then solves"); a same-sector move or any non-angle dim stays labelAnchor-only.
  moveDimLabel: (dimId: string, anchor: Vec2): void => {
    const s = sketchSessionStore.getState().sketch
    if (s === null) return
    const dim = s.dimensions.find((d) => d.id === dimId)
    const valueOverride = dim ? angleLabelDragValueOverride(s.entities, dim, anchor) : null
    const next: Sketch = {
      ...s,
      dimensions: s.dimensions.map((d) =>
        d.id === dimId
          // SKC-58B: a sector crossing rewrites value AND the reversed-operand
          // orientation together (the far value is only no-motion with reverseB).
          ? { ...d, labelAnchor: anchor,
              ...(valueOverride !== null
                ? { value: valueOverride.value, reverseB: valueOverride.reverseB }
                : null) }
          : d
      ),
    }
    commitSketch(valueOverride !== null && dim?.driving ? solved(next) : next)
  },

  // 18
  openDimEditor: (dimId: string): void => {
    sketchSessionStore.setState({ dimEditor: { dimId, isNew: false } })
  },

  // ==== (a)/(b) Live text edit: a document cursor, not tool state ================================
  //
  // ALL EIGHT ARE NAMED INERT. The workbench toolbar arms no sketch-text tool, and the package calls
  // every member below ONLY from that tool's own paths (`placeText`/`bindTextPath` from the text
  // tool's click handler; `editText` from a double-click that first checks `pointHitsTextEntity`;
  // the commit/cancel pair from a live edit that `getTextEditId()` must have opened). With the
  // getters answering null, none of the commands is reachable -- so these are contracts, not crash
  // paths, and `sketchSessionStore.textEditId` stays null by construction.
  //
  // They fill together, when the workbench grows a text tool: the getters read `textEditId` /
  // `pickPathForTextId` off the session store, and the commands mutate `payload.sketch` through
  // `commitSketch` exactly like every other commit above. Nothing else changes.

  // 19
  getTextEditId: (): string | null => sketchSessionStore.getState().textEditId,
  // 20
  getPickPathForTextId: (): string | null => null,
  // 21
  editText: (): void => {},
  // 22
  commitTextEdit: (): void => {},
  // 23
  cancelTextEdit: (): void => {},
  // 24
  cancelPickTextPath: (): void => {},
  // 25
  placeText: (): void => {},
  // 26
  bindTextPath: (): void => {},

  // ==== (a)/(b) Block edit-in-place (SKC-BLOCKS Stage 4): a document cursor, mirrors live text edit
  // above -- and, like it, funnels through the SAME `commitSketch`/`openStepNow` write path every
  // other command in this file uses. Session bookkeeping (the reactive blockEditId + ghost-outerIds
  // pair, and the private meta/return-snapshot pair finish/cancel need) lives on
  // `sketchSessionStore` -- see its beginBlockEditSession/endBlockEditSession/getBlockEditMeta/
  // getBlockEditReturnSketch. Mirrors CAM's beginSketchBlockEdit/finishSketchBlockEdit/
  // cancelSketchBlockEdit (src/store/index.ts) member-for-member, adapted to this host's
  // synchronous single write path instead of a solver-worker round trip.

  // 27
  getBlockEditId: (): string | null => sketchSessionStore.getState().blockEditId,

  // 28. Double-click (or context-menu "Edit block"): detach the block into its world members as a
  //     live session, selecting the detached members. No-op for a non-block id (refused by name via
  //     a notice) or while a session is already open (mirrors CAM's own re-entry no-op: a second
  //     begin would clobber the captured return snapshot).
  beginBlockEdit: (entityId: string): void => {
    const s = sketchSessionStore.getState()
    if (s.sketch === null || s.blockEditId !== null) return
    const res = beginBlockEditPure(s.sketch, entityId)
    if (!res.ok) {
      deps()?.notice(res.message, 'warning')
      return
    }
    const returnSketch = s.sketch
    openStepNow()
    commitSketch(solved(res.sketch))
    sketchSessionStore.beginBlockEditSession(entityId, res.meta, returnSketch)
    sketchSessionStore.setState({ selectedIds: res.memberIds })
    deps()?.notice(
      `Editing block${res.meta.name ? ` "${res.meta.name}"` : ''} - edit its members, then Finish`,
      'info',
    )
  },

  // 29. Finalize: re-group the CURRENT members (everything not in the captured outerIds -- so
  //     entities newly drawn in the session are absorbed too) back into ONE block with the SAME id
  //     and frame (no jump, no identity loss). Refuses by name (cross-boundary / nested), leaving
  //     the session OPEN so the user can fix the flagged constraint/dimension and try Finish again
  //     (ADR-0003 -- never silently discard the edit or force-close the session).
  finishBlockEdit: (): void => {
    const s = sketchSessionStore.getState()
    const meta = sketchSessionStore.getBlockEditMeta()
    if (s.blockEditId === null || meta === null || s.sketch === null) return
    const res = finishBlockEditPure(s.sketch, meta)
    if (!res.ok) {
      deps()?.notice(res.message, 'warning')
      return
    }
    openStepNow()
    commitSketch(solved(res.sketch))
    sketchSessionStore.endBlockEditSession()
    sketchSessionStore.setState({ selectedIds: res.deleted ? [] : [meta.blockId] })
  },

  // 30. Revert-and-finish (Esc / the banner's Cancel): restore the pre-edit block VERBATIM as ONE
  //     forward undo step -- never a history pop (the begin already opened its own step, and Undo
  //     must still be able to step back through it, exactly like cancelSketchTextEdit's in-place
  //     revert / CAM's cancelSketchBlockEdit).
  cancelBlockEdit: (): void => {
    const s = sketchSessionStore.getState()
    const meta = sketchSessionStore.getBlockEditMeta()
    if (s.blockEditId === null || s.sketch === null) return
    const ret = sketchSessionStore.getBlockEditReturnSketch()
    openStepNow()
    commitSketch(solved(ret ?? s.sketch))
    sketchSessionStore.endBlockEditSession()
    sketchSessionStore.setState({ selectedIds: meta ? [meta.blockId] : [] })
  },
}

/** Re-read the session's sketch from the dag. Called by the page after undo/redo/regen, whose
 *  writes go through `CommandHistory` and therefore bypass `commitSketch`'s store mirror. Without
 *  this, Ctrl+Z would restore the payload and leave the viewport painting the pre-undo geometry. */
export function syncSketchSessionFromDag(): void {
  const d = deps()
  const { active, sketchNodeId, frame } = sketchSessionStore.getState()
  if (!active || d === null || sketchNodeId === null) return
  if (frame === null) {
    d.notice('Sketch resync refused: the active workbench sketch has no plane frame.', 'error')
    return
  }
  const payload = d.dag.getNode(sketchNodeId)?.payload
  const sketch = payload?.sketch as Sketch | undefined
  if (sketch !== undefined) {
    sketchSessionStore.setState({ sketch: injectWorkbenchOrigin(sketch, frame) })
  }
}

// WO UI-50C-R3 MAJOR 2: SKETCH_DOCUMENT_PORT_MEMBER_COUNT (a hand-pinned `27`) was removed here --
// the binding contract forbids a pinned count or hand-listed member names as the completeness
// mechanism (a concurrent port-growing WO like SKC-46 guarantees a false conflict on the literal --
// this is that exact collision, hit and resolved per the contract at UI-50C-R6 assembly: SKC-46's
// substantive staged-size-memory feature (7a/7b above) merges in untouched, only the pinned-count
// bookkeeping is dropped). `workbenchSketchMount.test.ts` now derives
// `Object.keys(workbenchSketchDocumentPort)` at test runtime instead. Completeness for the
// DIMENSION-writing subset of members is independently proven by `dimensionWritePathCensus.test.ts`,
// which AST-sweeps this file for every `dimensions:` site and keys each hit to its real enclosing
// function name (== the live port member name, for a port-object property) -- a renamed or
// newly-added dimension-writing member fails THAT census by name, with no dependency on a count.
