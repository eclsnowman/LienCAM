// Coordinate-hierarchy migration (Phase 0) unit tests.
//
// migrateProjectToHierarchy is PURE + IDEMPOTENT and must NOT change any value a
// resolver reads. These tests assert: the additive hierarchy fields are written
// correctly (stocks, geometry.stockId, wcs.originBinding), the migrator is
// idempotent, it does not mutate its input, and — the load-bearing invariant —
// it leaves every legacy field a resolver reads byte-for-byte unchanged.

import { describe, it, expect } from 'vitest'
import {
  migrateProjectToHierarchy,
  ensureDefaultAutoStock,
  DERIVED_STOCK_ID,
} from '../../store/migrateHierarchy'
import type {
  Project,
  ImportedGeometry,
  Setup,
  WCS,
  Operation,
  SceneStock,
  FixedStockItem,
  HeightParams,
  PassParams,
  LinkingParams,
  MachineConfig,
} from '../../types'

// -- fixtures --------------------------------------------------------------------

const machine: MachineConfig = {
  id: 'm-1', name: 'Router', type: 'gantry_router', controller: 'grbl',
  travel: { x: 800, y: 600, z: 100 },
  rapidRate: 5000, maxSpindleRpm: 24000, minSpindleRpm: 8000,
  spindleDirection: 'cw', toolChanger: 'manual', coolant: false,
  axisLimits: {
    x: { maxCutting: 3000, maxRapid: 5000 },
    y: { maxCutting: 3000, maxRapid: 5000 },
    z: { maxCutting: 1000, maxRapid: 3000 },
  },
  notes: '',
}

const autoSceneStock: SceneStock = {
  mode: 'auto', autoOffsetXY: 2, autoOffsetZTop: 1,
  fixedWidth: 100, fixedHeight: 100, fixedDepth: 12, fixedStocks: [],
}

function makeGeo(id: string, stockId?: string): ImportedGeometry {
  return {
    id, name: id, filename: `${id}.dxf`, type: 'curves_2d', format: 'dxf',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 0 },
      size: { x: 10, y: 10, z: 0 }, center: { x: 5, y: 5, z: 0 },
    },
    position: { x: 1, y: 2, z: 3 },
    rotation: { x: 0, y: 0, z: 90 },
    loaded: true,
    ...(stockId ? { stockId } : {}),
  }
}

const heights: HeightParams = {
  clearanceHeight: 10, clearanceHeightMode: 'relative',
  retractHeight: 5, feedHeight: 1,
  topHeight: 0, topHeightMode: 'stock_top',
  bottomHeight: -5, bottomHeightMode: 'absolute',
}
const passes: PassParams = {
  stepdown: 1.5, stepover: 3, stockToLeave: 0.2, finishPasses: 0, springPasses: 0,
}
const linking: LinkingParams = {
  entryType: 'plunge', rampAngle: 2, rampLength: 5,
  leadInRadius: 1.5, leadOutRadius: 1, retractType: 'full', transitionType: 'safe_height',
}

function makeOp(id: string, type: Operation['type']): Operation {
  return {
    id, name: id, type, enabled: true, status: 'ready',
    toolId: 't-1', geometrySelections: ['loop-1'],
    heights: structuredClone(heights),
    passes: structuredClone(passes),
    linking: structuredClone(linking),
    params: { foo: 'bar' },
  }
}

function makeWcs(over: Partial<WCS> = {}): WCS {
  return {
    id: 'wcs-1', label: 'G54', fixtureOffset: 54,
    origin: { x: 7, y: 8, z: 9 },
    xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
    ...over,
  }
}

function makeSetup(id: string, wcs: WCS, ops: Operation[]): Setup {
  return {
    id, name: id, wcs,
    stock: {
      type: 'rectangular', width: 100, height: 100, depth: 12,
      offsetX: 2, offsetY: 2, offsetZTop: 1, offsetZBottom: 0, material: 'al',
    },
    operations: ops, notes: '',
  }
}

function makeProject(over: Partial<Project> = {}): Project {
  return {
    id: 'p-1', name: 'Proj', version: '1.0.0',
    createdAt: '2026-06-13T00:00:00.000Z', updatedAt: '2026-06-13T00:00:00.000Z',
    machine, toolLibrary: [],
    geometry: [makeGeo('geo-a')],
    setups: [],
    activeSetupId: null, activeOperationId: null,
    sceneStock: structuredClone(autoSceneStock),
    notes: '',
    ...over,
  }
}

// -- tests -----------------------------------------------------------------------

describe('migrateProjectToHierarchy: stocks + geometry membership', () => {
  it('old single-auto-stock project gets a lone derived stock owning all geometry', () => {
    const p = makeProject({ geometry: [makeGeo('geo-a'), makeGeo('geo-b')] })
    const out = migrateProjectToHierarchy(p)

    expect(out.stocks).toBeDefined()
    expect(out.stocks!.length).toBe(1)
    expect(out.stocks![0].id).toBe(DERIVED_STOCK_ID)
    expect(out.stocks![0].mode).toBe('derived')
    // The catch-all derived stock IS the default visible AUTO stock now
    // (ensureDefaultAutoStock), so its name is the default auto-stock name.
    expect(out.stocks![0].name).toBe('Auto Stock 1')

    for (const g of out.geometry) {
      expect(g.stockId).toBe(DERIVED_STOCK_ID)
    }
  })

  it('a project with no autoStocks gains the default visible AUTO stock (catch-all)', () => {
    // ensureDefaultAutoStock: every project always carries >=1 visible auto
    // stock so new imports have a box + working ops. The default auto stock IS
    // the catch-all (id === DERIVED_STOCK_ID) — no second stock id is minted.
    const p = makeProject() // sceneStock has no autoStocks key
    const out = migrateProjectToHierarchy(p)
    const autoStocks = out.sceneStock.autoStocks ?? []
    expect(autoStocks.length).toBe(1)
    expect(autoStocks[0].id).toBe(DERIVED_STOCK_ID)
    expect(autoStocks[0].name).toBe('Auto Stock 1')
    // ...and it maps to exactly ONE PhysicalStock (no duplicate id).
    expect(out.stocks!.filter((s) => s.id === DERIVED_STOCK_ID).length).toBe(1)
  })

  it('multi-fixedStock project gets derived + explicit stocks reusing fixed ids', () => {
    const fixedStocks: FixedStockItem[] = [
      { id: 'fs-1', name: 'Block A', width: 50, height: 60, depth: 20, position: { x: 1, y: 2, z: 3 } },
      { id: 'fs-2', name: 'Block B', width: 30, height: 40, depth: 10, position: { x: 4, y: 5, z: 6 } },
    ]
    const p = makeProject({
      geometry: [makeGeo('geo-a'), makeGeo('geo-b')],
      sceneStock: { ...structuredClone(autoSceneStock), mode: 'fixed', fixedStocks },
    })
    const out = migrateProjectToHierarchy(p)

    expect(out.stocks!.length).toBe(3) // derived + 2 explicit
    expect(out.stocks![0].id).toBe(DERIVED_STOCK_ID)

    const a = out.stocks!.find((s) => s.id === 'fs-1')!
    expect(a.mode).toBe('explicit')
    expect(a.name).toBe('Block A')
    expect(a.bounds.max).toEqual({ x: 50, y: 60, z: 20 })
    expect(a.bounds.min).toEqual({ x: 0, y: 0, z: 0 })
    expect(a.position).toEqual({ x: 1, y: 2, z: 3 })

    const b = out.stocks!.find((s) => s.id === 'fs-2')!
    expect(b.bounds.max).toEqual({ x: 30, y: 40, z: 10 })
    expect(b.position).toEqual({ x: 4, y: 5, z: 6 })

    // Members NOT sorted yet (Phase 1): all geometry on the lone derived stock.
    for (const g of out.geometry) {
      expect(g.stockId).toBe(DERIVED_STOCK_ID)
    }
  })

  it('one derived PhysicalStock per named autoStock (id reused, mode derived)', () => {
    const p = makeProject({
      sceneStock: {
        ...structuredClone(autoSceneStock),
        autoStocks: [
          { id: 'auto-1', name: 'Auto A', autoOffsetXY: 3, autoOffsetZTop: 1 },
          { id: 'auto-2', name: 'Auto B', autoOffsetXY: 0, autoOffsetZTop: 0 },
        ],
      },
    })
    const out = migrateProjectToHierarchy(p)

    // derived + 2 auto-derived stocks.
    expect(out.stocks!.length).toBe(3)
    const a = out.stocks!.find((s) => s.id === 'auto-1')!
    expect(a.mode).toBe('derived')
    expect(a.name).toBe('Auto A')
    const b = out.stocks!.find((s) => s.id === 'auto-2')!
    expect(b.mode).toBe('derived')
    expect(b.name).toBe('Auto B')
  })

  it('no autoStocks field still yields exactly one PhysicalStock (the catch-all)', () => {
    // The default auto stock shares the catch-all id, so the stock COUNT is
    // unchanged (one) even though sceneStock.autoStocks is now populated.
    const p = makeProject() // sceneStock has no autoStocks key
    const out = migrateProjectToHierarchy(p)
    expect(out.stocks!.length).toBe(1)
    expect(out.stocks![0].id).toBe(DERIVED_STOCK_ID)
  })

  it('idempotent with autoStocks: a present auto-derived stock is reused verbatim', () => {
    const p = makeProject({
      sceneStock: {
        ...structuredClone(autoSceneStock),
        autoStocks: [{ id: 'auto-1', name: 'Auto A', autoOffsetXY: 3, autoOffsetZTop: 1 }],
      },
    })
    const once = migrateProjectToHierarchy(p)
    const twice = migrateProjectToHierarchy(once)
    expect(twice.stocks).toEqual(once.stocks)
    // Same reference for the auto stock (returned verbatim, not re-minted).
    const a1 = once.stocks!.find((s) => s.id === 'auto-1')!
    const a2 = twice.stocks!.find((s) => s.id === 'auto-1')!
    expect(a2).toBe(a1)
  })

  it('does not overwrite an existing geometry.stockId', () => {
    const p = makeProject({ geometry: [makeGeo('geo-a', 'fs-7'), makeGeo('geo-b')] })
    const out = migrateProjectToHierarchy(p)
    expect(out.geometry.find((g) => g.id === 'geo-a')!.stockId).toBe('fs-7')
    expect(out.geometry.find((g) => g.id === 'geo-b')!.stockId).toBe(DERIVED_STOCK_ID)
  })
})

describe('ensureDefaultAutoStock', () => {
  it('adds the default catch-all auto stock when none exist', () => {
    const p = makeProject()
    const out = ensureDefaultAutoStock(p)
    expect(out.sceneStock.autoStocks).toEqual([
      { id: DERIVED_STOCK_ID, name: 'Auto Stock 1', autoOffsetXY: 2, autoOffsetZTop: 1, autoOffsetZBottom: 0 },
    ])
  })

  it('is a no-op (same reference) when auto stocks already exist', () => {
    const p = makeProject({
      sceneStock: {
        ...structuredClone(autoSceneStock),
        autoStocks: [{ id: 'auto-1', name: 'Auto A', autoOffsetXY: 3, autoOffsetZTop: 1 }],
      },
    })
    const out = ensureDefaultAutoStock(p)
    expect(out).toBe(p) // unchanged reference: not forced to gain the default
  })

  it('does not mutate the input project', () => {
    const p = makeProject()
    const snapshot = structuredClone(p)
    ensureDefaultAutoStock(p)
    expect(p).toEqual(snapshot)
  })
})

describe('migrateProjectToHierarchy: WCS origin binding from legacy fields', () => {
  it('stockId + corner -> stock_corner originBinding (legacy fields preserved)', () => {
    const wcs = makeWcs({ stockId: 'fs-1', cornerRow: 2, cornerCol: 1, cornerFace: 'bottom' })
    const p = makeProject({ setups: [makeSetup('s-1', wcs, [])] })
    const out = migrateProjectToHierarchy(p)

    const ob = out.setups[0].wcs.originBinding
    expect(ob).toEqual({
      kind: 'stock_corner', stockId: 'fs-1', cornerRow: 2, cornerCol: 1, cornerFace: 'bottom',
    })
    // legacy fields untouched
    expect(out.setups[0].wcs.stockId).toBe('fs-1')
    expect(out.setups[0].wcs.cornerRow).toBe(2)
    expect(out.setups[0].wcs.cornerCol).toBe(1)
    expect(out.setups[0].wcs.cornerFace).toBe('bottom')
  })

  it('stock_corner defaults corner row/col/face when absent', () => {
    const wcs = makeWcs({ stockId: 'fs-1' })
    const p = makeProject({ setups: [makeSetup('s-1', wcs, [])] })
    const out = migrateProjectToHierarchy(p)
    expect(out.setups[0].wcs.originBinding).toEqual({
      kind: 'stock_corner', stockId: 'fs-1', cornerRow: 0, cornerCol: 0, cornerFace: 'top',
    })
  })

  it('snapGeoId + snapLocalPt -> part_feature vertex originBinding', () => {
    const wcs = makeWcs({ snapGeoId: 'geo-a', snapLocalPt: { x: 3, y: 4, z: 5 } })
    const p = makeProject({ setups: [makeSetup('s-1', wcs, [])] })
    const out = migrateProjectToHierarchy(p)

    expect(out.setups[0].wcs.originBinding).toEqual({
      kind: 'part_feature', geoId: 'geo-a', featureRef: { kind: 'vertex', localPt: { x: 3, y: 4, z: 5 } },
    })
    expect(out.setups[0].wcs.snapGeoId).toBe('geo-a')
    expect(out.setups[0].wcs.snapLocalPt).toEqual({ x: 3, y: 4, z: 5 })
  })

  it('AUTO-mode corner (cornerRow/Col set, no stockId, no snap) -> stock_corner bound to DERIVED_STOCK_ID', () => {
    // Legacy auto/derived stock historically had no id, so an auto-mode corner
    // pick writes cornerRow/Col/Face but NO stockId. This WCS IS corner-bound to
    // the derived stock and re-derives when it changes — it must NOT be 'manual'.
    const wcs = makeWcs({ cornerRow: 1, cornerCol: 2, cornerFace: 'bottom' })
    const p = makeProject({ setups: [makeSetup('s-1', wcs, [])] })
    const out = migrateProjectToHierarchy(p)
    expect(out.setups[0].wcs.originBinding).toEqual({
      kind: 'stock_corner', stockId: DERIVED_STOCK_ID, cornerRow: 1, cornerCol: 2, cornerFace: 'bottom',
    })
    // legacy fields untouched; no stockId minted onto the legacy WCS
    expect(out.setups[0].wcs.stockId).toBeUndefined()
    expect(out.setups[0].wcs.cornerRow).toBe(1)
    expect(out.setups[0].wcs.cornerCol).toBe(2)
  })

  it('AUTO-mode corner with no cornerFace defaults cornerFace to top', () => {
    const wcs = makeWcs({ cornerRow: 0, cornerCol: 0 })
    const p = makeProject({ setups: [makeSetup('s-1', wcs, [])] })
    const out = migrateProjectToHierarchy(p)
    expect(out.setups[0].wcs.originBinding).toEqual({
      kind: 'stock_corner', stockId: DERIVED_STOCK_ID, cornerRow: 0, cornerCol: 0, cornerFace: 'top',
    })
  })

  it('truly-manual (no corner, no snap, no stockId) -> manual originBinding', () => {
    const wcs = makeWcs()
    const p = makeProject({ setups: [makeSetup('s-1', wcs, [])] })
    const out = migrateProjectToHierarchy(p)
    expect(out.setups[0].wcs.originBinding).toEqual({ kind: 'manual' })
  })
})

describe('migrateProjectToHierarchy: idempotency + purity', () => {
  it('migrate(migrate(p)) deep-equals migrate(p)', () => {
    const fixedStocks: FixedStockItem[] = [
      { id: 'fs-1', name: 'Block A', width: 50, height: 60, depth: 20, position: { x: 1, y: 2, z: 3 } },
    ]
    const p = makeProject({
      geometry: [makeGeo('geo-a'), makeGeo('geo-b')],
      sceneStock: { ...structuredClone(autoSceneStock), mode: 'fixed', fixedStocks },
      setups: [
        makeSetup('s-1', makeWcs({ stockId: 'fs-1', cornerRow: 1 }), [makeOp('op-1', 'pocket_2d')]),
        makeSetup('s-2', makeWcs({ id: 'wcs-2', snapGeoId: 'geo-a', snapLocalPt: { x: 1, y: 1, z: 1 } }), []),
      ],
    })
    const once = migrateProjectToHierarchy(p)
    const twice = migrateProjectToHierarchy(once)
    expect(twice).toEqual(once)
  })

  it('does not mutate the input project', () => {
    const p = makeProject({
      geometry: [makeGeo('geo-a')],
      setups: [makeSetup('s-1', makeWcs({ stockId: 'fs-1' }), [])],
    })
    const snapshot = structuredClone(p)
    migrateProjectToHierarchy(p)
    expect(p).toEqual(snapshot) // input untouched
  })
})

describe('migrateProjectToHierarchy: NO BEHAVIOR CHANGE (resolver-read fields unchanged)', () => {
  it('leaves every field a resolver reads byte-for-byte identical', () => {
    const p = makeProject({
      geometry: [makeGeo('geo-a')],
      sceneStock: {
        ...structuredClone(autoSceneStock), mode: 'fixed',
        fixedStocks: [
          { id: 'fs-1', name: 'Block A', width: 50, height: 60, depth: 20, position: { x: 1, y: 2, z: 3 } },
        ],
      },
      setups: [
        makeSetup('s-1', makeWcs({ stockId: 'fs-1', cornerRow: 2, cornerCol: 1, cornerFace: 'bottom' }), [
          makeOp('op-pocket', 'pocket_2d'),
          makeOp('op-chamfer', 'chamfer'),
        ]),
      ],
    })

    // Capture the resolver-read subtrees BEFORE migration. autoStocks is an
    // ADDITIVE hierarchy field (the default-auto-stock guarantee writes it); it
    // is not a legacy resolver-read field, so it is excluded from this
    // byte-identity comparison.
    const stripAdditive = (s: SceneStock): Omit<SceneStock, 'autoStocks'> => {
      const { autoStocks: _drop, ...rest } = s
      void _drop
      return rest
    }
    const before = {
      sceneStock: stripAdditive(structuredClone(p.sceneStock)),
      geo: p.geometry.map((g) => ({
        position: structuredClone(g.position),
        rotation: structuredClone(g.rotation),
        boundingBox: structuredClone(g.boundingBox),
        projectionPlane: structuredClone(g.projectionPlane ?? null),
      })),
      wcs: p.setups.map((s) => ({
        origin: structuredClone(s.wcs.origin),
        stockId: s.wcs.stockId,
        cornerRow: s.wcs.cornerRow,
        cornerCol: s.wcs.cornerCol,
        cornerFace: s.wcs.cornerFace,
        snapGeoId: s.wcs.snapGeoId,
        snapLocalPt: structuredClone(s.wcs.snapLocalPt ?? null),
      })),
      heights: p.setups.flatMap((s) => s.operations.map((o) => structuredClone(o.heights))),
    }

    const out = migrateProjectToHierarchy(p)

    const after = {
      sceneStock: stripAdditive(structuredClone(out.sceneStock)),
      geo: out.geometry.map((g) => ({
        position: structuredClone(g.position),
        rotation: structuredClone(g.rotation),
        boundingBox: structuredClone(g.boundingBox),
        projectionPlane: structuredClone(g.projectionPlane ?? null),
      })),
      wcs: out.setups.map((s) => ({
        origin: structuredClone(s.wcs.origin),
        stockId: s.wcs.stockId,
        cornerRow: s.wcs.cornerRow,
        cornerCol: s.wcs.cornerCol,
        cornerFace: s.wcs.cornerFace,
        snapGeoId: s.wcs.snapGeoId,
        snapLocalPt: structuredClone(s.wcs.snapLocalPt ?? null),
      })),
      heights: out.setups.flatMap((s) => s.operations.map((o) => structuredClone(o.heights))),
    }

    expect(after).toEqual(before)
  })
})
