// WO-1845 / ADR-0051: the data an STL's edit journal is made of.
//
// An edited STL is not a new kind of row and not new bytes. The imported bytes
// stay the immutable source; the mesh every consumer sees is the result of
// REPLAYING an ordered list of these records over those bytes (ADR-0051 s1.1).
//
// Identity, and how the two governing documents are reconciled here
// (decide-and-log, LIENCAM.md rule 3):
//   - WO-1845 asks for "an id view over MeshBuffers: facet id = source triangle
//     index of the imported STL" plus a per-edit ancestry map.
//   - ADR-0051 s1.4 binds a record's selection to "facet indices in the mesh
//     produced by the edits BEFORE it, AND a small witness of what it selected".
// Both hold at once and neither is softened: a record's `facets` are indices
// into the pre-edit mesh (ADR), every replay carries a `sourceFacetIds` view
// that maps each facet of the CURRENT mesh back to its triangle index in the
// imported file (WO), and that view is composed from the per-edit ancestry
// maps. An index alone is a position, not a proof - the witness is what makes
// replaying it safe, and a witness that no longer matches STOPS replay
// (ADR-0003, no silent fallback).

import type { MeshBuffers, Vec3 } from '../types';

/** A small geometric fingerprint of what an edit selected, taken when the edit
 *  was recorded. Replay recomputes it from the same indices; a mismatch means
 *  the facets at those indices are not the facets the operator picked, so
 *  replay stops there instead of editing a different region (ADR-0051 s1.4). */
export interface MeshEditWitness {
  /** how many facets were selected */
  facetCount: number;
  /** summed area of the selected facets, mm^2 */
  area: number;
  /** area-weighted centroid of the selection, mm */
  centroid: Vec3;
  /** summed (unnormalised) facet normal - catches a winding/orientation change
   *  that leaves area and centroid untouched */
  normalSum: Vec3;
}

/** One entry in an STL row's journal. Persisted verbatim inside the project
 *  JSON on the `ImportedGeometry` row (ADR-0051 s5.3, additive + optional under
 *  ADR-0027; no migration, ADR-0040). Plain JSON only - no typed arrays, no
 *  Maps - because this rides through `JSON.stringify` on every save. */
export interface MeshEditRecord {
  /** stable id of this edit, unique within the row's journal */
  id: string;
  /** which registered operation replays it (see registry.ts) */
  kind: string;
  /** the operation's parameter/behaviour version at record time. An operation
   *  that changes meaning bumps its version; an old record then refuses to
   *  replay under the new one rather than quietly meaning something else. */
  version: number;
  /** operation-specific parameters, validated by the operation on replay */
  parameters: Record<string, unknown>;
  /** the selection: facet indices into the mesh produced by the edits before
   *  this one (ADR-0051 s1.4). */
  facets: number[];
  /** what those facets looked like when the operator chose them */
  witness: MeshEditWitness;
  /** the source-file triangle indices those facets descended from, recorded so
   *  a later slice can re-find the region without replaying (WO-1845's id
   *  view). Never the primary selection - the `facets` above are. */
  sourceFacets?: number[];
}

/** Next's `meshTopologyHistory` shape, on our buffers: for ONE edit, which
 *  output elements each input element became. Indexed BY INPUT id, so
 *  `triangles[i]` is the list of output facet indices descended from input
 *  facet `i`; an empty list means that input element did not survive. */
export interface MeshEditAncestry {
  triangles: number[][];
  vertices: number[][];
}

/** What a registered operation is handed. The selection is already
 *  range-checked and the parameters are already validated by the operation's
 *  own `validate`. */
export interface MeshEditApplyInput<P = unknown> {
  /** the mesh as of the edits before this one */
  mesh: MeshBuffers;
  /** the record being replayed */
  record: MeshEditRecord;
  /** the operation's own validated parameters */
  parameters: P;
  /** the validated selection, facet indices into `mesh` */
  facets: number[];
}

export interface MeshEditApplyResult {
  mesh: MeshBuffers;
  ancestry: MeshEditAncestry;
}

/** An edit operation. A later slice (WO-1846..1851) ADDS one file that exports
 *  one of these and registers it; it never edits the framework (ADR-0051 s3). */
export interface MeshEditOperation<P = unknown> {
  /** the `kind` its records carry; unique across the registry */
  kind: string;
  /** current behaviour version; records carrying a different one are refused */
  version: number;
  /** what the properties panel calls it */
  label: string;
  /** one line naming THIS edit for the panel list and the console. */
  describe(record: MeshEditRecord): string;
  /** throw (naming the problem) if these parameters are not this operation's;
   *  return the typed parameters otherwise. */
  validate(parameters: Record<string, unknown>): P;
  /** Complete an operation's dependent geometry before the selection is
   *  witnessed and persisted. Preview and record must use the same completion. */
  completeSelection?(mesh: MeshBuffers, facets: readonly number[]): number[];
  /** pure: same mesh + same record -> same output, no I/O, no globals. */
  apply(input: MeshEditApplyInput<P>): MeshEditApplyResult;
}

/** Why replay stopped short, if it did. Earlier edits stay applied
 *  (ADR-0051 s1.4). */
export interface MeshEditReplayStop {
  /** index of the record replay stopped AT (that record was NOT applied) */
  index: number;
  recordId: string;
  kind: string;
  /** the operator-readable reason, the same text written to the console */
  reason: string;
}

export interface MeshEditReplayResult {
  /** the mesh after every edit that replayed */
  mesh: MeshBuffers;
  /** per facet of `mesh`, the triangle index it descends from in the imported
   *  file. Length = mesh.indices.length / 3. */
  sourceFacetIds: Uint32Array;
  /** how many records replayed (equals records.length when nothing stopped) */
  appliedCount: number;
  /** present IFF replay stopped short */
  stopped?: MeshEditReplayStop;
}
