import type { Sketch, SketchConstraint } from '../types'
import type { DragRequest, SketchSolveOutcome } from './gcsMapping'
import { routeDependentDimension, routeDependentConstraint } from './dependentDimensionRouting'
import { constraintRefIds, dimensionRefIds } from '../refIds'
import { patternGoverningIds, regeneratePattern } from '../patterns'
import { recomputeOffsetLinks, withoutOffsetLink } from '../tools/offsetTool'

type Solve = (sketch: Sketch, drag?: DragRequest) => SketchSolveOutcome

/** Patterns and offsets are one-way dependent features. Source constraints solve
 * first; evaluated members form the boundary of the downstream solve. A failed
 * downstream solve never publishes a partial result or overwrites residuals. */
export function solveDependentFeatures(sketch: Sketch, drag: DragRequest | undefined, solve: Solve): SketchSolveOutcome {
  const patterns = sketch.patterns ?? []
  const offsets = [...new Set(sketch.entities.flatMap(e => e.offsetLink ? [e.offsetLink.id] : []))]
  const definitions = [
    ...patterns.map(pattern => ({ id: pattern.id, sources: patternGoverningIds(pattern),
      members: pattern.members.map(m => m.id), constraintIds: pattern.constraintIds ?? [],
      offset: false, evaluate: (entities: Sketch['entities']) => regeneratePattern(pattern, entities) })),
    ...offsets.map(id => {
      const copies = sketch.entities.filter(e => e.offsetLink?.id === id)
      return { id, sources: copies[0].offsetLink!.source.map(ref => ref.entityId), members: copies.map(e => e.id),
        constraintIds: copies[0].offsetLink!.constraintIds ?? [], offset: true, evaluate: (entities: Sketch['entities']) => {
          // Evaluate only this group; later groups depend on its published shape.
          const group = new Set(copies.map(e => e.id))
          const result = recomputeOffsetLinks(entities.map(e => e.offsetLink && !group.has(e.id) ? withoutOffsetLink(e) : e))
          if (result.notes.length > 0) throw new Error('Offset cannot follow this source edit at the stored distance. Edit offset or Break offset first.')
          const updated = new Map(result.entities.filter(e => group.has(e.id)).map(e => [e.id, e]))
          return entities.map(e => updated.get(e.id) ?? e)
        } }
    }),
  ]
  const routedDimensions = new Map(sketch.dimensions.filter(d => d.driving).flatMap(d => {
    const routed = routeDependentDimension(sketch, d)
    return routed ? [[d.id, routed] as const] : []
  }))
  const generatedRelations = new Set(definitions.flatMap(d => d.constraintIds))
  const routedConstraints = new Map(sketch.constraints.filter(c => !generatedRelations.has(c.id)).flatMap(c => {
    const routed = routeDependentConstraint(sketch, c)
    return routed ? [[c.id, routed] as const] : []
  }))
  const persistedId = (id: string) => id.replace(/^(?:__patternroute-)+/, '')
  // Keep the pinned entity's identity through GCS's ':site' owner mapping.
  // A failed boundary equation names that real entity, never an internal pin;
  // the genuine user relation and failure remain in the diagnostic set.
  const failureId = (id: string) => persistedId(id).replace(/^__patternbound-/, '')
  const failureText = (message: string) => message.replaceAll('__patternroute-', '').replaceAll('__patternbound-', '')
  const persistedFailure = (result: SketchSolveOutcome): SketchSolveOutcome => result.ok ? result : ({
    ...result, message: failureText(result.message), status: { ...result.status,
      conflicting: [...new Set(result.status.conflicting.map(failureId))],
      redundant: [...new Set(result.status.redundant.map(failureId))],
      ...(result.status.failureMessage ? { failureMessage: failureText(result.status.failureMessage) } : {}) } })
  const allMembers = new Set(definitions.flatMap(p => p.members))
  const fail = (message: string): SketchSolveOutcome => ({ ok: false, reason: 'invalid_sketch', message,
    status: { dof: sketch.solveStatus?.dof ?? 0, conflicting: [], redundant: [], solveFailed: true, failureMessage: message,
      fullyDefinedEntities: sketch.solveStatus?.fullyDefinedEntities } })
  const pattern = definitions.find(p => p.sources.every(id => !allMembers.has(id)))
  if (!pattern) return fail('Patterns contain a dependency cycle. Break a pattern to edit it independently.')
  const members = new Set(pattern.members)
  const upstream = new Set(pattern.sources)
  // A constraint involving a dependent belongs downstream. Ordinary connected
  // source geometry remains upstream, preserving all its driving relationships.
  const edges = [
    ...sketch.constraints.map(constraintRefIds), ...sketch.dimensions.map(dimensionRefIds),
    ...[...routedDimensions.values()].map(dimensionRefIds),
    ...[...routedConstraints.values()].map(constraintRefIds),

  ].filter(edge => !edge.some(id => allMembers.has(id)))
  let changed = true
  while (changed) {
    changed = false
    for (const edge of edges) if (edge.some(id => upstream.has(id))) for (const id of edge) {
      if (!upstream.has(id)) { upstream.add(id); changed = true }
    }
  }
  const refsUpstream = (refs: string[]) => refs.every(id => upstream.has(id))
  const sourceSketch: Sketch = { ...sketch,
    entities: sketch.entities.filter(e => upstream.has(e.id)),
    constraints: [...sketch.constraints.filter(c => refsUpstream(constraintRefIds(c))),
      ...[...routedConstraints.values()].filter(c => refsUpstream(constraintRefIds(c)))],
    dimensions: [...sketch.dimensions.filter(d => refsUpstream(dimensionRefIds(d))),
      ...[...routedDimensions.values()].filter(d => refsUpstream(dimensionRefIds(d)))],
    patterns: patterns.filter(p => p.id !== pattern.id && refsUpstream([...patternGoverningIds(p), ...p.members.map(m => m.id)])),
    solveStatus: null }
  const sourceTargets = drag?.targets.filter(t => upstream.has(t.point.entityId))
  const baseline = solve(sourceSketch)
  if (!baseline.ok) return persistedFailure(routedDimensions.size ? { ...baseline, message: `${baseline.message} The copy dimension also drives its source. Edit the source dimension or Break pattern.` } : baseline)
  // Temporary drag pins may consume freedoms in the numerical solve, but they
  // cannot change the document's DoF or authorize a driving back-edge.
  const sourceResult = sourceTargets?.length
    ? solve({ ...sourceSketch, entities: baseline.entities, solveStatus: baseline.status }, { targets: sourceTargets }) : baseline
  if (!sourceResult.ok) return persistedFailure(sourceResult)
  if (baseline.status.dof !== 0) {
    const affected = new Set(members)
    let expanded = true
    while (expanded) {
      expanded = false
      for (const definition of definitions) if (definition.sources.some(id => affected.has(id)))
        for (const id of definition.members) if (!affected.has(id)) { affected.add(id); expanded = true }
    }
    const owned = new Set(definitions.flatMap(d => d.constraintIds))
    const relation = sketch.constraints.find(c => !owned.has(c.id) && !routedConstraints.has(c.id) && constraintRefIds(c).some(id => affected.has(id))) ??
      sketch.dimensions.find(d => d.driving && !routedDimensions.has(d.id) && dimensionRefIds(d).some(id => affected.has(id)))
    if (relation) return fail(`The ${relation.kind} relation ${relation.id} has no exact route through this dependent definition while its source is free. Fully define the source, use a reference dimension, or Break pattern. The relation and definition are retained.`)
  }
  const solved = new Map(sourceResult.entities.map(e => [e.id, e]))
  let entities = sketch.entities.map(e => solved.get(e.id) ?? e)
  try { entities = pattern.evaluate(entities) }
  catch (error) { return fail(error instanceof Error ? error.message : String(error)) }
  const boundary = new Set([...upstream, ...members])
  // Fix is an internal phase boundary, not a persisted constraint. Existing
  // upstream constraints have already been solved and are not redundantly added.
  const pins: SketchConstraint[] = entities.filter(e => boundary.has(e.id)).map(e => ({
    id: `__patternbound-${e.id}`, kind: 'fix', entityId: e.id }))
  const downstream: Sketch = { ...sketch, entities: pattern.offset ? entities.map(e => members.has(e.id) ? withoutOffsetLink(e) : e) : entities,
    constraints: [...sketch.constraints.filter(c => !refsUpstream(constraintRefIds(c)) && !pattern.constraintIds.includes(c.id)), ...pins],
    dimensions: sketch.dimensions.filter(d => !refsUpstream(dimensionRefIds(d))),
    patterns: patterns.filter(p => p.id !== pattern.id && !refsUpstream([...patternGoverningIds(p), ...p.members.map(m => m.id)])),
    solveStatus: null }
  const downstreamTargets = drag?.targets.filter(t => !boundary.has(t.point.entityId))
  const result = solve(downstream, downstreamTargets?.length ? { ...drag!, targets: downstreamTargets } : undefined)
  if (!result.ok) return persistedFailure({ ...result, message: `${result.message} Copies are driven by their source and definition. Edit pattern or Break pattern before adding an incompatible driving constraint.` })
  const same = (a: unknown, b: unknown): boolean => {
    if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b))
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => same(v, b[i]))
    if (a && b && typeof a === 'object' && typeof b === 'object') return Object.keys(a).every(key => same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
    return a === b
  }
  for (const entity of entities) if (boundary.has(entity.id) && !same({ ...entity, offsetLink: undefined }, { ...result.entities.find(e => e.id === entity.id), offsetLink: undefined }))
    return fail('A driving constraint would change the pattern boundary. Edit pattern or Break pattern first.')
  if (pattern.offset) {
    const links = new Map(entities.filter(e => members.has(e.id)).map(e => [e.id, e.offsetLink]))
    result.entities = result.entities.map(e => members.has(e.id) ? { ...e, offsetLink: links.get(e.id) } : e)
  }
  result.status.dof = (sourceResult.status.dof ?? 0) + (result.status.dof ?? 0)
  // Boundary pins do not prove that upstream-driven members are fully defined.
  // Retain an unknown per-entity verdict when the upstream has freedoms.
  if (sourceResult.status.dof !== 0) result.status.fullyDefinedEntities = undefined
  // A routed dimension consumed source rank. Its apparent downstream
  // redundancy against our fixed boundary is artificial; the source verdict
  // is authoritative, including genuine redundancy against another source dim.
  result.status.redundant = [...new Set([
    ...sourceResult.status.redundant.map(persistedId),
    ...result.status.redundant.filter(id => !id.startsWith('__patternbound') && !routedDimensions.has(persistedId(id)) && !routedConstraints.has(persistedId(id))).map(persistedId),
  ])]

  return result
}
