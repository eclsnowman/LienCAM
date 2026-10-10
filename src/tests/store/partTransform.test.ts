// Coordinate-hierarchy Phase 4 - Item 1: the world-placement seam.
//
// `partWorldTransform` is the single source of truth for a part's world
// (machine-frame) placement. Under Q1 = Option 1 (machine-absolute coords) it is
// the IDENTITY for BOTH derived and explicit members - the stored transform IS
// the world transform - so routing viewport placement through it is
// snapshot-identical to reading geo.position/geo.rotation directly.
//
// These tests pin that identity contract (so a future workspace tier / stored
// stock-relative model has a guard when it adds the compose step), and confirm
// the seam exists with the expected shape.

import { describe, it, expect } from 'vitest'
import { partWorldTransform } from '../../store/partTransform'
import type { ImportedGeometry, PhysicalStock, BoundingBox } from '../../types'

// -- Fixtures ------------------------------------------------------------------

function makeGeo(over: Partial<ImportedGeometry> = {}): ImportedGeometry {
  return {
    id: 'geo-1', name: 'Part', filename: 'part.stl', type: 'mesh', format: 'stl',
    boundingBox: {
      min: { x: -25, y: -25, z: 0 }, max: { x: 25, y: 25, z: 10 },
      size: { x: 50, y: 50, z: 10 }, center: { x: 0, y: 0, z: 5 },
    },
    position: { x: 12, y: -7, z: 3 },
    rotation: { x: 0, y: 0, z: 45 },
    loaded: true,
    ...over,
  }
}

/** Explicit PhysicalStock from a world min corner + size. */
function makeExplicitStock(id: string, pos = { x: 0, y: 0, z: 0 }, size = { x: 100, y: 100, z: 12 }): PhysicalStock {
  const bounds: BoundingBox = {
    min: { x: 0, y: 0, z: 0 }, max: size, size,
    center: { x: size.x / 2, y: size.y / 2, z: size.z / 2 },
  }
  return { id, name: id, mode: 'explicit', bounds, position: pos }
}

function makeDerivedStock(id = 'derived'): PhysicalStock {
  return {
    id, name: 'Stock', mode: 'derived',
    bounds: {
      min: { x: -27, y: -27, z: 0 }, max: { x: 27, y: 27, z: 10 },
      size: { x: 54, y: 54, z: 10 }, center: { x: 0, y: 0, z: 5 },
    },
    position: { x: 0, y: 0, z: 0 },
  }
}

// -- Tests ---------------------------------------------------------------------

describe('partWorldTransform (Phase 4 Item 1 world-placement seam)', () => {
  it('the seam exists and returns a {position, rotation} pair', () => {
    expect(typeof partWorldTransform).toBe('function')
    const out = partWorldTransform(makeGeo(), [])
    expect(out).toHaveProperty('position')
    expect(out).toHaveProperty('rotation')
  })

  it('DERIVED member returns its stored machine coords unchanged (identity)', () => {
    const geo = makeGeo({ stockId: 'derived' })
    const stocks = [makeDerivedStock('derived')]
    const out = partWorldTransform(geo, stocks)
    expect(out.position).toEqual(geo.position)
    expect(out.rotation).toEqual(geo.rotation)
  })

  it('EXPLICIT member returns its stored machine coords unchanged (identity under Option 1)', () => {
    const geo = makeGeo({ stockId: 'fixed-1', stockIdLocked: true })
    // Place the owning explicit stock somewhere non-trivial: the seam is the
    // identity, so the part's world transform must NOT depend on the stock.
    const stocks = [makeExplicitStock('fixed-1', { x: 200, y: 50, z: 0 })]
    const out = partWorldTransform(geo, stocks)
    expect(out.position).toEqual(geo.position)
    expect(out.rotation).toEqual(geo.rotation)
  })

  it('result is identical with no stocks vs many stocks (stocks is inert today)', () => {
    const geo = makeGeo({ stockId: 'fixed-1' })
    const none = partWorldTransform(geo, [])
    const many = partWorldTransform(geo, [
      makeDerivedStock('derived'),
      makeExplicitStock('fixed-1', { x: 200, y: 50, z: 0 }),
      makeExplicitStock('fixed-2', { x: -300, y: -90, z: 5 }),
    ])
    expect(none).toEqual(many)
  })

  it('does not mutate the input geometry transform', () => {
    const geo = makeGeo()
    const posBefore = { ...geo.position }
    const rotBefore = { ...geo.rotation }
    partWorldTransform(geo, [makeExplicitStock('s', { x: 9, y: 9, z: 9 })])
    expect(geo.position).toEqual(posBefore)
    expect(geo.rotation).toEqual(rotBefore)
  })
})
