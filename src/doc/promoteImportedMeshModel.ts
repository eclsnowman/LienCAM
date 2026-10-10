// MSH-3 wiring / INT-IMPORT-EDIT stage 4 (REV-ENG rung 0): the HEADLESS seed
// builder for the "Edit as model" WRAP flow of a CAM format:'stl' row -> a new
// Model Item whose editable base body is the prismatic mesh, rebuilt as a real
// B-rep solid.
//
// The sibling of promoteImportedStepModel.ts: same shape, same shared
// seedModelArchive machinery, only the base node differs. Assemble a
// one-meshImport-node modeling document archive -- the exact bytes
// `stashLoadedDocument` parks for a Model Item mount -- with NO React, NO
// canvas, NO kernel client. The store's `wrapImportedGeometryAsModelItem` calls
// this (after validating the prismatic conversion up front), then stashes the
// returned bytes against the freshly minted item id; when the Model workspace
// mounts on that item, `takePendingDocumentSeed` hands it this document, the
// meshImport node replays `loadCachedSTL(cacheKey) -> importStl -> converter ->
// makeSolidFromPlanarFaces`, and the mesh is present as the model's editable
// base body -- defeature/resize-hole on it work because it is an ordinary
// upstream body to the workbench's dress-up/defeature ops.
//
// SHAPE FIDELITY. The single meshImport node carries the payload the executor
// replay branch (SolidsWorkbenchPage.tsx, `node.kind === 'meshImport'`) reads:
//   kind 'meshImport', payload { fileName, cacheKey, name }
// -- no `consumes`/`refs` (a mesh import is a standalone body producer). The id
// 'CNV1' is what `nextId(dag, 'CNV')` yields in a fresh DAG; it roots the
// converted body's stable ids (the `CNVn:face#i` grammar the converter emits,
// which the executor keys to the node id via convertPrismaticMesh's convertId).
//
// LAYERING. A LEAF in src/doc: it imports only the shared seedModelArchive
// helper. Nothing in src/doc imports it; the store imports it by direct path.

import { newSeededModelDag, finalizeSeedArchive } from './seedModelArchive'

export interface ImportedMeshSeedInput {
  /** The original file name -- the meshImport node's fail-loud message subject
   *  and the tree-label fallback (matches the STEP path's payload shape). */
  fileName: string
  /** A FRESH, globally-unique IndexedDB key the wrap copied the STL bytes under
   *  (NEVER the source CAM geo id -- copying decouples the two independent cache
   *  lifetimes, exactly as the STEP wrap does). The executor's loadCachedSTL
   *  reads this back on replay. */
  cacheKey: string
  /** The Model Item / base-body display name (the source CAM row's name). */
  name: string
}

/**
 * Build the seed archive for wrapping an imported STL row into a fresh Model
 * Item's editable base body. Synchronous (no I/O, no module state): decode the
 * returned bytes with `loadDocumentArchive` and assert the single meshImport
 * node + its payload.
 */
export function buildImportedMeshModelArchive(input: ImportedMeshSeedInput): Uint8Array {
  const dag = newSeededModelDag()
  dag.insertNode({
    id: 'CNV1',
    kind: 'meshImport',
    consumes: [],
    refs: [],
    payload: { fileName: input.fileName, cacheKey: input.cacheKey, name: input.name },
  })
  return finalizeSeedArchive(dag)
}
