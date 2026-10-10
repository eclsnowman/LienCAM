// WO SKC-14: ALL sketch pointer + keyboard interaction. Extracted from CNCViewport.ts:2237-3343
// (the 1,114-line block the plan calls "the risk center" -- these lines ARE Operator's quality bar,
// so this cut is a MECHANICAL move: no behaviour edits, plan R5's mitigation).
//
// What changed, and nothing else:
//   * `this.camera` / `this.controls` / `this.renderer.domElement` / `this.container` -> the
//     SketcherHost handles.
//   * `this.getWorldPerPixel()` -> host.worldPerPixel(); the ortho unproject moved behind
//     host.clientToPlaneWorld() (plan Section 3.2's surface primitives).
//   * The FOUR direct `useCamStore.getState()` reads (CNCViewport.ts:2915, 2993, 3131, 3278)
//     became port calls -- getSketch() / getTextEditId() / getPickPathForTextId(). This module
//     imports no store. That is what makes the workbench mount (S3) possible at all.
//   * `beginDimDrag()` -> the undo ADAPTER (`undo.beginGesture()`), plan R3: the interaction core
//     emits mutations and owns no history.
//
// WO SKC-14-R1 (audit FAIL) moved the two gestures the first cut left behind, and with them the
// last of the felt logic:
//   * The DOM dimension-label drag (press / 3px threshold / move / release, its undo step and its
//     trailing click-select and double-click-to-edit) came out of SketchDimensionOverlay.
//   * The right-button context-menu gesture (press position, pan-vs-menu discrimination,
//     preventDefault) came out of Viewport. The component DECIDES; the host PRESENTS (SketchMenuPort).
//   Both attach to `host.overlayHost`, the DOM surface covering the canvas and the host's overlays.
//   * `getPreview` / `getDimAnchor` left the port: the component now runs the pure resolvers
//     (`toolPreview`, `resolveProjectHit`, `dimensionDisplay`) over host-supplied DATA.
//   * Undo granularity is latched HERE (`newGestureStep`), never in a store action.
//
// This is the ONE module in the tree allowed to handle a sketch pointerdown or paint hover/
// preview geometry; src/tests/sketch/oneSketchPointerOwner.test.ts fails if a second appears.
import type * as THREE from 'three'
import { dimensionDisplay, type SketchLayer, type SketchPickHit } from './sketchLayer'
import type { SketchOverlayPainter } from './overlayPainter'
import type { OrbitArbiter } from './orbitArbiter'
import type {
  SketcherHost, SketchDocumentPort, SketchMenuPort, SketchUndoSink,
} from './ports'
import type { Vec2 as SketchVec2 } from '../types'
import { isTypingTarget, shortcutActionForKeyEvent } from '../tools/shortcuts'
import { pickTextAttachTarget, pointHitsTextEntity } from '../textOnPath'
import { toolPreview, type SketchToolId } from '../tools/toolMachine'
import {
  projectPreviewPaths,
  projectRefusal,
  resolveProjectHit,
  type ExpectedProjectSource,
  type ProjectCandidate,
  type ProjectResolveResult,
} from '../projectUse'
import { chamferChainPreview } from '../tools/chamferTool'
import { filletChainPreview } from '../tools/filletTool'
import {
  stagedSizeFromDrag,
  startStagedSizeDrag,
  type StagedSizeDrag,
} from '../tools/stagedSizeDrag'
import { sketcherTools } from './toolController'
import { toolState } from './toolStore'
import { decodeEndpointSelectionRef, ownerIdForSelection } from '../centerReferences'
import {
  constraintForEndpointDragSnap,
  findEndpointDragSnap,
  type DragSnapTarget,
} from '../dragSnap'
import type { PointRef, SketchConstraint } from '../types'

/** Pixel tolerance for sketch picking — generous for easier selection. */
const SKETCH_PICK_PX = 8
/** WO SKC-57: wider PASS-2 pick radius, opt-in per call site (see `pickAt`).
 *  Operator's ask: an unambiguous click near a lone entity should not need to be
 *  pixel-exact, but a click that could mean two things must still refuse. */
const SKETCH_PICK_GENEROUS_PX = 16
/** Drag distance (px) before a press becomes a marquee instead of a click. */
const SKETCH_DRAG_PX = 5
/** Drag distance (px) before a press on a DOM dimension VALUE LABEL becomes a label drag rather
 *  than a click-select. Deliberately tighter than SKETCH_DRAG_PX: this is the exact 3px threshold
 *  the label drag has always used (SketchDimensionOverlay's `dx*dx + dy*dy < 9`). */
const DIM_LABEL_DRAG_PX = 3
/** Right-button travel (px) above which a contextmenu is the tail of an orbit-controls PAN drag
 *  and not a menu request. The exact threshold Viewport's handler used. */
const RIGHT_DRAG_PAN_PX = 5

type StagedSizeKind = 'fillet' | 'chamfer'

interface ActiveStagedSizeDrag {
  kind: StagedSizeKind
  drag: StagedSizeDrag
}

/** PICK tools operate on EXISTING entities (the user points AT geometry and clicks to add it to
 *  an operand set), so they want the same cyan hover halo a bare cursor gets — without it there
 *  is no affordance that a line is pickable (the angle-dim repro: complaint 1). CREATE tools
 *  (line/rect/circle/arc/...) draw new geometry at the cursor and keep the crosshair /
 *  no-hover behavior. */
const SKETCH_PICK_TOOLS: ReadonlySet<string> = new Set([
  'smart-dimension', 'mirror', 'pattern-linear', 'pattern-circular', 'pattern-path',
  'move', 'rotate', 'scale', 'project',
])

export class SketchInteraction {
  /** The mount's document/commit sink. Tool state is NOT here -- it lives in ./toolStore.ts and is
   *  dispatched through ./toolController.ts, which this module reaches directly. */
  private doc: SketchDocumentPort | null = null
  private undo: SketchUndoSink | null = null
  private menu: SketchMenuPort | null = null

  private pointerDown: { x: number; y: number; hit: SketchPickHit | null } | null = null
  private marqueeDiv: HTMLDivElement | null = null
  private keyHandler: ((e: KeyboardEvent) => void) | null = null
  /** Live DOM dimension VALUE-LABEL drag (press on a `[data-dim-id]` element in the host's overlay
   *  surface). `moved` latches past the 3px threshold: below it the gesture is a click-select, at
   *  or above it the label repositions (pure display data, never a solve). */
  private labelDrag: {
    id: string
    startX: number
    startY: number
    orig: SketchVec2
    moved: boolean
    step: () => void
  } | null = null
  /** Where the right button went down, so `contextmenu` can tell a menu request from the tail of
   *  an orbit-controls PAN drag. Null outside a right-button press. */
  private rightDown: { x: number; y: number } | null = null
  /** True while a select-tool drag gesture is live (store accepted it). */
  private dragActive = false
  private draggedEndpoint: PointRef | null = null
  private dragSnapTarget: DragSnapTarget | null = null
  private dragSnapConstraint: SketchConstraint | null = null
  /** Pointer that owns the live primary canvas gesture. Synthetic jsdom MouseEvents have no
   *  pointerId, so zero is the test-only token; real PointerEvents always keep their browser id. */
  private primaryPointerId: number | null = null
  /** Browser pointer capture actually acquired for the live gesture. Kept separate from the
   *  primary token so legacy unit harnesses without the Pointer Capture API still exercise the
   *  normal in-canvas release path. */
  private capturedPointerId: number | null = null
  /** Live dimension leader-line drag (select tool, press on a dim leader and
   *  drag): repositions the label anchor. Null outside such a drag. */
  private dimDrag: { id: string; origAnchor: SketchVec2; grab: SketchVec2 } | null = null
  /** Swipe path in world mm while the TRIM tool is pressed-and-dragging
   *  (drag-swipe trim); null outside a trim press. */
  private swipePath: SketchVec2[] | null = null
  /** Live fillet/chamfer size drag. Geometry remains a ghost and the
   *  document stays untouched until the existing Apply path commits it. */
  private stagedSizeDrag: ActiveStagedSizeDrag | null = null
  private lastCursor: SketchVec2 | null = null
  /** Last external source actually previewed. Cleared on every miss/lifecycle tail. */
  private projectPreviewCandidate: ProjectCandidate | null = null

  private readonly host: SketcherHost
  private readonly layer: SketchLayer
  private readonly painter: SketchOverlayPainter
  /** WO SKC-15B: the package's single owner of `controls.enableRotate`. Under the default
   *  'session' policy every call below is an early-return no-op, which is why CAM's write sequence
   *  is unchanged (see ./orbitArbiter.ts). */
  private readonly orbit: OrbitArbiter

  constructor(
    host: SketcherHost, layer: SketchLayer, painter: SketchOverlayPainter, orbit: OrbitArbiter,
  ) {
    this.host = host
    this.layer = layer
    this.painter = painter
    this.orbit = orbit
  }

  setDocumentPort(port: SketchDocumentPort | null): void {
    this.projectPreviewCandidate = null
    this.painter.setToolPreview(null)
    this.doc = port
  }

  setUndoSink(sink: SketchUndoSink | null): void {
    this.undo = sink
  }

  setMenuPort(p: SketchMenuPort | null): void {
    this.menu = p
  }

  getLastCursor(): SketchVec2 | null {
    return this.lastCursor
  }

  /**
   * ONE undoable step per gesture (plan R3, WO SKC-14-R1 finding 3). Each gesture mints a fresh
   * latch and hands it to whichever commit operations it drives. The host calls it at the instant
   * it is about to touch the document; the FIRST call opens the step, every later call in the same
   * gesture is swallowed. A gesture that never mutates -- a tool click that only advances the
   * chain, a drag the store refuses -- never calls it, so it costs the user no Ctrl+Z press.
   *
   * This is why no store action pushes history for a component-owned gesture any more: the
   * granularity decision lives here, in the component, and nowhere else.
   */
  private newGestureStep(): () => void {
    let opened = false
    return () => {
      if (opened) return
      opened = true
      this.undo?.beginGesture()
    }
  }

  private tool(): SketchToolId | undefined {
    return toolState().tool
  }

  /** True while a CREATE tool is armed (anything but select). */
  toolArmed(): boolean {
    const t = this.tool()
    return !!t && t !== 'select'
  }

  private toolIsPickTool(): boolean {
    const t = this.tool()
    return !!t && SKETCH_PICK_TOOLS.has(t)
  }

  /**
   * Rubber-band preview polyline for the in-progress chain at the cursor, or null when no chain is
   * in progress. Was `SketchToolHandlers.getPreview` -- i.e. the MOUNT's job -- until SKC-14-R1's
   * finding 2. Both branches are pure resolvers over host-supplied data:
   *   * PROJECT: the "preview" is the hover highlight for the candidate point/path source
   *     that the click would lift. Hit-tested with the same tolerance the click uses, so the halo
   *     never promises a projection the click would refuse.
   *   * everything else: `toolPreview` over the live tool state.
   */
  private previewPoints(cursor: SketchVec2, tolWorld?: number): SketchVec2[] | null {
    const st = toolState()
    return toolPreview({ tool: st.tool, chain: st.chain }, cursor, {
      gearParams: st.gearParams,
      polygonSides: st.polygonSides,
      polygonMode: st.polygonMode,
      splineClosed: st.splineClosed,
      // Close-on-start feedback: the same pick tol the click uses, so the preview snaps CLOSED
      // exactly where a click would close the loop.
      closeTol: tolWorld,
    })
  }

  private static sameProjectSource(
    expected: ExpectedProjectSource,
    candidate: ProjectCandidate,
  ): boolean {
    const actual = candidate.sourceIdentity
    return actual !== undefined
      && expected.stablePickKey === candidate.stablePickKey
      && expected.sourceIdentity.bodyId === actual.bodyId
      && expected.sourceIdentity.cacheVersion === actual.cacheVersion
      && expected.sourceIdentity.stableId === actual.stableId
  }

  /** Resolve one Project pointer event exactly once. The optional mount resolver receives raw
   *  client/local facts; CAM keeps the existing local baked-loop hit path. */
  private resolveProjectAt(
    clientX: number,
    clientY: number,
    local: SketchVec2,
    fallbackHitPoint: SketchVec2,
    tolerance: number,
    enforcePreviewIdentity: boolean,
  ): ProjectResolveResult {
    const doc = this.doc
    if (!doc?.getSketch()) {
      this.projectPreviewCandidate = null
      return projectRefusal('no-document', 'Project: no active sketch document')
    }
    const preview = enforcePreviewIdentity ? this.projectPreviewCandidate : null
    const expectedSource = preview?.sourceIdentity
      ? { stablePickKey: preview.stablePickKey, sourceIdentity: preview.sourceIdentity }
      : undefined
    const resolved = doc.resolveProjectSource
      ? doc.resolveProjectSource({ clientX, clientY, local, tolerance, expectedSource })
      : resolveProjectHit(doc.getProjectCandidates(), fallbackHitPoint, tolerance)
    if (!resolved.ok) {
      this.projectPreviewCandidate = null
      return resolved
    }
    if (
      expectedSource
      && !SketchInteraction.sameProjectSource(expectedSource, resolved.candidate)
    ) {
      this.projectPreviewCandidate = null
      return projectRefusal(
        'stale-source',
        'Project: source geometry changed after preview; move the pointer and try again',
      )
    }
    this.projectPreviewCandidate = resolved.candidate
    return resolved
  }

  /** Current display anchor (world mm) of a dimension's value label; null when the dim cannot
   *  resolve. The canvas leader drag and the DOM label drag seed from the SAME resolver the
   *  renderer uses, so a grab never jumps. */
  private dimAnchor(dimId: string): SketchVec2 | null {
    const doc = this.doc
    const sketch = doc?.getSketch()
    if (!doc || !sketch) return null
    const d = sketch.dimensions.find((x) => x.id === dimId)
    if (!d) return null
    return dimensionDisplay(sketch, d, doc.getDisplayUnits())?.anchor ?? null
  }

  private get camera(): THREE.Camera {
    return this.host.camera
  }

  private get el(): HTMLElement {
    return this.host.domElement
  }

  private setCursor(css: string): void {
    this.el.style.cursor = css
  }

  // WO SKC-55: position/depth-aware, not the origin-anchored, z=0 `host.worldPerPixel()` default.
  // `layer.worldPerPixelAt` is the SAME depth-aware helper badge scaling already used (it forwards
  // the sketch-LOCAL point through the layer's display-offset pose, then asks the host for scale
  // AT the SketchLayer's actual render height, SKETCH_Z) -- so hover/drag/snap/staged-drag/
  // text-attach tolerance now sizes itself at the gesture's own position and depth instead of a
  // single per-frame scalar anchored at the plane origin. `at` defaults to the last known cursor
  // position (every call site below either has a fresher point in hand and passes it explicitly,
  // or is a cursor-less path -- e.g. a fresh press before any move -- where the last cursor is the
  // best available estimate; `{ x: 0, y: 0 }` is the final origin fallback for the case neither
  // exists yet, e.g. before the very first pointermove of a session).
  private wpp(at?: SketchVec2): number {
    return this.layer.worldPerPixelAt(at ?? this.lastCursor ?? { x: 0, y: 0 })
  }

  private tolWorld(at?: SketchVec2): number {
    return SKETCH_PICK_PX * this.wpp(at)
  }

  private moveActiveDrag(world: SketchVec2): void {
    if (!this.draggedEndpoint) {
      this.doc?.dragMove(world)
      return
    }
    const snap = findEndpointDragSnap(
      this.draggedEndpoint,
      world,
      this.doc?.getSketch()?.entities ?? [],
      this.tolWorld(world),
    )
    this.dragSnapTarget = snap
    this.painter.setSnapDisplay(snap ? {
      point: snap.point,
      kind: snap.kind === 'point' ? 'endpoint' : 'intersection',
      sourceEntityIds: [snap.kind === 'point' ? snap.ref.entityId : snap.entityId],
      inferences: [],
    } : null)
    this.doc?.dragMove(snap?.point ?? world)
  }

  /** Resolve a staged fillet/chamfer's draggable ghost through the exact
   *  preview geometry that the painter and Apply already consume. */
  private stagedSizeDragAt(clientX: number, clientY: number): ActiveStagedSizeDrag | null {
    const state = toolState()
    const sketch = this.doc?.getSketch()
    if (!sketch) return null
    const world = this.clientToLocal(clientX, clientY)
    const tolerance = this.tolWorld(world)
    if (state.tool === 'fillet' && state.chain?.kind === 'fillet' && state.chain.corners.length > 0) {
      const drag = startStagedSizeDrag(
        filletChainPreview(state.chain, sketch, state.filletRadius).dragRegions,
        state.filletRadius,
        world,
        tolerance,
      )
      return drag ? { kind: 'fillet', drag } : null
    }
    if (state.tool === 'chamfer' && state.chain?.kind === 'chamfer' && state.chain.corners.length > 0) {
      const drag = startStagedSizeDrag(
        chamferChainPreview(state.chain, sketch, state.chamferSetback).dragRegions,
        state.chamferSetback,
        world,
        tolerance,
      )
      return drag ? { kind: 'chamfer', drag } : null
    }
    return null
  }

  /** Both direct manipulation and typed entry write the same package-owned
   *  scalar setter for their tool kind. */
  private setStagedSizeValue(kind: StagedSizeKind, value: number): void {
    if (kind === 'fillet') sketcherTools.setFilletRadius(value)
    else sketcherTools.setChamferSetback(value)
  }

  // Screen client coords -> sketch-LOCAL coords. The host resolves the screen ray onto the sketch
  // plane; the layer's display pose is then inverse-mapped so the result is in the document's
  // LOCAL frame (identity for a normal geo; the seed-slot inverse for a posed nest seed). Every
  // sketch interaction (snap, click-to-place, drag, swipe, marquee corners) consumes sketch
  // coords, so this single seam keeps picking correct at the offset location.
  private clientToLocal(clientX: number, clientY: number): SketchVec2 {
    const w = this.host.clientToPlaneWorld(clientX, clientY)
    return this.layer.worldToLocal(w.x, w.y)
  }

  /** `opts.generous` opts this call into PASS 2 (SKC-57): only the select-mode
   *  hover and its paired pointerup click-select fallback pass it, because
   *  those two must agree (hover predicts click); every other call site
   *  (pointerdown, pick-tool hover, text-edit press/double-click) stays tight
   *  so precision-sensitive gestures (drag-start, marquee-vs-not, the
   *  separate pick-tool click resolver) keep today's behavior exactly. */
  private pickAt(
    clientX: number,
    clientY: number,
    opts?: { generous?: boolean },
  ): SketchPickHit | null {
    const rect = this.el.getBoundingClientRect()
    return this.layer.pick(
      clientX - rect.left,
      clientY - rect.top,
      this.camera,
      rect.width,
      rect.height,
      SKETCH_PICK_PX,
      // Raw (page) client coords, threaded through for the layer's reverse
      // clientToPlaneLocal callback -- host.clientToPlaneWorld does its own
      // rect.left/top subtraction, so it needs the UNadjusted client point,
      // not the canvas-relative pxX/pxY above (those stay for screen-space
      // badge comparisons).
      clientX,
      clientY,
      opts?.generous ? SKETCH_PICK_GENEROUS_PX : undefined,
    )
  }

  /** Re-render the tool overlay at the last cursor position (store value changes — overlay
   *  fields, chain transitions — must live-update the preview without a pointermove). */
  refreshToolOverlay(): void {
    if (!this.toolArmed() || !this.lastCursor) {
      this.painter.setToolOverlayDisplay(null)
      return
    }
    this.painter.setToolOverlayDisplay(
      sketcherTools.overlay(this.lastCursor, this.tolWorld(this.lastCursor)) ?? null,
    )
  }

  // ---- Session attach / detach ------------------------------------------------

  attach(): void {
    const el = this.el
    el.addEventListener('pointerdown', this.handlePointerDown)
    el.addEventListener('pointermove', this.handlePointerMove)
    el.addEventListener('pointerup', this.handlePointerUp)
    el.addEventListener('pointercancel', this.handlePointerCancel)
    el.addEventListener('lostpointercapture', this.handleLostPointerCapture)
    el.addEventListener('dblclick', this.handleDoubleClick)
    // The host's overlay surface (canvas + its DOM sketch overlays). The two gestures that used to
    // live in mount files ride here: the dimension VALUE-LABEL drag/click/double-click, and the
    // right-button context menu. Both are decided in this module and nowhere else.
    const oh = this.host.overlayHost
    oh.addEventListener('pointerdown', this.handleOverlayPointerDown)
    oh.addEventListener('dblclick', this.handleOverlayDoubleClick)
    oh.addEventListener('contextmenu', this.handleOverlayContextMenu)
    this.attachWindowKeys()
  }

  /** The SINGLE window-keydown registration site (WO INT-15). Kept as one method so both attach()
   *  and resumeWindowKeys() re-arm through the SAME registration call -- the key-listener census
   *  counts registration SITES, so a second literal keydown registration would read as a new,
   *  unlisted listener. Idempotent via the null-handler guard in resumeWindowKeys / at call sites. */
  private attachWindowKeys(): void {
    this.keyHandler = this.handleKeyDown
    window.addEventListener('keydown', this.keyHandler)
  }

  detach(): void {
    const el = this.el
    el.removeEventListener('pointerdown', this.handlePointerDown)
    el.removeEventListener('pointermove', this.handlePointerMove)
    el.removeEventListener('pointerup', this.handlePointerUp)
    el.removeEventListener('pointercancel', this.handlePointerCancel)
    el.removeEventListener('lostpointercapture', this.handleLostPointerCapture)
    el.removeEventListener('dblclick', this.handleDoubleClick)
    const oh = this.host.overlayHost
    oh.removeEventListener('pointerdown', this.handleOverlayPointerDown)
    oh.removeEventListener('dblclick', this.handleOverlayDoubleClick)
    oh.removeEventListener('contextmenu', this.handleOverlayContextMenu)
    this.endLabelDrag()
    this.rightDown = null
    // Leaving sketch mode closes any open context menu (the component opened it, so it closes it).
    this.menu?.close()
    if (this.keyHandler) {
      window.removeEventListener('keydown', this.keyHandler)
      this.keyHandler = null
    }
    // Last-resort cleanup tail: exit/dispose may arrive while any primary gesture is live. The same
    // idempotent finalizer used by pointerup/cancel/lost-capture owns dragEnd and orbit restoration.
    this.finalizePrimaryGesture()
    this.painter.setToolPreview(null)
    this.painter.setSnapDisplay(null)
    this.painter.setToolOverlayDisplay(null)
    this.lastCursor = null
    this.projectPreviewCandidate = null
    this.layer.setHover(null)
    this.setCursor('')
  }

  // ---- WO INT-15 (F-5): window-key disarm on workspace suspend ------------------
  //
  // WHY THIS EXISTS, SEPARATE FROM detach(). INT-13B's Sketcher.suspend() quiesces an
  // ENTERED session WITHOUT exiting it (D3.2 keeps an open sketch open across a workspace
  // switch), so it deliberately left interaction.attach()'s WINDOW keydown handler live --
  // and that is the F-5 leak: a suspended Part sketcher still claimed single-key tool chords
  // (l/r/c/s/g/...) from the CAM workspace, because this window listener sits on `window`, not
  // inside the host's display:none subtree, so the suspend never reached it. suspend() now calls
  // suspendWindowKeys() (detach the window key handler ONLY -- the INT-13B "a suspended host has
  // no listener at all" idiom, D5.2, not an event-time flag), and resume() re-arms via
  // resumeWindowKeys(). The POINTER/overlay listeners are left untouched: they sit on the host
  // canvas/overlayHost, which IS inside the suspended display:none subtree, so they cannot fire,
  // and touching them would risk the gesture/arbiter state INT-13B's suspend contract must
  // preserve intact (sketcher/index.ts:271-276). Both idempotent; a no-op with no key handler
  // attached (the session never entered, or already suspended).
  //
  // SHARED-PACKAGE SURFACE: this is the one Sketcher both hosts mount, so the disarm applies to
  // BOTH the 3D modeling workspace and the CAM sketcher instance identically (feedback_sketcher_parity_part_cam).
  suspendWindowKeys(): void {
    if (this.keyHandler) {
      window.removeEventListener('keydown', this.keyHandler)
      this.keyHandler = null
    }
  }

  resumeWindowKeys(): void {
    if (!this.keyHandler) this.attachWindowKeys()
  }

  /** WO INT-15 gate seam (F-5): true iff this interaction's window keydown handler is attached --
   *  lets a test read the disarm's real structural state instead of inferring it from behaviour. */
  isKeyListenerAttached(): boolean {
    return this.keyHandler !== null
  }

  // ---- Overlay-surface gestures ------------------------------------------------
  //
  // The host renders the dimension VALUE labels as DOM (crisp, constant size while panning), each
  // tagged `data-dim-id`. Rendering is the host's; the GESTURE is not. Everything below -- the
  // press, the 3px threshold, the one undo step, the label move, the trailing click-select, the
  // double-click-to-edit, and the right-button menu discrimination -- was second-owner code in
  // SketchDimensionOverlay.tsx and Viewport.tsx until WO SKC-14-R1.

  /** The dimension id of the DOM value label under an event, or null when the event landed
   *  anywhere else on the overlay surface (the canvas included). */
  private dimIdFromEvent(event: Event): string | null {
    const target = event.target as Element | null
    const label = target?.closest?.('[data-dim-id]') as HTMLElement | null
    return label?.dataset?.dimId ?? null
  }

  private handleOverlayPointerDown = (event: PointerEvent) => {
    // Right button anywhere on the surface (canvas or overlay): remember where it went down.
    if (event.button === 2) {
      this.rightDown = { x: event.clientX, y: event.clientY }
      return
    }
    if (event.button !== 0) return
    const dimId = this.dimIdFromEvent(event)
    if (dimId == null) return // a canvas press: the canvas handlers own it
    const anchor = this.dimAnchor(dimId)
    if (!anchor) return
    // The press belongs to the label, not to the canvas underneath it.
    event.stopPropagation()
    this.labelDrag = {
      id: dimId,
      startX: event.clientX,
      startY: event.clientY,
      orig: { x: anchor.x, y: anchor.y },
      moved: false,
      step: this.newGestureStep(),
    }
    window.addEventListener('pointermove', this.handleLabelPointerMove)
    window.addEventListener('pointerup', this.handleLabelPointerUp, { once: true })
  }

  private handleLabelPointerMove = (event: PointerEvent) => {
    const drag = this.labelDrag
    if (!drag) return
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (!drag.moved) {
      if (dx * dx + dy * dy < DIM_LABEL_DRAG_PX ** 2) return // sub-threshold: still a click
      drag.moved = true
      // ONE undoable step for the whole label-drag gesture, opened before the first move lands.
      drag.step()
    }
    const wpp = this.wpp(drag.orig)
    // Screen y grows downward, world y upward (top-down sketch view).
    this.doc?.moveDimLabel(drag.id, {
      x: drag.orig.x + dx * wpp,
      y: drag.orig.y - dy * wpp,
    })
  }

  private handleLabelPointerUp = (event: PointerEvent) => {
    const drag = this.labelDrag
    this.endLabelDrag()
    if (!drag || drag.moved) return // a completed drag is not a click
    // Labels are DOM, so canvas picking never sees this press: the click-select happens here,
    // under the SAME rules as entity picking (plain click replaces, Shift toggles).
    const doc = this.doc
    if (!doc) return
    const current = doc.getSelection()
    if (event.shiftKey) {
      doc.setSelection(
        current.includes(drag.id)
          ? current.filter((id) => id !== drag.id)
          : [...current, drag.id],
      )
    } else {
      doc.setSelection([drag.id])
    }
  }

  private endLabelDrag(): void {
    window.removeEventListener('pointermove', this.handleLabelPointerMove)
    window.removeEventListener('pointerup', this.handleLabelPointerUp)
    this.labelDrag = null
  }

  private handleOverlayDoubleClick = (event: MouseEvent) => {
    const dimId = this.dimIdFromEvent(event)
    if (dimId == null) return // a canvas double-click: handleDoubleClick owns it
    event.stopPropagation()
    this.doc?.openDimEditor(dimId)
  }

  private handleOverlayContextMenu = (event: MouseEvent) => {
    // Suppressed inside the viewport only -- the rest of the app keeps its browser menu. This
    // handler is installed on session enter and removed on exit, so "are we in sketch mode?" is
    // answered by the listener's existence rather than by a mount reading store state.
    event.preventDefault()
    const down = this.rightDown
    this.rightDown = null
    if (down && Math.hypot(event.clientX - down.x, event.clientY - down.y) > RIGHT_DRAG_PAN_PX) {
      return // right-drag = orbit-controls pan, not a menu request
    }
    const local = this.clientToLocal(event.clientX, event.clientY)
    this.lastCursor = local
    sketcherTools.setClipboardPlacement(local)
    this.menu?.open(event.clientX, event.clientY)
  }

  // ---- Keyboard ---------------------------------------------------------------

  private handleKeyDown = (e: KeyboardEvent) => {
    // Escape during a staged size drag cancels the GESTURE, not the
    // selected corner set: restore the pointerdown size through the same
    // scalar setter used by typed edits, release capture, and leave the
    // existing ghost ready for another drag or Apply. A second Escape can
    // then perform the tool machine's normal back/cancel action.
    if (e.key === 'Escape' && this.stagedSizeDrag) {
      e.preventDefault()
      this.finalizePrimaryGesture()
      this.refreshToolOverlay()
      return
    }
    // Escape cancels an in-progress draw BEFORE the typing-guard below.
    // Why: the sketch canvas preventDefaults pointerdown (marquee text
    // guard), so a click never moves focus onto the canvas. If a toolbox
    // spinner (e.g. grid spacing) was focused before the draw, focus stays
    // invisibly stuck on it through the whole draw - a real Escape then has
    // e.target=INPUT, the typing guard swallows it, and the draw never
    // cancels (Operator's "no text field focused" repro). Sketch value editors
    // (draw-value box, dimension/confirm overlays) stopPropagation their own
    // Escape, so anything that reaches here is safe to treat as a cancel.
    if (e.key === 'Escape' && sketcherTools.escape()) {
      // Un-stick focus from the foreign input so later keys/shortcuts work.
      ;(document.activeElement as HTMLElement | null)?.blur?.()
      this.painter.setToolPreview(null)
      this.painter.setSnapDisplay(null)
      this.projectPreviewCandidate = null
      this.refreshToolOverlay() // post-Esc chain state
      return
    }
    // SKC-BLOCKS Stage 4: while a block edit-in-place session is open (and no
    // tool is armed inside it -- an armed tool's OWN Escape already returned
    // above, so reaching here means select mode), Enter/Esc behave like the
    // tool machine's own confirm/cancel: Enter finishes (re-freezes the
    // block), Esc cancels (reverts it). Mutually exclusive with a live text
    // edit by construction (a block-edit session never has one open), so no
    // conflict-guard is needed against getTextEditId().
    const liveBlockEditId = this.doc?.getBlockEditId?.() ?? null
    if (liveBlockEditId != null && this.tool() === 'select') {
      if (e.key === 'Escape') {
        e.preventDefault()
        this.doc?.cancelBlockEdit?.()
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        this.doc?.finishBlockEdit?.()
        return
      }
    }
    // Never hijack keys while the user is typing in a field (shared
    // focus-guard predicate; also guards the tool shortcuts below).
    if (isTypingTarget(e.target as HTMLElement | null)) return
    const clipboardChord = (e.ctrlKey || e.metaKey) && !e.altKey
    if (clipboardChord && e.key.toLowerCase() === 'c') {
      e.preventDefault()
      sketcherTools.copySelection()
      return
    }
    if (clipboardChord && e.key.toLowerCase() === 'v') {
      e.preventDefault()
      sketcherTools.pasteSelection(this.lastCursor ?? undefined)
      return
    }
    const nudgeStep = e.shiftKey ? 1 : 0.1
    const nudge =
      e.key === 'ArrowLeft' ? { x: -nudgeStep, y: 0 } :
      e.key === 'ArrowRight' ? { x: nudgeStep, y: 0 } :
      e.key === 'ArrowDown' ? { x: 0, y: -nudgeStep } :
      e.key === 'ArrowUp' ? { x: 0, y: nudgeStep } :
      null
    if (nudge) {
      // Modifier chords remain available to the browser/app. CAM opts into
      // nudgeSelection through its document port; the Part mount deliberately
      // omits it, so this shared listener does not expand Part behavior.
      if (e.ctrlKey || e.altKey || e.metaKey) return
      if (this.doc?.nudgeSelection?.(nudge, this.newGestureStep())) e.preventDefault()
      return
    }
    if (e.key === 'Escape') {
      // Esc not consumed by the tool machine -> clear the selection.
      this.doc?.setSelection([])
    } else if (e.key === 'Enter') {
      // Enter is the tool machine's confirm key - ONE code path with the
      // prompt-bar Confirm button (both call sketchToolEnd). Prevent the
      // browser default so a still-focused BUTTON never receives a
      // synthetic click: the sketch canvas preventDefaults pointerdown
      // (marquee text-selection guard), so clicking entities never moves
      // focus off the toolbox button that armed the tool - without this,
      // Enter confirmed the set and then "clicked" the armed tool button,
      // toggling the tool off (B16: Enter ended mirror doing nothing).
      e.preventDefault()
      sketcherTools.end()
      this.painter.setToolPreview(null)
      this.painter.setSnapDisplay(null)
      if (this.tool() !== 'project') this.projectPreviewCandidate = null
      this.refreshToolOverlay() // post-confirm chain state
    } else if (e.key === 'Tab' && this.tool() === 'smart-dimension') {
      // Tab forces the linear-dimension orientation (auto -> aligned -> H ->
      // V -> auto) when the drag-vector auto-snap picks the wrong one near
      // the aligned/H/V boundary. Scoped to the armed smart-dim tool so Tab
      // keeps its normal focus behavior everywhere else; preventDefault here
      // stops focus leaving the canvas mid-placement.
      e.preventDefault()
      sketcherTools.cycleDimForce()
      this.refreshToolOverlay() // re-resolve the witness preview
    } else if (
      e.key === 'Tab' &&
      (this.tool() === 'rect-corner' || this.tool() === 'rect-center')
    ) {
      // Tab toggles ROTATED (angled) rectangle mode (item G): the box drops
      // the H/V lock and draws at a free angle via a 3-click flow. Scoped to
      // the armed rect tools so Tab keeps its normal focus behavior
      // everywhere else; preventDefault keeps focus on the canvas mid-draw.
      e.preventDefault()
      sketcherTools.toggleRectRotated()
      this.refreshToolOverlay() // re-resolve the rubber-band preview
    } else if (e.key === 'q' || e.key === 'Q') {
      // Construction toggle: selection flip, else draw-mode toggle.
      sketcherTools.toggleConstruction()
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      // Delete the selection (no-op when nothing is selected). Prevent
      // default so Backspace can never trigger browser navigation.
      e.preventDefault()
      sketcherTools.deleteSelection()
    } else {
      // Single-key tool shortcuts (Stage 6): l/r/c/a/d/t/o/m/e/f/h/1/2 arm
      // their tool, and `i` toggles the Measure readout (pure dispatch map in
      // lib/sketch/tools/shortcuts.ts; modifier chords fall through). Arming
      // clears any in-progress preview/snap feedback, same as clicking the
      // tool button. Measure is a utility, not a drawing tool, so it only
      // flips the shared `measureOpen` flag the toolbox reads.
      const action = shortcutActionForKeyEvent({
        key: e.key,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        metaKey: e.metaKey,
        repeat: e.repeat,
        target: e.target as HTMLElement | null,
      })
      if (action?.kind === 'tool') {
        sketcherTools.armTool(action.tool)
        this.painter.setToolPreview(null)
        this.painter.setSnapDisplay(null)
        this.painter.setToolOverlayDisplay(null)
        if (action.tool !== 'project') this.projectPreviewCandidate = null
      } else if (action?.kind === 'utility' && action.utility === 'measure') {
        sketcherTools.toggleMeasure()
      }
    }
  }

  // ---- Pointer down -----------------------------------------------------------

  private handlePointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || !this.doc) return
    // Suppress the compatibility mousedown so a marquee drag that leaves
    // the canvas never starts a DOM text selection.
    event.preventDefault()
    // preventDefault() above ALSO suppresses the browser's default
    // focus-shift-on-click (the same "canvas never steals focus" fact the
    // Escape handler above works around at :438), so a focused sketch value
    // editor (the dimension popup / draw-value box, both `.sketch-dim-input`)
    // never receives a native blur from a canvas click-away -- WO UI-26's
    // commit-on-blur would be unreachable by a real click without this
    // explicit blur. The text WYSIWYG editor (`.sketch-text-input`) is a
    // different class and untouched, so the M1c drag-while-typing exception
    // below is unaffected.
    const focused = document.activeElement as HTMLElement | null
    if (focused?.classList.contains('sketch-dim-input')) focused.blur()
    const pointerId = Number.isInteger(event.pointerId) ? event.pointerId : 0
    if (Number.isInteger(event.pointerId) && typeof this.el.setPointerCapture === 'function') {
      // Pointer capture is the causal fix: a release outside the canvas is retargeted here. Let a
      // real browser capture failure surface instead of silently returning to the stuck-session bug.
      this.el.setPointerCapture(event.pointerId)
      this.capturedPointerId = event.pointerId
    }
    // Publish the live gesture only after capture succeeds, so an explicit browser capture error
    // cannot leave a half-started primary pointer that would consume the next valid click.
    this.primaryPointerId = pointerId
    // No pick while a CREATE tool is armed OR an attach-to-path pick is
    // pending: presses are tool clicks, never entity selection or marquee
    // starts. (Text-on-path attach is reached from SELECT mode, so the
    // press must behave like an armed press to reach the pointer-up pick
    // routing cleanly instead of starting a marquee/entity drag.)
    // M1c EXCEPTION (drag-while-typing): with the TEXT tool armed and an
    // in-canvas edit OPEN, a press ON the edited text KEEPS its hit so the
    // move handler can grow it into the NORMAL entity drag (slide the text
    // without committing the edit). Every other armed press stays hit-null;
    // a sub-threshold press on the edited text falls through to
    // sketchToolClick at pointerup, where the store's M1c guard makes it a
    // safe no-op (caret stays open).
    let hit: SketchPickHit | null = null
    if (this.doc?.getPickPathForTextId() != null) {
      // pending curve pick: always a tool click
    } else if (this.toolArmed()) {
      const editId = this.doc?.getTextEditId() ?? null
      if (editId && this.tool() === 'text') {
        const picked = this.pickAt(event.clientX, event.clientY)
        if (picked?.id === editId) hit = picked
      }
    } else {
      hit = this.pickAt(event.clientX, event.clientY)
    }
    this.pointerDown = { x: event.clientX, y: event.clientY, hit }
    // WO SKC-15B/SKC-15C: a left press inside an open sketch is a sketch gesture, never an orbit.
    // Suppress HERE, not at the 5px `dragBegin` threshold -- OrbitControls latches `state = ROTATE`
    // at pointerdown and would rotate through those first five pixels.
    //
    // UNCONDITIONAL, and that is the SKC-15C fix (SKC-15B suppressed only when `hit?.type ===
    // 'entity'`). A press on EMPTY space is not "nothing": with the select tool it becomes a MARQUEE
    // after 5px, and with a tool armed it becomes a draw click -- and under a nav preset that binds
    // LEFT to orbit, the old code let the camera rotate underneath both. At pointerdown the gesture
    // is not yet decided, so the answer cannot depend on which one it becomes. No-op under the
    // default 'session' policy (CAM), where orbit is already off for the whole session. See
    // ./orbitArbiter.ts for the full argument and its cost.
    this.orbit.beginSketchPress()
    // A press on the exact dashed preview of an already-staged fillet or
    // chamfer starts one shared size gesture immediately. Ordinary staging
    // clicks remain on the existing click-to-stage path below.
    const sizeDrag = this.stagedSizeDragAt(event.clientX, event.clientY)
    if (sizeDrag) {
      this.stagedSizeDrag = sizeDrag
      this.lastCursor = { x: sizeDrag.drag.grab.x, y: sizeDrag.drag.grab.y }
      this.setCursor('grabbing')
      return
    }
    // Trim tool: a press starts a potential drag-swipe path. Whether it
    // becomes a swipe (drag) or a click trim is decided at pointerup.
    this.swipePath =
      this.tool() === 'trim'
        ? [this.clientToLocal(event.clientX, event.clientY)]
        : null
    // WO-1862: a BEZIER press places the next anchor at the snapped press point; the drag pulls
    // its handle (the preview reads the press off the chain) and the release -- the ordinary tool
    // click at pointerup -- sets the handle where the pointer let go.
    if (this.tool() === 'bezier' && this.doc.getPickPathForTextId() == null) {
      const raw = this.clientToLocal(event.clientX, event.clientY)
      const world = sketcherTools.lockCursor(raw, event.shiftKey)
      sketcherTools.bezierPress(world, sketcherTools.snap(world, this.wpp(world), event.shiftKey) ?? null)
    }
  }

  // ---- Pointer move -----------------------------------------------------------

  private handlePointerMove = (event: PointerEvent) => {
    if (!this.doc) return

    // Armed tool: no marquee churn; the rubber-band preview tracks the
    // cursor while a chain is in progress.
    if (this.toolArmed()) {
      if (this.stagedSizeDrag) {
        const world = this.clientToLocal(event.clientX, event.clientY)
        const value = stagedSizeFromDrag(this.stagedSizeDrag.drag, world)
        this.lastCursor = world
        if (value !== null) this.setStagedSizeValue(this.stagedSizeDrag.kind, value)
        this.setCursor('grabbing')
        return
      }
      // M1c (drag-while-typing): an armed press only ever KEEPS a hit when
      // it landed ON the open text edit (pointerdown gate), so a held press
      // with a hit is the edited text being dragged. Grow it into the
      // NORMAL entity drag (dragBegin -> on-path slide / free anchor-pin in
      // the store); the armed hover/preview logic below must NOT run while
      // the gesture is live. Pointerup's dragActive branch ends the
      // drag WITHOUT a tool click; a sub-threshold press falls through to
      // sketchToolClick, where the store's M1c guard no-ops it.
      const downM1c = this.pointerDown
      if (downM1c?.hit) {
        if (this.dragActive) {
          this.moveActiveDrag(this.clientToLocal(event.clientX, event.clientY))
          return
        }
        const ddx = event.clientX - downM1c.x
        const ddy = event.clientY - downM1c.y
        if (ddx * ddx + ddy * ddy > SKETCH_DRAG_PX ** 2 && downM1c.hit.type === 'entity') {
          const grab = this.clientToLocal(downM1c.x, downM1c.y)
          if (this.doc?.dragBegin(downM1c.hit.id, grab, this.tolWorld(grab), this.newGestureStep())) {
            this.dragActive = true
            this.setCursor('grabbing')
            this.moveActiveDrag(this.clientToLocal(event.clientX, event.clientY))
          }
        }
        return // no hover/preview churn mid-press on the edited text
      }
      // PICK tools (smart-dim / mirror / pattern / project) hover-halo the
      // entity under the cursor so it reads as pickable; the cursor stays a
      // pointer over a target, crosshair otherwise. CREATE tools never
      // hover (they draw, not pick).
      if (this.tool() === 'project' && this.doc.resolveProjectSource) {
        // Project hovers external source geometry, never an active-sketch entity. Its cursor is
        // decided below by the same one resolution that paints the preview.
        this.layer.setHover(null)
      } else if (this.toolIsPickTool()) {
        const hit = this.pickAt(event.clientX, event.clientY)
        this.layer.setHover(hit?.id ?? null)
        this.setCursor(hit ? 'pointer' : 'crosshair')
      } else if (this.tool() === 'text') {
        // TEXT tool: the birth click attaches to a nearby curve, so
        // hover-halo the curve the click WOULD bind to -- the SAME helper
        // (pickTextAttachTarget, doubled tolerance) the store click uses,
        // so hover and click can never disagree. The cursor stays the
        // crosshair: text still PLACES at the click; the halo only flags
        // the attach candidate.
        const world = this.clientToLocal(event.clientX, event.clientY)
        const entities = this.doc?.getSketch()?.entities
        const hit = entities ? pickTextAttachTarget(entities, world, this.tolWorld(world)) : null
        this.layer.setHover(hit?.id ?? null)
        this.setCursor('crosshair')
      } else {
        this.layer.setHover(null)
        // Fillet/chamfer remain armed MODIFY tools everywhere else, but an
        // already-staged dashed preview is a direct-manipulation handle.
        this.setCursor(
          !this.pointerDown && this.stagedSizeDragAt(event.clientX, event.clientY)
            ? 'grab'
            : 'crosshair',
        )
      }
      // Trim drag-swipe in progress: accumulate the path, render it as
      // the preview band, and highlight every span the swipe would trim
      // (accumulating); snap feedback stays off (a swipe never snaps).
      if (this.swipePath && this.pointerDown) {
        const world = this.clientToLocal(event.clientX, event.clientY)
        const last = this.swipePath[this.swipePath.length - 1]
        if (Math.hypot(world.x - last.x, world.y - last.y) > this.wpp(world)) {
          this.swipePath.push(world)
        }
        if (this.swipePath.length > 1) {
          this.painter.setSnapDisplay(null)
          this.painter.setToolPreview(this.swipePath)
          this.painter.setToolOverlayDisplay(sketcherTools.swipeOverlay(this.swipePath) ?? null)
          return
        }
      }
      // Snap first; the rubber band tracks the SNAPPED point so the
      // preview always shows what the next click commits, and the snap
      // feedback (marker / guide / badge preview) follows the cursor.
      // Ortho-lock (Shift): lock the cursor to the chain's 0/45/90deg rays
      // BEFORE snapping, so the locked direction wins over soft H/V
      // inference and the SAME locked point feeds preview and the click.
      const rawWorld = this.clientToLocal(event.clientX, event.clientY)
      const world = sketcherTools.lockCursor(rawWorld, event.shiftKey) ?? rawWorld
      const snap = sketcherTools.snap(world, this.wpp(world), event.shiftKey) ?? null
      this.painter.setSnapDisplay(snap)
      // Woken refs (getSnap may just have woken one): persistent dimmed
      // rings, rebuilt per move (<= 3 small loops).
      this.painter.setWakeDisplay(toolState().wakeRefs)
      const tol = this.tolWorld(world)
      if (this.tool() === 'project') {
        const resolved = this.resolveProjectAt(
          event.clientX,
          event.clientY,
          rawWorld,
          snap?.point ?? world,
          tol,
          false,
        )
        if (this.doc.resolveProjectSource) this.setCursor(resolved.ok ? 'pointer' : 'crosshair')
        this.painter.setToolPreview(resolved.ok ? projectPreviewPaths(resolved.candidate, tol * 0.6) : null)
      } else {
        this.painter.setToolPreview(this.previewPoints(snap?.point ?? world, tol))
      }
      // Tool overlay (removal highlights / ghosts / warnings + the ortho
      // cue) at the (locked) cursor — overlay hit-testing matches the
      // click's pick behavior.
      // The "type a value mid-draw" box reads this each frame: it must be the
      // SAME point the rubber band shows (snap?.point ?? world), so a line
      // that LOOKS horizontal (soft H/V snap) or ortho-locked commits in that
      // exact direction (preview === commit). Free draw with no snap is
      // unchanged (snap is null -> world).
      this.lastCursor = snap?.point ?? world
      this.painter.setToolOverlayDisplay(sketcherTools.overlay(world, tol, event.shiftKey) ?? null)
      return
    }
    this.painter.setToolPreview(null) // disarmed: never leave a stale band
    this.painter.setSnapDisplay(null)
    this.painter.setWakeDisplay(null)
    this.painter.setToolOverlayDisplay(null)

    const down = this.pointerDown

    // Marquee: press started on empty space and the pointer moved far enough.
    if (down && !down.hit) {
      const dx = event.clientX - down.x
      const dy = event.clientY - down.y
      if (this.marqueeDiv || dx * dx + dy * dy > SKETCH_DRAG_PX ** 2) {
        this.updateMarquee(down.x, down.y, event.clientX, event.clientY)
        return
      }
    }

    // Entity drag: press started ON an entity and moved past the click
    // threshold. The store decides whether the entity may drag at all
    // (fully-defined geometry must not budge); a rejected gesture is
    // simply ignored — it never falls back to marquee.
    if (down && down.hit) {
      // Dimension leader-line drag: press on a dim's leader and drag to
      // reposition its value label (pure display data). Mirrors the DOM
      // value-label drag in SketchDimensionOverlay; a sub-threshold press
      // stays a click (which selects the dim at pointerup).
      if (down.hit.type === 'dimension') {
        if (this.dimDrag) {
          const w = this.clientToLocal(event.clientX, event.clientY)
          this.doc?.moveDimLabel(this.dimDrag.id, {
            x: this.dimDrag.origAnchor.x + (w.x - this.dimDrag.grab.x),
            y: this.dimDrag.origAnchor.y + (w.y - this.dimDrag.grab.y),
          })
          return
        }
        const dpx = event.clientX - down.x
        const dpy = event.clientY - down.y
        if (dpx * dpx + dpy * dpy > SKETCH_DRAG_PX ** 2) {
          const anchor = this.dimAnchor(down.hit.id)
          if (anchor) {
            // ONE undoable step for the whole leader-drag gesture (the undo
            // ADAPTER; CAM's sketchHistory is the sink).
            this.undo?.beginGesture()
            this.dimDrag = {
              id: down.hit.id,
              origAnchor: anchor,
              grab: this.clientToLocal(down.x, down.y),
            }
            this.setCursor('grabbing')
          }
        }
        return
      }
      if (this.dragActive) {
        this.moveActiveDrag(this.clientToLocal(event.clientX, event.clientY))
        return
      }
      const dx = event.clientX - down.x
      const dy = event.clientY - down.y
      if (dx * dx + dy * dy > SKETCH_DRAG_PX ** 2 && down.hit.type === 'entity') {
        const grab = this.clientToLocal(down.x, down.y)
        const dragOwnerId = ownerIdForSelection(down.hit.id)
        if (this.doc?.dragBegin(dragOwnerId, grab, this.tolWorld(grab), this.newGestureStep())) {
          this.dragActive = true
          this.draggedEndpoint = decodeEndpointSelectionRef(down.hit.id)
          this.dragSnapTarget = null
          this.dragSnapConstraint = null
          this.setCursor('grabbing')
          this.moveActiveDrag(this.clientToLocal(event.clientX, event.clientY))
        }
      }
      return // no hover churn mid-press
    }
    if (down) return // sub-threshold empty-space press: wait it out

    // Hover highlight + cursor feedback. While an "Attach to path" pick is
    // pending (select mode, pickPathForTextId set) ONLY a curve the
    // binding click would actually accept highlights -- the SAME helper +
    // doubled tolerance as the store's pick interception (excluding the
    // text being attached), so the halo never promises an attach the click
    // would refuse. Normal select-mode hover is untouched otherwise.
    const pickPathForTextId = this.doc?.getPickPathForTextId() ?? null
    if (pickPathForTextId != null) {
      const sketch = this.doc?.getSketch() ?? null
      const world = this.clientToLocal(event.clientX, event.clientY)
      const pathHit = sketch
        ? pickTextAttachTarget(sketch.entities, world, this.tolWorld(world), pickPathForTextId)
        : null
      this.layer.setHover(pathHit?.id ?? null)
      this.setCursor(pathHit ? 'pointer' : '')
      return
    }
    // WO SKC-57: GENEROUS -- one of the two paired sites (with the pointerup
    // fallback below) so hover predicts click.
    const hit = this.pickAt(event.clientX, event.clientY, { generous: true })
    this.layer.setHover(hit?.id ?? null)
    this.setCursor(hit ? 'pointer' : '')
  }

  // ---- Double click -----------------------------------------------------------

  private handleDoubleClick = (event: MouseEvent) => {
    if (event.button !== 0) return
    // Armed CREATE tool: double-click ends an in-progress chain (Enter equiv).
    if (this.toolArmed()) {
      sketcherTools.end()
      this.painter.setToolPreview(null)
      this.painter.setSnapDisplay(null)
      this.refreshToolOverlay()
      return
    }
    // Select mode: double-clicking a placed text entity re-opens it for a
    // LIVE in-place edit (string / height / angle / style); double-clicking a
    // block (SKC-BLOCKS Stage 4) opens it for edit-in-place instead. The store
    // no-ops for any other pick, so a double-click on ordinary geometry is
    // inert. A block dbl-click is swallowed while a session is ALREADY open
    // (nested edit-in-place is not a thing -- Finish/Cancel the open one first).
    const hit = this.pickAt(event.clientX, event.clientY)
    if (!hit) return
    if (this.doc?.getBlockEditId?.() != null) return
    const entity = this.doc?.getSketch()?.entities.find((e) => e.id === hit.id)
    if (entity?.kind === 'block') this.doc?.beginBlockEdit?.(hit.id)
    else this.doc?.editText(hit.id)
  }

  // ---- Pointer up -------------------------------------------------------------

  /** Browser pointer id, with a stable token for legacy jsdom MouseEvent stand-ins. */
  private pointerToken(event: PointerEvent): number {
    return Number.isInteger(event.pointerId) ? event.pointerId : 0
  }

  /**
   * The one cleanup owner for every primary-gesture release path. State is cleared BEFORE dragEnd
   * or releasePointerCapture can synchronously dispatch lostpointercapture, making re-entry a no-op.
   * An omitted pointer id is the detach/exit tail and force-finalizes whichever gesture is live.
   */
  private finalizePrimaryGesture(pointerId?: number): void {
    if (pointerId !== undefined && this.primaryPointerId !== pointerId) return

    const capturedPointerId = this.capturedPointerId
    const shouldSettleDrag = this.dragActive
    const dragConstraint = this.dragSnapConstraint ?? undefined
    const cancelledSizeDrag = this.stagedSizeDrag
    const shouldClearCursor = this.dragActive || this.dimDrag !== null || cancelledSizeDrag !== null
    const shouldClearSwipeDisplay = this.swipePath !== null && this.swipePath.length > 1

    this.primaryPointerId = null
    this.capturedPointerId = null
    this.pointerDown = null
    this.dragActive = false
    this.draggedEndpoint = null
    this.dragSnapTarget = null
    this.dragSnapConstraint = null
    this.clearMarquee()
    this.swipePath = null
    this.stagedSizeDrag = null
    this.dimDrag = null
    // WO-1862: a bezier press the release did not consume (cancel / lost capture) is forgotten.
    sketcherTools.clearBezierPress()
    this.orbit.endSketchPress()
    if (shouldClearCursor) this.setCursor('')
    if (shouldClearSwipeDisplay) {
      this.painter.setToolPreview(null)
      this.painter.setSnapDisplay(null)
      this.painter.setToolOverlayDisplay(null)
    }
    if (cancelledSizeDrag) {
      this.setStagedSizeValue(cancelledSizeDrag.kind, cancelledSizeDrag.drag.startValue)
    }
    if (shouldSettleDrag) {
      this.painter.setSnapDisplay(null)
      this.doc?.dragEnd(dragConstraint)
    }

    if (capturedPointerId !== null
      && typeof this.el.hasPointerCapture === 'function'
      && this.el.hasPointerCapture(capturedPointerId)) {
      this.el.releasePointerCapture(capturedPointerId)
    }
  }

  private handlePointerCancel = (event: PointerEvent) => {
    this.finalizePrimaryGesture(this.pointerToken(event))
  }

  private handleLostPointerCapture = (event: PointerEvent) => {
    this.finalizePrimaryGesture(this.pointerToken(event))
  }

  private handlePointerUp = (event: PointerEvent) => {
    if (event.button !== 0) return
    const pointerId = this.pointerToken(event)
    if (this.primaryPointerId !== pointerId) return
    try {
      this.completePointerUp(event)
    } finally {
      this.finalizePrimaryGesture(pointerId)
    }
  }

  /** Apply the semantic result of a normal pointerup; cleanup always belongs to the finalizer. */
  private completePointerUp(event: PointerEvent): void {
    const doc = this.doc
    const down = this.pointerDown
    if (!doc || !down) return

    // Drag finish: geometry stays where the solver put it (the store's
    // endSketchDrag settles with a plain solve). The finalizer calls dragEnd exactly once.
    if (this.dragActive) {
      if (this.draggedEndpoint && this.dragSnapTarget) {
        this.dragSnapConstraint = constraintForEndpointDragSnap(
          this.draggedEndpoint,
          this.dragSnapTarget,
          crypto.randomUUID(),
        )
      }
      return
    }

    // Dimension leader-line drag finish: the anchor is already committed by
    // the move handler. The finalizer clears it; this is not a selection click.
    if (this.dimDrag) return

    // Staged-size finish: the latest scalar already drives the live
    // ghost and readout. Clear only the gesture latch; the existing Apply
    // path remains the sole geometry commit and will consume this exact value.
    if (this.stagedSizeDrag) {
      this.stagedSizeDrag = null
      this.setCursor(this.stagedSizeDragAt(event.clientX, event.clientY) ? 'grab' : 'crosshair')
      return
    }

    // Armed CREATE tool: a stationary press is a tool click on the sketch
    // plane (drags while armed are ignored — pan/zoom stay on right/wheel)
    // EXCEPT the trim tool, whose drag is the swipe-trim gesture, and the
    // bezier tool (WO-1862), whose drag pulls the handle of the anchor its
    // press placed -- its release is the click, dragged or not.
    if (this.toolArmed()) {
      const swipe = this.swipePath
      this.swipePath = null
      const dx = event.clientX - down.x
      const dy = event.clientY - down.y
      if (dx * dx + dy * dy > SKETCH_DRAG_PX ** 2 && this.tool() !== 'bezier') {
        if (swipe && swipe.length > 1) {
          sketcherTools.swipeTrim(swipe, this.newGestureStep())
          this.painter.setToolPreview(null)
          this.painter.setSnapDisplay(null)
          this.painter.setToolOverlayDisplay(null)
        }
        return
      }
      // Ortho-lock (Shift): commit on the SAME locked point the preview
      // showed (preview === commit while held).
      const rawWorld = this.clientToLocal(event.clientX, event.clientY)
      const world = sketcherTools.lockCursor(rawWorld, event.shiftKey)
      const tol = this.tolWorld(world)
      const snap = sketcherTools.snap(world, this.wpp(world), event.shiftKey)
      const projectResolution = this.tool() === 'project'
        ? this.resolveProjectAt(
            event.clientX,
            event.clientY,
            rawWorld,
            snap?.point ?? world,
            tol,
            true,
          )
        : undefined
      // Shift at commit -> rect square lock (equal-leg constraint downstream).
      sketcherTools.click(
        world,
        tol,
        snap,
        event.shiftKey,
        this.newGestureStep(),
        projectResolution,
      )
      // Refresh the rubber band from the post-click chain state so a
      // committing click clears it immediately (stale shape otherwise);
      // snap feedback clears too (the next pointermove redraws it).
      if (projectResolution) {
        if (doc.resolveProjectSource) this.setCursor(projectResolution.ok ? 'pointer' : 'crosshair')
        this.painter.setToolPreview(
          projectResolution.ok ? projectPreviewPaths(projectResolution.candidate, tol * 0.6) : null,
        )
      } else {
        this.painter.setToolPreview(this.previewPoints(snap?.point ?? world, tol))
      }
      this.painter.setSnapDisplay(null)
      // Recompute (not clear) the overlay from the post-click state:
      // accumulated previews (fillet arcs, pattern ghosts) must persist
      // without waiting for the next pointermove. Match the rubber band's
      // point (snap?.point ?? world) so the value box stays consistent.
      this.lastCursor = snap?.point ?? world
      this.painter.setToolOverlayDisplay(sketcherTools.overlay(world, tol, event.shiftKey))
      return
    }

    // Marquee finish.
    if (this.marqueeDiv) {
      this.clearMarquee()
      const a = this.clientToLocal(down.x, down.y)
      const b = this.clientToLocal(event.clientX, event.clientY)
      // Convention: left-to-right drag = window (fully contained),
      // right-to-left = crossing (any intersection).
      const windowSelect = event.clientX >= down.x
      const ids = this.layer.entitiesInRect(
        Math.min(a.x, b.x), Math.min(a.y, b.y),
        Math.max(a.x, b.x), Math.max(a.y, b.y),
        windowSelect,
      )
      if (event.shiftKey) {
        doc.setSelection([...new Set([...doc.getSelection(), ...ids])])
      } else {
        doc.setSelection(ids)
      }
      return
    }

    // Click (no meaningful drag).
    const dx = event.clientX - down.x
    const dy = event.clientY - down.y
    if (dx * dx + dy * dy > SKETCH_DRAG_PX ** 2) return
    // Attach-to-path pick pending (text-on-path): this stationary click is the
    // curve pick. Route it through click() -> store.sketchToolClick, whose
    // pick interception binds the text to the clicked curve, BEFORE the
    // text-edit commit below can clear the pending pick and select the
    // curve instead. The pick is consumed here; do not also run select/commit.
    if (this.doc?.getPickPathForTextId() != null) {
      const world = this.clientToLocal(event.clientX, event.clientY)
      const snap = sketcherTools.snap(world, this.wpp(world), event.shiftKey)
      sketcherTools.click(world, this.tolWorld(world), snap, event.shiftKey, this.newGestureStep())
      return
    }
    // A live placed-text edit finalizes on any click-away (commit-on-
    // click); the entity was mutated live, so this just clears the edit state
    // before the normal selection click runs.
    // M1c EXCEPTION (drag-while-typing): a click ON the text being edited is
    // part of the edit, NEVER a click-away -- the caret stays open and the
    // click is consumed (a drag on it already slid it and returned above).
    // Same helper + semantics as the store's armed-mode guard in
    // sketchToolClick, so select mode and armed mode agree.
    const editId = this.doc?.getTextEditId() ?? null
    if (editId != null) {
      const sketch = this.doc?.getSketch() ?? null
      const edited = sketch?.entities.find((x) => x.id === editId)
      if (edited && sketch) {
        const world = this.clientToLocal(event.clientX, event.clientY)
        if (pointHitsTextEntity(edited, sketch.entities, world, this.tolWorld(world))) {
          return // edit stays open; no commit, no selection change
        }
      }
      this.doc?.commitTextEdit()
    }
    // WO SKC-57: GENEROUS -- paired with the hover site above so hover
    // predicts click. `down.hit` (the pointerdown pick) stays TIGHT and takes
    // priority when set; this fallback only runs when pointerdown missed, so
    // widening it is what lets a click-no-drag near a lone entity select it
    // (ACCEPTED TRADEOFF: clicking empty canvas within the generous radius of
    // a lone entity now selects it instead of deselecting -- Operator's ask by
    // construction; deselect still works farther out).
    const hit = down.hit ?? this.pickAt(event.clientX, event.clientY, { generous: true })
    if (hit) {
      const current = doc.getSelection()
      if (event.shiftKey) {
        doc.setSelection(
          current.includes(hit.id)
            ? current.filter((id) => id !== hit.id)
            : [...current, hit.id],
        )
      } else {
        doc.setSelection([hit.id])
      }
    } else if (!event.shiftKey) {
      doc.setSelection([]) // click on empty space clears
    }
  }

  // ---- Marquee ----------------------------------------------------------------

  private updateMarquee(x0: number, y0: number, x1: number, y1: number): void {
    const rect = this.el.getBoundingClientRect()
    if (!this.marqueeDiv) {
      this.marqueeDiv = document.createElement('div')
      this.host.container.appendChild(this.marqueeDiv)
    }
    // Solid rectangle for window (L-to-R), dashed for crossing (R-to-L).
    this.marqueeDiv.className =
      x1 >= x0 ? 'sketch-marquee' : 'sketch-marquee sketch-marquee-crossing'
    this.marqueeDiv.style.left = `${Math.min(x0, x1) - rect.left}px`
    this.marqueeDiv.style.top = `${Math.min(y0, y1) - rect.top}px`
    this.marqueeDiv.style.width = `${Math.abs(x1 - x0)}px`
    this.marqueeDiv.style.height = `${Math.abs(y1 - y0)}px`
  }

  private clearMarquee(): void {
    this.marqueeDiv?.remove()
    this.marqueeDiv = null
  }

  // ---- Per-frame no-leak clearing ---------------------------------------------

  /** No state leaks: a disarm that happens WITHOUT a canvas pointermove (toolbox button
   *  click, mode exit) must still clear the snap feedback and the rubber band on the very
   *  next frame. */
  onFrame(): void {
    if (this.tool() !== 'project' && this.projectPreviewCandidate !== null) {
      this.projectPreviewCandidate = null
      this.painter.setToolPreview(null)
    }
    if (!this.toolArmed()) {
      if (this.painter.snapChildCount() > 0) this.painter.setSnapDisplay(null)
      if (this.painter.wakeChildCount() > 0) this.painter.setWakeDisplay(null)
      if (this.painter.hasPreview()) this.painter.setToolPreview(null)
      if (this.painter.overlayChildCount() > 0) this.painter.setToolOverlayDisplay(null)
    } else if (this.painter.wakeChildCount() > 0) {
      const refs = toolState().wakeRefs
      if (this.painter.wakeNeedsRebuild(refs)) this.painter.setWakeDisplay(refs)
    }
  }
}
