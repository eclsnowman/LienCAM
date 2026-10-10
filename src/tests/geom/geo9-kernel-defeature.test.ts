// GEO-9 (BK-65) — adoption proof for the PATCHED occt-wasm kernel.
// =================================================================
// These tests drive the RAW kernel primitive `OcctKernel.defeature()` through
// the app's own `occt-wasm` dependency (now the pinned GEO-9/BK-65 build:
// defeature() rebound to OCCT's real BRepAlgoAPI_Defeaturing + a single-solid-
// compound unwrap). The app's V1 defeature ENGINE (src/geom/worker/defeature.ts)
// deliberately never calls kernel.defeature() — it uses a manual remove+heal
// stack — so proofs (a)-(c) exercise the kernel primitive directly, and proof
// (d) confirms the V1 manual path still works under the swapped kernel.
//
// Fails-if guards (WO GEO-9 acceptance criterion 2):
//   - Reverting the DEFEATURE REBIND (back to the stock zero-thickness
//     MakeThickSolidByJoin) makes (a) throw a WebAssembly.Exception (stock threw
//     on 6/6 inputs).
//   - Reverting the FACADE UNWRAP (single-solid compound -> bare solid) makes (b)
//     fail via k.isSolid(result) === false on the geometrically-correct box.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { OcctKernel } from 'occt-wasm'
import type { ShapeHandle } from 'occt-wasm'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { recognizeFeatures, healRemoval, gatherFaces, releaseFaceRecs } from '../../geom/worker/defeature.ts'

const FIX = join(process.cwd(), 'src/tests/geom/fixtures')
const TOL = 1e-6

function loadStep(k: OcctKernel, name: string): ShapeHandle {
  const buf = readFileSync(join(FIX, name))
  return k.importStep(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
}
function facesOfKind(k: OcctKernel, shape: ShapeHandle, kind: string): ShapeHandle[] {
  return k.getSubShapes(shape, 'face').filter((f) => {
    try { return k.surfaceType(f) === kind } catch { return false }
  })
}
function releaseAll(k: OcctKernel, hs: ShapeHandle[]): void {
  for (const h of hs) { try { k.release(h) } catch { /* ignore */ } }
}
/** watertight == a VALID solid (a closed shell classifies as a solid; a shell
 *  with free boundary edges does not). Matches the app's own convention
 *  (defeature-evidence.test.ts: watertightSolid = isValid && isSolid). */
function watertight(k: OcctKernel, s: ShapeHandle): boolean {
  return safeBool(() => k.isValid(s)) && safeBool(() => k.isSolid(s))
}
function safeBool(fn: () => boolean): boolean { try { return fn() } catch { return false } }

describe('GEO-9 patched occt-wasm defeature() adoption', () => {
  let k: OcctKernel
  beforeAll(async () => { k = await OcctKernel.init() }, 60_000)
  afterAll(() => { try { k[Symbol.dispose]() } catch { /* */ } })

  // ---- (a) no WebAssembly.Exception on ANY fixture input (stock threw 6/6) ----
  it('(a) defeature() raises no WebAssembly.Exception on any fixture face set', () => {
    // Build >= 6 distinct real face sets across the fixtures. Under the STOCK
    // build (MakeThickSolidByJoin(..., 0.0, tolerance)) every one of these throws;
    // the rebind must let all of them return without a wasm abort.
    const cases: Array<{ name: string; make: () => { shape: ShapeHandle; faces: ShapeHandle[]; own: ShapeHandle[] } }> = [
      {
        name: 'box+fillet cylinder face',
        make: () => {
          const box = k.makeBox(20, 20, 20)
          const edges = k.getSubShapes(box, 'edge')
          const filleted = k.fillet(box, [edges[0]], 2)
          releaseAll(k, edges); try { k.release(box) } catch { /* */ }
          const cyl = facesOfKind(k, filleted, 'cylinder')
          return { shape: filleted, faces: cyl, own: [filleted, ...cyl] }
        },
      },
      { name: 'tray torus faces (subset)', make: () => { const s = loadStep(k, 'tray.step'); const f = facesOfKind(k, s, 'torus'); return { shape: s, faces: f.slice(0, 3), own: [s, ...f] } } },
      { name: 'tray first torus face', make: () => { const s = loadStep(k, 'tray.step'); const f = facesOfKind(k, s, 'torus'); return { shape: s, faces: f.slice(0, 1), own: [s, ...f] } } },
      { name: 'tray cylinder faces', make: () => { const s = loadStep(k, 'tray.step'); const f = facesOfKind(k, s, 'cylinder'); return { shape: s, faces: f.slice(0, 4), own: [s, ...f] } } },
      { name: 'step-test-with-holes cylinder faces', make: () => { const s = loadStep(k, 'step-test-with-holes.step'); const f = facesOfKind(k, s, 'cylinder'); return { shape: s, faces: f.slice(0, 4), own: [s, ...f] } } },
      { name: 'plate-holes cylinder faces', make: () => { const s = loadStep(k, 'plate-holes.step'); const f = facesOfKind(k, s, 'cylinder'); return { shape: s, faces: f.slice(0, 4), own: [s, ...f] } } },
    ]

    let calls = 0
    for (const c of cases) {
      const { shape, faces, own } = c.make()
      expect(faces.length, `${c.name}: expected at least one face to defeature`).toBeGreaterThan(0)
      let out: ShapeHandle | undefined
      expect(() => { out = k.defeature(shape, faces, TOL) }, `${c.name}: defeature threw (rebind regressed?)`).not.toThrow()
      if (out !== undefined) { try { k.release(out) } catch { /* */ } }
      releaseAll(k, own)
      calls++
    }
    expect(calls, 'expected >= 6 fixture face sets (stock threw 6/6)').toBeGreaterThanOrEqual(6)
  }, 120_000)

  // ---- (b) synthetic box edge-fillet removes to a watertight sharp box ----
  it('(b) box edge-fillet defeatures to a watertight sharp box (volume restored)', () => {
    const box = k.makeBox(20, 20, 20)
    const v0 = k.getVolume(box) // 8000
    const edges = k.getSubShapes(box, 'edge')
    const filleted = k.fillet(box, [edges[0]], 2)
    releaseAll(k, edges)
    const vFilleted = k.getVolume(filleted)
    expect(vFilleted, 'fillet must remove material').toBeLessThan(v0)

    const cyl = facesOfKind(k, filleted, 'cylinder')
    expect(cyl.length, 'a single-edge fillet yields exactly one cylindrical face').toBe(1)

    const out = k.defeature(filleted, cyl, TOL)
    // Unwrap guard: BRepAlgoAPI_Defeaturing returns a single-solid COMPOUND; the
    // GEO-9 facade unwrap must expose the bare solid here. Reverting the unwrap
    // makes isSolid() false.
    expect(k.isSolid(out), 'result must be a bare solid (facade unwrap)').toBe(true)
    expect(watertight(k, out), 'result must be a watertight solid').toBe(true)

    const vRestored = k.getVolume(out)
    // native removal reconstructed the sharp box -> volume back to 8000.
    expect(Math.abs(vRestored - v0), `volume restored to sharp box (got ${vRestored})`).toBeLessThan(1e-3)
    // and the sharp box has exactly 6 planar faces again.
    const outFaces = k.getSubShapes(out, 'face')
    expect(outFaces.length, 'sharp box has 6 faces').toBe(6)
    // removal delta vs the filleted input is positive and small (material added back).
    const delta = vRestored - vFilleted
    expect(delta).toBeGreaterThan(0)
    expect(delta).toBeLessThan(1000)

    releaseAll(k, [...cyl, ...outFaces, out, filleted, box])
  }, 120_000)

  // ---- (c) tray probe-06 corner blend: honest-decline no-op ----
  it('(c) tray probe-06 corner-blend torus defeature is an honest no-op (valid, watertight, unchanged)', () => {
    const tray = loadStep(k, 'tray.step')
    const v0 = k.getVolume(tray)
    expect(watertight(k, tray), 'tray input is a valid watertight solid').toBe(true)
    const facesBefore = k.getSubShapes(tray, 'face').length

    const torus = facesOfKind(k, tray, 'torus')
    expect(torus.length, 'tray has torus corner-blend faces').toBeGreaterThan(0)

    // Pin the EXACT GEO-6X2 probe-06 target: the corner-blend torus with band
    // area ~61.011 whose neighbours are {cylinder,cylinder,cylinder,plane} — the
    // three mutually-non-adjacent trimmed cylinders BOPAlgo_RemoveFeatures cannot
    // extend to close the sharp corner.
    const nbrSig = (f: ShapeHandle): string => {
      const adj = k.adjacentFaces(tray, f)
      const s = adj.map((a) => { try { return k.surfaceType(a) } catch { return '?' } }).sort().join(',')
      releaseAll(k, adj)
      return s
    }
    const target = torus.find((f) => Math.abs(k.getSurfaceArea(f) - 61.011) < 0.5 && nbrSig(f) === 'cylinder,cylinder,cylinder,plane')
    expect(target, 'probe-06 corner-blend torus (band area ~61.011, nbrs cyl,cyl,cyl,plane) present').toBeDefined()

    // RemoveFeatures runs cleanly and DECLINES (unremovable feature = warning, not
    // error): it returns the input shape UNCHANGED — the honest-decline contract
    // (GEO-6X2 verdict, corroborated at the kernel level).
    let out: ShapeHandle | undefined
    expect(() => { out = k.defeature(tray, [target as ShapeHandle], TOL) }, 'corner-blend defeature must not throw').not.toThrow()
    const result = out as ShapeHandle
    expect(k.isSolid(result), 'result is a valid solid').toBe(true)
    expect(watertight(k, result), 'result is watertight').toBe(true)
    const v1 = k.getVolume(result)
    expect(Math.abs(v1 - v0), `volume unchanged (delta ${v1 - v0}) — nothing removed`).toBeLessThan(1e-6)
    const facesAfter = k.getSubShapes(result, 'face').length
    expect(facesAfter, 'face count unchanged').toBe(facesBefore)

    releaseAll(k, [...torus, result, tray])
  }, 120_000)

  // ---- (d) GEO-6S manual remove+heal path still works (V1 engine, untouched) ----
  it('(d) GEO-6S manual remove+heal still heals a proven class to a watertight solid', () => {
    const shape = loadStep(k, 'step-test-with-holes.step')
    const recs = gatherFaces(k, shape)
    const feats = recognizeFeatures(k, shape, recs)
    const holes = feats.filter((f) => f.removable && (f.type === 'throughHole' || f.type === 'blindHole' || f.type === 'counterboreStack'))
    expect(holes.length, 'the plate has removable hole features').toBeGreaterThan(0)

    const scratch: ShapeHandle[] = []
    const heal = healRemoval(k, shape, holes, scratch, recs)
    expect(heal.ok, `manual heal must succeed: ${heal.reason ?? ''}`).toBe(true)
    const healed = heal.shape as ShapeHandle
    expect(k.isSolid(healed), 'healed result is a solid').toBe(true)
    expect(watertight(k, healed), 'healed result is watertight').toBe(true)
    expect(typeof heal.volumeDelta).toBe('number')

    for (const s of scratch) if (s !== healed) { try { k.release(s) } catch { /* */ } }
    try { k.release(healed) } catch { /* */ }
    releaseFaceRecs(k, recs)
    try { k.release(shape) } catch { /* */ }
  }, 120_000)
})
