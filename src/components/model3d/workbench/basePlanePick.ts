import * as THREE from 'three'
import type { RayLike, Vec3Like } from '../../../viewport3d'
import { BASE_PLANE_BY_NODE_ID } from './basePlanes'

/** World-space distance at which two distinct plane hits are indistinguishable. */
export const BASE_PLANE_PICK_TIE_EPSILON = 1e-6

interface FiniteSurfaceHit {
  point: Vec3Like
  normal: Vec3Like
  distance: number
}

export type BasePlanePickResult =
  | ({ kind: 'plane'; nodeId: string } & FiniteSurfaceHit)
  | ({ kind: 'blocked' } & FiniteSurfaceHit)
  | { kind: 'ambiguous'; nodeIds: readonly string[]; distance: number }
  | { kind: 'miss'; reason: 'no-hit' | 'non-finite-ray' | 'zero-direction' | 'invalid-hit' }

interface PlaneCandidate extends FiniteSurfaceHit {
  nodeId: string
}

function finiteVec3(value: Vec3Like): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z)
}

function surfaceHit(intersection: THREE.Intersection): FiniteSurfaceHit | null {
  if (intersection.face == null || !Number.isFinite(intersection.distance) || intersection.distance < 0) return null
  if (!finiteVec3(intersection.point)) return null

  const normal = intersection.face.normal.clone().applyNormalMatrix(
    new THREE.Matrix3().getNormalMatrix(intersection.object.matrixWorld),
  )
  const normalLengthSq = normal.lengthSq()
  if (!finiteVec3(normal) || !Number.isFinite(normalLengthSq) || normalLengthSq <= 0) return null
  normal.normalize()
  if (!finiteVec3(normal)) return null

  return {
    point: { x: intersection.point.x, y: intersection.point.y, z: intersection.point.z },
    normal: { x: normal.x, y: normal.y, z: normal.z },
    distance: intersection.distance,
  }
}

/**
 * Resolves one finite world ray against the mode-owned ambient base-plane
 * glyph roots and the currently visible body meshes. The candidate map is
 * deliberately the identity boundary: Origin and emphasis duplicates never
 * enter it, and each accepted key must agree with the ambient root metadata.
 */
export function resolveBasePlanePick(
  ray: RayLike,
  ambientPlaneRoots: ReadonlyMap<string, THREE.Object3D>,
  bodyMeshes: readonly THREE.Mesh[],
): BasePlanePickResult {
  if (!finiteVec3(ray.origin) || !finiteVec3(ray.direction)) {
    return { kind: 'miss', reason: 'non-finite-ray' }
  }

  const direction = new THREE.Vector3(ray.direction.x, ray.direction.y, ray.direction.z)
  const directionLengthSq = direction.lengthSq()
  if (!Number.isFinite(directionLengthSq) || directionLengthSq <= 0) {
    return { kind: 'miss', reason: 'zero-direction' }
  }

  const raycaster = new THREE.Raycaster()
  raycaster.set(
    new THREE.Vector3(ray.origin.x, ray.origin.y, ray.origin.z),
    direction.normalize(),
  )

  let invalidHit = false
  let nearestBody: FiniteSurfaceHit | null = null
  for (const mesh of bodyMeshes) {
    if (mesh.visible !== true) continue
    const faceHits = raycaster.intersectObject(mesh, false).filter((hit) => hit.face != null)
    for (const intersection of faceHits) {
      const hit = surfaceHit(intersection)
      if (hit === null) {
        invalidHit = true
        continue
      }
      if (nearestBody === null || hit.distance < nearestBody.distance) nearestBody = hit
      break
    }
  }

  const planes: PlaneCandidate[] = []
  for (const [nodeId, root] of ambientPlaneRoots) {
    if (!(nodeId in BASE_PLANE_BY_NODE_ID)) continue
    if (root.userData.genesisNodeId !== nodeId || root.userData.genesisVariant !== 'ambient') continue

    // One root owns one identity. Keeping only its nearest face-bearing hit
    // collapses the two fill triangles (and any future tessellation) before
    // cross-plane ambiguity is evaluated.
    const faceHits = raycaster.intersectObject(root, true).filter((hit) => hit.face != null)
    for (const intersection of faceHits) {
      const hit = surfaceHit(intersection)
      if (hit === null) {
        invalidHit = true
        continue
      }
      planes.push({ nodeId, ...hit })
      break
    }
  }

  if (invalidHit) return { kind: 'miss', reason: 'invalid-hit' }

  planes.sort((a, b) => a.distance - b.distance || a.nodeId.localeCompare(b.nodeId))
  const nearestPlane = planes[0]
  if (
    nearestBody !== null &&
    (nearestPlane === undefined || nearestBody.distance <= nearestPlane.distance + BASE_PLANE_PICK_TIE_EPSILON)
  ) {
    return { kind: 'blocked', ...nearestBody }
  }
  if (nearestPlane === undefined) return { kind: 'miss', reason: 'no-hit' }

  const tiedNodeIds = planes
    .filter((candidate) => Math.abs(candidate.distance - nearestPlane.distance) <= BASE_PLANE_PICK_TIE_EPSILON)
    .map((candidate) => candidate.nodeId)
    .sort()
  if (tiedNodeIds.length > 1) {
    return { kind: 'ambiguous', nodeIds: tiedNodeIds, distance: nearestPlane.distance }
  }

  return {
    kind: 'plane',
    nodeId: nearestPlane.nodeId,
    point: nearestPlane.point,
    normal: nearestPlane.normal,
    distance: nearestPlane.distance,
  }
}
