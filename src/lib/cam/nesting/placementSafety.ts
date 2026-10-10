import type { Vec2 } from '../../../types'
import { intersection } from '../adaptiveClearing2d/engine/clipperEngine'
import { polygonArea } from './geometry'
import { transformRing } from './placement'
import type { NestPart, Placement, Sheet } from './types'

const AREA_EPSILON = 1e-8
const BOUNDS_EPSILON = 1e-6
// Standing project tolerance: a placement passes only when its measured
// clearance is at least `partGap - 0.01` mm. Operator ruling 2026-08-09: "0.01 is
// already 10x safety margin". The independent final validator must not
// accept a pose that sits further inside the requested gap than this.
const CLEARANCE_TOLERANCE = 0.01

function hasPositiveAreaOverlap(a: Vec2[], b: Vec2[]): boolean {
  return intersection([a], [b]).some((loop) => Math.abs(polygonArea(loop)) > AREA_EPSILON)
}

function pointSegmentDistanceSquared(point: Vec2, start: Vec2, end: Vec2): number {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared <= Number.EPSILON) {
    const px = point.x - start.x
    const py = point.y - start.y
    return px * px + py * py
  }
  const projected =
    ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared
  const t = Math.max(0, Math.min(1, projected))
  const closestX = start.x + t * dx
  const closestY = start.y + t * dy
  const px = point.x - closestX
  const py = point.y - closestY
  return px * px + py * py
}

function minimumRingClearanceSquared(a: Vec2[], b: Vec2[]): number {
  let minimum = Infinity
  const measure = (points: Vec2[], edges: Vec2[]) => {
    for (const point of points) {
      for (let index = 0; index < edges.length; index++) {
        minimum = Math.min(
          minimum,
          pointSegmentDistanceSquared(point, edges[index], edges[(index + 1) % edges.length]),
        )
      }
    }
  }
  measure(a, b)
  measure(b, a)
  return minimum
}

function violatesPartClearance(a: Vec2[], b: Vec2[], partGap: number): boolean {
  if (hasPositiveAreaOverlap(a, b)) return true
  if (partGap <= 0) return false
  const required = Math.max(0, partGap - CLEARANCE_TOLERANCE)
  return minimumRingClearanceSquared(a, b) < required * required
}

function isInsideUsableSheet(ring: Vec2[], sheet: Sheet, margin: number): boolean {
  const minX = margin - BOUNDS_EPSILON
  const minY = margin - BOUNDS_EPSILON
  const maxX = sheet.width - margin + BOUNDS_EPSILON
  const maxY = sheet.height - margin + BOUNDS_EPSILON
  return ring.every(
    (point) =>
      point.x >= minX &&
      point.y >= minY &&
      point.x <= maxX &&
      point.y <= maxY,
  )
}

/**
 * Final transformed-geometry safety gate for a nesting result.
 *
 * The NFP search should already produce valid poses. This independent check
 * prevents a failed/degenerate search from leaking stacked or out-of-sheet
 * top-level placements into preview, simulation, or post. Invalid placements
 * are returned to the caller for explicit unplaced accounting.
 */
export function validatePlacementSafety(
  entries: readonly { part: NestPart }[],
  placements: readonly Placement[],
  sheet: Sheet,
  sheetMargin: number,
  partGap = 0,
): { placements: Placement[]; rejected: Placement[] } {
  const requestedGap = Number.isFinite(partGap) ? Math.max(0, partGap) : 0
  const partById = new Map(entries.map((entry) => [entry.part.id, entry.part]))
  const accepted: Placement[] = []
  const rejected: Placement[] = []
  const acceptedRings: Vec2[][] = []
  const acceptedIds = new Set<string>()

  for (const placement of placements) {
    if (placement.depth !== 0) continue
    const part = partById.get(placement.partId)
    if (!part) {
      rejected.push(placement)
      continue
    }
    const ring = transformRing(
      part.outer,
      placement.rotationDeg,
      placement.x,
      placement.y,
    )
    const violatesClearance = acceptedRings.some((other) =>
      violatesPartClearance(ring, other, requestedGap),
    )
    if (!isInsideUsableSheet(ring, sheet, sheetMargin) || violatesClearance) {
      rejected.push(placement)
      continue
    }
    accepted.push(placement)
    acceptedRings.push(ring)
    acceptedIds.add(placement.instanceId)
  }

  // Window children are produced by their own inside-window containment/NFP
  // gate. Keep them only when their accepted top-level host still exists.
  for (const placement of placements) {
    if (placement.depth === 0) continue
    if (placement.windowParentId && acceptedIds.has(placement.windowParentId)) {
      accepted.push(placement)
    } else {
      rejected.push(placement)
    }
  }

  return { placements: accepted, rejected }
}
