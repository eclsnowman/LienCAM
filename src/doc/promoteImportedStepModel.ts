// GEO-UNIFY Stage 4 / INT-IMPORT-EDIT stage 1 (plan sec 2 step 3): the HEADLESS
// seed builder for the "Edit as model" WRAP flow (a CAM format:'step' row ->
// a new Model Item whose base feature is the STEP import).
//
// Assemble a one-import-node modeling document archive -- the exact bytes
// `stashLoadedDocument` parks for a Model Item mount -- with NO React, NO
// canvas, NO kernel client. The store's `wrapImportedGeometryAsModelItem` calls
// this, then stashes the returned bytes against the freshly minted item id;
// when the Model workspace mounts on that item, `takePendingDocumentSeed`
// hands it this document, the import node replays `loadCachedStep(cacheKey) ->
// client.importStep(bytes)`, and the STEP is present as the model's editable
// base body -- defeature/resize-hole on it work because it is an ordinary
// upstream body to the workbench's dress-up/defeature ops.
//
// SHAPE FIDELITY (why this cannot drift from the workbench). The single import
// node is minted in the EXACT create-shape handleImportStepFileChange mints for
// an interactive workbench STEP import (SolidsWorkbenchPage.tsx):
//   kind 'import', payload { fileName, cacheKey, name }
// -- no `consumes`/`refs` (an import is a standalone body producer, it consumes
// no datum). The executor replay branch (SolidsWorkbenchPage.tsx, `node.kind ===
// 'import'`) reads exactly these three payload fields (fileName for its
// fail-loud messages, cacheKey for loadCachedStep, name for the tree label), so
// the seeded node replays byte-identically to a hand-imported one. The id 'IMP1'
// is what `nextId(dag, 'IMP')` yields in a fresh DAG, matching the interactive
// path's first import.
//
// LAYERING. A LEAF in src/doc: it imports only the shared seedModelArchive
// helper (which owns the genesis-born DAG + archive serialization). Nothing in
// src/doc imports it; the store imports it by its direct path.

import { newSeededModelDag, finalizeSeedArchive } from './seedModelArchive'

export interface ImportedStepSeedInput {
  /** The original file name -- the import node's fail-loud message subject and
   *  the tree-label fallback (matches handleImportStepFileChange's payload). */
  fileName: string
  /** A FRESH, globally-unique IndexedDB key the wrap copied the STEP bytes
   *  under (NEVER the source CAM geo id -- copying decouples the two independent
   *  cache lifetimes, plan sec 2 step 2). The executor's loadCachedStep reads
   *  this back on replay. */
  cacheKey: string
  /** The Model Item / base-body display name (the source CAM row's name). */
  name: string
}

/**
 * Build the seed archive for wrapping an imported STEP row into a fresh Model
 * Item's editable base body. Synchronous (no profile extraction, unlike the
 * sketch promote builder): it performs no I/O and touches no module state, so
 * it is safe to call from anywhere and trivially unit-testable (decode the
 * returned bytes with `loadDocumentArchive` and assert the single import node +
 * its payload).
 */
export function buildImportedStepModelArchive(input: ImportedStepSeedInput): Uint8Array {
  const dag = newSeededModelDag()
  dag.insertNode({
    id: 'IMP1',
    kind: 'import',
    consumes: [],
    refs: [],
    payload: { fileName: input.fileName, cacheKey: input.cacheKey, name: input.name },
  })
  return finalizeSeedArchive(dag)
}

/** One solid of a multi-body STEP file: its own cache-key copy of the bytes, its
 *  own display name, and the `bodyIndex` the executor uses to pick bodies[i]
 *  from the file (instead of refusing the multi-body file). */
export interface ImportedStepBodySeed {
  fileName: string
  cacheKey: string
  name: string
  /** 0-based index of this solid within the STEP file's body list. The 'import'
   *  executor replay reads it to select `imported.bodies[bodyIndex]`; absent (as
   *  in the single-body builder above) keeps the original one-body-only refusal. */
  bodyIndex: number
}

/**
 * INT-IMPORT-EDIT stage 3 (multi-body STEP): build a seed archive with ONE
 * import node PER solid, each carrying its own `bodyIndex`. All N nodes live in
 * ONE Model Item -- the workbench regens every body-producing root on the item's
 * single mount, so the adapter adopts the wrapped CAM row as the first solid and
 * appends solids 1..N-1 as new CAM rows on that ONE regen (no need to open N
 * separate workspaces to surface every solid). Each node re-imports the same
 * file and keeps only its own index, so the one-body-per-import-node workbench
 * invariant is untouched. Node ids IMP1..IMPn mirror `nextId(dag,'IMP')`'s
 * sequence, so a body index i maps to node IMP{i+1}.
 */
export function buildMultiBodyImportedStepModelArchive(bodies: readonly ImportedStepBodySeed[]): Uint8Array {
  const dag = newSeededModelDag()
  bodies.forEach((body, i) => {
    dag.insertNode({
      id: `IMP${i + 1}`,
      kind: 'import',
      consumes: [],
      refs: [],
      payload: {
        fileName: body.fileName,
        cacheKey: body.cacheKey,
        name: body.name,
        bodyIndex: body.bodyIndex,
      },
    })
  })
  return finalizeSeedArchive(dag)
}
