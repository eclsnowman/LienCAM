import * as THREE from 'three'
import type { RayLike } from '../../../viewport3d'

export type ReferencePlanePickResult =
  | { kind: 'plane'; nodeId: string; distance: number }
  | { kind: 'blocked' }
  | { kind: 'ambiguous'; nodeIds: readonly string[]; distance: number }
  | { kind: 'miss'; reason: 'non-finite-ray' | 'zero-direction' | 'no-hit' }

const TIE_EPSILON = 1e-6

export function resolveReferencePlanePick(
  ray: RayLike,
  roots: ReadonlyMap<string, THREE.Object3D>,
  bodyMeshes: readonly THREE.Mesh[],
): ReferencePlanePickResult {
  const values = [ray.origin.x, ray.origin.y, ray.origin.z, ray.direction.x, ray.direction.y, ray.direction.z]
  if (!values.every(Number.isFinite)) return { kind: 'miss', reason: 'non-finite-ray' }
  const direction = new THREE.Vector3(ray.direction.x, ray.direction.y, ray.direction.z)
  if (direction.lengthSq() <= 0) return { kind: 'miss', reason: 'zero-direction' }

  const raycaster = new THREE.Raycaster()
  raycaster.set(new THREE.Vector3(ray.origin.x, ray.origin.y, ray.origin.z), direction.normalize())
  let nearestBody = Number.POSITIVE_INFINITY
  for (const mesh of bodyMeshes) {
    if (!mesh.visible) continue
    const hit = raycaster.intersectObject(mesh, false).find((candidate) => candidate.face != null)
    if (hit !== undefined && Number.isFinite(hit.distance)) nearestBody = Math.min(nearestBody, hit.distance)
  }

  const hits: Array<{ nodeId: string; distance: number }> = []
  for (const [nodeId, root] of roots) {
    if (root.userData.referencePlaneNodeId !== nodeId || root.userData.referencePlaneVariant !== 'ambient') continue
    const hit = raycaster.intersectObject(root, true).find((candidate) => candidate.face != null)
    if (hit !== undefined && Number.isFinite(hit.distance)) hits.push({ nodeId, distance: hit.distance })
  }
  hits.sort((a, b) => a.distance - b.distance || a.nodeId.localeCompare(b.nodeId))
  const nearest = hits[0]
  if (nearest === undefined) return { kind: 'miss', reason: 'no-hit' }
  if (nearestBody <= nearest.distance + TIE_EPSILON) return { kind: 'blocked' }
  const tied = hits.filter((hit) => Math.abs(hit.distance - nearest.distance) <= TIE_EPSILON)
  if (tied.length > 1) {
    return { kind: 'ambiguous', nodeIds: tied.map((hit) => hit.nodeId), distance: nearest.distance }
  }
  return { kind: 'plane', nodeId: nearest.nodeId, distance: nearest.distance }
}
