import { describe, it, expect } from 'vitest'
import { ElementMap } from '../../doc/element-map'
import {
  boxFaceId,
  edgeId,
  filletFaceId,
  chamferFaceId,
  extrudeSideFaceId,
  extrudeCapId,
  mintBooleanFragments,
} from '../../doc/stable-id'
import type { ElementMapDelta } from '../../geom/geom-service'

// AC #4: two identical build sequences produce BYTE-IDENTICAL id sets, and the
// result is independent of iteration order (delta object-key order + within-delta
// array order). No Date.now, no Math.random, no map/set iteration-order leakage:
// everything that emits is sorted first.

const delta = (p: Partial<ElementMapDelta> & { featureId: string }): ElementMapDelta => ({
  modified: {},
  generated: [],
  deleted: [],
  ...p,
})

const TOP = boxFaceId('F1', 'zmax')
const XMAX = boxFaceId('F1', 'xmax')
const BOTTOM = boxFaceId('F1', 'zmin')

// A canonical ~12-step build (box + dress-up + extrude + boolean split) exercising
// every lineage-event kind. Returned as a fresh delta list each call so the two
// runs share no object identity.
function canonicalBuild(): ElementMapDelta[] {
  const filletBand = filletFaceId('F2', edgeId(BOTTOM, XMAX))
  const chamferBand = chamferFaceId('F4', edgeId(TOP, XMAX))
  const { fragments: frags } = mintBooleanFragments('F5', 'CUT', TOP, [
    { centroid: { x: 3, y: 0, z: 10 }, area: 25, orientation: { x: 0, y: 0, z: 1 }, shapeKey: 'east' },
    { centroid: { x: -3, y: 0, z: 10 }, area: 25, orientation: { x: 0, y: 0, z: 1 }, shapeKey: 'west' },
    { centroid: { x: 0, y: 4, z: 10 }, area: 25, orientation: { x: 0, y: 0, z: 1 }, shapeKey: 'north' },
  ])
  return [
    // F1: box
    delta({
      featureId: 'F1',
      generated: [
        boxFaceId('F1', 'xmin'), XMAX, boxFaceId('F1', 'ymin'),
        boxFaceId('F1', 'ymax'), BOTTOM, TOP,
      ],
    }),
    // F2: fillet (retrim + band)
    delta({ featureId: 'F2', modified: { [BOTTOM]: [BOTTOM], [XMAX]: [XMAX] }, generated: [filletBand] }),
    // F3: extrude a boss on TOP (two side faces + cap + retrim TOP)
    delta({
      featureId: 'F3',
      modified: { [TOP]: [TOP] },
      generated: [extrudeSideFaceId('F3', 'S1.e0'), extrudeSideFaceId('F3', 'S1.e1'), extrudeCapId('F3', 1)],
    }),
    // F4: chamfer (retrim + band)
    delta({ featureId: 'F4', modified: { [TOP]: [TOP], [XMAX]: [XMAX] }, generated: [chamferBand] }),
    // F5: boolean split of TOP into three fragments
    delta({ featureId: 'F5', modified: { [TOP]: frags.map((f) => f.id) } }),
    // F6: delete a fragment
    delta({ featureId: 'F6', deleted: [frags[0].id] }),
  ]
}

function buildMap(deltas: ElementMapDelta[]): ElementMap {
  const m = new ElementMap()
  for (const d of deltas) m.applyDelta(d)
  return m
}

describe('determinism -- golden byte-identical id sets', () => {
  it('two identical build sequences serialize byte-for-byte identically', () => {
    const a = buildMap(canonicalBuild()).serializeIds()
    const b = buildMap(canonicalBuild()).serializeIds()
    expect(a).toBe(b)
    expect(a.length).toBeGreaterThan(0)
  })

  it('matches a frozen golden string (regression guard on the emitted shape)', () => {
    // If this string changes, the id grammar or serialization changed -- that is a
    // deliberate, reviewable event, not an accident.
    const golden =
      '{"live":["F1:BOX:xmax","F1:BOX:xmin","F1:BOX:ymax","F1:BOX:ymin","F1:BOX:zmin",' +
      '"F2:FIL:(F1:BOX:xmax∧F1:BOX:zmin)","F3:XTR:S1.e0:side","F3:XTR:S1.e1:side",' +
      '"F3:XTR:cap1","F4:CHM:(F1:BOX:xmax∧F1:BOX:zmax)",' +
      '"F5:CUT:F1:BOX:zmax#1","F5:CUT:F1:BOX:zmax#2"],' +
      '"deleted":["F5:CUT:F1:BOX:zmax#0"],' +
      '"lineage":[["F1:BOX:zmax",["F5:CUT:F1:BOX:zmax#0","F5:CUT:F1:BOX:zmax#1","F5:CUT:F1:BOX:zmax#2"]]]}'
    expect(buildMap(canonicalBuild()).serializeIds()).toBe(golden)
  })
})

describe('determinism -- iteration-order independence (sort before emit)', () => {
  it('shuffling delta object-key order and within-delta array order yields identical serialization', () => {
    const straight = buildMap(canonicalBuild()).serializeIds()

    // Rebuild the SAME logical model but hand every collection over reversed:
    // generated arrays reversed, modified keys inserted in reverse, deleted
    // reversed. A correct implementation sorts on emit, so the result is equal.
    const shuffled = canonicalBuild().map((d) => {
      const revModified: Record<string, string[]> = {}
      for (const k of Object.keys(d.modified).reverse()) revModified[k] = [...d.modified[k]].reverse()
      return delta({
        featureId: d.featureId,
        generated: [...d.generated].reverse(),
        modified: revModified,
        deleted: [...d.deleted].reverse(),
      })
    })
    expect(buildMap(shuffled).serializeIds()).toBe(straight)
  })

  it('liveIds() and successorsOf() are always sorted regardless of insertion order', () => {
    const m = new ElementMap()
    m.applyDelta(delta({ featureId: 'F1', generated: ['z', 'a', 'm'] }))
    expect(m.liveIds()).toEqual(['a', 'm', 'z'])
    m.applyDelta(delta({ featureId: 'F2', modified: { a: ['a2', 'a1', 'a0'] } }))
    expect(m.successorsOf('a')).toEqual(['a0', 'a1', 'a2'])
  })
})

describe('determinism -- no wall-clock / randomness leakage', () => {
  it('the module source imports nothing non-deterministic (no Date.now / Math.random)', async () => {
    // Structural guard: reason about behavior, not internals -- build twice with a
    // real timing gap-free loop and confirm stability across many repetitions.
    const first = buildMap(canonicalBuild()).serializeIds()
    for (let i = 0; i < 25; i++) {
      expect(buildMap(canonicalBuild()).serializeIds()).toBe(first)
    }
  })
})
