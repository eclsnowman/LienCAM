// WO MODEL-WORKSPACE-STL-EXPORT: pure multi-body STL composition.
//
// The Model-workspace Document-rail STL export composes one binary STL from
// every effectively-visible workbench body. The page (SolidsWorkbenchPage) owns
// the live kernel: it resolves feature ids -> BodyHandles and re-tessellates
// each handle through the geometry client at DISPLAY_TESS_QUALITY. This module
// owns the rest -- and ONLY the rest -- so the merge/rebase/refusal/encode
// behavior is unit-testable without mounting the 10k-line page.
//
// Contract (verbatim from the work order):
//  - Rebase every later body's indices by the accumulated prior vertex count
//    (positions.length / 3). Two or more visible independent bodies must export
//    into the SAME valid STL.
//  - Do not scale, flip axes, flip winding, or flip normals. Coordinates are
//    millimeters in kernel/model space; the writer (exportBinaryStl) derives
//    facet normals from winding.
//  - Refuse empty input, zero triangles, non-finite positions, indices outside
//    the body's vertex range, and incomplete triangles (index count not
//    divisible by 3) with a NAMED error -- never silently export a subset.
//  - Fresh tessellation buffers only: the caller re-tessellates per body, so
//    the arrays handed here are never the live GeometryCache's retained ones.
//    This module copies every body's positions/indices into freshly allocated
//    merged arrays, so the input buffers are never mutated.

import { exportBinaryStl } from '../../mesh/stl'
import { meshFromTessBuffers, type TessellatedBrepBuffers } from '../../mesh/crossDomainBoolean'
import type { MeshBuffers } from '../../mesh/types'

/** One effectively-visible body's fresh tessellation, paired with its feature
 *  id so refusal errors name the offending body. `tess` is the
 *  field-compatible { position, index } shape GeomClient.tessellate returns;
 *  meshFromTessBuffers adapts it to a plain MeshBuffers. */
export interface StlBodyInput {
  featureId: string
  tess: TessellatedBrepBuffers
}

/** Named refusal for one body's malformed tessellation. */
function validateBodyTess(featureId: string, tess: TessellatedBrepBuffers): void {
  if (tess.position.length % 3 !== 0) {
    throw new Error(`STL export: body '${featureId}' position count is not a multiple of 3`)
  }
  if (tess.index.length % 3 !== 0) {
    throw new Error(`STL export: body '${featureId}' has an incomplete triangle (index count not divisible by 3)`)
  }
  const vertexCount = tess.position.length / 3
  for (let i = 0; i < tess.position.length; i++) {
    if (!Number.isFinite(tess.position[i])) {
      throw new Error(`STL export: body '${featureId}' has a non-finite position coordinate`)
    }
  }
  for (let i = 0; i < tess.index.length; i++) {
    const idx = tess.index[i]
    if (idx < 0 || idx >= vertexCount) {
      throw new Error(`STL export: body '${featureId}' has an index ${idx} out of vertex range [0, ${vertexCount})`)
    }
  }
}

/** Merge per-body tessellations into one MeshBuffers, rebasing each later
 *  body's indices by the accumulated prior vertex count. Validates every
 *  body's buffers and refuses empty input / zero total triangles by name.
 *  Inputs are never mutated; the merged positions/indices are fresh arrays. */
export function mergeTessellatedBodies(inputs: StlBodyInput[]): MeshBuffers {
  if (inputs.length === 0) throw new Error('STL export: no body to export')
  const meshes: MeshBuffers[] = []
  let totalVertices = 0
  let totalTriangles = 0
  for (const { featureId, tess } of inputs) {
    validateBodyTess(featureId, tess)
    const mesh = meshFromTessBuffers(tess)
    meshes.push(mesh)
    totalVertices += mesh.positions.length / 3
    totalTriangles += mesh.indices.length / 3
  }
  if (totalTriangles === 0) throw new Error('STL export: zero triangles')

  const positions = new Float32Array(totalVertices * 3)
  const indices = new Uint32Array(totalTriangles * 3)
  let vertexBase = 0
  let triangleBase = 0
  for (const mesh of meshes) {
    positions.set(mesh.positions, vertexBase * 3)
    const base = vertexBase
    for (let i = 0; i < mesh.indices.length; i++) {
      indices[triangleBase + i] = base + mesh.indices[i]
    }
    triangleBase += mesh.indices.length
    vertexBase += mesh.positions.length / 3
  }
  return { positions, indices }
}

/** Validate + merge + encode in one step. Returns the deterministic binary
 *  STL bytes and the total facet count. The writer (exportBinaryStl) derives
 *  facet normals from winding, so no normals are passed or synthesized here. */
export function composeWorkbenchStl(inputs: StlBodyInput[]): { bytes: ArrayBuffer; triangleCount: number } {
  const mesh = mergeTessellatedBodies(inputs)
  return exportBinaryStl(mesh)
}
