// "Many paths to same result" for the nest's thickness (N1d Item 5). The bound
// fixed stock's depth IS the nest's material thickness, editable from multiple
// surfaces that all converge on ONE value:
//   - setNestThickness (the canonical writer the Properties Panel field calls)
//   - updateFixedStock({ depth }) on the bound stock (the design-tree depth field)
// Both must keep record.thickness and the bound stock depth in sync.
//
// Coverage:
//  (i)   setNestThickness on a BOUND nest sets BOTH record.thickness and the
//        bound fixed stock's depth;
//  (ii)  updateFixedStock(boundStockId, { depth }) directly mirrors onto
//        record.thickness (the reverse-sync);
//  (iii) setNestThickness on a nest with NO boundStockId still sets
//        record.thickness directly.

import { describe, it, expect, beforeEach } from 'vitest'
import { useCamStore } from '../../store'
import type { NestRecord } from '../../types'
import type { NestResult } from '../../lib/cam/nesting/types'

function makeNest(id: string, thickness: number): NestRecord {
  return {
    id, name: `Nest ${id}`,
    sheet: { width: 100, height: 100 },
    style: 'arbitrary',
    spacing: { partGap: 1, sheetMargin: 1, windowGap: 1 },
    seed: 1,
    sources: [],
    placements: [],
    unplaced: [],
    utilization: 0,
    thickness,
  }
}

function installNest(nest: NestRecord): void {
  useCamStore.setState((s) => ({
    project: {
      ...s.project,
      geometry: [],
      geometryFolders: [],
      nests: [nest],
      setups: [],
      stocks: undefined,
      sceneStock: { ...s.project.sceneStock, fixedStocks: [] },
    },
    projectHistory: [],
    canUndo: false,
  }))
}

// A non-empty successful pack so applyNestResult auto-creates + binds a stock.
function result(width: number, height: number): NestResult {
  return {
    placements: [{ partId: 'p', instanceId: 'p#0', x: 0, y: 0, rotationDeg: 0, depth: 0 }],
    unplaced: [],
    utilization: 0.5,
    sheetUsed: { width, height },
  }
}

function nestById(id: string): NestRecord {
  return useCamStore.getState().project.nests!.find((n) => n.id === id)!
}

beforeEach(() => {
  useCamStore.getState().newProject()
  useCamStore.setState((s) => ({
    appSettings: { ...s.appSettings, defaultStockPaddingXYMm: 5, defaultStockThicknessMm: 99 },
  }))
})

describe('nest thickness sync (N1d Item 5)', () => {
  it('(i) setNestThickness updates BOTH record.thickness and the bound stock depth', () => {
    installNest(makeNest('n1', 12))
    // Bind a stock via a pack.
    useCamStore.getState().applyNestResult('n1', result(100, 100))
    const stockId = nestById('n1').boundStockId
    expect(stockId).toBeDefined()

    useCamStore.getState().setNestThickness('n1', 20)

    expect(nestById('n1').thickness).toBe(20)
    const stock = useCamStore.getState().project.sceneStock.fixedStocks!.find((fs) => fs.id === stockId)!
    expect(stock.depth).toBe(20)
  })

  it('(ii) updateFixedStock(boundStockId, { depth }) mirrors onto record.thickness', () => {
    installNest(makeNest('n1', 12))
    useCamStore.getState().applyNestResult('n1', result(100, 100))
    const stockId = nestById('n1').boundStockId!

    // Edit the bound stock's depth directly (the design-tree depth field path).
    useCamStore.getState().updateFixedStock(stockId, { depth: 33 })

    expect(nestById('n1').thickness).toBe(33)
    const stock = useCamStore.getState().project.sceneStock.fixedStocks!.find((fs) => fs.id === stockId)!
    expect(stock.depth).toBe(33)
  })

  it('(iii) setNestThickness on a nest with NO boundStockId still sets record.thickness', () => {
    // No pack -> no bound stock.
    installNest(makeNest('n2', 12))
    expect(nestById('n2').boundStockId).toBeUndefined()

    useCamStore.getState().setNestThickness('n2', 7)

    expect(nestById('n2').thickness).toBe(7)
    // No stock was created as a side effect.
    expect(useCamStore.getState().project.sceneStock.fixedStocks ?? []).toHaveLength(0)
  })

  it('setNestThickness rejects mm <= 0 (no-op, prior value intact)', () => {
    installNest(makeNest('n3', 12))
    useCamStore.getState().setNestThickness('n3', 0)
    expect(nestById('n3').thickness).toBe(12)
    useCamStore.getState().setNestThickness('n3', -5)
    expect(nestById('n3').thickness).toBe(12)
  })
})
