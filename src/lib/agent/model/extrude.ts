// model.extrude (WO-3011, WO-2951 "First command" template): extrude an existing sketch's
// profile into a body, exactly as the Model page's Extrude dialog does.
//
// The dialog's Apply inserts one feature node (nextId 'F', opType 'extrude') through
// createFeatureCommand and the page's kernel op turns that node into a body with
// buildExtrudeRequest (workbench/extrudeParams.ts -- the definition the page imports, not
// the older copy in lib/cam/modelWorkbenchHelpers.ts). This command builds the SAME node
// payload and runs the SAME builder BEFORE committing, so a request the dialog would refuse
// is refused here with the dialog's own words and the document is untouched.
//
// Covers the dialog's Blind and Symmetric end conditions (direction up / down / midplane,
// operation New body / Add / Remove / Intersect, the whole sketch as the profile). The other
// end conditions, a region pick and a bound distance expression stay on the screen.
// WO-3234: Thin too -- wallMode 'thin' with wallThickness and wallSide (default Inside, as
// the dialog). Without wallMode 'thin' the payload is the ordinary solid's, key for key,
// and a stray wallThickness / wallSide is not read (the dialog ignores them the same way).
// WO-3237: `openChain` names one open chain of the sketch by its ordered curves and travel
// directions (the dialog's saved sketch-chain selector). It is built only as a Thin wall,
// side left / right / center of travel (default Left, as the dialog); without Thin the
// builder refuses it in the dialog's words. The chain resolves through the same authority.
// One call, one history step labelled "Agent: Extrude".

import { CompositeCommand } from '../../../doc'
import { textFor } from '../../../i18n'
import { createFeatureCommand } from '../../../components/model3d/dialogs/createFeatureCommand'
import { nextId } from '../../../components/model3d/dialogs/nextId'
import { liveBodyFeatureIds } from '../../../components/model3d/bodyLineage'
import {
  buildExtrudeRequest,
  DEFAULT_THIN_OPEN_WALL_SIDE,
  DEFAULT_THIN_WALL_SIDE,
  EXTRUDE_BOOL_MODES,
  EXTRUDE_DIRECTIONS,
  EXTRUDE_WALL_MODES,
  THIN_OPEN_WALL_SIDES,
  THIN_WALL_SIDES,
  type ExtrudeBoolMode,
  type ExtrudeDirection,
  type ExtrudeWallMode,
} from '../../../components/model3d/workbench/extrudeParams'
import { resolveExtrudeSelection, type ProfileSelector } from '../../../components/model3d/workbench/regionSelector'
import type { BodyHandle, ProfileRegion, ThinExtrudeSide, ThinOpenSide } from '../../../geom/geom-service'
import type { ModelSession } from '../../../doc/modelSession'
import { refuse, type ModelEditSpec } from '../registry'

const workbenchText = textFor('sketch-and-model-workbench')

export interface ExtrudeInput {
  /** The sketch node whose closed profile is extruded (the dialog's sketch picker). */
  sketchId: string
  /** How far, in the model's units; the dialog's own checks decide what is acceptable. */
  distance: number
  /** Default 'up', like the dialog. */
  direction?: ExtrudeDirection
  /** The dialog's New body / Add / Remove / Intersect. Default 'newBody'. */
  operation?: ExtrudeBoolMode
  /** The body Add / Remove / Intersect works on. */
  targetFeatureId?: string
  /** The dialog's Thin toggle. Default 'solid'. */
  wallMode?: ExtrudeWallMode
  /** Thin wall thickness in mm; read only with wallMode 'thin'. */
  wallThickness?: number
  /** Where the thin wall sits on the sketch outline; read only with wallMode 'thin'. Default 'inside'.
   *  With openChain: left / right / center of the chain's travel, default 'left'. */
  wallSide?: ThinExtrudeSide | ThinOpenSide
  /** WO-3237: one open chain of the sketch, its curves in travel order, each walked
   *  start -> end (forward) or reversed. Built only with wallMode 'thin'. */
  openChain?: { steps: Array<{ entityId: string; forward: boolean }> }
}

export interface ExtrudeResult {
  featureId: string
  status: string
  diagnostics: Array<{ code: string; message: string }>
}

/** Rebuild statuses that mean the node produced a body (the page's bodyHandles stand-in). */
const HAS_BODY = new Set(['ok', 'degraded'])

export const extrudeSpec: ModelEditSpec<ExtrudeInput, ExtrudeResult> = {
  id: 'model.extrude',
  kind: 'edit',
  effect: 'edit',
  input: {
    type: 'object',
    additionalProperties: false,
    required: ['sketchId', 'distance'],
    properties: {
      sketchId: { type: 'string' },
      distance: { type: 'number' },
      direction: { type: 'string', enum: EXTRUDE_DIRECTIONS },
      operation: { type: 'string', enum: EXTRUDE_BOOL_MODES },
      targetFeatureId: { type: 'string' },
      wallMode: { type: 'string', enum: EXTRUDE_WALL_MODES },
      wallThickness: { type: 'number' },
      wallSide: { type: 'string', enum: [...THIN_WALL_SIDES, ...THIN_OPEN_WALL_SIDES.filter((side) => side !== 'center')] },
      openChain: {
        type: 'object',
        additionalProperties: false,
        required: ['steps'],
        properties: {
          steps: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['entityId', 'forward'],
              properties: { entityId: { type: 'string' }, forward: { type: 'boolean' } },
            },
          },
        },
      },
    },
  },
  output: {
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
  },
  // The dialog has no refusal of its own beyond what the builder says (checked in prepare).
  enabled: () => null,
  prepare(session, input) {
    const { dag } = session
    const sketch = dag.getNode(input.sketchId)
    if (sketch === undefined || sketch.kind !== 'sketch') {
      return refuse('missing-target', `There is no sketch "${input.sketchId}" in this model. Create the sketch first, or use the id of an existing one.`)
    }
    const profileSelector: ProfileSelector | undefined = input.openChain === undefined
      ? undefined
      : { kind: 'sketch-chain', sketchId: input.sketchId, steps: input.openChain.steps.map(({ entityId, forward }) => ({ entityId, forward })) }
    const profiles = resolveExtrudeSelection(input.sketchId, sketch.payload.regions as ProfileRegion[] | undefined, profileSelector, (id) => dag.getNode(id))
    if (!profiles.ok) return refuse('refused', profiles.message)

    const boolMode = input.operation ?? 'newBody'
    const direction = input.direction ?? 'up'
    const featureId = nextId(dag, 'F')
    const endCondition = direction === 'midplane' ? 'symmetric' : 'blind'
    const targetFeatureId = boolMode === 'newBody' ? undefined : (input.targetFeatureId ?? '')

    // The dialog's payload, key for key (ExtrudeDialog handleApply, create mode).
    const payload = {
      opType: 'extrude',
      sketchId: input.sketchId,
      ...(profileSelector === undefined ? {} : { profileSelector }),
      distance: input.distance,
      direction,
      endCondition,
      boolMode,
      ...(targetFeatureId === undefined ? {} : { targetFeatureId }),
      ...(input.wallMode === 'thin'
        ? { wallMode: 'thin', wallThickness: input.wallThickness, wallSide: input.wallSide ?? (profiles.openChain ? DEFAULT_THIN_OPEN_WALL_SIDE : DEFAULT_THIN_WALL_SIDE) }
        : {}),
      name: workbenchText('ExtrudeDialog.extrude2', { id: featureId }),
    }

    // The page's own gate, run before anything is committed. A body handle is not available
    // headless, so a node that has built a body stands in for one; the page's rebuild still
    // has the last word and reports through the result.
    const live = new Set(liveBodyFeatureIds(dag, (id) => HAS_BODY.has(session.scheduler.statusOf(id))))
    const build = buildExtrudeRequest({
      featureId,
      payload,
      profiles: profiles.profiles,
      openChain: profiles.openChain,
      distance: input.distance,
      lookupTarget: (id) => (live.has(id) ? (PLACEHOLDER_BODY as BodyHandle) : undefined),
      modelItemId: session.modelItemId,
    })
    if (!build.ok) return refuse('refused', build.reason)

    const consumes = [...new Set([input.sketchId, ...(targetFeatureId === undefined ? [] : [targetFeatureId])])]
    const label = textFor('sketch-and-model-workbench')('AgentCommands.extrude')
    return {
      label,
      commands: [new CompositeCommand([createFeatureCommand(dag, { id: featureId, kind: 'feature', consumes, payload })], label)],
      touched: [featureId],
      changed: { created: [featureId], edited: [], removed: [] },
      finish: (s) => extrudeResult(s, featureId),
    }
  },
}

// Only the builder's liveness test ever looks at the handle; the request it returns is discarded.
const PLACEHOLDER_BODY = Object.freeze({}) as unknown

function extrudeResult(session: ModelSession, featureId: string): ExtrudeResult {
  return {
    featureId,
    status: session.scheduler.statusOf(featureId),
    diagnostics: session.scheduler.diagnosticsOf(featureId).map((d) => {
      const detail = Object.entries(d.params ?? {}).map(([k, v]) => `${k}=${v}`).join(', ')
      return { code: d.code, message: detail === '' ? d.code : `${d.code}: ${detail}` }
    }),
  }
}

