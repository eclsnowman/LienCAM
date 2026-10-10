// GEO-UNIFY: the SHARED headless seed-archive machinery every "promote/wrap ->
// new Model Item" flow reuses (the shared-resolver law, applied to the seed
// builder: one place mints the born-with-genesis DAG and one place serializes
// it to the exact bytes stashLoadedDocument parks, so two builders can never
// drift on document shape).
//
// Callers (all LEAVES in src/doc, imported by the store via their direct path):
//   - promoteSketchModel.ts       (GEO-UNIFY Stage 3): a one-sketch base doc.
//   - promoteImportedStepModel.ts (GEO-UNIFY Stage 4): a one-import base doc.
//
// LAYERING. This module imports UPWARD (basePlanes) for seedGenesisNodes, the
// exact shape a real workbench mount produces. It is a LEAF in src/doc --
// nothing in src/doc (least of all the barrel index.ts) imports it -- so
// `basePlanes -> ../../../doc` (the barrel) never closes a cycle back to here.

import { FeatureDag } from './dag'
import { createDocumentArchive } from './persist'
import { seedGenesisNodes } from '../components/model3d/workbench/basePlanes'

/**
 * A fresh workbench-document DAG, born with Origin + XY/XZ/YZ genesis nodes
 * (SKC-15) -- the common starting point every headless model-seed builder needs
 * before it inserts its own base node(s). seedGenesisNodes is idempotent and
 * touches no history (it is a property of "a document exists at all").
 */
export function newSeededModelDag(): FeatureDag {
  const dag = new FeatureDag()
  seedGenesisNodes(dag)
  return dag
}

/**
 * Serialize a seed DAG to the exact document-archive bytes stashLoadedDocument
 * parks for a Model Item mount to consume via takePendingDocumentSeed.
 * `elementMapDeltas: []` (a brand-new document has no lineage history);
 * `rollback` is the EXPLICIT caller-supplied timeline field buildDocumentSaveInput
 * uses, so the seeded archive matches what a save of this same DAG would write.
 */
export function finalizeSeedArchive(dag: FeatureDag): Uint8Array {
  return createDocumentArchive({
    dag,
    elementMapDeltas: [],
    rollback: { featureOrder: dag.featureOrder(), marker: dag.getRollbackMarker() },
  })
}
