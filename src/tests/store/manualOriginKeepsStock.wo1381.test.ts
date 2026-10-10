// WO-1381: a vertex pick that resolves to no trackable geometry saves
// originBinding: { kind: 'manual' } (SetupModal.tsx handleSave) and the
// legacy wcs.stockId mirror is only written for corner mode. setupProvenStockId
// (store/index.ts) proved a stock only for a part_feature binding, so a manual
// origin refused Contour/Drill/Bore/Face/Planar Rough Smart Height with
// "cannot prove one active Setup stock" even when the setup's own geometry is
// fixed to exactly one stock.
//
// These tests drive computeOperationToolpath with a worker stub (same harness
// as seedStockResolution.test.ts) plus the pure setupProvenStockId /
// setupStockConsistency resolvers and assert:
//   (1) one geometry fixed to one stock, manual origin -> Contour computes
//       without refusing and its dispatched top height is that stock's top.
//   (2) two geometries fixed to two different stocks, manual origin -> still
//       unproven (setupProvenStockId undefined), the underlying consistency
//       check names both stocks, and Contour generation still refuses.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { useCamStore, setupProvenStockId } from '../../store'
import { setupStockConsistency } from '../../store/stockAssignment'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'
import type {
  ImportedGeometry, SceneStock, PhysicalStock, BoundingBox, Vec3, Vec2, Project,
  Setup, Operation, WCS, Tool, HeightParams, PassParams, LinkingParams,
} from '../../types'

// -- Worker stub: capture every postMessage payload --------------------------

let postedPayloads: Array<{ type: string; payload: { heights?: HeightParams } }> = []
let OrigWorker: typeof Worker | undefined

function installWorkerStub(): void {
  OrigWorker = (globalThis as { Worker?: typeof Worker }).Worker
  ;(globalThis as { Worker?: unknown }).Worker = class {
    onmessage: ((e: unknown) => void) | null = null
    onerror: ((e: unknown) => void) | null = null
    postMessage(msg: { type: string; payload: { heights?: HeightParams } }): void {
      postedPayloads.push(msg)
    }
    terminate(): void { /* no-op */ }
  }
}

function restoreWorker(): void {
  ;(globalThis as { Worker?: unknown }).Worker = OrigWorker
}

// -- Fixtures ----------------------------------------------------------------

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

const LOCAL_SQUARE: Vec2[] = [
  { x: -5, y: -5 }, { x: 5, y: -5 }, { x: 5, y: 5 }, { x: -5, y: 5 },
]

function makeGeo(id: string, stockId: string): ImportedGeometry {
  return {
    id, name: id, filename: 'part.dxf', type: 'curves_2d', format: 'dxf',
    boundingBox: bbox({ x: -5, y: -5, z: 0 }, { x: 5, y: 5, z: 0 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    loops: [{
      id: `${id}-loop`,
      points: LOCAL_SQUARE.map(p => ({ ...p })),
      closed: true, type: 'contour', layerId: 'L1', area: 100,
    }],
    layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
    // The geometry's own FIXED stock assignment (locked, explicit) - the
    // thing WO-1381 says a manual origin should still be able to read.
    stockId, stockIdLocked: true,
  } as ImportedGeometry
}

// World top = position.z + bounds.size.z (stockWorldBounds, store/stockAssignment.ts).
function namedStock(id: string, name: string, topZ: number, xOffset = 0): PhysicalStock {
  return {
    id, name, mode: 'explicit',
    bounds: bbox({ x: xOffset - 50, y: -50, z: 0 }, { x: xOffset + 50, y: 50, z: topZ }),
    position: { x: xOffset - 50, y: -50, z: 0 },
  } as PhysicalStock
}

function autoSceneStock(): SceneStock {
  return {
    mode: 'auto', autoOffsetXY: 2, autoOffsetZTop: 1,
    fixedWidth: 100, fixedHeight: 100, fixedDepth: 12, fixedStocks: [], autoStocks: [],
  } as unknown as SceneStock
}

// Clearance/retract/feed resolve as literal absolute WCS-Z planes
// (legacyHeightIntentForOperation: reference 'wcs_plane'), so all three must
// sit at or above the proven stock's top (12, test 1's fixture) to satisfy
// Clearance >= Retract >= Feed >= Material Start.
const heights: HeightParams = {
  clearanceHeight: 100, clearanceHeightMode: 'relative',
  retractHeight: 50, feedHeight: 20,
  topHeight: 0, topHeightMode: 'absolute',
  bottomHeight: -5, bottomHeightMode: 'absolute',
}
const passes: PassParams = {
  stepdown: 1.5, stepover: 3, stockToLeave: 0, finishPasses: 0, springPasses: 0,
}
const linking: LinkingParams = {
  entryType: 'plunge', rampAngle: 2, rampLength: 5,
  leadInRadius: 1.5, leadOutRadius: 1, retractType: 'full', transitionType: 'safe_height',
}

function makeOp(opId: string, geometryId: string): Operation {
  return {
    id: opId, name: 'Profile Cut', type: 'contour_2d', enabled: true, status: 'ready',
    toolId: 'tool-1', geometrySelections: [`${geometryId}-loop`],
    heights: structuredClone(heights),
    passes: structuredClone(passes),
    linking: structuredClone(linking),
    params: { geometryId, side: 'outside', direction: 'climb' },
    smartHeight: smartHeightAuthorityFixture('contour_2d', {
      setupId: 'setup-1', heights, geometryIds: [geometryId],
    }),
  }
}

// A vertex pick that resolved to no trackable geometry (SetupModal.tsx
// handleSave): originBinding manual, no legacy wcs.stockId mirror.
function makeManualWcs(): WCS {
  return {
    id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
    xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
    originBinding: { kind: 'manual' },
  }
}

function makeSetup(ops: Operation[]): Setup {
  return {
    id: 'setup-1', name: 'Setup 1', wcs: makeManualWcs(),
    stock: {
      type: 'rectangular', width: 100, height: 100, depth: 12,
      offsetX: 2, offsetY: 2, offsetZTop: 1, offsetZBottom: 0, material: 'al',
    },
    operations: ops, notes: '',
  }
}

const tool: Tool = {
  id: 'tool-1', name: 'EM6', type: 'flat_end_mill', diameter: 6,
  fluteLength: 20, shankDiameter: 6, overallLength: 50, numberOfFlutes: 2,
} as Tool

function installProject(geometry: ImportedGeometry[], ops: Operation[], stocks: PhysicalStock[]): void {
  useCamStore.setState((s) => ({
    toolLibrary: [tool],
    project: {
      ...s.project,
      geometry,
      stocks,
      nests: [],
      setups: [makeSetup(ops)],
      sceneStock: autoSceneStock(),
    } as Project,
  }))
}

function opStatus(opId: string): { status?: string; errorMessage?: string } {
  const setup = useCamStore.getState().project.setups[0]
  const op = setup.operations.find(candidate => candidate.id === opId)!
  return { status: op.status, errorMessage: op.errorMessage }
}

// =============================================================================

describe('WO-1381: a manual origin still proves a stock from the setup\'s own geometry', () => {
  beforeEach(() => {
    postedPayloads = []
    installWorkerStub()
  })
  afterEach(() => {
    restoreWorker()
  })

  it('(1) one geometry fixed to one stock: Contour computes and uses that stock\'s top', () => {
    const geo = makeGeo('geo-1', 'sheet-1')
    const stock = namedStock('sheet-1', 'Fixed Sheet', 12)
    installProject([geo], [makeOp('op-1', 'geo-1')], [stock])

    const project = useCamStore.getState().project
    const setup = project.setups[0]
    // The pure resolver itself: proves the stock despite the manual binding.
    expect(setupProvenStockId(setup, project)).toBe('sheet-1')

    useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')

    const { status, errorMessage } = opStatus('op-1')
    expect(status, errorMessage).not.toBe('error')
    expect(postedPayloads.length).toBe(1)
    // WCS origin.z is 0, so the WCS-relative dispatched top equals the
    // proven stock's world top (12) - proof the resolved height came from
    // that stock, not a fallback.
    expect(postedPayloads[0].payload.heights?.topHeight).toBe(12)
  })

  it('(2) two geometries fixed to two different stocks: still unproven, names both, still refuses', () => {
    const geoA = makeGeo('geo-a', 'stock-a')
    const geoB = makeGeo('geo-b', 'stock-b')
    const stockA = namedStock('stock-a', 'Sheet A', 12, 0)
    const stockB = namedStock('stock-b', 'Sheet B', 18, 200)
    installProject(
      [geoA, geoB],
      [makeOp('op-a', 'geo-a'), makeOp('op-b', 'geo-b')],
      [stockA, stockB],
    )

    const project = useCamStore.getState().project
    const setup = project.setups[0]

    expect(setupProvenStockId(setup, project)).toBeUndefined()

    const consistency = setupStockConsistency(setup, project.geometry, project.stocks ?? [], project.nests ?? [])
    expect(consistency.ok).toBe(false)
    expect(consistency.reason).toMatch(/Sheet A/)
    expect(consistency.reason).toMatch(/Sheet B/)

    useCamStore.getState().computeOperationToolpath('setup-1', 'op-a')

    expect(postedPayloads.length).toBe(0)
    const { status, errorMessage } = opStatus('op-a')
    expect(status).toBe('error')
    expect(errorMessage).toMatch(/cannot prove one active Setup stock/i)
  })
})
