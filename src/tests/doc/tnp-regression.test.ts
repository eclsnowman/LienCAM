import { describe, it, expect } from 'vitest'
import { ElementMap } from '../../doc/element-map'
import type { GeometrySnapshot } from '../../doc/element-map'
import {
  boxFaceId,
  edgeId,
  filletFaceId,
  chamferFaceId,
  mintBooleanFragments,
} from '../../doc/stable-id'
import type { ElementMapDelta } from '../../geom/geom-service'

// The canonical TNP (topological-naming-problem) regression scenarios from
// docs/stable-id-spec.md "Canonical TNP regression scenarios". Scenario #1 is a
// hard acceptance criterion (AC #5). Silent wrong-binding is the one unforgivable
// failure mode -- every scenario asserts the reference either survives correctly
// or DEGRADES to lost, never that it silently moved to the wrong face.

const delta = (p: Partial<ElementMapDelta> & { featureId: string }): ElementMapDelta => ({
  modified: {},
  generated: [],
  deleted: [],
  ...p,
})

const plane = (c: { x: number; y: number; z: number }, area: number): GeometrySnapshot => ({
  surfaceType: 'plane',
  centroid: c,
  area,
  normal: { x: 0, y: 0, z: 1 },
})

// The six faces of box F1 (a 10x10x10 block centered on the origin base).
const TOP = boxFaceId('F1', 'zmax')
const BOTTOM = boxFaceId('F1', 'zmin')
const XMAX = boxFaceId('F1', 'xmax')

/** F1: emit the six box faces. */
function box(): ElementMapDelta {
  return delta({
    featureId: 'F1',
    generated: [
      boxFaceId('F1', 'xmin'), XMAX,
      boxFaceId('F1', 'ymin'), boxFaceId('F1', 'ymax'),
      BOTTOM, TOP,
    ],
  })
}

/** F2: fillet the bottom/east edge -> retrims BOTTOM & XMAX, adds a band. TOP untouched. */
function filletBottomEdge(): ElementMapDelta {
  const band = filletFaceId('F2', edgeId(BOTTOM, XMAX))
  return delta({ featureId: 'F2', modified: { [BOTTOM]: [BOTTOM], [XMAX]: [XMAX] }, generated: [band] })
}

/** F4: chamfer the TOP/east edge -> retrims TOP & XMAX (same ids), adds a band. */
function chamferTopEdge(): ElementMapDelta {
  const band = chamferFaceId('F4', edgeId(TOP, XMAX))
  return delta({ featureId: 'F4', modified: { [TOP]: [TOP], [XMAX]: [XMAX] }, generated: [band] })
}

/** F3: cut a hole whose sketch plane is TOP -> retrims TOP (inner loop), adds bore faces. */
function cutHoleOnTop(): ElementMapDelta {
  return delta({ featureId: 'F3', modified: { [TOP]: [TOP] }, generated: ['F3:CUT:bore', 'F3:CUT:breakthrough'] })
}

describe('TNP scenario #1 -- insert a feature mid-history; downstream ref still resolves (AC #5)', () => {
  // The cut feature (F3) stores a reference to the TOP face as its sketch plane.
  it('original order (box -> fillet -> cut): the cut resolves to TOP exactly', () => {
    const m = new ElementMap()
    m.applyDelta(box()).applyDelta(filletBottomEdge()).applyDelta(cutHoleOnTop())
    expect(m.resolve(TOP, 'single-face')).toMatchObject({ status: 'exact', via: 'exact', boundTo: [TOP] })
  })

  it('chamfer INSERTED between fillet and cut (and touching TOP): the cut STILL resolves to TOP', () => {
    const m = new ElementMap()
    m.applyDelta(box())
      .applyDelta(filletBottomEdge())
      .applyDelta(chamferTopEdge()) // <-- inserted mid-history, retrims TOP
      .applyDelta(cutHoleOnTop())
    const r = m.resolve(TOP, 'single-face')
    expect(r.status).toBe('exact')
    expect(r.boundTo).toEqual([TOP]) // "hole still on top face"
    // The insertion genuinely changed the model (extra chamfer band) ...
    expect(m.liveIds()).toContain(chamferFaceId('F4', edgeId(TOP, XMAX)))
    // ... yet the downstream binding is byte-identical to the un-inserted build.
  })
})

describe('TNP scenario #2 -- delete a middle feature; downstream degrades or rebinds, never silently moves', () => {
  it('deleting the fillet loses a reference to its band face (degraded, not wrong-bound)', () => {
    const m = new ElementMap()
    const band = filletFaceId('F2', edgeId(BOTTOM, XMAX))
    m.applyDelta(box()).applyDelta(filletBottomEdge()).applyDelta(cutHoleOnTop())
    // A downstream feature had referenced the fillet band; now delete the fillet.
    m.applyDelta(delta({ featureId: 'F2-del', deleted: [band] }))
    const r = m.resolve(band, 'single-face')
    expect(r.status).toBe('lost')
    expect(r.diagnostics[0]?.code).toBe('REFERENCE_UNRESOLVED')
  })

  it('a reference to TOP (unaffected by the fillet) still resolves after the delete', () => {
    const m = new ElementMap()
    const band = filletFaceId('F2', edgeId(BOTTOM, XMAX))
    m.applyDelta(box()).applyDelta(filletBottomEdge()).applyDelta(cutHoleOnTop())
    m.applyDelta(delta({ featureId: 'F2-del', deleted: [band] }))
    expect(m.resolve(TOP, 'single-face').status).toBe('exact')
  })
})

describe('TNP scenario #3 -- a boolean splits a referenced face; face-set gets both, single-face picks the winner', () => {
  it('splits TOP into two fragments and binds by reference kind', () => {
    const m = new ElementMap()
    m.applyDelta(box(), { [TOP]: plane({ x: 0, y: 0, z: 10 }, 100) })
    // A boolean carves TOP into an east and a west fragment.
    const frags = mintBooleanFragments('F5', 'CUT', TOP, [
      { centroid: { x: 3, y: 0, z: 10 }, area: 50, orientation: { x: 0, y: 0, z: 1 }, shapeKey: 'east' },  // east
      { centroid: { x: -3, y: 0, z: 10 }, area: 50, orientation: { x: 0, y: 0, z: 1 }, shapeKey: 'west' }, // west
    ]).fragments
    const snaps: Record<string, GeometrySnapshot> = {}
    for (const f of frags) snaps[f.id] = plane(f.seed.centroid, 50)
    m.applyDelta(delta({ featureId: 'F5', modified: { [TOP]: frags.map((f) => f.id) } }), snaps)

    // Face-set reference (e.g. a color assignment) gets BOTH fragments.
    const setRes = m.resolve(TOP, 'face-set')
    expect(setRes.status).toBe('exact')
    expect(setRes.boundTo.sort()).toEqual(frags.map((f) => f.id).sort())

    // Single-face reference (a sketch plane) picks the overlap winner. The parent
    // TOP centroid is at x=0; the west fragment (x=-3) and east (x=3) are equal
    // distance, so make the parent lean: re-seat via a snapshot closer to west.
  })

  it('single-face split resolution picks the fragment nearest the parent geometry', () => {
    const m = new ElementMap()
    // Parent TOP centroid deliberately biased toward the east fragment.
    m.applyDelta(box(), { [TOP]: plane({ x: 2.5, y: 0, z: 10 }, 100) })
    const frags = mintBooleanFragments('F5', 'CUT', TOP, [
      { centroid: { x: 3, y: 0, z: 10 }, area: 50, orientation: { x: 0, y: 0, z: 1 }, shapeKey: 'east' },
      { centroid: { x: -3, y: 0, z: 10 }, area: 50, orientation: { x: 0, y: 0, z: 1 }, shapeKey: 'west' },
    ]).fragments
    const snaps: Record<string, GeometrySnapshot> = {}
    for (const f of frags) snaps[f.id] = plane(f.seed.centroid, 50)
    m.applyDelta(delta({ featureId: 'F5', modified: { [TOP]: frags.map((f) => f.id) } }), snaps)

    const eastId = frags.find((f) => f.seed.centroid.x === 3)!.id
    const r = m.resolve(TOP, 'single-face')
    expect(r.status).toBe('exact')
    expect(r.boundTo).toEqual([eastId])
  })
})

describe('TNP scenario #4 -- a parameter edit shrinks the part so a referenced face disappears', () => {
  it('the dependent reference degrades with REFERENCE_UNRESOLVED; the document stays healthy', () => {
    const m = new ElementMap()
    m.applyDelta(box())
    // Regeneration after a shrink: XMAX no longer exists and has no successor.
    m.applyDelta(delta({ featureId: 'F1-regen', deleted: [XMAX] }))
    const r = m.resolve(XMAX, 'single-face')
    expect(r.status).toBe('lost')
    expect(r.diagnostics[0]?.code).toBe('REFERENCE_UNRESOLVED')
    // Document integrity: every OTHER face is still resolvable.
    expect(m.resolve(TOP).status).toBe('exact')
    expect(m.resolve(BOTTOM).status).toBe('exact')
  })
})
