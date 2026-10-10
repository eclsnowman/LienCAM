/* Tests for the P1.2 packer (src/lib/cam/nesting/index.ts packNest + the
 * placement worker + seeded GA). Each test is a real gate per
 * NESTING-P1-ENGINE-PLAN.md P1.2:
 *   - NO OVERLAP + SPACING (achieved edge-to-edge clearance >= partGap, inside
 *     sheet minus sheetMargin)
 *   - IN-BOUNDS (every transformed placement within the sheet)
 *   - DETERMINISM (two runs, same seed/input -> deep-equal placements) <- key
 *   - UTILIZATION (matches a hand-computed ratio on a simple fixture)
 *   - ORIENTATION LOCK (a locked part only ever appears at its locked angle)
 *   - STYLE 'ninety' (all rotationDeg in {0,90,180,270})
 *   - OVER-CAPACITY (more parts than fit -> exact leftover count, no silent drop)
 *
 * Fixtures are tiny; expected-value reasoning is in comments. packNest is async
 * (awaits clipper2-wasm init), so every test awaits it.
 */

import { describe, it, expect } from 'vitest'
import { Worker } from 'node:worker_threads'
import os from 'node:os'
import type { Vec2 } from '../../../types/index'
import { packNest, transformRing } from '../../../lib/cam/nesting'
import type { NestPart, NestRequest, Placement } from '../../../lib/cam/nesting'
import { intersect, pointInPolygon } from '../../../lib/cam/nesting/geometry'

// ── fixtures / helpers ──────────────────────────────────────────────────────

/** Axis-aligned square of side `s` with lower-left at origin (CCW). */
function square(id: string, s: number, locked?: number): NestPart {
  return {
    id,
    outer: [
      { x: 0, y: 0 },
      { x: s, y: 0 },
      { x: s, y: s },
      { x: 0, y: s },
    ],
    holes: [],
    ...(locked !== undefined ? { lockedRotationDeg: locked } : {}),
  }
}

function rectangle(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  lockedRotationDeg: number,
): NestPart {
  return {
    id,
    outer: [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height },
    ],
    holes: [],
    lockedRotationDeg,
  }
}

/** L-shape (concave), bounding 10x10, CCW. */
function lShape(id: string): NestPart {
  return {
    id,
    outer: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 4 },
      { x: 4, y: 4 },
      { x: 4, y: 10 },
      { x: 0, y: 10 },
    ],
    holes: [],
  }
}

/** The placed (transformed) outer ring of a placement, given its source part. */
function placedRing(p: Placement, parts: NestPart[]): Vec2[] {
  const src = parts.find((s) => s.id === p.partId)!
  return transformRing(src.outer, p.rotationDeg, p.x, p.y)
}

/** Minimum edge-to-edge distance between two convex-ish rings (vertex-to-edge
 *  both ways). Adequate for axis-aligned/L fixtures; a lower bound on clearance. */
function ringClearance(a: Vec2[], b: Vec2[]): number {
  let min = Infinity
  const segDist = (p: Vec2, q1: Vec2, q2: Vec2): number => {
    const dx = q2.x - q1.x
    const dy = q2.y - q1.y
    const len2 = dx * dx + dy * dy
    let t = len2 === 0 ? 0 : ((p.x - q1.x) * dx + (p.y - q1.y) * dy) / len2
    t = Math.max(0, Math.min(1, t))
    const cx = q1.x + t * dx
    const cy = q1.y + t * dy
    return Math.hypot(p.x - cx, p.y - cy)
  }
  const each = (P: Vec2[], Q: Vec2[]) => {
    for (const p of P) {
      for (let i = 0; i < Q.length; i++) {
        const d = segDist(p, Q[i], Q[(i + 1) % Q.length])
        if (d < min) min = d
      }
    }
  }
  each(a, b)
  each(b, a)
  return min
}

/** Busy-loop body run in each load worker (BK-7 determinism-under-load proof):
 *  a tight synchronous CPU spin, no timers/awaits, so it genuinely occupies a
 *  core rather than yielding to the event loop. Self-capped at 20s as a safety
 *  net; the real stop is worker.terminate() in saturateCpu's returned cleanup. */
const BUSY_LOOP_SRC = `
  const stop = Date.now() + 20000
  while (Date.now() < stop) { for (let i = 0; i < 1e6; i++) Math.sqrt(i) }
`

/** Spawn 3x-CPU-core busy-loop worker_threads to saturate the machine while a
 *  test packs, reproducing the CPU contention that made BK-7 flake in a
 *  full-suite run. Oversubscribing (not just 1x cores) is deliberate: 1x
 *  merely slows the main thread by a roughly constant factor, which an old
 *  wall-clock deadline tends to cross at the same generation boundary every
 *  time (no divergence); 3x adds real OS-scheduler preemption jitter between
 *  the two sequential packNest calls below, which is what actually reproduced
 *  the fails-if divergence (see INT-H1 report) -- confirmed empirically, not
 *  a theoretical claim. Returns an async cleanup that terminates every worker. */
function saturateCpu(): () => Promise<void> {
  const n = Math.max(1, os.cpus().length * 3)
  const workers = Array.from({ length: n }, () => new Worker(BUSY_LOOP_SRC, { eval: true }))
  return async () => {
    await Promise.all(workers.map((w) => w.terminate()))
  }
}

/** Do two placed rings overlap on positive area? */
function overlap(a: Vec2[], b: Vec2[]): boolean {
  const ac = [...a, a[0]]
  const bc = [...b, b[0]]
  if (intersect(ac, bc)) return true
  for (const v of a) if (pointInPolygon(v, b) === true) return true
  for (const v of b) if (pointInPolygon(v, a) === true) return true
  return false
}

function baseRequest(over: Partial<NestRequest> = {}): NestRequest {
  return {
    parts: [],
    sheet: { width: 100, height: 100 },
    style: 'ninety',
    spacing: { partGap: 0, sheetMargin: 0, windowGap: 0 },
    solver: { kind: 'fixSheet' },
    seed: 12345,
    ...over,
  }
}

// ── NO OVERLAP + SPACING ────────────────────────────────────────────────────

describe('packer: no overlap + spacing clearance', () => {
  it('places squares with no overlap, partGap clearance, inside sheetMargin', async () => {
    const sq = square('sq', 20)
    const req = baseRequest({
      parts: [{ part: sq, quantity: 6 }],
      sheet: { width: 100, height: 100 },
      spacing: { partGap: 3, sheetMargin: 5, windowGap: 0 },
      style: 'ninety',
    })
    const result = await packNest(req)

    expect(result.placements.length).toBeGreaterThan(1)
    const rings = result.placements.map((p) => placedRing(p, [sq]))

    // pairwise: no overlap, and edge-to-edge clearance >= partGap (minus a tiny
    // numeric/faceting tolerance from the round-offset spacing envelope).
    const GAP = 3
    const TOL = 0.25
    for (let i = 0; i < rings.length; i++) {
      for (let j = i + 1; j < rings.length; j++) {
        expect(overlap(rings[i], rings[j])).toBe(false)
        expect(ringClearance(rings[i], rings[j])).toBeGreaterThanOrEqual(GAP - TOL)
      }
    }

    // every placed part inside the sheet minus the sheetMargin keep-out
    const MARGIN = 5
    for (const ring of rings) {
      for (const v of ring) {
        expect(v.x).toBeGreaterThanOrEqual(MARGIN - TOL)
        expect(v.y).toBeGreaterThanOrEqual(MARGIN - TOL)
        expect(v.x).toBeLessThanOrEqual(100 - MARGIN + TOL)
        expect(v.y).toBeLessThanOrEqual(100 - MARGIN + TOL)
      }
    }
  }, 60000) // BK-7: pure generation-count GA (no wall-clock bailout) x this
  // fixture's partGap-grown polygons is genuinely slow per placement.ts/nfp.ts's
  // orbit cost (measured ~45s here) - see INT-H1 report for the newly-exposed,
  // pre-existing NFP-orbit performance characteristic this timeout accommodates.

  it('places L-shapes without overlap', async () => {
    const l = lShape('L')
    const req = baseRequest({
      parts: [{ part: l, quantity: 4 }],
      sheet: { width: 60, height: 60 },
      spacing: { partGap: 2, sheetMargin: 0, windowGap: 0 },
      style: 'ninety',
    })
    const result = await packNest(req)
    expect(result.placements.length).toBeGreaterThan(1)
    const rings = result.placements.map((p) => placedRing(p, [l]))
    for (let i = 0; i < rings.length; i++) {
      for (let j = i + 1; j < rings.length; j++) {
        expect(overlap(rings[i], rings[j])).toBe(false)
      }
    }
  }, 40000) // BK-7: same pure generation-count cost note as above (measured ~24s)

  it('keeps rotated multi-object groups separated and inside usable stock', async () => {
    // These source outlines intentionally live in different coordinate frames.
    // A group placement must apply one rigid pose to each source outline without
    // assuming its local bounds start at the origin.
    const wide = rectangle('wide', 20, 30, 12, 6, 90)
    const tall = rectangle('tall', -8, 4, 6, 12, 0)
    const parts = [wide, tall]
    const req = baseRequest({
      parts: [
        { part: wide, quantity: 2 },
        { part: tall, quantity: 2 },
      ],
      sheet: { width: 70, height: 50 },
      spacing: { partGap: 3, sheetMargin: 4, windowGap: 0 },
      style: 'ninety',
    })

    const result = await packNest(req)
    expect(result.placements.length).toBeGreaterThan(1)
    expect(result.placements.length + result.unplaced.length).toBe(4)
    expect(new Set(result.placements.map((item) => item.instanceId)).size).toBe(
      result.placements.length,
    )

    const rings = result.placements.map((item) => placedRing(item, parts))
    const tolerance = 0.25
    for (let index = 0; index < rings.length; index++) {
      for (const point of rings[index]) {
        expect(point.x).toBeGreaterThanOrEqual(4 - tolerance)
        expect(point.y).toBeGreaterThanOrEqual(4 - tolerance)
        expect(point.x).toBeLessThanOrEqual(66 + tolerance)
        expect(point.y).toBeLessThanOrEqual(46 + tolerance)
      }
      for (let other = index + 1; other < rings.length; other++) {
        expect(overlap(rings[index], rings[other])).toBe(false)
        expect(ringClearance(rings[index], rings[other])).toBeGreaterThanOrEqual(
          3 - tolerance,
        )
      }
    }
  }, 30000)
})

// ── IN-BOUNDS ───────────────────────────────────────────────────────────────

describe('packer: in-bounds', () => {
  it('keeps every placement within the sheet rectangle', async () => {
    const sq = square('sq', 15)
    const req = baseRequest({
      parts: [{ part: sq, quantity: 8 }],
      sheet: { width: 80, height: 80 },
    })
    const result = await packNest(req)
    const TOL = 0.25
    for (const p of result.placements) {
      for (const v of placedRing(p, [sq])) {
        expect(v.x).toBeGreaterThanOrEqual(-TOL)
        expect(v.y).toBeGreaterThanOrEqual(-TOL)
        expect(v.x).toBeLessThanOrEqual(80 + TOL)
        expect(v.y).toBeLessThanOrEqual(80 + TOL)
      }
    }
  })
})

// ── DETERMINISM (the key gate) ──────────────────────────────────────────────

describe('packer: determinism', () => {
  it('produces byte-identical placements for the same seed/input', async () => {
    const mk = (): NestRequest =>
      baseRequest({
        parts: [
          { part: square('a', 18), quantity: 4 },
          { part: lShape('b'), quantity: 3 },
        ],
        sheet: { width: 90, height: 90 },
        spacing: { partGap: 1.5, sheetMargin: 2, windowGap: 0 },
        style: 'arbitrary',
        rotationCount: 4,
        seed: 777,
      })
    const r1 = await packNest(mk())
    const r2 = await packNest(mk())
    expect(r2.placements).toEqual(r1.placements)
    expect(r2.unplaced).toEqual(r1.unplaced)
    expect(r2.utilization).toBe(r1.utilization)
  }, 120000) // BK-7: two full GA packs, pure generation-count (no wall-clock
  // bailout); this fixture's partGap-grown concave+convex mix is genuinely slow
  // per placement.ts/nfp.ts's orbit cost (measured ~90s for both packs combined
  // - see INT-H1 report for the newly-exposed, pre-existing NFP-orbit
  // performance characteristic this timeout accommodates).

  it('different seeds may differ, same seed never does', async () => {
    const mk = (seed: number): NestRequest =>
      baseRequest({
        parts: [{ part: square('s', 22), quantity: 6 }],
        sheet: { width: 100, height: 100 },
        seed,
      })
    const a = await packNest(mk(1))
    const a2 = await packNest(mk(1))
    expect(a2.placements).toEqual(a.placements)
  }, 20000) // two full GA packs; the 5s default flakes under full-suite load

  // BK-7: two same-process packNest runs on identical input produced DIFFERENT
  // placements under CPU load, because the GA generation loop used to consult
  // performance.now() against a soft deadline (index.ts) to decide when to stop
  // -- under load, a run could complete fewer generations (or truncate mid-
  // generation, leaving some individuals unscored) than the same run on a quiet
  // machine, diverging the final population from the identical seeded rng
  // sequence. Fixed by bounding the search ONLY by DEFAULT_GENERATION_CAP (a
  // fixed, input-independent iteration count) -- never wall-clock. This test
  // saturates every core with busy-loop worker_threads WHILE packing runs, so a
  // regression back to a wall-clock decision would flake here under a quiet-
  // machine full-suite run too (proven by reverting the fix locally: FAILS
  // under this load, per the WO's fails-if requirement -- see INT-H1 report).
  it('produces byte-identical placements while synthetic CPU load saturates every core', async () => {
    const stopLoad = saturateCpu()
    try {
      // Deliberately SMALLER than the plain byte-identical fixture above (3
      // instances, not 7): the GA's per-individual placement cost scales with
      // pairwise NFP calls (placement.ts/nfp.ts orbit, ~50ms each for simple
      // convex rings - see INT-H1 report), so this keeps the busy-loop-saturated
      // run bounded while still exercising the full GA generation/rotation
      // search this fix governs.
      const mk = (): NestRequest =>
        baseRequest({
          parts: [{ part: square('a', 18), quantity: 3 }],
          sheet: { width: 90, height: 90 },
          spacing: { partGap: 1.5, sheetMargin: 2, windowGap: 0 },
          style: 'arbitrary',
          rotationCount: 4,
          seed: 777,
          // On the FIXED packer this field is dead wire-compat (ignored
          // entirely, see types.ts) so it cannot affect the assertions below.
          // It exists purely for the fails-if proof (revert this fix locally):
          // 900ms sits mid-run for this fixture's ~1.6-2s unthrottled 8-gen
          // search, so under this test's 3x-core-oversubscribed load, whether
          // the OLD wall-clock deadline trips before or after a given
          // individual/generation is jitter-sensitive and genuinely varies
          // run-to-run - empirically reproduced (see INT-H1 report: reverting
          // this fix with this exact setup failed ~2/4 reps; the fix passed
          // 5/5 under the same load). A too-small budget (e.g. tens of ms)
          // instead bails deterministically on gen 0's first individual every
          // time, on both runs alike, and never actually exercises the race.
          timeBudgetMs: 900,
        })
      const r1 = await packNest(mk())
      const r2 = await packNest(mk())
      expect(r2.placements).toEqual(r1.placements)
      expect(r2.unplaced).toEqual(r1.unplaced)
      expect(r2.utilization).toBe(r1.utilization)
    } finally {
      await stopLoad()
    }
  }, 60000)
})

// ── UTILIZATION ─────────────────────────────────────────────────────────────

describe('packer: utilization', () => {
  it('matches the hand-computed placed-area / sheet-area ratio', async () => {
    // four 10x10 squares = 400 placed area; sheet 50x50 = 2500. They all fit
    // (no spacing, plenty of room) -> utilization = 400/2500 = 0.16.
    const sq = square('u', 10)
    const req = baseRequest({
      parts: [{ part: sq, quantity: 4 }],
      sheet: { width: 50, height: 50 },
      spacing: { partGap: 0, sheetMargin: 0, windowGap: 0 },
    })
    const result = await packNest(req)
    expect(result.placements.length).toBe(4)
    expect(result.utilization).toBeCloseTo(400 / 2500, 6)
  })

  // ── TRUE-REQUIREMENT UTILIZATION GATE ─────────────────────────────────────
  // The whole point of nesting is utilization. These cases are trivially
  // tileable (a 2x2 grid fits with room to spare), so a correct packer MUST
  // place ALL parts. They FAIL on the pre-fix bottom-left-vs-smallest-x
  // tie-break, which stranded the 4th square by building a single x=0 column
  // (placement.ts gravity tie-break). Do NOT relax these to "narrow column"
  // fixtures - that would mask the very defect they exist to catch.
  it('places ALL 4 of four 25mm squares on a 70x70 sheet (2x2 grid fits trivially)', async () => {
    // 2x2 grid of 25mm squares spans 50x50, fitting inside 70x70 with 20mm to
    // spare in each axis. A correct packer leaves ZERO unplaced.
    const sq = square('grid', 25)
    const req = baseRequest({
      parts: [{ part: sq, quantity: 4 }],
      sheet: { width: 70, height: 70 },
      spacing: { partGap: 0, sheetMargin: 0, windowGap: 0 },
      style: 'ninety',
    })
    const result = await packNest(req)
    expect(result.placements.length).toBe(4)
    expect(result.unplaced).toEqual([])
    // utilization floor: all four 25mm squares placed = 4*625 / (70*70) = 2500/4900.
    expect(result.utilization).toBeCloseTo(2500 / 4900, 6)
  })

  it('meets the obvious lower-bound utilization for a known-tileable 3x3 grid', async () => {
    // nine 20mm squares tile a 60x60 region exactly; sheet 64x64 gives a 2mm
    // border in each axis. A column-stacking packer would strand most of them.
    // Lower bound: a perfect 3x3 grid -> 9*400 / (64*64) = 3600/4096 ~= 0.879.
    const sq = square('tile', 20)
    const req = baseRequest({
      parts: [{ part: sq, quantity: 9 }],
      sheet: { width: 64, height: 64 },
      spacing: { partGap: 0, sheetMargin: 0, windowGap: 0 },
      style: 'ninety',
    })
    const result = await packNest(req)
    expect(result.placements.length).toBe(9)
    expect(result.utilization).toBeGreaterThanOrEqual(3600 / 4096 - 1e-6)
  })
})

// ── ORIENTATION LOCK ────────────────────────────────────────────────────────

describe('packer: orientation lock', () => {
  it('only ever places a locked part at its locked angle', async () => {
    // a NON-square (rectangle) locked to 0 deg; even under 'arbitrary' style the
    // GA may not rotate it, so every placement must read rotationDeg === 0.
    const rect: NestPart = {
      id: 'lock',
      outer: [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 8 },
        { x: 0, y: 8 },
      ],
      holes: [],
      lockedRotationDeg: 0,
    }
    const req = baseRequest({
      parts: [{ part: rect, quantity: 5 }],
      sheet: { width: 100, height: 100 },
      style: 'arbitrary',
      rotationCount: 4,
    })
    const result = await packNest(req)
    expect(result.placements.length).toBeGreaterThan(0)
    for (const p of result.placements) {
      expect(p.rotationDeg).toBe(0)
    }
  })
})

// ── STYLE 'ninety' ──────────────────────────────────────────────────────────

describe("packer: style 'ninety'", () => {
  it('uses only 0/90/180/270 degree rotations', async () => {
    const rect: NestPart = {
      id: 'r',
      outer: [
        { x: 0, y: 0 },
        { x: 16, y: 0 },
        { x: 16, y: 6 },
        { x: 0, y: 6 },
      ],
      holes: [],
    }
    const req = baseRequest({
      parts: [{ part: rect, quantity: 6 }],
      sheet: { width: 100, height: 100 },
      style: 'ninety',
    })
    const result = await packNest(req)
    expect(result.placements.length).toBeGreaterThan(0)
    for (const p of result.placements) {
      expect([0, 90, 180, 270]).toContain(p.rotationDeg)
    }
  })
})

// ── OVER-CAPACITY ───────────────────────────────────────────────────────────

describe('packer: over-capacity leftovers', () => {
  it('reports the exact leftover count when more parts are requested than fit', async () => {
    // 40x40 squares on a 50x50 sheet: only ONE fits. Request 3 -> 2 unplaced.
    const sq = square('big', 40)
    const req = baseRequest({
      parts: [{ part: sq, quantity: 3 }],
      sheet: { width: 50, height: 50 },
      spacing: { partGap: 0, sheetMargin: 0, windowGap: 0 },
    })
    const result = await packNest(req)
    expect(result.placements.length).toBe(1)
    // no silent drop: leftovers explicitly reported (ADR 0003)
    const left = result.unplaced.find((u) => u.partId === 'big')
    expect(left).toBeDefined()
    expect(left!.count).toBe(2)
    // conservation: placed + unplaced == requested
    expect(result.placements.length + left!.count).toBe(3)
  })
})
