import * as THREE from 'three'
import { DEFAULT_PICK_THRESHOLDS, type PickThresholds, type RayLike } from './types'

/** Model-workspace edge target, matched to the established CAM B-rep picker. */
export const MODEL_EDGE_PICK_TOLERANCE_PX = 10

/**
 * Convert a CSS-pixel edge target into the per-segment world tolerance used by
 * PickEngine. Perspective tolerance grows with the candidate's ray distance;
 * orthographic tolerance stays constant. This keeps hover and click usable at
 * both close and distant zoom levels without changing lower-level defaults.
 */
export function screenSpaceEdgePickThresholds(
  camera: THREE.Camera,
  viewportCssHeight: number,
  ray: RayLike,
  pixels = MODEL_EDGE_PICK_TOLERANCE_PX,
): PickThresholds {
  if (!Number.isFinite(viewportCssHeight) || viewportCssHeight <= 0) {
    throw new Error('screen-space edge pick requires a positive viewport CSS height')
  }
  if (!Number.isFinite(pixels) || pixels <= 0) {
    throw new Error('screen-space edge pick requires a positive pixel tolerance')
  }

  const perspective = camera as THREE.PerspectiveCamera
  if (perspective.isPerspectiveCamera === true) {
    const direction = new THREE.Vector3(ray.direction.x, ray.direction.y, ray.direction.z).normalize()
    const forward = camera.getWorldDirection(new THREE.Vector3())
    const depthPerRayDistance = direction.dot(forward)
    const effectiveFov = THREE.MathUtils.degToRad(perspective.getEffectiveFOV())
    if (!Number.isFinite(depthPerRayDistance) || depthPerRayDistance <= 0 || !Number.isFinite(effectiveFov)) {
      throw new Error('screen-space edge pick requires a forward-facing finite perspective ray')
    }
    const worldUnitsPerPixelPerRayDistance =
      (2 * Math.tan(effectiveFov / 2) * depthPerRayDistance) / viewportCssHeight
    return {
      ...DEFAULT_PICK_THRESHOLDS,
      edgeAtDistance: (rayDistance) =>
        Math.max(0, rayDistance) * worldUnitsPerPixelPerRayDistance * pixels,
    }
  }

  const orthographic = camera as THREE.OrthographicCamera
  if (orthographic.isOrthographicCamera === true) {
    const worldHeight = Math.abs(orthographic.top - orthographic.bottom) / orthographic.zoom
    if (!Number.isFinite(worldHeight) || worldHeight <= 0) {
      throw new Error('screen-space edge pick requires a finite orthographic view height')
    }
    return {
      ...DEFAULT_PICK_THRESHOLDS,
      edge: (worldHeight / viewportCssHeight) * pixels,
      edgeProjection: 'orthographic',
    }
  }

  throw new Error('screen-space edge pick requires a perspective or orthographic camera')
}
