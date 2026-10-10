// Regression (Operator, reproducible): a NEST's bound fixed stock can be DRAGGED by
// the viewport gizmo and it stays where dropped (moveFixedStockLive), but TYPING a
// position value in the Properties panel (updateFixedStock(id, {position})) makes
// it jump to the typed location and then REVERT to the old location.
//
// This store-level test exercises the updateFixedStock typed-position path and
// asserts the data the render reads:
//   - the BOUND STOCK's own stored position EQUALS the typed value (the revert
//     symptom: it currently snaps back),
//   - NestRecord.origin tracked the XY delta,
//   - a SECOND identical call is idempotent (no drift),
//   - a NON-nest fixed stock position edit still persists.
//
// Mirrors nestMoveCoupling.test.ts fixtures (apply path binds the stock).

import { describe, it, expect, beforeEach } from 'vitest'
import { useCamStore } from '../../store'
import { buildSceneStockRebuildKey } from '../../components/viewport/sceneStockRebuildKey'
import type { ImportedGeometry, BoundingBox, Vec3, Loop2D, NestRecord } from '../../types'
import type { NestResult } from '../../lib/cam/nesting/types'

// -- Fixtures (copied from nestMoveCoupling.test.ts) ---------------------------

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
    points: [{ x: 0, y: 0 }, { x: s, y: 0 }, { x: s, y: s }, { x: 0, y: s }],
  }
}

function makeSeed(id: string, side: number, ownerNestId: string): ImportedGeometry {
  return {
    id, name: `Part ${id}`, filename: `${id}.dxf`, type: 'curves_2d', format: 'dxf',
    boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: side, y: side, z: 0 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    loops: [squareLoop(`${id}-outer`, side)],
    layers2d: [{ id: 'L', color: '#00e5ff', visible: true }],
    ownerNestId, stockId: undefined, stockIdLocked: true,
  } as ImportedGeometry
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
    placements, unplaced: [], utilization: 0.5, thickness,
  }
}

function installProject(geometry: ImportedGeometry[], nest: NestRecord): void {
  useCamStore.setState((s) => ({
    project: {
      ...s.project,
      geometry, geometryFolders: [], nests: [nest], setups: [],
      sceneStock: { ...s.project.sceneStock, fixedStocks: [] },
    },
    projectHistory: [], canUndo: false,
  }))
}

function result(width: number, height: number): NestResult {
  return {
    placements: [{ partId: 'g1', instanceId: 'g1#0', x: 10, y: 20, rotationDeg: 0, depth: 0 }],
    unplaced: [], utilization: 0.5, sheetUsed: { width, height },
  }
}

const PAD = 5

beforeEach(() => {
  useCamStore.getState().newProject()
  useCamStore.setState((s) => ({
    appSettings: { ...s.appSettings, defaultStockPaddingXYMm: PAD, defaultStockThicknessMm: 99 },
  }))
})

function bindAndGet(): { boundStockId: string; stockPos: Vec3 } {
  const placements: NestRecord['placements'] = [
    { partId: 'g1', instanceId: 'g1#0', x: 10, y: 20, rotationDeg: 0, depth: 0 },
  ]
  installProject([makeSeed('g1', 10, 'n1')], makeNest('n1', 12, 'g1', placements))
  useCamStore.getState().applyNestResult('n1', result(100, 100))
  const st = useCamStore.getState()
  const nest = st.project.nests!.find((n) => n.id === 'n1')!
  const boundStockId = nest.boundStockId!
  const stock = st.project.sceneStock.fixedStocks!.find((fs) => fs.id === boundStockId)!
  return { boundStockId, stockPos: stock.position }
}

function getStock(id: string) {
  return useCamStore.getState().project.sceneStock.fixedStocks!.find((fs) => fs.id === id)!
}

// Drives the ONLY box-rebuild for a typed Properties edit (the gizmo path moves
// the box imperatively and does not depend on this). If a typed POSITION edit does
// not change this key, the box mesh is never rebuilt at the new spot -> the visual
// "reverts" to the old location even though the store data is correct. Asserts
// against the REAL pure builder used by Viewport.tsx (not a replica).
function rebuildKey(): string {
  return buildSceneStockRebuildKey(useCamStore.getState().project)
}

describe('updateFixedStock typed-position edit on a NEST-bound stock (revert bug)', () => {
  it('the bound stock stores the typed position (does not revert) + origin tracks delta', () => {
    const { boundStockId, stockPos } = bindAndGet()
    const dx = -12, dy = 7
    const target = { x: stockPos.x + dx, y: stockPos.y + dy, z: stockPos.z }

    useCamStore.getState().updateFixedStock(boundStockId, { position: { ...target } })

    // The revert symptom: the stored fixed-stock position snaps back to stockPos.
    const stock = getStock(boundStockId)
    expect(stock.position.x).toBe(target.x)
    expect(stock.position.y).toBe(target.y)
    expect(stock.position.z).toBe(target.z)

    // The nest origin rode the same XY delta (sheet + parts follow).
    const nest = useCamStore.getState().project.nests!.find((n) => n.id === 'n1')!
    expect(nest.origin).toEqual({ x: dx, y: dy })
  })

  it('a SECOND identical position call is idempotent (no drift in stock or origin)', () => {
    const { boundStockId, stockPos } = bindAndGet()
    const dx = -12, dy = 7
    const target = { x: stockPos.x + dx, y: stockPos.y + dy, z: stockPos.z }

    useCamStore.getState().updateFixedStock(boundStockId, { position: { ...target } })
    const afterFirst = { ...getStock(boundStockId).position }
    const originFirst = { ...useCamStore.getState().project.nests!.find((n) => n.id === 'n1')!.origin! }

    // Re-type the SAME value (prevStock now equals target -> delta 0 -> no shift).
    useCamStore.getState().updateFixedStock(boundStockId, { position: { ...target } })
    const afterSecond = getStock(boundStockId).position
    const originSecond = useCamStore.getState().project.nests!.find((n) => n.id === 'n1')!.origin!

    expect(afterSecond).toEqual(afterFirst)
    expect(originSecond).toEqual(originFirst)
  })

  it('a NON-nest fixed stock position edit still persists', () => {
    // No nest in play; addFixedStock then updateFixedStock should just move it.
    useCamStore.getState().newProject()
    const stock = {
      id: 'plain1', name: 'Plain', width: 50, height: 40, depth: 10,
      position: { x: 0, y: 0, z: 0 },
    }
    useCamStore.getState().addFixedStock(stock as any)
    const target = { x: 33, y: -8, z: 2 }
    useCamStore.getState().updateFixedStock('plain1', { position: { ...target } })
    const after = getStock('plain1')
    expect(after.position).toEqual(target)
  })

  // ROOT-CAUSE GATE: the viewport box only rebuilds when sceneStockRebuildKey
  // changes. A typed POSITION edit MUST change that key, or the box mesh never
  // moves to the new spot (the "reverts to old location" symptom). This is the
  // gate that currently FAILS — the key omits fixed-stock position.
  it('typed position edit on a PLAIN fixed stock changes the viewport rebuild key', () => {
    useCamStore.getState().newProject()
    const stock = {
      id: 'plain1', name: 'Plain', width: 50, height: 40, depth: 10,
      position: { x: 0, y: 0, z: 0 },
    }
    useCamStore.getState().addFixedStock(stock as any)
    const before = rebuildKey()
    useCamStore.getState().updateFixedStock('plain1', { position: { x: 33, y: -8, z: 2 } })
    const after = rebuildKey()
    expect(after).not.toBe(before)
  })

  it('typed position edit on a NEST-bound stock changes the viewport rebuild key', () => {
    const { boundStockId, stockPos } = bindAndGet()
    const before = rebuildKey()
    useCamStore.getState().updateFixedStock(boundStockId, {
      position: { x: stockPos.x - 12, y: stockPos.y + 7, z: stockPos.z },
    })
    const after = rebuildKey()
    expect(after).not.toBe(before)
  })
})
