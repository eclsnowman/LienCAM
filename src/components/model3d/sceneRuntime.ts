// 3D Lab: injectable Three.js scene/camera/renderer runtime (WO UI-2).
//
// Lab3DView never constructs THREE.WebGLRenderer directly -- it only calls a
// CreateSceneRuntime it was handed (defaulting to createDefaultSceneRuntime
// below). This is the render smoke test's fake-injection point: jsdom has no
// WebGL context, so `new THREE.WebGLRenderer()` throws there; if Lab3DView
// constructed one itself inside a mount effect, that throw would fail the
// render smoke test even though it happens strictly after the initial React
// render. Tests instead pass a createSceneRuntime stub that returns a plain
// object satisfying SceneRuntime -- no THREE/WebGL API is touched, so jsdom
// never sees the problematic construction. Mirrors src/cam3d/dev/devPage.ts's
// `startViewer` conventions (Z-up camera, OrbitControls, render-on-demand via
// controls' 'change' listener, no rAF loop, resize handling cleaned up in
// dispose()).

import * as THREE from 'three'
import { observeRendererDpr, rendererDpr } from '../../lib/ui/zoomDpr'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
// GEO-25: fat-line (LineSegments2/LineMaterial) body-edge overlays for
// non-classic themes size their stroke in SCREEN PIXELS via a `resolution`
// uniform (mirrors CNCViewport.ts's own handleResize comment for its
// fat-line stock edges) -- only needed here to keep that resolution current
// after a window/zoom resize.
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import type { RayLike } from '../../viewport3d'
import {
  syncInteractionClipping,
  syncInteractionResolution,
} from '../../viewport3d/interactionPresentation'
import { isDepthExtentExempt } from '../../viewport3d/depthExtent'
import { planeYDir } from '../../sketch3d/planeMath'
import type { PlaneFrame } from '../../sketch3d/planeMath'
import { createNavPresetController, type NavPresetController } from '../../lib/viewport/navPresetController'
import type { NavPresetId } from '../../types'
// WO INT-13B (D1.2): the shared design-token bridge CNCViewport already resolves
// its clear colour through -- so the two hosts' backgrounds cannot drift apart.
import { asNumber } from '../../theme/viewportColors'
// Shared fixed studio lighting: the same PMREM intensity, exposure, and
// world-space light rig used by CAM.
import { installViewportEnvironment, type ViewportEnvironment } from '../../lib/viewport/lighting/buildEnvironment'
import { buildModeledBodyStudioRig } from '../../lib/viewport/lighting/workbenchRig'
import {
  MODELED_BODY_STUDIO_ENV_INTENSITY,
  MODELED_BODY_STUDIO_EXPOSURE,
} from '../../lib/viewport/lighting/rigDescriptors'
import { createSectionCapController } from '../../lib/viewport/sectionCaps'
// GEO-23 L4 (audit cure C2): per-vertex ambient occlusion so bored holes read as
// recesses (darker-with-depth) from every orbit direction in the Model workspace.
import { applyBodyAO } from '../../lib/viewport/lighting/vertexAO'

export { applySectionCapPairVisibility } from '../../lib/viewport/sectionCaps'

/** WO UI-17 (criterion 6): the ViewCube's seven preset views. Same union
 *  CNCViewport.setCameraView accepts -- the cube component dispatches these
 *  names verbatim through its window bridge. */
export type WorkbenchViewName = 'top' | 'front' | 'right' | 'iso' | 'back' | 'left' | 'bottom'

/** WO UI-23 (C4): the two camera projections the display-mode flyout toggles
 *  between. */
export type CameraProjectionMode = 'perspective' | 'orthographic'

/** Camera state carried by the debug-scene repro channel. Kept in the
 * runtime module so capture and restore share one discriminated contract
 * without sceneRuntime importing the higher-level debugScene format. */
export interface DebugCameraStateBase {
  position: Vec3Like
  target: Vec3Like
  up: Vec3Like
}

export interface PerspectiveDebugCameraState extends DebugCameraStateBase {
  projection: 'perspective'
  fov: number
}

export interface OrthographicDebugCameraState extends DebugCameraStateBase {
  projection: 'orthographic'
  left: number
  right: number
  top: number
  bottom: number
  zoom: number
  near: number
  far: number
}

export type DebugCameraState = PerspectiveDebugCameraState | OrthographicDebugCameraState

/** Extract the exact projection-specific debug payload from a live THREE
 * camera. Kept pure so the production export branch is directly testable
 * without constructing WebGLRenderer or OrbitControls. */
export function captureDebugCameraState(camera: THREE.Camera, target: Vec3Like): DebugCameraState {
  const common = {
    position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
    target: { x: target.x, y: target.y, z: target.z },
    up: { x: camera.up.x, y: camera.up.y, z: camera.up.z },
  }
  const persp = camera as THREE.PerspectiveCamera
  if (persp.isPerspectiveCamera === true) {
    return { ...common, fov: persp.fov, projection: 'perspective' }
  }
  const ortho = camera as THREE.OrthographicCamera
  if (ortho.isOrthographicCamera !== true) throw new Error('debug export: unsupported camera projection subtype')
  return {
    ...common,
    projection: 'orthographic',
    left: ortho.left,
    right: ortho.right,
    top: ortho.top,
    bottom: ortho.bottom,
    zoom: ortho.zoom,
    near: ortho.near,
    far: ortho.far,
  }
}

interface DebugCameraControls {
  target: THREE.Vector3
}

const INVALID_AUTHORED_DEPTH_SLAB = 'camera-depth-refused-invalid-authored-slab'

function validCameraDepthPlanes(near: number, far: number, allowZeroNear = false): boolean {
  return Number.isFinite(near)
    && Number.isFinite(far)
    && (allowZeroNear ? near >= 0 : near > 0)
    && near < far
}

/** Apply an imported debug-camera payload to a real THREE camera, then hand
 * control replacement to the caller only after the authored up vector and
 * projection fields are final. OrbitControls caches camera.up at construction,
 * so keeping the old controls after this mutation makes the first orbit use the
 * wrong axis. The callback is the production seam shared with projection swaps. */
export function restoreDebugCameraState<TControls extends DebugCameraControls>(
  camera: THREE.Camera,
  controls: TControls,
  state: DebugCameraState,
  rebindControls: (controls: TControls, target: THREE.Vector3) => TControls,
): TControls {
  if (state.projection === 'orthographic' && !validCameraDepthPlanes(state.near, state.far, true)) {
    throw new Error(INVALID_AUTHORED_DEPTH_SLAB)
  }
  if (state.projection === 'perspective') {
    const persp = camera as THREE.PerspectiveCamera
    if (persp.isPerspectiveCamera !== true) throw new Error('debug scene restore: expected a perspective camera')
    persp.fov = state.fov
    persp.updateProjectionMatrix()
  } else {
    const ortho = camera as THREE.OrthographicCamera
    if (ortho.isOrthographicCamera !== true) throw new Error('debug scene restore: expected an orthographic camera')
    ortho.left = state.left
    ortho.right = state.right
    ortho.top = state.top
    ortho.bottom = state.bottom
    ortho.zoom = state.zoom
    ortho.near = state.near
    ortho.far = state.far
    ortho.updateProjectionMatrix()
  }

  camera.position.set(state.position.x, state.position.y, state.position.z)
  camera.up.set(state.up.x, state.up.y, state.up.z)
  const target = new THREE.Vector3(state.target.x, state.target.y, state.target.z)
  camera.lookAt(target)
  return rebindControls(controls, target)
}

/** WO UI-23 (C4): viewing distance for a perspective camera that frames a
 *  `radius`-sized region (pulled out of frameBox/orientNormalToPlane's own
 *  inline math so both this and the new orthographic path share ONE
 *  definition). An orthographic camera's apparent size is controlled by its
 *  frustum/zoom, not distance -- any distance that clears near/far and keeps
 *  dolly's `_clampDistance` sane works, so this just multiplies the radius by
 *  a safe margin for that branch. */
export function distanceForRadius(camera: THREE.Camera, radius: number): number {
  const persp = camera as THREE.PerspectiveCamera
  if (persp.isPerspectiveCamera === true) {
    const fovRad = (persp.fov * Math.PI) / 180
    return (radius / Math.sin(fovRad / 2)) * 1.4
  }
  return radius * 3
}

/** WO-1454: the half-height formula buildProjectionSwapCamera uses to build an
 *  orthographic frustum at a given viewing distance, pulled out so frameBox's
 *  orthographic branch reuses the exact same math instead of re-deriving it.
 *  Defaults to 45deg -- the same assumed fov buildProjectionSwapCamera's own
 *  orthographic->perspective reverse branch uses when no original fov is
 *  known (an orthographic camera has none). */
export function orthographicHalfHeightForDistance(distance: number, fovDeg = 45): number {
  const fovRad = (fovDeg * Math.PI) / 180
  return Math.max(distance * Math.tan(fovRad / 2), 1e-3)
}

/** WO UI-23 (C3): a deterministic camera "up" for an arbitrary pick normal --
 *  unlike a PlaneFrame (which carries an authored xDir/localY), a raw
 *  face/body pick has no natural in-plane basis. Project world Z onto the
 *  plane perpendicular to `normal`; fall back to world Y when `normal` is
 *  itself too close to Z (mirrors frameBox's own "avoid a degenerate
 *  direction" fallback). Pure and deterministic so repeat-picking the same
 *  normal always lands the same up/roll. */
export function stableUpForNormal(normal: THREE.Vector3): THREE.Vector3 {
  const n = normal.clone().normalize()
  const worldZ = new THREE.Vector3(0, 0, 1)
  const ref = Math.abs(n.dot(worldZ)) > 0.999 ? new THREE.Vector3(0, 1, 0) : worldZ
  const up = ref.clone().sub(n.clone().multiplyScalar(ref.dot(n)))
  if (up.lengthSq() < 1e-9) return new THREE.Vector3(0, 1, 0)
  return up.normalize()
}

/** WO UI-23-R1 (audit finding 3, "non-production tests"): the ACTUAL
 *  orientNormalToPoint camera math, extracted to a pure function so a test
 *  can drive it directly against a real THREE.Camera + OrbitControls pair
 *  (no WebGLRenderer/canvas needed for the math itself -- only
 *  createDefaultSceneRuntime's WebGLRenderer construction needs a real GL
 *  context, which jsdom lacks) instead of recording call arguments against a
 *  fake runtime. The SceneRuntime.orientNormalToPoint method below is now a
 *  one-line wrapper around this plus its own render() call -- so a test
 *  calling this function IS calling production code, not a re-derivation of
 *  it. */
export function applyOrientNormalToPoint(
  camera: THREE.Camera,
  controls: { target: THREE.Vector3; update(): void },
  point: Vec3Like,
  normal: Vec3Like,
  sizeHint?: number,
): void {
  const origin = new THREE.Vector3(point.x, point.y, point.z)
  const n = new THREE.Vector3(normal.x, normal.y, normal.z).normalize()
  const up = stableUpForNormal(n)
  const radius = Math.max(sizeHint ?? 0, 10)
  const distance = distanceForRadius(camera, radius)
  camera.up.copy(up)
  camera.position.copy(origin).addScaledVector(n, distance)
  controls.target.copy(origin)
  camera.lookAt(origin)
  controls.update()
}

/** WO-1454: the ACTUAL frameBox camera math, extracted to a pure function for
 *  the same reason applyOrientNormalToPoint above is (a test can drive it
 *  directly against a real THREE.Camera + OrbitControls pair, no
 *  WebGLRenderer/canvas needed). frameBox below is now a thin wrapper around
 *  this plus its own render() call.
 *
 *  For a perspective camera, distance IS the framing control (unchanged
 *  behavior). For an orthographic camera, moving distance changes nothing
 *  visible -- distanceForRadius's own comment says so -- so this branch also
 *  rebuilds the frustum half-width/half-height around the box's radius,
 *  reusing the exact half-height formula (orthographicHalfHeightForDistance)
 *  buildProjectionSwapCamera uses when swapping INTO orthographic. */
export function applyFrameBox(
  camera: THREE.Camera,
  controls: { target: THREE.Vector3; update(): void },
  min: Vec3Like,
  max: Vec3Like,
  canvasWidth: number,
  canvasHeight: number,
): void {
  const center = new THREE.Vector3(
    (min.x + max.x) / 2,
    (min.y + max.y) / 2,
    (min.z + max.z) / 2,
  )
  const size = new THREE.Vector3(max.x - min.x, max.y - min.y, max.z - min.z)
  const radius = Math.max(size.length() / 2, 1e-3)
  // Keep the current viewing direction (camera - target, normalized);
  // only distance and target move.
  const viewDirection = camera.position.clone().sub(controls.target)
  if (viewDirection.lengthSq() < 1e-9) viewDirection.set(1, -1, 0.8)
  viewDirection.normalize()
  const distance = distanceForRadius(camera, radius) // margin so the part isn't edge-to-edge
  camera.position.copy(center).addScaledVector(viewDirection, distance)
  controls.target.copy(center)
  camera.lookAt(center)
  const orthoCam = camera as THREE.OrthographicCamera
  if (orthoCam.isOrthographicCamera === true) {
    const aspect = canvasWidth / canvasHeight
    const halfHeight = orthographicHalfHeightForDistance(distance)
    const halfWidth = halfHeight * aspect
    orthoCam.left = -halfWidth
    orthoCam.right = halfWidth
    orthoCam.top = halfHeight
    orthoCam.bottom = -halfHeight
    orthoCam.zoom = 1
    orthoCam.updateProjectionMatrix()
  }
  controls.update()
}

/** WO UI-23-R1 (audit finding 3): the ACTUAL perspective<->orthographic swap
 *  math setCameraProjection uses, extracted to a pure function (byte-for-
 *  byte the same formulas that lived inline before this fix) so it is
 *  directly testable against a real THREE.PerspectiveCamera/
 *  OrthographicCamera -- no OrbitControls/WebGLRenderer construction
 *  required for the math itself. setCameraProjection below calls this for
 *  the new camera, then owns the OrbitControls/gate rebuild (which
 *  inherently needs the runtime's own closures) around it. */
export function buildProjectionSwapCamera(
  camera: THREE.Camera,
  target: THREE.Vector3,
  mode: CameraProjectionMode,
  aspect: number,
): THREE.Camera {
  const pos = camera.position.clone()
  const up = camera.up.clone()
  const dist = Math.max(pos.distanceTo(target), 1e-3)

  if (mode === 'orthographic') {
    // WO UI-23 (C4): match the orthographic frustum's HALF-HEIGHT to what
    // the perspective camera currently shows AT the target's depth
    // (halfHeight = distance * tan(fov/2)) -- this is the "zoom scale
    // preserved" contract: an object at the target plane subtends the
    // same fraction of the viewport right after the swap.
    const persp = camera as THREE.PerspectiveCamera
    const halfHeight = orthographicHalfHeightForDistance(dist, persp.fov)
    const halfWidth = halfHeight * aspect
    const ortho = new THREE.OrthographicCamera(-halfWidth, halfWidth, halfHeight, -halfHeight, 0.1, 2000)
    ortho.position.copy(pos)
    ortho.up.copy(up)
    ortho.zoom = 1
    ortho.lookAt(target)
    ortho.updateProjectionMatrix()
    return ortho
  }
  // Reverse: pick a perspective distance that reproduces the SAME
  // half-height the orthographic frustum currently shows (accounting
  // for its zoom), along the SAME view direction, keeping the target
  // centered.
  const ortho = camera as THREE.OrthographicCamera
  const halfHeight = Math.max((ortho.top - ortho.bottom) / 2 / Math.max(ortho.zoom, 1e-6), 1e-3)
  const fov = 45
  const fovRad = (fov * Math.PI) / 180
  const newDist = halfHeight / Math.tan(fovRad / 2)
  const dir = pos.clone().sub(target)
  if (dir.lengthSq() < 1e-9) dir.set(1, -1, 0.8)
  dir.normalize()
  const persp = new THREE.PerspectiveCamera(fov, aspect, 0.1, 2000)
  persp.position.copy(target).addScaledVector(dir, newDist)
  persp.up.copy(up)
  persp.lookAt(target)
  persp.updateProjectionMatrix()
  return persp
}

/**
 * Reflow only the camera dimension controlled by viewport aspect. This keeps
 * circles circular when a docked panel changes the canvas height without
 * changing the browser window size.
 */
export function resizeSceneCameraProjection(
  camera: THREE.Camera,
  width: number,
  height: number,
): void {
  if (![width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    throw new Error('Model viewport resize requires finite positive dimensions.')
  }
  const aspect = width / height
  const ortho = camera as THREE.OrthographicCamera
  if (ortho.isOrthographicCamera === true) {
    const halfHeight = (ortho.top - ortho.bottom) / 2
    ortho.left = -halfHeight * aspect
    ortho.right = halfHeight * aspect
    ortho.updateProjectionMatrix()
    return
  }
  const perspective = camera as THREE.PerspectiveCamera
  if (perspective.isPerspectiveCamera !== true) {
    throw new Error('Model viewport resize requires a perspective or orthographic camera.')
  }
  perspective.aspect = aspect
  perspective.updateProjectionMatrix()
}

/**
 * Window resize does not fire when flex layout changes because the bottom
 * event drawer opens. Observe the canvas box itself, matching the CAM
 * viewport's established container-resize ownership.
 */
export function observeSceneViewportResize(
  canvas: HTMLCanvasElement,
  onResize: () => void,
): () => void {
  if (typeof ResizeObserver === 'undefined') {
    console.warn('Model viewport: ResizeObserver unavailable; using window resize only.')
    return () => {}
  }
  const observer = new ResizeObserver(() => onResize())
  observer.observe(canvas)
  return () => observer.disconnect()
}

/** WO UI-17 (criterion 6): the DOCUMENTED preset pose -- camera position for
 *  `view`, keeping the current orbit target and viewing distance. Byte-for-byte
 *  the pose table CNCViewport.setCameraView uses (CNCViewport.ts:2029-2037),
 *  extracted pure so the workbench runtime and a unit test share ONE
 *  definition of what "the top view" is. */
export function presetCameraPosition(view: WorkbenchViewName, target: Vec3Like, dist: number): Vec3Like {
  switch (view) {
    case 'top':    return { x: target.x, y: target.y, z: target.z + dist }
    case 'front':  return { x: target.x, y: target.y - dist, z: target.z }
    case 'right':  return { x: target.x + dist, y: target.y, z: target.z }
    case 'iso':    return { x: target.x + dist * 0.7, y: target.y - dist * 0.7, z: target.z + dist * 0.5 }
    case 'back':   return { x: target.x, y: target.y + dist, z: target.z }
    case 'left':   return { x: target.x - dist, y: target.y, z: target.z }
    case 'bottom': return { x: target.x, y: target.y, z: target.z - dist }
  }
}

/** Apply the workbench ViewCube pose to a live camera/controls pair. Extracted
 *  so pole-start regression tests exercise the exact production path without
 *  constructing createDefaultSceneRuntime's WebGLRenderer in jsdom. */
export function applyPresetCameraView(
  camera: THREE.Camera,
  controls: { target: THREE.Vector3; update(): void },
  view: WorkbenchViewName,
): void {
  const target = controls.target
  const dist = camera.position.distanceTo(target)
  const pos = presetCameraPosition(view, target, dist)
  camera.position.set(pos.x, pos.y, pos.z)
  // At top/bottom, world Z is the viewing axis and therefore cannot also be
  // the lookAt up reference. +Y gives both pole views a deterministic CAD
  // roll while side/isometric views retain the established Z-up horizon.
  if (view === 'top' || view === 'bottom') camera.up.set(0, 1, 0)
  else camera.up.set(0, 0, 1)
  camera.lookAt(target)
  // Let OrbitControls consume/clear any pending deltas, then restore the
  // mathematically exact preset because its spherical makeSafe nudges an
  // exact pole by epsilon even though free orbit can handle that pose.
  controls.update()
  camera.position.set(pos.x, pos.y, pos.z)
  if (view === 'top' || view === 'bottom') camera.up.set(0, 1, 0)
  else camera.up.set(0, 0, 1)
  camera.lookAt(target)
}

/** WO UI-17 (criterion 8): fallback grid colors for an environment where the
 *  CSS custom properties are not resolvable (jsdom, a detached document) --
 *  the literal values tokens.css assigns to --vp-grid / --vp-grid-accent. */
const VP_GRID_FALLBACK = 0x2a2f36

function resolveCssColor(name: string, fallback: number): THREE.Color {
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    if (raw !== '') return new THREE.Color(raw)
  } catch {
    /* no DOM / unparsable value: fall through */
  }
  return new THREE.Color(fallback)
}

/** WO UI-17 (criterion 8): the quaternion that carries a GridHelper (whose own
 *  plane normal is local +Y and whose lines run along local X/Z) onto `frame`
 *  -- local X lands on frame.xDir, local Y on frame.normal. ONE definition,
 *  shared by buildPlaneGrid and the acceptance test, so the assertion is
 *  against the same math the scene uses. */
export function planeGridQuaternion(frame: PlaneFrame): THREE.Quaternion {
  const xDir = new THREE.Vector3(frame.xDir.x, frame.xDir.y, frame.xDir.z).normalize()
  const yDir = new THREE.Vector3(frame.normal.x, frame.normal.y, frame.normal.z).normalize()
  const zDir = new THREE.Vector3().crossVectors(xDir, yDir) // right-handed basis
  const m = new THREE.Matrix4().makeBasis(xDir, yDir, zDir)
  return new THREE.Quaternion().setFromRotationMatrix(m)
}

/** WO UI-17 (criterion 8): the sketch-plane grid -- CNCViewport.buildGrid()'s
 *  GridHelper recipe (size/spacing -> divisions, --vp-grid token) oriented by
 *  the session plane's frame instead of hardwired world
 *  XY. Pure THREE (no renderer), so it is unit-testable in jsdom. Lines only:
 *  the CAM ground grid's fill plane is scenery for a whole machine envelope,
 *  not for a bounded sketch plane. */
export function buildPlaneGrid(frame: PlaneFrame, spacingMm: number, sizeMm: number): THREE.Group {
  const group = new THREE.Group()
  group.name = 'workbench-sketch-grid'
  group.userData.sketchPlaneGrid = true
  const size = Math.max(1, sizeMm)
  const divisions = Math.max(2, Math.round(size / Math.max(1, spacingMm)))
  const grid = new THREE.GridHelper(
    size,
    divisions,
    // SKC-61: the package already paints the real sketch X/Y axes as dashed
    // construction geometry. A second, solid accent pair from GridHelper read
    // as two infinite user lines at oblique camera angles. Keep every grid
    // segment, but render the center pair as ordinary grid scenery.
    resolveCssColor('--vp-grid', VP_GRID_FALLBACK),
    resolveCssColor('--vp-grid', VP_GRID_FALLBACK),
  )
  const material = grid.material as THREE.LineBasicMaterial
  material.transparent = true
  material.opacity = 0.55
  material.depthWrite = false
  group.add(grid)
  group.quaternion.copy(planeGridQuaternion(frame))
  group.position.set(frame.origin.x, frame.origin.y, frame.origin.z)
  group.updateMatrixWorld(true)
  return group
}

/** WO UI-17-R1 (audit finding 1): the ONE right-drag travel threshold, in px.
 *  MUST equal the frozen sketch package's private context-menu classifier
 *  constant (src/lib/sketch/sketcher/sketchInteraction.ts:54, RIGHT_DRAG_PAN_PX
 *  = 5): below-or-at it a right press is a MENU request (camera must not move),
 *  above it the press is an ORBIT drag (menu must not open). The package is
 *  FROZEN, so its module-private constant cannot be exported from there; the
 *  one-source rule is enforced instead by the named drift test in
 *  workbenchNavRightDragOrbit.test.ts, which parses the frozen source and fails
 *  if the two values ever diverge. */
export const RIGHT_DRAG_PAN_PX = 5

/** WO UI-17 (Q-15, Operator-answered) + UI-17-R1 (audit finding 1): inside a
 *  sketch session, on the liencnc-default preset ONLY, right-DRAG orbits while
 *  a right-CLICK (travel <= RIGHT_DRAG_PAN_PX) opens the sketch context menu.
 *
 *  R1 change: while the override is active this ARMS the gesture by mapping
 *  RIGHT to null instead of THREE.MOUSE.ROTATE. OrbitControls latches its
 *  action at pointerdown, so an immediate ROTATE mapping rotated the camera
 *  through the first five pixels of what the frozen package's contextmenu
 *  classifier still called a CLICK (the audit's 4px/5.03-unit proof). With
 *  RIGHT unmapped, nothing latches at pointerdown; createSketchRightDragOrbitGate
 *  (below) watches travel and engages ROTATE only past the SAME shared
 *  threshold the menu classification uses.
 *
 *  Every other preset's bindings are untouched -- callers re-apply the preset
 *  mapping first (createNavPresetController.apply) and then run this override,
 *  so deactivation restores the preset's own RIGHT mapping by construction. */
export function applySketchRightDragOrbitOverride(
  mouseButtons: { RIGHT?: THREE.MOUSE | null },
  presetId: NavPresetId,
  sketchSessionActive: boolean,
): void {
  if (sketchSessionActive && presetId === 'liencnc-default') {
    mouseButtons.RIGHT = null
  }
}

/** Marks the gate's own synthetic events so its listeners skip them and so
 *  they are distinguishable from real pointer input. A plain property (not a
 *  Symbol) so a test can assert it if it ever needs to. */
const GATE_SYNTHETIC = '__liencamRightDragOrbitGate'

export interface SketchRightDragOrbitGate {
  /** Reflect the override state (sketch session active AND liencnc-default).
   *  Enabling installs the capture-phase listeners; disabling removes them and
   *  discards any half-tracked gesture. Idempotent both ways. */
  setEnabled(enabled: boolean): void
  dispose(): void
}

/** WO UI-17-R1 (audit finding 1): the drag-threshold gate in the CAMERA path.
 *
 *  While enabled (armed by applySketchRightDragOrbitOverride mapping RIGHT to
 *  null), a right pointerdown latches NOTHING in OrbitControls -- the camera
 *  is provably untouched for the whole 0..RIGHT_DRAG_PAN_PX px travel range a
 *  contextmenu still treats as a menu click. On the first move whose travel
 *  EXCEEDS the shared threshold, the gate engages the orbit:
 *
 *   1. a tagged, NON-BUBBLING synthetic pointercancel makes OrbitControls
 *      forget the tracked pointer (its onPointerDown early-returns for an
 *      already-tracked pointerId, so a fresh latch needs a clean slate);
 *   2. mouseButtons.RIGHT flips to THREE.MOUSE.ROTATE;
 *   3. a tagged, NON-BUBBLING synthetic pointerdown at the ORIGINAL down
 *      position re-latches -- so the very next move (the one being processed,
 *      which reaches OrbitControls' just-re-added document listener after this
 *      capture handler returns) rotates by the FULL travel. A 6px drag orbits
 *      by 6px worth, not by 6-minus-threshold.
 *
 *  bubbles:false is load-bearing: the frozen sketch package records the
 *  right-down position on the OVERLAY HOST (the canvas's parent) in the bubble
 *  phase, and its contextmenu classifier measures travel from that point. The
 *  synthetics fire canvas target listeners only (OrbitControls; the package's
 *  own canvas pointerdown handler ignores button !== 0), so the menu
 *  classification keeps measuring from the TRUE down point. Same synthetic
 *  re-dispatch pattern as navPresetController's invert-wheel interceptor.
 *
 *  Cleanup tail (charter item 5): pointerup and pointercancel both end the
 *  gesture and restore the armed RIGHT=null mapping; setEnabled(false)/dispose
 *  remove all four listeners and discard tracking. The gate holds no timers,
 *  rAF handles, or queued callbacks. */
export function createSketchRightDragOrbitGate(
  controls: { mouseButtons: { RIGHT?: THREE.MOUSE | null }; enabled: boolean },
  domElement: HTMLElement,
): SketchRightDragOrbitGate {
  let enabled = false
  let gesture: { pointerId: number; x: number; y: number; engaged: boolean } | null = null

  const isSynthetic = (e: Event): boolean =>
    (e as Event & { [GATE_SYNTHETIC]?: boolean })[GATE_SYNTHETIC] === true

  const dispatchSynthetic = (
    type: 'pointerdown' | 'pointercancel',
    at: { x: number; y: number },
    like: PointerEvent,
  ): void => {
    // MouseEvent + defined pointerId/pointerType: OrbitControls only reads
    // pointerId/pointerType/button/clientX/clientY/modifiers, and jsdom has no
    // reliable PointerEvent constructor -- the same trick the package mount
    // tests and the nav harness use. Modifiers are copied from the live event
    // so ctrl/shift+right-drag keeps OrbitControls' own modifier-swap parity.
    const synthetic = new MouseEvent(type, {
      bubbles: false,
      cancelable: true,
      clientX: at.x,
      clientY: at.y,
      button: 2,
      ctrlKey: like.ctrlKey,
      shiftKey: like.shiftKey,
      altKey: like.altKey,
      metaKey: like.metaKey,
    })
    Object.defineProperty(synthetic, 'pointerId', { value: like.pointerId })
    Object.defineProperty(synthetic, 'pointerType', { value: 'mouse' })
    Object.defineProperty(synthetic, GATE_SYNTHETIC, { value: true })
    domElement.dispatchEvent(synthetic)
  }

  const onPointerDown = (e: PointerEvent): void => {
    if (isSynthetic(e)) return // our own engage re-latch: not a new gesture
    if (e.button !== 2 || e.pointerType === 'touch') return
    if (controls.enabled === false) return
    gesture = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, engaged: false }
  }

  const onPointerMove = (e: PointerEvent): void => {
    if (gesture === null || gesture.engaged || e.pointerId !== gesture.pointerId) return
    const travel = Math.hypot(e.clientX - gesture.x, e.clientY - gesture.y)
    // Fail CLOSED on bad data (charter item 3): a non-finite coordinate keeps
    // the gate shut (camera untouched) instead of sailing through a NaN>tol
    // comparison in whichever direction happens to be wrong.
    if (!Number.isFinite(travel)) return
    if (travel <= RIGHT_DRAG_PAN_PX) return // same boundary as the menu classifier
    gesture.engaged = true
    dispatchSynthetic('pointercancel', { x: gesture.x, y: gesture.y }, e)
    controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE
    dispatchSynthetic('pointerdown', { x: gesture.x, y: gesture.y }, e)
  }

  const endGesture = (e: PointerEvent): void => {
    if (isSynthetic(e)) return
    if (gesture === null || e.pointerId !== gesture.pointerId) return
    const wasEngaged = gesture.engaged
    gesture = null
    // Re-arm: back to the null mapping so the NEXT right press gates again.
    // OrbitControls has already latched (or not) for the ending gesture;
    // mouseButtons is only read at pointerdown, so this cannot disturb it.
    if (wasEngaged) controls.mouseButtons.RIGHT = null
  }

  const addListeners = (): void => {
    domElement.addEventListener('pointerdown', onPointerDown, { capture: true })
    domElement.addEventListener('pointermove', onPointerMove, { capture: true })
    domElement.addEventListener('pointerup', endGesture, { capture: true })
    domElement.addEventListener('pointercancel', endGesture, { capture: true })
  }
  const removeListeners = (): void => {
    domElement.removeEventListener('pointerdown', onPointerDown, { capture: true } as EventListenerOptions)
    domElement.removeEventListener('pointermove', onPointerMove, { capture: true } as EventListenerOptions)
    domElement.removeEventListener('pointerup', endGesture, { capture: true } as EventListenerOptions)
    domElement.removeEventListener('pointercancel', endGesture, { capture: true } as EventListenerOptions)
  }

  return {
    setEnabled: (next) => {
      if (next === enabled) return
      enabled = next
      gesture = null
      if (next) addListeners()
      else removeListeners()
    },
    dispose: () => {
      if (enabled) removeListeners()
      enabled = false
      gesture = null
    },
  }
}

/** WO UI-23 (C1, Operator's "middle-orbit + ctrl-middle-pan" finding): workbench-
 *  only override -- middle-DRAG orbits, Ctrl+middle-drag pans, both inside and
 *  outside a sketch session. Scoped to liencnc-default ONLY (every other
 *  preset already defines its own MIDDLE scheme -- orbit-first modifier presets already do
 *  exactly this via modifierRules, right-orbit, orbit-middle, and pan-first presets use
 *  MIDDLE for something else on purpose -- an override here would corrupt a
 *  scheme a user deliberately picked).
 *
 *  DIVERGENCE NOTE (WO premise: "check what the CAM viewport does with the
 *  same gesture before diverging"): liencnc-default's MIDDLE=zoom mapping is
 *  the CAM viewport's shipping default too (NAV_PRESETS is the shared table,
 *  types/index.ts), and it is PINNED there by
 *  src/tests/store/appSettings.test.ts:132-135 (`mouseButtons` equals
 *  `{LEFT:'orbit', MIDDLE:'zoom', RIGHT:'pan'}`, `modifierRules` asserted
 *  `undefined`) -- a CAM-owned test outside this WO's ownership manifest
 *  (types/index.ts and that test file are not in the UI-23 manifest, and
 *  "the CAM route's Viewport/nav files" are explicitly off-limits). Editing
 *  the shared preset table would silently change CAM viewport feel and break
 *  that pinned test. So this is a genuine, DISCLOSED workbench-only
 *  divergence: the CAM viewport keeps MIDDLE=zoom, the workbench gets
 *  MIDDLE=orbit/Ctrl+MIDDLE=pan. Ctrl+middle=pan needs NO extra remap code --
 *  OrbitControls' own onMouseDown swaps ROTATE->PAN whenever ctrl/shift/meta
 *  is held (OrbitControls.js onMouseDown, MOUSE.ROTATE case), the exact same
 *  built-in swap navPresetController.ts's navDesiredToBaseMouse already
 *  leans on for the orbit-first modifier-rule presets. */
export function applyWorkbenchMiddleDragOverride(
  mouseButtons: { MIDDLE?: THREE.MOUSE | null },
  presetId: NavPresetId,
): void {
  if (presetId === 'liencnc-default') {
    mouseButtons.MIDDLE = THREE.MOUSE.ROTATE
  }
}

/** WO UI-23 (C2): fold an UNBOUNDED accumulated polar angle into three.js's
 *  canonical [0, PI] `phi` + a `theta` parity flip.
 *
 *  ROOT CAUSE of Operator's "other axes clamp" report: OrbitControls' internal
 *  Spherical.makeSafe() unconditionally clips phi to [EPS, PI-EPS] on every
 *  update() call (see node_modules/three/examples/jsm/controls/
 *  OrbitControls.js -- `this._spherical.makeSafe()`), regardless of
 *  minPolarAngle/maxPolarAngle (already the full 0..PI range by default) --
 *  it exists only to keep the view direction from going exactly parallel to
 *  `up` (a lookAt singularity). Because `_spherical` is recomputed FRESH from
 *  the actual camera position every call, once the camera is pinned at that
 *  boundary, every further drag delta is discarded: the camera visibly jams
 *  at the pole no matter how much more the user drags.
 *
 *  MECHANISM CHOSEN (per the WO premise, documented here + in the report):
 *  NOT a trackball. An unconstrained trackball would let ordinary,
 *  non-polar drags roll/tilt the camera too -- a bigger divergence from
 *  today's keep-the-horizon-level orbit feel than Operator asked for ("Z is
 *  continuous today, other axes clamp" scopes the complaint to the polar
 *  axis only, not a request for full roll freedom). Instead: keep world Z as
 *  a FIXED polar axis and track our OWN unbounded raw phi across an active
 *  rotate gesture, folding it back into the canonical range every frame
 *  instead of letting OrbitControls clamp it. sin(phi) -> 0 exactly at the
 *  fold point keeps the 3D position perfectly continuous through the
 *  crossing (no jump, no NaN); the theta flip is invisible at the crossing
 *  for the same reason and the drag just keeps going on the far meridian. */
export function foldPolarAngle(rawPhi: number): { phi: number; thetaFlip: boolean } {
  const twoPi = Math.PI * 2
  let p = rawPhi % twoPi
  if (p < 0) p += twoPi
  if (p <= Math.PI) return { phi: p, thetaFlip: false }
  return { phi: twoPi - p, thetaFlip: true }
}

function clampUnit(v: number): number {
  return Math.max(-1, Math.min(1, v))
}

/** Z-up spherical decomposition of a camera-minus-target offset (phi measured
 *  from +Z, theta around Z) -- deliberately independent of OrbitControls' own
 *  internal Y-up-space spherical (`_spherical`/`_quat`), so the fold math
 *  above is pure and unit-testable with no THREE instance beyond Vec3Like. */
export function zUpSphericalFromOffset(offset: Vec3Like): { radius: number; theta: number; phi: number } {
  const radius = Math.max(Math.hypot(offset.x, offset.y, offset.z), 1e-9)
  const phi = Math.acos(clampUnit(offset.z / radius))
  const theta = Math.atan2(offset.y, offset.x)
  return { radius, theta, phi }
}

export function zUpOffsetFromSpherical(radius: number, theta: number, phi: number): Vec3Like {
  const sinPhi = Math.sin(phi)
  return {
    x: radius * sinPhi * Math.cos(theta),
    y: radius * sinPhi * Math.sin(theta),
    z: radius * Math.cos(phi),
  }
}

/** WO UI-23 (C2): would THIS button+modifier combination, under the CURRENT
 *  (already preset+override-resolved) `mouseButtons` mapping, become a
 *  ROTATE gesture once OrbitControls' own onMouseDown modifier-swap runs?
 *  Pure mirror of that swap (OrbitControls.js onMouseDown: ROTATE swaps to
 *  PAN when a modifier is held, PAN swaps to ROTATE when one is) -- reused so
 *  free-orbit gesture detection agrees with OrbitControls' own decision for
 *  every preset, including the modifier-gated ones, without re-deriving
 *  preset-specific rules here. */
export function willResolveToRotate(
  action: THREE.MOUSE | null | undefined,
  mods: { shift: boolean; ctrl: boolean; meta: boolean },
): boolean {
  const modHeld = mods.shift || mods.ctrl || mods.meta
  if (action === THREE.MOUSE.ROTATE) return !modHeld
  if (action === THREE.MOUSE.PAN) return modHeld
  return false
}

/** UI-49: the pan counterpart to willResolveToRotate. The input mapping is
 *  read only after navPresetController's capture listener has resolved the
 *  active preset/modifiers, so this mirrors OrbitControls' final action
 *  without introducing a second preset table. */
export function willResolveToPan(
  action: THREE.MOUSE | null | undefined,
  mods: { shift: boolean; ctrl: boolean; meta: boolean },
): boolean {
  const modHeld = mods.shift || mods.ctrl || mods.meta
  if (action === THREE.MOUSE.ROTATE) return modHeld
  if (action === THREE.MOUSE.PAN) return !modHeld
  return false
}

export interface FreeOrbitController {
  dispose(): void
}

/** The workbench opts into cursor-anchored wheel zoom while the CAM viewport
 *  keeps createNavPresetController's default. Keeping this constructor seam
 *  shared preserves all preset/invert behavior without forking wheel logic. */
export function createWorkbenchNavController(
  controls: OrbitControls,
  domElement: HTMLElement,
): NavPresetController {
  return createNavPresetController(controls, domElement, { zoomToCursor: true })
}

/** Seed screen-up from the current pose without allowing a collinear or
 *  non-finite camera.up to poison the transported basis. Exact Z poles use
 *  +Y, matching applyPresetCameraView's deterministic CAD roll. */
function hasFiniteVector3Components(value: THREE.Vector3): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z)
}

function stableRollUpSeed(viewDir: THREE.Vector3, candidateUp: THREE.Vector3): THREE.Vector3 | null {
  if (!hasFiniteVector3Components(viewDir) || viewDir.lengthSq() < 1e-12) return null

  const dir = viewDir.clone().normalize()
  const candidateUpIsFinite = hasFiniteVector3Components(candidateUp)
  let up = candidateUpIsFinite
    ? candidateUp.clone().sub(dir.clone().multiplyScalar(dir.dot(candidateUp)))
    : new THREE.Vector3()
  if (!candidateUpIsFinite || !hasFiniteVector3Components(up) || up.lengthSq() < 1e-9) {
    const fallback = Math.abs(dir.z) > 0.999 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1)
    up = fallback.sub(dir.clone().multiplyScalar(dir.dot(fallback)))
  }
  if (!hasFiniteVector3Components(up) || up.lengthSq() < 1e-12) return null
  return up.normalize()
}

/** WO UI-23 (C2): install free (pole-continuous) orbit on a live OrbitControls
 *  instance. Engaged ONLY for the duration of a real rotate gesture (button-
 *  down through button-up/cancel, decided via willResolveToRotate at
 *  pointerdown) -- outside that window `controls.update` is untouched, so
 *  every programmatic camera move (setCameraView, frameBox,
 *  orientNormalToPlane/Point, setCameraPose, the ViewCube, a preset switch)
 *  is provably unaffected: this file's own precedent for monkeypatching a
 *  private OrbitControls member (navPresetController.ts's `_pan` override for
 *  invert-pan) is the model followed here for `update`.
 *
 *  Re-dispatches OrbitControls' own 'change' event after each correction so
 *  the caller's EXISTING `controls.addEventListener('change', render)` wiring
 *  (already installed by createDefaultSceneRuntime) picks up the corrected
 *  frame -- no new render callback plumbing needed. */
export function installFreeOrbit(
  controls: OrbitControls,
  camera: THREE.Camera,
  domElement: HTMLElement,
): FreeOrbitController {
  let active = false
  // WO UI-37 (Operator 2026-07-12): VIEW-RELATIVE (trackball) orbit. Each frame we
  // rotate the camera about its CURRENT view axes -- yaw about the current up,
  // pitch about the current screen-right -- so NO rotational axis ever inverts,
  // from any pose (upright, over the top, or upside down), and the over-the-top
  // path stays continuous because an incremental rotation is always well-defined.
  // This REPLACES the previous world-Z spherical accumulation, whose FIXED polar
  // axis made left/right (yaw) AND up/down (pitch) drag feel inverted once the
  // camera rolled past vertical (Operator: "when I go over the top the yaw/other
  // axis inverts"). State = the live camera->target offset + screen-up, reseeded
  // from the camera's actual pose at every pointerdown.
  const orbitOffset = new THREE.Vector3()
  const orbitUp = new THREE.Vector3(0, 0, 1)

  const origUpdate = controls.update.bind(controls)
  const patchedUpdate = ((deltaTime?: number | null) => {
    if (!active) return origUpdate(deltaTime)
    const c = controls as unknown as { _sphericalDelta: { theta: number; phi: number } }
    // Read this frame's drag deltas BEFORE origUpdate resets them; fail closed
    // on non-finite data (charter item 3): treat a bad delta as zero this frame.
    const dTheta = Number.isFinite(c._sphericalDelta.theta) ? c._sphericalDelta.theta : 0
    const dPhi = Number.isFinite(c._sphericalDelta.phi) ? c._sphericalDelta.phi : 0
    const changed = origUpdate(deltaTime)
    // origUpdate may have wheel-zoomed/panned: keep its target + resulting radius.
    const radius = camera.position.distanceTo(controls.target)
    const dir = orbitOffset.lengthSq() > 1e-12 ? orbitOffset.clone().normalize() : new THREE.Vector3(0, 0, 1)
    // Screen-right = up x view-out. Yaw rotates about the CURRENT up; pitch about
    // the CURRENT right. Both signs match the previous upright feel (yaw about +Z
    // by dTheta; pitch lowers the camera for +dPhi) but now follow the live basis.
    const right = new THREE.Vector3().crossVectors(orbitUp, dir)
    if (right.lengthSq() < 1e-9) {
      right.crossVectors(Math.abs(dir.z) > 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1), dir)
    }
    right.normalize()
    const rot = new THREE.Quaternion().setFromAxisAngle(right, dPhi)
      .multiply(new THREE.Quaternion().setFromAxisAngle(orbitUp, dTheta))
    orbitOffset.applyQuaternion(rot)
    orbitUp.applyQuaternion(rot)
    if (orbitOffset.lengthSq() < 1e-12) orbitOffset.copy(dir)
    orbitOffset.setLength(radius)
    camera.position.copy(controls.target).add(orbitOffset)

    const newDir = orbitOffset.clone().normalize()
    // Re-orthonormalize up against the view direction (guards float drift over a
    // long gesture); NEVER re-derive from a fixed world axis (that reintroduces
    // the pole singularity UI-31 removed). Deterministic fallback keeps it
    // fail-closed if up ever goes collinear with the view.
    let yAxis = orbitUp.clone().sub(newDir.clone().multiplyScalar(newDir.dot(orbitUp)))
    if (yAxis.lengthSq() < 1e-9) {
      const fallback = Math.abs(newDir.z) > 0.999 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1)
      yAxis = fallback.sub(newDir.clone().multiplyScalar(newDir.dot(fallback)))
    }
    yAxis.normalize()
    orbitUp.copy(yAxis)
    const xAxis = new THREE.Vector3().crossVectors(yAxis, newDir).normalize()
    camera.up.copy(yAxis)
    camera.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xAxis, yAxis, newDir))

    controls.dispatchEvent({ type: 'change' })
    return changed
  }) as typeof controls.update
  controls.update = patchedUpdate

  const buttonName = (button: number): 'LEFT' | 'MIDDLE' | 'RIGHT' | null =>
    button === 0 ? 'LEFT' : button === 1 ? 'MIDDLE' : button === 2 ? 'RIGHT' : null

  const onPointerDown = (e: PointerEvent): void => {
    if (controls.enabled === false || e.pointerType === 'touch') return
    const name = buttonName(e.button)
    if (name === null) return
    const action = controls.mouseButtons[name] ?? null
    if (!willResolveToRotate(action, { shift: e.shiftKey, ctrl: e.ctrlKey, meta: e.metaKey })) return
    const offset = {
      x: camera.position.x - controls.target.x,
      y: camera.position.y - controls.target.y,
      z: camera.position.z - controls.target.z,
    }
    const direction = new THREE.Vector3(offset.x, offset.y, offset.z)
    const radius = direction.length()
    const seededUp = stableRollUpSeed(direction, camera.up)
    if (
      !hasFiniteVector3Components(direction)
      || !Number.isFinite(radius)
      || radius < 1e-9
      || seededUp === null
    ) {
      active = false
      // This capture listener must also refuse the underlying pointerdown.
      // Otherwise stock OrbitControls arms its rotate state and consumes the
      // first move with the same invalid payload that free orbit rejected.
      e.preventDefault()
      e.stopImmediatePropagation()
      return
    }
    active = true
    orbitOffset.copy(direction)
    orbitUp.copy(seededUp)
  }
  const endGesture = (): void => {
    active = false
  }
  domElement.addEventListener('pointerdown', onPointerDown, { capture: true })
  domElement.addEventListener('pointerup', endGesture, { capture: true })
  domElement.addEventListener('pointercancel', endGesture, { capture: true })

  return {
    dispose: () => {
      controls.update = origUpdate
      domElement.removeEventListener('pointerdown', onPointerDown, { capture: true } as EventListenerOptions)
      domElement.removeEventListener('pointerup', endGesture, { capture: true } as EventListenerOptions)
      domElement.removeEventListener('pointercancel', endGesture, { capture: true } as EventListenerOptions)
    },
  }
}

export interface Vec3Like {
  x: number
  y: number
  z: number
}

export type CameraBoundsRefusalReason = 'camera-bounds-refused-nonfinite'
export type CameraDepthRefusalReason =
  | CameraBoundsRefusalReason
  | 'camera-depth-refused-unsupported-camera'
  | 'camera-depth-refused-invalid-camera'
  | 'camera-depth-refused-invalid-authored-slab'
  | 'camera-depth-refused-perspective-behind-eye'
  | 'camera-depth-refused-nonfinite-result'

export type VisibleBodyBoundsSnapshot =
  | { ok: true; bounds: THREE.Box3 | null }
  | { ok: false; reason: CameraBoundsRefusalReason }

export type DepthExtentBoundsSnapshot =
  | { ok: true; bounds: THREE.Box3 | null; fitWithoutBody: boolean }
  | { ok: false; reason: CameraBoundsRefusalReason }

export interface DepthExtentWorkProbe {
  registeredRoots: number
  renderedRoots: number
  visitedObjects: number
  geometryBoundsReads: number
  boundingBoxRecomputes: number
}

export type CameraDepthPolicyResult =
  | {
      ok: true
      corrected: boolean
      retreatedBy: number
      near: number
      far: number
      minDepth: number
      maxDepth: number
    }
  | { ok: false; reason: CameraDepthRefusalReason }

function finiteVector3(v: THREE.Vector3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)
}

function finiteBox3(box: THREE.Box3): boolean {
  return finiteVector3(box.min)
    && finiteVector3(box.max)
    && box.min.x <= box.max.x
    && box.min.y <= box.max.y
    && box.min.z <= box.max.z
}

/** UI-49: cached world bounds for registered body meshes only. Geometry is
 *  inspected on lifecycle changes, never from a controls/camera event. A
 *  visible invalid body poisons the snapshot by name instead of silently
 *  falling back to the previous union. */
export class VisibleBodyBoundsCache {
  private readonly registered = new Set<THREE.Mesh>()
  private readonly worldBounds = new Map<THREE.Mesh, THREE.Box3>()
  private readonly invalidVisible = new Set<THREE.Mesh>()
  private readonly union = new THREE.Box3()
  private hasUnion = false

  register(mesh: THREE.Mesh): VisibleBodyBoundsSnapshot {
    this.registered.add(mesh)
    return this.refresh(mesh, mesh.visible)
  }

  syncGeometry(mesh: THREE.Mesh): VisibleBodyBoundsSnapshot {
    if (!this.registered.has(mesh)) return this.snapshot()
    return this.refresh(mesh, mesh.visible)
  }

  setVisible(mesh: THREE.Mesh, visible: boolean): VisibleBodyBoundsSnapshot {
    if (!this.registered.has(mesh)) return this.snapshot()
    return this.refresh(mesh, visible)
  }

  unregister(mesh: THREE.Mesh): VisibleBodyBoundsSnapshot {
    this.registered.delete(mesh)
    this.worldBounds.delete(mesh)
    this.invalidVisible.delete(mesh)
    this.rebuildUnion()
    return this.snapshot()
  }

  snapshot(): VisibleBodyBoundsSnapshot {
    if (this.invalidVisible.size > 0) return { ok: false, reason: 'camera-bounds-refused-nonfinite' }
    return { ok: true, bounds: this.hasUnion ? this.union : null }
  }

  private refresh(mesh: THREE.Mesh, visible: boolean): VisibleBodyBoundsSnapshot {
    if (!visible) {
      this.worldBounds.delete(mesh)
      this.invalidVisible.delete(mesh)
      this.rebuildUnion()
      return this.snapshot()
    }

    mesh.geometry.computeBoundingBox()
    const local = mesh.geometry.boundingBox
    mesh.updateWorldMatrix(true, false)
    const matrixIsFinite = mesh.matrixWorld.elements.every(Number.isFinite)
    if (local === null || !finiteBox3(local) || !matrixIsFinite) {
      this.worldBounds.delete(mesh)
      this.invalidVisible.add(mesh)
      this.rebuildUnion()
      return this.snapshot()
    }

    const world = this.worldBounds.get(mesh) ?? new THREE.Box3()
    world.copy(local).applyMatrix4(mesh.matrixWorld)
    if (!finiteBox3(world)) {
      this.worldBounds.delete(mesh)
      this.invalidVisible.add(mesh)
      this.rebuildUnion()
      return this.snapshot()
    }

    this.worldBounds.set(mesh, world)
    this.invalidVisible.delete(mesh)
    this.rebuildUnion()
    return this.snapshot()
  }

  private rebuildUnion(): void {
    this.union.makeEmpty()
    this.hasUnion = false
    for (const bounds of this.worldBounds.values()) {
      if (!this.hasUnion) {
        this.union.copy(bounds)
        this.hasUnion = true
      } else {
        this.union.union(bounds)
      }
    }
  }
}

/** WO UI-72: world bounds of the non-body scene roots that must stay inside the
 *  camera's near/far slab (Operator note N-33 = the sketch grid and the sketch
 *  overlay). VisibleBodyBoundsCache deliberately tracks BODIES ONLY because the
 *  pivot-centering paths (syncCenteredModeAtGestureStart / finishPan) must keep
 *  centering on the MODEL -- so the sketch surfaces cannot simply be registered
 *  there without moving the orbit pivot. This registry is consumed by
 *  applyDepthSafety and nothing else.
 *
 *  Bounds are computed lazily per depth pass rather than cached on lifecycle
 *  events (the body cache's model) because a sketch overlay GROWS while the user
 *  draws: every new line would otherwise need a resync call, and a missed one is
 *  a silently-returning clip bug of exactly the kind this WO exists to fix.
 *  A pass is a short traversal that reads each geometry's boundingBox, recomputing
 *  only the geometries whose position buffer actually changed since the last pass
 *  (depthExtentBoundingBox) -- not a per-vertex scan of the whole subtree
 *  (measured on the real workbench scene: coordination/evidence/UI-72/perf/).
 *
 *  Returns null when no registered root contributes finite bounds (all detached,
 *  hidden, or empty); a NON-FINITE root refuses BY NAME rather than silently
 *  contributing nothing -- a NaN corner would otherwise poison the union and,
 *  because NaN comparisons are false in BOTH directions, sail through the
 *  policy's own finite checks as a slab that clips everything. */
/** WO UI-72 acceptance seam payload -- see SceneRuntime.getDepthClipProbe. */
export interface DepthClipProbe {
  near: number
  far: number
  cameraPosition: { x: number; y: number; z: number }
  /** One entry per registered depth-extent root that currently contributes
   *  bounds. `cornerDepths` are the eight world-box corners' camera-space depths
   *  (-z, i.e. distance in front of the eye), so a corner is unclipped iff
   *  near <= depth <= far. Empty when no sketch session is open. */
  roots: { name: string; cornerDepths: number[] }[]
}

export class DepthExtentRoots {
  private readonly roots = new Set<THREE.Object3D>()
  private readonly fitWithoutBodyRoots = new Set<THREE.Object3D>()
  private readonly scratch = new THREE.Box3()
  private readonly union = new THREE.Box3()
  private lastWork: DepthExtentWorkProbe = {
    registeredRoots: 0,
    renderedRoots: 0,
    visitedObjects: 0,
    geometryBoundsReads: 0,
    boundingBoxRecomputes: 0,
  }

  register(obj: THREE.Object3D, fitWithoutBody = isUserSceneDepthRoot(obj)): void {
    this.roots.add(obj)
    if (fitWithoutBody) this.fitWithoutBodyRoots.add(obj)
  }
  unregister(obj: THREE.Object3D): void {
    this.roots.delete(obj)
    this.fitWithoutBodyRoots.delete(obj)
  }
  /** Test seam: how many roots are live (a leak here silently widens the slab). */
  size(): number { return this.roots.size }
  /** UI-81C: exact bounded work performed by the most recent snapshot(). */
  lastWorkProbe(): DepthExtentWorkProbe { return { ...this.lastWork } }

  /** Per-root world boxes, for the WO UI-72 acceptance probe. Same visibility +
   *  exemption rules as snapshot(), so the probe describes exactly the geometry
   *  the policy was actually fitted to. */
  perRootBoxes(): { name: string; box: THREE.Box3 }[] {
    const out: { name: string; box: THREE.Box3 }[] = []
    for (const root of this.roots) {
      if (!contributesToRender(root)) continue
      root.updateWorldMatrix(true, true)
      const box = new THREE.Box3().makeEmpty()
      if (unionDepthExtent(box, root, new THREE.Box3()) === 'some') {
        out.push({ name: root.name === '' ? '(unnamed)' : root.name, box })
      }
    }
    return out
  }

  snapshot(): DepthExtentBoundsSnapshot {
    this.union.makeEmpty()
    const work: DepthExtentWorkProbe = {
      registeredRoots: this.roots.size,
      renderedRoots: 0,
      visitedObjects: 0,
      geometryBoundsReads: 0,
      boundingBoxRecomputes: 0,
    }
    let has = false
    let fitWithoutBody = false
    for (const root of this.roots) {
      if (!contributesToRender(root)) continue
      work.renderedRoots += 1
      root.updateWorldMatrix(true, true)
      const status = unionDepthExtent(this.union, root, this.scratch, work)
      // 'nonfinite' REFUSES the whole pass. It must not degrade to "skip that
      // one object": a root whose geometry went NaN still RENDERS, so quietly
      // leaving it out of the extent would fit a slab that clips it -- the exact
      // defect this class exists to prevent, reintroduced through the error path.
      if (status === 'nonfinite') {
        this.lastWork = work
        return { ok: false, reason: 'camera-bounds-refused-nonfinite' }
      }
      if (status === 'some') {
        has = true
        if (this.fitWithoutBodyRoots.has(root)) fitWithoutBody = true
      }
    }
    this.lastWork = work
    if (has && !finiteBox3(this.union)) return { ok: false, reason: 'camera-bounds-refused-nonfinite' }
    return { ok: true, bounds: has ? this.union : null, fitWithoutBody }
  }
}

/** UI-81C preimage-compatible classification for the existing production
 * scene tags. The runtime explicitly enrolls every addObject/setSketchGrid
 * root below; this inference also makes a directly registered finished sketch,
 * body, or genesis glyph obey the same no-body rule. */
function isUserSceneDepthRoot(obj: THREE.Object3D): boolean {
  return typeof obj.userData.workbenchSketchNodeId === 'string'
    || typeof obj.userData.workbenchFeatureId === 'string'
    || typeof obj.userData.genesisNodeId === 'string'
}

/** WO UI-72: does `root` actually reach the renderer right now? Answered
 *  STRUCTURALLY -- from the scene graph -- rather than by trusting callers to
 *  unregister, because the teardown paths do NOT all reach unregisterDepthExtent:
 *  Sketcher.exit() early-returns `if (!session)` before calling onSessionExit,
 *  and Sketcher.dispose() never calls onSessionExit at all, while
 *  SolidsWorkbenchPage's finish path detaches the overlay root itself
 *  (runtime.removeObject) either way. A registered-but-detached root would
 *  otherwise still contribute bounds and silently widen the slab forever -- the
 *  fail-open twin of the very bug this WO fixes.
 *
 *  Two conditions, both required:
 *   - every node from `root` up is visible (three.js hides a subtree from ANY
 *     level, so checking only the root is not enough), and
 *   - the chain TERMINATES IN A SCENE. A detached subtree's top ancestor is a
 *     plain Object3D/Group, never a Scene, so this is what distinguishes
 *     "removed from the scene" from "hanging under a group". */
function contributesToRender(root: THREE.Object3D): boolean {
  let node: THREE.Object3D = root
  for (;;) {
    if (!node.visible) return false
    if (node.parent === null) break
    node = node.parent
  }
  return (node as THREE.Scene).isScene === true
}

/** Union `obj`'s visible, non-exempt renderable subtree into `target` (world
 *  space). Deliberately not Box3.setFromObject: that has no way to skip an
 *  exempt subtree, and it would silently pull the pseudo-infinite axis lines
 *  back in.
 *
 *  Every outcome is NAMED, and each one is a decision:
 *   'none'      nothing here renders (hidden, exempt, or geometry-less) -- the
 *               only case where contributing nothing is correct.
 *   'some'      at least one finite geometry was unioned in.
 *   'nonfinite' a geometry that DOES render has a non-finite or missing box.
 *               Refuses upward. Skipping it instead would leave rendered
 *               geometry out of the slab, and a NaN corner compares false in
 *               BOTH directions, so it would never trip a later >/< check. */
type DepthExtentStatus = 'none' | 'some' | 'nonfinite'

/** WO UI-72-R1: the position-attribute version this module last computed a
 *  boundingBox from, per geometry. Weak on purpose -- a disposed geometry drops
 *  out on its own, with no unregister call from callers that (as
 *  contributesToRender's note records) do not reliably make one. */
const depthExtentBoxVersion = new WeakMap<THREE.BufferGeometry, { position: unknown; version: number }>()

/** `geometry`'s local bounding box, RECOMPUTED whenever its position buffer has
 *  been written or replaced since this module last measured it. A geometry with
 *  nothing to draw measures as the EMPTY box (+Infinity..-Infinity), not null
 *  -- see isEmptyGeometryBox (WO-2183).
 *
 *  Recomputing only when boundingBox is null -- the obvious version of this --
 *  is a stale-cache clip bug, not an optimization: three.js NEVER invalidates
 *  boundingBox on an in-place position write, and the live sketch path does
 *  exactly that. SketchLayer.updateDimensionGeometry rewrites the position
 *  values, sets needsUpdate, and refreshes only the bounding SPHERE, so a
 *  dimension guide moved outside the previous envelope would be measured where
 *  it USED to be and then clipped by the supposedly inclusive slab -- this WO's
 *  own defect, reintroduced through the cache.
 *
 *  The change signal is BufferAttribute.version, which three bumps on every
 *  `needsUpdate = true`. That is the tick an in-place writer must already fire
 *  to get its bytes to the GPU, so geometry cannot change VISIBLY without
 *  bumping it -- which is what makes the signal sufficient rather than merely
 *  convenient. When it cannot be read (no position attribute, or one whose
 *  version is not a number -- e.g. an interleaved attribute, whose counter lives
 *  on the shared buffer), this REFUSES THE CACHE and recomputes every pass. That
 *  is slower and never stale; trusting an unverifiable box is the fail-open
 *  alternative, and fail-open is the bug this WO exists to close. */
function depthExtentBoundingBox(
  geometry: THREE.BufferGeometry,
  work?: DepthExtentWorkProbe,
): THREE.Box3 | null {
  if (work !== undefined) work.geometryBoundsReads += 1
  const version = positionBufferVersion(geometry)
  // WO-2183: the version is per ATTRIBUTE, so a writer that swaps in a fresh
  // position attribute (setAttribute(new ...)) restarts it at 0 -- the Form
  // cage wire does this on every edit. Measure again whenever the attribute
  // object itself changed, not only when its counter moved.
  const position = geometry.attributes.position as unknown
  const measured = depthExtentBoxVersion.get(geometry)
  if (version === null) {
    depthExtentBoxVersion.delete(geometry)
    if (work !== undefined) work.boundingBoxRecomputes += 1
    geometry.computeBoundingBox()
  } else if (geometry.boundingBox === null || measured === undefined
    || measured.position !== position || measured.version !== version) {
    if (work !== undefined) work.boundingBoxRecomputes += 1
    geometry.computeBoundingBox()
    depthExtentBoxVersion.set(geometry, { position, version })
  }
  return geometry.boundingBox
}

/** The position attribute's monotonic write counter, or null when there is no
 *  readable one -- see depthExtentBoundingBox for why null means "recompute",
 *  never "assume unchanged". */
function positionBufferVersion(geometry: THREE.BufferGeometry): number | null {
  const position = (geometry.attributes as Record<string, { version?: unknown } | undefined> | undefined)?.position
  if (position === undefined || position === null) return null
  const { version } = position
  return typeof version === 'number' && Number.isFinite(version) ? version : null
}

/** WO-2183: the box computeBoundingBox() gives a geometry with no vertices
 *  (Box3.makeEmpty). Exact on purpose: a geometry with even one vertex, NaN or
 *  infinite, measures as something else and stays a 'nonfinite' refusal. */
function isEmptyGeometryBox(box: THREE.Box3): boolean {
  const { min, max } = box
  return min.x === Infinity && min.y === Infinity && min.z === Infinity
    && max.x === -Infinity && max.y === -Infinity && max.z === -Infinity
}

function unionDepthExtent(
  target: THREE.Box3,
  obj: THREE.Object3D,
  scratch: THREE.Box3,
  work?: DepthExtentWorkProbe,
): DepthExtentStatus {
  if (work !== undefined) work.visitedObjects += 1
  if (!obj.visible || isDepthExtentExempt(obj)) return 'none'
  let status: DepthExtentStatus = 'none'
  const geometry = (obj as Partial<THREE.Mesh>).geometry
  const local = geometry === undefined ? null : depthExtentBoundingBox(geometry, work)
  // WO-2183: an EMPTY geometry (no position attribute, or zero vertices) has
  // nothing to draw. three.js measures it as the empty box -- every min
  // +Infinity, every max -Infinity -- never null, so this used to fall into the
  // 'nonfinite' refusal below: the Form overlay always carries empty layers (no
  // creased edges, no selection, no hover), every depth pass refused, and the
  // slab froze while the operator orbited the near side of the skin through it.
  // Only that exact empty box contributes nothing; a NaN or infinite corner
  // from a geometry that DOES draw still refuses by name. Children are still
  // visited -- an empty parent can hold drawn children.
  if (local !== null && !isEmptyGeometryBox(local)) {
    if (!finiteBox3(local) || !obj.matrixWorld.elements.every(Number.isFinite)) return 'nonfinite'
    scratch.copy(local).applyMatrix4(obj.matrixWorld)
    if (!finiteBox3(scratch)) return 'nonfinite'
    target.union(scratch)
    status = 'some'
  }
  for (const child of obj.children) {
    const childStatus = unionDepthExtent(target, child, scratch, work)
    if (childStatus === 'nonfinite') return 'nonfinite'
    if (childStatus === 'some') status = 'some'
  }
  return status
}

/** UI-49: the single production camera-depth policy. It transforms the eight
 *  cached world-bound corners into camera space, atomically validates the
 *  proposed retreat/planes, then mutates only camera position and near/far.
 *  The fixed scratch vectors keep repeated controls changes allocation-flat. */
export class CameraDepthPolicy {
  private readonly corners = Array.from({ length: 8 }, () => new THREE.Vector3())
  private readonly size = new THREE.Vector3()
  private readonly forward = new THREE.Vector3()

  apply(camera: THREE.Camera, bounds: THREE.Box3): CameraDepthPolicyResult {
    const perspective = camera as THREE.PerspectiveCamera
    const orthographic = camera as THREE.OrthographicCamera
    if (perspective.isPerspectiveCamera !== true && orthographic.isOrthographicCamera !== true) {
      return { ok: false, reason: 'camera-depth-refused-unsupported-camera' }
    }
    const projection = perspective.isPerspectiveCamera === true ? perspective : orthographic
    if (!finiteBox3(bounds)) return { ok: false, reason: 'camera-bounds-refused-nonfinite' }
    if (!finiteVector3(camera.position)
      || !finiteVector3(camera.up)
      || ![camera.quaternion.x, camera.quaternion.y, camera.quaternion.z, camera.quaternion.w].every(Number.isFinite)) {
      return { ok: false, reason: 'camera-depth-refused-invalid-camera' }
    }

    camera.updateMatrixWorld(true)
    const { min, max } = bounds
    let minDepth = Number.POSITIVE_INFINITY
    let maxDepth = Number.NEGATIVE_INFINITY
    for (let i = 0; i < this.corners.length; i += 1) {
      const corner = this.corners[i]
      corner.set(
        (i & 1) === 0 ? min.x : max.x,
        (i & 2) === 0 ? min.y : max.y,
        (i & 4) === 0 ? min.z : max.z,
      ).applyMatrix4(camera.matrixWorldInverse)
      const depth = -corner.z
      minDepth = Math.min(minDepth, depth)
      maxDepth = Math.max(maxDepth, depth)
    }

    bounds.getSize(this.size)
    camera.getWorldDirection(this.forward)
    const diagonal = this.size.length()
    // Orthographic X/Y scale is independent of eye distance, so retreating
    // along the unchanged view direction can make behind-eye geometry visible
    // without changing target, orientation, zoom, or apparent framing.
    // Perspective scale is distance-dependent: applying the same move there
    // would silently reframe the model, so that unsupported state refuses by
    // name and leaves the camera untouched.
    const eyeMargin = Math.max(1e-3, diagonal * 0.01)
    if (perspective.isPerspectiveCamera === true && minDepth <= 0) {
      return { ok: false, reason: 'camera-depth-refused-perspective-behind-eye' }
    }
    const retreatedBy = orthographic.isOrthographicCamera === true && minDepth <= eyeMargin
      ? eyeMargin - minDepth
      : 0
    const correctedMinDepth = minDepth + retreatedBy
    const correctedMaxDepth = maxDepth + retreatedBy
    const depthSpan = correctedMaxDepth - correctedMinDepth
    const padding = Math.max(1e-3, diagonal * 0.01, depthSpan * 0.05)
    const nearPadding = Math.min(padding, correctedMinDepth * 0.5)
    const near = Math.max(1e-6, correctedMinDepth - nearPadding)
    const far = correctedMaxDepth + padding

    if (![minDepth, maxDepth, diagonal, retreatedBy, near, far].every(Number.isFinite)
      || !finiteVector3(this.forward)
      || this.forward.lengthSq() < 1e-12
      || !(0 < near && near < correctedMinDepth && correctedMaxDepth < far)) {
      return { ok: false, reason: 'camera-depth-refused-nonfinite-result' }
    }

    if (retreatedBy > 0) camera.position.addScaledVector(this.forward, -retreatedBy)
    projection.near = near
    projection.far = far
    projection.updateProjectionMatrix()
    camera.updateMatrixWorld(true)
    return {
      ok: true,
      corrected: retreatedBy > 0,
      retreatedBy,
      near,
      far,
      minDepth: correctedMinDepth,
      maxDepth: correctedMaxDepth,
    }
  }
}

type CameraSceneSafetyControls = Pick<OrbitControls,
  'target' | 'mouseButtons' | 'touches' | 'enabled' | 'enablePan' | 'addEventListener' | 'removeEventListener'
>

export interface CameraSceneSafety {
  applyDepthSafety(): CameraDepthPolicyResult | null
  onBoundsChanged(): CameraDepthPolicyResult | null
  bindControls(controls: CameraSceneSafetyControls): CameraDepthPolicyResult | null
  isPivotCentered(): boolean
  dispose(): void
}

/** One production seam for every sectionable-body change that can invalidate
 * the camera slab. The real runtime and the source-connected delete gate both
 * use this class, so register/unregister coverage cannot stop at call recording. */
export class SectionableCameraDepthLifecycle {
  private readonly boundsCache: VisibleBodyBoundsCache
  private readonly cameraSafety: CameraSceneSafety

  constructor(
    boundsCache: VisibleBodyBoundsCache,
    cameraSafety: CameraSceneSafety,
  ) {
    this.boundsCache = boundsCache
    this.cameraSafety = cameraSafety
  }

  register(mesh: THREE.Mesh): CameraDepthPolicyResult | null {
    this.boundsCache.register(mesh)
    return this.cameraSafety.onBoundsChanged()
  }

  syncGeometry(mesh: THREE.Mesh): CameraDepthPolicyResult | null {
    this.boundsCache.syncGeometry(mesh)
    return this.cameraSafety.onBoundsChanged()
  }

  setVisible(mesh: THREE.Mesh, visible: boolean): CameraDepthPolicyResult | null {
    this.boundsCache.setVisible(mesh, visible)
    return this.cameraSafety.onBoundsChanged()
  }

  unregister(mesh: THREE.Mesh): CameraDepthPolicyResult | null {
    this.boundsCache.unregister(mesh)
    return this.cameraSafety.onBoundsChanged()
  }
}

/** UI-81C: the production addObject/removeObject depth enrollment seam.
 * Tests drive this same class without constructing WebGLRenderer, so a
 * mutation that stops a visible scene object reaching CameraSceneSafety
 * fails on the real consumer path rather than on a duplicated policy. */
export class VisibleSceneDepthLifecycle {
  private readonly depthExtentRoots: DepthExtentRoots
  private readonly cameraSafety: CameraSceneSafety

  constructor(
    depthExtentRoots: DepthExtentRoots,
    cameraSafety: CameraSceneSafety,
  ) {
    this.depthExtentRoots = depthExtentRoots
    this.cameraSafety = cameraSafety
  }

  register(obj: THREE.Object3D): CameraDepthPolicyResult | null {
    this.depthExtentRoots.register(obj, true)
    return this.cameraSafety.onBoundsChanged()
  }

  unregister(obj: THREE.Object3D): CameraDepthPolicyResult | null {
    this.depthExtentRoots.unregister(obj)
    return this.cameraSafety.onBoundsChanged()
  }
}

export interface VisibleSceneObjectEnrollment {
  addObject(obj: THREE.Object3D): void
  removeObject(obj: THREE.Object3D): void
}

/** UI-81C-R1: the injectable default-runtime scene ownership boundary.
 * WebGLRenderer cannot be constructed in jsdom, so the real runtime publishes
 * these exact methods while the enrollment gate injects only Scene and render.
 * There is one lifecycle: deleting either production register/unregister call
 * below makes the source-connected gate fail. */
export function createVisibleSceneObjectEnrollment(args: {
  scene: Pick<THREE.Scene, 'add' | 'remove'>
  depthLifecycle: Pick<VisibleSceneDepthLifecycle, 'register' | 'unregister'>
  requestRender: () => void
}): VisibleSceneObjectEnrollment {
  const { scene, depthLifecycle, requestRender } = args
  return {
    addObject: (obj) => {
      // WO UI-35: CAD bodies use the live normal-based rig above and never
      // participate in shadow maps. Setting both flags explicitly prevents
      // a material or renderer default from reintroducing body self-shadow.
      if (obj instanceof THREE.Mesh) {
        obj.castShadow = false
        obj.receiveShadow = false
      }
      scene.add(obj)
      // addObject is the production scene-ownership boundary. Enroll every
      // root once here so bodies, edge overlays, genesis glyphs, finished
      // sketches, active sketch roots, and future previews cannot render
      // without also contributing to camera depth.
      depthLifecycle.register(obj)
      requestRender()
    },
    removeObject: (obj) => {
      scene.remove(obj)
      depthLifecycle.unregister(obj)
      requestRender()
    },
  }
}

/** UI-49: owns the depth-change listener and pan-end pivot state as one
 *  lifecycle unit. Rebinding removes old control/canvas listeners before
 *  installing one fresh set; the change guard refuses recursive dispatch. */
export function createCameraSceneSafety(args: {
  getCamera: () => THREE.Camera
  controls: CameraSceneSafetyControls
  canvas: HTMLElement
  boundsCache: VisibleBodyBoundsCache
  /** WO UI-72: non-body roots that must also survive the near/far slab. Omitted
   *  by callers with no sketch surfaces (the depth pass then behaves exactly as
   *  it did before this WO). */
  depthExtentRoots?: DepthExtentRoots
  onControlsChange?: () => void
  onRefusal?: (reason: CameraDepthRefusalReason) => void
}): CameraSceneSafety {
  const policy = new CameraDepthPolicy()
  const depthBounds = new THREE.Box3()
  const projectedCenter = new THREE.Vector3()
  const modelCenter = new THREE.Vector3()
  const recaptureDelta = new THREE.Vector3()
  const activeTouches = new Set<number>()
  let controls = args.controls
  let disposed = false
  let handlingChange = false
  let mousePanPointer: number | null = null
  let touchGesturePanned = false
  let pivotCentered = false
  type DepthPlanes = { near: number; far: number }
  type DepthProjectionCamera = THREE.Camera
    & Pick<THREE.PerspectiveCamera, 'near' | 'far' | 'updateProjectionMatrix'>
    & Partial<Pick<THREE.PerspectiveCamera, 'isPerspectiveCamera'>>
    & Partial<Pick<THREE.OrthographicCamera, 'isOrthographicCamera'>>
  const initialProjection = args.getCamera() as DepthProjectionCamera
  const initialProjectionSupported = initialProjection.isPerspectiveCamera === true
    || initialProjection.isOrthographicCamera === true
  let baselineDepthPlanes: DepthPlanes | null = initialProjectionSupported
    && validCameraDepthPlanes(
      initialProjection.near,
      initialProjection.far,
      initialProjection.isOrthographicCamera === true,
    )
    ? { near: initialProjection.near, far: initialProjection.far }
    : null
  let policyOwnedDepthPlanes: DepthPlanes | null = null

  const sameDepthPlanes = (left: DepthPlanes, right: DepthPlanes): boolean =>
    left.near === right.near && left.far === right.far

  const applyDepthSafety = (): CameraDepthPolicyResult | null => {
    if (disposed) return null
    const projection = args.getCamera() as DepthProjectionCamera
    const currentDepthPlanes = { near: projection.near, far: projection.far }
    if (projection.isPerspectiveCamera !== true && projection.isOrthographicCamera !== true) {
      const refusal = { ok: false, reason: 'camera-depth-refused-unsupported-camera' } as const
      args.onRefusal?.(refusal.reason)
      return refusal
    }
    if (!validCameraDepthPlanes(
      currentDepthPlanes.near,
      currentDepthPlanes.far,
      projection.isOrthographicCamera === true,
    )) {
      const refusal = { ok: false, reason: INVALID_AUTHORED_DEPTH_SLAB } as const
      args.onRefusal?.(refusal.reason)
      return refusal
    }

    // A depth slab is policy-owned only while it is bit-identical to the last
    // slab this policy wrote. Any other valid slab came from an external owner
    // (debug restore, projection swap, or another camera authoring path), so it
    // becomes the baseline and is never "repaired" merely for differing from
    // construction defaults.
    if (policyOwnedDepthPlanes === null || !sameDepthPlanes(currentDepthPlanes, policyOwnedDepthPlanes)) {
      baselineDepthPlanes = currentDepthPlanes
      policyOwnedDepthPlanes = null
    }

    const snapshot = args.boundsCache.snapshot()
    if (!snapshot.ok) {
      args.onRefusal?.(snapshot.reason)
      return snapshot
    }
    const extra = args.depthExtentRoots?.snapshot()
    if (extra !== undefined && !extra.ok) {
      args.onRefusal?.(extra.reason)
      return extra
    }

    // With no visible body, preserve the UI-72 arm-A no-op for a never-fitted
    // camera whose only registered roots are legacy/manual probes. UI-81C
    // explicitly enrolls every production scene root for body-less fitting:
    // those roots are real renderables (datum, sketch, edge, preview, grid),
    // so fit them rather than silently clipping them behind the eye.
    if (snapshot.bounds === null) {
      if (extra?.bounds != null && extra.fitWithoutBody) {
        const result = policy.apply(args.getCamera(), extra.bounds)
        if (!result.ok) args.onRefusal?.(result.reason)
        else policyOwnedDepthPlanes = { near: result.near, far: result.far }
        return result
      }
      // If a body fit did happen, restore only while the current slab is still
      // the exact temporary slab this policy owns. An externally authored slab
      // clears that ownership above and remains untouched.
      if (policyOwnedDepthPlanes === null || baselineDepthPlanes === null) return null
      projection.near = baselineDepthPlanes.near
      projection.far = baselineDepthPlanes.far
      projection.updateProjectionMatrix()
      policyOwnedDepthPlanes = null
      return {
        ok: true,
        corrected: true,
        retreatedBy: 0,
        near: baselineDepthPlanes.near,
        far: baselineDepthPlanes.far,
        minDepth: baselineDepthPlanes.near,
        maxDepth: baselineDepthPlanes.far,
      }
    }

    // WO UI-72 (Operator N-33) ROOT-CAUSE FIX. Before this, the slab was fitted to
    // BODY bounds alone while the sketch grid/overlay extend well past them
    // (grid = max(200mm, 5x the face size hint), a 20mm part => a ~27mm slab
    // around a 200mm grid). Head-on that clips nothing -- the grid plane sits at
    // one constant camera depth -- so the defect only appears once the user
    // TILTS and the grid starts spanning depth. Union those roots in so the
    // slab covers everything the camera actually draws.
    let bounds = snapshot.bounds
    if (extra?.bounds != null) {
      bounds = depthBounds.copy(snapshot.bounds).union(extra.bounds)
    }

    const result = policy.apply(args.getCamera(), bounds)
    if (!result.ok) args.onRefusal?.(result.reason)
    else policyOwnedDepthPlanes = { near: result.near, far: result.far }
    return result
  }

  const onControlsChange = (): void => {
    if (disposed || handlingChange) return
    handlingChange = true
    try {
      applyDepthSafety()
      args.onControlsChange?.()
    } finally {
      handlingChange = false
    }
  }

  const syncCenteredModeAtGestureStart = (): void => {
    const snapshot = args.boundsCache.snapshot()
    if (!snapshot.ok || snapshot.bounds === null) return
    snapshot.bounds.getCenter(modelCenter)
    if (controls.target.distanceToSquared(modelCenter) <= 1e-18) pivotCentered = true
  }

  const finishPan = (): void => {
    const snapshot = args.boundsCache.snapshot()
    if (!snapshot.ok) {
      args.onRefusal?.(snapshot.reason)
      return
    }
    if (snapshot.bounds === null) return

    const camera = args.getCamera()
    const rect = args.canvas.getBoundingClientRect()
    const width = rect.width || args.canvas.clientWidth || 1
    const height = rect.height || args.canvas.clientHeight || 1
    const shorter = Math.min(width, height)
    if (![width, height, shorter].every(Number.isFinite) || shorter <= 0) return

    snapshot.bounds.getCenter(modelCenter)
    camera.updateMatrixWorld(true)
    projectedCenter.copy(modelCenter).project(camera)
    if (!finiteVector3(projectedCenter)) return
    const radialPx = Math.hypot(projectedCenter.x * width * 0.5, projectedCenter.y * height * 0.5)
    const enterPx = shorter * 0.08
    const releasePx = shorter * 0.12

    if (radialPx <= enterPx) {
      recaptureDelta.copy(modelCenter).sub(controls.target)
      camera.position.add(recaptureDelta)
      controls.target.copy(modelCenter)
      camera.updateMatrixWorld(true)
      pivotCentered = true
      applyDepthSafety()
      args.onControlsChange?.()
    } else if (pivotCentered && radialPx > releasePx) {
      pivotCentered = false
    }
  }

  const mouseAction = (event: PointerEvent): THREE.MOUSE | null | undefined => {
    if (event.button === 0) return controls.mouseButtons.LEFT
    if (event.button === 1) return controls.mouseButtons.MIDDLE
    if (event.button === 2) return controls.mouseButtons.RIGHT
    return undefined
  }

  const onPointerDown = (event: PointerEvent): void => {
    if (disposed || controls.enabled === false || controls.enablePan === false) return
    if (event.pointerType === 'touch') {
      activeTouches.add(event.pointerId)
      const action = activeTouches.size === 1 ? controls.touches.ONE : controls.touches.TWO
      if (action === THREE.TOUCH.PAN || action === THREE.TOUCH.DOLLY_PAN) {
        touchGesturePanned = true
        syncCenteredModeAtGestureStart()
      }
      return
    }
    if (willResolveToPan(mouseAction(event), {
      shift: event.shiftKey,
      ctrl: event.ctrlKey,
      meta: event.metaKey,
    })) {
      mousePanPointer = event.pointerId
      syncCenteredModeAtGestureStart()
    }
  }

  const onPointerUp = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') {
      activeTouches.delete(event.pointerId)
      if (activeTouches.size === 0 && touchGesturePanned) finishPan()
      if (activeTouches.size === 0) touchGesturePanned = false
      return
    }
    if (mousePanPointer !== event.pointerId) return
    mousePanPointer = null
    finishPan()
  }

  const onPointerCancel = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') {
      activeTouches.delete(event.pointerId)
      // Any canceled contact invalidates the whole multi-touch completion;
      // a later pointer-up from a surviving finger is not a completed pan.
      touchGesturePanned = false
    } else if (mousePanPointer === event.pointerId) {
      mousePanPointer = null
    }
  }

  const addListeners = (): void => {
    controls.addEventListener('change', onControlsChange)
    args.canvas.addEventListener('pointerdown', onPointerDown, { capture: true })
    args.canvas.addEventListener('pointerup', onPointerUp, { capture: true })
    args.canvas.addEventListener('pointercancel', onPointerCancel, { capture: true })
  }

  const removeListeners = (): void => {
    controls.removeEventListener('change', onControlsChange)
    args.canvas.removeEventListener('pointerdown', onPointerDown, { capture: true } as EventListenerOptions)
    args.canvas.removeEventListener('pointerup', onPointerUp, { capture: true } as EventListenerOptions)
    args.canvas.removeEventListener('pointercancel', onPointerCancel, { capture: true } as EventListenerOptions)
  }

  addListeners()
  return {
    applyDepthSafety,
    onBoundsChanged: applyDepthSafety,
    bindControls: (nextControls) => {
      if (disposed) return null
      removeListeners()
      controls = nextControls
      mousePanPointer = null
      activeTouches.clear()
      touchGesturePanned = false
      addListeners()
      return applyDepthSafety()
    },
    isPivotCentered: () => pivotCentered,
    dispose: () => {
      if (disposed) return
      removeListeners()
      mousePanPointer = null
      activeTouches.clear()
      touchGesturePanned = false
      disposed = true
    },
  }
}

export interface SceneRuntime {
  scene: THREE.Scene
  camera: THREE.Camera
  addObject(obj: THREE.Object3D): void
  removeObject(obj: THREE.Object3D): void
  requestRender(): void
  /** Drawing-buffer ratio used by every screen-space overlay in this scene. */
  getPixelRatio?(): number
  /** WO INT-13B (spec 3.2 step 5, "stop rendering"): quiesce this runtime while
   *  its workspace is the SUSPENDED one. This host is genuinely render-on-demand
   *  (no idle rAF loop), so "stop" means detaching the render TRIGGER: every
   *  render path -- the controls'-change trigger routed through
   *  createCameraSceneSafety's onControlsChange, addObject/removeObject, resize,
   *  and any requestRender() caller -- goes through the one `render` closure,
   *  which becomes a no-op. Also stops the sketch-session frame drive, the only
   *  rAF loop this host ever runs (it would otherwise keep drawing an invisible
   *  scene every frame for a suspended workspace with an open sketch).
   *
   *  Does NOT dispose, unmount, touch the camera, or exit a sketch session: the
   *  pose and selection survive by not being disturbed (D3.1), which is what
   *  makes re-entry instant. Idempotent. */
  suspendRender(): void
  /** WO INT-13B (spec 3.2): the exact inverse of suspendRender, in reverse
   *  order -- reattaches the render trigger, restores the sketch frame drive if a
   *  session was driving one at suspend, and issues ONE catch-up render so the
   *  resumed workspace shows any state that changed while it was quiet.
   *  Idempotent. */
  resumeRender(): void
  /** WO INT-13B: gate seam for B2b/B1 -- lets a harness read the real suspension
   *  state rather than inferring it from frame counts. */
  isRenderSuspended(): boolean
  /** ndcX/ndcY in [-1, 1] normalized device coords. Pure camera-projection
   *  math, no DOM lookups -- callers derive ndc from their own pointer event. */
  screenToRay(ndcX: number, ndcY: number): RayLike
  /** Project a world-space point to canvas-relative pixel coordinates (top-left
   *  origin, matching PointerEvent.clientX/Y minus the canvas's own offset).
   *  Returns null if the point projects behind the camera. WO INT-1: lets a
   *  caller (or a headless test driver) target a real screen pixel for a
   *  known body without guessing where it landed after import -- no fake
   *  raycasting, the projection uses the SAME camera the real pick path
   *  reads from. */
  projectToCanvas(point: Vec3Like): { x: number; y: number } | null
  /** WO INT-1 "visual section": set (or clear with []) the active clip
   *  plane(s). Cheap-and-honest per architect ruling 1 -- a real three.js
   *  clip, not a kernel-exact section curve (that lands with UI-4).
   *
   *  WO UI-H1: applied as PER-MATERIAL (local) clipping to every registered
   *  sectionable object, never `renderer.clippingPlanes` (global) -- a
   *  global plane clips EVERY material unconditionally (three.js has no
   *  per-object opt-out of it, see WebGLClipping.setState), which would also
   *  clip the stencil-cap quad this method builds/repositions below even
   *  though that quad is deliberately coplanar with the section plane
   *  (clipping a coincident quad is a coin-flip on which fragments survive --
   *  exactly the z-fighting class this WO exists to kill). Only the FIRST
   *  plane drives the cap (Lab3DView only ever drives one axis at a time);
   *  additional planes still clip geometry, just without a cap. */
  setClipPlanes(planes: THREE.Plane[]): void
  /** WO UI-H1: register a body's visible Mesh + edge-overlay LineSegments so
   *  (a) their materials track setClipPlanes() (local, not global -- see
   *  above), and (b) the Mesh gets stencil-cap helper meshes -- SAME
   *  BufferGeometry, invisible (colorWrite false) -- so a clipped closed
   *  body reads as a SOLID with a rendered cap on the cut plane instead of
   *  exposing its FrontSide-only interior walls as a hollow shell (Operator's
   *  M1 field-report defect 1). Call once per body, alongside addObject. */
  registerSectionable(mesh: THREE.Mesh, edgeLines: THREE.LineSegments): void
  /** Call after reassigning `mesh.geometry` in place (progressive
   *  tessellation refine) so the stencil-cap helpers registered above --
   *  separate Mesh instances sharing that BufferGeometry -- stay in lockstep
   *  instead of capping the PRIOR tier's now-disposed geometry. */
  syncSectionGeometry(mesh: THREE.Mesh): void
  /** Mirror a body's visibility toggle (BodyListPanel) onto its bounds and
   *  stencil-cap helpers. The runtime derives topology-only surface
   *  suppression from the mesh material without widening this frozen
   *  interface. */
  setSectionableVisible(mesh: THREE.Mesh, visible: boolean): void
  /** Unregister + dispose a body's stencil-cap helpers (call on body
   *  dispose, alongside removeObject(mesh)/removeObject(edgeLines)). */
  unregisterSectionable(mesh: THREE.Mesh, edgeLines: THREE.LineSegments): void
  /** Re-center and re-distance the camera/controls so `min..max` (world-space
   *  bbox) fills the view -- run once after a body imports so Operator doesn't
   *  have to hunt for it before orbiting. Keeps the current view DIRECTION,
   *  only changes distance/target. */
  frameBox(min: Vec3Like, max: Vec3Like): void
  /** WO SKC-5 (Q6): current camera pose (position + orbit target) -- the
   *  transient save/restore pair a sketch-edit session uses; NEVER persisted
   *  to the document (Operator rejected camera-persist 2026-07-02 -- this stays
   *  entirely in-memory, same as every other pre-SKC-5 camera state). */
  getCameraPose(): { position: Vec3Like; target: Vec3Like }
  setCameraPose(pose: { position: Vec3Like; target: Vec3Like }): void
  /** Full, projection-specific camera state for the debug repro channel. */
  getDebugCameraState(): DebugCameraState
  /** Restore a validated debug camera exactly, including projection subtype,
   *  authored up vector, and orthographic frustum/zoom/clip planes. */
  setDebugCameraState(state: DebugCameraState): void
  /** WO SKC-5 (Q6): orient the camera normal-to `frame` on sketch entry --
   *  looking along -normal at frame.origin, with frame's own local Y axis
   *  (planeMath.ts's `normal x xDir` convention) as camera "up" so the
   *  sketch's local up reads as screen-up. `sizeHint` (a rough in-plane
   *  radius, e.g. the projected face's bounding radius) sets viewing
   *  distance; a tiny/absent hint falls back to a sane minimum so a small
   *  face is still framed usably (mirrors frameBox's own margin factor). */
  orientNormalToPlane(frame: PlaneFrame, sizeHint?: number): void
  /** WO UI-23 (C3): same camera move as orientNormalToPlane, for a pick that
   *  has a point + normal but no authored PlaneFrame/xDir (an arbitrary body
   *  face) -- `up` is derived deterministically (stableUpForNormal) instead
   *  of read off a frame's xDir. Also the base-plane-glyph path: a glyph
   *  click passes that plane's `{origin, normal}` from BASE_PLANE_FRAMES. */
  orientNormalToPoint(point: Vec3Like, normal: Vec3Like, sizeHint?: number): void
  /** WO SKC-5 (Q6): true if the user has actually orbited/panned/zoomed
   *  (OrbitControls' own 'start' event -- fires ONLY on real pointer/wheel
   *  interaction, never on a programmatic camera move like frameBox or
   *  orientNormalToPlane, which only ever fire 'change') since the last
   *  resetUserOrbited() call. This is what lets sketch-exit honestly decide
   *  "restore the saved pose" vs "the user already moved the camera, leave
   *  it" (Q6's own distinction) without misreading a programmatic move as a
   *  user one. */
  hasUserOrbited(): boolean
  resetUserOrbited(): void
  /** WO SKC-5-R1 (Finding 1, BK-26 one-coherent-feel): route this runtime's
   *  OrbitControls through the SAME app-wide NAV_PRESETS table + invert
   *  settings every other viewport uses -- via the shared
   *  navPresetController.ts engine, never a forked mapping. Callers
   *  re-invoke this whenever appSettings.navPreset/invertZoom/invertPan
   *  change (mirrors src/components/viewport/Viewport.tsx's own effect). */
  applyNavPreset(presetId: NavPresetId, invertZoom: boolean, invertPan: boolean): void
  /** WO UI-5: lets a caller (the push/pull gizmo) disable OrbitControls while
   *  a face-edit drag is in flight -- same "disable navigation during a
   *  competing drag gesture" contract TranslateGizmo's own onDraggingChange
   *  seam documents for its caller, just routed through the runtime instead
   *  of a bespoke per-caller controls reference (SceneRuntime already owns
   *  the OrbitControls instance; nothing outside this module may reach it
   *  directly). Additive -- no existing caller passes dragging state today. */
  setOrbitEnabled(enabled: boolean): void
  /** WO SKC-11 (Operator T-SKC-PARITY finding 3): suppress/restore orbit rotation for the duration of
   *  a sketch-geometry drag -- mirrors CNCViewport's sketchSavedEnableRotate save/restore, but
   *  scoped to ONE drag gesture instead of the whole sketch session (Operator: view rotation stays
   *  available BETWEEN drags, just never DURING one). Idempotent both ways: a second
   *  suppressed(true) while already suppressed does not clobber the saved value with `false`, and
   *  suppressed(false) when not currently suppressed is a no-op -- callers invoke this from every
   *  drag-end/abort path (pointer-up, pointer-leave, Escape, tool switch, sketch-exit) without
   *  each one needing to know whether a drag/suppression was actually in progress. */
  setDragOrbitSuppressed(suppressed: boolean): void
  /** WO SKC-15B: the ONE handle the mounted Sketcher package needs -- a LIVE view of the orbit
   *  controls' `enableRotate` flag, and nothing else.
   *
   *  `SketcherHost.controls` is typed `{ enableRotate: boolean }`, so the package can suppress
   *  rotation without ever learning that an OrbitControls exists. This returns a getter/setter view
   *  onto the real flag rather than the controls object itself, because "SceneRuntime already owns
   *  the OrbitControls instance; nothing outside this module may reach it directly"
   *  (setOrbitEnabled's own doc, above) -- widening the interface to hand out OrbitControls would
   *  give every caller the whole camera.
   *
   *  DISTINCT FROM `setDragOrbitSuppressed`: that one is this module's own save/restore state
   *  machine, used by the push/pull gizmo and the OLD inline sketch drag machine. The sketcher
   *  package brought its own arbiter (lib/sketch/sketcher/orbitArbiter.ts) when it took ownership of
   *  camera policy, so it needs the raw flag, not a second suppression stack layered on this one.
   *  Two stacks over one flag is the interleaving bug this returns a plain view to avoid. */
  sketchOrbitHandle(): { enableRotate: boolean }
  /** WO UI-17 (criterion 4, the live-feedback root cause): start the per-frame
   *  render drive for a sketch session -- a rAF loop that calls `onFrame`
   *  (the page's sketcher.onFrame bridge) and then renders, CAM-parity with
   *  CNCViewport.startRenderLoop (CNCViewport.ts:5251-5268). Started at
   *  session begin, STOPPED at session end -- the on-demand render model
   *  stays for all non-sketch use, so an idle workbench never free-runs. */
  startSketchFrameDrive(onFrame: () => void): void
  stopSketchFrameDrive(): void
  /** WO UI-17 (acceptance 2): total frames actually rendered -- the
   *  frame-count seam the frame-drive test asserts on. */
  frameCount(): number
  /** WO UI-17 (criterion 6): drive the camera to a documented preset pose
   *  (presetCameraPosition), keeping the current target + distance. The
   *  ViewCube bridge dispatches these. */
  setCameraView(view: WorkbenchViewName): void
  /** WO UI-17 (criterion 8): show (frame != null) or remove (null) the
   *  sketch-plane grid -- buildPlaneGrid oriented by the session plane. */
  setSketchGrid(frame: PlaneFrame | null, spacingMm?: number, sizeMm?: number): void
  /** The live grid group, or null -- the acceptance test's quaternion probe. */
  getSketchGrid(): THREE.Object3D | null
  /** WO UI-72 (Operator note N-33): declare `obj` as a non-body scene root that must
   *  stay inside the camera's near/far slab. The depth policy otherwise fits the
   *  slab to BODY bounds alone, which silently clips anything reaching past the
   *  model once the camera tilts -- the sketch grid and the sketch overlay both
   *  do. The sketch grid registers itself in setSketchGrid; the sketch overlay
   *  root is registered by its host at session enter. Registering re-fits the
   *  slab immediately, so a root never enters clipped.
   *  NOT the same question as VisibleBodyBoundsCache, which stays bodies-only on
   *  purpose: it also drives orbit pivot-centering, which must keep centering on
   *  the MODEL, not on a 200mm grid around it. */
  registerDepthExtent(obj: THREE.Object3D): void
  /** WO UI-72: counterpart to registerDepthExtent. MUST be called before the
   *  root's geometry is disposed. */
  unregisterDepthExtent(obj: THREE.Object3D): void
  /** WO UI-72 acceptance seam: RAW depth numbers read off the SAME live camera
   *  the renderer draws with -- the near/far slab, and the camera-space depth of
   *  the eight corners of each registered depth-extent root's world box.
   *  Deliberately returns raw numbers and NOT a boolean verdict: the "is it
   *  clipped" comparison belongs to the acceptance harness, so the gate cannot
   *  pass by agreeing with a duplicate of the code under test. A GPU clip is
   *  otherwise only observable as absent pixels, which is exactly the weak proxy
   *  the pre-fix bug hid behind. */
  getDepthClipProbe(): DepthClipProbe
  /** WO UI-17 (Q-15): flag a live sketch session so the liencnc-default
   *  preset's RIGHT button orbits for its duration -- see
   *  applySketchRightDragOrbitOverride. Other presets are untouched. */
  setSketchRightDragOrbit(active: boolean): void
  /** WO UI-23 (C4): the live camera projection -- 'perspective' at construction, always. */
  getCameraProjection(): CameraProjectionMode
  /** WO UI-23 (C4): swap projection while PRESERVING the apparent view --
   *  the orbit target stays centered and the visible extent AT the target's
   *  depth (half-height = distance * tan(fov/2) for perspective, matched to
   *  the orthographic frustum/zoom) is kept within tolerance, not reset.
   *  Rebuilds the camera + OrbitControls (an OrthographicCamera and a
   *  PerspectiveCamera are different THREE.Camera subclasses -- there is no
   *  in-place conversion) and re-applies the current nav preset + every gate
   *  (sketch right-drag override, free orbit) onto the new controls, so
   *  behavior is identical to before the swap for everything except the
   *  projection itself. A no-op when `mode` already matches. */
  setCameraProjection(mode: CameraProjectionMode): void
  dispose(): void
}

export type CreateSceneRuntime = (canvas: HTMLCanvasElement) => SceneRuntime

/** WO-2095: the runtime currently drawing on each canvas. A canvas has exactly one WebGL
 *  context for its whole life, so a canvas a new runtime has taken over must keep it. */
const canvasOwners = new WeakMap<HTMLCanvasElement, object>()

/** WO-2095: give a closed view's WebGL context back to the browser once its canvas has
 *  left the page. renderer.dispose() alone keeps the context alive until the browser
 *  collects the canvas, so every closed Model view counted toward the browser's cap
 *  ("Too many active WebGL contexts. Oldest context will be lost." after ~8 New / Model
 *  cycles, 2026-09-27). A canvas still in the page is NOT released: React's dev double
 *  mount (and any host that keeps its canvas) builds the next runtime on the same element,
 *  and getContext() would hand it the lost context -- WebGLRenderer then throws on
 *  construction. The extension is reached through the raw context, so the release does
 *  not depend on three's bookkeeping surviving renderer.dispose() (the order trap
 *  ViewCube.tsx and CNCViewport.ts measured with renderer.forceContextLoss()). */
function releaseContextWhenCanvasLeaves(canvas: HTMLCanvasElement, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
  const release = (): void => {
    if (canvas.isConnected || canvasOwners.has(canvas) || gl.isContextLost()) return
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
  if (!canvas.isConnected) release()
  else setTimeout(release, 0)
}

/** Real implementation: canvas + WebGLRenderer + Z-up PerspectiveCamera +
 *  OrbitControls + render-on-demand, no rAF loop -- the exact bootstrap style
 *  already proven by src/cam3d/dev/devPage.ts's startViewer(). */
export const createDefaultSceneRuntime: CreateSceneRuntime = (canvas) => {
  const scene = new THREE.Scene()
  // WO INT-13B (D1.2, background reconciliation): resolve the SAME shared design
  // token CNCViewport's clear color resolves (--vp-canvas, CNCViewport.ts:147 via
  // theme/viewportColors) instead of the hard-coded 0x101418 that used to live
  // here. The two were never intentionally different -- they were one digit apart
  // (0x101418 vs --vp-canvas #111418), which is exactly the "two products bolted
  // together" tell D1.2 names, and unnoticeable until D1 put both surfaces one
  // tab click apart. Sharing the token means they cannot drift again.
  scene.background = new THREE.Color(asNumber('--vp-canvas'))

  // stencil:true -- required for the section stencil-cap technique below
  // (default WebGLRenderer stencil buffer is OFF); localClippingEnabled --
  // every clip-aware material below sets its OWN clippingPlanes (never
  // renderer.clippingPlanes, see setClipPlanes doc) so this just turns local
  // clipping evaluation on at all.
  //
  // The reusable controller lives in lib/viewport/sectionCaps.ts; every host
  // that installs it must explicitly request a stencil buffer.
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, stencil: true })
  const canvasOwner = {}
  canvasOwners.set(canvas, canvasOwner)
  // WO INT-13B (D1.2, the performance half): clamp to match CNCViewport.ts:438.
  // This was unclamped `window.devicePixelRatio`, which was defensible while the
  // workbench was the ONLY thing on the page (the standalone ?lab3d route). Under
  // D1 it co-resides with the clamped CAM viewport, and on a 3x-DPR display an
  // unclamped renderer draws ~9x the pixels of a 2x-clamped one -- a genuine
  // cliff, paid on the machine least able to afford it. min(dpr, 2) is the
  // app-wide rule; the workbench is no longer an exception to it.
  renderer.setPixelRatio(rendererDpr())
  renderer.localClippingEnabled = true
  // WO UI-35: CAD viewport bodies use normal-based form lighting, not
  // shadow maps. Besides removing the visible self-shadow artifact, keeping
  // the map disabled avoids an extra scene render for every shadow-casting
  // light. A future explicit contact-shadow pass can opt back in without
  // changing the body policy below.
  //
  // WO INT-13B (D1.2): shadows are a DELIBERATE per-host difference, not drift.
  // CNCViewport enables them (PCFShadowMap, CNCViewport.ts:439-444) because the
  // CAM view renders STOCK and wants that realism; the workbench renders design
  // bodies under UI-35's form-lighting policy above and would only gain the
  // self-shadow artifact UI-35 removed. Kept divergent ON PURPOSE, recorded here
  // so a future reader does not "fix" it into agreement.
  renderer.shadowMap.enabled = false

  // WO INT-13B (D1.2, tone-mapping reconciliation): adopt CNCViewport's tone
  // mapping (CNCViewport.ts:445-446) so the two surfaces grade colour the same
  // way. Unlike shadows/stencil above, this is NOT a defensible per-host
  // difference: it is a whole-image transfer curve, so the SAME body colour, the
  // SAME theme token and the SAME material would resolve to two different pixels
  // depending only on which tab the operator is standing in -- the "bolted
  // together" tell D1.2 exists to remove, and now visible one tab click apart.
  //
  // USER-VISIBLE: this changes how the workbench grades (ACES compresses
  // highlights and lifts the midtones relative to no tone mapping), so it is
  // flagged for the design-cohesion audit / Operator's visual verdict rather than
  // claimed as a silent no-op. It is the direction the spec's D1.2 table names,
  // and CAM is the surface with the larger installed look.
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  // One exposure is part of the shared modeled-body studio profile.
  renderer.toneMappingExposure = MODELED_BODY_STUDIO_EXPOSURE

  // WO UI-23 (C4): `let`, not `const` -- setCameraProjection below rebuilds
  // both the camera (a THREE.PerspectiveCamera and THREE.OrthographicCamera
  // are different Object3D subclasses; there is no in-place conversion) and
  // the OrbitControls bound to it. Every closure below (render, resize,
  // frameBox, applyNav, etc.) reads these two variables at CALL time, so a
  // rebuild is picked up everywhere automatically -- nothing else needs to
  // change when the projection swaps.
  let camera: THREE.Camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000)
  camera.up.set(0, 0, 1) // Z-up, matching engine convention
  camera.position.set(85, -85, 65)
  camera.lookAt(0, 0, 0)

  let controls = new OrbitControls(camera, canvas)
  controls.target.set(0, 0, 0)
  controls.update()
  // WO UI-23 (C4): tracks which camera subtype is currently live, so
  // setCameraProjection can no-op a redundant call and getCameraProjection
  // has an answer.
  let projectionMode: CameraProjectionMode = 'perspective'

  // WO SKC-5-R1 (Finding 1): same shared engine CNCViewport.applyNavPreset
  // delegates to -- see navPresetController.ts. Applied once here with the
  // app default; SolidsWorkbenchPage re-applies on every appSettings
  // navPreset/invertZoom/invertPan change, same pattern as Viewport.tsx.
  //
  // WO UI-17 (Q-15): the last-applied preset args are remembered so the
  // sketch-session right-drag-orbit override can be layered ON TOP of the
  // preset mapping and re-derived whenever EITHER input changes (a settings
  // change mid-session, a session begin/end) -- navController.apply always
  // resets mouseButtons to the preset's own mapping first, so turning the
  // override off is just a re-apply.
  //
  // WO UI-17-R1 (finding 1): the override ARMS (RIGHT -> null) and the gate
  // below decides WHEN the drag becomes an orbit -- same threshold constant
  // the frozen package's contextmenu classifier uses. The gate is created
  // AFTER the first applyNav so its capture-phase pointerdown listener
  // registers after navPresetController's modifier remapper would (same-node
  // capture listeners fire in registration order): if both ever ran for one
  // event, the gate's write would win. Today they cannot conflict at all --
  // the remapper only installs for modifierRules presets and the gate only
  // enables on liencnc-default, which has none.
  let navController: NavPresetController = createWorkbenchNavController(controls, canvas)
  let lastNav: { presetId: NavPresetId; invertZoom: boolean; invertPan: boolean } = {
    presetId: 'liencnc-default', invertZoom: false, invertPan: false,
  }
  let sketchRightDragOrbit = false
  let rightDragGate = createSketchRightDragOrbitGate(controls, canvas)
  const applyNav = (): void => {
    navController.apply(lastNav.presetId, lastNav.invertZoom, lastNav.invertPan)
    // WO UI-23 (C1): unconditional -- both inside and outside a sketch
    // session -- applied AFTER the shared preset apply so it always wins over
    // liencnc-default's static MIDDLE=zoom, and BEFORE the sketch override/
    // gate below (which only ever touches RIGHT, so ordering between the two
    // cannot matter, but this keeps every MIDDLE-vs-RIGHT override grouped).
    applyWorkbenchMiddleDragOverride(controls.mouseButtons, lastNav.presetId)
    applySketchRightDragOrbitOverride(controls.mouseButtons, lastNav.presetId, sketchRightDragOrbit)
    rightDragGate.setEnabled(sketchRightDragOrbit && lastNav.presetId === 'liencnc-default')
  }
  applyNav()
  // WO UI-23 (C2): free (pole-continuous) orbit -- rebuilt on every
  // projection swap (setCameraProjection), disposed alongside the other
  // gates below.
  let freeOrbit = installFreeOrbit(controls, camera, canvas)

  // WO SKC-5 (Q6): 'start' fires only on a real user-initiated orbit/pan/
  // zoom gesture (OrbitControls' own event, distinct from 'change' which
  // ALSO fires on every programmatic camera.position/controls.target write
  // this file makes, e.g. frameBox/orientNormalToPlane below) -- see
  // hasUserOrbited's own doc comment on the SceneRuntime interface.
  let userOrbited = false
  const onControlsStart = (): void => {
    userOrbited = true
  }
  controls.addEventListener('start', onControlsStart)

  // WO SKC-11: saved enableRotate for the ACTIVE drag suppression only (null = not currently
  // suppressed) -- see setDragOrbitSuppressed's own interface doc for why this must be idempotent.
  let dragSuppressedEnableRotate: boolean | null = null

  // GEO-23 L1: image-based-lighting base. RoomEnvironment baked to a PMREM cube
  // becomes scene.environment, so every MeshStandardMaterial body samples real
  // irradiance from EVERY direction -- orbit to a bottom/side face and it is lit
  // "from the space" (Operator's ask), never the near-black a fixed all-above rig
  // left it. One-time bake at construction; disposed below.
  const environment: ViewportEnvironment = installViewportEnvironment(
    renderer,
    scene,
    MODELED_BODY_STUDIO_ENV_INTENSITY,
  )

  // The environment and these lights stay fixed in world space. Orbiting the
  // camera therefore moves broad highlights across faces and compresses them
  // over fillets instead of carrying a light with the camera.
  const workbenchRig = buildModeledBodyStudioRig()
  scene.add(workbenchRig.hemisphere, ...workbenchRig.accents)

  const raycaster = new THREE.Raycaster()
  const projector = new THREE.Vector3()

  // WO UI-17 (acceptance 2): every render -- on-demand or frame-driven --
  // bumps this counter. The frame-drive test reads it through frameCount().
  let renderedFrames = 0
  /** WO INT-13B (spec 3.2 step 5): true while this workspace is suspended. */
  let renderSuspended = false
  const render = (): void => {
    // WO INT-13B: the ONE choke point every render path in this runtime goes
    // through (controls-change via cameraSafety.onControlsChange, addObject/
    // removeObject, resize, orient*, setCameraView, the sketch frame drive, and
    // every external requestRender caller). Gating HERE is what makes "stop
    // rendering" total rather than a list of trigger sites someone must
    // remember to extend -- a new render path added later is suspended by
    // construction. renderedFrames deliberately does not advance either: it is
    // the seam B4 reads to prove a suspended workspace repainted zero times.
    if (renderSuspended) return
    renderedFrames += 1
    renderer.render(scene, camera)
  }

  // WO-1200: scene.background is a THREE.Color snapshot, whereas the CSS
  // custom property is live. Observe both orthogonal token selectors so a
  // mounted Model workspace repaints its canvas when either changes; the
  // palette remains solely in tokens.css.
  const colorModeObserver = typeof MutationObserver === 'undefined' || typeof document === 'undefined'
    ? null
    : new MutationObserver(() => {
      scene.background = new THREE.Color(asNumber('--vp-canvas'))
      render()
    })
  colorModeObserver?.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'data-color-mode'],
  })

  const visibleBodyBounds = new VisibleBodyBoundsCache()
  const depthExtentRoots = new DepthExtentRoots()
  const cameraSafety = createCameraSceneSafety({
    getCamera: () => camera,
    controls,
    canvas,
    boundsCache: visibleBodyBounds,
    depthExtentRoots,
    onControlsChange: render,
    onRefusal: (reason) => console.warn('[camera-scene-safety]', { reason }),
  })
  const sectionableCameraDepth = new SectionableCameraDepthLifecycle(visibleBodyBounds, cameraSafety)
  const visibleSceneCameraDepth = new VisibleSceneDepthLifecycle(depthExtentRoots, cameraSafety)
  const visibleSceneObjects = createVisibleSceneObjectEnrollment({
    scene,
    depthLifecycle: visibleSceneCameraDepth,
    requestRender: render,
  })

  // WO UI-17 (criterion 4): the sketch session's frame drive. null = no loop
  // running (the workbench's at-rest on-demand model). The callback is the
  // page's sketcher.onFrame bridge; controls.update() runs first, mirroring
  // CNCViewport.startRenderLoop's own per-frame order.
  let frameDriveId: number | null = null
  /** WO INT-13B: the live session's onFrame bridge, remembered so a SUSPEND can
   *  pause the loop and a RESUME can restart the same drive. This is what makes
   *  "pause the loop" (suspend) distinguishable from "the session ended" (stop):
   *  a suspended workspace with an open sketch must come back driving, and only
   *  a real session end clears the callback. */
  let frameDriveOnFrame: (() => void) | null = null

  /** Cancel the rAF handle but KEEP frameDriveOnFrame -- the session is still
   *  open, this workspace is merely quiet. */
  const pauseSketchFrameDrive = (): void => {
    if (frameDriveId !== null) {
      cancelAnimationFrame(frameDriveId)
      frameDriveId = null
    }
  }

  /** Start (or restart) the drive. Refuses when already driving, when no session
   *  registered a callback, and -- critically -- while suspended, so a sketch
   *  opened/resumed against a suspended workspace cannot sneak a live rAF loop
   *  past spec 3.2 step 5. */
  const runSketchFrameDrive = (): void => {
    if (frameDriveId !== null || frameDriveOnFrame === null || renderSuspended) return
    const animate = (): void => {
      frameDriveId = requestAnimationFrame(animate)
      controls.update()
      frameDriveOnFrame?.()
      render()
    }
    animate()
  }

  /** Real session end: stop driving AND forget the callback, so a later resume
   *  does not revive a drive for a session that no longer exists. */
  const stopSketchFrameDrive = (): void => {
    pauseSketchFrameDrive()
    frameDriveOnFrame = null
  }

  const forEachInteractionOverlayRoot = (
    visit: (overlay: THREE.Object3D) => void,
  ): void => {
    scene.traverse((object) => {
      if (object.userData.isInteractionOverlay !== true) return
      if (object.parent?.userData.isInteractionOverlay === true) return
      visit(object)
    })
  }

  // WO UI-17 (criterion 8): the live sketch-plane grid group, or null.
  let sketchGrid: THREE.Group | null = null
  const removeSketchGrid = (): void => {
    if (sketchGrid === null) return
    // WO UI-72: unregister BEFORE the scene detach + dispose, so no depth pass
    // can ever read a root whose geometry is already disposed.
    visibleSceneCameraDepth.unregister(sketchGrid)
    scene.remove(sketchGrid)
    sketchGrid.traverse((obj) => {
      const withGeom = obj as Partial<THREE.Mesh>
      withGeom.geometry?.dispose()
      const material = withGeom.material
      if (Array.isArray(material)) material.forEach((m) => m.dispose())
      else material?.dispose()
    })
    sketchGrid = null
  }
  const resize = (): void => {
    const w = canvas.clientWidth || 1
    const h = canvas.clientHeight || 1
    renderer.setSize(w, h, false)
    resizeSceneCameraProjection(camera, w, h)
    cameraSafety.applyDepthSafety()
    // GEO-25: keep every fat-line body-edge overlay's stroke width correct
    // after a resize -- LineMaterial.resolution must track the renderer
    // drawing-buffer size in DEVICE pixels (mirrors CNCViewport.ts's
    // handleResize). No-op when every body is on the classic thin-edge path
    // (nothing to traverse matches LineMaterial).
    const dpr = renderer.getPixelRatio()
    const resX = w * dpr
    const resY = h * dpr
    scene.traverse((o) => {
      const mat = (o as { material?: unknown }).material
      if (mat instanceof LineMaterial) mat.resolution.set(resX, resY)
    })
    forEachInteractionOverlayRoot((overlay) => {
      syncInteractionResolution(overlay, { width: resX, height: resY })
    })
    render()
  }
  window.addEventListener('resize', resize)
  const stopObservingViewportResize = observeSceneViewportResize(canvas, resize)
  const stopObservingRendererDpr = observeRendererDpr(() => {
    renderer.setPixelRatio(rendererDpr())
    resize()
  })
  resize()

  // WO UI-H1: the shared stencil controller renders a real cut-face cap from
  // closed body tessellation. It keeps its helpers outside body pick trees and
  // follows each body's live world matrix before drawing.
  const sectionCaps = createSectionCapController(scene)

  const rebindCameraControls = (target: THREE.Vector3): OrbitControls => {
    // Tear down every gate/listener bound to the OLD camera/controls, then
    // rebuild only after camera.up is final. Projection swaps and debug-camera
    // restore must stay on this one path because OrbitControls caches
    // object.up-derived state at construction.
    freeOrbit.dispose()
    rightDragGate.dispose()
    navController.dispose()
    controls.removeEventListener('start', onControlsStart)
    controls.dispose()

    controls = new OrbitControls(camera, canvas)
    controls.target.copy(target)
    controls.update()
    navController = createWorkbenchNavController(controls, canvas)
    rightDragGate = createSketchRightDragOrbitGate(controls, canvas)
    applyNav()
    freeOrbit = installFreeOrbit(controls, camera, canvas)
    controls.addEventListener('start', onControlsStart)
    cameraSafety.bindControls(controls)
    return controls
  }

  const setCameraProjection = (mode: CameraProjectionMode): void => {
    if (mode === projectionMode) return
    const w = canvas.clientWidth || 1
    const h = canvas.clientHeight || 1
    const aspect = w / h
    const target = controls.target.clone()
    const newCamera = buildProjectionSwapCamera(camera, target, mode, aspect)

    camera = newCamera
    rebindCameraControls(target)
    projectionMode = mode
    render()
  }

  return {
    scene,
    // WO UI-23 (C4): a LIVE getter, not a captured value -- setCameraProjection
    // reassigns the `camera` closure variable on a projection swap, and every
    // reader of `runtime.camera` (PushPullGizmo, the ViewCube bridge) must see
    // the CURRENT camera on its very next read, not the one from mount time.
    get camera() {
      return camera
    },
    addObject: visibleSceneObjects.addObject,
    removeObject: visibleSceneObjects.removeObject,
    requestRender: render,
    getPixelRatio: () => renderer.getPixelRatio(),
    screenToRay: (ndcX, ndcY) => {
      raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera)
      const { origin, direction } = raycaster.ray
      return {
        origin: { x: origin.x, y: origin.y, z: origin.z },
        direction: { x: direction.x, y: direction.y, z: direction.z },
      }
    },
    projectToCanvas: (point) => {
      projector.set(point.x, point.y, point.z).project(camera)
      if (projector.z > 1) return null // behind the camera (projected z outside NDC clip range)
      const rect = canvas.getBoundingClientRect()
      const w = rect.width || canvas.clientWidth || 1
      const h = rect.height || canvas.clientHeight || 1
      return {
        x: ((projector.x + 1) / 2) * w,
        y: ((1 - projector.y) / 2) * h,
      }
    },
    setClipPlanes: (planes) => {
      const localPlanes = planes.length > 0 ? [...planes] : null
      sectionCaps.setPlanes(planes)
      forEachInteractionOverlayRoot((overlay) => {
        syncInteractionClipping(overlay, localPlanes)
      })
      render()
    },
    registerSectionable: (mesh, edgeLines) => {
      // GEO-23 L4: bake per-vertex AO into this body + patch its material here (the
      // in-scope seam where sceneRuntime first sees a fully-built body mesh). The
      // shared controller's stencil helpers reuse mesh.geometry but use Basic
      // materials that never sample the AO attribute, so this is body-only.
      applyBodyAO(mesh)
      const meshMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      const edgeMaterials = Array.isArray(edgeLines.material) ? edgeLines.material : [edgeLines.material]
      sectionCaps.register(mesh, [...meshMaterials, ...edgeMaterials])
      sectionableCameraDepth.register(mesh)
      render()
    },
    syncSectionGeometry: (mesh) => {
      // GEO-23 L4: geometry was replaced (re-tessellation) -- rebake AO for the new
      // buffers so an edited body keeps its hole-depth cue.
      applyBodyAO(mesh)
      sectionCaps.syncGeometry(mesh)
      sectionableCameraDepth.syncGeometry(mesh)
      render()
    },
    setSectionableVisible: (mesh, visible) => {
      sectionCaps.setVisible(mesh, visible)
      sectionableCameraDepth.setVisible(mesh, visible)
      render()
    },
    unregisterSectionable: (mesh, edgeLines) => {
      void edgeLines
      sectionCaps.unregister(mesh)
      sectionableCameraDepth.unregister(mesh)
      render()
    },
    frameBox: (min, max) => {
      applyFrameBox(camera, controls, min, max, canvas.clientWidth || 1, canvas.clientHeight || 1)
      render()
    },
    getCameraPose: () => ({
      position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
      target: { x: controls.target.x, y: controls.target.y, z: controls.target.z },
    }),
    getDebugCameraState: () => captureDebugCameraState(camera, controls.target),
    setDebugCameraState: (state) => {
      setCameraProjection(state.projection)
      controls = restoreDebugCameraState(
        camera,
        controls,
        state,
        (_previousControls, target) => rebindCameraControls(target),
      )
      render()
    },
    setCameraPose: (pose) => {
      camera.position.set(pose.position.x, pose.position.y, pose.position.z)
      controls.target.set(pose.target.x, pose.target.y, pose.target.z)
      camera.up.set(0, 0, 1) // restores the app's normal Z-up convention (orientNormalToPlane may have changed it)
      camera.lookAt(controls.target)
      controls.update()
      render()
    },
    orientNormalToPlane: (frame, sizeHint) => {
      const origin = new THREE.Vector3(frame.origin.x, frame.origin.y, frame.origin.z)
      const normal = new THREE.Vector3(frame.normal.x, frame.normal.y, frame.normal.z).normalize()
      const yDirRaw = planeYDir(frame)
      const up = new THREE.Vector3(yDirRaw.x, yDirRaw.y, yDirRaw.z)
      const radius = Math.max(sizeHint ?? 0, 10) // sane minimum so a tiny/unmeasured face still frames usably
      const distance = distanceForRadius(camera, radius)
      camera.up.copy(up)
      camera.position.copy(origin).addScaledVector(normal, distance)
      controls.target.copy(origin)
      camera.lookAt(origin)
      controls.update()
      render()
    },
    orientNormalToPoint: (point, normal, sizeHint) => {
      applyOrientNormalToPoint(camera, controls, point, normal, sizeHint)
      render()
    },
    hasUserOrbited: () => userOrbited,
    resetUserOrbited: () => {
      userOrbited = false
    },
    applyNavPreset: (presetId, invertZoom, invertPan) => {
      lastNav = { presetId, invertZoom, invertPan }
      applyNav()
      // navPresetController may add/remove its capture-phase modifier
      // resolver here. Rebinding puts pan recognition after that resolver so
      // it reads the action OrbitControls will actually execute.
      cameraSafety.bindControls(controls)
    },
    startSketchFrameDrive: (onFrame) => {
      if (frameDriveOnFrame !== null) return // already driving -- one loop, ever
      frameDriveOnFrame = onFrame
      runSketchFrameDrive()
    },
    stopSketchFrameDrive,
    // WO INT-13B (spec 3.2 steps 5-6, and its exact inverse on resume).
    suspendRender: () => {
      if (renderSuspended) return
      // Order mirrors the spec's "quiesce, do not destroy": stop the only rAF
      // loop this host runs FIRST (so no in-flight frame can slip a render past
      // the flag), then close the render gate.
      pauseSketchFrameDrive()
      renderSuspended = true
    },
    resumeRender: () => {
      if (!renderSuspended) return
      renderSuspended = false
      // Inverse order: open the gate, revive the drive (a no-op unless a session
      // was actually driving at suspend -- frameDriveOnFrame survives a pause but
      // not a real session end), then ONE catch-up render. The catch-up matters:
      // every requestRender() issued while suspended was dropped, so without it
      // the resumed workspace could show a stale frame until the user happens to
      // move the camera.
      runSketchFrameDrive()
      render()
    },
    isRenderSuspended: () => renderSuspended,
    frameCount: () => renderedFrames,
    setCameraView: (view) => {
      applyPresetCameraView(camera, controls, view)
      render()
    },
    setSketchGrid: (frame, spacingMm = 10, sizeMm = 200) => {
      removeSketchGrid()
      if (frame !== null) {
        sketchGrid = buildPlaneGrid(frame, spacingMm, sizeMm)
        scene.add(sketchGrid)
        // WO UI-72: the grid is the widest thing in a sketch session and is not
        // a body, so it must be re-fitted into the near/far slab HERE -- and the
        // slab must be recomputed now, not at the next orbit, or the grid enters
        // clipped and only heals when the user happens to move the camera.
        visibleSceneCameraDepth.register(sketchGrid)
      }
      cameraSafety.onBoundsChanged()
      render()
    },
    getSketchGrid: () => sketchGrid,
    registerDepthExtent: (obj) => {
      visibleSceneCameraDepth.register(obj)
      render()
    },
    unregisterDepthExtent: (obj) => {
      // A host may retire its explicit sketch-session registration before it
      // detaches the same root from the scene. addObject's UI-81C enrollment
      // remains authoritative for that brief cleanup tail: visible geometry
      // cannot fall out of the slab between the two synchronous calls.
      if (contributesToRender(obj)) visibleSceneCameraDepth.register(obj)
      else visibleSceneCameraDepth.unregister(obj)
      render()
    },
    getDepthClipProbe: () => {
      camera.updateMatrixWorld(true)
      const corner = new THREE.Vector3()
      // `camera` is the ortho|perspective union; both carry near/far, and the
      // depth policy writes to whichever is live through the same projection
      // narrowing. Read them off the same object rather than re-deriving.
      const projection = camera as THREE.PerspectiveCamera | THREE.OrthographicCamera
      return {
        near: projection.near,
        far: projection.far,
        cameraPosition: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
        roots: depthExtentRoots.perRootBoxes().map(({ name, box }) => {
          const cornerDepths: number[] = []
          for (let i = 0; i < 8; i += 1) {
            corner.set(
              (i & 1) === 0 ? box.min.x : box.max.x,
              (i & 2) === 0 ? box.min.y : box.max.y,
              (i & 4) === 0 ? box.min.z : box.max.z,
            ).applyMatrix4(camera.matrixWorldInverse)
            cornerDepths.push(-corner.z)
          }
          return { name, cornerDepths }
        }),
      }
    },
    setSketchRightDragOrbit: (active) => {
      if (sketchRightDragOrbit === active) return
      sketchRightDragOrbit = active
      applyNav()
    },
    getCameraProjection: () => projectionMode,
    setCameraProjection,
    setOrbitEnabled: (enabled) => {
      controls.enabled = enabled
    },
    setDragOrbitSuppressed: (suppressed) => {
      if (suppressed) {
        if (dragSuppressedEnableRotate === null) dragSuppressedEnableRotate = controls.enableRotate
        controls.enableRotate = false
      } else if (dragSuppressedEnableRotate !== null) {
        controls.enableRotate = dragSuppressedEnableRotate
        dragSuppressedEnableRotate = null
      }
    },
    // A live view, not a snapshot: the package writes through it during a sketch session and the
    // real OrbitControls reads the result on its very next pointermove.
    sketchOrbitHandle: () => ({
      get enableRotate() {
        return controls.enableRotate
      },
      set enableRotate(v: boolean) {
        controls.enableRotate = v
      },
    }),
    dispose: () => {
      colorModeObserver?.disconnect()
      stopSketchFrameDrive()
      removeSketchGrid()
      stopObservingViewportResize()
      stopObservingRendererDpr()
      window.removeEventListener('resize', resize)
      controls.removeEventListener('start', onControlsStart)
      cameraSafety.dispose()
      rightDragGate.dispose()
      freeOrbit.dispose()
      navController.dispose()
      sectionCaps.dispose()
      // GEO-23 L1: free the PMREM environment texture (detaches scene.environment).
      environment.dispose()
      controls.dispose()
      const gl = renderer.getContext()
      renderer.dispose()
      if (canvasOwners.get(canvas) === canvasOwner) canvasOwners.delete(canvas)
      releaseContextWhenCanvasLeaves(canvas, gl)
    },
  }
}
