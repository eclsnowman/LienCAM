// 3D Lab tests: a plain object satisfying SceneRuntime that never touches
// THREE/WebGL APIs -- the second fake-injection point required for the
// render smoke test (jsdom has no WebGL context; Lab3DView never constructs
// THREE.WebGLRenderer itself, only whatever createSceneRuntime hands it, so
// this fake keeps the whole render path jsdom-safe). Records addObject/
// removeObject/requestRender calls and returns a fixed ray from
// screenToRay so pick-path tests are deterministic.

import * as THREE from 'three'
import {
  applyOrientNormalToPoint,
  buildPlaneGrid,
  presetCameraPosition,
  type CreateSceneRuntime,
  type DebugCameraState,
  type SceneRuntime,
  type Vec3Like,
  type WorkbenchViewName,
} from '../../components/model3d/sceneRuntime'
import type { RayLike } from '../../viewport3d'
import type { PlaneFrame } from '../../sketch3d/planeMath'
import type { NavPresetId } from '../../types'

export interface FakeSceneRuntime extends SceneRuntime {
  addedObjects: THREE.Object3D[]
  removedObjects: THREE.Object3D[]
  /** WO UI-72: the live set of roots declared via registerDepthExtent (minus
   *  those unregistered) -- the seam the sketch-overlay depth-extent test reads,
   *  since jsdom has no frustum to observe a clip against. */
  depthExtentRoots: Set<THREE.Object3D>
  requestRenderCallCount: number
  disposeCallCount: number
  /** Every clip-plane array setClipPlanes() was called with, in call order
   *  (WO INT-1 section-control test seam -- jsdom has no WebGL clipping to
   *  assert against, so tests assert on this call log instead). */
  clipPlaneCalls: THREE.Plane[][]
  /** Every {min,max} frameBox() was called with, in call order. */
  frameBoxCalls: Array<{ min: Vec3Like; max: Vec3Like }>
  /** WO UI-3 BK-25: every (mesh, edgeLines) pair registerSectionable() was
   *  called with, in call order -- the UI-H1 audit flagged that no test
   *  asserted this lifecycle call actually fires on body add. */
  registerSectionableCalls: Array<{ mesh: THREE.Mesh; edgeLines: THREE.LineSegments }>
  setSectionableVisibleCalls: Array<{ mesh: THREE.Mesh; visible: boolean }>
  /** WO UI-3 BK-25: every (mesh, edgeLines) pair unregisterSectionable() was
   *  called with, in call order (body dispose). */
  unregisterSectionableCalls: Array<{ mesh: THREE.Mesh; edgeLines: THREE.LineSegments }>
  /** Override to make projectToCanvas deterministic per test (default: null,
   *  i.e. "nothing projects" -- most tests don't need this and should keep
   *  using the fixed screenToRay ray instead). */
  projectToCanvasResult: { x: number; y: number } | null
  /** Override for screenToRay() (default: null, i.e. use FIXED_RAY). FIXED_RAY
   *  is aimed at the demo box's top face CENTER -- fine for body/face picks
   *  (any hit on the body/face resolves), but edge/vertex picks are
   *  threshold-proximity tests (PickEngine.ts) that a face-center ray is far
   *  too distant from any edge/vertex to trigger. WO INT-1-R1.1's edge/vertex
   *  hover/select tests set this to a ray aimed at a known edge midpoint or
   *  corner instead. */
  rayOverride: RayLike | null
  /** WO SKC-5: every (frame, sizeHint) orientNormalToPlane() was called with,
   *  in call order -- jsdom has no real camera-orientation effect to assert
   *  against, so tests assert on this call log (mirrors clipPlaneCalls'
   *  own pattern). */
  orientNormalToPlaneCalls: Array<{ frame: PlaneFrame; sizeHint?: number }>
  /** Every pose setCameraPose() was called with, in call order -- WO SKC-5
   *  (Q6) tests assert on this to prove "restore unless the user moved it"
   *  (a call here means the page decided to restore; none means it decided
   *  the user's own camera move should stand). */
  setCameraPoseCalls: Array<{ position: Vec3Like; target: Vec3Like }>
  /** Test-only override: forces hasUserOrbited() to return true, simulating
   *  a real user orbit/pan/zoom gesture (the real runtime derives this from
   *  OrbitControls' 'start' event, unavailable in jsdom). */
  simulateUserOrbit(): void
  /** WO SKC-5-R1 (Finding 1): every (presetId, invertZoom, invertPan)
   *  applyNavPreset() was called with, in call order -- the nav-preset
   *  no-regress test asserts on this call log (jsdom has no real
   *  OrbitControls.mouseButtons effect to read back against). */
  navPresetCalls: Array<{ presetId: NavPresetId; invertZoom: boolean; invertPan: boolean }>
  /** WO UI-5: every value setOrbitEnabled() was called with, in call order --
   *  jsdom has no real OrbitControls.enabled effect to read back against, so
   *  tests assert on this call log (mirrors navPresetCalls' own pattern). */
  setOrbitEnabledCalls: boolean[]
  /** WO SKC-11: every setDragOrbitSuppressed() call, in order -- lets a test assert BOTH that
   *  suppression was requested during a drag and that it was explicitly lifted again (a bare
   *  "ended up false" read can't distinguish "restored" from "never suppressed"). */
  dragOrbitSuppressedCalls: boolean[]
  /** WO SKC-11: current suppressed state (last setDragOrbitSuppressed() call's value, false
   *  initially) -- the live read a test drives mid-drag/post-abort assertions off of. */
  readonly dragOrbitSuppressed: boolean
  /** WO SKC-15B: the live `enableRotate` flag `sketchOrbitHandle()` hands the mounted sketcher.
   *  Readable directly so a test can assert what the package wrote THROUGH the handle (the real
   *  runtime's flag lives on an OrbitControls that jsdom cannot construct). */
  sketchOrbitEnableRotate: boolean
  /** WO UI-17 (criterion 6): every preset setCameraView() was called with, in
   *  call order -- the page-level ViewCube-bridge test asserts on this; the
   *  fake ALSO moves its camera per presetCameraPosition so a pose read after
   *  a call reflects the documented pose. */
  setCameraViewCalls: WorkbenchViewName[]
  /** WO UI-17 (criterion 8): every setSketchGrid() call's frame (null = grid
   *  removed), in call order. The live group is readable via getSketchGrid(). */
  sketchGridCalls: Array<{ frame: PlaneFrame | null; spacingMm?: number; sizeMm?: number }>
  /** WO UI-17 (Q-15): every setSketchRightDragOrbit() call, in order. */
  sketchRightDragOrbitCalls: boolean[]
  /** WO UI-17 (acceptance 2): true while the fake's frame drive is running --
   *  lets a test assert the loop really STOPPED (not merely that the count
   *  plateaued inside one poll window). */
  readonly frameDriveRunning: boolean
  /** WO UI-23 (C3): every (point, normal, sizeHint) orientNormalToPoint() was
   *  called with, in call order -- same jsdom-has-no-real-camera-effect
   *  rationale as orientNormalToPlaneCalls above. */
  orientNormalToPointCalls: Array<{ point: Vec3Like; normal: Vec3Like; sizeHint?: number }>
  /** WO UI-23 (C4): every setCameraProjection() call, in order. */
  setCameraProjectionCalls: Array<'perspective' | 'orthographic'>
  /** WO UI-58-R1 (minor finding): every world point projectToCanvas() was
   *  called with, in call order -- projectToCanvasResult (above) only
   *  controls the RETURNED pixel, so a test proving WHICH world point an
   *  anchor (e.g. AnchoredValueEntry's own rAF loop) is tracking needs this
   *  call log instead, same "record the call, assert the log" pattern every
   *  other *Calls field on this fake already uses. */
  projectToCanvasCalls: Vec3Like[]
}

const FIXED_RAY: RayLike = { origin: { x: 0, y: 0, z: 100 }, direction: { x: 0, y: 0, z: -1 } }

export function createFakeSceneRuntime(): FakeSceneRuntime {
  const addedObjects: THREE.Object3D[] = []
  const removedObjects: THREE.Object3D[] = []
  const depthExtentRoots = new Set<THREE.Object3D>()
  const clipPlaneCalls: THREE.Plane[][] = []
  const frameBoxCalls: Array<{ min: Vec3Like; max: Vec3Like }> = []
  const registerSectionableCalls: Array<{ mesh: THREE.Mesh; edgeLines: THREE.LineSegments }> = []
  const setSectionableVisibleCalls: Array<{ mesh: THREE.Mesh; visible: boolean }> = []
  const unregisterSectionableCalls: Array<{ mesh: THREE.Mesh; edgeLines: THREE.LineSegments }> = []
  const orientNormalToPlaneCalls: Array<{ frame: PlaneFrame; sizeHint?: number }> = []
  const orientNormalToPointCalls: Array<{ point: Vec3Like; normal: Vec3Like; sizeHint?: number }> = []
  const setCameraProjectionCalls: Array<'perspective' | 'orthographic'> = []
  const projectToCanvasCalls: Vec3Like[] = []
  let projectionMode: 'perspective' | 'orthographic' = 'perspective'
  const setCameraPoseCalls: Array<{ position: Vec3Like; target: Vec3Like }> = []
  const navPresetCalls: Array<{ presetId: NavPresetId; invertZoom: boolean; invertPan: boolean }> = []
  const setOrbitEnabledCalls: boolean[] = []
  const dragOrbitSuppressedCalls: boolean[] = []
  const setCameraViewCalls: WorkbenchViewName[] = []
  const sketchGridCalls: Array<{ frame: PlaneFrame | null; spacingMm?: number; sizeMm?: number }> = []
  const sketchRightDragOrbitCalls: boolean[] = []
  let requestRenderCallCount = 0
  let disposeCallCount = 0
  // WO UI-17 (criterion 4/acceptance 2): the fake runs a REAL rAF loop (jsdom
  // provides requestAnimationFrame) incrementing a frame counter and invoking
  // the page's onFrame bridge -- no rendering, but the LIFECYCLE (started at
  // session begin, stopped at session end) is the thing under test.
  let renderedFrames = 0
  let frameDriveId: number | null = null
  // WO INT-13B: same two-variable split the real runtime uses -- the rAF HANDLE
  // (paused by suspend) is distinct from the session's CALLBACK (cleared only by
  // a real session end), which is what lets resume tell "was driving, is quiet"
  // apart from "no session".
  let frameDriveOnFrame: (() => void) | null = null
  let renderSuspended = false
  const pauseFrameDrive = (): void => {
    if (frameDriveId !== null) {
      cancelAnimationFrame(frameDriveId)
      frameDriveId = null
    }
  }
  const runFrameDrive = (): void => {
    if (frameDriveId !== null || frameDriveOnFrame === null || renderSuspended) return
    const animate = (): void => {
      frameDriveId = requestAnimationFrame(animate)
      frameDriveOnFrame?.()
      renderedFrames += 1
    }
    animate()
  }
  let sketchGrid: THREE.Group | null = null
  let cameraPose: { position: Vec3Like; target: Vec3Like } = { position: { x: 85, y: -85, z: 65 }, target: { x: 0, y: 0, z: 0 } }
  let debugCameraState: DebugCameraState = {
    ...cameraPose,
    up: { x: 0, y: 0, z: 1 },
    fov: 45,
    projection: 'perspective',
  }
  let userOrbited = false
  let dragOrbitSuppressed = false

  // scene/camera are never dereferenced by Lab3DView itself (only handed to
  // addObject/removeObject, which this fake ignores structurally). WO
  // UI-3-R1: ChassisDemo hands runtime.scene straight to TranslateGizmo,
  // which (with the real default TransformControls adapter) calls
  // scene.add()/remove() on it directly -- a real THREE.Scene/Camera here
  // (cheap, no WebGL/GPU involved) keeps that path jsdom-safe without
  // needing yet another injection seam through ChassisDemo.
  const runtime: FakeSceneRuntime = {
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(),
    addedObjects,
    removedObjects,
    depthExtentRoots,
    clipPlaneCalls,
    frameBoxCalls,
    orientNormalToPlaneCalls,
    orientNormalToPointCalls,
    setCameraProjectionCalls,
    setCameraPoseCalls,
    navPresetCalls,
    setOrbitEnabledCalls,
    dragOrbitSuppressedCalls,
    sketchOrbitEnableRotate: true, // OrbitControls' own default
    get dragOrbitSuppressed() {
      return dragOrbitSuppressed
    },
    simulateUserOrbit: () => {
      userOrbited = true
    },
    registerSectionableCalls,
    setSectionableVisibleCalls,
    unregisterSectionableCalls,
    projectToCanvasResult: null,
    projectToCanvasCalls,
    rayOverride: null,
    get requestRenderCallCount() {
      return requestRenderCallCount
    },
    get disposeCallCount() {
      return disposeCallCount
    },
    addObject: (obj) => {
      addedObjects.push(obj)
      // WO UI-23 (C3): also add to the REAL THREE.Scene this fake already
      // constructs (see the class comment above -- "a real THREE.Scene/
      // Camera here ... keeps that path jsdom-safe") so a real
      // THREE.Raycaster against `runtime.scene` (the N-to-face pick's
      // plane-glyph path) can actually hit what the page added, exactly
      // like the real runtime's addObject. Additive: every existing
      // assertion against `addedObjects`/`removedObjects` is unchanged.
      runtime.scene.add(obj)
    },
    removeObject: (obj) => {
      removedObjects.push(obj)
      runtime.scene.remove(obj)
    },
    requestRender: () => {
      // WO INT-13B: the fake models the real runtime's ONE render gate. In
      // createDefaultSceneRuntime every render path funnels through a `render`
      // closure that returns early while suspended, so a suspended workspace
      // repaints zero times. A fake that kept counting here would make B2b/B4
      // vacuous -- they would pass against a suspend that does nothing.
      //
      // `renderedFrames` is deliberately NOT touched here. It stays what UI-17
      // AC2 made it -- a count of FRAME-DRIVE frames -- because AC2 asserts the
      // drive does not free-run, and folding on-demand renders into the same
      // counter would silently change what that older gate measures (charter:
      // a rewrite must not weaken prior rounds' coverage). B4 reads
      // requestRenderCallCount for the on-demand half and frameCount() for the
      // drive half; both must sit still across a suspended interval.
      if (renderSuspended) return
      requestRenderCallCount++
    },
    screenToRay: () => runtime.rayOverride ?? FIXED_RAY,
    projectToCanvas: (point) => {
      runtime.projectToCanvasCalls.push(point)
      return runtime.projectToCanvasResult
    },
    setClipPlanes: (planes) => {
      clipPlaneCalls.push(planes)
    },
    // WO UI-H1 stencil-cap plumbing has no jsdom-visible effect (no real
    // WebGL), so most of this stays a pure no-op -- EXCEPT register/
    // unregisterSectionable, which WO UI-3's BK-25 rider records so a test
    // can assert the lifecycle call actually fires on body add/dispose (the
    // UI-H1 audit flagged this as an untested surface).
    registerSectionable: (mesh, edgeLines) => {
      registerSectionableCalls.push({ mesh, edgeLines })
    },
    syncSectionGeometry: () => {},
    setSectionableVisible: (mesh, visible) => {
      setSectionableVisibleCalls.push({ mesh, visible })
    },
    unregisterSectionable: (mesh, edgeLines) => {
      unregisterSectionableCalls.push({ mesh, edgeLines })
    },
    frameBox: (min, max) => {
      frameBoxCalls.push({ min, max })
    },
    getCameraPose: () => ({ position: cameraPose.position, target: cameraPose.target }),
    getDebugCameraState: () => debugCameraState,
    setDebugCameraState: (state) => {
      debugCameraState = state
      cameraPose = { position: state.position, target: state.target }
      projectionMode = state.projection
    },
    setCameraPose: (pose) => {
      cameraPose = { position: pose.position, target: pose.target }
      debugCameraState = { ...debugCameraState, ...cameraPose }
      setCameraPoseCalls.push(cameraPose)
    },
    orientNormalToPlane: (frame, sizeHint) => {
      orientNormalToPlaneCalls.push(sizeHint === undefined ? { frame } : { frame, sizeHint })
    },
    orientNormalToPoint: (point, normal, sizeHint) => {
      orientNormalToPointCalls.push(sizeHint === undefined ? { point, normal } : { point, normal, sizeHint })
      // WO UI-23-R1 (audit finding 3, "non-production tests"): also run the
      // REAL production camera math (applyOrientNormalToPoint -- the exact
      // function createDefaultSceneRuntime.orientNormalToPoint calls) against
      // this fake's own real THREE.Camera, so a test can assert the FINAL
      // camera pose (dot(viewDir,normal) ~ -1, target on the pick point)
      // instead of only the recorded call arguments above.
      const fakeControls = {
        target: new THREE.Vector3(cameraPose.target.x, cameraPose.target.y, cameraPose.target.z),
        update: () => {},
      }
      applyOrientNormalToPoint(runtime.camera, fakeControls, point, normal, sizeHint)
      cameraPose = {
        position: { x: runtime.camera.position.x, y: runtime.camera.position.y, z: runtime.camera.position.z },
        target: { x: fakeControls.target.x, y: fakeControls.target.y, z: fakeControls.target.z },
      }
    },
    hasUserOrbited: () => userOrbited,
    resetUserOrbited: () => {
      userOrbited = false
    },
    applyNavPreset: (presetId, invertZoom, invertPan) => {
      navPresetCalls.push({ presetId, invertZoom, invertPan })
    },
    setOrbitEnabled: (enabled) => {
      setOrbitEnabledCalls.push(enabled)
    },
    setDragOrbitSuppressed: (suppressed) => {
      dragOrbitSuppressedCalls.push(suppressed)
      dragOrbitSuppressed = suppressed
    },
    // The same live-view shape the real runtime returns, over the fake's own flag field.
    sketchOrbitHandle: () => ({
      get enableRotate() {
        return runtime.sketchOrbitEnableRotate
      },
      set enableRotate(v: boolean) {
        runtime.sketchOrbitEnableRotate = v
      },
    }),
    setCameraViewCalls,
    sketchGridCalls,
    sketchRightDragOrbitCalls,
    get frameDriveRunning() {
      return frameDriveId !== null
    },
    startSketchFrameDrive: (onFrame) => {
      if (frameDriveOnFrame !== null) return
      frameDriveOnFrame = onFrame
      runFrameDrive()
    },
    stopSketchFrameDrive: () => {
      pauseFrameDrive()
      frameDriveOnFrame = null
    },
    // WO INT-13B (spec 3.2 step 5): mirrors createDefaultSceneRuntime's real
    // suspend/resume -- pause the drive but REMEMBER the callback, so a
    // workspace suspended mid-sketch comes back driving (D3.2 keeps the session
    // open), while a real session end still forgets it.
    suspendRender: () => {
      if (renderSuspended) return
      pauseFrameDrive()
      renderSuspended = true
    },
    resumeRender: () => {
      if (!renderSuspended) return
      renderSuspended = false
      runFrameDrive()
      // The real runtime issues one catch-up render here; on the fake that lands
      // as a requestRender-shaped repaint, NOT a drive frame -- see the note in
      // requestRender above for why renderedFrames must keep meaning "drive
      // frames" for UI-17 AC2.
      requestRenderCallCount++
    },
    isRenderSuspended: () => renderSuspended,
    frameCount: () => renderedFrames,
    setCameraView: (view) => {
      setCameraViewCalls.push(view)
      // Move the fake's own camera to the documented pose (target = origin,
      // current distance) so a pose read after the call is meaningful.
      const cam = runtime.camera as THREE.PerspectiveCamera
      const dist = cam.position.length() || 100
      const pos = presetCameraPosition(view, { x: 0, y: 0, z: 0 }, dist)
      cam.position.set(pos.x, pos.y, pos.z)
      cam.up.set(0, 0, 1)
      cam.lookAt(0, 0, 0)
    },
    setSketchGrid: (frame, spacingMm, sizeMm) => {
      sketchGridCalls.push({ frame, spacingMm, sizeMm })
      sketchGrid = frame === null ? null : buildPlaneGrid(frame, spacingMm ?? 10, sizeMm ?? 200)
    },
    getSketchGrid: () => sketchGrid,
    registerDepthExtent: (obj) => { depthExtentRoots.add(obj) },
    unregisterDepthExtent: (obj) => { depthExtentRoots.delete(obj) },
    // The fake has no depth policy (jsdom never renders), so the probe reports
    // the fake camera's own planes and no roots. Tests that care about depth
    // extent assert on `depthExtentRoots` above; the real numbers are the
    // real-browser gate's job (tools/capture/ui72-grid-clip-gate.mjs).
    getDepthClipProbe: () => ({
      near: (runtime.camera as THREE.PerspectiveCamera).near,
      far: (runtime.camera as THREE.PerspectiveCamera).far,
      cameraPosition: {
        x: runtime.camera.position.x,
        y: runtime.camera.position.y,
        z: runtime.camera.position.z,
      },
      roots: [],
    }),
    setSketchRightDragOrbit: (active) => {
      sketchRightDragOrbitCalls.push(active)
    },
    getCameraProjection: () => projectionMode,
    setCameraProjection: (mode) => {
      setCameraProjectionCalls.push(mode)
      if (mode !== projectionMode) {
        const common = {
          position: debugCameraState.position,
          target: debugCameraState.target,
          up: debugCameraState.up,
        }
        debugCameraState = mode === 'perspective'
          ? { ...common, projection: 'perspective', fov: 45 }
          : { ...common, projection: 'orthographic', left: -50, right: 50, top: 50, bottom: -50, zoom: 1, near: 0.1, far: 2000 }
      }
      projectionMode = mode
    },
    dispose: () => {
      if (frameDriveId !== null) {
        cancelAnimationFrame(frameDriveId)
        frameDriveId = null
      }
      disposeCallCount++
    },
  }
  return runtime
}

export const fakeCreateSceneRuntime: CreateSceneRuntime = () => createFakeSceneRuntime()
