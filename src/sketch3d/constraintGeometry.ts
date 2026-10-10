// Shared "what does this constraint touch, and where should a UI point at it" derivation - used
// by both the conflict/redundant panel (labels + entityIds) and the canvas glyph layer (anchor +
// hover/select entity set). Kept out of mapping.ts because none of this feeds the solver.
import { sketch3dPointSamples } from './pointSamples'
import type { Sketch3dConstraint, Sketch3dDocument, Sketch3dEntity, Sketch3dPointRef, Sketch3dVec2 } from './types'

const TWO_PI = Math.PI * 2

function pointRefId(ref: Sketch3dPointRef): string {
  return ref.site === 'self' ? ref.entityId : `${ref.entityId}:${ref.site}`
}

function positionIndex(document: Sketch3dDocument): Map<string, Sketch3dVec2> {
  const index = new Map<string, Sketch3dVec2>()
  for (const sample of sketch3dPointSamples(document)) index.set(sample.id, sample.at)
  return index
}

function entityIndex(document: Sketch3dDocument): Map<string, Sketch3dEntity> {
  return new Map(document.entities.map((entity) => [entity.id, entity]))
}

function midpoint(a: Sketch3dVec2, b: Sketch3dVec2): Sketch3dVec2 {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

// A representative anchor point for a bare geometry entity (used when a constraint references
// a whole line/circle/arc rather than a specific point on it).
function entityAnchor(entity: Sketch3dEntity): Sketch3dVec2 {
  switch (entity.kind) {
    case 'point':
      return entity.at
    case 'line':
      return midpoint(entity.start, entity.end)
    case 'circle':
      return { x: entity.center.x + entity.radius * Math.cos(Math.PI / 4), y: entity.center.y + entity.radius * Math.sin(Math.PI / 4) }
    case 'arc': {
      // WO SKC-12: canonical-CCW arcs sweep CCW from startAngle to endAngle via
      // norm(endAngle - startAngle) (draftEntities.ts's canonicalArcFromThreePoints) -- a plain
      // (startAngle + endAngle) / 2 average is only the true sweep midpoint when endAngle >
      // startAngle, and silently lands OUTSIDE the arc (on the complementary side) whenever the
      // canonical constructor swapped start/end for a major arc.
      const sweep = ((((entity.endAngle - entity.startAngle) % TWO_PI) + TWO_PI) % TWO_PI)
      const mid = entity.startAngle + sweep / 2
      return { x: entity.center.x + entity.radius * Math.cos(mid), y: entity.center.y + entity.radius * Math.sin(mid) }
    }
  }
}

export interface Sketch3dConstraintGeometry {
  label: string
  entityIds: string[]
  pointIds: string[]
  anchor: Sketch3dVec2
}

function dedupe(ids: string[]): string[] {
  return Array.from(new Set(ids))
}

export function describeConstraint(document: Sketch3dDocument, constraint: Sketch3dConstraint): Sketch3dConstraintGeometry {
  const points = positionIndex(document)
  const entities = entityIndex(document)
  const posOf = (ref: Sketch3dPointRef): Sketch3dVec2 => {
    const at = points.get(pointRefId(ref))
    if (!at) throw new Error(`sketch3d constraint geometry: unknown point ref '${pointRefId(ref)}'`)
    return at
  }
  const anchorOf = (entityId: string): Sketch3dVec2 => {
    const entity = entities.get(entityId)
    if (!entity) throw new Error(`sketch3d constraint geometry: unknown entity '${entityId}'`)
    return entityAnchor(entity)
  }

  switch (constraint.kind) {
    case 'coincident':
      return {
        label: `Coincident (${constraint.a.entityId}, ${constraint.b.entityId})`,
        entityIds: dedupe([constraint.a.entityId, constraint.b.entityId]),
        pointIds: [pointRefId(constraint.a), pointRefId(constraint.b)],
        anchor: posOf(constraint.a),
      }
    case 'horizontal':
    case 'vertical': {
      const kindLabel = constraint.kind === 'horizontal' ? 'Horizontal' : 'Vertical'
      if (constraint.line) {
        return {
          label: `${kindLabel} (${constraint.line})`,
          entityIds: [constraint.line],
          pointIds: [],
          anchor: anchorOf(constraint.line),
        }
      }
      const [p1, p2] = constraint.points!
      return {
        label: `${kindLabel} (${p1.entityId}, ${p2.entityId})`,
        entityIds: dedupe([p1.entityId, p2.entityId]),
        pointIds: [pointRefId(p1), pointRefId(p2)],
        anchor: midpoint(posOf(p1), posOf(p2)),
      }
    }
    case 'parallel':
      return {
        label: `Parallel (${constraint.a}, ${constraint.b})`,
        entityIds: [constraint.a, constraint.b],
        pointIds: [],
        anchor: midpoint(anchorOf(constraint.a), anchorOf(constraint.b)),
      }
    case 'perpendicular':
      return {
        label: `Perpendicular (${constraint.a}, ${constraint.b})`,
        entityIds: [constraint.a, constraint.b],
        pointIds: [],
        anchor: midpoint(anchorOf(constraint.a), anchorOf(constraint.b)),
      }
    case 'tangent':
      return {
        label: `Tangent (${constraint.a}, ${constraint.b})`,
        entityIds: [constraint.a, constraint.b],
        pointIds: [],
        anchor: midpoint(anchorOf(constraint.a), anchorOf(constraint.b)),
      }
    case 'equal':
      return {
        label: `Equal (${constraint.a}, ${constraint.b})`,
        entityIds: [constraint.a, constraint.b],
        pointIds: [],
        anchor: midpoint(anchorOf(constraint.a), anchorOf(constraint.b)),
      }
    case 'midpoint':
      return {
        label: `Midpoint (${constraint.point.entityId} on ${constraint.line})`,
        entityIds: dedupe([constraint.point.entityId, constraint.line]),
        pointIds: [pointRefId(constraint.point)],
        anchor: posOf(constraint.point),
      }
    case 'distance': {
      if (constraint.b) {
        return {
          label: `Distance ${constraint.value} (${constraint.a.entityId}, ${constraint.b.entityId})`,
          entityIds: dedupe([constraint.a.entityId, constraint.b.entityId]),
          pointIds: [pointRefId(constraint.a), pointRefId(constraint.b)],
          anchor: midpoint(posOf(constraint.a), posOf(constraint.b)),
        }
      }
      return {
        label: `Distance ${constraint.value} (${constraint.a.entityId} to ${constraint.line})`,
        entityIds: dedupe([constraint.a.entityId, constraint.line!]),
        pointIds: [pointRefId(constraint.a)],
        anchor: posOf(constraint.a),
      }
    }
    case 'angle':
      return {
        label: `Angle ${constraint.value} (${constraint.a}, ${constraint.b})`,
        entityIds: [constraint.a, constraint.b],
        pointIds: [],
        anchor: midpoint(anchorOf(constraint.a), anchorOf(constraint.b)),
      }
    case 'radius':
      return {
        label: `Radius ${constraint.value} (${constraint.entityId})`,
        entityIds: [constraint.entityId],
        pointIds: [],
        anchor: anchorOf(constraint.entityId),
      }
    case 'diameter':
      return {
        label: `Diameter ${constraint.value} (${constraint.entityId})`,
        entityIds: [constraint.entityId],
        pointIds: [],
        anchor: anchorOf(constraint.entityId),
      }
    case 'fixed': {
      if (constraint.point) {
        return {
          label: `Fixed (${constraint.point.entityId})`,
          entityIds: [constraint.point.entityId],
          pointIds: [pointRefId(constraint.point)],
          anchor: posOf(constraint.point),
        }
      }
      return {
        label: `Fixed (${constraint.entityId})`,
        entityIds: [constraint.entityId!],
        pointIds: [],
        anchor: anchorOf(constraint.entityId!),
      }
    }
  }
}
