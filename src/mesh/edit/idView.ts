// WO-1845: the id view over MeshBuffers, and the ancestry plumbing that keeps
// it true across edits.
//
// A facet id is its triangle index in the IMPORTED FILE, and nothing else.
// `importStl` writes triangle t of a binary STL to indices[3t..3t+2] in file
// order with no welding or reordering (src/mesh/stl.ts:44-72; the ASCII path
// does the same), so file order is a discrete topological fact that exists
// before any tessellation of ours - which is exactly the durable reference
// ADR-0039 demanded and ADR-0051 s1.3 supplies.
//
// The id is anchored at parseStl/importStl output. It is NOT anchored at
// importStlToPartMesh (src/cam3d/input/stl.ts), which welds and drops
// degenerate triangles - a different, lossy numbering.

import type { MeshBuffers, Vec3 } from '../types';
import type { MeshEditAncestry } from './types';

export function facetCount(mesh: MeshBuffers): number {
  return Math.floor(mesh.indices.length / 3);
}

export function vertexCount(mesh: MeshBuffers): number {
  return Math.floor(mesh.positions.length / 3);
}

/** The identity id view of a freshly parsed STL: facet i IS source facet i. */
export function sourceFacetIdsOf(mesh: MeshBuffers): Uint32Array {
  const out = new Uint32Array(facetCount(mesh));
  for (let i = 0; i < out.length; i++) out[i] = i;
  return out;
}

/** An ancestry map for an operation that changed no topology: every input
 *  element maps to the output element at the same index. */
export function identityAncestry(mesh: MeshBuffers): MeshEditAncestry {
  const triangles: number[][] = [];
  for (let i = 0; i < facetCount(mesh); i++) triangles.push([i]);
  const vertices: number[][] = [];
  for (let i = 0; i < vertexCount(mesh); i++) vertices.push([i]);
  return { triangles, vertices };
}

/**
 * Carry the source-facet ids across one edit. `previous[i]` is the source
 * facet that input facet `i` descends from; `ancestry.triangles[i]` says which
 * output facets input `i` became. The result is indexed by OUTPUT facet.
 *
 * An output facet no ancestry entry claims keeps no source id and is marked
 * NO_SOURCE_FACET - it is new geometry (a hole fill, say), not a descendant.
 */
export const NO_SOURCE_FACET = 0xffffffff;

export function composeSourceFacetIds(
  previous: Uint32Array,
  ancestry: MeshEditAncestry,
  outputFacetCount: number,
): Uint32Array {
  const out = new Uint32Array(outputFacetCount).fill(NO_SOURCE_FACET);
  const limit = Math.min(previous.length, ancestry.triangles.length);
  for (let input = 0; input < limit; input++) {
    for (const output of ancestry.triangles[input]) {
      if (output >= 0 && output < outputFacetCount) out[output] = previous[input];
    }
  }
  return out;
}

/** The three vertices of facet `index`, in winding order. */
export function facetVertices(mesh: MeshBuffers, index: number): [Vec3, Vec3, Vec3] {
  const base = index * 3;
  return [
    vertexAt(mesh, mesh.indices[base]),
    vertexAt(mesh, mesh.indices[base + 1]),
    vertexAt(mesh, mesh.indices[base + 2]),
  ];
}

function vertexAt(mesh: MeshBuffers, vertexIndex: number): Vec3 {
  const at = vertexIndex * 3;
  return [mesh.positions[at], mesh.positions[at + 1], mesh.positions[at + 2]];
}
