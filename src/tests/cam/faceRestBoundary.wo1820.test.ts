// WO-1820 - Facing can face only what earlier operations left ('rest' boundary, v1).
//
// Two halves, both behavioural:
//   1. restRegionFrom() - the geometry the store resolves 'rest' with: the
//      stock/contour boundary MINUS the footprints of the earlier pockets.
//   2. buildFaceToolpath() with regionHoles - the face actually skips those
//      footprints, still covers the untouched stock, and leaves every non-rest
//      face exactly as it was.
import { describe, it, expect } from 'vitest'
import { buildFaceToolpath, restRegionFrom, ensureRestClipperReady } from '../../lib/cam/face2d'
import { ensureClipperReady } from '../../lib/cam/face2d/clipperOffset'
import type { FaceParams, FaceWorkerPayload, LoopData, ToolpathMove } from '../../lib/cam/types'
import type { Tool, HeightParams, PassParams, LinkingParams } from '../../types'

await ensureClipperReady()
await ensureRestClipperReady()

type Pt = { x: number; y: number }

// The same 10mm flat end mill (R5) the face2d suite uses, so the offsets below
// are the documented ones: the region grows outward by 5 and each pocket is
// eaten into by 5.
function makeTool(): Tool {
  return {
    id: 't1', name: '10mm flat', type: 'flat_end_mill',
    diameter: 10, fluteLength: 20, shankDiameter: 10, overallLength: 60,
    numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
    feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 2, stepover: 7 } },
  } as Tool
}

const DEPTH = -2

const heights: HeightParams = {
  clearanceHeight: 10, clearanceHeightMode: 'absolute',
  retractHeight: 5, feedHeight: 1,
  topHeight: 0, topHeightMode: 'absolute',
  bottomHeight: DEPTH, bottomHeightMode: 'absolute',
}
const passes: PassParams = { stepdown: 5, stepover: 7, stockToLeave: 0, finishPasses: 0, springPasses: 0 }
const linking: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
}

function makeFaceParams(over: Partial<FaceParams> = {}): FaceParams {
  return {
    boundarySource: 'stock', geometryId: '__stock__', loopIds: [],
    stockOffset: 0, boundaryContainment: 'outside', avoidanceLoopIds: [],
    pattern: 'linear', passAngle: 0, direction: 'both_ways', fromOtherSide: false,
    passExtension: 5, chipThinning: false,
    bothSidesPerLevel: false, floorStockToLeave: 0, finishPass: false,
    entryType: 'plunge', leadInRadius: 0, leadOutRadius: 0,
    keepToolDown: true, maxStayDownDistance: Infinity, extendBeforeRetract: false,
    transition: 'straight', tolerance: 0.01,
    ...over,
  }
}

const box = (x0: number, y0: number, x1: number, y1: number): Pt[] =>
  [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]

const asLoop = (points: Pt[], id = 'r'): LoopData => ({ id, closed: true, type: 'contour', points })

function makePayload(params: FaceParams, loops: LoopData[], regionHoles?: Pt[][]): FaceWorkerPayload {
  return {
    opId: 'op', setupId: 'su', params, heights, passes, linking,
    tool: makeTool(), loops, wcsOrigin: { x: 0, y: 0, z: 0 },
    ...(regionHoles ? { regionHoles } : {}),
  }
}

const cuts = (m: ToolpathMove[]) => m.filter(x => x.role === 'cut')

/** Every straight in-XY segment the path travels at cutting depth: the cut
 *  passes AND the stay-down stepover links between them. A "double cut inside
 *  the pocket" would be any of these crossing the pocket footprint. */
function downSegments(m: ToolpathMove[]): Array<{ a: Pt; b: Pt }> {
  const out: Array<{ a: Pt; b: Pt }> = []
  let prev: Pt | null = null
  for (const mv of m) {
    const here = { x: mv.x, y: mv.y }
    const atDepth = Math.abs(mv.z - DEPTH) < 1e-6
    if (prev && atDepth && (mv.role === 'cut' || mv.role === 'stepover')) out.push({ a: prev, b: here })
    prev = here
  }
  return out
}

/** Does segment a-b enter the open rectangle? Sampled densely - enough to catch
 *  a pass that runs through a pocket, which is a gross overlap, not a graze. */
function entersBox(a: Pt, b: Pt, x0: number, y0: number, x1: number, y1: number): boolean {
  const N = 400
  for (let i = 0; i <= N; i++) {
    const t = i / N
    const x = a.x + (b.x - a.x) * t
    const y = a.y + (b.y - a.y) * t
    if (x > x0 + 1e-9 && x < x1 - 1e-9 && y > y0 + 1e-9 && y < y1 - 1e-9) return true
  }
  return false
}

const segLength = (m: ToolpathMove[]) =>
  downSegments(m).reduce((t, s) => t + Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y), 0)

// -- 1. The rest region ------------------------------------------------------

describe('WO-1820 restRegionFrom - stock minus the earlier pockets', () => {
  const stock = box(0, 0, 100, 60)

  it('with no earlier pockets, hands the boundary back whole', () => {
    const r = restRegionFrom([stock], [])
    expect(r.outer.length).toBe(1)
    expect(r.holes.length).toBe(0)
    expect(r.areaMm2).toBeCloseTo(6000, 3)
  })

  it('punches an interior pocket out as a HOLE, not as a new outer edge', () => {
    const r = restRegionFrom([stock], [box(20, 20, 40, 40)])
    expect(r.outer.length).toBe(1)
    expect(r.holes.length).toBe(1)
    expect(r.areaMm2).toBeCloseTo(6000 - 400, 3)
  })

  it('splits the stock into two outer regions when a pocket cuts right across', () => {
    const r = restRegionFrom([stock], [box(40, -10, 60, 70)])
    expect(r.outer.length).toBe(2)
    expect(r.holes.length).toBe(0)
    expect(r.areaMm2).toBeCloseTo(6000 - 20 * 60, 3)
  })

  it('leaves a pocket ISLAND standing - it is material, not removed stock', () => {
    // A pocket 20..60 x 10..50 with an island 30..50 x 20..40 inside it. The
    // even-odd clip cancels the nested loop, so only the RING was removed.
    const r = restRegionFrom([stock], [box(20, 10, 60, 50), box(30, 20, 50, 40)])
    expect(r.areaMm2).toBeCloseTo(6000 - (40 * 40 - 20 * 20), 3)
    // The island comes back as its own outer contour inside the hole.
    expect(r.outer.length).toBe(2)
    expect(r.holes.length).toBe(1)
  })

  it('reports ZERO area when an earlier pocket already took the whole boundary', () => {
    const r = restRegionFrom([stock], [box(-5, -5, 105, 65)])
    expect(r.outer.length).toBe(0)
    expect(r.areaMm2).toBe(0)
  })

  it('treats an empty boundary as an empty region rather than guessing', () => {
    expect(restRegionFrom([], [box(0, 0, 10, 10)])).toEqual({ outer: [], holes: [], areaMm2: 0 })
  })
})

// -- 2. The face that uses it ------------------------------------------------

describe('WO-1820 face with a rest boundary', () => {
  const stock = box(0, 0, 100, 60)
  const pocket = box(30, 15, 70, 45)
  const region = restRegionFrom([stock], [pocket])
  const params = makeFaceParams()
  const restLoops = region.outer.map((pts, i) => asLoop(pts, `o${i}`))
  const restMoves = buildFaceToolpath(makePayload(params, restLoops, region.holes))
  const plainMoves = buildFaceToolpath(makePayload(params, [asLoop(stock)]))

  // The tool centre is allowed the same R5 overrun into the pocket it gets at
  // the stock edge, so the forbidden zone is the pocket INSET by the radius.
  const forbidden = [30 + 5, 15 + 5, 70 - 5, 45 - 5] as const

  it('cuts something (a rest face is not an empty path)', () => {
    expect(cuts(restMoves).length).toBeGreaterThan(0)
  })

  it('never puts a cutting move inside the pocket the earlier op already took', () => {
    const offenders = downSegments(restMoves).filter(s => entersBox(s.a, s.b, ...forbidden))
    expect(offenders.length).toBe(0)
  })

  it('the SAME face without rest does drive straight through it (the control)', () => {
    const offenders = downSegments(plainMoves).filter(s => entersBox(s.a, s.b, ...forbidden))
    expect(offenders.length).toBeGreaterThan(0)
  })

  it('still covers the untouched stock on both sides of the pocket', () => {
    // Cut SEGMENTS, not just their endpoints: a split scanline's two passes both
    // end near the pocket wall, so the endpoints alone say nothing about reach.
    const spans = downSegments(restMoves)
    expect(spans.some(s => Math.min(s.a.x, s.b.x) < -5)).toBe(true)     // past the left stock edge
    expect(spans.some(s => Math.max(s.a.x, s.b.x) > 105)).toBe(true)    // past the right stock edge
    // And material is cut at scanlines level with the pocket, on both sides.
    const level = spans.filter(s =>
      Math.abs(s.a.y - s.b.y) < 1e-6 && s.a.y > 20 && s.a.y < 40)
    expect(level.some(s => Math.min(s.a.x, s.b.x) < 0)).toBe(true)
    expect(level.some(s => Math.max(s.a.x, s.b.x) > 100)).toBe(true)
  })

  it('does less cutting than the same face without rest', () => {
    // Only the CUT passes: the rest face trades some stay-down turns for
    // retract-and-rapid links, which is the point - it stops dragging the tool
    // across the pocket. What must shrink is the cutting itself.
    const cutLength = (m: ToolpathMove[]) => m.reduce((t, mv, i) => {
      if (i === 0 || mv.role !== 'cut') return t
      const p = m[i - 1]
      return t + Math.hypot(mv.x - p.x, mv.y - p.y)
    }, 0)
    expect(cutLength(restMoves)).toBeLessThan(cutLength(plainMoves))
  })

  it('covers every stock scanline the plain face covers (no missed strip)', () => {
    const ys = (m: ToolpathMove[]) => new Set(cuts(m).map(c => c.y.toFixed(4)))
    for (const y of ys(plainMoves)) expect(ys(restMoves).has(y)).toBe(true)
  })

  it('faces a pocket narrower than the tool straight over the top of it', () => {
    // A 4mm-wide pocket cannot take a 10mm cutter; eaten into by R5 from each
    // side the hole vanishes, so the face simply covers it.
    const thin = restRegionFrom([stock], [box(48, 20, 52, 40)])
    const moves = buildFaceToolpath(makePayload(
      params, thin.outer.map((pts, i) => asLoop(pts, `o${i}`)), thin.holes))
    const level = downSegments(moves).filter(s =>
      Math.abs(s.a.y - s.b.y) < 1e-6 && s.a.y > 25 && s.a.y < 35)
    expect(level.some(s => Math.min(s.a.x, s.b.x) < 48 && Math.max(s.a.x, s.b.x) > 52)).toBe(true)
  })

  it('says plainly that the Offset pattern cannot follow a rest boundary yet', () => {
    expect(() => buildFaceToolpath(makePayload(
      makeFaceParams({ pattern: 'offset' }), restLoops, region.holes,
    ))).toThrow(/Offset \(contour-parallel\) pattern cannot follow a Rest boundary/)
  })

  it('faces BOTH halves when a pocket splits the stock in two', () => {
    const split = restRegionFrom([stock], [box(40, -10, 60, 70)])
    const moves = buildFaceToolpath(makePayload(
      params, split.outer.map((pts, i) => asLoop(pts, `o${i}`)), split.holes))
    const spans = downSegments(moves)
    expect(spans.some(s => Math.min(s.a.x, s.b.x) < 0)).toBe(true)       // the left island is cut
    expect(spans.some(s => Math.max(s.a.x, s.b.x) > 100)).toBe(true)     // and so is the right one
  })
})

describe('WO-1820 the non-rest face is untouched', () => {
  // regionHoles ABSENT is the whole gate: with no such field the builder takes
  // the historical single-largest-loop region, and every existing face2d
  // assertion still holds (that suite runs unchanged alongside this one).
  const params = makeFaceParams()
  const stockLoop = [asLoop(box(0, 0, 100, 60))]
  const a = buildFaceToolpath(makePayload(params, stockLoop))

  it('keeps the documented 11-pass rectangle', () => {
    expect(cuts(a).length).toBe(11)
  })

  it('keeps the documented overrun past both stock edges', () => {
    const xs = cuts(a).map(c => c.x)
    expect(Math.max(...xs)).toBeGreaterThan(105)
    expect(Math.min(...xs)).toBeLessThan(-5)
  })

  it('covers the whole stock when rest is on and no pocket precedes it', () => {
    // Nothing subtracted, so the rest face must still face everything: the same
    // pass count, the same overrun, and within 2% of the same cut length. It is
    // not byte-identical on purpose - a rest region is grown by the robust
    // clipper offsetter (round joins, because a differenced region is full of
    // concave corners the miter offset self-intersects on), so the four corners
    // of the grown rectangle are radiused instead of square.
    const none = restRegionFrom([box(0, 0, 100, 60)], [])
    const moves = buildFaceToolpath(makePayload(
      params, none.outer.map((pts, i) => asLoop(pts, `o${i}`)), none.holes))
    expect(cuts(moves).length).toBe(cuts(a).length)
    const spans = downSegments(moves)
    expect(spans.some(s => Math.min(s.a.x, s.b.x) < -5)).toBe(true)
    expect(spans.some(s => Math.max(s.a.x, s.b.x) > 105)).toBe(true)
    expect(segLength(moves) / segLength(a)).toBeGreaterThan(0.98)
    expect(segLength(moves) / segLength(a)).toBeLessThanOrEqual(1)
  })
})

// -- 3. The fix phase: how the split rows are linked, and which rows split -----
//
// Operator's verdict on the picture gate (2026-09-23): "there are still facing
// sections on either side of that center pocket that don't look linked. How is
// that supposed to work?" - each split row was cut as left half, lift, right
// half, lift, then a full-width diagonal rapid back to the next row; and two
// further rows ran the whole 50mm width of the pocket to take a 0.4mm strip the
// neighbouring pass had already cut.
//
// The scenario is the one the picture gate renders (src/tests/evidence/WO-1820).
describe('WO-1820 fix phase - split rows are linked, redundant rows are split', () => {
  const STOCK = { x0: 0, y0: 0, x1: 120, y1: 80 }
  const POCKET = { x0: 35, y0: 25, x1: 85, y1: 55 }
  const R = 5                              // 10mm cutter
  // The scanlines are spread EVENLY over the grown region, so this is the spacing
  // the passes actually get - see buildFaceToolpath's `range / gaps`.
  const RANGE = (STOCK.y1 - STOCK.y0) + 2 * R
  const SPACING = RANGE / Math.ceil(RANGE / passes.stepover)

  const rect = (b: typeof STOCK) => box(b.x0, b.y0, b.x1, b.y1)
  const region = restRegionFrom([rect(STOCK)], [rect(POCKET)])
  const moves = buildFaceToolpath(makePayload(
    makeFaceParams(), region.outer.map((pts, i) => asLoop(pts, `o${i}`)), region.holes))

  /** Every cutting pass in the order the tool makes it, with whether the tool was
   *  LIFTED to get there (a rapid between this pass and the previous one). */
  function passList(m: ToolpathMove[]) {
    const out: Array<{ a: Pt; b: Pt; lifted: boolean }> = []
    let prev: Pt | null = null
    let lifted = false
    for (const mv of m) {
      const here = { x: mv.x, y: mv.y }
      if (mv.role === 'cut') { if (prev) out.push({ a: prev, b: here, lifted }); lifted = false }
      else if (mv.role === 'rapid') lifted = true
      prev = here
    }
    return out
  }
  const mid = (POCKET.x0 + POCKET.x1) / 2
  const sideOf = (p: { a: Pt; b: Pt }) =>
    Math.max(p.a.x, p.b.x) <= mid ? 'left' : Math.min(p.a.x, p.b.x) >= mid ? 'right' : 'across'

  // The entry lift is not a link between passes.
  const P = passList(moves).slice(1)

  it('machines each side of the pocket as ONE run - the tool crosses once', () => {
    let crossings = 0
    let last: string | null = null
    for (const p of P) {
      const s = sideOf(p)
      if (s === 'across') continue
      if (last && last !== s) crossings++
      last = s
    }
    expect(crossings).toBe(1)
  })

  it('never lifts between two rows on the same side of the pocket', () => {
    const lifts: string[] = []
    for (let i = 1; i < P.length; i++) {
      const prev = P[i - 1], cur = P[i]
      const s = sideOf(cur)
      if (s === 'across' || sideOf(prev) !== s) continue
      if (cur.lifted) lifts.push(`${s} y=${prev.a.y.toFixed(2)} -> y=${cur.a.y.toFixed(2)}`)
    }
    expect(lifts).toEqual([])
  })

  it('lifts exactly once - to cross the pocket - and links every other turn', () => {
    // Architect's fix-phase note 2026-09-23: "Only a move that crosses the pocket
    // or jumps between the two sides lifts." Opening a run is not itself such a
    // move: where the region splits, the first row of the new run sits one
    // row-step above the row that just ended AT THE SAME X, and where the two
    // sides merge again the step onto the full row runs away from the pocket.
    // Both are ordinary boustrophedon turns. The single lift is the crossing from
    // the right of the pocket to the left.
    const lifted = P.filter(p => p.lifted)
    expect(lifted.length).toBe(1)
    expect(sideOf(lifted[0])).toBe('left')
  })

  it('steps onto the first row of a split WITHOUT lifting', () => {
    // The move this fix removed: after the last full-width row the tool used to
    // retract and rapid to the same x one row-step away, one row-step outside the
    // stock, then plunge again.
    const firstSplit = P.findIndex(p => sideOf(p) !== 'across')
    expect(firstSplit).toBeGreaterThan(0)
    expect(P[firstSplit].lifted).toBe(false)
    // and it really is the same-x row-step, not a jump across the part.
    expect(P[firstSplit].a.x).toBeCloseTo(P[firstSplit - 1].b.x, 6)
  })

  it('splits a row rather than running it across for stock its neighbour already cut', () => {
    // A pass that runs the pocket's full width takes material in the strip
    // between its own reach and the pocket wall. If the pass one spacing further
    // from the wall already reaches that wall, the crossing buys nothing but air.
    const across = P.filter(p => Math.abs(p.a.y - p.b.y) < 1e-9
      && Math.min(p.a.x, p.b.x) < POCKET.x0 && Math.max(p.a.x, p.b.x) > POCKET.x1)
    const redundant = across.filter(p => {
      const y = p.a.y
      if (y >= POCKET.y0 && y <= POCKET.y1) return true             // straight through it
      return y < POCKET.y0
        ? (y - SPACING) + R >= POCKET.y0                            // below: neighbour reaches the wall
        : (y + SPACING) - R <= POCKET.y1                            // above: same, from the other side
    })
    expect(redundant.map(p => p.a.y.toFixed(2))).toEqual([])
    expect(across.length).toBeGreaterThan(0)                        // and some rows DO still cross
  })

  it('still covers every bit of remaining material - nothing is left standing', () => {
    // "Missing stock is not an option": every point of stock-minus-pocket must
    // lie within the tool radius of some move made at cutting depth.
    const segs = downSegments(moves)
    const near = (px: number, py: number) => {
      for (const s of segs) {
        const dx = s.b.x - s.a.x, dy = s.b.y - s.a.y
        const len2 = dx * dx + dy * dy
        const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - s.a.x) * dx + (py - s.a.y) * dy) / len2)) : 0
        if (Math.hypot(px - (s.a.x + t * dx), py - (s.a.y + t * dy)) <= R + 1e-6) return true
      }
      return false
    }
    const missed: string[] = []
    for (let x = STOCK.x0 + 0.05; x <= STOCK.x1 - 0.05; x += 0.5)
      for (let y = STOCK.y0 + 0.05; y <= STOCK.y1 - 0.05; y += 0.5) {
        if (x > POCKET.x0 && x < POCKET.x1 && y > POCKET.y0 && y < POCKET.y1) continue
        if (!near(x, y)) missed.push(`${x.toFixed(2)},${y.toFixed(2)}`)
      }
    expect(missed.slice(0, 10)).toEqual([])
  })

  it('cuts less than it did before the split rows were linked', () => {
    const cutLength = (m: ToolpathMove[]) => m.reduce((t, mv, i) => {
      if (i === 0 || mv.role !== 'cut') return t
      const p = m[i - 1]
      return t + Math.hypot(mv.x - p.x, mv.y - p.y)
    }, 0)
    const stock = buildFaceToolpath(makePayload(makeFaceParams(), [asLoop(rect(STOCK))]))
    expect(cutLength(moves)).toBeLessThan(cutLength(stock))
    // Two rows that used to run the whole pocket width no longer do.
    expect(cutLength(stock) - cutLength(moves)).toBeGreaterThan(2 * (POCKET.x1 - POCKET.x0))
  })
})

// -- 4. Operator's second verdict: no cutting move slants across the block --------
//
// Operator, 2026-09-23 10:31Z, on the second picture: "Look at the diagonal linking
// crossover near the skipped center. This is not desirable, but potentially
// unavoidable because of interval steps and area to be covered."
//
// It IS avoidable, and the rule has to be general - "for any number of rows per
// side and any pocket position, pick the start corner per region (and the region
// order) so that no cutting move crosses stock diagonally; the only non-row moves
// are row-end links outside the stock and lifts". These cases put the pocket in
// nine different places and spacings so that each side of it comes out with an
// odd row count in some and an even one in others, which is the parity that
// decides which end a zigzag finishes at.
describe('WO-1820 second verdict - no cutting move slants across the block', () => {
  const STOCK = { x0: 0, y0: 0, x1: 120, y1: 80 }
  type Rect = { x0: number; y0: number; x1: number; y1: number }
  const rect = (b: Rect) => box(b.x0, b.y0, b.x1, b.y1)

  const CASES: Array<{ name: string; pockets: Rect[]; stepover: number }> = [
    { name: 'the picture-gate pocket, centred', pockets: [{ x0: 35, y0: 25, x1: 85, y1: 55 }], stepover: 7 },
    { name: 'a shallower centred pocket', pockets: [{ x0: 35, y0: 28, x1: 85, y1: 48 }], stepover: 7 },
    { name: 'a pocket off to the left', pockets: [{ x0: 10, y0: 20, x1: 60, y1: 62 }], stepover: 7 },
    { name: 'a pocket low in the block', pockets: [{ x0: 30, y0: 5, x1: 90, y1: 35 }], stepover: 7 },
    { name: 'a pocket cut right through the block', pockets: [{ x0: 50, y0: -10, x1: 70, y1: 90 }], stepover: 7 },
    { name: 'two pockets side by side', pockets: [{ x0: 15, y0: 25, x1: 45, y1: 55 }, { x0: 75, y0: 25, x1: 105, y1: 55 }], stepover: 7 },
    { name: 'a tighter stepover', pockets: [{ x0: 35, y0: 25, x1: 85, y1: 55 }], stepover: 5 },
    { name: 'a wider stepover', pockets: [{ x0: 35, y0: 22, x1: 85, y1: 58 }], stepover: 9 },
    { name: 'many rows a side', pockets: [{ x0: 40, y0: 18, x1: 80, y1: 62 }], stepover: 4 },
  ]

  const pathFor = (c: { pockets: Rect[]; stepover: number }) => {
    const region = restRegionFrom([rect(STOCK)], c.pockets.map(rect))
    return buildFaceToolpath({
      ...makePayload(makeFaceParams(), region.outer.map((pts, i) => asLoop(pts, `o${i}`)), region.holes),
      passes: { ...passes, stepover: c.stepover },
    })
  }

  /** Cutting moves (passes and the stay-down links between them) that travel in
   *  BOTH x and y and pass inside the block. A pass runs along one row (no dy); a
   *  row-end turn steps in y at the same x, out in the overrun beyond the block.
   *  Anything else is the diagonal Operator refused. */
  const slantsAcross = (m: ToolpathMove[]) => downSegments(m)
    .filter(s => Math.abs(s.b.x - s.a.x) > 1e-6 && Math.abs(s.b.y - s.a.y) > 1e-6)
    .filter(s => entersBox(s.a, s.b, STOCK.x0, STOCK.y0, STOCK.x1, STOCK.y1))
    .map(s => `(${s.a.x.toFixed(2)},${s.a.y.toFixed(2)})->(${s.b.x.toFixed(2)},${s.b.y.toFixed(2)})`)

  /** How many cut passes sit wholly on each side of the first pocket - the row
   *  count per side, whose ODD/EVEN parity decides which end the zigzag ends at. */
  const rowsPerSide = (m: ToolpathMove[], p: Rect) => {
    const mid = (p.x0 + p.x1) / 2
    const rows = downSegments(m).filter(s => Math.abs(s.a.y - s.b.y) < 1e-9)
    return {
      left: rows.filter(s => Math.max(s.a.x, s.b.x) <= mid).length,
      right: rows.filter(s => Math.min(s.a.x, s.b.x) >= mid).length,
    }
  }

  for (const c of CASES) {
    it(`${c.name}: every cutting move is a row or a row-end turn`, () => {
      expect(slantsAcross(pathFor(c))).toEqual([])
    })
  }

  it('covers both parities - some sides have an odd row count, some even', () => {
    const counts = CASES.flatMap(c => {
      const { left, right } = rowsPerSide(pathFor(c), c.pockets[0])
      return [left, right]
    })
    expect(counts.every(n => n > 0)).toBe(true)
    expect(counts.some(n => n % 2 === 1)).toBe(true)
    expect(counts.some(n => n % 2 === 0)).toBe(true)
  })

  it('crosses between the two halves of a through-cut pocket in the AIR', () => {
    // The stay-down envelope alone does not catch this one: each half's envelope
    // is grown by the overrun plus a tool radius, so for a pocket no wider than
    // twice that the two envelopes overlap and a link across the removed slot
    // tested as "inside the region". Measured before the fix: one 90mm feed move
    // at depth, corner to corner across the slot.
    const c = CASES.find(x => x.name === 'a pocket cut right through the block')!
    const moves = pathFor(c)
    const slot = c.pockets[0]
    // Each half's passes may overrun into the slot exactly as they overrun the
    // block's own edge - R past the wall, plus the pass extension - which for this
    // 20mm slot reaches its centre line and no further. Nothing cutting may CROSS
    // that line: the far half is another island, and the tool gets there in air.
    const centre = (slot.x0 + slot.x1) / 2
    const crossings = downSegments(moves)
      .filter(s => Math.min(s.a.x, s.b.x) < centre - 1e-6 && Math.max(s.a.x, s.b.x) > centre + 1e-6)
      .map(s => `(${s.a.x.toFixed(2)},${s.a.y.toFixed(2)})->(${s.b.x.toFixed(2)},${s.b.y.toFixed(2)})`)
    expect(crossings).toEqual([])
    // and both halves are still faced, so it is not skipping one of them.
    const { left, right } = rowsPerSide(moves, slot)
    expect(left).toBeGreaterThan(0)
    expect(right).toBeGreaterThan(0)
  })
})
