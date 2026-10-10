// Form - picking a cage point, edge or face under the pointer.
//
// The cage is drawn over the smooth skin, so what the operator can SEE decides
// what a click takes:
//   1. a point within POINT_PICK_PX of the pointer, not hidden behind the skin;
//   2. else an edge within the edge tolerance (the model screen's screen-space
//      edge target, src/viewport3d/screenSpacePick.ts), not hidden behind the skin;
//   3. else the face: the skin under the pointer names the cage face it grew
//      from (the whole region shades as one cage face), or, with the skin hidden,
//      the first cage face the ray crosses.
// Hidden = the pointer ray meets the skin nearer than the element by more than
// a small tolerance. In cage-only display nothing is hidden (it is a wireframe).

import * as THREE from 'three'
import type { Cage } from './cage'
import { cageEdges, edgeKey } from './cage'
import { MODEL_EDGE_PICK_TOLERANCE_PX } from '../viewport3d/screenSpacePick'

export const POINT_PICK_PX = 10
export const EDGE_PICK_PX = MODEL_EDGE_PICK_TOLERANCE_PX - 3

export type CagePick =
  | { kind: 'point'; index: number }
  | { kind: 'edge'; key: string }
  | { kind: 'face'; index: number }

export interface PickInput {
  cage: Cage
  camera: THREE.Camera
  /** canvas size in CSS pixels */
  width: number
  height: number
  /** pointer in CSS pixels from the canvas's top-left */
  x: number
  y: number
  /** the skin, when it is shown; null in cage-only display */
  skin: { mesh: THREE.Mesh; cageFaceOfTriangle: (triangle: number) => number } | null
}

function project(p: THREE.Vector3, camera: THREE.Camera, width: number, height: number): { x: number; y: number; inFront: boolean } {
  const v = p.clone().project(camera)
  return { x: (v.x + 1) / 2 * width, y: (1 - v.y) / 2 * height, inFront: v.z > -1 && v.z < 1 }
}

function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): { d: number; t: number } {
  const dx = bx - ax, dy = by - ay
  const len2 = dx * dx + dy * dy
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0
  return { d: Math.hypot(px - (ax + t * dx), py - (ay + t * dy)), t }
}

/** The pointer ray in world space. */
export function pointerRay(camera: THREE.Camera, width: number, height: number, x: number, y: number): THREE.Raycaster {
  const raycaster = new THREE.Raycaster()
  raycaster.setFromCamera(new THREE.Vector2((x / width) * 2 - 1, -(y / height) * 2 + 1), camera)
  return raycaster
}

export function pickCage(input: PickInput): CagePick | null {
  const { cage, camera, width, height, x, y, skin } = input
  const raycaster = pointerRay(camera, width, height, x, y)
  // depth ALONG the pointer ray, measured from the ray's own origin: the skin
  // hit distance is measured the same way. (An orthographic camera's rays start
  // on the near plane at the pointer, not at the camera position, so a distance
  // from the camera position would rank points wrongly there.)
  const ray = raycaster.ray
  const depthOf = (w: THREE.Vector3) => w.clone().sub(ray.origin).dot(ray.direction)

  // where the pointer ray first meets the skin (null: misses, or no skin shown)
  let skinHit: THREE.Intersection | null = null
  if (skin && skin.mesh.visible) {
    const hits = raycaster.intersectObject(skin.mesh, false)
    skinHit = hits[0] ?? null
  }
  // hidden-by-skin tolerance: 1% of the cage's size, at least 0.05 mm
  const size = (() => {
    const box = new THREE.Box3()
    for (const p of cage.positions) box.expandByPoint(new THREE.Vector3(p[0], p[1], p[2]))
    return box.getSize(new THREE.Vector3()).length()
  })()
  const tol = skinTolerance(size)
  const hidden = (world: THREE.Vector3) => skinHit !== null && depthOf(world) > skinHit.distance + tol

  // 1. points
  let best: { index: number; d: number; depth: number } | null = null
  cage.positions.forEach((p, index) => {
    const w = new THREE.Vector3(p[0], p[1], p[2])
    const s = project(w, camera, width, height)
    if (!s.inFront) return
    const d = Math.hypot(s.x - x, s.y - y)
    if (d > POINT_PICK_PX || hidden(w)) return
    const depth = depthOf(w)
    if (!best || d < best.d - 0.5 || (Math.abs(d - best.d) <= 0.5 && depth < best.depth)) best = { index, d, depth }
  })
  if (best) return { kind: 'point', index: (best as { index: number }).index }

  // 2. edges
  let bestEdge: { key: string; d: number; depth: number } | null = null
  for (const [a, b] of cageEdges(cage)) {
    const wa = new THREE.Vector3(...cage.positions[a])
    const wb = new THREE.Vector3(...cage.positions[b])
    const sa = project(wa, camera, width, height)
    const sb = project(wb, camera, width, height)
    if (!sa.inFront || !sb.inFront) continue
    const { d, t } = segmentDistance(x, y, sa.x, sa.y, sb.x, sb.y)
    if (d > EDGE_PICK_PX) continue
    const w = wa.clone().lerp(wb, t)
    if (hidden(w)) continue
    const depth = depthOf(w)
    if (!bestEdge || d < bestEdge.d - 0.5 || (Math.abs(d - bestEdge.d) <= 0.5 && depth < bestEdge.depth)) bestEdge = { key: edgeKey(a, b), d, depth }
  }
  if (bestEdge) return { kind: 'edge', key: (bestEdge as { key: string }).key }

  // 3. faces
  if (skinHit && skinHit.faceIndex !== undefined && skinHit.faceIndex !== null && skin) {
    return { kind: 'face', index: skin.cageFaceOfTriangle(skinHit.faceIndex) }
  }
  return pickCageFaceByRay(cage, raycaster)
}

/** Hidden-by-skin tolerance for a cage `size` mm across (its bounding box diagonal): 1%, at least 0.05 mm. */
export function skinTolerance(size: number): number {
  return Math.max(0.05, size * 0.01)
}

/**
 * True when the shown skin meets the pointer ray at (x, y) nearer than `world` by more than `tol` - the
 * point is behind the smooth surface there (the same rule pickCage uses for the cage's own points).
 */
export function hiddenBySkin(camera: THREE.Camera, width: number, height: number, x: number, y: number, skin: THREE.Mesh | null, world: readonly [number, number, number], tol: number): boolean {
  if (skin === null || !skin.visible) return false
  const raycaster = pointerRay(camera, width, height, x, y)
  const hit = raycaster.intersectObject(skin, false)[0]
  if (hit === undefined) return false
  const ray = raycaster.ray
  const depth = new THREE.Vector3(world[0], world[1], world[2]).sub(ray.origin).dot(ray.direction)
  return depth > hit.distance + tol
}

/**
 * The cage points a box drag takes: every point in front of the camera whose screen position (CSS px) lies in
 * the rectangle between corners (x0, y0) and (x1, y1), and that `hidden` (given its screen position) does not
 * say the skin hides.
 */
export function pointsInRect(
  cage: Cage, camera: THREE.Camera, width: number, height: number,
  x0: number, y0: number, x1: number, y1: number,
  hidden: (x: number, y: number, world: readonly [number, number, number]) => boolean = () => false,
): number[] {
  const left = Math.min(x0, x1), right = Math.max(x0, x1), top = Math.min(y0, y1), bottom = Math.max(y0, y1)
  const out: number[] = []
  cage.positions.forEach((p, index) => {
    const s = project(new THREE.Vector3(p[0], p[1], p[2]), camera, width, height)
    if (!s.inFront || s.x < left || s.x > right || s.y < top || s.y > bottom) return
    if (!hidden(s.x, s.y, p)) out.push(index)
  })
  return out
}

/** First cage face (fan-triangulated) the ray crosses, either side facing. */
export function pickCageFaceByRay(cage: Cage, raycaster: THREE.Raycaster): CagePick | null {
  const tri = new THREE.Triangle()
  const hit = new THREE.Vector3()
  let best: { index: number; t: number } | null = null
  cage.faces.forEach((loop, index) => {
    const a = new THREE.Vector3(...cage.positions[loop[0]])
    for (let i = 1; i + 1 < loop.length; i++) {
      tri.set(a, new THREE.Vector3(...cage.positions[loop[i]]), new THREE.Vector3(...cage.positions[loop[i + 1]]))
      const p = raycaster.ray.intersectTriangle(tri.a, tri.b, tri.c, false, hit)
      if (!p) continue
      const t = raycaster.ray.origin.distanceTo(p)
      if (!best || t < best.t) best = { index, t }
    }
  })
  return best ? { kind: 'face', index: (best as { index: number }).index } : null
}
