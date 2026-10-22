// model.fillet (WO-3014): round the chosen edges of a live body, exactly as the Model page's
// Fillet dialog does.
//
// The dialog's Apply (create mode) inserts one feature node (nextId 'F', opType 'fillet') through
// createFeatureCommand, consuming the owner body; the page's kernel op then hands the node's edge
// ids to the kernel, which is the one validator of the ids and of the radius it can build. This
// command writes the SAME payload through the SAME command. The dialog's own gate (an owner, at
// least one edge, a radius above zero) and the page's live-owner lookup run BEFORE anything is
// committed, so a call the screen would refuse leaves the document untouched.
//
// Edges are named by the ids the Model page's picker uses. The ids come from the live body; a stale
// or unknown id is the kernel's to name, and shows up as the result's status and diagnostics.
// One call, one history step labelled "Agent: Fillet".
//
// The small result/liveness helpers below are shared by chamfer, hole and revolve (this order's
// four files are its whole grant, so they live in the first of them).

import { CompositeCommand } from '../../../doc'
import { textFor } from '../../../i18n'
import { createFeatureCommand } from '../../../components/model3d/dialogs/createFeatureCommand'
import { nextId } from '../../../components/model3d/dialogs/nextId'
import { liveBodyFeatureIds } from '../../../components/model3d/bodyLineage'
import type { ModelSession } from '../../../doc/modelSession'
import type { JsonSchema } from '../schema'
import { refuse, type ModelEditSpec, type Refusal } from '../registry'

const workbenchText = textFor('sketch-and-model-workbench')

/** Rebuild statuses that mean the node produced a body (the page's bodyHandles stand-in). */
const HAS_BODY = new Set(['ok', 'degraded'])

export interface FeatureCommandResult {
  featureId: string
  status: string
  diagnostics: Array<{ code: string; message: string }>
}

/** The output schema every feature command shares: the node it made and how its rebuild went. */
export const FEATURE_RESULT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['featureId', 'status', 'diagnostics'],
  properties: {
    featureId: { type: 'string' },
    status: { type: 'string' },
    diagnostics: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'message'],
        properties: { code: { type: 'string' }, message: { type: 'string' } },
      },
    },
  },
}

/** What the new node's rebuild said, read after the commit (the same words extrude reports). */
export function featureResult(session: ModelSession, featureId: string): FeatureCommandResult {
  return {
    featureId,
    status: session.scheduler.statusOf(featureId),
    diagnostics: session.scheduler.diagnosticsOf(featureId).map((d) => {
      const detail = Object.entries(d.params ?? {}).map(([k, v]) => `${k}=${v}`).join(', ')
      return { code: d.code, message: detail === '' ? d.code : `${d.code}: ${detail}` }
    }),
  }
}

/**
 * The page's own live-owner gate, run before anything is committed: the owner must exist, and be a
 * body no later feature has consumed. `refusedWords` is the page's sentence for that operation.
 */
export function ownerRefusal(session: ModelSession, ownerId: string, refusedWords: string): Refusal | null {
  if (!session.dag.has(ownerId)) {
    return refuse('missing-target', `There is no body "${ownerId}" in this model. Use the id of a body in the feature tree.`)
  }
  const live = new Set(liveBodyFeatureIds(session.dag, (id) => HAS_BODY.has(session.scheduler.statusOf(id))))
  return live.has(ownerId) ? null : refuse('refused', refusedWords)
}

export interface FilletInput {
  /** The live body whose edges are rounded (the dialog's owner). */
  ownerId: string
  /** The edge ids the Model page's edge picker names; at least one. */
  edges: string[]
  /** In the model's units; above zero. */
  radius: number
}

export const filletSpec: ModelEditSpec<FilletInput, FeatureCommandResult> = {
  id: 'model.fillet',
  kind: 'edit',
  effect: 'edit',
  input: {
    type: 'object',
    additionalProperties: false,
    required: ['ownerId', 'edges', 'radius'],
    properties: {
      ownerId: { type: 'string' },
      edges: { type: 'array', items: { type: 'string' } },
      radius: { type: 'number' },
    },
  },
  output: FEATURE_RESULT_SCHEMA,
  // The dialog has no refusal of its own beyond its disabled Apply (checked in prepare).
  enabled: () => null,
  prepare(session, input) {
    const { dag } = session
    const edges = [...new Set(input.edges)]
    if (edges.length === 0 || edges.some((id) => id.length === 0)) {
      return refuse('refused', `${workbenchText('FilletDialog.selectEdgesInTheViewport')}. Send the id of at least one edge of "${input.ownerId}".`)
    }
    if (!(input.radius > 0)) {
      return refuse('refused', `The fillet radius must be greater than zero (got ${input.radius}). Send a radius in the model's units.`)
    }
    const owner = ownerRefusal(session, input.ownerId, workbenchText('SolidsWorkbenchPage.filletOwnerHasNoLiveBodyMissingOrAlready', { ownerId: input.ownerId }))
    if (owner !== null) return owner

    const featureId = nextId(dag, 'F')
    // The dialog's payload, key for key (FilletDialog handleApply, create mode).
    const payload = {
      opType: 'fillet',
      ownerId: input.ownerId,
      edges,
      radius: input.radius,
      propagateTangent: true,
      name: workbenchText('FilletDialog.fillet2', { id: featureId }),
    }
    const label = workbenchText('AgentCommands.fillet')
    return {
      label,
      commands: [new CompositeCommand([createFeatureCommand(dag, { id: featureId, kind: 'feature', consumes: [input.ownerId], payload })], label)],
      touched: [featureId],
      changed: { created: [featureId], edited: [], removed: [] },
      finish: (s) => featureResult(s, featureId),
    }
  },
}
