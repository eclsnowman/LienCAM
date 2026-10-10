// Relief - the face frame of a picked flat face, read from the body's display
// tessellation (its triangles of that face and their normals). Kept apart
// from the page so the page only hands over what it already caches.

import type * as THREE from 'three'
import { faceFrameFromPoints, type FaceFrame } from '../../../relief/reliefHeights'

export interface DisplayBody {
  geometry: THREE.BufferGeometry
  /** triangle i belongs to face faceIds[triFace[i]] */
  triFace: ArrayLike<number>
  faceIds: readonly string[]
}

/** The frame of `faceId` on a displayed body: its outward normal (the mean of its vertex normals) and its extent; null when the body shows no triangle of it. */
export function faceFrameOfDisplayedFace(body: DisplayBody, faceId: string): FaceFrame | null {
  const position = body.geometry.getAttribute('position')
  const normal = body.geometry.getAttribute('normal')
  const index = body.geometry.getIndex()
  if (position === undefined || index === null) return null
  const points: number[] = []
  let nx = 0, ny = 0, nz = 0
  for (let t = 0; t < body.triFace.length; t++) {
    if (body.faceIds[body.triFace[t]] !== faceId) continue
    const a = index.getX(t * 3), b = index.getX(t * 3 + 1), c = index.getX(t * 3 + 2)
    for (const v of [a, b, c]) {
      points.push(position.getX(v), position.getY(v), position.getZ(v))
      if (normal !== undefined) { nx += normal.getX(v); ny += normal.getY(v); nz += normal.getZ(v) }
    }
    if (normal === undefined) {
      // no normals: the triangle's own (the tessellation winds outward)
      const p = (v: number) => [position.getX(v), position.getY(v), position.getZ(v)]
      const [ax, ay, az] = p(a), [bx, by, bz] = p(b), [cx, cy, cz] = p(c)
      const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az
      nx += uy * vz - uz * vy; ny += uz * vx - ux * vz; nz += ux * vy - uy * vx
    }
  }
  if (points.length === 0 || Math.hypot(nx, ny, nz) === 0) return null
  return faceFrameFromPoints({ x: nx, y: ny, z: nz }, points)
}
