/* Tests for P2 - the INSIDE-WINDOW engine extension (src/lib/cam/nesting:
 * packNest Phase B + the placeInWindows helper). A "window" is a designated
 * interior loop of a host part; leftover parts that did not fit the open sheet
 * may be nested inside it to use the host's waste (NESTING-SPEC.md item 7, ADR
 * 0024). No recursion in v1.
 *
 * Each test is a real gate:
 *   - WINDOW PLACEMENT (e2e via packNest): a host that FILLS the sheet plus small
 *     parts that overflow -> the overflow nests inside the host's window with
 *     depth=1 and windowParentId = the host instanceId; the nested part's
 *     vertices lie INSIDE the host-posed window loop, with >= windowGap clearance
 *     to the boundary.
 *     [Why a host-fills-the-sheet fixture: the on-sheet GA scores by parts-placed
 *     and is blind to a window's bonus capacity, so it only KEEPS a host when
 *     dropping it would not let it place MORE on-sheet parts. A window can never
 *     hold more parts than the (strictly larger) bare sheet, so the GA reliably
 *     keeps the host only in the fitness TIE where the bare sheet holds exactly
 *     ONE small (host placed -> N unplaced; host dropped -> 1 host + (N-1)
 *     unplaced = N; tie -> the area-descending seed, host first, wins). That ties
 *     the host-kept e2e case to a SINGLE nested child. The multi-sibling
 *     clearance + no-overlap requirement is therefore gated DIRECTLY against
 *     placeInWindows below, which is the same engine code Phase B calls.]
 *   - HOST DEPTH: the host part itself is depth=0.
 *   - MULTI-SIBLING (direct, placeInWindows): several parts in ONE window are
 *     placed with depth=1 + the host instanceId, all inside the posed window, and
 *     do NOT overlap (clearance >= windowGap between siblings and to the boundary).
 *   - TOO BIG: a part too big for the window stays UNPLACED (explicit, ADR 0003).
 *   - DETERMINISM: two runs deep-equal (incl. windowParentId / depth).
 *   - NO-REGRESSION: a request with NO windows packs exactly as P1 (all depth 0,
 *     no windowParentId).
 *
 * packNest is async (awaits clipper2-wasm init), so every packNest test awaits it.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import type { Vec2 } from '../../../types/index'
import { packNest, placeInWindows, transformRing } from '../../../lib/cam/nesting'
import type { NestPart, NestRequest, Placement, WindowInst } from '../../../lib/cam/nesting'
import { intersect, pointInPolygon, polygonArea } from '../../../lib/cam/nesting/geometry'
import { ensureEngineClipperReady } from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'

// ── fixtures / helpers ──────────────────────────────────────────────────────

/** Axis-aligned square of side `s`, lower-left at origin (CCW). */
function square(id: string, s: number): NestPart {
  return {
    id,
    outer: [
      { x: 0, y: 0 },
      { x: s, y: 0 },
      { x: s, y: s },
      { x: 0, y: s },
    ],
    holes: [],
  }
}

/** A big square host (side `s`) with a centered square window of side `w`. The
 *  window is both a hole and a designated nesting window (CCW like the outer). */
function hostWithWindow(id: string, s: number, w: number): NestPart {
  const lo = (s - w) / 2
  const hi = lo + w
  const win: Vec2[] = [
    { x: lo, y: lo },
    { x: hi, y: lo },
    { x: hi, y: hi },
    { x: lo, y: hi },
  ]
  return {
    id,
    outer: [
      { x: 0, y: 0 },
      { x: s, y: 0 },
      { x: s, y: s },
      { x: 0, y: s },
    ],
    holes: [win],
    windows: [win],
  }
}

/** The placed (transformed) outer ring of a placement, given its source part. */
function placedRing(p: Placement, parts: NestPart[]): Vec2[] {
  const src = parts.find((s) => s.id === p.partId)!
  return transformRing(src.outer, p.rotationDeg, p.x, p.y)
}

/** The host-posed window loop for a host placement (window in world coords). */
function posedWindow(host: Placement, parts: NestPart[]): Vec2[] {
  const src = parts.find((s) => s.id === host.partId)!
  return transformRing(src.windows![0], host.rotationDeg, host.x, host.y)
}

/** Min edge-to-edge distance between two rings (vertex-to-edge both ways). */
function ringClearance(a: Vec2[], b: Vec2[]): number {
  let min = Infinity
  const segDist = (p: Vec2, q1: Vec2, q2: Vec2): number => {
    const dx = q2.x - q1.x
    const dy = q2.y - q1.y
    const len2 = dx * dx + dy * dy
    let t = len2 === 0 ? 0 : ((p.x - q1.x) * dx + (p.y - q1.y) * dy) / len2
    t = Math.max(0, Math.min(1, t))
    return Math.hypot(p.x - (q1.x + t * dx), p.y - (q1.y + t * dy))
  }
  const each = (P: Vec2[], Q: Vec2[]) => {
    for (const p of P)
      for (let i = 0; i < Q.length; i++) {
        const d = segDist(p, Q[i], Q[(i + 1) % Q.length])
        if (d < min) min = d
      }
  }
  each(a, b)
  each(b, a)
  return min
}

/** Do two placed rings overlap on positive area? */
function overlap(a: Vec2[], b: Vec2[]): boolean {
  if (intersect([...a, a[0]], [...b, b[0]])) return true
  for (const v of a) if (pointInPolygon(v, b) === true) return true
  for (const v of b) if (pointInPolygon(v, a) === true) return true
  return false
}

/** True if every vertex of `ring` is inside (or on) `poly` (none strictly out). */
function ringInside(ring: Vec2[], poly: Vec2[]): boolean {
  for (const v of ring) {
    if (pointInPolygon(v, poly) === false) return false // strictly outside
  }
  return true
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

// ── WINDOW PLACEMENT (e2e via packNest) ──────────────────────────────────────

describe('inside-window: an overflow part nests in a host window (e2e)', () => {
  // Host 80x80 with a centered 70x70 window FILLS an 80x80 sheet. small=50x50,
  // qty 3. The host occupies the whole sheet, so NO small fits beside it. A bare
  // 80x80 sheet would fit exactly ONE 50x50 -> the GA's host-kept vs host-dropped
  // genes TIE on unplaced count, and the area-descending seed (host first) wins,
  // so the host is placed. The three 50x50 smalls overflow; the 70x70 window
  // (shrunk by windowGap/2 to 69 and the part grown by windowGap/2 to 51) admits
  // exactly ONE, which Phase B nests. (The remaining two are genuine leftovers.)
  const WINDOW_GAP = 2

  it('nests the overflow part with depth=1 + host instanceId, inside the posed window', async () => {
    const host = hostWithWindow('host', 80, 70)
    const small = square('small', 50)
    const req = baseRequest({
      parts: [
        { part: host, quantity: 1 },
        { part: small, quantity: 3 },
      ],
      sheet: { width: 80, height: 80 },
      spacing: { partGap: 0, sheetMargin: 0, windowGap: WINDOW_GAP },
      style: 'ninety',
    })
    const result = await packNest(req)

    const hostP = result.placements.find((p) => p.partId === 'host')
    expect(hostP).toBeDefined()
    expect(hostP!.depth).toBe(0) // host is on the sheet
    expect(hostP!.windowParentId).toBeUndefined()

    const children = result.placements.filter((p) => p.partId === 'small')
    expect(children.length).toBe(1) // exactly one 50mm part fits the 70mm window
    for (const c of children) {
      expect(c.depth).toBe(1)
      expect(c.windowParentId).toBe(hostP!.instanceId)
    }

    // the nested part is inside the host-posed window, with >= windowGap to the
    // boundary (part-to-window clearance).
    const window = posedWindow(hostP!, [host])
    const TOL = 0.25 // round-offset faceting slack on the windowGap envelope
    for (const c of children) {
      const ring = placedRing(c, [small])
      expect(ringInside(ring, window)).toBe(true)
      expect(ringClearance(ring, window)).toBeGreaterThanOrEqual(WINDOW_GAP - TOL)
    }

    // conservation: 1 nested + 2 leftover == 3 requested smalls (ADR 0003)
    const left = result.unplaced.find((u) => u.partId === 'small')
    expect(left?.count ?? 0).toBe(2)
  })
})

// ── MULTI-SIBLING (direct gate on the engine's window placer) ─────────────────

describe('inside-window: several siblings nest in one window without overlap', () => {
  // Gated directly against placeInWindows - the exact engine code Phase B calls -
  // because the on-sheet GA will not keep a host when a window holds 2+ parts
  // (see the e2e note above). Here a single 100x100 host is "already placed" at
  // the origin with a 90x90 window; four 18x18 squares are handed in as the
  // leftover set. A 2x2 grid of 18mm squares with a 2mm windowGap spans ~38mm,
  // fitting the 90mm window with room to spare -> all four should nest.
  const WINDOW_GAP = 2

  beforeAll(async () => {
    await ensureEngineClipperReady() // placeInWindows uses clipper offsets/union
  })

  it('places 4 siblings depth=1 inside the window, no overlap, clearance >= windowGap', () => {
    const host = hostWithWindow('host', 100, 90)
    const small = square('small', 18)

    // the host is treated as already placed on the sheet (Phase A output).
    const hostPlacement: Placement = {
      partId: 'host',
      instanceId: 'host#0',
      x: 0,
      y: 0,
      rotationDeg: 0,
      depth: 0,
    }
    const partById = new Map<string, NestPart>([
      ['host', host],
      ['small', small],
    ])
    const angleByPart = new Map<string, number[]>([
      ['host', [0]],
      ['small', [0]],
    ])
    const smallArea = Math.abs(polygonArea(small.outer))
    const unplaced: WindowInst[] = [0, 1, 2, 3].map((q) => ({
      partId: 'small',
      instanceId: `small#${q}`,
      sourceArea: smallArea,
    }))

    const { windowChildren, stillUnplaced } = placeInWindows(
      [hostPlacement],
      unplaced,
      partById,
      angleByPart,
      WINDOW_GAP
    )

    // all four nested; none left over
    expect(windowChildren.length).toBe(4)
    expect(stillUnplaced.length).toBe(0)

    for (const c of windowChildren) {
      expect(c.depth).toBe(1)
      expect(c.windowParentId).toBe('host#0')
    }

    // every sibling is inside the (host-posed) window
    const window = posedWindow(hostPlacement, [host])
    const rings = windowChildren.map((c) => placedRing(c, [small]))
    const TOL = 0.25
    for (const ring of rings) {
      expect(ringInside(ring, window)).toBe(true)
      expect(ringClearance(ring, window)).toBeGreaterThanOrEqual(WINDOW_GAP - TOL)
    }

    // siblings do not overlap and keep >= windowGap clearance between each other
    for (let i = 0; i < rings.length; i++) {
      for (let j = i + 1; j < rings.length; j++) {
        expect(overlap(rings[i], rings[j])).toBe(false)
        expect(ringClearance(rings[i], rings[j])).toBeGreaterThanOrEqual(WINDOW_GAP - TOL)
      }
    }
  })
})

// ── TOO BIG FOR THE WINDOW ───────────────────────────────────────────────────

describe('inside-window: a part too big for the window stays unplaced', () => {
  it('does not force-fit an oversized part (explicit leftover, ADR 0003)', () => {
    // A 100x100 host (90x90 window) already placed at the origin; one 95x95 part
    // is too big for the 90x90 window -> it must stay unplaced, never force-fit.
    const host = hostWithWindow('host', 100, 90)
    const big = square('big', 95)
    const hostPlacement: Placement = {
      partId: 'host',
      instanceId: 'host#0',
      x: 0,
      y: 0,
      rotationDeg: 0,
      depth: 0,
    }
    const partById = new Map<string, NestPart>([
      ['host', host],
      ['big', big],
    ])
    const angleByPart = new Map<string, number[]>([
      ['host', [0]],
      ['big', [0]],
    ])
    const unplaced: WindowInst[] = [
      { partId: 'big', instanceId: 'big#0', sourceArea: Math.abs(polygonArea(big.outer)) },
    ]

    const { windowChildren, stillUnplaced } = placeInWindows(
      [hostPlacement],
      unplaced,
      partById,
      angleByPart,
      2
    )

    expect(windowChildren.length).toBe(0)
    expect(stillUnplaced.length).toBe(1)
    expect(stillUnplaced[0].instanceId).toBe('big#0')
  })
})

// ── DETERMINISM ──────────────────────────────────────────────────────────────

describe('inside-window: determinism', () => {
  it('produces byte-identical placements (incl. windowParentId/depth) across runs', async () => {
    const mk = (): NestRequest =>
      baseRequest({
        parts: [
          { part: hostWithWindow('host', 80, 70), quantity: 1 },
          { part: square('small', 50), quantity: 3 },
        ],
        sheet: { width: 80, height: 80 },
        spacing: { partGap: 0, sheetMargin: 0, windowGap: 2 },
        style: 'ninety',
        seed: 4242,
      })
    const r1 = await packNest(mk())
    const r2 = await packNest(mk())
    expect(r2.placements).toEqual(r1.placements)
    expect(r2.unplaced).toEqual(r1.unplaced)
    expect(r2.utilization).toBe(r1.utilization)
  })
})

// ── NO-REGRESSION (no windows == P1 behavior) ────────────────────────────────

describe('inside-window: no windows == P1 behavior', () => {
  it('a request with NO windows places exactly as before (all depth 0, no parent)', async () => {
    // Plain six-square pack (a P1 packer fixture). With no `windows` on any part,
    // Phase B never runs; every placement is depth 0 with no windowParentId.
    const sq = square('p', 20)
    const req = baseRequest({
      parts: [{ part: sq, quantity: 6 }],
      sheet: { width: 100, height: 100 },
      // a non-trivial windowGap is set but no part offers a window, so it is inert.
      spacing: { partGap: 3, sheetMargin: 5, windowGap: 5 },
      style: 'ninety',
    })
    const result = await packNest(req)

    expect(result.placements.length).toBeGreaterThan(1)
    for (const p of result.placements) {
      expect(p.depth).toBe(0)
      expect(p.windowParentId).toBeUndefined()
    }
    expect(result.unplaced).toEqual([])
  }, 60000) // BK-7: pure generation-count GA (no wall-clock bailout) x this
  // fixture's partGap-grown polygons is genuinely slow per placement.ts/nfp.ts's
  // orbit cost (measured ~42s here) - see INT-H1 report.
})
