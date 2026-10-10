// DIAGNOSE-ONLY reproduction (RED) for the "Stock top resolves to +offset"
// height bug (branch feat/tool-angle-convention).
//
// SYMPTOM (Operator, project-12): an engrave op with heightReference 'stock_top'
// and planeOffset 0 resolves its top plane ABOVE the stock instead of at Z0,
// floating the toolpath. The setup's WCS Z0 is bound to the (auto/derived)
// stock TOP, so the CORRECT resolved WCS-relative top plane is ~0.
//
// MECHANISM under test (see resolveTopZ in src/store/dispatchGeo.ts):
//     refZ = owningStockTop(geometry) - setup.wcs.origin.z   (+ workOffset + planeOffset)
// owningStockTop is RE-DERIVED FRESH from the current geometry every compute,
// but setup.wcs.origin.z is the PERSISTED value. When the two disagree (the
// persisted origin.z is stale, OR the WCS re-derive used a different ZTop offset
// than resolveTopZ uses) refZ != 0 and the path floats.
//
// These tests reproduce that divergence through the REAL resolveTopZ resolver,
// the REAL loadProjectFromFile heal, and the REAL updateGeometryTransform store
// action. They assert the CORRECT expectation (~0) and now PASS via the fix
// (FIX 1: per-stock offset consistency in owningStockWorldBounds; FIX 2: heal a
// stale persisted WCS on load) -- they stand as regression guards.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useCamStore } from '../../store'
import { resolveTopZ, deriveAutoStockBounds } from '../../store/dispatchGeo'
import type {
  ImportedGeometry, SceneStock, Setup, WCS,
  PhysicalStock, BoundingBox, Vec3, Project, AutoStockItem, MachineConfig,
} from '../../types'

// -- Fixtures (mirror wcsRederivation.test.ts) --------------------------------

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

/** A 3D mesh part whose world Z span = position.z + boundingBox z extent. */
function makeMeshGeo(over: Partial<ImportedGeometry> = {}): ImportedGeometry {
  return {
    id: 'geo-mesh', name: 'Part3D', filename: 'part.stl', type: 'mesh', format: 'stl',
    boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: 40, y: 40, z: 4 }),
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
    stockId: 'stock-derived',
    ...over,
  } as ImportedGeometry
}

/** A 2D engrave target (flat at position.z). Carries a loop so the engrave op
 *  has something to resolve, but the op only NEEDS resolveTopZ here. */
function makeEngraveGeo(over: Partial<ImportedGeometry> = {}): ImportedGeometry {
  return {
    id: 'geo-engrave', name: 'BMG', filename: 'bmg.dxf', type: 'curves_2d', format: 'dxf',
    boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: 50, y: 50, z: 0 }),
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
    stockId: 'stock-derived',
    loops: [{
      id: 'loop-1',
      points: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }, { x: 0, y: 50 }],
      closed: true, type: 'contour', layerId: 'L1', area: 2500,
    }],
    layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
    ...over,
  } as ImportedGeometry
}

function derivedStock(boundsTopZ: number): PhysicalStock {
  return {
    id: 'stock-derived', name: 'Auto Stock 1', mode: 'derived',
    bounds: bbox({ x: 0, y: 0, z: 0 }, { x: 50, y: 50, z: boundsTopZ }),
    position: { x: 0, y: 0, z: 0 },
  }
}

function makeAutoSceneStock(over: Partial<SceneStock> = {}): SceneStock {
  return {
    mode: 'auto',
    autoOffsetXY: 5, autoOffsetZTop: 5,
    fixedWidth: 100, fixedHeight: 100, fixedDepth: 12,
    fixedStocks: [],
    ...over,
  }
}

function makeWcs(over: Partial<WCS> = {}): WCS {
  return {
    id: 'wcs-1', label: 'G54', fixtureOffset: 54,
    origin: { x: 0, y: 0, z: 0 },
    xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
    cornerRow: 2, cornerCol: 0, cornerFace: 'top',
    stockId: 'stock-derived',
    originBinding: {
      kind: 'stock_corner', stockId: 'stock-derived',
      cornerRow: 2, cornerCol: 0, cornerFace: 'top',
    },
    ...over,
  }
}

function makeSetup(wcs: WCS): Setup {
  return {
    id: 'setup-1', name: 'Setup 1',
    wcs,
    stock: {
      type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0,
      material: 'aluminum',
    } as Setup['stock'],
    operations: [], notes: '',
  }
}

function installProject(over: Partial<Project>): void {
  useCamStore.setState((s) => ({
    project: {
      ...s.project,
      geometry: [],
      setups: [],
      stocks: [],
      activeSetupId: 'setup-1',
      activeOperationId: null,
      ...over,
    },
  }))
}

beforeEach(() => {
  installProject({})
})

// =============================================================================
// CORE REPRO: resolveTopZ('stock_top', 0, ...) must equal ~0 when the WCS Z0 is
// bound to the stock top. (Driven directly through the real resolver.)
// =============================================================================

// A minimal-but-valid machine so loadProjectFromFile's structural validation
// (id/name/version/machine/geometry/setups) passes through to migration + heal.
function makeMachine(): MachineConfig {
  return {
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
  } as MachineConfig
}

/** Serialize a fully-migrated project (so migrateProjectToHierarchy is a no-op
 *  via isFullyMigrated) that carries a STALE persisted wcs.origin.z. The real
 *  loadProjectFromFile must heal the corner-bound WCS from the freshly-sized
 *  stock before resolveTopZ runs. */
function serializeProject(over: {
  geometry: ImportedGeometry[]
  stocks: PhysicalStock[]
  setups: Setup[]
  sceneStock: SceneStock
}): string {
  const project: Project = {
    id: 'proj-12', name: 'Stale WCS Repro', version: '1.0.0',
    schemaVersion: 2, // CURRENT -> migration is a no-op pass-through
    createdAt: '2026-06-22T00:00:00.000Z', updatedAt: '2026-06-22T00:00:00.000Z',
    machine: makeMachine(),
    toolLibrary: [],
    activeSetupId: 'setup-1', activeOperationId: null,
    notes: '',
    ...over,
  } as Project
  return JSON.stringify(project)
}

describe('stock_top height resolution with a top-bound WCS', () => {
  it('REPRO: a persisted-stale wcs.origin.z is HEALED on load so stock_top resolves to 0', () => {
    // Mirrors project-12: a derived stock whose CURRENT top (from geometry +
    // global autoOffsetZTop) is 19, but a persisted/stale WCS origin.z of 12.
    // Routed through the REAL load action so FIX 2 (heal-on-load) is exercised:
    // a resolveTopZ-direct call would NOT see the heal and would still float.
    const sceneStock = makeAutoSceneStock() // autoOffsetZTop 5 (the GLOBAL value resolveTopZ uses)

    // Two members: an engrave target (flat, world z 12..12) and a TALLER part
    // that drives the stock top. Tall part world z = 0..14 (position 14, bbox
    // -14..0) -> members' max world z = 14. Stock top = 14 + 5 = 19.
    const engrave = makeEngraveGeo({ position: { x: 0, y: 0, z: 12 } })
    const tall = makeMeshGeo({
      id: 'geo-tall', position: { x: 0, y: 0, z: 14 },
      boundingBox: bbox({ x: 0, y: 0, z: -14 }, { x: 40, y: 40, z: 0 }),
    })
    const geometry = [engrave, tall]

    // Sanity: confirm the fresh owning-stock top is 19 (global offset path).
    const freshTop = deriveAutoStockBounds(geometry, sceneStock)!.max.z
    expect(freshTop).toBeCloseTo(19, 6)

    // The persisted file carries a STALE WCS origin.z of 12 (the CORRECT value is
    // the current stock top = 19). project-12 saved it stale.
    const staleWcsZ = 12
    const wcs = makeWcs({ origin: { x: 0, y: 0, z: staleWcsZ } })

    // No viewport handle in node -> loadProjectFromFile skips the scene rebuild;
    // alert must exist (the catch path may call it).
    vi.stubGlobal('alert', vi.fn())
    useCamStore.getState().loadProjectFromFile(serializeProject({
      geometry,
      stocks: [derivedStock(/* stale stored top */ 12)],
      setups: [makeSetup(wcs)],
      sceneStock,
    }))

    const st = useCamStore.getState()
    expect(st.project.id).toBe('proj-12') // the store took the project

    // FIX 2: the corner-bound WCS origin.z was re-derived from the freshly-sized
    // stock top on load -> 19, NOT the stale 12.
    const healedSetup = st.project.setups[0]
    expect(healedSetup.wcs.origin.z).toBeCloseTo(19, 6)

    const resolved = resolveTopZ(
      'stock_top', /* planeOffset */ 0, healedSetup, st.project.sceneStock,
      st.project.geometry, 'geo-engrave', st.project.stocks,
    )

    // CORRECT expectation: WCS Z0 is the (healed) stock top, so the stock_top
    // plane is at WCS-relative Z 0. Without FIX 2 the stale origin.z stays 12 and
    // this yields freshTop - staleWcsZ = 19 - 12 = +7.
    expect(resolved).toBeCloseTo(0, 6)
  })

  it('CONTROL: when wcs.origin.z equals the current stock top, stock_top resolves to 0', () => {
    // Same scene, but with a FRESH (correct) WCS origin.z = 19. This passes today
    // and isolates the staleness as the cause (not the resolver math itself).
    const sceneStock = makeAutoSceneStock()
    const engrave = makeEngraveGeo({ position: { x: 0, y: 0, z: 12 } })
    const tall = makeMeshGeo({
      id: 'geo-tall', position: { x: 0, y: 0, z: 14 },
      boundingBox: bbox({ x: 0, y: 0, z: -14 }, { x: 40, y: 40, z: 0 }),
    })
    const geometry = [engrave, tall]
    const wcs = makeWcs({ origin: { x: 0, y: 0, z: 19 } }) // fresh = current top
    const setup = makeSetup(wcs)
    const stocks: PhysicalStock[] = [derivedStock(19)]
    const resolved = resolveTopZ('stock_top', 0, setup, sceneStock, geometry, 'geo-engrave', stocks)
    expect(resolved).toBeCloseTo(0, 6)
  })
})

// =============================================================================
// SECOND-ORDER REPRO: even WITHOUT a stale persisted file, the WCS re-derive
// (applyAutoStockToSetups, per-stock ZTop offset) and resolveTopZ (global ZTop
// offset) can DISAGREE, so a fresh in-app move leaves stock_top != 0.
//
// Drives the REAL updateGeometryTransform action, then checks resolveTopZ
// against the freshly re-derived WCS origin.z.
// =============================================================================

describe('in-app member move keeps stock_top at 0 (offset-consistency)', () => {
  it('REPRO: per-stock ZTop=0 (WCS) vs global ZTop=5 (resolveTopZ) -> stock_top != 0', () => {
    // sceneStock GLOBAL autoOffsetZTop = 5, but the named AutoStockItem for this
    // derived stock carries its OWN autoOffsetZTop = 0 (exactly project-12).
    const autoStocks: AutoStockItem[] = [
      { id: 'stock-derived', name: 'Auto Stock 1', autoOffsetXY: 5, autoOffsetZTop: 0 },
    ] as AutoStockItem[]
    const sceneStock = makeAutoSceneStock({ autoStocks })

    const engrave = makeEngraveGeo({ position: { x: 0, y: 0, z: 0 } })
    const tall = makeMeshGeo({
      id: 'geo-tall', position: { x: 0, y: 0, z: 0 },
      boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: 40, y: 40, z: 10 }),
    })
    const wcs = makeWcs({ origin: { x: 0, y: 0, z: 10 } }) // start consistent-ish

    installProject({
      geometry: [engrave, tall],
      stocks: [derivedStock(10)],
      setups: [makeSetup(wcs)],
      sceneStock,
    })

    // Move the tall part in Z via the REAL action -> applyAutoStockToSetups
    // re-derives the WCS origin.z using the PER-STOCK offset (ZTop 0).
    useCamStore.getState().updateGeometryTransform(
      'geo-tall', { x: 0, y: 0, z: 5 }, { x: 0, y: 0, z: 0 },
    )

    const st = useCamStore.getState()
    const setup = st.project.setups[0]
    const resolved = resolveTopZ(
      'stock_top', 0, setup, st.project.sceneStock,
      st.project.geometry, 'geo-engrave', st.project.stocks,
    )

    // CORRECT expectation: after any consistent move, stock_top with offset 0
    // resolves to WCS-relative 0. Before FIX 1 the mismatch (WCS uses ZTop 0 ->
    // origin.z 15; resolveTopZ uses global ZTop 5 -> top 20) yielded 20 - 15 = +5.
    expect(resolved).toBeCloseTo(0, 6)
  })
})
