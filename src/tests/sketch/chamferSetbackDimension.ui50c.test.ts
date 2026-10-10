// Chamfer d1xd2 setback-pair dimension (UI-50C, split from UI-50B by
// preflight): measures BOTH setback distances from the theoretical
// (untrimmed) corner to the chamfer line's own two endpoints. WO-1858 made
// the kind DRIVABLE -- the DRIVING half of its behaviour is proved in
// chamferSetbackDriving.wo1858.test.ts; this file keeps the measurement,
// refusal, derived-consumer and renderer coverage. Mirrors
// arcLengthDimension.ui50b.test.ts's structure (measurement, solver
// contract, derived consumers, renderer) plus the preflight's mandatory
// asymmetry can-fail fixture and named-refuse paths.

import { describe, it, expect } from 'vitest'
import {
  DIMENSION_KINDS,
  TwoValueDimensionKindError,
  UnknownSketchDimensionKindError,
  dimForceFamily,
  dimToolClick,
  formatChamferSetbackValue,
  formatDimensionValue,
  measureDimension,
  planDimension,
  remeasureReferenceDimensions,
} from '../../lib/sketch/tools/dimTool'
import { resolveDimPlacement, dimGuides } from '../../lib/sketch/tools/dimPlacement'
import {
  resolveChamferCorner, measureChamferSetbacks,
} from '../../lib/sketch/tools/theoreticalCorner'
import { chamferLines } from '../../lib/sketch/tools/chamferTool'
import type { SketchDoc } from '../../lib/sketch/tools/trimTool'
import {
  sketchToGcsPrimitives, solveSketchOnWrapper,
} from '../../lib/sketch/solver/gcsMapping'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import { dimensionRefIds } from '../../lib/sketch/refIds'
import { deleteFromSketch } from '../../lib/sketch/deleteSelection'
import { buildBrowserModel } from '../../lib/sketch/browserModel'
import { dimensionDisplay } from '../../lib/sketch/sketcher/sketchLayer'
import type {
  Sketch, SketchConstraint, SketchDimension, SketchDimensionKind, SketchEntity, SketchLineEntity,
} from '../../lib/sketch/types'
import { armTool, toolClick, IDLE_TOOL_STATE } from '../../lib/sketch/tools/toolMachine'

let n = 0
const newId = () => `ui50c-${n++}`

/** 90-deg corner at (10,0): A runs (0,0)->(10,0), B runs (10,0)->(10,10)
 *  (chamferTool.test.ts's own fixture). Setback 3 on BOTH legs. */
function buildCornerFixture(setback = 3) {
  const doc: SketchDoc = {
    entities: [
      { id: 'A', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
      { id: 'B', kind: 'line', construction: false, start: { x: 10, y: 0 }, end: { x: 10, y: 10 } },
    ],
    constraints: [
      { id: 'c-corner', kind: 'coincident',
        a: { entityId: 'A', site: 'end' }, b: { entityId: 'B', site: 'start' } },
    ],
    dimensions: [],
  }
  const r = chamferLines(doc, 'A', 'B', { x: 0, y: 0 }, { x: 10, y: 10 }, setback, newId)
  if (typeof r === 'string') throw new Error(r)
  return r
}

function sketch(entities: SketchEntity[], constraints: Sketch['constraints'],
  dimensions: SketchDimension[]): Sketch {
  return { id: 'ui-50c', layerId: 'layer', entities, constraints, dimensions, solveStatus: null }
}

describe('UI-50C d1xd2 corner resolution and measurement', () => {
  it('resolves the theoretical corner and measures both (initially equal) setbacks', () => {
    const r = buildCornerFixture(3)
    const resolved = resolveChamferCorner(r.transform.entities, r.transform.constraints, r.lineId)
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.corner.phantom.x).toBeCloseTo(10, 9)
    expect(resolved.corner.phantom.y).toBeCloseTo(0, 9)

    const m = measureChamferSetbacks(r.transform.entities, r.transform.constraints, r.lineId)
    expect(m).not.toBeNull()
    expect(m!.d1).toBeCloseTo(3, 9) // phantom -> chamfer line START (coincident with A/end)
    expect(m!.d2).toBeCloseTo(3, 9) // phantom -> chamfer line END (coincident with B/start)
  })

  it('measures null (missing-entity convention) for a non-line entityId', () => {
    const r = buildCornerFixture(3)
    expect(measureChamferSetbacks(r.transform.entities, r.transform.constraints, 'A')).toBeNull()
    expect(measureChamferSetbacks(r.transform.entities, r.transform.constraints, 'nope')).toBeNull()
  })
})

describe('UI-50C named REFUSE paths (never a virtual intersection)', () => {
  it('refuses no-theoretical-corner for a hand-drawn line with no phantom rig', () => {
    const bare: SketchEntity[] = [
      { id: 'freehand', kind: 'line', construction: false,
        start: { x: 0, y: 0 }, end: { x: 5, y: 5 } },
    ]
    const resolved = resolveChamferCorner(bare, [], 'freehand')
    expect(resolved).toEqual({ ok: false, reason: 'no-theoretical-corner' })
    expect(measureChamferSetbacks(bare, [], 'freehand')).toBeNull()

    // Smart-dim planner falls back to plain length (never guesses a corner).
    const plan = planDimension(bare, ['freehand'], [])
    expect(plan.ok).toBe(true)
    if (plan.ok) expect(plan.plan.kind).toBe('distance')
  })

  it('refuses parallel-legs when the current host directions have re-solved parallel', () => {
    const r = buildCornerFixture(3)
    // Simulate "legs re-solved" (e.g. a leg drag) collapsing the corner to
    // parallel: re-point B parallel to A while the coincident/point_on_object
    // rig (the phantom + both host pins) stays structurally intact.
    const parallelEntities = r.transform.entities.map((e) =>
      e.id === 'B' ? { ...(e as SketchLineEntity), start: { x: 0, y: 5 }, end: { x: 10, y: 5 } } : e,
    )
    const resolved = resolveChamferCorner(parallelEntities, r.transform.constraints, r.lineId)
    expect(resolved).toEqual({ ok: false, reason: 'parallel-legs' })
    expect(measureChamferSetbacks(parallelEntities, r.transform.constraints, r.lineId)).toBeNull()
  })
})

describe('UI-50C solver contract: a REFERENCE pair is never pushed', () => {
  it('produces NO solver primitive for a reference d1xd2, under any id', () => {
    const r = buildCornerFixture(3)
    const readout: SketchDimension = {
      id: 'readout', kind: 'd1xd2', entityId: r.lineId, driving: false, value: 3, d2: 3,
    }
    const primitives = sketchToGcsPrimitives(
      sketch(r.transform.entities, r.transform.constraints, [...r.transform.dimensions, readout]),
    )
    // Checked by PREFIX, not by exact id: WO-1858's compound mapping names its
    // two primitives 'readout:d1'/'readout:d2', so an exact-id check would go
    // green against a pair that WAS pushed.
    expect(primitives.some((p) => p.id.startsWith('readout'))).toBe(false)
  })

  it('refuses a malformed d1xd2 target by entity kind name (fail loud, not corruption-tolerant)', () => {
    const point: SketchEntity = { id: 'p1', kind: 'point', construction: false, at: { x: 0, y: 0 } }
    const malformed = {
      id: 'bad', kind: 'd1xd2', entityId: 'p1', driving: false, value: 1, d2: 1,
    } as SketchDimension
    expect(() => sketchToGcsPrimitives(sketch([point], [], [malformed])))
      .toThrow(/is a point.*expected line/)
  })
})

describe('UI-50C derived consumers: format, refIds, browser model', () => {
  it('refuses the single-value formatter by name and formats both setbacks explicitly', () => {
    expect(() => formatDimensionValue('d1xd2', 3, false)).toThrow(TwoValueDimensionKindError)
    expect(formatChamferSetbackValue(3, 5, true)).toBe('3.00 x 5.00')
    expect(formatChamferSetbackValue(3, 5, false)).toBe('(3.00 x 5.00)')
    expect(DIMENSION_KINDS).toContain('d1xd2')
    expect(() => formatDimensionValue('not-a-kind' as SketchDimensionKind, 1, true))
      .toThrow(UnknownSketchDimensionKindError)
  })

  it('participates in refIds/delete cascade with the CHAMFER LINE only', () => {
    const r = buildCornerFixture(3)
    const readout: SketchDimension = {
      id: 'readout', kind: 'd1xd2', entityId: r.lineId, driving: false, value: 3, d2: 3,
    }
    expect(dimensionRefIds(readout)).toEqual([r.lineId])
    const doc = sketch(r.transform.entities, r.transform.constraints,
      [...r.transform.dimensions, readout])
    const afterDelete = deleteFromSketch(doc, [r.lineId])
    expect(afterDelete?.dimensions.some((d) => d.id === 'readout')).toBe(false)
  })

  it('renders both values in the constraint browser (never the bare-d1 default)', () => {
    const r = buildCornerFixture(3)
    const readout: SketchDimension = {
      id: 'readout', kind: 'd1xd2', entityId: r.lineId, driving: false, value: 3.456, d2: 5.123,
    }
    const model = buildBrowserModel(
      sketch(r.transform.entities, r.transform.constraints, [readout]), null,
    )
    const group = model.groups.find((g) => g.kind === 'd1xd2')
    expect(group).toBeDefined()
    expect(group!.title).toBe('D1 x D2 dim')
    expect(group!.rows[0].operands).toContain('(3.456 x 5.123 mm)')
  })
})

describe('UI-50C renderer: leader/label never silently falls through', () => {
  it('builds a finite anchor/label and two finite leader guides', () => {
    const r = buildCornerFixture(3)
    const dim: SketchDimension = {
      id: 'rendered', kind: 'd1xd2', entityId: r.lineId, driving: false, value: 3, d2: 3,
    }
    const doc = sketch(r.transform.entities, r.transform.constraints, [dim])
    const display = dimensionDisplay(doc, dim)
    expect(display).not.toBeNull()
    expect(Number.isFinite(display!.anchor.x)).toBe(true)
    expect(Number.isFinite(display!.anchor.y)).toBe(true)
    expect(display!.text).toBe('(3.00 x 3.00)')

    const guides = dimGuides(r.transform.entities,
      { kind: 'd1xd2', entityId: r.lineId, value: 3, d2: 3 }, display!.anchor, 0.5)
    expect(guides.length).toBeGreaterThanOrEqual(2)
    expect(guides.flat().every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true)
  })
})

describe('UI-50C smart-dim entity-context default (extend-only planDimension)', () => {
  it('defaults a lone CHAMFER LINE pick to d1xd2 only when constraints are supplied', () => {
    const r = buildCornerFixture(3)
    // EXTENSION proof: omitting constraints (every pre-existing 2-arg call
    // site) keeps the unchanged 'distance' (length) default.
    const withoutConstraints = planDimension(r.transform.entities, [r.lineId])
    expect(withoutConstraints.ok).toBe(true)
    if (withoutConstraints.ok) expect(withoutConstraints.plan.kind).toBe('distance')

    const withConstraints = planDimension(
      r.transform.entities, [r.lineId], r.transform.constraints)
    expect(withConstraints.ok).toBe(true)
    if (withConstraints.ok) {
      expect(withConstraints.plan).toMatchObject({ kind: 'd1xd2', entityId: r.lineId, value: 3, d2: 3 })
    }

    // dimForceFamily is untouched by this WO (d1xd2 is not Tab-cycled) -- a
    // lone line still reports the pre-existing 'linear' family.
    expect(dimForceFamily(r.transform.entities, [r.lineId])).toBe('linear')

    // An ordinary (non-chamfer) line is completely unaffected even WITH
    // constraints in hand.
    const ordinary: SketchEntity = { id: 'plain', kind: 'line', construction: false,
      start: { x: 0, y: 0 }, end: { x: 4, y: 0 } }
    const plainPlan = planDimension([ordinary], ['plain'], r.transform.constraints)
    expect(plainPlan.ok).toBe(true)
    if (plainPlan.ok) expect(plainPlan.plan.kind).toBe('distance')
  })

  it('commits a d1xd2 dimension as ALWAYS reference (driving forced false)', () => {
    const r = buildCornerFixture(3)
    const out = dimToolClick(
      { kind: 'dim', operandIds: [r.lineId] },
      { x: 20, y: 0 }, 0.5, r.transform.entities, newId, null, r.transform.constraints,
    )
    expect(out.dimension).not.toBeNull()
    expect(out.dimension).toMatchObject({ kind: 'd1xd2', entityId: r.lineId, driving: false, value: 3, d2: 3 })
  })

  it('resolveDimPlacement threads constraints through to the same d1xd2 plan', () => {
    const r = buildCornerFixture(3)
    const placement = resolveDimPlacement(
      r.transform.entities, [r.lineId], { x: 20, y: 0 }, {}, r.transform.constraints)
    expect(placement).toMatchObject({ kind: 'd1xd2', value: 3 })
    expect(placement?.plan).toMatchObject({ kind: 'd1xd2', entityId: r.lineId, value: 3, d2: 3 })
  })
})

describe('UI-50C asymmetry can-fail fixture (preflight section 6, real solver)', () => {
  it('measures d1 != d2 independently after ONE setback dim is edited and re-solved', async () => {
    const r = buildCornerFixture(3)
    // Edit ONLY setbackDimAId (A's leg) to a different value -- already an
    // independently-driving 'distance' dim (chamferTool's equal-distance v1
    // constructs two SEPARATE dims); nothing new needs to exist for this.
    const editedDims = r.transform.dimensions.map((d) =>
      d.id === r.setbackDimAId ? { ...d, value: 5 } : d)
    const asymmetric: Sketch = sketch(r.transform.entities, r.transform.constraints, editedDims)

    const wrapper = await createGcsWrapper()
    try {
      const out = solveSketchOnWrapper(wrapper, asymmetric)
      expect(out.ok).toBe(true)
      if (!out.ok) return

      const m = measureChamferSetbacks(out.entities, asymmetric.constraints, r.lineId)
      expect(m).not.toBeNull()
      // A naive implementation that assumes symmetry (chamfer LINE length,
      // or reusing one setback for both) would show d1===d2 here -- FAILS.
      expect(m!.d1).toBeCloseTo(5, 6)
      expect(m!.d2).toBeCloseTo(3, 6)
      expect(m!.d1).not.toBeCloseTo(m!.d2, 3)

      // A live reference d1xd2 dimension re-measures to the SAME asymmetric
      // pair after the solve (remeasureReferenceDimensions, both hosts' path).
      const readout: SketchDimension = {
        id: 'readout', kind: 'd1xd2', entityId: r.lineId, driving: false, value: 3, d2: 3,
      }
      const remeasured = remeasureReferenceDimensions(
        out.entities, [readout], asymmetric.constraints)
      // Real-solver output converges to ~1e-15 of ideal, never bit-exact
      // (same reason lines above use toBeCloseTo) - exact match here was
      // the file's one outlier and had never passed.
      const rm0 = remeasured[0]
      if (rm0.kind !== 'd1xd2') throw new Error(`expected d1xd2, got ${rm0.kind}`)
      expect(rm0.value).toBeCloseTo(5, 6)
      expect(rm0.d2).toBeCloseTo(3, 6)
      expect(measureDimension(out.entities, readout, asymmetric.constraints)).toBeCloseTo(5, 6)

      // The Constraint Browser and label text both render BOTH values (the
      // fixture's own coincident/point_on_object constraints group ahead of
      // the dimension groups, so find the d1xd2 group by kind).
      const model = buildBrowserModel(
        sketch(out.entities, asymmetric.constraints, [remeasured[0]]), null)
      const group = model.groups.find((g) => g.kind === 'd1xd2')
      expect(group?.rows[0].operands).toContain('(5 x 3 mm)')
      const display = dimensionDisplay(
        sketch(out.entities, asymmetric.constraints, [remeasured[0]]), remeasured[0])
      expect(display!.text).toBe('(5.00 x 3.00)')
    } finally {
      wrapper.destroy_gcs_module()
    }
  })
})

// ---- UI-50C-R1 rework: audit FAIL, four majors -----------------------------

describe('UI-50C-R1 major 2: false-phantom hardening (adversarial rig)', () => {
  it('refuses a non-construction point pinned to both hosts (never a plausible-but-wrong measurement)', () => {
    const decoy: SketchEntity = { id: 'Q', kind: 'point', construction: false, at: { x: 100, y: 100 } }
    const entities: SketchEntity[] = [
      { id: 'A', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
      { id: 'B', kind: 'line', construction: false, start: { x: 10, y: 0 }, end: { x: 10, y: 10 } },
      { id: 'chamfer', kind: 'line', construction: false, start: { x: 7, y: 0 }, end: { x: 10, y: 3 },
        chamferSetback: true },
      decoy,
    ]
    const constraints: SketchConstraint[] = [
      { id: 'j1', kind: 'coincident',
        a: { entityId: 'chamfer', site: 'start' }, b: { entityId: 'A', site: 'end' } },
      { id: 'j2', kind: 'coincident',
        a: { entityId: 'chamfer', site: 'end' }, b: { entityId: 'B', site: 'start' } },
      // The adversarial rig: Q is pinned to BOTH hosts exactly like a real
      // phantom would be, but Q is NOT construction geometry.
      { id: 'p1', kind: 'point_on_object', point: { entityId: 'Q', site: 'self' }, object: 'A' },
      { id: 'p2', kind: 'point_on_object', point: { entityId: 'Q', site: 'self' }, object: 'B' },
    ]
    const resolved = resolveChamferCorner(entities, constraints, 'chamfer')
    expect(resolved).toEqual({ ok: false, reason: 'no-theoretical-corner' })
    expect(measureChamferSetbacks(entities, constraints, 'chamfer')).toBeNull()
    // The refusal reaches the production planner too (major 1 + major 2 compose).
    const plan = planDimension(entities, ['chamfer'], constraints)
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.reason).toContain('no-theoretical-corner')
  })

  it('finds the REAL construction phantom even with a non-construction decoy also pinned to both hosts', () => {
    const r = buildCornerFixture(3)
    const decoy: SketchEntity = { id: 'decoy', kind: 'point', construction: false, at: { x: -50, y: -50 } }
    const entities = [...r.transform.entities, decoy]
    const constraints: SketchConstraint[] = [
      ...r.transform.constraints,
      { id: 'decoy-p1', kind: 'point_on_object', point: { entityId: 'decoy', site: 'self' }, object: 'A' },
      { id: 'decoy-p2', kind: 'point_on_object', point: { entityId: 'decoy', site: 'self' }, object: 'B' },
    ]
    const resolved = resolveChamferCorner(entities, constraints, r.lineId)
    expect(resolved.ok).toBe(true)
    if (resolved.ok) {
      expect(resolved.corner.phantom.x).toBeCloseTo(10, 9)
      expect(resolved.corner.phantom.y).toBeCloseTo(0, 9)
    }
  })

  it('refuses when hostA and hostB resolve to the SAME line (corrupted rig)', () => {
    const entities: SketchEntity[] = [
      { id: 'A', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
      { id: 'chamfer', kind: 'line', construction: false, start: { x: 7, y: 0 }, end: { x: 3, y: 0 },
        chamferSetback: true },
    ]
    const constraints: SketchConstraint[] = [
      { id: 'j1', kind: 'coincident',
        a: { entityId: 'chamfer', site: 'start' }, b: { entityId: 'A', site: 'end' } },
      { id: 'j2', kind: 'coincident',
        a: { entityId: 'chamfer', site: 'end' }, b: { entityId: 'A', site: 'start' } },
    ]
    expect(resolveChamferCorner(entities, constraints, 'chamfer'))
      .toEqual({ ok: false, reason: 'no-theoretical-corner' })
  })
})

describe('UI-50C-R1 major 1: production-path NAMED refuse (never a silent distance fallback)', () => {
  it('planDimension NAMED-refuses a chamfer-identity line whose rig is broken (missing phantom)', () => {
    const r = buildCornerFixture(3)
    // Strip the point_on_object pins (phantom rig gone) while the chamferSetback
    // identity and coincident joints stay intact -- a corrupted/hand-edited file.
    const brokenConstraints = r.transform.constraints.filter((c) => c.kind !== 'point_on_object')
    const plan = planDimension(r.transform.entities, [r.lineId], brokenConstraints)
    expect(plan.ok).toBe(false)
    if (!plan.ok) {
      expect(plan.incomplete).toBe(false)
      expect(plan.reason).toContain('no-theoretical-corner')
    }
  })

  it('planDimension NAMED-refuses a chamfer-identity line with re-solved parallel legs', () => {
    const r = buildCornerFixture(3)
    const parallelEntities = r.transform.entities.map((e) =>
      e.id === 'B' ? { ...(e as SketchLineEntity), start: { x: 0, y: 5 }, end: { x: 10, y: 5 } } : e)
    const plan = planDimension(parallelEntities, [r.lineId], r.transform.constraints)
    expect(plan.ok).toBe(false)
    if (!plan.ok) {
      expect(plan.incomplete).toBe(false)
      expect(plan.reason).toContain('parallel-legs')
    }
  })

  it('an ORDINARY line with the SAME structural rig shape (no chamfer identity) still gets plain distance', () => {
    // A middle polyline segment: both endpoints coincident-joined to
    // neighbors -- structurally identical to resolveChamferCorner's own
    // host-joint search -- but it never carries chamferSetback, so the
    // identity gate must not misdiagnose it as a broken chamfer.
    const entities: SketchEntity[] = [
      { id: 'seg1', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 5, y: 0 } },
      { id: 'seg2', kind: 'line', construction: false, start: { x: 5, y: 0 }, end: { x: 5, y: 5 } },
      { id: 'seg3', kind: 'line', construction: false, start: { x: 5, y: 5 }, end: { x: 0, y: 5 } },
    ]
    const constraints: SketchConstraint[] = [
      { id: 'j1', kind: 'coincident',
        a: { entityId: 'seg2', site: 'start' }, b: { entityId: 'seg1', site: 'end' } },
      { id: 'j2', kind: 'coincident',
        a: { entityId: 'seg2', site: 'end' }, b: { entityId: 'seg3', site: 'start' } },
    ]
    const plan = planDimension(entities, ['seg2'], constraints)
    expect(plan.ok).toBe(true)
    if (plan.ok) expect(plan.plan.kind).toBe('distance')
  })

  it('the REAL click-to-commit path (toolMachine.toolClick) threads constraints, so a chamfer line defaults to d1xd2 from an actual click', () => {
    const r = buildCornerFixture(3)
    const chamferEntity = r.transform.entities.find((e) => e.id === r.lineId) as SketchLineEntity
    const midpoint = {
      x: (chamferEntity.start.x + chamferEntity.end.x) / 2,
      y: (chamferEntity.start.y + chamferEntity.end.y) / 2,
    }
    let n = 0
    const newId = () => `click-${n++}`

    const state = armTool(IDLE_TOOL_STATE, 'smart-dimension')
    const pick = toolClick(state, midpoint, 0.6, newId, {
      entities: r.transform.entities, constraints: r.transform.constraints,
    })
    expect(pick.commit).toBeNull() // single operand: waits for placement
    const placed = toolClick(pick.state, { x: 20, y: 20 }, 0.6, newId, {
      entities: r.transform.entities, constraints: r.transform.constraints,
    })
    expect(placed.commit?.dimensions?.[0]?.kind).toBe('d1xd2')

    // A caller that genuinely cannot supply constraints (ctx.constraints
    // omitted, toolMachine's own defensive `?? []`) correctly NAMED-refuses
    // on the very first click rather than reproducing the old silent
    // "distance" mis-fallback this WO's audit found.
    const state2 = armTool(IDLE_TOOL_STATE, 'smart-dimension')
    const pick2 = toolClick(state2, midpoint, 0.6, newId, { entities: r.transform.entities })
    expect(pick2.commit).toBeNull()
    expect(pick2.notice).toContain('no-theoretical-corner')
  })
})

// WO-1858 retired UI-50C-R1 major 3's "normalize a forged driving:true d1xd2"
// rule: the kind drives the solver now, so driving:true is a real state and
// remeasuring over it would throw away the number the operator typed.
describe('remeasureReferenceDimensions and the two states of a d1xd2', () => {
  it('a REFERENCE pair re-measures BOTH halves from the current geometry', () => {
    const r = buildCornerFixture(3)
    const stale: SketchDimension = {
      id: 'stale', kind: 'd1xd2', entityId: r.lineId, driving: false, value: 111, d2: 222,
    }
    const next = remeasureReferenceDimensions(r.transform.entities, [stale], r.transform.constraints)
    expect(next[0]).toMatchObject({ driving: false, value: 3, d2: 3 })
  })

  it('a DRIVING pair keeps its typed values -- it holds them through the solver, like every other driving kind', () => {
    const r = buildCornerFixture(3)
    const driven: SketchDimension = {
      id: 'driven', kind: 'd1xd2', entityId: r.lineId, driving: true, value: 7, d2: 9,
    }
    const dims = [driven]
    const next = remeasureReferenceDimensions(r.transform.entities, dims, r.transform.constraints)
    expect(next).toBe(dims) // byte-stable: nothing to remeasure
    expect(next[0]).toMatchObject({ driving: true, value: 7, d2: 9 })
  })

  it('a REFERENCE pair whose corner cannot resolve keeps its prior values rather than guessing', () => {
    const bare: SketchEntity[] = [
      { id: 'freehand', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 5, y: 5 } },
    ]
    const unresolvable: SketchDimension = {
      id: 'unresolvable', kind: 'd1xd2', entityId: 'freehand', driving: false, value: 111, d2: 222,
    }
    const dims = [unresolvable]
    expect(remeasureReferenceDimensions(bare, dims, [])).toBe(dims)
  })

  it('a d1xd2 already driving:false and already at the measured value is byte-stable (no spurious change)', () => {
    const r = buildCornerFixture(3)
    const clean: SketchDimension = {
      id: 'clean', kind: 'd1xd2', entityId: r.lineId, driving: false, value: 3, d2: 3,
    }
    const dims = [clean]
    const next = remeasureReferenceDimensions(r.transform.entities, dims, r.transform.constraints)
    expect(next).toBe(dims)
  })
})
