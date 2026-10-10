// N1d D3 ("parts pinned to the sheet"): moving a nest's bound fixed stock rides
// the nest sheet + ALL placed parts + the seed slot with it. The render coupling
// is a SINGLE group move (NestRecord.origin -> viewport group position; the sheet
// + placements are group-relative), so this store-level test asserts the data the
// render reads:
//
//   - NestRecord.origin shifts by the move delta.
//   - the owned-seed home POSE (geo.position, recorded by applyNestResult at the
//     seed's lower-left slot; ABSOLUTE-WORLD for the sketch-editor display offset)
//     shifts by the SAME delta -> seed editing stays aligned, no desync.
//   - the PLACEMENT records are UNCHANGED (they are nest-local / group-relative;
//     translating them too would DOUBLE-translate the render).
//
// Both move paths are covered: moveFixedStockLive (live gizmo drag) and
// updateFixedStock (history-pushing position edit). Headless: no viewport, so the
// setNestGroupPosition side effect is a guarded no-op; the store data is the gate.
//
// Mirrors nestBoundStockLifecycle.test.ts fixtures (apply path binds the stock).

import { describe, it, expect, beforeEach } from 'vitest'
import { useCamStore } from '../../store'
import type { ImportedGeometry, BoundingBox, Vec3, Loop2D, NestRecord } from '../../types'
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
    points: [{ x: 0, y: 0 }, { x: s, y: 0 }, { x: s, y: s }, { x: 0, y: s }],
  }
}

// An OWNED SEED geometry (ownerNestId set). Its position is the seed home pose.
// Owned seeds are explicit NO-STOCK (stockId undefined + stockIdLocked true) — the
// real deepCopySeedGeometry contract (src/store/index.ts ~501-502). This matters:
// it keeps assignStocks from making the seed a MEMBER of the bound stock, so
// translateStockMembers does NOT move it (only translateBoundNest does) — the
// guarantee that prevents the seed home pose from double-translating.
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
  // Keep s.project.stocks (default derived/catch-all) so addFixedStock (invoked by
  // applyNestResult) mints the bound stock's EXPLICIT twin in project.stocks —
  // required by moveFixedStockLive's fail-loud explicit-twin guard.
  useCamStore.setState((s) => ({
    project: {
      ...s.project,
      geometry, geometryFolders: [], nests: [nest], setups: [],
      sceneStock: { ...s.project.sceneStock, fixedStocks: [] },
    },
    projectHistory: [], canUndo: false,
  }))
}

// Single placement at (10,20): the lower-left seed, so applyNestResult records the
// seed home pose at {x:10, y:20}. instanceId 'g1#0'.
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

// Bind a real fixed stock via the apply path; return its id + the seed home pose
// applyNestResult recorded (sanity-checked by the caller).
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

describe('N1d D3 nest move-coupling (parts pinned to the sheet)', () => {
  it('applyNestResult seeds origin {0,0}, stock at -pad, seed home at slot', () => {
    const { stockPos } = bindAndGet()
    const st = useCamStore.getState()
    const nest = st.project.nests!.find((n) => n.id === 'n1')!
    // origin defaults to {0,0}; stock min-corner = origin - pad.
    expect(nest.origin ?? { x: 0, y: 0 }).toEqual({ x: 0, y: 0 })
    expect(stockPos.x).toBe(-PAD)
    expect(stockPos.y).toBe(-PAD)
    // seed home pose recorded at the lower-left slot.
    const seed = st.project.geometry.find((g) => g.id === 'g1')!
    expect(seed.position.x).toBe(10)
    expect(seed.position.y).toBe(20)
  })

  it('moveFixedStockLive shifts origin + seed home by the delta; placements unchanged', () => {
    const { boundStockId, stockPos } = bindAndGet()
    const dx = 30, dy = 40
    useCamStore.getState().moveFixedStockLive(boundStockId, {
      x: stockPos.x + dx, y: stockPos.y + dy, z: stockPos.z,
    })
    const st = useCamStore.getState()
    const nest = st.project.nests!.find((n) => n.id === 'n1')!

    // origin += delta
    expect(nest.origin).toEqual({ x: dx, y: dy })
    // seed home pose += delta (absolute-world -> stays aligned with the slot)
    const seed = st.project.geometry.find((g) => g.id === 'g1')!
    expect(seed.position.x).toBe(10 + dx)
    expect(seed.position.y).toBe(20 + dy)
    // PLACEMENT records UNCHANGED (group-relative; no double-translate)
    expect(nest.placements).toHaveLength(1)
    expect(nest.placements[0].x).toBe(10)
    expect(nest.placements[0].y).toBe(20)
    // the bound stock itself rode (its own move path)
    const stock = st.project.sceneStock.fixedStocks!.find((fs) => fs.id === boundStockId)!
    expect(stock.position.x).toBe(-PAD + dx)
    expect(stock.position.y).toBe(-PAD + dy)
  })

  it('updateFixedStock position edit shifts origin + seed home; placements unchanged', () => {
    const { boundStockId, stockPos } = bindAndGet()
    const dx = -12, dy = 7
    useCamStore.getState().updateFixedStock(boundStockId, {
      position: { x: stockPos.x + dx, y: stockPos.y + dy, z: stockPos.z },
    })
    const st = useCamStore.getState()
    const nest = st.project.nests!.find((n) => n.id === 'n1')!

    expect(nest.origin).toEqual({ x: dx, y: dy })
    const seed = st.project.geometry.find((g) => g.id === 'g1')!
    expect(seed.position.x).toBe(10 + dx)
    expect(seed.position.y).toBe(20 + dy)
    expect(nest.placements[0].x).toBe(10)
    expect(nest.placements[0].y).toBe(20)
  })

  it('updateFixedStock NON-position edit (depth) leaves origin + seed home put', () => {
    const { boundStockId } = bindAndGet()
    useCamStore.getState().updateFixedStock(boundStockId, { depth: 25 })
    const st = useCamStore.getState()
    const nest = st.project.nests!.find((n) => n.id === 'n1')!
    // No XY delta -> origin stays {0,0}, seed home stays at the slot.
    expect(nest.origin ?? { x: 0, y: 0 }).toEqual({ x: 0, y: 0 })
    const seed = st.project.geometry.find((g) => g.id === 'g1')!
    expect(seed.position.x).toBe(10)
    expect(seed.position.y).toBe(20)
    // depth mirrored to thickness (existing reverse-sync, unrelated to D3).
    expect(nest.thickness).toBe(25)
  })
})
