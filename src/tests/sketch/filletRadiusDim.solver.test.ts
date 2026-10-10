// Fillet radius dimension is EDITABLE (the bug Operator reported: editing a
// fillet's radius "throws errors"). Root cause: planegcs runs its
// conflict diagnosis on the Jacobian at the INITIAL geometry, and a
// fillet's tangent + coincident topology is benignly redundant, so a
// radius edit (geometry at the old radius, dim demanding a new one) was
// MISREPORTED as a hard conflict even though the solve converges to
// correct geometry. solveSketchOnWrapper now re-diagnoses at the solved
// geometry and clears the false positive (a TRUE conflict does not
// converge and stays flagged). Regression: a plain circle radius edit
// (no redundancy) is unaffected.

import { describe, it, expect } from 'vitest'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import { solveSketchOnWrapper } from '../../lib/sketch/solver/gcsMapping'
import { filletLines, filletApplyAll, filletSeedFromSelection } from '../../lib/sketch/tools/filletTool'
import { ellipseDerivativeAt, ellipseParamFromPoint } from '../../lib/sketch/ellipse'
import { chamferApplyAll, chamferSeedFromSelection } from '../../lib/sketch/tools/chamferTool'
import type { SketchDoc } from '../../lib/sketch/tools/trimTool'
import type {
  Sketch, SketchEntity, SketchConstraint, SketchDimension, SketchArcEntity, PointRef,
} from '../../lib/sketch/types'
import type { GcsWrapper } from '@salusoft89/planegcs'

let wrapperP: Promise<GcsWrapper> | null = null
const getWrapper = () => (wrapperP ??= createGcsWrapper())

function line(id: string, x1: number, y1: number, x2: number, y2: number): SketchEntity {
  return { id, kind: 'line', construction: false, start: { x: x1, y: y1 }, end: { x: x2, y: y2 } }
}
function ref(e: string, s: PointRef['site']): PointRef { return { entityId: e, site: s } }

// Fully defined right-angle corner: A horizontal (start fixed), B vertical
// (end fixed), joined at the corner — the realistic rectangle-corner case.
function definedCorner(): Sketch {
  return {
    id: 'sk', layerId: 'layer',
    entities: [line('A', 0, 0, 10, 0), line('B', 10, 0, 10, 10)],
    constraints: [
      { id: 'cc', kind: 'coincident', a: ref('A', 'end'), b: ref('B', 'start') },
      { id: 'hA', kind: 'horizontal', line: 'A' },
      { id: 'vB', kind: 'vertical', line: 'B' },
      { id: 'fA', kind: 'fix', point: ref('A', 'start') },
      { id: 'fB', kind: 'fix', point: ref('B', 'end') },
    ],
    dimensions: [], solveStatus: null,
  }
}

function apply(sk: Sketch, t: { entities: SketchEntity[]; constraints: SketchConstraint[]; dimensions: SketchDimension[] }): Sketch {
  return { ...sk, entities: t.entities, constraints: t.constraints, dimensions: t.dimensions, solveStatus: null }
}

describe('fillet radius dimension is editable (false-positive conflict fix)', () => {
  it('create -> NO conflict and the arc sits at the dim radius', async () => {
    const wrapper = await getWrapper()
    let n = 0
    const base = definedCorner()
    const r = filletLines(base as unknown as SketchDoc, 'A', 'B',
      { x: 0, y: 0 }, { x: 10, y: 10 }, 2, () => `f${n++}`)
    if (typeof r === 'string') throw new Error(r)
    const sk = apply(base, r.transform)
    const created = solveSketchOnWrapper(wrapper, sk)
    expect(created.ok).toBe(true)
    if (!created.ok) return
    // The driving radius dim was accepted with NO hard conflict (Operator's
    // "throws errors" path). planegcs's tangent_la + endpoint coincident
    // topology is one constraint past minimal, so planegcs flags the two
    // tangents as REDUNDANT (advisory); C5 now SUPPRESSES that benign
    // by-construction advisory so the banner is not spammed — the reported
    // redundant set is empty. (dof is still inflated by 2 at the as-built
    // geometry; that display fork is unchanged.)
    expect(created.status.conflicting).toEqual([])
    expect(created.status.redundant).toEqual([])
    const arc = created.entities.find(
      (e): e is SketchArcEntity => e.id === r.arcId && e.kind === 'arc')!
    expect(arc.radius).toBeCloseTo(2, 6)
  })

  it('editing the radius dim re-solves WITHOUT errors and resizes the arc', async () => {
    const wrapper = await getWrapper()
    let n = 0
    const base = definedCorner()
    const r = filletLines(base as unknown as SketchDoc, 'A', 'B',
      { x: 0, y: 0 }, { x: 10, y: 10 }, 2, () => `f${n++}`)
    if (typeof r === 'string') throw new Error(r)
    const sk = apply(base, r.transform)
    const created = solveSketchOnWrapper(wrapper, sk)
    expect(created.ok).toBe(true)

    // Edit the driving radius dim 2 -> 3 (geometry still at radius 2).
    const edited: Sketch = {
      ...sk,
      dimensions: sk.dimensions.map((d) => d.id === r.radiusDimId ? { ...d, value: 3 } : d),
      solveStatus: created.ok ? created.status : null,
    }
    const out = solveSketchOnWrapper(wrapper, edited)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.status.conflicting).toEqual([])
    expect(out.status.dof).toBe(0)
    const arc = out.entities.find((e): e is SketchArcEntity => e.id === r.arcId && e.kind === 'arc')!
    expect(arc.radius).toBeCloseTo(3, 6)
    // 90 deg corner, R3: center at (7,3).
    expect(arc.center.x).toBeCloseTo(7, 6)
    expect(arc.center.y).toBeCloseTo(3, 6)
  })

  it('batch fillet: editing the lead dim resizes EVERY linked arc equally', async () => {
    const wrapper = await getWrapper()
    let n = 0
    // Open rectangle: l1 bottom, l2 right, l3 top — two corners. Far ends
    // pinned so the figure is determinate enough to read radii.
    const sk0: Sketch = {
      id: 'sk', layerId: 'layer',
      entities: [line('l1', 0, 0, 20, 0), line('l2', 20, 0, 20, 20), line('l3', 20, 20, 0, 20)],
      constraints: [
        { id: 'c12', kind: 'coincident', a: ref('l1', 'end'), b: ref('l2', 'start') },
        { id: 'c23', kind: 'coincident', a: ref('l2', 'end'), b: ref('l3', 'start') },
        { id: 'h1', kind: 'horizontal', line: 'l1' },
        { id: 'v2', kind: 'vertical', line: 'l2' },
        { id: 'h3', kind: 'horizontal', line: 'l3' },
        { id: 'f1', kind: 'fix', point: ref('l1', 'start') },
        { id: 'f3', kind: 'fix', point: ref('l3', 'end') },
      ],
      dimensions: [], solveStatus: null,
    }
    const corners = filletSeedFromSelection(sk0.entities, ['l1', 'l2', 'l3'])
    const res = filletApplyAll(sk0 as unknown as SketchDoc, corners, 2, () => `f${n++}`)
    expect(res.applied).toBe(2)
    const sk = apply(sk0, res.transform!)
    const leadDim = sk.dimensions.find((d) => d.kind === 'radius')!
    const arcIds = sk.entities.filter((e) => e.kind === 'arc').map((e) => e.id)

    const created = solveSketchOnWrapper(wrapper, sk)
    expect(created.ok).toBe(true)

    // Edit the single lead radius dim 2 -> 1.5; both arcs follow via equal.
    const edited: Sketch = {
      ...sk,
      dimensions: sk.dimensions.map((d) => d.id === leadDim.id ? { ...d, value: 1.5 } : d),
      solveStatus: created.ok ? created.status : null,
    }
    const out = solveSketchOnWrapper(wrapper, edited)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.status.conflicting).toEqual([])
    for (const id of arcIds) {
      const a = out.entities.find((e): e is SketchArcEntity => e.id === id && e.kind === 'arc')!
      expect(a.radius).toBeCloseTo(1.5, 6)
    }
  })

  it('REGRESSION: a TRUE conflict still fails loud (does not get cleared)', async () => {
    const wrapper = await getWrapper()
    // Horizontal line, start fixed, with TWO contradictory length dims.
    const sk: Sketch = {
      id: 'sk', layerId: 'layer',
      entities: [line('l1', 0, 0, 10, 0)],
      constraints: [
        { id: 'h', kind: 'horizontal', line: 'l1' },
        { id: 'f', kind: 'fix', point: ref('l1', 'start') },
      ],
      dimensions: [
        { id: 'dA', kind: 'distance', driving: true, value: 10, a: ref('l1', 'start'), b: ref('l1', 'end') },
        { id: 'dB', kind: 'distance', driving: true, value: 25, a: ref('l1', 'start'), b: ref('l1', 'end') },
      ],
      solveStatus: null,
    }
    const out = solveSketchOnWrapper(wrapper, sk)
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe('conflicting')
    expect(out.status.conflicting.length).toBeGreaterThan(0)
  })

  // ---- T10: a fillet radius edit must NOT move the rest of the sketch ----
  //
  // Operator's bug: making a box-corner fillet bigger grew the whole box. Root
  // cause: the radius-edit re-solve path (false-positive-conflict cleared)
  // SKIPPED the B23 free-DoF parking pass, so the box's other (free) corners
  // were no longer pinned and DogLeg pushed them out to accommodate the larger
  // fillet. The parking pass now runs on that path too (pinning the OTHER free
  // geometry at its as-drawn spot), while the edited fillet still resizes
  // because its driving radius dim is HARD and the pins are SOFT.

  /** Bounding box of all line endpoints + arc centers. */
  function bbox(entities: SketchEntity[]) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const e of entities) {
      const pts = e.kind === 'line' ? [e.start, e.end] : e.kind === 'arc' ? [e.center] : []
      for (const p of pts) {
        minX = Math.min(minX, p.x); minY = Math.min(minY, p.y)
        maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y)
      }
    }
    return { minX, minY, maxX, maxY }
  }

  // Under-constrained box: H/V + one fixed corner, but NO width/height dims,
  // so the far corners are FREE DoF (this is the scenario where skipping the
  // parking pass let them drift). 20 x 20, bottom-left fixed at the origin.
  function underConstrainedBox(W = 20, H = 20): Sketch {
    return {
      id: 'sk', layerId: 'layer',
      entities: [
        line('lb', 0, 0, W, 0), line('lr', W, 0, W, H),
        line('lt', W, H, 0, H), line('ll', 0, H, 0, 0),
      ],
      constraints: [
        { id: 'cbr', kind: 'coincident', a: ref('lb', 'end'), b: ref('lr', 'start') },
        { id: 'crt', kind: 'coincident', a: ref('lr', 'end'), b: ref('lt', 'start') },
        { id: 'ctl', kind: 'coincident', a: ref('lt', 'end'), b: ref('ll', 'start') },
        { id: 'clb', kind: 'coincident', a: ref('ll', 'end'), b: ref('lb', 'start') },
        { id: 'hb', kind: 'horizontal', line: 'lb' },
        { id: 'ht', kind: 'horizontal', line: 'lt' },
        { id: 'vr', kind: 'vertical', line: 'lr' },
        { id: 'vl', kind: 'vertical', line: 'll' },
        { id: 'fO', kind: 'fix', point: ref('lb', 'start') },
      ],
      dimensions: [], solveStatus: null,
    }
  }

  it('T10: editing a fillet radius does NOT push out the box free corners', async () => {
    const wrapper = await getWrapper()
    let n = 0
    const base = underConstrainedBox(20, 20)
    // Fillet the bottom-right corner (lb/lr meet at (20,0)).
    const r = filletLines(base as unknown as SketchDoc, 'lb', 'lr',
      { x: 0, y: 0 }, { x: 20, y: 20 }, 2, () => `f${n++}`)
    if (typeof r === 'string') throw new Error(r)
    const sk = apply(base, r.transform)
    const created = solveSketchOnWrapper(wrapper, sk)
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const bb0 = bbox(created.entities)
    // The box is drawn 20 x 20 and must stay so through the radius edit.
    expect(bb0.maxX).toBeCloseTo(20, 4)
    expect(bb0.maxY).toBeCloseTo(20, 4)

    // Edit the fillet radius 2 -> 5.
    const edited: Sketch = {
      ...sk,
      dimensions: sk.dimensions.map((d) => d.id === r.radiusDimId ? { ...d, value: 5 } : d),
      solveStatus: created.status,
    }
    const out = solveSketchOnWrapper(wrapper, edited)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const bb1 = bbox(out.entities)
    // The box must NOT have grown: extents unchanged within tight tolerance.
    expect(bb1.maxX).toBeCloseTo(bb0.maxX, 4)
    expect(bb1.maxY).toBeCloseTo(bb0.maxY, 4)
    expect(bb1.minX).toBeCloseTo(bb0.minX, 4)
    expect(bb1.minY).toBeCloseTo(bb0.minY, 4)
    // ...and the fillet itself DID resize to the new radius.
    const arc = out.entities.find((e): e is SketchArcEntity => e.id === r.arcId && e.kind === 'arc')!
    expect(arc.radius).toBeCloseTo(5, 4)
  })

  // ---- C5: benign fillet/chamfer redundancy advisories are suppressed ----
  it('C5: multi-fillet does NOT raise spurious redundant/conflicting advisories', async () => {
    const wrapper = await getWrapper()
    let n = 0
    const base = underConstrainedBox(20, 20)
    // Fillet all four corners at once (the multi-fillet spam scenario).
    const corners = filletSeedFromSelection(base.entities, ['lb', 'lr', 'lt', 'll'])
    expect(corners).toHaveLength(4)
    const res = filletApplyAll(base as unknown as SketchDoc, corners, 2, () => `f${n++}`)
    expect(res.applied).toBe(4)
    const sk = apply(base, res.transform!)
    const created = solveSketchOnWrapper(wrapper, sk)
    expect(created.ok).toBe(true)
    if (!created.ok) return
    // Eight fillet tangents (two per corner) would otherwise spam the
    // advisory banner; all are benign-by-construction and suppressed.
    expect(created.status.redundant).toEqual([])
    expect(created.status.conflicting).toEqual([])
  })

  it('C5: a multi-chamfer batch solves with no spurious advisories', async () => {
    const wrapper = await getWrapper()
    let n = 0
    const base = underConstrainedBox(20, 20)
    const corners = chamferSeedFromSelection(base.entities, ['lb', 'lr', 'lt', 'll'])
    expect(corners).toHaveLength(4)
    const res = chamferApplyAll(base as unknown as SketchDoc, corners, 2, () => `c${n++}`)
    expect(res.applied).toBe(4)
    const sk = apply(base, res.transform!)
    const out = solveSketchOnWrapper(wrapper, sk)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.status.conflicting).toEqual([])
    expect(out.status.redundant).toEqual([])
  })

  it('REGRESSION: plain circle radius edit solves cleanly (no false-positive path)', async () => {
    const wrapper = await getWrapper()
    const sk: Sketch = {
      id: 'sk', layerId: 'layer',
      entities: [{ id: 'c1', kind: 'circle', construction: false, center: { x: 0, y: 0 }, radius: 5 }],
      constraints: [{ id: 'fc', kind: 'fix', point: ref('c1', 'center') }],
      dimensions: [{ id: 'dr', kind: 'radius', driving: true, value: 5, entityId: 'c1' }],
      solveStatus: null,
    }
    const created = solveSketchOnWrapper(wrapper, sk)
    expect(created.ok).toBe(true)
    expect(created.status.dof).toBe(0)

    const edited: Sketch = {
      ...sk,
      dimensions: [{ id: 'dr', kind: 'radius', driving: true, value: 8, entityId: 'c1' }],
      solveStatus: created.ok ? created.status : null,
    }
    const out = solveSketchOnWrapper(wrapper, edited)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.status.conflicting).toEqual([])
    const circle = out.entities.find((e) => e.id === 'c1')!
    expect(circle.kind === 'circle' && circle.radius).toBeCloseTo(8, 6)
  })

  it('WO-206: editing a line/arc fillet radius preserves both solved joints', async () => {
    const wrapper = await getWrapper()
    const base: Sketch = {
      id: 'sk', layerId: 'layer',
      entities: [
        line('line', -10, 0, 0, 0),
        {
          id: 'hostArc', kind: 'arc', construction: false,
          center: { x: -5, y: 0 }, radius: 5,
          startAngle: 0, endAngle: Math.PI / 2,
        },
      ],
      constraints: [
        { id: 'corner', kind: 'coincident', a: ref('line', 'end'), b: ref('hostArc', 'start') },
        { id: 'horizontal', kind: 'horizontal', line: 'line' },
        { id: 'line-start', kind: 'fix', point: ref('line', 'start') },
        { id: 'arc-center', kind: 'fix', point: ref('hostArc', 'center') },
        { id: 'arc-end', kind: 'fix', point: ref('hostArc', 'end') },
      ],
      dimensions: [{
        id: 'host-radius', kind: 'radius', driving: true, value: 5, entityId: 'hostArc',
      }],
      solveStatus: null,
    }
    let n = 0
    const made = filletLines(
      base as unknown as SketchDoc,
      'line', 'hostArc', { x: -8, y: 0 }, { x: -5, y: 5 }, 1,
      () => `curve-fillet-${n++}`,
    )
    if (typeof made === 'string') throw new Error(made)
    const created = solveSketchOnWrapper(wrapper, apply(base, made.transform))
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const edited = apply(base, {
      entities: created.entities,
      constraints: made.transform.constraints,
      dimensions: made.transform.dimensions.map((dimension) =>
        dimension.id === made.radiusDimId ? { ...dimension, value: 1.5 } : dimension),
    })
    edited.solveStatus = created.status
    const solved = solveSketchOnWrapper(wrapper, edited)
    expect(solved.ok).toBe(true)
    if (!solved.ok) return
    const fillet = solved.entities.find((entity) => entity.id === made.arcId)
    expect(fillet?.kind).toBe('arc')
    if (!fillet || fillet.kind !== 'arc') return
    expect(fillet.radius).toBeCloseTo(1.5, 6)

    const pointAt = (point: PointRef): { x: number; y: number } => {
      const entity = solved.entities.find((candidate) => candidate.id === point.entityId)!
      if (entity.kind === 'line' && (point.site === 'start' || point.site === 'end')) {
        return entity[point.site]
      }
      if (entity.kind === 'arc' && (point.site === 'start' || point.site === 'end')) {
        const angle = point.site === 'start' ? entity.startAngle : entity.endAngle
        return {
          x: entity.center.x + entity.radius * Math.cos(angle),
          y: entity.center.y + entity.radius * Math.sin(angle),
        }
      }
      throw new Error(`unsupported point ${point.entityId}/${point.site}`)
    }
    const joints = made.transform.constraints.filter((constraint) =>
      constraint.kind === 'coincident' &&
      (constraint.a.entityId === made.arcId || constraint.b.entityId === made.arcId))
    expect(joints).toHaveLength(2)
    for (const joint of joints) {
      if (joint.kind !== 'coincident') continue
      const a = pointAt(joint.a), b = pointAt(joint.b)
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(1e-6)
    }
    expect(made.transform.constraints.filter((constraint) =>
      constraint.kind === 'tangent' &&
      (constraint.a === made.arcId || constraint.b === made.arcId))).toHaveLength(2)
  })
})

describe('WO-207 native-curve fillet solve retention', () => {
  it('keeps a line/ellipse fillet tangent after its driving radius changes', async () => {
    const base: Sketch = {
      id: 'native-fillet', layerId: 'layer', solveStatus: null,
      entities: [
        line('line', 0, 5, 0, 15),
        { id: 'ellipse', kind: 'ellipse', construction: false, center: { x: 0, y: 0 },
          majorRadius: 10, minorRadius: 5, rotation: 0 },
      ], constraints: [], dimensions: [],
    }
    let id = 0
    const made = filletLines(base, 'line', 'ellipse', { x: 0, y: 10 }, { x: 6, y: 4 }, 1, () => `native-${id++}`)
    expect(made).not.toBeTypeOf('string')
    if (typeof made === 'string') return
    const edited: Sketch = {
      ...base,
      ...made.transform,
      dimensions: made.transform.dimensions.map((d) => d.id === made.radiusDimId ? { ...d, value: 1.5 } : d),
    }
    const out = solveSketchOnWrapper(await getWrapper(), edited)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const fillet = out.entities.find((e) => e.id === made.arcId)
    const ellipse = out.entities.find((e) => e.id === 'ellipse')
    expect(fillet?.kind).toBe('arc')
    expect(ellipse?.kind).toBe('elliptical-arc')
    if (fillet?.kind !== 'arc' || ellipse?.kind !== 'elliptical-arc') return
    expect(fillet.radius).toBeCloseTo(1.5, 5)
    const joint = fillet.curveFillet?.arcAAtStart ? fillet.endAngle : fillet.startAngle
    const p = { x: fillet.center.x + fillet.radius * Math.cos(joint),
      y: fillet.center.y + fillet.radius * Math.sin(joint) }
    const d = ellipseDerivativeAt(ellipse, ellipseParamFromPoint(ellipse, p))
    const radial = { x: p.x - fillet.center.x, y: p.y - fillet.center.y }
    expect(Math.abs(d.x * radial.x + d.y * radial.y)).toBeLessThan(1e-4)
  })
})
