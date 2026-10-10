// WO-1845 / ADR-0051 s1.1, s1.4: replay an STL row's journal over its source
// mesh.
//
// Replay is FAIL-CLOSED. When a record cannot be replayed - its operation is
// not registered, its version moved, its facets are out of range, or its
// witness no longer matches what is at those indices - replay STOPS AT THAT
// EDIT, says so in the console naming the edit, and leaves every earlier edit
// applied. It never skips an edit silently and never edits a different region
// (ADR-0003). The operator gets a partially replayed part and a message, which
// is the honest outcome; the alternative is cutting the wrong shape.

import type { MeshBuffers } from '../types';
import { composeSourceFacetIds, facetCount, sourceFacetIdsOf } from './idView';
import { getMeshEditOperation, describeMeshEdit } from './registry';
import type {
  MeshEditAncestry,
  MeshEditRecord,
  MeshEditReplayResult,
  MeshEditReplayStop,
} from './types';
import { computeWitness, witnessMismatch } from './witness';

/**
 * Apply `records` in order to `sourceMesh`.
 *
 * `sourceMesh` must be the output of importStl/parseStl on the row's own
 * bytes - the file-order, unwelded mesh the facet ids are anchored to
 * (ADR-0051 s1.3). With no records this returns the source mesh object
 * itself, so "no edits" costs nothing and cannot change a single byte.
 */
export function replayMeshEdits(
  sourceMesh: MeshBuffers,
  records: readonly MeshEditRecord[] | undefined,
  options: { onStop?: (stop: MeshEditReplayStop) => void } = {},
): MeshEditReplayResult {
  if (!records || records.length === 0) {
    return { mesh: sourceMesh, sourceFacetIds: sourceFacetIdsOf(sourceMesh), appliedCount: 0 };
  }

  let mesh = sourceMesh;
  let sourceFacetIds = sourceFacetIdsOf(sourceMesh);
  let applied = 0;

  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    const refusal = replayOne(mesh, record);
    if (typeof refusal === 'string') {
      const stop: MeshEditReplayStop = {
        index,
        recordId: record.id,
        kind: record.kind,
        reason: refusal,
      };
      // COHESION-STANDARD s13: the console is where events are said, not a
      // banner or a modal. Name the edit so the operator knows WHICH one.
      console.error(
        `Mesh edit "${describeMeshEdit(record)}" could not be replayed: ${refusal}. ` +
          `The ${applied} edit(s) before it are still applied; this one and any after it are not.`,
      );
      options.onStop?.(stop);
      return { mesh, sourceFacetIds, appliedCount: applied, stopped: stop };
    }
    mesh = refusal.mesh;
    sourceFacetIds = composeSourceFacetIds(sourceFacetIds, refusal.ancestry, facetCount(mesh));
    applied++;
  }

  return { mesh, sourceFacetIds, appliedCount: applied };
}

/** The reason this record cannot replay (a string), or its result. */
function replayOne(
  mesh: MeshBuffers,
  record: MeshEditRecord,
): { mesh: MeshBuffers; ancestry: MeshEditAncestry } | string {
  const operation = getMeshEditOperation(record.kind);
  if (!operation) return `this build has no "${record.kind}" edit`;
  if (operation.version !== record.version) {
    return (
      `it was recorded by version ${record.version} of "${record.kind}" and this build ships ` +
      `version ${operation.version}`
    );
  }

  const total = facetCount(mesh);
  if (!Array.isArray(record.facets) || record.facets.length === 0) {
    return 'it selects no facets';
  }
  for (const facet of record.facets) {
    if (!Number.isInteger(facet) || facet < 0 || facet >= total) {
      return `it selects facet ${String(facet)}, which this mesh does not have (${total} facets)`;
    }
  }

  if (!record.witness || typeof record.witness.facetCount !== 'number') {
    // ADR-0051 s1.4: indices without a witness are a position, not a proof.
    return 'it carries no record of what it selected, so it cannot be proved to still point at the same region';
  }
  const mismatch = witnessMismatch(record.witness, computeWitness(mesh, record.facets));
  if (mismatch) return mismatch;

  let parameters: never;
  try {
    parameters = operation.validate(record.parameters ?? {}) as never;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }

  let result;
  try {
    result = operation.apply({ mesh, record, parameters, facets: record.facets });
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return result;
}
