// ADR 0025 Amendment 3: an OWNED NEST SEED is deliberately NO-STOCK (stockId
// undefined + stockIdLocked, Amendment 2) so the catch-all auto stock never
// wraps it. But its real CUT stock is the owning nest's BOUND fixed sheet
// (NestRecord.boundStockId, mirrored into project.stocks with the same id by
// syncFixedStocksToPhysical). computeOperationToolpath must resolve a seed op's
// stock coordinate frame from that bound stock for COMPUTE ONLY (a shallow copy;
// the real geometry stays no-stock), instead of fail-louding on no-stock.
//
// These tests drive computeOperationToolpath with a worker stub and assert:
//   (a) a seed op whose nest HAS a boundStockId (with a matching PhysicalStock)
//       computes WITHOUT throwing and POSTS to the worker (no error status).
//   (b) a seed op whose nest has NO boundStockId throws the clear seed-specific
//       fail-loud error (op.status === 'error', message names the bound sheet).
//   (c) a NORMAL non-seed unassigned geometry still throws the ORIGINAL
//       "not assigned to any stock" error (no behavior change).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { useCamStore } from '../../store'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'
import type {
  ImportedGeometry, SceneStock, PhysicalStock, BoundingBox, Vec3, Vec2, Project,
  Setup, Operation, WCS, Tool, HeightParams, PassParams, LinkingParams, NestRecord,
} from '../../types'

// -- Worker stub: capture every postMessage payload --------------------------

let postedPayloads: Array<{ type: string; payload: { loops?: Array<{ id: string; points: Vec2[] }> } }> = []
let OrigWorker: typeof Worker | undefined

function installWorkerStub(): void {
  OrigWorker = (globalThis as { Worker?: typeof Worker }).Worker
  ;(globalThis as { Worker?: unknown }).Worker = class {
    onmessage: ((e: unknown) => void) | null = null
    onerror: ((e: unknown) => void) | null = null
    postMessage(msg: { type: string; payload: { loops?: Array<{ id: string; points: Vec2[] }> } }): void {
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

function makeGeo(over: Partial<ImportedGeometry> = {}): ImportedGeometry {
  return {
    id: 'geo-1', name: 'WidgetPart', filename: 'part.dxf', type: 'curves_2d', format: 'dxf',
    boundingBox: bbox({ x: -5, y: -5, z: 0 }, { x: 5, y: 5, z: 0 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    loops: [{
      id: 'loop-1',
      points: LOCAL_SQUARE.map(p => ({ ...p })),
      closed: true, type: 'contour', layerId: 'L1', area: 100,
    }],
    layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
    stockId: 'stock-1', stockIdLocked: true,
    ...over,
  } as ImportedGeometry
}

function namedStock(id = 'sheet-1', name = 'Nest Sheet'): PhysicalStock {
  return {
    id, name, mode: 'explicit',
    // stockWorldBounds (store/stockAssignment.ts) computes an EXPLICIT stock's
    // world max as position + bounds.SIZE, not bounds.max directly - `bounds`
    // is a size template anchored at `position`, not a literal world AABB. So
    // to land the stock's real world top at z=0 (matching this file's
    // topHeightMode 'absolute' 0 convention, and what Smart Height V2's
    // 'current_material' plane now actually resolves against), position.z
    // must be -10 (= -size.z), not 0.
    bounds: bbox({ x: -50, y: -50, z: -10 }, { x: 50, y: 50, z: 0 }),
    position: { x: 0, y: 0, z: -10 },
  } as PhysicalStock
}

function autoSceneStock(over: Partial<SceneStock> = {}): SceneStock {
  return {
    mode: 'auto', autoOffsetXY: 2, autoOffsetZTop: 1,
    fixedWidth: 100, fixedHeight: 100, fixedDepth: 12, fixedStocks: [], ...over,
  }
}

// Absolute top/bottom so the owning-stock plane resolvers stay off the critical
// path — the focus is the STOCK-MEMBERSHIP guard, not Z resolution.
const heights: HeightParams = {
  clearanceHeight: 10, clearanceHeightMode: 'relative',
  retractHeight: 5, feedHeight: 1,
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

// Commit 2e5678b7: a valid smart_v2 envelope is now the ONLY runtime height
// authority, checked BEFORE the stock-membership guard this file tests -
// stamp one or every case here dies on "no Smart Height V2 authority"
// instead of the seed-stock resolution outcome it means to prove.
function makeOp(geometryId: string): Operation {
  return {
    id: 'op-1', name: 'Profile Cut', type: 'contour_2d', enabled: true, status: 'ready',
    toolId: 'tool-1', geometrySelections: ['loop-1'],
    heights: structuredClone(heights),
    passes: structuredClone(passes),
    linking: structuredClone(linking),
    params: { geometryId, side: 'outside', direction: 'climb' },
    smartHeight: smartHeightAuthorityFixture('contour_2d', {
      setupId: 'setup-1', heights, geometryIds: [geometryId],
    }),
  }
}

function makeWcs(): WCS {
  return {
    id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
    xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
    // Contour's Smart Height runtime (setupProvenStockId, store/index.ts)
    // requires a proven owning stock before it resolves anything. 'sheet-1'
    // is the bound sheet stock case (a)'s seed resolves to; cases (b) and
    // (c) both return before reaching that resolver, so this is inert there.
    stockId: 'sheet-1',
  }
}

function makeSetup(op: Operation): Setup {
  return {
    id: 'setup-1', name: 'Setup 1', wcs: makeWcs(),
    stock: {
      type: 'rectangular', width: 100, height: 100, depth: 12,
      offsetX: 2, offsetY: 2, offsetZTop: 1, offsetZBottom: 0, material: 'al',
    },
    operations: [op], notes: '',
  }
}

const tool: Tool = {
  id: 'tool-1', name: 'EM6', type: 'flat_end_mill', diameter: 6,
  fluteLength: 20, shankDiameter: 6, overallLength: 50, numberOfFlutes: 2,
} as Tool

function nest(over: Partial<NestRecord> = {}): NestRecord {
  return {
    id: 'nest-1', name: 'Nest 1',
    sheet: { width: 100, height: 100 },
    style: 'ninety',
    spacing: { partGap: 1, sheetMargin: 1 },
    placements: [],
    ...over,
  } as NestRecord
}

function installProject(
  geometry: ImportedGeometry[], op: Operation,
  stocks: PhysicalStock[], nests: NestRecord[],
): void {
  useCamStore.setState((s) => ({
    toolLibrary: [tool],
    project: {
      ...s.project,
      geometry,
      stocks,
      nests,
      setups: [makeSetup(op)],
      sceneStock: autoSceneStock(),
    } as Project,
  }))
}

function opStatus(): { status?: string; errorMessage?: string } {
  const setup = useCamStore.getState().project.setups[0]
  const op = setup.operations[0]
  return { status: op.status, errorMessage: op.errorMessage }
}

// =============================================================================

describe('computeOperationToolpath: seed ops resolve stock from the nest bound sheet', () => {
  beforeEach(() => {
    postedPayloads = []
    installWorkerStub()
  })
  afterEach(() => {
    restoreWorker()
  })

  it('(a) a seed op whose nest HAS a boundStockId computes and posts to the worker', () => {
    // No-stock seed (deliberate, Amendment 2) bound to a nest whose boundStockId
    // matches an existing PhysicalStock. It must pass the guard and dispatch.
    const seed = makeGeo({
      id: 'seed-1', name: 'Seed Part', ownerNestId: 'nest-1',
      stockId: undefined, stockIdLocked: true,
      position: { x: 100, y: 200, z: 0 },
    })
    installProject(
      [seed], makeOp('seed-1'),
      [namedStock('sheet-1')],
      [nest({ id: 'nest-1', boundStockId: 'sheet-1' })],
    )

    useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')

    // Did NOT fail loud, and the worker received the op.
    expect(opStatus().status).not.toBe('error')
    expect(postedPayloads.length).toBe(1)
    expect(postedPayloads[0].payload.loops?.length).toBe(1)
  })

  it('(b) a seed op whose nest has NO boundStockId throws the seed-specific fail-loud', () => {
    const seed = makeGeo({
      id: 'seed-1', name: 'Seed Part', ownerNestId: 'nest-1',
      stockId: undefined, stockIdLocked: true,
    })
    installProject(
      [seed], makeOp('seed-1'),
      [namedStock('sheet-1')],
      [nest({ id: 'nest-1', boundStockId: undefined })],
    )

    useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')

    expect(postedPayloads.length).toBe(0)
    const { status, errorMessage } = opStatus()
    expect(status).toBe('error')
    expect(errorMessage).toMatch(/belongs to a nest with/i)
    expect(errorMessage).toMatch(/bound sheet stock/i)
  })

  it('(c) a normal non-seed unassigned geometry still throws the original error', () => {
    // Locked, no stock, NOT a seed -> the deliberate "None" -> original message.
    const part = makeGeo({
      id: 'geo-1', name: 'Free Part', ownerNestId: undefined,
      stockId: undefined, stockIdLocked: true,
    })
    installProject([part], makeOp('geo-1'), [namedStock('sheet-1')], [])

    useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')

    expect(postedPayloads.length).toBe(0)
    const { status, errorMessage } = opStatus()
    expect(status).toBe('error')
    expect(errorMessage).toMatch(/is not assigned to any stock/i)
    expect(errorMessage).not.toMatch(/belongs to a nest/i)
  })
})
