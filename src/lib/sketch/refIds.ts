import type { SketchConstraint, SketchDimension, SketchEntity } from './types'

// Entity ids a constraint references. Used by delete paths to remove
// every constraint touching a deleted entity — the document must never
// hold a dangling reference (the solver mapping fails loud on one, so a
// missed cleanup here would break ALL subsequent solves, not just the
// deleted entity).
export function constraintRefIds(c: SketchConstraint): string[] {
  switch (c.kind) {
    case 'coincident':
    case 'continuity_g1':
    case 'continuity_g2':   return [c.a.entityId, c.b.entityId]
    case 'concentric':
    case 'parallel':
    case 'perpendicular':
    case 'collinear':
    case 'tangent':
    case 'equal':           return [c.a, c.b]
    case 'horizontal':
    case 'vertical':        return c.line ? [c.line] : (c.points ?? []).map(p => p.entityId)
    case 'midpoint':        return [c.point.entityId, c.line]
    case 'symmetric':       return [c.a.entityId, c.b.entityId, c.axis]
    case 'fix':             return c.point ? [c.point.entityId] : c.entityId ? [c.entityId] : []
    case 'point_on_object': return [c.point.entityId, c.object]
    case 'pierce':          return [c.point.entityId]
  }
}

// WO-1859: the entity ids an ASSOCIATIVE OFFSET re-derives its shape from.
// A SOFT reference, unlike the two above: a dangling one never reaches the
// solver, so it can only cost the offset its link (the geometry survives as
// ordinary entities), never a solve. Delete paths use it to drop the link
// instead of cascading the offset away with its source.
export function offsetSourceRefIds(e: SketchEntity): string[] {
  return e.offsetLink ? e.offsetLink.source.map((r) => r.entityId) : []
}

export function dimensionRefIds(d: SketchDimension): string[] {
  switch (d.kind) {
    case 'distance':
    case 'distanceX':
    case 'distanceY':   return [d.a.entityId, d.b.entityId]
    // WO-1867: an ordinate holds its stack's DATUM as well as the measured
    // point, so deleting either entity must take the dimension with it.
    case 'ordinate':    return [d.origin.entityId, d.point.entityId]
    case 'distancePL':  return [d.point.entityId, d.line]
    case 'angle':       return [d.a, d.b]
    // WO-1868: deleting the vertex OR either leg's entity takes the angle with it.
    case 'angle3':      return [d.vertex.entityId, d.a.entityId, d.b.entityId]
    case 'radius':
    case 'diameter':
    case 'arcLength':
    case 'majorRadius':
    case 'minorRadius':
    case 'focusDistance':
    case 'd1xd2':          return [d.entityId]
  }
}
