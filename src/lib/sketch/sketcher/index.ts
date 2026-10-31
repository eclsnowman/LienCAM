// WO SKC-14: THE Sketcher component. One self-contained package holding ALL of the felt surface:
// the document model (CAM `Sketch`, the only model), the tool state machine bridge,
// snapping/inference, live feedback painting, the dimension flow, camera POLICY, and the undo
// ADAPTER contract.
//
// Both surfaces MOUNT this. A mount provides only: a canvas/layer, a camera+controls handle, a
// plane frame, and a commit sink (see ./ports.ts). A mount contains NO tool logic, NO painting,
// NO pointer state -- thin enough that divergence has nowhere to live (the critic's law,
// docs/3d/SKETCH-CRITIC-REPORT.md, honored structurally).
//
//   * CAM 2D mode mounts it here, in this WO (src/lib/viewport/CNCViewport.ts).
//   * The workbench mounts it at S3 (SolidsWorkbenchPage) -- not this WO.
//
// Plan: docs/3d/SKETCH-CONVERGENCE-PLAN.md Section 8.2 (binding).
import { SketchLayer, type SketchViewState, type SketchOffset } from './sketchLayer'
import { SketchOverlayPainter } from './overlayPainter'
import { SketchInteraction } from './sketchInteraction'
import { OrbitArbiter } from './orbitArbiter'
import { bindSketcherDocument, setMeasureOpen, clearCreationSize } from './toolController'
import { sketcherToolStore, type SketcherToolState } from './toolStore'
import { sketcherMenuStore } from './overlays/menuStore'
import type {
  SketcherHost, SketcherCameraPose, SketchDocumentPort, SketchMenuPort, SketchUndoSink,
} from './ports'
import type { Sketch, Vec2 as SketchVec2 } from '../types'

export type {
  SketcherHost, SketcherCameraPose, SketchDocumentPort, SketchMenuPort, SketchNoticeSeverity,
  SketchUndoSink, SketcherOrbitPolicy,
} from './ports'
export { OrbitArbiter } from './orbitArbiter'
export * from './sketchLayer'

// ---- The tool slice (WO SKC-14B) --------------------------------------------------------------
//
// The armed tool, the chain, the snap flags/engine, the overlay resolver, the woken alignment refs
// and the inference accumulator live HERE, not in a host store. A mount reads them through
// `useSketcherTool` (React) or `sketcherToolStore.getState()` and dispatches through
// `sketcherTools`; it stores none of it.
export { sketcherToolStore, type SketcherToolState } from './toolStore'
export { sketcherTools, bindSketcherDocument, sketcherDocument } from './toolController'
export { useSketcherTool } from './useSketcherTool'

// ---- The overlay DOM (WO SKC-14C) --------------------------------------------------------------
//
// The eight sketch overlays -- dimension labels + value editor, live draw dims, the type-a-value
// box, the WYSIWYG text input, the on-path anchor pill, the prompt bar, the confirm overlay and the
// context menu -- are rendered by THIS package, from one reactive host port. A mount renders
// `<SketcherOverlays port={...}/>` and no sketch DOM of its own; there is no file in which a second
// version of the sketch chrome could be written.
//
// The context-menu ANCHOR is package state too (./overlays/menuStore.ts): a mount hands
// `sketcherMenuPort` to `Sketcher.setMenuPort()` and holds nothing.
export { SketcherOverlays } from './overlays/SketcherOverlays'
export { sketcherMenuPort, sketcherMenuStore } from './overlays/menuStore'
export type {
  SketcherOverlaysPort, SketcherOverlaySurface, SketchDimEditorState,
} from './overlays/port'

// ---- The document model + its canonical constructors (WO SKC-14-R1, finding 2) ----------------
//
// The CAM `Sketch` is the ONLY sketch model (plan Section 8.2), so it is re-exported from the
// component that owns it: a mount imports its document type from the sketcher, never the other way
// round. `canonicalArcFromThreePoints` rides along because it is S1's single arc constructor --
// the one place in the tree an arc may be built from three points (WO SKC-12 / BK-88). A second
// mount that wants to place an arc has nowhere else to get one.
export type {
  Sketch, SketchEntity, SketchConstraint, SketchDimension, Vec2,
} from '../types'
export { canonicalArcFromThreePoints } from '../../../components/sketch3d-shared/draftEntities'

// NOTE: geometry/arcTessellation is deliberately NOT re-exported here -- it exports its own
// density-policy-aware `arcSegmentCount`, which would collide with sketchLayer's render-density
// wrapper of the same name. Import it from './geometry/arcTessellation' directly.

/** What the component saves on sketch entry and restores on exit. The camera pose is opaque
 *  (the host minted it); the orbit flag is the component's own -- it owns the suppression, and
 *  since WO SKC-15B it holds it in `./orbitArbiter.ts`, the single writer of `controls.enableRotate`. */
interface SketchSession {
  cameraPose: SketcherCameraPose
}

type ToolOverlayInputs = Pick<
  SketcherToolState,
  | 'tool'
  | 'chain'
  | 'creationSize'
  | 'filletRadius'
  | 'chamferSetback'
  | 'offsetDistance'
  | 'linearPatternCount'
  | 'circularPatternCount'
  | 'circularPatternAngleDeg'
>

function toolOverlayInputs(state: SketcherToolState): ToolOverlayInputs {
  return {
    tool: state.tool,
    chain: state.chain,
    creationSize: state.creationSize,
    filletRadius: state.filletRadius,
    chamferSetback: state.chamferSetback,
    offsetDistance: state.offsetDistance,
    linearPatternCount: state.linearPatternCount,
    circularPatternCount: state.circularPatternCount,
    circularPatternAngleDeg: state.circularPatternAngleDeg,
  }
}

function sameToolOverlayInputs(a: ToolOverlayInputs, b: ToolOverlayInputs): boolean {
  return a.tool === b.tool &&
    a.chain === b.chain &&
    a.creationSize === b.creationSize &&
    a.filletRadius === b.filletRadius &&
    a.chamferSetback === b.chamferSetback &&
    a.offsetDistance === b.offsetDistance &&
    a.linearPatternCount === b.linearPatternCount &&
    a.circularPatternCount === b.circularPatternCount &&
    a.circularPatternAngleDeg === b.circularPatternAngleDeg
}

export class Sketcher {
  readonly layer: SketchLayer
  private readonly painter: SketchOverlayPainter
  private readonly interaction: SketchInteraction
  private readonly orbit: OrbitArbiter
  private session: SketchSession | null = null
  private toolOverlayUnsubscribe: (() => void) | null = null
  private offset: SketchOffset = { x: 0, y: 0, rotationDeg: 0 }
  /** The currently bound document sink, so `setDocumentPort` can tell a real document SWITCH from
   *  an idempotent re-bind of the same port (CAM's viewport re-binds its module const on mount). */
  private boundPort: SketchDocumentPort | null = null

  private readonly host: SketcherHost

  constructor(host: SketcherHost) {
    this.host = host
    this.layer = new SketchLayer(
      (at, localZ) => host.worldPerPixel(at, localZ),
      host.projectToScreen === undefined ? undefined : (at, localZ) => host.projectToScreen!(at, localZ),
      // SKC-54: click-pick's reverse conversion, composed from the SAME two steps
      // sketchInteraction.ts's clientToLocal already uses for draw/marquee -- host.clientToPlaneWorld
      // (the real per-host plane raycast: CAM's ortho unproject onto world XY, the workbench's
      // PerspectiveCamera raycast onto its datum PlaneFrame) followed by this.layer.worldToLocal
      // (reversing the display offset, e.g. a posed nest seed). `this.layer` is read at CALL time
      // (pick() only runs once the constructor below has finished and assigned it), not at closure
      // creation time, so the forward reference here is safe. Composed HERE, package-side, so
      // neither host file needs an edit -- clientToPlaneWorld is already a required port member both
      // hosts implement.
      (clientX, clientY) => {
        const w = host.clientToPlaneWorld(clientX, clientY)
        return this.layer.worldToLocal(w.x, w.y)
      },
    )
    host.overlayRoot.add(this.layer.group)
    this.painter = new SketchOverlayPainter(host.overlayRoot, (at) => host.worldPerPixel(at))
    this.orbit = new OrbitArbiter(host)
    this.interaction = new SketchInteraction(host, this.layer, this.painter, this.orbit)
  }

  // ---- Ports (a mount wires these once) ----------------------------------------

  /**
   * THE mount wiring. One call hands over the document/commit sink: the interaction layer reads
   * the document through it, and the package's tool controller commits through it.
   *
   * The controller is a module singleton (see toolStore.ts), so the LAST mount to bind owns the
   * commit sink, and tool state is SHARED across mounts. That is deliberate: the armed tool is a
   * global UI mode. Entry does not reset it -- CAM preserves an in-progress chain across sketch
   * re-entry today, and this WO changes no felt behavior. When S3 adds a second live mount, the
   * mount switch must clear the chain (it targets a different document); that is S3's to do, and
   * the sink binding above is where it hooks.
   */
  setDocumentPort(port: SketchDocumentPort | null): void {
    // WO SKC-15B item 5 (SKC-14C techDebt: "what does a document switch mean for the singleton
    // menuStore anchor?"). It CLOSES, for the same reason `resetForDocumentSwitch()` clears the
    // chain: an open context menu is anchored to a selection in a document that no longer exists,
    // and its Delete item would dispatch into the NEW document. The anchor is selection-scoped
    // state, and selection never survives a document switch.
    //
    // Guarded on a real switch: CAM's mount effect re-binds the SAME module const (`camSketch
    // DocumentPort`) on every viewport remount, and an idempotent re-bind is not a document switch.
    const switching = port !== this.boundPort
    this.boundPort = port
    this.interaction.setDocumentPort(port)
    bindSketcherDocument(port)
    if (switching) {
      sketcherMenuStore.close()
      // A live Sketcher changing document is a real session boundary. Initial
      // pre-entry wiring is not, so it must not disturb another retained host.
      if (this.session) setMeasureOpen(false)
    }
  }

  setUndoSink(sink: SketchUndoSink | null): void {
    this.interaction.setUndoSink(sink)
  }

  /** Context-menu presentation sink. The component decides WHEN a menu is requested and WHERE
   *  (right press + release without a pan drag, inside a live session); the host renders it. */
  setMenuPort(p: SketchMenuPort | null): void {
    this.interaction.setMenuPort(p)
  }

  // ---- Session lifecycle: the component owns CAMERA POLICY ----------------------
  //
  // Plan Section 8.2: "camera POLICY (the component owns orbit suppression and normal-to-plane
  // framing; it asks its host only for camera/controls handles)". CAM guarantees
  // "drag never orbits" by deleting orbit for the whole session; SKC-11's drag-never-orbits
  // finalization semantics carry in here. The HOST is asked only to save/restore a pose and to
  // frame normal-to-plane -- it never decides when.

  /** True while a sketch session is live. */
  isActive(): boolean {
    return this.session != null
  }

  /** True while an accepted entity drag currently holds orbit rotation suppressed (only ever true
   *  under `orbitPolicy: 'drag'`). Exposed so the workbench's zero-camera-motion probe can assert
   *  the suppression was really APPLIED, rather than pass vacuously against a policy that never
   *  writes -- a probe that cannot fail is not a gate (charter item 1). */
  isDragOrbitSuppressed(): boolean {
    return this.orbit.isDragSuppressed()
  }

  private subscribeToolOverlay(): void {
    if (this.toolOverlayUnsubscribe) return
    let previous = toolOverlayInputs(sketcherToolStore.getState())
    this.toolOverlayUnsubscribe = sketcherToolStore.subscribe(() => {
      const next = toolOverlayInputs(sketcherToolStore.getState())
      if (sameToolOverlayInputs(previous, next)) return
      previous = next
      this.refreshToolOverlay()
    })
  }

  /** Idempotent shared cleanup for every way an active component can stop owning store traffic. */
  private unsubscribeToolOverlay(): void {
    const unsubscribe = this.toolOverlayUnsubscribe
    this.toolOverlayUnsubscribe = null
    unsubscribe?.()
  }

  enter(): void {
    if (this.session) return
    // The tool controller is shared by the retained CAM and Model mounts. The inactive mount may
    // have bound its own document most recently, so entering this session must reclaim tool
    // commits before the first canvas click.
    bindSketcherDocument(this.boundPort)
    sketcherToolStore.setState({ creationSessionActive: true, creationDocumentId: this.boundPort?.getSketch()?.id ?? null })
    const cameraPose = this.host.saveCameraPose()
    this.host.onSessionEnter?.()
    this.layer.group.visible = true
    this.host.frameNormalToPlane()
    // Sketch interaction under the DEFAULT 'session' policy: left-drag becomes marquee select, so
    // orbit rotation is disabled (the sketch camera is locked normal-to-plane anyway). Under a
    // mount that asked for 'drag', the arbiter captures the flag and leaves rotation available --
    // see ./orbitArbiter.ts for why CAM's write sequence is unchanged either way.
    this.orbit.enterSession()
    this.session = { cameraPose }
    this.interaction.attach()
    this.subscribeToolOverlay()
  }

  /** WO INT-13B (spec 6.2(2)): quiesce an ENTERED session WITHOUT exiting it.
   *
   *  Why the package needs this at all. Until INT-13's D1, the CAM and Part roots
   *  were mutually exclusive, so `exit()` was the only path that ever
   *  unsubscribed (:255) and "unsubscribe but stay entered" was a combination
   *  nothing could ask for. D1 co-mounts both hosts, and D3.2 keeps an open
   *  sketch OPEN across a workspace switch -- so the SUSPENDED host must stop
   *  observing the store while its session survives intact. Exiting instead would
   *  restore the camera pose and tear down the session: precisely the data loss
   *  D3.2 forbids.
   *
   *  This is not merely a wasted-work optimization. `sketcherToolStore` is a
   *  MODULE SINGLETON (toolStore.ts:148) shared by every mount, and every entered
   *  Sketcher subscribes to that one store (:218-227) -- so with two sessions
   *  co-resident, one workspace's tool change repaints the OTHER workspace's
   *  invisible overlay. That is the "correctness hazard if the two instances
   *  observe the same store" spec 6.2(1) names, and it is real here, not
   *  theoretical.
   *
   *  Scope is deliberately ONLY the subscription: no camera, no selection, no
   *  interaction detach, no orbit-arbiter change. The arbiter state in particular
   *  MUST survive -- it is per-instance (orbitArbiter.ts holds no module state)
   *  and each host's session owns its own controls, which is what lets both
   *  sessions keep their own left-drag meaning while co-resident (spec 6.2(3),
   *  proved by the B5 gate).
   *
   *  Idempotent, and a no-op when no session is entered.
   *
   *  SHARED-PACKAGE SURFACE: this lands in the one Sketcher both hosts mount, so
   *  it is a sketch-surface change and is gated against BOTH mounts
   *  (UI-ARCHITECTURE.md:353, feedback_sketcher_parity_part_cam). */
  suspend(): void {
    if (!this.session) return
    this.unsubscribeToolOverlay()
    // WO INT-15 (F-5): also DISARM the interaction's window keydown handler. INT-13B's suspend
    // was subscription-only, so a suspended sketcher kept claiming single-key tool chords
    // (l/r/c/g/...) from the OTHER workspace -- the window listener sits on `window`, outside the
    // host's display:none subtree, so display:none never reached it. resume() re-arms. This is the
    // "a suspended host has no listener at all" idiom (D5.2), applied to the sketch key surface.
    this.interaction.suspendWindowKeys()
  }

  /** WO INT-13B (spec 6.2(2)): the exact inverse of suspend(). Re-observes the
   *  shared tool store for a session that never stopped being entered.
   *
   *  subscribeToolOverlay re-reads the store's CURRENT slice as its `previous`
   *  baseline (:220), so a tool change made in the OTHER workspace while this one
   *  was suspended does not spuriously repaint on resume -- it is absorbed as the
   *  new baseline. Idempotent (:219 guards a double-subscribe), and a no-op when
   *  no session is entered. */
  resume(): void {
    if (!this.session) return
    // A retained session resumes after the other workspace has owned the shared controller.
    // Reclaim this mount's document so armed tools commit into the visible sketch.
    bindSketcherDocument(this.boundPort)
    this.subscribeToolOverlay()
    // WO INT-15 (F-5): the inverse of suspend()'s window-key disarm -- re-attach the interaction's
    // window keydown handler for a session that never stopped being entered. Idempotent.
    this.interaction.resumeWindowKeys()
  }

  /** WO INT-13B: gate seam for B4's "the suspended host observed nothing" claim
   *  -- lets a test read the subscription's real state instead of inferring it. */
  isToolOverlaySubscribed(): boolean {
    return this.toolOverlayUnsubscribe !== null
  }

  /** WO INT-15 gate seam (F-5): true iff the sketch interaction's window keydown handler is
   *  attached. A suspended session must read FALSE -- that is the disarm this WO adds. */
  isInteractionKeyListenerAttached(): boolean {
    return this.interaction.isKeyListenerAttached()
  }

  /** Exit sketch mode: restore the saved camera pose, orbit flag and host presentation. */
  exit(): void {
    const session = this.session
    this.unsubscribeToolOverlay()
    if (!session) return
    this.session = null
    clearCreationSize()
    sketcherToolStore.setState({ creationSessionActive: false, creationDocumentId: null })
    setMeasureOpen(false)
    this.host.onSessionExit?.()
    this.layer.group.visible = false
    this.orbit.exitSession()
    this.interaction.detach()
    this.host.restoreCameraPose(session.cameraPose)
  }

  // ---- Document ------------------------------------------------------------------

  /** Re-render the active sketch (called reactively on store changes). `offset` is the display
   *  pose of the edited part (identity for a normal geo; the seed slot for a posed nest seed);
   *  it is mirrored onto the overlay carriers so interaction affordances render aligned. */
  private creationDocument: Sketch | null = null
  updateSketch(sketch: Sketch | null, view?: SketchViewState, offset?: SketchOffset): void {
    const previous = this.creationDocument
    this.creationDocument = sketch
    if (this.toolOverlayUnsubscribe && sketcherToolStore.getState().creationDocumentId !== sketch?.id) {
      sketcherToolStore.setState({ creationDocumentId: sketch?.id ?? null })
    }
    if (previous && (previous.id !== sketch?.id || previous.entities !== sketch?.entities ||
        previous.dimensions !== sketch?.dimensions)) clearCreationSize()
    this.offset = offset ?? { x: 0, y: 0, rotationDeg: 0 }
    this.layer.update(sketch, view, offset)
    this.painter.setOffset(this.offset)
    if (this.session) this.refreshToolOverlay()
  }

  /** Hover highlight driven from panel UI (constraint-browser rows): same path the in-viewport
   *  badge hover takes — a constraint/dimension id tints its glyph AND every entity it binds. */
  setHover(id: string | null): void {
    this.layer.setHover(id)
  }

  /** GEO-26 Stage B: repaint the sketch entities' selected/hover colors after
   *  a live Settings > Display glow switch (pass-through to the layer -- see
   *  SketchLayer.refreshGlow's doc comment for why this is needed at all). */
  refreshGlow(): void {
    this.layer.refreshGlow()
  }

  /** Current viewport-local sketch hover id (entity or constraint), or null. Exposed for the F9
   *  hover-treatment capture tooling to confirm a real pointermove registered the hover. */
  getHover(): string | null {
    return this.layer.getHover()
  }

  /** Last (plane-locked) sketch cursor in world mm, or null when no sketch pointermove has
   *  happened. The "type a value mid-draw" box reads this each frame. */
  getLastCursor(): SketchVec2 | null {
    return this.interaction.getLastCursor()
  }

  /** Re-render the tool overlay at the last cursor (store value changes must live-update the
   *  preview without waiting for a pointermove). */
  refreshToolOverlay(): void {
    this.interaction.refreshToolOverlay()
  }

  // ---- Render loop -----------------------------------------------------------------

  onFrame(worldPerPixel: number, resPxW: number, resPxH: number): void {
    this.layer.onFrame(worldPerPixel, resPxW, resPxH)
    this.interaction.onFrame()
  }

  dispose(): void {
    this.unsubscribeToolOverlay()
    this.session = null
    this.interaction.detach()
    this.painter.dispose()
    this.layer.dispose()
    this.host.overlayRoot.remove(this.layer.group)
  }
}
