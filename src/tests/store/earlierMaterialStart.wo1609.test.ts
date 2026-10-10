// WO-1609: 2D operations start at the material earlier operations left.
//
// Every case calls the store's OWN generate action (computeOperationToolpath);
// the store resolves the heights and builds the request, and the REAL
// toolpathWorker.ts handles it in-process. The only stand-in is the Worker
// thread (node has none) - the same wire WO-1582's test uses.
//
// SCENE (decide-and-log in the WO): a 60 x 40 mm plate, 20 mm thick (world Z
// 0..20, work origin on its top), a 20 x 16 mm pocket sketch in the middle.
//  - "Face": a 10 mm end mill facing the whole plate 2 mm down (explicit depth,
//    boundary = a sketch rectangle covering the plate).
//  - "Pocket": a 6 mm end mill, 10 mm deep (explicit depth), 3 mm step-down.
// Without the face the pocket's depth passes are at -3, -6, -9, -10. After the
// face they start from the faced surface (-2): -5, -8, -10.

import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCamStore } from '../../store'
import { DERIVED_STOCK_ID } from '../../store/migrateHierarchy'
import { remainingStockBefore } from '../../store/toolReachInputs'
import { highestMaterialOver } from '../../lib/cam/smartHeights'
import type { StockState } from '../../lib/cam/stockState'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'
import { writeSideView, toolBands, type PathPoint } from '../helpers/sideViewEvidence'
import type { WorkerRequestMsg, WorkerResponseMsg } from '../../lib/cam/types'
import type {
  BoundingBox, HeightParams, ImportedGeometry, LinkingParams, Operation, OperationType, PassParams, PhysicalStock,
  Project, SceneStock, Setup, Tool, ToolHolder, ToolpathMove, Vec3, WCS,
} from '../../types'

const SETUP_ID = 'setup-1'
const PLATE_TOP = 20
const FACE_DEPTH = 2
const POCKET_DEPTH = 10
const STEPDOWN = 3

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

function sketchRect(id: string, name: string, x0: number, y0: number, x1: number, y1: number): ImportedGeometry {
  return {
    id, name, filename: `${id}.dxf`, type: 'curves_2d', format: 'dxf',
    boundingBox: bbox({ x: x0, y: y0, z: 0 }, { x: x1, y: y1, z: 0 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    stockId: DERIVED_STOCK_ID, stockIdLocked: true,
    loops: [{
      id: `${id}-loop`, closed: true, type: 'contour', layerId: 'L1', area: (x1 - x0) * (y1 - y0),
      points: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }],
    }],
    layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
  } as unknown as ImportedGeometry
}

const POCKET_SKETCH = () => sketchRect('dxf-pocket', 'Pocket sketch', -10, -8, 10, 8)
/** Covers the whole plate, so the face takes 2 mm off everywhere the pocket is. */
const FACE_ALL_SKETCH = () => sketchRect('dxf-face', 'Face boundary', -30, -20, 30, 20)
/** A corner of the plate well clear of the pocket. */
const FACE_CORNER_SKETCH = () => sketchRect('dxf-face', 'Face boundary', 18, 8, 28, 18)

/** WO-1609: a boundary with an outer rect and an inner "hole" loop -
 * pocket2d.ts's classifyLoops (type 'hole') treats it as an island the
 * algorithm avoids cutting, so it survives in the stock the operation leaves. */
function sketchRectWithHole(
  id: string, name: string,
  outer: readonly [number, number, number, number],
  hole: readonly [number, number, number, number],
): ImportedGeometry {
  const [ox0, oy0, ox1, oy1] = outer
  const [hx0, hy0, hx1, hy1] = hole
  return {
    id, name, filename: `${id}.dxf`, type: 'curves_2d', format: 'dxf',
    boundingBox: bbox({ x: ox0, y: oy0, z: 0 }, { x: ox1, y: oy1, z: 0 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    stockId: DERIVED_STOCK_ID, stockIdLocked: true,
    loops: [
      {
        id: `${id}-outer`, closed: true, type: 'contour', layerId: 'L1',
        area: (ox1 - ox0) * (oy1 - oy0),
        points: [{ x: ox0, y: oy0 }, { x: ox1, y: oy0 }, { x: ox1, y: oy1 }, { x: ox0, y: oy1 }],
      },
      {
        id: `${id}-hole`, closed: true, type: 'hole', layerId: 'L1',
        area: (hx1 - hx0) * (hy1 - hy0),
        points: [{ x: hx0, y: hy0 }, { x: hx1, y: hy0 }, { x: hx1, y: hy1 }, { x: hx0, y: hy1 }],
      },
    ],
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

const FACE_MILL = tool({ id: 'face-mill', name: '10 mm end mill', diameter: 10, shankDiameter: 10 })
const POCKET_MILL = tool({ id: 'pocket-mill', name: '6 mm end mill' })

const LINKING: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
}

const HEIGHTS: HeightParams = {
  clearanceHeight: 15, clearanceHeightMode: 'absolute', retractHeight: 10, feedHeight: 5,
  topHeight: 0, topHeightMode: 'absolute', bottomHeight: -POCKET_DEPTH, bottomHeightMode: 'absolute',
}

function faceOp(): Operation {
  const params = {
    boundarySource: 'geometry', geometryId: 'dxf-face', loopIds: [],
    stockOffset: 0, boundaryContainment: 'outside', avoidanceLoopIds: [],
    pattern: 'zigzag', passAngle: 0, direction: 'both_ways', fromOtherSide: false,
    passExtension: 2, chipThinning: false, bothSidesPerLevel: false,
    floorStockToLeave: 0, finishPass: false, entryType: 'plunge', leadInRadius: 0,
    leadOutRadius: 0, keepToolDown: false, maxStayDownDistance: 0,
    extendBeforeRetract: false, transition: 'direct', tolerance: 0.05,
  }
  const passes: PassParams = { stepdown: FACE_DEPTH, stepover: 5, stockToLeave: 0, finishPasses: 0, springPasses: 0 }
  return {
    id: 'op-face', name: 'Face', type: 'face', enabled: true, status: 'pending',
    toolId: FACE_MILL.id, geometrySelections: [], heights: HEIGHTS, passes, linking: LINKING, params,
    smartHeight: smartHeightAuthorityFixture('face', {
      setupId: SETUP_ID, heights: HEIGHTS, params, stockId: DERIVED_STOCK_ID, explicitDepthMm: FACE_DEPTH,
    }),
  } as unknown as Operation
}

function pocketParams(type: OperationType): Record<string, unknown> {
  if (type === 'adaptive_clearing_2d') {
    return {
      geometryId: 'dxf-pocket', loopIds: [], targetEngagement: 0.4, maxEngagement: 0.7,
      stepDistance: 0.4, thetaMax: Math.PI / 3, climb: true, rampAngle: 3, completionTolerance: 1,
    }
  }
  if (type === 'contour_2d') {
    return { geometryId: 'dxf-pocket', loopIds: [], side: 'outer', direction: 'climb', tabs: false }
  }
  return { geometryId: 'dxf-pocket', loopIds: [], stepover: 3, heightReference: 'absolute', planeOffset: 0, direction: 'climb' }
}

function secondOp(type: 'pocket_2d' | 'adaptive_clearing_2d' | 'contour_2d'): Operation {
  const params = pocketParams(type)
  const passes: PassParams = { stepdown: STEPDOWN, stepover: 3, stockToLeave: 0, finishPasses: type === 'contour_2d' ? 1 : 0, springPasses: 0 }
  return {
    id: 'op-pocket', name: 'Pocket', type, enabled: true, status: 'pending',
    toolId: POCKET_MILL.id, geometrySelections: [], heights: HEIGHTS, passes, linking: LINKING, params,
    smartHeight: smartHeightAuthorityFixture(type, {
      setupId: SETUP_ID, heights: HEIGHTS, params, geometryIds: ['dxf-pocket'], explicitDepthMm: POCKET_DEPTH,
    }),
  } as unknown as Operation
}

function install(
  operations: Operation[],
  faceSketch: ImportedGeometry = FACE_ALL_SKETCH(),
  extraGeometry: readonly ImportedGeometry[] = [],
): void {
  const stock = {
    id: DERIVED_STOCK_ID, name: 'Stock', mode: 'explicit',
    bounds: bbox({ x: -30, y: -20, z: 0 }, { x: 30, y: 20, z: PLATE_TOP }),
    position: { x: -30, y: -20, z: 0 },
  } as unknown as PhysicalStock
  const setup = {
    id: SETUP_ID, name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: -30, y: -20, z: PLATE_TOP },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      stockId: DERIVED_STOCK_ID,
    } as WCS,
    stock: { type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum' },
    operations, notes: '',
  } as unknown as Setup
  const sceneStock = {
    mode: 'auto', autoOffsetXY: 0, autoOffsetZTop: 0, fixedWidth: 60, fixedHeight: 40, fixedDepth: PLATE_TOP, fixedStocks: [],
  } as unknown as SceneStock
  useCamStore.setState((s) => ({
    toolLibrary: [FACE_MILL, POCKET_MILL],
    holders: [HOLDER],
    toolpathBatch: null,
    consoleEvents: [],
    project: {
      ...s.project, geometry: [POCKET_SKETCH(), faceSketch, ...extraGeometry], stocks: [stock], setups: [setup], sceneStock,
      activeSetupId: SETUP_ID, activeOperationId: operations[0].id,
      modelItemPlacements: [],
    } as Project,
  }))
}

/** An earlier pocket_2d operation with its own boundary geometry, used as
 * "Pocket A" ahead of the "Pocket" ("Pocket B") the shared fixtures build. */
function earlierPocketOp(opts: {
  id: string
  name: string
  geometryId: string
  explicitDepthMm: number
}): Operation {
  const params = {
    geometryId: opts.geometryId, loopIds: [], stepover: 3, heightReference: 'absolute', planeOffset: 0, direction: 'climb',
  }
  const passes: PassParams = { stepdown: STEPDOWN, stepover: 3, stockToLeave: 0, finishPasses: 0, springPasses: 0 }
  return {
    id: opts.id, name: opts.name, type: 'pocket_2d', enabled: true, status: 'pending',
    toolId: POCKET_MILL.id, geometrySelections: [], heights: HEIGHTS, passes, linking: LINKING, params,
    smartHeight: smartHeightAuthorityFixture('pocket_2d', {
      setupId: SETUP_ID, heights: HEIGHTS, params, geometryIds: [opts.geometryId], explicitDepthMm: opts.explicitDepthMm,
    }),
  } as unknown as Operation
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
const startLines = () => useCamStore.getState().consoleEvents
  .filter((e) => e.source === 'toolpath' && e.message.includes('left, not the stock top'))
  .map((e) => e.message)

async function generate(opId: string): Promise<void> {
  await useCamStore.getState().computeOperationToolpath(SETUP_ID, opId)
  expect(opById(opId).status, opById(opId).errorMessage).toBe('ready')
}

/** The Z levels (WCS) the operation cuts at: horizontal feed moves below the plate top. */
function cutLevels(moves: readonly ToolpathMove[]): number[] {
  const levels = new Set<number>()
  for (let i = 1; i < moves.length; i++) {
    const a = moves[i - 1]
    const b = moves[i]
    if (b.type === 'rapid') continue
    if (Math.abs(a.z - b.z) > 1e-6 || Math.hypot(b.x - a.x, b.y - a.y) < 1e-6) continue
    const wcsZ = b.z - PLATE_TOP
    if (wcsZ < -1e-6) levels.add(Math.round(wcsZ * 1000) / 1000)
  }
  return [...levels].sort((p, q) => q - p)
}

const topOfPlan = (opId: string) => opById(opId).resolvedHeightPlan?.machining.materialStart.wcsMm

// ── Cases ────────────────────────────────────────────────────────────────────

describe('WO-1609: highestMaterialOver reads the replayed stock over a region', () => {
  it('is the faced height over a faced region, the stock top over an uncut one', async () => {
    install([faceOp(), secondOp('pocket_2d')])
    await generate('op-face')
    const block = { min: { x: -30, y: -20, z: 0 }, max: { x: 30, y: 20, z: PLATE_TOP } }
    const remaining = remainingStockBefore([{
      enabled: true, status: 'ready', toolpathMoves: opById('op-face').toolpathMoves, tool: FACE_MILL,
    }], block)!
    expect(highestMaterialOver(remaining.stock, { minX: -10, minY: -8, maxX: 10, maxY: 8 }))
      .toBeCloseTo(PLATE_TOP - FACE_DEPTH, 6)
    expect(highestMaterialOver(remaining.stock, { minX: 100, minY: 100, maxX: 110, maxY: 110 })).toBeUndefined()
  })
})

describe('WO-1609: a Face then a Pocket - the pocket starts at the faced surface', () => {
  it('the pocket depth passes start one step-down below the faced surface; the floor is unchanged', async () => {
    install([faceOp(), secondOp('pocket_2d')])
    await generate('op-face')
    await generate('op-pocket')
    const levels = cutLevels(opById('op-pocket').toolpathMoves ?? [])
    expect(levels, 'first pass one step-down below the faced surface').toEqual([-5, -8, -10])
    expect(topOfPlan('op-pocket')).toBeCloseTo(-FACE_DEPTH, 6)
    expect(opById('op-pocket').resolvedHeightPlan?.machining.materialArtifact?.representation)
      .toBe('material-left-by-earlier-operations')
    const lines = startLines()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toBe('"Pocket": starts at Z -2.000, the material "Face" left, not the stock top.')
  })

  it('the Top Height row preview shows the same number the moves were built from', async () => {
    install([faceOp(), secondOp('pocket_2d')])
    await generate('op-face')
    const plan = await useCamStore.getState().previewOperationSmartHeightPlan(SETUP_ID, opById('op-pocket'))
    expect(plan.machining.materialStart.wcsMm).toBeCloseTo(-FACE_DEPTH, 6)
    await generate('op-pocket')
    expect(topOfPlan('op-pocket')).toBeCloseTo(plan.machining.materialStart.wcsMm, 9)
  })

  it('with the Face deleted the pocket is what it is today', async () => {
    install([secondOp('pocket_2d')])
    await generate('op-pocket')
    expect(cutLevels(opById('op-pocket').toolpathMoves ?? [])).toEqual([-3, -6, -9, -10])
    expect(topOfPlan('op-pocket')).toBeCloseTo(0, 6)
    expect(opById('op-pocket').resolvedHeightPlan?.machining.materialArtifact?.representation)
      .toBe('axis-aligned-stock-box')
    expect(startLines()).toEqual([])
  })

  it('a Face whose region does not cover the pocket leaves it starting at the original top', async () => {
    install([faceOp(), secondOp('pocket_2d')], FACE_CORNER_SKETCH())
    await generate('op-face')
    await generate('op-pocket')
    expect(cutLevels(opById('op-pocket').toolpathMoves ?? [])).toEqual([-3, -6, -9, -10])
    expect(topOfPlan('op-pocket')).toBeCloseTo(0, 6)
    expect(startLines()).toEqual([])
  })

  it('a Face not yet computed changes nothing', async () => {
    install([faceOp(), secondOp('pocket_2d')])
    await generate('op-pocket')
    expect(cutLevels(opById('op-pocket').toolpathMoves ?? [])).toEqual([-3, -6, -9, -10])
  })

  it('an explicit Top is never replaced by the Face', async () => {
    const pocket = secondOp('pocket_2d')
    const state = pocket.smartHeight as unknown as { intent: { machining: { start: unknown } } }
    state.intent.machining.start = {
      owner: { kind: 'user_override' },
      value: { kind: 'explicit_plane', plane: { reference: 'stock_top', offsetMm: 0, owner: { kind: 'user_override' } } },
    }
    install([faceOp(), pocket])
    await generate('op-face')
    await generate('op-pocket')
    expect(cutLevels(opById('op-pocket').toolpathMoves ?? [])).toEqual([-3, -6, -9, -10])
    expect(topOfPlan('op-pocket')).toBeCloseTo(0, 6)
    expect(startLines()).toEqual([])
  })

  it('changing the Face outdates the pocket built on what it left', async () => {
    install([faceOp(), secondOp('pocket_2d')])
    await generate('op-face')
    await generate('op-pocket')
    useCamStore.getState().updateOperation(SETUP_ID, 'op-face', { enabled: false })
    expect(opById('op-pocket').status).toBe('outdated')
    await generate('op-pocket')
    expect(cutLevels(opById('op-pocket').toolpathMoves ?? [])).toEqual([-3, -6, -9, -10])
  })
})

/** WCS Z of every non-rapid move that ends below the plate top: cuts, plunges and lead-ins. */
function feedDepths(moves: readonly ToolpathMove[]): number[] {
  return moves.filter((m) => m.type !== 'rapid' && m.z - PLATE_TOP < -1e-6).map((m) => m.z - PLATE_TOP)
}

describe.each(['contour_2d', 'adaptive_clearing_2d'] as const)('WO-1609: a Face then %s', (type) => {
  it('starts one step-down below the faced surface; without the Face below the stock top; the floor is unchanged', async () => {
    install([faceOp(), secondOp(type)])
    await generate('op-face')
    await generate('op-pocket')
    const after = feedDepths(opById('op-pocket').toolpathMoves ?? [])
    expect(topOfPlan('op-pocket')).toBeCloseTo(-FACE_DEPTH, 6)
    expect(startLines()).toHaveLength(1)

    install([secondOp(type)])
    await generate('op-pocket')
    const before = feedDepths(opById('op-pocket').toolpathMoves ?? [])
    expect(topOfPlan('op-pocket')).toBeCloseTo(0, 6)

    expect(after.length).toBeGreaterThan(0)
    expect(before.length).toBeGreaterThan(0)
    expect(Math.max(...before), 'today: first pass one step-down below the stock top').toBeCloseTo(-STEPDOWN, 6)
    expect(Math.max(...after), 'first pass one step-down below the faced surface').toBeCloseTo(-FACE_DEPTH - STEPDOWN, 6)
    expect(Math.min(...after), 'deepest cut unchanged').toBeCloseTo(Math.min(...before), 6)
  })
})

// ── WO-1609 Operator's question: a raised island a partial earlier cut left ─────

describe('WO-1609: a raised island left by a partial earlier cut keeps the later pocket high', () => {
  it('an earlier cut over only half the region does not lower the later pocket\'s start', async () => {
    const halfGeo = sketchRect('dxf-pocketA-half', 'Pocket A boundary (left half)', -10, -8, 0, 8)
    const pocketA = earlierPocketOp({
      id: 'op-pocketA', name: 'Pocket A', geometryId: halfGeo.id, explicitDepthMm: FACE_DEPTH + STEPDOWN,
    })
    install([faceOp(), pocketA, secondOp('pocket_2d')], FACE_ALL_SKETCH(), [halfGeo])
    await generate('op-face')
    await generate('op-pocketA')
    await generate('op-pocket')

    const withA = cutLevels(opById('op-pocket').toolpathMoves ?? [])
    expect(withA[0], 'first pass one step-down below the island top (-2), not below the -5 A left on its half')
      .toBeCloseTo(-FACE_DEPTH - STEPDOWN, 6)
    expect(topOfPlan('op-pocket'), 'B starts at the island top, not at what A cut').toBeCloseTo(-FACE_DEPTH, 6)
    expect(opById('op-pocket').resolvedHeightPlan?.machining.materialArtifact?.representation)
      .toBe('material-left-by-earlier-operations')
    // Both Pocket A and Pocket B compute against what Face left, so there are
    // two lines; the one that matters here is B's, and it must name Face - the
    // op that actually set the region's top - never Pocket A, whose partial
    // cut left the region's high point exactly where Face put it.
    const lines = startLines()
    expect(lines, 'one line each for Pocket A and Pocket B').toHaveLength(2)
    const bLine = lines.find(line => line.startsWith('"Pocket":'))
    expect(bLine, 'names Face, not Pocket A, and does not claim a lower start than the island keeps')
      .toBe('"Pocket": starts at Z -2.000, the material "Face" left, not the stock top.')

    // With Pocket A deleted, B must start from the same place: A's partial cut
    // (leaving half the region a raised island at the faced height) did not
    // lower B's start below what the Face alone left.
    install([faceOp(), secondOp('pocket_2d')])
    await generate('op-face')
    await generate('op-pocket')
    const withoutA = cutLevels(opById('op-pocket').toolpathMoves ?? [])
    expect(withoutA, 'identical first pass with or without A\'s partial cut').toEqual(withA)
  })
})

// ── WO-1609 SH-10 probe: does a small boss survive the stock-state raster? ───
//
// remainingStockBefore replays onto a z-dexel StockState at a fixed cell size
// (REMAINING_STOCK_CELL_MM in src/store/toolReachInputs.ts). highestMaterialOver
// takes the max over every cell the region's bounding box touches, so a raised
// island bigger than one cell reads correctly. A column stores ONE height for
// its whole footprint, so an island smaller than one cell cannot be told apart
// from a fully-cut cell if the cell's sample point falls in material the real
// cutter never reached, and it can silently disappear.

describe('WO-1609: a small raised boss left by a partial earlier cut (SH-10 probe)', () => {
  it('records the stock-state cell size this order relies on', async () => {
    install([faceOp(), secondOp('pocket_2d')])
    await generate('op-face')
    const block = { min: { x: -30, y: -20, z: 0 }, max: { x: 30, y: 20, z: PLATE_TOP } }
    const remaining = remainingStockBefore([{
      enabled: true, status: 'ready', toolpathMoves: opById('op-face').toolpathMoves, tool: FACE_MILL,
    }], block)!
    // WO-2530 refines REMAINING_STOCK_CELL_MM for neck clearance in pilot holes.
    expect(remaining.stock.resolutionMm).toBeCloseTo(0.2, 6)
  })

  it('a 4x4 mm boss (20x20 cells - bigger than one) keeps the later pocket high', async () => {
    // A's own boundary is padded 5 mm past B's region on every side so A's OWN
    // tool-radius corner leftovers (a 6 mm tool cannot square its own outer
    // corners) fall outside the box B's region query reads - the only raised
    // material B's query can see inside its own region is the drawn island.
    const bossGeo = sketchRectWithHole(
      'dxf-pocketA-boss4', 'Pocket A boundary (4x4 boss)', [-15, -13, 15, 13], [-2, -2, 2, 2],
    )
    const pocketA = earlierPocketOp({
      id: 'op-pocketA', name: 'Pocket A', geometryId: bossGeo.id, explicitDepthMm: FACE_DEPTH + STEPDOWN,
    })
    install([faceOp(), pocketA, secondOp('pocket_2d')], FACE_ALL_SKETCH(), [bossGeo])
    await generate('op-face')
    await generate('op-pocketA')
    await generate('op-pocket')

    const levels = cutLevels(opById('op-pocket').toolpathMoves ?? [])
    expect(levels[0], 'first pass one step-down below the boss top (-2), not below the -5 A cut around it')
      .toBeCloseTo(-FACE_DEPTH - STEPDOWN, 6)
    expect(topOfPlan('op-pocket')).toBeCloseTo(-FACE_DEPTH, 6)
    const lines = startLines()
    expect(lines, 'one line each for Pocket A and Pocket B').toHaveLength(2)
    const bLine = lines.find(line => line.startsWith('"Pocket":'))
    expect(bLine).toBe('"Pocket": starts at Z -2.000, the material "Face" left, not the stock top.')
  })

  // SH-10 (found while proving WO-1609, not fixed): a boss smaller than the
  // stock-state's 0.5 mm cell is invisible to the column-height replay
  // earlierMaterialStartFor reads. Confirmed by hand: with A's own boundary
  // padded well clear of B's region (so A's own tool-radius corner leftovers,
  // unrelated to any island, cannot leak into the reading), a 0.2 mm island -
  // smaller than one 0.5 mm cell - is missed: B starts at -5 (the -8/-5/-3
  // pattern below -5), not -2. removeSweep (src/cam3d/stock/removeSweep.ts)
  // samples each cell at its CENTER; the nearest cell centers (+-0.25 mm from
  // the origin) fall outside the 0.2 mm island, so both read "cut", and
  // highestMaterialOver never sees the island. it.fails per the WO: do not
  // change product code to chase this here.
  it.fails('SH-10: a sub-cell boss (0.2mm, smaller than the 0.5mm cell) is missed', async () => {
    const bossGeo = sketchRectWithHole(
      'dxf-pocketA-bossSub', 'Pocket A boundary (sub-cell boss)', [-15, -13, 15, 13], [-0.1, -0.1, 0.1, 0.1],
    )
    const pocketA = earlierPocketOp({
      id: 'op-pocketA', name: 'Pocket A', geometryId: bossGeo.id, explicitDepthMm: FACE_DEPTH + STEPDOWN,
    })
    install([faceOp(), pocketA, secondOp('pocket_2d')], FACE_ALL_SKETCH(), [bossGeo])
    await generate('op-face')
    await generate('op-pocketA')
    await generate('op-pocket')

    const levels = cutLevels(opById('op-pocket').toolpathMoves ?? [])
    expect(levels[0], 'a real sub-cell boss should still keep B\'s start at -2')
      .toBeCloseTo(-FACE_DEPTH - STEPDOWN, 6)
    expect(topOfPlan('op-pocket')).toBeCloseTo(-FACE_DEPTH, 6)
  })
})

// ── Evidence (WRITE_EVIDENCE=1 only): side views with the tool drawn ─────────

const EVIDENCE_DIR = join('src', 'tests', 'evidence', 'WO-1609')
const SECTION_Y = 0

/** The stock height along the section line, equal-height cells merged. */
function profileOfField(stock: StockState, y: number): (readonly [number, number, number, number])[] {
  const cell = stock.resolutionMm
  const j = Math.floor((y - stock.bounds.minY) / cell)
  const out: [number, number, number, number][] = []
  for (let i = 0; i < stock.nx; i++) {
    const top = stock.topZ[j * stock.nx + i]
    const x0 = stock.bounds.minX + i * cell
    const last = out[out.length - 1]
    if (last && Math.abs(last[3] - top) < 1e-6 && Math.abs(last[1] - x0) < 1e-6) last[1] = x0 + cell
    else out.push([x0, x0 + cell, 0, top])
  }
  return out.filter((column) => column[3] > stock.bottomZ + 1e-6)
}

function sectionPath(moves: readonly ToolpathMove[]): PathPoint[] {
  const out: PathPoint[] = []
  for (let i = 1; i < moves.length; i++) {
    const a = moves[i - 1]
    const b = moves[i]
    if (b.type === 'rapid') continue
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / 0.25))
    for (let k = 0; k <= n; k++) {
      const t = k / n
      const y = a.y + (b.y - a.y) * t
      if (Math.abs(y - SECTION_Y) > 1.5) continue
      out.push({ x: a.x + (b.x - a.x) * t, y: SECTION_Y, z: a.z + (b.z - a.z) * t, kind: 'cut' })
    }
  }
  return out
}

describe('WO-1609 evidence: the side views Operator lands this order on', () => {
  it('draws the pocket after a facing pass, before and after this order', async () => {
    // AFTER: through the store's generate action (rule 6).
    install([faceOp(), secondOp('pocket_2d')])
    await generate('op-face')
    await generate('op-pocket')
    const afterMoves = opById('op-pocket').toolpathMoves ?? []
    const afterLevels = cutLevels(afterMoves)
    const block = { min: { x: -30, y: -20, z: 0 }, max: { x: 30, y: 20, z: PLATE_TOP } }
    const faced = remainingStockBefore([{
      enabled: true, status: 'ready', toolpathMoves: opById('op-face').toolpathMoves, tool: FACE_MILL,
    }], block)!.stock
    const afterLine = startLines()[0]

    // BEFORE: the pocket as this build computes it with the stock as loaded -
    // the path every build before this order produced after the same Face.
    install([secondOp('pocket_2d')])
    await generate('op-pocket')
    const beforeMoves = opById('op-pocket').toolpathMoves ?? []
    const beforeLevels = cutLevels(beforeMoves)

    const bands = toolBands(POCKET_MILL, HOLDER)
    const stockObstacle = { columns: profileOfField(faced, SECTION_Y), colour: '#c0392b', label: 'stock', showLabel: false }
    const faceZ = PLATE_TOP - FACE_DEPTH
    const common = {
      dir: EVIDENCE_DIR,
      obstacles: [stockObstacle],
      bands,
      referenceLines: [
        { z: PLATE_TOP, label: 'original stock top (WCS Z 0)' },
        { z: faceZ, label: `faced surface (WCS Z -${FACE_DEPTH})` },
      ],
    }
    writeSideView({
      ...common,
      name: 'before-pocket-starts-at-original-top',
      title: 'BEFORE - the pocket starts at the original stock top',
      subtitle: `Face 2 mm, then a 10 mm deep Pocket (6 mm end mill, 3 mm step-down). Section at Y ${SECTION_Y}, looking from -Y.`,
      path: sectionPath(beforeMoves),
      placements: [{ x: 0, tipZ: PLATE_TOP + beforeLevels[0] }],
      captions: [
        'red = the stock the Face left - blue = pocket cutting moves near the section - tool drawn at the first depth pass',
        `First depth pass at WCS Z ${beforeLevels[0].toFixed(3)}: only ${(-FACE_DEPTH - beforeLevels[0]).toFixed(3)} mm of its ${STEPDOWN} mm step is in material; the top ${FACE_DEPTH} mm cuts air the Face already removed.`,
        `Depth passes: ${beforeLevels.join(', ')}`,
      ],
    })
    writeSideView({
      ...common,
      name: 'after-pocket-starts-at-faced-surface',
      title: 'AFTER - the pocket starts at the material the Face left',
      subtitle: `Same Face, same Pocket, same tool. Section at Y ${SECTION_Y}, looking from -Y.`,
      path: sectionPath(afterMoves),
      placements: [{ x: 0, tipZ: PLATE_TOP + afterLevels[0] }],
      captions: [
        'red = the stock the Face left - blue = pocket cutting moves near the section - tool drawn at the first depth pass',
        `First depth pass at WCS Z ${afterLevels[0].toFixed(3)}: a full ${STEPDOWN} mm step below the faced surface.`,
        `Depth passes: ${afterLevels.join(', ')}`,
        `Console: ${afterLine}`,
      ],
    })

    expect(beforeLevels[0]).toBeCloseTo(-STEPDOWN, 6)
    expect(afterLevels[0]).toBeCloseTo(-FACE_DEPTH - STEPDOWN, 6)
    expect(Math.min(...afterLevels)).toBeCloseTo(Math.min(...beforeLevels), 6)
  })
})
