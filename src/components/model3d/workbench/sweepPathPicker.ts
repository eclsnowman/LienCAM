// WO-3230: the Sweep dialog's Sketch path picker. One choice = one open,
// connected line/arc chain in one upstream sketch, persisted as the WO-3228
// selector (sketch node id + entity ids with travel direction).
//
// This builds NO second chain authority: every candidate is what
// `expandSweepPathSelection` (src/geom/sweep-path.ts) returns for one of the
// sketch's curves, and the dialog re-resolves the persisted selector through
// `resolveSweepPathChain` exactly as live replay does. Here we only list the
// chains, give each a stable key, and describe where it starts and which way
// it travels.
//
// First route (decide-and-log, WO-3230): a list of uniquely identified open
// chains. Every chain a click could reach is in the list, so nothing is lost
// to the operator by not clicking in the viewport yet.

import {
  expandSweepPathSelection,
  type SketchChainPathSelector,
  type SweepPathDiagnostic,
  type SweepPathNodeLookup,
} from '../../../geom/sweep-path'
import type { PathChain, PlaneDef, ProfileSegment } from '../../../geom/geom-service'
import { expandBlocksForGeometry } from '../../../lib/sketch/blocks'
import type { Sketch, SketchEntity } from '../../../lib/sketch/types'

export interface SweepPathCandidate {
  /** Transient UI identity, independent of travel direction. Persist `selector`, never this. */
  key: string
  sketchId: string
  selector: SketchChainPathSelector
  path: PathChain
}

export interface SweepPathSketchCandidates {
  sketchId: string
  candidates: SweepPathCandidate[]
  /** Curves of this sketch that belong to no listed chain, with the resolver's reason (one per chain). */
  unavailable: SweepPathDiagnostic[]
}

/** Direction-free key: the same chain walked either way is the same choice. */
export function sweepPathKey(selector: SketchChainPathSelector): string {
  return `${selector.sketchId}:${selector.steps.map((s) => s.entityId).slice().sort().join('\u001f')}`
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Ids of the non-construction lines and arcs a sketch draws (block members flattened the way the resolver reads them). */
function pathCurveIds(node: ReturnType<SweepPathNodeLookup>): string[] {
  if (node === undefined || node.kind !== 'sketch') return []
  const payload = node.payload
  let entities: readonly SketchEntity[] = []
  if (isRecord(payload.sketch)) {
    const sketch = payload.sketch as unknown as Sketch
    entities = expandBlocksForGeometry(sketch.entities ?? [], sketch.constraints ?? [], sketch.blockDefs).entities
  } else if (isRecord(payload.document) && Array.isArray(payload.document.entities)) {
    entities = payload.document.entities as SketchEntity[]
  }
  return entities
    .filter((e) => (e.kind === 'line' || e.kind === 'arc') && e.construction !== true)
    .map((e) => e.id)
}

/** Every open chain one click on a curve of this sketch would pick, each listed once. */
export function sweepPathCandidatesForSketch(sketchId: string, lookup: SweepPathNodeLookup): SweepPathSketchCandidates {
  const candidates: SweepPathCandidate[] = []
  const unavailable: SweepPathDiagnostic[] = []
  const covered = new Set<string>()
  for (const entityId of pathCurveIds(lookup(sketchId))) {
    if (covered.has(entityId)) continue
    const expanded = expandSweepPathSelection(sketchId, entityId, lookup)
    if (!expanded.ok) {
      for (const id of expanded.diagnostic.entityIds) covered.add(id)
      covered.add(entityId)
      unavailable.push(expanded.diagnostic)
      continue
    }
    for (const step of expanded.selector.steps) covered.add(step.entityId)
    candidates.push({ key: sweepPathKey(expanded.selector), sketchId, selector: expanded.selector, path: expanded.path })
  }
  return { sketchId, candidates, unavailable }
}

export interface Vec3Like { x: number; y: number; z: number }

function lift(plane: PlaneDef, p: readonly [number, number]): Vec3Like {
  const n = plane.normal
  const x = plane.xDir
  const y = { x: n.y * x.z - n.z * x.y, y: n.z * x.x - n.x * x.z, z: n.x * x.y - n.y * x.x }
  return {
    x: plane.origin.x + x.x * p[0] + y.x * p[1],
    y: plane.origin.y + x.y * p[0] + y.y * p[1],
    z: plane.origin.z + x.z * p[0] + y.z * p[1],
  }
}

/** Start point and unit travel direction of a path segment, in its sketch plane's 2D coordinates. */
export function segmentStartAndTangent(segment: ProfileSegment): { start: readonly [number, number]; tangent: readonly [number, number] } {
  if (segment.kind === 'line') {
    const dx = segment.b[0] - segment.a[0]
    const dy = segment.b[1] - segment.a[1]
    const length = Math.hypot(dx, dy)
    return { start: segment.a, tangent: length > 0 ? [dx / length, dy / length] : [0, 0] }
  }
  const angle = segment.a0
  const start: readonly [number, number] = [segment.c[0] + Math.cos(angle) * segment.r, segment.c[1] + Math.sin(angle) * segment.r]
  const sign = segment.ccw ? 1 : -1
  return { start, tangent: [-Math.sin(angle) * sign, Math.cos(angle) * sign] }
}

/** Where the path starts and which way it leaves its start, in world millimetres. */
export function sweepPathStart(path: PathChain): { point: Vec3Like; direction: Vec3Like } | null {
  const first = path.segments[0]
  if (first === undefined) return null
  const { start, tangent } = segmentStartAndTangent(first)
  const origin = lift(path.plane, [0, 0])
  const tip = lift(path.plane, tangent)
  return {
    point: lift(path.plane, start),
    direction: { x: tip.x - origin.x, y: tip.y - origin.y, z: tip.z - origin.z },
  }
}

/** The path's own segments plus a start arrow (along the travel direction), in the path plane --
 *  what the viewport draws while the Sweep dialog has a sketch path chosen. */
export function sweepPathPreviewSegments(path: PathChain): ProfileSegment[] {
  const first = path.segments[0]
  if (first === undefined) return []
  const { start, tangent } = segmentStartAndTangent(first)
  const extent = path.segments.reduce((max, segment) => Math.max(max, segment.kind === 'line'
    ? Math.hypot(segment.b[0] - segment.a[0], segment.b[1] - segment.a[1])
    : segment.r), 0)
  const length = Math.max(1, Math.min(10, extent * 0.25))
  const head = length * 0.35
  const tip: [number, number] = [start[0] + tangent[0] * length, start[1] + tangent[1] * length]
  const normal: [number, number] = [-tangent[1], tangent[0]]
  const barb = (side: number): [number, number] => [
    tip[0] - tangent[0] * head + normal[0] * head * 0.6 * side,
    tip[1] - tangent[1] * head + normal[1] * head * 0.6 * side,
  ]
  return [
    ...path.segments,
    { kind: 'line', a: [start[0], start[1]], b: tip, srcId: 'sweep-path-start-arrow' },
    { kind: 'line', a: tip, b: barb(1), srcId: 'sweep-path-start-arrow' },
    { kind: 'line', a: tip, b: barb(-1), srcId: 'sweep-path-start-arrow' },
  ]
}
