// model.chamfer (WO-3014): bevel the chosen edges of a live body, exactly as the Model page's
// Chamfer dialog does -- the same shape as model.fillet (see fillet.ts), with a distance in place
// of the radius. The dialog's payload is written key for key through createFeatureCommand; the
// page's kernel op validates the edge ids and the distance it can build. The dialog's gate (an
// owner, at least one edge, a distance above zero) and the page's live-owner lookup run before
// anything is committed. One call, one history step labelled "Agent: Chamfer".

import { CompositeCommand } from '../../../doc'
import { textFor } from '../../../i18n'
import { createFeatureCommand } from '../../../components/model3d/dialogs/createFeatureCommand'
import { nextId } from '../../../components/model3d/dialogs/nextId'
import { refuse, type ModelEditSpec } from '../registry'
import { FEATURE_RESULT_SCHEMA, featureResult, ownerRefusal, type FeatureCommandResult } from './fillet'

const workbenchText = textFor('sketch-and-model-workbench')

export interface ChamferInput {
  /** The live body whose edges are bevelled (the dialog's owner). */
  ownerId: string
  /** The edge ids the Model page's edge picker names; at least one. */
  edges: string[]
  /** In the model's units; above zero. */
  distance: number
}

export const chamferSpec: ModelEditSpec<ChamferInput, FeatureCommandResult> = {
  id: 'model.chamfer',
  kind: 'edit',
  effect: 'edit',
  input: {
    type: 'object',
    additionalProperties: false,
    required: ['ownerId', 'edges', 'distance'],
    properties: {
      ownerId: { type: 'string' },
      edges: { type: 'array', items: { type: 'string' } },
      distance: { type: 'number' },
    },
  },
  output: FEATURE_RESULT_SCHEMA,
  enabled: () => null,
  prepare(session, input) {
    const { dag } = session
    const edges = [...new Set(input.edges)]
    if (edges.length === 0 || edges.some((id) => id.length === 0)) {
      return refuse('refused', `${workbenchText('ChamferDialog.selectEdgesInTheViewport')}. Send the id of at least one edge of "${input.ownerId}".`)
    }
    if (!(input.distance > 0)) {
      return refuse('refused', `The chamfer distance must be greater than zero (got ${input.distance}). Send a distance in the model's units.`)
    }
    const owner = ownerRefusal(session, input.ownerId, workbenchText('SolidsWorkbenchPage.chamferOwnerHasNoLiveBodyMissingOrAlready', { ownerId: input.ownerId }))
    if (owner !== null) return owner

    const featureId = nextId(dag, 'F')
    // The dialog's payload, key for key (ChamferDialog handleApply, create mode).
    const payload = {
      opType: 'chamfer',
      ownerId: input.ownerId,
      edges,
      distance: input.distance,
      propagateTangent: true,
      name: workbenchText('ChamferDialog.chamfer2', { id: featureId }),
    }
    const label = workbenchText('AgentCommands.chamfer')
    return {
      label,
      commands: [new CompositeCommand([createFeatureCommand(dag, { id: featureId, kind: 'feature', consumes: [input.ownerId], payload })], label)],
      touched: [featureId],
      changed: { created: [featureId], edited: [], removed: [] },
      finish: (s) => featureResult(s, featureId),
    }
  },
}
