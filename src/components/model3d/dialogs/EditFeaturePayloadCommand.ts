// WO UI-3: the property-dialog framework's Apply seam plugs into DOC-2's
// command layer (src/doc/commands.ts) through this Command implementation.
//
// FeatureDag (src/doc/dag.ts, out of this WO's ownership) exposes only
// insertNode/removeNode/restoreNode/setConsumes -- there is no direct
// "update this node's payload" mutation. Modeling a payload edit as
// remove-then-reinsert-with-the-same-id (both already-public DAG methods)
// gets an undo-safe payload edit without touching src/doc/** -- removeNode
// returns the exact prior snapshot (id/kind/consumes/refs/payload), so
// undo() is a byte-exact restore, same guarantee RemoveNodeCommand itself
// relies on (see commands.ts's own removeNode/restoreNode pairing).
//
// This is the ONE command every property dialog this WO's framework mounts
// (BoxSizeDialog, the translate gizmo's commit) executes through
// CommandHistory -- proving the "any feature can mount a dialog and get undo
// for free" framework claim without needing a bespoke Command subclass per
// field.
//
// WO INT-4A-R1 (R1.1): optional `nextConsumes` lets a payload edit also
// rewire `consumes` in the SAME undo-safe step -- needed when binding/
// unbinding a driving expression changes which parameter nodes the feature
// depends on (see ExtrudeDialog/RevolveDialog + workbench/featureDimension.ts).
// Omitted (existing call sites, e.g. BoxSizeDialog), the node's prior
// consumes are kept untouched -- byte-identical to this command's pre-R1
// behavior.
//
// UI-107: optional `nextRefs` performs the same atomic rewrite for structural
// element refs. Fillet edges currently have no ElementMap lineage contract,
// so an edited legacy Fillet must be able to clear obsolete edge refs while
// preserving the edge IDs in its replay payload. Omission preserves every
// existing caller's refs exactly; an explicit [] clears them undo-safely.

import { textFor } from '../../../i18n'
const workbenchText = textFor('sketch-and-model-workbench')
import type { Command, DagNodeSnapshot, FeatureDag, FeatureRef } from '../../../doc'

export class EditFeaturePayloadCommand implements Command {
  readonly label = 'editFeaturePayload'
  private readonly id: string
  private readonly nextPayload: Record<string, unknown>
  private readonly nextConsumes: string[] | undefined
  private readonly nextRefs: FeatureRef[] | undefined
  private prior: DagNodeSnapshot | undefined

  constructor(id: string, nextPayload: Record<string, unknown>, nextConsumes?: string[], nextRefs?: FeatureRef[]) {
    this.id = id
    this.nextPayload = nextPayload
    this.nextConsumes = nextConsumes
    this.nextRefs = nextRefs
  }

  do(dag: FeatureDag): void {
    // WO UI-12-R1 (Finding 1, instance 3): capture the node's featureOrder()
    // slot BEFORE removeNode drops it, and restore-at-that-index -- a plain
    // restoreNode (the pre-R1 shape) re-appends to the END of featureOrder()
    // on EVERY payload edit, silently dragging the edited feature to the tip
    // of the tree each time a dialog Applies (extrude size, revolve angle,
    // expression rebind, ...). remove-then-reinsert-same-id must be
    // order-neutral, exactly like a delete-undo.
    const index = dag.featureOrder().indexOf(this.id)
    this.prior = dag.removeNode(this.id)
    dag.restoreNode({
      ...this.prior,
      payload: this.nextPayload,
      consumes: this.nextConsumes ?? this.prior.consumes,
      refs: this.nextRefs ?? this.prior.refs,
    }, index)
  }

  undo(dag: FeatureDag): void {
    if (!this.prior) {
      throw new Error(workbenchText('EditFeaturePayloadCommand.editfeaturepayloadcommandUndoWasNeverEditedDoHasNotRun', { id: String(this.id) }))
    }
    const index = dag.featureOrder().indexOf(this.id)
    dag.removeNode(this.id)
    dag.restoreNode(this.prior, index)
  }

  serialize(): unknown {
    return {
      type: 'editFeaturePayload',
      id: this.id,
      payload: this.nextPayload,
      consumes: this.nextConsumes,
      ...(this.nextRefs === undefined ? {} : { refs: this.nextRefs }),
    }
  }
}
