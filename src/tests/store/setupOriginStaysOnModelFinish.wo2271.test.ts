// @vitest-environment jsdom
//
// WO-2271: the setup's work origin stays where the Setup dialog put it, so a
// reopened project posts the same G-code.
//
// The fresh-PC journey (WO-2249 step 7) built a 2D plate plus a modeled body,
// created a setup on the auto stock with a corner origin, posted, saved, closed
// and reopened, then opened Model and pressed Finish. Every operation then
// posted shifted by one constant (X -10 / Y -4.425): the setup origin moved.
// The Setup dialog puts the corner on the RENDERED stock box, which folds the
// unlocked model body in; Model Finish (syncModelBodies) re-derived the corner
// from the stock's stockId members only (the CAM-DRILL-FIX2/FIX3 Z baseline),
// so a Finish with nothing changed moved G54 to the smaller box's corner.
//
// Driven through the production store: syncModelBodies (the Model workbench's
// own regen writer), addSetup with the origin the Setup dialog computes from
// the rendered stock box, saveProjectToFile -> packageProjectToFile, and
// loadProjectFromFile. A real stock-offset edit (updateAutoStock) must still
// move the auto origin.

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'

vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}),
  loadCachedSTL: vi.fn(async () => null),
  removeCachedSTL: vi.fn(async () => {}),
}))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async () => {}),
  loadCachedStep: vi.fn(async () => null),
  removeCachedStep: vi.fn(async () => {}),
}))

// jsdom's localStorage is broken under vitest's node launch flags; the store's
// persist() writes on every set() (same shim as reopenDrillOnModeledHole.wo2282).
const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { useCamStore } = await import('../../store')
const { DERIVED_STOCK_ID } = await import('../../store/migrateHierarchy')
const { resetDocumentHolder, setDocumentStorage } = await import('../../doc/documentHolder')
const { InMemoryDocumentStorage } = await import('../../doc/persist')

import type { BoundingBox, ImportedGeometry, Loop2D, ModelBodyDisplay, PhysicalStock, Setup, Vec3 } from '../../types'

const state = () => useCamStore.getState()

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

/** Imported 2D plate 60 x 40 at Z0 - an ordinary member of the auto stock. */
function plateGeo(): ImportedGeometry {
  const loop: Loop2D = {
    id: 'plate-loop',
    points: [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 40 }, { x: 0, y: 40 }],
    closed: true, type: 'contour', layerId: 'L1', area: 2400,
  }
  return {
    id: 'geo-plate', name: 'Plate', filename: 'plate.dxf', type: 'curves_2d', format: 'dxf',
    boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: 60, y: 40, z: 0 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    loops: [loop],
    layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
    stockId: DERIVED_STOCK_ID,
  } as ImportedGeometry
}

/** The modeled body reaches past the plate's front-left corner, so the
 *  rendered stock box (body folded in) and the members-only box differ in XY. */
function bodyDisplay(): ModelBodyDisplay {
  return {
    positions: [], normals: [], indices: [], edgePositions: [], edgeOffsets: [],
    bbox: { min: [-10, -5, 0], max: [30, 20, 10] },
  }
}

/** The Model workbench's regen writer, as Model > Finish fires it. */
function finishModel(version: number): void {
  state().syncModelBodies({
    live: [{ bodyId: 'F1', name: 'Block' }],
    derived: [{ bodyId: 'F1', version, stableIds: ['F1:F0'], display: bodyDisplay() }],
  })
}

function autoStock(): PhysicalStock {
  const s = (state().project.stocks ?? []).find((st) => st.id === DERIVED_STOCK_ID)
  if (!s) throw new Error('no auto stock')
  return s
}

/** What SetupModal does on a corner pick: cornerToWorld on the RENDERED stock
 *  box (getVp().getStockBounds -> the stock's stored bounds), Front Left, top. */
function createCornerSetup(): Vec3 {
  const box = autoStock().bounds
  const origin = { x: box.min.x, y: box.min.y, z: box.max.z }
  const setup = {
    id: 'setup-wo2271', name: 'Setup 1',
    wcs: {
      id: 'wcs-wo2271', label: 'G54', fixtureOffset: 54, origin,
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      stockId: DERIVED_STOCK_ID, cornerRow: 2, cornerCol: 0, cornerFace: 'top',
      originBinding: { kind: 'stock_corner', stockId: DERIVED_STOCK_ID, cornerRow: 2, cornerCol: 0, cornerFace: 'top' },
    },
    stock: {
      type: 'rectangular', width: 100, height: 100, depth: 12,
      offsetX: 2, offsetY: 2, offsetZTop: 5, offsetZBottom: 0, material: 'al',
    },
    operations: [], notes: '',
  } as unknown as Setup
  state().addSetup(setup)
  return { ...origin }
}

const origin = () => state().project.setups.find((s) => s.id === 'setup-wo2271')!.wcs.origin

/** The journey's build: 2D plate imported, auto stock, body modeled. */
function buildPart(): void {
  useCamStore.setState((s) => ({
    project: {
      ...s.project,
      geometry: [plateGeo()],
      sceneStock: {
        ...s.project.sceneStock, mode: 'auto', autoOffsetXY: 2, autoOffsetZTop: 5, autoOffsetZBottom: 0,
        autoStocks: [{ id: DERIVED_STOCK_ID, name: 'Auto Stock 1', autoOffsetXY: 2, autoOffsetZTop: 5, autoOffsetZBottom: 0 }],
      },
      stocks: [{
        id: DERIVED_STOCK_ID, name: 'Auto Stock 1', mode: 'derived',
        bounds: bbox({ x: -2, y: -2, z: 0 }, { x: 62, y: 42, z: 5 }), position: { x: 0, y: 0, z: 0 },
      } as PhysicalStock],
    },
  }))
  finishModel(1)
  // The rendered box folds the unlocked body in: front-left corner (-12, -7).
  expect(autoStock().bounds.min.x).toBeCloseTo(-12, 6)
  expect(autoStock().bounds.min.y).toBeCloseTo(-7, 6)
}

let savedProjectText = ''

beforeEach(() => {
  mem.clear()
  resetDocumentHolder()
  setDocumentStorage(new InMemoryDocumentStorage())
  state().newProject()
  savedProjectText = ''
  vi.stubGlobal('liencamHost', {
    saveFile: async (_filename: string, data: string | Uint8Array) => {
      savedProjectText = typeof data === 'string' ? data : new TextDecoder().decode(data)
      return 'C:\\Temp\\WO-2271.camproject'
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  resetDocumentHolder()
})

describe('WO-2271: the setup work origin stays where the Setup dialog put it', () => {
  it('Model Finish with nothing changed leaves the origin XY where it was set', () => {
    buildPart()
    const set = createCornerSetup()
    expect(set.x).toBeCloseTo(-12, 6)
    expect(set.y).toBeCloseTo(-7, 6)

    finishModel(2)

    expect(origin().x).toBeCloseTo(set.x, 6)
    expect(origin().y).toBeCloseTo(set.y, 6)
    expect(origin().z).toBeCloseTo(set.z, 6)
  })

  it('saved, closed, reopened, then Model Finish: the origin is unchanged', async () => {
    buildPart()
    const set = createCornerSetup()

    await state().saveProjectToFile()
    expect(savedProjectText).not.toBe('')

    // Close: fresh store and document holder; reopen through the production path.
    resetDocumentHolder()
    setDocumentStorage(new InMemoryDocumentStorage())
    useCamStore.setState(useCamStore.getInitialState(), true)
    await state().loadProjectFromFile(savedProjectText)
    expect(state().project.geometry.some((g) => g.modelBody?.ref.bodyId === 'F1')).toBe(true)

    expect(origin().x).toBeCloseTo(set.x, 6)
    expect(origin().y).toBeCloseTo(set.y, 6)

    finishModel(3)

    expect(origin().x).toBeCloseTo(set.x, 6)
    expect(origin().y).toBeCloseTo(set.y, 6)
    expect(origin().z).toBeCloseTo(set.z, 6)
  })

  it('a real stock-offset edit still moves the auto origin', () => {
    buildPart()
    const set = createCornerSetup()

    state().updateAutoStock(DERIVED_STOCK_ID, { autoOffsetXY: 5 })

    expect(origin().x).not.toBeCloseTo(set.x, 3)
    expect(origin().y).not.toBeCloseTo(set.y, 3)
  })
})
