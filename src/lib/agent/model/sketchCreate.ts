// model.sketch.create (WO-3013, docs/design/AGENT-MCP.md "add_feature: sketches"): make one
// sketch on a plane with rectangle, circle and closed-polyline profiles, so an agent can go
// from nothing to model.extrude.
//
// What the Model page does for "New sketch" on a base or construction plane
// (SolidsWorkbenchPage beginPickedPlaneSketch -> beginPackageSketch, create mode) is insert
// ONE sketch node that consumes the plane node, with payload { sketch, planeNodeId,
// externalRefs, dimensionDiagnostics, name? }. The profile regions are not stored by the
// page at that moment: the regen executor's sketch branch (recomputeSketchProfile) derives
// them from the plane's frame on every rebuild. This command inserts the same node with the
// geometry already drawn, and the rebuild the runner performs after the commit produces the
// regions exactly as it does after the sketcher's Finish.
//
// The geometry is made by the sketcher's own tool machine (toolClick), fed the clicks a
// person would make: two corners for a rectangle (so it carries the same four lines, corner
// and horizontal / vertical constraints and the construction centre the tool commits), two
// points for a circle, the vertices and a click back on the first for a polyline. What the
// tool ignores (a zero-size click) is refused here in one plain sentence instead of being
// dropped silently.
//
// A sketch on a body FACE follows openPackageSketchOnFace: the face-plane datum is built with
// buildFacePlaneDatumNodeInput and inserted together with the sketch in the SAME history step
// (datum first), and the rebuild resolves its frame from the face. A face that is not flat is
// refused in the page's own sentence before anything is committed (the element map the page
// publishes holds each face's captured surface, the same data the datum executor reads).
// One call, one history step labelled "Agent: Sketch".

import { CompositeCommand, type DagNodeInput } from '../../../doc'
import { textFor } from '../../../i18n'
import { createFeatureCommand } from '../../../components/model3d/dialogs/createFeatureCommand'
import { BASE_PLANE_BY_NODE_ID, BASE_PLANE_LABELS, NODE_ID_BY_BASE_PLANE } from '../../../components/model3d/workbench/basePlanes'
import { createBlankSketch } from '../../sketch/blankSketch'
import { toolClick, type ToolState } from '../../sketch/tools/toolMachine'
import type { Sketch, SketchConstraint, SketchEntity, Vec2 } from '../../sketch/types'
import type { BasePlaneKind } from '../../../sketch3d'
import { buildFacePlaneDatumNodeInput, isFacePlaneDatumPayload, isOffsetPlaneDatumPayload } from '../../../sketch3d/datumPlane'
import { featureLabel, liveBodyFeatureIds } from '../../../components/model3d/bodyLineage'
import { describeFaceSnapshot } from '../../../components/model3d/workbench/faceWords'
import type { PlaneFrame } from '../../../sketch3d/planeMath'
import { sketch3dNodeId } from '../../../sketch3d/regen'
import { refuse, type ModelEditSpec, type Refusal } from '../registry'
import type { JsonSchema } from '../schema'

const workbenchText = textFor('sketch-and-model-workbench')

export const SKETCH_PROFILE_KINDS = ['rectangle', 'circle', 'polyline'] as const
export type SketchProfileKind = (typeof SKETCH_PROFILE_KINDS)[number]

export interface PointInput {
  x: number
  y: number
}

export interface SketchProfileInput {
  kind: SketchProfileKind
  /** rectangle: one corner, in mm on the plane. */
  corner?: PointInput
  /** rectangle: the extent from the corner; either may be negative, like dragging the other way. */
  width?: number
  height?: number
  /** circle */
  center?: PointInput
  radius?: number
  /** polyline: the vertices in order; the last joins back to the first. */
  points?: PointInput[]
}

export interface SketchCreateInput {
  /** 'XY', 'XZ' or 'YZ', or the id of an existing plane (an offset, construction or face plane). */
  plane?: string
  /** Instead of `plane`: a flat face of a body (ids from model.summary); the face plane is made for you. */
  face?: { bodyId: string; faceId: string }
  profiles: SketchProfileInput[]
}

export interface SketchCreateResult {
  sketchId: string
  plane: string
  /** One per profile asked for, in order: the sketch entities that draw it. */
  profiles: Array<{ index: number; kind: SketchProfileKind; entityIds: string[] }>
  /** Closed regions the rebuilt sketch offers an extrude. */
  regionCount: number
}

const POINT: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['x', 'y'],
  properties: { x: { type: 'number' }, y: { type: 'number' } },
}

const CLOSE_TOL_MM = 1e-6

export const sketchCreateSpec: ModelEditSpec<SketchCreateInput, SketchCreateResult> = {
  id: 'model.sketch.create',
  kind: 'edit',
  effect: 'edit',
  input: {
    type: 'object',
    additionalProperties: false,
    required: ['profiles'],
    properties: {
      plane: { type: 'string' },
      face: {
        type: 'object',
        additionalProperties: false,
        required: ['bodyId', 'faceId'],
        properties: { bodyId: { type: 'string' }, faceId: { type: 'string' } },
      },
      profiles: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['kind'],
          properties: {
            kind: { type: 'string', enum: SKETCH_PROFILE_KINDS },
            corner: POINT,
            width: { type: 'number' },
            height: { type: 'number' },
            center: POINT,
            radius: { type: 'number' },
            points: { type: 'array', items: POINT },
          },
        },
      },
    },
  },
  output: {
    type: 'object',
    additionalProperties: false,
    required: ['sketchId', 'plane', 'profiles', 'regionCount'],
    properties: {
      sketchId: { type: 'string' },
      plane: { type: 'string' },
      profiles: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['index', 'kind', 'entityIds'],
          properties: {
            index: { type: 'integer' },
            kind: { type: 'string', enum: SKETCH_PROFILE_KINDS },
            entityIds: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      regionCount: { type: 'integer' },
    },
  },
  enabled: () => null,
  prepare(session, input) {
    const { dag } = session
    if ((input.plane === undefined) === (input.face === undefined)) {
      return refuse('invalid-arguments', 'Say where to sketch with exactly one of plane (XY, XZ, YZ or a plane id) or face {bodyId, faceId}.', '$.plane')
    }
    const rawId = nextSketchId(dag)
    const nodeId = sketch3dNodeId(rawId)
    const plane = input.face !== undefined ? resolveFace(session, input.face, rawId) : resolvePlane(session, input.plane as string)
    if ('ok' in plane) return plane
    if (input.profiles.length === 0) {
      return refuse('refused', 'A sketch needs at least one profile. Send a rectangle, a circle or a closed polyline.', '$.profiles')
    }

    let counter = 0
    const newId = (): string => `${rawId}-${++counter}`

    const entities: SketchEntity[] = []
    const constraints: SketchConstraint[] = []
    const drawn: SketchCreateResult['profiles'] = []
    for (let index = 0; index < input.profiles.length; index++) {
      const made = drawProfile(input.profiles[index], index, newId)
      if ('ok' in made) return made
      entities.push(...made.entities)
      constraints.push(...made.constraints)
      drawn.push({ index, kind: input.profiles[index].kind, entityIds: made.entities.filter((e) => !e.construction).map((e) => e.id) })
    }

    // The page's blank sketch, with the drawing in it. The solver has not run (the sketcher
    // solves on its first edit); every coordinate here is exact and the page re-solves on open.
    const sketch: Sketch = { ...createBlankSketch(plane.layerId, newId), entities, constraints }
    const label = textFor('sketch-and-model-workbench')('AgentCommands.sketch')
    const nodeInput = {
      id: nodeId,
      kind: 'sketch' as const,
      consumes: [plane.nodeId],
      refs: [],
      payload: {
        sketch,
        planeNodeId: plane.nodeId,
        externalRefs: [],
        dimensionDiagnostics: [],
        ...(plane.name === undefined ? {} : { name: plane.name }),
      },
    }
    return {
      label,
      commands: [new CompositeCommand([...(plane.datumInput === undefined ? [] : [createFeatureCommand(dag, plane.datumInput)]), createFeatureCommand(dag, nodeInput)], label)],
      touched: plane.datumInput === undefined ? [nodeId] : [plane.datumInput.id, nodeId],
      changed: { created: plane.datumInput === undefined ? [nodeId] : [plane.datumInput.id, nodeId].sort(), edited: [], removed: [] },
      finish: (s) => {
        const regions = s.dag.getNode(nodeId)?.payload.regions
        return { sketchId: nodeId, plane: plane.nodeId, profiles: drawn, regionCount: Array.isArray(regions) ? regions.length : 0 }
      },
    }
  },
}

interface ResolvedPlane {
  nodeId: string
  layerId: string
  name?: string
  /** A face plane made with the sketch: inserted first, in the same step. */
  datumInput?: DagNodeInput
}

function isFiniteVec(v: { x: number; y: number; z: number } | undefined): boolean {
  return v !== undefined && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)
}

function isFiniteFrame(frame: PlaneFrame | undefined): boolean {
  return frame !== undefined && isFiniteVec(frame.origin) && isFiniteVec(frame.normal) && isFiniteVec(frame.xDir)
}

function resolvePlane(session: Parameters<typeof sketchCreateSpec.prepare>[0], wanted: string): ResolvedPlane | Refusal {
  const { dag } = session
  // model.summary lists the base planes by node id ('datum:XY'); the names XY / XZ / YZ mean the same planes.
  const key = BASE_PLANE_BY_NODE_ID[wanted.trim()] ?? wanted.trim().toLowerCase()
  if (key === 'xy' || key === 'xz' || key === 'yz') {
    const kind = key as BasePlaneKind
    const nodeId = NODE_ID_BY_BASE_PLANE[kind]
    if (!dag.has(nodeId)) {
      return refuse('missing-target', `This model has no ${BASE_PLANE_LABELS[kind]} plane to sketch on. Open the Model page for the part first.`)
    }
    return {
      nodeId,
      layerId: `plane:${kind}`,
      name: workbenchText('SolidsWorkbenchPage.sketchOn', { value1: String(BASE_PLANE_LABELS[kind]) }),
    }
  }
  const node = dag.getNode(wanted)
  if (node === undefined) {
    return refuse('missing-target', `There is no plane "${wanted}" in this model. Use XY, XZ or YZ, or the id of a plane from model.summary.`, '$.plane')
  }
  // The page's beginPickedPlaneSketch / the sketch-on-face route: an offset, construction or face plane
  // that resolved in the last rebuild.
  const status = session.scheduler.statusOf(wanted)
  const sketchable = node.kind === 'datum' && (isOffsetPlaneDatumPayload(node.payload) || isFacePlaneDatumPayload(node.payload))
  const usable = sketchable && node.degraded !== true && status !== 'failed' && status !== 'degraded'
  const frame = (node.payload as { lastGoodFrame?: PlaneFrame }).lastGoodFrame
  if (!usable) {
    return refuse('refused', `"${wanted}" is not a plane that can hold a sketch right now. Use XY, XZ or YZ, or the id of a plane from model.summary.`, '$.plane')
  }
  if (!isFiniteFrame(frame)) {
    return refuse('refused', `The plane "${wanted}" has no resolved position yet, so a sketch cannot be placed on it. Rebuild the model or fix that plane first.`, '$.plane')
  }
  return { nodeId: wanted, layerId: isFacePlaneDatumPayload(node.payload) ? `face:${wanted}` : `plane:${wanted}` }
}

/** The page's openPackageSketchOnFace: a flat face of a live body gets its face-plane datum, built the same way. */
function resolveFace(session: Parameters<typeof sketchCreateSpec.prepare>[0], face: { bodyId: string; faceId: string }, rawId: string): ResolvedPlane | Refusal {
  const { dag, map } = session
  const live = liveBodyFeatureIds(dag, (id) => ['ok', 'degraded'].includes(session.scheduler.statusOf(id)))
  if (!live.includes(face.bodyId)) {
    return refuse('missing-target', `There is no body "${face.bodyId}" in this model. Use the id of a body from model.summary.`, '$.face.bodyId')
  }
  const resolved = map.resolve(face.faceId, 'single-face')
  const snap = resolved.status === 'lost' || resolved.boundTo.length === 0 ? undefined : map.snapshotOf(resolved.boundTo[0])
  if (snap === undefined) {
    return refuse('missing-target', `There is no face "${face.faceId}" on this model. Use a face id from model.summary.`, '$.face.faceId')
  }
  if (snap.surfaceType !== 'plane' || snap.normal === undefined) {
    return refuse('refused', workbenchText('SolidsWorkbenchPage.faceOfIsNotFlatSoASketchCannot', { faceLabel: describeFaceSnapshot(snap), ownerLabel: String(featureLabel(dag, face.bodyId)) }), '$.face.faceId')
  }
  const built = buildFacePlaneDatumNodeInput({ id: rawId, ownerId: face.bodyId, faceId: face.faceId })
  return { nodeId: built.nodeId, layerId: `face:${face.faceId}`, datumInput: built.input }
}

/** The page's nextFaceSketchId: the first SKn not taken as a sketch, its plane or a sketch3d node. */
function nextSketchId(dag: { has(id: string): boolean }): string {
  let n = 1
  while (dag.has(`SK${n}`) || dag.has(`datum:SK${n}`) || dag.has(`sketch3d:SK${n}`)) n++
  return `SK${n}`
}

interface Drawn {
  entities: SketchEntity[]
  constraints: SketchConstraint[]
}

function finite(...values: Array<number | undefined>): boolean {
  return values.every((v) => v !== undefined && Number.isFinite(v))
}

/** Clicks the sketcher's tool with the points a person would pick. */
function drawProfile(profile: SketchProfileInput, index: number, newId: () => string): Drawn | Refusal {
  const where = `$.profiles[${index}]`
  const entities: SketchEntity[] = []
  const constraints: SketchConstraint[] = []
  let state: ToolState = { tool: 'select', chain: null }
  const click = (p: Vec2): boolean => {
    const r = toolClick(state, p, CLOSE_TOL_MM, newId)
    state = r.state
    if (r.commit === null) return false
    entities.push(...r.commit.entities)
    constraints.push(...r.commit.constraints)
    return true
  }

  if (profile.kind === 'rectangle') {
    const { corner, width, height } = profile
    if (corner === undefined || !finite(corner.x, corner.y, width, height)) {
      return refuse('invalid-arguments', 'A rectangle needs a corner {x, y} and a width and height in mm.', where)
    }
    if (Math.abs(width!) <= CLOSE_TOL_MM || Math.abs(height!) <= CLOSE_TOL_MM) {
      return refuse('refused', 'A rectangle needs a width and a height that are not zero.', where)
    }
    state = { tool: 'rect-corner', chain: null }
    click(corner)
    click({ x: corner.x + width!, y: corner.y + height! })
  } else if (profile.kind === 'circle') {
    const { center, radius } = profile
    if (center === undefined || !finite(center.x, center.y, radius)) {
      return refuse('invalid-arguments', 'A circle needs a center {x, y} and a radius in mm.', where)
    }
    if (radius! <= CLOSE_TOL_MM) return refuse('refused', 'A circle needs a radius greater than zero.', where)
    state = { tool: 'circle-center', chain: null }
    click(center)
    click({ x: center.x + radius!, y: center.y })
  } else {
    const points = profile.points
    if (points === undefined || points.length < 3 || !points.every((p) => finite(p.x, p.y))) {
      return refuse('invalid-arguments', 'A polyline needs at least three points {x, y} in mm. The last point joins back to the first.', where)
    }
    state = { tool: 'line', chain: null }
    click(points[0])
    for (let i = 1; i < points.length; i++) {
      if (!click(points[i])) return refuse('refused', `Points ${i} and ${i + 1} of the polyline are the same place. Each point has to be a different place from the one before it.`, where)
    }
    // A last point on the first one already closed the chain in the line tool (astra round 3 F3).
    if (state.chain !== null && !click(points[0])) {
      return refuse('refused', 'The polyline could not be closed back to its first point.', where)
    }
  }
  return { entities, constraints }
}
