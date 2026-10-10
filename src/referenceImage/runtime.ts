import * as THREE from 'three'
import type { SceneRuntime } from '../components/model3d/sceneRuntime'
import { worldToLocal, type PlaneFrame } from '../sketch3d/planeMath'

/** The image tools need a scene and projection, not a Model document or sketch host. */
export type ReferenceImageRuntime = Pick<SceneRuntime, 'camera' | 'addObject' | 'removeObject' | 'requestRender' | 'projectToCanvas'>

export function referenceImagePoint(runtime: ReferenceImageRuntime, canvas: HTMLCanvasElement, frame: PlaneFrame, x: number, y: number) {
  const rect = canvas.getBoundingClientRect()
  const ray = new THREE.Raycaster()
  ray.setFromCamera(new THREE.Vector2((x - rect.left) / (rect.width || 1) * 2 - 1, 1 - (y - rect.top) / (rect.height || 1) * 2), runtime.camera)
  // SKC-55: sketch ink is lifted; reference pictures are on the actual plane at zero lift.
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
    new THREE.Vector3(frame.normal.x, frame.normal.y, frame.normal.z),
    new THREE.Vector3(frame.origin.x, frame.origin.y, frame.origin.z))
  const hit = ray.ray.intersectPlane(plane, new THREE.Vector3())
  return hit ? worldToLocal(frame, hit) : { x: 0, y: 0 }
}
