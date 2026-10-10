// Form - the live smooth skin.
//
// compileSkin() runs once per topology change: it refines the cage `level`
// times, composes every step with the limit mask into STENCILS (each skin
// point a fixed weighted sum of cage points), and lays out render vertices so
// shading is smooth everywhere except across creases and open boundaries.
// evaluateSkin() runs per frame while dragging: stencils x cage points, then
// normals. Topology never changes between those calls.

import type { Cage } from './cage'
import { edgeKey } from './cage'
import { buildHalfEdge, vertexOutgoing } from './halfEdge'
import {
  applyRows,
  cagePositionArray,
  composeRows,
  identityRows,
  levelFromCage,
  limitRows,
  refine,
  type Level,
  type SparseRows,
} from './subdivide'

export interface CompiledSkin {
  level: number
  /** the finest topology (all quads when level >= 1) */
  topology: Level
  /** skin point = stencils(row) . cage points */
  stencils: SparseRows
  /** render vertex -> skin point */
  renderSource: Int32Array
  /** triangle indices into render vertices */
  indices: Uint32Array
  /** per face corner (face-major, 4 per quad or n per n-gon): render vertex */
  cornerRender: Int32Array
  cornerOffsets: Int32Array
  /** skin face -> the cage face it descends from */
  cageFaceOfSkinFace: Int32Array
  /** triangle -> skin face */
  skinFaceOfTriangle: Int32Array
}

/** Refine `level` times; return every intermediate refinement. */
export function refineLevels(cage: Cage, level: number) {
  const steps = []
  let current = levelFromCage(cage)
  for (let i = 0; i < level; i++) {
    const r = refine(current)
    steps.push(r)
    current = r.level
  }
  return { steps, finest: current }
}

export function compileSkin(cage: Cage, level: number): CompiledSkin {
  const { steps, finest } = refineLevels(cage, level)
  let stencils = identityRows(cage.positions.length)
  for (const s of steps) stencils = composeRows(s.rows, stencils)
  if (level >= 1) stencils = composeRows(limitRows(finest), stencils)

  // Render layout: one render vertex per (point, smooth sector). A sector is
  // the fan of faces around a point between two sharp edges.
  const mesh = buildHalfEdge({ positions: new Array(finest.vertexCount), faces: finest.faces, creases: [] })
  const isSharp = (h: number) => {
    const key = edgeKey(mesh.origin[h], mesh.origin[mesh.next[h]])
    return mesh.twin[h] < 0 || finest.creases.has(key) || (finest.sharpness?.get(key) ?? 0) > 0
  }
  const cornerRenderByHalfEdge = new Int32Array(mesh.origin.length).fill(-1)
  const renderSource: number[] = []
  for (let v = 0; v < finest.vertexCount; v++) {
    const ring = vertexOutgoing(mesh, v)
    if (ring.length === 0) continue
    // start the walk just after a sharp edge so each sector is contiguous
    let start = 0
    for (let i = 0; i < ring.length; i++) if (isSharp(ring[i])) { start = i; break }
    let render = renderSource.length
    renderSource.push(v)
    for (let k = 0; k < ring.length; k++) {
      const h = ring[(start + k) % ring.length]
      if (k > 0 && isSharp(h)) {
        render = renderSource.length
        renderSource.push(v)
      }
      cornerRenderByHalfEdge[h] = render
    }
  }
  let cageFaceOfSkinFace = Int32Array.from(cage.faces.map((_, f) => f))
  for (const s of steps) cageFaceOfSkinFace = Int32Array.from(s.faceParent, (parent) => cageFaceOfSkinFace[parent])
  const cornerOffsets = new Int32Array(finest.faces.length + 1)
  const cornerRender: number[] = []
  const tris: number[] = []
  const skinFaceOfTriangle: number[] = []
  for (let f = 0; f < finest.faces.length; f++) {
    const start = mesh.faceHalfEdge[f]
    const corners: number[] = []
    let h = start
    do { corners.push(cornerRenderByHalfEdge[h]); h = mesh.next[h] } while (h !== start)
    cornerRender.push(...corners)
    cornerOffsets[f + 1] = cornerRender.length
    for (let i = 1; i + 1 < corners.length; i++) {
      tris.push(corners[0], corners[i], corners[i + 1])
      skinFaceOfTriangle.push(f)
    }
  }
  return {
    level,
    topology: finest,
    stencils,
    renderSource: Int32Array.from(renderSource),
    indices: Uint32Array.from(tris),
    cornerRender: Int32Array.from(cornerRender),
    cornerOffsets,
    cageFaceOfSkinFace,
    skinFaceOfTriangle: Int32Array.from(skinFaceOfTriangle),
  }
}

export interface SkinBuffers {
  /** skin points (limit positions), 3 per point */
  points: Float64Array
  /** render vertex positions and normals, 3 floats each */
  positions: Float32Array
  normals: Float32Array
}

/** Stencils x cage points, then crease-aware area-weighted normals. */
export function evaluateSkin(skin: CompiledSkin, cagePoints: ArrayLike<number>, reuse?: SkinBuffers): SkinBuffers {
  const points = applyRows(skin.stencils, cagePoints, reuse?.points)
  const rc = skin.renderSource.length
  const positions = reuse?.positions ?? new Float32Array(rc * 3)
  const normals = reuse?.normals ?? new Float32Array(rc * 3)
  normals.fill(0)
  for (let r = 0; r < rc; r++) {
    const s = skin.renderSource[r] * 3
    positions[r * 3] = points[s]
    positions[r * 3 + 1] = points[s + 1]
    positions[r * 3 + 2] = points[s + 2]
  }
  const faces = skin.topology.faces
  for (let f = 0; f < faces.length; f++) {
    const loop = faces[f]
    // Newell normal: area-weighted, exact for planar n-gons, robust for quads
    let nx = 0, ny = 0, nz = 0
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i] * 3
      const b = loop[(i + 1) % loop.length] * 3
      nx += (points[a + 1] - points[b + 1]) * (points[a + 2] + points[b + 2])
      ny += (points[a + 2] - points[b + 2]) * (points[a] + points[b])
      nz += (points[a] - points[b]) * (points[a + 1] + points[b + 1])
    }
    for (let k = skin.cornerOffsets[f]; k < skin.cornerOffsets[f + 1]; k++) {
      const r = skin.cornerRender[k] * 3
      normals[r] += nx
      normals[r + 1] += ny
      normals[r + 2] += nz
    }
  }
  for (let r = 0; r < rc; r++) {
    const x = normals[r * 3], y = normals[r * 3 + 1], z = normals[r * 3 + 2]
    const len = Math.hypot(x, y, z) || 1
    normals[r * 3] = x / len
    normals[r * 3 + 1] = y / len
    normals[r * 3 + 2] = z / len
  }
  return { points, positions, normals }
}

/** Convenience for tests and one-shot callers. */
export function skinOf(cage: Cage, level: number): { skin: CompiledSkin; buffers: SkinBuffers } {
  const skin = compileSkin(cage, level)
  return { skin, buffers: evaluateSkin(skin, cagePositionArray(cage)) }
}
