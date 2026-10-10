// Form stage 34: From body remeshes the body's curved faces into grids of quads.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GeomEngine } from '../../geom/worker/geom-engine'
import type { BodyHandle } from '../../geom/geom-service'
import type { Cage, Vec3 } from '../../form/cage'
import { formFromBody, FORM_FROM_BODY_TESS } from '../../form/fromMesh'
import { remeshFromBody } from '../../form/remesh'
import { formStep } from '../../form/exactStep'
import { validateCage } from '../../form/halfEdge'
import { closestPointIndex } from '../../form/closestPoint'
import { applyRows, cagePositionArray, levelFromCage, limitRows, refine, type Level } from '../../form/subdivide'

const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer

/** the smooth skin's points, `levels` refinements down, on the limit surface */
function skin(cage: Cage, levels = 4): Vec3[] {
  let level: Level = levelFromCage(cage)
  let P = cagePositionArray(cage)
  for (let k = 0; k < levels; k++) { const r = refine(level); P = applyRows(r.rows, P); level = r.level }
  const L = applyRows(limitRows(level), P)
  const out: Vec3[] = []
  for (let i = 0; i < L.length; i += 3) out.push([L[i], L[i + 1], L[i + 2]])
  return out
}

describe('From body remeshes curved faces into quads (real occt-wasm)', () => {
  let engine: GeomEngine
  const bodies = new Map<string, BodyHandle>()
  beforeAll(async () => {
    engine = new GeomEngine()
    await engine.init()
    const box = await engine.makeBox('B', { x: 40, y: 30, z: 20 })
    bodies.set('box', box.body!)
    bodies.set('cylinder', (await engine.debugMakeCylinder('C', 10, 20)).body!)
    const t0 = await engine.tessellate(box.body!, FORM_FROM_BODY_TESS)
    const fil = await engine.applyFillet({ featureId: 'F', body: box.body!, edges: [...t0.edgeIds], radius: 4, propagateTangent: true })
    bodies.set('filleted box', fil.body!)
    const box2 = await engine.makeBox('B2', { x: 30, y: 30, z: 20 })
    const c2 = await engine.debugMakeCylinder('C2', 5, 20)
    bodies.set('notched box', (await engine.applyBoolean({ featureId: 'X', op: 'cut', target: box2.body!, tools: [c2.body!] })).body!)
  }, 180_000)
  afterAll(async () => { await engine.disposeKernel() })

  const mesh = (name: string) => engine.tessellate(bodies.get(name)!, FORM_FROM_BODY_TESS)
  const exactVolume = async (cage: Cage) => {
    const res = await engine.importStep(bytes(formStep(cage, 'F', 3).text), 'FRM9')
    expect(res.bodies).toHaveLength(1)
    return (await engine.measure(res.bodies[0].handle, 'volume')).value
  }
  /** the worst distance of the smooth skin from the body, measured on a fine tessellation (not the one remeshed) */
  const offBody = async (name: string, cage: Cage) => {
    const fine = await engine.tessellate(bodies.get(name)!, { deflection: 0.01, angularDeflection: 0.05 })
    const idx = closestPointIndex(fine)
    return skin(cage).reduce((w, p) => Math.max(w, idx.closest(p).distance), 0)
  }

  it('a box stays eight points: six flat faces, twelve creased edges, its volume', async () => {
    const r = formFromBody(await mesh('box'))
    expect(r.cage.positions).toHaveLength(8)
    expect(r.cage.faces).toHaveLength(6)
    expect(r.cage.creases).toHaveLength(12)
    expect(r.gridFaces).toBe(0)
    expect(validateCage(r.cage, true).problems).toEqual([])
    expect(await exactVolume(r.cage)).toBeCloseTo(24000, 3)
  }, 180_000)

  it('a cylinder: flat ends, its side a ring grid of quads on the body, the volume within 1% and nearer than the old path', async () => {
    const t = await mesh('cylinder')
    const r = formFromBody(t)
    const old = formFromBody(t, { remesh: false })
    expect(validateCage(r.cage, true).problems).toEqual([])
    expect(r.flatFaces).toBe(2)
    expect(r.gridFaces).toBe(1)
    expect(r.curvedTriangles).toBe(0)
    expect(r.cage.faces.filter((f) => f.length === 4)).toHaveLength(r.cage.faces.length - 2)
    expect(old.curvedTriangles).toBeGreaterThan(0)
    // the input is the coarse Form tessellation (0.3 mm chord): its rim polyline is what the rim is pulled onto
    expect(await offBody('cylinder', r.cage)).toBeLessThan(0.06)
    const truth = Math.PI * 100 * 20
    const v = await exactVolume(r.cage), vOld = await exactVolume(old.cage)
    console.log('REMESH cylinder', JSON.stringify({ pts: r.cage.positions.length, oldPts: old.cage.positions.length, volume: v / truth - 1, oldVolume: vOld / truth - 1 }))
    expect(Math.abs(v - truth) / truth).toBeLessThan(0.01)
    expect(Math.abs(v - truth)).toBeLessThan(Math.abs(vOld - truth))
  }, 180_000)

  it('a filleted box: every face a grid (flat faces, strips and the three-sided corners), on the body, its volume', async () => {
    const t = await mesh('filleted box')
    const r = formFromBody(t)
    const old = formFromBody(t, { remesh: false })
    expect(validateCage(r.cage, true).problems).toEqual([])
    // the six flat faces run smoothly into the fillets: gridded too, not one n-gon each
    expect(r.flatFaces).toBe(0)
    expect(r.gridFaces).toBe(26) // 6 flat + 12 edge strips + 8 corner blends
    expect(r.curvedTriangles).toBe(0)
    expect(r.cage.faces.every((f) => f.length === 4)).toBe(true)
    // a few more points than the old path's triangles (416), which smoothed into a lumpy skin
    expect(r.cage.positions.length).toBeLessThan(old.cage.positions.length * 1.25)
    const off = await offBody('filleted box', r.cage)
    expect(off).toBeLessThan(0.12)
    const truth = (await engine.measure(bodies.get('filleted box')!, 'volume')).value
    const v = await exactVolume(r.cage), vOld = await exactVolume(old.cage)
    console.log('REMESH filleted box', JSON.stringify({ pts: r.cage.positions.length, oldPts: old.cage.positions.length, off, volume: v / truth - 1, oldVolume: vOld / truth - 1 }))
    expect(Math.abs(v - truth) / truth).toBeLessThan(0.002)
  }, 300_000)

  it('a box notched by a cylinder: flat faces whole, the notch a quad grid, straight edges not divided, its volume', async () => {
    const t = await mesh('notched box')
    const r = formFromBody(t)
    expect(validateCage(r.cage, true).problems).toEqual([])
    expect(r.flatFaces).toBe(6)
    expect(r.gridFaces).toBe(1)
    expect(r.curvedTriangles).toBe(0)
    // the box's straight edges between two flat faces keep their two ends: only the notch's arcs and its
    // straight sides are divided
    expect(r.cage.positions.length).toBeLessThan(40)
    expect(await offBody('notched box', r.cage)).toBeLessThan(0.1)
    const truth = 30 * 30 * 20 - (Math.PI * 25 / 4) * 20
    const v = await exactVolume(r.cage)
    console.log('REMESH notched box', JSON.stringify({ pts: r.cage.positions.length, volume: v / truth - 1 }))
    expect(Math.abs(v - truth) / truth).toBeLessThan(0.005)
  }, 180_000)

  it('a curved edge is divided by how far it turns: a quarter circle in three chords gets four segments at 25 degrees', () => {
    // a quarter cylinder (face 0, three quads), a flat sector at each end (faces 1, 2) and a flap on each
    // straight side (3, 4), so its boundary is four chains
    const position: number[] = [], index: number[] = [], triFace: number[] = []
    const pt = (x: number, y: number, z: number) => { position.push(x, y, z); return position.length / 3 - 1 }
    const arc = (y: number) => [0, 1, 2, 3].map((k) => pt(10 * Math.cos((k * Math.PI) / 6), y, 10 * Math.sin((k * Math.PI) / 6)))
    const quad = (a: number, b: number, c: number, d: number, f: number) => { index.push(a, b, c, a, c, d); triFace.push(f, f) }
    const rows = [arc(0), arc(1)]
    for (let k = 0; k < 3; k++) quad(rows[0][k], rows[0][k + 1], rows[1][k + 1], rows[1][k], 0)
    for (const [j, f] of [[0, 1], [1, 2]]) { const c = pt(0, j, 0); for (let k = 0; k < 3; k++) { index.push(c, rows[j][k + 1], rows[j][k]); triFace.push(f) } }
    quad(rows[0][0], rows[1][0], pt(11, 1, 0), pt(11, 0, 0), 3)
    quad(rows[0][3], pt(0, 0, 11), pt(0, 1, 11), rows[1][3], 4)
    const res = remeshFromBody({ position, index, triFace }, { pull: false, spacing: 100, maxTurnDeg: 25 })
    const onArc = res.cage.positions.filter((p) => Math.abs(p[1]) < 1e-9 && Math.abs(Math.hypot(p[0], p[2]) - 9.5) < 0.5 + 1e-6)
    // the polyline turns 60 degrees at its two inner points (three segments at 25); the circle it follows turns 90
    expect(onArc).toHaveLength(5)
  })

  it('three-sided and five-sided faces: split at a centre into quads', () => {
    // a curved triangle (an octant of a sphere) and a curved pentagon, each alone: every side an opening
    for (const sides of [3, 5]) {
      const position: number[] = [], index: number[] = [], triFace: number[] = []
      const rim = 12 * sides, r = 20
      position.push(0, 0, r)
      for (let i = 0; i < rim; i++) {
        const a = (2 * Math.PI * i) / rim
        position.push(r * Math.sin(0.8) * Math.cos(a), r * Math.sin(0.8) * Math.sin(a), r * Math.cos(0.8))
      }
      for (let i = 0; i < rim; i++) { index.push(0, 1 + i, 1 + ((i + 1) % rim)); triFace.push(0) }
      // a neighbouring face on each side, so the rim splits into `sides` chains
      const base = position.length / 3
      for (let i = 0; i < rim; i++) {
        const a = (2 * Math.PI * i) / rim
        position.push(r * 1.2 * Math.cos(a), r * 1.2 * Math.sin(a), 0)
      }
      for (let i = 0; i < rim; i++) {
        const j = (i + 1) % rim, f = 1 + Math.floor(i / 12)
        index.push(1 + i, base + i, base + j, 1 + i, base + j, 1 + j); triFace.push(f, f)
      }
      const res = remeshFromBody({ position, index, triFace }, { pull: false, sharpDeg: 89 })
      expect(res.gridFaces).toBe(1 + sides) // the cap and its neighbours
      expect(res.triangleFaces).toBe(0)
      expect(res.cage.faces.every((f) => f.length === 4)).toBe(true)
      // the cage point nearest the cap's top is its centre: one quad per corner meets there
      const top = res.cage.positions.reduce((b, p, i) => (p[2] > res.cage.positions[b][2] ? i : b), 0)
      expect(res.cage.faces.filter((f) => f.includes(top))).toHaveLength(sides)
      expect(validateCage(res.cage, false).problems).toEqual([])
    }
  })
})
