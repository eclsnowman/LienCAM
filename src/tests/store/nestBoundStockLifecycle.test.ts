// N1d Item 6 (decision D2): bound-stock lifecycle on nest DELETE vs EXPLODE.
//
//  - removeNest: deleting a nest that has a bound fixed stock (record.boundStockId,
//    auto-created by applyNestResult) ALSO removes that stock from BOTH
//    sceneStock.fixedStocks AND project.stocks (the explicit twin), in ONE undo.
//    A single undo restores the nest AND its bound stock together.
//  - explodeNest: exploding KEEPS the bound fixed stock (it becomes a normal fixed
//    stock) and the baked exploded parts become its members (stockId === the former
//    boundStockId), unlocked (normal editable parts).
//
// Mirrors nestBoundStock.test.ts (apply path) + explodeNest.test.ts (bake path).

import { describe, it, expect, beforeEach } from 'vitest'
import { useCamStore } from '../../store'
import type { ImportedGeometry, BoundingBox, Vec3, Loop2D } from '../../types'
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

// A ready NestRecord (no bound stock yet); applyNestResult binds one.
function makeNest(
  id: string, thickness: number,
  seedId: string, placements: NestRecord['placements'],
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

function installProject(geometry: ImportedGeometry[], nest: NestRecord): void {
  // Keep s.project.stocks (the default derived/catch-all PhysicalStock from
  // newProject) so addFixedStock — invoked by applyNestResult — actually mints
  // the bound stock's EXPLICIT twin in project.stocks (syncFixedStocksToPhysical
  // returns undefined when existing stocks are undefined, so a forced-undefined
  // stocks would never create a twin to later assert on).
  useCamStore.setState((s) => ({
    project: {
      ...s.project,
      geometry,
      geometryFolders: [],
      nests: [nest],
      setups: [],
      sceneStock: { ...s.project.sceneStock, fixedStocks: [] },
    },
    projectHistory: [],
    canUndo: false,
  }))
}

// A synthetic successful pack result. applyNestResult OVERWRITES the record's
// placements with result.placements, so the count here drives explode's bake
// count. `count` placements of the owned seed 'g1' at non-overlapping x slots.
function result(width: number, height: number, count = 1): NestResult {
  const placements = Array.from({ length: count }, (_, i) => ({
    partId: 'g1', instanceId: `g1#${i}`, x: i * 20, y: 0, rotationDeg: 0, depth: 0,
  }))
  return { placements, unplaced: [], utilization: 0.5, sheetUsed: { width, height } }
}

beforeEach(() => {
  useCamStore.getState().newProject()
  useCamStore.setState((s) => ({
    appSettings: { ...s.appSettings, defaultStockPaddingXYMm: 5, defaultStockThicknessMm: 99 },
  }))
})

describe('removeNest bound-stock lifecycle (N1d Item 6, D2)', () => {
  it('removes the bound fixed stock from both fixedStocks and project.stocks', () => {
    const placements: NestRecord['placements'] = [
      { partId: 'g1', instanceId: 'g1#0', x: 0, y: 0, rotationDeg: 0, depth: 0 },
    ]
    installProject([makeSeed('g1', 10, 'n1')], makeNest('n1', 12, 'g1', placements))

    // Bind a real fixed stock via the apply path.
    useCamStore.getState().applyNestResult('n1', result(100, 100))
    const bound = useCamStore.getState().project.nests!.find((n) => n.id === 'n1')!
    const boundStockId = bound.boundStockId
    expect(boundStockId).toBeDefined()
    expect((useCamStore.getState().project.sceneStock.fixedStocks ?? []).length).toBe(1)

    // Delete the nest.
    useCamStore.getState().removeNest('n1')
    const st = useCamStore.getState()

    // The bound stock is gone from BOTH the scene-stock list AND the physical twins.
    expect((st.project.sceneStock.fixedStocks ?? []).some((fs) => fs.id === boundStockId)).toBe(false)
    expect((st.project.stocks ?? []).some((ps) => ps.id === boundStockId)).toBe(false)
    // The nest itself is gone.
    expect((st.project.nests ?? []).some((n) => n.id === 'n1')).toBe(false)
  })

  it('a single undo restores BOTH the nest and its bound stock', () => {
    const placements: NestRecord['placements'] = [
      { partId: 'g1', instanceId: 'g1#0', x: 0, y: 0, rotationDeg: 0, depth: 0 },
    ]
    installProject([makeSeed('g1', 10, 'n1')], makeNest('n1', 12, 'g1', placements))
    useCamStore.getState().applyNestResult('n1', result(100, 100))
    const boundStockId = useCamStore.getState().project.nests!.find((n) => n.id === 'n1')!.boundStockId

    const histBefore = useCamStore.getState().projectHistory.length
    useCamStore.getState().removeNest('n1')
    // removeNest pushes exactly ONE history entry for the combined removal.
    expect(useCamStore.getState().projectHistory.length).toBe(histBefore + 1)

    useCamStore.getState().undo()
    const st = useCamStore.getState()
    // Nest back.
    expect((st.project.nests ?? []).some((n) => n.id === 'n1')).toBe(true)
    expect(st.project.nests!.find((n) => n.id === 'n1')!.boundStockId).toBe(boundStockId)
    // Bound stock back in BOTH places.
    expect((st.project.sceneStock.fixedStocks ?? []).some((fs) => fs.id === boundStockId)).toBe(true)
    expect((st.project.stocks ?? []).some((ps) => ps.id === boundStockId)).toBe(true)
  })
})

describe('explodeNest bound-stock lifecycle (N1d Item 6, D2)', () => {
  it('keeps the bound fixed stock and assigns baked parts to it (unlocked members)', () => {
    const placements: NestRecord['placements'] = [
      { partId: 'g1', instanceId: 'g1#0', x: 0, y: 0, rotationDeg: 0, depth: 0 },
      { partId: 'g1', instanceId: 'g1#1', x: 20, y: 0, rotationDeg: 0, depth: 0 },
    ]
    installProject([makeSeed('g1', 10, 'n1')], makeNest('n1', 12, 'g1', placements))
    useCamStore.getState().applyNestResult('n1', result(100, 100, 2))
    const boundStockId = useCamStore.getState().project.nests!.find((n) => n.id === 'n1')!.boundStockId
    expect(boundStockId).toBeDefined()

    useCamStore.getState().explodeNest('n1')
    const st = useCamStore.getState()

    // The bound fixed stock STILL EXISTS (becomes a normal fixed stock).
    expect((st.project.sceneStock.fixedStocks ?? []).some((fs) => fs.id === boundStockId)).toBe(true)
    expect((st.project.stocks ?? []).some((ps) => ps.id === boundStockId && ps.mode === 'explicit')).toBe(true)

    // The nest is gone; the owned seed absorbed; two baked copies remain.
    expect((st.project.nests ?? []).some((n) => n.id === 'n1')).toBe(false)
    const baked = st.project.geometry.filter((g) => g.ownerNestId === undefined)
    expect(baked.length).toBe(2)

    // Each baked part is a member of the former bound stock, and NOT locked.
    for (const g of baked) {
      expect(g.stockId).toBe(boundStockId)
      expect(g.stockIdLocked).not.toBe(true)
    }
  })
})
