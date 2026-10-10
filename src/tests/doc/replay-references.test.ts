import { describe, it, expect } from 'vitest'
import { FeatureDag } from '../../doc/dag'
import { ElementMap } from '../../doc/element-map'
import type { DeltaSnapshots, GeometrySnapshot } from '../../doc/element-map'
import { applyFeatureDelta } from '../../doc/replay'
import type { ElementMapDelta } from '../../geom/geom-service'

// AC #3: a feature consuming a face StableId of an upstream feature survives
// an upstream parameter change that SPLITS the referenced face (a modified
// 1->2 delta with inline geometry per ICR-1); the DAG edge re-resolves
// through element-map machinery and records via='geometric'|'lineage'
// honestly. FAILS-IF: must fail if replay consults the companion map when
// the inline field is present but disagrees (inline wins).
//
// AC #4: a feature whose reference resolves 'lost' is marked degraded in the
// DAG with its structured Diag retained; downstream features still evaluate
// against the last-good body; the degraded flag round-trips serialization.

const plane = (centroid: GeometrySnapshot['centroid'], area: number, normal = { x: 0, y: 0, z: 1 }): GeometrySnapshot => ({
  surfaceType: 'plane',
  centroid,
  area,
  normal,
})

describe('AC #3: replay correctness with references across a face split (ICR-1 inline geometry)', () => {
  const TOP = 'F1:BOX:zmax'
  const FRAG0 = `F1:CUT:(${TOP})#0`
  const FRAG1 = `F1:CUT:(${TOP})#1`

  const boxDelta: ElementMapDelta = {
    featureId: 'F1',
    generated: [TOP, 'F1:BOX:zmin'],
    modified: {},
    deleted: [],
    geometry: {
      [TOP]: plane({ x: 0, y: 0, z: 10 }, 100),
      'F1:BOX:zmin': plane({ x: 0, y: 0, z: -10 }, 100, { x: 0, y: 0, z: -1 }),
    },
  }

  // Split delta: the parameter edit shrank the box so the cut now splits the
  // top face into two fragments. Inline geometry (ICR-1) is authoritative;
  // fragment #0 is genuinely close to the pre-split top face's centroid,
  // fragment #1 is far -- so the correct split winner (max-overlap proxy:
  // closest centroid) is #0.
  const splitDelta: ElementMapDelta = {
    featureId: 'F1r',
    generated: [],
    modified: { [TOP]: [FRAG0, FRAG1] },
    deleted: [],
    geometry: {
      [FRAG0]: plane({ x: 0, y: 0, z: 10.01 }, 60),
      [FRAG1]: plane({ x: 5, y: 5, z: 10 }, 40),
    },
  }

  // A companion snapshot map that DISAGREES with splitDelta.geometry for the
  // SAME two ids -- swapped, so a resolver that trusted companion over inline
  // would pick the WRONG fragment as the split winner.
  const disagreeingCompanion: DeltaSnapshots = {
    [FRAG0]: plane({ x: 5, y: 5, z: 10 }, 40),
    [FRAG1]: plane({ x: 0, y: 0, z: 10.01 }, 60),
  }

  function buildDag(): FeatureDag {
    const dag = new FeatureDag()
    dag.insertNode({ id: 'F1', kind: 'feature', consumes: [], refs: [], payload: { op: 'box' } })
    dag.insertNode({
      id: 'F2',
      kind: 'feature',
      consumes: ['F1'],
      refs: [{ id: TOP, kind: 'single-face' }],
      payload: { op: 'cut' },
    })
    return dag
  }

  it('resolves exact before the split, then re-resolves via lineage after the split -- inline geometry wins over a disagreeing companion map', () => {
    const map = new ElementMap()
    const dag = buildDag()

    applyFeatureDelta(map, boxDelta)
    dag.regenerate(map)
    expect(dag.getNode('F2')!.degraded).toBe(false)
    expect(dag.getNode('F2')!.lastGoodBoundTo[TOP]).toEqual([TOP])

    // Merge helper is handed BOTH the inline geometry and a companion map that
    // disagrees with it -- per ICR-1, inline must win.
    applyFeatureDelta(map, splitDelta, disagreeingCompanion)
    dag.regenerate(map)

    const f2 = dag.getNode('F2')!
    expect(f2.degraded).toBe(false)
    // FAILS-IF proof: if replay had consulted the companion map instead of
    // (or in preference to) the inline field, this would resolve to FRAG1
    // (the companion's swapped-in "close" candidate) instead of FRAG0.
    expect(f2.lastGoodBoundTo[TOP]).toEqual([FRAG0])

    const resolution = map.resolve(TOP, 'single-face')
    expect(resolution.status).toBe('exact')
    expect(['geometric', 'lineage']).toContain(resolution.via)
    expect(resolution.via).toBe('lineage')
    expect(resolution.boundTo).toEqual([FRAG0])
  })

  it('control: applying the SAME companion map WITHOUT the inline merge picks the wrong fragment (proves the test is sensitive to the merge direction)', () => {
    const map2 = new ElementMap()
    applyFeatureDelta(map2, boxDelta)
    // Bypass the merge helper entirely -- apply the split delta with ONLY the
    // disagreeing companion snapshots, exactly what a regression to
    // "companion wins" (or "inline ignored") would do.
    map2.applyDelta(splitDelta, disagreeingCompanion)
    const resolution = map2.resolve(TOP, 'single-face')
    expect(resolution.via).toBe('lineage')
    expect(resolution.boundTo).toEqual([FRAG1]) // the WRONG winner, by construction
  })
})

describe('AC #4: degraded state, last-good-body retention, and serialization round-trip', () => {
  const ZMAX = 'F1:BOX:zmax'
  const ZMIN = 'F1:BOX:zmin'

  const boxDelta: ElementMapDelta = {
    featureId: 'F1',
    generated: [ZMAX, ZMIN],
    modified: {},
    deleted: [],
    geometry: {
      [ZMAX]: plane({ x: 0, y: 0, z: 10 }, 100),
      [ZMIN]: plane({ x: 0, y: 0, z: -10 }, 100, { x: 0, y: 0, z: -1 }),
    },
  }

  function buildDag(): FeatureDag {
    const dag = new FeatureDag()
    dag.insertNode({ id: 'F1', kind: 'feature', consumes: [], refs: [], payload: { op: 'box' } })
    dag.insertNode({
      id: 'F4',
      kind: 'feature',
      consumes: ['F1'],
      refs: [{ id: ZMIN, kind: 'single-face' }],
      payload: { op: 'holeInBottom' },
    })
    dag.insertNode({
      id: 'F5',
      kind: 'feature',
      consumes: ['F4'],
      refs: [{ id: ZMAX, kind: 'single-face' }],
      payload: { op: 'chamferTop' },
    })
    return dag
  }

  it('a lost reference degrades ONLY its owning node; downstream nodes still evaluate in the same regenerate() pass; last-good binding is retained', () => {
    const map = new ElementMap()
    const dag = buildDag()

    applyFeatureDelta(map, boxDelta)
    dag.regenerate(map)
    expect(dag.getNode('F4')!.degraded).toBe(false)
    expect(dag.getNode('F4')!.lastGoodBoundTo[ZMIN]).toEqual([ZMIN])
    expect(dag.getNode('F5')!.degraded).toBe(false)

    // Parameter edit removes the bottom face outright (no split, no
    // successor) -- ZMIN has no lineage AND no live geometric match.
    const deleteDelta: ElementMapDelta = { featureId: 'F1r', generated: [], modified: {}, deleted: [ZMIN] }
    applyFeatureDelta(map, deleteDelta)
    dag.regenerate(map)

    const f4 = dag.getNode('F4')!
    expect(f4.degraded).toBe(true)
    expect(f4.diagnostics.some((d) => d.code === 'REFERENCE_UNRESOLVED')).toBe(true)
    // Last-good body rule: the prior successful binding is retained, not wiped.
    expect(f4.lastGoodBoundTo[ZMIN]).toEqual([ZMIN])

    // F5 (downstream of the now-degraded F4) was still evaluated this same
    // pass -- its own ref (ZMAX, untouched) resolves normally.
    const f5 = dag.getNode('F5')!
    expect(f5.degraded).toBe(false)
    expect(f5.lastGoodBoundTo[ZMAX]).toEqual([ZMAX])
  })

  it('the degraded flag and last-good binding round-trip serialize()/restore()', () => {
    const map = new ElementMap()
    const dag = buildDag()
    applyFeatureDelta(map, boxDelta)
    dag.regenerate(map)
    applyFeatureDelta(map, { featureId: 'F1r', generated: [], modified: {}, deleted: [ZMIN] })
    dag.regenerate(map)

    expect(dag.getNode('F4')!.degraded).toBe(true)

    const json = dag.serialize()
    const restored = FeatureDag.restore(json)
    const f4 = restored.getNode('F4')!
    expect(f4.degraded).toBe(true)
    expect(f4.lastGoodBoundTo[ZMIN]).toEqual([ZMIN])
    expect(f4.diagnostics.some((d) => d.code === 'REFERENCE_UNRESOLVED')).toBe(true)
    expect(restored.serialize()).toBe(json)
  })
})
