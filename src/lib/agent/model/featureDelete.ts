// model.feature.delete (WO-3011): delete one feature the way the Design tree's Delete does.
//
// The tree plans the delete with planFeatureDelete (components/model3d/tree/featureDelete.ts)
// and the page's handleDelete runs the plan as one history entry. This command makes the same
// plan, refuses the same cases in the tree's own words (a face sketch whose reference plane
// other features still use), and removes the same ids in the same order. Deleting a feature
// removes everything built on it, as the tree does after its confirmation; the result names
// every removed id and one "Agent: Delete" Undo brings them all back.

import { CompositeCommand, RemoveNodeCommand, isGenesisNodeId } from '../../../doc'
import { textFor } from '../../../i18n'
import { featureLabel } from '../../../components/model3d/bodyLineage'
import { planFeatureDelete } from '../../../components/model3d/tree/featureDelete'
import { isReferenceImagePayload } from '../../../referenceImage/referenceImage'
import { refuse, type ModelEditSpec } from '../registry'

const workbenchText = textFor('sketch-and-model-workbench')

export interface FeatureDeleteInput {
  featureId: string
}

export interface FeatureDeleteResult {
  /** Every node taken out of the model, the feature itself last. */
  removed: string[]
}

export const featureDeleteSpec: ModelEditSpec<FeatureDeleteInput, FeatureDeleteResult> = {
  id: 'model.feature.delete',
  kind: 'edit',
  effect: 'edit',
  input: {
    type: 'object',
    additionalProperties: false,
    required: ['featureId'],
    properties: { featureId: { type: 'string' } },
  },
  output: {
    type: 'object',
    additionalProperties: false,
    required: ['removed'],
    properties: { removed: { type: 'array', items: { type: 'string' } } },
  },
  enabled: () => null,
  prepare(session, input) {
    const { dag } = session
    const id = input.featureId
    if (!dag.has(id)) return refuse('missing-target', `There is no feature "${id}" in this model. Read the model for the ids it has.`)
    // The tree offers no Delete on an origin row (the page's handleDelete is a quiet no-op there).
    if (isGenesisNodeId(id)) return refuse('refused', `"${id}" is one of the model's built-in origin items. It stays in every model, so there is nothing to delete.`)

    const plan = planFeatureDelete(dag, id)
    if (!plan.ok) {
      return refuse(
        'refused',
        workbenchText('SolidsWorkbenchPage.cannotDeleteItsReferencePlaneIsStillUsedBy', {
          value1: String(featureLabel(dag, id)),
          value2: String(plan.retainedConsumerIds.map((consumerId) => featureLabel(dag, consumerId)).join(', ')),
        }),
      )
    }
    const removalOrder = [...plan.removalOrder]
    const node = dag.getNode(id)!
    // A reference image's own plane goes with it (the page's handleDelete does the same).
    if (isReferenceImagePayload(node.payload) && node.payload.planeNodeId === `datum:${id}`) removalOrder.push(node.payload.planeNodeId)

    const label = textFor('sketch-and-model-workbench')('AgentCommands.deleteFeature')
    return {
      label,
      commands: [new CompositeCommand(removalOrder.map((nid) => new RemoveNodeCommand(nid)), label)],
      touched: removalOrder,
      changed: { created: [], edited: [], removed: [...removalOrder].sort() },
      finish: () => ({ removed: removalOrder }),
    }
  },
}
