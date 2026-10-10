import type { SketchEntity, Vec2 } from './types'

export type SketchMeasureValueKind = 'length' | 'angle' | 'count'

export interface SketchMeasureValue {
  label: string
  value: number
  kind: SketchMeasureValueKind
}

/** Identity of one natural reference point a two-entity spacing measured. */
export interface SketchMeasureReference {
  entityId: string
  label: string
}

export interface SketchSelectionMeasurement {
  title: string
  /** Present ONLY on a two-entity spacing: the two natural reference points
   *  the Distance/dX/dY/Angle values were taken between. Absent on a
   *  single-entity measurement. */
  references?: SketchMeasureReference[]
  values: SketchMeasureValue[]
}

function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

function angleDeg(a: Vec2, b: Vec2): number {
  return Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI
}

function positiveSweep(start: number, end: number): number {
  const tau = Math.PI * 2
  return ((end - start) % tau + tau) % tau
}

interface NaturalReference {
  point: Vec2
  label: string
}

function naturalReference(entity: SketchEntity): NaturalReference | null {
  switch (entity.kind) {
    case 'point':
      return { point: entity.at, label: 'point' }
    case 'line':
      return {
        point: {
          x: (entity.start.x + entity.end.x) / 2,
          y: (entity.start.y + entity.end.y) / 2,
        },
        label: 'line midpoint',
      }
    case 'circle':
      return { point: entity.center, label: 'circle center' }
    case 'arc':
      return { point: entity.center, label: 'arc center' }
    case 'ellipse':
      return { point: entity.center, label: 'ellipse center' }
    case 'elliptical-arc':
      return { point: entity.center, label: 'elliptical arc center' }
    case 'spline': {
      const point = entity.points[0]
      return point ? { point, label: 'spline start' } : null
    }
    case 'text':
      return { point: entity.at, label: 'text anchor' }
    case 'block':
      return { point: entity.origin, label: 'block origin' }
  }
}

function measureOne(entity: SketchEntity): SketchSelectionMeasurement {
  switch (entity.kind) {
    case 'point':
      return {
        title: 'Point position',
        values: [
          { label: 'X', value: entity.at.x, kind: 'length' },
          { label: 'Y', value: entity.at.y, kind: 'length' },
        ],
      }
    case 'line': {
      const dx = entity.end.x - entity.start.x
      const dy = entity.end.y - entity.start.y
      return {
        title: 'Line',
        values: [
          { label: 'Length', value: Math.hypot(dx, dy), kind: 'length' },
          { label: 'dX', value: dx, kind: 'length' },
          { label: 'dY', value: dy, kind: 'length' },
          { label: 'Angle', value: angleDeg(entity.start, entity.end), kind: 'angle' },
        ],
      }
    }
    case 'circle':
      return {
        title: 'Circle',
        values: [
          { label: 'Radius', value: entity.radius, kind: 'length' },
          { label: 'Diameter', value: entity.radius * 2, kind: 'length' },
          { label: 'Circumference', value: Math.PI * entity.radius * 2, kind: 'length' },
        ],
      }
    case 'arc': {
      const sweep = positiveSweep(entity.startAngle, entity.endAngle)
      return {
        title: 'Arc',
        values: [
          { label: 'Radius', value: entity.radius, kind: 'length' },
          { label: 'Arc length', value: entity.radius * sweep, kind: 'length' },
          { label: 'Sweep', value: sweep * 180 / Math.PI, kind: 'angle' },
        ],
      }
    }
    case 'ellipse':
      return {
        title: 'Ellipse',
        values: [
          { label: 'Major radius', value: entity.majorRadius, kind: 'length' },
          { label: 'Minor radius', value: entity.minorRadius, kind: 'length' },
          { label: 'Rotation', value: entity.rotation * 180 / Math.PI, kind: 'angle' },
        ],
      }
    case 'elliptical-arc':
      return {
        title: 'Elliptical arc',
        values: [
          { label: 'Major radius', value: entity.majorRadius, kind: 'length' },
          { label: 'Minor radius', value: entity.minorRadius, kind: 'length' },
          {
            label: 'Sweep',
            value: positiveSweep(entity.startParam, entity.endParam) * 180 / Math.PI,
            kind: 'angle',
          },
        ],
      }
    case 'spline': {
      const start = entity.points[0]
      const end = entity.points[entity.points.length - 1]
      const values: SketchMeasureValue[] = [
        { label: 'Points', value: entity.points.length, kind: 'count' },
      ]
      if (start && end) {
        values.push(
          { label: 'Chord', value: distance(start, end), kind: 'length' },
          { label: 'Angle', value: angleDeg(start, end), kind: 'angle' },
        )
      }
      return { title: entity.closed ? 'Closed spline' : 'Spline', values }
    }
    case 'text':
      return {
        title: 'Text',
        values: [
          { label: 'Height', value: entity.height, kind: 'length' },
          { label: 'Rotation', value: (entity.rotation ?? 0) * 180 / Math.PI, kind: 'angle' },
        ],
      }
    case 'block':
      return {
        title: entity.name ? `Block: ${entity.name}` : 'Block',
        values: [
          { label: 'Members', value: entity.members.entities.length, kind: 'count' },
          { label: 'Origin X', value: entity.origin.x, kind: 'length' },
          { label: 'Origin Y', value: entity.origin.y, kind: 'length' },
        ],
      }
  }
}

/**
 * Read-only inspection for the sketch Measure utility. It never creates a
 * dimension or mutates the document. One entity reports its intrinsic
 * geometry; two entities report spacing between their natural reference
 * points (line midpoint, curve center, point/text/spline anchor) and name
 * those two points in `references` so the number is legible against the
 * visible geometry.
 */
export function measureSketchSelection(
  entities: readonly SketchEntity[],
  selectedIds: readonly string[],
): SketchSelectionMeasurement | null {
  const selected = selectedIds
    .map((id) => entities.find((entity) => entity.id === id))
    .filter((entity): entity is SketchEntity => entity !== undefined)

  if (selected.length === 1) return measureOne(selected[0])
  if (selected.length !== 2) return null

  const a = naturalReference(selected[0])
  const b = naturalReference(selected[1])
  if (!a || !b) return null

  return {
    title: 'Selection spacing',
    references: [
      { entityId: selected[0].id, label: a.label },
      { entityId: selected[1].id, label: b.label },
    ],
    values: [
      { label: 'Distance', value: distance(a.point, b.point), kind: 'length' },
      { label: 'dX', value: b.point.x - a.point.x, kind: 'length' },
      { label: 'dY', value: b.point.y - a.point.y, kind: 'length' },
      { label: 'Angle', value: angleDeg(a.point, b.point), kind: 'angle' },
    ],
  }
}
