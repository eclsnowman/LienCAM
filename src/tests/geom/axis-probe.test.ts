// GEO-3 BK-14 — analytic axis correctness for ALL axial kinds.
//
// GEO-2-R1.1 withheld `axis` on cone/torus because the two-surface-normal
// cross-product was analytically wrong there (cone normals tilt toward the
// apex; torus normals vary in two directions). BK-14 REPLACES that shortcut
// with an ANALYTIC axis derived from three points sampled along a latitude
// circle of the face — a cylinder/cone/torus latitude circle lies in a plane
// perpendicular to the axis, so that plane's normal IS the axis, exactly, for
// all three kinds. So cone and torus faces now carry a CORRECT axis, and the
// DOC resolver's wrong-bind guard (src/doc/element-map.ts geometricCandidates)
// gets a trustworthy axis for them instead of degrading to "absent".
//
// This test constructs REAL kernel primitives (debugMakeCylinder /
// debugMakeCone / debugMakeTorus debug hooks) rather than authoring a STEP
// text fixture -- occt-wasm's makeCone/makeTorus are directly available and
// more reliable than hand-authoring a conical/toroidal face in STEP text.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'

describe('axis probe correctness (GEO-3 BK-14 analytic axis)', () => {
  let engine: GeomEngine

  beforeAll(async () => {
    engine = new GeomEngine()
    await engine.init()
  }, 60_000)

  afterAll(async () => {
    await engine.disposeKernel()
  })

  it('cylinder face snapshots keep a correct axis (dot with known Z axis > 0.999)', async () => {
    const cyl = await engine.debugMakeCylinder('CYL1', 5, 20)
    expect(cyl.ok).toBe(true)
    const geometry = cyl.elementMap!.geometry!
    const axialSnaps = Object.values(geometry).filter((s) => s.surfaceType === 'cylinder')
    expect(axialSnaps.length).toBeGreaterThan(0)
    for (const snap of axialSnaps) {
      expect(snap.axis).toBeDefined()
      const a = snap.axis!
      const len = Math.hypot(a.x, a.y, a.z)
      const dotZ = Math.abs(a.z / len) // debugMakeCylinder mints a Z-axis cylinder
      expect(dotZ).toBeGreaterThan(0.999)
    }
    await engine.disposeAll()
  }, 60_000)

  it('cone face carries the CORRECT analytic axis (dot with known Z axis > 0.99999)', async () => {
    // Truncated cone: r1 != r2 so the lateral face is a genuine OCCT 'cone'
    // surface (r1 === r2 would degenerate to a cylinder). BK-14 FAILS-IF: the
    // old GEO-2-R1.1 two-normal cross-product yields a direction tilted off
    // Z by the cone half-angle, so it would NOT clear the 0.99999 gate — only
    // the analytic three-point-circle axis does.
    const cone = await engine.debugMakeCone('CONE1', 10, 4, 15)
    expect(cone.ok).toBe(true)
    const geometry = cone.elementMap!.geometry!
    const coneSnaps = Object.values(geometry).filter((s) => s.surfaceType === 'cone')
    expect(coneSnaps.length).toBeGreaterThan(0)
    for (const snap of coneSnaps) {
      expect(snap.axis).toBeDefined()
      const a = snap.axis!
      const len = Math.hypot(a.x, a.y, a.z)
      expect(Math.abs(a.z / len)).toBeGreaterThan(0.99999) // Z-axis cone
    }
    await engine.disposeAll()
  }, 60_000)

  it('torus face carries the CORRECT analytic axis (dot with known Z axis > 0.99999)', async () => {
    const torus = await engine.debugMakeTorus('TOR1', 20, 5)
    expect(torus.ok).toBe(true)
    const geometry = torus.elementMap!.geometry!
    const torusSnaps = Object.values(geometry).filter((s) => s.surfaceType === 'torus')
    expect(torusSnaps.length).toBeGreaterThan(0)
    for (const snap of torusSnaps) {
      expect(snap.axis).toBeDefined()
      const a = snap.axis!
      const len = Math.hypot(a.x, a.y, a.z)
      expect(Math.abs(a.z / len)).toBeGreaterThan(0.99999) // Z-axis torus
    }
    await engine.disposeAll()
  }, 60_000)
})
