import type { Sketch, SketchEntity, Vec2 } from './types'
import { centroidOfEntities } from './blocks'
import type { SketchDocTransform } from './tools/trimTool'
import { transformEntity, pathPatternTransformAt, type PatternPathSource, type PatternResult } from './tools/patternTools'
import { constraintRefIds, dimensionRefIds } from './refIds'
import { mirrorEntities, type MirrorResult } from './tools/mirrorTool'

export type PatternPathDefinition = { kind: 'chain'; steps: { entityId: string; forward: boolean }[]; closed: boolean } | { kind: 'spline' | 'elliptical-arc'; entityId: string }

export type PatternValues =
  | { kind: 'path'; count: number; path: PatternPathDefinition; spacingMode: 'equal' | 'fixed'; fixedSpacing: number; followTangent: boolean }
  | { kind: 'linear'; count: number; step: Vec2; rows: number; rowStep: Vec2 }
  | { kind: 'circular'; count: number; center: Vec2; stepAngle: number }
  | { kind: 'mirror'; count: 2; axisId: string }
  | { kind: 'transform'; count: 2; center: Vec2; stepAngle: number; scale: number; shift: Vec2 }

export interface SketchPatternDefinition {
  id: string
  sources: string[]
  values: PatternValues
  /** Stable member addresses survive value edits, suppression, and restoration. */
  members: { id: string; sourceId: string; column: number; row: number }[]
  suppressed: string[]
  constraintIds?: string[]
  expressions?: Record<string, string>
}

export function patternGoverningIds(pattern: SketchPatternDefinition): string[] {
  const v = pattern.values
  return [...pattern.sources, ...(v.kind === 'mirror' ? [v.axisId] : v.kind === 'path'
    ? v.path.kind === 'chain' ? v.path.steps.map(s => s.entityId) : [v.path.entityId] : [])]
}

export function livePatternPath(path: PatternPathDefinition, entities: SketchEntity[]): PatternPathSource {
  const get = (id: string) => {
    const entity = entities.find(e => e.id === id)
    if (!entity) throw new Error(`Path pattern: path entity ${id} was removed`)
    return entity
  }
  if (path.kind === 'chain') return { kind: 'chain', closed: path.closed, steps: path.steps.map(step => {
    const entity = get(step.entityId)
    if (entity.kind !== 'line' && entity.kind !== 'arc') throw new Error('Path pattern: chain member changed kind')
    return { entity, forward: step.forward }
  }) }
  const entity = get(path.entityId)
  if (path.kind === 'spline' && entity.kind === 'spline') return { kind: 'spline', entity }
  if (path.kind === 'elliptical-arc' && entity.kind === 'elliptical-arc') return { kind: 'elliptical-arc', entity }
  throw new Error('Path pattern: path changed kind')
}

export function regeneratePathPattern(pattern: SketchPatternDefinition, entities: SketchEntity[]): SketchEntity[] {
  if (pattern.values.kind !== 'path') return entities
  const v = pattern.values, sources = pattern.sources.map(id => entities.find(e => e.id === id)!)
  if (sources.some(e => !e)) throw new Error('Path pattern: source was removed')
  const transform = pathPatternTransformAt(livePatternPath(v.path, entities), centroidOfEntities(sources), v.count, v.spacingMode, v.fixedSpacing, v.followTangent)
  return entities.map(entity => {
    const member = pattern.members.find(m => m.id === entity.id)
    return member ? transformEntity(sources.find(e => e.id === member.sourceId)!, transform(member.column), member.id) : entity
  })
}

/** Full dependent evaluation for solver-inert shapes, including local spline edits. */
export function regeneratePattern(pattern: SketchPatternDefinition, entities: SketchEntity[]): SketchEntity[] {
  if (pattern.values.kind === 'path') return regeneratePathPattern(pattern, entities)
  const index = new Map(entities.map(e => [e.id, e]))
  return entities.map(copy => {
    const member = pattern.members.find(m => m.id === copy.id)
    if (!member) return copy
    const source = index.get(member.sourceId)
    if (!source) throw new Error('Pattern source was removed')
    if (pattern.values.kind === 'mirror') {
      const result = mirrorEntities(entities, [source.id], pattern.values.axisId, () => copy.id)
      if (typeof result === 'string') throw new Error(result)
      return result.entities[0]
    }
    return patternCopy(source, patternAffine(pattern.values, member.column, member.row), member.id)
  })
}

export function patternMemberKey(column: number, row: number): string {
  return `${column},${row}`
}

export function patternAffine(values: PatternValues, column: number, row: number) {
  if (values.kind === 'mirror' || values.kind === 'path') throw new Error('This definition uses its live mirror axis or path.')
  if (values.kind === 'linear') return {
    a: 1, b: 0, c: 0, d: 1, angle: 0, scale: 1,
    tx: column * values.step.x + row * values.rowStep.x,
    ty: column * values.step.y + row * values.rowStep.y,
  }
  const angle = column * values.stepAngle
  const scale = values.kind === 'transform' ? values.scale : 1
  const a = scale * Math.cos(angle), b = -scale * Math.sin(angle), c = -b, d = a
  return { a, b, c, d, angle, scale,
    tx: values.center.x - a * values.center.x - b * values.center.y + (values.kind === 'transform' ? values.shift.x : 0),
    ty: values.center.y - c * values.center.x - d * values.center.y + (values.kind === 'transform' ? values.shift.y : 0) }
}

export function defineMirrorPattern(result: MirrorResult | string, axisId: string,
  newId: () => string = () => crypto.randomUUID()): PatternResult | string {
  if (typeof result === 'string') return result
  const entries = [...result.idMap]
  return { entities: result.entities, constraints: result.constraints, patterns: [{
    id: newId(), sources: entries.map(([source]) => source), values: { kind: 'mirror', count: 2, axisId },
    members: entries.map(([sourceId, id]) => ({ id, sourceId, column: 1, row: 0 })), suppressed: [],
    constraintIds: result.constraints.map(c => c.id),
  }] }
}

export function patternPoint(p: Vec2, t: ReturnType<typeof patternAffine>): Vec2 {
  return { x: t.a * p.x + t.b * p.y + t.tx, y: t.c * p.x + t.d * p.y + t.ty }
}

function patternCopy(source: SketchEntity, t: ReturnType<typeof patternAffine>, id: string): SketchEntity {
  const copy = transformEntity(source, { map: p => patternPoint(p, t), dTheta: t.angle }, id)
  if (t.scale === 1) return copy
  switch (copy.kind) {
    case 'circle': case 'arc': return { ...copy, radius: copy.radius * t.scale }
    case 'ellipse': case 'elliptical-arc': return { ...copy, majorRadius: copy.majorRadius * t.scale, minorRadius: copy.minorRadius * t.scale }
    case 'text': return { ...copy, height: copy.height * t.scale, letterSpacingMm: copy.letterSpacingMm === undefined ? undefined : copy.letterSpacingMm * t.scale }
    case 'block': return { ...copy, scale: copy.scale * t.scale }
    default: return copy
  }
}


export function definePattern(
  result: PatternResult | string, sources: readonly SketchEntity[], ids: readonly string[],
  values: PatternValues, newId: () => string = () => crypto.randomUUID(),
): PatternResult | string {
  if (typeof result === 'string') return result
  const invalid = validatePatternValues(values)
  if (invalid) return invalid
  const sourceIds = ids.filter(id => sources.some(e => e.id === id && !e.construction))
  const definition: SketchPatternDefinition = {
    id: newId(), sources: sourceIds, values, suppressed: [],
    members: result.entities.map((e, index) => ({ id: e.id,
      sourceId: sourceIds[index % sourceIds.length],
      column: 1 + Math.floor(index / sourceIds.length), row: 0 })),
  }
  // A dependent is already defined by the transform; repeating the source's
  // constraints on every instance would redundantly constrain the same shape.
  return { entities: result.entities, constraints: [], patterns: [definition] }
}

export function patternForSelection(sketch: Sketch, ids: readonly string[]) {
  return sketch.patterns?.find(p => p.members.some(m => ids.includes(m.id)) || p.sources.some(id => ids.includes(id)))
}

export function appendDefinedPattern(sketch: Sketch, result: PatternResult): SketchDocTransform {
  return { entities: [...sketch.entities, ...result.entities],
    constraints: [...sketch.constraints, ...result.constraints], dimensions: sketch.dimensions,
    patterns: [...(sketch.patterns ?? []), ...(result.patterns ?? [])] }
}

export function validatePatternValues(v: PatternValues): string | null {
  if (v.kind === 'mirror') return v.axisId ? null : 'Choose a mirror line.'
  if (!Number.isInteger(v.count) || v.count < 2) return 'Pattern count must be a whole number of at least 2.'
  if (v.kind === 'path') return Number.isFinite(v.fixedSpacing) && (v.spacingMode === 'equal' || v.fixedSpacing > 0) ? null : 'Path spacing must be positive and finite.'
  if (v.kind === 'transform') {
    return [v.center.x, v.center.y, v.stepAngle, v.scale, v.shift.x, v.shift.y].every(Number.isFinite) && v.scale > 0 ? null : 'Transform values must be finite and scale positive.'
  }
  if (v.kind === 'circular') {
    if (![v.center.x, v.center.y, v.stepAngle].every(Number.isFinite) || Math.abs(v.stepAngle) < 1e-9)
      return 'Pattern center and nonzero angle must be finite.'
  } else {
    if (!Number.isInteger(v.rows) || v.rows < 1) return 'Rows must be a positive whole number.'
    if (![v.step.x, v.step.y, v.rowStep.x, v.rowStep.y].every(Number.isFinite) || Math.hypot(v.step.x, v.step.y) < 1e-9)
      return 'Pattern spacing must be finite and nonzero.'
    if (v.rows > 1 && Math.hypot(v.rowStep.x, v.rowStep.y) < 1e-9) return 'Row spacing must be nonzero.'
  }
  return null
}

/** Removing a member also removes features whose sources no longer exist. */
function pruneDependents(result: SketchDocTransform): SketchDocTransform {
  let entities = result.entities, patterns = result.patterns ?? []
  let changed = true
  while (changed) {
    const live = new Set(entities.map(e => e.id))
    const orphanPatterns = patterns.filter(p => patternGoverningIds(p).some(id => !live.has(id)))
    const orphanIds = new Set(orphanPatterns.flatMap(p => p.members.map(m => m.id)))
    const next = entities.filter(e => !orphanIds.has(e.id) && !e.offsetLink?.source.some(ref => !live.has(ref.entityId)))
    changed = next.length !== entities.length || orphanPatterns.length > 0
    entities = next
    patterns = patterns.filter(p => !orphanPatterns.includes(p))
  }
  const live = new Set(entities.map(e => e.id))
  return { entities, patterns,
    constraints: result.constraints.filter(c => constraintRefIds(c).every(id => live.has(id))),
    dimensions: result.dimensions.filter(d => dimensionRefIds(d).every(id => live.has(id))) }
}

/** Regenerate once at the document boundary; preserve IDs of surviving instances. */
export function editPattern(
  sketch: Sketch, id: string, values: PatternValues,
  suppressed?: string[], newId: () => string = () => crypto.randomUUID(), expressions?: Record<string, string>,
): SketchDocTransform | string {
  const old = sketch.patterns?.find(p => p.id === id)
  if (!old) return 'Pattern definition was not found.'
  if (old.values.kind !== values.kind) return 'Choose values for the existing pattern type.'
  const invalid = validatePatternValues(values)
  if (invalid) return invalid
  const source = old.sources.map(s => sketch.entities.find(e => e.id === s))
  if (source.some(e => !e)) return 'Pattern source was removed.'
  const pattern: SketchPatternDefinition = { ...old, values, expressions,
    suppressed: suppressed ?? old.suppressed, members: [...old.members] }
  if (values.kind === 'mirror') {
    const result = mirrorEntities(sketch.entities, old.sources, values.axisId, newId)
    if (typeof result === 'string') return result
    const copies = new Map(result.entities.map(e => [e.id, e]))
    const remap = new Map([...result.idMap].map(([sourceId, copyId]) => [copyId, old.members.find(m => m.sourceId === sourceId)!.id]))
    const active = !pattern.suppressed.includes('1,0')
    const entities = sketch.entities.filter(e => !old.members.some(m => m.id === e.id))
    if (active) for (const [temporary, stable] of remap) entities.push({ ...copies.get(temporary)!, id: stable })
    const constraints = result.constraints.map(c => {
      if (c.kind === 'symmetric') return { ...c, b: { ...c.b, entityId: remap.get(c.b.entityId)! } }
      if (c.kind === 'equal') return { ...c, b: remap.get(c.b)! }
      return c
    })
    pattern.constraintIds = active ? constraints.map(c => c.id) : []
    const live = new Set(entities.map(e => e.id))
    return pruneDependents({ entities, constraints: [...sketch.constraints.filter(c => !old.constraintIds?.includes(c.id) && constraintRefIds(c).every(r => live.has(r))), ...(active ? constraints : [])],
      dimensions: sketch.dimensions.filter(d => dimensionRefIds(d).every(r => live.has(r))),
      patterns: sketch.patterns!.map(p => p.id === id ? pattern : p) })
  }
  const copies: SketchEntity[] = []
  const rows = values.kind === 'linear' ? values.rows : 1
  for (let row = 0; row < rows; row++) for (let column = 0; column < values.count; column++) {
    if (values.kind !== 'path' && row === 0 && column === 0) continue
    for (const entity of source as SketchEntity[]) {
      let member = pattern.members.find(m => m.sourceId === entity.id && m.column === column && m.row === row)
      if (!member) {
        member = { id: newId(), sourceId: entity.id, column, row }
        pattern.members.push(member)
      }
      if (pattern.suppressed.includes(patternMemberKey(column, row))) continue
      copies.push(values.kind === 'path' ? { ...entity, id: member.id } : patternCopy(entity, patternAffine(values, column, row), member.id))
    }
  }
  const oldIds = new Set(old.members.map(m => m.id))
  const entities = regeneratePathPattern(pattern, [...sketch.entities.filter(e => !oldIds.has(e.id)), ...copies])
  const live = new Set(entities.map(e => e.id))
  return pruneDependents({ entities,
    constraints: sketch.constraints.filter(c => constraintRefIds(c).every(ref => live.has(ref))),
    dimensions: sketch.dimensions.filter(d => dimensionRefIds(d).every(ref => live.has(ref))),
    patterns: sketch.patterns!.map(p => p.id === id ? pattern : p) })
}

export function breakPattern(sketch: Sketch, id: string): SketchDocTransform {
  const pattern = sketch.patterns?.find(p => p.id === id)
  return { entities: sketch.entities, constraints: sketch.constraints.filter(c => !pattern?.constraintIds?.includes(c.id)), dimensions: sketch.dimensions,
    patterns: sketch.patterns?.filter(p => p.id !== id) ?? [] }
}

