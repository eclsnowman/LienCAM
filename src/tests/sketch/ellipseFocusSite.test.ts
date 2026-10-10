// Ellipse FOCUS point sites ('focus1'/'focus2') — the dimensionable-foci
// follow-up to the always-displayed foci nodes (Operator ruling 2026-07-02: "foci
// nodes ... should be dimensionable").
//
// Covers the WHOLE shared path a point site rides (mirroring the 'center'
// site precedent everywhere):
//   - ellipse.ts        ellipseFocusSite position derivation (+ degenerate)
//   - sketchLayer.ts    resolvePointRef
//   - snap.ts           entity snap spot enumeration (pick path for dims)
//   - dimTool.ts        planDimension / measureDimension with focus operands
//   - gcsMapping.ts     materialized center-tied gcs points; a driving dim
//                       on a focus DRAGS the ellipse exactly like a center
//                       dim; fail-loud on a focus ref to a non-ellipse
//
// The real-planegcs solves reuse the createGcsWrapper harness pattern from
// ellipseTrimDefinedness.repro.test.ts.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { GcsWrapper } from '@salusoft89/planegcs'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import {
  sketchToGcsPrimitives, solveSketchOnWrapper, SketchMappingError,
} from '../../lib/sketch/solver/gcsMapping'
import { resolvePointRef } from '../../lib/sketch/sketcher/sketchLayer'
import { ellipseFocusSite } from '../../lib/sketch/ellipse'
import { findSnap, type SnapQuery } from '../../lib/sketch/snap'
import { planDimension, measureDimension, dist } from '../../lib/sketch/tools/dimTool'
import type {
  Sketch, SketchEntity, SketchConstraint, SketchDimension, PointRef, Vec2,
} from '../../lib/sketch/types'

// ---- fixtures ---------------------------------------------------------------

const C = Math.sqrt(10 * 10 - 5 * 5) // linear eccentricity of the 10x5 ellipse

function ellipse(
  id: string, cx: number, cy: number, major = 10, minor = 5, rot = 0,
): SketchEntity {
  return { id, kind: 'ellipse', construction: false,
    center: { x: cx, y: cy }, majorRadius: major, minorRadius: minor, rotation: rot }
}

function point(id: string, x: number, y: number): SketchEntity {
  return { id, kind: 'point', construction: false, at: { x, y } }
}

function sketchWith(
  entities: SketchEntity[],
  constraints: SketchConstraint[] = [],
  dimensions: SketchDimension[] = [],
): Sketch {
  return { id: 'sk', layerId: 'L', entities, constraints, dimensions, solveStatus: null }
}

const ref = (entityId: string, site: PointRef['site']): PointRef => ({ entityId, site })

// ---- position derivation (pure) ----------------------------------------------

describe('ellipseFocusSite', () => {
  const el = { center: { x: 2, y: 3 }, majorRadius: 10, minorRadius: 5, rotation: 0 }

  it('focus1 = center + c*majorDir, focus2 the mirror', () => {
    expect(ellipseFocusSite(el, 'focus1')).toEqual({ x: 2 + C, y: 3 })
    expect(ellipseFocusSite(el, 'focus2')).toEqual({ x: 2 - C, y: 3 })
  })

  it('swapped-axis ellipse (minor > major): foci ride the TRUE long axis', () => {
    const tall = { ...el, majorRadius: 5, minorRadius: 10 } // long axis = +Y
    const f1 = ellipseFocusSite(tall, 'focus1')
    expect(f1.x).toBeCloseTo(2, 9)
    expect(f1.y).toBeCloseTo(3 + C, 9)
  })

  it('circle-degenerate: BOTH sites collapse onto the center', () => {
    const circ = { ...el, majorRadius: 5, minorRadius: 5 }
    expect(ellipseFocusSite(circ, 'focus1')).toEqual({ x: 2, y: 3 })
    expect(ellipseFocusSite(circ, 'focus2')).toEqual({ x: 2, y: 3 })
  })
})

// ---- render-layer resolution ---------------------------------------------------

describe('resolvePointRef focus sites', () => {
  it('resolves focus1/focus2 on ellipse and elliptical-arc', () => {
    const arc: SketchEntity = {
      id: 'ea', kind: 'elliptical-arc', construction: false,
      center: { x: 0, y: 0 }, majorRadius: 10, minorRadius: 5, rotation: 0,
      startParam: 0, endParam: Math.PI,
    }
    const sk = sketchWith([ellipse('el', 0, 0), arc])
    expect(resolvePointRef(sk, ref('el', 'focus1'))).toEqual({ x: C, y: 0 })
    expect(resolvePointRef(sk, ref('el', 'focus2'))).toEqual({ x: -C, y: 0 })
    expect(resolvePointRef(sk, ref('ea', 'focus1'))).toEqual({ x: C, y: 0 })
  })

  it('focus site on a non-ellipse resolves to null (unrepresentable)', () => {
    const sk = sketchWith([point('p1', 1, 1)])
    expect(resolvePointRef(sk, ref('p1', 'focus1'))).toBeNull()
  })
})

// ---- snap enumeration (the dim tool's explicit-point pick path) ---------------

const WPP = 0.1 // snap radius = SNAP_PX * 0.1 = 1 mm

function query(cursor: Vec2, entities: SketchEntity[]): SnapQuery {
  return {
    cursor, entities, gridSpacing: 25, worldPerPixel: WPP,
    flags: { entity: true, grid: true, inference: true },
  }
}

describe('snap: focus spots', () => {
  it('cursor near a focus snaps to it with the focus-site ref + inference', () => {
    const r = findSnap(query({ x: C + 0.3, y: 0.2 }, [ellipse('el', 0, 0)]))
    expect(r).not.toBeNull()
    expect(r!.kind).toBe('center')
    expect(r!.point.x).toBeCloseTo(C, 9)
    expect(r!.point.y).toBeCloseTo(0, 9)
    expect(r!.inferences).toEqual([
      { kind: 'coincident', to: { entityId: 'el', site: 'focus1' } },
    ])
    // The hover-wake ref (what the dim tool receives as the explicit
    // operand) carries the SAME addressable site.
    expect(r!.wake?.ref).toEqual({ entityId: 'el', site: 'focus1' })
  })

  it('the opposite focus enumerates as focus2', () => {
    const r = findSnap(query({ x: -C - 0.2, y: -0.1 }, [ellipse('el', 0, 0)]))
    expect(r!.wake?.ref).toEqual({ entityId: 'el', site: 'focus2' })
  })

  it('circle-degenerate ellipse: the collapsed spot is the CENTER site only', () => {
    const r = findSnap(query({ x: 0.2, y: 0.1 }, [ellipse('el', 0, 0, 5, 5)]))
    expect(r!.kind).toBe('center')
    expect(r!.wake?.ref).toEqual({ entityId: 'el', site: 'center' })
  })
})

// ---- dim tool (clone of the center-site precedent) ------------------------------

describe('dim tool: focus operands behave like center operands', () => {
  const el = ellipse('el', 0, 0)
  const pt = point('p1', 30, 0)
  const lc: SketchEntity = { id: 'lc', kind: 'line', construction: false,
    start: { x: 20, y: -10 }, end: { x: 20, y: 10 } }
  const ents = [el, pt, lc]

  it('explicit focus + point -> straight distance between the two points', () => {
    const out = planDimension(ents, [
      { entityId: 'el', site: 'focus1' }, { entityId: 'p1', site: 'self' },
    ])
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.plan.kind).toBe('distance')
      expect(out.plan).toMatchObject({
        a: { entityId: 'el', site: 'focus1' },
        b: { entityId: 'p1', site: 'self' },
      })
      if (out.plan.kind === 'distance') {
        expect(out.plan.value).toBeCloseTo(30 - C, 9)
      }
    }
  })

  it('explicit focus + line -> point-to-line distance (center-site parity)', () => {
    const out = planDimension(ents, [{ entityId: 'el', site: 'focus1' }, 'lc'])
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.plan.kind).toBe('distancePL')
  })

  it('measureDimension resolves focus refs (incl. after geometry edits)', () => {
    const d: SketchDimension = { id: 'd1', kind: 'distance', driving: true,
      value: 0, a: ref('el', 'focus1'), b: ref('p1', 'self') }
    expect(measureDimension(ents, d)).toBeCloseTo(30 - C, 9)
    // Degenerate circle-ellipse: the focus measures AS the center.
    const round = [ellipse('el', 0, 0, 5, 5), pt]
    expect(measureDimension(round, d)).toBeCloseTo(30, 9)
  })

  it('focus1 + focus2 of the SAME ellipse plan the focus-to-focus (2c) dimension', () => {
    const out = planDimension([el], [
      { entityId: 'el', site: 'focus1' }, { entityId: 'el', site: 'focus2' },
    ])
    // Two DISTINCT foci of one ellipse now drive the FOCUS-TO-FOCUS direct-edit
    // dimension whose value is the inter-focal distance 2c (the dimToolClick
    // same-entity guard makes an explicit exception for two distinct foci).
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.plan.kind).toBe('focusDistance')
      expect((out.plan as { value: number }).value).toBeCloseTo(2 * C, 9)
    }
  })
})

// ---- gcs mapping + real solves ---------------------------------------------------

describe('gcsMapping: focus sites', () => {
  let wrapper: GcsWrapper
  beforeAll(async () => { wrapper = await createGcsWrapper() }, 60_000)
  afterAll(() => { wrapper.destroy_gcs_module() })

  const focusDim = (value: number): SketchDimension => ({
    id: 'd1', kind: 'distance', driving: true, value,
    a: ref('el', 'focus1'), b: ref('p1', 'self'),
  })
  const fixP1: SketchConstraint = { id: 'f1', kind: 'fix', point: ref('p1', 'self') }

  it('un-referenced ellipse pushes NO focus primitives (byte-parity)', () => {
    const prims = sketchToGcsPrimitives(sketchWith([ellipse('el', 0, 0)]))
    expect(prims.some((p) => p.id.includes('focus'))).toBe(false)
  })

  it('a focus ref materializes the point + two center-tie differences', () => {
    const sk = sketchWith([ellipse('el', 0, 0), point('p1', 30, 0)], [fixP1], [focusDim(15)])
    const prims = sketchToGcsPrimitives(sk)
    const fp = prims.find((p) => p.id === 'el:focus1')
    expect(fp?.type).toBe('point')
    if (fp?.type === 'point') {
      expect(fp.x).toBeCloseTo(C, 9)
      expect(fp.y).toBe(0)
    }
    const tx = prims.find((p) => p.id === 'el:focus1:tx')
    const ty = prims.find((p) => p.id === 'el:focus1:ty')
    expect(tx?.type).toBe('difference')
    if (tx?.type === 'difference') expect(tx.difference).toBeCloseTo(C, 9)
    expect(ty?.type).toBe('difference')
    if (ty?.type === 'difference') expect(ty.difference).toBe(0)
    // focus2 was never referenced: not materialized.
    expect(prims.some((p) => p.id.startsWith('el:focus2'))).toBe(false)
  })

  it('focus ref on a NON-ellipse fails loud (SketchMappingError)', () => {
    const bad = sketchWith(
      [ { id: 'ln', kind: 'line', construction: false,
          start: { x: 0, y: 0 }, end: { x: 10, y: 0 } }, point('p1', 30, 0) ],
      [], [{ id: 'd1', kind: 'distance', driving: true, value: 5,
             a: ref('ln', 'focus1'), b: ref('p1', 'self') }],
    )
    expect(() => sketchToGcsPrimitives(bad)).toThrow(SketchMappingError)
  })

  it('a DRIVING focus dim drags the ellipse exactly like a center dim', () => {
    // Free ellipse, fixed point at (30,0), dim focus1<->point = 15 (seeded
    // at 30 - c ~ 21.34, so the solver MUST move the ellipse).
    const sk = sketchWith([ellipse('el', 0, 0), point('p1', 30, 0)], [fixP1], [focusDim(15)])
    const out = solveSketchOnWrapper(wrapper, sk)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.status.solveFailed).toBeFalsy()
    expect(out.status.conflicting).toEqual([])
    const solvedEl = out.entities.find((e) => e.id === 'el')!
    expect(solvedEl.kind).toBe('ellipse')
    if (solvedEl.kind !== 'ellipse') return
    // Shape carried verbatim (solver-inert), only the center moved.
    expect(solvedEl.majorRadius).toBe(10)
    expect(solvedEl.minorRadius).toBe(5)
    // The RE-DERIVED focus (center + shape — what the render shows) sits at
    // the dimensioned distance: the tie kept the phantom point ON the focus.
    const f1 = ellipseFocusSite(solvedEl, 'focus1')
    expect(dist(f1, { x: 30, y: 0 })).toBeCloseTo(15, 6)

    // Center-site CONTROL: the identical sketch dimensioned to the CENTER
    // behaves the same way (parity gate).
    const ctrl = sketchWith([ellipse('el', 0, 0), point('p1', 30, 0)], [fixP1],
      [{ id: 'd1', kind: 'distance', driving: true, value: 15,
         a: ref('el', 'center'), b: ref('p1', 'self') }])
    const outC = solveSketchOnWrapper(wrapper, ctrl)
    expect(outC.ok).toBe(true)
    if (!outC.ok) return
    const ec = outC.entities.find((e) => e.id === 'el')!
    if (ec.kind !== 'ellipse') return
    expect(dist(ec.center, { x: 30, y: 0 })).toBeCloseTo(15, 6)
    // Same residual DoF either way: the focus tie adds zero net freedom.
    expect(out.status.dof).toBe(outC.status.dof)
  }, 30_000)

  it('degenerate circle-ellipse: the focus dim behaves as a center dim', () => {
    const sk = sketchWith([ellipse('el', 0, 0, 5, 5), point('p1', 30, 0)], [fixP1], [focusDim(12)])
    const out = solveSketchOnWrapper(wrapper, sk)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const el = out.entities.find((e) => e.id === 'el')!
    if (el.kind !== 'ellipse') return
    // Collapsed foci: focus == center, so the CENTER lands at distance 12.
    expect(dist(el.center, { x: 30, y: 0 })).toBeCloseTo(12, 6)
  }, 30_000)
})
