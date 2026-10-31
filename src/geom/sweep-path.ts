// WO-3228: the ONE authority that turns a persisted sweep-path selector into
// the exact PathChain a SweepRequest carries (geom-service.ts v0.5).
//
// A selector names its path by IDENTITY, never by geometry or array index:
// the producer sketch's DAG node id plus an ordered list of entity ids, each
// with its travel direction. Resolution reads the sketch's CURRENT payload and
// its datum plane's CURRENT frame, so a coordinate edit or a moved plane flows
// into the path while a deleted entity stays deleted (no neighbour rebind).
//
// Pure: no kernel call, no cache, no selection service. Shared by the Model
// dialog, live replay and headless CAM replay (later orders), so the three can
// never disagree about which curve a saved Sweep runs along.
//
// Reused, never copied:
//   - src/sketch3d/regions.ts `segmentFor`: entity + direction -> exact
//     line/arc ProfileSegment (canonical-CCW arcs; a reversed arc is ccw:false).
//   - src/lib/sketch/bake.ts `chainComponentContaining`: the bake/offset
//     chain walk, used ONLY to expand one clicked entity into a candidate
//     chain. Its 0.05 mm join is never a repair: every resolved path is
//     re-checked below for exact endpoint coincidence at PATH_JOIN_TOL_MM.
//   - src/lib/sketch/blocks.ts `expandBlocksForGeometry`: the same block
//     flattening bake and profile extraction use, so block members resolve
//     under the ids those routes already show.

import type { DagNodeSnapshot } from '../doc/dag'
import type { PathChain, PlaneDef, ProfileSegment } from './geom-service'
import { segmentFor } from '../sketch3d/regions'
import { isDatumPlanePayload } from '../sketch3d/datumPlane'
import type { Sketch3dDocument } from '../sketch3d/types'
import { chainComponentContaining } from '../lib/sketch/bake'
import { expandBlocksForGeometry } from '../lib/sketch/blocks'
import type { Sketch, SketchConstraint, SketchEntity } from '../lib/sketch/types'

/** Endpoint coincidence tolerance for a sweep path, mm. OCCT's
 *  Precision::Confusion(): the distance below which the kernel itself treats
 *  two points as one when it builds the spine wire (geom-engine #buildPathWire).
 *  Anything farther apart is a gap, reported, never closed. */
export const PATH_JOIN_TOL_MM = 1e-7

export interface SweepPathStep {
  entityId: string
  /** true: walk the entity start -> end as stored (an arc CCW); false: reverse. */
  forward: boolean
}

/** Persisted path selector: an ordered chain of entities in ONE sketch. */
export interface SketchChainPathSelector {
  kind: 'sketch-chain'
  /** The producer sketch's DAG node id. */
  sketchId: string
  steps: SweepPathStep[]
}

export type SweepPathSelector = SketchChainPathSelector

export type SweepPathDiagnosticCode =
  | 'malformed-selector'
  | 'unsupported-path-kind'
  | 'missing-sketch'
  | 'not-a-sketch'
  | 'closed-profile-only'
  | 'unsolved-sketch'
  | 'unresolved-plane'
  | 'missing-entity'
  | 'unsupported-entity'
  | 'non-finite-geometry'
  | 'zero-length'
  | 'repeated-entity'
  | 'disconnected'
  | 'closed-path'
  | 'ambiguous-branch'

export interface SweepPathDiagnostic {
  code: SweepPathDiagnosticCode
  /** The producer sketch the diagnostic is about ('' when the selector names none). */
  sketchId: string
  /** The source entities involved, in path order where order means something. */
  entityIds: string[]
  /** One plain sentence for the operator. */
  message: string
  /** Measured endpoint gap, mm ('disconnected' only). */
  gapMm?: number
}

export type SweepPathResolution =
  | { ok: true; path: PathChain }
  | { ok: false; diagnostic: SweepPathDiagnostic }

/** What the resolver needs from the DAG: a node by id (the sketch, then its datum plane). */
export type SweepPathNodeLookup = (nodeId: string) => Pick<DagNodeSnapshot, 'kind' | 'payload'> | undefined

type CurveEntity = Extract<SketchEntity, { kind: 'line' | 'arc' }>

interface SketchSource {
  sketchId: string
  plane: PlaneDef
  entities: SketchEntity[]
  constraints: SketchConstraint[]
}

const SOLVED_STATUSES: ReadonlySet<string> = new Set(['success', 'redundant'])
const TWO_PI = Math.PI * 2

function fail(
  code: SweepPathDiagnosticCode, sketchId: string, entityIds: string[], message: string, gapMm?: number,
): { ok: false; diagnostic: SweepPathDiagnostic } {
  return { ok: false, diagnostic: gapMm === undefined ? { code, sketchId, entityIds, message } : { code, sketchId, entityIds, message, gapMm } }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function finitePlane(p: PlaneDef | undefined): p is PlaneDef {
  if (p === undefined) return false
  return [p.origin, p.normal, p.xDir].every((v) =>
    isRecord(v) && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z))
}

/** The sketch node's current geometry and plane frame, or why there is none.
 *  Package sketches (`payload.sketch`, a CAM Sketch) and legacy native sketch3d
 *  documents (`payload.document`, solved by its executor) both host curves on a
 *  datum plane named by `payload.planeNodeId`. */
function readSketchSource(sketchId: string, lookup: SweepPathNodeLookup): { ok: true; source: SketchSource } | { ok: false; diagnostic: SweepPathDiagnostic } {
  const node = lookup(sketchId)
  if (node === undefined) return fail('missing-sketch', sketchId, [], `The sweep path's sketch '${sketchId}' no longer exists.`)
  if (node.kind !== 'sketch') return fail('not-a-sketch', sketchId, [], `'${sketchId}' is not a sketch, so it has no curves to sweep along.`)
  const payload = node.payload

  let entities: SketchEntity[]
  let constraints: SketchConstraint[]
  if (isRecord(payload.sketch)) {
    const sketch = payload.sketch as unknown as Sketch
    const flat = expandBlocksForGeometry(sketch.entities ?? [], sketch.constraints ?? [], sketch.blockDefs)
    entities = flat.entities
    constraints = flat.constraints
  } else if (isRecord(payload.document)) {
    const solve = payload.solveResult
    if (!isRecord(solve) || typeof solve.status !== 'string' || !SOLVED_STATUSES.has(solve.status)) {
      return fail('unsolved-sketch', sketchId, [], `Sketch '${sketchId}' has not solved, so its curves have no settled position to sweep along.`)
    }
    // sketch3d line/arc/circle/point entities and coincident constraints are
    // structurally identical to the CAM sketch's (workbench/sketchProfile.ts
    // relies on the same identity); only those fields are read below.
    const doc = payload.document as unknown as Sketch3dDocument
    entities = (doc.entities ?? []) as unknown as SketchEntity[]
    constraints = (doc.constraints ?? []) as unknown as SketchConstraint[]
  } else {
    return fail(
      'closed-profile-only', sketchId, [],
      `Sketch '${sketchId}' stores only a closed rectangle profile, which has no open curve to sweep along.`,
    )
  }

  const planeNodeId = typeof payload.planeNodeId === 'string' ? payload.planeNodeId : undefined
  const planeNode = planeNodeId === undefined ? undefined : lookup(planeNodeId)
  const frame = planeNode !== undefined && isDatumPlanePayload(planeNode.payload)
    ? (planeNode.payload.lastGoodFrame as PlaneDef | undefined)
    : undefined
  if (!finitePlane(frame)) {
    return fail('unresolved-plane', sketchId, [], `Sketch '${sketchId}' has no resolved plane, so its path cannot be placed in the model.`)
  }
  return { ok: true, source: { sketchId, plane: frame, entities, constraints } }
}

function arcPoint(e: Extract<CurveEntity, { kind: 'arc' }>, angle: number): { x: number; y: number } {
  return { x: e.center.x + e.radius * Math.cos(angle), y: e.center.y + e.radius * Math.sin(angle) }
}

function curveFinite(e: CurveEntity): boolean {
  return e.kind === 'line'
    ? [e.start.x, e.start.y, e.end.x, e.end.y].every(Number.isFinite)
    : [e.center.x, e.center.y, e.radius, e.startAngle, e.endAngle].every(Number.isFinite)
}

/** CCW sweep start -> end in [0, 2pi): 0 means start and end coincide (a full turn). */
function arcSweepMod(e: Extract<CurveEntity, { kind: 'arc' }>): number {
  const s = (e.endAngle - e.startAngle) % TWO_PI
  return s < 0 ? s + TWO_PI : s
}

function stepEnds(e: CurveEntity, forward: boolean): [{ x: number; y: number }, { x: number; y: number }] {
  const [a, b] = e.kind === 'line' ? [e.start, e.end] : [arcPoint(e, e.startAngle), arcPoint(e, e.endAngle)]
  return forward ? [a, b] : [b, a]
}

const UNSUPPORTED_CAPABILITY: Record<string, string> = {
  spline: 'a spline path',
  ellipse: 'an ellipse path',
  'elliptical-arc': 'an elliptical-arc path',
  text: 'a text path',
  block: 'a block as a path',
  point: 'a point as a path',
}

function validSelectorShape(selector: unknown): selector is SweepPathSelector {
  if (!isRecord(selector) || selector.kind !== 'sketch-chain') return false
  if (typeof selector.sketchId !== 'string' || selector.sketchId.length === 0) return false
  if (!Array.isArray(selector.steps) || selector.steps.length === 0) return false
  return selector.steps.every((s) => isRecord(s) && typeof s.entityId === 'string' && s.entityId.length > 0 && typeof s.forward === 'boolean')
}

/**
 * Resolve a persisted selector against the sketch's CURRENT payload and
 * plane. Returns the exact PathChain (one line/arc ProfileSegment per step,
 * srcId = entity id, plane = the sketch's datum frame), or ONE named
 * diagnostic. Never samples an arc, never closes a gap, never substitutes a
 * neighbour for a missing id, never falls back to another path.
 */
export function resolveSweepPathChain(selector: unknown, lookup: SweepPathNodeLookup): SweepPathResolution {
  if (isRecord(selector) && typeof selector.kind === 'string' && selector.kind !== 'sketch-chain') {
    return fail(
      'unsupported-path-kind', typeof selector.sketchId === 'string' ? selector.sketchId : '', [],
      `A '${selector.kind}' sweep path is not supported yet: a sweep path must be a chain of lines and arcs in one sketch.`,
    )
  }
  if (!validSelectorShape(selector)) {
    const sketchId = isRecord(selector) && typeof selector.sketchId === 'string' ? selector.sketchId : ''
    return fail('malformed-selector', sketchId, [], 'The saved sweep path is incomplete: it needs a sketch and at least one curve with a direction.')
  }
  const { sketchId, steps } = selector
  const ids = steps.map((s) => s.entityId)

  const repeated = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))]
  if (repeated.length > 0) {
    return fail('repeated-entity', sketchId, repeated, `The sweep path uses the same curve more than once (${repeated.join(', ')}).`)
  }

  const read = readSketchSource(sketchId, lookup)
  if (!read.ok) return read
  const { source } = read
  const byId = new Map(source.entities.map((e) => [e.id, e]))

  const missing = ids.filter((id) => !byId.has(id))
  if (missing.length > 0) {
    return fail('missing-entity', sketchId, missing, `The sweep path's curve${missing.length > 1 ? 's' : ''} ${missing.join(', ')} no longer exist${missing.length > 1 ? '' : 's'} in sketch '${sketchId}'.`)
  }

  const resolved = steps.map((s) => ({ step: s, entity: byId.get(s.entityId)! }))
  const unsupported = resolved.filter(({ entity }) => entity.kind !== 'line' && entity.kind !== 'arc')
  const closedCurves = unsupported.filter(({ entity }) => entity.kind === 'circle')
  if (closedCurves.length > 0) {
    const cIds = closedCurves.map(({ entity }) => entity.id)
    return fail('closed-path', sketchId, cIds, `A full circle (${cIds.join(', ')}) closes on itself; a sweep path must be open.`)
  }
  if (unsupported.length > 0) {
    const kinds = [...new Set(unsupported.map(({ entity }) => UNSUPPORTED_CAPABILITY[entity.kind] ?? `a ${entity.kind} path`))]
    return fail(
      'unsupported-entity', sketchId, unsupported.map(({ entity }) => entity.id),
      `Sweep cannot follow ${kinds.join(' or ')} yet; only lines and arcs can be a sweep path.`,
    )
  }
  const curves = resolved as Array<{ step: SweepPathStep; entity: CurveEntity }>

  const nonFinite = curves.filter(({ entity }) => !curveFinite(entity)).map(({ entity }) => entity.id)
  if (nonFinite.length > 0) {
    return fail('non-finite-geometry', sketchId, nonFinite, `The sweep path's curve${nonFinite.length > 1 ? 's' : ''} ${nonFinite.join(', ')} ha${nonFinite.length > 1 ? 've' : 's'} no valid position.`)
  }

  const zero = curves.filter(({ entity }) => entity.kind === 'line'
    ? Math.hypot(entity.end.x - entity.start.x, entity.end.y - entity.start.y) <= PATH_JOIN_TOL_MM
    : entity.radius <= PATH_JOIN_TOL_MM).map(({ entity }) => entity.id)
  if (zero.length > 0) {
    return fail('zero-length', sketchId, zero, `The sweep path's curve${zero.length > 1 ? 's' : ''} ${zero.join(', ')} ha${zero.length > 1 ? 've' : 's'} zero length.`)
  }
  const fullTurns = curves.filter(({ entity }) => entity.kind === 'arc'
    && entity.radius * Math.min(arcSweepMod(entity), TWO_PI - arcSweepMod(entity)) <= PATH_JOIN_TOL_MM).map(({ entity }) => entity.id)
  if (fullTurns.length > 0) {
    return fail('closed-path', sketchId, fullTurns, `The arc ${fullTurns.join(', ')} starts and ends at the same point; a sweep path must be open.`)
  }

  const ends = curves.map(({ step, entity }) => stepEnds(entity, step.forward))
  for (let i = 0; i + 1 < ends.length; i++) {
    const gap = Math.hypot(ends[i][1].x - ends[i + 1][0].x, ends[i][1].y - ends[i + 1][0].y)
    if (gap > PATH_JOIN_TOL_MM) {
      const pair = [ids[i], ids[i + 1]]
      return fail('disconnected', sketchId, pair, `The sweep path breaks between ${pair[0]} and ${pair[1]}: their ends are ${gap.toPrecision(3)} mm apart.`, gap)
    }
  }
  const last = ends[ends.length - 1][1]
  if (Math.hypot(last.x - ends[0][0].x, last.y - ends[0][0].y) <= PATH_JOIN_TOL_MM) {
    return fail('closed-path', sketchId, ids, 'The sweep path ends where it starts; a sweep path must be open.')
  }

  // An arc's span is its canonical CCW sweep mod 2pi (the sketch invariant bake
  // reads too); store angles that differ by a whole extra turn would otherwise
  // reach the spine wire as that extra turn.
  const segments: ProfileSegment[] = curves.map(({ step, entity }) => segmentFor(
    entity.kind === 'arc' ? { ...entity, endAngle: entity.startAngle + arcSweepMod(entity) } : entity,
    step.forward,
  ))
  return { ok: true, path: { sketchId, plane: source.plane, segments } }
}

/** The same chain walked the other way: same entities, reversed order and directions. */
export function reverseSweepPathSelector(selector: SweepPathSelector): SweepPathSelector {
  return {
    kind: 'sketch-chain',
    sketchId: selector.sketchId,
    steps: selector.steps.slice().reverse().map((s) => ({ entityId: s.entityId, forward: !s.forward })),
  }
}

/**
 * Expand ONE clicked entity into the selector for its connected chain, then
 * resolve it. A simple open component expands to its whole chain, oriented so
 * the clicked entity travels as stored. A component with a branch (a node
 * joining three or more curve ends) has no unique path from one click and is
 * reported, never guessed; the caller then persists an explicit step list.
 * Construction geometry and unrelated curves elsewhere in the sketch never
 * join the chain or block it.
 */
export function expandSweepPathSelection(
  sketchId: string, entityId: string, lookup: SweepPathNodeLookup,
): { ok: true; selector: SweepPathSelector; path: PathChain } | { ok: false; diagnostic: SweepPathDiagnostic } {
  const read = readSketchSource(sketchId, lookup)
  if (!read.ok) return read
  const { entities, constraints } = read.source
  const clicked = entities.find((e) => e.id === entityId)
  if (clicked === undefined) {
    return fail('missing-entity', sketchId, [entityId], `Sketch '${sketchId}' has no curve ${entityId}.`)
  }

  // Topology (open, closed, branched) comes from the walk at the path's own
  // join tolerance, so one click and the explicit resolver agree on what is
  // connected. The bake walk at its 0.05 mm join runs only to FIND near-miss
  // ends: when it reaches curves the exact walk does not, its chain goes to
  // the resolver, which names the gap ('disconnected') instead of joining it.
  const toSteps = (c: { steps: Array<{ entity: { id: string }; forward: boolean }> }): SweepPathStep[] =>
    c.steps.map((s) => ({ entityId: s.entity.id, forward: s.forward }))
  let steps: SweepPathStep[]
  const chain = chainComponentContaining(entities, constraints, entityId, PATH_JOIN_TOL_MM)
  if (chain === null) {
    // Not chainable by the bake walk (construction, degenerate, or a kind it
    // does not chain): the entity alone is the selection; resolve says what,
    // if anything, stops it from being a path.
    steps = [{ entityId, forward: true }]
  } else {
    const chainIds = chain.steps.map((s) => s.entity.id)
    if (chain.branched) {
      return fail(
        'ambiguous-branch', sketchId, chainIds,
        `The curve ${entityId} meets a branch, so one click does not say which way the sweep path goes; pick the curves of the path in order.`,
      )
    }
    if (chain.closed) {
      return fail('closed-path', sketchId, chainIds, `The curve ${entityId} is part of a closed loop; a sweep path must be open.`)
    }
    steps = toSteps(chain)
    const near = chainComponentContaining(entities, constraints, entityId)
    if (near !== null && near.steps.some((s) => !chainIds.includes(s.entity.id))) steps = toSteps(near)
  }
  let selector: SweepPathSelector = { kind: 'sketch-chain', sketchId, steps }
  if (steps.find((s) => s.entityId === entityId)?.forward === false) selector = reverseSweepPathSelector(selector)

  const resolved = resolveSweepPathChain(selector, lookup)
  return resolved.ok ? { ok: true, selector, path: resolved.path } : resolved
}

/** A Sweep's producer `consumes`: the profile sketch and the path sketch, once each. */
export function sweepProducerIds(profileSketchId: string, path: SweepPathSelector): string[] {
  return profileSketchId === path.sketchId ? [profileSketchId] : [profileSketchId, path.sketchId]
}
