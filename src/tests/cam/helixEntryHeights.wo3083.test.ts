// WO-3083: helix, ramp and plunge entries start just above the material - one rule for every
// operation. The owner, 2026-10-23 release review (example 04, Chamfer 3): "chamfer start height
// helix entry is really heigh as well ... This is a common theme across several operations";
// and (Drill 1): "We don't need to go that high unless a reposition move would go over a clamp".
// Rule 1: every entry starts ENTRY_CLEARANCE_MM (Pocket's 1 mm) above the material it meets.
// Rule 2: hops between the features of one operation cross at Retract, not Clearance.
// Production route: planChain (the store's computeOperationToolpath) on the shipped examples.
// The BEFORE measurement is the architect's audit, src/tests/evidence/WO-3083/results.jsonl.
import { beforeAll, describe, expect, it } from 'vitest'
import type { HeightParams, LinkingParams, Operation, Tool, ToolpathMove } from '../../types'
import type { ContourParams, ContourWorkerPayload, DrillParams, DrillWorkerPayload, FaceParams, FaceWorkerPayload, LoopData } from '../../lib/cam/types'
import type { StockState } from '../../lib/cam/stockState'
import { buildDrillToolpath } from '../../lib/cam/drill2d'
import { buildContourToolpath } from '../../lib/cam/contour2d'
import { buildFaceToolpath } from '../../lib/cam/face2d'
import { ensureClipperReady } from '../../lib/cam/face2d/clipperOffset'
import { entryStartAlong, hopTo } from '../../lib/cam/moves'
import { reconstructDrillCycles } from '../../lib/post/cannedCycle'
import { emitProgram } from '../../lib/post/emit'
import { UCCNC_CONFIG } from '../../lib/post/dialects/uccnc'
import { resolveCoolant, resolveSpindle } from '../../lib/post/resolve'
import type { PostInput } from '../../lib/post/types'
import { resolveFeedrates } from '../../lib/cam/feedrates'
import { trimToolpathToToolReach } from '../../lib/cam/holderClearanceGate'
import type { ClearanceMesh } from '../../lib/cam/holderClearance'
import { readGcodeProgram } from '../../lib/gcode/reader'
import { makeMachine, makeTool, makeWcs } from '../post/helpers'
import { planChain, type PlannedChain } from '../benchmark/chainRunner'
import { alpha3Chains, type BenchmarkChain } from '../benchmark/registry'

const TOL = 0.01

/** Expected per op (resolved Top and Retract from the audit; both unchanged by this order). */
interface Case {
  op: string
  top: number
  retract: number
  /** 'top+1': every entry starts at Top + 1. 'first': the first does (later levels stay down).
   *  'atMost': no entry starts above Top + 1. */
  entry: 'top+1' | 'first' | 'atMost'
  /** Every hop between two features of the op crosses at Retract. */
  hopsAtRetract: boolean
  /** The first helix begins at Top + 1 (WO-3077: it began AT Top after a fed plunge). */
  firstHelixAtTopPlus1?: boolean
}

const CHAINS: { chain: string; cases: Case[] }[] = [
  { chain: 'ex04-tool-storage-bar-declared', cases: [
    { op: 'Drill 1', top: 0, retract: 5, entry: 'top+1', hopsAtRetract: true },
    { op: 'Bore 2', top: 0, retract: 5, entry: 'top+1', hopsAtRetract: true },
    { op: 'Chamfer 3', top: 0, retract: 5, entry: 'top+1', hopsAtRetract: true },
  ] },
  { chain: 'ex01-fixture-plate-declared', cases: [
    { op: 'Face 1', top: 0, retract: 5, entry: 'top+1', hopsAtRetract: true },
    { op: 'Drill 2', top: -0.5, retract: 5, entry: 'top+1', hopsAtRetract: true },
    { op: 'Thread Mill 3', top: -0.5, retract: 5, entry: 'atMost', hopsAtRetract: true },
    { op: 'Contour 4', top: -0.5, retract: 5, entry: 'top+1', hopsAtRetract: true },
    { op: 'Chamfer 5', top: -0.5, retract: 5, entry: 'top+1', hopsAtRetract: true },
  ] },
  { chain: 'ex08-gear-pair-declared', cases: [
    { op: 'Bore 1', top: 0, retract: 5, entry: 'top+1', hopsAtRetract: true },
    { op: 'Contour 3', top: 0, retract: 5, entry: 'top+1', hopsAtRetract: true },
  ] },
  { chain: 'ex03-soft-jaws-declared', cases: [
    // Pocket already followed the rule (WO-1972): unchanged. Its later levels stay down.
    { op: 'Pocket 2', top: -0.5, retract: 5, entry: 'first', hopsAtRetract: false },
  ] },
  { chain: 'ex05-name-sign-declared', cases: [
    { op: 'V-carve 1', top: 0, retract: 5, entry: 'top+1', hopsAtRetract: true },
  ] },
  { chain: 'ex07-relief-medallion-declared', cases: [
    // 3D rough: the first entry follows the rule; later re-entries keep the carved-stock
    // authority (contact + 0.05).
    { op: '3D Rough 2', top: 0, retract: 5, entry: 'first', hopsAtRetract: false },
  ] },
  { chain: 'engagement-pocket-adaptive_clearing_2d-declared', cases: [
    { op: 'adaptive_clearing_2d', top: 16, retract: 18, entry: 'first', hopsAtRetract: false, firstHelixAtTopPlus1: true },
  ] },
]

const isTraverse = (m: ToolpathMove) => m.type === 'rapid' || m.role === 'rapid'

export interface EntryReport {
  /** Z each entry starts feeding from (the last traverse before a feature's first cut). */
  startZs: number[]
  /** Z of every XY traverse between the op's first entry and its last cut. */
  hopZs: number[]
  /** Seconds of feed spent wholly above the material top. */
  airSec: number
}

export function entryReport(moves: readonly ToolpathMove[], top: number): EntryReport {
  const startZs: number[] = []
  const hopZs: number[] = []
  let hopped = true
  let airSec = 0
  let lastCut = -1
  moves.forEach((m, i) => { if (!isTraverse(m)) lastCut = i })
  let firstEntry = -1
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i]
    const prev = moves[i - 1]
    if (isTraverse(m)) {
      if (prev && Math.hypot(m.x - prev.x, m.y - prev.y) > 1e-6) {
        hopped = true
        if (firstEntry >= 0 && i < lastCut) hopZs.push(Math.max(m.z, prev.z))
      }
      continue
    }
    if (hopped && prev) {
      startZs.push(prev.z)
      if (firstEntry < 0) firstEntry = i
    }
    hopped = false
    if (prev && m.type === 'feed' && Math.min(m.z, prev.z) > top + 1e-6 && (m.feed ?? 0) > 0) {
      airSec += Math.hypot(m.x - prev.x, m.y - prev.y, m.z - prev.z) / m.feed! * 60
    }
  }
  return { startZs, hopZs, airSec }
}

function chainOf(id: string): BenchmarkChain {
  const chain = alpha3Chains().find(c => c.id === id)
  if (!chain) throw new Error(`no chain ${id}`)
  return chain
}

const plans = new Map<string, Promise<PlannedChain>>()
/** One production plan per chain for the whole file (the drill post row reuses ex04's). */
function plannedOf(id: string): Promise<PlannedChain> {
  let plan = plans.get(id)
  if (!plan) { plan = planChain(chainOf(id)); plans.set(id, plan) }
  return plan
}

describe('WO-3083 every entry starts just above the material, hops at Retract', () => {
  for (const { chain: id, cases } of CHAINS) {
    it(`${id}: ${cases.map(c => c.op).join(', ')}`, async () => {
      const chain = chainOf(id)
      const planned: PlannedChain = await plannedOf(id)
      const failures: string[] = []
      for (const c of cases) {
        // The registry runs each op with its library tool variants; the first that computes is
        // the row the audit measured.
        const idx = chain.steps.findIndex((s, i) => (s.authoredOperation?.name ?? s.id) === c.op && planned.steps[i].status === 'ready')
        expect(idx, `${id} computes ${c.op}`).toBeGreaterThanOrEqual(0)
        const step = planned.steps[idx]
        // Moves are in the world frame; the expectations are in the setup's WCS.
        const wcsZ = step.sourceWcsOrigin?.z ?? 0
        const r = entryReport(step.moves.map(m => ({ ...m, z: m.z - wcsZ })), c.top)
        console.log(`WO-3083 ${id} | ${c.op} | entries ${r.startZs.length} start Z ${[...new Set(r.startZs.map(z => +z.toFixed(3)))].join(',')}` +
          ` | hops ${[...new Set(r.hopZs.map(z => +z.toFixed(3)))].join(',')} | air s ${r.airSec.toFixed(1)} | cut time s ${((step.cutTimeMs ?? 0) / 1000).toFixed(1)}`)
        expect(r.startZs.length, `${c.op} has entries`).toBeGreaterThan(0)
        for (const z of c.entry === 'first' ? r.startZs.slice(0, 1) : r.startZs) {
          if (c.entry !== 'atMost' ? Math.abs(z - (c.top + 1)) > TOL : z > c.top + 1 + TOL) {
            failures.push(`${c.op}: entry starts at ${z.toFixed(3)}, want ${c.entry === 'top+1' ? '' : '<= '}${c.top + 1}`)
          }
        }
        if (c.firstHelixAtTopPlus1) {
          const moves = step.moves.map(m => ({ ...m, z: m.z - wcsZ }))
          const k = moves.findIndex(m => m.role === 'helix')
          const from = k > 0 ? moves[k - 1].z : NaN
          if (!(Math.abs(from - (c.top + 1)) <= TOL)) failures.push(`${c.op}: first helix starts at ${from.toFixed(3)}, want ${c.top + 1}`)
        }
        if (c.hopsAtRetract) {
          for (const z of r.hopZs) {
            if (Math.abs(z - c.retract) > TOL) failures.push(`${c.op}: hop at ${z.toFixed(3)}, want Retract ${c.retract}`)
          }
        }
      }
      expect([...new Set(failures)]).toEqual([])
    }, 900_000)
  }
})

// -- Attempt 2: the routes the audit found the example rows could not reach --------------------
// Drill G99, multi-loop / multi-depth contour hops, face level changes, and the two helper
// boundaries (an entry above Retract; material standing between two path vertices).

describe('WO-3083 attempt 2: hop routes and helper boundaries', () => {
  beforeAll(async () => { await ensureClipperReady() })

  const flat6 = {
    id: 't6', name: 'O6 flat', type: 'flat_end_mill',
    diameter: 6, fluteLength: 20, shankDiameter: 6, overallLength: 60,
    numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
    feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 2, stepover: 3 } },
  } as Tool
  const heights = (bottom: number): HeightParams => ({
    clearanceHeight: 15, clearanceHeightMode: 'absolute',
    retractHeight: 5, feedHeight: 5,
    topHeight: 0, topHeightMode: 'absolute',
    bottomHeight: bottom, bottomHeightMode: 'absolute',
  })
  const linking: LinkingParams = {
    entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
    retractType: 'full', transitionType: 'safe_height',
  }
  const square = (id: string, x0: number, size: number): LoopData => ({
    id, closed: true, type: 'contour',
    points: [{ x: x0, y: 0 }, { x: x0 + size, y: 0 }, { x: x0 + size, y: size }, { x: x0, y: size }],
  })
  /** No traverse climbs or drops while it moves in XY. */
  const levelHops = (moves: readonly ToolpathMove[]) => {
    for (let i = 1; i < moves.length; i++) {
      const m = moves[i], p = moves[i - 1]
      if (m.type === 'rapid' && Math.hypot(m.x - p.x, m.y - p.y) > 1e-6) expect(m.z, `rapid ${i}`).toBeCloseTo(p.z, 9)
    }
  }

  function drill(retractMode: DrillParams['retractMode']) {
    const params: DrillParams = {
      geometryId: 'g', loopIds: [], cycleType: 'simple', peckDepth: 2, chipBreakRetract: 0.5, dwell: 0,
      retractMode, sortStrategy: 'none',
    }
    const payload: DrillWorkerPayload = {
      opId: 'op', setupId: 'su', params, heights: heights(-10),
      passes: { stepdown: 2, stepover: 1, stockToLeave: 0, finishPasses: 0, springPasses: 0 }, linking,
      tool: { ...flat6, type: 'drill' } as Tool, loops: [square('h1', -2, 4), square('h2', 28, 4)],
      wcsOrigin: { x: 0, y: 0, z: 0 },
    }
    const moves = buildDrillToolpath(payload)
    const recon = reconstructDrillCycles({ id: 'op', type: 'drill', params } as unknown as Operation, moves)
    if (!recon.ok) throw new Error(recon.message)
    // The stream's hop to the second hole: the traverse that arrives over it.
    const k = moves.findIndex((m, i) => i > 0 && m.type === 'rapid' && Math.abs(m.x - 30) < 1e-9 && Math.abs(moves[i - 1].x - 30) > 1e-9)
    return { program: recon.program, hopZ: Math.max(moves[k].z, moves[k - 1].z) }
  }

  it('drill G99 (retract mode): R stays the Feed plane, so at default heights the stream hops where the native cycle returns', () => {
    const { program, hopZ } = drill('retract')
    expect(program.returnMode).toBe('G99')
    // G99 returns to R between holes; a stream hopping at Retract over an R of Top + 1 showed
    // the operator a hop 4 mm above the one the machine makes. Feed = Retract = 5 here.
    expect(program.rPlaneZ).toBeCloseTo(5, 9)
    expect(hopZ).toBeCloseTo(program.rPlaneZ, 9)
  })

  it('drill G98 (clearance mode): R just above the material, the hop where G98 returns', () => {
    const { program, hopZ } = drill('clearance')
    expect(program.returnMode).toBe('G98')
    expect(program.rPlaneZ).toBeCloseTo(1, 9)
    // WO-3083 fix round: the G98 initial plane is the stream's hop plane, Retract (was Clearance).
    expect(hopZ).toBeCloseTo(5, 9)
    expect(program.initialZ).toBeCloseTo(5, 9)
  })

  it('contour: hops between loops and between plunge depths cross at Retract; first and last at Clearance', () => {
    const payload: ContourWorkerPayload = {
      opId: 'op', setupId: 'su', heights: heights(-6), linking, tool: flat6,
      params: { side: 'outer', direction: 'climb', geometryId: 'g', loopIds: [], tabs: false } as ContourParams,
      passes: { stepdown: 2, stepover: 1.5, stockToLeave: 0.5, finishPasses: 0, springPasses: 0 },
      loops: [square('a', 0, 40), square('b', 60, 40)], wcsOrigin: { x: 0, y: 0, z: 0 },
    }
    const moves = buildContourToolpath(payload)
    const r = entryReport(moves, 0)
    expect(r.startZs.length).toBe(2)   // one XY entry per loop; its depths re-enter in place
    expect(new Set(moves.filter(m => m.role === 'cut').map(m => m.z)).size).toBe(3)
    // Between the first and last cut nothing rises above Retract (the depth retracts rode Clearance).
    const cutAt = moves.map((m, i) => (m.type === 'rapid' ? -1 : i)).filter(i => i >= 0)
    expect(Math.max(...moves.slice(cutAt[0], cutAt[cutAt.length - 1]).map(m => m.z))).toBe(5)
    expect([...new Set(r.hopZs)]).toEqual([5])
    expect(moves[0].z).toBe(15)
    expect(moves[moves.length - 1].z).toBe(15)
    levelHops(moves)
  })

  it('face: the hop to each new Z level crosses at Retract, lifting straight up first', () => {
    const params = {
      boundarySource: 'stock', geometryId: '__stock__', loopIds: [],
      stockOffset: 0, boundaryContainment: 'outside', avoidanceLoopIds: [],
      pattern: 'linear', passAngle: 0, direction: 'both_ways', fromOtherSide: false,
      passExtension: 5, chipThinning: false,
      bothSidesPerLevel: false, floorStockToLeave: 0, finishPass: false,
      entryType: 'plunge', leadInRadius: 0, leadOutRadius: 0,
      keepToolDown: true, maxStayDownDistance: Infinity, extendBeforeRetract: false,
      transition: 'straight', tolerance: 0.01,
    } as FaceParams
    const moves = buildFaceToolpath({
      opId: 'op', setupId: 'su', params, heights: heights(-2), linking,
      passes: { stepdown: 1, stepover: 4, stockToLeave: 0, finishPasses: 0, springPasses: 0 },
      tool: flat6, loops: [square('r', 0, 60)], wcsOrigin: { x: 0, y: 0, z: 0 },
    } as FaceWorkerPayload)
    expect(new Set(moves.filter(m => m.role === 'cut').map(m => m.z)).size).toBe(2)
    const r = entryReport(moves, 0)
    expect(r.hopZs.length).toBeGreaterThan(0)
    expect([...new Set(r.hopZs)]).toEqual([5])
    const cutAt = moves.map((m, i) => (m.type === 'rapid' ? -1 : i)).filter(i => i >= 0)
    expect(Math.max(...moves.slice(cutAt[0], cutAt[cutAt.length - 1]).map(m => m.z))).toBe(5)
    expect(moves[moves.length - 1].z).toBe(15)
    levelHops(moves)
  })

  it('hopTo: an entry that starts above Retract is crossed to at its own height, never below it', () => {
    const moves: ToolpathMove[] = [{ type: 'feed', x: 0, y: 0, z: 0, role: 'cut' }]
    hopTo(moves, { x: 20, y: 0 }, 7, 5, 15)
    const last = moves[moves.length - 1]
    expect([last.x, last.y, last.z]).toEqual([20, 0, 7])
    levelHops(moves)
  })

  it('entryStartAlong: material standing between two vertices, and on a closing segment, is read', () => {
    const nx = 101, ny = 5
    const topZ = new Float32Array(nx * ny).fill(-5)
    topZ[2 * nx + 50] = 0
    const remaining = {
      schemaVersion: 1, representation: 'z-dexel', warnings: [],
      bounds: { minX: 0, minY: 0, minZ: -10, maxX: nx, maxY: ny, maxZ: 0 },
      requestedResolutionMm: 1, resolutionMm: 1, nx, ny, bottomZ: -10, topZ,
    } as unknown as StockState
    const src = { remaining, topZ: -5 }
    expect(entryStartAlong(src, [{ points: [{ x: 0.5, y: 2.5 }, { x: 100.5, y: 2.5 }] }], 1)).toBeCloseTo(1, 9)
    // The standing cell lies only under the closing edge (last vertex back to the first); at
    // reach 0 the other three edges' padded reads stay off its row.
    const ring = [{ x: 100.5, y: 2.5 }, { x: 100.5, y: 4.5 }, { x: 0.5, y: 4.5 }, { x: 0.5, y: 2.5 }]
    expect(entryStartAlong(src, [{ points: ring }], 0)).toBeCloseTo(-4, 9)
    expect(entryStartAlong(src, [{ closed: true, points: ring }], 0)).toBeCloseTo(1, 9)
    // Away from it, the rule still reads the lower material.
    expect(entryStartAlong(src, [{ points: [{ x: 0.5, y: 2.5 }, { x: 40.5, y: 2.5 }] }], 1)).toBeCloseTo(-4, 9)
  })
})

// -- Attempt 3: the path-sampling route through the production contour builder ----------------
// Audit 3 (finding 1): the attempt-2 helper row changed the helper's signature, so its old result
// did not isolate the missing segment sampling. This row feeds ONE contour payload to the builder
// (the worker's entry point) on old and new source alike: remaining stock at -5 except a column
// left standing at Top under the middle of one edge, 20 mm from every vertex.

describe('WO-3083 attempt 3: contour entry reads material standing between two vertices', () => {
  beforeAll(async () => { await ensureClipperReady() })

  it('closed contour: the entry starts 1 mm above a column left standing mid-edge, not above the material at the corners', () => {
    const nx = 80, ny = 80
    const topZ = new Float32Array(nx * ny).fill(-5)
    // Cell x 20..21, y -3..-2: under the outer pass along the bottom edge (y = 0 offset outward).
    topZ[17 * nx + 40] = 0
    const remainingStock = {
      schemaVersion: 1, representation: 'z-dexel', warnings: [],
      bounds: { minX: -20, minY: -20, minZ: -10, maxX: 60, maxY: 60, maxZ: 0 },
      requestedResolutionMm: 1, resolutionMm: 1, nx, ny, bottomZ: -10, topZ,
    } as unknown as StockState
    const payload = {
      opId: 'op', setupId: 'su',
      heights: {
        clearanceHeight: 15, clearanceHeightMode: 'absolute', retractHeight: 5, feedHeight: 5,
        topHeight: 0, topHeightMode: 'absolute', bottomHeight: -6, bottomHeightMode: 'absolute',
      },
      linking: {
        entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
        retractType: 'full', transitionType: 'safe_height',
      },
      tool: {
        id: 't6', name: 'O6 flat', type: 'flat_end_mill',
        diameter: 6, fluteLength: 20, shankDiameter: 6, overallLength: 60,
        numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
        feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 2, stepover: 3 } },
      },
      params: { side: 'outer', direction: 'climb', geometryId: 'g', loopIds: [], tabs: false },
      passes: { stepdown: 2, stepover: 1.5, stockToLeave: 0, finishPasses: 1, springPasses: 0 },
      loops: [{ id: 'a', closed: true, type: 'contour',
        points: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 }] }],
      wcsOrigin: { x: 0, y: 0, z: 0 },
      remainingStock,
    } as unknown as ContourWorkerPayload
    const moves = buildContourToolpath(payload)
    const r = entryReport(moves, 0)
    console.log(`WO-3083 attempt 3 | contour mid-edge column | entry start Z ${[...new Set(r.startZs)].join(',')}`)
    expect(r.startZs.length).toBeGreaterThan(0)
    // Material along the edge is the column at 0: every entry starts at 0 + 1 (old: -5 + 1 = -4).
    expect([...new Set(r.startZs.map(z => +z.toFixed(6)))]).toEqual([1])
  })
})

// -- Attempt 4: default G98 drilling hops at Retract in the stream AND the posted program ------
// Review FAIL (drill2d.ts:162): G98 drilling hopped between holes at Clearance. The native cycle
// returns to its initial plane, so the post now starts the cycle there (Retract) and, where the
// reach trim raised a hop over workholding, ends the cycle, lifts over the clamp and restarts it.
// The posted file is read back through the app's G-code reader (canned cycles expanded) so the
// machine's hops are measured, not the post's text.

const drillTool = makeTool({ id: 'd5', name: 'O5 drill', type: 'drill', diameter: 5, fluteLength: 30, shankDiameter: 5 })

function postDrill(params: DrillParams, moves: ToolpathMove[]) {
  const machine = makeMachine()
  const op = {
    id: 'op', name: 'Drill', type: 'drill', enabled: true, status: 'ready', toolId: drillTool.id,
    params, toolpathMoves: moves,
  } as unknown as Operation
  const input: PostInput = { machine, setup: { wcs: makeWcs(), operations: [{
    op, tool: drillTool, moves,
    feeds: resolveFeedrates(drillTool, undefined, machine.rapidRate),
    spindle: resolveSpindle(op, drillTool, machine),
    coolant: resolveCoolant(drillTool, machine),
  }] } }
  const { lines, diagnostics } = emitProgram(input, UCCNC_CONFIG)
  const read = readGcodeProgram(lines.join('\n'), {
    dialect: 'uccnc', sessionWcs: 'G54', initialPosition: { x: 0, y: 0, z: 50 }, machineUnits: 'mm',
    workOffsets: { G54: { x: 0, y: 0, z: 0 } },
  })
  if (!read.ok) throw new Error(`the posted drill was refused: ${read.refusal.message}`)
  return { lines, diagnostics, moves: read.program.moves as ToolpathMove[] }
}

/** Every XY move from the first move into the material to the last one, as a segment. */
function xyHops(moves: readonly ToolpathMove[], top: number) {
  const inside = moves.map((m, i) => (m.z < top - 1e-6 ? i : -1)).filter(i => i >= 0)
  const hops: { from: ToolpathMove; to: ToolpathMove }[] = []
  for (let i = inside[0] + 1; i <= inside[inside.length - 1]; i++) {
    if (Math.hypot(moves[i].x - moves[i - 1].x, moves[i].y - moves[i - 1].y) > 1e-6) hops.push({ from: moves[i - 1], to: moves[i] })
  }
  return hops
}
const hopZsOf = (moves: readonly ToolpathMove[], top: number) =>
  [...new Set(xyHops(moves, top).map(h => +Math.max(h.from.z, h.to.z).toFixed(3)))]

describe('WO-3083 attempt 4: default G98 drilling hops at Retract, in the stream and on the machine', () => {
  it('ex04 Drill 1 (default G98): the stream and the posted program both hop between holes at Retract', async () => {
    const id = 'ex04-tool-storage-bar-declared'
    const chain = chainOf(id)
    const planned = await plannedOf(id)
    const idx = chain.steps.findIndex((s, i) => (s.authoredOperation?.name ?? s.id) === 'Drill 1' && planned.steps[i].status === 'ready')
    expect(idx).toBeGreaterThanOrEqual(0)
    const step = planned.steps[idx]
    const wcsZ = step.sourceWcsOrigin?.z ?? 0
    const moves = step.moves.map(m => ({ ...m, z: m.z - wcsZ }))
    const params = step.settings!.params as unknown as DrillParams
    expect(params.retractMode).toBe('clearance')
    const posted = postDrill(params, moves)
    const streamHops = hopZsOf(moves, 0)
    const postedHops = hopZsOf(posted.moves, 0)
    console.log(`WO-3083 attempt 4 | ex04 Drill 1 | stream hops ${streamHops.join(',')} | posted hops ${postedHops.join(',')}`)
    expect(posted.lines.some(l => /^G98 G8[123] /.test(l)), posted.lines.join('\n')).toBe(true)
    expect(streamHops).toEqual([5])
    expect(postedHops).toEqual([5])
    // The first entry and the final exit stay at Clearance, as the stream's do.
    expect(Math.max(...posted.moves.map(m => m.z).slice(1))).toBeGreaterThanOrEqual(15 - TOL)
  }, 900_000)

  // Two holes with a clamp standing between them, taller than Retract and lower than Clearance.
  type Box = readonly [number, number, number, number, number, number]
  const CLAMP: Box = [15, -20, 0, 25, 20, 10]
  function clampMesh([x0, y0, z0, x1, y1, z1]: Box): ClearanceMesh {
    const positions: number[] = []
    for (const z of [z0, z1]) for (const y of [y0, y1]) for (const x of [x0, x1]) positions.push(x, y, z)
    const indices: number[] = []
    for (const [a, b, c, d] of [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]]) {
      indices.push(a, b, c, a, c, d)
    }
    return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) }
  }
  const hole = (id: string, cx: number): LoopData => ({ id, closed: true, type: 'contour',
    points: [{ x: cx - 2, y: -2 }, { x: cx + 2, y: -2 }, { x: cx + 2, y: 2 }, { x: cx - 2, y: 2 }] })
  function drillPair(retractMode: DrillParams['retractMode'], workholding: ClearanceMesh[]) {
    const params: DrillParams = {
      geometryId: 'g', loopIds: [], cycleType: 'simple', peckDepth: 2, chipBreakRetract: 0.5, dwell: 0,
      retractMode, sortStrategy: 'by_x',
    }
    const payload: DrillWorkerPayload = {
      opId: 'op', setupId: 'su', params,
      heights: {
        clearanceHeight: 15, clearanceHeightMode: 'absolute', retractHeight: 5, feedHeight: 5,
        topHeight: 0, topHeightMode: 'absolute', bottomHeight: -10, bottomHeightMode: 'absolute',
      },
      passes: { stepdown: 2, stepover: 1, stockToLeave: 0, finishPasses: 0, springPasses: 0 },
      linking: { entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0, retractType: 'full', transitionType: 'safe_height' },
      tool: drillTool, loops: [hole('h1', 0), hole('h2', 40)], wcsOrigin: { x: 0, y: 0, z: 0 },
    }
    // The production route: the builder, then the worker's reach trim (toolpathWorker.ts).
    const built = buildDrillToolpath(payload)
    const moves = workholding.length === 0 ? built : [...trimToolpathToToolReach({
      operation: 'Drill', moves: built, tool: drillTool, plungeRate: 150, workholding,
    }).moves]
    return { params, moves, posted: postDrill(params, moves) }
  }
  /** Every posted XY move whose straight path passes over the clamp (widened by the drill radius). */
  const overClamp = (moves: readonly ToolpathMove[]) => xyHops(moves, 0).filter(({ from, to }) =>
    Math.max(from.x, to.x) > CLAMP[0] - 2.5 && Math.min(from.x, to.x) < CLAMP[3] + 2.5)

  for (const mode of ['clearance', 'retract'] as const) {
    it(`a clamp between two holes (${mode === 'clearance' ? 'G98' : 'G99'}): the posted program ends the cycle and lifts over it where the stream does`, () => {
      const { moves, posted } = drillPair(mode, [clampMesh(CLAMP)])
      const streamHops = hopZsOf(moves, 0)
      const postedHops = hopZsOf(posted.moves, 0)
      console.log(`WO-3083 attempt 4 | clamp ${mode} | stream hops ${streamHops.join(',')} | posted hops ${postedHops.join(',')}\n${posted.lines.join('\n')}`)
      // The reach trim raised the stream's hop above the clamp (the precondition).
      expect(Math.min(...streamHops)).toBeGreaterThan(CLAMP[5])
      // On the machine nothing crosses the clamp below its top.
      const crossings = overClamp(posted.moves)
      expect(crossings.length).toBeGreaterThan(0)
      for (const { from, to } of crossings) expect(Math.min(from.z, to.z), JSON.stringify({ from, to })).toBeGreaterThan(CLAMP[5])
      // And it crosses where the simulator's stream does.
      expect(postedHops).toEqual(streamHops)
      // The cycle was ended for the lift and restarted in full.
      expect(posted.lines.filter(l => l === 'G80')).toHaveLength(2)
      expect(posted.lines.filter(l => /^G9[89] G81 /.test(l))).toHaveLength(2)
    })
  }

  it('no workholding: the G98 cycle starts from Retract and crosses to the first hole at Clearance', () => {
    const g98 = drillPair('clearance', [])
    const i98 = g98.posted.lines.findIndex(l => l.startsWith('G98 G81'))
    expect(g98.posted.lines.slice(i98 - 3, i98)).toEqual(['G0 Z15', 'G0 X0 Y0', 'G0 Z5'])
    expect(g98.posted.lines.slice(i98 + 1, i98 + 4)).toEqual(['X40 Y0', 'G80', 'G0 Z15'])
    expect(hopZsOf(g98.posted.moves, 0)).toEqual([5])
  })

  it('no workholding: G99 (retract mode) posts exactly as before - opens at Clearance, returns and hops at R', () => {
    const g99 = drillPair('retract', [])
    const i99 = g99.posted.lines.findIndex(l => l.startsWith('G99 G81'))
    expect(g99.posted.lines.slice(i99 - 2)).toEqual(
      ['M8', 'G0 Z15', 'G99 G81 X0 Y0 Z-10 R5 F400', 'X40 Y0', 'G80', 'M5', 'M9', 'G0 Z15', 'M30'])
    expect(hopZsOf(g99.posted.moves, 0)).toEqual([5])
  })
})
