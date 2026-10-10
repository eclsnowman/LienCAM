// WO-1716 — Operator's MC note (2026-09-19, "why is resize hole not working?"): resize
// hole on a rounded-corner plate with three through holes + a hex through-cut
// refused DEFEATURE_UNSUPPORTED: "host-slab heal @(0,0,0) produced an
// invalid/degenerate face (valid=false, area=3232.7035); refusing rather than
// sewing an open shell" — healHostFace's removeHolesFromFace call on the bottom
// slab (curved rounded-corner outer wire, four inner loops: three hole circles +
// the hex through-cut) came back topologically invalid.
//
// Built through the PRODUCTION path: raw-kernel geometry (rounded-rect outer wire
// + addHolesInFace for the three round holes and the hex, extrude, chamfer the
// top perimeter) exported to STEP and re-entered through engine.importStep — the
// same GeomEngine the app's worker runs — then resized through engine.editFeature
// exactly as ResizeHoleDialog's armed-entry apply path does.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { OcctKernel } from 'occt-wasm'
import type { ShapeHandle, Vec3 } from 'occt-wasm'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'
import type { BodyHandle, FeatureVerdict } from '../../geom/geom-service.ts'

const PI = Math.PI
const W = 80, H = 50, T = 13, CR = 10   // plate width / height / thickness / corner radius
const CHAMFER_DIST = 1.5
const HOLE_R = 3                        // Ø6 pilot holes
const HOLE_CENTERS: Array<[number, number]> = [[20, 15], [60, 15], [40, 40]]
const HEX_CENTER: [number, number] = [40, 24]
const HEX_R = 8

function stepBuffer(step: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(step)
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

/** CCW rounded-rectangle outer wire edges [0,w]x[0,h] with corner radius r, at z. */
function roundedRectEdges(k: OcctKernel, w: number, h: number, r: number, z: number): ShapeHandle[] {
  const p = (x: number, y: number): Vec3 => ({ x, y, z })
  const corner = (cx: number, cy: number, aMid: number): Vec3 => ({ x: cx + r * Math.cos(aMid), y: cy + r * Math.sin(aMid), z })
  return [
    k.makeLineEdge(p(r, 0), p(w - r, 0)),                                          // bottom
    k.makeArcEdge(p(w - r, 0), corner(w - r, r, -PI / 4), p(w, r)),                 // BR corner
    k.makeLineEdge(p(w, r), p(w, h - r)),                                          // right
    k.makeArcEdge(p(w, h - r), corner(w - r, h - r, PI / 4), p(w - r, h)),          // TR corner
    k.makeLineEdge(p(w - r, h), p(r, h)),                                          // top
    k.makeArcEdge(p(r, h), corner(r, h - r, 3 * PI / 4), p(0, h - r)),              // TL corner
    k.makeLineEdge(p(0, h - r), p(0, r)),                                          // left
    k.makeArcEdge(p(0, r), corner(r, r, 5 * PI / 4), p(r, 0)),                      // BL corner
  ]
}

function circleWire(k: OcctKernel, cx: number, cy: number, r: number, z: number): ShapeHandle {
  const e = k.makeCircleEdge({ x: cx, y: cy, z }, { x: 0, y: 0, z: 1 }, r)
  return k.makeWire([e])
}

function hexWire(k: OcctKernel, cx: number, cy: number, r: number, z: number): ShapeHandle {
  const pts: Vec3[] = []
  for (let i = 0; i < 6; i++) {
    const ang = (PI / 3) * i
    pts.push({ x: cx + r * Math.cos(ang), y: cy + r * Math.sin(ang), z })
  }
  const edges = pts.map((pt, i) => k.makeLineEdge(pt, pts[(i + 1) % 6]))
  return k.makeWire(edges)
}

/** The single planar face whose whole bounding box sits at z ~= zTarget. */
function planarFaceAtZ(k: OcctKernel, solid: ShapeHandle, zTarget: number): ShapeHandle {
  const faces = k.getSubShapes(solid, 'face')
  let target: ShapeHandle | null = null
  for (const f of faces) {
    const bb = k.getBoundingBox(f, false)
    if (Math.abs(bb.zmin - zTarget) < 1e-6 && Math.abs(bb.zmax - zTarget) < 1e-6) target = f
  }
  if (!target) throw new Error(`no planar face found at z=${zTarget}`)
  for (const f of faces) { if (f !== target) { try { k.release(f) } catch { /* */ } } }
  return target
}

/**
 * Operator's plate: a rounded-corner rectangular slab, three Ø6 through holes and a
 * hex through-cut on ONE sketch (so the top/bottom slab faces each carry a curved
 * outer wire PLUS four inner loops), with the top perimeter chamfered afterward —
 * the same "Sketch -> Extrude -> Chamfer" order as the MC screenshot.
 */
function buildChamferedPlate(k: OcctKernel): ShapeHandle {
  const outerEdges = roundedRectEdges(k, W, H, CR, 0)
  const outerWire = k.makeWire(outerEdges)
  const outerFace = k.makeFace(outerWire)
  const holeWires = HOLE_CENTERS.map(([cx, cy]) => circleWire(k, cx, cy, HOLE_R, 0))
  const hex = hexWire(k, HEX_CENTER[0], HEX_CENTER[1], HEX_R, 0)
  const faceWithHoles = k.addHolesInFace(outerFace, [...holeWires, hex])
  const solid = k.extrude(faceWithHoles, 0, 0, T)

  const topFace = planarFaceAtZ(k, solid, T)
  const topWire = k.outerWire(topFace)
  const topEdges = k.getSubShapes(topWire, 'edge')
  const chamfered = k.chamfer(solid, topEdges, CHAMFER_DIST)

  for (const e of outerEdges) { try { k.release(e) } catch { /* */ } }
  for (const w of holeWires) { try { k.release(w) } catch { /* */ } }
  for (const e of topEdges) { try { k.release(e) } catch { /* */ } }
  try {
    k.release(outerWire); k.release(outerFace); k.release(hex); k.release(faceWithHoles)
    k.release(topFace); k.release(topWire); k.release(solid)
  } catch { /* */ }
  return chamfered
}

async function importPlate(k: OcctKernel, engine: GeomEngine, id: string): Promise<BodyHandle> {
  const chamfered = buildChamferedPlate(k)
  const step = k.exportStep(chamfered)
  try { k.release(chamfered) } catch { /* */ }
  const { bodies } = await engine.importStep(stepBuffer(step), id)
  return bodies[0].handle
}

async function vol(engine: GeomEngine, b: BodyHandle): Promise<number> {
  return (await engine.measure(b, 'volume')).value
}

/** Hole feature keys are `hole:${x}:${y}:${z}:${dirx}:${diry}:${dirz}:${radius}`
 *  (defeature.ts) — match a verdict to the seeded (cx, cy) by that prefix rather
 *  than a raw handle, since FeatureVerdict carries no fingerprint field. */
function findHoleAt(verdicts: FeatureVerdict[], cx: number, cy: number): FeatureVerdict | undefined {
  const prefix = `hole:${cx}:${cy}:`
  return verdicts.find((v) => v.featureClass === 'throughHole' && v.featureKey.startsWith(prefix))
}

describe('WO-1716 resize hole on a rounded-corner, hex-pocketed, chamfered plate (real occt-wasm kernel)', () => {
  let k: OcctKernel
  let engine: GeomEngine
  beforeAll(async () => {
    k = await OcctKernel.init()
    engine = new GeomEngine()
    await engine.init()
  }, 60_000)
  afterAll(async () => {
    await engine.disposeKernel()
    try { k[Symbol.dispose]() } catch { /* */ }
  })

  it('sanity: the plate carries exactly three removable Ø6 through holes', async () => {
    const body = await importPlate(k, engine, 'IMP0')
    const verdicts = await engine.recognizeFeatures(body)
    const holes = verdicts.filter((v: FeatureVerdict) => v.featureClass === 'throughHole')
    expect(holes.length).toBe(3)
    for (const h of holes) {
      expect(h.removable, h.refuseReason ?? '').toBe(true)
      expect(Number(h.params.diameter)).toBeCloseTo(HOLE_R * 2, 6)
    }
    await engine.disposeAll()
  }, 60_000)

  for (const [idx, [cx, cy]] of HOLE_CENTERS.entries()) {
    it(`hole #${idx} @(${cx},${cy}): resize Ø6 -> Ø8 succeeds, analytic volume delta`, async () => {
      const body = await importPlate(k, engine, `G${idx}`)
      const v0 = await vol(engine, body)
      const verdicts = await engine.recognizeFeatures(body)
      const hole = findHoleAt(verdicts, cx, cy)
      expect(hole, `hole @(${cx},${cy}) recognized`).toBeDefined()

      const r = await engine.editFeature({ featureId: 'E1', body, featureKey: hole!.featureKey, delta: 2, kind: 'holeDiameter' })
      // THE GATE — fails on main: DEFEATURE_UNSUPPORTED "host-slab heal ... produced
      // an invalid/degenerate face" (Operator's exact refusal).
      expect(r.ok, `resize must succeed: ${JSON.stringify(r.diagnostics ?? [])}`).toBe(true)
      const v1 = await vol(engine, r.body!)
      const analyticDelta = -PI * (4 * 4 - HOLE_R * HOLE_R) * T
      expect(Math.abs((v1 - v0) - analyticDelta)).toBeLessThan(1e-3)

      const rr = await engine.recognizeFeatures(r.body!)
      const grown = findHoleAt(rr, cx, cy)
      expect(grown, 'resized hole still recognizes at the new center').toBeDefined()
      expect(Number(grown!.params.diameter)).toBeCloseTo(8, 3)
      await engine.disposeAll()
    }, 60_000)

    it(`hole #${idx} @(${cx},${cy}): resize Ø6 -> Ø4 succeeds, analytic volume delta`, async () => {
      const body = await importPlate(k, engine, `S${idx}`)
      const v0 = await vol(engine, body)
      const verdicts = await engine.recognizeFeatures(body)
      const hole = findHoleAt(verdicts, cx, cy)
      expect(hole, `hole @(${cx},${cy}) recognized`).toBeDefined()

      const r = await engine.editFeature({ featureId: 'E1', body, featureKey: hole!.featureKey, delta: -2, kind: 'holeDiameter' })
      expect(r.ok, `resize must succeed: ${JSON.stringify(r.diagnostics ?? [])}`).toBe(true)
      const v1 = await vol(engine, r.body!)
      const analyticDelta = -PI * (2 * 2 - HOLE_R * HOLE_R) * T
      expect(Math.abs((v1 - v0) - analyticDelta)).toBeLessThan(1e-3)

      const rr = await engine.recognizeFeatures(r.body!)
      const shrunk = findHoleAt(rr, cx, cy)
      expect(shrunk, 'resized hole still recognizes at the new center').toBeDefined()
      expect(Number(shrunk!.params.diameter)).toBeCloseTo(4, 3)
      await engine.disposeAll()
    }, 60_000)
  }
})
