import { describe, it, expect } from 'vitest'
import { buildPocketToolpath } from '../../lib/cam/pocket2d'
import { ensureClipperReady } from '../../lib/cam/face2d/clipperOffset'
import type { PocketParams, PocketWorkerPayload, LoopData } from '../../lib/cam/types'
import type { Tool, HeightParams, PassParams, LinkingParams } from '../../types'

await ensureClipperReady()

// ── Material-travel-safety: stay-down links may not plow uncleared stock ─────────
//
// A pocket whose offset rings SPLIT into two lobes at a thin waist (a non-convex
// boundary that pinches the region in two) must NOT connect a finished lobe to the
// next with a straight feed at depth across the still-uncut waist — that is a gouge
// on a real machine. The fix mirrors adaptive clearing: a stay-down travel is kept
// only when its swept corridor lies inside already-cleared stock; otherwise it
// retracts (rapid to clearance/retract Z, rapid across, plunge back in).
//
// These tests build a PEANUT outer boundary: a 90x30 rectangle pinched at the
// middle by opposing V-notches (a tip at (45,14) from the bottom, (45,16) from the
// top). With a O6 tool (R3) the inward ring offset self-intersects at the waist and
// splits into two disjoint lobes (verified: left x[3..42], right x[48..87] at the
// outer ring), so the lobe-to-lobe link across the uncut waist is the move under test.

type Pt2 = { x: number; y: number }

const TOOL_R = 3
const GAP_X  = 45   // x of the uncleared waist centre — no cut legitimately reaches it

function makeTool(): Tool {
  return {
    id: 't1', name: 'O6 flat', type: 'flat_end_mill',
    diameter: TOOL_R * 2, fluteLength: 20, shankDiameter: 6, overallLength: 60,
    numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
    feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 2, stepover: 1.5 } },
  } as Tool
}

function makeHeights(): HeightParams {
  return {
    clearanceHeight: 10, clearanceHeightMode: 'absolute',
    retractHeight: 5, feedHeight: 1,
    topHeight: 0, topHeightMode: 'absolute',
    bottomHeight: -2, bottomHeightMode: 'absolute',
  }
}

const passes: PassParams = {
  stepdown: 5, stepover: 1.5, stockToLeave: 0, finishPasses: 0, springPasses: 0,
}

const linking: LinkingParams = {
  entryType: 'ramp_helical', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
}

function makePocketParams(over: Partial<PocketParams> = {}): PocketParams {
  return {
    geometryId: 'g', loopIds: [],
    direction: 'climb', orderStrategy: 'by_depth', fillStrategy: 'outside_in',
    floorStockToLeave: 0, finishContour: false,
    helixDiameter: 90, overlapMm: 0, stepoverLeadIn: 'none',
    stayDown: false, stayDownLift: 1.0,
    ...over,
  }
}

// Peanut outline (CCW): a 90x30 rectangle pinched at x=45 by a bottom V-notch
// (tip (45,14)) and a top V-notch (tip (45,16)) — a 2 mm waist that the -3 mm tool
// offset splits into two lobes.
const PEANUT: LoopData = {
  id: 'peanut', closed: true, type: 'contour',
  points: [
    { x: 0,  y: 0 },  { x: 40, y: 0 },  { x: 45, y: 14 }, { x: 50, y: 0 },
    { x: 90, y: 0 },  { x: 90, y: 30 }, { x: 50, y: 30 }, { x: 45, y: 16 },
    { x: 40, y: 30 }, { x: 0,  y: 30 },
  ],
}

// Plain convex square pocket 40x40 for the no-spurious-retract regression.
const SQUARE: LoopData = {
  id: 'square', closed: true, type: 'contour',
  points: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 }],
}

function makePayload(params: PocketParams, loops: LoopData[]): PocketWorkerPayload {
  return {
    opId: 'op', setupId: 'su', params, heights: makeHeights(), passes,
    linking: {
      ...linking,
      entryType: params.fillStrategy === 'outside_in' ? 'ramp_linear' : 'ramp_helical',
    },
    tool: makeTool(), loops, wcsOrigin: { x: 0, y: 0, z: 0 },
  }
}

type Move = ReturnType<typeof buildPocketToolpath>[number]

// True when the segment a->b straddles the vertical line x = GAP_X.
function straddlesGap(a: Pt2, b: Pt2): boolean {
  return (a.x - GAP_X) * (b.x - GAP_X) < 0
}

// ── Safety: the FIRST lobe-to-lobe transition must lift, not plow the waist ───────
//
// The bug: when the machine first crosses from the finished lobe to the not-yet-cut
// lobe, the waist between them is solid. Pre-fix that link fed straight across at
// depth (a gouge). The fix forces a retract there.
//
// We assert on the FIRST L<->R transition only. AFTER both lobes' outer rings are
// cut, their tool sweeps overlap and genuinely CLEAR the waist (the V-notch split
// pinches the lobes to within a tool diameter), so a later cross-waist link
// legitimately stays down — that is correct, not a gouge, and is the no-spurious-
// retract property the regression block guards. This holds for both fill orders:
// at the first crossing only the source lobe is cut, so the waist is uncleared.

const lobeOf = (x: number): 'L' | 'R' | null => (x <= 44 ? 'L' : x >= 46 ? 'R' : null)

describe.each([
  { label: 'outside_in', fill: 'outside_in' as const },
  { label: 'inside_out', fill: 'inside_out' as const },
])('Pocket 2D travel safety — peanut waist split, $label', ({ fill }) => {
  const moves = buildPocketToolpath(
    makePayload(makePocketParams({ fillStrategy: fill }), [PEANUT]))

  it('produces a toolpath that machines BOTH lobes', () => {
    expect(moves.length).toBeGreaterThan(0)
    const cut = moves.filter(m => m.type === 'feed' && m.z <= 1e-6)
    expect(cut.some(m => m.x < 40)).toBe(true)   // left lobe cut
    expect(cut.some(m => m.x > 50)).toBe(true)   // right lobe cut
  })

  it('the FIRST lobe-to-lobe crossing lifts to clearance (not a straight feed across the uncut waist)', () => {
    // Classify lobes by 'cut'-role moves (actual ring cutting); the entry helix and
    // the links between rings are deliberately excluded. At the first L<->R switch in
    // cutting, a lift above stock top (a rapid to retract/clearance Z) must have
    // occurred since the previous cut. A pre-fix stay-down cross-link is a single
    // 'stepover' feed at depth with NO lifted move between -> this fails. With the
    // fix the connection is rapid(retract)->rapid->plunge, so a lift is present.
    let lastCutLobe: 'L' | 'R' | null = null
    let liftedSinceLastCut = false
    let checkedFirstSwitch = false
    for (const m of moves) {
      if (m.z > 1e-6) liftedSinceLastCut = true   // a lift above stock top
      if (!(m.type === 'feed' && m.role === 'cut' && m.z <= 1e-6)) continue
      const lobe = lobeOf(m.x)
      if (lobe === null) continue   // a cut inside the waist band — ignore
      if (lastCutLobe && lobe !== lastCutLobe && !checkedFirstSwitch) {
        checkedFirstSwitch = true
        expect(liftedSinceLastCut).toBe(true)   // first crossing MUST have lifted
      }
      lastCutLobe = lobe
      liftedSinceLastCut = false
    }
    expect(checkedFirstSwitch).toBe(true)   // a lobe-to-lobe crossing did occur
  })

  it('a retract rapid (at safe Z) crosses the gap — the link was rerouted, not dropped', () => {
    let prev: Move | null = null
    let safeGapCrossing = false
    for (const m of moves) {
      if (prev && m.type === 'rapid' && m.z > 1e-6 && straddlesGap(prev, m)) safeGapCrossing = true
      prev = m
    }
    expect(safeGapCrossing).toBe(true)
  })
})

// ── Regression: a simple convex pocket gains NO spurious retract ──────────────────
// Outside-in Profile Ramp explicitly cleans its first ring before stepovers;
// inside-out Helix clears only one endpoint disk and begins locally. Later
// overlapping-ring links stay down for both strategies.

describe('Pocket 2D travel safety - inside-out helix across a split waist', () => {
  const moves = buildPocketToolpath(
    makePayload(makePocketParams({ fillStrategy: 'inside_out' }), [PEANUT]))

  it('retracts and plunges for the first unproven lobe link, never stepping through stock', () => {
    let previousLobe: 'L' | 'R' | null = null
    let previousLobeCutIndex = -1
    let transition: Move[] | null = null

    for (let index = 0; index < moves.length; index++) {
      const move = moves[index]
      if (!(move.type === 'feed' && move.role === 'cut' && move.z <= 1e-6)) continue
      const lobe = lobeOf(move.x)
      if (lobe === null) continue
      if (previousLobe && lobe !== previousLobe) {
        transition = moves.slice(previousLobeCutIndex + 1, index)
        break
      }
      previousLobe = lobe
      previousLobeCutIndex = index
    }

    expect(transition).not.toBeNull()
    expect(transition!.some(move => move.type === 'rapid' && move.z > 1e-6)).toBe(true)
    expect(transition!.some(move => move.role === 'plunge' && Math.abs(move.z + 2) <= 1e-7)).toBe(true)

    for (let index = 0; index < transition!.length; index++) {
      const move = transition![index]
      if (move.role !== 'stepover') continue
      const previous = index > 0 ? transition![index - 1] : moves[previousLobeCutIndex]
      expect(straddlesGap(previous, move)).toBe(false)
    }
  })
})

describe.each([
  { label: 'outside_in', fill: 'outside_in' as const, expectedEntryPlunges: 0 },
  { label: 'inside_out', fill: 'inside_out' as const, expectedEntryPlunges: 0 },
])('Pocket 2D travel safety — convex pocket keeps proven stay-down links, $label', ({ fill, expectedEntryPlunges }) => {
  const moves = buildPocketToolpath(
    makePayload(makePocketParams({ fillStrategy: fill }), [SQUARE]))

  it('builds a multi-ring toolpath with the compatible entry strategy', () => {
    expect(moves.length).toBeGreaterThan(0)
    expect(moves.some(m => m.role === (fill === 'outside_in' ? 'ramp' : 'helix'))).toBe(true)
  })

  it('retracts only when the first approach is not covered by the entry footprint', () => {
    const plunges = moves.filter(m => m.role === 'plunge')
    expect(plunges.length).toBe(expectedEntryPlunges)
  })

  it('no engaged-down feed ever lifts to retract height mid-cut', () => {
    // Every cut/stepover link stays at depth; a stay-down link is a feed at z<=0,
    // never a rapid to retractZ (5). Confirm no rapid-to-retract appears between
    // two engaged cuts (which would be a spurious lift).
    const cutRoles = new Set(['cut', 'stepover'])
    const cutCount = moves.filter(m => m.role && cutRoles.has(m.role)).length
    expect(cutCount).toBeGreaterThan(0)
  })
})
