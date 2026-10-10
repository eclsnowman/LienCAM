// Form - start a form from an existing body (its faces become the cage).
//
// By default the body's curved faces are remeshed into grids of quads
// (remesh.ts: flat faces stay one face each, sharp edges creased, the cage
// pulled onto the body). `{ remesh: false }` keeps the path below, used before
// stage 34 and kept as the control:
//
// The body's tessellation is the raw material: points at the same place are
// merged; a flat face becomes ONE cage face (its boundary loop), a curved face
// keeps its triangles; every edge between two faces of the body that meet at a
// real angle (more than SHARP_EDGE_DEG) is creased. A flat, sharp-edged body
// (a box, a prism, an extruded sketch) therefore comes back as itself - flat
// faces stay flat, creased edges stay straight between corners - and curved
// faces come back as a smooth approximation that sits slightly inside them
// (a subdivision surface lies inside its cage). Uncrease edges to round the
// body off, move points to reshape it.

import type { Cage, Vec3 } from './cage'
import { edgeKey } from './cage'
import { remeshFromBody } from './remesh'

/** How finely a body is tessellated to become a cage: coarse, so the cage stays a handful of points to shape. */
export const FORM_FROM_BODY_TESS = { deflection: 0.3, angularDeflection: 0.4 }

/** Faces of the body meeting at more than this are a sharp edge of the form. */
export const SHARP_EDGE_DEG = 30

export interface BodyMesh {
  position: ArrayLike<number>
  index: ArrayLike<number>
  /** per triangle: the body face it belongs to */
  triFace: ArrayLike<number>
}

export interface FormFromBodyOptions {
  /** remesh the curved faces into quad grids (default true); false keeps their triangles */
  remesh?: boolean
}

export interface FormFromBodyResult {
  cage: Cage
  flatFaces: number
  /** curved faces rebuilt as grids of quads */
  gridFaces: number
  /** triangles of curved faces kept as they are */
  curvedTriangles: number
}

export function formFromBody(mesh: BodyMesh, opts: FormFromBodyOptions = {}): FormFromBodyResult {
  if (opts.remesh !== false) {
    const r = remeshFromBody(mesh, { sharpDeg: SHARP_EDGE_DEG })
    return { cage: r.cage, flatFaces: r.flatFaces, gridFaces: r.gridFaces, curvedTriangles: r.triangles }
  }
  const triCount = Math.floor(mesh.index.length / 3)
  // merge points at the same place (the kernel shares a face edge's points, but per face)
  let extent = 0
  for (let i = 0; i < mesh.position.length; i++) extent = Math.max(extent, Math.abs(mesh.position[i]))
  const q = 1e-6 * Math.max(1, extent)
  const byKey = new Map<string, number>()
  const positions: Vec3[] = []
  const remap = new Int32Array(mesh.position.length / 3)
  for (let v = 0; v < remap.length; v++) {
    const p: Vec3 = [mesh.position[v * 3], mesh.position[v * 3 + 1], mesh.position[v * 3 + 2]]
    const key = p.map((c) => Math.round(c / q)).join(',')
    let id = byKey.get(key)
    if (id === undefined) { id = positions.length; positions.push(p); byKey.set(key, id) }
    remap[v] = id
  }
  const tris: number[][] = []
  const triFaceOf: number[] = []
  for (let t = 0; t < triCount; t++) {
    const tri = [remap[mesh.index[t * 3]], remap[mesh.index[t * 3 + 1]], remap[mesh.index[t * 3 + 2]]]
    if (tri[0] === tri[1] || tri[1] === tri[2] || tri[0] === tri[2]) continue // a sliver the merge collapsed
    tris.push(tri)
    triFaceOf.push(mesh.triFace[t])
  }
  const normalOf = (tri: number[]): Vec3 => {
    const [a, b, c] = tri.map((i) => positions[i])
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
    const n: Vec3 = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]
    const l = Math.hypot(...n)
    return l > 0 ? [n[0] / l, n[1] / l, n[2] / l] : [0, 0, 0]
  }

  // group the triangles by body face
  const byFace = new Map<number, number[]>()
  tris.forEach((_, t) => { const f = triFaceOf[t]; const list = byFace.get(f); if (list) list.push(t); else byFace.set(f, [t]) })
  const faces: number[][] = []
  const faceOfCageFace: number[] = []
  let flatFaces = 0, curvedTriangles = 0
  for (const [f, list] of byFace) {
    const n0 = normalOf(tris[list[0]])
    const o = positions[tris[list[0]][0]]
    const flat = list.every((t) => {
      const n = normalOf(tris[t])
      if (n[0] * n0[0] + n[1] * n0[1] + n[2] * n0[2] < 1 - 1e-9) return false
      return tris[t].every((i) => Math.abs((positions[i][0] - o[0]) * n0[0] + (positions[i][1] - o[1]) * n0[1] + (positions[i][2] - o[2]) * n0[2]) <= 1e-6 * Math.max(1, extent))
    })
    const loop = flat && list.length > 1 ? boundaryLoop(list.map((t) => tris[t])) : flat ? tris[list[0]] : null
    if (loop !== null) {
      faces.push(loop)
      faceOfCageFace.push(f)
      flatFaces++
      continue
    }
    // curved (or a flat face with a hole): its triangles, as they are
    for (const t of list) { faces.push(tris[t]); faceOfCageFace.push(f) }
    curvedTriangles += list.length
  }

  // crease the edges between body faces that meet at a real angle
  const cageNormal = faces.map((loop) => newell(loop.map((i) => positions[i])))
  const sides = new Map<string, number[]>()
  faces.forEach((loop, c) => {
    for (let i = 0; i < loop.length; i++) {
      const key = edgeKey(loop[i], loop[(i + 1) % loop.length])
      const list = sides.get(key)
      if (list) list.push(c); else sides.set(key, [c])
    }
  })
  const cosSharp = Math.cos((SHARP_EDGE_DEG * Math.PI) / 180)
  const creases: string[] = []
  for (const [key, list] of sides) {
    if (list.length !== 2) continue
    const [c0, c1] = list
    if (faceOfCageFace[c0] === faceOfCageFace[c1]) continue
    const a = cageNormal[c0], b = cageNormal[c1]
    if (a[0] * b[0] + a[1] * b[1] + a[2] * b[2] < cosSharp) creases.push(key)
  }
  // an open body (a surface) gives an open form - Fill hole or Thicken closes it
  return { cage: { positions, faces, creases }, flatFaces, gridFaces: 0, curvedTriangles }
}

/** The single boundary loop of a set of edge-connected triangles, in their winding; null if it is not one simple loop. */
function boundaryLoop(tris: number[][]): number[] | null {
  const uses = new Map<string, number>()
  for (const t of tris) for (let k = 0; k < 3; k++) {
    const key = edgeKey(t[k], t[(k + 1) % 3])
    uses.set(key, (uses.get(key) ?? 0) + 1)
  }
  const next = new Map<number, number>()
  for (const t of tris) for (let k = 0; k < 3; k++) {
    const a = t[k], b = t[(k + 1) % 3]
    if (uses.get(edgeKey(a, b)) !== 1) continue
    if (next.has(a)) return null
    next.set(a, b)
  }
  if (next.size < 3) return null
  const start = next.keys().next().value as number
  const loop = [start]
  for (let p = next.get(start); p !== start; p = next.get(p!)) {
    if (p === undefined || loop.length > next.size) return null
    loop.push(p)
  }
  return loop.length === next.size ? loop : null
}

function newell(pts: Vec3[]): Vec3 {
  let x = 0, y = 0, z = 0
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length]
    x += (p[1] - q[1]) * (p[2] + q[2])
    y += (p[2] - q[2]) * (p[0] + q[0])
    z += (p[0] - q[0]) * (p[1] + q[1])
  }
  const l = Math.hypot(x, y, z)
  return l > 0 ? [x / l, y / l, z / l] : [0, 0, 0]
}
