/* PERFORMANCE + determinism gate for the nesting packer on a REAL dense part.
 *
 * Root cause this gate guards (PROFILED, NESTING perf work): Operator's BMG.dxf
 * imports to a ~202-vertex outer ring. noFitPolygon was ~99.9% of pack wall-clock
 * (one BMGxBMG NFP ~19s; the GA calls it hundreds of times) -> a multi-MINUTE
 * hang (BMG x4 measured at 113,842 ms baseline). The fix: SVGnest-style up-front
 * Douglas-Peucker simplification of the NFP/placement PROXY rings only
 * (simplify.ts), wired into packNest (index.ts) and the solver (solver.ts). The
 * original part geometry is untouched; only WHERE a part lands shifts by a sub-
 * tolerance amount.
 *
 * This test asserts three things:
 *   (a) the simplified proxy ring fed into the pack has FAR fewer vertices than
 *       the raw import (the simplification actually reaches the NFP inputs),
 *   (b) packing BMG x12 on a fixed sheet completes UNDER a wall-clock budget that
 *       proves the collapse (was ~8 minutes / 472s; budget 45s - generous so the
 *       gate is not flaky under full-suite parallel contention, where this pack
 *       measures ~12-20s vs ~3s isolated; the DETERMINISTIC mechanism proof is
 *       assertion (a), the vertex collapse - this is just the "no multi-minute
 *       hang" ceiling),
 *   (c) determinism: two packs on the real part deep-equal.
 *
 * Importer reuse: importDXF() (pure string parser, runs in the node vitest env).
 * Run: npx vitest run src/tests/cam/nesting/perf.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { importDXF } from '../../../lib/import/dxfImporter'
import { packNest } from '../../../lib/cam/nesting'
import { simplifyRing, DEFAULT_CURVE_TOLERANCE } from '../../../lib/cam/nesting/simplify'
import type { NestPart, NestRequest } from '../../../lib/cam/nesting'

const __dirname = dirname(fileURLToPath(import.meta.url))
// perf.test.ts lives at src/tests/cam/nesting/ -> four levels up to the repo root.
const REPO = resolve(__dirname, '../../../..')
const SAMPLES = resolve(REPO, 'Sample Parts')
const SEED = 1337

/** Load BMG.dxf as a NestPart: outer = largest-area closed loop, holes = the rest
 *  (same convention as the visual harness). */
function loadBMG(): { part: NestPart; vertices: number } {
  const txt = readFileSync(resolve(SAMPLES, 'BMG.dxf'), 'utf8')
  const res = importDXF(txt)
  const closed = res.loops.filter((l) => l.closed && l.points.length >= 3)
  if (closed.length === 0) throw new Error('BMG.dxf: no closed loops')
  const sorted = [...closed].sort((a, b) => b.area - a.area)
  const outer = sorted[0].points
  const holes = sorted.slice(1).map((l) => l.points)
  return { part: { id: 'bmg', outer, holes }, vertices: outer.length }
}

function baseReq(part: NestPart): NestRequest {
  return {
    parts: [{ part, quantity: 12 }],
    sheet: { width: 300, height: 300 },
    style: 'ninety',
    spacing: { partGap: 3, sheetMargin: 5, windowGap: 2 },
    solver: { kind: 'fixSheet' },
    seed: SEED,
  }
}

describe('nesting packer performance (real dense part)', () => {
  it('simplifies the dense BMG ring to a small proxy vertex count', () => {
    const { part, vertices } = loadBMG()
    // sanity: BMG really is the dense profile this gate exists for.
    expect(vertices).toBeGreaterThan(100)

    // the proxy that reaches noFitPolygon is the (grown then) simplified ring.
    // Test the simplification of the raw outer directly: it must collapse hard.
    const simplified = simplifyRing(part.outer, DEFAULT_CURVE_TOLERANCE)
    // eslint-disable-next-line no-console
    console.log(`PERF BMG ring: raw=${vertices} verts -> simplified=${simplified.length} verts`)
    expect(simplified.length).toBeLessThanOrEqual(50)
    // must still be a real polygon (not collapsed to a sliver).
    expect(simplified.length).toBeGreaterThanOrEqual(3)
  })

  it('packs 12 BMG copies on a fixed sheet well under the wall-clock budget', async () => {
    const { part, vertices } = loadBMG()
    const req = baseReq(part)

    const t0 = performance.now()
    const res = await packNest(req)
    const elapsedMs = performance.now() - t0

    // eslint-disable-next-line no-console
    console.log(
      `PERF BMG x12: outer=${vertices} verts, pack=${elapsedMs.toFixed(0)}ms, ` +
        `placed=${res.placements.length}, unplaced=${res.unplaced.reduce((s, u) => s + u.count, 0)}`
    )

    // BUDGET: was ~8 MINUTES (472s) before simplification. 45s is a generous upper
    // bound that proves the hang is gone while tolerating full-suite parallel
    // contention (observed ~12-20s under load, ~3s isolated). The real mechanism
    // proof is the deterministic vertex-collapse assertion above.
    expect(elapsedMs).toBeLessThan(45_000)
    // the pack must actually place parts (no silent empty success).
    expect(res.placements.length).toBeGreaterThan(0)
  }, 60_000)

  it('is deterministic on the real part (two packs deep-equal)', async () => {
    const { part } = loadBMG()
    const req = baseReq(part)
    const a = await packNest(req)
    const b = await packNest(req)
    expect(b).toEqual(a)
  }, 60_000)
})
