// Topology-keyed definedness cache (perf fix for the several-second dimension
// edit). diagnoseDefinedEntities is O(N) full solves; its result is STRUCTURAL
// (depends only on the constraint graph, never on dimension values), so a
// value edit on a fixed-topology sketch reuses the cached result and SKIPS the
// probe loop, while any topology change re-diagnoses. These tests pin:
//   (a) a VALUE edit (same topology) does NOT re-run the probe loop (the
//       internal solve count collapses to a small constant) yet returns the
//       IDENTICAL definedness set (correctness preserved by the cache),
//   (b) a TOPOLOGY change (adding a dimension) DOES re-diagnose and produces
//       the correct new definedness,
//   (c) the signature EXCLUDES values/coords and INCLUDES every structural
//       field (ids/kinds/refs/driving/sketch-id) so the cache never reuses a
//       stale or foreign result.

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import {
  solveSketchOnWrapper, sketchTopologySignature,
} from '../../lib/sketch/solver/gcsMapping'
import type {
  Sketch, SketchEntity, SketchLineEntity, SketchConstraint,
  SketchDimension, PointRef,
} from '../../lib/sketch/types'
import type { GcsWrapper } from '@salusoft89/planegcs'

let wrapper: GcsWrapper
beforeAll(async () => { wrapper = await createGcsWrapper() })
afterAll(() => { wrapper.destroy_gcs_module() })

function ref(entityId: string, site: PointRef['site']): PointRef {
  return { entityId, site }
}
function line(id: string, x1: number, y1: number, x2: number, y2: number): SketchLineEntity {
  return { id, kind: 'line', construction: false, start: { x: x1, y: y1 }, end: { x: x2, y: y2 } }
}

/** Rectangle (4 lines, coincident corners, H/V) + fixed corner + optional
 *  width/height dims + optional free circle. With dims the rectangle is rigid
 *  (its 4 lines fully defined) but the circle stays free (dof>0), so the
 *  per-entity probe loop actually runs. `p` = id prefix so each test owns a
 *  unique topology signature (guaranteed cold first solve). */
function rectSketch(p: string, opts: { dims?: boolean; circle?: boolean } = {}): Sketch {
  const entities: SketchEntity[] = [
    line(`${p}l1`, 0, 0, 40, 0),
    line(`${p}l2`, 40, 0, 40, 30),
    line(`${p}l3`, 40, 30, 0, 30),
    line(`${p}l4`, 0, 30, 0, 0),
  ]
  const constraints: SketchConstraint[] = [
    { id: `${p}c12`, kind: 'coincident', a: ref(`${p}l1`, 'end'), b: ref(`${p}l2`, 'start') },
    { id: `${p}c23`, kind: 'coincident', a: ref(`${p}l2`, 'end'), b: ref(`${p}l3`, 'start') },
    { id: `${p}c34`, kind: 'coincident', a: ref(`${p}l3`, 'end'), b: ref(`${p}l4`, 'start') },
    { id: `${p}c41`, kind: 'coincident', a: ref(`${p}l4`, 'end'), b: ref(`${p}l1`, 'start') },
    { id: `${p}h1`, kind: 'horizontal', line: `${p}l1` },
    { id: `${p}h3`, kind: 'horizontal', line: `${p}l3` },
    { id: `${p}v2`, kind: 'vertical', line: `${p}l2` },
    { id: `${p}v4`, kind: 'vertical', line: `${p}l4` },
    { id: `${p}fx`, kind: 'fix', point: ref(`${p}l1`, 'start') },
  ]
  const dimensions: SketchDimension[] = opts.dims ? [
    { id: `${p}dw`, kind: 'distance', driving: true, value: 40, a: ref(`${p}l1`, 'start'), b: ref(`${p}l1`, 'end') },
    { id: `${p}dh`, kind: 'distance', driving: true, value: 30, a: ref(`${p}l2`, 'start'), b: ref(`${p}l2`, 'end') },
  ] : []
  if (opts.circle) {
    entities.push({ id: `${p}circ`, kind: 'circle', construction: false, center: { x: 90, y: 15 }, radius: 8 })
  }
  return { id: 'sk', layerId: 'layer', entities, constraints, dimensions, solveStatus: null }
}

/** Count how many times gcs.solve() runs during one solveSketchOnWrapper. The
 *  probe loop is O(N) internal solves; the main + false-conflict + park passes
 *  are a small constant. So a cold solve (probe loop runs) has MANY more solves
 *  than a warm one (probe loop skipped). */
function countSolves(sk: Sketch): { solves: number; out: ReturnType<typeof solveSketchOnWrapper> } {
  const spy = vi.spyOn(wrapper, 'solve')
  const out = solveSketchOnWrapper(wrapper, sk)
  const solves = spy.mock.calls.length
  spy.mockRestore()
  return { solves, out }
}

describe('definedness cache: value edit reuses, topology change recomputes', () => {
  it('(a) a value edit (same topology) skips the probe loop but keeps the SAME definedness', () => {
    const cold = rectSketch('a_', { dims: true, circle: true })

    // COLD: fresh topology -> probe loop runs (N_entities internal solves).
    const c = countSolves(cold)
    expect(c.out.ok).toBe(true)
    if (!c.out.ok) return
    expect(c.out.status.dof).toBeGreaterThan(0) // the free circle
    const coldDefined = new Set(c.out.status.fullyDefinedEntities)
    // The rigid rectangle is defined; the free circle is not.
    expect(coldDefined).toEqual(new Set(['a_l1', 'a_l2', 'a_l3', 'a_l4']))

    // WARM: same ids, only a dimension VALUE changed (40 -> 55). Same topology.
    const warm: Sketch = {
      ...cold,
      dimensions: cold.dimensions.map((d) => d.id === 'a_dw' ? { ...d, value: 55 } : d),
    }
    // Signature must be identical (values excluded).
    expect(sketchTopologySignature(warm)).toBe(sketchTopologySignature(cold))

    const w = countSolves(warm)
    expect(w.out.ok).toBe(true)
    if (!w.out.ok) return

    // The probe loop was skipped: the warm solve runs far fewer internal
    // solves than the cold one (no per-entity probe), yet the definedness is
    // byte-identical (correctness preserved by the cache).
    expect(w.solves).toBeLessThan(c.solves)
    expect(w.solves).toBeLessThanOrEqual(c.solves - cold.entities.length + 1)
    expect(new Set(w.out.status.fullyDefinedEntities)).toEqual(coldDefined)
  })

  it('(b) a topology change (fix + add a dimension) re-diagnoses with correct definedness', () => {
    // Rect (rigid) + TWO free circles, so a residual dof>0 remains even after
    // one circle is fully defined -> the probe loop still runs (no dof==0
    // short-circuit) and the coloring must update structurally.
    const base = rectSketch('b_', { dims: true, circle: true })
    base.entities.push({ id: 'b_circ2', kind: 'circle', construction: false,
      center: { x: 130, y: 15 }, radius: 5 })
    const first = solveSketchOnWrapper(wrapper, base) // populate cache for topology B
    expect(first.ok).toBe(true)
    if (!first.ok) return
    // Both circles are free -> only the rectangle's 4 lines are defined.
    expect(new Set(first.status.fullyDefinedEntities)).toEqual(
      new Set(['b_l1', 'b_l2', 'b_l3', 'b_l4']))

    // Fully define circle 1 (fix its center + a driving radius dim) -> new
    // topology; circle 2 stays free. The signature must change so the probe
    // loop re-runs and circle 1 flips to defined while circle 2 stays blue.
    const grown: Sketch = {
      ...base,
      constraints: [...base.constraints,
        { id: 'b_fixc', kind: 'fix', point: ref('b_circ', 'center') }],
      dimensions: [...base.dimensions,
        { id: 'b_dr', kind: 'radius', driving: true, value: 8, entityId: 'b_circ' }],
    }
    expect(sketchTopologySignature(grown)).not.toBe(sketchTopologySignature(base))

    const g = countSolves(grown)
    expect(g.out.ok).toBe(true)
    if (!g.out.ok) return
    expect(g.out.status.dof).toBeGreaterThan(0) // circle 2 keeps it under-defined
    // Re-diagnosed (probe loop ran again) and circle 1 is now defined; the
    // still-free circle 2 stays undefined.
    expect(g.solves).toBeGreaterThan(grown.entities.length)
    expect(new Set(g.out.status.fullyDefinedEntities)).toEqual(
      new Set(['b_l1', 'b_l2', 'b_l3', 'b_l4', 'b_circ']))
  })
})

describe('topology signature: excludes values/coords, includes structure', () => {
  it('is identical when only a dimension value or a coordinate changes', () => {
    const s = rectSketch('sig_', { dims: true, circle: true })
    const valueEdit: Sketch = {
      ...s, dimensions: s.dimensions.map((d) => ({ ...d, value: d.value + 123 })),
    }
    const moved: Sketch = {
      ...s,
      entities: s.entities.map((e) =>
        e.kind === 'circle' ? { ...e, center: { x: 999, y: 999 }, radius: 42 } : e),
    }
    expect(sketchTopologySignature(valueEdit)).toBe(sketchTopologySignature(s))
    expect(sketchTopologySignature(moved)).toBe(sketchTopologySignature(s))
  })

  it('changes when structure changes: entity, constraint, dim, driving flag, sketch id', () => {
    const s = rectSketch('sig2_', { dims: true, circle: true })
    const sig = sketchTopologySignature(s)

    // add a constraint
    const addCon: Sketch = { ...s, constraints: [...s.constraints,
      { id: 'sig2_extra', kind: 'equal', a: 'sig2_l1', b: 'sig2_l2' }] }
    // toggle a dim to reference (non-driving removes no DoF -> different defined state)
    const toRef: Sketch = { ...s, dimensions: s.dimensions.map((d) =>
      d.id === 'sig2_dw' ? { ...d, driving: false } : d) }
    // remove an entity
    const dropEnt: Sketch = { ...s, entities: s.entities.filter((e) => e.kind !== 'circle') }
    // different sketch id (sketch switch reusing the worker)
    const otherSketch: Sketch = { ...s, id: 'sk-other' }

    expect(sketchTopologySignature(addCon)).not.toBe(sig)
    expect(sketchTopologySignature(toRef)).not.toBe(sig)
    expect(sketchTopologySignature(dropEnt)).not.toBe(sig)
    expect(sketchTopologySignature(otherSketch)).not.toBe(sig)
  })
})
