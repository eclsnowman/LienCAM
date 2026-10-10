// Image relief - route (a) of docs/design/IMAGE-RELIEF-PLAN.md section 3:
// the relief as a triangle mesh. A box plate whose top carries the height
// grid, closed and outward-wound, ready for the mesh tools (manifold
// booleans) and for CAM as it is. Two triangles per grid cell; the flat frame
// between the relief rectangle and the plate's edge is four fans.

import type { HeightGrid } from './heightGrid'

export interface PlateSpec {
  /** plate size, mm; the plate spans 0..x, 0..y, 0..z */
  x: number
  y: number
  z: number
}

export interface MeshBody {
  positions: Float32Array
  indices: Uint32Array
}

/**
 * The closed mesh of a plate with the grid raised on its top face, the grid's
 * low corner at `origin`. The grid's border heights must be 0 (the relief
 * meets the face) - they are written as exactly the plate top.
 */
export function reliefPlateMesh(g: HeightGrid, plate: PlateSpec, origin: { x: number; y: number }): MeshBody {
  const { cols, rows } = g
  const top = plate.z
  const nGrid = cols * rows
  const positions = new Float32Array((nGrid + 8) * 3)
  for (let r = 0; r < rows; r++) {
    const y = origin.y + (g.depthMm * r) / (rows - 1)
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c
      const edge = r === 0 || c === 0 || r === rows - 1 || c === cols - 1
      positions[i * 3] = origin.x + (g.widthMm * c) / (cols - 1)
      positions[i * 3 + 1] = y
      positions[i * 3 + 2] = top + (edge ? 0 : g.heights[i])
    }
  }
  // plate corners: 4 on top (nGrid .. nGrid+3), 4 on the bottom (nGrid+4 ..)
  const corners = [[0, 0], [plate.x, 0], [plate.x, plate.y], [0, plate.y]]
  corners.forEach(([x, y], k) => {
    positions.set([x, y, top], (nGrid + k) * 3)
    positions.set([x, y, 0], (nGrid + 4 + k) * 3)
  })
  const idx: number[] = []
  const tri = (a: number, b: number, c: number) => { idx.push(a, b, c) }
  // relief cells, counter-clockwise from above
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c
      tri(a, a + 1, a + cols + 1)
      tri(a, a + cols + 1, a + cols)
    }
  }
  // the frame: for each side k of the plate (corner k -> k+1, counter-clockwise),
  // the grid border from its corner k to corner k+1 fans to plate corner k,
  // closed by one triangle to plate corner k+1.
  const gridCorner = [0, cols - 1, rows * cols - 1, (rows - 1) * cols]
  const border = (k: number): number[] => {
    const out: number[] = []
    if (k === 0) for (let c = 0; c < cols; c++) out.push(c)
    if (k === 1) for (let r = 0; r < rows; r++) out.push(r * cols + cols - 1)
    if (k === 2) for (let c = cols - 1; c >= 0; c--) out.push((rows - 1) * cols + c)
    if (k === 3) for (let r = rows - 1; r >= 0; r--) out.push(r * cols)
    return out
  }
  for (let k = 0; k < 4; k++) {
    const pk = nGrid + k
    const pk1 = nGrid + ((k + 1) % 4)
    const b = border(k)
    for (let j = 0; j < b.length - 1; j++) tri(pk, b[j + 1], b[j])
    tri(pk, pk1, gridCorner[(k + 1) % 4])
  }
  // walls and bottom
  for (let k = 0; k < 4; k++) {
    const t0 = nGrid + k, t1 = nGrid + ((k + 1) % 4), b0 = t0 + 4, b1 = t1 + 4
    tri(b0, b1, t1)
    tri(b0, t1, t0)
  }
  tri(nGrid + 4, nGrid + 7, nGrid + 6)
  tri(nGrid + 4, nGrid + 6, nGrid + 5)
  return { positions, indices: Uint32Array.from(idx) }
}

/**
 * WO-2200 - the mesh relief (IMAGE-RELIEF-PLAN.md section 3, route (a)): the
 * working grid's heights over the relief rectangle, signed mm, row 0 at the
 * rectangle's low-Y edge (sampleReliefGrid's layout). Its outer ring is not
 * used: the face's edge lies in the plane, where the neighbouring face's own
 * mesh already put its points.
 */
export interface ReliefDetail {
  cols: number
  rows: number
  heights: ArrayLike<number>
}

type P3 = { x: number; y: number; z: number }

/** The relief rectangle in space: its low corner, unit axes (xDir x yDir = normal, out of the part) and size. */
export interface DetailFrame {
  origin: P3
  xDir: P3
  yDir: P3
  normal: P3
  widthMm: number
  heightMm: number
}

export interface FaceMesh {
  positions: Float32Array
  normals: Float32Array
  indices: Uint32Array
}

/**
 * The relief face meshed at the working grid's full detail: one vertex per
 * grid sample inside the rectangle (two triangles per cell), and a collar
 * from the grid's first inner ring out to `boundary` - the points the
 * neighbouring faces' meshes put on the rectangle's edges, corners included
 * (flat xyz). The collar uses exactly those points and no others, so the face
 * welds to its neighbours with no T-junction: the body's mesh stays closed.
 *
 * Null when `boundary` does not trace the rectangle (a corner is missing):
 * the caller meshes the face its own way then.
 */
export function reliefDetailFaceMesh(d: ReliefDetail, f: DetailFrame, boundary: ArrayLike<number>, tol = 1e-3): FaceMesh | null {
  const { cols, rows } = d
  if (!(cols >= 4 && rows >= 4) || d.heights.length !== cols * rows) return null
  const W = f.widthMm, H = f.heightMm
  const local = (x: number, y: number, z: number) => {
    const px = x - f.origin.x, py = y - f.origin.y, pz = z - f.origin.z
    return {
      u: px * f.xDir.x + py * f.xDir.y + pz * f.xDir.z,
      v: px * f.yDir.x + py * f.yDir.y + pz * f.yDir.z,
      w: px * f.normal.x + py * f.normal.y + pz * f.normal.z,
    }
  }
  // the outer loop: boundary points on the rectangle's edges, by their place round it (s in [0, 4), corner k at s = k)
  const cornerUV = [[0, 0], [W, 0], [W, H], [0, H]]
  const corners: (number[] | null)[] = [null, null, null, null]
  const cornerGap = [Infinity, Infinity, Infinity, Infinity]
  const sides = new Map<string, { s: number; p: number[] }>()
  for (let i = 0; i + 2 < boundary.length; i += 3) {
    const x = boundary[i], y = boundary[i + 1], z = boundary[i + 2]
    const { u, v, w } = local(x, y, z)
    if (Math.abs(w) > tol || u < -tol || v < -tol || u > W + tol || v > H + tol) continue
    let corner = -1
    for (let k = 0; k < 4; k++) {
      const g = Math.hypot(u - cornerUV[k][0], v - cornerUV[k][1])
      if (g <= tol) {
        corner = k
        if (g < cornerGap[k]) { cornerGap[k] = g; corners[k] = [x, y, z] }
      }
    }
    if (corner >= 0) continue
    let s: number
    if (Math.abs(v) <= tol) s = u / W
    else if (Math.abs(u - W) <= tol) s = 1 + v / H
    else if (Math.abs(v - H) <= tol) s = 2 + (W - u) / W
    else if (Math.abs(u) <= tol) s = 3 + (H - v) / H
    else continue
    sides.set(`${x},${y},${z}`, { s, p: [x, y, z] })
  }
  if (corners.some((c) => c === null)) return null
  const outer = [...corners.map((p, k) => ({ s: k, p: p as number[] })), ...sides.values()].sort((a, b) => a.s - b.s)

  // the inner grid: rows 1 .. rows-2, cols 1 .. cols-2 (the outer ring is the plane's)
  const ic = cols - 2, ir = rows - 2
  const nOuter = outer.length
  const nInner = ic * ir
  const positions = new Float32Array((nOuter + nInner) * 3)
  const normals = new Float32Array((nOuter + nInner) * 3)
  outer.forEach((o, i) => {
    positions.set(o.p, i * 3)
    normals.set([f.normal.x, f.normal.y, f.normal.z], i * 3)
  })
  const h = (r: number, c: number) => (r <= 0 || c <= 0 || r >= rows - 1 || c >= cols - 1 ? 0 : d.heights[r * cols + c])
  const dx = W / (cols - 1), dy = H / (rows - 1)
  for (let r = 1; r <= ir; r++) {
    const y = (H * r) / (rows - 1)
    for (let c = 1; c <= ic; c++) {
      const x = (W * c) / (cols - 1)
      const z = h(r, c)
      const i = nOuter + (r - 1) * ic + (c - 1)
      positions[i * 3] = f.origin.x + x * f.xDir.x + y * f.yDir.x + z * f.normal.x
      positions[i * 3 + 1] = f.origin.y + x * f.xDir.y + y * f.yDir.y + z * f.normal.y
      positions[i * 3 + 2] = f.origin.z + x * f.xDir.z + y * f.yDir.z + z * f.normal.z
      const gx = (h(r, c + 1) - h(r, c - 1)) / (2 * dx), gy = (h(r + 1, c) - h(r - 1, c)) / (2 * dy)
      const nx = f.normal.x - gx * f.xDir.x - gy * f.yDir.x
      const ny = f.normal.y - gx * f.xDir.y - gy * f.yDir.y
      const nz = f.normal.z - gx * f.xDir.z - gy * f.yDir.z
      const l = Math.hypot(nx, ny, nz) || 1
      normals[i * 3] = nx / l; normals[i * 3 + 1] = ny / l; normals[i * 3 + 2] = nz / l
    }
  }
  const at = (r: number, c: number) => nOuter + (r - 1) * ic + (c - 1)
  // two triangles per inner cell; the collar has one per point of either loop
  const idx = new Uint32Array(3 * (2 * (ir - 1) * (ic - 1) + nOuter + 2 * (ic - 1) + 2 * (ir - 1)))
  let t = 0
  // counter-clockwise seen from outside when xDir x yDir = normal; flipped otherwise
  const cz = {
    x: f.xDir.y * f.yDir.z - f.xDir.z * f.yDir.y,
    y: f.xDir.z * f.yDir.x - f.xDir.x * f.yDir.z,
    z: f.xDir.x * f.yDir.y - f.xDir.y * f.yDir.x,
  }
  const flip = cz.x * f.normal.x + cz.y * f.normal.y + cz.z * f.normal.z < 0
  const tri = (a: number, b: number, c: number) => {
    idx[t++] = a
    idx[t++] = flip ? c : b
    idx[t++] = flip ? b : c
  }
  for (let r = 1; r < ir; r++) {
    for (let c = 1; c < ic; c++) {
      const a = at(r, c)
      tri(a, a + 1, a + ic + 1)
      tri(a, a + ic + 1, a + ic)
    }
  }
  // the inner loop, counter-clockwise from its low corner, by the same place round the rectangle
  const inner: { s: number; i: number }[] = []
  const sc = Math.max(ic - 1, 1), sr = Math.max(ir - 1, 1)
  for (let c = 1; c < ic; c++) inner.push({ s: (c - 1) / sc, i: at(1, c) })
  for (let r = 1; r < ir; r++) inner.push({ s: 1 + (r - 1) / sr, i: at(r, ic) })
  for (let c = ic; c > 1; c--) inner.push({ s: 2 + (ic - c) / sc, i: at(ir, c) })
  for (let r = ir; r > 1; r--) inner.push({ s: 3 + (ir - r) / sr, i: at(r, 1) })
  // the collar: zip the two loops by their place round the rectangle
  const O = [...outer.map((o, i) => ({ s: o.s, i })), { s: 4, i: 0 }]
  const I = [...inner, { s: 4, i: inner[0].i }]
  let a = 0, b = 0
  while (a < O.length - 1 || b < I.length - 1) {
    if (b === I.length - 1 || (a < O.length - 1 && O[a + 1].s <= I[b + 1].s)) {
      tri(O[a].i, O[a + 1].i, I[b].i)
      a++
    } else {
      tri(O[a].i, I[b + 1].i, I[b].i)
      b++
    }
  }
  return { positions, normals, indices: t === idx.length ? idx : idx.slice(0, t) }
}

/** A closed prism approximating a vertical cylinder, `segments` sides (chord error r (1 - cos(pi/segments))). */
export function cylinderMesh(cx: number, cy: number, radius: number, z0: number, z1: number, segments: number): MeshBody {
  const positions = new Float32Array((2 * segments + 2) * 3)
  for (let i = 0; i < segments; i++) {
    const a = (2 * Math.PI * i) / segments
    const x = cx + radius * Math.cos(a), y = cy + radius * Math.sin(a)
    positions.set([x, y, z0], i * 3)
    positions.set([x, y, z1], (segments + i) * 3)
  }
  const c0 = 2 * segments, c1 = 2 * segments + 1
  positions.set([cx, cy, z0], c0 * 3)
  positions.set([cx, cy, z1], c1 * 3)
  const idx: number[] = []
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments
    idx.push(i, j, segments + j, i, segments + j, segments + i)
    idx.push(c0, j, i)
    idx.push(c1, segments + i, segments + j)
  }
  return { positions, indices: Uint32Array.from(idx) }
}

/** Signed volume of a closed mesh (divergence theorem), mm^3; positive when wound outward. */
export function meshVolume(m: { positions: ArrayLike<number>; indices: ArrayLike<number> }): number {
  const p = m.positions
  let v = 0
  for (let t = 0; t < m.indices.length; t += 3) {
    const a = m.indices[t] * 3, b = m.indices[t + 1] * 3, c = m.indices[t + 2] * 3
    v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
      - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c])
      + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])
  }
  return v / 6
}
