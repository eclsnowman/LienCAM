// INT-17C Stage C1, step 2 (preflight extraction-order step 2): a direct unit
// test for the new, zero-call-sites-wired Placement seam, so the export is
// not dead code by the letter of the law. Wiring into real consumers is step
// 3 (separate commit) -- this file drives `src/lib/cam/modelItemPlacement.ts`
// directly, nothing else.

import { describe, it, expect } from 'vitest'
import {
  placementsFromGeometry,
  placementRegistry,
  resolveModelItemPlacement,
  ModelItemPlacementResolutionError,
  type ModelItemPlacement,
} from '../../lib/cam/modelItemPlacement'

describe('INT-17C Stage C1 step 2: resolveModelItemPlacement (identity-stub, per contract invariant 5)', () => {
  it('resolves a registered whole-item Placement (today always identity, per invariant 5)', () => {
    const placements = placementsFromGeometry([
      { id: 'modelbody:b1', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
    ])
    expect(resolveModelItemPlacement(placements, 'modelbody:b1')).toEqual({
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
    })
  })

  it('is the REAL function reading REAL state, not a hardcoded identity constant -- a non-identity record round-trips', () => {
    // Stage C1 ships no UI that writes a non-identity Placement, but the
    // function itself must not special-case identity (WO Stage C1 "Placement
    // seam": "it is not a fake stub returning a hardcoded identity constant").
    const placements = new Map<string, ModelItemPlacement>([
      ['moved-item', { modelItemId: 'moved-item', position: { x: 12, y: -4, z: 0.5 }, rotation: { x: 0, y: 0, z: 90 } }],
    ])
    expect(resolveModelItemPlacement(placements, 'moved-item')).toEqual({
      position: { x: 12, y: -4, z: 0.5 },
      rotation: { x: 0, y: 0, z: 90 },
    })
  })

  it('fails loud (invariant 4) for a modelItemId with no Placement record, never defaults to identity', () => {
    const placements = placementsFromGeometry([])
    expect(() => resolveModelItemPlacement(placements, 'unknown-item')).toThrow(
      ModelItemPlacementResolutionError,
    )
    expect(() => resolveModelItemPlacement(placements, 'unknown-item')).toThrow(/no Placement record/)
  })

  it('a bodyId with no body-filtered record falls back to the whole-item record (no body-filtered UI exists yet)', () => {
    const placements = placementsFromGeometry([
      { id: 'item-a', position: { x: 1, y: 2, z: 3 }, rotation: { x: 0, y: 0, z: 0 } },
    ])
    expect(resolveModelItemPlacement(placements, 'item-a', 'some-body')).toEqual({
      position: { x: 1, y: 2, z: 3 },
      rotation: { x: 0, y: 0, z: 0 },
    })
  })

  it('a body-filtered record, when present, is preferred over the whole-item record', () => {
    const placements = new Map<string, ModelItemPlacement>([
      ['item-a', { modelItemId: 'item-a', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }],
      ['item-a:body-1', { modelItemId: 'item-a', bodyId: 'body-1', position: { x: 5, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }],
    ])
    expect(resolveModelItemPlacement(placements, 'item-a', 'body-1')).toEqual({
      position: { x: 5, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
    })
    // The whole-item Placement is untouched and still resolvable without a bodyId.
    expect(resolveModelItemPlacement(placements, 'item-a')).toEqual({
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
    })
  })

  it('placementsFromGeometry never omits an entry for a row that is actually present ("every item HAS one")', () => {
    const placements = placementsFromGeometry([
      { id: 'b1', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
      { id: 'b2', position: { x: 4, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
    ])
    expect(() => resolveModelItemPlacement(placements, 'b1')).not.toThrow()
    expect(() => resolveModelItemPlacement(placements, 'b2')).not.toThrow()
  })
})

describe('INT-17C Stage C2: placementRegistry (builds the seam lookup from the REAL persisted Project.modelItemPlacements registry)', () => {
  it('keys a whole-item record (bodyId omitted) by modelItemId alone', () => {
    const placements = placementRegistry([
      { modelItemId: 'item-a', position: { x: 1, y: 2, z: 3 }, rotation: { x: 0, y: 0, z: 0 } },
    ])
    expect(resolveModelItemPlacement(placements, 'item-a')).toEqual({
      position: { x: 1, y: 2, z: 3 },
      rotation: { x: 0, y: 0, z: 0 },
    })
  })

  it('keys a body-filtered record by modelItemId+bodyId, preferred over a whole-item record for that body', () => {
    const placements = placementRegistry([
      { modelItemId: 'item-a', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
      { modelItemId: 'item-a', bodyId: 'b1', position: { x: 9, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
    ])
    expect(resolveModelItemPlacement(placements, 'item-a', 'b1')).toEqual({
      position: { x: 9, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
    })
    expect(resolveModelItemPlacement(placements, 'item-a')).toEqual({
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
    })
  })

  it('an empty registry resolves nothing -- fails loud, never a silent identity default', () => {
    const placements = placementRegistry([])
    expect(() => resolveModelItemPlacement(placements, 'item-a')).toThrow(
      ModelItemPlacementResolutionError,
    )
  })

  it('is independent of placementsFromGeometry -- two items with the SAME geometry-row-id-shaped key never collide', () => {
    // placementsFromGeometry keys by the geometry ROW's own id; placementRegistry
    // keys by modelItemId(+bodyId). Different key schemes, same Map type -- this
    // proves the real registry never accidentally resolves a Stage C1 stub value.
    const registry = placementRegistry([
      { modelItemId: 'real-item', position: { x: 7, y: 7, z: 7 }, rotation: { x: 0, y: 0, z: 0 } },
    ])
    expect(() => resolveModelItemPlacement(registry, 'modelbody:real-item')).toThrow(
      ModelItemPlacementResolutionError,
    )
  })
})
