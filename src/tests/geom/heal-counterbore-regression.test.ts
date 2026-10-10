// GEO-11-R1 (blocker 1) — a WIDE counterbore shoulder must stay INSIDE the bore
// footprint so the feature heals to a watertight SOLID, not an open shell.
//
// Root cause (defeature.ts `capWithinFootprint`): the cap-footprint gate measured a
// candidate cap's radial extent from its world-axis bounding-box corners. For a
// circular cap of radius R those corners sit at R*sqrt(2) from the axis, overstating
// the true extent by ~41%. A d20 counterbore's shoulder (outer R=10) reads 14.14 >
// the ~13 threshold and was WRONGLY excluded from the caps set, so its face was left
// in the sew set instead of being dropped and the counterbore mouth untrimmed. The
// sew then closed into an open shell (valid:true, solid:false) — a regression the
// auditor reproduced on this exact probe (volume 35648.142 shell on pre-R1 HEAD).
//
// The fix measures radial extent from ACTUAL cap geometry (capRadialExtent): the
// shoulder's outer wire returns R=10 <= threshold, so it is dropped and the feature
// heals with volumeDelta ~ 1426.2831 (the material added back). A structural slab
// still reads far past the threshold and stays excluded (see heal-plate-top-solid).
//
// This test FAILS against pre-R1 capWithinFootprint (heal.ok === false) and PASSES
// after — see coordination/evidence/GEO-11/mutation-proof-R1.md.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { OcctKernel } from 'occt-wasm'
import type { ShapeHandle } from 'occt-wasm'
import { recognizeFeatures, healRemoval, gatherFaces, releaseFaceRecs } from '../../geom/worker/defeature.ts'

// The auditor's probe: 60x40x15 box, blind pilot d6 total depth 10, counterbore d20
// x 4 deep, all concentric on the box centre (30,20). Removed material:
//   counterbore ring z=11..15, R=10 : pi*100*4               = 1256.637
//   pilot below the shoulder z=5..11, R=3 : pi*9*6            =  169.646
//                                                        total = 1426.283
const EXPECTED_DELTA = Math.PI * 100 * 4 + Math.PI * 9 * 6  // 1426.2831...

describe('GEO-11-R1 wide counterbore shoulder heals to a solid (raw kernel)', () => {
  let k: OcctKernel
  beforeAll(async () => { k = await OcctKernel.init() }, 60_000)
  afterAll(() => { try { k[Symbol.dispose]() } catch { /* */ } })

  it('#r1 d20 counterbore (shoulder R=10) is recognized AND heals to a SOLID, delta ~ 1426.2831', () => {
    const box = k.makeBox(60, 40, 15)
    const v0 = k.getVolume(box)                       // 60*40*15 = 36000
    expect(Math.abs(v0 - 36000), `box volume (got ${v0})`).toBeLessThan(1e-3)

    // counterbore R=10 z=11..16 (mouth at the z=15 top, 4 deep); pilot R=3 z=5..16
    // (10 deep from the top). Both poke above the top so the cut is clean.
    const cbore = k.translate(k.makeCylinder(10, 5), 30, 20, 11)
    const pilot = k.translate(k.makeCylinder(3, 11), 30, 20, 5)
    const drilled = k.cut(k.cut(box, cbore), pilot)
    const vDrilled = k.getVolume(drilled)
    expect(Math.abs(vDrilled - (v0 - EXPECTED_DELTA)), `drilled volume (got ${vDrilled})`).toBeLessThan(1e-2)

    const recs = gatherFaces(k, drilled)
    const feats = recognizeFeatures(k, drilled, recs)
    const cb = feats.filter((f) => f.removable && f.type === 'counterboreStack')
    expect(cb.length, 'the d20 counterbore is recognized as a removable counterboreStack').toBe(1)

    const scratch: ShapeHandle[] = []
    const heal = healRemoval(k, drilled, cb, scratch, recs)

    // THE GATE (pre-R1: heal.ok === false — the wide shoulder was left in the sew set
    // and the result was a valid-but-open shell):
    expect(heal.ok, `heal must succeed: ${heal.reason ?? ''}`).toBe(true)
    const healed = heal.shape as ShapeHandle
    expect(healed, 'a healed shape is returned on success').toBeDefined()
    expect(k.isSolid(healed), 'healed result is a solid, not a shell').toBe(true)
    expect(k.isValid(healed), 'healed result is a valid solid').toBe(true)

    const vHealed = k.getVolume(healed)
    expect(Number.isFinite(vHealed), 'healed volume is finite').toBe(true)
    // filling the counterbore restores the plain box.
    expect(Math.abs(vHealed - v0), `volume restored to ${v0} (got ${vHealed})`).toBeLessThan(1e-2)
    expect(heal.volumeDelta, 'positive material-added-back delta').toBeGreaterThan(0)
    expect(Math.abs((heal.volumeDelta as number) - EXPECTED_DELTA), `delta ~ ${EXPECTED_DELTA.toFixed(4)} (got ${heal.volumeDelta})`).toBeLessThan(0.5)

    for (const s of scratch) if (s !== healed) { try { k.release(s) } catch { /* */ } }
    try { k.release(healed) } catch { /* */ }
    releaseFaceRecs(k, recs)
    try { k.release(drilled) } catch { /* */ }
    try { k.release(box) } catch { /* */ }
  }, 120_000)
})
