// WO-1462 (BUG-392): an unanchored filleted sketch read dof 0 / "Fully
// defined" because the SKC-77 fillet-joint correction grounded each joint
// point, which on a floating body also removed its REAL translation freedom.
// The correction now swaps each joint's tangent for the equivalent
// radius-perpendicular-to-leg form (gcsMapping.ts
// filletJointDiagnosticPrimitives), which removes only the joint's own
// phantom DOF. Independent truth used below: planegcs's raw dof carries
// exactly 1 phantom per joint (SKC-77), so true dof = raw - joints, and the
// floating case is also proven by actually translating the whole sketch.

import { describe, it, expect, beforeAll } from 'vitest'
import { Algorithm } from '@salusoft89/planegcs'
import type { GcsWrapper } from '@salusoft89/planegcs'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import { solveSketchOnWrapper, sketchToGcsPrimitives } from '../../lib/sketch/solver/gcsMapping'
import { injectSketchAnchors } from '../../lib/sketch/sketchAnchors'
import { buildRectCommit } from '../../lib/sketch/tools/rectTools'
import { filletApplyAll, filletLines, filletSeedFromSelection } from '../../lib/sketch/tools/filletTool'
import type { SketchDoc } from '../../lib/sketch/tools/trimTool'
import type { Sketch, SketchDimension, SketchEntity, PointRef } from '../../lib/sketch/types'

function idFactory(prefix: string): () => string {
  let n = 0
  return () => `${prefix}${n++}`
}

/** 80x60 rectangle (tool rig + 2 driving dims), all 4 corners filleted R8.
 *  `anchor` adds a Fix on the rectangle's construction center point. */
function filletedRect(id: string, anchor: boolean): Sketch {
  const newId = idFactory('e')
  const commit = buildRectCommit({ x: -40, y: -30 }, { x: 40, y: 30 }, false, newId)
  const centerPoint = commit.entities.find((e) => e.kind === 'point' && e.construction)
  if (!centerPoint) throw new Error('expected the rectangle construction center point')
  const [l0, , l2] = commit.entities
  const dims: SketchDimension[] = [
    { id: newId(), kind: 'distanceX', driving: true, value: 80,
      a: { entityId: l0.id, site: 'start' }, b: { entityId: l2.id, site: 'start' },
      labelAnchor: { x: 0, y: 40 } },
    { id: newId(), kind: 'distanceY', driving: true, value: 60,
      a: { entityId: l0.id, site: 'start' }, b: { entityId: l2.id, site: 'start' },
      labelAnchor: { x: 50, y: 0 } },
  ]
  let sketch: Sketch = {
    id, layerId: 'layer', entities: commit.entities,
    constraints: [
      ...commit.constraints,
      ...(anchor ? [{ id: newId(), kind: 'fix' as const, point: { entityId: centerPoint.id, site: 'self' as const } }] : []),
    ],
    dimensions: dims, solveStatus: null,
  }
  const lineIds = commit.entities.filter((e) => e.kind === 'line' && !e.construction).map((e) => e.id)
  for (let step = 1; step <= 4; step++) {
    const corners = filletSeedFromSelection(sketch.entities, [lineIds[step - 1], lineIds[step % 4]])
    const result = filletApplyAll(sketch, corners, 8, idFactory(`f${step}_`))
    if (!result.transform) throw new Error(`fillet ${step} was not applied`)
    sketch = { ...sketch, ...result.transform, solveStatus: null }
  }
  return sketch
}

function translate(e: SketchEntity, dx: number, dy: number): SketchEntity {
  const mv = (p: { x: number; y: number }) => ({ x: p.x + dx, y: p.y + dy })
  switch (e.kind) {
    case 'line': return { ...e, start: mv(e.start), end: mv(e.end) }
    case 'arc': return { ...e, center: mv(e.center) }
    case 'circle': return { ...e, center: mv(e.center) }
    case 'point': return { ...e, at: mv(e.at) }
    default: throw new Error(`translate: unexpected entity kind ${e.kind}`)
  }
}

/** planegcs's own dof for the solved sketch, with no correction. */
function rawDof(wrapper: GcsWrapper, solved: Sketch): number {
  wrapper.clear_data()
  wrapper.push_primitives_and_params(sketchToGcsPrimitives(solved))
  wrapper.solve(Algorithm.DogLeg)
  return wrapper.gcs.dof()
}

/** Fillet joints in the sketch: tangent arc<->line pairs whose endpoints are
 *  also coincident (the SKC-77 shape, counted here independently). */
function jointCount(sketch: Sketch): number {
  const kind = new Map(sketch.entities.map((e) => [e.id, e.kind]))
  const joined = new Set<string>()
  for (const c of sketch.constraints) {
    if (c.kind !== 'coincident') continue
    joined.add(`${c.a.entityId}|${c.b.entityId}`)
    joined.add(`${c.b.entityId}|${c.a.entityId}`)
  }
  return sketch.constraints.filter((c) => c.kind === 'tangent'
    && ((kind.get(c.a) === 'arc' && kind.get(c.b) === 'line') || (kind.get(c.a) === 'line' && kind.get(c.b) === 'arc'))
    && joined.has(`${c.a}|${c.b}`)).length
}

describe('WO-1462: the fillet-joint DOF correction never eats real freedom', () => {
  let wrapper: GcsWrapper
  beforeAll(async () => {
    wrapper = await createGcsWrapper()
  })

  it('an unanchored filleted rectangle keeps its 2 translation DOF and nothing reads fully defined', () => {
    const sketch = filletedRect('wo1462-floating', false)
    const out = solveSketchOnWrapper(wrapper, sketch)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const solved = { ...sketch, entities: out.entities }
    expect(jointCount(sketch)).toBe(8)
    expect(out.status.dof).toBe(rawDof(wrapper, solved) - 8)
    expect(out.status.dof).toBe(2)
    expect(out.status.fullyDefinedEntities ?? []).toEqual([])

    // The freedom is real: shift the whole sketch and it stays where it was put.
    const shifted = { ...solved, entities: solved.entities.map((e) => translate(e, 17, -9)) }
    const moved = solveSketchOnWrapper(wrapper, shifted)
    expect(moved.ok).toBe(true)
    if (!moved.ok) return
    const before = solved.entities.find((e) => e.kind === 'line')
    const after = moved.entities.find((e) => e.id === before?.id)
    if (before?.kind !== 'line' || after?.kind !== 'line') throw new Error('expected a line')
    expect(after.start.x).toBeCloseTo(before.start.x + 17, 6)
    expect(after.start.y).toBeCloseTo(before.start.y - 9, 6)
  })

  it('BUG-392 repro: editing a fillet radius to 30mm on the unanchored sketch still reports DOF', () => {
    const sketch = filletedRect('wo1462-radius30', false)
    const first = solveSketchOnWrapper(wrapper, sketch)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const radiusDim = sketch.dimensions.find((d) => d.kind === 'radius')
    if (!radiusDim) throw new Error('expected a driving radius dimension from the fillet tool')
    const edited: Sketch = {
      ...sketch, entities: first.entities,
      dimensions: sketch.dimensions.map((d) => (d.id === radiusDim.id ? { ...d, value: 30 } : d)),
    }
    const out = solveSketchOnWrapper(wrapper, edited)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    // Still a floating body with square corners: exactly its 2 translations.
    // (planegcs's raw phantom is numerically fragile off the as-drawn radius --
    // raw reads 2, not 10, here -- so only the geometric truth is pinned.)
    expect(out.status.dof).toBe(2)
    expect(out.status.fullyDefinedEntities ?? []).toEqual([])
  })

  it('SKC-77 still holds: the anchored filleted rectangle reads dof 0 with every entity defined', () => {
    for (const [label, sketch] of [
      ['center fix', filletedRect('wo1462-anchored-fix', true)],
      ['sketch anchors', injectSketchAnchors(filletedRect('wo1462-anchored-origin', true), { x: 0, y: 0 })],
    ] as const) {
      const out = solveSketchOnWrapper(wrapper, sketch)
      expect(out.ok, label).toBe(true)
      if (!out.ok) continue
      expect(out.status.dof, label).toBe(0)
      const defined = new Set(out.status.fullyDefinedEntities ?? [])
      for (const e of sketch.entities) expect(defined.has(e.id), `${label}: ${e.id} (${e.kind})`).toBe(true)
    }
  })

  it('a partly anchored fillet (one point fixed, the rest floating) reports its intermediate DOF', () => {
    const ref = (e: string, s: PointRef['site']): PointRef => ({ entityId: e, site: s })
    const base: Sketch = {
      id: 'wo1462-partial', layerId: 'layer',
      entities: [
        { id: 'A', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
        { id: 'B', kind: 'line', construction: false, start: { x: 10, y: 0 }, end: { x: 10, y: 10 } },
      ],
      constraints: [
        { id: 'cc', kind: 'coincident', a: ref('A', 'end'), b: ref('B', 'start') },
        { id: 'hA', kind: 'horizontal', line: 'A' },
        { id: 'vB', kind: 'vertical', line: 'B' },
        { id: 'fA', kind: 'fix', point: ref('A', 'start') },
      ],
      dimensions: [], solveStatus: null,
    }
    let n = 0
    const r = filletLines(base as unknown as SketchDoc, 'A', 'B', { x: 0, y: 0 }, { x: 10, y: 10 }, 2, () => `f${n++}`)
    if (typeof r === 'string') throw new Error(r)
    const sketch: Sketch = { ...base, ...r.transform, solveStatus: null }
    const out = solveSketchOnWrapper(wrapper, sketch)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    // A.start is fixed; B's x position and B's far end stay free: 2 DOF.
    expect(jointCount(sketch)).toBe(2)
    expect(out.status.dof).toBe(rawDof(wrapper, { ...sketch, entities: out.entities }) - 2)
    expect(out.status.dof).toBe(2)
    const defined = new Set(out.status.fullyDefinedEntities ?? [])
    for (const e of sketch.entities) {
      if (e.kind === 'line' || e.kind === 'arc') expect(defined.has(e.id), `${e.id} (${e.kind})`).toBe(false)
    }
  })
})
