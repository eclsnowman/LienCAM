import { describe, it, expect } from 'vitest'
import { buildContourToolpath } from '../../lib/cam/contour2d'
import { ensureClipperReady } from '../../lib/cam/face2d/clipperOffset'
import type { ContourParams, ContourWorkerPayload, LoopData } from '../../lib/cam/types'
import type { Tool, HeightParams, PassParams, LinkingParams } from '../../types'

// Contour offsets now route through the clipper2-wasm offsetter (loaded once,
// async). Init it before any suite runs — top-level await completes before the
// describe bodies (mirrors face2d.test.ts).
await ensureClipperReady()

// ── Fixtures ───────────────────────────────────────────────────────────────────
// A single closed square 40x40 (x0..40, y0..40) cut on the outside with a Ø6
// (R3) flat end mill. Heights give a multi-stepdown cut (top 0 → bottom -6 at
// 2 mm stepdown → 3 depth levels) so the per-stepdown finish has multiple levels
// to act on.

type Pt2 = { x: number; y: number }

const TOOL_R = 3

function makeTool(): Tool {
  return {
    id: 't1', name: 'O6 flat', type: 'flat_end_mill',
    diameter: TOOL_R * 2, fluteLength: 20, shankDiameter: 6, overallLength: 60,
    numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
    feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 2, stepover: 1.5 } },
  } as Tool
}

// top 0, bottom -6 → with 2 mm stepdown buildDepths yields [-2, -4, -6] (3 levels)
function makeHeights(): HeightParams {
  return {
    clearanceHeight: 10, clearanceHeightMode: 'absolute',
    retractHeight: 5, feedHeight: 1,
    topHeight: 0, topHeightMode: 'absolute',
    bottomHeight: -6, bottomHeightMode: 'absolute',
  }
}

const linking: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
}

function makePasses(over: Partial<PassParams> = {}): PassParams {
  return {
    stepdown: 2, stepover: 1.5, stockToLeave: 0, finishPasses: 0, springPasses: 0,
    ...over,
  }
}

function makeContourParams(over: Partial<ContourParams> = {}): ContourParams {
  return {
    side: 'outer', direction: 'climb', geometryId: 'g', loopIds: [],
    tabs: false,
    ...over,
  }
}

function squareLoop(): LoopData {
  return {
    id: 'sq', closed: true, type: 'contour',
    points: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 }] as Pt2[],
  }
}

function makePayload(params: ContourParams, passes: PassParams, heights = makeHeights()): ContourWorkerPayload {
  return {
    opId: 'op', setupId: 'su', params, heights, passes, linking,
    tool: makeTool(), loops: [squareLoop()], wcsOrigin: { x: 0, y: 0, z: 0 },
  }
}

// Finish-pass entries are tagged role 'lead_in' (the loftBridge samples for the
// roughing→finish bridge, and the plungeTo lead-in for a fresh finish entry).
// Counting them gives an unambiguous proxy for "how many finish entries fired".
function leadInCount(moves: { role?: string }[]): number {
  return moves.filter(m => m.role === 'lead_in').length
}

describe('contour2d — pass mode matrix', () => {
  it('THROWS when no cutting mode is selected (rough off + finish off)', () => {
    const payload = makePayload(makeContourParams(), makePasses({ stockToLeave: 0, finishPasses: 0 }))
    expect(() => buildContourToolpath(payload)).toThrow(/no cutting mode selected/i)
  })

  it('zero-depths guard does not over-fire on a degenerate top===bottom cut', () => {
    // The plan asked for a "zero-stepdown throws" case. In the current code the
    // loud throw guards depths.length === 0, but buildDepths ALWAYS appends
    // bottomZ, so a normal heights/stepdown config can never make that array
    // empty (min length 1). The genuine no-cut config is the no-mode case above,
    // which DOES throw. Here we assert the complementary fact: a degenerate
    // top===bottom cut (single zero-thickness depth) with a finish enabled still
    // emits moves and does NOT trip the zero-depths guard — confirming the guard
    // is correctly scoped and does not over-fire.
    const heights: HeightParams = {
      clearanceHeight: 10, clearanceHeightMode: 'absolute',
      retractHeight: 5, feedHeight: 1,
      topHeight: 0, topHeightMode: 'absolute',
      bottomHeight: 0, bottomHeightMode: 'absolute',
    }
    const payload = makePayload(makeContourParams(), makePasses({ finishPasses: 1 }), heights)
    const moves = buildContourToolpath(payload)
    expect(moves.length).toBeGreaterThan(0)
  })

  it('MODE: cut-at-geometry (rough off / finish on) produces moves', () => {
    const payload = makePayload(makeContourParams(), makePasses({ stockToLeave: 0, finishPasses: 1 }))
    const moves = buildContourToolpath(payload)
    expect(moves.length).toBeGreaterThan(0)
    expect(leadInCount(moves)).toBeGreaterThan(0)
  })

  it('MODE: roughing-only (rough on / finish off) produces moves', () => {
    const payload = makePayload(makeContourParams(), makePasses({ stockToLeave: 0.5, finishPasses: 0 }))
    const moves = buildContourToolpath(payload)
    expect(moves.length).toBeGreaterThan(0)
  })

  it('MODE: rough + finish at final depth produces moves', () => {
    const payload = makePayload(
      makeContourParams({ contourFinishMode: 'final' }),
      makePasses({ stockToLeave: 0.5, finishPasses: 1 }),
    )
    const moves = buildContourToolpath(payload)
    expect(moves.length).toBeGreaterThan(0)
  })

  it('MODE: rough + finish at each stepdown produces moves', () => {
    const payload = makePayload(
      makeContourParams({ contourFinishMode: 'each_stepdown' }),
      makePasses({ stockToLeave: 0.5, finishPasses: 1 }),
    )
    const moves = buildContourToolpath(payload)
    expect(moves.length).toBeGreaterThan(0)
  })

  it("'final' is byte-identical to undefined contourFinishMode (default)", () => {
    const undefinedMode = buildContourToolpath(makePayload(
      makeContourParams(),                              // contourFinishMode undefined
      makePasses({ stockToLeave: 0.5, finishPasses: 1 }),
    ))
    const finalMode = buildContourToolpath(makePayload(
      makeContourParams({ contourFinishMode: 'final' }),
      makePasses({ stockToLeave: 0.5, finishPasses: 1 }),
    ))
    expect(finalMode).toEqual(undefinedMode)
    expect(finalMode.length).toBe(undefinedMode.length)
    expect(leadInCount(finalMode)).toBe(leadInCount(undefinedMode))
  })

  it("'each_stepdown' yields MORE finish moves than 'final' on a multi-stepdown cut", () => {
    const finalMode = buildContourToolpath(makePayload(
      makeContourParams({ contourFinishMode: 'final' }),
      makePasses({ stockToLeave: 0.5, finishPasses: 1 }),
    ))
    const eachMode = buildContourToolpath(makePayload(
      makeContourParams({ contourFinishMode: 'each_stepdown' }),
      makePasses({ stockToLeave: 0.5, finishPasses: 1 }),
    ))
    // each_stepdown adds a full finish loop at every intermediate depth.
    expect(eachMode.length).toBeGreaterThan(finalMode.length)
    expect(leadInCount(eachMode)).toBeGreaterThan(leadInCount(finalMode))
  })
})

describe('contour2d tool-hand direction', () => {
  const build = (direction: 'climb' | 'conventional', cutHand: 'right' | 'left') => {
    const p = makePayload(
      makeContourParams({ direction }),
      makePasses({ stockToLeave: 0, finishPasses: 1 }),
    )
    p.tool = { ...p.tool, cutHand }
    return buildContourToolpath(p)
  }

  it('reverses the CW planner winding for a left-hand cutter', () => {
    const rightClimb = build('climb', 'right')
    const rightConventional = build('conventional', 'right')
    expect(rightClimb).not.toEqual(rightConventional)
    expect(build('climb', 'left')).toEqual(rightConventional)
    expect(build('conventional', 'left')).toEqual(rightClimb)
  })
})

// ── Multi-region (clipper offsetLoop splits the part into 2+ disjoint loops) ─────
//
// An hourglass outline cut on the INSIDE: a sufficiently large inward offset
// pinches the interior into two disjoint regions. clipper's offsetLoop returns
// the two sub-loops; the contour generator must cut BOTH regions and reposition
// (retract → rapid at clearance) between the islands.

describe('contour2d — multi-region', () => {
  // Diagonal-walled waist so the inward offset self-crosses TRANSVERSELY (a
  // collinear pinch would not split). At R3 inner: finish offset (-3) and rough
  // offset (-5 with stockToLeave 2) both split into 2 sub-loops.
  function hourglassLoop(): LoopData {
    return {
      id: 'hg', closed: true, type: 'contour',
      points: [
        { x: 0,   y: 0 },
        { x: 40,  y: 0 },
        { x: 56,  y: 18 },
        { x: 64,  y: 18 },
        { x: 80,  y: 0 },
        { x: 120, y: 0 },
        { x: 120, y: 40 },
        { x: 80,  y: 40 },
        { x: 64,  y: 22 },
        { x: 56,  y: 22 },
        { x: 40,  y: 40 },
        { x: 0,   y: 40 },
      ] as Pt2[],
    }
  }

  function makeHourglassPayload(params: ContourParams, passes: PassParams): ContourWorkerPayload {
    return {
      opId: 'op', setupId: 'su', params, heights: makeHeights(), passes, linking,
      tool: makeTool(), loops: [hourglassLoop()], wcsOrigin: { x: 0, y: 0, z: 0 },
    }
  }

  // A reposition between regions = a rapid up to clearanceZ (10) immediately
  // followed by a rapid back down to clearanceZ at a NEW xy (next region's
  // rapidEntry first move is also at clearanceZ). Count clearance-height rapids
  // as a robust proxy for "entered/left an island".
  function clearanceRapids(moves: { type?: string; z?: number; role?: string }[]): number {
    return moves.filter(m => m.type === 'rapid' && m.role === 'rapid' && m.z === 10).length
  }

  it('cuts BOTH disjoint regions when a large inner offset pinches the part', () => {
    const payload = makeHourglassPayload(
      makeContourParams({ side: 'inner' }),
      makePasses({ stockToLeave: 2, finishPasses: 1 }),
    )
    const moves = buildContourToolpath(payload)
    expect(moves.length).toBeGreaterThan(0)

    // Cutting must happen on BOTH the left (x < 60) and right (x > 60) lobe.
    const cuts = moves.filter(m => m.role === 'cut')
    const leftCuts  = cuts.filter(m => m.x < 60).length
    const rightCuts = cuts.filter(m => m.x > 60).length
    expect(leftCuts).toBeGreaterThan(0)
    expect(rightCuts).toBeGreaterThan(0)
  })

  it('retracts + repositions (rapid at clearance) between the two islands', () => {
    const payload = makeHourglassPayload(
      makeContourParams({ side: 'inner' }),
      makePasses({ stockToLeave: 2, finishPasses: 1 }),
    )
    const moves = buildContourToolpath(payload)

    // Each region does its own rapidEntry (3 clearance-or-lower rapids incl. one
    // at clearance) + retractFrom (one rapid back to clearance). With 2 rough
    // regions x 3 depths and 2 finish regions, there are MANY clearance rapids;
    // a single-region cut would have far fewer. Assert there is more than one
    // island-entry/exit cycle.
    expect(clearanceRapids(moves)).toBeGreaterThan(2)

    // Finish entries fire once per finish region -> >1 lead_in means 2 islands.
    expect(leadInCount(moves)).toBeGreaterThan(1)
  })

  it('SINGLE-region (clean offset) is unchanged: square outer cut still emits', () => {
    // The byte-identical guarantee for the common single-loop case lives in the
    // 'final' vs undefined test above; here we just confirm a clean square stays
    // on the single-region path (one finish entry = exactly one lead_in cluster).
    const square = buildContourToolpath(makePayload(
      makeContourParams(),                                   // outer, clean offset
      makePasses({ stockToLeave: 0, finishPasses: 1 }),
    ))
    expect(square.length).toBeGreaterThan(0)
    expect(leadInCount(square)).toBe(3)   // one plungeTo lead_in per depth (3 depths)
  })
})

// ── Per-loop multi-Z (loopBottoms) ───────────────────────────────────────────────
//
// Phase A: a contour over several picked boss tops must cut EACH loop down to ITS
// OWN bottom Z (passed as payload.loopBottoms, WCS-relative, keyed by loop id),
// instead of collapsing every loop to the shared op bottom. Absent/equal
// loopBottoms must reproduce the legacy shared-bottom path byte-for-byte.

describe('contour2d — per-loop multi-Z (loopBottoms)', () => {
  // Two well-separated squares so a clean outer offset never pinches/merges them.
  function squareAt(id: string, x0: number): LoopData {
    return {
      id, closed: true, type: 'contour',
      points: [
        { x: x0, y: 0 }, { x: x0 + 40, y: 0 },
        { x: x0 + 40, y: 40 }, { x: x0, y: 40 },
      ] as Pt2[],
    }
  }

  function twoLoopPayload(
    loopBottoms: { [id: string]: number } | undefined,
    loopIds: string[] = [],
  ): ContourWorkerPayload {
    return {
      opId: 'op', setupId: 'su',
      params: makeContourParams({ loopIds }),
      heights: makeHeights(),                 // shared op bottom = -6
      passes: makePasses({ stockToLeave: 0, finishPasses: 1 }),
      linking,
      tool: makeTool(),                       // fluteLength 20 -> no maxDepth clamp at -8
      loops: [squareAt('A', 0), squareAt('B', 60)],
      wcsOrigin: { x: 0, y: 0, z: 0 },
      ...(loopBottoms ? { loopBottoms } : {}),
    }
  }

  // Deepest (most negative) Z any move reaches.
  const minZ = (moves: { z: number }[]) => Math.min(...moves.map(m => m.z))

  it('each loop descends to ITS OWN loopBottoms Z (taller boss cuts shallower)', () => {
    // A is the "taller boss" (bottom -2, one depth level); B is deeper (-8).
    const lb = { A: -2, B: -8 }
    const aOnly = buildContourToolpath(twoLoopPayload(lb, ['A']))
    const bOnly = buildContourToolpath(twoLoopPayload(lb, ['B']))
    expect(minZ(aOnly)).toBeCloseTo(-2, 6)
    expect(minZ(bOnly)).toBeCloseTo(-8, 6)
    // The taller boss's deepest cut is strictly shallower than the deeper one.
    expect(minZ(aOnly)).toBeGreaterThan(minZ(bOnly))

    // Cut together, BOTH levels appear and the overall floor is the deeper one.
    const both = buildContourToolpath(twoLoopPayload(lb))
    expect(minZ(both)).toBeCloseTo(-8, 6)
    expect(both.some(m => Math.abs(m.z - (-2)) < 1e-6)).toBe(true)
    expect(both.some(m => Math.abs(m.z - (-8)) < 1e-6)).toBe(true)
  })

  it('omitting loopBottoms collapses both loops to the shared op bottom (-6)', () => {
    const moves = buildContourToolpath(twoLoopPayload(undefined))
    expect(minZ(moves)).toBeCloseTo(-6, 6)
  })

  it('loopBottoms equal to the shared bottom is byte-identical to omitting it', () => {
    // The depth construction was hoisted INTO the per-loop body; with a uniform
    // bottom it must recompute the EXACT same arrays as the legacy shared path.
    const legacy = buildContourToolpath(twoLoopPayload(undefined))
    const uniform = buildContourToolpath(twoLoopPayload({ A: -6, B: -6 }))
    expect(uniform).toEqual(legacy)
    expect(uniform.length).toBe(legacy.length)
  })
})
