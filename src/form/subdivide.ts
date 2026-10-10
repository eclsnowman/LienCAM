// Form - Catmull-Clark subdivision with sharp creases.
//
// One refinement step is expressed as a sparse matrix R (CSR rows): every
// point of the finer level is a fixed weighted sum of points of the coarser
// level. Topology decides R; positions never do. That split is what makes
// dragging cheap:
//   - on a topology change, compose the steps into STENCILS: each skin point
//     as a weighted sum of CAGE points (plus the limit-position mask, so the
//     displayed points lie on the limit surface);
//   - while dragging, only multiply the stencils by the moved cage points.
// Finish Form applies the same steps directly to positions (no stencil
// composition) to go fine enough for a 0.01 mm chord.
//
// Rules (Catmull & Clark 1978; crease rules after DeRose, Kass & Truong 1998,
// infinitely sharp creases only):
//   face point   average of the face's points
//   edge point   smooth: (a + b + f0 + f1) / 4;  crease or open boundary: (a + b) / 2
//   point        fewer than 2 sharp edges: (F + 2R + (n - 3) P) / n
//                exactly 2 sharp edges:      (a + 6P + b) / 8
//                3+ sharp edges, or an open-boundary point with one face: P (corner)
// An open boundary edge behaves as a crease. Sub-edges of a crease stay creased.
// Semi-sharp edges (sharpness s, DeRose et al. 1998): s >= 1 uses the crease
// rule at this step and hands its halves s - 1; 0 < s < 1 blends the smooth
// and crease rules by s. A point with 2+ sharp edges blends its smooth rule
// and its crease/corner rule by the average sharpness of those edges.
//
// Point numbering of a refined level: the old points first (same indices, so a
// cage point keeps its index at every level), then one point per edge, then
// one per face.

import type { Cage } from './cage'
import { edgeKey } from './cage'
import { buildHalfEdge, type HalfEdgeMesh } from './halfEdge'

/** A topology level: faces, sharp edges, and how many points it has. */
export interface Level {
  vertexCount: number
  faces: number[][]
  creases: Set<string>
  /** semi-sharp edges still sharp at this level: key -> remaining sharpness > 0 */
  sharpness?: Map<string, number>
}

/** Sparse rows: row r is sum over k in [offsets[r], offsets[r+1]) of weights[k] * point[index[k]]. */
export interface SparseRows {
  offsets: Int32Array
  index: Int32Array
  weights: Float64Array
}

class RowBuilder {
  offsets: number[] = [0]
  index: number[] = []
  weights: number[] = []
  add(entries: Map<number, number>): void {
    for (const [i, w] of entries) {
      this.index.push(i)
      this.weights.push(w)
    }
    this.offsets.push(this.index.length)
  }
  build(): SparseRows {
    return { offsets: Int32Array.from(this.offsets), index: Int32Array.from(this.index), weights: Float64Array.from(this.weights) }
  }
}

function bump(m: Map<number, number>, i: number, w: number): void {
  m.set(i, (m.get(i) ?? 0) + w)
}

export function levelFromCage(cage: Cage): Level {
  const sharpness = new Map<string, number>()
  for (const [key, v] of Object.entries(cage.weights ?? {})) if (v > 0 && !cage.creases.includes(key)) sharpness.set(key, v)
  return { vertexCount: cage.positions.length, faces: cage.faces.map((f) => f.slice()), creases: new Set(cage.creases), ...(sharpness.size > 0 ? { sharpness } : {}) }
}

/** An edge's sharpness at a level: Infinity for a crease or an open edge, its remaining weight, or 0. */
function edgeSharpness(level: Level, key: string, boundary: boolean): number {
  if (boundary || level.creases.has(key)) return Infinity
  return level.sharpness?.get(key) ?? 0
}

interface Adjacency {
  mesh: HalfEdgeMesh
  /** per point: the other ends of its edges */
  neighbours: number[][]
  /** per point: its faces */
  vertexFaces: number[][]
  /** per point: how many of its edges are sharp (crease or open boundary) */
  sharpCount: Int32Array
  /** per point: the other ends of its sharp edges */
  sharpNeighbours: number[][]
  /** per point: on an open boundary */
  onBoundary: Uint8Array
  /** per point: the sharpness of each of its sharp edges (same order as sharpNeighbours) */
  sharpValues: number[][]
}

function adjacency(level: Level): Adjacency {
  const mesh = buildHalfEdge({ positions: new Array(level.vertexCount), faces: level.faces, creases: [] })
  const n = level.vertexCount
  const neighbours: number[][] = Array.from({ length: n }, () => [])
  const vertexFaces: number[][] = Array.from({ length: n }, () => [])
  const sharpCount = new Int32Array(n)
  const sharpNeighbours: number[][] = Array.from({ length: n }, () => [])
  const onBoundary = new Uint8Array(n)
  const sharpValues: number[][] = Array.from({ length: n }, () => [])
  for (let f = 0; f < level.faces.length; f++) for (const v of level.faces[f]) vertexFaces[v].push(f)
  for (const [key, list] of mesh.edgeHalfEdges) {
    const a = mesh.origin[list[0]]
    const b = mesh.origin[mesh.next[list[0]]]
    neighbours[a].push(b)
    neighbours[b].push(a)
    const boundary = list.length === 1
    if (boundary) { onBoundary[a] = 1; onBoundary[b] = 1 }
    const s = edgeSharpness(level, key, boundary)
    if (s > 0) {
      sharpCount[a]++
      sharpCount[b]++
      sharpNeighbours[a].push(b)
      sharpNeighbours[b].push(a)
      sharpValues[a].push(s)
      sharpValues[b].push(s)
    }
  }
  return { mesh, neighbours, vertexFaces, sharpCount, sharpNeighbours, onBoundary, sharpValues }
}

export interface Refinement {
  level: Level
  /** finer point r = rows(r) . coarser points */
  rows: SparseRows
  /** coarse edge key -> index of its edge point in the finer level */
  edgePoint: Map<string, number>
  /** coarse face index -> index of its face point in the finer level */
  facePoint: Int32Array
  /** finer face index -> the coarse face it came from */
  faceParent: Int32Array
}

/** One Catmull-Clark step: the finer topology and the matrix that makes it. */
export function refine(level: Level): Refinement {
  const adj = adjacency(level)
  const { mesh } = adj
  const V = level.vertexCount
  const F = level.faces.length
  const edgeKeys = [...mesh.edgeHalfEdges.keys()]
  const edgePoint = new Map<string, number>()
  edgeKeys.forEach((key, i) => edgePoint.set(key, V + i))
  const facePoint = new Int32Array(F)
  for (let f = 0; f < F; f++) facePoint[f] = V + edgeKeys.length + f

  const faceRows: Array<Map<number, number>> = []
  for (let f = 0; f < F; f++) {
    const loop = level.faces[f]
    const m = new Map<number, number>()
    for (const v of loop) bump(m, v, 1 / loop.length)
    faceRows.push(m)
  }

  const rows = new RowBuilder()
  // 1. points
  for (let v = 0; v < V; v++) {
    const m = new Map<number, number>()
    const faces = adj.vertexFaces[v]
    const sharp = adj.sharpCount[v]
    const smooth = (target: Map<number, number>, k: number) => {
      const n = adj.neighbours[v].length
      // F: average of adjacent face points
      for (const f of faces) for (const [i, w] of faceRows[f]) bump(target, i, (k * w) / faces.length / n)
      // 2R: twice the average of edge midpoints
      for (const o of adj.neighbours[v]) {
        bump(target, v, (k * 2 * 0.5) / n / n)
        bump(target, o, (k * 2 * 0.5) / n / n)
      }
      bump(target, v, (k * (n - 3)) / n)
    }
    const sharpRule = (target: Map<number, number>, k: number) => {
      if (sharp === 2) {
        const [a, b] = adj.sharpNeighbours[v]
        bump(target, a, k / 8)
        bump(target, b, k / 8)
        bump(target, v, (k * 6) / 8)
      } else {
        bump(target, v, k)
      }
    }
    if (faces.length === 0 || (adj.onBoundary[v] === 1 && faces.length <= 1)) {
      m.set(v, 1)
    } else if (sharp < 2) {
      smooth(m, 1)
    } else {
      // the point's sharpness: the average of its sharp edges' (a crease or open edge: fully sharp)
      const values = adj.sharpValues[v]
      const vs = values.reduce((acc, x) => acc + x, 0) / values.length
      if (vs >= 1) sharpRule(m, 1)
      else { smooth(m, 1 - vs); sharpRule(m, vs) }
    }
    rows.add(m)
  }
  // 2. edge points
  for (const key of edgeKeys) {
    const list = mesh.edgeHalfEdges.get(key)!
    const a = mesh.origin[list[0]]
    const b = mesh.origin[mesh.next[list[0]]]
    const m = new Map<number, number>()
    const es = edgeSharpness(level, key, list.length === 1)
    const k = Math.min(1, es) // weight of the crease rule
    if (k > 0) {
      bump(m, a, 0.5 * k)
      bump(m, b, 0.5 * k)
    }
    if (k < 1) {
      bump(m, a, 0.25 * (1 - k))
      bump(m, b, 0.25 * (1 - k))
      for (const h of list) for (const [i, w] of faceRows[mesh.face[h]]) bump(m, i, w * 0.25 * (1 - k))
    }
    rows.add(m)
  }
  // 3. face points
  for (let f = 0; f < F; f++) rows.add(faceRows[f])

  // finer faces: one quad per face corner, same orientation
  const faces: number[][] = []
  const faceParent: number[] = []
  for (let f = 0; f < F; f++) {
    const loop = level.faces[f]
    const n = loop.length
    for (let i = 0; i < n; i++) {
      faceParent.push(f)
      const v = loop[i]
      const nextV = loop[(i + 1) % n]
      const prevV = loop[(i + n - 1) % n]
      faces.push([v, edgePoint.get(edgeKey(v, nextV))!, facePoint[f], edgePoint.get(edgeKey(prevV, v))!])
    }
  }
  const creases = new Set<string>()
  for (const key of level.creases) {
    const e = edgePoint.get(key)
    if (e === undefined) continue
    const [a, b] = key.split(':').map(Number)
    creases.add(edgeKey(a, e))
    creases.add(edgeKey(e, b))
  }
  // a semi-sharp edge hands its halves one step less sharpness
  const sharpness = new Map<string, number>()
  for (const [key, v] of level.sharpness ?? []) {
    const e = edgePoint.get(key)
    if (e === undefined || v - 1 <= 0) continue
    const [a, b] = key.split(':').map(Number)
    sharpness.set(edgeKey(a, e), v - 1)
    sharpness.set(edgeKey(e, b), v - 1)
  }
  return {
    level: { vertexCount: V + edgeKeys.length + F, faces, creases, ...(sharpness.size > 0 ? { sharpness } : {}) },
    rows: rows.build(),
    edgePoint,
    facePoint,
    faceParent: Int32Array.from(faceParent),
  }
}

/**
 * The limit-position mask of every point of an all-quad level (any level
 * after the first refinement). Smooth point of valence n:
 *   (n^2 P + 4 sum(edge neighbours) + sum(diagonal face points)) / (n (n + 5))
 * crease point: (a + 4P + b) / 6; corner: P.
 */
export function limitRows(level: Level): SparseRows {
  const adj = adjacency(level)
  const rows = new RowBuilder()
  for (let v = 0; v < level.vertexCount; v++) {
    const m = new Map<number, number>()
    const faces = adj.vertexFaces[v]
    const sharp = adj.sharpCount[v]
    const corner = sharp >= 3 || (adj.onBoundary[v] === 1 && faces.length <= 1)
    const allQuads = faces.every((f) => level.faces[f].length === 4)
    if (faces.length === 0 || corner) {
      m.set(v, 1)
    } else if (sharp === 2) {
      const [a, b] = adj.sharpNeighbours[v]
      bump(m, a, 1 / 6)
      bump(m, b, 1 / 6)
      bump(m, v, 4 / 6)
    } else if (!allQuads) {
      m.set(v, 1)
    } else {
      const n = adj.neighbours[v].length
      const d = n * (n + 5)
      bump(m, v, (n * n) / d)
      for (const o of adj.neighbours[v]) bump(m, o, 4 / d)
      for (const f of faces) {
        const loop = level.faces[f]
        const i = loop.indexOf(v)
        bump(m, loop[(i + 2) % 4], 1 / d)
      }
    }
    rows.add(m)
  }
  return rows.build()
}

/** out = rows . points (3 floats per point). */
export function applyRows(rows: SparseRows, points: ArrayLike<number>, out?: Float64Array): Float64Array {
  const count = rows.offsets.length - 1
  const result = out ?? new Float64Array(count * 3)
  for (let r = 0; r < count; r++) {
    let x = 0, y = 0, z = 0
    for (let k = rows.offsets[r]; k < rows.offsets[r + 1]; k++) {
      const i = rows.index[k] * 3
      const w = rows.weights[k]
      x += w * points[i]
      y += w * points[i + 1]
      z += w * points[i + 2]
    }
    result[r * 3] = x
    result[r * 3 + 1] = y
    result[r * 3 + 2] = z
  }
  return result
}

/** rows(A) . rows(B): compose two sparse steps (A applied after B). */
export function composeRows(a: SparseRows, b: SparseRows): SparseRows {
  const builder = new RowBuilder()
  const count = a.offsets.length - 1
  for (let r = 0; r < count; r++) {
    const m = new Map<number, number>()
    for (let k = a.offsets[r]; k < a.offsets[r + 1]; k++) {
      const j = a.index[k]
      const w = a.weights[k]
      for (let q = b.offsets[j]; q < b.offsets[j + 1]; q++) bump(m, b.index[q], w * b.weights[q])
    }
    builder.add(m)
  }
  return builder.build()
}

export function identityRows(count: number): SparseRows {
  const offsets = new Int32Array(count + 1)
  const index = new Int32Array(count)
  const weights = new Float64Array(count).fill(1)
  for (let i = 0; i < count; i++) { offsets[i + 1] = i + 1; index[i] = i }
  return { offsets, index, weights }
}

export function cagePositionArray(cage: Cage): Float64Array {
  const out = new Float64Array(cage.positions.length * 3)
  cage.positions.forEach((p, i) => { out[i * 3] = p[0]; out[i * 3 + 1] = p[1]; out[i * 3 + 2] = p[2] })
  return out
}
