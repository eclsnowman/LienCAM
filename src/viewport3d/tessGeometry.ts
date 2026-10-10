// viewport3d L0: TessBuffers -> THREE.BufferGeometry, zero-copy.
//
// Wraps the FROZEN TessBuffers contract (src/geom/geom-service.ts) directly:
// every attribute is a THREE.BufferAttribute over the SAME transferable
// TypedArray the caller passed in (contract rule 4, "tessellation buffers
// are transferables"), never a copy.
//
// edgeOffsets convention (the contract's doc comment doesn't pin the unit):
// this module treats edgeOffsets as a CSR point-index table -- edge i's
// polyline occupies edgePositions points [edgeOffsets[i], edgeOffsets[i+1]),
// so edgeOffsets.length === edgeIds.length + 1 and edgeOffsets[last] ===
// edgePositions.length / 3. Mirrors the triFace "parallel to triangles"
// pattern already used for face data. Flagged in the WO report as an
// assumption for GEO lane to confirm.

import * as THREE from 'three'
import type { TessBuffers } from '../geom/geom-service'

/** Fail loud on malformed tessellation data -- never silently limp with a
 *  half-wired geometry (project convention, see cam3d/kernel/registry.ts). */
export function validateTessBuffers(tess: TessBuffers): void {
  if (tess.position.length % 3 !== 0) {
    throw new Error(`viewport3d: position length ${tess.position.length} is not xyz triples`)
  }
  if (tess.normal.length !== tess.position.length) {
    throw new Error(
      `viewport3d: normal length ${tess.normal.length} !== position length ${tess.position.length}`
    )
  }
  if (tess.index.length % 3 !== 0) {
    throw new Error(`viewport3d: index length ${tess.index.length} is not triangle triples`)
  }
  const vertexCount = tess.position.length / 3
  for (let i = 0; i < tess.index.length; i++) {
    if (tess.index[i] >= vertexCount) {
      throw new Error(`viewport3d: index ${tess.index[i]} out of range (${vertexCount} verts)`)
    }
  }
  const triCount = tess.index.length / 3
  if (tess.triFace.length !== triCount) {
    throw new Error(
      `viewport3d: triFace length ${tess.triFace.length} !== triangle count ${triCount}`
    )
  }
  for (let t = 0; t < tess.triFace.length; t++) {
    if (tess.triFace[t] >= tess.faceIds.length) {
      throw new Error(
        `viewport3d: triFace[${t}]=${tess.triFace[t]} out of range (${tess.faceIds.length} faceIds)`
      )
    }
  }
  if (tess.edgePositions.length % 3 !== 0) {
    throw new Error(`viewport3d: edgePositions length ${tess.edgePositions.length} is not xyz triples`)
  }
  if (tess.edgeOffsets.length !== tess.edgeIds.length + 1) {
    throw new Error(
      `viewport3d: edgeOffsets length ${tess.edgeOffsets.length} !== edgeIds.length + 1 ` +
        `(${tess.edgeIds.length + 1})`
    )
  }
  if (tess.edgeClasses !== undefined && tess.edgeClasses.length > tess.edgeIds.length) {
    throw new Error(
      `viewport3d: edgeClasses length ${tess.edgeClasses.length} exceeds edgeIds length ${tess.edgeIds.length}`
    )
  }
  const edgePointCount = tess.edgePositions.length / 3
  for (let i = 0; i < tess.edgeOffsets.length; i++) {
    if (tess.edgeOffsets[i] > edgePointCount) {
      throw new Error(
        `viewport3d: edgeOffsets[${i}]=${tess.edgeOffsets[i]} exceeds edgePositions point count ${edgePointCount}`
      )
    }
    if (i > 0 && tess.edgeOffsets[i] < tess.edgeOffsets[i - 1]) {
      throw new Error(`viewport3d: edgeOffsets not monotonic at index ${i}`)
    }
  }
}

/** Body-mesh geometry: position + normal + index, wired directly onto the
 *  caller's TypedArrays (no copy). */
export function buildBufferGeometry(tess: TessBuffers): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(tess.position, 3))
  geometry.setAttribute('normal', new THREE.BufferAttribute(tess.normal, 3))
  geometry.setIndex(new THREE.BufferAttribute(tess.index, 1))
  return geometry
}

/** Non-indexed line-segment geometry for edge overlay rendering: each
 *  polyline's consecutive point pairs become one LineSegments pair.
 *  Positions are copied (segment pairs duplicate shared interior points,
 *  so this can't alias edgePositions 1:1 the way the body mesh does). */
export interface EdgePolylineBuffers {
  edgePositions: Float32Array
  edgeOffsets: Uint32Array
  edgeIds?: readonly string[]
  edgeClasses?: readonly import('../geom/geom-service').EdgeClass[]
}

export function buildEdgeLineGeometry(tess: EdgePolylineBuffers): THREE.BufferGeometry {
  const edgeCount = Math.max(0, tess.edgeOffsets.length - 1)
  let segmentCount = 0
  for (let e = 0; e < edgeCount; e++) {
    const start = tess.edgeOffsets[e]
    const end = tess.edgeOffsets[e + 1]
    if (end > start + 1) segmentCount += end - start - 1
  }
  const positions = new Float32Array(segmentCount * 2 * 3)
  let w = 0
  for (let e = 0; e < edgeCount; e++) {
    const start = tess.edgeOffsets[e]
    const end = tess.edgeOffsets[e + 1]
    const collapse = tess.edgeClasses?.[e] === 'seam'
    for (let p = start; p + 1 < end; p++) {
      const a = p * 3
      // Keep every edge's output slot range stable for highlight/visibility
      // consumers, but make a seam's segments zero-length so rasterization
      // emits no visible line. Picking and measurement continue to read the
      // untouched source edgePositions/edgeOffsets.
      const b = collapse ? a : (p + 1) * 3
      positions[w++] = tess.edgePositions[a]
      positions[w++] = tess.edgePositions[a + 1]
      positions[w++] = tess.edgePositions[a + 2]
      positions[w++] = tess.edgePositions[b]
      positions[w++] = tess.edgePositions[b + 1]
      positions[w++] = tess.edgePositions[b + 2]
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  return geometry
}
