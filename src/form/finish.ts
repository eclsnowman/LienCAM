// Form - Finish Form: tessellate the smooth (limit) surface to a chord
// tolerance, as a closed triangle mesh.
//
// Refinement goes level by level on positions directly (no stencils: Finish
// runs once). The chord error of level L is MEASURED, not guessed: every
// level-(L+1) limit point that is new (one per level-L edge and face) is
// compared with the level-L piece it would otherwise fall on - the edge point
// with its edge's midpoint, the face point with the centre of its quad -
// along the surface normal there. The first level whose worst deviation is within tolerance is used.

import type { Cage } from './cage'
import { applyRows, cagePositionArray, levelFromCage, limitRows, refine, type Level } from './subdivide'

export const DEFAULT_CHORD_TOLERANCE_MM = 0.01
/** A form is never refined past this many triangles; the achieved chord is reported instead. */
export const MAX_FINISH_TRIANGLES = 400_000

export interface FormTessellation {
  /** 3 floats per vertex */
  positions: Float64Array
  /** 3 vertex indices per triangle, counter-clockwise seen from outside */
  indices: Uint32Array
  level: number
  /** measured worst chord deviation of this mesh from the limit surface, mm */
  chordError: number
  tolerance: number
  /** true when the triangle cap stopped refinement before the tolerance was met */
  capped: boolean
}

function trianglesOf(level: Level): number {
  let n = 0
  for (const f of level.faces) n += f.length - 2
  return n
}

/**
 * Worst distance, ALONG THE SURFACE NORMAL, between the next level's new
 * limit points and this level's flat pieces (tangential drift of a point
 * inside a flat region is not a chord error).
 */
function chordErrorBetween(level: Level, limitPts: Float64Array, next: ReturnType<typeof refine>, nextLimit: Float64Array): number {
  // Newell normal of every level face (unit)
  const normals = new Float64Array(level.faces.length * 3)
  level.faces.forEach((loop, f) => {
    let nx = 0, ny = 0, nz = 0
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i] * 3, b = loop[(i + 1) % loop.length] * 3
      nx += (limitPts[a + 1] - limitPts[b + 1]) * (limitPts[a + 2] + limitPts[b + 2])
      ny += (limitPts[a + 2] - limitPts[b + 2]) * (limitPts[a] + limitPts[b])
      nz += (limitPts[a] - limitPts[b]) * (limitPts[a + 1] + limitPts[b + 1])
    }
    const len = Math.hypot(nx, ny, nz) || 1
    normals[f * 3] = nx / len; normals[f * 3 + 1] = ny / len; normals[f * 3 + 2] = nz / len
  })
  const facesOfEdge = new Map<string, number[]>()
  level.faces.forEach((loop, f) => {
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i], b = loop[(i + 1) % loop.length]
      const key = a < b ? `${a}:${b}` : `${b}:${a}`
      const list = facesOfEdge.get(key)
      if (list) list.push(f); else facesOfEdge.set(key, [f])
    }
  })
  // deviation of new point i from (x, y, z) along each normal of the faces it lies between (the larger)
  const dev = (i: number, x: number, y: number, z: number, faces: number[]) => {
    const dx = nextLimit[i * 3] - x, dy = nextLimit[i * 3 + 1] - y, dz = nextLimit[i * 3 + 2] - z
    let worst = 0
    for (const f of faces) worst = Math.max(worst, Math.abs(dx * normals[f * 3] + dy * normals[f * 3 + 1] + dz * normals[f * 3 + 2]))
    return worst
  }
  let worst = 0
  for (const [key, e] of next.edgePoint) {
    const [a, b] = key.split(':').map(Number)
    const x = (limitPts[a * 3] + limitPts[b * 3]) / 2
    const y = (limitPts[a * 3 + 1] + limitPts[b * 3 + 1]) / 2
    const z = (limitPts[a * 3 + 2] + limitPts[b * 3 + 2]) / 2
    worst = Math.max(worst, dev(e, x, y, z, facesOfEdge.get(key) ?? []))
  }
  level.faces.forEach((loop, f) => {
    let x = 0, y = 0, z = 0
    for (const v of loop) { x += limitPts[v * 3]; y += limitPts[v * 3 + 1]; z += limitPts[v * 3 + 2] }
    worst = Math.max(worst, dev(next.facePoint[f], x / loop.length, y / loop.length, z / loop.length, [f]))
  })
  return worst
}

export function tessellateForm(cage: Cage, tolerance = DEFAULT_CHORD_TOLERANCE_MM, maxTriangles = MAX_FINISH_TRIANGLES): FormTessellation {
  const tol = Math.max(1e-4, tolerance)
  let level = levelFromCage(cage)
  let pts = cagePositionArray(cage)
  // level 1 first: the limit mask needs an all-quad mesh
  const step = refine(level)
  pts = applyRows(step.rows, pts)
  level = step.level
  let depth = 1
  let limit = applyRows(limitRows(level), pts)
  let chordError: number
  let capped = false
  for (;;) {
    const next = refine(level)
    const nextPts = applyRows(next.rows, pts)
    const nextLimit = applyRows(limitRows(next.level), nextPts)
    chordError = chordErrorBetween(level, limit, next, nextLimit)
    if (chordError <= tol) break
    if (trianglesOf(next.level) > maxTriangles) { capped = true; break }
    level = next.level
    pts = nextPts
    limit = nextLimit
    depth++
  }
  const tris: number[] = []
  for (const loop of level.faces) {
    // split each quad along its shorter diagonal (the flatter pair of triangles)
    if (loop.length === 4) {
      const [a, b, c, dd] = loop
      const ac = Math.hypot(limit[a * 3] - limit[c * 3], limit[a * 3 + 1] - limit[c * 3 + 1], limit[a * 3 + 2] - limit[c * 3 + 2])
      const bd = Math.hypot(limit[b * 3] - limit[dd * 3], limit[b * 3 + 1] - limit[dd * 3 + 1], limit[b * 3 + 2] - limit[dd * 3 + 2])
      if (ac <= bd) tris.push(a, b, c, a, c, dd)
      else tris.push(a, b, dd, b, c, dd)
    } else {
      for (let i = 1; i + 1 < loop.length; i++) tris.push(loop[0], loop[i], loop[i + 1])
    }
  }
  return { positions: limit, indices: Uint32Array.from(tris), level: depth, chordError, tolerance: tol, capped }
}
