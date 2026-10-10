// WO-1424: explodeNest bakes each placement onto the nest's surviving backing
// stock (boundStockId), UNLOCKED. The very next mutation re-sorts membership by
// AABB containment (assignStocks -> assignGeometryToStocks), which — before
// this fix — picked the SMALLEST-VOLUME container when a baked part's box was
// ALSO contained by some unrelated overlapping stock, silently overriding
// explode's own choice for that one placement (BUG-426).
//
// Reproduces the exact shape: a nest with a real bound backing stock (via the
// applyNestResult path, mirrors nestBoundStockLifecycle.test.ts), exploded into
// a scene that ALSO has a second, smaller, explicit stock whose bounds overlap
// only one placement's baked position.

import { describe, it, expect, beforeEach } from 'vitest'
import { useCamStore } from '../../store'
import type { ImportedGeometry, BoundingBox, Vec3, Loop2D, PhysicalStock } from '../../types'
import type { NestRecord } from '../../types'
import type { NestResult } from '../../lib/cam/nesting/types'

// -- Fixtures ------------------------------------------------------------------

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

function squareLoop(id: string, s: number): Loop2D {
  return {
    id, layerId: 'L', closed: true, type: 'contour', area: s * s,
    points: [
      { x: 0, y: 0 }, { x: s, y: 0 }, { x: s, y: s }, { x: 0, y: s },
    ],
  }
}

// An OWNED SEED geometry (ownerNestId set) — what a nest deep-copies and explodes.
function makeSeed(id: string, side: number, ownerNestId: string): ImportedGeometry {
  return {
    id, name: `Part ${id}`, filename: `${id}.dxf`, type: 'curves_2d', format: 'dxf',
    boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: side, y: side, z: 0 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    loops: [squareLoop(`${id}-outer`, side)],
    layers2d: [{ id: 'L', color: '#00e5ff', visible: true }],
    ownerNestId,
  } as ImportedGeometry
}

// A pre-existing, unrelated part (no ownerNestId) sitting far away from the
// nest's sheet — explode never produced it and must never claim it.
function makeUnrelatedPart(id: string, min: Vec3, max: Vec3): ImportedGeometry {
  const side = max.x - min.x
  return {
    id, name: `Part ${id}`, filename: `${id}.dxf`, type: 'curves_2d', format: 'dxf',
    boundingBox: bbox(min, max),
    position: { x: min.x, y: min.y, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    loops: [{
      id: `${id}-outer`, layerId: 'L', closed: true, type: 'contour', area: side * side,
      points: [{ x: 0, y: 0 }, { x: side, y: 0 }, { x: side, y: side }, { x: 0, y: side }],
    }],
    layers2d: [{ id: 'L', color: '#00e5ff', visible: true }],
  } as ImportedGeometry
}

function makeExplicitStock(
  id: string, position: Vec3, size: { x: number; y: number; z: number },
): PhysicalStock {
  return {
    id, name: id, mode: 'explicit',
    bounds: {
      min: { x: 0, y: 0, z: 0 }, max: { ...size },
      size: { ...size }, center: { x: size.x / 2, y: size.y / 2, z: size.z / 2 },
    },
    position,
  }
}

function makeNest(
  id: string, thickness: number, seedId: string, placements: NestRecord['placements'],
): NestRecord {
  return {
    id, name: `Nest ${id}`,
    sheet: { width: 100, height: 100 },
    style: 'arbitrary',
    spacing: { partGap: 1, sheetMargin: 1, windowGap: 1 },
    seed: 1,
    sources: [{ geometryId: seedId, quantity: placements.length }],
    placements,
    unplaced: [],
    utilization: 0.5,
    thickness,
  }
}

function installProject(geometry: ImportedGeometry[], nest: NestRecord, stocks: PhysicalStock[]): void {
  useCamStore.setState((s) => ({
    project: {
      ...s.project,
      geometry,
      geometryFolders: [],
      nests: [nest],
      setups: [],
      stocks,
      sceneStock: { ...s.project.sceneStock, fixedStocks: [] },
    },
    projectHistory: [],
    canUndo: false,
  }))
}

// Two placements of a 10x10 seed at non-overlapping X slots, sized to fit the
// nest's 100x100 sheet (mirrors nestBoundStockLifecycle.test.ts's `result`).
function packResult(count: number): NestResult {
  const placements = Array.from({ length: count }, (_, i) => ({
    partId: 'g1', instanceId: `g1#${i}`, x: i * 20, y: 0, rotationDeg: 0, depth: 0,
  }))
  return { placements, unplaced: [], utilization: 0.5, sheetUsed: { width: 100, height: 100 } }
}

beforeEach(() => {
  useCamStore.getState().newProject()
  useCamStore.setState((s) => ({
    appSettings: { ...s.appSettings, defaultStockPaddingXYMm: 5, defaultStockThicknessMm: 99 },
  }))
})

describe('explodeNest keeps backing-stock membership under an overlapping stock (WO-1424, BUG-426)', () => {
  it('every baked part is a member of the nest backing stock, even the one ambiguously contained by a smaller overlapping stock', () => {
    const placements: NestRecord['placements'] = [
      { partId: 'g1', instanceId: 'g1#0', x: 0, y: 0, rotationDeg: 0, depth: 0 },
      { partId: 'g1', instanceId: 'g1#1', x: 20, y: 0, rotationDeg: 0, depth: 0 },
    ]
    installProject([makeSeed('g1', 10, 'n1')], makeNest('n1', 12, 'g1', placements), [])
    useCamStore.getState().applyNestResult('n1', packResult(2))
    const boundStockId = useCamStore.getState().project.nests!.find((n) => n.id === 'n1')!.boundStockId!
    expect(boundStockId).toBeDefined()
    // Bound stock world bounds: position (-5,-5,0) .. (105,105,12) (100x100 sheet
    // + 5mm padding each side); placement 0's box (0..10,0..10) and placement
    // 1's box (20..30,0..10) both land well inside it.

    // A second, SMALLER explicit stock whose bounds overlap ONLY placement 1's
    // baked box — before the fix, containment's smallest-volume tie-break
    // silently reassigns placement 1's copy to this stock instead of the
    // nest's own bound stock.
    const otherStock = makeExplicitStock('stock-2', { x: 15, y: -5, z: 0 }, { x: 20, y: 20, z: 12 })
    useCamStore.setState((s) => ({
      project: { ...s.project, stocks: [...(s.project.stocks ?? []), otherStock] },
    }))

    useCamStore.getState().explodeNest('n1')
    const st = useCamStore.getState()

    const baked = st.project.geometry.filter((g) => g.ownerNestId === undefined)
    expect(baked.length).toBe(2)

    // Acceptance 1: EVERY baked part, including the ambiguous one, is a member
    // of the nest's backing stock — no per-placement divergence (acceptance 5).
    for (const g of baked) {
      expect(g.stockId).toBe(boundStockId)
      // Acceptance 3: still unlocked — a normal, future-re-homeable part.
      expect(g.stockIdLocked).not.toBe(true)
    }
  })

  it('leaves a pre-existing part that overlaps only the unrelated stock unaffected', () => {
    const placements: NestRecord['placements'] = [
      { partId: 'g1', instanceId: 'g1#0', x: 0, y: 0, rotationDeg: 0, depth: 0 },
    ]
    // The unrelated stock sits far away from the nest's sheet (150..170) so an
    // unrelated part contained by it is NOT also contained by the nest's own
    // bound stock (-5..105) — explode must not claim it either way.
    const unrelated = makeUnrelatedPart('other-part', { x: 152, y: 152, z: 0 }, { x: 160, y: 160, z: 0 })

    installProject([makeSeed('g1', 10, 'n1'), unrelated], makeNest('n1', 12, 'g1', placements), [])
    useCamStore.getState().applyNestResult('n1', packResult(1))

    // Add the unrelated stock AFTER applyNestResult (which re-syncs
    // project.stocks from sceneStock.fixedStocks via addFixedStock and would
    // otherwise drop a stock installed by hand up front).
    const farStock = makeExplicitStock('stock-far', { x: 150, y: 150, z: 0 }, { x: 20, y: 20, z: 12 })
    useCamStore.setState((s) => ({
      project: { ...s.project, stocks: [...(s.project.stocks ?? []), farStock] },
    }))

    useCamStore.getState().explodeNest('n1')
    const st = useCamStore.getState()

    const other = st.project.geometry.find((g) => g.id === 'other-part')!
    expect(other.stockId).toBe('stock-far')
  })

  it('the user can still explicitly re-home a baked part to a different stock afterward', () => {
    const placements: NestRecord['placements'] = [
      { partId: 'g1', instanceId: 'g1#0', x: 0, y: 0, rotationDeg: 0, depth: 0 },
    ]
    installProject([makeSeed('g1', 10, 'n1')], makeNest('n1', 12, 'g1', placements), [])
    useCamStore.getState().applyNestResult('n1', packResult(1))

    const otherStock = makeExplicitStock('stock-2', { x: -50, y: -50, z: 0 }, { x: 20, y: 20, z: 12 })
    useCamStore.setState((s) => ({
      project: { ...s.project, stocks: [...(s.project.stocks ?? []), otherStock] },
    }))

    useCamStore.getState().explodeNest('n1')
    const baked = useCamStore.getState().project.geometry.find((g) => g.ownerNestId === undefined)!

    useCamStore.getState().setStockMembership(baked.id, 'stock-2')
    const st = useCamStore.getState()
    const moved = st.project.geometry.find((g) => g.id === baked.id)!
    expect(moved.stockId).toBe('stock-2')
    expect(moved.stockIdLocked).toBe(true)
  })

  it('a single undo restores the pre-explode nest and stock membership exactly', () => {
    const placements: NestRecord['placements'] = [
      { partId: 'g1', instanceId: 'g1#0', x: 0, y: 0, rotationDeg: 0, depth: 0 },
      { partId: 'g1', instanceId: 'g1#1', x: 20, y: 0, rotationDeg: 0, depth: 0 },
    ]
    const otherStock = makeExplicitStock('stock-2', { x: 15, y: -5, z: 0 }, { x: 20, y: 20, z: 12 })
    installProject([makeSeed('g1', 10, 'n1')], makeNest('n1', 12, 'g1', placements), [otherStock])
    useCamStore.getState().applyNestResult('n1', packResult(2))
    const boundStockId = useCamStore.getState().project.nests!.find((n) => n.id === 'n1')!.boundStockId

    const preGeometry = useCamStore.getState().project.geometry
    const preNests = useCamStore.getState().project.nests

    useCamStore.getState().explodeNest('n1')
    useCamStore.getState().undo()
    const st = useCamStore.getState()

    expect(st.project.geometry).toEqual(preGeometry)
    expect(st.project.nests).toEqual(preNests)
    expect(st.project.nests!.find((n) => n.id === 'n1')!.boundStockId).toBe(boundStockId)
  })
})
