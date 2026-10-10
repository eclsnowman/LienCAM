// WO-1386 (audit BUG-459): File Open must reproduce what was saved.
//
// THE DEFECT: an auto stock wrapped an UNLOCKED model body (the design tree's
// 'auto-catch-all' member of "Auto Stock 1") plus a flat 2D plate. The stored
// stock bounds and the stock-top G54 origin both sat on the body's top (Z25).
// On Open, rederiveDerivedStockBounds folded the body back into the stock
// (bounds stayed Z0..25) but applyAutoStockToSetups re-derived the corner
// origin from the STRICT stockId members only - the body left out - so the
// origin dropped to the plate's padding (Z5), every ready operation went
// outdated, and a second Open repeated it.
//
// Driven through the REAL open path (loadProjectFromFile) with the file shape
// saveProjectToFile writes (the live project spread + schemaVersion), asserted
// BEFORE any compute.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { useCamStore } from '../../store'
import { DERIVED_STOCK_ID } from '../../store/migrateHierarchy'
import { deriveStockBounds } from '../../store/stockAssignment'
import { CURRENT_PROJECT_SCHEMA_VERSION } from '../../store/migrations/projectMigrations'
import type {
  ImportedGeometry, Operation, PhysicalStock, Project, SceneStock, Setup, Vec3, BoundingBox,
  ModelItemPlacementRecord, Loop2D,
} from '../../types'

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

/** Flat 10x10 DXF plate at Z0 - an ordinary stockId member of the auto stock. */
function plateGeo(): ImportedGeometry {
  const loop: Loop2D = {
    id: 'plate-loop',
    points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
    closed: true, type: 'contour', layerId: 'L1', area: 100,
  }
  return {
    id: 'geo-plate', name: 'Plate', filename: 'plate.dxf', type: 'curves_2d', format: 'dxf',
    boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: 10, y: 10, z: 0 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    loops: [loop],
    layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
    stockId: DERIVED_STOCK_ID,
  } as ImportedGeometry
}

/** A modeled body 40x30x20 standing on Z0 (legacy Model Item, identity placement). */
function bodyGeo(membership: { stockId?: string; stockIdLocked?: boolean } = {}): ImportedGeometry {
  return {
    id: 'geo-body', name: 'Body', filename: '', type: 'model', format: 'model',
    boundingBox: bbox({ x: -20, y: -15, z: 0 }, { x: 20, y: 15, z: 20 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    modelItemId: 'legacy',
    ...membership,
    modelBody: {
      ref: { bodyId: 'geo-body-body', stableIds: ['geo-body-body:F0'], version: 1 },
      display: {
        positions: [], normals: [], indices: [], edgePositions: [], edgeOffsets: [],
        bbox: { min: [-20, -15, 0], max: [20, 15, 20] },
      },
    },
  } as unknown as ImportedGeometry
}

const PLACEMENTS: ModelItemPlacementRecord[] = [
  { modelItemId: 'legacy', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
]

const sceneStock = {
  mode: 'auto', autoOffsetXY: 2, autoOffsetZTop: 5, autoOffsetZBottom: 0,
  fixedWidth: 100, fixedHeight: 100, fixedDepth: 12, fixedStocks: [],
  autoStocks: [{ id: DERIVED_STOCK_ID, name: 'Auto Stock 1', autoOffsetXY: 2, autoOffsetZTop: 5, autoOffsetZBottom: 0 }],
} as unknown as SceneStock

function contourOp(): Operation {
  return {
    id: 'op-contour', name: 'Contour', type: 'contour_2d', enabled: true, status: 'pending',
    toolId: 'tool-1', geometrySelections: [],
    heights: {
      clearanceHeight: 10, clearanceHeightMode: 'relative', retractHeight: 5, feedHeight: 1,
      topHeight: 0, topHeightMode: 'relative', bottomHeight: -18, bottomHeightMode: 'relative',
    },
    passes: { stepdown: 1, stepover: 3, stockToLeave: 0, finishPasses: 1, springPasses: 0 },
    linking: {
      entryType: 'plunge', rampAngle: 2, rampLength: 5, leadInRadius: 1.5, leadOutRadius: 1,
      retractType: 'full', transitionType: 'safe_height',
    },
    params: { geometryId: 'geo-plate', loopIds: [], side: 'outside', direction: 'climb', heightReference: 'stock_top' },
  } as unknown as Operation
}

/** G54 on the back-left corner of the stock TOP (the SetupModal corner pick). */
function stockTopSetup(origin: Vec3): Setup {
  return {
    id: 'setup-1', name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { ...origin },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      stockId: DERIVED_STOCK_ID, cornerRow: 2, cornerCol: 0, cornerFace: 'top',
      originBinding: { kind: 'stock_corner', stockId: DERIVED_STOCK_ID, cornerRow: 2, cornerCol: 0, cornerFace: 'top' },
    },
    stock: {
      type: 'rectangular', width: 100, height: 100, depth: 12,
      offsetX: 2, offsetY: 2, offsetZTop: 5, offsetZBottom: 0, material: 'al',
    },
    operations: [contourOp()], notes: '',
  } as unknown as Setup
}

/**
 * The session state the operator saved: the stock box is what the app drew
 * (rederive folds the catch-all model member when it applies), and the G54
 * sits on that box's back-left top corner - exactly where SetupModal's corner
 * pick put it.
 */
function savedFile(body: ImportedGeometry): { json: string; stock: BoundingBox; origin: Vec3 } {
  const geometry = [plateGeo(), body]
  const derived: PhysicalStock = {
    id: DERIVED_STOCK_ID, name: 'Auto Stock 1', mode: 'derived',
    bounds: bbox({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }), position: { x: 0, y: 0, z: 0 },
  }
  const stock = deriveStockBounds(derived, geometry, sceneStock.autoStocks![0], PLACEMENTS, [derived])!
  const origin = { x: stock.min.x, y: stock.min.y, z: stock.max.z }
  const base = useCamStore.getState().project
  const project: Project = {
    ...base,
    id: 'proj-wo1386', name: 'WO-1386', geometry,
    stocks: [{ ...derived, bounds: stock }],
    setups: [stockTopSetup(origin)], activeSetupId: 'setup-1', activeOperationId: null,
    sceneStock, modelItemPlacements: PLACEMENTS,
  }
  const json = JSON.stringify({ ...project, schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION })
  return { json, stock, origin }
}

const state = () => useCamStore.getState()

/** Re-save the opened project the way saveProjectToFile snapshots it. */
const resave = () => JSON.stringify({ ...state().project, schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION })

function expectReproduced(stock: BoundingBox, origin: Vec3) {
  const p = state().project
  const opened = (p.stocks ?? []).find((s) => s.id === DERIVED_STOCK_ID)!
  expect(opened.bounds.min).toEqual(stock.min)
  expect(opened.bounds.max).toEqual(stock.max)
  expect(p.setups[0].wcs.origin).toEqual(origin)
  const op = p.setups[0].operations[0]
  expect(op.status).toBe('pending')
  expect(op.heights).toEqual(contourOp().heights)
  expect(op.params).toEqual(contourOp().params)
}

describe('WO-1386: File Open keeps a stock-bound work zero where it was saved', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {})
    vi.stubGlobal('alert', vi.fn())
  })
  afterAll(() => {
    vi.unstubAllGlobals()
  })

  it('unlocked model body inside the auto stock: bounds, G54 Z and operation intent survive two Opens', async () => {
    const { json, stock, origin } = savedFile(bodyGeo())
    // The saved scene really is the defect's: the body sets the stock top.
    expect(stock.max.z).toBe(25)
    expect(origin.z).toBe(25)

    await state().loadProjectFromFile(json)
    expect(state().project.id).toBe('proj-wo1386')
    expectReproduced(stock, origin)
    const body = state().project.geometry.find((g) => g.id === 'geo-body')!
    expect(body.stockIdLocked).toBeUndefined()

    await state().loadProjectFromFile(resave())
    expectReproduced(stock, origin)
  })

  it('a file that carries the unlocked body as a stockId member opens to the same box and origin', async () => {
    const { json, stock, origin } = savedFile(bodyGeo({ stockId: DERIVED_STOCK_ID }))
    await state().loadProjectFromFile(json)
    expectReproduced(stock, origin)
    await state().loadProjectFromFile(resave())
    expectReproduced(stock, origin)
  })

  it('explicit assignment (locked to the auto stock) round-trips', async () => {
    const { json, stock, origin } = savedFile(bodyGeo({ stockId: DERIVED_STOCK_ID, stockIdLocked: true }))
    expect(origin.z).toBe(25)
    await state().loadProjectFromFile(json)
    expectReproduced(stock, origin)
    const body = state().project.geometry.find((g) => g.id === 'geo-body')!
    expect(body.stockId).toBe(DERIVED_STOCK_ID)
    expect(body.stockIdLocked).toBe(true)
    await state().loadProjectFromFile(resave())
    expectReproduced(stock, origin)
  })

  it('explicit None keeps the body out: the plate alone sizes the stock, and that round-trips', async () => {
    const { json, stock, origin } = savedFile(bodyGeo({ stockIdLocked: true }))
    expect(stock.max.z).toBe(5)
    expect(origin.z).toBe(5)
    await state().loadProjectFromFile(json)
    expectReproduced(stock, origin)
    const body = state().project.geometry.find((g) => g.id === 'geo-body')!
    expect(body.stockId).toBeUndefined()
    expect(body.stockIdLocked).toBe(true)
    await state().loadProjectFromFile(resave())
    expectReproduced(stock, origin)
  })
})
