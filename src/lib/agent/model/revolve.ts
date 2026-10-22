// model.revolve (WO-3014): turn an existing sketch's profile about an axis into a body, exactly as
// the Model page's Revolve dialog does.
//
// The dialog's Apply (create mode) inserts one feature node (nextId 'F', opType 'revolve') through
// createFeatureCommand; the page's kernel op resolves the sketch's profile and the axis and makes
// the solid. This command writes the SAME payload through the SAME command, and runs the dialog's
// gate BEFORE committing: the profile must resolve (resolveProfileSelector, the page's own), the
// axis datum must resolve to a line, and a profile lying flat across the axis is refused in the
// dialog's words (it would sweep no volume). The dialog keeps those checks inside React, so they are
// restated here and pinned to the dialog's output by modelFeatureCommands.wo3014.test.ts.
//
// Covers the whole sketch as the profile, about world Z or an axis datum, for an angle in (0, 360]
// (the dialog's preview range). A region pick and a driving expression stay on the screen.
// One call, one history step labelled "Agent: Revolve".

import { CompositeCommand } from '../../../doc'
import { textFor } from '../../../i18n'
import { createFeatureCommand } from '../../../components/model3d/dialogs/createFeatureCommand'
import { nextId } from '../../../components/model3d/dialogs/nextId'
import { resolveProfileSelector } from '../../../components/model3d/workbench/regionSelector'
import type { ProfileRegion, Vec3 } from '../../../geom/geom-service'
import { axisLineOfNode, isAxisDatumPayload } from '../../../sketch3d'
import { refuse, type ModelEditSpec } from '../registry'
import { FEATURE_RESULT_SCHEMA, featureResult, type FeatureCommandResult } from './fillet'

const workbenchText = textFor('sketch-and-model-workbench')

export interface RevolveInput {
  /** The sketch node whose closed profile is revolved (the dialog's profile picker). */
  sketchId: string
  /** Degrees in (0, 360]. Default 360, a full turn, like the dialog. */
  angleDeg?: number
  /** An axis datum to turn about; default world Z through the origin. */
  axisDatumId?: string
}

// RevolveDialog: a profile whose plane normal is the axis lies perpendicular to it.
const AXIS_PARALLEL_EPS = 1e-6
const WORLD_Z: Vec3 = { x: 0, y: 0, z: 1 }
const DEFAULT_ANGLE = 360

function profileNormalIsRevolveAxis(regions: unknown, axisDir: Vec3): boolean {
  if (!Array.isArray(regions)) return false
  try {
    const resolution = resolveProfileSelector(regions as ProfileRegion[], undefined)
    if (!resolution.ok) return false
    const normal = resolution.profiles[0]?.plane?.normal
    if (normal === undefined || ![normal.x, normal.y, normal.z].every(Number.isFinite)) return false
    const n = Math.hypot(normal.x, normal.y, normal.z)
    const a = Math.hypot(axisDir.x, axisDir.y, axisDir.z)
    if (!(n > AXIS_PARALLEL_EPS) || !(a > AXIS_PARALLEL_EPS)) return false
    const cx = normal.y * axisDir.z - normal.z * axisDir.y
    const cy = normal.z * axisDir.x - normal.x * axisDir.z
    const cz = normal.x * axisDir.y - normal.y * axisDir.x
    return Math.hypot(cx, cy, cz) / (n * a) < AXIS_PARALLEL_EPS
  } catch {
    return false
  }
}

export const revolveSpec: ModelEditSpec<RevolveInput, FeatureCommandResult> = {
  id: 'model.revolve',
  kind: 'edit',
  effect: 'edit',
  input: {
    type: 'object',
    additionalProperties: false,
    required: ['sketchId'],
    properties: {
      sketchId: { type: 'string' },
      angleDeg: { type: 'number' },
      axisDatumId: { type: 'string' },
    },
  },
  output: FEATURE_RESULT_SCHEMA,
  // The dialog has no refusal of its own beyond its disabled Apply (checked in prepare).
  enabled: () => null,
  prepare(session, input) {
    const { dag } = session
    const sketch = dag.getNode(input.sketchId)
    if (sketch === undefined || sketch.kind !== 'sketch') {
      return refuse('missing-target', `There is no sketch "${input.sketchId}" in this model. Create the sketch first, or use the id of an existing one.`)
    }
    const angleDeg = input.angleDeg ?? DEFAULT_ANGLE
    if (!(angleDeg > 0 && angleDeg <= 360)) {
      return refuse('refused', `The revolve angle must be above 0 and at most 360 degrees (got ${angleDeg}). Send 360 for a full turn.`)
    }
    const profiles = resolveProfileSelector(sketch.payload.regions as ProfileRegion[] | undefined, undefined)
    if (!profiles.ok) return refuse('refused', profiles.message)

    const axisDatumId = input.axisDatumId ?? ''
    let axisDir = WORLD_Z
    let axisWords: string = workbenchText('RevolveDialog.worldZ')
    if (axisDatumId !== '') {
      const datum = dag.getNode(axisDatumId)
      const line = axisLineOfNode(dag, axisDatumId)
      if (datum === undefined || datum.kind !== 'datum' || !isAxisDatumPayload(datum.payload) || line === undefined) {
        return refuse('missing-target', `${workbenchText('SolidsWorkbenchPage.axisHasNoResolvedLine', { axisDatumId })}. Use the id of an axis datum in this model (Construct > Axis), or leave the axis out for world Z.`)
      }
      axisDir = line.dir
      axisWords = String(datum.payload.name)
    }
    if (profileNormalIsRevolveAxis(sketch.payload.regions, axisDir)) {
      return refuse('refused', workbenchText('RevolveDialog.revolveRefusedTheSelectedProfileLiesInAPlane', { axisWords }))
    }

    const featureId = nextId(dag, 'F')
    // The dialog's payload, key for key (RevolveDialog handleApply, create mode).
    const payload = {
      opType: 'revolve',
      sketchId: input.sketchId,
      angleDeg,
      ...(axisDatumId !== '' ? { axisDatumId } : {}),
      name: workbenchText('RevolveDialog.revolve', { id: featureId }),
    }
    const label = workbenchText('AgentCommands.revolve')
    return {
      label,
      commands: [new CompositeCommand([createFeatureCommand(dag, { id: featureId, kind: 'feature', consumes: [input.sketchId, ...(axisDatumId === '' ? [] : [axisDatumId])], payload })], label)],
      touched: [featureId],
      changed: { created: [featureId], edited: [], removed: [] },
      finish: (s) => featureResult(s, featureId),
    }
  },
}
