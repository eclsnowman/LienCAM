// Interior hit-test for loop picking (drill holes especially).
//
// Loop picking normally requires the click ray to graze the thin loop OUTLINE
// (a THREE.Line). For a small drill hole the natural click is the hole CENTER,
// which misses the outline entirely - so nothing selects. This pure helper lets
// the viewport fall back to "did the click ray pierce the INTERIOR of this closed
// loop?", so clicking anywhere inside a hole selects it. Kept free of THREE so the
// containment math is unit-tested without a WebGL context; the viewport supplies
// the loop's world-space points and the camera ray as plain {x,y,z}.

export interface V3 { x: number; y: number; z: number }

const sub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
const dot = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z
const cross = (a: V3, b: V3): V3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
})
const len = (a: V3): number => Math.hypot(a.x, a.y, a.z)
const norm = (a: V3): V3 => {
  const l = len(a)
  return l < 1e-12 ? { x: 0, y: 0, z: 0 } : { x: a.x / l, y: a.y / l, z: a.z / l }
}

/** Drop a trailing point that duplicates the first (closed loops append a closing
 *  vertex). Leaves the array untouched otherwise. */
function stripClosing(pts: V3[]): V3[] {
  if (pts.length >= 2) {
    const a = pts[0], b = pts[pts.length - 1]
    if (Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < 1e-9) return pts.slice(0, -1)
  }
  return pts
}

/** Newell's method: a robust average plane normal for a (near-)planar loop. */
function newellNormal(pts: V3[]): V3 {
  let nx = 0, ny = 0, nz = 0
  const n = pts.length
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n]
    nx += (a.y - b.y) * (a.z + b.z)
    ny += (a.z - b.z) * (a.x + b.x)
    nz += (a.x - b.x) * (a.y + b.y)
  }
  return norm({ x: nx, y: ny, z: nz })
}

/** 2D even-odd point-in-polygon. poly is the loop projected to the plane basis. */
function pointInPolygon2D(poly: Array<{ u: number; v: number }>, pu: number, pv: number): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const ui = poly[i].u, vi = poly[i].v
    const uj = poly[j].u, vj = poly[j].v
    const intersects = (vi > pv) !== (vj > pv) &&
      pu < ((uj - ui) * (pv - vi)) / (vj - vi) + ui
    if (intersects) inside = !inside
  }
  return inside
}

/** Same pierce test as {@link rayPiercesClosedLoop}, but also reports how far
 *  along the ray (the `t` in `origin + t*dir`) the pierce point sits - so a
 *  caller comparing candidates from MULTIPLE, differently-positioned loops
 *  (WO-350: loops of a chamfered part sit at different heights, each its own
 *  plane) can prefer the one the ray reaches FIRST, not just the smallest.
 *  `rayDir` need not be normalized, but `t` is only a true world distance
 *  when it is - callers comparing `t` across calls must reuse the SAME
 *  `rayDir` for every candidate (true of every caller today: one ray per
 *  hover/click resolution). */
export function rayPierceLoop(
  loopPtsRaw: V3[],
  rayOrigin: V3,
  rayDir: V3,
): { area: number; t: number } | null {
  const pts = stripClosing(loopPtsRaw)
  if (pts.length < 3) return null

  const normal = newellNormal(pts)
  if (len(normal) < 0.5) return null   // degenerate / non-planar enough to be unreliable

  // Ray-plane intersection: n.(O + t*d - P0) = 0
  const P0 = pts[0]
  const denom = dot(normal, rayDir)
  if (Math.abs(denom) < 1e-9) return null   // ray parallel to the loop plane
  const t = dot(normal, sub(P0, rayOrigin)) / denom
  if (t < 0) return null                    // intersection behind the camera
  const hit: V3 = {
    x: rayOrigin.x + t * rayDir.x,
    y: rayOrigin.y + t * rayDir.y,
    z: rayOrigin.z + t * rayDir.z,
  }

  // Orthonormal in-plane basis (u, v).
  const ref: V3 = Math.abs(normal.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 }
  const u = norm(cross(ref, normal))
  const v = cross(normal, u)

  const poly = pts.map((p) => {
    const d = sub(p, P0)
    return { u: dot(d, u), v: dot(d, v) }
  })
  const dh = sub(hit, P0)
  const pu = dot(dh, u), pv = dot(dh, v)

  if (!pointInPolygon2D(poly, pu, pv)) return null

  // Shoelace area in the plane basis (absolute).
  let area2 = 0
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    area2 += (poly[j].u + poly[i].u) * (poly[j].v - poly[i].v)
  }
  return { area: Math.abs(area2) / 2, t }
}

/**
 * Does the ray (origin + t*dir, t >= 0) pierce the interior of this closed loop?
 * Returns the loop's planar AREA when it does (so the caller can prefer the
 * SMALLEST containing loop = the innermost hole), or null when it does not
 * (ray parallel to the loop plane, intersection behind the camera, degenerate
 * loop, or the pierce point lies outside the polygon).
 *
 * `rayDir` need not be normalized. World-space inputs; orientation-agnostic.
 */
export function rayPiercesClosedLoop(
  loopPtsRaw: V3[],
  rayOrigin: V3,
  rayDir: V3,
): number | null {
  return rayPierceLoop(loopPtsRaw, rayOrigin, rayDir)?.area ?? null
}
