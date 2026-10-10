// @vitest-environment node
/* WO-2480: Nesting Calculate placed only 2 of the 7 kit outlines (WO-2381
 * production reproduction: sign, two gears, two soft jaws, two toe clamps on a
 * 290 x 190 sheet, gap 8, margin 8, orientations locked). The outlines below are
 * the app's own imported loops, read back from the production Calculate
 * (wo/WO-2381 nest-readback.json), and the request is built the way the store
 * builds it (createNest: nestPartGeometryFromLoops + lockedRotationDeg 0 for a
 * locked source) and run through runNest - the same entry the nest worker calls.
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Vec2 } from '../../types/index'
import { runNest, transformRing } from '../../lib/cam/nesting'
import type { NestPart, NestRequest } from '../../lib/cam/nesting'
import { nestPartGeometryFromLoops } from '../../lib/cam/nesting/partGroups'
import { intersect, pointInPolygon } from '../../lib/cam/nesting/geometry'
import { spacingProxy } from '../../lib/cam/nesting/proxy'
import { DEFAULT_CURVE_TOLERANCE } from '../../lib/cam/nesting/simplify'
import { ensureEngineClipperReady } from '../../lib/cam/adaptiveClearing2d/engine/clipperEngine'

interface KitFixture {
  sheet: { width: number; height: number }
  style: NestRequest['style']
  spacing: NestRequest['spacing']
  solver: NestRequest['solver']
  seed: number
  parts: { name: string; quantity: number; locked: boolean; outer: Vec2[] }[]
}

const root = resolve(import.meta.dirname, '../../..')
const kit: KitFixture = JSON.parse(
  readFileSync(join(root, 'src/tests/evidence/WO-2480/kit-outlines.json'), 'utf8'),
)

function kitRequest(locked: boolean): NestRequest {
  return {
    parts: kit.parts.map((p) => {
      const part: NestPart = {
        id: p.name,
        ...nestPartGeometryFromLoops({ points: p.outer }, []),
        ...(locked ? { lockedRotationDeg: 0 } : {}),
      }
      return { part, quantity: p.quantity }
    }),
    sheet: kit.sheet,
    style: kit.style,
    spacing: kit.spacing,
    solver: kit.solver,
    seed: kit.seed,
  }
}

function minDistanceSquared(a: Vec2[], b: Vec2[]): number {
  let best = Infinity
  const seg = (p: Vec2, s: Vec2, e: Vec2) => {
    const dx = e.x - s.x, dy = e.y - s.y
    const l = dx * dx + dy * dy
    const t = l <= 0 ? 0 : Math.max(0, Math.min(1, ((p.x - s.x) * dx + (p.y - s.y) * dy) / l))
    const qx = s.x + t * dx - p.x, qy = s.y + t * dy - p.y
    return qx * qx + qy * qy
  }
  for (const [pts, ring] of [[a, b], [b, a]] as const) {
    for (const p of pts) for (let i = 0; i < ring.length; i++) best = Math.min(best, seg(p, ring[i], ring[(i + 1) % ring.length]))
  }
  return best
}

async function expectWholeKitNested(locked: boolean) {
  const req = kitRequest(locked)
  const result = await runNest(req)
  const requested = kit.parts.reduce((n, p) => n + p.quantity, 0)
  expect(requested).toBe(7)
  expect(result.unplaced).toEqual([])
  expect(result.placements).toHaveLength(7)

  const outerById = new Map(req.parts.map((e) => [e.part.id, e.part.outer]))
  const rings = result.placements.map((p) => transformRing(outerById.get(p.partId)!, p.rotationDeg, p.x, p.y))
  const { partGap, sheetMargin } = kit.spacing
  for (const ring of rings) for (const p of ring) {
    expect(p.x).toBeGreaterThanOrEqual(sheetMargin - 1e-6)
    expect(p.y).toBeGreaterThanOrEqual(sheetMargin - 1e-6)
    expect(p.x).toBeLessThanOrEqual(kit.sheet.width - sheetMargin + 1e-6)
    expect(p.y).toBeLessThanOrEqual(kit.sheet.height - sheetMargin + 1e-6)
  }
  for (let i = 0; i < rings.length; i++) for (let j = i + 1; j < rings.length; j++) {
    const a = rings[i], b = rings[j]
    expect(intersect([...a, a[0]], [...b, b[0]])).toBe(false)
    expect(a.some((p) => pointInPolygon(p, b) === true)).toBe(false)
    expect(b.some((p) => pointInPolygon(p, a) === true)).toBe(false)
    expect(Math.sqrt(minDistanceSquared(a, b))).toBeGreaterThanOrEqual(partGap - 0.01)
  }
  return result
}

describe('WO-2480 nesting places every kit part that fits', () => {
  it('builds each placement proxy to hold the real outline plus half the gap, straight edges exactly half the gap out', async () => {
    await ensureEngineClipperReady()
    const half = kit.spacing.partGap / 2
    for (const p of kit.parts) {
      const proxy = spacingProxy(p.outer, half, DEFAULT_CURVE_TOLERANCE)
      // every real vertex and edge midpoint is inside the proxy and at least
      // half the gap from its boundary (main: gear tooth tips 0.3 mm short)
      for (let i = 0; i < p.outer.length; i++) {
        const a = p.outer[i], b = p.outer[(i + 1) % p.outer.length]
        for (const q of [a, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }]) {
          expect(pointInPolygon(q, proxy)).toBe(true)
          // 2e-4: clipper rounds to 0.1 micron; the validator allows 0.01 mm
          expect(Math.sqrt(minDistanceSquared([q], proxy))).toBeGreaterThanOrEqual(half - 2e-4)
        }
      }
    }
    // a rectangle's proxy keeps its flat sides exactly half the gap out (common-
    // edge pairing measures them) and only its corners reach further
    const jaw = kit.parts.find((p) => p.name === 'soft-jaw')!
    const xs = jaw.outer.map((q) => q.x), ys = jaw.outer.map((q) => q.y)
    const proxy = spacingProxy(jaw.outer, half, DEFAULT_CURVE_TOLERANCE)
    expect(Math.min(...proxy.map((q) => q.x))).toBeCloseTo(Math.min(...xs) - half, 4)
    expect(Math.max(...proxy.map((q) => q.y))).toBeCloseTo(Math.max(...ys) + half, 4)
  })

  it('nests all seven locked kit outlines on the 290 x 190 sheet with gap and margin held', async () => {
    const result = await expectWholeKitNested(true)
    // every requested part's area is on the sheet (main: 0.279, two parts)
    expect(result.utilization).toBeCloseTo(0.4354, 3)
  }, 120_000)

  it('nests all seven kit outlines when they may rotate in 90 deg steps', async () => {
    await expectWholeKitNested(false)
  }, 120_000)

  // Audit of attempt 1: the proxy's simplification compensation grows a detailed
  // outline everywhere, also at extremes simplification kept, and the sheet fit
  // used that grown proxy - a 100 mm disk no longer fitted a 100.1 mm sheet.
  // Sheet containment is the real outline plus half the gap; the proxy only
  // spaces parts from each other.
  const disk: Vec2[] = Array.from({ length: 64 }, (_, i) => ({
    x: 50 + 50 * Math.cos((i * Math.PI) / 32),
    y: 50 + 50 * Math.sin((i * Math.PI) / 32),
  }))
  const diskRequest = (side: number, partGap: number, solver: NestRequest['solver']): NestRequest => ({
    parts: [{ part: { id: 'disk', outer: disk, holes: [], lockedRotationDeg: 0 }, quantity: 1 }],
    sheet: { width: side, height: side },
    style: 'ninety',
    spacing: { partGap, sheetMargin: 0, windowGap: 0 },
    solver,
    seed: 1,
  })

  it.each([
    ['zero gap, exact quantity', 100.1, 0, { kind: 'fixSheetExact' }],
    ['zero gap, most that fit', 100.1, 0, { kind: 'fixSheet' }],
    ['2 mm gap (1 mm per side), exact quantity', 102.1, 2, { kind: 'fixSheetExact' }],
  ] as const)('places a detailed disk that fits its sheet (%s)', async (_label, side, gap, solver) => {
    const result = await runNest(diskRequest(side, gap, solver))
    expect(result.unplaced).toEqual([])
    expect(result.placements).toHaveLength(1)
    const ring = transformRing(disk, result.placements[0].rotationDeg, result.placements[0].x, result.placements[0].y)
    for (const p of ring) {
      expect(p.x).toBeGreaterThanOrEqual(-1e-6)
      expect(p.y).toBeGreaterThanOrEqual(-1e-6)
      expect(p.x).toBeLessThanOrEqual(side + 1e-6)
      expect(p.y).toBeLessThanOrEqual(side + 1e-6)
    }
  })

  it('still refuses the disk on a sheet it does not fit', async () => {
    const result = await runNest(diskRequest(99.9, 0, { kind: 'fixSheetExact' }))
    expect(result.placements).toHaveLength(0)
    expect(result.unplaced).toEqual([{ partId: 'disk', count: 1 }])
  })
})

// Second audit of attempt 1: the compensation for what simplification shaves off
// grew the WHOLE proxy by the worst deviation, measured on either side - so an
// inward notch (already inside the simplified ring) or one small outward bump
// pushed every flat edge out, and a neighbour that fits beside it was refused.
// The proxy now reaches past the simplified ring only along the simplified edges
// the real outline actually crosses, and only by how far it crosses them.
describe('WO-2480 simplification compensation stays local to the detail it covers', () => {
  const ring = (pts: [number, number][]): Vec2[] => pts.map(([x, y]) => ({ x, y }))
  // 100 x 40 with 19 vertices (so it is simplified) and one 0.2 mm feature on the
  // top edge at x = 50: inward (a notch) or outward (a bump)
  const withTopFeature = (y: number) =>
    ring([[0, 0], [20, 0], [40, 0], [60, 0], [80, 0], [100, 0], [100, 10], [100, 20], [100, 30], [100, 40],
      [80, 40], [60, 40], [50, y], [40, 40], [20, 40], [0, 40], [0, 30], [0, 20], [0, 10]])
  const rect = ring([[0, 0], [100, 0], [100, 40], [0, 40]])
  const pairRequest = (feature: Vec2[], width: number, partGap: number): NestRequest => ({
    parts: [
      { part: { id: 'feature', outer: feature, holes: [], lockedRotationDeg: 0 }, quantity: 1 },
      { part: { id: 'rect', outer: rect, holes: [], lockedRotationDeg: 0 }, quantity: 1 },
    ],
    sheet: { width, height: 55 },
    style: 'ninety',
    spacing: { partGap, sheetMargin: 0, windowGap: 0 },
    solver: { kind: 'fixSheetExact' },
    seed: 1,
  })

  it.each([
    // 0.2 mm to spare on each sheet (main itself refuses two plain rectangles
    // with only 0.1 mm to spare - placement numerics, not the proxy)
    ['0.2 mm inward notch, zero gap - the audit case', 39.8, 200.2, 0],
    ['0.25 mm inward notch, 2 mm gap', 39.75, 204.2, 2],
    ['0.25 mm outward bump, zero gap', 40.25, 200.2, 0],
    ['0.25 mm outward bump, 2 mm gap', 40.25, 204.2, 2],
  ] as const)('places a plain rectangle beside a simplified outline that fits (%s)', async (_label, y, width, gap) => {
    const feature = withTopFeature(y)
    const result = await runNest(pairRequest(feature, width, gap))
    expect(result.unplaced).toEqual([])
    expect(result.placements).toHaveLength(2)
    const outerById = new Map<string, Vec2[]>([['feature', feature], ['rect', rect]])
    const [a, b] = result.placements.map((p) => transformRing(outerById.get(p.partId)!, p.rotationDeg, p.x, p.y))
    expect(intersect([...a, a[0]], [...b, b[0]])).toBe(false)
    expect(Math.sqrt(minDistanceSquared(a, b))).toBeGreaterThanOrEqual(gap - 0.01)
    for (const p of [...a, ...b]) {
      expect(p.x).toBeGreaterThanOrEqual(-1e-6)
      expect(p.x).toBeLessThanOrEqual(width + 1e-6)
    }
  })

  it('keeps the proxy flat sides half the gap out; only the edge with the bump moves, by the bump', async () => {
    await ensureEngineClipperReady()
    const half = 1
    for (const [y, top] of [[39.75, 40 + half], [40.25, 40.25 + half]] as const) {
      const proxy = spacingProxy(withTopFeature(y), half, DEFAULT_CURVE_TOLERANCE)
      expect(Math.min(...proxy.map((q) => q.x))).toBeCloseTo(-half, 4)
      expect(Math.max(...proxy.map((q) => q.x))).toBeCloseTo(100 + half, 4)
      expect(Math.min(...proxy.map((q) => q.y))).toBeCloseTo(-half, 4)
      expect(Math.max(...proxy.map((q) => q.y))).toBeCloseTo(top, 4)
    }
  })
})

// Third audit: the proxy reaches past a curved outline (it encloses the real
// outline), and the GA's angle pick still measured the PROXY against the sheet.
// On a sheet only the turned part fits, neither proxy orientation fitted, so the
// pick fell back to 0 deg every time and a part that fits was left unplaced.
// The angle pick now measures the real outline, as the sheet inner-fit does.
describe('WO-2480 a freely rotating part that only fits turned is placed', () => {
  // 64-vertex 100 x 40 ellipse (simplified, so its proxy is enlarged)
  const ellipse: Vec2[] = Array.from({ length: 64 }, (_, i) => ({
    x: 50 + 50 * Math.cos((i * Math.PI) / 32),
    y: 20 + 20 * Math.sin((i * Math.PI) / 32),
  }))
  const ellipseRequest = (lockedRotationDeg?: number): NestRequest => ({
    parts: [{ part: { id: 'ellipse', outer: ellipse, holes: [], ...(lockedRotationDeg === undefined ? {} : { lockedRotationDeg }) }, quantity: 1 }],
    sheet: { width: 40.1, height: 100.1 },
    style: 'ninety',
    spacing: { partGap: 0, sheetMargin: 0, windowGap: 0 },
    solver: { kind: 'fixSheetExact' },
    seed: 1,
  })

  it('turns the ellipse 90 or 270 deg onto a 40.1 x 100.1 sheet when rotation is free', async () => {
    const result = await runNest(ellipseRequest())
    expect(result.unplaced).toEqual([])
    expect(result.placements).toHaveLength(1)
    const p = result.placements[0]
    expect([90, 270]).toContain(((p.rotationDeg % 360) + 360) % 360)
    for (const q of transformRing(ellipse, p.rotationDeg, p.x, p.y)) {
      expect(q.x).toBeGreaterThanOrEqual(-1e-6)
      expect(q.y).toBeGreaterThanOrEqual(-1e-6)
      expect(q.x).toBeLessThanOrEqual(40.1 + 1e-6)
      expect(q.y).toBeLessThanOrEqual(100.1 + 1e-6)
    }
  })

  it('still refuses the ellipse locked at 0 deg on that sheet', async () => {
    const result = await runNest(ellipseRequest(0))
    expect(result.placements).toHaveLength(0)
    expect(result.unplaced).toEqual([{ partId: 'ellipse', count: 1 }])
  })
})
