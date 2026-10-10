// applyNestResult -> auto-create + re-size a FIXED stock bound to the nest (N1d
// Item 4). On a SUCCESSFUL non-empty pack the store mints a FixedStockItem sized
// to (sheet + 2*padding) x thickness, binds it via record.boundStockId, and on a
// re-pack re-sizes the SAME stock in XY while preserving the user's thickness
// (depth is never re-written from a pack).
//
// Coverage:
//  - first apply: exactly one fixed stock appears, width/height = sheet + 2*pad,
//    depth = record.thickness, position = MIN corner at z=0 (origin - pad), and
//    record.boundStockId points at it;
//  - second apply with a DIFFERENT sheet: the SAME stock id is updated (W/H
//    change) and its depth (user thickness) is UNCHANGED.

import { describe, it, expect, beforeEach } from 'vitest'
import { useCamStore } from '../../store'
import type { NestRecord } from '../../types'
import type { NestResult } from '../../lib/cam/nesting/types'

// A minimal ready NestRecord with a known thickness and no bound stock yet.
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

// A synthetic successful pack result for the given sheet. One placement makes it
// "non-empty" so the stock auto-create path fires.
function result(width: number, height: number): NestResult {
  return {
    placements: [{ partId: 'p', instanceId: 'p#0', x: 0, y: 0, rotationDeg: 0, depth: 0 }],
    unplaced: [],
    utilization: 0.5,
    sheetUsed: { width, height },
  }
}

beforeEach(() => {
  useCamStore.getState().newProject()
  // Deterministic padding so width/height asserts are exact.
  useCamStore.setState((s) => ({
    appSettings: { ...s.appSettings, defaultStockPaddingXYMm: 5, defaultStockThicknessMm: 99 },
  }))
})

describe('applyNestResult bound fixed stock (N1d Item 4)', () => {
  it('auto-creates one fixed stock sized to sheet+2*pad x thickness and binds it', () => {
    installNest(makeNest('n1', 12))

    useCamStore.getState().applyNestResult('n1', result(100, 100))
    const st = useCamStore.getState()

    const fixed = st.project.sceneStock.fixedStocks ?? []
    expect(fixed.length).toBe(1)
    const stock = fixed[0]
    // sheet 100x100, pad 5 each side -> 110 x 110.
    expect(stock.width).toBe(110)
    expect(stock.height).toBe(110)
    // depth = record.thickness (12), NOT the app default thickness (99).
    expect(stock.depth).toBe(12)
    // MIN corner: origin {0,0} - pad, at the table plane z=0.
    expect(stock.position).toEqual({ x: -5, y: -5, z: 0 })
    // The nest record is bound to the new stock.
    const nest = st.project.nests!.find((n) => n.id === 'n1')!
    expect(nest.boundStockId).toBe(stock.id)
  })

  it('re-packs into the SAME stock (XY re-sized) and preserves the user thickness', () => {
    installNest(makeNest('n1', 12))

    // First pack -> create.
    useCamStore.getState().applyNestResult('n1', result(100, 100))
    const stockId = useCamStore.getState().project.nests!.find((n) => n.id === 'n1')!.boundStockId
    expect(stockId).toBeDefined()

    // Simulate the user editing the bound stock's thickness after the first pack.
    useCamStore.getState().updateFixedStock(stockId!, { depth: 18 })

    // Second pack with a DIFFERENT sheet size.
    useCamStore.getState().applyNestResult('n1', result(200, 60))
    const st = useCamStore.getState()

    const fixed = st.project.sceneStock.fixedStocks ?? []
    // Still exactly ONE stock — re-sized in place, not a new one.
    expect(fixed.length).toBe(1)
    const stock = fixed[0]
    expect(stock.id).toBe(stockId)
    // XY tracks the new sheet (200x60) + 2*pad.
    expect(stock.width).toBe(210)
    expect(stock.height).toBe(70)
    // Depth (the user's chosen thickness) is UNCHANGED by the re-pack.
    expect(stock.depth).toBe(18)
    // Binding unchanged.
    expect(st.project.nests!.find((n) => n.id === 'n1')!.boundStockId).toBe(stockId)
  })
})
