// GEO-11-R1 (blocker 2) — healRemoval must be FAIL-CLOSED on non-finite volume data.
//
// The sole ok:true gate tested only `vol > 1e-9`, which accepts +Infinity
// (Infinity > 1e-9 is true), and never validated `originalVol`. So a healed result
// could be reported as success (ok:true) carrying a volumeDelta of Infinity or NaN.
// The auditor reproduced both with minimal kernel doubles:
//   - isValid/isSolid true, four faces, OUTPUT volume +Infinity -> ok:true, delta Infinity
//   - ORIGINAL volume NaN, output volume 10          -> ok:true, delta NaN
//
// The fix requires Number.isFinite(originalVol) && Number.isFinite(vol) && vol > 1e-9
// && Number.isFinite(volumeDelta) before ok:true, and REFUSES BY NAME (the reason
// names the offending value) otherwise. These tests FAIL against pre-R1 code (they
// would see ok:true) and PASS after — see coordination/evidence/GEO-11/mutation-proof-R1.md.
import { describe, it, expect } from 'vitest'
import { healRemoval } from '../../geom/worker/defeature.ts'
import type { FaceRec, RecognizedFeature } from '../../geom/worker/defeature.ts'
import type { OcctKernel, ShapeHandle } from 'occt-wasm'

const SHAPE = 1 as ShapeHandle          // the "original" body handle
const SOLID = 99 as ShapeHandle         // the handle sewAndSolidify returns
const FACE_HANDLES = [10, 11, 12, 13] as ShapeHandle[]

/** four planar face records kept byte-identical (no drops/untrims) so the heal path
 *  reaches the final finite-data gate with a 4-face sew set. */
function fourFaces(): FaceRec[] {
  return FACE_HANDLES.map((h, i) => ({
    handle: h,
    hash: 100 + i,
    type: 'plane' as const,
    centroid: { x: i, y: 0, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
    area: 1,
    bbox: { xmin: 0, ymin: 0, zmin: 0, xmax: 1, ymax: 1, zmax: 1 },
    innerLoops: 0,
    neighbours: [],
  }))
}

/** one removable feature that drops/untrims nothing — every face is kept as-is. */
function keepAllFeature(): RecognizedFeature {
  return {
    key: 'dbl:0',
    type: 'blindHole',
    dropHashes: [],
    untrimHashes: [],
    hostRemovals: [],
    neighbourHashes: [],
    effect: 'add',
    removable: true,
    params: {},
    fingerprint: { cx: 0, cy: 0, cz: 0, nx: 0, ny: 0, nz: 1, kind: 'blindHole' },
  }
}

/** a minimal OcctKernel double: getVolume returns `originalVol` for the input body
 *  and `outputVol` for the sewn solid; the sew always yields a valid, solid body. */
function kernelDouble(originalVol: number, outputVol: number): OcctKernel {
  const kd = {
    getVolume: (h: ShapeHandle) => (h === SOLID ? outputVol : originalVol),
    sewAndSolidify: (_faces: ShapeHandle[], _tol: number) => SOLID,
    isValid: (_h: ShapeHandle) => true,
    isSolid: (_h: ShapeHandle) => true,
    reverseShape: (h: ShapeHandle) => h,
    release: (_h: ShapeHandle) => { /* noop */ },
  }
  return kd as unknown as OcctKernel
}

describe('GEO-11-R1 healRemoval fail-closes on non-finite volume data', () => {
  it('#f1 an +Infinity OUTPUT volume REFUSES by name (not ok:true with delta Infinity)', () => {
    const k = kernelDouble(100, Infinity)
    const scratch: ShapeHandle[] = []
    const heal = healRemoval(k, SHAPE, [keepAllFeature()], scratch, fourFaces())

    // THE GATE (pre-R1: heal.ok === true, volumeDelta === Infinity):
    expect(heal.ok, 'an Infinity output volume must NOT be reported as success').toBe(false)
    expect(heal.reason, 'the refusal names finite-data and the offending value').toMatch(/finite/i)
    expect(heal.reason).toMatch(/Infinity/)
    expect(heal.volumeDelta, 'no volumeDelta is returned on refusal').toBeUndefined()
  })

  it('#f2 a NaN ORIGINAL volume REFUSES by name (not ok:true with delta NaN)', () => {
    const k = kernelDouble(NaN, 10)
    const scratch: ShapeHandle[] = []
    const heal = healRemoval(k, SHAPE, [keepAllFeature()], scratch, fourFaces())

    // THE GATE (pre-R1: heal.ok === true, volumeDelta === NaN):
    expect(heal.ok, 'a NaN original volume must NOT be reported as success').toBe(false)
    expect(heal.reason, 'the refusal names finite-data and the offending value').toMatch(/finite/i)
    expect(heal.reason).toMatch(/NaN/)
    expect(heal.volumeDelta, 'no volumeDelta is returned on refusal').toBeUndefined()
  })

  it('#f3 finite data still heals (the gate is non-vacuous — success path unbroken)', () => {
    const k = kernelDouble(100, 158.9)
    const scratch: ShapeHandle[] = []
    const heal = healRemoval(k, SHAPE, [keepAllFeature()], scratch, fourFaces())

    expect(heal.ok, `finite data must still succeed: ${heal.reason ?? ''}`).toBe(true)
    expect(heal.volumeDelta, 'finite delta = output - original').toBeCloseTo(58.9, 6)
    expect(heal.faceCount).toBe(4)
  })
})
