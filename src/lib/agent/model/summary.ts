// model.summary (WO-3013, docs/design/AGENT-MCP.md "project_summary: the tree, bodies"):
// read the open model the way the Model page shows it -- the Design tree in order, the
// Bodies list and the Parameters table -- as plain frozen data. A read: no history step,
// nothing written.
//
// Every fact comes from the same place the screen reads it: the tree rows are the DAG's
// feature order with the names featureLabel gives them, the status is the scheduler's, the
// Bodies rows are the page's own census (bodyFeatureIds -> liveBodyFeatureIds ->
// projectBodyLineages, the three calls refreshBodiesList makes), the parameters are the
// Parameters table's.
//
// A body's volume is a kernel measurement the page keeps in its Bodies state; nothing a
// ModelSession holds carries it. The page hands it over through setBodyFacts() below; with
// no provider the row simply has no `volume` (the screen shows none either until the
// measurement lands).

import { isGenesisNodeId } from '../../../doc'
import type { ModelSession } from '../../../doc/modelSession'
import type { JsonSchema } from '../schema'
import { bodyFeatureIds, featureLabel, liveBodyFeatureIds, projectBodyLineages, resolveBodyTargetLineage } from '../../../components/model3d/bodyLineage'
import type { ModelReadSpec } from '../registry'

const NO_ARGUMENTS: JsonSchema = { type: 'object', additionalProperties: false, properties: {} }

/** Rebuild statuses that mean the node produced a body (the page's bodyHandles stand-in). */
const HAS_BODY = new Set(['ok', 'degraded'])

export interface BodyFact {
  /** Exact volume in mm^3, once the kernel has measured it. */
  volume?: number
}

export type BodyFactsProvider = () => Readonly<Record<string, BodyFact>>

const bodyFactsProviders = new WeakMap<ModelSession, BodyFactsProvider>()

/** The Model page publishes what its Bodies list knows about each body, keyed by body id. Pass
 *  null to remove it (the page's unmount). */
export function setBodyFacts(session: ModelSession, provider: BodyFactsProvider | null): void {
  if (provider === null) bodyFactsProviders.delete(session)
  else bodyFactsProviders.set(session, provider)
}

export interface SummaryItem {
  id: string
  /** The DAG kind: sketch, datum, feature, import, ... */
  kind: string
  /** The row's name in the Design tree. */
  name: string
  /** For a feature, its operation (extrude, revolve, ...). */
  opType?: string
  /** Rebuild status: ok, failed, suppressed, ... */
  status: string
  suppressed: boolean
  /** True for the origin and the three base planes every model has. */
  builtIn: boolean
  /** The nodes this one is built on. */
  consumes: string[]
  /** A sketch's plane. */
  plane?: string
  /** A sketch's closed profiles (regions) as of the last rebuild. */
  profileCount?: number
}

export interface SummaryFace {
  id: string
  /** Outward direction of the flat face. */
  normal: { x: number; y: number; z: number }
  centroid: { x: number; y: number; z: number }
}

export interface SummaryBody {
  id: string
  name: string
  volume?: number
  /** Flat faces a sketch can start on (model.sketch.create's `face`). */
  planarFaces: SummaryFace[]
}

export interface SummaryParameter {
  name: string
  expression: string
  value: number
  status: string
}

export interface ModelSummary {
  items: SummaryItem[]
  bodies: SummaryBody[]
  parameters: SummaryParameter[]
}

const STATUS_VALUES = ['ok', 'dirty', 'running', 'failed', 'degraded', 'suppressed', 'rolledBack'] as const

const ITEM: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'kind', 'name', 'status', 'suppressed', 'builtIn', 'consumes'],
  properties: {
    id: { type: 'string' },
    kind: { type: 'string' },
    name: { type: 'string' },
    opType: { type: 'string' },
    status: { type: 'string', enum: STATUS_VALUES },
    suppressed: { type: 'boolean' },
    builtIn: { type: 'boolean' },
    consumes: { type: 'array', items: { type: 'string' } },
    plane: { type: 'string' },
    profileCount: { type: 'integer' },
  },
}

const VEC3: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['x', 'y', 'z'],
  properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
}

const BODY: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'planarFaces'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    volume: { type: 'number' },
    planarFaces: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'normal', 'centroid'],
        properties: { id: { type: 'string' }, normal: VEC3, centroid: VEC3 },
      },
    },
  },
}

const PARAMETER: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'expression', 'value', 'status'],
  properties: {
    name: { type: 'string' },
    expression: { type: 'string' },
    value: { type: 'number' },
    status: { type: 'string', enum: STATUS_VALUES },
  },
}

export const summaryReadSpec: ModelReadSpec<Record<string, never>, ModelSummary> = {
  id: 'model.summary',
  kind: 'read',
  effect: 'read',
  input: NO_ARGUMENTS,
  output: {
    type: 'object',
    additionalProperties: false,
    required: ['items', 'bodies', 'parameters'],
    properties: {
      items: { type: 'array', items: ITEM },
      bodies: { type: 'array', items: BODY },
      parameters: { type: 'array', items: PARAMETER },
    },
  },
  read: (session) => modelSummary(session),
}

export function modelSummary(session: ModelSession): ModelSummary {
  const { dag } = session
  const items: SummaryItem[] = []
  for (const id of dag.featureOrder()) {
    const node = dag.getNode(id)
    // A parameter is a row of the Parameters table, not of the Design tree.
    if (node === undefined || node.kind === 'parameter') continue
    const payload = node.payload as Record<string, unknown>
    const item: SummaryItem = {
      id,
      kind: node.kind,
      name: featureLabel(dag, id),
      status: session.scheduler.statusOf(id),
      suppressed: dag.isEffectivelySuppressed(id),
      builtIn: isGenesisNodeId(id),
      consumes: [...node.consumes],
    }
    if (node.kind === 'feature' && typeof payload.opType === 'string') item.opType = payload.opType
    if (node.kind === 'sketch') {
      if (typeof payload.planeNodeId === 'string') item.plane = payload.planeNodeId
      if (Array.isArray(payload.regions)) item.profileCount = payload.regions.length
    }
    items.push(item)
  }

  const facts = bodyFactsProviders.get(session)?.() ?? {}
  const all = bodyFeatureIds(dag)
  const live = liveBodyFeatureIds(dag, (id) => HAS_BODY.has(session.scheduler.statusOf(id)))
  const bodies: SummaryBody[] = projectBodyLineages(dag, all, live).map(({ bodyId, lineageId }) => {
    const volume = facts[bodyId]?.volume
    return { id: bodyId, name: featureLabel(dag, lineageId), ...(volume === undefined ? {} : { volume }), planarFaces: planarFacesOf(session, all, bodyId) }
  })

  const parameters: SummaryParameter[] = session.params.names().map((name) => ({
    name,
    expression: session.params.expressionOf(name) ?? '',
    value: session.params.valueOf(name) ?? 0,
    status: session.params.statusOf(name),
  }))
  return { items, bodies, parameters }
}

/** The live flat faces this body actually has: those minted by the body-producing features whose material it
 *  carries (a face id starts with the id of the feature that made it). Ancestry is followed through material
 *  edges between bodies only -- never through a sketch or datum, so a New body sketched on another body's face
 *  does not report that body's faces (the Bodies list's own rule, bodyLineage.ts). */
function planarFacesOf(session: ModelSession, allBodyIds: readonly string[], bodyId: string): SummaryFace[] {
  const { dag, map } = session
  const makers = new Set<string>([bodyId])
  for (const candidate of allBodyIds) {
    const r = resolveBodyTargetLineage(dag, allBodyIds, [bodyId], candidate)
    if (r.ok && r.bodyId === bodyId) makers.add(candidate)
  }
  const out: SummaryFace[] = []
  for (const id of map.liveIds()) {
    if (!makers.has(id.split(':')[0])) continue
    const snap = map.snapshotOf(id)
    if (snap === undefined || snap.surfaceType !== 'plane' || snap.normal === undefined) continue
    out.push({ id, normal: { ...snap.normal }, centroid: { ...snap.centroid } })
  }
  return out
}
