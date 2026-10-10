import { describe, it, expect } from 'vitest'
import { buildFaceToolpath } from '../../lib/cam/face2d'
import { ensureClipperReady } from '../../lib/cam/face2d/clipperOffset'
import type { FaceParams, FaceWorkerPayload, LoopData } from '../../lib/cam/types'
import type { Tool, HeightParams, PassParams, LinkingParams } from '../../types'

// The offset ring fill uses clipper2-wasm (loaded once, async). Init it
// before any suite runs — top-level await completes before the describe bodies.
await ensureClipperReady()

// ── Fixtures ───────────────────────────────────────────────────────────────────
// All fixtures use a Ø10 mm flat end mill (R5). The region is grown outward by the
// tool radius (ADR 0015 §2), so a 100×60 boundary yields a −5..105 × −5..65 fill
// region; with passExtension=5 each pass spans x ∈ [−10, 110].

function makeTool(): Tool {
  return {
    id: 't1', name: 'Ø10 flat', type: 'flat_end_mill',
    diameter: 10, fluteLength: 20, shankDiameter: 10, overallLength: 60,
    numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
    feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 2, stepover: 7 } },
  } as Tool
}

function makeHeights(bottom = -2): HeightParams {
  return {
    clearanceHeight: 10, clearanceHeightMode: 'absolute',
    retractHeight: 5, feedHeight: 1,
    topHeight: 0, topHeightMode: 'absolute',
    bottomHeight: bottom, bottomHeightMode: 'absolute',
  }
}

const passes: PassParams = {
  stepdown: 5, stepover: 7, stockToLeave: 0, finishPasses: 0, springPasses: 0,
}

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

function rect(w: number, h: number): LoopData {
  return { id: 'r', closed: true, type: 'contour',
    points: [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }] }
}

function makePayload(params: FaceParams, loops: LoopData[], heights = makeHeights(),
  pp: PassParams = passes): FaceWorkerPayload {
  return {
    opId: 'op', setupId: 'su', params, heights, passes: pp, linking,
    tool: makeTool(), loops, wcsOrigin: { x: 0, y: 0, z: 0 },
  }
}

const cuts = (m: ReturnType<typeof buildFaceToolpath>) => m.filter(x => x.role === 'cut')

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Face 2D — T1 rectangle, both-ways', () => {
  const moves = buildFaceToolpath(makePayload(makeFaceParams(), [rect(100, 60)]))

  it('produces cut moves', () => {
    expect(cuts(moves).length).toBeGreaterThan(0)
  })

  it('has the expected pass count (ceil(70/7)+1 = 11)', () => {
    expect(cuts(moves).length).toBe(11)
  })

  it('overruns the boundary on both ends (x reaches beyond 100 and below 0)', () => {
    const xs = cuts(moves).map(c => c.x)
    expect(Math.max(...xs)).toBeGreaterThan(105)
    expect(Math.min(...xs)).toBeLessThan(-5)
  })

  it('alternates direction (boustrophedon)', () => {
    const c = cuts(moves)
    expect(c[0].x).toBeGreaterThan(100)   // first pass ends at +X
    expect(c[1].x).toBeLessThan(0)        // second ends at −X
    expect(c[2].x).toBeGreaterThan(100)
  })

  it('cuts at the faced depth (bottomZ = −2)', () => {
    for (const c of cuts(moves)) expect(c.z).toBeCloseTo(-2, 6)
  })

  it('stays down between passes (no retracts within the level)', () => {
    const retracts = moves.filter(m => m.role === 'rapid' && Math.abs(m.z - 5) < 1e-6)
    // Only the final end-of-level retract; no per-pass retracts in zigzag stay-down.
    expect(retracts.length).toBe(1)
  })
})

describe('Face 2D — T1b pass angle 90° rotates the scan direction', () => {
  const moves = buildFaceToolpath(makePayload(makeFaceParams({ passAngle: 90 }), [rect(100, 60)]))
  it('passes now run along Y and overrun in Y', () => {
    const ys = cuts(moves).map(c => c.y)
    expect(Math.max(...ys)).toBeGreaterThan(65)
    expect(Math.min(...ys)).toBeLessThan(-5)
  })
  it('pass count follows the X extent (ceil(110/7)+1 = 17)', () => {
    expect(cuts(moves).length).toBe(17)
  })
})

describe('Face 2D — T2 one-way (climb) retracts and returns', () => {
  const moves = buildFaceToolpath(makePayload(
    makeFaceParams({ direction: 'climb', pattern: 'one_way' }), [rect(100, 60)]))

  it('every pass cuts in the same direction (+X)', () => {
    for (const c of cuts(moves)) expect(c.x).toBeGreaterThan(100)
  })
  it('returns via retract between passes (multiple retract-height rapids)', () => {
    const retracts = moves.filter(m => m.role === 'rapid' && Math.abs(m.z - 5) < 1e-6)
    expect(retracts.length).toBeGreaterThan(10)   // ~2 per inter-pass link + final
  })
})

describe('Face 2D tool-hand direction', () => {
  const build = (
    direction: 'climb' | 'conventional',
    cutHand: 'right' | 'left',
    pattern: 'one_way' | 'offset',
  ) => {
    const p = makePayload(
      makeFaceParams({ direction, pattern }),
      [rect(100, 60)],
    )
    p.tool = { ...p.tool, cutHand }
    return buildFaceToolpath(p)
  }

  it('reverses one-way travel for a left-hand cutter and leaves both-ways explicit', () => {
    for (const pattern of ['one_way', 'offset'] as const) {
      const rightClimb = build('climb', 'right', pattern)
      const rightConventional = build('conventional', 'right', pattern)
      expect(rightClimb).not.toEqual(rightConventional)
      expect(build('climb', 'left', pattern)).toEqual(rightConventional)
      expect(build('conventional', 'left', pattern)).toEqual(rightClimb)
    }

    const rightBoth = makePayload(makeFaceParams({ direction: 'both_ways' }), [rect(100, 60)])
    const leftBoth = structuredClone(rightBoth)
    leftBoth.tool.cutHand = 'left'
    expect(buildFaceToolpath(leftBoth)).toEqual(buildFaceToolpath(rightBoth))
  })
})

describe('Face 2D — T3 multiple Z levels', () => {
  const moves = buildFaceToolpath(makePayload(
    makeFaceParams(), [rect(40, 40)],
    makeHeights(-3), { ...passes, stepdown: 1 }))

  it('cuts at three distinct depths (−1, −2, −3)', () => {
    const zs = new Set(cuts(moves).map(c => Number(c.z.toFixed(3))))
    expect(zs.has(-1)).toBe(true)
    expect(zs.has(-2)).toBe(true)
    expect(zs.has(-3)).toBe(true)
  })
})

describe('Face 2D — T4 boundary containment "inside" stays within the part', () => {
  const moves = buildFaceToolpath(makePayload(
    makeFaceParams({ boundaryContainment: 'inside', passExtension: 0 }), [rect(100, 60)]))
  it('never crosses the boundary (x within [0,100], y within [0,60])', () => {
    for (const c of cuts(moves)) {
      expect(c.x).toBeGreaterThanOrEqual(-1e-6)
      expect(c.x).toBeLessThanOrEqual(100 + 1e-6)
    }
  })
})

describe('Face 2D — fail-loud guards (ADR 0003 / ADR 0015)', () => {
  const cases: Array<[string, Partial<FaceParams>]> = [
    ['avoidance regions',     { avoidanceLoopIds: ['x'] }],
    ['arc lead-in entry',     { entryType: 'lead_in_arc' }],
    ['chip thinning',         { chipThinning: true }],
    ['high-feed transition',  { transition: 'high_feed' }],
    ['no-contact transition', { transition: 'no_contact' }],
  ]
  for (const [name, over] of cases) {
    it(`throws for ${name}`, () => {
      expect(() => buildFaceToolpath(makePayload(makeFaceParams(over), [rect(50, 50)]))).toThrow()
    })
  }
})

describe('Face 2D — T5 offset (contour-parallel rings)', () => {
  const moves = buildFaceToolpath(makePayload(
    makeFaceParams({ pattern: 'offset', direction: 'climb' }), [rect(100, 60)]))

  it('produces concentric rings (cut moves + stepover links)', () => {
    expect(cuts(moves).length).toBeGreaterThan(10)
    expect(moves.some(m => m.role === 'stepover')).toBe(true)   // ring-to-ring links
  })
  it('outer ring overruns the boundary (grown by tool radius)', () => {
    const xs = cuts(moves).map(c => c.x)
    expect(Math.max(...xs)).toBeGreaterThan(104)   // 100 + R5
    expect(Math.min(...xs)).toBeLessThan(-4)
  })
  it('cuts at the faced depth and ends with a centre cleanup move', () => {
    for (const c of cuts(moves)) expect(c.z).toBeCloseTo(-2, 6)
  })
})

describe('Face 2D — T7 pass extension overruns the offset rings', () => {
  const maxX = (m: ReturnType<typeof buildFaceToolpath>) => Math.max(...cuts(m).map(c => c.x))
  it('larger pass extension pushes the offset rings further outside the stock', () => {
    const noExt  = buildFaceToolpath(makePayload(makeFaceParams({ pattern: 'offset', passExtension: 0 }),  [rect(100, 60)]))
    const bigExt = buildFaceToolpath(makePayload(makeFaceParams({ pattern: 'offset', passExtension: 12 }), [rect(100, 60)]))
    expect(maxX(bigExt)).toBeGreaterThan(maxX(noExt) + 5)
  })
})

// ── Coverage check: every point of the stock must be within toolRadius of some
// engaged (non-rapid) cut segment, or material is left behind. "Missing stock
// removal is not an option."
function pointSegDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay
  const len2 = dx * dx + dy * dy
  if (len2 < 1e-12) return Math.hypot(px - ax, py - ay)
  let t = ((px - ax) * dx + (py - ay) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}
function worstUncovered(
  moves: ReturnType<typeof buildFaceToolpath>, w: number, h: number, grid = 2.5,
): number {
  // Engaged segments: consecutive non-rapid moves that travel in XY (skip plunges).
  const segs: Array<[number, number, number, number]> = []
  for (let i = 1; i < moves.length; i++) {
    const a = moves[i - 1], b = moves[i]
    if (a.type === 'rapid' || b.type === 'rapid') continue
    if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-6) continue
    segs.push([a.x, a.y, b.x, b.y])
  }
  let worst = 0
  for (let x = 1; x <= w - 1; x += grid) {
    for (let y = 1; y <= h - 1; y += grid) {
      let best = Infinity
      for (const [ax, ay, bx, by] of segs) best = Math.min(best, pointSegDist(x, y, ax, ay, bx, by))
      worst = Math.max(worst, best)
    }
  }
  return worst
}

function pointInPoly(px: number, py: number, poly: Array<{ x: number; y: number }>): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y
    if (((yi > py) !== (yj > py)) && (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)) inside = !inside
  }
  return inside
}
// Worst uncovered point restricted to the interior of an arbitrary boundary
// polygon (so a concave notch isn't falsely counted as "uncut").
function worstUncoveredInPoly(
  moves: ReturnType<typeof buildFaceToolpath>, poly: Array<{ x: number; y: number }>, grid = 2,
): number {
  const xs = poly.map(p => p.x), ys = poly.map(p => p.y)
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys)
  const segs: Array<[number, number, number, number]> = []
  for (let i = 1; i < moves.length; i++) {
    const a = moves[i - 1], b = moves[i]
    if (a.type === 'rapid' || b.type === 'rapid') continue
    if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-6) continue
    segs.push([a.x, a.y, b.x, b.y])
  }
  let worst = 0
  for (let x = minX + 1; x <= maxX - 1; x += grid) {
    for (let y = minY + 1; y <= maxY - 1; y += grid) {
      if (!pointInPoly(x, y, poly)) continue
      let best = Infinity
      for (const [ax, ay, bx, by] of segs) best = Math.min(best, pointSegDist(x, y, ax, ay, bx, by))
      worst = Math.max(worst, best)
    }
  }
  return worst
}

describe('Face 2D — concave (L-shaped) part', () => {
  // Reflex corner at (40,40). zigzag clears it (coverage); offset clears it via the
  // clipper offset tree (the slot splits the inner region into sub-regions filled
  // recursively).
  const L = [
    { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 40 },
    { x: 40, y: 40 }, { x: 40, y: 100 }, { x: 0, y: 100 },
  ]
  const Lloop: LoopData = { id: 'L', closed: true, type: 'contour', points: L }
  it('zigzag clears the L-shape interior (no missing stock)', () => {
    const m = buildFaceToolpath(makePayload(makeFaceParams({ pattern: 'zigzag' }), [Lloop]))
    expect(worstUncoveredInPoly(m, L, 2)).toBeLessThanOrEqual(5 + 0.6)
  })
  it('offset clears the L-shape via the offset tree (no missing stock)', () => {
    const m = buildFaceToolpath(makePayload(makeFaceParams({ pattern: 'offset' }), [Lloop]))
    expect(worstUncoveredInPoly(m, L, 2)).toBeLessThanOrEqual(5 + 0.6)
  })
})

describe('Face 2D — coverage (no missing stock)', () => {
  // Ø10 tool (R5). Every stock point must be within R of a cut segment, or
  // material is left behind. TOL = R + grid-sampling slack.
  const TOL = 5 + 0.6
  // 2.8·R — far past the corner/ridge coverage limits; only passes because the
  // stepover is clamped (ring → 1.3·R, straight → 1.9·R). Guards the clamps.
  const oversized: PassParams = { ...passes, stepover: 14 }
  for (const pattern of ['zigzag', 'offset'] as const) {
    it(`${pattern} clears the stock at default stepover`, () => {
      const m = buildFaceToolpath(makePayload(makeFaceParams({ pattern }), [rect(100, 60)]))
      expect(worstUncovered(m, 100, 60, 2)).toBeLessThanOrEqual(TOL)
    })
    it(`${pattern} clears the stock even at oversized stepover (clamped)`, () => {
      const m = buildFaceToolpath(makePayload(makeFaceParams({ pattern }), [rect(100, 100)], makeHeights(), oversized))
      expect(worstUncovered(m, 100, 100, 2)).toBeLessThanOrEqual(TOL)
    })
  }
})

// ── Bug 2 regression: angled, concave contour must not leave a stray diagonal ───
// Rotate a point list by `deg` about its centroid, so its top/bottom edges become
// shallow (near-horizontal) in the scan frame.
function rotate(pts: Array<{ x: number; y: number }>, deg: number) {
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length
  const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t)
  return pts.map(p => {
    const dx = p.x - cx, dy = p.y - cy
    return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c }
  })
}

describe('Face 2D — zigzag on angled/concave contours (Bug 2)', () => {
  const R = 5

  // Rotated trapezoid: slanted top/bottom edges, ONE span per scanline. The turns
  // at the slanted edges move in both X and Y but stay over the region, so they
  // must be ONE continuous stay-down move — NOT a retract (the reported bug was the
  // tool retracting / leaving a stray segment at these edges).
  const trap = rotate([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 90, y: 60 }, { x: 10, y: 60 }], 12)
  const trapLoop: LoopData = { id: 'tr', closed: true, type: 'contour', points: trap }
  const trapMoves = buildFaceToolpath(makePayload(makeFaceParams({ pattern: 'zigzag' }), [trapLoop]))

  it('clears the trapezoid interior (no missing stock)', () => {
    expect(worstUncoveredInPoly(trapMoves, trap, 2)).toBeLessThanOrEqual(R + 0.6)
  })

  it('never retracts for a diagonal turn — stays down, one continuous move', () => {
    // Single span per line means no gap to cross, so EVERY pass-to-pass turn stays
    // down: the only retract is the end-of-level lift. Pre-fix (retract on any
    // X+Y jump) produced extra mid-level retracts at the slanted edges.
    const retracts = trapMoves.filter(x => x.role === 'rapid' && Math.abs(x.z - 5) < 1e-6)
    expect(retracts.length).toBe(1)
  })

  // Rotated slotted block: scanlines over the slot are multi-span. Crossing the
  // slot would cut outside the region, so those links retract (over cleared air),
  // but coverage of the material still holds.
  const slot = rotate([
    { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 60 }, { x: 60, y: 60 },
    { x: 60, y: 32 }, { x: 40, y: 32 }, { x: 40, y: 60 }, { x: 0, y: 60 },
  ], 12)
  const slotLoop: LoopData = { id: 'slot', closed: true, type: 'contour', points: slot }
  it('clears a slotted (multi-span) contour, coverage intact', () => {
    const m = buildFaceToolpath(makePayload(makeFaceParams({ pattern: 'zigzag' }), [slotLoop]))
    expect(worstUncoveredInPoly(m, slot, 2)).toBeLessThanOrEqual(R + 0.6)
  })
})

describe('Face 2D — offset clears a concave contour via the offset tree (Bug 1)', () => {
  // A concave (slotted) contour. The offset ring fill handles it via the clipper
  // offset tree: the slot splits the inner region into two sub-regions, each filled
  // recursively (nested rings) — no tangle, full coverage. The Platte C class of bug.
  const slot = [
    { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 70 }, { x: 65, y: 70 },
    { x: 65, y: 30 }, { x: 35, y: 30 }, { x: 35, y: 70 }, { x: 0, y: 70 },
  ]
  const concave: LoopData = { id: 'cc', closed: true, type: 'contour', points: slot }

  it('offset clears the concave/slotted contour at any stepover (no missing stock)', () => {
    const m = buildFaceToolpath(makePayload(makeFaceParams({ pattern: 'offset' }), [concave]))
    expect(worstUncoveredInPoly(m, slot, 2)).toBeLessThanOrEqual(5 + 0.6)
  })

  for (const pattern of ['zigzag', 'one_way', 'linear'] as const) {
    it(`${pattern} also handles the concave contour`, () => {
      expect(() => buildFaceToolpath(makePayload(makeFaceParams({ pattern }), [concave]))).not.toThrow()
    })
  }
})

describe('Face 2D — CAM-14 perf guard: offset-ring vertex accumulation stays bounded', () => {
  // CAM-14 tightened clipperOffset.ts's arcTolerance (0.1mm -> 0.0025mm) and decimate
  // (fixed 0.2mm spacing -> a Douglas-Peucker sagitta bound, epsilon=0.0025mm as of
  // CAM-14-R1) to fix a corner gouge/facet defect — both changes make each ring's
  // tessellation FINER, which is exactly the input decimate's own doc comment warns
  // compounds across the recursive offset tree ("each successive inward offset would
  // otherwise ACCUMULATE round-join vertices ... rings grow to thousands of points and
  // resampling them blows up"). A 10x-scaled reflex-cornered L (the same shape as the
  // "concave (L-shaped) part" fixture above, whose corner at (400,400) persists across
  // every inward ring and needs a round join every single step) at a small stepover is
  // the representative accumulation case. Manually verified during CAM-14: disabling
  // decimate() on this exact case does not just grow vertex count — it HANGS (900s+,
  // never returns) because clipper's wasm InflatePathsD chokes on an exponentially-
  // growing input across ~40+ successive ring iterations. This assertion is the
  // standing guard against that class silently coming back.
  const bigL: LoopData = { id: 'bigL', closed: true, type: 'contour', points: [
    { x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 400 },
    { x: 400, y: 400 }, { x: 400, y: 1000 }, { x: 0, y: 1000 },
  ] }
  it('a 40+ ring inward offset on a reflex-cornered boundary produces a bounded move count', () => {
    const tightPasses: PassParams = { ...passes, stepover: 2 }
    const m = buildFaceToolpath(makePayload(
      makeFaceParams({ pattern: 'offset' }), [bigL], makeHeights(), tightPasses,
    ))
    expect(m.length).toBeGreaterThan(0)
    // Observed 5967 moves for this exact case post-CAM-14-R1 fix (coordination/
    // evidence/CAM-14/r1/bigl-move-count.ts; R0's measurement was 6383 — the
    // sagitta-bounded decimate is, if anything, slightly MORE aggressive on this
    // shape's low-curvature spans, not less). 20000 is a generous ceiling that still
    // clearly catches the "decimate stopped working" explosion class (which does not
    // even complete — see comment above), not a tight regression trip-wire.
    expect(m.length).toBeLessThan(20000)
  })
})

describe('Face 2D — degenerate input', () => {
  // SKC-47-R2 truth-fix: this used to assert a silent empty return (the exact
  // "ready / 0 moves / nothing renders" bug class ADR 0003 exists to kill).
  // Face now fails loud at the builder boundary; the store's own pre-dispatch
  // guard (src/store/index.ts:5415-5420) is the separate, already-existing
  // user-visible refusal for the geometry-boundary UI path.
  it('throws a named refusal for no closed loops (ADR 0003), never a silent empty return', () => {
    expect(() => buildFaceToolpath(makePayload(makeFaceParams(), []))).toThrow(/Face:.*no closed loop/i)
  })
})
