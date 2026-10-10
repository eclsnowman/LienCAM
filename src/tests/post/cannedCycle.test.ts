import { describe, it, expect, vi, afterEach } from 'vitest'
import { reconstructDrillCycles } from '../../lib/post/cannedCycle'
import { buildDrillToolpath } from '../../lib/cam/drill2d'
import type { DrillParams, DrillWorkerPayload, LoopData } from '../../lib/cam/types'
import type { Operation, Tool, HeightParams, PassParams, LinkingParams, ToolpathMove } from '../../types'

// ── Fixtures (mirrors src/tests/cam/drill2d.test.ts) ────────────────────────────
// Three holes on the X axis (sortStrategy 'by_x' keeps order deterministic):
//   h1 @ x=0, h2 @ x=20, h3 @ x=40.
// Heights: clearance 10, retract 5, feed 1, top 0, bottom -10 (absolute).
// plungeRate (feed of plunge moves) = 150 from the tool default.

function makeTool(): Tool {
  return {
    id: 't1', name: 'Ø5 drill', type: 'drill',
    diameter: 5, fluteLength: 30, shankDiameter: 5, overallLength: 60,
    numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
    feedsAndSpeeds: { default: { rpm: 8000, feedRate: 600, plungeRate: 150, depthOfCut: 5, stepover: 2 } },
  } as Tool
}

function makeHeights(bottom = -10): HeightParams {
  return {
    clearanceHeight: 10, clearanceHeightMode: 'absolute',
    retractHeight: 5, feedHeight: 1,
    topHeight: 0, topHeightMode: 'absolute',
    bottomHeight: bottom, bottomHeightMode: 'absolute',
  }
}

const passes: PassParams = {
  stepdown: 5, stepover: 2, stockToLeave: 0, finishPasses: 0, springPasses: 0,
}

const linking: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
}

function holeLoop(id: string, cx: number, cy = 0): LoopData {
  const s = 2
  return { id, closed: true, type: 'contour', points: [
    { x: cx - s, y: cy - s }, { x: cx + s, y: cy - s },
    { x: cx + s, y: cy + s }, { x: cx - s, y: cy + s },
  ] }
}

const LOOPS = [holeLoop('h1', 0), holeLoop('h2', 20), holeLoop('h3', 40)]

function makeDrillParams(over: Partial<DrillParams> = {}): DrillParams {
  return {
    geometryId: 'g1', loopIds: [],
    cycleType: 'simple', peckDepth: 3, chipBreakRetract: 1, dwell: 0,
    retractMode: 'clearance', sortStrategy: 'by_x',
    ...over,
  }
}

function makePayload(
  params: DrillParams,
  holeBottoms?: { [loopId: string]: number },
  wcsZ = 0,
): DrillWorkerPayload {
  return {
    opId: 'op', setupId: 'su', params, heights: makeHeights(), passes, linking,
    tool: makeTool(), loops: LOOPS, wcsOrigin: { x: 0, y: 0, z: wcsZ },
    ...(holeBottoms ? { holeBottoms } : {}),
  }
}

// Build an Operation wrapper carrying the same DrillParams under op.params.
function makeOp(params: DrillParams): Operation {
  return {
    id: 'op', name: 'Drill', type: 'drill', enabled: true, status: 'pending',
    toolId: 't1', geometrySelections: [], heights: makeHeights(), passes, linking,
    params: params as unknown as Record<string, unknown>,
  } as Operation

}

afterEach(() => {
  vi.restoreAllMocks()
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('reconstructDrillCycles', () => {
  it('(1) simple -> G81 with correct holes, R plane, initialZ, feed; no peckQ/dwellSec', () => {
    const params = makeDrillParams()
    const moves = buildDrillToolpath(makePayload(params))
    const res = reconstructDrillCycles(makeOp(params), moves)

    expect(res.ok).toBe(true)
    if (!res.ok) return
    const p = res.program
    expect(p.gWord).toBe('G81')
    expect(p.returnMode).toBe('G98')          // retractMode 'clearance'
    expect(p.initialZ).toBe(10)               // clearance plane
    expect(p.rPlaneZ).toBe(1)                 // feed height
    expect(p.feed).toBe(150)                  // plungeRate
    expect(p.holes).toEqual([
      { x: 0, y: 0, bottomZ: -10 },
      { x: 20, y: 0, bottomZ: -10 },
      { x: 40, y: 0, bottomZ: -10 },
    ])
    expect(p.peckQ).toBeUndefined()
    expect(p.dwellSec).toBeUndefined()
  })

  it('(2) peck -> G83 with peckQ = peckDepth', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const params = makeDrillParams({ cycleType: 'peck', peckDepth: 3 })
    const moves = buildDrillToolpath(makePayload(params))
    const res = reconstructDrillCycles(makeOp(params), moves)

    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.program.gWord).toBe('G83')
    expect(res.program.peckQ).toBe(3)
    expect(res.program.dwellSec).toBeUndefined()
    // Each hole still reaches its own bottom (min plunge Z), regardless of pecks.
    expect(res.program.holes.map(h => h.bottomZ)).toEqual([-10, -10, -10])
  })

  it('(3) dwell -> G82 with dwellSec = params.dwell (seconds)', () => {
    const params = makeDrillParams({ cycleType: 'dwell', dwell: 0.5 })
    const moves = buildDrillToolpath(makePayload(params))
    const res = reconstructDrillCycles(makeOp(params), moves)

    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.program.gWord).toBe('G82')
    expect(res.program.dwellSec).toBe(0.5)
    expect(res.program.peckQ).toBeUndefined()
  })

  it('(4) chip_break -> ok:false DRILL_CHIP_BREAK_EXPANDED (expected signal)', () => {
    const params = makeDrillParams({ cycleType: 'chip_break' })
    const moves = buildDrillToolpath(makePayload(params))
    const res = reconstructDrillCycles(makeOp(params), moves)

    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('DRILL_CHIP_BREAK_EXPANDED')
    expect(res.message.length).toBeGreaterThan(0)
  })

  it('(5) returnMode: clearance -> G98, retract -> G99', () => {
    const pClear = makeDrillParams({ retractMode: 'clearance' })
    const rClear = reconstructDrillCycles(makeOp(pClear), buildDrillToolpath(makePayload(pClear)))
    expect(rClear.ok).toBe(true)
    if (rClear.ok) expect(rClear.program.returnMode).toBe('G98')

    const pRetract = makeDrillParams({ retractMode: 'retract' })
    const rRetract = reconstructDrillCycles(makeOp(pRetract), buildDrillToolpath(makePayload(pRetract)))
    expect(rRetract.ok).toBe(true)
    if (rRetract.ok) {
      expect(rRetract.program.returnMode).toBe('G99')
      // initialZ stays the clearance plane (first + final rapids reach Z=10).
      expect(rRetract.program.initialZ).toBe(10)
      expect(rRetract.program.rPlaneZ).toBe(1)
    }
  })

  it('(6) per-hole differing holeBottoms reflected in holes[].bottomZ', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const params = makeDrillParams()
    // h1 -> -4, h2 -> -7, h3 missing -> op bottom -10.
    const moves = buildDrillToolpath(makePayload(params, { h1: -4, h2: -7 }))
    const res = reconstructDrillCycles(makeOp(params), moves)

    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.program.holes).toEqual([
      { x: 0, y: 0, bottomZ: -4 },
      { x: 20, y: 0, bottomZ: -7 },
      { x: 40, y: 0, bottomZ: -10 },
    ])
  })

  it('(7) malformed move array -> ok:false DRILL_CYCLE_MALFORMED', () => {
    const params = makeDrillParams()
    // A stream with rapids only, no plunge moves at all.
    const bad: ToolpathMove[] = [
      { type: 'rapid', x: 0, y: 0, z: 10, role: 'rapid' },
      { type: 'rapid', x: 20, y: 0, z: 10, role: 'rapid' },
    ]
    const res = reconstructDrillCycles(makeOp(params), bad)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('DRILL_CYCLE_MALFORMED')
  })

  it('(7b) empty move array -> ok:false DRILL_CYCLE_MALFORMED', () => {
    const params = makeDrillParams()
    const res = reconstructDrillCycles(makeOp(params), [])
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('DRILL_CYCLE_MALFORMED')
  })
})
