// WO-1845 / ADR-0051 s1.2: THE resolver. One function turns an STL row's
// bytes + journal into geometry, and every route that needs an STL's shape
// goes through it. A route that parses the bytes itself and skips this is a
// defect, not a limitation - an operator who edits his part and still sees the
// old shape somewhere has been lied to.
//
// Two entry points, because the routes want two things:
//   - resolveEditedStlMesh: MeshBuffers, for everything that works on our own
//     mesh representation (edge chains, measurement, the viewport).
//   - resolveEditedStlBytes: STL bytes, for the routes whose next step is an
//     importer that takes bytes (CAM's acquirePartMesh, the viewport's addSTL,
//     the "Edit as model" wrap). The edited mesh is re-exported with the SAME
//     deterministic writer the product already ships, so those routes keep
//     running the exact importer they run today.
//
// With NO edits both return the input untouched - the same ArrayBuffer object,
// not a copy - so an unedited STL is byte-for-byte what it is today
// (ADR-0051 s1.1).

import { exportBinaryStl, importStl } from '../stl';
import type { MeshBuffers, StlImportResult } from '../types';
import { replayMeshEdits } from './replay';
import { sourceFacetIdsOf } from './idView';
import type { MeshEditRecord, MeshEditReplayStop } from './types';

export interface ResolvedStlMesh {
  mesh: MeshBuffers;
  /** per facet of `mesh`, its triangle index in the imported file */
  sourceFacetIds: Uint32Array;
  /** the parse of the source bytes, before any edit (format/report/measures) */
  source: StlImportResult;
  appliedCount: number;
  stopped?: MeshEditReplayStop;
}

function hasEdits(edits: readonly MeshEditRecord[] | undefined): edits is readonly MeshEditRecord[] {
  return Array.isArray(edits) && edits.length > 0;
}

/** Parse `bytes` and replay `edits` over them. */
export function resolveEditedStlMesh(
  bytes: ArrayBuffer | Uint8Array | string,
  edits: readonly MeshEditRecord[] | undefined,
): ResolvedStlMesh {
  const source = importStl(bytes);
  if (!hasEdits(edits)) {
    return {
      mesh: source.mesh,
      sourceFacetIds: sourceFacetIdsOf(source.mesh),
      source,
      appliedCount: 0,
    };
  }
  const replayed = replayMeshEdits(source.mesh, edits);
  return {
    mesh: replayed.mesh,
    sourceFacetIds: replayed.sourceFacetIds,
    source,
    appliedCount: replayed.appliedCount,
    ...(replayed.stopped ? { stopped: replayed.stopped } : {}),
  };
}

/**
 * The edited STL as bytes, for the routes that hand bytes to an importer.
 *
 * Returns the INPUT ArrayBuffer itself when the row has no edits - not a
 * re-export, not a copy. That is what makes "an STL with an empty journal
 * behaves exactly as it does today, byte for byte" true by construction rather
 * than by measurement.
 */
export function resolveEditedStlBytes(
  bytes: ArrayBuffer,
  edits: readonly MeshEditRecord[] | undefined,
): ArrayBuffer {
  if (!hasEdits(edits)) return bytes;
  return exportBinaryStl(resolveEditedStlMesh(bytes, edits).mesh).bytes;
}
