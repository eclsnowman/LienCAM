import { describe, expect, it } from 'vitest'
import {
  buildContourToolpath,
  buildContourTabPlan,
  sampleTabPath,
  computeContourTabPreviewLoop,
} from '../../lib/cam/contour2d'
import { ensureClipperReady } from '../../lib/cam/face2d/clipperOffset'
import type { ContourParams, ContourWorkerPayload, LoopData } from '../../lib/cam/types'
import type { HeightParams, LinkingParams, PassParams, Tool, ToolpathMove } from '../../types'

await ensureClipperReady()

const tool: Tool = {
  id: 'tool',
  name: '6 mm flat',
  type: 'flat_end_mill',
  diameter: 6,
  fluteLength: 20,
  shankDiameter: 6,
  overallLength: 60,
  numberOfFlutes: 2,
  material: 'carbide',
  coating: 'none',
  notes: '',
  feedsAndSpeeds: {
    default: {
      rpm: 10_000,
      feedRate: 1_000,
      plungeRate: 250,
      depthOfCut: 2,
      stepover: 2,
    },
  },
}

const heights: HeightParams = {
  clearanceHeight: 10,
  clearanceHeightMode: 'absolute',
  retractHeight: 5,
  feedHeight: 1,
  topHeight: 0,
  topHeightMode: 'absolute',
  bottomHeight: -6,
  bottomHeightMode: 'absolute',
}

const passes: PassParams = {
  stepdown: 2,
  stepover: 2,
  stockToLeave: 0,
  finishPasses: 2,
  springPasses: 1,
  overlapMm: 3,
}

const plunge: LinkingParams = {
  entryType: 'plunge',
  rampAngle: 3,
  rampLength: 10,
  leadInRadius: 0,
  leadOutRadius: 0,
  retractType: 'full',
  transitionType: 'safe_height',
}

const square: LoopData = {
  id: 'square',
  closed: true,
  type: 'contour',
  points: [
    { x: 0, y: 0 },
    { x: 40, y: 0 },
    { x: 40, y: 40 },
    { x: 0, y: 40 },
  ],
}

function params(overrides: Partial<ContourParams> = {}): ContourParams {
  return {
    side: 'outer',
    direction: 'climb',
    geometryId: 'geometry',
    loopIds: [],
    tabs: false,
    ...overrides,
  }
}

function payload(
  contour: ContourParams,
  overrides: Partial<ContourWorkerPayload> = {},
): ContourWorkerPayload {
  return {
    opId: 'op',
    setupId: 'setup',
    params: contour,
    heights,
    passes,
    linking: plunge,
    tool,
    loops: [square],
    wcsOrigin: { x: 0, y: 0, z: 0 },
    stockBottomZ: -6,
    ...overrides,
  }
}

function verticalTransitions(moves: ToolpathMove[]) {
  const transitions: Array<{ from: ToolpathMove; to: ToolpathMove }> = []
  for (let i = 1; i < moves.length; i++) {
    const from = moves[i - 1]
    const to = moves[i]
    if (
      from.type === 'feed' &&
      to.type === 'feed' &&
      Math.abs(from.x - to.x) < 1e-8 &&
      Math.abs(from.y - to.y) < 1e-8 &&
      Math.abs(from.z - to.z) > 1e-8
    ) {
      transitions.push({ from, to })
    }
  }
  return transitions
}

// ── Clamped-ramp verification helpers ────────────────────────────────────────
//
// These independently re-derive "what Z is safe here" from the tab plan
// (mirroring tabZAt's box/triangular formulas, which are internal to
// contour2d.ts) so the no-gouge proof below is a genuine second computation,
// not a re-check of the same code path the engine used.

/** Arc distance along `plan.path` of a point that lies ON the path (a 'cut' or
 *  'ramp' move) -- null for anything else (rapids, lead-ins). */
function arcPositionOf(
  plan: { path: { x: number; y: number }[]; cumulative: number[] },
  point: { x: number; y: number },
): number | null {
  for (let i = 0; i < plan.path.length; i++) {
    const a = plan.path[i]
    const b = plan.path[(i + 1) % plan.path.length]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const segLen2 = dx * dx + dy * dy
    if (segLen2 < 1e-12) continue
    const t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / segLen2
    if (t < -1e-6 || t > 1 + 1e-6) continue
    const projX = a.x + t * dx
    const projY = a.y + t * dy
    if (Math.hypot(point.x - projX, point.y - projY) < 1e-4) {
      return plan.cumulative[i] + Math.max(0, Math.min(1, t)) * Math.sqrt(segLen2)
    }
  }
  return null
}

/** The Z a tab retains at arc distance `s` for a pass targeting `depth` --
 *  the box/triangular formula, re-derived independently of tabZAt. Returns
 *  -Infinity outside any tab interval (no constraint there). A 1e-6 margin
 *  around each interval boundary avoids flagging the boundary point itself
 *  (where a move legitimately still sits at `depth`, an instant before/after
 *  the tab's wall) as a false gouge. */
function requiredTabZAt(
  plan: { tabTopZ: number; shape: 'box' | 'triangular'; intervals: Array<{ start: number; end: number }> },
  depth: number,
  s: number,
): number {
  if (depth >= plan.tabTopZ - 1e-6) return -Infinity
  for (const { start, end } of plan.intervals) {
    if (s > start + 1e-6 && s < end - 1e-6) {
      if (plan.shape === 'triangular') {
        const rise = Math.min(s - start, end - s)
        return Math.min(plan.tabTopZ, depth + rise)
      }
      return plan.tabTopZ
    }
  }
  return -Infinity
}

/** No-gouge proof: every cutting/ramping move must sit AT or ABOVE the tab
 *  profile at its position -- never below it by more than 1e-6. `depth`
 *  should be the deepest floor the op cuts (bottomZ): tabZAt's own box
 *  formula is depth-independent, and its triangular formula only grows
 *  taller at a deeper depth, so checking every move against the deepest
 *  floor's profile is the correct (and, for triangular, the strictest)
 *  bound whenever only the FINAL stepdown clamps -- true for every scenario
 *  below (stepdown 2, tabTopZ -4, bottom -6: only -4->-6 clamps). */
function assertNoGouge(
  moves: ToolpathMove[],
  plan: { path: { x: number; y: number }[]; cumulative: number[]; tabTopZ: number; shape: 'box' | 'triangular'; intervals: Array<{ start: number; end: number }> },
  depth: number,
) {
  let checked = 0
  for (const m of moves) {
    if (m.type !== 'feed' || (m.role !== 'cut' && m.role !== 'ramp')) continue
    const s = arcPositionOf(plan, m)
    if (s == null) continue
    checked++
    expect(m.z).toBeGreaterThanOrEqual(requiredTabZAt(plan, depth, s) - 1e-6)
  }
  expect(checked).toBeGreaterThan(0)
}

/** Horizontal (XY) distance traveled between a vertical rise (same XY, +dz)
 *  and its matching vertical fall (same XY, -dz) -- one span per box-tab
 *  crossing, regardless of whether the crossing belongs to a finishing pass
 *  or a clamped-ramp tab ride. Used to prove each crossing's extra travel is
 *  bounded by the tab's own width (computed from the plan, not hardcoded). */
function crossingSpans(moves: ToolpathMove[]): number[] {
  const spans: number[] = []
  let i = 0
  while (i < moves.length) {
    const from = moves[i - 1]
    const to = moves[i]
    if (
      from && to && from.type === 'feed' && to.type === 'feed' &&
      Math.abs(from.x - to.x) < 1e-8 && Math.abs(from.y - to.y) < 1e-8 && to.z > from.z + 1e-8
    ) {
      let dist = 0
      let j = i
      while (j + 1 < moves.length) {
        const a = moves[j]
        const b = moves[j + 1]
        if (a.type !== 'feed' || b.type !== 'feed') break
        dist += Math.hypot(b.x - a.x, b.y - a.y)
        j++
        if (Math.abs(a.x - b.x) < 1e-8 && Math.abs(a.y - b.y) < 1e-8 && b.z < a.z - 1e-8) break
      }
      spans.push(dist)
      i = j + 1
      continue
    }
    i++
  }
  return spans
}

describe('CAM-11 contour holding tabs', () => {
  it('keeps disabled/legacy output byte-compatible', () => {
    const legacy = buildContourToolpath(payload(params()))
    const explicitDisabled = buildContourToolpath(payload(params({
      tabs: false,
      tabWidth: 17,
      tabHeight: 4,
      tabCount: 9,
    })))
    expect(explicitDisabled).toEqual(legacy)
  })

  it('places deterministic even tabs and preserves them through finish and spring passes', () => {
    const moves = buildContourToolpath(payload(params({
      tabs: true,
      tabWidth: 8,
      tabHeight: 2,
      tabCount: 4,
    })))

    const transitions = verticalTransitions(moves)
    const lifts = transitions.filter(({ from, to }) =>
      Math.abs(from.z - (-6)) < 1e-8 && Math.abs(to.z - (-4)) < 1e-8)
    const returns = transitions.filter(({ from, to }) =>
      Math.abs(from.z - (-4)) < 1e-8 && Math.abs(to.z - (-6)) < 1e-8)

    // Two finish loops plus one spring loop, each retaining the same four tabs.
    expect(lifts).toHaveLength(12)
    expect(returns).toHaveLength(12)
    expect(new Set(lifts.map(({ to }) => `${to.x.toFixed(6)},${to.y.toFixed(6)}`)).size).toBe(4)

    // Lifts/traverses use cutting feed; safe returns use the tool's plunge feed.
    expect(lifts.every(({ to }) => to.feed === 1_000 && to.role === 'cut')).toBe(true)
    expect(returns.every(({ to }) => to.feed === 250 && to.role === 'cut')).toBe(true)
    expect(moves.some((move) =>
      move.type === 'feed' && move.z === -4 && move.role === 'cut')).toBe(true)
  })

  it('fails by name for unsafe or impossible tab requests', () => {
    const enabled = params({ tabs: true, tabWidth: 8, tabHeight: 2, tabCount: 4 })

    expect(() => buildContourToolpath(payload(enabled, { stockBottomZ: undefined })))
      .toThrow(/Contour tabs: stock bottom could not be resolved/i)
    expect(() => buildContourToolpath(payload(enabled, {
      heights: { ...heights, bottomHeight: -5 },
    }))).toThrow(/Contour tabs:.*not a cut-through contour/i)
    expect(() => buildContourToolpath(payload(params({
      tabs: true,
      tabWidth: 100,
      tabHeight: 2,
      tabCount: 4,
    })))).toThrow(/Contour tabs:.*do not fit/i)
    expect(() => buildContourToolpath(payload(enabled, {
      linking: { ...plunge, entryType: 'ramp_helical' },
    }))).toThrow(/Contour tabs: entry type .* is not supported/i)
    expect(() => buildContourToolpath(payload(enabled, {
      loops: [{ ...square, closed: false }],
    }))).toThrow(/no closed loop found/i)
  })

  it('allows ramp entry: rides over every tab it meets and never gouges one', () => {
    // 30 deg (the max allowed ramp angle): the tool ramps continuously from
    // feedZ through all three stepdowns (-2, -4, -6) with NO retract/re-entry
    // in between. OWNER DIRECTIVE: the below-tabTop descent is NEVER refused
    // for a tab in the way -- it rides up and over (clampedRampDescent) and
    // keeps descending once clear. At this steep angle the descent completes
    // well before it ever needs to clamp, so the ramp behaves exactly as the
    // old unconstrained ramp always did.
    const moves = buildContourToolpath(payload(
      params({ tabs: true, tabWidth: 8, tabHeight: 2, tabCount: 4 }),
      { linking: { ...plunge, entryType: 'ramp_linear', rampAngle: 30 } },
    ))

    // No wasted per-depth re-entry: ONE entry rapid group (3 rapids: clearance
    // -> retract -> feed) at the very start, ONE final retract group (2
    // rapids: retract -> clearance) at the very end -- 5 total, same as the
    // non-tab continuous ramp case.
    const rapids = moves.filter((m) => m.type === 'rapid')
    expect(rapids).toHaveLength(5)

    const ramps = moves.filter((m) => m.role === 'ramp')
    expect(ramps.length).toBeGreaterThan(0)

    // Tabs are still fully retained: 2 finish + 1 spring loops x 4 tabs each,
    // exactly as with plunge entry.
    const transitions = verticalTransitions(moves)
    const lifts = transitions.filter(({ from, to }) =>
      Math.abs(from.z - (-6)) < 1e-8 && Math.abs(to.z - (-4)) < 1e-8)
    const returns = transitions.filter(({ from, to }) =>
      Math.abs(from.z - (-4)) < 1e-8 && Math.abs(to.z - (-6)) < 1e-8)
    expect(lifts).toHaveLength(12)
    expect(returns).toHaveLength(12)

    // NO-GOUGE PROOF: every cutting/ramping move sits at or above the tab
    // profile at its own position, independently re-derived from the plan
    // (not a re-check of tabZAt itself).
    const plan = buildContourTabPlan(
      computeContourTabPreviewLoop(square.points, 'outer', 'climb', tool.diameter)!.path,
      { width: 8, count: 4, tabTopZ: -4, stockBottomZ: -6, shape: 'box' },
    )
    assertNoGouge(moves, plan, -6)

    // Each box-tab crossing (ramp-induced or finish-pass) travels exactly the
    // tab's own width across it -- no extra wandering.
    for (const span of crossingSpans(moves)) {
      expect(span).toBeCloseTo(8, 3)
    }

    // Each entry's ramp (a contiguous run of ramp moves) descends
    // monotonically to its cut depth; separate depths re-enter from feed
    // height, so monotonicity only holds within a run.
    for (let i = 1; i < moves.length; i++) {
      if (moves[i].role === 'ramp' && moves[i - 1].role === 'ramp') {
        expect(moves[i].z).toBeLessThanOrEqual(moves[i - 1].z + 1e-9)
      }
    }
  })

  it('continuous ramp+tabs descent wastes no travel: one entry, one retract, exact arc length', () => {
    // Same 15 deg / 3-depth (-2, -4, -6) setup as the safety test above, but
    // this test is specifically about the WASTE elimination: the old code
    // re-entered (rapid + fresh seam-anchored ramp) at every one of the 3
    // depths and retracted after every one; the fix carries the tool straight
    // through all 3 stepdowns on one continuous ramp.
    const moves = buildContourToolpath(payload(
      params({ tabs: true, tabWidth: 8, tabHeight: 2, tabCount: 4 }),
      { linking: { ...plunge, entryType: 'ramp_linear', rampAngle: 15 } },
    ))

    // ONE entry rapid group (3 rapids) + ONE final retract group (2 rapids) --
    // matches the non-tab continuous ramp case exactly, instead of 5 rapids
    // PER DEPTH (15 total) the old per-depth re-entry produced.
    expect(moves.filter((m) => m.type === 'rapid')).toHaveLength(5)

    // The three stepdown ramps together travel exactly the arc length physics
    // dictates -- (firstDrop + (n-1)*stepdown) / tan(rampAngle) -- not one
    // ramp's worth repeated three times (which is what the old fresh-entry
    // waste would have produced: each of the 3 ramps ran the FULL feedZ ->
    // depth drop, not just its own stepdown).
    const rampAngleDeg = 15
    const tanAngle = Math.tan(rampAngleDeg * Math.PI / 180)
    const feedZ = 1
    const firstDepth = -2
    const stepdown = 2
    const depthCount = 3   // (-2, -4, -6) from top 0 / bottom -6 / stepdown 2
    const expectedArcLength = (feedZ - firstDepth + (depthCount - 1) * stepdown) / tanAngle

    let rampArcLength = 0
    for (let i = 1; i < moves.length; i++) {
      if (moves[i].role === 'ramp') {
        rampArcLength += Math.hypot(moves[i].x - moves[i - 1].x, moves[i].y - moves[i - 1].y)
      }
    }
    expect(rampArcLength).toBeCloseTo(expectedArcLength, 3)
  })

  it('a shallow angle that used to be refused now clamps over every tab instead', () => {
    // 3 deg: the continuous descent's below-tabTop tail (the -4 -> -6
    // transition) needs ~38.2 mm of tab-free travel but the gap it lands in
    // is only ~24.9 mm -- under the OLD gap-fitting design this threw. OWNER
    // DIRECTIVE: it must never be refused. The tool now rides up onto each
    // tab it meets mid-descent (clampedRampDescent), pausing its downward
    // progress while it crosses, and keeps going once clear -- however many
    // laps of the contour that takes.
    const moves = buildContourToolpath(payload(
      params({ tabs: true, tabWidth: 8, tabHeight: 2, tabCount: 4 }),
      { linking: { ...plunge, entryType: 'ramp_linear', rampAngle: 3 } },
    ))

    // Still ONE entry + ONE retract -- the extra laps needed to clear tabs
    // never cost a re-entry or an intermediate retract.
    expect(moves.filter((m) => m.type === 'rapid')).toHaveLength(5)

    // Descent actually reaches the true bottom, and every tab is still fully
    // retained through finish + spring (2 + 1 passes x 4 tabs = 12).
    expect(moves.some((m) => m.type === 'feed' && Math.abs(m.z - (-6)) < 1e-6)).toBe(true)
    const transitions = verticalTransitions(moves)
    const lifts = transitions.filter(({ from, to }) =>
      Math.abs(from.z - (-6)) < 1e-8 && Math.abs(to.z - (-4)) < 1e-8)
    const returns = transitions.filter(({ from, to }) =>
      Math.abs(from.z - (-4)) < 1e-8 && Math.abs(to.z - (-6)) < 1e-8)
    expect(lifts).toHaveLength(12)
    expect(returns).toHaveLength(12)

    // NO-GOUGE PROOF, same independent re-derivation as the 30 deg case.
    const plan = buildContourTabPlan(
      computeContourTabPreviewLoop(square.points, 'outer', 'climb', tool.diameter)!.path,
      { width: 8, count: 4, tabTopZ: -4, stockBottomZ: -6, shape: 'box' },
    )
    assertNoGouge(moves, plan, -6)
    for (const span of crossingSpans(moves)) {
      expect(span).toBeCloseTo(8, 3)
    }

    // ARC-LENGTH WASTE PROOF: clamping never steals from the ramp's own
    // budget -- 'ramp'-role travel alone still totals EXACTLY the unclamped
    // ideal (a stronger guarantee than the required ">= ideal"; every mm the
    // tabs cost shows up separately, as 'cut'-role tab-crossing travel, which
    // the crossingSpans check above already bounds at exactly one tab width
    // per crossing -- so total travel is provably ideal + crossings x width,
    // never more).
    const rampAngleDeg = 3
    const tanAngle = Math.tan(rampAngleDeg * Math.PI / 180)
    const feedZ = 1
    const bottomZ = -6
    const idealArcLength = (feedZ - bottomZ) / tanAngle
    let rampArcLength = 0
    for (let i = 1; i < moves.length; i++) {
      if (moves[i].role === 'ramp') {
        rampArcLength += Math.hypot(moves[i].x - moves[i - 1].x, moves[i].y - moves[i - 1].y)
      }
    }
    expect(rampArcLength).toBeGreaterThanOrEqual(idealArcLength - 1e-3)
    expect(rampArcLength).toBeCloseTo(idealArcLength, 3)
  })

  it('fails loud only for a pathological descent: tabs leaving almost no tab-free contour', () => {
    // 4 tabs at 44 mm wide on a ~178.8 mm perimeter leave only ~2.8 mm of
    // tab-free contour total; at 0.5 deg that permits only ~0.025 mm of
    // descent per lap -- clearing even the first stepdown's 3 mm drop would
    // need thousands of laps. This is the ONLY kind of failure left: a named
    // MAX_WRAPS/capacity error, never a "doesn't fit one gap" refusal.
    expect(() => buildContourToolpath(payload(
      params({ tabs: true, tabWidth: 44, tabHeight: 2, tabCount: 4 }),
      { linking: { ...plunge, entryType: 'ramp_linear', rampAngle: 0.5 } },
    ))).toThrow(/did not clear its tabs within 50 laps|more than 50 laps/i)
  })

  it('keeps tabShape box byte-identical to the legacy box output', () => {
    const legacy = buildContourToolpath(payload(params({
      tabs: true,
      tabWidth: 8,
      tabHeight: 2,
      tabCount: 4,
    })))
    const explicitBox = buildContourToolpath(payload(params({
      tabs: true,
      tabShape: 'box',
      tabWidth: 8,
      tabHeight: 2,
      tabCount: 4,
    })))
    expect(JSON.stringify(explicitBox)).toBe(JSON.stringify(legacy))
  })

  it('triangular tabs feed up and over at 45 deg with no vertical steps', () => {
    const moves = buildContourToolpath(payload(params({
      tabs: true,
      tabShape: 'triangular',
      tabWidth: 8,
      tabHeight: 2,
      tabCount: 4,
    })))

    const bottom = -6
    const tabTopZ = -4

    // No same-XY vertical Z transitions anywhere in the cutting motion
    // (entry lead-ins carry role 'lead_in' and are excluded).
    const cutVerticals = verticalTransitions(moves).filter(({ from, to }) =>
      from.role === 'cut' && to.role === 'cut')
    expect(cutVerticals).toHaveLength(0)

    // Every Z change inside the cut is a 45 deg ramp in arc space: |dz|/ds ~= 1.
    let slopePairs = 0
    let crossings = 0
    let topArrivals = 0
    for (let i = 1; i < moves.length; i++) {
      const from = moves[i - 1]
      const to = moves[i]
      if (from.type !== 'feed' || to.type !== 'feed') continue
      if (from.role !== 'cut' || to.role !== 'cut') continue
      const dz = to.z - from.z
      if (Math.abs(dz) > 1e-9) {
        const ds = Math.hypot(to.x - from.x, to.y - from.y)
        expect(Math.abs(dz) / ds).toBeCloseTo(1, 6)
        slopePairs++
      }
      // A tab crossing starts when the cut leaves the bottom depth...
      if (from.z <= bottom + 1e-9 && to.z > bottom + 1e-9) crossings++
      // ...and each crossing tops out at exactly the tab top.
      if (from.z < tabTopZ - 1e-6 && Math.abs(to.z - tabTopZ) < 1e-6) topArrivals++
    }
    expect(slopePairs).toBeGreaterThan(0)

    // 2 finish + 1 spring pass x 4 tabs = 12 crossings, every one reaching
    // the full tab height (width 8 >= 2 x height 2, so the top is flat).
    expect(crossings).toBe(12)
    expect(topArrivals).toBe(12)
  })

  it('rejects triangular tabs narrower than twice the tab height by name', () => {
    expect(() => buildContourToolpath(payload(params({
      tabs: true,
      tabShape: 'triangular',
      tabWidth: 3.9,
      tabHeight: 2,
      tabCount: 4,
    })))).toThrow(/triangular.*width >= 4\.000 mm/i)

    // Exactly 2 x height is the boundary and must be accepted.
    expect(() => buildContourToolpath(payload(params({
      tabs: true,
      tabShape: 'triangular',
      tabWidth: 4,
      tabHeight: 2,
      tabCount: 4,
    })))).not.toThrow()
  })

  it('triangular tabs with ramp entry ride the slopes and never gouge one', () => {
    // Same 30 deg rationale as the box case: the descent clamps only if/where
    // it actually meets a tab -- at this steep angle it completes before that
    // ever happens, so the ramp behaves exactly as it always did.
    const moves = buildContourToolpath(payload(
      params({ tabs: true, tabShape: 'triangular', tabWidth: 8, tabHeight: 2, tabCount: 4 }),
      { linking: { ...plunge, entryType: 'ramp_linear', rampAngle: 30 } },
    ))

    // One entry rapid group + one final retract group, same as the box case.
    expect(moves.filter((m) => m.type === 'rapid')).toHaveLength(5)

    const ramps = moves.filter((m) => m.role === 'ramp')
    expect(ramps.length).toBeGreaterThan(0)

    // Tab interval boundaries are where the cut leaves / rejoins the bottom
    // depth (the triangular ramps start and end exactly at the interval edges).
    const bottom = -6
    const boundaries: ToolpathMove[] = []
    for (let i = 1; i < moves.length; i++) {
      const from = moves[i - 1]
      const to = moves[i]
      if (from.type !== 'feed' || to.type !== 'feed') continue
      if (from.role !== 'cut' || to.role !== 'cut') continue
      if (from.z <= bottom + 1e-9 && to.z > bottom + 1e-9) boundaries.push(from)
      if (from.z > bottom + 1e-9 && to.z <= bottom + 1e-9) boundaries.push(to)
    }
    // 12 crossings (2 finish + 1 spring x 4 tabs) x start + end boundary.
    expect(boundaries).toHaveLength(24)

    // Triangular + clamped-ramp: a tab crossing during the descent rides the
    // 45 deg slopes exactly like a same-depth finishing pass would -- NEVER a
    // vertical same-XY step anywhere (that would only happen for 'box').
    expect(verticalTransitions(moves)).toHaveLength(0)

    // NO-GOUGE PROOF: z never dips below the triangular profile at its own
    // position, independently re-derived from the plan.
    const plan = buildContourTabPlan(
      computeContourTabPreviewLoop(square.points, 'outer', 'climb', tool.diameter)!.path,
      { width: 8, count: 4, tabTopZ: -4, stockBottomZ: -6, shape: 'triangular' },
    )
    assertNoGouge(moves, plan, -6)
  })
})

// ── Tabs v2 deliverable 3: USER-PLACED tab locations ─────────────────────────
//
// ContourParams.tabLocations[loopId] = tab CENTERS as fractions of the loop's
// finish-contour perimeter (arc distance along the cut direction from the
// seam). The expected geometry below is derived through the SAME exported
// pieces the app uses (computeContourTabPreviewLoop for the finish path,
// buildContourTabPlan + sampleTabPath for the interval mapping), so any drift
// between the preview the viewport shows and the tabs the engine cuts fails
// here.
describe('Tabs v2 - user-placed tab locations', () => {
  const W = 8
  const TABS = { width: W, count: 4, tabTopZ: -4, stockBottomZ: -6, shape: 'box' as const }

  function customParams(fractions: number[], extra: Partial<ContourParams> = {}): ContourParams {
    return params({
      tabs: true, tabWidth: W, tabHeight: 2, tabCount: 4,
      tabLocations: { square: fractions },
      ...extra,
    })
  }

  function finishPreview() {
    const preview = computeContourTabPreviewLoop(square.points, 'outer', 'climb', tool.diameter)
    expect(preview).not.toBeNull()
    return preview!
  }

  it('keeps the tab preview winding synchronized with left-hand toolpaths', () => {
    const rightConventional = computeContourTabPreviewLoop(
      square.points, 'outer', 'conventional', tool.diameter, 'right',
    )
    const leftClimb = computeContourTabPreviewLoop(
      square.points, 'outer', 'climb', tool.diameter, 'left',
    )
    expect(leftClimb).toEqual(rightConventional)
  })

  it('cuts tabs exactly at the given fractions and ignores tabCount', () => {
    // THREE custom centers with tabCount 4: the count field must be ignored.
    const fractions = [0.1, 0.45, 0.8]
    const moves = buildContourToolpath(payload(customParams(fractions)))

    const transitions = verticalTransitions(moves)
    const lifts = transitions.filter(({ from, to }) =>
      Math.abs(from.z - (-6)) < 1e-8 && Math.abs(to.z - (-4)) < 1e-8)
    const returns = transitions.filter(({ from, to }) =>
      Math.abs(from.z - (-4)) < 1e-8 && Math.abs(to.z - (-6)) < 1e-8)

    // 2 finish + 1 spring pass x 3 tabs (NOT the tabCount 4).
    expect(lifts).toHaveLength(9)
    expect(returns).toHaveLength(9)
    expect(new Set(lifts.map(({ to }) => `${to.x.toFixed(6)},${to.y.toFixed(6)}`)).size).toBe(3)

    // Every lift/return sits exactly at the interval boundary predicted from
    // the finish preview path (center +/- width/2), within 1e-6.
    const preview = finishPreview()
    const plan = buildContourTabPlan(preview.path, TABS, fractions)
    for (const f of fractions) {
      const liftPt = sampleTabPath(plan, f * plan.perimeter - W / 2)
      const returnPt = sampleTabPath(plan, f * plan.perimeter + W / 2)
      expect(lifts.some(({ to }) =>
        Math.hypot(to.x - liftPt.x, to.y - liftPt.y) < 1e-6)).toBe(true)
      expect(returns.some(({ to }) =>
        Math.hypot(to.x - returnPt.x, to.y - returnPt.y) < 1e-6)).toBe(true)
    }
  })

  it('keeps even spacing byte-identical when no custom entry applies to the loop', () => {
    const legacy = buildContourToolpath(payload(params({
      tabs: true, tabWidth: W, tabHeight: 2, tabCount: 4,
    })))
    const emptyMap = buildContourToolpath(payload(params({
      tabs: true, tabWidth: W, tabHeight: 2, tabCount: 4, tabLocations: {},
    })))
    const otherLoopOnly = buildContourToolpath(payload(params({
      tabs: true, tabWidth: W, tabHeight: 2, tabCount: 4,
      tabLocations: { some_other_loop: [0.25, 0.75] },
    })))
    const emptyList = buildContourToolpath(payload(params({
      tabs: true, tabWidth: W, tabHeight: 2, tabCount: 4, tabLocations: { square: [] },
    })))
    expect(JSON.stringify(emptyMap)).toBe(JSON.stringify(legacy))
    expect(JSON.stringify(otherLoopOnly)).toBe(JSON.stringify(legacy))
    expect(JSON.stringify(emptyList)).toBe(JSON.stringify(legacy))
  })

  it('fails by name on overlapping custom tabs and on all-invalid entries', () => {
    // ~1.8 mm of center spacing on a ~178.9 mm perimeter < the 8 mm width.
    expect(() => buildContourToolpath(payload(customParams([0.5, 0.51]))))
      .toThrow(/Contour tabs: custom tabs at .* overlap/i)
    expect(() => buildContourToolpath(payload(customParams([Number.NaN, Number.POSITIVE_INFINITY]))))
      .toThrow(/custom tab location.*invalid/i)
  })

  it('filters invalid entries but keeps the valid ones', () => {
    const moves = buildContourToolpath(payload(customParams([0.3, Number.NaN])))
    const lifts = verticalTransitions(moves).filter(({ from, to }) =>
      Math.abs(from.z - (-6)) < 1e-8 && Math.abs(to.z - (-4)) < 1e-8)
    // 3 passes x the ONE valid tab.
    expect(lifts).toHaveLength(3)
  })

  it('handles a seam-spanning custom tab by re-seaming the path (documented choice)', () => {
    // A tab CENTERED on the seam (fraction 0). The engine re-seams the finish
    // path so the cut starts in the largest tab-free gap instead of splitting
    // the interval (splitting would break the triangular profile and put the
    // plunge entry inside retained tab material).
    const fractions = [0, 0.25, 0.5, 0.75]
    const moves = buildContourToolpath(payload(customParams(fractions)))

    const transitions = verticalTransitions(moves)
    const lifts = transitions.filter(({ from, to }) =>
      Math.abs(from.z - (-6)) < 1e-8 && Math.abs(to.z - (-4)) < 1e-8)
    expect(lifts).toHaveLength(12)
    expect(new Set(lifts.map(({ to }) => `${to.x.toFixed(6)},${to.y.toFixed(6)}`)).size).toBe(4)

    const preview = finishPreview()
    const plan = buildContourTabPlan(preview.path, TABS, fractions)
    // The plan re-seamed: its seam is a different point from the raw finish
    // path's seam, and no interval crosses the (new) seam.
    expect(Math.hypot(
      plan.path[0].x - preview.path[0].x,
      plan.path[0].y - preview.path[0].y,
    )).toBeGreaterThan(1e-6)
    expect(plan.intervals.every(iv => iv.start >= -1e-9 && iv.end <= plan.perimeter + 1e-9)).toBe(true)

    // The plunge entry (lead_in) lands exactly at the re-seamed path start —
    // inside a tab-free gap, never through the seam tab.
    const leadIn = moves.find((m) => m.role === 'lead_in')!
    expect(Math.hypot(leadIn.x - plan.path[0].x, leadIn.y - plan.path[0].y)).toBeLessThan(1e-9)

    // Every lift matches the plan's predicted interval starts.
    for (const iv of plan.intervals) {
      const liftPt = sampleTabPath(plan, iv.start)
      expect(lifts.some(({ to }) =>
        Math.hypot(to.x - liftPt.x, to.y - liftPt.y) < 1e-6)).toBe(true)
    }
  })

  it('keeps the full triangular profile on a seam-spanning custom tab', () => {
    const moves = buildContourToolpath(payload(customParams(
      [0, 0.25, 0.5, 0.75], { tabShape: 'triangular' },
    )))
    const bottom = -6
    const tabTopZ = -4
    let crossings = 0
    let topArrivals = 0
    for (let i = 1; i < moves.length; i++) {
      const from = moves[i - 1]
      const to = moves[i]
      if (from.type !== 'feed' || to.type !== 'feed') continue
      if (from.role !== 'cut' || to.role !== 'cut') continue
      if (from.z <= bottom + 1e-9 && to.z > bottom + 1e-9) crossings++
      if (from.z < tabTopZ - 1e-6 && Math.abs(to.z - tabTopZ) < 1e-6) topArrivals++
    }
    // 3 passes x 4 tabs, every one (including the seam tab) reaching the full
    // tab top — a split interval would never top out on the seam tab.
    expect(crossings).toBe(12)
    expect(topArrivals).toBe(12)
  })

  it('custom + triangular + ramp entry rides over every custom tab it meets', () => {
    // 5 deg is shallow enough that the descent clamps on more than one
    // CUSTOM-placed tab before it completes -- OWNER DIRECTIVE: it rides
    // over each one instead of requiring the below-tabTop tail to fit a
    // single gap between them.
    const fractions = [0.1, 0.35, 0.6, 0.85]
    const moves = buildContourToolpath(payload(
      customParams(fractions, { tabShape: 'triangular' }),
      { linking: { ...plunge, entryType: 'ramp_linear', rampAngle: 5 } },
    ))

    const ramps = moves.filter((m) => m.role === 'ramp')
    expect(ramps.length).toBeGreaterThan(0)

    // Interval boundaries = where the cut leaves / rejoins the bottom depth
    // (same detection as the even-spacing triangular ramp test).
    const bottom = -6
    const boundaries: ToolpathMove[] = []
    for (let i = 1; i < moves.length; i++) {
      const from = moves[i - 1]
      const to = moves[i]
      if (from.type !== 'feed' || to.type !== 'feed') continue
      if (from.role !== 'cut' || to.role !== 'cut') continue
      if (from.z <= bottom + 1e-9 && to.z > bottom + 1e-9) boundaries.push(from)
      if (from.z > bottom + 1e-9 && to.z <= bottom + 1e-9) boundaries.push(to)
    }
    expect(boundaries).toHaveLength(24)   // 12 crossings x start + end

    // Triangular rides the slopes even when the RAMP itself is doing the
    // crossing -- never a vertical same-XY step anywhere.
    expect(verticalTransitions(moves)).toHaveLength(0)

    // NO-GOUGE PROOF against the CUSTOM plan (fractions, not even spacing).
    const preview = computeContourTabPreviewLoop(square.points, 'outer', 'climb', tool.diameter)!
    const plan = buildContourTabPlan(
      preview.path, { width: W, count: 4, tabTopZ: -4, stockBottomZ: -6, shape: 'triangular' }, fractions,
    )
    assertNoGouge(moves, plan, -6)
  })

  it('a custom seam gap too tight for the old design now just rides over it', () => {
    // Tabs hugging the seam from both sides leave a ~9.9 mm seam gap -- under
    // the OLD gap-fitting design, a 30 deg ramp's below-tabTop tail landed
    // ~3.5 mm short of the seam tab (needing ~3.5 mm of tab-free travel but
    // finding only ~1.5 mm) and threw. It now simply rides over that tab.
    const moves = buildContourToolpath(payload(
      customParams([0.05, 0.95]),
      { linking: { ...plunge, entryType: 'ramp_linear', rampAngle: 30 } },
    ))

    expect(moves.filter((m) => m.type === 'rapid')).toHaveLength(5)

    // 2 custom tabs x (2 finish + 1 spring) = 6 lifts/returns.
    const transitions = verticalTransitions(moves)
    const lifts = transitions.filter(({ from, to }) =>
      Math.abs(from.z - (-6)) < 1e-8 && Math.abs(to.z - (-4)) < 1e-8)
    const returns = transitions.filter(({ from, to }) =>
      Math.abs(from.z - (-4)) < 1e-8 && Math.abs(to.z - (-6)) < 1e-8)
    expect(lifts).toHaveLength(6)
    expect(returns).toHaveLength(6)

    const preview = computeContourTabPreviewLoop(square.points, 'outer', 'climb', tool.diameter)!
    const plan = buildContourTabPlan(
      preview.path, { width: W, count: 4, tabTopZ: -4, stockBottomZ: -6, shape: 'box' }, [0.05, 0.95],
    )
    assertNoGouge(moves, plan, -6)
    for (const span of crossingSpans(moves)) {
      expect(span).toBeCloseTo(W, 3)
    }
  })

})
