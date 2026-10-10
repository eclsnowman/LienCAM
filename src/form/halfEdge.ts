// Form - half-edge topology over a cage, and the validator that runs after
// every topology operation.
//
// Design references: OpenMesh / pmp-library (half-edge layout), Wings3D
// (winged-edge editing). Our own TypeScript: the cage is small (tens to a few
// hundred points), so the structure is rebuilt from the plain Cage data after
// each topology change rather than edited in place. That keeps every edit
// operation a pure Cage -> Cage function and makes undo a snapshot.
//
// Half-edge h runs from `origin[h]` to the origin of `next[h]` inside face
// `face[h]`. `twin[h]` is the opposite half-edge, or -1 on an open boundary.

import type { Cage } from './cage'
import { edgeKey } from './cage'

export interface HalfEdgeMesh {
  vertexCount: number
  faceCount: number
  /** per half-edge */
  origin: Int32Array
  next: Int32Array
  prev: Int32Array
  twin: Int32Array
  face: Int32Array
  /** first half-edge of each face */
  faceHalfEdge: Int32Array
  /** one outgoing half-edge per vertex (a boundary one when the vertex is on a boundary), -1 if unused */
  vertexHalfEdge: Int32Array
  /** undirected edge key -> the half-edges on it (1 or 2 when manifold) */
  edgeHalfEdges: Map<string, number[]>
}

export function buildHalfEdge(cage: Cage): HalfEdgeMesh {
  const vertexCount = cage.positions.length
  const faceCount = cage.faces.length
  let total = 0
  for (const f of cage.faces) total += f.length
  const origin = new Int32Array(total)
  const next = new Int32Array(total)
  const prev = new Int32Array(total)
  const twin = new Int32Array(total).fill(-1)
  const face = new Int32Array(total)
  const faceHalfEdge = new Int32Array(faceCount)
  const vertexHalfEdge = new Int32Array(vertexCount).fill(-1)
  const edgeHalfEdges = new Map<string, number[]>()

  let h = 0
  for (let fi = 0; fi < faceCount; fi++) {
    const loop = cage.faces[fi]
    const n = loop.length
    faceHalfEdge[fi] = h
    for (let i = 0; i < n; i++) {
      origin[h + i] = loop[i]
      next[h + i] = h + ((i + 1) % n)
      prev[h + i] = h + ((i + n - 1) % n)
      face[h + i] = fi
    }
    h += n
  }
  // each vertex's outgoing half-edges (a string, or even a Map entry, per half-edge was most of the build
  // on a refined mesh); twins and the edge map read these short lists
  const outStart = new Int32Array(vertexCount + 1)
  for (let e = 0; e < total; e++) outStart[origin[e] + 1]++
  for (let v = 0; v < vertexCount; v++) outStart[v + 1] += outStart[v]
  const outList = new Int32Array(total)
  const fill = outStart.slice(0, vertexCount)
  for (let e = 0; e < total; e++) outList[fill[origin[e]]++] = e
  for (let e = 0; e < total; e++) {
    const a = origin[e], b = origin[next[e]]
    // the last half-edge b -> a, as a map keyed by direction kept it
    for (let k = outStart[b]; k < outStart[b + 1]; k++) if (origin[next[outList[k]]] === a) twin[e] = outList[k]
  }
  // every half-edge on each edge, in order, as the validator reads it; the edge's first half-edge adds it
  for (let e = 0; e < total; e++) {
    const a = origin[e], b = origin[next[e]]
    const list: number[] = []
    for (let k = outStart[a]; k < outStart[a + 1]; k++) if (origin[next[outList[k]]] === b) list.push(outList[k])
    if (a !== b) for (let k = outStart[b]; k < outStart[b + 1]; k++) if (origin[next[outList[k]]] === a) list.push(outList[k])
    list.sort((x, y) => x - y)
    if (list[0] === e) edgeHalfEdges.set(edgeKey(a, b), list)
  }
  for (let e = 0; e < total; e++) {
    const v = origin[e]
    // prefer the outgoing half-edge with no twin: the rotation walk
    // (h -> twin(prev(h))) has no predecessor there, so it starts at the boundary
    if (vertexHalfEdge[v] === -1 || twin[e] === -1) vertexHalfEdge[v] = e
  }
  return { vertexCount, faceCount, origin, next, prev, twin, face, faceHalfEdge, vertexHalfEdge, edgeHalfEdges }
}

/** The point indices of face f, in loop order. */
export function faceVertices(mesh: HalfEdgeMesh, f: number): number[] {
  const out: number[] = []
  const start = mesh.faceHalfEdge[f]
  let h = start
  do {
    out.push(mesh.origin[h])
    h = mesh.next[h]
  } while (h !== start)
  return out
}

/**
 * Outgoing half-edges of vertex v in rotation order. Starts at the boundary
 * when v sits on one. Assumes a manifold vertex (validateCage refuses others).
 */
export function vertexOutgoing(mesh: HalfEdgeMesh, v: number): number[] {
  const start = mesh.vertexHalfEdge[v]
  if (start < 0) return []
  const out: number[] = []
  let h = start
  // rotate: the next outgoing edge around v is twin(prev(h))
  for (let step = 0; step < 1024; step++) {
    out.push(h)
    const t = mesh.twin[mesh.prev[h]]
    if (t < 0 || t === start) break
    h = t
  }
  return out
}

export interface CageValidation {
  ok: boolean
  /** every surface edge has two faces (a watertight cage) */
  closed: boolean
  /** plain-words findings; empty when ok */
  problems: string[]
  boundaryEdgeCount: number
  edgeCount: number
  eulerCharacteristic: number
}

/**
 * The validator run after every topology operation: manifold (each edge has
 * at most two faces, each vertex one fan), oriented (neighbour faces run a
 * shared edge in opposite directions), every face has 3+ distinct points,
 * every point index exists and every point is used. `expectClosed` adds the
 * closed check (a box/cylinder/sphere cage must stay watertight; a plane is
 * open by design).
 */
export function validateCage(cage: Cage, expectClosed = false): CageValidation {
  const problems: string[] = []
  const n = cage.positions.length
  const used = new Uint8Array(n)
  for (let fi = 0; fi < cage.faces.length; fi++) {
    const loop = cage.faces[fi]
    if (loop.length < 3) problems.push(`face ${fi} has ${loop.length} points (needs 3 or more)`)
    const distinct = new Set(loop)
    if (distinct.size !== loop.length) problems.push(`face ${fi} repeats a point`)
    for (const v of loop) {
      if (!Number.isInteger(v) || v < 0 || v >= n) problems.push(`face ${fi} names point ${v}, which does not exist`)
      else used[v] = 1
    }
  }
  for (let v = 0; v < n; v++) {
    if (!used[v]) problems.push(`point ${v} belongs to no face`)
    const p = cage.positions[v]
    if (!p || !p.every(Number.isFinite)) problems.push(`point ${v} has no finite position`)
  }
  if (problems.length > 0) {
    return { ok: false, closed: false, problems, boundaryEdgeCount: 0, edgeCount: 0, eulerCharacteristic: 0 }
  }

  const mesh = buildHalfEdge(cage)
  let boundaryEdgeCount = 0
  const seenDirected = new Set<string>()
  for (let e = 0; e < mesh.origin.length; e++) {
    const key = `${mesh.origin[e]}>${mesh.origin[mesh.next[e]]}`
    if (seenDirected.has(key)) problems.push(`edge ${key.replace('>', '-')} runs the same way in two faces (faces are not consistently oriented)`)
    seenDirected.add(key)
  }
  for (const [key, list] of mesh.edgeHalfEdges) {
    if (list.length > 2) problems.push(`edge ${key.replace(':', '-')} has ${list.length} faces (non-manifold)`)
    if (list.length === 1) boundaryEdgeCount++
  }
  // one fan per vertex: the rotation walk must visit every outgoing half-edge
  const outgoingCount = new Int32Array(n)
  for (let e = 0; e < mesh.origin.length; e++) outgoingCount[mesh.origin[e]]++
  if (problems.length === 0) {
    for (let v = 0; v < n; v++) {
      if (vertexOutgoing(mesh, v).length !== outgoingCount[v]) {
        problems.push(`point ${v} joins two separate fans of faces (non-manifold point)`)
      }
    }
  }
  const closed = boundaryEdgeCount === 0
  if (expectClosed && !closed) problems.push(`the cage has ${boundaryEdgeCount} open edges; it should be closed`)
  const edgeCount = mesh.edgeHalfEdges.size
  for (const key of cage.creases) {
    if (!mesh.edgeHalfEdges.has(key)) problems.push(`crease ${key.replace(':', '-')} is not an edge of the cage`)
  }
  return {
    ok: problems.length === 0,
    closed,
    problems,
    boundaryEdgeCount,
    edgeCount,
    eulerCharacteristic: n - edgeCount + cage.faces.length,
  }
}
