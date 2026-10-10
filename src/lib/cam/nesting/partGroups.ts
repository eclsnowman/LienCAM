import type { Vec2 } from '../../../types'
import { intersect, pointInPolygon, polygonArea } from './geometry'

export interface NestLoopLike {
  points: Vec2[]
}

export interface NestPartGroup<T extends NestLoopLike> {
  outer: T
  /** The outer followed by every closed or open feature contained by it. */
  loops: T[]
}

const AREA_EPSILON = 1e-9

function closedRing(points: Vec2[]): Vec2[] {
  if (points.length === 0) return points
  const first = points[0]
  const last = points[points.length - 1]
  return first.x === last.x && first.y === last.y ? points : [...points, first]
}

function containsClosedLoop(outer: Vec2[], inner: Vec2[]): boolean {
  if (Math.abs(polygonArea(outer)) <= Math.abs(polygonArea(inner)) + AREA_EPSILON) {
    return false
  }
  if (intersect(closedRing(outer), closedRing(inner))) return false
  return containsFeature(outer, inner)
}

function containsFeature(outer: Vec2[], feature: Vec2[]): boolean {
  if (feature.length === 0) return false
  let strictlyInside = false
  for (const point of feature) {
    const state = pointInPolygon(point, outer)
    if (state === false) return false
    if (state === true) strictlyInside = true
  }
  return strictlyInside
}

/**
 * Partition one imported geometry into independently nestable composite parts.
 *
 * Every disconnected top-level closed outline becomes one part. All descendant
 * closed loops, plus any open/internal features geometrically contained by that
 * outline, stay in the same group and therefore receive the same placement pose.
 * Input order is preserved for deterministic seed naming and rendering.
 */
export function groupLoopsByTopLevelOuter<T extends NestLoopLike>(
  closedLoops: readonly T[],
  features: readonly T[] = closedLoops,
): NestPartGroup<T>[] {
  if (closedLoops.length === 0) return []

  const parent = new Array<number>(closedLoops.length).fill(-1)
  const areas = closedLoops.map((loop) => Math.abs(polygonArea(loop.points)))

  for (let child = 0; child < closedLoops.length; child++) {
    let bestParent = -1
    let bestArea = Infinity
    for (let candidate = 0; candidate < closedLoops.length; candidate++) {
      if (candidate === child || areas[candidate] >= bestArea) continue
      if (!containsClosedLoop(closedLoops[candidate].points, closedLoops[child].points)) {
        continue
      }
      bestParent = candidate
      bestArea = areas[candidate]
    }
    parent[child] = bestParent
  }

  const rootOf = (index: number): number => {
    let root = index
    while (parent[root] >= 0) root = parent[root]
    return root
  }

  const roots = closedLoops
    .map((_, index) => index)
    .filter((index) => parent[index] < 0)
  const loopsByRoot = new Map<number, T[]>()
  for (const root of roots) loopsByRoot.set(root, [])

  const closedIndex = new Map<T, number>()
  closedLoops.forEach((loop, index) => closedIndex.set(loop, index))

  for (const feature of features) {
    const index = closedIndex.get(feature)
    let root: number | undefined
    if (index !== undefined) {
      root = rootOf(index)
    } else {
      let bestArea = Infinity
      for (const candidate of roots) {
        if (
          areas[candidate] < bestArea &&
          containsFeature(closedLoops[candidate].points, feature.points)
        ) {
          root = candidate
          bestArea = areas[candidate]
        }
      }
    }
    if (root === undefined || feature === closedLoops[root]) continue
    loopsByRoot.get(root)?.push(feature)
  }

  return roots.map((root) => ({
    outer: closedLoops[root],
    loops: [closedLoops[root], ...(loopsByRoot.get(root) ?? [])],
  }))
}

/** WO-1523 (BUG-526): the outer + hole loops of a nestable group, resolved into
 *  NestPart's geometry fields. Every interior loop is a usable nesting window
 *  (no separate designation step - the packer's own inside-fit test decides
 *  what actually fits, see placeInWindows in index.ts) so `windows` is `holes`
 *  verbatim, same frame as `outer`. Shared by createNest and recomputeNest
 *  (src/store/index.ts) so both build a NestPart the same way - the two call
 *  sites drifting apart (one populating windows, one not) is exactly how
 *  BUG-526 happened the first time. */
export function nestPartGeometryFromLoops<T extends NestLoopLike>(
  outer: T,
  holeLoops: readonly T[],
): { outer: Vec2[]; holes: Vec2[][]; windows: Vec2[][] } {
  const holes = holeLoops.map((l) => l.points.map((p) => ({ x: p.x, y: p.y })))
  return { outer: outer.points.map((p) => ({ x: p.x, y: p.y })), holes, windows: holes }
}
