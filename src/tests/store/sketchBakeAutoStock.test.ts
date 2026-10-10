// P0 repro (docs/planning/POST-MERGE-WORKPLAN.md, OPEN BUGS 2026-06-24):
// "Auto stock does not resize when a sketch is created or edited."
//
// EXPECTED: the derived (auto) stock that owns sketch-origin geometry re-derives
// its stored bounds from the baked sketch loops on CREATE (first Finish) and on
// EVERY EDIT (re-open + re-bake), exactly the way imported-geometry edits re-wrap
// the auto stock (setGeometryLoops -> assignStocks -> rederiveDerivedStockBounds
// -> applyAutoStockToSetups). A corner-bound WCS on that stock follows the fresh
// corner in the same pass.
//
// This drives the REAL store through the sketch UX path (setViewerMode('sketch')
// -> addEntity -> finishSketch), not a synthetic setGeometryLoops call, so the
// whole bake pipeline is under test.

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import type { SketchEntity } from '../../lib/sketch/types'
import type {
  PhysicalStock, SceneStock, Setup, WCS, BoundingBox, Vec3,
} from '../../types'

class StubWorker {
  onmessage: ((e: unknown) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  postMessage(): void {}
  terminate(): void {}
}
vi.stubGlobal('Worker', StubWorker)
vi.stubGlobal('localStorage', {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
})

let useCamStore: typeof import('../../store').useCamStore
let DERIVED_STOCK_ID: string

beforeAll(async () => {
  ;({ useCamStore } = await import('../../store'))
  ;({ DERIVED_STOCK_ID } = await import('../../store/migrateHierarchy'))
})

// -- Fixtures ------------------------------------------------------------------

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

const OFF_XY = 2
const OFF_ZTOP = 1

function derivedCatchAll(): PhysicalStock {
  return {
    id: DERIVED_STOCK_ID, name: 'Stock', mode: 'derived',
    bounds: bbox({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }),
    position: { x: 0, y: 0, z: 0 },
  }
}

function autoSceneStock(): SceneStock {
  return {
    mode: 'auto',
    autoOffsetXY: OFF_XY, autoOffsetZTop: OFF_ZTOP,
    fixedWidth: 100, fixedHeight: 100, fixedDepth: 12,
    fixedStocks: [],
  }
}

/** Corner-bound WCS on the derived catch-all: front-left (row 2, col 0) top. */
function makeWcs(): WCS {
  return {
    id: 'wcs-1', label: 'G54', fixtureOffset: 54,
    origin: { x: 0, y: 0, z: 0 },
    xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
    stockId: DERIVED_STOCK_ID, cornerRow: 2, cornerCol: 0, cornerFace: 'top',
  }
}

function makeSetup(): Setup {
  return {
    id: 'setup-1', name: 'Setup 1',
    wcs: makeWcs(),
    stock: {
      type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0,
      material: 'aluminum',
    } as Setup['stock'],
    operations: [], notes: '',
  }
}

beforeEach(() => {
  useCamStore.setState((s) => ({
    activeSketch: null,
    sketchSolveStatus: null,
    sketchSelectedIds: [],
    sketchTool: 'select',
    sketchToolChain: null,
    sketchConstructionMode: false,
    sketchNotice: null,
    lastNonSketchMode: 'setup' as const,
    viewer: { ...s.viewer, mode: 'setup' as const },
    project: {
      ...s.project,
      geometry: [],
      stocks: [derivedCatchAll()],
      sceneStock: autoSceneStock(),
      setups: [makeSetup()],
      activeSetupId: 'setup-1',
      activeOperationId: null,
    },
    projectHistory: [],
    sketchHistory: [],
  }))
})

// WO-2189: every new sketch is its own part - find it through its layer's owner.
const sketchPart = (layerId: string) =>
  useCamStore.getState().project.geometry.find((g) => g.layers2d?.some((l) => l.id === layerId))

const derivedBounds = (): BoundingBox => {
  const st = useCamStore.getState().project.stocks?.find((x) => x.id === DERIVED_STOCK_ID)
  if (!st) throw new Error('derived catch-all stock missing')
  return st.bounds
}

const wcsOrigin = (): Vec3 => useCamStore.getState().project.setups[0].wcs.origin

function line(id: string, x0: number, y0: number, x1: number, y1: number): SketchEntity {
  return { id, kind: 'line', construction: false, start: { x: x0, y: y0 }, end: { x: x1, y: y1 } }
}

/** Add a closed axis-aligned rectangle (4 chained lines) to the active sketch. */
function addRect(idPrefix: string, x0: number, y0: number, x1: number, y1: number): void {
  useCamStore.getState().addEntity(line(`${idPrefix}-b`, x0, y0, x1, y0))
  useCamStore.getState().addEntity(line(`${idPrefix}-r`, x1, y0, x1, y1))
  useCamStore.getState().addEntity(line(`${idPrefix}-t`, x1, y1, x0, y1))
  useCamStore.getState().addEntity(line(`${idPrefix}-l`, x0, y1, x0, y0))
}

describe('P0: auto stock re-wraps sketch-origin geometry', () => {
  it('CREATE: finishing a new sketch re-derives the auto stock bounds from the baked loops', () => {
    useCamStore.getState().setViewerMode('sketch')
    const layerId = useCamStore.getState().activeSketch!.layerId
    addRect('r1', 0, 0, 10, 10)
    useCamStore.getState().finishSketch()

    // The bake landed on the sketch's own part and it joined the catch-all stock.
    const geo = sketchPart(layerId)!
    expect(geo.loops?.filter((l) => l.closed)).toHaveLength(1)
    expect(geo.stockId).toBe(DERIVED_STOCK_ID)

    // Stored derived bounds wrap the 10x10 rect + offsets (NOT the stale zero box).
    const b = derivedBounds()
    expect(b.min.x).toBeCloseTo(0 - OFF_XY, 9)
    expect(b.min.y).toBeCloseTo(0 - OFF_XY, 9)
    expect(b.max.x).toBeCloseTo(10 + OFF_XY, 9)
    expect(b.max.y).toBeCloseTo(10 + OFF_XY, 9)
    expect(b.min.z).toBeCloseTo(0, 9)
    expect(b.max.z).toBeCloseTo(0 + OFF_ZTOP, 9)

    // Corner-bound WCS (front-left top) followed the fresh corner in the same pass.
    expect(wcsOrigin()).toEqual({ x: b.min.x, y: b.min.y, z: b.max.z })
  })

  it('EDIT: re-opening the sketch and re-baking bigger geometry re-wraps the stock', () => {
    // Create pass: 10x10 rect.
    useCamStore.getState().setViewerMode('sketch')
    const layerId = useCamStore.getState().activeSketch!.layerId
    addRect('r1', 0, 0, 10, 10)
    useCamStore.getState().finishSketch()
    const before = derivedBounds()
    expect(before.max.x).toBeCloseTo(10 + OFF_XY, 9)

    // Edit pass: re-open the STORED document, add a second, farther rectangle.
    const stored = sketchPart(layerId)!.sketches!.find((sk) => sk.layerId === layerId)!
    useCamStore.getState().setActiveSketch(stored)
    useCamStore.getState().setViewerMode('sketch')
    addRect('r2', 20, 0, 50, 30)
    useCamStore.getState().finishSketch()

    // Stored derived bounds re-wrapped to the union of BOTH rects + offsets.
    const after = derivedBounds()
    expect(after.min.x).toBeCloseTo(0 - OFF_XY, 9)
    expect(after.min.y).toBeCloseTo(0 - OFF_XY, 9)
    expect(after.max.x).toBeCloseTo(50 + OFF_XY, 9)
    expect(after.max.y).toBeCloseTo(30 + OFF_XY, 9)

    // WCS followed the enlarged stock's corner.
    expect(wcsOrigin()).toEqual({ x: after.min.x, y: after.min.y, z: after.max.z })
  })

  it('EDIT (shrink): re-baking smaller geometry shrinks the stock (no stale large box)', () => {
    // Create pass: big 50x30 rect.
    useCamStore.getState().setViewerMode('sketch')
    const layerId = useCamStore.getState().activeSketch!.layerId
    addRect('big', 0, 0, 50, 30)
    useCamStore.getState().finishSketch()
    expect(derivedBounds().max.x).toBeCloseTo(50 + OFF_XY, 9)

    // Edit pass: delete the big rect, draw a small 10x10 instead.
    const stored = sketchPart(layerId)!.sketches!.find((sk) => sk.layerId === layerId)!
    useCamStore.getState().setActiveSketch(stored)
    useCamStore.getState().setViewerMode('sketch')
    for (const suffix of ['b', 'r', 't', 'l']) {
      useCamStore.getState().deleteEntity(`big-${suffix}`)
    }
    addRect('small', 0, 0, 10, 10)
    useCamStore.getState().finishSketch()

    const after = derivedBounds()
    expect(after.max.x).toBeCloseTo(10 + OFF_XY, 9)
    expect(after.max.y).toBeCloseTo(10 + OFF_XY, 9)
  })
})
