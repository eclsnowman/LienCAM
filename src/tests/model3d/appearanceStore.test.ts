// WO UI-4 acceptance #5: appearance-by-stable-id store. The decisive test
// reuses the SAME "modify keeps stable id" fixture shape
// src/tests/doc/tnp-regression.test.ts already established (fillet retrims
// two faces but each keeps its own id -- element-map.ts's own "self-edge"
// doc comment) -- proving colors survive a real ElementMap-level modify, and
// are cleaned up (never orphaned) when an id is truly deleted.

import { describe, it, expect } from 'vitest'
import { ElementMap } from '../../doc/element-map'
import { boxFaceId, edgeId, filletFaceId } from '../../doc/stable-id'
import type { ElementMapDelta } from '../../geom/geom-service'
import { AppearanceStore } from '../../components/model3d/appearance'

const delta = (p: Partial<ElementMapDelta> & { featureId: string }): ElementMapDelta => ({
  modified: {},
  generated: [],
  deleted: [],
  ...p,
})

const TOP = boxFaceId('F1', 'zmax')
const BOTTOM = boxFaceId('F1', 'zmin')
const XMAX = boxFaceId('F1', 'xmax')

function box(): ElementMapDelta {
  return delta({
    featureId: 'F1',
    generated: [boxFaceId('F1', 'xmin'), XMAX, boxFaceId('F1', 'ymin'), boxFaceId('F1', 'ymax'), BOTTOM, TOP],
  })
}

/** Same fixture as tnp-regression.test.ts's filletBottomEdge(): retrims
 *  BOTTOM & XMAX (each maps to itself -- the "self-edge" identity-preserving
 *  case), adds a new band face. TOP is untouched. */
function filletBottomEdge(): ElementMapDelta {
  const band = filletFaceId('F2', edgeId(BOTTOM, XMAX))
  return delta({ featureId: 'F2', modified: { [BOTTOM]: [BOTTOM], [XMAX]: [XMAX] }, generated: [band] })
}

describe('AppearanceStore basic set/clear', () => {
  it('sets and reads face and body colors independently', () => {
    const store = new AppearanceStore()
    store.setFaceColor('F1:BOX:zmax', [1, 0, 0])
    store.setBodyColor('bodyA', [0, 1, 0])
    expect(store.faceColor('F1:BOX:zmax')).toEqual([1, 0, 0])
    expect(store.bodyColor('bodyA')).toEqual([0, 1, 0])
    expect(store.faceColor('bodyA')).toBeUndefined()
  })

  it('notifies subscribers only on an actual change', () => {
    const store = new AppearanceStore()
    let notifications = 0
    const unsub = store.subscribe(() => notifications++)
    store.setFaceColor('F1', [1, 0, 0])
    expect(notifications).toBe(1)
    store.clearFaceColor('never-set')
    expect(notifications).toBe(1) // no-op clear doesn't notify
    store.clearFaceColor('F1')
    expect(notifications).toBe(2)
    unsub()
  })

  it('serialize/restore round-trips both maps', () => {
    const store = new AppearanceStore()
    store.setFaceColor('F1:BOX:zmax', [1, 0, 0])
    store.setBodyColor('bodyA', [0, 0.5, 1])
    const payload = store.serialize()

    const restored = new AppearanceStore()
    restored.restore(payload)
    expect(restored.faceColor('F1:BOX:zmax')).toEqual([1, 0, 0])
    expect(restored.bodyColor('bodyA')).toEqual([0, 0.5, 1])
  })
})

describe('AppearanceStore vs a real ElementMap regen (WO UI-4 acceptance #5 decisive test)', () => {
  it('a face color SURVIVES a modify that keeps the same stable id', () => {
    const map = new ElementMap()
    map.applyDelta(box())
    const appearance = new AppearanceStore()
    appearance.setFaceColor(TOP, [1, 0, 0])
    appearance.setFaceColor(BOTTOM, [0, 1, 0])

    // Fillet retrims BOTTOM/XMAX (self-mapped -- same identity survives);
    // TOP is untouched entirely.
    map.applyDelta(filletBottomEdge())

    const pruned = appearance.pruneDeleted((id) => map.isDeleted(id))
    expect(pruned).toEqual([])
    expect(appearance.faceColor(TOP)).toEqual([1, 0, 0])
    expect(appearance.faceColor(BOTTOM)).toEqual([0, 1, 0])
  })

  it('a face color is CLEANED UP, never orphaned to a wrong face, when its id is actually deleted', () => {
    const map = new ElementMap()
    map.applyDelta(box())
    const appearance = new AppearanceStore()
    appearance.setFaceColor(BOTTOM, [0, 1, 0])

    // A feature that consumes BOTTOM with no survivor (e.g. it's fully
    // removed by a later boolean) -- a genuine deletion, not a retrim.
    map.applyDelta(delta({ featureId: 'F9', deleted: [BOTTOM] }))

    const pruned = appearance.pruneDeleted((id) => map.isDeleted(id))
    expect(pruned).toEqual([BOTTOM])
    expect(appearance.faceColor(BOTTOM)).toBeUndefined()
    // Never silently reassigned to a different (wrong) face's color slot.
    expect(appearance.faceColor(TOP)).toBeUndefined()
  })
})
