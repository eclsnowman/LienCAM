// WO UI-7-R1 (audit blocker): every create-mode dialog (ExtrudeDialog,
// RevolveDialog, BooleanDialog) must land its new node AT the
// rollback marker -- not appended past it -- whenever the document is rolled
// back, mirroring InsertAtMarkerCommand's own contract (commands.ts). At the
// default 'end' marker (nothing rolled back) this is a plain append, same as
// every pre-UI-7 caller -- InsertNodeCommand stays the command class there so
// its serialize() shape ({ type: 'insertNode', ... }) is unchanged for the
// overwhelming common case.

import { textFor } from '../../../i18n'
const workbenchText = textFor('sketch-and-model-workbench')
import { CompositeCommand, InsertAtMarkerCommand, InsertNodeCommand, SetHiddenCommand, type Command, type DagNodeInput, type FeatureDag } from '../../../doc'
import { isDirectEditBodyOpType, isWorkbenchBodyOpType } from '../bodyLineage'

/** WO UI-56 (Design 3, carry-forward): true iff `id` is a body-producing DAG
 *  node -- the same kind test SolidsWorkbenchPage.tsx's own bodyFeatureIds()
 *  applies (kept in sync manually since that function is module-local and
 *  not exported; duplicated rather than imported to avoid a workbench-page
 *  -> dialogs -> workbench-page import cycle). */
function isBodyProducingNode(dag: FeatureDag, id: string): boolean {
  const node = dag.getNode(id)
  if (node === undefined) return false
  if (node.kind === 'import' || node.kind === 'meshImport') return true
  return node.kind === 'feature' && isWorkbenchBodyOpType(node.payload.opType)
}

export function createFeatureCommand(dag: FeatureDag, input: DagNodeInput): Command {
  const base = dag.getRollbackMarker().kind === 'end' ? new InsertNodeCommand(input) : new InsertAtMarkerCommand(input)
  // WO UI-56 (Design 3, Operator's own principle applied to lineage carry-forward):
  // a dress-up superseding a hidden body with a new leaf must not silently
  // re-show it -- the new leaf IS the same body identity to the user (WO
  // UI-28's own bodyId/lineageId split), so it inherits the sole consumed
  // parent's hidden flag. Ambiguous when >1 body-producing parent is
  // consumed (a Boolean's target+tool -- whose hidden state should win?),
  // so that case is left alone (PARTIAL per this WO's own allowance) rather
  // than guessing.
  const bodyParents = (input.consumes ?? []).filter((id) => isBodyProducingNode(dag, id))
  if (bodyParents.length === 1 && dag.getNode(bodyParents[0])?.hidden === true) {
    return new CompositeCommand([base, new SetHiddenCommand(input.id, true)], base.label)
  }
  return base
}

/** First-class history entry for every direct body edit. The accepted opType
 * domain is derived from WORKBENCH_BODY_OP_DEFINITIONS, the same registry the
 * body executor narrows against. A new direct-edit operation therefore cannot
 * use this command until it is also a real replayable workbench feature. */
export function createDirectEditFeatureCommand(dag: FeatureDag, input: DagNodeInput): Command {
  if (input.kind !== 'feature' || !isDirectEditBodyOpType(input.payload?.opType)) {
    throw new Error(workbenchText('createFeatureCommand.directEditMustBeARegisteredDirectEditFeature', { id: String(input.id) }))
  }
  return createFeatureCommand(dag, input)
}
