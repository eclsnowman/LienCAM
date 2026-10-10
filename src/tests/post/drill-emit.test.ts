import { describe, it, expect, vi, afterEach } from 'vitest'
import { emitProgram } from '../../lib/post/emit'
import { UCCNC_CONFIG } from '../../lib/post/dialects/uccnc'
import { GRBL_CONFIG } from '../../lib/post/dialects/grbl'
import { buildDrillToolpath } from '../../lib/cam/drill2d'
import { resolveFeedrates } from '../../lib/cam/feedrates'
import { resolveSpindle, resolveCoolant } from '../../lib/post/resolve'
import { makeMachine, makeWcs } from './helpers'
import type { PostConfig, PostInput, PostOperation } from '../../lib/post/types'
import type {
  DrillParams,
  DrillWorkerPayload,
  LoopData,
} from '../../lib/cam/types'
import type {
  Operation,
  Tool,
  HeightParams,
  PassParams,
  LinkingParams,
} from '../../types'

// ── Fixtures (mirror src/tests/post/cannedCycle.test.ts) ─────────────────────
// Three holes on the X axis: h1 @ x=0, h2 @ x=20, h3 @ x=40.
// Heights: clearance 10, retract 5, feed 1, top 0, bottom -10 (absolute).
// plungeRate (feed of plunge moves) = 150 from the tool default.

function makeDrillTool(): Tool {
  return {
    id: 't1',
    name: 'Ø5 drill',
    type: 'drill',
    diameter: 5,
    fluteLength: 30,
    shankDiameter: 5,
    overallLength: 60,
    numberOfFlutes: 2,
    material: 'carbide',
    coating: 'none',
    notes: '',
    toolNumber: 1,
    feedsAndSpeeds: {
      default: {
        rpm: 8000,
        feedRate: 600,
        plungeRate: 150,
        depthOfCut: 5,
        stepover: 2,
      },
    },
  } as Tool
}

function makeHeights(bottom = -10): HeightParams {
  return {
    clearanceHeight: 10,
    clearanceHeightMode: 'absolute',
    retractHeight: 5,
    feedHeight: 1,
    topHeight: 0,
    topHeightMode: 'absolute',
    bottomHeight: bottom,
    bottomHeightMode: 'absolute',
  }
}

const passes: PassParams = {
  stepdown: 5,
  stepover: 2,
  stockToLeave: 0,
  finishPasses: 0,
  springPasses: 0,
}

const linking: LinkingParams = {
  entryType: 'plunge',
  rampAngle: 3,
  rampLength: 0,
  leadInRadius: 0,
  leadOutRadius: 0,
  retractType: 'full',
  transitionType: 'safe_height',
}

function holeLoop(id: string, cx: number, cy = 0): LoopData {
  const s = 2
  return {
    id,
    closed: true,
    type: 'contour',
    points: [
      { x: cx - s, y: cy - s },
      { x: cx + s, y: cy - s },
      { x: cx + s, y: cy + s },
      { x: cx - s, y: cy + s },
    ],
  }
}

const LOOPS = [holeLoop('h1', 0), holeLoop('h2', 20), holeLoop('h3', 40)]

function makeDrillParams(over: Partial<DrillParams> = {}): DrillParams {
  return {
    geometryId: 'g1',
    loopIds: [],
    cycleType: 'simple',
    peckDepth: 3,
    chipBreakRetract: 1,
    dwell: 0,
    retractMode: 'clearance',
    sortStrategy: 'by_x',
    ...over,
  }
}

function makePayload(
  params: DrillParams,
  holeBottoms?: { [loopId: string]: number },
): DrillWorkerPayload {
  return {
    opId: 'op',
    setupId: 'su',
    params,
    heights: makeHeights(),
    passes,
    linking,
    tool: makeDrillTool(),
    loops: LOOPS,
    wcsOrigin: { x: 0, y: 0, z: 0 },
    ...(holeBottoms ? { holeBottoms } : {}),
  }
}

// Build an Operation wrapper carrying the DrillParams under op.params, with the
// built toolpath moves on op.toolpathMoves (so postOp picks them up).
function makeDrillOp(
  params: DrillParams,
  holeBottoms?: { [loopId: string]: number },
): Operation {
  const moves = buildDrillToolpath(makePayload(params, holeBottoms))
  return {
    id: 'op',
    name: 'Drill',
    type: 'drill',
    enabled: true,
    status: 'ready',
    toolId: 't1',
    geometrySelections: [],
    heights: makeHeights(),
    passes,
    linking,
    params: params as unknown as Record<string, unknown>,
    toolpathMoves: moves,
  } as Operation
}

// Assemble a PostInput around one drill op (mirrors emit.test.ts postOp/makeInput).
function makeDrillInput(
  params: DrillParams,
  holeBottoms?: { [loopId: string]: number },
): PostInput {
  const op = makeDrillOp(params, holeBottoms)
  const tool = makeDrillTool()
  const machine = makeMachine()
  const postOp: PostOperation = {
    op,
    tool,
    feeds: resolveFeedrates(tool, op.feedrateOverride, machine.rapidRate),
    spindle: resolveSpindle(op, tool, machine),
    coolant: resolveCoolant(tool, machine),
    moves: op.toolpathMoves ?? [],
  }
  return { machine, setup: { wcs: makeWcs(), operations: [postOp] } }
}

function withOptions(
  base: PostConfig,
  options: Partial<PostConfig['options']>,
): PostConfig {
  return { ...base, options: { ...base.options, ...options } }
}

afterEach(() => {
  vi.restoreAllMocks()
})

// ── UCCNC: native canned-cycle emission ──────────────────────────────────────

describe('emitProgram — drill canned cycles (UCCNC)', () => {
  it('simple -> one G98 G81 block + X/Y-only subsequent holes + one G80; no plunge spam', () => {
    const params = makeDrillParams()
    const { lines, diagnostics } = emitProgram(makeDrillInput(params), UCCNC_CONFIG)

    // The first hole carries the full canned-cycle definition.
    const first = lines.find((l) => l.includes('G81'))
    expect(first).toBeDefined()
    expect(first).toContain('G98')
    expect(first).toContain('G81')
    expect(first).toMatch(/X0\b/)
    expect(first).toContain('R')
    expect(first).toContain('F')

    // Exactly one G81 (it is modal; not repeated on later holes).
    expect(lines.filter((l) => l.includes('G81'))).toHaveLength(1)

    // The 2nd / 3rd holes are X/Y-only (same bottom Z -> Z suppressed, no G-word).
    const hole2 = lines.find((l) => l.startsWith('X20'))
    const hole3 = lines.find((l) => l.startsWith('X40'))
    expect(hole2).toBe('X20 Y0')
    expect(hole3).toBe('X40 Y0')

    // Exactly one G80 closes the cycle.
    expect(lines.filter((l) => l === 'G80')).toHaveLength(1)

    // No expanded per-move plunge spam (no G1 plunge into the work).
    expect(lines.some((l) => /^G1\b.*Z-10/.test(l))).toBe(false)
    expect(lines.some((l) => l.startsWith('G1'))).toBe(false)

    // No malformed-fallback warning for a well-formed simple cycle.
    expect(diagnostics).toHaveLength(0)
  })

  it('peck -> G83 with Q3', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const params = makeDrillParams({ cycleType: 'peck', peckDepth: 3 })
    const { lines } = emitProgram(makeDrillInput(params), UCCNC_CONFIG)
    const first = lines.find((l) => l.includes('G83'))
    expect(first).toBeDefined()
    expect(first).toContain('G83')
    expect(first).toContain('Q3')
    expect(lines.filter((l) => l === 'G80')).toHaveLength(1)
  })

  it('dwell -> G82 with P500 (0.5 s -> 500 ms on UCCNC)', () => {
    const params = makeDrillParams({ cycleType: 'dwell', dwell: 0.5 })
    const { lines } = emitProgram(makeDrillInput(params), UCCNC_CONFIG)
    const first = lines.find((l) => l.includes('G82'))
    expect(first).toBeDefined()
    expect(first).toContain('G82')
    expect(first).toContain('P500')
    expect(first).not.toContain('P0.5')
  })

  it('retractMode retract -> G99', () => {
    const params = makeDrillParams({ retractMode: 'retract' })
    const { lines } = emitProgram(makeDrillInput(params), UCCNC_CONFIG)
    const first = lines.find((l) => l.includes('G81'))
    expect(first).toBeDefined()
    expect(first).toContain('G99')
    expect(first).not.toContain('G98')
  })

  it('per-hole differing bottoms -> the changed hole re-emits its Z', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // h1 -> -4, h2 -> -7, h3 missing -> op bottom -10.
    const params = makeDrillParams()
    const { lines } = emitProgram(
      makeDrillInput(params, { h1: -4, h2: -7 }),
      UCCNC_CONFIG,
    )
    // First hole defines Z-4 on the G81 line.
    const first = lines.find((l) => l.includes('G81'))
    expect(first).toContain('Z-4')
    // Hole 2 differs -> re-emits Z-7. Hole 3 differs -> re-emits Z-10.
    const hole2 = lines.find((l) => l.startsWith('X20'))
    const hole3 = lines.find((l) => l.startsWith('X40'))
    expect(hole2).toBe('X20 Y0 Z-7')
    expect(hole3).toBe('X40 Y0 Z-10')
  })

  it('chip_break -> NO canned cycle (no G73/G81/G80), expanded G1 plunge present, no error diag', () => {
    const params = makeDrillParams({ cycleType: 'chip_break' })
    const { lines, diagnostics } = emitProgram(makeDrillInput(params), UCCNC_CONFIG)
    expect(lines.some((l) => l.includes('G73'))).toBe(false)
    expect(lines.some((l) => l.includes('G81'))).toBe(false)
    expect(lines.some((l) => l === 'G80')).toBe(false)
    // The expanded linear plunge stream IS emitted as the fall-through.
    expect(lines.some((l) => l.startsWith('G1'))).toBe(true)
    // chip_break is an EXPECTED signal -> no diagnostic at all.
    expect(diagnostics).toHaveLength(0)
  })
})

// ── GRBL: no canned cycles -> unchanged expanded fallback ─────────────────────

describe('emitProgram — drill expanded fallback (GRBL, no canned cycles)', () => {
  it('simple drill -> NO G81/G83/G80; expanded G1 plunge lines ARE present', () => {
    const params = makeDrillParams()
    const { lines } = emitProgram(makeDrillInput(params), GRBL_CONFIG)
    expect(lines.some((l) => l.includes('G81'))).toBe(false)
    expect(lines.some((l) => l.includes('G83'))).toBe(false)
    expect(lines.some((l) => l === 'G80')).toBe(false)
    // The fully expanded linear stream emits G1 plunge moves.
    expect(lines.some((l) => l.startsWith('G1'))).toBe(true)
  })

  it('dwell drill on GRBL stays expanded (cannedCycles false), no G82', () => {
    const params = makeDrillParams({ cycleType: 'dwell', dwell: 0.5 })
    const cfg = withOptions(GRBL_CONFIG, {})
    const { lines } = emitProgram(makeDrillInput(params), cfg)
    expect(lines.some((l) => l.includes('G82'))).toBe(false)
    expect(lines.some((l) => l.startsWith('G1'))).toBe(true)
  })
})
