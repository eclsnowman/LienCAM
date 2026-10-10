// WO SKC-15B (S3), item 1: the workbench's `SketcherHost`.
//
// A mount supplies only the four surface primitives plus camera handles. CAM implements this over an
// OrthographicCamera locked to a top view; the workbench implements it over a PERSPECTIVE camera
// raycasting onto a datum-plane frame. Neither may do anything else for the sketcher: no tool logic,
// no painting, no pointer state.
//
// ---- THE OVERLAY ROOT IS THE PLANE FRAME (the SKC-15 report's trap) ---------------------------
//
// `Sketcher`'s constructor does `host.overlayRoot.add(this.layer.group)`, and `SketchOverlayPainter`
// parents to the same root. The sketch layer draws in sketch-LOCAL 2D coordinates (z = 0). So
// `overlayRoot` is a per-session `THREE.Group` whose world matrix IS the plane frame: local (u, v)
// then lands at `origin + u*xDir + v*yDir` in world space, for free, for the layer AND every overlay
// the painter builds. Nothing has to project anything.
//
// That also makes `clientToPlaneWorld` exactly what its doc comment says for this mount -- "raycast
// onto the datum frame" -- followed by `worldToLocal(frame, p)` (planeMath.ts already owns that
// math). The component then inverse-maps through the layer's display pose, which is identity here.
//
// ---- worldPerPixel IS NOT CAM's ---------------------------------------------------------------
//
// CAM's camera is orthographic, so one world mm spans a constant number of pixels. The workbench's
// is a PerspectiveCamera: the scale depends on how far the plane origin is from the eye. Every
// pick/snap tolerance in the package scales by this number, so getting it wrong makes snapping feel
// broken at one zoom level and dead at another.
//
//     worldPerPixel = 2 * tan(fov/2) * distanceToPlaneOrigin / clientHeight
//
// which is the standard perspective frustum height at a given depth, divided by the pixel height.
import * as THREE from 'three'
import type { SketcherHost, SketcherCameraPose, Vec2 } from '../../../lib/sketch/sketcher'
import { SKETCH_Z } from '../../../lib/sketch/sketcher'
import type { PlaneFrame } from '../../../sketch3d/planeMath'
import { localToWorld, planeYDir, worldToLocal } from '../../../sketch3d/planeMath'
import type { SceneRuntime } from '../sceneRuntime'

/** Minimum world-per-pixel, so a degenerate canvas (height 0 before first layout) can never emit 0
 *  or Infinity into every snap tolerance in the package. Charter item 3: validate data at the accept
 *  point -- a NaN/0 tolerance compares false in BOTH directions and snapping dies silently. */
const MIN_WORLD_PER_PIXEL = 1e-6

/** A `THREE.Group` whose transform IS `frame`. The sketch layer's local 2D coords render in 3D. */
export function makePlaneFrameGroup(frame: PlaneFrame): THREE.Group {
  const group = new THREE.Group()
  applyFrameToGroup(group, frame)
  return group
}

export function applyFrameToGroup(group: THREE.Group, frame: PlaneFrame): void {
  const xDir = new THREE.Vector3(frame.xDir.x, frame.xDir.y, frame.xDir.z).normalize()
  const normal = new THREE.Vector3(frame.normal.x, frame.normal.y, frame.normal.z).normalize()
  const yRaw = planeYDir(frame)
  const yDir = new THREE.Vector3(yRaw.x, yRaw.y, yRaw.z).normalize()
  // Columns are the frame's own basis; the 4th is its origin. Matches worldToLocal/localToWorld.
  const m = new THREE.Matrix4().makeBasis(xDir, yDir, normal)
  m.setPosition(frame.origin.x, frame.origin.y, frame.origin.z)
  group.matrix.copy(m)
  group.matrixAutoUpdate = false
  group.updateMatrixWorld(true)
}

export interface WorkbenchSketcherHostOptions {
  canvas: HTMLCanvasElement
  /** The positioned ancestor the marquee <div> parents to, and the surface the package attaches its
   *  overlay gestures (dimension-label drag, context menu) to. */
  container: HTMLElement
  runtime: SceneRuntime
  /** The per-session group whose matrix is the plane frame. Also the scene node the layer lives in. */
  overlayRoot: THREE.Group
  /** The plane the session draws on. Read live, so a session can be re-framed without a new host. */
  getFrame: () => PlaneFrame
  /** Rough in-plane radius used to choose the normal-to-plane viewing distance. */
  getSizeHint?: () => number | undefined
}

function localPlanePoint(frame: PlaneFrame, at: Vec2, localZ: number): THREE.Vector3 {
  const world = localToWorld(frame, at)
  const normal = new THREE.Vector3(frame.normal.x, frame.normal.y, frame.normal.z).normalize()
  return new THREE.Vector3(world.x, world.y, world.z).addScaledVector(normal, localZ)
}

/**
 * Build the host. NOT a React value: the page creates exactly one per sketch session, inside an
 * effect, and disposes it on exit. Nothing here is rebuilt per render.
 */
export function createWorkbenchSketcherHost(opts: WorkbenchSketcherHostOptions): SketcherHost {
  const { canvas, container, runtime, overlayRoot, getFrame } = opts
  const raycaster = new THREE.Raycaster()
  const plane = new THREE.Plane()
  const hit = new THREE.Vector3()

  return {
    domElement: canvas,
    container,
    // The workbench renders <SketcherOverlays/> as a child of the canvas's positioned parent, so the
    // container IS the overlay surface. (Do-not-redo: never wrap <SketcherOverlays/> in a div.)
    overlayHost: container,
    overlayRoot,
    camera: runtime.camera,
    // The live enableRotate view. SceneRuntime never hands out its OrbitControls.
    controls: runtime.sketchOrbitHandle(),

    // WO SKC-15B: the workbench wants orbit available BETWEEN drags and never DURING one
    // (Operator, T-SKC-PARITY finding 3). CAM leaves this undefined and keeps its session-wide
    // suppression. See lib/sketch/sketcher/orbitArbiter.ts.
    orbitPolicy: 'drag',

    /** Screen client px -> sketch-LOCAL mm on the plane.
     *
     * WO SKC-55: raycasts the plane LIFTED by SKETCH_Z along the normal -- the same height the
     * live SketchLayer group actually renders at (sketchLayer.ts's `group.position.z = SKETCH_Z`)
     * -- not the true datum plane at zero lift. At a square-on pose the two planes are parallel
     * to the ray and produce an identical (u, v); at a tilt, intersecting the DATUM plane (the old
     * behavior) lands the ray's hit point away from where the layer's pixels actually render, by
     * exactly the `SKETCH_Z * tan(theta)` parallax Operator's repro measured. Every gesture funnels
     * through this one raycast (clientToLocal in sketchInteraction.ts, and the composed
     * clientToPlaneLocal callback in index.ts that feeds SketchLayer.pick()), so drawing, dragging,
     * marquee corners, and click-select are ALL corrected together by construction, not just picks.
     */
    clientToPlaneWorld: (clientX: number, clientY: number): Vec2 => {
      const frame = getFrame()
      const rect = canvas.getBoundingClientRect()
      const w = rect.width || canvas.clientWidth || 1
      const h = rect.height || canvas.clientHeight || 1
      const ndcX = ((clientX - rect.left) / w) * 2 - 1
      const ndcY = -(((clientY - rect.top) / h) * 2 - 1)
      raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), runtime.camera)
      const normal = new THREE.Vector3(frame.normal.x, frame.normal.y, frame.normal.z).normalize()
      const liftedCoplanarPoint = new THREE.Vector3(frame.origin.x, frame.origin.y, frame.origin.z)
        .addScaledVector(normal, SKETCH_Z)
      plane.setFromNormalAndCoplanarPoint(normal, liftedCoplanarPoint)
      const p = raycaster.ray.intersectPlane(plane, hit)
      // The ray is PARALLEL to the sketch plane (the user orbited exactly edge-on). There is no
      // point under the cursor. Return the plane origin rather than NaN: every snap tolerance in the
      // package compares against this, and `NaN > tol` is false in BOTH directions, so a NaN here
      // would sail silently through every guard and land in the document (charter item 3).
      if (p === null) return { x: 0, y: 0 }
      // worldToLocal projects (p - frame.origin) onto xDir/yDir only (planeMath.ts) -- both
      // orthogonal to `normal`, so the SKETCH_Z-along-normal component of `p` contributes nothing
      // to the result. The (u, v) below is the honest in-plane parallax shift, not a Z leak.
      const local = worldToLocal(frame, { x: p.x, y: p.y, z: p.z })
      if (!Number.isFinite(local.x) || !Number.isFinite(local.y)) return { x: 0, y: 0 }
      return local
    },

    /** World mm spanned by one screen pixel at a sketch-local point. Perspective scale varies
     *  across an oblique plane, while orthographic scale comes directly from the live frustum. */
    worldPerPixel: (at = { x: 0, y: 0 }, localZ = 0): number => {
      const frame = getFrame()
      const cam = runtime.camera
      const rect = canvas.getBoundingClientRect()
      const h = rect.height || canvas.clientHeight || 0
      if (!(h > 0)) return MIN_WORLD_PER_PIXEL

      if (cam instanceof THREE.OrthographicCamera) {
        const wpp = Math.abs(cam.top - cam.bottom) / (h * Math.max(cam.zoom, MIN_WORLD_PER_PIXEL))
        return Number.isFinite(wpp) && wpp > MIN_WORLD_PER_PIXEL ? wpp : MIN_WORLD_PER_PIXEL
      }

      if (cam instanceof THREE.PerspectiveCamera) {
        const cameraPoint = localPlanePoint(frame, at, localZ).applyMatrix4(cam.matrixWorldInverse)
        const depth = -cameraPoint.z
        if (!(Number.isFinite(depth) && depth > MIN_WORLD_PER_PIXEL)) return MIN_WORLD_PER_PIXEL
        const frustumHeight = 2 * Math.tan((cam.getEffectiveFOV() * Math.PI) / 360) * depth
        const wpp = frustumHeight / h
        return Number.isFinite(wpp) && wpp > MIN_WORLD_PER_PIXEL ? wpp : MIN_WORLD_PER_PIXEL
      }

      // A generic Camera is only a test/future seam; retain its named unit-scale behavior.
      return 1
    },

    projectToScreen: (at, localZ = 0): Vec2 | null => {
      const rect = canvas.getBoundingClientRect()
      const w = rect.width || canvas.clientWidth || 0
      const h = rect.height || canvas.clientHeight || 0
      if (!(w > 0 && h > 0)) return null
      const ndc = localPlanePoint(getFrame(), at, localZ).project(runtime.camera)
      if (![ndc.x, ndc.y, ndc.z].every(Number.isFinite)) return null
      return { x: ((ndc.x + 1) / 2) * w, y: ((1 - ndc.y) / 2) * h }
    },

    // ---- Camera POLICY hooks: the component decides WHEN, the host knows HOW ----
    saveCameraPose: (): SketcherCameraPose => runtime.getCameraPose(),

    /**
     * WO SKC-15C: the ONE owner of "put the camera back when the sketch ends", and the one place the
     * Q6 rule lives: **restore the entry pose UNLESS the user deliberately orbited during the
     * session.** Operator, T-SKC-PARITY finding 3 / WO SKC-5 Q6: "finish restores unless user moved it".
     *
     * THE DEFECT THIS FIXES. `Sketcher.exit()` calls this hook unconditionally. SolidsWorkbenchPage
     * ALSO kept its own `savedCameraPoseRef` and its own conditional restore in `finishPackageSketch`
     * -- but the package's restore ran first, so the page's `hasUserOrbited()` check never decided
     * anything: finishing a package sketch yanked the camera back to the entry pose even when the
     * user had deliberately tumbled the part. It went unnoticed because the only Q6 test in the tree
     * (SolidsWorkbenchPage.sketchCamera.test.tsx) drove the OLD inline session, which had no package
     * restore behind it. Routing sketch-on-face through the package (the SKC-15C severing) pointed
     * that test at this code path and it went red immediately. Two owners of one decision; the
     * quieter one won.
     *
     * `hasUserOrbited()` is a one-way latch that `frameNormalToPlane()` resets on entry (so the
     * programmatic normal-to-plane move is never mistaken for a user orbit), which is exactly the
     * "did the user move it DURING this session" question.
     *
     * CAM IS UNTOUCHED: this is the workbench's host. CAM's sketch host is built in CNCViewport (a
     * frozen file) and has its own `restoreCameraPose`. Under CAM's default `orbitPolicy: 'session'`
     * rotation is disabled for the whole session anyway, so "the user orbited" cannot arise there.
     */
    restoreCameraPose: (pose: SketcherCameraPose): void => {
      if (runtime.hasUserOrbited()) return
      runtime.setCameraPose(pose as { position: { x: number; y: number; z: number }; target: { x: number; y: number; z: number } })
    },
    frameNormalToPlane: (): void => {
      runtime.orientNormalToPlane(getFrame(), opts.getSizeHint?.())
      // A programmatic move must not read as a user orbit: `hasUserOrbited()` is a one-way latch and
      // the page's finish path consults it before restoring the saved pose.
      runtime.resetUserOrbited()
    },

    onSessionEnter: (): void => {
      runtime.addObject(overlayRoot)
      // WO UI-72 (Operator note N-33 reported sketch ITEMS clipping too, not just
      // the grid): sketch entities live on the sketch plane, so they reach past
      // the body exactly like the grid does and the body-fitted near/far slab
      // clips them by the same mechanism. depthTest:false does NOT exempt them
      // -- that disables the depth-buffer TEST, while near/far clipping happens
      // in clip space before it. Registering the root (not each entity) is what
      // keeps this correct as the user draws: the extent is re-read per depth
      // pass, so entities added later are covered with no resync call.
      runtime.registerDepthExtent(overlayRoot)
      runtime.requestRender()
    },
    onSessionExit: (): void => {
      runtime.unregisterDepthExtent(overlayRoot)
      runtime.removeObject(overlayRoot)
      runtime.requestRender()
    },
  }
}
