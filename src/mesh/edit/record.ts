// WO-1845: minting one journal entry.
//
// A record is made HERE, against a live mesh, so the witness is taken from the
// very facets the operator selected rather than being supplied by a caller who
// could get it wrong. Every UI/store path that adds an edit goes through this.

import type { MeshBuffers } from '../types';
import { facetCount } from './idView';
import { getMeshEditOperation } from './registry';
import type { MeshEditRecord } from './types';
import { computeWitness } from './witness';

export interface NewMeshEdit {
  kind: string;
  /** facet indices into `mesh` (the mesh as it stands with the journal's
   *  existing edits already applied) */
  facets: number[];
  parameters?: Record<string, unknown>;
  /** explicit id, for tests and for a deterministic redo; otherwise minted */
  id?: string;
  /** per current facet, its source-file triangle index (replay's
   *  `sourceFacetIds`). When given, the record also stores the source facets
   *  its selection descends from. */
  sourceFacetIds?: Uint32Array;
}

/**
 * Build a replayable record for `edit` against `mesh`.
 *
 * Throws (naming the problem) when the kind is not registered, the selection
 * is empty or out of range, or the operation refuses the parameters. Refusing
 * HERE is the point: a journal never gets an entry that cannot replay.
 */
export function createMeshEditRecord(mesh: MeshBuffers, edit: NewMeshEdit): MeshEditRecord {
  const operation = getMeshEditOperation(edit.kind);
  if (!operation) {
    throw new Error(`There is no "${edit.kind}" mesh edit in this build.`);
  }
  if (!Array.isArray(edit.facets) || edit.facets.length === 0) {
    throw new Error(`A "${edit.kind}" edit must select at least one facet.`);
  }
  const total = facetCount(mesh);
  let facets = [...new Set(edit.facets)].sort((a, b) => a - b);
  for (const facet of facets) {
    if (!Number.isInteger(facet) || facet < 0 || facet >= total) {
      throw new Error(
        `A "${edit.kind}" edit selects facet ${String(facet)}, which this mesh does not have ` +
          `(${total} facets).`,
      );
    }
  }
  const parameters = edit.parameters ?? {};
  operation.validate(parameters);

  if (operation.completeSelection) {
    facets = [...new Set(operation.completeSelection(mesh, facets))].sort((a, b) => a - b);
  }

  const sourceFacets = edit.sourceFacetIds
    ? facets.map((facet) => edit.sourceFacetIds![facet]).filter((id) => id !== undefined)
    : undefined;

  return {
    id: edit.id ?? newEditId(),
    kind: operation.kind,
    version: operation.version,
    parameters,
    facets,
    witness: computeWitness(mesh, facets),
    ...(sourceFacets ? { sourceFacets } : {}),
  };
}

function newEditId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  return random ? `medit-${random}` : `medit-${Math.random().toString(36).slice(2, 12)}`;
}
