// WO-1582: the tool-reach trim knows what the earlier operations removed.
//
// Every case calls the store's OWN generate action (computeOperationToolpath)
// on a project; the store builds the request, and the REAL toolpathWorker.ts
// handles it in-process. The only stand-in is the Worker thread (node has none).
//
// SCENE (decide-and-log in the WO): an 80 x 80 mm plate, 20 mm thick (world Z
// 0..20, work origin on its top), and a 20 x 16 mm sketch rectangle.
//  - "Rough pocket": 6 mm end mill, 25 mm flutes, pocket 20 mm deep leaving 0.3
//    mm on the walls (Smart Height explicit depth 20).
//  - "Finish wall": a contour finishing the same wall to the same 20 mm (Smart
//    Height through the stock) with a 6 mm end mill whose flutes are exactly 20
//    mm and whose shank is reduced to 4 mm. At the floor its shank starts at the
//    plate top, so with the stock as loaded it comes within the 0.25 mm
//    clearance of the material inside the pocket and the cut stops. The roughing
//    has already taken that material out, and the 4 mm shank stays 0.7 mm off
//    the wall the roughing left, so knowing the remaining stock nothing stops.

import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCamStore } from '../../store'
import { DERIVED_STOCK_ID } from '../../store/migrateHierarchy'
import { remainingStockBefore } from '../../store/toolReachInputs'
import type { StockState } from '../../lib/cam/stockState'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'
import { writeSideView, toolBands, type Obstacle, type PathPoint, type ToolPlacement } from '../helpers/sideViewEvidence'
import type { WorkerRequestMsg, WorkerResponseMsg } from '../../lib/cam/types'
import type {
  BoundingBox, HeightParams, ImportedGeometry, LinkingParams, Operation, PassParams, PhysicalStock,
  Project, SceneStock, Setup, Tool, ToolHolder, ToolpathMove, Vec3, WCS,
} from '../../types'

const SETUP_ID = 'setup-1'
const PLATE_TOP = 20

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

function sketchRect(): ImportedGeometry {
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

function tool(overrides: Partial<Tool>): Tool {
  return {
    id: 'tool', name: 'tool', type: 'flat_end_mill',
    diameter: 6, fluteLength: 25, shankDiameter: 6, overallLength: 70,
    lengthBelowHolder: 40, numberOfFlutes: 2, material: 'carbide', coating: 'none',
    holderId: 'holder-1', notes: '',
    feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 2, stepover: 1.5 } },
    ...overrides,
  } as unknown as Tool
}

const ROUGHING_MILL = tool({ id: 'rough-mill', name: '6 mm roughing end mill' })
const FINISHING_MILL = tool({ id: 'finish-mill', name: '6 mm end mill, 20 mm flutes, 4 mm shank', fluteLength: 20, shankDiameter: 4 })

const LINKING: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
}

const HEIGHTS: HeightParams = {
  clearanceHeight: 15, clearanceHeightMode: 'absolute', retractHeight: 10, feedHeight: 5,
  topHeight: 0, topHeightMode: 'absolute', bottomHeight: -20, bottomHeightMode: 'absolute',
}

function roughingPocket(): Operation {
  const params = { geometryId: 'dxf-pocket', loopIds: [], stepover: 3, heightReference: 'absolute', planeOffset: 0, direction: 'climb' }
  const passes: PassParams = { stepdown: 5, stepover: 3, stockToLeave: 0.3, finishPasses: 0, springPasses: 0 }
  return {
    id: 'op-rough', name: 'Rough pocket', type: 'pocket_2d', enabled: true, status: 'pending',
    toolId: ROUGHING_MILL.id, geometrySelections: [], heights: HEIGHTS, passes, linking: LINKING, params,
    smartHeight: smartHeightAuthorityFixture('pocket_2d', {
      setupId: SETUP_ID, heights: HEIGHTS, params, geometryIds: ['dxf-pocket'], explicitDepthMm: 20,
    }),
  } as unknown as Operation
}

function finishingContour(): Operation {
  const params = { geometryId: 'dxf-pocket', loopIds: [], side: 'inner', direction: 'climb', tabs: false }
  const passes: PassParams = { stepdown: 5, stepover: 1.5, stockToLeave: 0, finishPasses: 1, springPasses: 0 }
  return {
    id: 'op-finish', name: 'Finish wall', type: 'contour_2d', enabled: true, status: 'pending',
    toolId: FINISHING_MILL.id, geometrySelections: [], heights: HEIGHTS, passes, linking: LINKING, params,
    smartHeight: smartHeightAuthorityFixture('contour_2d', {
      setupId: SETUP_ID, heights: HEIGHTS, params, geometryIds: ['dxf-pocket'],
    }),
  } as unknown as Operation
}

function install(operations: Operation[]): void {
  // An explicit stock sits with its min corner at `position` (stockWorldBounds).
  const stock = {
    id: DERIVED_STOCK_ID, name: 'Stock', mode: 'explicit',
    bounds: bbox({ x: -40, y: -40, z: 0 }, { x: 40, y: 40, z: PLATE_TOP }),
    position: { x: -40, y: -40, z: 0 },
  } as unknown as PhysicalStock
  const setup = {
    id: SETUP_ID, name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: -40, y: -40, z: PLATE_TOP },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      stockId: DERIVED_STOCK_ID,
    } as WCS,
    stock: { type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum' },
    operations, notes: '',
  } as unknown as Setup
  const sceneStock = {
    mode: 'auto', autoOffsetXY: 0, autoOffsetZTop: 0, fixedWidth: 80, fixedHeight: 80, fixedDepth: PLATE_TOP, fixedStocks: [],
  } as unknown as SceneStock
  useCamStore.setState((s) => ({
    toolLibrary: [ROUGHING_MILL, FINISHING_MILL],
    holders: [HOLDER],
    toolpathBatch: null,
    consoleEvents: [],
    project: {
      ...s.project, geometry: [sketchRect()], stocks: [stock], setups: [setup], sceneStock,
      activeSetupId: SETUP_ID, activeOperationId: operations[0].id,
      modelItemPlacements: [],
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

// ── Reading the result ───────────────────────────────────────────────────────

const opById = (id: string) => useCamStore.getState().project.setups[0].operations.find((op) => op.id === id)!
const toolpathLines = () => useCamStore.getState().consoleEvents.filter((e) => e.source === 'toolpath').map((e) => e.message)
const contourStopLines = () => toolpathLines().filter((line) => line.includes('left uncut'))

async function generate(opId: string): Promise<void> {
  await useCamStore.getState().computeOperationToolpath(SETUP_ID, opId)
  expect(opById(opId).status, opById(opId).errorMessage).toBe('ready')
}

function lastRequest(type: WorkerRequestMsg['type']): WorkerRequestMsg {
  const matching = workerRequests.filter((r) => r.type === type)
  expect(matching.length).toBeGreaterThan(0)
  return matching[matching.length - 1]
}

/** Runs the real worker on a request and returns what it posted. */
async function runWorker(request: WorkerRequestMsg): Promise<{ moves: ToolpathMove[]; notices: string[] }> {
  const posted: WorkerResponseMsg[] = []
  activeShim = { onmessage: (e) => { posted.push(e.data) } }
  await workerSelf.onmessage!({ data: request })
  const done = posted.find((m) => m.type === 'TOOLPATH_COMPLETE') as { moves: ToolpathMove[]; notices?: string[] } | undefined
  expect(done, JSON.stringify(posted.find((m) => m.type === 'TOOLPATH_ERROR'))).toBeDefined()
  return { moves: done!.moves, notices: done!.notices ?? [] }
}

function feedLengthAtFloor(moves: readonly ToolpathMove[]): number {
  let length = 0
  for (let i = 1; i < moves.length; i++) {
    const a = moves[i - 1]
    const b = moves[i]
    if (b.type === 'rapid' || Math.abs(a.z) > 1e-6 || Math.abs(b.z) > 1e-6) continue
    length += Math.hypot(b.x - a.x, b.y - a.y)
  }
  return length
}

const dependsOnPredecessors = (op: Operation) => (op as Operation & { dependsOnPredecessors?: boolean }).dependsOnPredecessors

// ── Cases ────────────────────────────────────────────────────────────────────

describe('WO-1582: roughing, then a finishing contour whose shank passes the roughed-out region', () => {
  it('the contour is not stopped; without the remaining stock the same request stops against the stock as loaded', async () => {
    install([roughingPocket(), finishingContour()])
    await generate('op-rough')
    const roughMoves = opById('op-rough').toolpathMoves ?? []
    const roughCuts = roughMoves.filter((m) => m.type !== 'rapid')
    expect(roughCuts.length).toBeGreaterThan(0)
    expect(Math.min(...roughCuts.map((m) => m.z)), 'the pocket reaches its floor').toBeLessThanOrEqual(0.3 + 1e-6)

    await generate('op-finish')
    const request = lastRequest('COMPUTE_CONTOUR')
    const payload = request.payload as { remainingStock?: { nx: number; ny: number; topZ: ArrayLike<number> } }
    expect(payload.remainingStock, 'the request carries the remaining stock').toBeDefined()

    const finish = opById('op-finish')
    expect(contourStopLines(), toolpathLines().join('\n')).toEqual([])
    // The whole wall at the floor: the 20 x 16 rectangle offset in by the 3 mm tool radius.
    expect(feedLengthAtFloor(finish.toolpathMoves ?? [])).toBeCloseTo(2 * (14 + 10), 1)
    expect(dependsOnPredecessors(finish)).toBe(true)

    // Before this order: the same request without the remaining stock.
    const { remainingStock: _dropped, ...asLoaded } = request.payload as unknown as Record<string, unknown>
    const before = await runWorker({ ...request, payload: asLoaded } as unknown as WorkerRequestMsg)
    expect(before.notices.some((line) => /the shank would come within 0\.25 mm of the stock as loaded/.test(line)),
      before.notices.join('\n')).toBe(true)
    expect(before.notices.join('\n')).toMatch(/kept clear of the stock as loaded/)
    expect(feedLengthAtFloor(before.moves)).toBeLessThan(feedLengthAtFloor(finish.toolpathMoves ?? []) - 5)
  })

  it('suppressing the roughing outdates the contour; regenerated, it stops again with the stock-as-loaded line', async () => {
    install([roughingPocket(), finishingContour()])
    await generate('op-rough')
    await generate('op-finish')
    expect(contourStopLines()).toEqual([])

    useCamStore.getState().updateOperation(SETUP_ID, 'op-rough', { enabled: false })
    expect(opById('op-finish').status).toBe('outdated')

    useCamStore.setState({ consoleEvents: [] })
    await generate('op-finish')
    const request = lastRequest('COMPUTE_CONTOUR')
    expect((request.payload as { remainingStock?: unknown }).remainingStock).toBeUndefined()
    const lines = contourStopLines()
    expect(lines.length, toolpathLines().join('\n')).toBeGreaterThan(0)
    expect(lines[0]).toContain('"Finish wall"')
    expect(lines[0]).toMatch(/the shank would come within 0\.25 mm of the stock as loaded/)
    expect(toolpathLines().join('\n')).toMatch(/kept clear of the stock as loaded/)
    expect(dependsOnPredecessors(opById('op-finish'))).toBeUndefined()
  })

  it('moving the contour ahead of the roughing outdates it; regenerated, it stops against the stock, now first and alone', async () => {
    install([roughingPocket(), finishingContour()])
    await generate('op-rough')
    await generate('op-finish')
    expect(contourStopLines()).toEqual([])

    useCamStore.getState().reorderOperations(SETUP_ID, 1, 0)
    expect(useCamStore.getState().project.setups[0].operations.map((op) => op.id)).toEqual(['op-finish', 'op-rough'])
    expect(opById('op-finish').status).toBe('outdated')

    useCamStore.setState({ consoleEvents: [] })
    await generate('op-finish')
    const lines = contourStopLines()
    expect(lines.length, toolpathLines().join('\n')).toBeGreaterThan(0)
    // WO-1625: nothing precedes "Finish wall" now, so the stock as loaded IS
    // the remaining stock - no "as loaded" hedge, and no caveat is printed.
    expect(lines[0]).toMatch(/the shank would come within 0\.25 mm of the stock\./)
    expect(toolpathLines().join('\n')).not.toMatch(/not told what earlier operations removed/)
  })

  it('editing the roughing outdates the contour built on it', async () => {
    install([roughingPocket(), finishingContour()])
    await generate('op-rough')
    await generate('op-finish')

    const rough = opById('op-rough')
    useCamStore.getState().updateOperation(SETUP_ID, 'op-rough', { passes: { ...rough.passes, stockToLeave: 0.5 } })
    expect(opById('op-finish').status).toBe('outdated')
  })

  it('a contour generated before the roughing has a result uses the stock as loaded and does not depend on it', async () => {
    install([roughingPocket(), finishingContour()])
    await generate('op-finish')
    expect(contourStopLines().length).toBeGreaterThan(0)
    expect(contourStopLines()[0]).toMatch(/the shank would come within 0\.25 mm of the stock as loaded/)
    expect(dependsOnPredecessors(opById('op-finish'))).toBeUndefined()
  })

  it('Generate All computes the roughing first, so the contour is not stopped', async () => {
    install([roughingPocket(), finishingContour()])
    await useCamStore.getState().computeAllToolpaths()
    expect(opById('op-rough').status, opById('op-rough').errorMessage).toBe('ready')
    expect(opById('op-finish').status, opById('op-finish').errorMessage).toBe('ready')
    expect(contourStopLines(), toolpathLines().join('\n')).toEqual([])
    expect(dependsOnPredecessors(opById('op-finish'))).toBe(true)
  })
})

describe('WO-1582: the remaining stock stays cheap on a 20-operation setup', () => {
  it('replays each earlier result once; a later compute reuses them', async () => {
    install([roughingPocket(), finishingContour()])
    await generate('op-rough')
    const moves = opById('op-rough').toolpathMoves!
    const block = { min: { x: -40, y: -40, z: 0 }, max: { x: 40, y: 40, z: PLATE_TOP } }
    // Nineteen earlier operations, each with its own generated result.
    const preceding = Array.from({ length: 19 }, (_, index) => ({
      enabled: true,
      status: 'ready',
      toolpathMoves: moves.map((move) => ({ ...move, x: move.x + ((index % 4) - 1.5) * 18, y: move.y + (Math.floor(index / 4) - 2) * 14 })),
      tool: ROUGHING_MILL,
    }))

    const firstStart = performance.now()
    const first = remainingStockBefore(preceding, block)
    const firstMs = performance.now() - firstStart
    const againStart = performance.now()
    const again = remainingStockBefore(preceding, block)
    const againMs = performance.now() - againStart
    process.stdout.write(`[WO-1582] 19 earlier operations: first build ${firstMs.toFixed(1)} ms, cached ${againMs.toFixed(2)} ms\n`)

    expect(first?.operationsReplayed).toBe(19)
    expect(again?.stock).toBe(first?.stock)
    expect(againMs).toBeLessThan(5)

    // A suppressed or ungenerated operation contributes nothing.
    const skipped = remainingStockBefore([
      { enabled: false, status: 'ready', toolpathMoves: moves, tool: ROUGHING_MILL },
      { enabled: true, status: 'pending', toolpathMoves: undefined, tool: ROUGHING_MILL },
    ], block)
    expect(skipped).toBeUndefined()
  })
})

// ── Evidence (WRITE_EVIDENCE=1 only): side views with the tool drawn ─────────
//
// Operator lands this order on a picture, so the picture has to show the thing that
// changed: the same contour, at the same place, against two different stock
// profiles. The section is the floor pass along the front wall (world Y -5),
// looking from -Y - X across, Z up - so the cutter, shank and holder stand up
// out of the pocket the way they do on the machine. Both pictures draw the tool
// at the two wall positions of that pass; the only difference between them is
// the stock the gate was handed, and what it then allowed.

const EVIDENCE_DIR = join('src', 'tests', 'evidence', 'WO-1582')
const SECTION_Y = -5

/** One run of the section profile: x0, x1, top Z. */
type Column = readonly [number, number, number]

type Sample = { x: number; y: number; z: number; type: ToolpathMove['type'] }

/** The horizontal clearance, in the section, from a tool band's surface to the
 *  nearest material that reaches the band's bottom - the quantity the reach gate
 *  is deciding on, read back out of the very profile the picture draws. */
function clearanceToMaterial(columns: readonly Column[], centreX: number, radius: number, atZ: number): number {
  const lo = centreX - radius
  const hi = centreX + radius
  let best = Number.POSITIVE_INFINITY
  for (const [cx0, cx1, top] of columns) {
    if (top < atZ - 1e-6) continue
    best = Math.min(best, Math.max(0, cx0 - hi, lo - cx1))
  }
  return best
}

function samples(moves: readonly ToolpathMove[], step = 0.25): Sample[] {
  const out: Sample[] = []
  for (let i = 1; i < moves.length; i++) {
    const a = moves[i - 1]
    const b = moves[i]
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / step))
    for (let k = 0; k <= n; k++) {
      const t = k / n
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t, type: b.type })
    }
  }
  return out
}

/** The stock as loaded: one solid column across the whole block. */
function profileOfBlock(block: { min: Vec3; max: Vec3 }): Column[] {
  return [[block.min.x, block.max.x, block.max.z]]
}

/** The remaining stock the request carried, read out of its height field along
 *  the section line - equal-height cells merged so the pocket reads as one gap. */
function profileOfField(stock: StockState, y: number): Column[] {
  const cell = stock.resolutionMm
  const j = Math.floor((y - stock.bounds.minY) / cell)
  const out: Column[] = []
  for (let i = 0; i < stock.nx; i++) {
    const top = stock.topZ[j * stock.nx + i]
    const x0 = stock.bounds.minX + i * cell
    const last = out[out.length - 1]
    if (last && Math.abs(last[2] - top) < 1e-6 && Math.abs(last[1] - x0) < 1e-6) {
      out[out.length - 1] = [last[0], x0 + cell, top]
    } else {
      out.push([x0, x0 + cell, top])
    }
  }
  return out.filter((column) => column[2] > stock.bottomZ + 1e-6)
}

function columnsToObstacle(columns: readonly Column[]): Obstacle {
  // Many narrow columns make up a stock profile; one on-image label per column
  // would be clutter, so the caption names it instead (showLabel: false).
  return { columns: columns.map(([x0, x1, top]) => [x0, x1, 0, top] as const), colour: '#c0392b', label: 'stock', showLabel: false }
}

function evidenceSideView(name: string, title: string, subtitle: string, columns: readonly Column[],
  moves: readonly ToolpathMove[], toolXs: readonly number[], captions: readonly string[]): void {
  const path: PathPoint[] = samples(moves)
    .filter((s) => s.type !== 'rapid' && Math.abs(s.y - SECTION_Y) < 0.01)
    .map((s) => ({ x: s.x, y: SECTION_Y, z: s.z, kind: 'cut' }))
  const bands = toolBands(FINISHING_MILL, HOLDER)
  const placements: ToolPlacement[] = toolXs.map((x) => ({ x, tipZ: 0 }))
  // The crux, measured off the drawn profile: what the shank has beside it at
  // the height where it enters the stock, against the 0.25 mm allowance.
  const shank = bands.find(([, , , , label]) => label === 'shank')
  const tx = toolXs[toolXs.length - 1]
  const callouts = shank && tx !== undefined
    ? [{
        z: shank[0], fromX: tx + shank[2],
        text: `shank has ${clearanceToMaterial(columns, tx, shank[2], shank[0]).toFixed(2)} mm beside it at Z ${shank[0]} (allowance 0.25 mm)`,
      }]
    : []

  writeSideView({
    dir: EVIDENCE_DIR, name, title, subtitle,
    obstacles: [columnsToObstacle(columns)],
    path, bands, placements, callouts,
    captions: [
      `red = stock the gate was given (section at Y ${SECTION_Y}) - blue = cutting moves crossing the section - tool tip on the pocket floor, Z 0`,
      ...captions,
    ],
  })
}

describe('WO-1582 evidence: the side views Operator lands this order on', () => {
  it('draws the same contour against the stock as loaded and against what the roughing left', async () => {
    // The acceptance case, through the store's generate action - not a hand-built
    // payload (rule 6). This is the same scene the first case above proves.
    install([roughingPocket(), finishingContour()])
    await generate('op-rough')
    await generate('op-finish')

    const request = lastRequest('COMPUTE_CONTOUR')
    const payload = request.payload as unknown as Record<string, unknown>
    const remaining = payload.remainingStock as StockState | undefined
    expect(remaining, 'the request carries the remaining stock').toBeDefined()
    const block = payload.stockBlock as { min: Vec3; max: Vec3 }

    const afterMoves = opById('op-finish').toolpathMoves ?? []
    const afterFloor = feedLengthAtFloor(afterMoves)
    const afterLines = toolpathLines()
    expect(contourStopLines(), afterLines.join('\n')).toEqual([])

    // The same request with the remaining stock dropped: what the gate did before
    // this order, on exactly the same operation.
    const { remainingStock: _dropped, ...asLoaded } = payload
    const before = await runWorker({ ...request, payload: asLoaded } as unknown as WorkerRequestMsg)
    const beforeFloor = feedLengthAtFloor(before.moves)
    expect(beforeFloor).toBeLessThan(afterFloor - 5)

    // The two wall positions of the floor pass, so the tool is drawn where the
    // shank has to pass the wall.
    const wallXs = [-7, 7]

    evidenceSideView('before-stock-as-loaded',
      'BEFORE - the contour is given the stock as loaded',
      'Rough pocket 20 mm deep, then Finish wall with a 20 mm flute / 4 mm shank end mill. The gate is not told the roughing happened.',
      profileOfBlock(block), before.moves, wallXs,
      [
        `Measured: ${beforeFloor.toFixed(1)} mm of the 48.0 mm floor pass was cut. The wall is left uncut at full depth.`,
        ...before.notices,
      ])

    evidenceSideView('after-knows-what-roughing-removed',
      'AFTER - the contour is given what the roughing left',
      'Same operation, same tool, same request - the only change is that the gate is handed the remaining stock the roughing produced.',
      profileOfField(remaining!, SECTION_Y), afterMoves, wallXs,
      [
        `Measured: ${afterFloor.toFixed(1)} mm of the 48.0 mm floor pass was cut - the whole wall.`,
        afterLines.length > 0
          ? afterLines.join(' ')
          : 'Console: no toolpath line. Nothing stopped the cut, so the operation has nothing to report.',
      ])

    // The words under the pictures have to be the words the run produced.
    expect(before.notices.join('\n')).toMatch(/the shank would come within 0\.25 mm of the stock as loaded/)
    expect(afterLines).toEqual([])

    // And the number each picture puts beside the shank has to agree with the
    // verdict written under it: inside the allowance where the cut stopped,
    // outside it where the cut ran on.
    const shankRadius = FINISHING_MILL.shankDiameter / 2
    const shankBottom = FINISHING_MILL.fluteLength
    expect(clearanceToMaterial(profileOfBlock(block), 7, shankRadius, shankBottom)).toBeLessThan(0.25)
    expect(clearanceToMaterial(profileOfField(remaining!, SECTION_Y), 7, shankRadius, shankBottom))
      .toBeGreaterThanOrEqual(0.25)
  })
})
