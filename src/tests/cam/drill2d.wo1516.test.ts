import { describe, it, expect, vi, afterEach } from 'vitest'
import { buildDrillToolpath } from '../../lib/cam/drill2d'
import { resolveFeedrates } from '../../lib/cam/feedrates'
import { emitProgram } from '../../lib/post/emit'
import { reconstructDrillCycles } from '../../lib/post/cannedCycle'
import { UCCNC_CONFIG } from '../../lib/post/dialects/uccnc'
import { LINUXCNC_CONFIG } from '../../lib/post/dialects/linuxcnc'
import { GRBL_CONFIG } from '../../lib/post/dialects/grbl'
import { resolveSpindle, resolveCoolant } from '../../lib/post/resolve'
import { makeMachine, makeWcs } from '../post/helpers'
import type { PostConfig, PostInput, PostOperation } from '../../lib/post/types'
import type { DrillParams, DrillWorkerPayload, LoopData } from '../../lib/cam/types'
import type { Operation, Tool, HeightParams, PassParams, LinkingParams, ToolpathMove } from '../../types'

// WO-1516 (BUG-408): the drill dwell lives on the canonical move stream
// (ToolpathMove.dwellMs on the hole-bottom plunge), and both post paths read it
// from there - native G82 P and the expanded G4.

function makeTool(): Tool {
  return {
    id: 't1', name: 'drill 5', type: 'drill',
    diameter: 5, fluteLength: 30, shankDiameter: 5, overallLength: 60,
    numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '', toolNumber: 1,
    feedsAndSpeeds: { default: { rpm: 8000, feedRate: 600, plungeRate: 150, depthOfCut: 5, stepover: 2 } },
  } as Tool
}

const heights: HeightParams = {
  clearanceHeight: 10, clearanceHeightMode: 'absolute',
  retractHeight: 5, feedHeight: 1,
  topHeight: 0, topHeightMode: 'absolute',
  bottomHeight: -10, bottomHeightMode: 'absolute',
}
const passes: PassParams = { stepdown: 5, stepover: 2, stockToLeave: 0, finishPasses: 0, springPasses: 0 }
const linking: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
}

function holeLoop(id: string, cx: number, cy: number): LoopData {
  const s = 2
  return { id, closed: true, type: 'contour', points: [
    { x: cx - s, y: cy - s }, { x: cx + s, y: cy - s },
    { x: cx + s, y: cy + s }, { x: cx - s, y: cy + s },
  ] }
}

const LOOPS: LoopData[] = []
for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) LOOPS.push(holeLoop(`h${r}${c}`, c * 20, r * 20))

function params(over: Partial<DrillParams> = {}): DrillParams {
  return {
    geometryId: 'g1', loopIds: [], cycleType: 'simple', peckDepth: 3, chipBreakRetract: 1, dwell: 0,
    retractMode: 'clearance', sortStrategy: 'none', ...over,
  }
}

function build(p: DrillParams, holeBottoms?: Record<string, number>): ToolpathMove[] {
  const payload: DrillWorkerPayload = {
    opId: 'op', setupId: 'su', params: p, heights, passes, linking,
    tool: makeTool(), loops: LOOPS, wcsOrigin: { x: 0, y: 0, z: 0 },
    ...(holeBottoms ? { holeBottoms } : {}),
  }
  return buildDrillToolpath(payload)
}

function makeOp(p: DrillParams, moves: ToolpathMove[]): Operation {
  return {
    id: 'op', name: 'Drill', type: 'drill', enabled: true, status: 'ready', toolId: 't1',
    geometrySelections: [], heights, passes, linking,
    params: p as unknown as Record<string, unknown>, toolpathMoves: moves,
  } as Operation
}

function input(op: Operation): PostInput {
  const tool = makeTool()
  const machine = makeMachine()
  const postOp: PostOperation = {
    op, tool,
    feeds: resolveFeedrates(tool, op.feedrateOverride, machine.rapidRate),
    spindle: resolveSpindle(op, tool, machine),
    coolant: resolveCoolant(tool, machine),
    moves: op.toolpathMoves ?? [],
  }
  return { machine, setup: { wcs: makeWcs(), operations: [postOp] } }
}

function noCanned(base: PostConfig): PostConfig {
  return { ...base, capabilities: { ...base.capabilities, cannedCycles: false } }
}

afterEach(() => { vi.restoreAllMocks() })

describe('WO-1516 drill dwell on the canonical toolpath', () => {
  it('a dwell drill stamps dwellMs on each hole-bottom plunge and emits no zero-length duplicate', () => {
    const moves = build(params({ cycleType: 'dwell', dwell: 0.75 }))
    const dwellMoves = moves.filter((m) => m.dwellMs !== undefined)
    expect(dwellMoves).toHaveLength(12)
    for (const m of dwellMoves) {
      expect(m.dwellMs).toBe(750)
      expect(m.role).toBe('plunge')
      expect(m.z).toBe(-10)
    }
    // No zero-length plunge (the old same-position "dwell cue" duplicate).
    for (let i = 1; i < moves.length; i++) {
      const a = moves[i - 1], b = moves[i]
      if (b.role !== 'plunge') continue
      expect(a.x === b.x && a.y === b.y && a.z === b.z).toBe(false)
    }
    // Identical geometry to the simple drill: only the pause differs.
    const simple = build(params())
    expect(moves.map(({ dwellMs: _d, ...rest }) => rest)).toEqual(simple)
  })

  it('zero-dwell and mixed-depth drills carry no dwell', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(build(params({ cycleType: 'dwell', dwell: 0 })).some((m) => m.dwellMs !== undefined)).toBe(false)
    expect(build(params(), { h00: -4, h11: -7 }).some((m) => m.dwellMs !== undefined)).toBe(false)
  })

  it('native G82 still emits P750 per the program, read from the move stream', () => {
    const p = params({ cycleType: 'dwell', dwell: 0.75 })
    const { lines, diagnostics } = emitProgram(input(makeOp(p, build(p))), UCCNC_CONFIG)
    const g82 = lines.filter((l) => l.includes('G82'))
    expect(g82).toHaveLength(1)
    expect(g82[0]).toContain('P750')
    expect(lines.some((l) => l.startsWith('G4'))).toBe(false)
    expect(diagnostics).toHaveLength(0)
  })

  it('G82 P follows the moves dwellMs, not a second read of params.dwell', () => {
    const p = params({ cycleType: 'dwell', dwell: 0.75 })
    const moves = build(params({ cycleType: 'dwell', dwell: 0.5 }))
    const res = reconstructDrillCycles(makeOp(p, moves), moves)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.program.dwellSec).toBe(0.5)
    const { lines } = emitProgram(input(makeOp(p, moves)), UCCNC_CONFIG)
    expect(lines.find((l) => l.includes('G82'))).toContain('P500')
  })

  it('expanded emission (no canned cycles) carries one explicit G4 per hole in controller units', () => {
    const p = params({ cycleType: 'dwell', dwell: 0.75 })
    const op = makeOp(p, build(p))
    const grbl = emitProgram(input(op), GRBL_CONFIG).lines
    expect(grbl.some((l) => l.includes('G82'))).toBe(false)
    expect(grbl.filter((l) => l === 'G4 P0.75')).toHaveLength(12)
    const uccnc = emitProgram(input(op), noCanned(UCCNC_CONFIG)).lines
    expect(uccnc.filter((l) => l === 'G4 P750')).toHaveLength(12)
    const linux = emitProgram(input(op), noCanned(LINUXCNC_CONFIG)).lines
    expect(linux.filter((l) => l === 'G4 P0.75')).toHaveLength(12)
    // Each G4 sits right after the plunge to the hole bottom.
    const i = grbl.indexOf('G4 P0.75')
    expect(grbl[i - 1]).toMatch(/Z-10/)
  })

  it('a stream whose holes carry different dwells falls back to expanded G4s with a named warning', () => {
    const p = params({ cycleType: 'dwell', dwell: 0.75 })
    const moves = build(p)
    const firstDwell = moves.findIndex((m) => m.dwellMs !== undefined)
    moves[firstDwell] = { ...moves[firstDwell], dwellMs: 250 }
    const { lines, diagnostics } = emitProgram(input(makeOp(p, moves)), UCCNC_CONFIG)
    expect(lines.some((l) => l.includes('G82'))).toBe(false)
    expect(diagnostics.map((d) => d.code)).toContain('DRILL_CYCLE_MALFORMED')
    expect(lines.filter((l) => l === 'G4 P750')).toHaveLength(11)
    expect(lines.filter((l) => l === 'G4 P250')).toHaveLength(1)
  })

  it('zero-dwell and simple drill output is unchanged (no G4, G82 P0 / G81 as before)', () => {
    const zero = params({ cycleType: 'dwell', dwell: 0 })
    const zl = emitProgram(input(makeOp(zero, build(zero))), UCCNC_CONFIG).lines
    expect(zl.find((l) => l.includes('G82'))).toContain('P0')
    expect(zl.some((l) => l.startsWith('G4'))).toBe(false)
    const simple = params()
    const gl = emitProgram(input(makeOp(simple, build(simple))), GRBL_CONFIG).lines
    expect(gl.some((l) => l.startsWith('G4'))).toBe(false)
  })
})
