// GEO-20-R1 (audit major 1): the ORIGINAL GEO-20 report's before-verdicts.json
// / before-pocket-census.json were mislabeled — both first appeared in the SAME
// commit as the production fix (6902e5b4), and their content (12 chamfers all
// carrying a measured width 0.707, four named absorbed-bspline sub-finding
// rows) is POST-fix output, not pre-fix.
//
// This test regenerates BOTH artifacts from the ACTUAL pre-fix source, so the
// artifact-truth law holds: a conviction exhibit is generated FROM the pre-fix
// source, not merely labeled "before".
//
// METHOD (stated here, per the WO's requirement that the method + ref go in
// the report): `git show 3baff88b:src/geom/worker/defeature.ts` was extracted
// into coordination/evidence/GEO-20/prefix-src/defeature.prefix-3baff88b.ts
// (committed alongside this test, sha256 in the R1 report) — 3baff88b is the
// immediate PARENT of 6902e5b4, the commit that first introduced GEO-20's
// production fix, and defeature.ts was untouched between them (`git log
// --oneline -- src/geom/worker/defeature.ts` shows no commit between
// 8d4357b0 and 6902e5b4). This test imports gatherFaces/recognizeFeatures
// DIRECTLY from that frozen pre-fix copy (never from the live, now-fixed
// src/geom/worker/defeature.ts) and runs them against a freshly-imported real
// kernel shape of the same committed vendor fixture. The assertions below are
// the ORIGINAL bug shape — they FAIL against the current (fixed) module,
// which is exactly what proves this is genuinely pre-fix execution, not a
// relabeled copy of current output.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { OcctKernel } from 'occt-wasm'
import type { ShapeHandle } from 'occt-wasm'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { recognizeFeatures, gatherFaces, releaseFaceRecs } from '../../../test_fixtures/evidence/GEO-20/defeature.prefix-3baff88b.ts'

const FIX = join(process.cwd(), 'src/tests/geom/fixtures')
const OUT = join(process.cwd(), 'test_fixtures/evidence/GEO-20')
const WRITE = process.env.GEO20_R1_BEFORE_EVIDENCE === '1'

function write(name: string, data: string): void {
  if (!WRITE) return
  mkdirSync(OUT, { recursive: true })
  writeFileSync(join(OUT, name), data)
}
function loadStep(k: OcctKernel, name: string): ShapeHandle {
  const buf = readFileSync(join(FIX, name))
  return k.importStep(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
}

describe('GEO-20-R1 (audit major 1): genuine PRE-FIX evidence, executed from the frozen 3baff88b copy', () => {
  let k: OcctKernel
  beforeAll(async () => { k = await OcctKernel.init() }, 60_000)
  afterAll(() => { try { k[Symbol.dispose]() } catch { /* */ } })

  it('dumps the full PRE-FIX verdict list for step-test-with-holes.step (genuinely pre-fix execution)', () => {
    const shape = loadStep(k, 'step-test-with-holes.step')
    const recs = gatherFaces(k, shape)
    const feats = recognizeFeatures(k, shape, recs)

    const dump = feats.map((f) => ({
      key: f.key,
      type: f.type,
      removable: f.removable,
      refuseReason: f.refuseReason,
      params: f.params,
      dropHashes: f.dropHashes.length,
      untrimHashes: f.untrimHashes.length,
    }))
    write('before-verdicts.json', JSON.stringify(dump, null, 2) + '\n')

    const byHash = new Map(recs.map((r) => [r.hash, r]))
    const pocket = feats.find((f) => f.type === 'pocket')
    const pocketCensus = pocket
      ? pocket.dropHashes.reduce<Record<string, number>>((acc, h) => {
          const t = byHash.get(h)?.type ?? 'unknown'
          acc[t] = (acc[t] ?? 0) + 1
          return acc
        }, {})
      : null
    write('before-pocket-census.json', JSON.stringify({ pocketFaceCount: pocket?.dropHashes.length, pocketCensus }, null, 2) + '\n')

    // ---- SYMPTOM A (P2/P3/P4), PRE-FIX: exactly 12 chamferPlanar rows, every
    // one a radius-0 decline (the pre-fix code's `round(radius ?? 0, 3)` — no
    // call site ever passed a radius, so it read 0 BY CONSTRUCTION) carrying
    // the ambiguous planar-neighbour-pair refusal. This is the ZERO-post-fix-
    // rows requirement: no `width` key exists anywhere pre-fix. ----
    const chamfers = feats.filter((f) => f.type === 'chamferPlanar')
    expect(chamfers.length).toBe(12)
    for (const c of chamfers) {
      expect(c.removable).toBe(false)
      expect(c.params.radius).toBe(0)
      expect(c.params.width).toBeUndefined()
      expect(c.refuseReason).toMatch(/ambiguous planar-neighbour pair/)
    }

    // ---- SYMPTOM B (P7/P8), PRE-FIX: the plate's 4 real bspline corner
    // fillets are silently absorbed into the pocket verdict with ZERO
    // standalone rows anywhere — no absorbed/unsupported sub-finding row
    // exists yet (that is Fix B, landed in 6902e5b4). ----
    const bsplineFaces = recs.filter((r) => r.type === ('bspline' as unknown as typeof r.type))
    expect(bsplineFaces.length).toBe(4)
    expect(pocket).toBeDefined()
    expect(pocket!.dropHashes.length).toBe(26)
    for (const b of bsplineFaces) expect(pocket!.dropHashes).toContain(b.hash)
    const standalone = feats.filter((f) => f.type !== 'pocket')
    for (const b of bsplineFaces) {
      const row = standalone.find((f) => f.dropHashes.includes(b.hash) || f.neighbourHashes.includes(b.hash))
      expect(row).toBeUndefined() // ZERO rows reference the bspline faces pre-fix — the exact silent-absence bug
    }

    releaseFaceRecs(k, recs)
    try { k.release(shape) } catch { /* */ }
  }, 60_000)
})
