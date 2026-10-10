/**
 * Edge -> face adjacency for a LARGE body whose faces are ALL planar (a
 * faceted solid: a SubD form's triangles, a big polyhedral import), walked
 * face by face.
 *
 * occt-wasm's edgeToFaceMap grows quadratically with the face count
 * (measured in the cloud sandbox: 1,920 planar faces ~3 s, 7,680 ~75 s per
 * tessellate call), so every display pass of a faceted body took minutes.
 * On planar faces the walk is exact: a plane is not periodic, so no edge can
 * be a seam (each edge is listed once - occurrences 1), and a free boundary
 * still lists its one face. (The kernel map lists some two-face edges twice;
 * tessellate reads occurrences only for one-face edges - the seam test - so
 * the walk and the kernel classify every edge the same:
 * src/tests/form/planarAdjacency.test.ts.) Returns null - the caller uses the kernel map -
 * for any body with a curved face or at most PLANAR_WALK_MIN_FACES faces, so
 * every ordinary CAD body keeps exactly the path it had.
 */
import type { OcctKernel, ShapeHandle } from 'occt-wasm'

export const PLANAR_WALK_MIN_FACES = 256

export interface EdgeAdjacency {
  adjacentFaces: Map<number, Set<number>>
  occurrences: Map<number, number>
}

export function planarEdgeAdjacency(
  k: OcctKernel,
  shape: ShapeHandle,
  hashModulus: number,
  minFaces = PLANAR_WALK_MIN_FACES,
): EdgeAdjacency | null {
  const faces = k.getSubShapes(shape, 'face')
  try {
    if (faces.length <= minFaces) return null
    for (const face of faces) if (k.surfaceType(face) !== 'plane') return null
    const adjacentFaces = new Map<number, Set<number>>()
    const occurrences = new Map<number, number>()
    for (const face of faces) {
      const fHash = k.hashCode(face, hashModulus)
      const edges = k.getSubShapes(face, 'edge')
      try {
        for (const edge of edges) {
          const eHash = k.hashCode(edge, hashModulus)
          occurrences.set(eHash, 1)
          let set = adjacentFaces.get(eHash)
          if (!set) {
            set = new Set<number>()
            adjacentFaces.set(eHash, set)
          }
          set.add(fHash)
        }
      } finally {
        for (const e of edges) {
          try { k.release(e) } catch { /* already released */ }
        }
      }
    }
    return { adjacentFaces, occurrences }
  } finally {
    for (const f of faces) {
      try { k.release(f) } catch { /* already released */ }
    }
  }
}

/** The kernel's flat edgeToFaceMap ([edgeHash, count, faceHash...]...) as the same maps. */
export function parseEdgeToFaceMap(flat: ArrayLike<number>): EdgeAdjacency {
  const adjacentFaces = new Map<number, Set<number>>()
  const occurrences = new Map<number, number>()
  let i = 0
  while (i < flat.length) {
    const eHash = flat[i++]
    if (i >= flat.length) break
    const count = flat[i++]
    occurrences.set(eHash, (occurrences.get(eHash) ?? 0) + 1)
    let set = adjacentFaces.get(eHash)
    if (!set) {
      set = new Set<number>()
      adjacentFaces.set(eHash, set)
    }
    for (let j = 0; j < count && i < flat.length; j++) set.add(flat[i++])
  }
  return { adjacentFaces, occurrences }
}
