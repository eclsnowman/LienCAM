import { describe, it, expect, vi } from 'vitest'
import { postProgram } from '../../lib/post/index'
import { UCCNC_CONFIG } from '../../lib/post/dialects/uccnc'
import { LINUXCNC_CONFIG } from '../../lib/post/dialects/linuxcnc'
import { buildSyntheticInput } from './fixtures/syntheticSetup'
import { buildDrillToolpath } from '../../lib/cam/drill2d'
import { resolveFeedrates } from '../../lib/cam/feedrates'
import { resolveSpindle, resolveCoolant } from '../../lib/post/resolve'
import { makeMachine, makeWcs } from './helpers'
import type { PostInput, PostOperation } from '../../lib/post/types'
import type { DrillParams, DrillWorkerPayload, LoopData } from '../../lib/cam/types'
import type {
  Operation,
  Tool,
  HeightParams,
  PassParams,
  LinkingParams,
} from '../../types'

// ============================================================================
// LinuxCNC inherits UCCNC's hardware validation by MOTION-EQUIVALENCE.
// ============================================================================
//
// WHY THIS TEST EXISTS
// --------------------
// Operator has NO LinuxCNC loader/sim in his shop -- only UCCNC and GRBL hardware.
// The project therefore validates LinuxCNC OUTPUT indirectly: it proves that the
// MOTION lines (G0/G1/G2/G3, canned cycles, all coordinates/feeds) that LinuxCNC
// emits are BYTE-IDENTICAL to the hardware-validated UCCNC output. The ONLY thing
// that legitimately differs between the two dialects is COMMENT SYNTAX:
//   - UCCNC comments are parenthesised:   ( like this )
//   - LinuxCNC comments are semicolon:    ; like this
// Strip the comments from both, compare the remaining motion lines, and they must
// match exactly. If they ever diverge for a non-dwell job, UCCNC's bench-proven
// validation no longer transfers to LinuxCNC -- a real regression worth a CI fail.
//
// This check used to be a hand-run diff. This test makes it a PERMANENT GATE.
//
// THE ONE LEGITIMATE DIVERGENCE -- DWELL UNITS (do NOT add dwell jobs here)
// ------------------------------------------------------------------------
// The G4 / G82 dwell P-word is the single deliberate dialect difference:
//   - UCCNC    caps.dwellUnits === 'ms'  -> P is in MILLISECONDS (0.5s -> P500)
//   - LinuxCNC caps.dwellUnits === 's'   -> P is in SECONDS      (0.5s -> P0.5)
// A job that emits a dwell (a G82 'dwell' drill cycle, or any config with
// options.dwellMs > 0) WILL legitimately differ in its MOTION lines and MUST NOT
// be asserted equivalent. Every job used in the equivalence assertions below is
// DWELL-FREE: the default UCCNC_CONFIG / LINUXCNC_CONFIG do not set a settle
// dwell (options.dwellMs === 0), and the drill fixtures use 'peck' and 'simple'
// cycles (never 'dwell'). The negative/guard test at the bottom builds a 'dwell'
// job ON PURPOSE and asserts the motion lines DIFFER -- documenting that the
// exclusion is intentional. If a future dev adds a dwell job here and sees this
// suite fail, the failure is EXPECTED, not a regression: dwell is excluded by
// design. Move the dwell job to the guard test, do not weaken the equivalence.

// ── stripComments: return MOTION lines only ─────────────────────────────────
// Mirrors the by-hand method (`grep -vE` of comment lines), but is robust to
// INLINE comments too:
//   - 'paren':     remove every  ( ... )  span anywhere on the line.
//   - 'semicolon': cut from the first  ;  to end-of-line.
// Then trim each line and DROP blank lines, so a line that was comment-only
// vanishes entirely and what remains is pure motion.
function stripComments(text: string, style: 'paren' | 'semicolon'): string[] {
  return text
    .split('\n')
    .map((line) => {
      const stripped =
        style === 'paren' ? line.replace(/\([^)]*\)/g, '') : line.replace(/;.*$/, '')
      return stripped.trim()
    })
    .filter((line) => line.length > 0)
}

// ── Drill fixture (copied from src/tests/post/drill-emit.test.ts) ────────────
// Three holes on the X axis at x = 0, 20, 40. Heights: clearance 10, retract 5,
// feed 1, top 0, bottom -10. NO dwell -- cycleType is 'peck' or 'simple' only.

function makeDrillTool(): Tool {
  return {
    id: 't1',
    name: 'D5 drill',
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

function makePayload(params: DrillParams): DrillWorkerPayload {
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
  }
}

function makeDrillOp(params: DrillParams): Operation {
  const moves = buildDrillToolpath(makePayload(params))
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

function makeDrillInput(params: DrillParams): PostInput {
  const op = makeDrillOp(params)
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

// Linear-only clones of the real configs. The synthetic all-roles fixture is
// sparsely sampled so its straight runs collapse cleanly; arcs:false pins the
// pure-linear motion path for the (a) linear-job equivalence assertion.
const UCCNC_LINEAR = {
  ...UCCNC_CONFIG,
  capabilities: { ...UCCNC_CONFIG.capabilities, arcs: false },
}
const LINUXCNC_LINEAR = {
  ...LINUXCNC_CONFIG,
  capabilities: { ...LINUXCNC_CONFIG.capabilities, arcs: false },
}

// ── The equivalence gate ────────────────────────────────────────────────────

describe('LinuxCNC motion-equivalence to UCCNC (comments-stripped)', () => {
  // Sanity: stripComments removes comments and blank lines, keeps motion.
  it('stripComments drops paren/semicolon comments and blank lines', () => {
    expect(stripComments('G0 X1 ( go ) Y2', 'paren')).toEqual(['G0 X1  Y2'])
    expect(stripComments('( whole-line comment )', 'paren')).toEqual([])
    expect(stripComments('G1 X3 ; feed in', 'semicolon')).toEqual(['G1 X3'])
    expect(stripComments('; whole-line comment', 'semicolon')).toEqual([])
    expect(stripComments('G0 X1\n\n  \nG1 X2', 'paren')).toEqual(['G0 X1', 'G1 X2'])
  })

  // (a) LINEAR job: every MoveRole, two-tool change, world->work transform.
  it('linear all-roles job: UCCNC motion === LinuxCNC motion', () => {
    const u = postProgram(buildSyntheticInput(), UCCNC_LINEAR)
    const l = postProgram(buildSyntheticInput(), LINUXCNC_LINEAR)
    expect(u.ok).toBe(true)
    expect(l.ok).toBe(true)
    expect(stripComments(u.gcode, 'paren')).toEqual(
      stripComments(l.gcode, 'semicolon'),
    )
  })

  // (b) ARC job: real arcs-ON configs, so G2/G3 with I/J center offsets are
  // exercised. (Dwell-free: neither config sets options.dwellMs.)
  it('arc job (arcs ON): UCCNC motion === LinuxCNC motion (G2/G3 IJK)', () => {
    const u = postProgram(buildSyntheticInput(), UCCNC_CONFIG)
    const l = postProgram(buildSyntheticInput(), LINUXCNC_CONFIG)
    expect(u.ok).toBe(true)
    expect(l.ok).toBe(true)
    const uMotion = stripComments(u.gcode, 'paren')
    const lMotion = stripComments(l.gcode, 'semicolon')
    // Guard the test itself: confirm arcs actually emitted (else equality is
    // trivially true for the linear subset and the IJK path went uncovered).
    expect(uMotion.some((line) => /\bG[23]\b/.test(line))).toBe(true)
    expect(uMotion.some((line) => /\bI/.test(line) || /\bJ/.test(line))).toBe(true)
    expect(uMotion).toEqual(lMotion)
  })

  // (c) DRILL peck + simple job (NO dwell): canned-cycle motion lines match.
  it('drill peck+simple job (no dwell): UCCNC motion === LinuxCNC motion', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const cycleType of ['peck', 'simple'] as const) {
      const params = makeDrillParams({ cycleType })
      const u = postProgram(makeDrillInput(params), UCCNC_CONFIG)
      const l = postProgram(makeDrillInput(params), LINUXCNC_CONFIG)
      expect(u.ok).toBe(true)
      expect(l.ok).toBe(true)
      expect(stripComments(u.gcode, 'paren')).toEqual(
        stripComments(l.gcode, 'semicolon'),
      )
    }
    vi.restoreAllMocks()
  })
})

// ── NEGATIVE / GUARD: the dwell divergence is INTENTIONAL ────────────────────
// This is the documentation-as-a-test of the one legitimate divergence. A G82
// 'dwell' cycle of 0.5 s emits P500 on UCCNC (ms) and P0.5 on LinuxCNC (s), so
// the MOTION lines MUST differ. This proves WHY dwell jobs are excluded from the
// equivalence gate above: their divergence is a known, deliberate dialect
// difference (caps.dwellUnits), NOT a regression the equivalence test should
// ever try to cover. If you make this test pass by making the two equal, you
// have broken the dwell-units contract -- stop and reconsider.
describe('dwell divergence is intentional (excluded from equivalence)', () => {
  it('G82 dwell 0.5s: UCCNC P500 (ms) vs LinuxCNC P0.5 (s) -> motion DIFFERS', () => {
    const params = makeDrillParams({ cycleType: 'dwell', dwell: 0.5 })
    const u = postProgram(makeDrillInput(params), UCCNC_CONFIG)
    const l = postProgram(makeDrillInput(params), LINUXCNC_CONFIG)
    expect(u.ok).toBe(true)
    expect(l.ok).toBe(true)

    const uMotion = stripComments(u.gcode, 'paren')
    const lMotion = stripComments(l.gcode, 'semicolon')

    // The motion lines are NOT equal -- this is the whole point.
    expect(uMotion).not.toEqual(lMotion)

    // Pin the exact reason: UCCNC carries P500 (ms), LinuxCNC carries P0.5 (s).
    const uG82 = uMotion.find((line) => line.includes('G82'))
    const lG82 = lMotion.find((line) => line.includes('G82'))
    expect(uG82).toBeDefined()
    expect(lG82).toBeDefined()
    expect(uG82).toContain('P500')
    expect(uG82).not.toContain('P0.5')
    expect(lG82).toContain('P0.5')
    expect(lG82).not.toContain('P500')
  })
})
