// WO-1577: rapids and links go OVER the workholding, never through it.
//
// WO-1575 stopped the CUT short of a jaw. The moves that are not cutting - the
// rapid between two features, the link between two trimmed stretches, the
// re-entry after a stop, a cam3d stay-down link - were still routed at the
// program's own retract/clearance height, and a jaw taller than that height
// stands straight through them. This order raises those moves over the jaw by
// the same allowance, using the SAME obstacle columns as the trim.
//
// Everything here is measured from plain box geometry computed in this file,
// never from the module's own column grid, and the 2D cases drive the REAL
// worker entry point (self.onmessage). The console lines are read from real
// console spies, not from a return value invented for the test.
//
// FIXTURES. The tall jaw is 40 mm tall - ABOVE the operation's 25 mm retract and
// its 30 mm clearance height - which is exactly the case the old code got wrong.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { HeightParams, LinkingParams, PassParams, Tool, ToolHolder, ToolpathMove } from '../../types'
import type {
  ContourWorkerPayload, DrillWorkerPayload, LoopData, ToolpathStockBlock, WorkerRequestMsg, WorkerResponseMsg,
} from '../../lib/cam/types'
import type { ToolReachInputs } from '../../lib/cam/holderClearanceGate'
import type { ToolpathCompleteWithNotices } from '../../lib/cam/toolpathWorker'
import { buildSolidColumns, type ClearanceMesh } from '../../lib/cam/holderClearance'
import { ensureClipperReady } from '../../lib/cam/face2d/clipperOffset'
import { enforceTraverseSafety } from '../../cam3d/rough/traverseSafety'
import { ZDexelField, removeSweep, type Box3 } from '../../cam3d/stock'
import type { CutterSpec } from '../../cam3d/kernel/types'
import type { IrMove } from '../../cam3d/ir/types'
import { writeSideView, obstacleFromBox, type Band, type PathPoint, type ToolPlacement } from '../helpers/sideViewEvidence'

// ── Geometry ─────────────────────────────────────────────────────────────────

/** [minX, minY, minZ, maxX, maxY, maxZ] */
type Box = readonly [number, number, number, number, number, number]

/** Taller than the 25 mm retract AND the 30 mm clearance height. */
const TALL_JAW: Box = [-4, 11, 0, 4, 30, 40]
/** The same jaw laid across the middle of the table, between two drilled holes. */
const DRILL_JAW: Box = [-4, -30, 0, 4, 30, 40]
const FAR_JAW: Box = [200, 200, 0, 210, 210, 40]
const CUT_Z = 5
const ALLOWANCE = 0.25
const RETRACT_Z = 25
const CLEARANCE_Z = 30

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
  clearanceHeight: CLEARANCE_Z, clearanceHeightMode: 'absolute',
  retractHeight: RETRACT_Z, feedHeight: 22,
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

/** Square loops whose centroids are the drill centres, either side of the jaw. */
const HOLE_X = 16
function holeLoop(id: string, cx: number, cy: number): LoopData {
  return {
    id, closed: true, type: 'contour',
    points: [
      { x: cx - 2, y: cy - 2 }, { x: cx + 2, y: cy - 2 },
      { x: cx + 2, y: cy + 2 }, { x: cx - 2, y: cy + 2 },
    ],
  }
}
const HOLE_LEFT = holeLoop('hole-left', -HOLE_X, 0)
const HOLE_RIGHT = holeLoop('hole-right', HOLE_X, 0)

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

// Every console line this order claims is read off a real spy, so a claim that
// "the console says so" cannot pass on a value the test made up.
let consoleLines: string[] = []
beforeEach(() => {
  consoleLines = []
  const record = (...args: unknown[]) => { consoleLines.push(args.map(String).join(' ')) }
  vi.spyOn(console, 'info').mockImplementation(record)
  vi.spyOn(console, 'warn').mockImplementation(record)
})
afterEach(() => { vi.restoreAllMocks() })

function raiseLines(): string[] {
  return consoleLines.filter((line) => line.includes('raised') && line.includes('workholding'))
}

async function compute(type: 'COMPUTE_CONTOUR' | 'COMPUTE_DRILL', payload: object): Promise<ToolpathCompleteWithNotices> {
  posted.length = 0
  await handler!({ data: { type, payload } } as MessageEvent<WorkerRequestMsg>)
  const terminal = posted.filter((response) => response.type !== 'TOOLPATH_PROGRESS')
  expect(terminal).toHaveLength(1)
  if (terminal[0].type !== 'TOOLPATH_COMPLETE') throw new Error(`expected a toolpath, got ${JSON.stringify(terminal[0])}`)
  return terminal[0] as ToolpathCompleteWithNotices
}

async function contour(reach: ToolReachInputs): Promise<ToolpathCompleteWithNotices> {
  const payload: ContourWorkerPayload & ToolReachInputs = {
    opId: 'op-contour', setupId: 'setup-1',
    params: { side: 'outer', direction: 'climb', geometryId: 'g', loopIds: [], tabs: false },
    heights: HEIGHTS, passes: PASSES, linking: LINKING,
    tool: FLAT_6, loops: [BLOCK_LOOP], wcsOrigin: { x: 0, y: 0, z: 0 },
    holder: HOLDER, stockBlock: STOCK_BLOCK,
    ...reach,
  }
  return compute('COMPUTE_CONTOUR', payload)
}

async function drill(reach: ToolReachInputs): Promise<ToolpathCompleteWithNotices> {
  const payload: DrillWorkerPayload & ToolReachInputs = {
    opId: 'op-drill', setupId: 'setup-1',
    params: {
      geometryId: 'g', loopIds: ['hole-left', 'hole-right'], cycleType: 'simple',
      peckDepth: 2, chipBreakRetract: 0.5, dwell: 0,
      // Between-hole rapids ride the RETRACT height - the one the jaw is taller than.
      retractMode: 'retract', sortStrategy: 'none',
    },
    heights: { ...HEIGHTS, bottomHeight: 0 },
    passes: PASSES, linking: LINKING,
    tool: FLAT_6, loops: [HOLE_LEFT, HOLE_RIGHT], wcsOrigin: { x: 0, y: 0, z: 0 },
    holder: HOLDER, stockBlock: STOCK_BLOCK,
    ...reach,
  }
  return compute('COMPUTE_DRILL', payload)
}

// ── Reading a path ───────────────────────────────────────────────────────────

interface Sample { x: number; y: number; z: number; type: ToolpathMove['type']; role?: ToolpathMove['role'] }

function samples(moves: readonly ToolpathMove[], step = 0.05): Sample[] {
  const out: Sample[] = []
  for (let i = 1; i < moves.length; i++) {
    const a = moves[i - 1]
    const b = moves[i]
    expect(b.type === 'arc_cw' || b.type === 'arc_ccw', 'the fixtures are polyline-only').toBe(false)
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / step))
    for (let k = 0; k <= n; k++) {
      const t = k / n
      out.push({
        x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t,
        type: b.type, role: b.role,
      })
    }
  }
  return out
}

/** Smallest gap between any band of the tool and a box, over every position the
 *  tool passes (rapids included). Negative = the tool is inside the box. */
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

/** The lowest tool tip Z of any NON-CUTTING sample whose cutter footprint stands
 *  over the box in XY: what "the rapid went over the jaw" actually means. */
function lowestTraverseTipOver(moves: readonly ToolpathMove[], box: Box): number {
  let lowest = Number.POSITIVE_INFINITY
  for (const s of samples(moves)) {
    if (s.type !== 'rapid' && s.role !== 'rapid') continue
    if (xyDistanceToBox(s.x, s.y, box) > BANDS[0][2]) continue
    lowest = Math.min(lowest, s.z)
  }
  return lowest
}

function stopNotices(notices: readonly string[] | undefined): string[] {
  return (notices ?? []).filter((notice) => notice.includes('left uncut'))
}

// ── 1. A rapid between two features crosses a jaw taller than the retract ─────

describe('WO-1577 two drilled holes either side of a jaw taller than the retract height', () => {
  it('raises every rapid over the jaw top plus the allowance and says so on the console', async () => {
    const before = await drill({ clearanceAllowanceMm: ALLOWANCE })
    expect(
      lowestTraverseTipOver(before.moves, DRILL_JAW),
      'the fixture must actually rapid across the jaw at the retract height',
    ).toBeLessThanOrEqual(RETRACT_Z + 1e-9)
    expect(smallestGap(before.moves, DRILL_JAW), 'and that rapid must be inside the jaw').toBeLessThan(0)

    const after = await drill({ clearanceAllowanceMm: ALLOWANCE, workholding: [meshOf([DRILL_JAW])] })

    // Nothing of the tool - cutter, shank or holder - comes within the allowance.
    expect(smallestGap(after.moves, DRILL_JAW)).toBeGreaterThanOrEqual(ALLOWANCE - 1e-6)
    // Every rapid standing over the jaw is above its top plus the allowance.
    expect(lowestTraverseTipOver(after.moves, DRILL_JAW)).toBeGreaterThanOrEqual(DRILL_JAW[5] + ALLOWANCE)
    // Both holes are still drilled to depth: nothing was refused.
    for (const x of [-HOLE_X, HOLE_X]) {
      expect(
        after.moves.some((m) => Math.abs(m.x - x) < 1e-6 && Math.abs(m.z - 0) < 1e-6 && m.type !== 'rapid'),
        `hole at X ${x} still reaches its bottom`,
      ).toBe(true)
    }

    const said = raiseLines()
    expect(said.length).toBeGreaterThan(0)
    expect(said[0]).toContain('to pass over the workholding')
    expect(said[0]).toMatch(/raised to Z 4\d\.\d\d/)
  })
})

// ── 2. The link and re-entry around a stop the trim made ─────────────────────

describe('WO-1577 a contour trimmed at a jaw taller than the retract height', () => {
  it('links from the stop to the resume point over the jaw, and re-enters by feeding down', async () => {
    const jaw = [meshOf([TALL_JAW])]
    const before = await contour({ clearanceAllowanceMm: ALLOWANCE })
    expect(smallestGap(before.moves, TALL_JAW), 'the fixture path must run through the jaw').toBeLessThan(0)

    const after = await contour({ clearanceAllowanceMm: ALLOWANCE, workholding: jaw })

    // The trim still stopped the cut (WO-1575), and now the link clears the jaw.
    const stops = stopNotices(after.notices)
    expect(stops).toHaveLength(1)
    expect(smallestGap(after.moves, TALL_JAW)).toBeGreaterThanOrEqual(ALLOWANCE - 1e-6)
    expect(lowestTraverseTipOver(after.moves, TALL_JAW)).toBeGreaterThanOrEqual(TALL_JAW[5] + ALLOWANCE)

    // The retract off the stop and the re-entry both ride above the jaw, not the
    // 30 mm clearance height the program asked for.
    const linkZ = Math.max(...after.moves.filter((m) => m.type === 'rapid').map((m) => m.z))
    expect(linkZ).toBeGreaterThanOrEqual(TALL_JAW[5] + ALLOWANCE)
    expect(after.moves.filter((m) => m.type === 'rapid' && Math.abs(m.z - linkZ) < 1e-9).length)
      .toBeGreaterThanOrEqual(2)

    // Rule 11 and the acceptance: the raise is SAID, on the app console beside
    // the stop it belongs to, not only in a return value.
    expect((after.notices ?? []).some((n) => /raised to Z .* to pass over the workholding/.test(n))).toBe(true)
    expect(raiseLines().length).toBeGreaterThan(0)
  })

  it('never rapids down into the cut: the re-entry descent is a feed plunge from the link height', async () => {
    const after = await contour({ clearanceAllowanceMm: ALLOWANCE, workholding: [meshOf([TALL_JAW])] })
    const linkZ = Math.max(...after.moves.filter((m) => m.type === 'rapid').map((m) => m.z))

    // Every move that leaves the link height downward is a FEED plunge. A rapid
    // descending out of the link is what would drive into stock the program has
    // not removed yet; there is none.
    let reEntries = 0
    for (let i = 1; i < after.moves.length; i++) {
      const from = after.moves[i - 1]
      const move = after.moves[i]
      if (Math.abs(from.z - linkZ) > 1e-9 || move.z >= from.z - 1e-9) continue
      reEntries++
      expect(move.type, 'the descent out of a raised link is a feed').toBe('feed')
      expect(move.role, 'and it is the plunge the entry logic already uses').toBe('plunge')
      // Straight down, at the XY the link landed on.
      expect(Math.abs(move.x - from.x)).toBeLessThan(1e-9)
      expect(Math.abs(move.y - from.y)).toBeLessThan(1e-9)
    }
    expect(reEntries, 'a trimmed contour re-enters at least once').toBeGreaterThan(0)

    // ... and the shank and the holder stay out of the stock the whole way down.
    // Stock as loaded is the 10 mm block; only the cutting head may be in it.
    const descents = samples(after.moves).filter((s) => s.role === 'plunge')
    expect(descents.length).toBeGreaterThan(0)
    for (const s of descents) {
      for (const [bottom, , radius] of BANDS.slice(1)) {
        if (radius <= BANDS[0][2]) continue
        expect(s.z + bottom, 'no shank or holder inside the remaining stock').toBeGreaterThanOrEqual(
          STOCK_BLOCK.max.z - 1e-6)
      }
    }
  })
})

// ── 3. A program with no workholding is unchanged ────────────────────────────

describe('WO-1577 a program with no workholding', () => {
  it('produces the same moves with no field, an empty list, and a jaw nowhere near', async () => {
    const plain = await contour({ clearanceAllowanceMm: ALLOWANCE })
    const empty = await contour({ clearanceAllowanceMm: ALLOWANCE, workholding: [] })
    const far = await contour({ clearanceAllowanceMm: ALLOWANCE, workholding: [meshOf([FAR_JAW])] })
    expect(empty.moves).toEqual(plain.moves)
    expect(far.moves).toEqual(plain.moves)
    expect(raiseLines()).toEqual([])

    const plainDrill = await drill({ clearanceAllowanceMm: ALLOWANCE })
    const farDrill = await drill({ clearanceAllowanceMm: ALLOWANCE, workholding: [meshOf([FAR_JAW])] })
    expect(farDrill.moves).toEqual(plainDrill.moves)
  })
})

// ── 4. cam3d stay-down links ─────────────────────────────────────────────────

const CAM3D_CUTTER: CutterSpec = { kind: 'flat', diameter: 6 }

/** Every point the cam3d tip passes through, endpoints included. */
function sampleIr(moves: readonly IrMove[], step = 0.05): { x: number; y: number; z: number }[] {
  const out: { x: number; y: number; z: number }[] = []
  for (let i = 1; i < moves.length; i++) {
    const a = moves[i - 1]
    const b = moves[i]
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / step))
    for (let k = 0; k <= n; k++) {
      const t = k / n
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t })
    }
  }
  return out
}
/** A jaw 40 mm tall, taller than the cam3d operation's 12 mm clearance plane. */
const CAM3D_JAW: Box = [-2, -20, 0, 2, 20, 40]

const CAM3D_BLOCK: Box3 = { minX: -30, minY: -30, minZ: 0, maxX: 30, maxY: 30, maxZ: 5 }

/** The block with the link's own corridor already milled to the floor, so the
 *  stock field PROVES the low link clear - the case where only the jaw is left
 *  to stop it. */
function provenField(): ZDexelField {
  const field = ZDexelField.fromBox(CAM3D_BLOCK, 0.5)
  removeSweep(field, { x0: -28, y0: 0, z0: 5, x1: 28, y1: 0, z1: 5 }, CAM3D_CUTTER)
  return field
}

describe('WO-1577 a cam3d stay-down link that would cross a jaw', () => {
  const FLOOR = 5
  const CLEARANCE = 12
  const lowLink: readonly IrMove[] = [
    { t: 'rapid', x: -20, y: 0, z: FLOOR + 1, role: 'rapid' },
    { t: 'rapid', x: 20, y: 0, z: FLOOR + 1, role: 'rapid' },
  ]

  it('routes the link over the jaw, not over the clearance plane the jaw is taller than', () => {
    const workholding = [buildSolidColumns(meshOf([CAM3D_JAW]))!]
    const result = enforceTraverseSafety(lowLink, {
      stock: provenField(), cutter: CAM3D_CUTTER, clearanceZ: CLEARANCE, materialTopZ: FLOOR,
      stockProven: true, initialTip: null, workholding, workholdingAllowanceMm: ALLOWANCE,
    })

    expect(result.report.raisedOverWorkholding).toBe(1)
    // Every position ALONG the emitted path whose cutter stands over the jaw is
    // above its top plus the allowance - the endpoints alone prove nothing, the
    // leg between them is what used to run through the jaw.
    const over = sampleIr(result.moves).filter((p) => xyDistanceToBox(p.x, p.y, CAM3D_JAW) <= 3)
    expect(over.length).toBeGreaterThan(0)
    for (const point of over) {
      expect(point.z).toBeGreaterThanOrEqual(CAM3D_JAW[5] + ALLOWANCE)
    }
    // It still arrives where it was going.
    const last = result.moves[result.moves.length - 1]
    expect(last.x).toBe(20)
    expect(last.y).toBe(0)
    expect(last.z).toBe(FLOOR + 1)
    expect(raiseLines().length).toBeGreaterThan(0)
  })

  it('leaves a link with no workholding exactly as it was', () => {
    const without = enforceTraverseSafety(lowLink, {
      stock: provenField(), cutter: CAM3D_CUTTER, clearanceZ: CLEARANCE, materialTopZ: FLOOR,
      stockProven: true, initialTip: null,
    })
    const far = enforceTraverseSafety(lowLink, {
      stock: provenField(), cutter: CAM3D_CUTTER, clearanceZ: CLEARANCE, materialTopZ: FLOOR,
      stockProven: true, initialTip: null,
      workholding: [buildSolidColumns(meshOf([FAR_JAW]))!], workholdingAllowanceMm: ALLOWANCE,
    })
    expect(far.moves).toEqual(without.moves)
    expect(far.report.raisedOverWorkholding).toBe(0)
    expect(raiseLines()).toEqual([])
  })
})

// ── Evidence (WRITE_EVIDENCE=1 only): the side view Operator reads ───────────────
//
// Looking from -Y: X across, Z up. Blue = cutting, purple = a feed plunge down to
// the cut (it only cuts once it is inside stock), orange = a rapid, link or re-entry.
// The dashed grey line is the height the program asked its rapids to travel at;
// the jaw drawn in red is taller than it, which is the whole of this order. Every
// move is drawn regardless of its Y, so a crossing at a different Y than the jaw
// (a projection artefact, not contact) is ghosted by the shared drawer, not hidden.

function toPathPoints(moves: readonly ToolpathMove[]): PathPoint[] {
  return samples(moves, 0.2).map((s) => ({
    x: s.x, y: s.y, z: s.z,
    kind: (s.type === 'rapid' || s.role === 'rapid' ? 'traverse' : s.role === 'plunge' ? 'plunge' : 'cut') as PathPoint['kind'],
  }))
}

/** The tool position to draw: where the raised rapid/link crosses the middle of
 *  the jaw - the one position the old program used to put inside it. */
function raisedPlacement(moves: readonly ToolpathMove[], box: Box): ToolPlacement {
  const jawMidX = (box[0] + box[3]) / 2
  const top = samples(moves, 0.2)
    .filter((s) => s.type === 'rapid' || s.role === 'rapid')
    .reduce((a, b) => (b.z > a.z + 1e-9 || (Math.abs(b.z - a.z) < 1e-9 &&
      Math.abs(b.x - jawMidX) < Math.abs(a.x - jawMidX)) ? b : a))
  return { x: top.x, tipZ: top.z }
}

describe('WO-1577 evidence', () => {
  it('draws the side view of a raised rapid and of a raised link', async () => {
    const dir = join('src', 'tests', 'evidence', 'WO-1577')
    const drilled = await drill({ clearanceAllowanceMm: ALLOWANCE, workholding: [meshOf([DRILL_JAW])] })
    const rapidPlacement = raisedPlacement(drilled.moves, DRILL_JAW)
    writeSideView({
      dir, name: 'rapid-over-jaw', title: 'Two holes either side of a 40 mm jaw',
      obstacles: [obstacleFromBox(DRILL_JAW)],
      path: toPathPoints(drilled.moves),
      bands: BANDS,
      placements: [rapidPlacement],
      referenceLines: [{ z: RETRACT_Z, label: `retract Z ${RETRACT_Z} - inside the jaw` }],
      captions: [`the raised rapid travels at Z ${rapidPlacement.tipZ.toFixed(2)}`, ...raiseLines()],
    })

    consoleLines = []
    const trimmed = await contour({ clearanceAllowanceMm: ALLOWANCE, workholding: [meshOf([TALL_JAW])] })
    const linkPlacement = raisedPlacement(trimmed.moves, TALL_JAW)
    writeSideView({
      dir, name: 'link-over-jaw', title: 'Contour stopped at a 40 mm jaw: the link goes over it',
      obstacles: [obstacleFromBox(TALL_JAW)],
      path: toPathPoints(trimmed.moves),
      bands: BANDS,
      placements: [linkPlacement],
      referenceLines: [{ z: CLEARANCE_Z, label: `clearance Z ${CLEARANCE_Z} - inside the jaw` }],
      captions: [`the raised link travels at Z ${linkPlacement.tipZ.toFixed(2)}`,
        ...stopNotices(trimmed.notices), ...raiseLines()],
    })
    const wrote = process.env.WRITE_EVIDENCE === '1'
    expect(!wrote || existsSync(join(dir, 'rapid-over-jaw.svg'))).toBe(true)
    expect(!wrote || existsSync(join(dir, 'link-over-jaw.svg'))).toBe(true)
  })
})
