import type { PointRef, Sketch, SketchDimension, SketchConstraint } from '../types'
import { remapConstraint } from '../tools/patternTools'
import { constraintRefIds, dimensionRefIds } from '../refIds'

/** Pull back only dimensions invariant under the instance's similarity map.
 * The persisted dimension stays on the copy and is rechecked downstream. */
export function routeDependentDimension(sketch: Sketch, dimension: SketchDimension): SketchDimension | undefined {
  let current = dimension, routed = false
  const limit = (sketch.patterns?.length ?? 0) + new Set(sketch.entities.flatMap(e => e.offsetLink ? [e.offsetLink.id] : [])).size
  for (let step = 0; step <= limit; step++) {
    const refs = dimensionRefIds(current)
    const pattern = sketch.patterns?.find(p => p.members.some(m => refs.includes(m.id)))
    if (pattern) {
      const members = refs.map(id => pattern.members.find(m => m.id === id))
      if (members.some(m => !m) || members.some(m => m!.column !== members[0]!.column || m!.row !== members[0]!.row)) return undefined
      const scale = pattern.values.kind === 'transform' ? Math.abs(pattern.values.scale) : 1
      const sourceId = (id: string) => pattern.members.find(m => m.id === id)!.sourceId
      const point = (ref: PointRef): PointRef => {
        const entityId = sourceId(ref.entityId)
        const source = sketch.entities.find(e => e.id === entityId)
        const site = pattern.values.kind === 'mirror' && source?.kind === 'arc'
          ? ref.site === 'start' ? 'end' : ref.site === 'end' ? 'start' : ref.site : ref.site
        return { entityId, site }
      }
      if (current.kind === 'radius' || current.kind === 'diameter' || current.kind === 'arcLength' || current.kind === 'majorRadius' || current.kind === 'minorRadius') {
        current = { ...current, entityId: sourceId(current.entityId), value: current.value / scale }
      } else if (current.kind === 'distance') {
        current = { ...current, a: point(current.a), b: point(current.b), value: current.value / scale }
      } else return undefined
      routed = true
      continue
    }
    const offset = refs.map(id => sketch.entities.find(e => e.id === id)).find(e => e?.offsetLink)
    if (offset?.offsetLink) {
      const link = offset.offsetLink
      if (refs.length !== 1 || offset.kind !== 'circle' || link.source.length !== 1 ||
          !['radius', 'diameter'].includes(current.kind)) return undefined
      const source = sketch.entities.find(e => e.id === link.source[0].entityId)
      if (source?.kind !== 'circle' || (current.kind !== 'radius' && current.kind !== 'diameter')) return undefined
      // computeOffset circle policy: rCopy = rSource - side * distance.
      current = { ...current, entityId: source.id,
        value: current.value + link.side * link.distance * (current.kind === 'diameter' ? 2 : 1) }
      routed = true
      continue
    }
    return routed ? { ...current, id: `__patternroute-${dimension.id}` } : undefined
  }
  return undefined
}


/** Similarity-invariant relations wholly inside one instance can be solved on
 * the source. Axis directions route only for a known quarter-turn transform. */
export function routeDependentConstraint(sketch: Sketch, constraint: SketchConstraint): SketchConstraint | undefined {
  let current = constraint, routed = false
  for (let step = 0; step <= (sketch.patterns?.length ?? 0); step++) {
    const refs = constraintRefIds(current)
    const pattern = sketch.patterns?.find(p => p.members.some(m => refs.includes(m.id)))
    if (!pattern) return routed ? { ...current, id: `__patternroute-${constraint.id}` } : undefined
    const members = refs.map(id => pattern.members.find(m => m.id === id))
    if (members.some(m => !m) || members.some(m => m!.column !== members[0]!.column || m!.row !== members[0]!.row)) return undefined
    const values = pattern.values
    if ((current.kind === 'horizontal' || current.kind === 'vertical' || current.kind === 'fix') &&
        (values.kind === 'path' || values.kind === 'mirror')) return undefined
    const ids = new Map(pattern.members.map(m => [m.id, m.sourceId]))
    if (current.kind === 'fix') {
      current = current.point ? { ...current, point: { ...current.point, entityId: ids.get(current.point.entityId)! } }
        : { ...current, entityId: ids.get(current.entityId!)! }
    } else {
      // Reflection swaps stored CCW arc endpoints. Other sites keep identity.
      const swapArcSites = (value: unknown): unknown => {
        if (!value || typeof value !== 'object') return value
        if (Array.isArray(value)) return value.map(swapArcSites)
        const record = value as Record<string, unknown>
        const source = typeof record.entityId === 'string' ? sketch.entities.find(e => e.id === ids.get(record.entityId as string)) : undefined
        return Object.fromEntries(Object.entries(record).map(([key, child]) => [key,
          key === 'site' && values.kind === 'mirror' && source?.kind === 'arc'
            ? child === 'start' ? 'end' : child === 'end' ? 'start' : child : swapArcSites(child)]))
      }
      const angle = values.kind === 'circular' || values.kind === 'transform' ? -members[0]!.column * values.stepAngle : 0
      const mapped = remapConstraint(swapArcSites(current) as SketchConstraint, ids, () => current.id, angle)
      if (!mapped) return undefined
      current = mapped
    }
    routed = true
  }
  return undefined
}
