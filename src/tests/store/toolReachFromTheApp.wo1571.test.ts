// WO-1571: the app trims every cut to the tool's reach (WO-1565 switched on).
//
// WO-1565's own test handed the worker a payload built by hand. Here every case
// calls the store's OWN generate action (computeOperationToolpath) on a project,
// the store builds the request, and the REAL toolpathWorker.ts handles it
// in-process. The only stand-in is the Worker thread (node has none). Expected
// places are checked from plain box geometry computed HERE.
//
// SCENE (decide-and-log in the WO): the WO-1565 lip T - a 10x10 stem Z 0..10
// under a flange Z 10..15 covering the stem's X <= 0 half with a 0.3 mm
// overhang - as a model body, profiled by a contour operation (the derived
// profile is the top-down outline, WO-1562). The app does not yet know what
// earlier operations removed, so the stock as loaded is used; it spans Z 5..10
// (the contour's Smart Height intent cuts through the stock, so the cut is at
// its bottom, Z 5, within the 6 mm head's flute length, and its top is the stem
// top), so the lollipop's neck is clear of the stock and the only rub left is
// its 3 mm-long neck's shank against the flange.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCamStore } from '../../store'
import { DERIVED_STOCK_ID } from '../../store/migrateHierarchy'
import { resolveToolReachInputs } from '../../store/toolReachInputs'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'
import type { WorkerRequestMsg, WorkerResponseMsg } from '../../lib/cam/types'
import type {
  BoundingBox, HeightParams, ImportedGeometry, LinkingParams, ModelItemPlacementRecord, Operation,
  PassParams, PhysicalStock, Project, SceneStock, Setup, Tool, ToolHolder, ToolpathMove, Vec3, WCS,
} from '../../types'

// ── Geometry ─────────────────────────────────────────────────────────────────

/** [minX, minY, minZ, maxX, maxY, maxZ] */
type Box = readonly [number, number, number, number, number, number]
const LIP: Box = [-5.3, -5.3, 10, 0, 5.3, 15]
const CUT_Z = 5
const SHANK_RADIUS = 3
/** The 6 mm ball meets its 3 mm neck 3 + 2.598 mm above the tip; the 3 mm-long neck ends 3 mm higher. */
const SHANK_BOTTOM_ABOVE_TIP = 3 + Math.sqrt(9 - 2.25) + 3

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

/** Closed voxel-grid solid (every exterior cell face, two triangles each). */
function gridSolid(xs: number[], ys: number[], zs: number[], solid: (x: number, y: number, z: number) => boolean) {
  const nx = xs.length, ny = ys.length
  const positions: number[] = []
  for (const z of zs) for (const y of ys) for (const x of xs) positions.push(x, y, z)
  const v = (i: number, j: number, k: number) => i + nx * (j + ny * k)
  const filled = (i: number, j: number, k: number) =>
    i >= 0 && j >= 0 && k >= 0 && i < nx - 1 && j < ny - 1 && k < zs.length - 1 &&
    solid((xs[i] + xs[i + 1]) / 2, (ys[j] + ys[j + 1]) / 2, (zs[k] + zs[k + 1]) / 2)
  const indices: number[] = []
  const quad = (a: number, b: number, c: number, d: number) => indices.push(a, b, c, a, c, d)
  for (let k = 0; k < zs.length - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    if (!filled(i, j, k)) continue
    if (!filled(i - 1, j, k)) quad(v(i, j, k), v(i, j + 1, k), v(i, j + 1, k + 1), v(i, j, k + 1))
    if (!filled(i + 1, j, k)) quad(v(i + 1, j, k), v(i + 1, j, k + 1), v(i + 1, j + 1, k + 1), v(i + 1, j + 1, k))
    if (!filled(i, j - 1, k)) quad(v(i, j, k), v(i, j, k + 1), v(i + 1, j, k + 1), v(i + 1, j, k))
    if (!filled(i, j + 1, k)) quad(v(i, j + 1, k), v(i + 1, j + 1, k), v(i + 1, j + 1, k + 1), v(i, j + 1, k + 1))
    if (!filled(i, j, k - 1)) quad(v(i, j, k), v(i + 1, j, k), v(i + 1, j + 1, k), v(i, j + 1, k))
    if (!filled(i, j, k + 1)) quad(v(i, j, k + 1), v(i, j + 1, k + 1), v(i + 1, j + 1, k + 1), v(i + 1, j, k + 1))
  }
  return { positions, indices }
}

const T_MESH = gridSolid([-5.3, -5, 0, 5], [-5.3, -5, 5, 5.3], [0, 10, 15], (x, y, z) =>
  z < 10 ? Math.abs(x) < 5 && Math.abs(y) < 5 : x < 0 && Math.abs(y) < 5.3)

function lipT(): ImportedGeometry {
  return {
    id: 'lip-t', name: 'Lip T', filename: '', type: 'model', format: 'model',
    boundingBox: bbox({ x: -5.3, y: -5.3, z: 0 }, { x: 5, y: 5.3, z: 15 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    stockId: DERIVED_STOCK_ID, stockIdLocked: true,
    modelItemId: 'legacy',
    modelBody: {
      ref: { bodyId: 'lip-t-body', stableIds: ['lip-t-body:F0'], version: 1 },
      display: {
        positions: T_MESH.positions, normals: [], indices: T_MESH.indices,
        edgePositions: [], edgeOffsets: [], bbox: { min: [-5.3, -5.3, 0], max: [5, 5.3, 15] },
      },
    },
  } as unknown as ImportedGeometry
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

// ── Tools ────────────────────────────────────────────────────────────────────

const HOLDER: ToolHolder = {
  id: 'holder-1', name: 'ER20 collet chuck',
  segments: [{ height: 40, lowerDiameter: 20, upperDiameter: 20 }],
}

function tool(overrides: Partial<Tool>): Tool {
  return {
    id: 'tool-1', name: 'tool', type: 'flat_end_mill',
    diameter: 6, fluteLength: 20, shankDiameter: 6, overallLength: 60,
    lengthBelowHolder: 40, numberOfFlutes: 2, material: 'carbide', coating: 'none',
    holderId: 'holder-1', notes: '',
    feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 2, stepover: 1.5 } },
    ...overrides,
  } as unknown as Tool
}

/** 6 mm lollipop with a 3 mm neck only 3 mm long: the shank starts 5.598 + 3 mm above the tip. */
const SHORT_NECK_LOLLIPOP = tool({
  name: '6 mm lollipop, 3 mm neck', type: 'lollipop_mill',
  diameter: 6, fluteLength: 6, shankDiameter: 6, neckDiameter: 3, shoulderLength: 3,
} as Partial<Tool>)

/** A flat end mill held short: the holder face is 8 mm above the tip. */
const SHORT_STICKOUT_MILL = tool({ name: '6 mm end mill, 8 mm stickout', lengthBelowHolder: 8 })

// ── Project ──────────────────────────────────────────────────────────────────

const LINKING: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
}

/** Heights in WCS terms for a work origin at `originZ`, so the cut is at world Z 5 whichever origin is used. */
function contourHeights(originZ: number): HeightParams {
  return {
    clearanceHeight: 30 - originZ, clearanceHeightMode: 'absolute',
    retractHeight: 25 - originZ, feedHeight: 20 - originZ,
    topHeight: 10 - originZ, topHeightMode: 'absolute',
    bottomHeight: CUT_Z - originZ, bottomHeightMode: 'absolute',
  }
}

function contourOp(originZ: number, clearanceAllowanceMm?: number): Operation {
  const heights = contourHeights(originZ)
  const params = {
    geometryId: 'lip-t', loopIds: [], side: 'outer', direction: 'climb', tabs: false,
    ...(clearanceAllowanceMm !== undefined ? { clearanceAllowanceMm } : {}),
  }
  const passes: PassParams = { stepdown: 5, stepover: 1.5, stockToLeave: 0, finishPasses: 1, springPasses: 0 }
  return {
    id: 'op-1', name: 'Undercut profile', type: 'contour_2d', enabled: true, status: 'pending',
    toolId: 'tool-1', geometrySelections: [], heights, passes, linking: LINKING, params,
    smartHeight: smartHeightAuthorityFixture('contour_2d', { setupId: 'setup-1', heights, params, geometryIds: ['lip-t'] }),
  } as unknown as Operation
}

function pocketOp(): Operation {
  const heights: HeightParams = {
    clearanceHeight: 60, clearanceHeightMode: 'absolute', retractHeight: 55, feedHeight: 50,
    topHeight: 12, topHeightMode: 'absolute', bottomHeight: 2, bottomHeightMode: 'absolute',
  }
  const params = { geometryId: 'dxf-pocket', loopIds: [], stepover: 3, heightReference: 'absolute', planeOffset: 2, direction: 'climb' }
  const passes: PassParams = { stepdown: 3, stepover: 3, stockToLeave: 0, finishPasses: 0, springPasses: 0 }
  return {
    id: 'op-1', name: 'Deep sketch pocket', type: 'pocket_2d', enabled: true, status: 'pending',
    toolId: 'tool-1', geometrySelections: [], heights, passes, linking: LINKING, params,
    smartHeight: smartHeightAuthorityFixture('pocket_2d', { setupId: 'setup-1', heights, params, geometryIds: ['dxf-pocket'] }),
  } as unknown as Operation
}

interface Install {
  geometry: ImportedGeometry
  op: Operation
  tool: Tool
  stockTop: number
  stockBottom?: number
  origin?: Vec3
  placement?: ModelItemPlacementRecord
}

function install({ geometry, op, tool: t, stockTop, stockBottom = 0, origin = { x: -40, y: -40, z: 0 }, placement }: Install): void {
  // An explicit stock sits with its min corner at `position` (stockWorldBounds).
  const stock = {
    id: DERIVED_STOCK_ID, name: 'Stock', mode: 'explicit',
    bounds: bbox({ x: -40, y: -40, z: stockBottom }, { x: 40, y: 40, z: stockTop }),
    position: { x: -40, y: -40, z: stockBottom },
  } as unknown as PhysicalStock
  const setup = {
    id: 'setup-1', name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { ...origin },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      stockId: DERIVED_STOCK_ID,
    } as WCS,
    stock: { type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum' },
    operations: [op], notes: '',
  } as unknown as Setup
  const sceneStock = {
    mode: 'auto', autoOffsetXY: 0, autoOffsetZTop: 0, fixedWidth: 80, fixedHeight: 80, fixedDepth: stockTop, fixedStocks: [],
  } as unknown as SceneStock
  useCamStore.setState((s) => ({
    toolLibrary: [t],
    holders: [HOLDER],
    toolpathBatch: null,
    consoleEvents: [],
    project: {
      ...s.project, geometry: [geometry], stocks: [stock], setups: [setup], sceneStock,
      activeSetupId: 'setup-1', activeOperationId: op.id,
      modelItemPlacements: [placement ?? { modelItemId: 'legacy', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }],
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

const theOp = () => useCamStore.getState().project.setups[0].operations[0]
const toolpathLines = () => useCamStore.getState().consoleEvents.filter((e) => e.source === 'toolpath').map((e) => e.message)
const stopLines = () => toolpathLines().filter((line) => line.includes('left uncut'))

async function generate(): Promise<void> {
  await useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')
  expect(theOp().status, theOp().errorMessage).toBe('ready')
}

interface Stop { x: number; y: number; z: number; uncut: number; line: string }

function stopsOf(lines: readonly string[]): Stop[] {
  return lines.flatMap((line) => {
    // WO-1683: a stop through the store's generate action now names its frame
    // ("cut stopped at G54 X.. Y.. Z.."); the frame word is optional here.
    const at = /cut stopped at (?:\S+ )?X (-?[\d.]+) Y (-?[\d.]+) Z (-?[\d.]+)/.exec(line)
    const uncut = /([\d.]+) mm of cutting path was left uncut/.exec(line)
    return at && uncut ? [{ x: Number(at[1]), y: Number(at[2]), z: Number(at[3]), uncut: Number(uncut[1]), line }] : []
  })
}

function xyDistanceToBox(x: number, y: number, [x0, y0, , x1, y1]: Box): number {
  return Math.hypot(Math.max(x0 - x, 0, x - x1), Math.max(y0 - y, 0, y - y1))
}

/** How far the shank is from the flange with the tip at (x, y, z) in the part's frame: beside it, or above its top. */
function shankGapToFlange(x: number, y: number, z: number): number {
  return Math.max(xyDistanceToBox(x, y, LIP) - SHANK_RADIUS, z + SHANK_BOTTOM_ABOVE_TIP - LIP[5])
}

function cutLengthAt(moves: readonly ToolpathMove[], z: number): number {
  let length = 0
  for (let i = 1; i < moves.length; i++) {
    const a = moves[i - 1]
    const b = moves[i]
    if (b.type === 'rapid' || Math.abs(a.z - z) > 1e-6 || Math.abs(b.z - z) > 1e-6) continue
    length += Math.hypot(b.x - a.x, b.y - a.y)
  }
  return length
}

/** Moves the builder gives for the SAME request with the reach inputs stripped - today's untrimmed program. */
async function untrimmed(request: WorkerRequestMsg): Promise<ToolpathMove[]> {
  const { buildContourToolpath } = await import('../../lib/cam/contour2d')
  const { ensureClipperReady } = await import('../../lib/cam/face2d/clipperOffset')
  await ensureClipperReady()
  return buildContourToolpath(request.payload as Parameters<typeof buildContourToolpath>[0])
}

// ── Cases ────────────────────────────────────────────────────────────────────

describe('WO-1571: the store generate action trims a contour to the tool reach', () => {
  it('a short-neck lollipop profiling the lip T: trimmed program, a stop line naming the operation, XYZ and uncut length, nothing refused', async () => {
    install({ geometry: lipT(), op: contourOp(0), tool: SHORT_NECK_LOLLIPOP, stockBottom: CUT_Z, stockTop: 10 })
    await generate()

    const request = workerRequests.find((r) => r.type === 'COMPUTE_CONTOUR')!
    const payload = request.payload as { clearancePart?: { positions: ArrayLike<number> }; clearanceAllowanceMm?: number }
    expect(payload.clearanceAllowanceMm).toBe(0.25)
    expect(payload.clearancePart?.positions.length).toBe(T_MESH.positions.length)

    const moves = theOp().toolpathMoves ?? []
    const before = await untrimmed(request)
    expect(cutLengthAt(moves, CUT_Z)).toBeGreaterThan(0)
    expect(cutLengthAt(moves, CUT_Z)).toBeLessThan(cutLengthAt(before, CUT_Z) - 5)

    const stops = stopsOf(stopLines())
    expect(stops.length, toolpathLines().join('\n')).toBeGreaterThan(0)
    for (const stop of stops) {
      expect(stop.line).toContain('"Undercut profile"')
      expect(stop.line).toMatch(/the shank would come within 0\.25 mm of the part/)
      // At the cut depth, or on the way down to it (a plunge beside the flange stops where the shank reaches its top).
      expect(stop.z).toBeGreaterThanOrEqual(CUT_Z - 1e-6)
      expect(stop.z).toBeLessThan(10)
      expect(stop.uncut).toBeGreaterThan(0)
      // Stops where the shank comes to the clearance from the flange, not far before it.
      const gap = shankGapToFlange(stop.x, stop.y, stop.z)
      expect(gap).toBeGreaterThanOrEqual(0.25 - 0.01)
      expect(gap).toBeLessThan(0.25 + 0.5)
    }
    // WO-1683: the console now says one summary line per generate (only the
    // first stop's position), so this per-stop invariant is checked directly
    // against the trimmed moves instead of parsed console text.
    const atCutDepth = moves.some((move) => {
      if (move.type === 'rapid' || Math.abs(move.z - CUT_Z) > 1e-6) return false
      const gap = shankGapToFlange(move.x, move.y, move.z)
      return gap >= 0.25 - 0.01 && gap < 0.25 + 0.5
    })
    expect(atCutDepth, 'one move sits at the cut depth at the clearance gap').toBe(true)
  })

  it('the same scene with the work origin at the part centre stops at the same place on the part', async () => {
    install({ geometry: lipT(), op: contourOp(0), tool: SHORT_NECK_LOLLIPOP, stockBottom: CUT_Z, stockTop: 10 })
    await generate()
    const atCorner = stopsOf(stopLines())
    const cornerMoves = theOp().toolpathMoves

    install({ geometry: lipT(), op: contourOp(7.5), tool: SHORT_NECK_LOLLIPOP, stockBottom: CUT_Z, stockTop: 10, origin: { x: 0, y: 0, z: 7.5 } })
    await generate()
    const atCentre = stopsOf(stopLines())

    expect(atCentre.length).toBeGreaterThan(0)
    expect(atCentre.map(({ x, y, z, uncut }) => ({ x, y, z, uncut })))
      .toEqual(atCorner.map(({ x, y, z, uncut }) => ({ x, y, z, uncut })))
    expect(theOp().toolpathMoves).toEqual(cornerMoves)
  })

  it('a part placed turned 90 deg and moved: the stop moves with the part', async () => {
    install({ geometry: lipT(), op: contourOp(0), tool: SHORT_NECK_LOLLIPOP, stockBottom: CUT_Z, stockTop: 10 })
    await generate()
    const home = stopsOf(stopLines())

    const placement = { modelItemId: 'legacy', position: { x: 12, y: -7, z: 0 }, rotation: { x: 0, y: 0, z: 90 } }
    install({ geometry: lipT(), op: contourOp(0), tool: SHORT_NECK_LOLLIPOP, stockBottom: CUT_Z, stockTop: 10, placement })
    await generate()
    const moved = stopsOf(stopLines())

    expect(home.length).toBeGreaterThan(0)
    expect(moved.length).toBe(home.length)
    // Every stop, taken back into the part's own frame, sits the clearance off the flange.
    for (const stop of moved) {
      const lx = stop.y - placement.position.y
      const ly = -(stop.x - placement.position.x)
      const gap = shankGapToFlange(lx, ly, stop.z)
      expect(gap).toBeGreaterThanOrEqual(0.25 - 0.01)
      expect(gap).toBeLessThan(0.25 + 0.5)
    }
    const total = (stops: Stop[]) => stops.reduce((sum, stop) => sum + stop.uncut, 0)
    expect(Math.abs(total(moved) - total(home))).toBeLessThan(1)
  })

  it('a tilted part: the part the worker keeps clear of is the body where the app shows it', async () => {
    const placement = { modelItemId: 'legacy', position: { x: 3, y: 4, z: 2 }, rotation: { x: 30, y: 0, z: 0 } }
    install({ geometry: lipT(), op: contourOp(0), tool: SHORT_NECK_LOLLIPOP, stockBottom: CUT_Z, stockTop: 10, placement })
    await useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')
    const request = workerRequests.find((r) => r.type === 'COMPUTE_CONTOUR')
    expect(request, theOp().errorMessage).toBeDefined()
    const { clearancePart, loops } = request!.payload as unknown as {
      clearancePart: { positions: ArrayLike<number>; indices: ArrayLike<number> }
      loops: { points: { x: number; y: number }[] }[]
    }
    // The derived profile the moves follow and the part the worker checks are one outline.
    // Only corners a triangle uses (the grid solid also stores the empty cells' corners).
    const partX: number[] = []
    const partY: number[] = []
    for (let i = 0; i < clearancePart.indices.length; i++) {
      const vertex = clearancePart.indices[i] * 3
      partX.push(clearancePart.positions[vertex])
      partY.push(clearancePart.positions[vertex + 1])
    }
    const loopPoints = loops.flatMap((loop) => loop.points)
    expect(Math.min(...partX)).toBeCloseTo(Math.min(...loopPoints.map((p) => p.x)), 1)
    expect(Math.max(...partX)).toBeCloseTo(Math.max(...loopPoints.map((p) => p.x)), 1)
    expect(Math.min(...partY)).toBeCloseTo(Math.min(...loopPoints.map((p) => p.y)), 1)
    expect(Math.max(...partY)).toBeCloseTo(Math.max(...loopPoints.map((p) => p.y)), 1)
  })

  it('Shank clearance 0.5 on the operation moves the stop and the line says 0.5 mm', async () => {
    install({ geometry: lipT(), op: contourOp(0), tool: SHORT_NECK_LOLLIPOP, stockBottom: CUT_Z, stockTop: 10 })
    await generate()
    const quarter = stopsOf(stopLines())

    install({ geometry: lipT(), op: contourOp(0, 0.5), tool: SHORT_NECK_LOLLIPOP, stockBottom: CUT_Z, stockTop: 10 })
    await generate()
    const half = stopsOf(stopLines())

    expect(half.length).toBeGreaterThan(0)
    for (const stop of half) {
      expect(stop.line).toMatch(/within 0\.5 mm of the part/)
      expect(shankGapToFlange(stop.x, stop.y, stop.z)).toBeGreaterThanOrEqual(0.5 - 0.01)
    }
    const total = (stops: Stop[]) => stops.reduce((sum, stop) => sum + stop.uncut, 0)
    expect(total(half)).toBeGreaterThan(total(quarter))
  })
})

describe('WO-1571: a job with no model body is trimmed against the stock, not refused', () => {
  it('a DXF pocket whose holder would hit the stock top: a trimmed program and a stop line', async () => {
    install({ geometry: dxfRect(), op: pocketOp(), tool: SHORT_STICKOUT_MILL, stockTop: 12 })
    await generate()

    const request = workerRequests.find((r) => r.type === 'COMPUTE_POCKET')!
    expect((request.payload as { clearancePart?: unknown }).clearancePart).toBeUndefined()
    const moves = theOp().toolpathMoves ?? []
    const cutting = moves.filter((m) => m.type !== 'rapid')
    expect(cutting.length).toBeGreaterThan(0)
    // The holder face is 8 mm above the tip: nothing is cut deeper than it can go under a 12 mm stock top.
    const deepest = Math.min(...cutting.map((m) => m.z))
    expect(deepest).toBeGreaterThan(12 - 8 - 0.25 - 1e-6)

    const stops = stopsOf(stopLines())
    expect(stops.length, toolpathLines().join('\n')).toBeGreaterThan(0)
    expect(stops[0].line).toContain('"Deep sketch pocket"')
    // WO-1625: this op is alone in its setup, so the stock as loaded IS the
    // remaining stock - no caveat, and the line says "the stock", not
    // "the stock as loaded".
    // WO-1683: a generate that stops more than once now says so on the same
    // line ("... of the stock (N stops).") instead of one line per stop.
    expect(stops[0].line).toMatch(/the holder would come within 0\.25 mm of the stock(?: \(\d+ stops\))?\./)
    expect(toolpathLines().join('\n')).not.toMatch(/not told what earlier operations removed/)
  })
})

describe('WO-1571: the reach inputs the store sends', () => {
  it('a part mesh that cannot be read still produces a program trimmed against the stock, and says so', async () => {
    const broken = lipT()
    ;(broken.modelBody as unknown as { display: { positions: number[] } }).display.positions = []
    const inputs = resolveToolReachInputs({ params: {}, geoSources: [broken], modelItemPlacements: [] })
    expect(inputs.clearanceAllowanceMm).toBe(0.25)
    expect(inputs.clearancePart?.positions.length).toBe(0)

    // The same request the store sends for the pocket, with that unreadable part on it.
    install({ geometry: dxfRect(), op: pocketOp(), tool: SHORT_STICKOUT_MILL, stockTop: 12 })
    await generate()
    const request = workerRequests.find((r) => r.type === 'COMPUTE_POCKET')!
    const posted: WorkerResponseMsg[] = []
    activeShim = { onmessage: (e) => { posted.push(e.data) } }
    await workerSelf.onmessage!({ data: { ...request, payload: { ...request.payload, ...inputs } } as WorkerRequestMsg })
    const done = posted.find((m) => m.type === 'TOOLPATH_COMPLETE') as { moves: ToolpathMove[]; notices?: string[] } | undefined
    expect(done).toBeDefined()
    expect(done!.moves).toEqual(theOp().toolpathMoves)
    expect(done!.notices?.join('\n')).toMatch(/the part shape could not be read, so the tool was kept clear of the stock only/)
  })

  it('an operation without a clearance set sends the 0.25 mm default; one set to 0.5 sends 0.5', () => {
    expect(resolveToolReachInputs({ params: {}, geoSources: [dxfRect()], modelItemPlacements: [] }))
      .toEqual({ clearanceAllowanceMm: 0.25 })
    expect(resolveToolReachInputs({ params: { clearanceAllowanceMm: 0.5 }, geoSources: [dxfRect()], modelItemPlacements: [] }))
      .toEqual({ clearanceAllowanceMm: 0.5 })
  })
})
