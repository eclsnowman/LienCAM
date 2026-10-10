// Form stage 45: From body puts fewer rings on ruled faces - a cylinder or cone side is one ring of quads, and
// a quad face ruled between creased straight sides takes one segment of them - while a really curved band keeps
// its rings.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GeomEngine } from '../../geom/worker/geom-engine'
import type { BodyHandle } from '../../geom/geom-service'
import type { Cage, Vec3 } from '../../form/cage'
import { FORM_FROM_BODY_TESS } from '../../form/fromMesh'
import { remeshFromBody } from '../../form/remesh'
import { formStep } from '../../form/exactStep'
import { validateCage } from '../../form/halfEdge'
import { closestPointIndex } from '../../form/closestPoint'
import { applyRows, cagePositionArray, levelFromCage, limitRows, refine, type Level } from '../../form/subdivide'

const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer
function skin(cage: Cage, levels = 4): Vec3[] {
  let level: Level = levelFromCage(cage)
  let P = cagePositionArray(cage)
  for (let k = 0; k < levels; k++) { const r = refine(level); P = applyRows(r.rows, P); level = r.level }
  const L = applyRows(limitRows(level), P)
  const out: Vec3[] = []
  for (let i = 0; i < L.length; i += 3) out.push([L[i], L[i + 1], L[i + 2]])
  return out
}

/** a band round the Z axis between z = -h and h (radius r(z)), rows of k points, capped flat at both ends;
 *  `turn`: the top row's points are made starting that many points round (its loop starts elsewhere) */
function band(r: (z: number) => number, h: number, rows: number, k: number, turn = 0) {
  const position: number[] = [], index: number[] = [], triFace: number[] = []
  const pt = (x: number, y: number, z: number) => { position.push(x, y, z); return position.length / 3 - 1 }
  const ring = (z: number, s: number) => {
    const ids = new Array<number>(k)
    for (let n = 0; n < k; n++) { const i = (n + s) % k; const a = (2 * Math.PI * i) / k; ids[i] = pt(r(z) * Math.cos(a), r(z) * Math.sin(a), z) }
    return ids
  }
  const R = Array.from({ length: rows }, (_, j) => ring(-h + (2 * h * j) / (rows - 1), j === rows - 1 ? turn : 0))
  for (let j = 0; j + 1 < rows; j++) for (let i = 0; i < k; i++) {
    const a = R[j][i], b = R[j][(i + 1) % k], c = R[j + 1][(i + 1) % k], d = R[j + 1][i]
    index.push(a, b, c, a, c, d); triFace.push(0, 0)
  }
  const bottom = pt(0, 0, -h), top = pt(0, 0, h)
  for (let i = 0; i < k; i++) { index.push(bottom, R[0][(i + 1) % k], R[0][i]); triFace.push(1); index.push(top, R[rows - 1][i], R[rows - 1][(i + 1) % k]); triFace.push(2) }
  return { position, index, triFace }
}
/** points of the cage strictly between the two rims (off both caps) */
const between = (c: Cage, h: number) => c.positions.filter((p) => Math.abs(p[2]) < h - 1e-6).length

describe('ruled faces take fewer rings (synthetic bands)', () => {
  it('a cylinder band 30 tall: one ring of quads - no point between its rims', () => {
    const r = remeshFromBody(band(() => 10, 15, 7, 32), { pull: false, spacing: 3 })
    expect(validateCage(r.cage, true).problems).toEqual([])
    expect(between(r.cage, 15)).toBe(0)
  })

  it('its rims\' loops start at different points: the one ring still runs straight up (no twist into a waist)', () => {
    const r = remeshFromBody(band(() => 10, 15, 7, 32, 5), { pull: false, spacing: 3 })
    expect(between(r.cage, 15)).toBe(0)
    const P = r.cage.positions
    let worst = 0
    for (const f of r.cage.faces) for (let i = 0; i < f.length; i++) {
      const a = P[f[i]], b = P[f[(i + 1) % f.length]]
      if (Math.abs(Math.abs(a[2] - b[2]) - 30) < 1e-6) worst = Math.max(worst, Math.hypot(a[0] - b[0], a[1] - b[1]))
    }
    expect(worst).toBeLessThan(1e-6)
  })

  it('a sphere band (curved from rim to rim) keeps its rings', () => {
    const r = remeshFromBody(band((z) => Math.sqrt(144 - z * z), 8, 9, 32), { pull: false, spacing: 3 })
    expect(validateCage(r.cage, true).problems).toEqual([])
    expect(between(r.cage, 8)).toBeGreaterThan(0)
  })
})

describe('ruled faces take fewer rings (real occt-wasm)', () => {
  let engine: GeomEngine
  const bodies = new Map<string, BodyHandle>()
  beforeAll(async () => {
    engine = new GeomEngine()
    await engine.init()
    bodies.set('cylinder', (await engine.debugMakeCylinder('C', 10, 20)).body!)
    bodies.set('cone', (await engine.debugMakeCone('K', 10, 5, 20)).body!)
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
  const offBody = async (name: string, cage: Cage) => {
    const fine = await engine.tessellate(bodies.get(name)!, { deflection: 0.01, angularDeflection: 0.05 })
    const idx = closestPointIndex(fine)
    return skin(cage).reduce((w, p) => Math.max(w, idx.closest(p).distance), 0)
  }

  for (const [name, truth] of [['cylinder', Math.PI * 100 * 20], ['cone', (Math.PI * 20 * (100 + 50 + 25)) / 3]] as const) {
    it(`a ${name}: its side is one ring (every point on a rim), on the body, the volume within 1%`, async () => {
      const r = remeshFromBody(await mesh(name))
      expect(validateCage(r.cage, true).problems).toEqual([])
      expect(r.cage.positions.every((p) => Math.abs(p[2]) < 1e-6 || Math.abs(p[2] - 20) < 1e-6)).toBe(true)
      expect(await offBody(name, r.cage)).toBeLessThan(0.08)
      const v = await exactVolume(r.cage)
      console.log('RULED', name, JSON.stringify({ pts: r.cage.positions.length, volume: v / truth - 1 }))
      expect(Math.abs(v - truth) / truth).toBeLessThan(0.01)
    }, 180_000)
  }

  it('a box notched by a cylinder: the notch (ruled between creased straight sides) takes one segment of them', async () => {
    const r = remeshFromBody(await mesh('notched box'))
    expect(validateCage(r.cage, true).problems).toEqual([])
    expect(r.cage.positions.length).toBeLessThanOrEqual(16)
  }, 180_000)
})
