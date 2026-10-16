// WO SKC-15B (S3), item 1: the workbench's `SketcherOverlaysPort` (SKC-BLOCKS Stage 4 added the
// optional block-edit-in-place quintet: useBlockEditId + getBlockEditId/beginBlockEdit/
// finishBlockEdit/cancelBlockEdit).
//
// The twin of `src/components/viewport/camOverlaysPort.ts`. Where that one is seven `useCamStore`
// selectors, this one is seven `useSyncExternalStore` selectors over `sketchSessionStore` -- the
// same shape the keystone `src/tests/sketch/sketcherOverlays.test.tsx` proves a store-free host can
// use. Implementing these 23 members is the whole of what the workbench pays for all eight sketch
// overlays: dimension labels + value editor, live draw dims, the type-a-value box, the WYSIWYG text
// input, the on-path anchor pill, the prompt bar, the confirm overlay and the context menu.
//
// A MODULE CONST, deliberately (SKC-14C do-not-redo, and camOverlaysPort's own header): the members
// are React hooks, called in render, so the object must be referentially stable for the life of the
// mount. Building it in a `useMemo` that closes over a ref makes the React Compiler skip compiling
// the whole page.
//
// WHERE THIS DIVERGES FROM CAM, and why it is not a fork:
//
//   * CAM's `commitDimensionValue` / `applyConstraint` post a VERDICT SOLVE to a solver worker and
//     correlate the response by requestId, auto-rejecting a conflicting application. The workbench
//     solver is SYNCHRONOUS (`solveSketchOnWrapper`), so the same verdict is reached inline:
//     apply -> solve -> if the outcome names a conflict, REVERT the exact ids just added and say so.
//     Same semantics, no request correlation needed, and the revert is not a guess -- it removes
//     precisely the constraint/dimension this call created.
//   * The seven text members are NAMED INERT (the workbench arms no text tool), matching the eight
//     inert members of `workbenchSketchDocumentPort`. `useTextDraft()` returns '' and
//     `getTextEditId()` returns null, so `SketchTextInput` never mounts and none of the commands is
//     reachable. They are contracts, not crash paths.
import { useText, textFor } from '../../../i18n'
const workbenchText = textFor('sketch-and-model-workbench')
import { useSyncExternalStore } from 'react'
import * as THREE from 'three'

import type {
  SketcherOverlaysPort, SketcherOverlaySurface, SketchDimEditorState,
} from '../../../lib/sketch/sketcher'
import type { Sketch } from '../../../lib/sketch/sketcher'
import type { SketchConstraintKind } from '../../../lib/sketch/types'
import type { Units } from '../../../lib/ui/unitFormat'
import { constraintKindLabel, planConstraintForSelection } from '../../../lib/sketch/constraintActions'
import { solveSketchOnWrapper } from '../../../lib/sketch/solver/gcsMapping'
import { groupIntoBlock, explodeBlock, setBlockScale, setBlockRotationDeg, insertInstanceOfBlock } from '../../../lib/sketch/blocks'
import { isInjectedSketchAnchorId } from '../../../lib/sketch/sketchAnchors'
import { measureChamferSetbacks } from '../../../lib/sketch/tools/theoreticalCorner'
import { signedAngleEditValue } from '../../../lib/sketch/tools/dimTool'
import type { PlaneFrame } from '../../../sketch3d/planeMath'
import { localToWorld } from '../../../sketch3d/planeMath'
import type { SceneRuntime } from '../sceneRuntime'
import { sketchSessionStore, type SketchSessionState } from './sketchSessionStore'
import { resolveSolverAvailability, unverifiableApplyNotice } from './solverAvailability'
import { workbenchSketchDocumentPort } from './workbenchSketchDocumentPort'

/** The package's hooks, supplied by the host. Named `useSessionValue`, not `sel`: it IS a custom
 *  hook, and `rules-of-hooks` says so. */
function useSessionValue<T>(f: (s: SketchSessionState) => T): T {
  useText('sketch-and-model-workbench')
  return useSyncExternalStore(
    sketchSessionStore.subscribe,
    () => f(sketchSessionStore.getState()),
    () => f(sketchSessionStore.getState()),
  )
}

// ---- The projection surface --------------------------------------------------------------------

export interface WorkbenchOverlaySurfaceOptions {
  canvas: HTMLCanvasElement
  /** The overlay host: `worldToScreen` must return coordinates local to IT, not to the canvas. */
  container: HTMLElement
  runtime: SceneRuntime
  getFrame: () => PlaneFrame
  /** The package's live plane-locked cursor, in sketch-LOCAL mm (`Sketcher.getLastCursor()`). */
  getLastCursor: () => { x: number; y: number } | null
}

/**
 * Sketch-LOCAL mm -> overlay-host-local screen px.
 *
 * The overlays hand this LOCAL coordinates, because that is what the sketch layer draws in. CAM's
 * `CNCViewport` satisfies the same signature trivially (its sketch-local coords ARE world XY under
 * an ortho top view). Here the point must first be lifted through the plane frame into world space.
 * `z` is a small out-of-plane nudge the overlays use to lift labels off the geometry; it rides the
 * plane NORMAL, which is what "0.4 above the sketch" means on a tilted plane.
 */
export function createWorkbenchOverlaySurface(opts: WorkbenchOverlaySurfaceOptions): SketcherOverlaySurface {
  const { canvas, container, runtime, getFrame, getLastCursor } = opts
  return {
    worldToScreen: (x: number, y: number, z = 0) => {
      const frame = getFrame()
      const w = localToWorld(frame, { x, y })
      const p = new THREE.Vector3(w.x, w.y, w.z)
      if (z !== 0) {
        p.addScaledVector(new THREE.Vector3(frame.normal.x, frame.normal.y, frame.normal.z).normalize(), z)
      }
      const canvasPt = runtime.projectToCanvas({ x: p.x, y: p.y, z: p.z })
      // Behind the camera: the overlays' own rAF loops already handle an off-screen label; giving
      // them a NaN or a wrapped coordinate would paint a label at a wild position instead.
      if (canvasPt === null) return { x: -10_000, y: -10_000 }
      // canvas-relative -> overlayHost-relative. Identical when the canvas fills its parent, which
      // it does today; computed anyway so a future toolbar gutter cannot silently offset every label.
      const cRect = canvas.getBoundingClientRect()
      const hRect = container.getBoundingClientRect()
      return { x: canvasPt.x + (cRect.left - hRect.left), y: canvasPt.y + (cRect.top - hRect.top) }
    },
    getLastSketchCursor: () => getLastCursor(),
  }
}

// ---- Synchronous verdict solve -----------------------------------------------------------------

/**
 * Apply `next`, solve, and REVERT if the solve names any of `addedIds` in its conflicting set.
 *
 * This is CAM's `pendingConstraintApply` / `pendingDimensionApply` correlation, collapsed into a
 * straight line because the solve is in-process. Returns true when the application stood.
 *
 * Refuses BY NAME when the solver has not booted (`wrapper === null`): the application is rejected
 * rather than committed unverified, because an unverified constraint can silently over-constrain the
 * document and the user would have no way to see it.
 */
function applyWithVerdict(next: Sketch, addedIds: string[], label: string): boolean {
  const d = sketchSessionStore.getDeps()
  if (d === null) return false
  if (d.wrapper === null) {
    // WO-120: the refusal is unchanged -- an unverified constraint can silently
    // over-constrain the document. What changes is the REASON given. "Try again
    // in a moment" is true while the solver is booting and a lie once its
    // bounded recovery is spent, and it was the message for BOTH because a null
    // wrapper could not tell them apart (see solverAvailability.ts).
    d.notice(unverifiableApplyNotice(resolveSolverAvailability(d), label), 'warning')
    return false
  }

  let outcome
  try {
    outcome = solveSketchOnWrapper(d.wrapper, next)
  } catch (err) {
    d.notice(workbenchText('workbenchOverlaysPort.theConstraintSolverFailed', { label: String(label), value2: String(err instanceof Error ? err.message : String(err)) }), 'error')
    return false
  }

  const conflicting = new Set(outcome.status?.conflicting ?? [])
  const rejected = addedIds.filter((id) => conflicting.has(id))
  if (rejected.length > 0 || !outcome.ok) {
    const why = outcome.ok ? workbenchText('workbenchOverlaysPort.itConflictsWithTheExistingConstraints') : outcome.message
    d.notice(workbenchText('workbenchOverlaysPort.wasNotApplied', { label: String(label), why: String(why) }), 'warning')
    return false
  }

  // Stood. Route the write through the document port's own single write path so the undo step, the
  // store mirror, the dag payload and the regen kick all happen exactly once, in one place.
  workbenchSketchDocumentPort.beginStep()
  workbenchSketchDocumentPort.replace({
    entities: outcome.entities,
    constraints: next.constraints,
    dimensions: next.dimensions,
  })
  return true
}

// ---- THE PORT ----------------------------------------------------------------------------------

export const workbenchOverlaysPort: SketcherOverlaysPort = {
  // ==== Reactive reads (called in render; the host's own reactivity) ============================

  // 1
  useIsSketchActive: (): boolean => useSessionValue((s) => s.active),
  // 2
  useSketch: (): Sketch | null => useSessionValue((s) => s.sketch),
  // 3. ADR-0022: the document is always mm. The workbench has no display-units preference (see the
  //    twin NAMED-inert member on workbenchSketchDocumentPort.getDisplayUnits).
  useDisplayUnits: (): Units => 'mm',
  // 4
  useSelectedIds: (): string[] => useSessionValue((s) => s.selectedIds),
  // 5
  useDimEditor: (): SketchDimEditorState | null => useSessionValue((s) => s.dimEditor),
  // 6. NAMED INERT: the workbench arms no text tool, so nothing ever opens a text edit.
  useTextEditId: (): string | null => useSessionValue((s) => s.textEditId),
  // 6a. SKC-BLOCKS Stage 4: reactive read of the session store's block-edit cursor -- gates the
  //     "Editing block..." banner (WorkbenchToolRail) and the shared context menu's Finish/Cancel
  //     items, exactly like CAM's own `useBlockEditId` (camOverlaysPort.ts).
  useBlockEditId: (): string | null => useSessionValue((s) => s.blockEditId),
  // 7. NAMED INERT: '' whenever `useTextEditId()` is null, which here is always. The WYSIWYG input
  //    is controlled by this and never mounts.
  useTextDraft: (): string => useSessionValue((s) => {
    const id = s.textEditId
    if (id === null) return ''
    const e = s.sketch?.entities.find((x) => x.id === id)
    return e !== undefined && e.kind === 'text' ? e.text : ''
  }),

  // ==== Imperative reads (called from rAF; the same values, sampled) =============================

  // 8
  getSketch: (): Sketch | null => sketchSessionStore.getState().sketch,
  // 9
  getDisplayUnits: (): Units => 'mm',
  // 10
  getTextEditId: (): string | null => sketchSessionStore.getState().textEditId,
  // 11. Null until the mount has a live surface (first render, or after unmount) -- the overlays'
  //     rAF loops already bail on a null surface.
  getSurface: (): SketcherOverlaySurface | null => sketchSessionStore.getSurface(),

  // ==== Dimension commands ======================================================================

  // 12. Driving <-> reference. Never a conflict (a reference dimension constrains nothing), so no
  //     verdict solve is needed -- but a re-solve IS, because dropping a driving dimension frees a
  //     degree of freedom and the definition coloring must follow.
  toggleDimensionDriving: (dimId: string): void => {
    const s = sketchSessionStore.getState().sketch
    if (s === null) return
    const dim = s.dimensions.find((d) => d.id === dimId)
    if (dim === undefined) return
    // d1xd2's driving -> reference direction is TWO-valued -- remeasure BOTH
    // d1/d2 via measureChamferSetbacks (with constraints) rather than leaving
    // the toggle to flip the flag alone, which would leave a stale value/d2
    // on the label until the next solve.
    const flipped = dim.kind === 'd1xd2' && dim.driving
      ? (() => {
          const m = measureChamferSetbacks(s.entities, s.constraints, dim.entityId)
          return m ? { ...dim, driving: false, value: m.d1, d2: m.d2 } : { ...dim, driving: false }
        })()
      : { ...dim, driving: !dim.driving }
    workbenchSketchDocumentPort.beginStep()
    workbenchSketchDocumentPort.replace({
      entities: s.entities,
      constraints: s.constraints,
      dimensions: s.dimensions.map((d) => (d.id === dimId ? flipped : d)),
    })
  },

  // 13. `value` arrives in MILLIMETERS (angles: RADIANS) -- the overlay converts from display units
  //     at its own edge. A conflicting value is refused and the prior value stands. `expression`:
  //     "sketch-dim equations wiring" hitlist item -- the raw "=..." source `value` was resolved
  //     from (src/lib/sketch/dimExpr.ts), stored alongside `value` for redisplay; undefined clears
  //     any prior expression (a plain-number commit).
  commitDimensionValue: (
    dimId: string, value: number, expression?: string, half?: 'd1' | 'd2',
  ): void => {
    const s = sketchSessionStore.getState().sketch
    const d = sketchSessionStore.getDeps()
    if (s === null || d === null) return
    if (!Number.isFinite(value)) {
      // Charter item 3: validate DATA at the accept point. A NaN here would ride into the solver and
      // out into every coordinate of the sketch, and `NaN > tol` is false in both directions.
      d.notice(workbenchText('workbenchOverlaysPort.thatDimensionValueIsNotANumber'), 'warning')
      return
    }
    const dim = s.dimensions.find((x) => x.id === dimId)
    if (dim === undefined) return
    const label = workbenchText('workbenchOverlaysPort.dimension', { value1: String(constraintKindLabel(dim.kind)) })
    if (dim.kind === 'arcLength' && !(value > 0)) {
      d.notice(workbenchText('workbenchOverlaysPort.arcLengthMustBeGreaterThanZero', { label: String(label) }), 'warning')
      return
    }
    // WO-1858: a chamfer setback is a POSITIVE distance from the theoretical
    // corner -- zero or negative names no chamfer at all. Same refusal shape
    // (and the same host parity) as the arc-length guard above.
    if (dim.kind === 'd1xd2' && !(value > 0)) {
      d.notice(workbenchText('workbenchOverlaysPort.setbackMustBeGreaterThanZero', { label: String(label), value2: String(half === 'd2' ? 'D2' : 'D1') }), 'warning')
      return
    }
    if (!dim.driving) {
      d.notice(
        workbenchText('workbenchOverlaysPort.isAReferenceItTracksTheMeasuredValue', { label: String(label) }) +
        workbenchText('workbenchOverlaysPort.toggleItToDrivingToSetAValue'),
        'warning',
      )
      sketchSessionStore.setState({ dimEditor: null })
      return
    }
    // SKC-59-R1 blocker C1: normalize the typed magnitude into the dim's signed
    // sector convention (shared with CAM's store.commitDimensionValue via
    // signedAngleEditValue -- the single point of truth so the two hosts cannot
    // diverge). Without it a far/obtuse (reverseB=true) dim edited by value
    // flips the line to the mirror branch.
    const signedValue = signedAngleEditValue(dim, value)
    // WO-1858: the chamfer setback pair carries TWO independently driven
    // numbers, so an edit names WHICH half it sets (omitted = the base value,
    // d1 -- every single-valued kind's unchanged path).
    const editsD2 = dim.kind === 'd1xd2' && half === 'd2'
    const next: Sketch = {
      ...s,
      dimensions: s.dimensions.map((x) => (
        x.id !== dimId ? x
          : x.kind === 'd1xd2' && editsD2
            ? { ...x, d2: value, expression }
            : { ...x, value: signedValue, expression })),
    }
    if (applyWithVerdict(next, [dimId], label)) {
      sketchSessionStore.setState({ dimEditor: null })
    }
  },

  // 14
  closeDimensionEditor: (): void => {
    sketchSessionStore.setState({ dimEditor: null })
  },

  // ==== Text commands: ALL SEVEN NAMED INERT ====================================================
  //
  // Reachable only from `SketchTextInput` / the on-path anchor pill, which mount only when
  // `useTextEditId()` is non-null. It never is (member 6). They fill together with the document
  // port's eight text members, when the workbench grows a sketch-text tool.

  // 15
  setTextValue: (): void => {},
  // 16
  setTextCaretIndex: (): void => {},
  // 17
  commitTextEdit: (): void => {},
  // 18
  cancelTextEdit: (): void => {},
  // 19
  setTextPathAlignById: (): void => {},
  // 20
  setTextPathFlipById: (): void => {},
  // 21
  setTextMirrorById: (): void => {},

  // ==== Selection commands (the context menu shares these with the panels) =======================

  // 22. THE one constraint planner (`planConstraintForSelection`), then the synchronous verdict.
  //     Never silent: an invalid selection and a conflicting application each say why.
  applyConstraint: (kind: SketchConstraintKind): void => {
    const { sketch, selectedIds } = sketchSessionStore.getState()
    const d = sketchSessionStore.getDeps()
    if (sketch === null || d === null) return
    const label = constraintKindLabel(kind)
    const plan = planConstraintForSelection(sketch, selectedIds, kind)
    if (!plan.ok) {
      d.notice(`${label}: ${plan.reason}`, 'warning')
      return
    }
    applyWithVerdict(
      { ...sketch, constraints: [...sketch.constraints, ...plan.constraints] },
      plan.constraints.map((c) => c.id),
      label,
    )
  },

  // 23. Shared verbatim with the document port -- one delete-cascade, one undo step, one owner.
  deleteSelection: (): void => {
    workbenchSketchDocumentPort.deleteSelection()
  },

  // ==== Block commands (SKC-BLOCKS) -- parity with camOverlaysPort ================================
  //
  // group/explode are PURE document transforms (src/lib/sketch/blocks.ts). Grouping/exploding never
  // over-constrains (a block's members leave the constraint network; internal constraints were
  // already valid), so no verdict solve is needed -- but the change to the constraint graph does
  // need a re-solve, which the document port's `replace` write path performs. Refusals surface by
  // name through the same notice sink every other command uses.
  groupSelectionIntoBlock: (): void => {
    const { sketch, selectedIds } = sketchSessionStore.getState()
    const d = sketchSessionStore.getDeps()
    if (sketch === null || d === null) return
    const ids = selectedIds.filter((id) => !isInjectedSketchAnchorId(id))
    const r = groupIntoBlock(sketch, ids)
    if (!r.ok) { d.notice(r.message, r.reason === 'empty' ? 'info' : 'warning'); return }
    workbenchSketchDocumentPort.beginStep()
    workbenchSketchDocumentPort.replace({
      entities: r.sketch.entities, constraints: r.sketch.constraints, dimensions: r.sketch.dimensions,
    })
    workbenchSketchDocumentPort.setSelection([r.blockId])
    d.notice(workbenchText('workbenchOverlaysPort.groupedIntoABlock'), 'success')
  },
  explodeSelectedBlock: (): void => {
    const { sketch, selectedIds } = sketchSessionStore.getState()
    const d = sketchSessionStore.getDeps()
    if (sketch === null || d === null) return
    const blockId = selectedIds.find((id) => {
      const e = sketch.entities.find((x) => x.id === id)
      return e !== undefined && e.kind === 'block'
    })
    if (blockId === undefined) { d.notice(workbenchText('workbenchOverlaysPort.selectABlockToExplode'), 'info'); return }
    const r = explodeBlock(sketch, blockId)
    if (!r.ok) { d.notice(r.message, 'warning'); return }
    workbenchSketchDocumentPort.beginStep()
    workbenchSketchDocumentPort.replace({
      entities: r.sketch.entities, constraints: r.sketch.constraints, dimensions: r.sketch.dimensions,
      // Carry the def registry: exploding an instance may prune an orphaned def.
      blockDefs: r.sketch.blockDefs,
    })
    workbenchSketchDocumentPort.setSelection(r.memberIds)
    d.notice(workbenchText('workbenchOverlaysPort.explodedBlock'), 'success')
  },
  // SKC-BLOCKS Stage 5: place ANOTHER instance of the selected block. Hoists the
  // block into a shared DEFINITION on first reuse (so editing the block updates
  // every instance); carries the new blockDefs through the same single write path.
  insertInstance: (): void => {
    const { sketch, selectedIds } = sketchSessionStore.getState()
    const d = sketchSessionStore.getDeps()
    if (sketch === null || d === null) return
    const blockIds = selectedIds.filter((id) => {
      const e = sketch.entities.find((x) => x.id === id)
      return e !== undefined && e.kind === 'block'
    })
    if (blockIds.length !== 1) {
      d.notice(workbenchText('workbenchOverlaysPort.selectASingleBlockToPlaceAnotherInstanceOf'), 'info')
      return
    }
    const r = insertInstanceOfBlock(sketch, blockIds[0])
    if (!r.ok) { d.notice(r.message, 'warning'); return }
    workbenchSketchDocumentPort.beginStep()
    workbenchSketchDocumentPort.replace({
      entities: r.sketch.entities, constraints: r.sketch.constraints, dimensions: r.sketch.dimensions,
      blockDefs: r.sketch.blockDefs,
    })
    workbenchSketchDocumentPort.setSelection([r.blockId])
    d.notice(workbenchText('workbenchOverlaysPort.placedAnotherInstanceEditTheBlockToUpdateEvery'), 'success')
  },
  // SKC-BLOCKS Stage 2: direct-edit inert scale/rotation. Neither changes the
  // constraint graph (only the origin is solved), so -- like group/explode --
  // no verdict solve is needed; `replace` re-solves as part of its own single
  // write path. A no-op edit (setBlockScale/setBlockRotationDeg returning the
  // SAME sketch reference) skips the write entirely.
  setBlockScale: (blockId: string, scale: number): void => {
    const { sketch } = sketchSessionStore.getState()
    const d = sketchSessionStore.getDeps()
    if (sketch === null || d === null) return
    const r = setBlockScale(sketch, blockId, scale)
    if (!r.ok) { d.notice(r.message, 'warning'); return }
    if (r.sketch === sketch) return
    workbenchSketchDocumentPort.beginStep()
    workbenchSketchDocumentPort.replace({
      entities: r.sketch.entities, constraints: r.sketch.constraints, dimensions: r.sketch.dimensions,
    })
  },
  setBlockRotationDeg: (blockId: string, deg: number): void => {
    const { sketch } = sketchSessionStore.getState()
    const d = sketchSessionStore.getDeps()
    if (sketch === null || d === null) return
    const r = setBlockRotationDeg(sketch, blockId, deg)
    if (!r.ok) { d.notice(r.message, 'warning'); return }
    if (r.sketch === sketch) return
    workbenchSketchDocumentPort.beginStep()
    workbenchSketchDocumentPort.replace({
      entities: r.sketch.entities, constraints: r.sketch.constraints, dimensions: r.sketch.dimensions,
    })
  },

  // ==== Block edit-in-place commands (SKC-BLOCKS Stage 4; OPTIONAL, see useBlockEditId) ==========
  //
  // Thin forwards onto `workbenchSketchDocumentPort`'s own optional block-edit members -- the
  // ACTUAL begin/finish/cancel logic (the pure beginBlockEdit/finishBlockEdit transforms, the write
  // path, the session bookkeeping) lives there, where `commitSketch`/`openStepNow` already are.
  // This mirrors CAM exactly: `camSketchDocumentPort` and `camOverlaysPort` both delegate to the
  // SAME `useCamStore` actions (beginSketchBlockEdit et al.) rather than each owning a copy.
  getBlockEditId: (): string | null => workbenchSketchDocumentPort.getBlockEditId?.() ?? null,
  beginBlockEdit: (blockId: string): void => {
    workbenchSketchDocumentPort.beginBlockEdit?.(blockId)
  },
  finishBlockEdit: (): void => {
    workbenchSketchDocumentPort.finishBlockEdit?.()
  },
  cancelBlockEdit: (): void => {
    workbenchSketchDocumentPort.cancelBlockEdit?.()
  },
}

// WO UI-50C-R3 MAJOR 2: SKETCHER_OVERLAYS_PORT_MEMBER_COUNT (a hand-pinned `23`) was removed here --
// see the matching note on workbenchSketchDocumentPort.ts's SKETCH_DOCUMENT_PORT_MEMBER_COUNT
// removal for the full reasoning. `workbenchSketchMount.test.ts` derives `Object.keys(workbenchOverlaysPort)`
// at test runtime; dimension-writing completeness for this file is independently proven by
// `dimensionWritePathCensus.test.ts`.
