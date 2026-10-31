import { describe, it, expect, vi, afterEach } from 'vitest'
import { buildDrillToolpath } from '../../lib/cam/drill2d'
import { reconstructDrillCycles } from '../../lib/post/cannedCycle'
import { emitProgram } from '../../lib/post/emit'
import { UCCNC_CONFIG } from '../../lib/post/dialects/uccnc'
import { resolveFeedrates } from '../../lib/cam/feedrates'
import { resolveSpindle, resolveCoolant } from '../../lib/post/resolve'
import { makeMachine, makeWcs } from '../post/helpers'
import type { PostInput, PostOperation } from '../../lib/post/types'
import type { DrillParams, DrillWorkerPayload, LoopData } from '../../lib/cam/types'
import type {
  Operation, Tool, HeightParams, PassParams, LinkingParams, ToolpathMove,
} from '../../types'

// WO-1926: a deep-hole peck drill can shrink each successive peck by a set
// decrement (peckDecrement) down to a floor (minPeckDepth). With neither field
// set the emitted stream is exactly today's constant-peck output.

const PECK_DEPTH = 5
const TOP_Z = 0
const BOTTOM_Z = -20
const FEED_Z = 1
const RETRACT_Z = 5
const CLEARANCE_Z = 10
const PLUNGE_RATE = 150
const FEED_RATE = 600
const CLEARANCE = 0.5

function makeTool(): Tool {
  return {
    id: 't1', name: 'drill 5', type: 'drill',
    diameter: 5, fluteLength: 30, shankDiameter: 5, overallLength: 60,
    numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '', toolNumber: 1,
    feedsAndSpeeds: { default: { rpm: 8000, feedRate: FEED_RATE, plungeRate: PLUNGE_RATE, depthOfCut: 5, stepover: 2 } },
  } as Tool
}

function makeHeights(bottom = BOTTOM_Z): HeightParams {
  return {
    clearanceHeight: CLEARANCE_Z, clearanceHeightMode: 'absolute',
    retractHeight: RETRACT_Z, feedHeight: FEED_Z,
    topHeight: TOP_Z, topHeightMode: 'absolute',
    bottomHeight: bottom, bottomHeightMode: 'absolute',
  }
}

const passes: PassParams = { stepdown: 5, stepover: 2, stockToLeave: 0, finishPasses: 0, springPasses: 0 }
const linking: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
}

const LOOPS: LoopData[] = [{
  id: 'h1', closed: true, type: 'contour', points: [
    { x: -2, y: -2 }, { x: 2, y: -2 }, { x: 2, y: 2 }, { x: -2, y: 2 },
  ],
}]

function makeParams(over: Partial<DrillParams> = {}): DrillParams {
  return {
    geometryId: 'g1', loopIds: [], cycleType: 'peck', peckDepth: PECK_DEPTH,
    chipBreakRetract: 1, dwell: 0, retractMode: 'clearance', sortStrategy: 'none',
    ...over,
  }
}

function build(p: DrillParams, bottom = BOTTOM_Z): ToolpathMove[] {
  const payload: DrillWorkerPayload = {
    opId: 'op', setupId: 'su', params: p, heights: makeHeights(bottom), passes, linking,
    tool: makeTool(), loops: LOOPS, wcsOrigin: { x: 0, y: 0, z: 0 },
  }
  return buildDrillToolpath(payload)
}

function plungeZs(moves: ToolpathMove[]): number[] {
  return moves.filter(m => m.role === 'plunge').map(m => m.z)
}

// Successive peck lengths (mm) from the plunge-Z sequence, measured from the
// stock surface (topZ) as the emitter does.
function peckLengths(moves: ToolpathMove[], from = TOP_Z): number[] {
  const zs = plungeZs(moves)
  const pts = [from, ...zs]
  return pts.slice(1).map((z, i) => Math.abs(z - pts[i]))
}

function makeOp(p: DrillParams, moves: ToolpathMove[]): Operation {
  return {
    id: 'op', name: 'Drill', type: 'drill', enabled: true, status: 'ready', toolId: 't1',
    geometrySelections: [], heights: makeHeights(), passes, linking,
    params: p as unknown as Record<string, unknown>, toolpathMoves: moves,
  } as Operation
}

function makeInput(p: DrillParams, moves: ToolpathMove[]): PostInput {
  const op = makeOp(p, moves)
  const tool = makeTool()
  const machine = makeMachine()
  const postOp: PostOperation = {
    op, tool,
    feeds: resolveFeedrates(tool, op.feedrateOverride, machine.rapidRate),
    spindle: resolveSpindle(op, tool, machine),
    coolant: resolveCoolant(tool, machine),
    moves,
  }
  return { machine, setup: { wcs: makeWcs(), operations: [postOp] } }
}

afterEach(() => {
  vi.restoreAllMocks()
})

// ── emitPeck shrink arithmetic ────────────────────────────────────────────────

describe('WO-1926 peck cycle shrinks toward a minimum', () => {
  it('pecks shrink from peckDepth toward minPeckDepth, never below it', () => {
    // peckDepth 5, decrement 1, min 2, depth 20 -> lengths 5,4,3,2,2,2,2.
    const moves = build(makeParams({ peckDepth: 5, peckDecrement: 1, minPeckDepth: 2 }))

    expect(plungeZs(moves)).toEqual([-5, -9, -12, -14, -16, -18, -20])
    expect(peckLengths(moves)).toEqual([5, 4, 3, 2, 2, 2, 2])
    // Acceptance: no scheduled peck falls below the minimum.
    for (const len of peckLengths(moves)) expect(len).toBeGreaterThanOrEqual(2)
    // Reaches the true hole bottom exactly, as before.
    expect(Math.min(...plungeZs(moves))).toBe(BOTTOM_Z)
  })

  it('minPeckDepth clamps the floor (declining then flat at the floor)', () => {
    // peckDepth 4, decrement 1.5, min 1, depth 16 -> lengths 4,2.5,1,1,1,1,1,1,1,1,1(+clamp).
    const moves = build(makeParams({ peckDepth: 4, peckDecrement: 1.5, minPeckDepth: 1 }),
      -16)
    const lens = peckLengths(moves)
    expect(lens[0]).toBeCloseTo(4, 9)
    expect(lens[1]).toBeCloseTo(2.5, 9)
    // Everything after the floor is reached is exactly the floor.
    for (const len of lens.slice(2, -1)) expect(len).toBeCloseTo(1, 9)
    // No SCHEDULED peck falls below the floor; the very last peck is the
    // remainder that clamps the hole to its exact bottom (as in the legacy code).
    for (const len of lens.slice(0, -1)) expect(len).toBeGreaterThanOrEqual(1 - 1e-9)
    expect(Math.min(...plungeZs(moves))).toBe(-16)
  })

  it('a decrement with no minPeckDepth defaults the floor to the decrement (always progresses)', () => {
    // peckDepth 5, decrement 1, no floor -> lengths 5,4,3,2,1,1,1,1,1,1.
    const moves = build(makeParams({ peckDepth: 5, peckDecrement: 1 }))
    expect(peckLengths(moves)).toEqual([5, 4, 3, 2, 1, 1, 1, 1, 1, 1])
    expect(Math.min(...plungeZs(moves))).toBe(BOTTOM_Z)
  })

  it('WO-1886 full-retract and re-approach-rapid behaviour survives shrinking', () => {
    const moves = build(makeParams({ peckDepth: 5, peckDecrement: 1, minPeckDepth: 2 }))
    // WO-3083: the hole is now left to Retract too (G98 hops at Retract), so only the
    // z==retractZ rapids before the last plunge are inter-peck full retracts.
    const lastPlunge = moves.map(m => m.role).lastIndexOf('plunge')
    const retractIndices = moves
      .map((m, i) => (i < lastPlunge && m.type === 'rapid' && Math.abs(m.z - RETRACT_Z) < 1e-9 ? i : -1))
      .filter(i => i >= 0)
    // Every peck but the last full-retracts; each full retract is followed by a
    // RAPID re-approach to previous depth + clearance (never a plunge feed).
    expect(retractIndices.length).toBe(plungeZs(moves).length - 1)
    for (const i of retractIndices) {
      const re = moves[i + 1]
      expect(re.type).toBe('rapid')
      const prevZ = moves[i - 1].z
      expect(Math.abs(re.z - (prevZ + CLEARANCE))).toBeLessThan(1e-9)
    }
  })

  it('chip_break honours the same decrement/minimum', () => {
    const moves = build(makeParams({ cycleType: 'chip_break', peckDepth: 5, peckDecrement: 1, minPeckDepth: 2 }))
    expect(plungeZs(moves)).toEqual([-5, -9, -12, -14, -16, -18, -20])
    // Chip-break stays in the hole: partial retracts, no full retract to retractZ between pecks
    // (WO-3083: leaving the hole after the last peck now goes to Retract, the G98 hop plane).
    const lastPlunge = moves.map(m => m.role).lastIndexOf('plunge')
    expect(moves.slice(0, lastPlunge).some(m => m.type === 'rapid' && Math.abs(m.z - RETRACT_Z) < 1e-9)).toBe(false)
  })
})

// ── Negative control: neither field set is byte-identical to today ─────────────

describe('WO-1926 negative control: no shrink fields -> byte-identical legacy output', () => {
  it('constant pecks: exact legacy plunge-Z sequence, and explicit undefined keys change nothing', () => {
    const legacy = build(makeParams({ cycleType: 'peck', peckDepth: 5 }))
    expect(plungeZs(legacy)).toEqual([-5, -10, -15, -20])

    const explicit = build(makeParams({
      cycleType: 'peck', peckDepth: 5, peckDecrement: undefined, minPeckDepth: undefined,
    }))
    expect(JSON.stringify(explicit)).toBe(JSON.stringify(legacy))
  })

  it('peckDecrement 0 is treated as unset; a bare minPeckDepth is inert without a decrement', () => {
    const expected = [-5, -10, -15, -20]
    expect(plungeZs(build(makeParams({ peckDepth: 5, peckDecrement: 0, minPeckDepth: 2 })))).toEqual(expected)
    expect(plungeZs(build(makeParams({ peckDepth: 5, minPeckDepth: 2 })))).toEqual(expected)
    expect(plungeZs(build(makeParams({ peckDepth: 5, peckDecrement: -1, minPeckDepth: 2 })))).toEqual(expected)
  })

  it('chip_break negative control: constant pecks, partial retract unchanged', () => {
    const moves = build(makeParams({ cycleType: 'chip_break', peckDepth: 5 }))
    expect(plungeZs(moves)).toEqual([-5, -10, -15, -20])
  })
})

// ── Native canned-cycle refusal (cannedCycle.ts / emit.ts) ─────────────────────

describe('WO-1926 shrinking peck refuses native G83 by name and expands', () => {
  it('reconstructDrillCycles: peck + decrement -> DRILL_PECK_DECREMENT_EXPANDED', () => {
    const p = makeParams({ cycleType: 'peck', peckDepth: 5, peckDecrement: 1, minPeckDepth: 2 })
    const moves = build(p)
    const res = reconstructDrillCycles(makeOp(p, moves), moves)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('DRILL_PECK_DECREMENT_EXPANDED')
    expect(res.message.length).toBeGreaterThan(0)
  })

  it('reconstructDrillCycles: constant peck (no decrement) still -> G83 with peckQ', () => {
    const p = makeParams({ cycleType: 'peck', peckDepth: 5 })
    const moves = build(p)
    const res = reconstructDrillCycles(makeOp(p, moves), moves)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.program.gWord).toBe('G83')
    expect(res.program.peckQ).toBe(5)
  })

  it('reconstructDrillCycles: peck with decrement 0 still -> G83 (no false refusal)', () => {
    const p = makeParams({ cycleType: 'peck', peckDepth: 5, peckDecrement: 0, minPeckDepth: 2 })
    const moves = build(p)
    const res = reconstructDrillCycles(makeOp(p, moves), moves)
    expect(res.ok).toBe(true)
  })

  it('emitProgram (UCCNC): shrinking peck emits expanded G1 stream, no G83, no diagnostic', () => {
    const p = makeParams({ cycleType: 'peck', peckDepth: 5, peckDecrement: 1, minPeckDepth: 2 })
    const moves = build(p)
    const { lines, diagnostics } = emitProgram(makeInput(p, moves), UCCNC_CONFIG)
    expect(lines.some(l => l.includes('G83'))).toBe(false)
    expect(lines.some(l => l === 'G80')).toBe(false)
    // The fully expanded plunge stream is the fall-through.
    expect(lines.some(l => l.startsWith('G1'))).toBe(true)
    // Expected signal (like chip_break): no warning/error diagnostic.
    expect(diagnostics).toHaveLength(0)
  })

  it('emitProgram (UCCNC): constant peck still posts native G83 with Q', () => {
    const p = makeParams({ cycleType: 'peck', peckDepth: 5 })
    const moves = build(p)
    const { lines } = emitProgram(makeInput(p, moves), UCCNC_CONFIG)
    const first = lines.find(l => l.includes('G83'))
    expect(first).toBeDefined()
    expect(first).toContain('Q5')
  })
})