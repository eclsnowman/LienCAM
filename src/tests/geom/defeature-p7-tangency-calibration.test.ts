// GEO-20-R1 (audit major 2): CALIBRATION for FILLET_BAND_TANGENT_TOL
// (defeature.ts, isFilletBandEligible's gate). Proves — against real kernel
// geometry, not guessed — that measureFaceTangency cleanly separates genuine
// G1-tangent host adjacency from a hard/transverse edge by many orders of
// magnitude, so the chosen tolerance has no calibration ambiguity.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { OcctKernel } from 'occt-wasm'
import type { ShapeHandle } from 'occt-wasm'
import { gatherFaces, releaseFaceRecs, measureFaceTangency, HM } from '../../geom/worker/defeature.ts'

const FIX = join(process.cwd(), 'src/tests/geom/fixtures')
function fixtureBytes(name: string): ArrayBuffer {
  const buf = readFileSync(join(FIX, name))
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}

describe('GEO-20-R1 — measureFaceTangency calibration (real kernel)', () => {
  let k: OcctKernel
  beforeAll(async () => { k = await OcctKernel.init() }, 60_000)
  afterAll(() => { try { k[Symbol.dispose]() } catch { /* */ } })

  it('a real cylindrical fillet band is tangent (dev ~ 0) to its two host planes, and orthogonal (dev = 1) to its perpendicular end caps', () => {
    const box = k.makeBox(40, 20, 10)
    const edges = k.getSubShapes(box, 'edge')
    let target: ShapeHandle | null = null
    for (const e of edges) {
      const vs = k.getSubShapes(e, 'vertex')
      if (vs.length === 2) {
        const a = k.vertexPosition(vs[0]), b = k.vertexPosition(vs[1])
        if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6 && Math.abs(a.z - b.z) > 1e-6 && Math.abs(a.x - 40) < 1e-6 && Math.abs(a.y - 20) < 1e-6) target = e
      }
      for (const v of vs) { try { k.release(v) } catch { /* */ } }
    }
    const filleted = k.filletWithHistory(box, [target!], 3, [], HM).result
    for (const e of edges) { try { k.release(e) } catch { /* */ } }
    try { k.release(box) } catch { /* */ }

    const recs = gatherFaces(k, filleted)
    const band = recs.find((r) => r.type === 'cylinder')!
    const nbrs = recs.filter((r) => band.neighbours.includes(r.hash) && r.type === 'plane')
    expect(nbrs.length).toBe(4) // 2 real tangent host walls + 2 perpendicular end caps

    const devs = nbrs.map((n) => measureFaceTangency(k, band, n)).sort((a, b) => (a ?? 0) - (b ?? 0))
    // the two tangent hosts: dev far below the chosen 1e-6 gate.
    expect(devs[0]).toBeLessThan(1e-9)
    expect(devs[1]).toBeLessThan(1e-9)
    // the two perpendicular end caps: dev far above it (orthogonal, dev = 1).
    expect(devs[2]).toBeGreaterThan(0.9)
    expect(devs[3]).toBeGreaterThan(0.9)

    releaseFaceRecs(k, recs)
    try { k.release(filleted) } catch { /* */ }
  }, 60_000)

  it('two adjacent 90deg box planes measure dev = 1 (no tangency, far above the gate)', () => {
    const box = k.makeBox(40, 20, 10)
    const recs = gatherFaces(k, box)
    const top = recs.find((r) => Math.abs(r.centroid.z - 10) < 1e-6)!
    const side = recs.find((r) => top.neighbours.includes(r.hash))!
    const dev = measureFaceTangency(k, top, side)
    expect(dev).not.toBeNull()
    expect(dev!).toBeGreaterThan(0.9)
    releaseFaceRecs(k, recs)
    try { k.release(box) } catch { /* */ }
  }, 60_000)

  it('the real vendor plate: a bspline corner-fillet face is tangent (dev far below gate) to its two host cylinders, and NOT tangent to its own transverse bspline neighbour', () => {
    const shape = k.importStep(fixtureBytes('step-test-with-holes.step'))
    const recs = gatherFaces(k, shape)
    const bsplines = recs.filter((r) => r.type === ('bspline' as unknown as typeof r.type))
    expect(bsplines.length).toBe(4)
    const bs = bsplines[0]
    const nbrs = recs.filter((r) => bs.neighbours.includes(r.hash))
    const cylNbrs = nbrs.filter((n) => n.type === 'cylinder')
    expect(cylNbrs.length).toBeGreaterThanOrEqual(2)
    const cylDevs = cylNbrs.map((n) => measureFaceTangency(k, bs, n))
    const tangentCount = cylDevs.filter((d) => d !== null && d < 1e-6).length
    expect(tangentCount).toBeGreaterThanOrEqual(2) // real fillet-band eligibility: >= 2 tangent hosts

    const bsplineNbr = nbrs.find((n) => n.type === ('bspline' as unknown as typeof n.type))
    if (bsplineNbr) {
      const dev = measureFaceTangency(k, bs, bsplineNbr)
      expect(dev).not.toBeNull()
      expect(dev!).toBeGreaterThan(0.1) // the shared interior corner between two adjacent blend faces is NOT tangent
    }

    releaseFaceRecs(k, recs)
    try { k.release(shape) } catch { /* */ }
  }, 60_000)
})
