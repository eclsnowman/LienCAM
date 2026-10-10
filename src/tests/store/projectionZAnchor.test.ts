// Symbolic Z-anchor (Item 4): resolveAnchoredZ + computeSceneStockBounds, and a
// store-level test that a stock-bounds change re-resolves a stock-top-anchored
// projection layer's origin.z while leaving an absolute / face layer (no anchor)
// untouched. See docs/planning/BREP-SECTION-FACESELECT-PLAN.md "Symbolic Z-anchor".

import { describe, it, expect, beforeEach } from 'vitest'
import { resolveAnchoredZ, computeSceneStockBounds } from '../../store/dispatchGeo'
import { useCamStore } from '../../store'
import type { ImportedGeometry, Layer2D, SceneStock, ProjectionPlane, Loop2D } from '../../types'

function makeSceneStock(over: Partial<SceneStock> = {}): SceneStock {
  return {
    mode: 'auto',
    autoOffsetXY: 5,
    autoOffsetZTop: 5,
    fixedWidth: 100,
    fixedHeight: 100,
    fixedDepth: 20,
    fixedStocks: [],
    ...over,
  }
}

function makeGeo(over: Partial<ImportedGeometry> = {}): ImportedGeometry {
  return {
    id: 'geo-1', name: 'Part', filename: 'part.step', type: 'brep', format: 'step',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 },
      size: { x: 10, y: 10, z: 10 }, center: { x: 5, y: 5, z: 5 },
    },
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
    ...over,
  }
}

describe('resolveAnchoredZ', () => {
  const sb = { min: { z: -3 }, max: { z: 17 } }

  it('returns null for an undefined anchor (caller keeps origin.z)', () => {
    expect(resolveAnchoredZ(undefined, sb)).toBeNull()
  })

  it('returns null for an absolute anchor', () => {
    expect(resolveAnchoredZ({ ref: 'absolute', offset: 0 }, sb)).toBeNull()
    expect(resolveAnchoredZ({ ref: 'absolute', offset: 4 }, sb)).toBeNull()
  })

  it('floor = 0 + offset, independent of stock bounds', () => {
    expect(resolveAnchoredZ({ ref: 'floor', offset: 0 }, sb)).toBe(0)
    expect(resolveAnchoredZ({ ref: 'floor', offset: 2.5 }, null)).toBe(2.5)
  })

  it('stock-top = max.z + offset', () => {
    expect(resolveAnchoredZ({ ref: 'stock-top', offset: 0 }, sb)).toBe(17)
    expect(resolveAnchoredZ({ ref: 'stock-top', offset: 1 }, sb)).toBe(18)
  })

  it('stock-bottom = min.z + offset', () => {
    expect(resolveAnchoredZ({ ref: 'stock-bottom', offset: 0 }, sb)).toBe(-3)
    expect(resolveAnchoredZ({ ref: 'stock-bottom', offset: -2 }, sb)).toBe(-5)
  })

  it('stock-relative with no bounds returns null (keep stored Z)', () => {
    expect(resolveAnchoredZ({ ref: 'stock-top', offset: 0 }, null)).toBeNull()
    expect(resolveAnchoredZ({ ref: 'stock-bottom', offset: 0 }, null)).toBeNull()
  })
})

describe('computeSceneStockBounds', () => {
  it('auto mode: padded box (top = maxZ + zTop, base = minZ)', () => {
    const ss = makeSceneStock({ autoOffsetXY: 5, autoOffsetZTop: 5 })
    const box = computeSceneStockBounds([makeGeo()], ss)
    expect(box).not.toBeNull()
    expect(box!.max.z).toBe(15) // 10 + 5
    expect(box!.min.z).toBe(0)
  })

  it('auto mode with no geometry returns null', () => {
    expect(computeSceneStockBounds([], makeSceneStock())).toBeNull()
  })

  it('fixed mode: union of the default block when none named', () => {
    const ss = makeSceneStock({ mode: 'fixed', fixedDepth: 20 })
    const box = computeSceneStockBounds([], ss)
    expect(box).not.toBeNull()
    expect(box!.min.z).toBe(0)
    expect(box!.max.z).toBe(20)
  })

  it('fixed mode: union of named blocks', () => {
    const ss = makeSceneStock({
      mode: 'fixed',
      fixedStocks: [
        { id: 'a', name: 'A', width: 10, height: 10, depth: 8, position: { x: 0, y: 0, z: 0 } },
        { id: 'b', name: 'B', width: 10, height: 10, depth: 5, position: { x: 0, y: 0, z: 12 } },
      ],
    })
    const box = computeSceneStockBounds([], ss)
    expect(box!.min.z).toBe(0)
    expect(box!.max.z).toBe(17) // block b top = 12 + 5
  })
})

describe('reanchorProjectionLayers (store)', () => {
  const baseProject = useCamStore.getState().project

  beforeEach(() => {
    // Reset to a clean known project before each case.
    useCamStore.setState({ project: { ...baseProject, geometry: [], sceneStock: makeSceneStock() } })
  })

  function loop(layerId: string): Loop2D {
    return {
      id: '', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }],
      closed: true, type: 'contour', area: 0.5, layerId,
    }
  }

  function plane(over: Partial<ProjectionPlane> = {}): ProjectionPlane {
    return {
      origin: { x: 0, y: 0, z: 15 },
      xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: 1, z: 0 },
      normal: { x: 0, y: 0, z: 1 },
      ...over,
    }
  }

  it('re-resolves a stock-top-anchored layer when stock grows, leaves absolute/face untouched', () => {
    // Geometry 10mm tall -> auto stock top = 10 + 5 = 15.
    useCamStore.setState((s) => ({
      project: { ...s.project, geometry: [makeGeo()] },
    }))

    const anchoredLayer: Layer2D = {
      id: 'L-top', name: 'STL Projection 1', color: '#fff', visible: true,
      projectionPlane: plane({ origin: { x: 0, y: 0, z: 15 }, zAnchor: { ref: 'stock-top', offset: 0 } }),
    }
    const faceLayer: Layer2D = {
      id: 'L-face', name: 'STL Projection 2', color: '#fff', visible: true,
      projectionPlane: plane({ origin: { x: 0, y: 0, z: 3 } }), // no zAnchor (face/absolute)
    }
    // Attach both layers + their loops directly to the geometry row.
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        geometry: s.project.geometry.map((g) =>
          g.id === 'geo-1'
            ? { ...g, layers2d: [anchoredLayer, faceLayer], loops: [loop('L-top'), loop('L-face')], loopsVersion: 0 }
            : g),
      },
    }))

    const geoBefore = useCamStore.getState().project.geometry.find((g) => g.id === 'geo-1')!
    expect(geoBefore.layers2d![0].projectionPlane!.origin.z).toBe(15)

    // Grow the stock top by raising the auto Z pad 5 -> 25 (top = 10 + 25 = 35).
    useCamStore.getState().updateSceneStock({ autoOffsetZTop: 25 })

    const geoAfter = useCamStore.getState().project.geometry.find((g) => g.id === 'geo-1')!
    const topLayer = geoAfter.layers2d!.find((l) => l.id === 'L-top')!
    const faceL = geoAfter.layers2d!.find((l) => l.id === 'L-face')!
    expect(topLayer.projectionPlane!.origin.z).toBe(35) // rode the stock up
    expect(faceL.projectionPlane!.origin.z).toBe(3)     // untouched (no anchor)
    expect(geoAfter.loopsVersion).toBeGreaterThan(geoBefore.loopsVersion ?? 0)
  })

  it('is a no-op (no loopsVersion bump) when nothing is stock-anchored', () => {
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        geometry: [{
          ...makeGeo(),
          layers2d: [{
            id: 'L-abs', name: 'P', color: '#fff', visible: true,
            projectionPlane: plane({ origin: { x: 0, y: 0, z: 3 } }),
          }],
          loops: [loop('L-abs')],
          loopsVersion: 7,
        }],
      },
    }))
    useCamStore.getState().reanchorProjectionLayers()
    const geo = useCamStore.getState().project.geometry.find((g) => g.id === 'geo-1')!
    expect(geo.loopsVersion).toBe(7) // unchanged
  })
})
