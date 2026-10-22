// model.hole (WO-3014): drill a hole -- or a linear / circular pattern of holes -- in a face of a
// live body, exactly as the Model page's Hole dialog does.
//
// The dialog's Apply (create mode) inserts one feature node (nextId 'F', opType 'hole') consuming
// the owner body; the page's kernel op passes the node's face id, points, style and depth to the
// kernel in one makeHole call. The dialog keeps its payload logic inside React, so this command
// restates it (nothing is extracted): the points a pattern expands to (HoleDialog computePoints,
// over dressUpGeometry's perpBasis / addScaled), the style / depth / pattern checks and their
// words (HoleDialog holeStyleError, holeDepthError, placementError), and the payload key for key.
// modelFeatureCommands.wo3014.test.ts pins the result to the dialog's on the same inputs.
//
// The seed point and the face normal are what the dialog takes from the face pick; the face is
// named by the id the Model page's picker uses, and the kernel validates it. One call, one history
// step labelled "Agent: Hole".

import { CompositeCommand } from '../../../doc'
import { textFor } from '../../../i18n'
import { createFeatureCommand } from '../../../components/model3d/dialogs/createFeatureCommand'
import { addScaled, perpBasis } from '../../../components/model3d/dialogs/dressUpGeometry'
import { nextId } from '../../../components/model3d/dialogs/nextId'
import type { HoleStyle, Vec3 } from '../../../geom/geom-service'
import { refuse, type ModelEditSpec } from '../registry'
import { FEATURE_RESULT_SCHEMA, featureResult, ownerRefusal, type FeatureCommandResult } from './fillet'

const workbenchText = textFor('sketch-and-model-workbench')

export interface HoleInput {
  /** The live body drilled (the dialog's owner). */
  ownerId: string
  /** The face the holes start on, by the id the Model page's face picker uses. */
  faceId: string
  /** The first hole's centre on that face (the dialog's seed point). */
  seed: Vec3
  /** The face's outward normal at the seed (the dialog's pick normal). Only a pattern needs it: a
   *  single hole is drilled along the named face, and the node keeps whatever normal is sent. */
  normal?: Vec3
  style: {
    kind: HoleStyle['kind']
    diameter: number
    cbDiameter?: number
    cbDepth?: number
    csDiameter?: number
    csAngleDeg?: number
  }
  depth: { kind: 'blind' | 'throughAll'; distance?: number }
  /** Default one hole at the seed. Omitted pattern fields take the dialog's own defaults. */
  placement?: { kind: 'single' | 'linear' | 'circular'; count?: number; spacing?: number; radius?: number; startAngleDeg?: number }
}

type Placement =
  | { kind: 'single' }
  | { kind: 'linear'; count: number; spacing: number }
  | { kind: 'circular'; count: number; radius: number; startAngleDeg: number }

const VEC3_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['x', 'y', 'z'],
  properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
} as const

// HoleDialog's own starting values for the style and pattern fields a call leaves out.
const DEFAULT_CB_DIAMETER = 9
const DEFAULT_CB_DEPTH = 2
const DEFAULT_CS_DIAMETER = 9
const DEFAULT_CS_ANGLE = 90
const DEFAULT_COUNT = 3
const DEFAULT_SPACING = 10
const DEFAULT_RADIUS = 10
const DEFAULT_START_ANGLE = 0

function computePoints(origin: Vec3, normal: Vec3, placement: Placement): Vec3[] {
  if (placement.kind === 'single') return [origin]
  const { u, v } = perpBasis(normal)
  if (placement.kind === 'linear') {
    return Array.from({ length: placement.count }, (_, i) => addScaled(origin, u, i * placement.spacing, v, 0))
  }
  const startRad = (placement.startAngleDeg * Math.PI) / 180
  return Array.from({ length: placement.count }, (_, i) => {
    const theta = startRad + (i * 2 * Math.PI) / placement.count
    return addScaled(origin, u, placement.radius * Math.cos(theta), v, placement.radius * Math.sin(theta))
  })
}

const positive = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value) && value > 0

function holeStyleError(value: HoleStyle | Record<string, unknown>): string | undefined {
  const style = value as Partial<HoleStyle> & Record<string, unknown>
  if (!positive(style.diameter)) return workbenchText('HoleDialog.holeDiameterMustBeGreaterThanZero')
  if (style.kind === 'counterbore') {
    if (!positive(style.cbDiameter)) return workbenchText('HoleDialog.counterboreDiameterMustBeGreaterThanZero')
    if (!positive(style.cbDepth)) return workbenchText('HoleDialog.counterboreDepthMustBeGreaterThanZero')
  }
  if (style.kind === 'countersink') {
    if (!positive(style.csDiameter)) return workbenchText('HoleDialog.countersinkDiameterMustBeGreaterThanZero')
    if (typeof style.csAngleDeg !== 'number' || !Number.isFinite(style.csAngleDeg) || style.csAngleDeg <= 0 || style.csAngleDeg >= 180) return workbenchText('HoleDialog.countersinkAngleMustBeBetween0And180Degrees')
  }
  return undefined
}

function placementError(placement: Placement): string | undefined {
  if (placement.kind === 'single') return undefined
  if (!Number.isInteger(placement.count) || placement.count < 2) return workbenchText('HoleDialog.holePatternCountMustBeAtLeast2')
  if (placement.kind === 'linear' && !positive(placement.spacing)) return workbenchText('HoleDialog.holePatternSpacingMustBeGreaterThanZero')
  if (placement.kind === 'circular' && !positive(placement.radius)) return workbenchText('HoleDialog.holePatternRadiusMustBeGreaterThanZero')
  return undefined
}

export const holeSpec: ModelEditSpec<HoleInput, FeatureCommandResult> = {
  id: 'model.hole',
  kind: 'edit',
  effect: 'edit',
  input: {
    type: 'object',
    additionalProperties: false,
    required: ['ownerId', 'faceId', 'seed', 'style', 'depth'],
    properties: {
      ownerId: { type: 'string' },
      faceId: { type: 'string' },
      seed: VEC3_SCHEMA,
      normal: VEC3_SCHEMA,
      style: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'diameter'],
        properties: {
          kind: { type: 'string', enum: ['simple', 'counterbore', 'countersink'] },
          diameter: { type: 'number' },
          cbDiameter: { type: 'number' },
          cbDepth: { type: 'number' },
          csDiameter: { type: 'number' },
          csAngleDeg: { type: 'number' },
        },
      },
      depth: {
        type: 'object',
        additionalProperties: false,
        required: ['kind'],
        properties: { kind: { type: 'string', enum: ['blind', 'throughAll'] }, distance: { type: 'number' } },
      },
      placement: {
        type: 'object',
        additionalProperties: false,
        required: ['kind'],
        properties: {
          kind: { type: 'string', enum: ['single', 'linear', 'circular'] },
          count: { type: 'integer' },
          spacing: { type: 'number' },
          radius: { type: 'number' },
          startAngleDeg: { type: 'number' },
        },
      },
    },
  },
  output: FEATURE_RESULT_SCHEMA,
  // The dialog has no refusal of its own beyond its disabled Apply (checked in prepare).
  enabled: () => null,
  prepare(session, input) {
    const { dag } = session
    if (input.faceId.length === 0) {
      return refuse('refused', `Send the id of the face of "${input.ownerId}" the hole starts on.`)
    }
    // The dialog's state, the way its controls hold it, then its checks in its order.
    const s = input.style
    const style: HoleStyle =
      s.kind === 'simple'
        ? { kind: 'simple', diameter: s.diameter }
        : s.kind === 'counterbore'
          ? { kind: 'counterbore', diameter: s.diameter, cbDiameter: s.cbDiameter ?? DEFAULT_CB_DIAMETER, cbDepth: s.cbDepth ?? DEFAULT_CB_DEPTH }
          : { kind: 'countersink', diameter: s.diameter, csDiameter: s.csDiameter ?? DEFAULT_CS_DIAMETER, csAngleDeg: s.csAngleDeg ?? DEFAULT_CS_ANGLE }
    const depth = input.depth.kind === 'throughAll'
      ? ({ kind: 'throughAll' } as const)
      : ({ kind: 'blind', distance: input.depth.distance as number } as const)
    const p = input.placement
    const placement: Placement =
      p === undefined || p.kind === 'single'
        ? { kind: 'single' }
        : p.kind === 'linear'
          ? { kind: 'linear', count: p.count ?? DEFAULT_COUNT, spacing: p.spacing ?? DEFAULT_SPACING }
          : { kind: 'circular', count: p.count ?? DEFAULT_COUNT, radius: p.radius ?? DEFAULT_RADIUS, startAngleDeg: p.startAngleDeg ?? DEFAULT_START_ANGLE }

    const problem = holeStyleError(style)
      ?? (depth.kind === 'blind' && !positive(depth.distance) ? workbenchText('HoleDialog.blindDepthMustBeGreaterThanZero') : undefined)
      ?? placementError(placement)
    if (problem !== undefined) return refuse('refused', problem)
    // A pattern is laid out in the face plane, so it needs the face's direction; a single hole does not.
    const patternNeedsNormal = placement.kind !== 'single' && (input.normal === undefined || !(Math.hypot(input.normal.x, input.normal.y, input.normal.z) > 1e-9))
    if (patternNeedsNormal) {
      return refuse('refused', 'A hole pattern is laid out in the face plane, so it needs the face\'s outward direction. Send a normal that is not zero, for example {"x":0,"y":0,"z":1} for a top face, or place a single hole.')
    }
    const owner = ownerRefusal(session, input.ownerId, workbenchText('SolidsWorkbenchPage.holeOwnerHasNoLiveBodyMissingOrAlready', { ownerId: input.ownerId }))
    if (owner !== null) return owner

    const featureId = nextId(dag, 'F')
    const seed: Vec3 = { x: input.seed.x, y: input.seed.y, z: input.seed.z }
    const normal: Vec3 | undefined = input.normal === undefined ? undefined : { x: input.normal.x, y: input.normal.y, z: input.normal.z }
    const points = computePoints(seed, normal ?? { x: 0, y: 0, z: 1 }, placement)
    // The dialog's payload, key for key (HoleDialog handleApply, create mode).
    const payload = {
      opType: 'hole',
      ownerId: input.ownerId,
      faceId: input.faceId,
      points,
      style,
      depth,
      seed,
      ...(normal === undefined ? {} : { normal }),
      placement,
      name: workbenchText('HoleDialog.hole2', { id: featureId }),
    }
    const label = workbenchText('AgentCommands.hole')
    return {
      label,
      commands: [new CompositeCommand([createFeatureCommand(dag, { id: featureId, kind: 'feature', consumes: [input.ownerId], payload })], label)],
      touched: [featureId],
      changed: { created: [featureId], edited: [], removed: [] },
      finish: (sess) => featureResult(sess, featureId),
    }
  },
}
