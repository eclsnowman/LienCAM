// WO-1575: a cut stops short of the workholding and says where.
//
// Operator's fixture and clamp avoidance mandate (2026-08-09) and the undercut rulings
// of 2026-09-15: a cut goes only as far as the tool reaches, never refused. The
// workholding is a third obstacle beside the part and the remaining stock, and
// against it every component of the tool - cutter, neck, shank, holder - keeps
// the operation's Shank clearance.
//
// The 2D cases drive the REAL worker entry point (self.onmessage) with a REAL
// contour; the 3D cases drive the real operation adapters with a stub kernel
// client. Every distance is checked against plain box geometry computed HERE,
// never against the module's own column grid.
//
// FIXTURES: a 30 x 20 block profiled by a 6 mm end mill at Z 5, so the tool
// centre runs along Y 13 on the +Y side. The JAW is 20 mm tall and crosses that
// side. The CLAMP is a lip Z 0..2 under the whole +Y side (the cut clears it by
// 3 mm) with a nose Z 12..17 overhanging only X -4..4: one column holds two solid
// spans, and only the nose may stop the cut.

import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

import type { HeightParams, LinkingParams, PassParams, Tool, ToolHolder, ToolpathMove } from '../../types'
import type {
  ContourWorkerPayload, LoopData, ToolpathStockBlock, WorkerRequestMsg, WorkerResponseMsg,
} from '../../lib/cam/types'
import type { ToolReachInputs } from '../../lib/cam/holderClearanceGate'
import { trimToToolReachInPartFrame } from '../../store/toolReachInputs'
import type { ToolpathCompleteWithNotices } from '../../lib/cam/toolpathWorker'
import { buildSolidColumns, type ClearanceMesh } from '../../lib/cam/holderClearance'
import { ensureClipperReady } from '../../lib/cam/face2d/clipperOffset'
import { computeAdaptive3dMoves, DEFAULT_ADAPTIVE3D_PARAMS } from '../../cam3d/integration/adaptive3dOperation'
import { computeParallel3dMoves, DEFAULT_PARALLEL3D_PARAMS } from '../../cam3d/integration/parallel3dOperation'
import type { PartMesh } from '../../cam3d/kernel/types'
import type { Box3 } from '../../cam3d/stock'
import type { Cam3dClient } from '../../cam3d/worker/client'
import type { IrMove } from '../../cam3d/ir/types'
import { writeSideView, obstacleFromBox, type Band, type PathPoint, type ToolPlacement } from '../helpers/sideViewEvidence'

// ── Geometry ─────────────────────────────────────────────────────────────────

/** [minX, minY, minZ, maxX, maxY, maxZ] */
type Box = readonly [number, number, number, number, number, number]

const JAW: Box = [-4, 11, 0, 4, 30, 20]
const CLAMP_LIP: Box = [-30, 11, 0, 30, 30, 2]
const CLAMP_NOSE: Box = [-4, 11, 12, 4, 30, 17]
const FAR_JAW: Box = [100, 100, 0, 110, 110, 20]
const CUT_Z = 5
const PATH_Y = 13
const ALLOWANCE = 0.25

function meshOf(boxes: readonly Box[]): ClearanceMesh {
  const positions: number[] = []
  const indices: number[] = []
  for (const [x0, y0, z0, x1, y1, z1] of boxes) {
    const base = positions.length / 3
    for (const z of [z0, z1]) for (const y of [y0, y1]) for (const x of [x0, x1]) positions.push(x, y, z)
    const faces = [
      [0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5],
    ]
    for (const [a, b, c, d] of faces) indices.push(base + a, base + b, base + c, base + a, base + c, base + d)
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) }
}

function xyDistanceToBox(x: number, y: number, [x0, y0, , x1, y1]: Box): number {
  return Math.hypot(Math.max(x0 - x, 0, x - x1), Math.max(y0 - y, 0, y - y1))
}

// ── Tool ─────────────────────────────────────────────────────────────────────

const HOLDER: ToolHolder = {
  id: 'holder-1', name: 'ER20 collet chuck',
  segments: [{ height: 40, lowerDiameter: 20, upperDiameter: 20 }],
}

const FLAT_6 = {
  id: 'tool-1', name: '6 mm flat end mill', type: 'flat_end_mill',
  diameter: 6, fluteLength: 20, shankDiameter: 6, overallLength: 60,
  lengthBelowHolder: 40, numberOfFlutes: 2, material: 'carbide', coating: 'none',
  holderId: 'holder-1', notes: '',
  feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 2, stepover: 1.5 } },
} as unknown as Tool

/** The tool as radial bands above its tip: bottom, top, radius, colour, label.
 *  The holder's 1000 mm top is a deliberate stand-in for "keeps going up into
 *  the spindle" - not a measured extent - so the evidence drawer always shows
 *  it clipped, honestly, rather than silently omitted. */
const BANDS: readonly Band[] = [
  [0, 20, 3, '#2e7d32', 'cutter'],
  [20, 40, 3, '#7f8c8d', 'shank'],
  [40, 1000, 10, '#34495e', 'holder'],
]

// ── The 2D worker ────────────────────────────────────────────────────────────

const STOCK_BLOCK: ToolpathStockBlock = { min: { x: -40, y: -40, z: 0 }, max: { x: 40, y: 40, z: 10 } }
const HEIGHTS: HeightParams = {
  clearanceHeight: 30, clearanceHeightMode: 'absolute',
  retractHeight: 25, feedHeight: 22,
  topHeight: CUT_Z + 1, topHeightMode: 'absolute',
  bottomHeight: CUT_Z, bottomHeightMode: 'absolute',
}
const PASSES: PassParams = { stepdown: 5, stepover: 1.5, stockToLeave: 0, finishPasses: 1, springPasses: 0 }
const LINKING: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
}
const BLOCK_LOOP: LoopData = {
  id: 'block', closed: true, type: 'contour',
  points: [{ x: -15, y: -10 }, { x: 15, y: -10 }, { x: 15, y: 10 }, { x: -15, y: 10 }],
}

type WorkerHandler = (event: MessageEvent<WorkerRequestMsg>) => Promise<void> | void
let handler: WorkerHandler | undefined
const posted: WorkerResponseMsg[] = []

beforeAll(async () => {
  await ensureClipperReady()
  ;(globalThis as unknown as Record<string, unknown>).self = {
    set onmessage(fn: WorkerHandler) { handler = fn },
    postMessage: (message: WorkerResponseMsg) => { posted.push(message) },
  }
  await import('../../lib/cam/toolpathWorker')
})

async function contour(reach: ToolReachInputs): Promise<ToolpathCompleteWithNotices> {
  const payload: ContourWorkerPayload & ToolReachInputs = {
    opId: 'op-jaw', setupId: 'setup-1',
    params: { side: 'outer', direction: 'climb', geometryId: 'g', loopIds: [], tabs: false },
    heights: HEIGHTS, passes: PASSES, linking: LINKING,
    tool: FLAT_6, loops: [BLOCK_LOOP], wcsOrigin: { x: 0, y: 0, z: 0 },
    holder: HOLDER, stockBlock: STOCK_BLOCK,
    ...reach,
  }
  posted.length = 0
  await handler!({ data: { type: 'COMPUTE_CONTOUR', payload } } as MessageEvent<WorkerRequestMsg>)
  const terminal = posted.filter((response) => response.type !== 'TOOLPATH_PROGRESS')
  expect(terminal).toHaveLength(1)
  if (terminal[0].type !== 'TOOLPATH_COMPLETE') throw new Error(`expected a toolpath, got ${JSON.stringify(terminal[0])}`)
  return terminal[0] as ToolpathCompleteWithNotices
}

// ── Reading a path ───────────────────────────────────────────────────────────

interface Sample { x: number; y: number; z: number; type: ToolpathMove['type'] }

function samples(moves: readonly ToolpathMove[], step = 0.05): Sample[] {
  const out: Sample[] = []
  for (let i = 1; i < moves.length; i++) {
    const a = moves[i - 1]
    const b = moves[i]
    expect(b.type === 'arc_cw' || b.type === 'arc_ccw', 'the fixtures are polyline-only').toBe(false)
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / step))
    for (let k = 0; k <= n; k++) {
      const t = k / n
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t, type: b.type })
    }
  }
  return out
}

/** Smallest gap between any band of the tool and a box, over every position the
 *  tool passes (rapids included): the XY gap where the band's height range meets
 *  the box's, the Z gap where the band is above or below it and over its footprint. */
function smallestGap(moves: readonly ToolpathMove[], box: Box): number {
  let gap = Number.POSITIVE_INFINITY
  for (const s of samples(moves)) {
    for (const [bottom, top, radius] of BANDS) {
      const xy = xyDistanceToBox(s.x, s.y, box) - radius
      const zBelow = box[2] - (s.z + top)
      const zAbove = (s.z + bottom) - box[5]
      const z = Math.max(zBelow, zAbove)
      gap = Math.min(gap, xy > 0 && z > 0 ? Math.hypot(xy, z) : Math.max(xy, z))
    }
  }
  return gap
}

/** Feed samples at the cut depth along the +Y side, by X. The contour's straight
 *  side ends on points of its corner arcs, so Y along it is 13 only to ~0.005. */
function depthCutXs(moves: readonly ToolpathMove[]): number[] {
  return samples(moves)
    .filter((s) => s.type !== 'rapid' && Math.abs(s.z - CUT_Z) < 1e-6 && Math.abs(s.y - PATH_Y) < 0.01)
    .map((s) => s.x)
}

function stopNotices(notices: readonly string[] | undefined): string[] {
  return (notices ?? []).filter((notice) => notice.includes('left uncut'))
}

function uncutMm(notice: string): number {
  const match = /(\d+\.\d) mm of cutting path was left uncut/.exec(notice)
  expect(match, notice).not.toBeNull()
  return Number(match![1])
}

// ── Evidence (WRITE_EVIDENCE=1 only): side view with the tool drawn ──────────
//
// Looking from -Y at the +Y side of the profile: X across, Z up. The cut path
// drawn is already sliced to the wall (Y within 0.01 of PATH_Y), so there is no
// other Y for a crossing to be at - a genuine single-Y section, not a projection.

function evidenceSideView(dir: string, name: string, title: string, boxes: readonly Box[],
  moves: readonly ToolpathMove[], notices: readonly string[]): void {
  const cut = samples(moves, 0.25).filter((s) => s.type !== 'rapid' && Math.abs(s.y - PATH_Y) < 0.01)
  const path: PathPoint[] = cut.map((s) => ({ x: s.x, y: PATH_Y, z: s.z, kind: 'cut' }))
  // The tool drawn at both stops: the depth cut nearest X 0 on each side.
  const atDepth = cut.filter((s) => Math.abs(s.z - CUT_Z) < 1e-6)
  const left = atDepth.filter((s) => s.x < 0)
  const right = atDepth.filter((s) => s.x > 0)
  const placements: ToolPlacement[] = [
    left.length > 0 ? left.reduce((a, b) => (b.x > a.x ? b : a)) : undefined,
    right.length > 0 ? right.reduce((a, b) => (b.x < a.x ? b : a)) : undefined,
  ].filter((s): s is Sample => s !== undefined).map((s) => ({ x: s.x, tipZ: s.z }))
  writeSideView({
    dir, name, title,
    obstacles: boxes.map((box) => obstacleFromBox(box)),
    path, bands: BANDS, placements,
    captions: notices,
  })
}

// ── 2D: a contour through a jaw ──────────────────────────────────────────────

describe('WO-1575 a contour whose path passes through a 20 mm jaw', () => {
  it('cuts up to the allowance before the jaw, keeps every move clear, picks up beyond it, one line per stop', async () => {
    const before = await contour({ clearanceAllowanceMm: ALLOWANCE })
    expect(smallestGap(before.moves, JAW), 'the fixture path must actually run through the jaw').toBeLessThan(0)
    const after = await contour({ clearanceAllowanceMm: ALLOWANCE, workholding: [meshOf([JAW])] })

    expect(smallestGap(after.moves, JAW)).toBeGreaterThanOrEqual(ALLOWANCE - 1e-6)
    const xs = depthCutXs(after.moves)
    const cutUpTo = Math.max(...xs.filter((x) => x < 0))
    const resumedFrom = Math.min(...xs.filter((x) => x > 0))
    // Cut right up to the allowance on both sides (the grid slack is a few hundredths).
    expect(cutUpTo).toBeGreaterThan(JAW[0] - 3 - ALLOWANCE - 0.15)
    expect(resumedFrom).toBeLessThan(JAW[3] + 3 + ALLOWANCE + 0.15)
    // Cutting on both sides of the jaw, out to where the straight side meets the corners.
    expect(Math.min(...xs)).toBeLessThan(-14.9)
    expect(Math.max(...xs)).toBeGreaterThan(14.9)

    const stops = stopNotices(after.notices)
    expect(stops).toHaveLength(1)
    expect(stops[0]).toMatch(/^Contour: cut stopped at X -?\d+\.\d\d Y -?\d+\.\d\d Z 5\.00 - /)
    expect(stops[0]).toContain('would come within 0.25 mm of the workholding')
    expect(stops[0]).toMatch(/up to X -?\d+\.\d\d Y -?\d+\.\d\d Z 5\.00, where it picks up again/)
    const gapLength = resumedFrom - cutUpTo
    expect(uncutMm(stops[0])).toBeGreaterThan(gapLength - 0.5)
    expect(uncutMm(stops[0])).toBeLessThan(gapLength + 0.5)
    evidenceSideView(join('src', 'tests', 'evidence', 'WO-1575'), 'contour-through-jaw',
      'Contour through a 20 mm jaw - cut stops 0.25 mm short, resumes beyond', [JAW], after.moves, stops)
  })
})

// ── 2D: an overhanging clamp ─────────────────────────────────────────────────

describe('WO-1575 a clamp whose nose overhangs the cut', () => {
  it('holds the lip and the nose as two spans over the same column', () => {
    const clamp = buildSolidColumns(meshOf([CLAMP_LIP, CLAMP_NOSE]))!
    const i = Math.floor((0 - clamp.originX) / clamp.cell)
    const j = Math.floor((PATH_Y - clamp.originY) / clamp.cell)
    const column = j * clamp.nx + i
    const spans = Array.from(clamp.spanZ.subarray(clamp.spanStart[column], clamp.spanStart[column + 1]))
    expect(spans.map((z) => Math.round(z * 1000) / 1000)).toEqual([0, 2, 12, 17])
  })

  it('cuts over the lip and stops only where the tool would pass under the nose', async () => {
    const after = await contour({ clearanceAllowanceMm: ALLOWANCE, workholding: [meshOf([CLAMP_LIP, CLAMP_NOSE])] })

    expect(smallestGap(after.moves, CLAMP_NOSE)).toBeGreaterThanOrEqual(ALLOWANCE - 1e-6)
    expect(smallestGap(after.moves, CLAMP_LIP)).toBeGreaterThanOrEqual(ALLOWANCE - 1e-6)
    const xs = depthCutXs(after.moves)
    // Over the lip the cut runs on; a single solid span from the lip to the nose
    // would have stopped the whole +Y side.
    expect(Math.min(...xs)).toBeLessThan(-14.9)
    expect(Math.max(...xs)).toBeGreaterThan(14.9)
    expect(Math.max(...xs.filter((x) => x < 0))).toBeGreaterThan(CLAMP_NOSE[0] - 3 - ALLOWANCE - 0.15)
    expect(Math.min(...xs.filter((x) => x > 0))).toBeLessThan(CLAMP_NOSE[3] + 3 + ALLOWANCE + 0.15)

    const stops = stopNotices(after.notices)
    expect(stops).toHaveLength(1)
    expect(stops[0]).toContain('of the workholding')
    expect(uncutMm(stops[0])).toBeLessThan(16)
    evidenceSideView(join('src', 'tests', 'evidence', 'WO-1575'), 'contour-under-clamp-nose',
      'Contour under a clamp nose - cuts over the lip, stops at the nose', [CLAMP_LIP, CLAMP_NOSE], after.moves, stops)
  })
})

// ── No workholding, no change ────────────────────────────────────────────────

describe('WO-1575 a request with no workholding', () => {
  it('produces the same moves as without the field, with an empty list, and with a jaw nowhere near', async () => {
    const plain = await contour({ clearanceAllowanceMm: ALLOWANCE })
    const empty = await contour({ clearanceAllowanceMm: ALLOWANCE, workholding: [] })
    const far = await contour({ clearanceAllowanceMm: ALLOWANCE, workholding: [meshOf([FAR_JAW])] })
    expect(stopNotices(plain.notices)).toEqual([])
    expect(empty.moves).toEqual(plain.moves)
    expect(far.moves).toEqual(plain.moves)
    expect(stopNotices(far.notices)).toEqual([])
  })
})

// ── 3D: the same jaw over Adaptive 3D and Parallel 3D ────────────────────────
//
// WO-1678: the 3D strategies carry no reach check of their own. Each returns
// every move it plans; the store trims the result at ONE seam
// (trimToToolReachInPartFrame) with the same function and words as the 2D
// worker. So the adapter's own output runs through the jaw, and the seam's does not.

const STOCK_3D: Box3 = { minX: -40, minY: -40, minZ: 0, maxX: 40, maxY: 40, maxZ: 10 }
const PART_3D: PartMesh = {
  positions: new Float32Array([-30, -30, 0, 30, -30, 0, -30, 30, 10]),
  indices: new Uint32Array([0, 1, 2]),
  bounds: { min: [-30, -30, 0], max: [30, 30, 10] },
  source: 'fixture',
}
/** The part the seam keeps the tool clear of: a slab under the cut, so only the jaw can stop it. */
const SLAB_UNDER_THE_CUT = meshOf([[-30, -30, 0, 30, 30, CUT_Z - 1]])
const IR_MOVES: IrMove[] = [
  { t: 'rapid', x: -20, y: PATH_Y, z: 30, role: 'rapid' },
  { t: 'feed', x: -20, y: PATH_Y, z: CUT_Z, role: 'plunge' },
  { t: 'feed', x: 20, y: PATH_Y, z: CUT_Z, role: 'cut' },
  { t: 'rapid', x: 20, y: PATH_Y, z: 30, role: 'rapid' },
]

async function adaptiveMoves(stickoutMm = 40): Promise<ToolpathMove[]> {
  const result = await computeAdaptive3dMoves({
    partMesh: PART_3D,
    tool: { ...FLAT_6, lengthBelowHolder: stickoutMm },
    params: { ...DEFAULT_ADAPTIVE3D_PARAMS, cellSize: 1 },
    stockBounds: STOCK_3D,
    stockBoundsAreRealStock: true,
    resolvedHeights: { clearanceZ: 30, retractZ: 25, feedZ: 25, topZ: 10, bottomZ: 0 },
    client: {
      generateAdaptiveRough: async () => ({
        ir: { moves: IR_MOVES, meta: { strategyId: 'adaptive_rough', cutterId: 'wo1575', params: { floorZ: CUT_Z } } },
      }),
    } as unknown as Cam3dClient,
  })
  return result.moves
}

async function parallelMoves(stickoutMm = 40): Promise<ToolpathMove[]> {
  const result = await computeParallel3dMoves({
    partMesh: PART_3D,
    tool: { ...FLAT_6, lengthBelowHolder: stickoutMm },
    params: { ...DEFAULT_PARALLEL3D_PARAMS },
    resolvedHeights: { clearanceZ: 30, retractZ: 25, feedZ: 25, topZ: 10, bottomZ: 0, stockTopZ: STOCK_3D.maxZ },
    client: {
      generateParallelFinish: async () => ({ moves: IR_MOVES, meta: { strategyId: 'parallel_finish', cutterId: 'wo1575' } }),
    } as unknown as Cam3dClient,
  })
  return result.moves
}

/** The store's seam, as every 3D compute calls it straight after its strategy. */
function throughTheSeam(label: string, moves: readonly ToolpathMove[], workholding: readonly ClearanceMesh[], stickoutMm = 40) {
  return trimToToolReachInPartFrame({
    operation: label,
    moves,
    tool: { ...FLAT_6, lengthBelowHolder: stickoutMm },
    holder: HOLDER,
    stockBounds: STOCK_3D,
    part: SLAB_UNDER_THE_CUT,
    partToleranceMm: 0.05,
    params: { clearanceAllowanceMm: ALLOWANCE },
    workholding,
    noEarlierOperations: true,
  })
}

describe('WO-1575 Adaptive 3D and Parallel 3D over the same jaw', () => {
  for (const [label, job] of [['Adaptive 3D', adaptiveMoves], ['Parallel 3D', parallelMoves]] as const) {
    it(`${label} trims the program and says where, with no thrown error`, async () => {
      const untouched = await job()
      expect(smallestGap(untouched, JAW)).toBeLessThan(0)
      const result = throughTheSeam(label, untouched, [meshOf([JAW])])

      expect(smallestGap(result.moves, JAW)).toBeGreaterThanOrEqual(ALLOWANCE - 1e-6)
      const xs = depthCutXs(result.moves)
      expect(Math.min(...xs)).toBeLessThan(-19)
      expect(Math.max(...xs)).toBeGreaterThan(19)
      expect(Math.max(...xs.filter((x) => x < 0))).toBeGreaterThan(JAW[0] - 3 - ALLOWANCE - 0.15)
      expect(Math.min(...xs.filter((x) => x > 0))).toBeLessThan(JAW[3] + 3 + ALLOWANCE + 0.15)
      const stops = stopNotices(result.notices)
      expect(stops).toHaveLength(1)
      expect(stops[0].startsWith(`${label}: cut stopped at X `)).toBe(true)
      expect(stops[0]).toContain('of the workholding')
      expect(uncutMm(stops[0])).toBeGreaterThan(14)
      expect(uncutMm(stops[0])).toBeLessThan(15.5)
    })

    it(`${label} trims a holder that would hit the stock instead of refusing`, async () => {
      // A 5 mm stickout: the strategy itself never refuses, and the seam trims.
      const moves = await job(5)
      expect(moves.length).toBe(IR_MOVES.length)
      const result = throughTheSeam(label, moves, [meshOf([JAW])], 5)
      const stops = stopNotices(result.notices)
      expect(stops.length).toBeGreaterThan(0)
      expect(stops.join('\n')).toContain('holder')
    })
  }
})
