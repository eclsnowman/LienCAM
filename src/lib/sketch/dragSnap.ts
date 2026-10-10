import { centerPointForEntity, centerRefForEntity } from './centerReferences'
import type { PointRef, Sketch, SketchConstraint, SketchEntity, Vec2 } from './types'

export type DragSnapTarget =
  | { kind: 'point'; point: Vec2; ref: PointRef }
  | { kind: 'curve'; point: Vec2; entityId: string }

const distance = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y)

function endpointSites(entity: SketchEntity): Array<{ point: Vec2; ref: PointRef }> {
  if (entity.kind === 'line') {
    return [
      { point: entity.start, ref: { entityId: entity.id, site: 'start' } },
      { point: entity.end, ref: { entityId: entity.id, site: 'end' } },
    ]
  }
  if (entity.kind === 'arc') {
    return [
      {
        point: {
          x: entity.center.x + entity.radius * Math.cos(entity.startAngle),
          y: entity.center.y + entity.radius * Math.sin(entity.startAngle),
        },
        ref: { entityId: entity.id, site: 'start' },
      },
      {
        point: {
          x: entity.center.x + entity.radius * Math.cos(entity.endAngle),
          y: entity.center.y + entity.radius * Math.sin(entity.endAngle),
        },
        ref: { entityId: entity.id, site: 'end' },
      },
    ]
  }
  return []
}

export function projectToCurve(entity: SketchEntity, cursor: Vec2): Vec2 | null {
  if (entity.kind === 'line') {
    const dx = entity.end.x - entity.start.x
    const dy = entity.end.y - entity.start.y
    const length2 = dx * dx + dy * dy
    const t = length2 > 0
      ? Math.max(0, Math.min(1,
          ((cursor.x - entity.start.x) * dx + (cursor.y - entity.start.y) * dy) / length2))
      : 0
    return { x: entity.start.x + t * dx, y: entity.start.y + t * dy }
  }
  if (entity.kind !== 'circle' && entity.kind !== 'arc') return null
  const dx = cursor.x - entity.center.x
  const dy = cursor.y - entity.center.y
  const length = Math.hypot(dx, dy)
  if (!(length > 1e-12)) return null
  const angle = Math.atan2(dy, dx)
  if (entity.kind === 'arc') {
    let sweep = entity.endAngle - entity.startAngle
    while (sweep <= 0) sweep += Math.PI * 2
    let relative = angle - entity.startAngle
    while (relative < 0) relative += Math.PI * 2
    if (relative > sweep) return null
  }
  return {
    x: entity.center.x + entity.radius * dx / length,
    y: entity.center.y + entity.radius * dy / length,
  }
}

export function findEndpointDragSnap(
  moving: PointRef,
  cursor: Vec2,
  entities: readonly SketchEntity[],
  tolerance: number,
): DragSnapTarget | null {
  const pointCandidates: Array<{ point: Vec2; ref: PointRef; distance: number }> = []
  for (const entity of entities) {
    if (entity.id === moving.entityId) continue
    if (entity.kind === 'point') {
      pointCandidates.push({
        point: entity.at,
        ref: { entityId: entity.id, site: 'self' },
        distance: distance(cursor, entity.at),
      })
    }
    pointCandidates.push(...endpointSites(entity).map((candidate) => ({
      ...candidate,
      distance: distance(cursor, candidate.point),
    })))
    const center = centerPointForEntity(entity)
    const centerRef = centerRefForEntity(entity)
    if (center && centerRef) {
      pointCandidates.push({ point: center, ref: centerRef, distance: distance(cursor, center) })
    }
  }
  const points = pointCandidates
    .filter((candidate) => candidate.distance <= tolerance)
    .sort((a, b) => a.distance - b.distance)
  if (points.length > 0) {
    if (points.length > 1 && Math.abs(points[1].distance - points[0].distance) <= 1e-9) {
      return null
    }
    return { kind: 'point', point: points[0].point, ref: points[0].ref }
  }

  const curves = entities
    .filter((entity) => entity.id !== moving.entityId)
    .flatMap((entity) => {
      const point = projectToCurve(entity, cursor)
      return point ? [{ entityId: entity.id, point, distance: distance(cursor, point) }] : []
    })
    .filter((candidate) => candidate.distance <= tolerance)
    .sort((a, b) => a.distance - b.distance)
  if (curves.length === 0) return null
  if (curves.length > 1 && Math.abs(curves[1].distance - curves[0].distance) <= 1e-9) {
    return null
  }
  return { kind: 'curve', point: curves[0].point, entityId: curves[0].entityId }
}

export function constraintForEndpointDragSnap(
  moving: PointRef,
  target: DragSnapTarget,
  id: string,
): SketchConstraint {
  return target.kind === 'point'
    ? { id, kind: 'coincident', a: moving, b: target.ref }
    : { id, kind: 'point_on_object', point: moving, object: target.entityId }
}

const sameRef = (a: PointRef, b: PointRef) =>
  a.entityId === b.entityId && a.site === b.site

export function appendDragSnapConstraint(
  sketch: Sketch,
  constraint: SketchConstraint,
): Sketch {
  const duplicate = sketch.constraints.some((existing) => {
    if (constraint.kind === 'coincident' && existing.kind === 'coincident') {
      return (sameRef(existing.a, constraint.a) && sameRef(existing.b, constraint.b))
        || (sameRef(existing.a, constraint.b) && sameRef(existing.b, constraint.a))
    }
    if (constraint.kind === 'point_on_object' && existing.kind === 'point_on_object') {
      return sameRef(existing.point, constraint.point) && existing.object === constraint.object
    }
    return false
  })
  return duplicate
    ? sketch
    : { ...sketch, constraints: [...sketch.constraints, constraint] }
}
