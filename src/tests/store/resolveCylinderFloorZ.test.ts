// Unit coverage for resolveCylinderFloorZ (src/store/dispatchGeo.ts): the pure
// "cut floor from cylinder-derived loops" lookup behind the recompute-time smart
// cut-floor heal. Scans every layer's cylinder features, keeps those whose loopId
// is in the op's selection AND whose kind is 'boss' or 'bore', and returns the
// MIN bottomZ (the deepest base = the floor to reach), or undefined when none
// match. Model-local Z (the same frame selectedFaceZ is stored in).

import { describe, it, expect } from 'vitest'
import { resolveCylinderFloorZ } from '../../store/dispatchGeo'
import type { Layer2D, CylinderFeature } from '../../types'

function cyl(over: Partial<CylinderFeature> = {}): CylinderFeature {
  return {
    center: [0, 0], diameter: 10, topZ: 30, bottomZ: 10, through: false,
    kind: 'boss', ...over,
  }
}

function layer(cylinders: CylinderFeature[], over: Partial<Layer2D> = {}): Layer2D {
  return { id: 'L1', name: 'Cylinder (1)', color: '#00e5ff', visible: true, cylinders, ...over }
}

describe('resolveCylinderFloorZ (cylinder-derived cut floor)', () => {
  it('a boss whose loopId is selected -> its bottomZ', () => {
    const geo = { layers2d: [layer([cyl({ loopId: 'loop-a', bottomZ: 22 })])] }
    expect(resolveCylinderFloorZ(geo, ['loop-a'])).toBe(22)
  })

  it('a bore whose loopId is selected -> its bottomZ', () => {
    const geo = { layers2d: [layer([cyl({ kind: 'bore', loopId: 'loop-b', bottomZ: 5 })])] }
    expect(resolveCylinderFloorZ(geo, ['loop-b'])).toBe(5)
  })

  it('multiple matching cylinders -> the MIN (deepest) bottomZ', () => {
    const geo = {
      layers2d: [layer([
        cyl({ loopId: 'loop-a', bottomZ: 22 }),
        cyl({ kind: 'bore', loopId: 'loop-b', bottomZ: 8 }),
        cyl({ loopId: 'loop-c', bottomZ: 30 }),
      ])],
    }
    expect(resolveCylinderFloorZ(geo, ['loop-a', 'loop-b', 'loop-c'])).toBe(8)
  })

  it('only selected loopIds count (an unselected deeper cylinder is ignored)', () => {
    const geo = {
      layers2d: [layer([
        cyl({ loopId: 'loop-a', bottomZ: 22 }),
        cyl({ loopId: 'loop-deep', bottomZ: -5 }),
      ])],
    }
    expect(resolveCylinderFloorZ(geo, ['loop-a'])).toBe(22)
  })

  it('spans multiple layers -> min across all matching', () => {
    const geo = {
      layers2d: [
        layer([cyl({ loopId: 'loop-a', bottomZ: 22 })], { id: 'L1' }),
        layer([cyl({ kind: 'bore', loopId: 'loop-b', bottomZ: 3 })], { id: 'L2' }),
      ],
    }
    expect(resolveCylinderFloorZ(geo, ['loop-a', 'loop-b'])).toBe(3)
  })

  it('no loopId match -> undefined', () => {
    const geo = { layers2d: [layer([cyl({ loopId: 'loop-a', bottomZ: 22 })])] }
    expect(resolveCylinderFloorZ(geo, ['loop-other'])).toBeUndefined()
  })

  it('empty loopIds -> undefined', () => {
    const geo = { layers2d: [layer([cyl({ loopId: 'loop-a', bottomZ: 22 })])] }
    expect(resolveCylinderFloorZ(geo, [])).toBeUndefined()
  })

  it('non-cylinder layers (no cylinders array) are ignored -> undefined', () => {
    const geo = {
      layers2d: [{ id: 'L1', name: 'Plain', color: '#fff', visible: true } as Layer2D],
    }
    expect(resolveCylinderFloorZ(geo, ['loop-a'])).toBeUndefined()
  })

  it('a cylinder with no loopId is skipped even when present', () => {
    const geo = { layers2d: [layer([cyl({ loopId: undefined, bottomZ: 22 })])] }
    expect(resolveCylinderFloorZ(geo, ['loop-a'])).toBeUndefined()
  })

  it('no layers2d at all -> undefined', () => {
    expect(resolveCylinderFloorZ({}, ['loop-a'])).toBeUndefined()
  })
})
