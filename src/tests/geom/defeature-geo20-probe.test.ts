// GEO-20 REPRO-FIRST probe (lesson_reproduce_before_claiming): dumps the FULL
// recognizer verdict list (featureClass/removable/refuseReason/params/face
// types per feature) for the committed real-vendor fixture
// step-test-with-holes.step. Gated behind GEO20_EVIDENCE=1 (same convention as
// defeature-evidence.test.ts's GEO6_EVIDENCE) so the normal suite run stays
// read-only; the CONVICTION assertions below always run so this doubles as a
// regression probe as GEO-20 lands further fixes.
//
// GEO-20-R1 (audit major 1) CORRECTION: this test always imports from the
// LIVE, current src/geom/worker/defeature.ts — it therefore always dumps
// CURRENT (post-every-landed-fix) output, never "before" output. The dumps
// are written to after-verdicts.json / after-pocket-census.json accordingly.
// A prior version of this file wrote the identical current-code output to
// files literally named before-verdicts.json / before-pocket-census.json,
// which the R1 audit correctly flagged as a conviction-artifact defect (a
// BEFORE exhibit must be generated from the PRE-fix source). The genuine
// pre-fix dump now lives in defeature-geo20-r1-before-evidence.test.ts,
// executed from a frozen pre-fix copy of defeature.ts (git ref 3baff88b).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { OcctKernel } from 'occt-wasm'
import type { ShapeHandle } from 'occt-wasm'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { recognizeFeatures, gatherFaces, releaseFaceRecs } from '../../geom/worker/defeature.ts'

const FIX = join(process.cwd(), 'src/tests/geom/fixtures')
const OUT = join(process.cwd(), 'test_fixtures/evidence/GEO-20')
const WRITE = process.env.GEO20_EVIDENCE === '1'

function write(name: string, data: string): void {
  if (!WRITE) return
  mkdirSync(OUT, { recursive: true })
  writeFileSync(join(OUT, name), data)
}
function loadStep(k: OcctKernel, name: string): ShapeHandle {
  const buf = readFileSync(join(FIX, name))
  return k.importStep(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
}

describe('GEO-20 repro: real filleted plate produces zero usable defeature candidates', () => {
  let k: OcctKernel
  beforeAll(async () => { k = await OcctKernel.init() }, 60_000)
  afterAll(() => { try { k[Symbol.dispose]() } catch { /* */ } })

  it('dumps the full verdict list for step-test-with-holes.step (CURRENT/post-fix code)', () => {
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
    write('after-verdicts.json', JSON.stringify(dump, null, 2) + '\n')

    // Face-type census of every face absorbed by the single pocket verdict —
    // this is the P8 conviction artifact (26 faces: 6 plane / 8 cylinder /
    // 4 bspline / 8 cone on the real plate).
    const byHash = new Map(recs.map((r) => [r.hash, r]))
    const pocket = feats.find((f) => f.type === 'pocket')
    const pocketCensus = pocket
      ? pocket.dropHashes.reduce<Record<string, number>>((acc, h) => {
          const t = byHash.get(h)?.type ?? 'unknown'
          acc[t] = (acc[t] ?? 0) + 1
          return acc
        }, {})
      : null
    write('after-pocket-census.json', JSON.stringify({ pocketFaceCount: pocket?.dropHashes.length, pocketCensus }, null, 2) + '\n')

    // ---- CONVICTION A (P2 + P3 + P4), POST-FIX-A: the 12 perimeter chamfers
    // still decline, but the meaningless radius-0 placeholder is GONE: no
    // chamferPlanar row ever carries a `radius` param, and any row that DOES
    // carry a measured `width` never reads exactly 0 (GEO-20 Fix A).
    //
    // GEO-21-R1 UPDATE (the ONLY lines changed in this file — everything else here
    // is byte-identical, so GEO-20's radius-0 and real-fillet convictions keep their
    // original coverage): the 12 bands are now REMOVABLE. GEO-20 recorded
    // `removable === false` as a REPRO of a defect it could not yet fix ("produces
    // zero usable defeature candidates" — this file's own title), not as a guarantee
    // to defend; GEO-21-R1 fixes it (host-plane corner retrim + collapsed-cap drop),
    // so pinning the old verdict would pin the bug. The convictions GEO-20 actually
    // owned are untouched and still asserted: no radius-0 placeholder on a chamfer
    // row, and a measured width that never reads exactly 0. Deliverable 2's real
    // proof — all 12 healing to an exactly sharp box — lives in
    // defeature-geo21-corner.test.ts. ----
    const chamfers = feats.filter((f) => f.type === 'chamferPlanar')
    expect(chamfers.length).toBe(12)
    expect(chamfers.every((f) => f.removable === true)).toBe(true)
    expect(chamfers.every((f) => f.params.radius === undefined)).toBe(true)
    expect(chamfers.every((f) => f.params.width === undefined || (typeof f.params.width === 'number' && f.params.width > 0))).toBe(true)

    // ---- CONVICTION B (P8), POST-FIX-B: the real fillets (bspline corner
    // faces) no longer vanish silently. The pocket's OWN face set stays WHOLE
    // (26 faces, no double-claim — the naive "exclude from pocket absorption"
    // fix is proven unsound by the WO preflight), and each absorbed bspline
    // face remains named. WO-2079 proves the two narrow edge blends removable;
    // the two broad structural pocket walls remain non-claiming refusals. ----
    const bsplineFaces = recs.filter((r) => r.type === ('bspline' as unknown as typeof r.type))
    expect(bsplineFaces.length).toBe(4)
    expect(pocket).toBeDefined()
    expect(pocket!.dropHashes.length).toBe(26)
    for (const b of bsplineFaces) expect(pocket!.dropHashes).toContain(b.hash)
    const absorbed = feats.filter((f) => f.type === 'filletCurvedCorner' && f.params.absorbedBy === pocket!.key)
    expect(absorbed.length).toBe(4)
    const removable = absorbed.filter((f) => f.removable)
    expect(removable.length).toBe(2)
    for (const row of removable) {
      expect(row.dropHashes).toHaveLength(1)
      expect(row.nativeDefeatureHashes).toEqual(row.dropHashes)
      expect(row.refuseReason).toBeUndefined()
    }
    const refused = absorbed.filter((f) => !f.removable)
    expect(refused.length).toBe(2)
    for (const row of refused) {
      expect(row.dropHashes).toEqual([])
      expect(row.nativeDefeatureHashes).toBeUndefined()
      expect(row.refuseReason).toMatch(/absorbed inside pocket/)
    }

    releaseFaceRecs(k, recs)
    try { k.release(shape) } catch { /* */ }
  }, 60_000)
})
