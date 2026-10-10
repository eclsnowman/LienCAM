/* Tests for the P1.3 bidirectional sheet/quantity solver
 * (src/lib/cam/nesting/solver.ts solveNest). Each test is a real gate per
 * NESTING-P1-ENGINE-PLAN.md P1.3:
 *
 *   - fixSheet   -> MAX QUANTITY: a fixture where exactly N copies fit and N+1
 *                   do not -> the solver returns the multiplier M giving exactly
 *                   N placed, none unplaced.
 *   - fixQty width-locked -> MIN length on a fixed width within tolerance of the
 *                   hand-derived minimum, all placed; one notch smaller leaves
 *                   parts unplaced (the monotonic boundary).
 *   - fixQty none-locked -> a sheet that fits ALL with area <= a generous hand-
 *                   computed upper bound (sanity, not exact-optimal).
 *   - DETERMINISM: each mode twice with the same seed -> deep-equal NestResult.
 *   - ADR 0003: impossible requests (part bigger than any feasible locked sheet,
 *               and M=0 on fixSheet) -> leftovers reported EXPLICITLY, never a
 *               silent empty success.
 *
 * FIXTURE DESIGN NOTE: the P1.2 packer's gravity/min-bounding heuristic packs a
 * clean SINGLE COLUMN (or two columns) reliably, but does NOT achieve a perfect
 * 2D grid (a 70x70 sheet packs only 3 of 4 ideal 25x25 squares). So these gates
 * use TALL, NARROW sheets where the parts stack in 1-2 columns - the regime where
 * the packer is well-behaved and the hand-derived geometry is exact. solveNest is
 * async (awaits clipper2-wasm init), so every test awaits it.
 */

import { describe, it, expect } from 'vitest'
import { solveNest, transformRing } from '../../../lib/cam/nesting'
import type { NestPart, NestRequest } from '../../../lib/cam/nesting'

// ── fixtures / helpers ──────────────────────────────────────────────────────

/** Axis-aligned w x h rectangle, lower-left at origin (CCW). Locked to 0 deg so
 *  the solver cannot rotate it - keeps the hand-derived geometry exact. */
function rect(id: string, w: number, h: number, locked = true): NestPart {
  return {
    id,
    outer: [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w, y: h },
      { x: 0, y: h },
    ],
    holes: [],
    ...(locked ? { lockedRotationDeg: 0 } : {}),
  }
}

/** No-spacing base request (clearances default to zero -> exact geometry). */
function baseRequest(over: Partial<NestRequest> = {}): NestRequest {
  return {
    parts: [],
    sheet: { width: 100, height: 100 },
    style: 'ninety',
    spacing: { partGap: 0, sheetMargin: 0, windowGap: 0 },
    solver: { kind: 'fixSheet' },
    seed: 4242,
    ...over,
  }
}

// ── fixSheet -> MAX QUANTITY ─────────────────────────────────────────────────

describe('solver: fixSheet max quantity', () => {
  it('returns the multiplier M giving exactly N placed where N fits and N+1 does not', async () => {
    // 10x10 squares (locked, no spacing) on a 12-wide, 55-tall sheet. Width 12
    // holds a SINGLE column; height 55 holds floor(55/10) = 5 squares stacked.
    // A 6th would need height 60 > 55, so it cannot fit. Request set = 1 square,
    // so the solver maximises the multiplier M of the SET: M=5 fits (5 squares),
    // M=6 does not -> solver returns M=5 -> exactly 5 placed, none unplaced.
    const sq = rect('s', 10, 10)
    const req = baseRequest({
      parts: [{ part: sq, quantity: 1 }],
      sheet: { width: 12, height: 55 },
    })
    const result = await solveNest(req)
    expect(result.placements.length).toBe(5)
    expect(result.unplaced).toEqual([]) // every achieved-M copy placed cleanly
  })

  it('preserves a multi-part set ratio when maximising M', async () => {
    // set = one 10x10 'a' + one 10x5 'b' in a single 12-wide column. Per set
    // stacks to height 15; on a 55-tall sheet floor(55/15) = 3 full sets fit
    // (height 45 <= 55; a 4th set needs 60 > 55). The solver returns M=3 -> 3 of
    // each, ratio preserved, nothing unplaced (it never returns a partial set).
    const a = rect('a', 10, 10)
    const b = rect('b', 10, 5)
    const req = baseRequest({
      parts: [
        { part: a, quantity: 1 },
        { part: b, quantity: 1 },
      ],
      sheet: { width: 12, height: 55 },
    })
    const result = await solveNest(req)
    const aCount = result.placements.filter((p) => p.partId === 'a').length
    const bCount = result.placements.filter((p) => p.partId === 'b').length
    expect(aCount).toBe(bCount) // 1:1 ratio preserved across the multiplier
    expect(aCount).toBeGreaterThanOrEqual(1)
    expect(result.unplaced).toEqual([])
  })
})

// ── fixSheetExact -> EXACT QUANTITY on a fixed sheet ─────────────────────────

describe('solver: fixSheetExact exact quantity on a fixed sheet', () => {
  it('honors the EXACT requested quantities when they all fit (none scaled up)', async () => {
    // set = 3 'a' + 2 'b' (10-wide squares/rects) in a single 12-wide column on a
    // tall sheet. Heights: 3*10 + 2*5 = 40 <= 200, so all 5 fit with room to spare.
    // fixSheetExact must place EXACTLY 3 + 2 (NOT scale the set to fill the sheet
    // like fixSheet would), with nothing unplaced.
    const a = rect('a', 10, 10)
    const b = rect('b', 10, 5)
    const result = await solveNest(
      baseRequest({
        parts: [
          { part: a, quantity: 3 },
          { part: b, quantity: 2 },
        ],
        sheet: { width: 12, height: 200 },
        solver: { kind: 'fixSheetExact' },
      })
    )
    const aCount = result.placements.filter((p) => p.partId === 'a').length
    const bCount = result.placements.filter((p) => p.partId === 'b').length
    expect(aCount).toBe(3) // exact, not multiplied to fill the tall sheet
    expect(bCount).toBe(2)
    expect(result.placements.length).toBe(5)
    expect(result.unplaced).toEqual([])
  })

  it('reports leftovers EXPLICITLY when the fixed sheet is too small (ADR 0003)', async () => {
    // 4 squares 10x10 requested in a 12-wide column, but the sheet is only 25 tall:
    // floor(25/10) = 2 fit, 2 cannot. fixSheetExact must place 2 and report 2 left,
    // never silently drop or scale.
    const sq = rect('q', 10, 10)
    const result = await solveNest(
      baseRequest({
        parts: [{ part: sq, quantity: 4 }],
        sheet: { width: 12, height: 25 },
        solver: { kind: 'fixSheetExact' },
      })
    )
    const totalUnplaced = result.unplaced.reduce((n, u) => n + u.count, 0)
    expect(result.placements.length).toBeLessThan(4)
    expect(totalUnplaced).toBeGreaterThan(0)
    // conservation: placed + leftovers == requested (no silent loss).
    expect(result.placements.length + totalUnplaced).toBe(4)
    const left = result.unplaced.find((u) => u.partId === 'q')
    expect(left).toBeDefined()
  })
})

// ── fixQty width-locked -> MIN length ────────────────────────────────────────

describe('solver: fixQty width-locked min length', () => {
  it('solves the minimum length on a fixed width, all placed', async () => {
    // Three 10x10 squares (locked, no spacing) on a width-locked sheet of width
    // 12. Width 12 holds ONE column, so three squares stack to height 30. Hand-
    // derived minimum length = 30 mm. The solver should land within ~1mm of 30,
    // never below it, with all three placed.
    const sq = rect('q', 10, 10)
    const req = baseRequest({
      parts: [{ part: sq, quantity: 3 }],
      sheet: { width: 12, height: 0 }, // height is the free axis (solved)
      solver: { kind: 'fixQty', lockedAxis: 'width' },
    })
    const result = await solveNest(req)
    expect(result.placements.length).toBe(3)
    expect(result.unplaced).toEqual([])
    expect(result.sheetUsed.width).toBe(12) // locked axis unchanged
    // solved height within tolerance of the hand-derived 30mm minimum; a little
    // slack above 30 is allowed (binary search stops at its 0.5mm TOL). Must not
    // dip below the geometric 30.
    expect(result.sheetUsed.height).toBeGreaterThanOrEqual(30 - 1e-6)
    expect(result.sheetUsed.height).toBeLessThanOrEqual(30 + 1.5)
  })

  it('one notch below the solved length leaves parts unplaced (monotonic boundary)', async () => {
    // Same fixture. Force the height to 28 (< the 30 minimum) via a fixSheet pack
    // on that exact size: three full rows cannot fit in a single 12-wide column,
    // so at least one square is unplaced. This proves the solved length is a
    // genuine boundary, not idle slack.
    const sq = rect('q', 10, 10)
    const tight = await solveNest(
      baseRequest({
        parts: [{ part: sq, quantity: 3 }],
        sheet: { width: 12, height: 28 },
        solver: { kind: 'fixSheet' },
      })
    )
    const unplacedCount = tight.unplaced.reduce((n, u) => n + u.count, 0)
    expect(unplacedCount).toBeGreaterThan(0)
  })
})

// ── fixQty none-locked -> MIN area ───────────────────────────────────────────

describe('solver: fixQty none-locked min area', () => {
  it('returns a sheet that fits ALL parts within a generous area upper bound', async () => {
    // Four 10x10 squares (locked, no spacing). Total part area = 400 mm^2. The
    // tightest single column is 10 x 40 = 400. The bounded width scan + faceting
    // may pick a wider/longer sheet, so allow a healthy ~3x slack -> area <= 1200
    // mm^2. The real gate: ALL four placed (unplaced empty) on a both-axes-free
    // solved sheet.
    const sq = rect('m', 10, 10)
    const req = baseRequest({
      parts: [{ part: sq, quantity: 4 }],
      sheet: { width: 0, height: 0 }, // both free
      solver: { kind: 'fixQty', lockedAxis: 'none' },
    })
    const result = await solveNest(req)
    expect(result.placements.length).toBe(4)
    expect(result.unplaced).toEqual([])
    const area = result.sheetUsed.width * result.sheetUsed.height
    expect(area).toBeLessThanOrEqual(1200) // generous sanity bound, not optimal
  })
})

// ── fixQtyRatio -> fixed-aspect auto-size ────────────────────────────────────

describe('solver: fixQtyRatio fixed-aspect auto-size', () => {
  it('ratio 1 yields a ~square sheet that places ALL requested (exact qty)', async () => {
    // Four 10x10 squares (locked, no spacing). A ratio-1 (square) sheet must hold
    // all four. The packer lays a clean grid here only loosely, so the gate is:
    // all four placed, none unplaced, and the solved sheet is ~square (H/W ~= 1).
    const sq = rect('rs', 10, 10)
    const req = baseRequest({
      parts: [{ part: sq, quantity: 4 }],
      sheet: { width: 0, height: 0 }, // both auto-sized by the ratio solver
      solver: { kind: 'fixQtyRatio', ratio: 1 },
    })
    const result = await solveNest(req)
    expect(result.placements.length).toBe(4)
    expect(result.unplaced).toEqual([])
    const aspect = result.sheetUsed.height / result.sheetUsed.width
    expect(aspect).toBeGreaterThan(0.9)
    expect(aspect).toBeLessThan(1.1)
  })

  it('ratio 2 yields a sheet ~twice as tall as wide, all placed', async () => {
    const sq = rect('rt', 10, 10)
    const req = baseRequest({
      parts: [{ part: sq, quantity: 4 }],
      sheet: { width: 0, height: 0 },
      solver: { kind: 'fixQtyRatio', ratio: 2 },
    })
    const result = await solveNest(req)
    expect(result.placements.length).toBe(4)
    expect(result.unplaced).toEqual([])
    const aspect = result.sheetUsed.height / result.sheetUsed.width
    expect(aspect).toBeGreaterThan(1.9)
    expect(aspect).toBeLessThan(2.1)
  })

  it('is byte-identical for the same seed (determinism)', async () => {
    const mk = (): NestRequest =>
      baseRequest({
        parts: [{ part: rect('rd', 10, 10), quantity: 3 }],
        sheet: { width: 0, height: 0 },
        solver: { kind: 'fixQtyRatio', ratio: 1 },
        seed: 777,
      })
    const r1 = await solveNest(mk())
    const r2 = await solveNest(mk())
    expect(r2).toEqual(r1)
  })

  it('an invalid ratio (<= 0) falls back to the free min-area solve, all placed', async () => {
    // ADR 0003: an invalid ratio must not silently misshape the sheet; the solver
    // falls back to the free-aspect min-area solve (named console warning) and
    // still places everything.
    const sq = rect('ri', 10, 10)
    const req = baseRequest({
      parts: [{ part: sq, quantity: 4 }],
      sheet: { width: 0, height: 0 },
      solver: { kind: 'fixQtyRatio', ratio: 0 },
    })
    const result = await solveNest(req)
    expect(result.placements.length).toBe(4)
    expect(result.unplaced).toEqual([])
  })
})

// ── DETERMINISM ──────────────────────────────────────────────────────────────

describe('solver: determinism', () => {
  it('fixSheet is byte-identical for the same seed', async () => {
    const mk = (): NestRequest =>
      baseRequest({
        parts: [{ part: rect('d', 10, 10), quantity: 1 }],
        sheet: { width: 12, height: 80 },
        seed: 999,
      })
    const r1 = await solveNest(mk())
    const r2 = await solveNest(mk())
    expect(r2).toEqual(r1)
  })

  it('fixQty width-locked is byte-identical for the same seed', async () => {
    const mk = (): NestRequest =>
      baseRequest({
        parts: [{ part: rect('d', 10, 10), quantity: 4 }],
        sheet: { width: 12, height: 0 },
        solver: { kind: 'fixQty', lockedAxis: 'width' },
        seed: 333,
      })
    const r1 = await solveNest(mk())
    const r2 = await solveNest(mk())
    expect(r2).toEqual(r1)
  })

  it('fixQty none-locked is byte-identical for the same seed', async () => {
    const mk = (): NestRequest =>
      baseRequest({
        parts: [{ part: rect('d', 10, 10), quantity: 3 }],
        sheet: { width: 0, height: 0 },
        solver: { kind: 'fixQty', lockedAxis: 'none' },
        seed: 555,
      })
    const r1 = await solveNest(mk())
    const r2 = await solveNest(mk())
    expect(r2).toEqual(r1)
  })
})

// ── ADR 0003: impossible requests surface leftovers, never silent success ────

describe('solver: ADR 0003 explicit failure', () => {
  it('fixSheet with a part bigger than the sheet reports M=0 leftovers, not empty success', async () => {
    // A 60x60 square on a 50x50 sheet: even one copy cannot fit. The solver must
    // NOT return a clean empty result; it returns the best single-set pack with
    // the leftover reported EXPLICITLY (ADR 0003 - no silent drop).
    const big = rect('big', 60, 60)
    const result = await solveNest(
      baseRequest({
        parts: [{ part: big, quantity: 1 }],
        sheet: { width: 50, height: 50 },
      })
    )
    expect(result.placements.length).toBe(0)
    const left = result.unplaced.find((u) => u.partId === 'big')
    expect(left).toBeDefined()
    expect(left!.count).toBe(1) // the leftover is named with its count
  })

  it('fixQty width-locked with a part wider than the locked width reports leftovers', async () => {
    // Part is 30 wide; locked width is 20. No length can ever make it fit on a
    // 20-wide sheet. The solver must surface the leftover EXPLICITLY rather than
    // silently returning an empty placement set (ADR 0003).
    const wide = rect('wide', 30, 10)
    const result = await solveNest(
      baseRequest({
        parts: [{ part: wide, quantity: 2 }],
        sheet: { width: 20, height: 0 },
        solver: { kind: 'fixQty', lockedAxis: 'width' },
      })
    )
    const totalUnplaced = result.unplaced.reduce((n, u) => n + u.count, 0)
    expect(totalUnplaced).toBeGreaterThan(0) // explicit leftovers, not silent
    // conservation: any parts it DID place plus the leftovers == requested.
    expect(result.placements.length + totalUnplaced).toBe(2)
  })
})

// ── geometric sanity: placements stay in the solved sheet ────────────────────

describe('solver: placements stay inside the solved sheet', () => {
  it('width-locked solved sheet contains every placement', async () => {
    const sq = rect('c', 10, 10)
    const req = baseRequest({
      parts: [{ part: sq, quantity: 4 }],
      sheet: { width: 12, height: 0 },
      solver: { kind: 'fixQty', lockedAxis: 'width' },
    })
    const result = await solveNest(req)
    const TOL = 0.5
    for (const p of result.placements) {
      const src = req.parts.find((e) => e.part.id === p.partId)!.part
      for (const v of transformRing(src.outer, p.rotationDeg, p.x, p.y)) {
        expect(v.x).toBeGreaterThanOrEqual(-TOL)
        expect(v.y).toBeGreaterThanOrEqual(-TOL)
        expect(v.x).toBeLessThanOrEqual(result.sheetUsed.width + TOL)
        expect(v.y).toBeLessThanOrEqual(result.sheetUsed.height + TOL)
      }
    }
  })
})
