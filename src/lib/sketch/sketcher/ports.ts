// WO SKC-14: the ONLY surface a host must implement to mount THE sketcher.
//
// The critic's law (docs/3d/SKETCH-CRITIC-REPORT.md): "divergence is structurally hard only when
// there is no file in which a second version could be written." Everything a user FEELS -- the
// tool state machine, snapping/inference, hover + preview painting, dimension flow, camera
// arbitration, undo granularity -- lives inside the component. A mount supplies only the four
// surface primitives (plan Section 3.2) plus a document/commit/undo sink, and is thin enough that
// divergence has nowhere to live.
//
// A mount contains NO tool logic, NO painting, NO pointer state, NO tool state, NO snap, NO
// overlay resolution, NO inference, and renders NO sketch overlay DOM. That is enforced
// structurally (the painter, the handlers, the tool state and the overlays live in this package)
// and guarded by the capability scans in src/tests/sketch/oneSketchPointerOwner.test.ts and
// src/tests/sketch/oneArcTessellator.test.ts.
//
// WO SKC-14-R1 (audit FAIL, blocker + finding 2/3) narrowed this surface:
//   * The host no longer RESOLVES anything for the component. `getPreview` and `getDimAnchor` are
//     gone -- they were the mount's two pieces of felt logic.
//   * Mutating commit operations take a `beforeMutate` hook and contain NO history call of their
//     own. The component latches it into exactly ONE undo step per gesture (see SketchUndoSink).
//   * `overlayHost` + `SketchMenuPort` let the component own the two gestures that used to live
//     in mount files: the DOM dimension-label drag and the right-button context menu.
//
// WO SKC-14-B closed the remaining CAM-store window (the R1 audit's S3-blocking major finding):
//   * `getToolState` / `getSnap` / `getOverlay` / `getSwipeOverlay` / `getWakeRefs` / `lockCursor`
//     are GONE. The package owns the tool machine, the snap engine, the overlay resolver and the
//     inference accumulator (./toolStore.ts + ./toolController.ts). Nothing asks the mount for
//     them because the mount no longer has them.
//   * `SketchToolHandlers` is replaced by `SketchDocumentPort` below: reads that return DATA the
//     host legitimately owns (the document, its display units, the grid, project candidates) and
//     writes that COMMIT. No branch on the armed tool survives on the host side.
import type * as THREE from 'three'
import type {
  Sketch, SketchConstraint, Vec2 as SketchVec2, SketchEntity,
} from '../types'
import type {
  ExpectedProjectSource, ProjectCandidate, ProjectResolveResult,
} from '../projectUse'
import type { ToolCommit } from '../tools/toolMachine'
import type { SketchDocTransform } from '../tools/trimTool'
import type { TextPathAlign } from '../types'
import type { Units } from '../../ui/unitFormat'
import type { SketcherOrbitPolicy } from './orbitArbiter'

export type { SketcherOrbitPolicy } from './orbitArbiter'

/** Opaque camera pose token. The component never inspects it -- it only asks the host to save a
 *  pose on sketch entry and hand the same token back on exit. */
export type SketcherCameraPose = unknown

/**
 * The host handles. CAM's CNCViewport implements this over an OrthographicCamera + its own
 * OrbitControls; the workbench (S3) will implement it over a PerspectiveCamera raycasting onto
 * a datum-plane frame. Neither implementation may do anything else for the sketcher.
 */
export interface SketcherHost {
  /** Pointer-event target and cursor owner (the WebGL canvas). */
  readonly domElement: HTMLElement
  /** Positioned ancestor the marquee <div> is parented to. */
  readonly container: HTMLElement
  /**
   * The DOM surface that covers the canvas AND the package's own sketch overlay elements (the
   * `.viewport-root` div that hosts <SketcherOverlays/>).
   *
   * The component attaches its OVERLAY gesture listeners here -- the dimension-label drag and the
   * right-button context menu. Both used to live in mount files (SketchDimensionOverlay,
   * Viewport), which is exactly the second-owner shape SKC-14's audit found. A host hands over a
   * DOM surface and nothing else; every gesture on it is decided in this package.
   *
   * Defaults to `container` for a host with no DOM overlays of its own.
   */
  readonly overlayHost: HTMLElement
  /** Scene root the component parents its sketch layer + overlay groups to. */
  readonly overlayRoot: THREE.Object3D
  /** Camera used to project/pick sketch geometry. */
  readonly camera: THREE.Camera
  /** Orbit controls whose rotation the component suppresses. WHEN it suppresses is `orbitPolicy`. */
  readonly controls: { enableRotate: boolean }
  /**
   * WO SKC-15B: WHEN the component suppresses orbit rotation. The component still owns the policy
   * (./orbitArbiter.ts is the only writer of `controls.enableRotate` in the package); a mount only
   * declares which of the two it needs.
   *
   *   'session' (DEFAULT, and what `undefined` means) -- orbit is off for the whole sketch session.
   *     CAM: the sketch camera is an ortho top view locked normal-to-plane and left-drag is a
   *     marquee, so there is nothing to rotate and nothing to protect. CAM never sets this field,
   *     which is why its behavior is byte-for-byte unchanged by the option existing.
   *
   *   'drag' -- orbit stays available, and is suppressed only for the duration of one ACCEPTED
   *     entity drag. The workbench: Operator wants a normal-to-plane framing on entry that he may
   *     deliberately tumble away from, but an entity drag must never also orbit
   *     (T-SKC-PARITY finding 3: "both should not happen at the same time").
   */
  readonly orbitPolicy?: SketcherOrbitPolicy

  // ---- The four surface primitives (plan Section 3.2) ----
  /** Screen client px -> WORLD point on the sketch plane. CAM: ortho unproject.
   *  Workbench: raycast onto the datum frame. The component then inverse-maps
   *  through the layer's display pose to reach sketch-LOCAL coords. */
  clientToPlaneWorld(clientX: number, clientY: number): SketchVec2
  /** World mm spanned by one screen pixel. Perspective hosts accept a sketch-local
   *  anchor because scale varies with rendered depth; orthographic hosts may ignore it. */
  worldPerPixel(at?: SketchVec2, localZ?: number): number
  /** Optional sketch-local -> client-pixel projection. Perspective mounts provide
   *  it so plane-aligned arrow geometry can compensate for directional foreshortening. */
  projectToScreen?(at: SketchVec2, localZ?: number): SketchVec2 | null

  // ---- Camera POLICY hooks: the component decides WHEN, the host knows HOW ----
  saveCameraPose(): SketcherCameraPose
  restoreCameraPose(pose: SketcherCameraPose): void
  /** Orient the camera normal-to the sketch plane (CAM: top view). */
  frameNormalToPlane(): void

  /** Host scene presentation for the duration of a sketch session (CAM hides stock /
   *  machine / toolpath). Not tool logic, not painting -- the host's own scene. */
  onSessionEnter?(): void
  onSessionExit?(): void
}

/**
 * Undo ADAPTER. The component owns the SEMANTICS -- one undoable step per gesture -- and the host
 * owns the SINK: CAM pushes onto its `sketchHistory` snapshot stack; the workbench (S3) will push
 * an `EditFeaturePayloadCommand` onto its `CommandHistory`. Neither history type leaks in here --
 * that is plan R3, the constraint that decides whether S3 can land at all.
 *
 * WO SKC-14-R1 finding 3. `beginGesture()` opens ONE step, and the component guarantees it is
 * called at most once per gesture and always BEFORE that gesture's first mutation. It does that by
 * handing each mutating commit operation a `beforeMutate` hook which is latched: the latch turns
 * the FIRST such call into a `beginGesture()` and swallows the rest. A gesture that mutates
 * nothing -- a tool click that merely advances the chain -- therefore opens NO step and never
 * costs the user a wasted Ctrl+Z. No host commit operation calls a history function of its own.
 */
export interface SketchUndoSink {
  /** Open ONE undoable step covering the gesture that is about to run. */
  beginGesture(): void
}

/**
 * The sketch context menu: the COMPONENT decides when one is requested (right button pressed and
 * released without a pan drag, inside a live session) and where; the host PRESENTS it. Same shape
 * as the camera-pose hooks -- policy in the component, mechanism in the host.
 */
export interface SketchMenuPort {
  open(clientX: number, clientY: number): void
  close(): void
}

/** Severity of a transient notice. Mirrors CAM's `ConsoleEventSeverity` structurally; the package
 *  cannot import the store's type, and a mount that has no console can ignore the argument. */
export type SketchNoticeSeverity = 'info' | 'success' | 'warning' | 'error'

/** Package-owned pointer facts passed to an optional host geometry resolver. */
export interface ProjectSourceResolverContext {
  clientX: number
  clientY: number
  local: SketchVec2
  tolerance: number
  /** Full source key/revision promised by the last hover preview, when one exists. */
  expectedSource?: ExpectedProjectSource
}

/**
 * THE mount contract (plan Section 8.2, binding).
 *
 * Every method here is one of exactly three things, and nothing else is admitted:
 *
 *   (a) a READ of data the host legitimately owns -- the document itself, the display units it
 *       renders in, its grid, and the OTHER-layer geometry the PROJECT tool may lift. None of it
 *       is tool state; none of it can be computed by the package.
 *   (b) a COMMIT -- one semantic document edit. The package never touches history: a gesture
 *       latches `SketchUndoSink.beginGesture` before the first write, and a non-gesture commit
 *       (overlay Apply, a typed value, Enter-to-finish) calls `beginStep()` explicitly.
 *   (c) a PRESENTATION sink -- `notice`. Same shape as `SketchMenuPort`: the package decides WHAT
 *       to say and WHEN; the host decides where it appears. CAM renders it in the App status bar,
 *       which non-sketch writers share; a headless mount can drop it on the floor.
 *
 * The text-edit members are (a)/(b) pairs, not tool state: the edited id is a DOCUMENT CURSOR --
 * "which entity is open for editing" -- exactly the shape as the selection below it, and every
 * transition mutates the document and the undo stack. See the SKC-14B report, row 9.
 */
export interface SketchDocumentPort {
  // ---- (a) Reads: data the host owns ------------------------------------------------
  /** The document being edited (CAM `Sketch` is the only model). */
  getSketch(): Sketch | null
  /**
   * A tool click must NEVER silently no-op (ADR-0003). Entering sketch mode normally auto-creates a
   * blank document; if a click still finds none (store-API entry paths), the host creates one HERE,
   * without disturbing the armed tool, so the click that triggered it lands in the new document.
   * Returns the document to use, or null if the host genuinely cannot make one.
   *
   * Only the host can do this: a blank document needs a layer, and layers are the host's.
   */
  ensureSketch(): Sketch | null
  /** Display units for dimension label text/anchors (ADR-0022: the document is always mm). */
  getDisplayUnits(): Units
  /** Grid pitch in world mm; the snap engine's grid candidate spacing. */
  getGridSpacing(): number
  /** Loops on OTHER visible layers that the PROJECT tool may lift. The package hit-tests them
   *  itself (`resolveProjectHit`) and commits the same loop the hover highlight promised. */
  getProjectCandidates(): ProjectCandidate[]
  /** Optional non-CAM source resolver. The package still owns gesture timing, preview, identity
   *  parity, commit, notices, and cleanup; a mount only resolves host-owned geometry. */
  resolveProjectSource?(context: ProjectSourceResolverContext): ProjectResolveResult
  /** Sketch selection. The host owns the state; the component picks/marquees/consumes it. */
  getSelection(): readonly string[]
  setSelection(ids: string[]): void

  /**
   * SKC-46 size memory. The last COMMITTED fillet radius / chamfer setback for this host's own
   * persist surface, or null when the user has never applied one (CAM/workbench both back this
   * with the shared `liencam-ui-prefs` store — UI setup, not project data, per uiPrefs.ts). Read
   * once when a NEW corner set starts staging on that tool (`armTool`/the first staged corner);
   * the view/geometry-derived grabbable default (stagedSizeDrag.ts) is used when null.
   */
  getLastStagedSize(kind: 'fillet' | 'chamfer'): number | null
  /** Write the last COMMITTED size for `kind`. Called exactly once per successful `overlayApply`
   *  fillet/chamfer branch (a real commit) — never on a canceled drag, a typed-but-unapplied edit,
   *  or a drag tick. */
  setLastStagedSize(kind: 'fillet' | 'chamfer', value: number): void

  // ---- (c) Presentation --------------------------------------------------------------
  notice(message: string, severity?: SketchNoticeSeverity): void

  // ---- (b) Commits -------------------------------------------------------------------
  /** Open ONE undo step NOW. Used only by commits that are not pointer gestures (the confirm
   *  overlay's Apply, a typed draw value, Enter-to-finish a spline). Pointer gestures latch
   *  `SketchUndoSink.beginGesture` instead and never call this. */
  beginStep(): void
  /**
   * Append a tool commit to the document and re-solve, history untouched.
   * `inferred` are the snap-inference constraints that must ride the SAME undo step.
   * `openDimensionEditor` asks the host to verdict-solve a newly placed driving dimension and
   * open its value editor (CAM's chunk-1 path); a typed value has already chosen its number and
   * passes false.
   */
  append(
    commit: ToolCommit,
    inferred: SketchConstraint[],
    opts?: { openDimensionEditor?: boolean; clearSelection?: boolean },
  ): void
  /** Swap in full replacement document arrays (MODIFY tools: trim, fillet, chamfer) and re-solve,
   *  history untouched. */
  replace(next: SketchDocTransform, opts?: { clearSelection?: boolean }): void
  /** Flip the construction flag on the current selection as ONE undo step. Returns false when the
   *  selection matched no entity -- the package then toggles its own draw-as-construction MODE. */
  toggleSelectionConstruction(): boolean
  /** Delete / Backspace (and the MODIFY Delete button): remove the selected objects, cascading
   *  referencing constraints/dimensions. Shared with a panel button, so it owns its own step. */
  deleteSelection(): void

  /** CAM-only keyboard nudge capability. The shared interaction calls this only for Arrow keys;
   *  mounts that do not opt in (currently the Part workbench) leave it absent. Returns false when
   *  the current selection contains no movable entity. `beforeMutate` opens the keypress's single
   *  undo step immediately before the accepted write. */
  nudgeSelection?(delta: SketchVec2, beforeMutate: () => void): boolean

  // ---- (b) Select-tool drag (host solves via temporary constraints) --------------------
  /** Returns false when the host rejects the drag (fully defined / grounded entity) -- the
   *  component then ignores the gesture. `beforeMutate` fires only on the accepted path. */
  dragBegin(entityId: string, grab: SketchVec2, tolWorld: number, beforeMutate: () => void): boolean
  dragMove(world: SketchVec2): void
  dragEnd(constraint?: SketchConstraint): void

  // ---- (b) Dimension labels ------------------------------------------------------------
  /** Move a dimension's label anchor (pure display data, never a solve) -- the canvas leader-line
   *  drag and the DOM value-label drag share this. */
  moveDimLabel(dimId: string, anchor: SketchVec2): void
  /** Open the value editor on a dimension (double-click on its DOM value label). */
  openDimEditor(dimId: string): void

  // ---- (a)/(b) Live text edit: a document cursor, not tool state ------------------------
  /** Id of the text entity under a live in-place edit, or null. */
  getTextEditId(): string | null
  /** Id of the text entity awaiting an "Attach to path" curve pick, or null. */
  getPickPathForTextId(): string | null
  /** Double-click a placed entity: open a LIVE in-place edit of a text entity. */
  editText(entityId: string): void
  /** Finalize the live text edit (click-away / Enter). */
  commitTextEdit(): void
  /** Revert-and-finish the live text edit (Esc). */
  cancelTextEdit(): void
  /** Abandon a pending "Attach to path" curve pick (Esc). */
  cancelPickTextPath(): void
  /** Place an empty text entity (free, or born ON-PATH) and open its caret. `construction` is the
   *  package's draw-as-construction MODE -- tool state the host does not have. */
  placeText(
    at: SketchVec2, onPath: SketchEntity | null, pathOffsetMm: number, align: TextPathAlign,
    construction: boolean,
  ): void
  /** Bind the pending text entity to the picked curve. */
  bindTextPath(textId: string, curveId: string): void

  // ---- (a)/(b) Block edit-in-place (SKC-BLOCKS Stage 4): a document cursor, --------------
  // exactly like live text edit above -- mutually exclusive with it (a block-edit session
  // never has a text edit open, and vice versa). OPTIONAL (like nudgeSelection above): only
  // a host that offers block edit-in-place needs to implement these; a mount that omits them
  // simply never opens the session (getBlockEditId reads null forever).
  /** Id of the block currently open for edit-in-place, or null. */
  getBlockEditId?(): string | null
  /** Double-click (or context-menu "Edit block") on a block: detach its members
   *  into the document as a live, editable session. No-op for a non-block id
   *  or while a session is already open. */
  beginBlockEdit?(entityId: string): void
  /** Finalize the block edit: re-group the current members back into the same
   *  block id/frame. May refuse by name (a notice), leaving the session open. */
  finishBlockEdit?(): void
  /** Revert-and-finish the block edit (Esc): restore the pre-edit block. */
  cancelBlockEdit?(): void
}
