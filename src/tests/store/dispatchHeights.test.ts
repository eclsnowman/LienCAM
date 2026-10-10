// H1 (docs/planning/HEIGHTS-AUDIT-AND-PLAN.md): dispatch-time height-mode
// resolution for adaptive_clearing_2d / contour_2d / drill, plus the R3
// plane-ordering validation for ALL op types.
//
// Two layers of coverage:
//   1. Pure helpers (resolveTopZ / resolveModelBottomZ / planeOrderingError)
//      in the dispatchGeo.test.ts style.
//   2. Store integration: the REAL computeOperationToolpath with a stubbed
//      Worker, asserting what actually rides in the dispatched payload and
//      that ordering violations block dispatch via the existing op error
//      mechanism (status 'error' + errorMessage).

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import {
  resolveTopZ, resolveModelBottomZ, planeOrderingError, coMoveApproachPlanes,
} from '../../store/dispatchGeo'
import { useCamStore } from '../../store'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'
import type {
  ImportedGeometry, FixedStockItem, SceneStock, Setup, Operation, Tool,
  HeightParams, PassParams, LinkingParams, Layer2D, Loop2D,
  PhysicalStock,
} from '../../types'

// -- Shared fixtures -----------------------------------------------------------
// World picture: stock block 100x100x12 sitting at z=0 (top at world z=12);
// WCS origin at z=5 - so the stock top is +7 in WCS-relative terms, NOT 0.
// This is exactly the configuration where the old raw-heights dispatch
// silently degraded topHeightMode 'stock_top' to "WCS Z 0".

const WCS_Z = 5

function makeStock(over: Partial<FixedStockItem> = {}): FixedStockItem {
  return {
    id: 'stock-1', name: 'Stock',
    width: 100, height: 100, depth: 12,
    position: { x: 0, y: 0, z: 0 },
    ...over,
  }
}

function makeSceneStock(stock: FixedStockItem): SceneStock {
  return {
    mode: 'fixed',
    autoOffsetXY: 2, autoOffsetZTop: 1,
    fixedWidth: 100, fixedHeight: 100, fixedDepth: 12,
    fixedStocks: [stock],
  }
}

function makeGeo(over: Partial<ImportedGeometry> = {}): ImportedGeometry {
  return {
    id: 'geo-1', name: 'Part', filename: 'part.dxf', type: 'curves_2d', format: 'dxf',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 50, y: 50, z: 10 },
      size: { x: 50, y: 50, z: 10 }, center: { x: 25, y: 25, z: 5 },
    },
    position: { x: 0, y: 0, z: 1 },
    rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
    loops: [makeLoop()],
    layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
    ...over,
  }
}

function makeLoop(over: Partial<Loop2D> = {}): Loop2D {
  return {
    id: 'loop-1',
    points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
    closed: true, type: 'contour', layerId: 'L1', area: 100,
    ...over,
  }
}

function makeSetup(stockId: string, operations: Operation[]): Setup {
  return {
    id: 'setup-1', name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54,
      origin: { x: 0, y: 0, z: WCS_Z },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      stockId,
    },
    stock: {
      type: 'rectangular',
      offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0,
      material: 'aluminum',
    } as Setup['stock'],
    operations,
    notes: '',
  }
}

function makeTool(): Tool {
  return {
    id: 'tool-1', name: '4mm EM', type: 'flat_endmill',
    diameter: 4, fluteLength: 12, shankDiameter: 4, overallLength: 50,
    numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
    feedsAndSpeeds: {
      default: { rpm: 12000, feedRate: 800, plungeRate: 200, depthOfCut: 2, stepover: 1.6 },
    },
  } as unknown as Tool
}

// Valid ordering for the WCS_Z=5 / stock-top=+7 scene:
// clearance 20 >= retract 10 >= feed 8 >= top (7 when stock_top) > bottom -3.
function makeHeights(over: Partial<HeightParams> = {}): HeightParams {
  return {
    clearanceHeight: 20, clearanceHeightMode: 'absolute',
    retractHeight: 10, feedHeight: 8,
    topHeight: 0, topHeightMode: 'stock_top',
    bottomHeight: -3, bottomHeightMode: 'absolute',
    ...over,
  }
}

const passes: PassParams = {
  stepdown: 2, stepover: 1.6, stockToLeave: 0, finishPasses: 0, springPasses: 0,
}
const linking: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 10,
  leadInRadius: 0, leadOutRadius: 0, retractType: 'full', transitionType: 'safe_height',
}

function makeOp(type: Operation['type'], heights: HeightParams, params: Record<string, unknown>): Operation {
  return {
    id: 'op-1', name: 'Op', type, enabled: true, status: 'pending',
    toolId: 'tool-1', geometrySelections: [],
    // Smart Height V2 is the only runtime authority since 2e5678b7; without a
    // valid envelope computeOperationToolpath refuses before dispatch and every
    // payload assertion below sees zero posts (ADR-0040: stamp, do not migrate).
    smartHeight: smartHeightAuthorityFixture(type, { heights }),
    heights, passes, linking, params,
  }
}

const contourParams = (): Record<string, unknown> => ({
  geometryId: 'geo-1', loopIds: [], side: 'outer', direction: 'climb', tabs: false,
})

// -- 1. Pure helpers -----------------------------------------------------------

describe('resolveTopZ (height modes -> WCS-relative Z)', () => {
  const stock = makeStock()
  const sceneStock = makeSceneStock(stock)
  const geo = makeGeo()
  const setup = makeSetup(stock.id, [])

  it('stock_top: stock top world Z minus wcsOrigin.z, plus offset', () => {
    expect(resolveTopZ('stock_top', 0, setup, sceneStock, [geo], 'geo-1')).toBeCloseTo(7, 9)
    expect(resolveTopZ('stock_top', -1.5, setup, sceneStock, [geo], 'geo-1')).toBeCloseTo(5.5, 9)
  })

  it('model_top: geometry world bbox max Z minus wcsOrigin.z', () => {
    // position.z 1 + bbox max.z 10 = world 11; minus WCS 5 -> 6
    expect(resolveTopZ('model_top', 0, setup, sceneStock, [geo], 'geo-1')).toBeCloseTo(6, 9)
  })

  it('absolute: returns the offset verbatim (already WCS-relative)', () => {
    expect(resolveTopZ('absolute', -2.5, setup, sceneStock, [geo], 'geo-1')).toBe(-2.5)
  })
})

// ADR-0020 per-op isolation: geometry_face must resolve from the OWNING layer of
// the op's SELECTED loops, NOT the geometry-wide max layer plane. Bug: 6 thread
// ops on one shared STEP geometry all snapped to the highest boss face (Z47)
// instead of each loop's own plane (holes at Z22). A high boss layer derived for
// ONE op must not leak its plane into the others.
describe('resolveTopZ geometry_face: per-op owning-layer isolation (ADR-0020)', () => {
  const STOCK_TOP = 12  // world Z (stock depth 12 at z=0)
  const HI = STOCK_TOP + 25  // a high boss-top layer plane

  // World-baked layer (no frame): layerPlaneWorldZ returns projectionPlane.origin.z.
  function worldLayer(id: string, worldZ: number): Layer2D {
    return {
      id, name: id, color: '#00e5ff', visible: true,
      projectionPlane: {
        origin: { x: 0, y: 0, z: worldZ },
        xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, normal: { x: 0, y: 0, z: 1 },
      },
    }
  }

  // One brep geometry with TWO layers at different world Z, each owning one loop.
  function twoLayerGeo(): ImportedGeometry {
    return makeGeo({
      id: 'geo-1', type: 'brep', format: 'step',
      layers2d: [worldLayer('L_lo', STOCK_TOP), worldLayer('L_hi', HI)],
      loops: [
        makeLoop({ id: 'loop-lo', layerId: 'L_lo' }),
        makeLoop({ id: 'loop-hi', layerId: 'L_hi' }),
      ],
    })
  }

  const sceneStock = makeSceneStock(makeStock())
  const setup = makeSetup('stock-1', [])

  it("op selecting ['loop-lo'] resolves to the LOW layer plane (not the max)", () => {
    // L_lo world 12 - wcsZ 5 = 7. NOT HI (37-5=32).
    expect(resolveTopZ('geometry_face', 0, setup, sceneStock, [twoLayerGeo()], 'geo-1', [], ['loop-lo']))
      .toBeCloseTo(7, 9)
  })

  it("op selecting ['loop-hi'] resolves to the HIGH layer plane", () => {
    // L_hi world 37 - wcsZ 5 = 32.
    expect(resolveTopZ('geometry_face', 0, setup, sceneStock, [twoLayerGeo()], 'geo-1', [], ['loop-hi']))
      .toBeCloseTo(32, 9)
  })

  it('LEAK GUARD: the low op is unchanged by the presence of the high layer', () => {
    // Same geometry, but the high layer ALSO exists in layers2d. The low op must
    // still resolve to L_lo (7), proving the high layer does not leak in.
    const withHigh = twoLayerGeo()
    expect(withHigh.layers2d?.some(l => l.id === 'L_hi')).toBe(true)
    expect(resolveTopZ('geometry_face', 0, setup, sceneStock, [withHigh], 'geo-1', [], ['loop-lo']))
      .toBeCloseTo(7, 9)
  })

  it('empty loopIds still aggregates over ALL layers (legacy behavior preserved)', () => {
    // No selection -> geometry-wide max = HI (37-5=32).
    expect(resolveTopZ('geometry_face', 0, setup, sceneStock, [twoLayerGeo()], 'geo-1', [], []))
      .toBeCloseTo(32, 9)
  })

  it('orphan loopId (no owning layer) falls back to the legacy aggregate, not a crash', () => {
    expect(resolveTopZ('geometry_face', 0, setup, sceneStock, [twoLayerGeo()], 'geo-1', [], ['loop-missing']))
      .toBeCloseTo(32, 9)
  })
})

describe('resolveModelBottomZ (bottomHeightMode model_bottom)', () => {
  it('single geometry: world bbox min Z minus wcsZ', () => {
    // position.z 1 + bbox min.z 0 = world 1; minus WCS 5 -> -4
    expect(resolveModelBottomZ([makeGeo()], 'geo-1', WCS_Z)).toBeCloseTo(-4, 9)
  })

  it('__all__: lowest bottom across all loaded geometry', () => {
    const low = makeGeo({
      id: 'geo-2',
      position: { x: 0, y: 0, z: -2 },
    })
    expect(resolveModelBottomZ([makeGeo(), low], '__all__', WCS_Z)).toBeCloseTo(-7, 9)
  })

  it('missing geometry falls back to the WCS plane (0)', () => {
    expect(resolveModelBottomZ([makeGeo()], 'geo-missing', WCS_Z)).toBe(0)
  })
})

describe('planeOrderingError (R3: clearance >= retract >= feed >= top > bottom)', () => {
  const h = { clearanceHeight: 20, retractHeight: 10, feedHeight: 8 }

  it('returns null for a valid ordering', () => {
    expect(planeOrderingError(h, 7, -3)).toBeNull()
  })

  it('allows planes to be exactly equal except top/bottom', () => {
    expect(planeOrderingError({ clearanceHeight: 5, retractHeight: 5, feedHeight: 5 }, 5, -1)).toBeNull()
  })

  it('flags clearance below retract, naming both values', () => {
    const msg = planeOrderingError({ ...h, clearanceHeight: 9 }, 7, -3)
    expect(msg).toContain('Clearance height (9)')
    expect(msg).toContain('retract height (10)')
    expect(msg).toContain('operation not computed')
  })

  it('flags retract below feed', () => {
    const msg = planeOrderingError({ ...h, retractHeight: 7 }, 7, -3)
    expect(msg).toContain('Retract height (7)')
    expect(msg).toContain('feed height (8)')
  })

  it('flags feed below the resolved top', () => {
    const msg = planeOrderingError(h, 8.5, -3)
    expect(msg).toContain('Feed height (8)')
    expect(msg).toContain('top height (8.5)')
  })

  it('flags bottom at or above top (strict: equal is an error)', () => {
    const above = planeOrderingError(h, 0, 2)
    expect(above).toContain('Bottom height (2) is at or above top height (0)')
    const equal = planeOrderingError(h, 0, 0)
    expect(equal).toContain('Bottom height (0) is at or above top height (0)')
  })
})

// B24: a part laid on a face is a rigid MOVE. The top plane re-resolves to the
// moved stock, but feed/retract carry raw absolute panel values -> feed gets
// stranded below the re-resolved top and the op falsely fails the ordering
// check. coMoveApproachPlanes preserves the configured GAP: feed/retract shift
// by (resolvedTop - rawPanelTop); clearance stays machine-absolute.
describe('coMoveApproachPlanes (B24: feed/retract co-move with the resolved top)', () => {
  // Configured as a fixed gap above the panel top: top 0, feed +2, retract +5,
  // clearance +10 (all WCS-relative).
  const h: HeightParams = {
    clearanceHeight: 10, clearanceHeightMode: 'absolute',
    retractHeight: 5, feedHeight: 2,
    topHeight: 0, topHeightMode: 'stock_top',
    bottomHeight: -3, bottomHeightMode: 'absolute',
  }

  it('top moves UP by delta D: feed and retract each shift by D, gap preserved', () => {
    // rawPanelTop 0 -> resolvedTop 7 (D = +7).
    const moved = coMoveApproachPlanes(h, 7, 0)
    expect(moved.feedHeight).toBeCloseTo(9, 9)     // 2 + 7
    expect(moved.retractHeight).toBeCloseTo(12, 9) // 5 + 7
    // Gap above top preserved: feed-top and retract-top unchanged.
    expect(moved.feedHeight - 7).toBeCloseTo(h.feedHeight - 0, 9)
    expect(moved.retractHeight - 7).toBeCloseTo(h.retractHeight - 0, 9)
  })

  it('clearance is UNCHANGED (machine-absolute; protects clamps not the part)', () => {
    const moved = coMoveApproachPlanes(h, 7, 0)
    expect(moved.clearanceHeight).toBe(h.clearanceHeight)
  })

  it('top/bottom passthrough are untouched by the helper', () => {
    const moved = coMoveApproachPlanes(h, 7, 0)
    expect(moved.topHeight).toBe(h.topHeight)
    expect(moved.bottomHeight).toBe(h.bottomHeight)
  })

  it('after the co-move feed >= resolvedTop holds (no "Feed below top" failure)', () => {
    // Use a clearance high enough that the moved retract stays under it, so the
    // ONLY relationship under test is feed-vs-resolved-top.
    const hi: HeightParams = { ...h, clearanceHeight: 20 }
    const moved = coMoveApproachPlanes(hi, 7, 0)
    // Validate against the resolved top - the co-moved feed clears it.
    expect(planeOrderingError(moved, 7, -3)).toBeNull()
    expect(moved.feedHeight).toBeGreaterThanOrEqual(7)
  })

  it('clearance below the moved retract STILL fails loud (not suppressed)', () => {
    // top up by +7: feed -> 9, retract -> 12, but clearance stays 10 < 12.
    const moved = coMoveApproachPlanes(h, 7, 0)
    const err = planeOrderingError(moved, 7, -3)
    expect(err).toContain('Clearance height (10)')
    expect(err).toContain('retract height (12)')
  })

  it('downward move (delta negative) shifts feed/retract DOWN by D; clearance unchanged', () => {
    // rawPanelTop 0 -> resolvedTop -4 (D = -4).
    const moved = coMoveApproachPlanes(h, -4, 0)
    expect(moved.feedHeight).toBeCloseTo(-2, 9)   // 2 - 4
    expect(moved.retractHeight).toBeCloseTo(1, 9) // 5 - 4
    expect(moved.clearanceHeight).toBe(10)
  })

  it("'absolute' top (resolvedTop === rawPanelTop) is a no-op (delta 0)", () => {
    const moved = coMoveApproachPlanes(h, 0, 0)
    expect(moved.feedHeight).toBe(h.feedHeight)
    expect(moved.retractHeight).toBe(h.retractHeight)
    expect(moved.clearanceHeight).toBe(h.clearanceHeight)
  })
})

// -- 2. Store dispatch integration ---------------------------------------------

type Posted = {
  type: string
  payload: {
    heights: HeightParams
    params?: Record<string, unknown>
    holeBottoms?: Record<string, number>
    loopBottoms?: Record<string, number>
    stockBounds?: {
      min: { x: number; y: number }
      max: { x: number; y: number }
    }
  }
}

class MockWorker {
  static instances: MockWorker[] = []
  posted: Posted[] = []
  onmessage: ((e: unknown) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  constructor(_url: unknown, _opts?: unknown) { MockWorker.instances.push(this) }
  postMessage(msg: Posted): void { this.posted.push(msg) }
  terminate(): void { /* no-op */ }
}

function installScene(op: Operation, geoOver: Partial<ImportedGeometry> = {}): void {
  const stock = makeStock()
  // Coordinate hierarchy Phase 2: the dispatch resolves reference planes from the
  // geometry's OWNING PhysicalStock, so the scene must carry one (the migrator
  // does this in production). Mirror the fixed stock into an explicit
  // PhysicalStock and assign the geometry to it - so owningStockWorldBounds reads
  // position.z + depth (= the same +7 the old fixedStocks path produced).
  const physicalStock: PhysicalStock = {
    id: stock.id, name: stock.name, mode: 'explicit',
    bounds: {
      min: { x: 0, y: 0, z: 0 },
      max: { x: stock.width, y: stock.height, z: stock.depth },
      size: { x: stock.width, y: stock.height, z: stock.depth },
      center: { x: stock.width / 2, y: stock.height / 2, z: stock.depth / 2 },
    },
    position: { x: stock.position.x, y: stock.position.y, z: stock.position.z },
  }
  useCamStore.setState(s => ({
    project: {
      ...s.project,
      geometry: [makeGeo({ stockId: stock.id, ...geoOver })],
      setups: [makeSetup(stock.id, [op])],
      sceneStock: makeSceneStock(stock),
      stocks: [physicalStock],
      activeSetupId: 'setup-1',
      activeOperationId: 'op-1',
    },
    // Tool library is now a ROOT slice (single source of truth).
    toolLibrary: [makeTool()],
    toolpathBatch: null,
  }))
}

function dispatchedPayload(): Posted {
  expect(MockWorker.instances.length).toBe(1)
  expect(MockWorker.instances[0].posted.length).toBe(1)
  return MockWorker.instances[0].posted[0]
}

function opAfter(): Operation {
  return useCamStore.getState().project.setups[0].operations[0]
}

// Smart Height V2 is the only runtime authority (2e5678b7, 2026-08-15; ADR-0040:
// no legacy, no migration). Every dispatched plane now comes from the resolved
// V2 plan, so the former H1 tests that drove dispatch from V1 height modes
// (topHeightMode / bottomHeightMode / params.heightReference / selected_face
// heals) asserted a pipeline the product no longer has and were retired on
// 2026-08-18. Per-family V2 dispatch truth lives in
// src/tests/store/smartHeight*Store.phase*.test.ts and
// src/tests/cam/smartHeight*.phase*.test.ts. What remains here is the
// dispatch plumbing that is still true under V2: a valid op posts one payload,
// open-contour stock XY bounds ride along, and an unprovable stock refuses
// before any worker exists.
describe('computeOperationToolpath dispatch under Smart Height V2', () => {
  beforeEach(() => {
    MockWorker.instances = []
    vi.stubGlobal('Worker', MockWorker)
  })

  afterAll(() => {
    vi.unstubAllGlobals()
  })

  it('a valid config still dispatches (status computing, payload posted)', () => {
    installScene(makeOp('contour_2d', makeHeights(), contourParams()))
    useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')
    expect(MockWorker.instances.length).toBe(1)
    expect(opAfter().status).toBe('computing')
    expect(opAfter().errorMessage).toBeUndefined()
  })

  it('open contour dispatch attaches the active explicit stock XY bounds', () => {
    installScene(
      makeOp('contour_2d', makeHeights(), {
        ...contourParams(),
        pathType: 'open',
        openSide: 'right',
      }),
      {
        loops: [makeLoop({
          closed: false,
          points: [{ x: 10, y: 50 }, { x: 90, y: 50 }],
          area: 0,
        })],
      },
    )
    useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')
    const msg = dispatchedPayload()
    expect(msg.type).toBe('COMPUTE_CONTOUR')
    expect(msg.payload.stockBounds).toEqual({
      min: { x: 0, y: 0 },
      max: { x: 100, y: 100 },
    })
  })

  it('closed contour dispatch remains payload-compatible and omits stockBounds', () => {
    installScene(makeOp('contour_2d', makeHeights(), contourParams()))
    useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')
    const msg = dispatchedPayload()
    expect(Object.prototype.hasOwnProperty.call(msg.payload, 'stockBounds')).toBe(false)
  })

  it('open contour fails loud when its active stock has no valid XY extent', async () => {
    installScene(
      makeOp('contour_2d', makeHeights(), {
        ...contourParams(),
        pathType: 'open',
        openSide: 'right',
      }),
      {
        loops: [makeLoop({
          closed: false,
          points: [{ x: 10, y: 50 }, { x: 90, y: 50 }],
          area: 0,
        })],
      },
    )
    useCamStore.setState(state => ({
      project: {
        ...state.project,
        stocks: (state.project.stocks ?? []).map(stock => ({
          ...stock,
          bounds: {
            ...stock.bounds,
            max: { ...stock.bounds.max, x: stock.bounds.min.x },
            size: { ...stock.bounds.size, x: 0 },
          },
        })),
      },
    }))
    await useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')
    // V2 proves the owning stock's bounds before any worker exists, so a
    // zero-extent stock is refused there - earlier than the open-contour XY
    // check, same fail-loud outcome, no dispatch.
    expect(MockWorker.instances).toHaveLength(0)
    expect(opAfter().status).toBe('error')
    expect(opAfter().errorMessage).toMatch(/cannot resolve proven bounds for stock/i)
  })

  it('open contour ignores a viewport scene-union fallback in a valid multi-stock setup', () => {
    installScene(
      makeOp('contour_2d', makeHeights(), {
        ...contourParams(),
        pathType: 'open',
        openSide: 'right',
      }),
      {
        loops: [makeLoop({
          closed: false,
          points: [{ x: 10, y: 50 }, { x: 90, y: 50 }],
          area: 0,
        })],
      },
    )
    const secondStock: PhysicalStock = {
      id: 'stock-2',
      name: 'Stock 2',
      mode: 'explicit',
      bounds: {
        min: { x: 200, y: 0, z: 0 },
        max: { x: 300, y: 100, z: 12 },
        size: { x: 100, y: 100, z: 12 },
        center: { x: 250, y: 50, z: 6 },
      },
      position: { x: 200, y: 0, z: 0 },
    }
    useCamStore.setState(state => ({
      project: {
        ...state.project,
        stocks: [...(state.project.stocks ?? []), secondStock],
      },
    }))
    vi.stubGlobal('window', {
      __cncViewport: {
        // This is CNCViewport's fallback shape when the requested node is
        // absent: the union of stock-1 and stock-2. It must not be accepted.
        getStockBounds: () => ({
          min: { x: 0, y: 0, z: 0 },
          max: { x: 300, y: 100, z: 12 },
        }),
      },
    })
    try {
      useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')
      expect(dispatchedPayload().payload.stockBounds).toEqual({
        min: { x: 0, y: 0 },
        max: { x: 100, y: 100 },
      })
    } finally {
      vi.unstubAllGlobals()
      vi.stubGlobal('Worker', MockWorker)
    }
  })

  it('open contour fails loud on a stale multi-stock binding despite a viewport union fallback', async () => {
    installScene(
      makeOp('contour_2d', makeHeights(), {
        ...contourParams(),
        pathType: 'open',
        openSide: 'right',
      }),
      {
        loops: [makeLoop({
          closed: false,
          points: [{ x: 10, y: 50 }, { x: 90, y: 50 }],
          area: 0,
        })],
      },
    )
    const state = useCamStore.getState()
    const firstStock = state.project.stocks![0]
    useCamStore.setState(current => ({
      project: {
        ...current.project,
        stocks: [
          firstStock,
          {
            ...firstStock,
            id: 'stock-2',
            name: 'Stock 2',
            position: { x: 200, y: 0, z: 0 },
          },
        ],
        setups: current.project.setups.map(setup => ({
          ...setup,
          wcs: { ...setup.wcs, stockId: 'stale-stock-id' },
        })),
      },
    }))
    vi.stubGlobal('window', {
      __cncViewport: {
        getStockBounds: () => ({
          min: { x: 0, y: 0, z: 0 },
          max: { x: 300, y: 100, z: 12 },
        }),
      },
    })
    try {
      await useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')
      // The stale binding names a stock V2 cannot prove; refused before any
      // worker exists and the viewport union never gets a say.
      expect(MockWorker.instances).toHaveLength(0)
      expect(opAfter().status).toBe('error')
      expect(opAfter().errorMessage).toMatch(/cannot resolve proven bounds for stock 'stale-stock-id'/i)
    } finally {
      vi.unstubAllGlobals()
      vi.stubGlobal('Worker', MockWorker)
    }
  })

})
