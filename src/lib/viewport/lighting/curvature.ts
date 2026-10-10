// Curvature per vertex, for the curvature display (zebra.ts reads it as the
// `aCurvature` attribute).
//
// Along each mesh edge p_i -> p_j the surface's normal curvature is
// (n_j - n_i) . (p_j - p_i) / |p_j - p_i|^2 - exact on a sphere with true
// surface normals, whatever the triangles look like. At each vertex a least
// squares fit of k(u) = a x^2 + 2 b x y + c y^2 over its edges' tangent
// directions u = (x, y) gives the shape operator; the value stored is its
// curvedness sqrt((k1^2 + k2^2) / 2) = sqrt((a^2 + 2 b^2 + c^2) / 2) (1 / mm):
// 1 / R on a sphere, 1 / (r sqrt 2) on a cylinder, non-zero on a saddle. The
// Gaussian curvature k1 k2 = a c - b^2 (1 / mm^2, the `aGauss` attribute) comes
// from the same fit: 1 / R^2 on a sphere, 0 on a cylinder or any ruled or flat
// face, negative on a saddle.
//
// Vertices are joined by position AND normal, so a sharp edge (its two sides'
// vertices share a position, not a normal) stays two separate rims instead of
// reading as a very tight curve.

import * as THREE from 'three'

type V3 = [number, number, number]

/** Per-vertex curvedness (1 / mm) of an indexed or plain triangle geometry with normals. */
export function vertexCurvature(positions: ArrayLike<number>, normals: ArrayLike<number>, index: ArrayLike<number> | null): Float32Array {
  return vertexCurvatures(positions, normals, index).curvedness
}

/** Per-vertex curvedness (1 / mm) and Gaussian curvature (1 / mm^2, signed). */
export function vertexCurvatures(positions: ArrayLike<number>, normals: ArrayLike<number>, index: ArrayLike<number> | null): { curvedness: Float32Array; gaussian: Float32Array } {
  const n = Math.floor(positions.length / 3)
  const out = new Float32Array(n)
  const outG = new Float32Array(n)
  if (n === 0 || normals.length < positions.length) return { curvedness: out, gaussian: outG }
  // join vertices sharing position and normal
  let size = 0
  for (let i = 0; i < positions.length; i++) size = Math.max(size, Math.abs(positions[i]))
  const qp = 1e6 / Math.max(size, 1e-9)
  const key = (i: number) => {
    const p = [0, 1, 2].map((k) => Math.round(positions[i * 3 + k] * qp)).join(',')
    const q = [0, 1, 2].map((k) => Math.round(normals[i * 3 + k] * 1e3)).join(',')
    return `${p}|${q}`
  }
  const idOf = new Int32Array(n)
  const ids = new Map<string, number>()
  const rep: number[] = []
  for (let i = 0; i < n; i++) {
    const k = key(i)
    let id = ids.get(k)
    if (id === undefined) { id = rep.length; ids.set(k, id); rep.push(i) }
    idOf[i] = id
  }
  const nbrs: Array<Set<number>> = rep.map(() => new Set<number>())
  const tri = index ? index.length : n
  for (let t = 0; t + 2 < tri; t += 3) {
    const v = [0, 1, 2].map((k) => idOf[index ? index[t + k] : t + k])
    for (let a = 0; a < 3; a++) {
      const x = v[a], y = v[(a + 1) % 3]
      if (x !== y) { nbrs[x].add(y); nbrs[y].add(x) }
    }
  }
  const P = (i: number): V3 => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]]
  const N = (i: number): V3 => { const v: V3 = [normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]]; const l = Math.hypot(...v) || 1; return [v[0] / l, v[1] / l, v[2] / l] }
  const value = new Float32Array(rep.length)
  const gauss = new Float32Array(rep.length)
  const unfit: number[] = []
  rep.forEach((vi, id) => {
    const p = P(vi), nv = N(vi)
    // a tangent basis
    const helper: V3 = Math.abs(nv[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
    let b1: V3 = [helper[1] * nv[2] - helper[2] * nv[1], helper[2] * nv[0] - helper[0] * nv[2], helper[0] * nv[1] - helper[1] * nv[0]]
    const l1 = Math.hypot(...b1); b1 = [b1[0] / l1, b1[1] / l1, b1[2] / l1]
    const b2: V3 = [nv[1] * b1[2] - nv[2] * b1[1], nv[2] * b1[0] - nv[0] * b1[2], nv[0] * b1[1] - nv[1] * b1[0]]
    // normal equations for (a, b, c): k = a x^2 + 2 b x y + c y^2
    const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], r = [0, 0, 0]
    let sumK2 = 0, count = 0
    for (const j of nbrs[id]) {
      const q = P(rep[j]), nj = N(rep[j])
      const e: V3 = [q[0] - p[0], q[1] - p[1], q[2] - p[2]]
      const e2 = e[0] * e[0] + e[1] * e[1] + e[2] * e[2]
      if (e2 < 1e-24) continue
      const k = ((nj[0] - nv[0]) * e[0] + (nj[1] - nv[1]) * e[1] + (nj[2] - nv[2]) * e[2]) / e2
      const x0 = e[0] * b1[0] + e[1] * b1[1] + e[2] * b1[2], y0 = e[0] * b2[0] + e[1] * b2[1] + e[2] * b2[2]
      const tl = Math.hypot(x0, y0)
      if (tl < 1e-12) continue
      const x = x0 / tl, y = y0 / tl
      const row = [x * x, 2 * x * y, y * y]
      for (let a = 0; a < 3; a++) { r[a] += row[a] * k; for (let b = 0; b < 3; b++) M[a][b] += row[a] * row[b] }
      sumK2 += k * k
      count++
    }
    if (count === 0) return
    const s = solve3(M, r)
    if (s === null) { value[id] = Math.sqrt(sumK2 / count); unfit.push(id); return }
    value[id] = Math.sqrt((s[0] * s[0] + 2 * s[1] * s[1] + s[2] * s[2]) / 2)
    gauss[id] = s[0] * s[2] - s[1] * s[1]
  })
  // too few edge directions to fit (a rim or seam end): the mean of its fitted neighbours (the edges'
  // rms only when none was fitted - it is not the same measure)
  const fitted = new Uint8Array(rep.length).fill(1)
  for (const id of unfit) fitted[id] = 0
  for (const id of unfit) {
    let sum = 0, sumG = 0, n = 0
    for (const j of nbrs[id]) if (fitted[j]) { sum += value[j]; sumG += gauss[j]; n++ }
    if (n > 0) { value[id] = sum / n; gauss[id] = sumG / n }
  }
  for (let i = 0; i < n; i++) { out[i] = value[idOf[i]]; outG[i] = gauss[idOf[i]] }
  return { curvedness: out, gaussian: outG }
}

/** Solve a 3 x 3 system; null when (nearly) singular - too few distinct edge directions. */
function solve3(M: number[][], r: number[]): [number, number, number] | null {
  const det = (m: number[][]) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  const d = det(M)
  const scale = Math.max(1e-30, Math.abs(M[0][0] * M[1][1] * M[2][2]))
  if (Math.abs(d) < 1e-6 * scale) return null
  const col = (k: number) => M.map((row, i) => row.map((v, j) => (j === k ? r[i] : v)))
  return [det(col(0)) / d, det(col(1)) / d, det(col(2)) / d]
}

/**
 * What each geometry's aCurvature was computed from: the attribute OBJECTS and
 * their versions. Versions alone are not enough - a fresh BufferAttribute
 * starts at version 0 again, and the Form overlay replaces its skin's buffers
 * whenever the level changes (a drag runs one level down), so a released drag
 * came back with the same count and versions and kept its pre-drag colours.
 * A WeakMap, not userData: three copies userData through JSON on clone.
 */
const stamps = new WeakMap<THREE.BufferGeometry, { pos: THREE.BufferAttribute; nor: THREE.BufferAttribute; index: THREE.BufferAttribute | null; versions: string }>()

/**
 * Give a mesh's geometry an up-to-date `aCurvature` attribute (recomputed only
 * when its positions, normals or index changed - replaced or edited - since the
 * last time).
 */
export function ensureCurvatureAttribute(geometry: THREE.BufferGeometry): void {
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute | undefined
  const nor = geometry.getAttribute('normal') as THREE.BufferAttribute | undefined
  if (pos === undefined || nor === undefined || pos.count === 0) return
  const index = geometry.index
  const versions = `${pos.version}:${nor.version}:${index?.version ?? -1}`
  const last = stamps.get(geometry)
  if (last !== undefined && last.pos === pos && last.nor === nor && last.index === index && last.versions === versions && geometry.getAttribute('aCurvature') !== undefined && geometry.getAttribute('aGauss') !== undefined) return
  const values = vertexCurvatures(pos.array, nor.array, index ? index.array : null)
  geometry.setAttribute('aCurvature', new THREE.BufferAttribute(values.curvedness, 1))
  geometry.setAttribute('aGauss', new THREE.BufferAttribute(values.gaussian, 1))
  stamps.set(geometry, { pos, nor, index, versions })
}
