// Form - hide the edges of a form body where its faces meet smoothly.
//
// A form body's faces are many: every triangle of the faceted body, every
// first-level quad of the exact one. Drawn as body edges that is a wireframe
// of the whole knob. The edges that mean something are the creases and the
// boundaries against other geometry (a boolean cut, a hole). This drops an
// edge from the display buffers when BOTH faces it joins are faces of a form
// (stable ids rooted at a form feature: `FRMn:face#i` for the faceted body,
// `FRMn:step:face#i` for the exact one) and the surface is smooth across it:
// the two triangles on either side of the edge's middle segment meet within
// SMOOTH_FACET_ANGLE_DEG. Every other edge - on every other body, and a
// form's creased or cut edges - is untouched.

import type { TessBuffers } from '../geom/geom-service'

/** Faces meeting at less than this read as one smooth surface (a crease is ~90 deg). */
export const SMOOTH_FACET_ANGLE_DEG = 30

const FORM_FACE_ID = /^FRM\d+:(step:)?face#\d+$/

export function isFormFacetId(id: string | undefined): boolean {
  return id !== undefined && FORM_FACE_ID.test(id)
}

/** Buffers with the smooth form edges removed (same object when there is nothing to remove). */
export function withoutSmoothFormFacetEdges(buffers: TessBuffers): TessBuffers {
  const formFace = buffers.faceIds.map(isFormFacetId)
  if (!formFace.some(Boolean)) return buffers

  // quantised vertex key -> the form triangles that use a vertex there; per triangle its normal
  const key = (x: number, y: number, z: number) => `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`
  const trianglesAt = new Map<string, number[]>()
  const normal = new Map<number, [number, number, number]>()
  const P = buffers.position
  for (let t = 0; t < buffers.triFace.length; t++) {
    if (!formFace[buffers.triFace[t]]) continue
    const ia = buffers.index[t * 3], ib = buffers.index[t * 3 + 1], ic = buffers.index[t * 3 + 2]
    for (const i of [ia, ib, ic]) {
      const k = key(P[i * 3], P[i * 3 + 1], P[i * 3 + 2])
      const list = trianglesAt.get(k)
      if (list) list.push(t)
      else trianglesAt.set(k, [t])
    }
    const ux = P[ib * 3] - P[ia * 3], uy = P[ib * 3 + 1] - P[ia * 3 + 1], uz = P[ib * 3 + 2] - P[ia * 3 + 2]
    const vx = P[ic * 3] - P[ia * 3], vy = P[ic * 3 + 1] - P[ia * 3 + 1], vz = P[ic * 3 + 2] - P[ia * 3 + 2]
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const l = Math.hypot(nx, ny, nz)
    if (l > 0) normal.set(t, [nx / l, ny / l, nz / l])
  }

  const faceIndex = new Map(buffers.faceIds.map((id, f) => [id, f]))
  let trianglesOfFace: number[][] | null = null
  const nearestTriangle = (f: number, x: number, y: number, z: number): number => {
    if (trianglesOfFace === null) {
      trianglesOfFace = buffers.faceIds.map(() => [])
      for (let t = 0; t < buffers.triFace.length; t++) trianglesOfFace[buffers.triFace[t]].push(t)
    }
    let best = -1, bestD = Infinity
    for (const t of trianglesOfFace[f]) {
      let cx = 0, cy = 0, cz = 0
      for (let k = 0; k < 3; k++) { const i = buffers.index[t * 3 + k]; cx += P[i * 3]; cy += P[i * 3 + 1]; cz += P[i * 3 + 2] }
      const d = (cx / 3 - x) ** 2 + (cy / 3 - y) ** 2 + (cz / 3 - z) ** 2
      if (d < bestD) { bestD = d; best = t }
    }
    return best
  }
  const cosLimit = Math.cos((SMOOTH_FACET_ANGLE_DEG * Math.PI) / 180)
  const E = buffers.edgePositions
  const edgeCount = buffers.edgeOffsets.length - 1
  const keep: boolean[] = []
  for (let e = 0; e < edgeCount; e++) {
    const start = buffers.edgeOffsets[e], end = buffers.edgeOffsets[e + 1]
    if (end - start < 2) { keep.push(true); continue }
    // the middle segment of the edge's polyline, and the triangle on each side of it
    const s0 = start + Math.floor((end - start - 1) / 2)
    const a = trianglesAt.get(key(E[s0 * 3], E[s0 * 3 + 1], E[s0 * 3 + 2])) ?? []
    const b = trianglesAt.get(key(E[(s0 + 1) * 3], E[(s0 + 1) * 3 + 1], E[(s0 + 1) * 3 + 2])) ?? []
    let beside = a.filter((t) => b.includes(t))
    if (beside.length !== 2 || buffers.triFace[beside[0]] === buffers.triFace[beside[1]]) {
      // a curved face's edge is discretised apart from its triangles: take the triangle of each
      // face the edge id names that lies nearest the middle of the segment
      // `(faceA\u2227faceB)`, with an `@...` tail when the two faces meet along more than one edge (packed faces often do)
      const named = /^\((.+)\u2227(.+)\)(@.*)?$/.exec(buffers.edgeIds[e] ?? '')
      const fa = named ? faceIndex.get(named[1]) : undefined, fb = named ? faceIndex.get(named[2]) : undefined
      if (fa === undefined || fb === undefined || fa === fb || !formFace[fa] || !formFace[fb]) { keep.push(true); continue }
      const mx = (E[s0 * 3] + E[(s0 + 1) * 3]) / 2, my = (E[s0 * 3 + 1] + E[(s0 + 1) * 3 + 1]) / 2, mz = (E[s0 * 3 + 2] + E[(s0 + 1) * 3 + 2]) / 2
      beside = [nearestTriangle(fa, mx, my, mz), nearestTriangle(fb, mx, my, mz)].filter((t) => t >= 0)
      if (beside.length !== 2) { keep.push(true); continue }
    }
    const n0 = normal.get(beside[0]), n1 = normal.get(beside[1])
    const smooth = n0 !== undefined && n1 !== undefined && n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2] >= cosLimit
    keep.push(!smooth)
  }
  if (keep.every(Boolean)) return buffers

  const positions: number[] = []
  const offsets: number[] = []
  const ids: string[] = []
  const classes: NonNullable<TessBuffers['edgeClasses']> = []
  for (let e = 0; e < edgeCount; e++) {
    if (!keep[e]) continue
    offsets.push(positions.length / 3)
    for (let p = buffers.edgeOffsets[e]; p < buffers.edgeOffsets[e + 1]; p++) positions.push(E[p * 3], E[p * 3 + 1], E[p * 3 + 2])
    ids.push(buffers.edgeIds[e])
    if (buffers.edgeClasses !== undefined && e < buffers.edgeClasses.length) classes.push(buffers.edgeClasses[e])
  }
  offsets.push(positions.length / 3)
  return {
    ...buffers,
    edgePositions: Float32Array.from(positions),
    edgeOffsets: Uint32Array.from(offsets),
    edgeIds: ids,
    ...(buffers.edgeClasses !== undefined ? { edgeClasses: classes.length === ids.length ? classes : classes.slice(0, ids.length) } : {}),
  }
}
