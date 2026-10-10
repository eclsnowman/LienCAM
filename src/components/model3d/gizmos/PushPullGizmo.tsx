// WO UI-5: normal-constrained push/pull gizmo -- originally a sibling to
// TranslateGizmo reusing the stock three.js TransformControls (via
// TransformControlsAdapter). WO UI-57 (Operator verdict, T-UI5-PUSHPULL-RESIZE
// step 2 FAIL) REPLACES that stock 3-axis, positive-only-shaft gizmo with a
// purpose-built SYMMETRIC single-axis handle: TransformControls cannot draw
// a bidirectional shaft via its public API (showX/Y/Z only hides the
// half-shafts; the arrowhead pair still spans origin->positive only), so
// this component owns its own three.js geometry AND its own pointer
// lifecycle (raycast on pointerdown, closest-point-on-line projection on
// pointermove) -- it no longer depends on TransformControlsAdapter.ts at
// all (that file, and TranslateGizmo.tsx which still uses it, are untouched
// by this WO -- see PushPullGizmo.test.tsx's own header comment for the
// proof-of-isolation this file's rewrite required).
//
// Grab-anywhere-on-the-shaft dragging preserves the point under the cursor
// (a `grabOffset` captured on pointerdown), the same ergonomic a real
// TransformControls single-axis drag gives: dragging from the tip vs. the
// middle of the shaft both feel like "move with my cursor", never a jump to
// a canonical zero point.
//
// Attaches to nothing (there is no proxy object any more -- the OLD
// component moved an internal Object3D and read TransformControls' own
// `.object.position`; this one computes the signed mm delta directly from
// raycasting math and reports it, never a position). The visible handle
// stays FIXED at the picked face's origin for the whole gesture (it
// represents the AXIS, not a moving cursor) -- the caller's own live
// preview (the boolean re-tessellation) is what visibly grows/shrinks.
//
// WO UI-57 audit fixes:
//  F1 (pointer lifecycle) -- releaseDrag (pointerup) and abortDrag
//     (pointercancel, lostpointercapture, effect cleanup/unmount) both release
//     capture and emit dragging-false; NEITHER commits. Both idempotent.
//  F2 (cohesion) -- the handle auto-scales to a stable SCREEN size instead of
//     being a fixed 52mm object, takes its color from the viewport token
//     bridge, and drives grab/grabbing cursors with restoration of whatever
//     cursor the host had at mount.
//
// WO UI-79 (Operator verdict T-UI57-PUSHPULL, findings F-A + F-C):
//  F-A (release semantics -- fillet-drag parity) -- RELEASING THE DRAG NO
//     LONGER COMMITS. Pointer-up stops the drag and leaves the tool ARMED with
//     the live value shown; the caller's own Apply path (its AnchoredValueEntry
//     Enter/Apply, the SKC-44 staged-size standard's "Apply is the sole geometry
//     commit") is the ONLY commit. This component therefore has no onCommit
//     seam at all -- it REPORTS a live delta (onChange) and signals drag
//     start/end (onDraggingChange); it never completes the tool. A subsequent
//     grab continues from the current `value` (grabOffset is seeded so the
//     handle stays under the cursor without snapping the offset back to zero).
//  F-C (orbit-stuck-after-drag) -- claimPointerExclusively(): the viewport's
//     camera controls latch a rotate on the SAME pointerdown that grabs this
//     handle (its listener runs first, before the parent disables orbit in our
//     onDraggingChange), capture the pointer and install document move/up
//     listeners; our own pointerup stopPropagation then starves ITS pointerup
//     so it never unwinds -- it stays latched and orbits on the next buttonless
//     move until an empty-space click. We dispatch a non-bubbling synthetic
//     pointercancel for the grabbed pointer BEFORE taking our own capture, so
//     any controller tracking it forgets it and this gesture is the sole owner.

import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { asNumber } from '../../../theme/viewportColors'
import type { Vec3Like } from './TranslateGizmo'

export interface FaceFrame {
  origin: Vec3Like
  normal: Vec3Like
}

/** TEST-ONLY seam (mirrors the retired TransformControlsAdapter injection
 *  point's role): when a caller supplies `createTestDriver`, this component
 *  skips constructing its own raycaster/pointer-event machinery (jsdom lacks
 *  setPointerCapture and true hit-testing geometry) and instead drives
 *  onChange/onDraggingChange directly off the driver's own
 *  simulateDragStart/simulateDrag/simulateDragEnd calls. Production never
 *  supplies this -- the real handle drives pointer events on `domElement`
 *  itself. `simulateDrag` takes the SIGNED DELTA directly (there is no more
 *  off-axis raw position to project -- the real component enforces the
 *  on-axis constraint by construction now, not by post-hoc projection). */
export interface PushPullGizmoTestDriver {
  simulateDragStart(): void
  simulateDrag(delta: number): void
  /** WO UI-79 F-A -- Pointer-UP semantics: RELEASES the drag (emits
   *  dragging-false, tool stays armed with the live value). It does NOT commit
   *  -- this component has no commit seam; the caller's Apply path is the sole
   *  commit (see releaseDrag). */
  simulateDragEnd(): void
  /** WO UI-57 audit F1 (pointer lifecycle): the ABORT paths, which release +
   *  emit dragging-false but NEVER commit. Optional so every existing caller
   *  of this seam (SolidsWorkbenchPage.pushPull.test.tsx builds a 3-method
   *  driver literal) keeps compiling unchanged -- the component assigns them
   *  on the driver object it is handed, exactly like the three above. */
  simulateDragCancel?(): void
  simulateLostPointerCapture?(): void
}
export type CreatePushPullGizmoTestDriver = () => PushPullGizmoTestDriver

export interface PushPullGizmoProps {
  scene: THREE.Scene
  camera: THREE.Camera
  domElement: HTMLElement
  /** The picked planar face's world-space frame; null/undefined detaches
   *  (gizmo hidden -- same "no gizmo without a selection" contract
   *  TranslateGizmo's `target` prop documents). */
  face: FaceFrame | null | undefined
  enabled?: boolean
  /** Live-preview seam: fires continuously while dragging, with the signed
   *  mm offset along face.normal (never a raw position -- see file header). */
  onChange?(delta: number): void
  /** WO UI-79 F-A: the current signed offset the tool is armed at (the caller's
   *  live value, updated as this component's own onChange or the caller's typed
   *  entry changes it). A fresh grab seeds its drag from HERE so the offset
   *  continues from the armed value instead of snapping back to zero -- the
   *  fillet-drag parity Operator named. Defaults to 0 (a first grab right after the
   *  face pick, before any offset exists). */
  value?: number
  onDraggingChange?(dragging: boolean): void
  createTestDriver?: CreatePushPullGizmoTestDriver
  /** WO UI-14A (C5, UI-14.report.json defects[1]): sceneRuntime.ts renders
   *  strictly on-demand ('render on demand, no rAF loop') -- attaching/
   *  mounting a helper into the scene graph does NOT itself fire OrbitControls'
   *  own 'change' event, so without an explicit requestRender() call here the
   *  gizmo sits in THREE.Scene fully wired but invisible until the user's
   *  next orbit/pan/zoom gesture. Called once after the mount-once effect's
   *  initial scene.add call, once more on every face attach/detach, AND on
   *  every pointermove during a drag (the OLD TransformControls-backed
   *  version got a render "for free" from TransformControls' own internal
   *  wiring into the on-demand render loop; this component owns none of
   *  that plumbing, so it must ask explicitly on every visual change). */
  requestRender?(): void
}

/** Handle proportions, in the group's LOCAL units. These are no longer mm:
 *  WO UI-57 audit F2 ("the fixed-world gizmo is oversized [52mm handle on a
 *  40mm body]") -- the group is now camera-distance auto-scaled to a stable
 *  SCREEN size (see screenScaleFor), the way TransformControls and every real
 *  CAD gizmo behave, so these numbers only set the handle's PROPORTIONS
 *  (shaft:cone:picker ratios), never its size against the part. */
const SHAFT_HALF_LENGTH = 20
const SHAFT_RADIUS = 0.7
const CONE_HEIGHT = 6
const CONE_RADIUS = 2.4
/** Generous invisible picker cylinder radius -- easy to grab without
 *  pixel-perfect precision on the thin visible shaft. */
const PICKER_RADIUS = 3.5
/** End-to-end span of the handle in local units (shaft + both cones) -- the
 *  quantity screenScaleFor() maps onto a fraction of the viewport. */
const HANDLE_LOCAL_SPAN = SHAFT_HALF_LENGTH * 2 + CONE_HEIGHT * 2
/** Fraction of the viewport's HEIGHT the handle spans, at any camera distance
 *  and on any part size. ~1/5 of the frame: large enough to grab without
 *  precision, small enough that it never swamps the body it edits (the
 *  audit's "52mm handle on a 40mm body" failure). */
const HANDLE_SCREEN_FRACTION = 0.22
/** Half the handle's on-screen span, in CSS px, for a viewport `heightPx` tall.
 *
 *  UI-57-R1: the handle is drawn at a fixed fraction of the viewport, centred on
 *  the picked face's origin -- which is exactly where a caller anchors its
 *  AnchoredValueEntry. An anchored card placed "above the anchor" therefore
 *  lands ON TOP of the handle's + arrow and SWALLOWS THE GRAB: the card has
 *  pointerEvents:auto, so pointerdown never reaches the canvas and the drag
 *  cannot start at all (reproduced in a real browser -- zero pointerdown events
 *  on the canvas, cursor stuck on 'grab').
 *
 *  Callers pass pushPullHandleAvoidRect() to AnchoredValueEntry's `avoidRects`
 *  so the card slides clear of the handle instead of eating it. Exported from
 *  HERE so the geometry has ONE owner: a caller hard-coding "about 90px" would
 *  silently drift the moment HANDLE_SCREEN_FRACTION changes. */
export function pushPullHandleScreenHalfExtent(heightPx: number): number {
  return (heightPx * HANDLE_SCREEN_FRACTION) / 2
}

/** The canvas-relative box the push/pull handle occupies around `anchor`, for
 *  AnchoredValueEntry's `avoidRects`. Square: the handle points along the face
 *  normal, which can project to ANY screen direction, so the box covers the
 *  handle whichever way it lies. */
export function pushPullHandleAvoidRect(
  anchor: { x: number; y: number },
  viewport: { width: number; height: number },
): { left: number; top: number; right: number; bottom: number } {
  const r = pushPullHandleScreenHalfExtent(viewport.height)
  return { left: anchor.x - r, top: anchor.y - r, right: anchor.x + r, bottom: anchor.y + r }
}

/** Cohesion (COHESION-STANDARD.md section 1, "viewport color bridge"; review
 *  checklist item 1 "no raw hex that duplicates a token"): the handle is an
 *  active B-REP FACE PICK interaction, so it reads '--vp-brep-pick' -- the
 *  token whose whole job is brep pick state -- not '--sketch-selected' (the
 *  sketch-ENTITY palette, a different domain that merely happens to resolve to
 *  the same amber today). Both live under the section-3 amber viewport-
 *  selection doctrine, so this is the same accent, sourced from the right
 *  token instead of a duplicated 0xffaa00 literal. */
const HANDLE_COLOR_TOKEN = '--vp-brep-pick'

function toVector3(v: Vec3Like): THREE.Vector3 {
  return new THREE.Vector3(v.x, v.y, v.z)
}

/** Uniform scale that renders HANDLE_LOCAL_SPAN local units as
 *  HANDLE_SCREEN_FRACTION of the viewport height, for a gizmo sitting at
 *  `origin`. VISUAL ONLY -- the drag math (closestAxisParam off
 *  originRef/normalRef) works in unscaled world units and must never read
 *  this. Returns null when the camera kind/params cannot yield a sane scale,
 *  so callers leave the last good scale in place rather than collapsing the
 *  handle to 0 or NaN. */
function screenScaleFor(camera: THREE.Camera, origin: THREE.Vector3): number | null {
  let worldHeightAtOrigin: number
  if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
    const cam = camera as THREE.PerspectiveCamera
    const distance = cam.getWorldPosition(new THREE.Vector3()).distanceTo(origin)
    // Height of the view frustum, in world units, at the gizmo's own depth.
    worldHeightAtOrigin = (2 * distance * Math.tan((cam.fov * Math.PI) / 360)) / (cam.zoom || 1)
  } else if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
    const cam = camera as THREE.OrthographicCamera
    // Ortho has no perspective divide: the visible height is depth-independent.
    worldHeightAtOrigin = (cam.top - cam.bottom) / (cam.zoom || 1)
  } else {
    return null
  }
  const scale = (worldHeightAtOrigin * HANDLE_SCREEN_FRACTION) / HANDLE_LOCAL_SPAN
  if (!Number.isFinite(scale) || scale <= 0) return null
  return scale
}

/** Build the symmetric handle: a shaft spanning -L..+L along local +Z, with
 *  outward-pointing cones at both ends, plus an invisible fatter picker
 *  cylinder coincident with the shaft (real hit target). All local to the
 *  returned Group's own origin/orientation -- callers position/orient the
 *  Group itself, never these children. */
function buildHandleGeometry(): { group: THREE.Group; picker: THREE.Mesh } {
  const group = new THREE.Group()
  const material = new THREE.MeshBasicMaterial({ color: asNumber(HANDLE_COLOR_TOKEN), depthTest: false, depthWrite: false })
  group.renderOrder = 999 // always visible through the body, like a real gizmo

  const shaftGeom = new THREE.CylinderGeometry(SHAFT_RADIUS, SHAFT_RADIUS, SHAFT_HALF_LENGTH * 2, 12)
  shaftGeom.rotateX(Math.PI / 2) // cylinder's default axis is Y; align to local Z
  const shaft = new THREE.Mesh(shaftGeom, material)
  group.add(shaft)

  const coneGeom = new THREE.ConeGeometry(CONE_RADIUS, CONE_HEIGHT, 16)
  coneGeom.rotateX(Math.PI / 2) // cone's default apex points +Y; align apex to +Z
  const conePos = new THREE.Mesh(coneGeom, material)
  conePos.position.set(0, 0, SHAFT_HALF_LENGTH + CONE_HEIGHT / 2)
  group.add(conePos)

  const coneNeg = new THREE.Mesh(coneGeom, material)
  coneNeg.rotateX(Math.PI) // apex points -Z
  coneNeg.position.set(0, 0, -(SHAFT_HALF_LENGTH + CONE_HEIGHT / 2))
  group.add(coneNeg)

  const pickerGeom = new THREE.CylinderGeometry(PICKER_RADIUS, PICKER_RADIUS, SHAFT_HALF_LENGTH * 2 + CONE_HEIGHT * 2, 8)
  pickerGeom.rotateX(Math.PI / 2)
  const picker = new THREE.Mesh(pickerGeom, new THREE.MeshBasicMaterial({ visible: false }))
  group.add(picker)

  return { group, picker }
}

/** Closest point (as a signed distance along `axisDir` from `axisOrigin`) of
 *  a ray to an infinite 3D line -- the standard line-line closest-point
 *  formula. Returns null when the ray is nearly parallel to the axis
 *  (degenerate: an infinite family of equally-close points) rather than
 *  dividing by a near-zero denominator into a huge/NaN jump. */
function closestAxisParam(rayOrigin: THREE.Vector3, rayDir: THREE.Vector3, axisOrigin: THREE.Vector3, axisDir: THREE.Vector3): number | null {
  const b = rayDir.dot(axisDir)
  const denom = 1 - b * b
  if (Math.abs(denom) < 1e-9) return null
  const w0 = new THREE.Vector3().subVectors(rayOrigin, axisOrigin)
  const d = rayDir.dot(w0)
  const e = axisDir.dot(w0)
  const tAxis = (e - b * d) / denom
  return tAxis
}

export function PushPullGizmo({
  scene,
  camera,
  domElement,
  face,
  enabled = true,
  onChange,
  value = 0,
  onDraggingChange,
  createTestDriver,
  requestRender,
}: PushPullGizmoProps) {
  const groupRef = useRef<THREE.Group | null>(null)
  const pickerRef = useRef<THREE.Mesh | null>(null)
  const originRef = useRef(new THREE.Vector3())
  const normalRef = useRef(new THREE.Vector3(0, 0, 1))
  const enabledRef = useRef(enabled)
  const draggingRef = useRef(false)
  const grabOffsetRef = useRef(0)
  // WO UI-79 F-A: the current armed offset, read at pointerdown to seed a fresh
  // grab so re-dragging continues from the live value (see `value` prop).
  const valueRef = useRef(value)
  const pointerIdRef = useRef<number | null>(null)
  // Set by the mount-once effect below; read by the face-attach effect so a
  // freshly attached handle is sized for the CURRENT camera on its very first
  // frame, not one pointermove later.
  const applyScreenScaleRef = useRef<(() => boolean) | null>(null)
  // Callback refs so the mount-once effect below never needs to rebind
  // native DOM listeners just because a caller passed a fresh inline
  // callback on re-render (same pattern the old TransformControls-backed
  // version, and TranslateGizmo.tsx, both use).
  const onChangeRef = useRef(onChange)
  const onDraggingChangeRef = useRef(onDraggingChange)
  const requestRenderRef = useRef(requestRender)
  useEffect(() => {
    onChangeRef.current = onChange
    onDraggingChangeRef.current = onDraggingChange
    requestRenderRef.current = requestRender
    valueRef.current = value
  })
  useEffect(() => {
    enabledRef.current = enabled
  }, [enabled])

  useEffect(() => {
    const { group, picker } = buildHandleGeometry()
    groupRef.current = group
    pickerRef.current = picker
    group.visible = false
    scene.add(group)
    requestRenderRef.current?.()

    // WO UI-57 audit F2 (cursors): capture whatever cursor the HOST already
    // set on the canvas at mount and restore exactly that on hover-out / drag
    // end / abort / cleanup. Never hard-coded to 'default' -- that is the very
    // bug the audit called out at the parent (SolidsWorkbenchPage's sketch
    // package also writes this element's cursor; stomping it to 'default'
    // would silently break that owner's own cursor state).
    const originalCursor = domElement.style.cursor
    let hovering = false
    const restoreCursor = (): void => {
      hovering = false
      domElement.style.cursor = originalCursor
    }

    const raycaster = new THREE.Raycaster()
    const ndcFromEvent = (event: PointerEvent): THREE.Vector2 => {
      const rect = domElement.getBoundingClientRect()
      return new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -(((event.clientY - rect.top) / rect.height) * 2 - 1),
      )
    }
    const rayFromEvent = (event: PointerEvent): { origin: THREE.Vector3; direction: THREE.Vector3 } => {
      raycaster.setFromCamera(ndcFromEvent(event), camera)
      return { origin: raycaster.ray.origin.clone(), direction: raycaster.ray.direction.clone().normalize() }
    }
    const axisParamFromEvent = (event: PointerEvent): number | null => {
      const ray = rayFromEvent(event)
      return closestAxisParam(ray.origin, ray.direction, originRef.current, normalRef.current)
    }

    /** Re-derive the VISUAL screen-space scale from the current camera and the
     *  gizmo's own origin. Returns true when the scale actually moved (so the
     *  caller can ask for a render without a per-move render storm). Also
     *  refreshes matrixWorld: the picker raycast below hit-tests the SCALED
     *  mesh, so the transform must be current before any pointer hit-test. */
    const applyScreenScale = (): boolean => {
      const next = screenScaleFor(camera, originRef.current)
      if (next === null) return false
      const prev = group.scale.x
      if (Math.abs(next - prev) < prev * 1e-4) return false
      group.scale.setScalar(next)
      group.updateMatrixWorld(true)
      return true
    }
    applyScreenScaleRef.current = applyScreenScale

    const hitsPicker = (event: PointerEvent): boolean => {
      raycaster.setFromCamera(ndcFromEvent(event), camera)
      return raycaster.intersectObject(picker, false).length > 0
    }

    /** WO UI-79 F-C: claim `pointerId` exclusively for this gesture. The
     *  viewport's camera controls (OrbitControls) latched a rotate on the SAME
     *  real pointerdown -- its listener ran before ours and it was still
     *  enabled (the parent disables orbit only in our onDraggingChange, one
     *  step later), so it captured the pointer and installed document-level
     *  move/up listeners. A non-bubbling synthetic pointercancel makes any
     *  controller tracking this pointer forget it (removePointer ->
     *  releasePointerCapture -> remove its doc listeners -> state NONE) BEFORE
     *  we take our own capture below, so releasing this drag can never leave it
     *  stuck mid-rotate. Same sanctioned pattern createSketchRightDragOrbitGate
     *  uses to un-latch OrbitControls; bubbles:false keeps it to the canvas's
     *  own target listeners, never disturbing ancestors' bubble-phase listeners.
     *  Our own pointercancel handler no-ops here (pointerIdRef is still null). */
    const claimPointerExclusively = (pointerId: number): void => {
      const cancel = new MouseEvent('pointercancel', { bubbles: false, cancelable: true })
      Object.defineProperty(cancel, 'pointerId', { value: pointerId })
      Object.defineProperty(cancel, 'pointerType', { value: 'mouse' })
      domElement.dispatchEvent(cancel)
    }

    const beginDrag = (): void => {
      draggingRef.current = true
      hovering = false
      domElement.style.cursor = 'grabbing'
      onDraggingChangeRef.current?.(true)
    }
    const advanceDrag = (delta: number): void => {
      onChangeRef.current?.(delta)
      requestRenderRef.current?.()
    }
    /** WO UI-79 F-A: the RELEASE path -- reached from pointerup. Stops the drag
     *  and emits dragging-false (so the parent restores orbit), but DOES NOT
     *  commit and DOES NOT restore geometry: the tool stays ARMED with the live
     *  value shown, exactly like the SKC-44 fillet drag. The sole commit is the
     *  caller's own Apply path. Idempotent via the dragging guard, so a
     *  pointerup followed by the browser's lostpointercapture cannot double-
     *  emit dragging-false. (Capture is released by the pointerup handler that
     *  calls this, after this returns.) */
    const releaseDrag = (): void => {
      if (!draggingRef.current) return
      draggingRef.current = false
      pointerIdRef.current = null
      grabOffsetRef.current = 0
      restoreCursor()
      onDraggingChangeRef.current?.(false)
    }
    /** WO UI-57 audit F1 / UI-79 F-A: the INVOLUNTARY release path. Reached from
     *  pointercancel, lostpointercapture, and effect cleanup (the Escape-driven
     *  unmount the parent performs mid-drag). Releases capture, clears every
     *  drag ref, restores the cursor, and emits dragging-false -- which is what
     *  un-sticks the parent's orbit. Like releaseDrag it NEVER commits and never
     *  restores geometry; whether a cancelled gesture keeps or discards the
     *  preview is the parent's own cancel decision. Idempotent. */
    const abortDrag = (): void => {
      if (!draggingRef.current) return
      draggingRef.current = false
      const pointerId = pointerIdRef.current
      pointerIdRef.current = null
      grabOffsetRef.current = 0
      if (pointerId !== null) {
        try { domElement.releasePointerCapture(pointerId) } catch { /* jsdom / unsupported / already released */ }
      }
      restoreCursor()
      onDraggingChangeRef.current?.(false)
    }

    const handlePointerDown = (event: PointerEvent): void => {
      if (!enabledRef.current || !group.visible || event.button !== 0) return
      applyScreenScale() // hit-test the handle at the size the user actually sees
      if (!hitsPicker(event)) return
      event.preventDefault()
      event.stopPropagation()
      // WO UI-79 F-C: un-latch any camera control that already grabbed this
      // pointer, BEFORE we take our own capture (see claimPointerExclusively).
      claimPointerExclusively(event.pointerId)
      try { domElement.setPointerCapture(event.pointerId) } catch { /* jsdom / unsupported */ }
      pointerIdRef.current = event.pointerId
      const t = axisParamFromEvent(event)
      // WO UI-79 F-A: seed the grab so the reported delta STARTS at the current
      // armed value (grabOffset = cursorParam - value) -- a re-grab continues
      // from the live offset instead of snapping it back to zero.
      grabOffsetRef.current = (t ?? 0) - valueRef.current
      beginDrag()
    }
    const handlePointerMove = (event: PointerEvent): void => {
      if (!draggingRef.current) {
        // Hover pass (Q-1, COHESION-STANDARD.md section 3: hover = feedback,
        // always). Orbiting the camera also fires pointermove on this same
        // element, which is what keeps the screen-space scale current between
        // drags without this component owning a render loop.
        if (!enabledRef.current || !group.visible) {
          if (hovering) restoreCursor()
          return
        }
        const scaleChanged = applyScreenScale()
        const over = hitsPicker(event)
        if (over && !hovering) {
          hovering = true
          domElement.style.cursor = 'grab'
        } else if (!over && hovering) {
          restoreCursor()
        }
        if (scaleChanged) requestRenderRef.current?.()
        return
      }
      if (pointerIdRef.current !== event.pointerId) return
      event.preventDefault()
      event.stopPropagation()
      applyScreenScale()
      const t = axisParamFromEvent(event)
      if (t === null) return // degenerate ray-parallel-to-axis frame: hold the last delta
      advanceDrag(t - grabOffsetRef.current)
    }
    const handlePointerUp = (event: PointerEvent): void => {
      if (pointerIdRef.current !== event.pointerId) return
      event.preventDefault()
      event.stopPropagation()
      const pointerId = event.pointerId
      // releaseDrag FIRST, release capture SECOND: releasePointerCapture is
      // specified to fire lostpointercapture, whose handler aborts -- clearing
      // the dragging flag before releasing is what makes that abort a no-op
      // instead of a spurious second dragging-false after the release.
      releaseDrag()
      try { domElement.releasePointerCapture(pointerId) } catch { /* jsdom / unsupported */ }
    }
    const handlePointerCancel = (event: PointerEvent): void => {
      if (pointerIdRef.current !== event.pointerId) return
      abortDrag()
    }
    /** The OS/browser can revoke capture without ever sending pointerup or
     *  pointercancel (window focus loss, a touch turning into a system
     *  gesture). Without this the component would sit dragging=true forever
     *  and the parent's orbit would stay disabled -- the audit's stuck state. */
    const handleLostPointerCapture = (event: PointerEvent): void => {
      if (pointerIdRef.current !== event.pointerId) return
      abortDrag()
    }

    let testDriver: PushPullGizmoTestDriver | null = null
    if (createTestDriver) {
      testDriver = createTestDriver()
      testDriver.simulateDragStart = () => beginDrag()
      testDriver.simulateDrag = (delta: number) => advanceDrag(delta)
      testDriver.simulateDragEnd = () => releaseDrag()
      testDriver.simulateDragCancel = () => abortDrag()
      testDriver.simulateLostPointerCapture = () => abortDrag()
    } else {
      domElement.addEventListener('pointerdown', handlePointerDown)
      domElement.addEventListener('pointermove', handlePointerMove)
      domElement.addEventListener('pointerup', handlePointerUp)
      domElement.addEventListener('pointercancel', handlePointerCancel)
      domElement.addEventListener('lostpointercapture', handleLostPointerCapture)
    }

    return () => {
      // WO UI-57 audit F1: abort BEFORE tearing anything down. An unmount
      // mid-drag (the parent drops this component on Escape) must still emit
      // dragging-false, or the parent's orbit stays disabled forever with no
      // gizmo left on screen to release it.
      abortDrag()
      domElement.style.cursor = originalCursor
      applyScreenScaleRef.current = null
      if (!createTestDriver) {
        domElement.removeEventListener('pointerdown', handlePointerDown)
        domElement.removeEventListener('pointermove', handlePointerMove)
        domElement.removeEventListener('pointerup', handlePointerUp)
        domElement.removeEventListener('pointercancel', handlePointerCancel)
        domElement.removeEventListener('lostpointercapture', handleLostPointerCapture)
      }
      scene.remove(group)
      for (const child of group.children) {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose()
          if (!Array.isArray(child.material)) child.material.dispose()
        }
      }
      groupRef.current = null
      pickerRef.current = null
    }
    // Mount-once effect: scene/camera/domElement/createTestDriver are stable
    // for the lifetime of a mounted viewport (same contract the old
    // TransformControls-backed version's bootstrap effect documented).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, camera, domElement, createTestDriver])

  useEffect(() => {
    const group = groupRef.current
    if (!group) return
    if (face) {
      originRef.current.copy(toVector3(face.origin))
      normalRef.current.copy(toVector3(face.normal)).normalize()
      group.position.copy(originRef.current)
      group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normalRef.current)
      // Screen-space size, re-derived for THIS origin/camera pair (audit F2).
      // Visual only -- originRef/normalRef, which the drag math reads, are the
      // unscaled world frame set immediately above.
      applyScreenScaleRef.current?.()
      // Raycasting (pointerdown hit-test + the per-move axis projection) reads
      // matrixWorld directly; nothing else in this on-demand-render app drives
      // a scene-wide updateMatrixWorld() between this prop change and the
      // user's very next pointer event, so without this the picker mesh would
      // raycast against a STALE (construction-time identity) transform.
      group.updateMatrixWorld(true)
      group.visible = true
    } else {
      group.visible = false
    }
    requestRenderRef.current?.()
  }, [face])

  return null
}
