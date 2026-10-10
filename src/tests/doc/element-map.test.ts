import { describe, it, expect } from 'vitest'
import { ElementMap } from '../../doc/element-map'
import type { DeltaSnapshots, GeometrySnapshot } from '../../doc/element-map'
import { applyFeatureDelta } from '../../doc/replay'
import type { ElementMapDelta } from '../../geom/geom-service'

// AC #2 (delta application: created/modified/deleted/split/merged) and AC #3
// (resolution: all 4 steps, each distinguishable by a typed result).

const delta = (partial: Partial<ElementMapDelta> & { featureId: string }): ElementMapDelta => ({
  modified: {},
  generated: [],
  deleted: [],
  ...partial,
})

const planarSnap = (centroid: { x: number; y: number; z: number }, area: number, normal = { x: 0, y: 0, z: 1 }): GeometrySnapshot => ({
  surfaceType: 'plane',
  centroid,
  area,
  normal,
})

const cylSnap = (centroid: { x: number; y: number; z: number }, area: number, axis: { x: number; y: number; z: number }): GeometrySnapshot => ({
  surfaceType: 'cylinder',
  centroid,
  area,
  axis,
})

describe('ElementMap.applyDelta', () => {
  it('created: generated ids become live', () => {
    const m = new ElementMap()
    m.applyDelta(delta({ featureId: 'F1', generated: ['a', 'b', 'c'] }))
    expect(m.liveIds()).toEqual(['a', 'b', 'c'])
    expect(m.has('a')).toBe(true)
  })

  it('deleted: an input with no survivor leaves the live set and is marked deleted', () => {
    const m = new ElementMap()
    m.applyDelta(delta({ featureId: 'F1', generated: ['a', 'b'] }))
    m.applyDelta(delta({ featureId: 'F2', deleted: ['b'] }))
    expect(m.liveIds()).toEqual(['a'])
    expect(m.has('b')).toBe(false)
    expect(m.isDeleted('b')).toBe(true)
  })

  it('modified (retrim, same id): parent maps to itself and stays live', () => {
    const m = new ElementMap()
    m.applyDelta(delta({ featureId: 'F1', generated: ['top'] }))
    m.applyDelta(delta({ featureId: 'F2', modified: { top: ['top'] } }))
    expect(m.has('top')).toBe(true)
    // A self-retrim is not recorded as a lineage edge (it would be a self loop).
    expect(m.successorsOf('top')).toEqual([])
  })

  it('modified (rename): parent leaves the live set, child is live + lineage recorded', () => {
    const m = new ElementMap()
    m.applyDelta(delta({ featureId: 'F1', generated: ['old'] }))
    m.applyDelta(delta({ featureId: 'F2', modified: { old: ['new'] } }))
    expect(m.has('old')).toBe(false)
    expect(m.has('new')).toBe(true)
    expect(m.successorsOf('old')).toEqual(['new'])
  })

  it('split: one parent -> many children; all children live, parent gone', () => {
    const m = new ElementMap()
    m.applyDelta(delta({ featureId: 'F1', generated: ['face'] }))
    m.applyDelta(delta({ featureId: 'F2', modified: { face: ['face#0', 'face#1'] } }))
    expect(m.has('face')).toBe(false)
    expect(m.liveIds()).toEqual(['face#0', 'face#1'])
    expect(m.successorsOf('face')).toEqual(['face#0', 'face#1'])
  })

  it('merge: many parents -> one shared child (both old ids leave, child is live)', () => {
    const m = new ElementMap()
    m.applyDelta(delta({ featureId: 'F1', generated: ['a', 'b'] }))
    m.applyDelta(delta({ featureId: 'F2', modified: { a: ['merged'], b: ['merged'] } }))
    expect(m.has('a')).toBe(false)
    expect(m.has('b')).toBe(false)
    expect(m.liveIds()).toEqual(['merged'])
    expect(m.successorsOf('a')).toEqual(['merged'])
    expect(m.successorsOf('b')).toEqual(['merged'])
  })
})

describe('ElementMap.resolve -- the 4 steps, each a typed, distinguishable result', () => {
  it('step 1 exact: a live id resolves via "exact"', () => {
    const m = new ElementMap()
    m.applyDelta(delta({ featureId: 'F1', generated: ['top'] }))
    const r = m.resolve('top')
    expect(r).toMatchObject({ status: 'exact', via: 'exact', boundTo: ['top'] })
    expect(r.diagnostics).toEqual([])
  })

  it('step 2 lineage: a renamed id binds to its single survivor via "lineage"', () => {
    const m = new ElementMap()
    m.applyDelta(delta({ featureId: 'F1', generated: ['old'] }))
    m.applyDelta(delta({ featureId: 'F2', modified: { old: ['new'] } }))
    const r = m.resolve('old')
    expect(r).toMatchObject({ status: 'exact', via: 'lineage', boundTo: ['new'] })
  })

  it('step 2 lineage across a chain (a->b->c) binds to the deepest live survivor', () => {
    const m = new ElementMap()
    m.applyDelta(delta({ featureId: 'F1', generated: ['a'] }))
    m.applyDelta(delta({ featureId: 'F2', modified: { a: ['b'] } }))
    m.applyDelta(delta({ featureId: 'F3', modified: { b: ['c'] } }))
    expect(m.resolve('a')).toMatchObject({ status: 'exact', via: 'lineage', boundTo: ['c'] })
  })

  it('step 2 split, face-set kind: binds to ALL fragments', () => {
    const m = new ElementMap()
    m.applyDelta(delta({ featureId: 'F1', generated: ['face'] }))
    m.applyDelta(delta({ featureId: 'F2', modified: { face: ['face#0', 'face#1'] } }))
    const r = m.resolve('face', 'face-set')
    expect(r).toMatchObject({ status: 'exact', via: 'lineage', boundTo: ['face#0', 'face#1'] })
  })

  it('step 2 split, single-face kind: picks the max-overlap (nearest-centroid) fragment', () => {
    const m = new ElementMap()
    const snaps = {
      face: planarSnap({ x: 0, y: 0, z: 10 }, 100),
      'face#0': planarSnap({ x: -3, y: 0, z: 10 }, 40),
      'face#1': planarSnap({ x: 0.2, y: 0, z: 10 }, 60), // nearest the parent centroid
    }
    m.applyDelta(delta({ featureId: 'F1', generated: ['face'] }), { face: snaps.face })
    m.applyDelta(
      delta({ featureId: 'F2', modified: { face: ['face#0', 'face#1'] } }),
      { 'face#0': snaps['face#0'], 'face#1': snaps['face#1'] },
    )
    const r = m.resolve('face', 'single-face')
    expect(r).toMatchObject({ status: 'exact', via: 'lineage', boundTo: ['face#1'] })
  })

  it('step 2 split, single-face kind with NO snapshot: degrades to lost (never guesses)', () => {
    const m = new ElementMap()
    m.applyDelta(delta({ featureId: 'F1', generated: ['face'] }))
    m.applyDelta(delta({ featureId: 'F2', modified: { face: ['face#0', 'face#1'] } }))
    const r = m.resolve('face', 'single-face')
    expect(r.status).toBe('lost')
    expect(r.diagnostics[0]?.code).toBe('REFERENCE_UNRESOLVED')
  })

  it('step 3 geometric fallback: no lineage path, unique snapshot match -> "fallback" + warning', () => {
    const m = new ElementMap()
    // The referenced id is gone (deleted, no lineage), but a geometrically-equal
    // live face exists (e.g. the feature was reordered and rebuilt fresh).
    m.applyDelta(
      delta({ featureId: 'F1', generated: ['ghost'] }),
      { ghost: planarSnap({ x: 0, y: 0, z: 5 }, 50) },
    )
    m.applyDelta(delta({ featureId: 'F2', deleted: ['ghost'] }))
    m.applyDelta(
      delta({ featureId: 'F3', generated: ['fresh', 'far'] }),
      {
        fresh: planarSnap({ x: 0.01, y: 0, z: 5 }, 51), // within tolerance of ghost
        far: planarSnap({ x: 900, y: 900, z: 900 }, 50),
      },
    )
    const r = m.resolve('ghost')
    expect(r).toMatchObject({ status: 'fallback', via: 'geometric', boundTo: ['fresh'] })
    expect(r.diagnostics[0]?.code).toBe('REFERENCE_FALLBACK')
    expect(r.diagnostics[0]?.severity).toBe('warning')
  })

  it('step 3 ambiguous: two equally-good candidates -> does NOT guess, returns lost', () => {
    const m = new ElementMap({ bboxDiag: 1000 })
    m.applyDelta(
      delta({ featureId: 'F1', generated: ['ghost'] }),
      { ghost: planarSnap({ x: 0, y: 0, z: 5 }, 50) },
    )
    m.applyDelta(delta({ featureId: 'F2', deleted: ['ghost'] }))
    m.applyDelta(
      delta({ featureId: 'F3', generated: ['twinA', 'twinB'] }),
      {
        twinA: planarSnap({ x: 0.1, y: 0, z: 5 }, 50),
        twinB: planarSnap({ x: -0.1, y: 0, z: 5 }, 50),
      },
    )
    expect(m.resolve('ghost').status).toBe('lost')
  })

  it('step 4 lost: an id never seen resolves lost with REFERENCE_UNRESOLVED', () => {
    const m = new ElementMap()
    m.applyDelta(delta({ featureId: 'F1', generated: ['a'] }))
    const r = m.resolve('does-not-exist')
    expect(r).toMatchObject({ status: 'lost', via: 'none', boundTo: [] })
    expect(r.diagnostics[0]?.code).toBe('REFERENCE_UNRESOLVED')
    expect(r.diagnostics[0]?.severity).toBe('error')
  })

  it('a deleted id with no fallback snapshot degrades to lost, not exact', () => {
    const m = new ElementMap()
    m.applyDelta(delta({ featureId: 'F1', generated: ['a'] }))
    m.applyDelta(delta({ featureId: 'F2', deleted: ['a'] }))
    expect(m.resolve('a').status).toBe('lost')
  })
})

describe('ElementMap.resolve -- geometric fallback axis alignment (cylinder/cone/torus)', () => {
  // Regression for the DOC-1-R1 major: the geometric fallback must not silently
  // wrong-bind two similar-centroid/area cylindrical faces of DIFFERENT axis
  // direction (e.g. two same-diameter bores drilled along different axes).

  it('does NOT wrong-bind a differently-ORIENTED cylinder (axis check rejects it)', () => {
    const m = new ElementMap({ bboxDiag: 1000 }) // tol = 5mm
    m.applyDelta(
      delta({ featureId: 'F1', generated: ['bore'] }),
      { bore: cylSnap({ x: 0, y: 0, z: 0 }, 50, { x: 0, y: 0, z: 1 }) },
    )
    m.applyDelta(delta({ featureId: 'F2', deleted: ['bore'] }))
    // Same diameter/area, near-same centroid, but drilled along X, not Z.
    m.applyDelta(
      delta({ featureId: 'F3', generated: ['crossbore'] }),
      { crossbore: cylSnap({ x: 0.01, y: 0, z: 0 }, 50, { x: 1, y: 0, z: 0 }) },
    )
    // Before the fix this bound to crossbore ('fallback'); now it degrades.
    expect(m.resolve('bore').status).toBe('lost')
  })

  it('still binds a correctly-ALIGNED cylinder via geometric fallback', () => {
    const m = new ElementMap({ bboxDiag: 1000 })
    m.applyDelta(
      delta({ featureId: 'F1', generated: ['bore'] }),
      { bore: cylSnap({ x: 0, y: 0, z: 0 }, 50, { x: 0, y: 0, z: 1 }) },
    )
    m.applyDelta(delta({ featureId: 'F2', deleted: ['bore'] }))
    m.applyDelta(
      delta({ featureId: 'F3', generated: ['rebuilt'] }),
      { rebuilt: cylSnap({ x: 0.01, y: 0, z: 0 }, 51, { x: 0, y: 0, z: 1 }) },
    )
    expect(m.resolve('bore')).toMatchObject({ status: 'fallback', via: 'geometric', boundTo: ['rebuilt'] })
  })

  it('treats an ANTI-PARALLEL (sign-flipped) cylinder axis as aligned (axis is an undirected line)', () => {
    const m = new ElementMap({ bboxDiag: 1000 })
    m.applyDelta(
      delta({ featureId: 'F1', generated: ['bore'] }),
      { bore: cylSnap({ x: 0, y: 0, z: 0 }, 50, { x: 0, y: 0, z: 1 }) },
    )
    m.applyDelta(delta({ featureId: 'F2', deleted: ['bore'] }))
    // Same physical bore re-derived with a negated axis vector -> must still bind.
    m.applyDelta(
      delta({ featureId: 'F3', generated: ['reparam'] }),
      { reparam: cylSnap({ x: 0.01, y: 0, z: 0 }, 50, { x: 0, y: 0, z: -1 }) },
    )
    expect(m.resolve('bore').status).toBe('fallback')
  })

  it('does NOT bind an axial-surface candidate that is MISSING an axis (cannot verify -> do not guess)', () => {
    const m = new ElementMap({ bboxDiag: 1000 })
    m.applyDelta(
      delta({ featureId: 'F1', generated: ['bore'] }),
      { bore: cylSnap({ x: 0, y: 0, z: 0 }, 50, { x: 0, y: 0, z: 1 }) },
    )
    m.applyDelta(delta({ featureId: 'F2', deleted: ['bore'] }))
    m.applyDelta(
      delta({ featureId: 'F3', generated: ['noaxis'] }),
      { noaxis: { surfaceType: 'cylinder', centroid: { x: 0.01, y: 0, z: 0 }, area: 50 } },
    )
    expect(m.resolve('bore').status).toBe('lost')
  })
})

// BK-16a (WO DOC-5 ruling 3): ElementMap.applyDelta must default to the delta's
// OWN inline geometry (ICR-1) when no companion snapshot map is passed. Before
// the fix, only replay.applyFeatureDelta folded inline geometry into the
// companion argument, so a DIRECT applyDelta caller shipping a post-GEO-2 delta
// (inline geometry, no side channel) silently dropped every snapshot.
describe('BK-16a: applyDelta defaults to inline delta.geometry when no companion map is passed', () => {
  const inlineDelta: ElementMapDelta = {
    featureId: 'F1',
    generated: ['top'],
    modified: {},
    deleted: [],
    geometry: { top: planarSnap({ x: 0, y: 0, z: 10 }, 100) },
  }

  it('FAILS-IF (pre-fix): a direct applyDelta with inline geometry and no companion retains the snapshot', () => {
    const m = new ElementMap()
    m.applyDelta(inlineDelta) // no companion map -- pre-fix this dropped delta.geometry
    // Pre-fix behavior returned undefined here, failing this assertion.
    expect(m.snapshotOf('top')).toEqual(inlineDelta.geometry!.top)
  })

  it('a direct applyDelta STILL prefers an explicit companion map over inline geometry (companion is authoritative when present)', () => {
    // applyDelta's own contract is unchanged: an explicitly-passed companion map
    // wins. The inline-vs-companion MERGE (inline wins) lives one layer up in
    // replay.applyFeatureDelta, which always hands applyDelta the already-merged
    // map -- so this direct path stays exactly as it was.
    const companion: DeltaSnapshots = { top: planarSnap({ x: 5, y: 5, z: 10 }, 40) }
    const m = new ElementMap()
    m.applyDelta(inlineDelta, companion)
    expect(m.snapshotOf('top')).toEqual(companion.top)
  })

  it('REGRESSION: applyFeatureDelta behavior is unchanged -- inline geometry lands, and inline wins over a disagreeing companion', () => {
    // Inline-only through the replay seam: snapshot present (as before the fix).
    const m1 = new ElementMap()
    applyFeatureDelta(m1, inlineDelta)
    expect(m1.snapshotOf('top')).toEqual(inlineDelta.geometry!.top)

    // Inline + a disagreeing companion through the replay seam: inline still wins
    // (ICR-1), exactly as it did before this WO touched applyDelta.
    const disagreeing: DeltaSnapshots = { top: planarSnap({ x: 5, y: 5, z: 10 }, 40) }
    const m2 = new ElementMap()
    applyFeatureDelta(m2, inlineDelta, disagreeing)
    expect(m2.snapshotOf('top')).toEqual(inlineDelta.geometry!.top)
  })
})
