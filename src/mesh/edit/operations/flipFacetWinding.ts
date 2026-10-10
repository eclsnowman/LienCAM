// WO-1845: the ONE operation this framework slice ships, to prove the seam end
// to end.
//
// The order forbids "delete selected facets" as the proof operation - deleting
// facets makes a non-manifold part. This flips the WINDING of the selected
// facets instead: it moves no vertex, adds and removes nothing, changes the
// triangle count by zero, and is its own inverse, so it is harmless and
// reversible. It IS observable everywhere an edit must be observable: the
// facet's normal reverses, which shows up in the mesh buffers, in the exported
// bytes and in the signed volume. That is what makes it a proof rather than a
// no-op.
//
// The real editing operations (fill a hole, remove a boss, push a face) arrive
// as WO-1847..1850, each ADDING a file beside this one and registering it.

import type { MeshBuffers } from '../../types';
import { identityAncestry } from '../idView';
import { registerMeshEditOperation } from '../registry';
import type { MeshEditApplyInput, MeshEditApplyResult, MeshEditOperation, MeshEditRecord } from '../types';

export const FLIP_FACET_WINDING_KIND = 'flip-facet-winding';
export const FLIP_FACET_WINDING_VERSION = 1;

/** This operation takes no parameters; an unknown key is refused by name
 *  rather than ignored, so a typo never replays as something else. */
export type FlipFacetWindingParameters = Record<string, never>;

export const flipFacetWindingOperation: MeshEditOperation<FlipFacetWindingParameters> = {
  kind: FLIP_FACET_WINDING_KIND,
  version: FLIP_FACET_WINDING_VERSION,
  label: 'Flip facet winding',

  describe(record: MeshEditRecord): string {
    const count = record.facets.length;
    return `Flip winding of ${count} facet${count === 1 ? '' : 's'}`;
  },

  validate(parameters: Record<string, unknown>): FlipFacetWindingParameters {
    const keys = Object.keys(parameters ?? {});
    if (keys.length > 0) {
      throw new Error(
        `"${FLIP_FACET_WINDING_KIND}" takes no parameters, but this edit carries ${keys.join(', ')}`,
      );
    }
    return {} as FlipFacetWindingParameters;
  },

  apply({ mesh, facets }: MeshEditApplyInput<FlipFacetWindingParameters>): MeshEditApplyResult {
    const indices = new Uint32Array(mesh.indices);
    for (const facet of facets) {
      const base = facet * 3;
      const second = indices[base + 1];
      indices[base + 1] = indices[base + 2];
      indices[base + 2] = second;
    }
    // Positions are untouched, so they are shared, not copied: the buffer is
    // never mutated in place by this operation and the source mesh outlives
    // the result only as a read.
    const next: MeshBuffers = { positions: mesh.positions, indices };
    return { mesh: next, ancestry: identityAncestry(mesh) };
  },
};

registerMeshEditOperation(flipFacetWindingOperation);
