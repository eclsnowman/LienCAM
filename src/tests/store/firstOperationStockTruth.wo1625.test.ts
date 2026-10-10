// WO-1625: the first operation of a setup does not say it "was not told what
// earlier operations removed". A setup's lone operation has nothing before it
// at all - the stock as loaded IS the remaining stock, not a stand-in for it -
// so the caveat is false there and the console must not print it. An
// operation with an actual earlier operation that has no result yet still
// gets the caveat: that one is true (WO-1582).
//
// Every case calls the store's OWN generate action (computeOperationToolpath)
// on a project; the store builds the request, and the REAL toolpathWorker.ts
// handles it in-process. The only stand-in is the Worker thread (node has none).
//
// SCENE: the WO-1571 "Deep sketch pocket" scene - a 20x16 mm DXF rectangle
// pocketed 10 mm deep (top 12, bottom 2) with a 6 mm end mill held with only
// 8 mm of stickout, so the holder face comes within the 0.25 mm clearance of
// the stock and the cut stops short before it reaches the floor.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCamStore } from '../../store'
import { DERIVED_STOCK_ID } from '../../store/migrateHierarchy'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'
import type { WorkerRequestMsg, WorkerResponseMsg } from '../../lib/cam/types'
import type {
  BoundingBox, HeightParams, ImportedGeometry, LinkingParams, Operation,
  PassParams, PhysicalStock, Project, SceneStock, Tool, ToolHolder, Vec3, WCS,
} from '../../types'

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

function dxfRect(): ImportedGeometry {
  return {
    id: 'dxf-pocket', name: 'Pocket sketch', filename: 'pocket.dxf', type: 'curves_2d', format: 'dxf',
    boundingBox: bbox({ x: -10, y: -8, z: 0 }, { x: 10, y: 8, z: 0 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    stockId: DERIVED_STOCK_ID, stockIdLocked: true,
    loops: [{
      id: 'pocket-loop', closed: true, type: 'contour', layerId: 'L1', area: 320,
      points: [{ x: -10, y: -8 }, { x: 10, y: -8 }, { x: 10, y: 8 }, { x: -10, y: 8 }],
    }],
    layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
  } as unknown as ImportedGeometry
}

const HOLDER: ToolHolder = {
  id: 'holder-1', name: 'ER20 collet chuck',
  segments: [{ height: 40, lowerDiameter: 20, upperDiameter: 20 }],
}

const SHORT_STICKOUT_MILL: Tool = {
  id: 'tool-1', name: '6 mm end mill, 8 mm stickout', type: 'flat_end_mill',
  diameter: 6, fluteLength: 20, shankDiameter: 6, overallLength: 60,
  lengthBelowHolder: 8, numberOfFlutes: 2, material: 'carbide', coating: 'none',
  holderId: 'holder-1', notes: '',
  feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 2, stepover: 1.5 } },
} as unknown as Tool

const LINKING: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
}

function pocketOp(id: string, name: string): Operation {
  const heights: HeightParams = {
    clearanceHeight: 60, clearanceHeightMode: 'absolute', retractHeight: 55, feedHeight: 50,
    topHeight: 12, topHeightMode: 'absolute', bottomHeight: 2, bottomHeightMode: 'absolute',
  }
  const params = { geometryId: 'dxf-pocket', loopIds: [], stepover: 3, heightReference: 'absolute', planeOffset: 2, direction: 'climb' }
  const passes: PassParams = { stepdown: 3, stepover: 3, stockToLeave: 0, finishPasses: 0, springPasses: 0 }
  return {
    id, name, type: 'pocket_2d', enabled: true, status: 'pending',
    toolId: 'tool-1', geometrySelections: [], heights, passes, linking: LINKING, params,
    smartHeight: smartHeightAuthorityFixture('pocket_2d', { setupId: 'setup-1', heights, params, geometryIds: ['dxf-pocket'] }),
  } as unknown as Operation
}

function install(operations: Operation[]): void {
  const stock = {
    id: DERIVED_STOCK_ID, name: 'Stock', mode: 'explicit',
    bounds: bbox({ x: -40, y: -40, z: 0 }, { x: 40, y: 40, z: 12 }),
    position: { x: -40, y: -40, z: 0 },
  } as unknown as PhysicalStock
  const setup = {
    id: 'setup-1', name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: -40, y: -40, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      stockId: DERIVED_STOCK_ID,
    } as WCS,
    stock: { type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum' },
    operations, notes: '',
  } as unknown as import('../../types').Setup
  const sceneStock = {
    mode: 'auto', autoOffsetXY: 0, autoOffsetZTop: 0, fixedWidth: 80, fixedHeight: 80, fixedDepth: 12, fixedStocks: [],
  } as unknown as SceneStock
  useCamStore.setState((s) => ({
    toolLibrary: [SHORT_STICKOUT_MILL],
    holders: [HOLDER],
    toolpathBatch: null,
    consoleEvents: [],
    project: {
      ...s.project, geometry: [dxfRect()], stocks: [stock], setups: [setup], sceneStock,
      activeSetupId: 'setup-1', activeOperationId: operations[operations.length - 1].id,
      modelItemPlacements: [{ modelItemId: 'legacy', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }],
    } as Project,
  }))
}

// ── The worker wire: real toolpathWorker.ts, in-process ─────────────────────

let workerRequests: WorkerRequestMsg[] = []
let activeShim: { onmessage: ((e: { data: WorkerResponseMsg }) => void) | null } | null = null
let workerSelf: { onmessage: ((e: { data: WorkerRequestMsg }) => Promise<void>) | null }

beforeAll(async () => {
  ;(globalThis as { self?: unknown }).self = {
    postMessage: (m: WorkerResponseMsg) => { activeShim?.onmessage?.({ data: m }) },
    onmessage: null,
  }
  await import('../../lib/cam/toolpathWorker')
  workerSelf = (globalThis as unknown as { self: typeof workerSelf }).self
})

afterAll(() => {
  delete (globalThis as { self?: unknown }).self
})

beforeEach(() => {
  workerRequests = []
  activeShim = null
  vi.stubGlobal('Worker', class {
    onmessage: ((e: { data: WorkerResponseMsg }) => void) | null = null
    onerror: ((e: unknown) => void) | null = null
    postMessage(data: WorkerRequestMsg): void {
      workerRequests.push(data)
      activeShim = this
      void workerSelf.onmessage!({ data })
    }
    terminate(): void { /* no thread */ }
  })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const toolpathLines = () => useCamStore.getState().consoleEvents.filter((e) => e.source === 'toolpath').map((e) => e.message)
const stopLines = () => toolpathLines().filter((line) => line.includes('left uncut'))

async function generate(opId: string): Promise<void> {
  await useCamStore.getState().computeOperationToolpath('setup-1', opId)
  const op = useCamStore.getState().project.setups[0].operations.find((candidate) => candidate.id === opId)!
  expect(op.status, op.errorMessage).toBe('ready')
}

describe('WO-1625: the first operation of a setup and the earlier-operations caveat', () => {
  it('a lone operation stops against the stock and says nothing about earlier operations', async () => {
    install([pocketOp('op-1', 'Deep sketch pocket')])
    await generate('op-1')

    const stops = stopLines()
    expect(stops.length, toolpathLines().join('\n')).toBeGreaterThan(0)
    expect(stops.join('\n')).not.toMatch(/not told what earlier operations removed/)
    // WO-1683: a generate that stops more than once now says so on the same
    // line ("... of the stock (N stops).") instead of one line per stop.
    expect(stops.join('\n')).toMatch(/the holder would come within 0\.25 mm of the stock(?: \(\d+ stops\))?\./)
    expect(toolpathLines().join('\n')).not.toMatch(/not told what earlier operations removed/)
  })

  it('the same operation after an earlier operation with no result yet still prints the caveat', async () => {
    install([pocketOp('op-0', 'Rough pocket'), pocketOp('op-1', 'Deep sketch pocket')])
    // op-0 is enabled but never generated: it has no result yet, so the store
    // cannot say what it removed - the caveat stays true.
    await generate('op-1')

    const stops = stopLines()
    expect(stops.length, toolpathLines().join('\n')).toBeGreaterThan(0)
    expect(toolpathLines().join('\n')).toMatch(/not told what earlier operations removed/)
    expect(stops.join('\n')).toMatch(/the holder would come within 0\.25 mm of the stock as loaded/)
  })
})
