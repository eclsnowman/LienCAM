// Coordinate hierarchy Phase 2: nested height/zero RESOLUTION.
//
// resolveTopZ / resolveModelBottomZ now resolve a cut's reference plane from the
// geometry's OWNING PhysicalStock (machine -> setup(WCS) -> stock -> geometry),
// not a project-wide flat aggregate. This file proves:
//   1. NO-REGRESSION: a normal single-stock project (AUTO derived, or FIXED
//      explicit) resolves IDENTICALLY to the old flat path - numeric proof.
//   2. CROSS-PART (B22): an op on part A on stock A resolves A's frame, which
//      DIFFERS from the all-geometry aggregate and EQUALS A's stock top.
//   3. FAIL-LOUD (ADR-0003): a multi-stock '__all__' selection, and unassigned
//      geometry, THROW a structured OwningStockError - never a silent blend.
//   4. ROUTING: every one of the 7 op types dispatches through the centralized
//      resolver, so its resolved height reflects the OWNING stock.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import {
  resolveTopZ, resolveModelBottomZ, deriveAutoStockBounds,
  resolveOwningStock, owningStockWorldBounds, OwningStockError,
} from '../../store/dispatchGeo'
import { useCamStore } from '../../store'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'
import type {
  ImportedGeometry, FixedStockItem, SceneStock, Setup, Operation, Tool,
  HeightParams, PassParams, LinkingParams, PhysicalStock, BoundingBox, Vec3,
} from '../../types'

// -- Fixtures ------------------------------------------------------------------

const WCS_Z = 5

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

function makeGeo(over: Partial<ImportedGeometry> = {}): ImportedGeometry {
  return {
    id: 'geo-1', name: 'Part', filename: 'part.dxf', type: 'curves_2d', format: 'dxf',
    boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: 50, y: 50, z: 10 }),
    position: { x: 0, y: 0, z: 1 },
    rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
    loops: [{
      id: 'loop-1',
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
      closed: true, type: 'contour', layerId: 'L1', area: 100,
    }],
    layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
    ...over,
  } as ImportedGeometry
}

function explicitStock(id: string, name: string, min: Vec3, max: Vec3): PhysicalStock {
  return {
    id, name, mode: 'explicit',
    bounds: bbox({ x: 0, y: 0, z: 0 }, { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z }),
    position: { ...min },
  }
}

function derivedStock(id = 'stock-derived'): PhysicalStock {
  return {
    id, name: 'Stock', mode: 'derived',
    bounds: bbox({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }),
    position: { x: 0, y: 0, z: 0 },
  }
}

function makeAutoSceneStock(over: Partial<SceneStock> = {}): SceneStock {
  return {
    mode: 'auto',
    autoOffsetXY: 2, autoOffsetZTop: 1,
    fixedWidth: 100, fixedHeight: 100, fixedDepth: 12,
    fixedStocks: [],
    ...over,
  }
}

function makeFixedSceneStock(stock: FixedStockItem): SceneStock {
  return {
    mode: 'fixed',
    autoOffsetXY: 2, autoOffsetZTop: 1,
    fixedWidth: 100, fixedHeight: 100, fixedDepth: 12,
    fixedStocks: [stock],
  }
}

function makeSetup(stockId: string | undefined, operations: Operation[]): Setup {
  return {
    id: 'setup-1', name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54,
      origin: { x: 0, y: 0, z: WCS_Z },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      ...(stockId ? { stockId } : {}),
    },
    stock: {
      type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0,
      material: 'aluminum',
    } as Setup['stock'],
    operations, notes: '',
  }
}

// =============================================================================
// 1. NO-REGRESSION: single-stock resolves IDENTICALLY to the old flat path
// =============================================================================

describe('Phase 2 no-regression: single-stock AUTO (derived stock owns all geometry)', () => {
  // The migrated common case: lone DERIVED stock, all geometry assigned to it.
  // owningStockWorldBounds(derived) MUST equal deriveAutoStockBounds(all geometry)
  // by construction, so resolveTopZ with stocks == resolveTopZ without (legacy).
  const derived = derivedStock()
  const geo = makeGeo({ stockId: derived.id })
  const sceneStock = makeAutoSceneStock()
  const setup = makeSetup(undefined, [])
  const stocks = [derived]

  it('owningStockWorldBounds(derived) == deriveAutoStockBounds(all geometry) (numeric proof)', () => {
    const flat = deriveAutoStockBounds([geo], sceneStock)!
    const owning = owningStockWorldBounds(derived, [geo], sceneStock)
    expect(owning.min).toEqual(flat.min)
    expect(owning.max).toEqual(flat.max)
  })

  for (const ref of ['stock_top', 'stock_bottom'] as const) {
    it(`${ref}: WITH stocks resolves identically to the legacy flat path`, () => {
      const legacy = resolveTopZ(ref, 0, setup, sceneStock, [geo], 'geo-1')          // 6-arg legacy
      const nested = resolveTopZ(ref, 0, setup, sceneStock, [geo], 'geo-1', stocks)  // 7-arg owning
      expect(nested).toBeCloseTo(legacy, 9)
    })
  }

  for (const ref of ['geometry_face', 'model_top', 'machine_floor', 'wcs_plane', 'absolute'] as const) {
    it(`${ref}: WITH stocks resolves identically to the legacy flat path`, () => {
      const legacy = resolveTopZ(ref, -0.5, setup, sceneStock, [geo], 'geo-1')
      const nested = resolveTopZ(ref, -0.5, setup, sceneStock, [geo], 'geo-1', stocks)
      expect(nested).toBeCloseTo(legacy, 9)
    })
  }

  it('resolveModelBottomZ: WITH stocks resolves identically to the legacy flat path', () => {
    const legacy = resolveModelBottomZ([geo], 'geo-1', WCS_Z)
    const nested = resolveModelBottomZ([geo], 'geo-1', WCS_Z, stocks)
    expect(nested).toBeCloseTo(legacy, 9)
    // __all__ too (single owning member == all geometry).
    const legacyAll = resolveModelBottomZ([geo], '__all__', WCS_Z)
    const nestedAll = resolveModelBottomZ([geo], '__all__', WCS_Z, stocks)
    expect(nestedAll).toBeCloseTo(legacyAll, 9)
  })
})

describe('Phase 2 no-regression: single-stock FIXED (one explicit stock)', () => {
  // World picture matches dispatchHeights: stock 100x100x12 at z=0 (top world 12),
  // WCS at z=5 -> stock top +7, stock bottom -5 in WCS-relative terms.
  const fixed: FixedStockItem = {
    id: 'stock-1', name: 'Stock', width: 100, height: 100, depth: 12,
    position: { x: 0, y: 0, z: 0 },
  }
  const sceneStock = makeFixedSceneStock(fixed)
  const explicit = explicitStock('stock-1', 'Stock', { x: 0, y: 0, z: 0 }, { x: 100, y: 100, z: 12 })
  const geo = makeGeo({ stockId: 'stock-1' })
  const setup = makeSetup('stock-1', [])
  const stocks = [explicit]

  it('stock_top resolves to the same +7 the old pinned-fixedStock path produced', () => {
    const legacy = resolveTopZ('stock_top', 0, setup, sceneStock, [geo], 'geo-1')          // pinned fixedStock
    const nested = resolveTopZ('stock_top', 0, setup, sceneStock, [geo], 'geo-1', stocks)  // owning explicit
    expect(legacy).toBeCloseTo(7, 9)
    expect(nested).toBeCloseTo(7, 9)
  })

  it('stock_bottom resolves to the same -5 the old pinned-fixedStock path produced', () => {
    const legacy = resolveTopZ('stock_bottom', 0, setup, sceneStock, [geo], 'geo-1')
    const nested = resolveTopZ('stock_bottom', 0, setup, sceneStock, [geo], 'geo-1', stocks)
    expect(legacy).toBeCloseTo(-5, 9)
    expect(nested).toBeCloseTo(-5, 9)
  })
})

// =============================================================================
// 2. CROSS-PART (B22): the cut references its OWN stock, not the blend
// =============================================================================

describe('Phase 2 cross-part (B22): an op on part A resolves A\'s stock frame', () => {
  // Two parts on two explicit stocks at different Z:
  //   stock A: world z 0..10  (top 10)   - part A loops at z 2
  //   stock B: world z 0..30  (top 30)   - part B loops at z 20
  // WCS at z=5. resolveTopZ('stock_top') for part A MUST be A's top (10-5=+5),
  // NOT a flat all-stock aggregate (which would pick B's higher top, +25).
  const stockA = explicitStock('stock-A', 'A', { x: 0, y: 0, z: 0 }, { x: 100, y: 100, z: 10 })
  const stockB = explicitStock('stock-B', 'B', { x: 200, y: 0, z: 0 }, { x: 300, y: 100, z: 30 })
  const geoA = makeGeo({ id: 'geo-A', name: 'Part A', stockId: 'stock-A', position: { x: 0, y: 0, z: 2 } })
  const geoB = makeGeo({ id: 'geo-B', name: 'Part B', stockId: 'stock-B', position: { x: 200, y: 0, z: 20 } })
  const sceneStock = makeFixedSceneStock({
    id: 'unused', name: 'unused', width: 1, height: 1, depth: 1, position: { x: 0, y: 0, z: 0 },
  })
  const setup = makeSetup(undefined, [])
  const stocks = [stockA, stockB]
  const geometry = [geoA, geoB]

  it('resolveOwningStock picks the named geometry\'s stock', () => {
    expect(resolveOwningStock('geo-A', geometry, stocks).id).toBe('stock-A')
    expect(resolveOwningStock('geo-B', geometry, stocks).id).toBe('stock-B')
  })

  it('stock_top for part A == A\'s stock top (+5), and DIFFERS from the all-geometry blend', () => {
    const aTop = resolveTopZ('stock_top', 0, setup, sceneStock, geometry, 'geo-A', stocks)
    expect(aTop).toBeCloseTo(5, 9)            // A's top world 10 - WCS 5
    // The flat aggregate over BOTH stocks would surface B's higher top (+25).
    // Prove the nested value is NOT that blend.
    expect(aTop).not.toBeCloseTo(25, 6)
  })

  it('stock_top for part B == B\'s stock top (+25)', () => {
    const bTop = resolveTopZ('stock_top', 0, setup, sceneStock, geometry, 'geo-B', stocks)
    expect(bTop).toBeCloseTo(25, 9)           // B's top world 30 - WCS 5
  })

  it('model_top __all__ is constrained to a single owning stock (would throw if it spanned)', () => {
    // A single-part selection on geo-A resolves A's member model top (2+10-5=+7).
    const aModelTop = resolveTopZ('model_top', 0, setup, sceneStock, geometry, 'geo-A', stocks)
    expect(aModelTop).toBeCloseTo(7, 9)
  })
})

// =============================================================================
// 3. FAIL-LOUD (ADR-0003)
// =============================================================================

describe('Phase 2 fail-loud: resolveOwningStock', () => {
  const stockA = explicitStock('stock-A', 'A', { x: 0, y: 0, z: 0 }, { x: 100, y: 100, z: 10 })
  const stockB = explicitStock('stock-B', 'B', { x: 200, y: 0, z: 0 }, { x: 300, y: 100, z: 30 })

  it('__all__ spanning two stocks throws a structured multi-stock error', () => {
    const geoA = makeGeo({ id: 'geo-A', name: 'Part A', stockId: 'stock-A' })
    const geoB = makeGeo({ id: 'geo-B', name: 'Part B', stockId: 'stock-B' })
    expect(() => resolveOwningStock('__all__', [geoA, geoB], [stockA, stockB]))
      .toThrow(OwningStockError)
    expect(() => resolveOwningStock('__all__', [geoA, geoB], [stockA, stockB]))
      .toThrow(/spans multiple stocks/)
  })

  it('resolveTopZ on a multi-stock __all__ selection throws (no silent blend)', () => {
    const geoA = makeGeo({ id: 'geo-A', name: 'Part A', stockId: 'stock-A' })
    const geoB = makeGeo({ id: 'geo-B', name: 'Part B', stockId: 'stock-B' })
    const setup = makeSetup(undefined, [])
    const sceneStock = makeAutoSceneStock()
    expect(() => resolveTopZ('stock_top', 0, setup, sceneStock, [geoA, geoB], '__all__', [stockA, stockB]))
      .toThrow(OwningStockError)
  })

  it('named geometry with undefined stockId throws (unassigned)', () => {
    const geo = makeGeo({ id: 'geo-x', name: 'Orphan', stockId: undefined })
    expect(() => resolveOwningStock('geo-x', [geo], [stockA]))
      .toThrow(/not assigned to any stock/)
  })

  it('named geometry with a dangling stockId throws (stock does not exist)', () => {
    const geo = makeGeo({ id: 'geo-x', name: 'Dangling', stockId: 'stock-gone' })
    expect(() => resolveOwningStock('geo-x', [geo], [stockA]))
      .toThrow(/does not exist/)
  })

  it('__all__ with an unassigned selectable geometry throws', () => {
    const geoA = makeGeo({ id: 'geo-A', name: 'Part A', stockId: 'stock-A' })
    const orphan = makeGeo({ id: 'geo-x', name: 'Orphan', stockId: undefined })
    expect(() => resolveOwningStock('__all__', [geoA, orphan], [stockA]))
      .toThrow(/not assigned to an existing stock/)
  })

  it('missing named geometry throws', () => {
    expect(() => resolveOwningStock('geo-nope', [], [stockA]))
      .toThrow(/was not found/)
  })
})

// =============================================================================
// 3b. OWNING-GEOMETRY (ADR-0020 rule 2): '__all__' + loopIds narrows the
//     geometry-derived aggregate to the parts that OWN the selected loops.
// =============================================================================

describe('Phase 2 owning-geometry: __all__ + loopIds resolves the selected parts\' plane', () => {
  // ONE explicit stock, ONE WCS, TWO parts both assigned to it (single-stock so
  // resolveOwningStock does NOT throw - the multi-stock guard still runs first and
  // passes). Distinct loop ids so geometriesOwningSelection can tell them apart.
  // WCS at z=5. model_top = position.z + bbox.max.z; geometry_face (plain DXF) =
  // position.z; model_bottom = position.z + bbox.min.z.
  //   part A: position z 4, bbox 0..8  -> model_top world 12 (+7), face 4 (-1), bottom 4 (-1)
  //   part B: position z 1, bbox 0..1  -> model_top world 2  (-3), face 1 (-4), bottom 1 (-4)
  // Aggregate over BOTH: model_top max 12 (+7); geometry_face max 4 (-1, A);
  //   model_bottom min 1 (-4, B). A dominates top+face; B dominates bottom.
  const stock = explicitStock('stock-1', 'Stock', { x: 0, y: 0, z: 0 }, { x: 200, y: 100, z: 14 })
  const geoA = makeGeo({
    id: 'geo-A', name: 'Tall', stockId: 'stock-1',
    boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: 50, y: 50, z: 8 }),
    position: { x: 0, y: 0, z: 4 },
    loops: [{ id: 'loop-A', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], closed: true, type: 'contour', layerId: 'L1', area: 1 }],
  })
  const geoB = makeGeo({
    id: 'geo-B', name: 'Short', stockId: 'stock-1',
    boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: 50, y: 50, z: 1 }),
    position: { x: 100, y: 0, z: 1 },
    loops: [{ id: 'loop-B', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], closed: true, type: 'contour', layerId: 'L1', area: 1 }],
  })
  const sceneStock = makeAutoSceneStock()
  const setup = makeSetup(undefined, [])
  const geometry = [geoA, geoB]
  const stocks = [stock]

  // 1. A selection on B only resolves B's plane, NOT the A/B aggregate.
  it('model_top __all__ + [loop on B] resolves B\'s plane (-3), NOT the A/B max (+7)', () => {
    const z = resolveTopZ('model_top', 0, setup, sceneStock, geometry, '__all__', stocks, ['loop-B'])
    expect(z).toBeCloseTo(-3, 9)   // B model top world 2 - WCS 5
    expect(z).not.toBeCloseTo(7, 6)
  })
  it('geometry_face __all__ + [loop on B] resolves B\'s plane (-4), NOT the A/B max (-1)', () => {
    const z = resolveTopZ('geometry_face', 0, setup, sceneStock, geometry, '__all__', stocks, ['loop-B'])
    expect(z).toBeCloseTo(-4, 9)   // B face world 1 - WCS 5
    expect(z).not.toBeCloseTo(-1, 6)
  })

  // 2. resolveModelBottomZ narrowed to A resolves A's bottom (-1), NOT min(A,B) (-4).
  it('resolveModelBottomZ __all__ + [loop on A] resolves A\'s bottom (-1), NOT the A/B min (-4)', () => {
    const z = resolveModelBottomZ(geometry, '__all__', WCS_Z, stocks, ['loop-A'])
    expect(z).toBeCloseTo(-1, 9)   // A bottom world 4 - WCS 5
    expect(z).not.toBeCloseTo(-4, 6)
  })

  // 3. A selection spanning A+B aggregates over {A,B} (here == all -> the max/min).
  it('model_top __all__ + [loop on A, loop on B] aggregates over both (+7)', () => {
    const z = resolveTopZ('model_top', 0, setup, sceneStock, geometry, '__all__', stocks, ['loop-A', 'loop-B'])
    expect(z).toBeCloseTo(7, 9)
  })
  it('resolveModelBottomZ __all__ + [loop on A, loop on B] aggregates over both (-4)', () => {
    const z = resolveModelBottomZ(geometry, '__all__', WCS_Z, stocks, ['loop-A', 'loop-B'])
    expect(z).toBeCloseTo(-4, 9)
  })

  // 4. Empty loopIds is byte-identical to the prior (no-loopIds) call.
  it('empty loopIds resolves identically to the no-loopIds call (no regression)', () => {
    for (const ref of ['model_top', 'geometry_face'] as const) {
      const before = resolveTopZ(ref, 0, setup, sceneStock, geometry, '__all__', stocks)
      const empty  = resolveTopZ(ref, 0, setup, sceneStock, geometry, '__all__', stocks, [])
      expect(empty).toBeCloseTo(before, 9)
    }
    const bBefore = resolveModelBottomZ(geometry, '__all__', WCS_Z, stocks)
    const bEmpty  = resolveModelBottomZ(geometry, '__all__', WCS_Z, stocks, [])
    expect(bEmpty).toBeCloseTo(bBefore, 9)
  })

  // 5. An orphaned/unknown loop id falls back to ALL members (no throw, ADR-0003
  //    no second fail-loud - the multi-stock guard already passed).
  it('an unknown loopId falls back to all members (aggregate, no throw)', () => {
    expect(() => resolveTopZ('model_top', 0, setup, sceneStock, geometry, '__all__', stocks, ['loop-nope']))
      .not.toThrow()
    const z = resolveTopZ('model_top', 0, setup, sceneStock, geometry, '__all__', stocks, ['loop-nope'])
    expect(z).toBeCloseTo(7, 9)   // fell back to the A/B aggregate
  })
})

// =============================================================================
// 4. ROUTING: every op type dispatches through the centralized resolver
// =============================================================================

type Posted = { type: string; payload: { heights: HeightParams } }

class MockWorker {
  static instances: MockWorker[] = []
  posted: Posted[] = []
  onmessage: ((e: unknown) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  constructor(_url: unknown, _opts?: unknown) { MockWorker.instances.push(this) }
  postMessage(msg: Posted): void { this.posted.push(msg) }
  terminate(): void { /* no-op */ }
}

const passes: PassParams = {
  stepdown: 2, stepover: 1.6, stockToLeave: 0, finishPasses: 0, springPasses: 0,
}
const linking: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 10,
  leadInRadius: 0, leadOutRadius: 0, retractType: 'full', transitionType: 'safe_height',
}
function makeTool(): Tool {
  return {
    id: 'tool-1', name: '4mm EM', type: 'flat_endmill',
    diameter: 4, fluteLength: 12, shankDiameter: 4, overallLength: 50,
    numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
    feedsAndSpeeds: { default: { rpm: 12000, feedRate: 800, plungeRate: 200, depthOfCut: 2, stepover: 1.6 } },
  } as unknown as Tool
}
// Valid ordering for stock-top resolving to +7: clearance 20 >= retract 10 >=
// feed 8 >= top 7 > bottom -3.
function makeHeights(over: Partial<HeightParams> = {}): HeightParams {
  return {
    clearanceHeight: 20, clearanceHeightMode: 'absolute',
    retractHeight: 10, feedHeight: 8,
    topHeight: 0, topHeightMode: 'stock_top',
    bottomHeight: -3, bottomHeightMode: 'absolute',
    ...over,
  }
}
function makeOp(
  type: Operation['type'], params: Record<string, unknown>, heights = makeHeights(),
  explicitDepthMm?: number,
): Operation {
  return {
    id: 'op-1', name: 'Op', type, enabled: true, status: 'pending',
    toolId: 'tool-1', geometrySelections: [],
    // Smart Height V2 is the only runtime authority (2e5678b7); stamp a
    // valid envelope so dispatch reaches the owning-stock routing under
    // test instead of being refused earlier for want of authority
    // (ADR-0040).
    smartHeight: smartHeightAuthorityFixture(type, { heights, params, geometryIds: ['geo-1'], explicitDepthMm }),
    heights, passes, linking, params,
  }
}

// Install a single-explicit-stock scene where stock top resolves to +7 (world 12,
// WCS 5). Each op's resolved reference plane must reflect THAT stock.
function installScene(op: Operation): void {
  const fixed: FixedStockItem = {
    id: 'stock-1', name: 'Stock', width: 100, height: 100, depth: 12, position: { x: 0, y: 0, z: 0 },
  }
  const explicit = explicitStock('stock-1', 'Stock', { x: 0, y: 0, z: 0 }, { x: 100, y: 100, z: 12 })
  useCamStore.setState(s => ({
    project: {
      ...s.project,
      geometry: [makeGeo({ stockId: 'stock-1' })],
      setups: [makeSetup('stock-1', [op])],
      sceneStock: makeFixedSceneStock(fixed),
      stocks: [explicit],
      activeSetupId: 'setup-1',
      activeOperationId: 'op-1',
    },
    // Tool library is now a ROOT slice (single source of truth).
    toolLibrary: [makeTool()],
    toolpathBatch: null,
  }))
}

function dispatched(): Posted {
  expect(MockWorker.instances.length).toBe(1)
  return MockWorker.instances[0].posted[0]
}

// MockWorker never answers (no onmessage callback fires), so awaiting
// computeOperationToolpath's own returned promise to completion hangs
// forever on the success path. planarRough ops (pocket_2d/
// adaptive_clearing_2d) resolve their V2 authority via an internally
// `await`ed step before the worker post, though, so the dispatch has not
// happened yet on the very next synchronous line either. Flushing a couple
// of microtasks lets that internal resolution settle without waiting on the
// (never-arriving) worker response.
async function flushMicrotasks(turns = 4): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve()
}

describe('Phase 2 routing: each op type resolves its plane from the OWNING stock', () => {
  beforeEach(() => {
    MockWorker.instances = []
    vi.stubGlobal('Worker', MockWorker)
  })
  afterAll(() => { vi.unstubAllGlobals() })

  // contour / AC: topHeightMode 'stock_top' -> the owning stock top (+7). The
  // generic Smart Height V2 fixture's contour 'through_stock' and planarRough
  // 'explicit_depth' variants both resolve their machining Start plane via
  // policy default (real owning-stock top), so this still proves routing.
  //
  // Retired 2026-08-18: 'drill' was dropped from this loop. Drill's V2
  // 'explicit_depth' variant (the only one a fixture can author without real
  // hole-feature evidence) takes a literal WCS Z number for BOTH start and
  // end - there is no "resolve from stock_top" option the way contour/
  // planarRough's policy default gives, so a fixture can no longer prove
  // owning-stock routing for drill through this dispatch-payload path. Per-
  // family V2 dispatch truth lives in src/tests/store/smartHeight*Store
  // .phase*.test.ts and src/tests/cam/smartHeight*.phase*.test.ts.
  for (const [type, params] of [
    ['contour_2d', { geometryId: 'geo-1', loopIds: [], side: 'outer', direction: 'climb', tabs: false }],
    ['adaptive_clearing_2d', {
      geometryId: 'geo-1', loopIds: [], targetEngagement: 0.4, maxEngagement: 0.7,
      stepDistance: 0.4, thetaMax: 1, climb: true, rampAngle: 3, completionTolerance: 1,
    }],
  ] as const) {
    it(`${type}: top resolves to the owning stock top (+7)`, async () => {
      installScene(makeOp(type, params as Record<string, unknown>))
      void useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')
      await flushMicrotasks()
      expect(dispatched().payload.heights.topHeight).toBeCloseTo(7, 9)
    })
  }

  it('pocket_2d: bottom resolves from the owning stock top reference (+7 - 4 = +3)', async () => {
    // Pocket resolves only the BOTTOM via heightReference; top stays the raw
    // op.heights.topHeight. Set top absolute +10 so ordering holds (feed 12 >=
    // top 10 > resolved bottom 3).
    //
    // Under V2 the generic fixture's planarRough 'explicit_depth' variant
    // takes the END plane as a literal WCS Z number (not a depth-from-start
    // offset) - explicitDepthMm negates into that literal value
    // (smartHeightAuthorityFixture: explicitTargetWcsMm = -explicitDepthMm),
    // so -3 here authors the literal target +3 this test proves against.
    installScene(makeOp('pocket_2d', {
      geometryId: 'geo-1', loopIds: [], side: 'inner', direction: 'climb',
      heightReference: 'stock_top', planeOffset: -4,
    }, makeHeights({
      topHeight: 10, topHeightMode: 'absolute',
      feedHeight: 12, retractHeight: 14, clearanceHeight: 20,
    }), -3))
    void useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')
    await flushMicrotasks()
    expect(dispatched().payload.heights.bottomHeight).toBeCloseTo(3, 9)
  })

  // Retired 2026-08-18: chamfer's V2 authority (buildChamferSmartHeightIntent)
  // needs real selected-edge evidence a fixture cannot invent - the shared
  // helper's minimalEnvelopeIntent stamps the smallest envelope the
  // AUTHORITY accepts (policy/scope), and the resolver truthfully refuses at
  // compute for want of features (see smartHeightAuthorityFixture.ts's own
  // header comment). This test's heightReference/planeOffset premise is also
  // the V1 story chamfer's V2 path no longer computes. Per-family V2
  // dispatch truth lives in src/tests/store/smartHeight*Store.phase*.test.ts
  // and src/tests/cam/smartHeight*.phase*.test.ts.
  it('engrave: top resolves from the owning stock (heightReference stock_top -> +7)', () => {
    installScene(makeOp('engrave', {
      geometryId: 'geo-1', loopIds: [], includeOpen: true, includeClosed: true,
      heightReference: 'stock_top', planeOffset: 0,
    }, makeHeights({ topHeight: 0, topHeightMode: 'absolute' })))
    useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')
    expect(dispatched().payload.heights.topHeight).toBeCloseTo(7, 9)
  })

  it('face: top resolves from the owning stock (heightReference stock_top -> +7)', () => {
    // boundarySource 'geometry' avoids the viewport-stock-bounds branch (no
    // viewport in the test harness) and routes through resolveOpRefZ.
    installScene(makeOp('face', {
      geometryId: 'geo-1', loopIds: [], boundarySource: 'geometry',
      pattern: 'linear', stepover: 1.6, direction: 'climb',
      heightReference: 'stock_top', planeOffset: 0,
    }, makeHeights({ topHeight: 0, topHeightMode: 'absolute' })))
    useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')
    expect(dispatched().payload.heights.topHeight).toBeCloseTo(7, 9)
  })

  it('fail-loud at dispatch: a multi-stock __all__ selection errors the op, no worker', () => {
    const explicitA = explicitStock('stock-A', 'A', { x: 0, y: 0, z: 0 }, { x: 100, y: 100, z: 10 })
    const explicitB = explicitStock('stock-B', 'B', { x: 200, y: 0, z: 0 }, { x: 300, y: 100, z: 30 })
    const params = { geometryId: '__all__', loopIds: [], side: 'outer', direction: 'climb', tabs: false }
    const heights = makeHeights()
    const op: Operation = {
      id: 'op-1', name: 'Op', type: 'contour_2d', enabled: true, status: 'pending',
      toolId: 'tool-1', geometrySelections: [],
      // Smart Height V2's Setup-level stock proof (setupProvenStockId) runs
      // BEFORE any per-geometry scope check, so a '__all__' selection whose
      // members span two DIFFERENT stocks can no longer surface
      // resolveOwningStock's 'spans multiple stocks' message through this
      // path - it needs one Setup-bound stock to get past that gate at all.
      // Binding the Setup to stock-A and scoping the intent to BOTH parts'
      // ids reaches the next V2 fail-loud instead: the per-geometry "belongs
      // to a stock other than mine" refusal. Still "no silent blend" - a
      // different, and now the real, message.
      smartHeight: smartHeightAuthorityFixture('contour_2d', { heights, params, geometryIds: ['geo-A', 'geo-B'] }),
      heights, passes, linking, params,
    }
    useCamStore.setState(s => ({
      project: {
        ...s.project,
        geometry: [
          makeGeo({ id: 'geo-A', name: 'Part A', stockId: 'stock-A' }),
          makeGeo({ id: 'geo-B', name: 'Part B', stockId: 'stock-B' }),
        ],
        setups: [makeSetup('stock-A', [op])],
        sceneStock: makeAutoSceneStock(),
        stocks: [explicitA, explicitB],
        activeSetupId: 'setup-1',
        activeOperationId: 'op-1',
      },
      // Tool library is now a ROOT slice (single source of truth).
      toolLibrary: [makeTool()],
      toolpathBatch: null,
    }))
    useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')
    expect(MockWorker.instances.length).toBe(0)
    const after = useCamStore.getState().project.setups[0].operations[0]
    expect(after.status).toBe('error')
    expect(after.errorMessage).toContain("not this Setup's stock")
  })
})
