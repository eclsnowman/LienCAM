// GEO-23 L4 (mandated by GEO-23-R1 audit cure C2): per-vertex ambient occlusion
// baked into a geometry attribute and multiplied into a body's MeshStandardMaterial
// indirect (and a fraction of direct) light via onBeforeCompile.
//
// WHY vertex AO and not a screen-space pass: overlay safety (G2) is a merge
// criterion. A full-screen SSAO/GTAO pass darkens the whole framebuffer, including
// the unlit amber selection markers / sketch overlays / toolpath lines, unless a
// layered multi-pass composite excludes them. Vertex AO lives ENTIRELY in BODY
// geometry (a float attribute) sampled only by MeshStandardMaterial; the overlay
// materials are LineBasicMaterial / MeshBasicMaterial that never read it and are
// separate objects with separate geometry -- so the AO cue CANNOT touch an overlay
// pixel by construction. That is the G2 mechanism, stated plainly.
//
// WHY it reads as depth: occlusion is LOCAL (max distance = a small fraction of the
// body's radius, AO_RADIUS_FACTOR). A vertex on a bored cavity's wall/floor sees
// the surrounding walls close by and is occluded; a vertex on the open flat face
// sees mostly open space and is not. So the interior darkens with depth while the
// face stays bright -- exactly the rim-to-floor gradient + "interior darker than
// face" the audit demanded, and physically what makes a real hole read as a hole.
//
// Determinism: a FIXED Fibonacci-hemisphere sample set (no Math.random), so the
// baked AO -- and therefore the render matrix -- is byte-reproducible run to run.

import * as THREE from 'three'
import { MeshBVH } from 'three-mesh-bvh'
import {
  AO_ENABLED, AO_RAYS, AO_RADIUS_FACTOR, AO_STRENGTH, AO_MIN, AO_MIN_F32, AO_DIRECT_DIM,
} from './rigDescriptors.ts'

/** Geometry attribute name carrying the baked per-vertex AO factor in [AO_MIN, 1].
 *  Deliberately NOT `color` -- the Model workspace's highlight system owns the
 *  `color` attribute; AO rides its own attribute so the two never collide. */
export const AO_ATTRIBUTE = 'geo23Ao'

/** Marker so a material is patched at most once (materials outlive geometry). */
const AO_PATCH_FLAG = 'geo23AoPatched'

export interface AoBakeResult {
  /** Wall-clock ms to build the BVH + sample every vertex (one-time, at load). */
  bakeMs: number
  /** Number of vertices sampled (0 if AO was skipped). */
  vertices: number
  /** Bytes retained by the baked AO attribute (vertices * 4); the BVH is transient. */
  attributeBytes: number
  /** Exact attribute installed on the geometry; reusable as a display artifact. */
  ao?: Float32Array
}

export function isValidVertexAO(value: unknown, vertexCount: number): value is Float32Array {
  if (!(value instanceof Float32Array) || value.length !== vertexCount) return false
  for (const factor of value) {
    if (!Number.isFinite(factor) || factor < AO_MIN_F32 || factor > 1) return false
  }
  return true
}

// Fixed deterministic hemisphere sample set (tangent space, +Z = surface normal),
// cosine-relevant weight = z. Built once at module load.
const SAMPLES: Array<{ x: number; y: number; z: number }> = (() => {
  const out: Array<{ x: number; y: number; z: number }> = []
  const n = AO_RAYS
  const golden = Math.PI * (3 - Math.sqrt(5)) // golden angle
  for (let i = 0; i < n; i++) {
    // z in (0,1]: upper hemisphere only (never sample below the surface).
    const z = (i + 0.5) / n
    const r = Math.sqrt(Math.max(0, 1 - z * z))
    const phi = i * golden
    out.push({ x: Math.cos(phi) * r, y: Math.sin(phi) * r, z })
  }
  return out
})()

/** Build an orthonormal tangent frame (t, b) for a unit normal n. */
function basisFromNormal(nx: number, ny: number, nz: number): { tx: number; ty: number; tz: number; bx: number; by: number; bz: number } {
  // Pick a helper axis not parallel to n, cross to get tangent, then bitangent.
  const hx = Math.abs(nz) < 0.9 ? 0 : 1
  const hy = 0
  const hz = Math.abs(nz) < 0.9 ? 1 : 0
  // t = normalize(cross(h, n))
  let tx = hy * nz - hz * ny
  let ty = hz * nx - hx * nz
  let tz = hx * ny - hy * nx
  const tm = Math.hypot(tx, ty, tz) || 1
  tx /= tm; ty /= tm; tz /= tm
  // b = cross(n, t) (already unit since n,t orthonormal)
  const bx = ny * tz - nz * ty
  const by = nz * tx - nx * tz
  const bz = nx * ty - ny * tx
  return { tx, ty, tz, bx, by, bz }
}

/** WO-2200: the most vertices a body gets the exact per-vertex bake for. The bake
 *  runs on the page thread at ~0.1-0.2 ms a vertex, so a mesh relief (the portrait:
 *  627,534 vertices) stopped the Model screen for two minutes. A body at or under
 *  this bakes exactly as before; ordinary machined parts are well under it. */
export const AO_EXACT_VERTEX_BUDGET = 50_000

/** WO-2200: above the budget the bake casts the same rays from about this many
 *  sample vertices (0.6..1.25x) spread evenly over the surface and interpolates the
 *  rest (computeSampledAO). Rays cost ~0.2-0.3 ms a sample on the portrait's
 *  1.25M-triangle mesh in the browser, so its whole bake (BVH included) stays near a
 *  second. AO here is local but wide (AO_RADIUS_FACTOR x the body's radius, ~20 mm
 *  on a relief plate), so a sample every ~2.5 mm keeps the shading the eye reads;
 *  the relief's own fine detail is drawn by its normals, which are untouched.
 *  A body of many small faces (a fixture plate's holes) gets more: see
 *  AO_SAMPLES_PER_GROUP. */
export const AO_SAMPLED_VERTICES = 2_000

/** WO-2200: above the budget, samples per surface group (surfaceGroups), from
 *  AO_SAMPLED_VERTICES up to 4x it. A relief has a handful of groups and its AO
 *  changes over centimetres, so it keeps AO_SAMPLED_VERTICES; a machined part over
 *  the budget has hundreds of small faces (hole walls, counterbores) whose AO changes
 *  over millimetres, and one sample a face flattens each hole's shading (measured on a
 *  fixture plate: mean error 0.126 at 2,000 samples, 0.034 at 8,000). 8,000 samples
 *  cost ~1.5 s at the browser's ~0.19 ms a sample. */
export const AO_SAMPLES_PER_GROUP = 4

/**
 * Compute a per-vertex AO factor in [AO_MIN, 1] for `geometry` and store it in the
 * AO_ATTRIBUTE. Returns the Float32Array (also set on the geometry). Requires a
 * position + normal attribute; returns a flat (all-1) array if AO is disabled or
 * inputs are missing (fail-open to "no darkening", never to garbage).
 */
export function computeVertexAO(
  geometry: THREE.BufferGeometry,
  exactBudget: number = AO_EXACT_VERTEX_BUDGET,
  sampledVertices: number = AO_SAMPLED_VERTICES,
): { ao: Float32Array; bakeMs: number } {
  const t0 = performance.now()
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute | undefined
  const nrm = geometry.getAttribute('normal') as THREE.BufferAttribute | undefined
  const count = pos ? pos.count : 0
  const ao = new Float32Array(count).fill(1)
  if (!AO_ENABLED || !pos || !nrm || count === 0) return { ao, bakeMs: 0 }

  if (geometry.boundingSphere === null) geometry.computeBoundingSphere()
  const radius = geometry.boundingSphere ? geometry.boundingSphere.radius : 0
  const maxDist = radius * AO_RADIUS_FACTOR
  if (!(maxDist > 0)) return { ao, bakeMs: performance.now() - t0 }
  const eps = Math.max(1e-5, maxDist * 1e-3)

  // Own BVH over this geometry. `indirect: true` is REQUIRED: the default MeshBVH
  // reorders geometry.index in place to build the tree, which would corrupt the
  // triFace / faceRanges mapping the pick + highlight systems rely on (this is why
  // GeometryCache also builds with indirect:true). Transient: dropped when this
  // function returns, so it retains no GPU/heap memory beyond the AO attribute.
  // Over the budget only ~AO_SAMPLED_VERTICES vertices cast rays, so a shallower
  // tree (bigger leaves) builds in about half the time for the same hits.
  const sampled = count > exactBudget
  const bvh = new MeshBVH(geometry, sampled ? { indirect: true, maxLeafSize: 24 } : { indirect: true })
  const px = pos.array as ArrayLike<number>
  const nx = nrm.array as ArrayLike<number>
  const occlusionAt = vertexOcclusion(bvh, px, nx, maxDist, eps)

  if (sampled) computeSampledAO(geometry, px, nx, count, sampledVertices, occlusionAt, ao)
  else for (let v = 0; v < count; v++) ao[v] = occlusionAt(v)

  geometry.setAttribute(AO_ATTRIBUTE, new THREE.BufferAttribute(ao, 1))
  return { ao, bakeMs: performance.now() - t0 }
}

/** The AO factor of one vertex: the fixed hemisphere of rays from just off it. */
function vertexOcclusion(
  bvh: MeshBVH, px: ArrayLike<number>, nx: ArrayLike<number>, maxDist: number, eps: number,
): (v: number) => number {
  const ray = new THREE.Ray()
  return (v) => {
    const ox = px[v * 3], oy = px[v * 3 + 1], oz = px[v * 3 + 2]
    let vnx = nx[v * 3], vny = nx[v * 3 + 1], vnz = nx[v * 3 + 2]
    const nm = Math.hypot(vnx, vny, vnz) || 1
    vnx /= nm; vny /= nm; vnz /= nm
    const { tx, ty, tz, bx, by, bz } = basisFromNormal(vnx, vny, vnz)
    // Offset the origin off the surface along the normal to avoid self-hits.
    const sx = ox + vnx * eps, sy = oy + vny * eps, sz = oz + vnz * eps
    let occl = 0, wsum = 0
    for (const s of SAMPLES) {
      // world dir = t*s.x + b*s.y + n*s.z (hemisphere about the normal)
      const dx = tx * s.x + bx * s.y + vnx * s.z
      const dy = ty * s.x + by * s.y + vny * s.z
      const dz = tz * s.x + bz * s.y + vnz * s.z
      ray.origin.set(sx, sy, sz)
      ray.direction.set(dx, dy, dz).normalize()
      const w = s.z // cosine weight
      wsum += w
      const hit = bvh.raycastFirst(ray, THREE.DoubleSide, 0, maxDist)
      if (hit) occl += w
    }
    const occludedFraction = wsum > 0 ? occl / wsum : 0
    let f = 1 - occludedFraction * AO_STRENGTH
    if (f < AO_MIN) f = AO_MIN
    if (f > 1) f = 1
    return f
  }
}

/** Index of a normal's dominant axis and sign (0..5), so the two sides of a thin
 *  wall never share a sample. */
function normalBucket(x: number, y: number, z: number): number {
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z)
  if (ax >= ay && ax >= az) return x >= 0 ? 0 : 1
  if (ay >= az) return y >= 0 ? 2 : 3
  return z >= 0 ? 4 : 5
}

/**
 * Each vertex's surface group: its connected piece of the mesh (vertices joined by
 * triangles - on a kernel body's display mesh, one piece per face, since faces do not
 * share vertices) and its normal bucket, numbered densely from 0. Returns the group
 * of every vertex and how many groups there are. A non-indexed mesh is one piece.
 */
function surfaceGroups(geometry: THREE.BufferGeometry, nx: ArrayLike<number>, count: number): { group: Uint32Array; groups: number } {
  const parent = new Int32Array(count)
  for (let v = 0; v < count; v++) parent[v] = v
  const root = (v: number): number => {
    while (parent[v] !== v) { parent[v] = parent[parent[v]]; v = parent[v] }
    return v
  }
  const index = geometry.getIndex()
  if (index) {
    const idx = index.array as ArrayLike<number>
    for (let t = 0; t + 2 < idx.length; t += 3) {
      const a = root(idx[t]), b = root(idx[t + 1]), c = root(idx[t + 2])
      if (a !== b) parent[b] = a
      const ab = root(a)
      if (ab !== c) parent[c] = ab
    }
  } else {
    parent.fill(0)
  }
  const ids = new Map<number, number>()
  const group = new Uint32Array(count)
  for (let v = 0; v < count; v++) {
    const key = root(v) * 6 + normalBucket(nx[v * 3], nx[v * 3 + 1], nx[v * 3 + 2])
    let id = ids.get(key)
    if (id === undefined) { id = ids.size; ids.set(key, id) }
    group[v] = id
  }
  return { group, groups: ids.size }
}

/**
 * WO-2200: AO for a body over the vertex budget. Each surface group (surfaceGroups:
 * one connected piece of the surface facing one way) is cut into cubic cells of its
 * own; in each (group, cell) the vertex nearest the cell's centre is baked exactly
 * (occlusionAt), and every vertex takes the trilinear blend of its group's baked
 * values in the 2 x 2 x 2 cells round it. Its own cell is always one of them, so every
 * vertex gets a value. Groups keep a part's outer wall from taking the value of a
 * hole wall beside it that faces the same way, and the two sides of a thin wall apart.
 * Cells are sized so about `budget` of them hold surface - or AO_SAMPLES_PER_GROUP a
 * group, up to 4 x `budget`, on a body of many small faces - shared out by vertices,
 * not by area: the kernel meshes a flat face with few vertices and a hole wall with
 * many, and a hole's wall is where AO changes over millimetres. A body with more
 * groups than that gets at least one sample per group. Deterministic: no randomness,
 * fixed visiting order.
 */
function computeSampledAO(
  geometry: THREE.BufferGeometry, px: ArrayLike<number>, nx: ArrayLike<number>, count: number,
  sampledVertices: number, occlusionAt: (v: number) => number, ao: Float32Array,
): void {
  const buckets = new Uint8Array(count)
  for (let v = 0; v < count; v++) buckets[v] = normalBucket(nx[v * 3], nx[v * 3 + 1], nx[v * 3 + 2])
  const { group, groups } = surfaceGroups(geometry, nx, count)
  const budget = Math.min(4 * sampledVertices, Math.max(sampledVertices, AO_SAMPLES_PER_GROUP * groups))

  // Each group's box, vertex count and area (a triangle's area split over its corners).
  const gMin = new Float64Array(groups * 3).fill(Infinity)
  const gMax = new Float64Array(groups * 3).fill(-Infinity)
  const gVerts = new Float64Array(groups)
  for (let v = 0; v < count; v++) {
    const g = group[v]
    gVerts[g]++
    for (let k = 0; k < 3; k++) {
      const c = px[v * 3 + k]
      if (c < gMin[g * 3 + k]) gMin[g * 3 + k] = c
      if (c > gMax[g * 3 + k]) gMax[g * 3 + k] = c
    }
  }
  const gArea = new Float64Array(groups)
  const area = surfaceArea(geometry, px, (a, b, c, third) => { gArea[group[a]] += third; gArea[group[b]] += third; gArea[group[c]] += third })
  // A group's cell side is scale x the common side h: sqrt(area share / vertex share)
  // gives each group about budget x (its vertices / all vertices) cells.
  const scale = new Float64Array(groups).fill(1)
  if (area > 0) {
    for (let g = 0; g < groups; g++) {
      scale[g] = Math.min(8, Math.max(0.125, Math.sqrt((gArea[g] / area) / (gVerts[g] / count))))
    }
  }

  // Every group's grid for a common side h: its dims and where its keys start.
  const layout = (h: number) => {
    const dims = new Float64Array(groups * 3)
    const offset = new Float64Array(groups)
    let total = 0
    for (let g = 0; g < groups; g++) {
      const side = h * scale[g]
      for (let k = 0; k < 3; k++) dims[g * 3 + k] = Math.floor((gMax[g * 3 + k] - gMin[g * 3 + k]) / side) + 2
      offset[g] = total
      total += dims[g * 3] * dims[g * 3 + 1] * dims[g * 3 + 2]
    }
    return { dims, offset, total }
  }
  const keyOf = (g: number, dims: Float64Array, offset: Float64Array, ix: number, iy: number, iz: number) =>
    offset[g] + (ix * dims[g * 3 + 1] + iy) * dims[g * 3 + 2] + iz

  // Size the cells on an evenly strided subset of the vertices (cheap): first guess
  // from the surface area (a flat face of area A crosses ~A/h^2 cells of side h),
  // then bisect until 0.6..1.1 x budget cells hold surface.
  const stride = Math.max(1, Math.floor(count / 50_000))
  const occupied = (h: number): number => {
    const { dims, offset, total } = layout(h)
    const seen = cellTable(total)
    let n = 0
    for (let v = 0; v < count; v += stride) {
      const g = group[v], side = h * scale[g]
      const key = keyOf(g, dims, offset, Math.floor((px[v * 3] - gMin[g * 3]) / side),
        Math.floor((px[v * 3 + 1] - gMin[g * 3 + 1]) / side), Math.floor((px[v * 3 + 2] - gMin[g * 3 + 2]) / side))
      if (seen.get(key) === undefined) { seen.set(key, n); n++ }
    }
    return n
  }
  let cell = Math.sqrt(Math.max(area, 1e-12) / budget)
  let tooFine = 0, tooCoarse = Infinity
  for (let pass = 0; pass < 12; pass++) {
    const n = occupied(cell)
    if (n > budget * 1.1) tooFine = cell
    else if (n < budget * 0.6) tooCoarse = cell
    else break
    cell = tooFine > 0 && tooCoarse < Infinity ? Math.sqrt(tooFine * tooCoarse) : cell * Math.sqrt(n / budget)
    if (pass === 11 && tooCoarse < Infinity) cell = tooCoarse
  }

  // Every vertex into its (group, cell); the one nearest the cell's centre ACROSS the
  // surface is its sample. Distance along the normal's axis is left out: on a rough
  // relief it would pick the vertex at mid-cell height and so favour peaks (lighter).
  const { dims, offset, total } = layout(cell)
  const slots = cellTable(total)
  const repVertex: number[] = []
  const repDist: number[] = []
  for (let v = 0; v < count; v++) {
    const g = group[v], side = cell * scale[g]
    const ux = (px[v * 3] - gMin[g * 3]) / side, uy = (px[v * 3 + 1] - gMin[g * 3 + 1]) / side, uz = (px[v * 3 + 2] - gMin[g * 3 + 2]) / side
    const ix = Math.floor(ux), iy = Math.floor(uy), iz = Math.floor(uz)
    const key = keyOf(g, dims, offset, ix, iy, iz)
    const dx = ux - ix - 0.5, dy = uy - iy - 0.5, dz = uz - iz - 0.5
    const axis = buckets[v] >> 1
    const d = (axis === 0 ? 0 : dx * dx) + (axis === 1 ? 0 : dy * dy) + (axis === 2 ? 0 : dz * dz)
    const slot = slots.get(key)
    if (slot === undefined) {
      slots.set(key, repVertex.length)
      repVertex.push(v)
      repDist.push(d)
    } else if (d < repDist[slot]) {
      repVertex[slot] = v
      repDist[slot] = d
    }
  }

  const value = new Float32Array(repVertex.length)
  for (let s = 0; s < repVertex.length; s++) value[s] = occlusionAt(repVertex[s])

  for (let v = 0; v < count; v++) {
    const g = group[v], side = cell * scale[g]
    const ux = (px[v * 3] - gMin[g * 3]) / side - 0.5
    const uy = (px[v * 3 + 1] - gMin[g * 3 + 1]) / side - 0.5
    const uz = (px[v * 3 + 2] - gMin[g * 3 + 2]) / side - 0.5
    const bx = Math.floor(ux), by = Math.floor(uy), bz = Math.floor(uz)
    const fx = ux - bx, fy = uy - by, fz = uz - bz
    let sum = 0, wsum = 0
    for (let c = 0; c < 8; c++) {
      const ix = bx + (c & 1), iy = by + ((c >> 1) & 1), iz = bz + ((c >> 2) & 1)
      if (ix < 0 || iy < 0 || iz < 0) continue
      const slot = slots.get(keyOf(g, dims, offset, ix, iy, iz))
      if (slot === undefined) continue
      const w = (c & 1 ? fx : 1 - fx) * ((c >> 1) & 1 ? fy : 1 - fy) * ((c >> 2) & 1 ? fz : 1 - fz)
      sum += w * value[slot]
      wsum += w
    }
    let f = sum / wsum
    if (f < AO_MIN) f = AO_MIN
    if (f > 1) f = 1
    ao[v] = f
  }
}

/** Total triangle area of the geometry (indexed or not); `each` gets every triangle's
 *  corners and a third of its area. */
function surfaceArea(
  geometry: THREE.BufferGeometry, px: ArrayLike<number>, each?: (a: number, b: number, c: number, third: number) => void,
): number {
  const index = geometry.getIndex()
  const idx = index ? (index.array as ArrayLike<number>) : null
  const tris = idx ? Math.floor(idx.length / 3) : Math.floor(px.length / 9)
  let area = 0
  for (let t = 0; t < tris; t++) {
    const a = idx ? idx[t * 3] : t * 3, b = idx ? idx[t * 3 + 1] : t * 3 + 1, c = idx ? idx[t * 3 + 2] : t * 3 + 2
    const e1x = px[b * 3] - px[a * 3], e1y = px[b * 3 + 1] - px[a * 3 + 1], e1z = px[b * 3 + 2] - px[a * 3 + 2]
    const e2x = px[c * 3] - px[a * 3], e2y = px[c * 3 + 1] - px[a * 3 + 1], e2z = px[c * 3 + 2] - px[a * 3 + 2]
    const cx = e1y * e2z - e1z * e2y, cy = e1z * e2x - e1x * e2z, cz = e1x * e2y - e1y * e2x
    const triangle = 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz)
    area += triangle
    each?.(a, b, c, triangle / 3)
  }
  return area
}

/** GLSL constant, so the shader dim of DIRECT diffuse tracks the JS constant. */
function aoDirectDimGlsl(): string {
  // Force a decimal point so it is a valid float literal.
  const v = AO_DIRECT_DIM
  return Number.isInteger(v) ? `${v}.0` : `${v}`
}

/**
 * Patch a MeshStandardMaterial (idempotently) so it reads the AO_ATTRIBUTE and
 * multiplies it into indirect diffuse/specular (full AO) plus a fraction of direct
 * diffuse (AO_DIRECT_DIM). Composes with vertexColors, clipping, and shading modes
 * -- it only augments the generated program, changing no material property. A
 * distinct customProgramCacheKey keeps AO'd bodies from sharing a program with any
 * non-AO MeshStandard material.
 */
export function patchMaterialForAO(material: THREE.MeshStandardMaterial): void {
  const flagged = material.userData as Record<string, unknown>
  if (flagged[AO_PATCH_FLAG]) return
  flagged[AO_PATCH_FLAG] = true

  const prev = material.onBeforeCompile
  material.onBeforeCompile = (shader, renderer) => {
    if (prev) prev.call(material, shader, renderer)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float geo23Ao;\nvarying float vGeo23Ao;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvGeo23Ao = geo23Ao;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vGeo23Ao;')
      // After three accumulates indirect/direct light and applies any aoMap, dim
      // the environment/indirect term fully by our AO and a fraction of direct.
      // applyBodyAO only patches a material whose geometry already carries the
      // AO_ATTRIBUTE, so `geo23Ao` is always supplied (never the WebGL default 0).
      .replace(
        '#include <aomap_fragment>',
        `#include <aomap_fragment>\n\treflectedLight.indirectDiffuse *= vGeo23Ao;\n\treflectedLight.indirectSpecular *= vGeo23Ao;\n\treflectedLight.directDiffuse *= mix(1.0, vGeo23Ao, ${aoDirectDimGlsl()});`,
      )
  }
  material.customProgramCacheKey = () => 'geo23-ao'
  material.needsUpdate = true
}

/** WO-3044: a Model-page body opts into the off-thread bake by setting this on its
 *  geometry's userData (SolidsWorkbenchPage). The CAM viewport never sets it, so its
 *  bake stays synchronous and its result.ao is still returned for the display cache. */
export const AO_OFF_THREAD_KEY = 'aoOffThread'
/** WO-3044: the coarse tessellation pass sets this; its AO is not baked at all (the
 *  display pass that follows replaces the geometry and bakes). */
export const AO_SKIP_KEY = 'aoSkipBake'

/** WO-3044: an opted-in body with at least this many vertices bakes in a worker. Under
 *  it the bake is a few tens of ms (0.1-0.2 ms a vertex) and a worker's start-up is not
 *  worth it, so the synchronous path stays. */
export const AO_OFF_THREAD_MIN_VERTICES = 1_000

export interface AoJob {
  position: Float32Array
  normal: Float32Array
  index: Uint16Array | Uint32Array | null
}

/** The bake one worker job runs: the same computeVertexAO on a rebuilt geometry, so
 *  the values are the ones the page thread would have produced. */
export function runAoJob(job: AoJob): Float32Array {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(job.position, 3))
  geometry.setAttribute('normal', new THREE.BufferAttribute(job.normal, 3))
  if (job.index) geometry.setIndex(new THREE.BufferAttribute(job.index, 1))
  return computeVertexAO(geometry).ao
}

/** The slice of the Worker API the bake uses; a test supplies an in-process one. */
export interface AoWorkerLike {
  postMessage(job: AoJob): void
  terminate(): void
  onmessage: ((event: { data: { ao: Float32Array } }) => void) | null
  onerror: ((event: unknown) => void) | null
}

let aoWorkerFactory: (() => AoWorkerLike) | null | undefined

/** Test seam: replace (or with null, remove) the worker the off-thread bake starts. */
export function setAoWorkerFactory(factory: (() => AoWorkerLike) | null | undefined): void {
  aoWorkerFactory = factory
}

function createAoWorker(): AoWorkerLike | null {
  if (aoWorkerFactory !== undefined) return aoWorkerFactory ? aoWorkerFactory() : null
  if (typeof Worker === 'undefined') return null
  return new Worker(new URL('./vertexAO.worker.ts', import.meta.url), { type: 'module', name: 'vertex-ao-bake' }) as unknown as AoWorkerLike
}

const aoLandedListeners = new Set<(mesh: THREE.Mesh) => void>()
/** WO-3044: called after an off-thread bake lands in a mesh's geometry, so the page can
 *  draw it again. Returns the unsubscribe. */
export function onBodyAoLanded(listener: (mesh: THREE.Mesh) => void): () => void {
  aoLandedListeners.add(listener)
  return () => { aoLandedListeners.delete(listener) }
}

const pendingBakes = new WeakMap<THREE.Mesh, () => void>()

/** Stop the mesh's running off-thread bake, if any. */
function cancelPendingBake(mesh: THREE.Mesh): void {
  const cancel = pendingBakes.get(mesh)
  if (cancel) cancel()
}

/** Start the worker bake for `mesh`'s current geometry. Resolves nothing: the result is
 *  written into `placeholder` (the geometry's all-1 attribute) when it lands. Returns
 *  false when no worker could start, so the caller bakes synchronously. */
function startOffThreadBake(mesh: THREE.Mesh, geometry: THREE.BufferGeometry, placeholder: THREE.BufferAttribute): boolean {
  const worker = createAoWorker()
  if (!worker) return false
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute
  const nrm = geometry.getAttribute('normal') as THREE.BufferAttribute
  const index = geometry.getIndex()
  const t0 = performance.now()
  const finish = () => {
    worker.onmessage = null
    worker.onerror = null
    worker.terminate()
    pendingBakes.delete(mesh)
    geometry.removeEventListener('dispose', cancel)
  }
  const cancel = () => finish()
  worker.onmessage = (event) => {
    finish()
    const ao = event.data.ao
    if (mesh.geometry !== geometry || ao.length !== placeholder.count) return
    ;(placeholder.array as Float32Array).set(ao)
    placeholder.needsUpdate = true
    if (import.meta.env.DEV) {
      const win = window as unknown as { __geo23AoBakes?: unknown[] }
      ;(win.__geo23AoBakes ??= []).push({ bakeMs: +(performance.now() - t0).toFixed(2), vertices: ao.length, attributeBytes: ao.length * 4, offThread: true })
    }
    aoLandedListeners.forEach((listener) => listener(mesh))
  }
  // A worker that fails leaves the body with the flat (no-darkening) look it already has.
  worker.onerror = () => finish()
  pendingBakes.set(mesh, cancel)
  geometry.addEventListener('dispose', cancel)
  worker.postMessage({
    position: pos.array as Float32Array,
    normal: nrm.array as Float32Array,
    index: index ? (index.array as Uint16Array | Uint32Array) : null,
  })
  return true
}

/**
 * Bake AO into a body mesh's geometry and patch its material. Safe to call again
 * on geometry replacement (recomputes the attribute). No-op (returns zeros) when
 * AO is disabled (the C3(c) mutation) or the geometry lacks position/normal.
 *
 * WO-3044: a Model-page body (geometry.userData[AO_OFF_THREAD_KEY]) that is skipped
 * (AO_SKIP_KEY, the coarse pass) or large (AO_OFF_THREAD_MIN_VERTICES) gets an all-1
 * attribute at once - the look without AO, and one the patched shader can read - and
 * a large one is baked in a worker that fills that attribute when it lands.
 */
export function applyBodyAO(mesh: THREE.Mesh, cachedAo?: Float32Array): AoBakeResult {
  const geometry = mesh.geometry as THREE.BufferGeometry
  const material = mesh.material
  if (!AO_ENABLED) return { bakeMs: 0, vertices: 0, attributeBytes: 0 }
  cancelPendingBake(mesh)
  const positions = geometry.getAttribute('position') as THREE.BufferAttribute | undefined
  const reusable = positions && isValidVertexAO(cachedAo, positions.count) ? cachedAo : undefined
  const patch = (m: THREE.Material) => { if (m instanceof THREE.MeshStandardMaterial) patchMaterialForAO(m) }
  const deferred = !reusable && positions && geometry.getAttribute('normal') && geometry.userData[AO_OFF_THREAD_KEY] === true
    ? deferBake(mesh, geometry, positions.count)
    : false
  if (deferred) {
    if (Array.isArray(material)) material.forEach(patch)
    else patch(material)
    return { bakeMs: 0, vertices: 0, attributeBytes: 0 }
  }
  const { ao, bakeMs } = reusable
    ? { ao: reusable, bakeMs: 0 }
    : computeVertexAO(geometry)
  if (reusable) geometry.setAttribute(AO_ATTRIBUTE, new THREE.BufferAttribute(reusable, 1))
  if (!geometry.getAttribute(AO_ATTRIBUTE)) return { bakeMs, vertices: 0, attributeBytes: 0 }
  if (Array.isArray(material)) material.forEach(patch)
  else patch(material)
  const result = {
    bakeMs: +bakeMs.toFixed(2), vertices: ao.length, attributeBytes: ao.length * 4, ao,
  }
  // GEO-23-R1 cure C4: DEV-only telemetry (the one-time AO bake cost) for the perf
  // probe. Not a production interface; stripped from production builds.
  if (import.meta.env.DEV) {
    const win = window as unknown as { __geo23AoBakes?: unknown[] }
    // Telemetry must not retain the full per-vertex artifact. The caller owns
    // `result.ao` for persistence; the DEV probe needs compact measurements only.
    ;(win.__geo23AoBakes ??= []).push({
      bakeMs: result.bakeMs,
      vertices: result.vertices,
      attributeBytes: result.attributeBytes,
    })
  }
  return result
}

/** Give an opted-in geometry its all-1 AO attribute and, when it is large and not a
 *  skipped pass, start the worker bake. False = bake it here instead (small body, or
 *  no worker to start). */
function deferBake(mesh: THREE.Mesh, geometry: THREE.BufferGeometry, count: number): boolean {
  const skip = geometry.userData[AO_SKIP_KEY] === true
  if (!skip && count < AO_OFF_THREAD_MIN_VERTICES) return false
  const placeholder = new THREE.BufferAttribute(new Float32Array(count).fill(1), 1)
  geometry.setAttribute(AO_ATTRIBUTE, placeholder)
  if (skip) return true
  if (startOffThreadBake(mesh, geometry, placeholder)) return true
  geometry.deleteAttribute(AO_ATTRIBUTE)
  return false
}

/** (cell, normal bucket) key -> sample slot. A flat Int32Array while the grid is
 *  small enough (the usual case, and ~10x faster than a Map for the 8 lookups per
 *  vertex), a Map beyond that. */
function cellTable(keys: number): { get(key: number): number | undefined; set(key: number, slot: number): void } {
  if (keys > 4_000_000) return new Map<number, number>()
  const table = new Int32Array(keys).fill(-1)
  return {
    get: (key) => { const slot = table[key]; return slot < 0 ? undefined : slot },
    set: (key, slot) => { table[key] = slot },
  }
}
