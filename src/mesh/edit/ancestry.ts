// WO-2804: rebuilt or moved facets still descend from the operator's facets.
// Operations supply explicit output owners; a genuinely added cap uses -1.
// Never infer a facet's owner from proximity or give it an arbitrary source ID.
import type { MeshBuffers, Vec3 } from '../types'
import { facetCount, vertexCount } from './idView'
import type { MeshEditAncestry } from './types'

/** Invert output -> input facet owners into the edit framework's ancestry.
 * Split facets may name the same owner. Vertices retain ancestry only where
 * an original corner survives (optionally translated); intersections are new.
 * A retessellating operation can use this even when no corner survives. */
export function ancestryFromFacetOwners(
  input: MeshBuffers,
  output: MeshBuffers,
  owners: ArrayLike<number>,
  translation: Vec3 = [0, 0, 0],
): MeshEditAncestry {
  const triangles: number[][] = Array.from({ length: facetCount(input) }, () => [])
  const vertices: number[][] = Array.from({ length: vertexCount(input) }, () => [])
  if (owners.length !== facetCount(output)) throw new Error('Facet ancestry must name every output facet.')
  for (let out = 0; out < owners.length; out++) {
    const owner = owners[out]
    if (owner === -1) continue // A cap or other genuinely added facet.
    if (!Number.isInteger(owner) || owner < 0 || owner >= triangles.length) {
      throw new Error('Rebuilt facet ancestry names an input facet that does not exist.')
    }
    triangles[owner].push(out)
    for (let c = 0; c < 3; c++) {
      const original = input.indices[owner * 3 + c]
      for (let k = 0; k < 3; k++) {
        const rebuilt = output.indices[out * 3 + k]
        if ([0, 1, 2].every(axis => Math.abs(
          Math.fround(input.positions[original * 3 + axis] + translation[axis]) - output.positions[rebuilt * 3 + axis],
        ) <= 1e-5)) vertices[original].push(rebuilt)
      }
    }
  }
  return { triangles, vertices: vertices.map(list => [...new Set(list)]) }
}

/** Compose input -> intermediate -> output, for both facets and vertices. */
export function composeMeshEditAncestry(previous: MeshEditAncestry, next: MeshEditAncestry): MeshEditAncestry {
  const compose = (before: number[][], after: number[][]) =>
    before.map(list => [...new Set(list.flatMap(i => after[i] ?? []))])
  return { triangles: compose(previous.triangles, next.triangles), vertices: compose(previous.vertices, next.vertices) }
}

/** Combine independent routes descended from the SAME input (body/cutter). */
export function mergeMeshEditAncestry(left: MeshEditAncestry, right: MeshEditAncestry): MeshEditAncestry {
  if (left.triangles.length !== right.triangles.length || left.vertices.length !== right.vertices.length) {
    throw new Error('Facet ancestry routes must share the same input mesh.')
  }
  const merge = (a: number[][], b: number[][]) => a.map((list, i) => [...new Set([...list, ...b[i]])])
  return { triangles: merge(left.triangles, right.triangles), vertices: merge(left.vertices, right.vertices) }
}
