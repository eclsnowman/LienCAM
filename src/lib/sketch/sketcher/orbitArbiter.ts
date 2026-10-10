// WO SKC-15B (S3), item 4: the ONE owner of orbit suppression inside the sketcher package.
//
// Operator, driving the workbench (T-SKC-PARITY finding 3): "sketch view should be normal to sketch
// plane view, and rotatable by the user if desired, but both should not happen at the same time."
//
// Before this file, the package expressed exactly one policy, inline in `Sketcher.enter()`/`exit()`:
// delete orbit rotation for the WHOLE session. That is right for CAM -- its sketch camera is an
// orthographic top view locked normal-to-plane, and left-drag is a marquee -- and it is wrong for
// the workbench, where Operator wants to be able to tumble the part between drags and only needs the
// guarantee that an ENTITY DRAG never orbits.
//
// Rather than let the two mounts each write `controls.enableRotate` on their own schedule (the
// second-owner shape this program keeps deleting -- CAM's own `sketchSavedEnableRotate` and
// SceneRuntime's `setDragOrbitSuppressed` are two existing copies of this exact save/restore), the
// POLICY lives here, in the package, behind `SketcherHost.orbitPolicy`, and every write to
// `controls.enableRotate` in the package goes through this class.
//
// THE IDENTITY ARGUMENT (WO criterion 4, "CAM UNCHANGED"):
//
//   `orbitPolicy` is OPTIONAL and `undefined` resolves to 'session'. CAM's CNCViewport never sets
//   it. Under 'session' the drag methods below (`beginDrag`/`endDrag`) early-return BEFORE touching
//   `controls`, so they perform ZERO writes; the only writes that survive are the enter/exit pair,
//   in the same order, with the same values, as the inline code they replaced:
//
//       enter(): saved = controls.enableRotate ; controls.enableRotate = false
//       exit():  controls.enableRotate = saved
//
//   `src/tests/sketch/sketcherLifecycle.test.ts` tests 1-5 pin exactly that sequence (test 1: false
//   after enter; test 3: pre-enter `true` restored; test 4: pre-enter `false` restored; test 5: a
//   bare exit writes nothing). They are UNMODIFIED by this WO and stay green. The mutation proof in
//   coordination/evidence/SKC-15B/ forces the 'drag' branch under the CAM default and shows test 1
//   fail by name.
//
// Under 'drag' (the workbench): entry does NOT suppress -- the user may deliberately rotate between
// gestures -- and suppression is scoped to a single left PRESS, mirroring SceneRuntime
// `setDragOrbitSuppressed`'s own documented idempotence contract: a second `beginSketchPress()`
// while already suppressed does not clobber the saved value with `false`, and `endSketchPress()`
// when nothing is suppressed is a no-op. Every abort path in `SketchInteraction` (pointer-up, mode
// exit mid-drag via `detach()`) therefore calls `endSketchPress()` unconditionally without first
// asking whether a press or drag was in flight.
//
// WHY THE PRESS AND NOT `dragBegin()` (a deliberate departure from SKC-15B's suggested seam, which
// said "SketchInteraction suppresses orbit at drag begin"):
//
//   `doc.dragBegin()` fires only once the pointer has travelled SKETCH_DRAG_PX (5px) from the
//   press. OrbitControls' own `pointermove` handler re-reads `enableRotate` on every move, but it
//   latched `state = ROTATE` back at `pointerdown` -- so suppressing at the 5px threshold lets the
//   first five pixels of every entity drag rotate the camera. "Entity drags NEVER orbit" would then
//   be false, and the zero-camera-motion probe in
//   src/tests/sketch/sketcherOrbitPolicy.test.ts (which models OrbitControls' real
//   pointerdown-latch/pointermove-recheck behavior) fails by name.
//
//   The pre-existing workbench code already knew this: SolidsWorkbenchPage's inline drag machine
//   suppressed at POINTER DOWN over a grab target (`if (target !== null)
//   setDragOrbitSuppressed(true)`), and its comment named the residual risk of doing it any later.
//   Suppressing in the bubble-phase `pointerdown` is sufficient: OrbitControls' pointerdown records
//   a rotate ORIGIN but rotates nothing, and no `pointermove` for the gesture can arrive before
//   this handler has run. So NO rotation frame ever happens.
//
//   Consequence, faced deliberately: a press whose `dragBegin` is later REFUSED (a fully-defined or
//   grounded entity), and a press that never travels far enough to become anything at all, both hold
//   orbit suppressed until pointer-up. That is the old behavior verbatim -- `finalizeSketchDrag`
//   restored unconditionally, "a grab can be armed (suppressing orbit) and released/aborted without
//   ever crossing the move-threshold" -- and it is the right call: a press that landed inside an open
//   sketch is a sketch gesture, not an orbit.
//
// WO SKC-15C -- CLOSING SKC-15B'S OPEN FINDING: THE LEFT BUTTON BELONGS TO THE SKETCH.
//
// SKC-15B shipped `beginEntityPress()`: suppression scoped to a press that landed ON an entity. It
// then reported the hole that left. A left press on EMPTY space inside a 'drag'-policy session
// started the package's MARQUEE select and -- under the `liencnc-default` nav preset, where LEFT is
// bound to orbit (src/types/index.ts) -- an OrbitControls rotation. Both at once, which is exactly
// what Operator's T-SKC-PARITY finding 3 forbids: "rotatable by the user if desired, but both should not
// happen at the same time."
//
// THE DECISION, and it is CAM's own rather than a new invention. Ask how CAM resolves
// marquee-vs-nothing on empty space: it never has to. Under `orbitPolicy: 'session'` CAM deletes
// orbit rotation for the WHOLE sketch session, so inside a CAM sketch the left button is
// unambiguously the sketch's -- the marquee wins, always, and no rotation is possible. That is the
// rule, and it generalizes: INSIDE A SKETCH SESSION, A LEFT PRESS IS A SKETCH GESTURE. Entity drag,
// marquee, tool click: all of them. Common CAD navigation schemes reserve LEFT
// for select/draw and put orbit on another button.
//
// So `beginSketchPress()` replaces `beginEntityPress()` and fires on EVERY left press in the session,
// hit or no hit, armed tool or not. "Never both at once" then holds by CONSTRUCTION rather than by a
// case analysis of which gesture the press might become -- which matters, because at pointerdown the
// gesture is not yet decided (a press on empty space becomes a marquee only after 5px of travel, and
// OrbitControls has already latched ROTATE by then).
//
// WHAT 'drag' STILL BUYS, and why it is not merely 'session' with extra steps: suppression is scoped
// to the PRESS, so between presses `enableRotate` is restored. A user on the right-orbit,
// orbit-middle, pan-first, or orbit-first presets -- where LEFT is `'none'` and orbit lives on the
// middle or right button -- can therefore tumble the part freely mid-sketch, which is precisely what
// Operator asked for. Under `session` they could not: rotation is off for the entire session, on every
// button.
//
// THE COST, stated plainly rather than buried: under `liencnc-default` (LEFT = orbit, MIDDLE = zoom,
// RIGHT = pan) orbit has no other button to live on, so on that preset the user cannot tumble inside
// a sketch at all. That same preset already cannot marquee-select anywhere else in the app, for the
// same reason -- see `navActionToMouse`'s own comment, "'none' -> null leaves the button free for
// selection/marquee raycasting". It is a nav-preset problem, and giving the marquee away to work
// around it would be the wrong trade: a preset the user can change in Settings must not silently
// delete a sketch tool.

/** The two policies a mount may ask for. `undefined` on the host means 'session' (CAM's behavior). */
export type SketcherOrbitPolicy = 'session' | 'drag'

/** The slice of `SketcherHost` this class is allowed to see. Deliberately not the whole host: the
 *  arbiter must not be able to reach the camera, the DOM, or the document. */
export interface OrbitArbiterHost {
  readonly controls: { enableRotate: boolean }
  readonly orbitPolicy?: SketcherOrbitPolicy
}

export class OrbitArbiter {
  private readonly host: OrbitArbiterHost
  /** The pre-entry `enableRotate`, captured on `enterSession()`. Null outside a live session. */
  private sessionSaved: boolean | null = null
  /** The pre-drag `enableRotate`, captured on the first `beginDrag()` of a gesture. Null when no
   *  drag suppression is currently in force. The null sentinel IS the idempotence. */
  private dragSaved: boolean | null = null

  constructor(host: OrbitArbiterHost) {
    this.host = host
  }

  private policy(): SketcherOrbitPolicy {
    return this.host.orbitPolicy ?? 'session'
  }

  /**
   * Sketch entry. Captures the pre-entry flag under BOTH policies (exit restores it either way, so
   * a session can never leak a changed orbit flag back to the host), but only 'session' writes.
   */
  enterSession(): void {
    this.sessionSaved = this.host.controls.enableRotate
    if (this.policy() === 'session') this.host.controls.enableRotate = false
  }

  /**
   * Sketch exit. Restores the pre-entry flag.
   *
   * CLEANUP TAIL (charter item 5): a live drag suppression is DISCARDED here rather than unwound,
   * because the session restore below already writes the pre-entry value, which is what the
   * pre-drag value would have been restored to anyway. Clearing `dragSaved` first makes the
   * `endDrag()` that `SketchInteraction.detach()` fires immediately afterwards -- detach() settles
   * a mid-drag document -- an inert no-op instead of a second, later write that would clobber the
   * value this line just restored. Ordering between exit() and detach() therefore cannot matter.
   */
  exitSession(): void {
    this.dragSaved = null
    if (this.sessionSaved === null) return
    this.host.controls.enableRotate = this.sessionSaved
    this.sessionSaved = null
  }

  /** A left press landed inside the open sketch -- on an entity, on empty space, with a tool armed or
   *  not. The gesture belongs to the sketch, never to orbit (see this file's header for why the
   *  answer cannot depend on which gesture the press turns out to become). No-op under 'session'
   *  (orbit is already off for the whole session, and writing here would make this a second owner of
   *  the same flag). Idempotent: a repeat press never clobbers the saved value with `false`. */
  beginSketchPress(): void {
    if (this.policy() !== 'drag') return
    if (this.dragSaved === null) this.dragSaved = this.host.controls.enableRotate
    this.host.controls.enableRotate = false
  }

  /** The press ended, the drag aborted, or the mount tore down mid-gesture. Idempotent: safe to
   *  call from every abort path without knowing whether a press/drag was live. */
  endSketchPress(): void {
    if (this.policy() !== 'drag') return
    if (this.dragSaved === null) return
    this.host.controls.enableRotate = this.dragSaved
    this.dragSaved = null
  }

  /** Test/probe seam: is a drag suppression currently in force? The zero-camera-motion probe reads
   *  it to prove the suppression was actually applied rather than inferred from a silent no-op. */
  isDragSuppressed(): boolean {
    return this.dragSaved !== null
  }
}
