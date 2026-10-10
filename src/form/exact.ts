// Form - the limit surface as bicubic Bezier patches (the exact CAD solid).
//
// Finish Form's faceted body is triangles within a chord. The CAD solid is the
// surface itself: after `levels` Catmull-Clark steps every face is a quad, and
// every quad becomes one bicubic Bezier patch (16 control points), built with
// the rules of Loop & Schaefer, "Approximating Catmull-Clark Subdivision
// Surfaces with Bicubic Patches" (2008), extended to sharp creases:
//
//   interior point of face f at corner v (valence n):
//       (n v + 2 e_prev + 2 e_next + d) / (n + 5)
//       (e_* the face's two edge neighbours of v, d its diagonal point)
//   edge point of edge (v, e) near v:
//       smooth edge: the average of the two interior points beside it at v
//       sharp edge:  (2 v + e) / 3          (the crease curve's Bezier point)
//   corner point: the limit position of v (limitRows' masks)
//
// Where the four corners of a quad are ordinary (valence 4, smooth, or a
// regular crease point with two faces on each side) these ARE the uniform
// bicubic B-spline patch converted to Bezier form, which is exactly the limit
// surface (Stam 1998; a regular crease is the B-spline with its phantom row
// reflected, as OpenSubdiv evaluates it). Near an extraordinary point, a dart
// or a crease corner the patch is an approximation. Every edge and corner
// control point is computed once and shared by the patches on both sides, so
// the patches meet exactly (watertight) whatever the case; across a crease
// they meet with a corner, as the crease says.
//
// On a crease point the interior rule uses the valence of its own sector,
// mirrored across the crease (2 x the sector's face count): a regular crease
// sector (two faces) reads as valence 4, which keeps the rule exact there, and
// every rule is an affine combination of points on its own side, so a flat
// creased region stays exactly flat.

import type { Cage, Vec3 } from './cage'
import { edgeKey } from './cage'
import { buildHalfEdge } from './halfEdge'
import { applyRows, cagePositionArray, levelFromCage, limitRows, refine, type Level } from './subdivide'

/** One bicubic Bezier patch: control point (i, j) at points[(i * 4 + j)], i along the quad's first edge. */
export interface BezierPatch {
  points: Vec3[]
  /** the cage face this patch lies on */
  cageFace: number
  /** true when every corner is ordinary: the patch is exactly the limit surface */
  exact: boolean
}

export interface ExactSurface {
  /** one per face of the refined level, same order */
  patches: BezierPatch[]
  /** refinement steps applied before the patches were built */
  levels: number
  /** per patch: the first-level quad it lies in, and its corners' (u, v) there (see refinedLevel) */
  root: Int32Array
  uv: Float64Array
  /** per patch: its corner points in the refined level (to key shared edges and corners) */
  corners: number[][]
  /** edges of the refined level that are sharp (creased, semi-sharp still, or open), as edgeKey(a, b) */
  sharpEdges: Set<string>
}

/**
 * A quad level refined `levels` times from the cage (at least once), with
 * positions and ancestry: the cage face, and the first-level quad (`root`) each
 * face lies in with its corners' (u, v) in that root's [0, 1]^2 (8 numbers per
 * face, corner k at uv[f * 8 + 2k]).
 */
export function refinedLevel(cage: Cage, levels: number): { level: Level; positions: Float64Array; cageFace: Int32Array; root: Int32Array; uv: Float64Array } {
  let level = levelFromCage(cage)
  let positions = cagePositionArray(cage)
  let cageFace = Int32Array.from(cage.faces.map((_, f) => f))
  let root = new Int32Array(0)
  let uv = new Float64Array(0)
  for (let s = 0; s < Math.max(1, levels); s++) {
    const r = refine(level)
    positions = applyRows(r.rows, positions)
    cageFace = Int32Array.from(r.faceParent, (p) => cageFace[p])
    if (s === 0) {
      root = Int32Array.from(r.level.faces.map((_, f) => f))
      uv = new Float64Array(r.level.faces.length * 8)
      for (let f = 0; f < r.level.faces.length; f++) uv.set([0, 0, 1, 0, 1, 1, 0, 1], f * 8)
    } else {
      // refine() emits a parent's children in corner order: child i = [corner i, edge (i, i+1), centre, edge (i-1, i)]
      const nextRoot = new Int32Array(r.level.faces.length)
      const nextUv = new Float64Array(r.level.faces.length * 8)
      const seen = new Map<number, number>()
      for (let f = 0; f < r.level.faces.length; f++) {
        const p = r.faceParent[f]
        const i = seen.get(p) ?? 0
        seen.set(p, i + 1)
        nextRoot[f] = root[p]
        const c = (k: number) => [uv[p * 8 + ((k + 4) % 4) * 2], uv[p * 8 + ((k + 4) % 4) * 2 + 1]]
        const mid = (a: number[], b: number[]) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
        const centre = mid(mid(c(0), c(2)), mid(c(1), c(3)))
        nextUv.set([...c(i), ...mid(c(i), c(i + 1)), ...centre, ...mid(c(i - 1), c(i))], f * 8)
      }
      root = nextRoot
      uv = nextUv
    }
    level = r.level
  }
  return { level, positions, cageFace, root, uv }
}

/** The limit surface of a closed cage as bicubic Bezier patches. */
export function exactSurface(cage: Cage, levels = 2): ExactSurface {
  const { level, positions: P, cageFace, root, uv } = refinedLevel(cage, levels)
  const mesh = buildHalfEdge({ positions: new Array(level.vertexCount), faces: level.faces, creases: [] })
  const V = level.vertexCount
  const at = (i: number): Vec3 => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]]

  // per point: its faces, neighbours, sharp edges
  const vertexFaces: number[][] = Array.from({ length: V }, () => [])
  level.faces.forEach((loop, f) => { for (const v of loop) vertexFaces[v].push(f) })
  const valence = new Int32Array(V)
  const sharpCount = new Int32Array(V)
  // an edge still semi-sharp after the refinement (weight above the level count) counts as sharp, as limitRows does
  const sharpKey = (key: string) => level.creases.has(key) || (level.sharpness?.get(key) ?? 0) > 0
  const isSharp = (a: number, b: number) => {
    const key = edgeKey(a, b)
    return sharpKey(key) || (mesh.edgeHalfEdges.get(key)?.length ?? 0) === 1
  }
  for (const [key, list] of mesh.edgeHalfEdges) {
    const a = mesh.origin[list[0]], b = mesh.origin[mesh.next[list[0]]]
    valence[a]++
    valence[b]++
    if (list.length === 1 || sharpKey(key)) { sharpCount[a]++; sharpCount[b]++ }
  }
  const limit = applyRows(limitRows(level), P)
  const corner = (v: number): Vec3 => [limit[v * 3], limit[v * 3 + 1], limit[v * 3 + 2]]

  // The faces around v split into sectors by its sharp edges; a smooth point
  // is one sector of all its faces. sectorSize[f at v] = faces in f's sector.
  const faceAt = (f: number, v: number) => level.faces[f].indexOf(v)
  const sectorSize = new Map<string, number>()
  const sectorOf = (f: number, v: number): number => {
    const key = `${f}@${v}`
    const cached = sectorSize.get(key)
    if (cached !== undefined) return cached
    if (sharpCount[v] < 2) { sectorSize.set(key, vertexFaces[v].length); return vertexFaces[v].length }
    // walk both ways from f across smooth edges at v
    const seen = new Set<number>([f])
    const stack = [f]
    while (stack.length) {
      const g = stack.pop()!
      const loop = level.faces[g]
      const i = faceAt(g, v)
      for (const o of [loop[(i + 1) % 4], loop[(i + 3) % 4]]) {
        if (isSharp(v, o)) continue
        for (const h of vertexFaces[v]) {
          if (seen.has(h)) continue
          const hl = level.faces[h]
          if (hl.includes(o)) { seen.add(h); stack.push(h) }
        }
      }
    }
    for (const g of seen) sectorSize.set(`${g}@${v}`, seen.size)
    return seen.size
  }

  const interior = new Map<string, Vec3>()
  const interiorPoint = (f: number, v: number): Vec3 => {
    const key = `${f}@${v}`
    const cached = interior.get(key)
    if (cached) return cached
    const loop = level.faces[f]
    const i = faceAt(f, v)
    const eNext = at(loop[(i + 1) % 4]), d = at(loop[(i + 2) % 4]), ePrev = at(loop[(i + 3) % 4])
    const n = sharpCount[v] < 2 ? valence[v] : 2 * sectorOf(f, v)
    const p = at(v)
    const out: Vec3 = [0, 1, 2].map((k) => (n * p[k] + 2 * ePrev[k] + 2 * eNext[k] + d[k]) / (n + 5)) as Vec3
    interior.set(key, out)
    return out
  }

  // edge point near v on edge (v, e), shared by both faces on the edge
  const edgePointCache = new Map<string, Vec3>()
  const edgePoint = (v: number, e: number): Vec3 => {
    const key = `${v}>${e}`
    const cached = edgePointCache.get(key)
    if (cached) return cached
    let out: Vec3
    const pv = at(v), pe = at(e)
    if (isSharp(v, e)) {
      out = [0, 1, 2].map((k) => (2 * pv[k] + pe[k]) / 3) as Vec3
    } else {
      const faces = vertexFaces[v].filter((f) => level.faces[f].includes(e))
      const a = interiorPoint(faces[0], v), b = interiorPoint(faces[1], v)
      out = [0, 1, 2].map((k) => (a[k] + b[k]) / 2) as Vec3
    }
    edgePointCache.set(key, out)
    return out
  }

  const ordinary = (v: number, f: number): boolean => {
    if (sharpCount[v] === 0) return valence[v] === 4
    // a sharp crease decouples its two sides: this side is regular with two faces
    if (sharpCount[v] === 2) return sectorOf(f, v) === 2
    return false
  }

  const patches: BezierPatch[] = level.faces.map((loop, f) => {
    // grid (i, j): corner (0,0) = loop[0], i runs toward loop[1], j toward loop[3]
    const [c00, c10, c11, c01] = loop
    const g: Vec3[] = new Array(16)
    const set = (i: number, j: number, p: Vec3) => { g[i * 4 + j] = p }
    set(0, 0, corner(c00)); set(3, 0, corner(c10)); set(3, 3, corner(c11)); set(0, 3, corner(c01))
    set(1, 0, edgePoint(c00, c10)); set(2, 0, edgePoint(c10, c00))
    set(3, 1, edgePoint(c10, c11)); set(3, 2, edgePoint(c11, c10))
    set(2, 3, edgePoint(c11, c01)); set(1, 3, edgePoint(c01, c11))
    set(0, 2, edgePoint(c01, c00)); set(0, 1, edgePoint(c00, c01))
    set(1, 1, interiorPoint(f, c00)); set(2, 1, interiorPoint(f, c10))
    set(2, 2, interiorPoint(f, c11)); set(1, 2, interiorPoint(f, c01))
    return { points: g, cageFace: cageFace[f], exact: loop.every((v) => ordinary(v, f)) }
  })
  const sharpEdges = new Set<string>()
  for (const [key, list] of mesh.edgeHalfEdges) if (list.length === 1 || sharpKey(key)) sharpEdges.add(key)
  return { patches, levels: Math.max(1, levels), root, uv, corners: level.faces.map((f) => f.slice()), sharpEdges }
}

/** Point of a bicubic Bezier patch at (u, v) in [0, 1]^2 (u along i). */
export function evalPatch(points: readonly Vec3[], u: number, v: number): Vec3 {
  const b = (t: number) => { const s = 1 - t; return [s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t] }
  const bu = b(u), bv = b(v)
  const out: Vec3 = [0, 0, 0]
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    const w = bu[i] * bv[j]
    const p = points[i * 4 + j]
    out[0] += w * p[0]; out[1] += w * p[1]; out[2] += w * p[2]
  }
  return out
}

/** Unit normal of a bicubic Bezier patch at (u, v): d/du x d/dv. */
export function patchNormal(points: readonly Vec3[], u: number, v: number): Vec3 {
  const b = (t: number) => { const s = 1 - t; return [s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t] }
  const db = (t: number) => { const s = 1 - t; return [-3 * s * s, 3 * s * s - 6 * s * t, 6 * s * t - 3 * t * t, 3 * t * t] }
  const bu = b(u), bv = b(v), dbu = db(u), dbv = db(v)
  const du: Vec3 = [0, 0, 0], dv: Vec3 = [0, 0, 0]
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    const p = points[i * 4 + j]
    const wu = dbu[i] * bv[j], wv = bu[i] * dbv[j]
    for (let k = 0; k < 3; k++) { du[k] += wu * p[k]; dv[k] += wv * p[k] }
  }
  const n: Vec3 = [du[1] * dv[2] - du[2] * dv[1], du[2] * dv[0] - du[0] * dv[2], du[0] * dv[1] - du[1] * dv[0]]
  const l = Math.hypot(n[0], n[1], n[2])
  return l > 0 ? [n[0] / l, n[1] / l, n[2] / l] : [0, 0, 0]
}

