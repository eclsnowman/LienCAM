// WO UI-3: thin adapter over three.js TransformControls (same package as
// OrbitControls, already a dependency -- see sceneRuntime.ts -- so wrapping
// it here adds no new dependency). Mirrors src/lib/viewport/CNCViewport.ts's
// existing stock-gizmo usage (read-only reference: TransformControls
// constructor, .attach()/.detach(), 'change' + 'dragging-changed' events),
// with one difference -- this uses the public getHelper() accessor instead
// of reaching into the private _root field CNCViewport.ts's tcRoot() casts
// to (this three.js version exposes getHelper() directly; CNCViewport.ts
// predates that, per its own r184+ API-change comment).
//
// The adapter interface (not the concrete class) is what TranslateGizmo.tsx
// depends on, so tests can inject a jsdom-safe fake -- jsdom lacks
// setPointerCapture/PointerEvent capture semantics real TransformControls
// relies on, same "second fake-injection point" rationale sceneRuntime.ts
// documents for createSceneRuntime.
//
// WO-2507: three's rotate rings turn by (drag in world units) x 20 / (gizmo to
// camera distance). That suits a perspective camera, where the distance is what
// the operator sees. An orthographic camera's distance is never seen (the Model
// screen's depth safety parks it tens of metres back so nothing clips) and its
// zoom is not in the formula, so in Form a ring drag turned the selection by
// thousandths of a degree: "grabbing the rotation handle doesn't seem to work".
// With an orthographic camera the drag is measured from the perspective distance
// that shows the same view instead (the 45 deg reverse of
// buildProjectionSwapCamera in sceneRuntime.ts), so a ring turns as far per pixel
// at any zoom or camera distance. Move and Scale measure where the pointer meets
// the gizmo's plane and never read the distance: unchanged.

import * as THREE from 'three'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'

export interface TransformControlsAdapter {
  readonly object: THREE.Object3D | undefined
  enabled: boolean
  addEventListener(type: string, listener: (event: { value?: boolean }) => void): void
  removeEventListener(type: string, listener: (event: { value?: boolean }) => void): void
  attach(target: THREE.Object3D): void
  detach(): void
  setMode(mode: 'translate' | 'rotate' | 'scale'): void
  setSpace(space: 'world' | 'local'): void
  /** The renderable Object3D to add to the scene (three.js's own public
   *  accessor -- see header comment). */
  getHelper(): THREE.Object3D
  dispose(): void
}

export type CreateTransformControlsAdapter = (
  camera: THREE.Camera,
  domElement: HTMLElement,
) => TransformControlsAdapter

/** The perspective viewing distance (45 deg) that shows what this orthographic camera shows; null for any other camera. */
export function orthographicSeenDistance(camera: THREE.Camera): number | null {
  const ortho = camera as THREE.OrthographicCamera
  if (ortho.isOrthographicCamera !== true) return null
  const halfHeight = Math.max((ortho.top - ortho.bottom) / 2 / Math.max(ortho.zoom, 1e-6), 1e-3)
  return halfHeight / Math.tan((45 * Math.PI) / 360)
}

/** The parts of three's TransformControls the ring-rate correction reads (public at runtime, untyped here). */
interface RingDragInternals {
  camera: THREE.Camera
  mode: 'translate' | 'rotate' | 'scale'
  worldPosition: THREE.Vector3
  pointerMove(pointer: { x: number; y: number; button: number } | null): void
}

/** With an orthographic camera, a rotate drag reads the gizmo as standing at the seen distance from the camera. */
function ringDragAsSeen(controls: RingDragInternals): void {
  const move = controls.pointerMove.bind(controls)
  const held = new THREE.Vector3()
  const cameraAt = new THREE.Vector3()
  controls.pointerMove = (pointer) => {
    const seen = controls.mode === 'rotate' ? orthographicSeenDistance(controls.camera) : null
    const at = controls.worldPosition
    cameraAt.setFromMatrixPosition(controls.camera.matrixWorld)
    if (seen === null || at.distanceToSquared(cameraAt) < 1e-18) { move(pointer); return }
    // the rotate step reads worldPosition only for that distance; it is put back the moment the step is done
    held.copy(at)
    at.sub(cameraAt).setLength(seen).add(cameraAt)
    try { move(pointer) } finally { at.copy(held) }
  }
}

export const createDefaultTransformControlsAdapter: CreateTransformControlsAdapter = (camera, domElement) => {
  const controls = new TransformControls(camera, domElement) as unknown as TransformControlsAdapter & RingDragInternals & {
    addEventListener(type: string, listener: (event: unknown) => void): void
    removeEventListener(type: string, listener: (event: unknown) => void): void
  }
  ringDragAsSeen(controls)
  return controls
}
