// Shell on a form part with fillets, a boss and a blind hole in the opened face
// (Form stage 4b's Shell row). Two engine faults stopped it, neither of them
// the fillets:
//  - the rounded wall MakeThickSolid builds round a re-entrant edge (a boss on
//    a plate, a shaft on a knob) had no stable id, so every such shell was
//    refused ("could not trace to a generating face");
//  - the WO-2107 route's wall round a blind hole was built off the hole: the
//    grown floor outline came back `depth` away from the floor, so the cavity
//    cut into the hole and the route gave up.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GeomEngine } from '../../geom/worker/geom-engine'
import type { BodyHandle, StableId } from '../../geom/geom-service'
import { creaseRimAt, cylinderCage } from '../../form/starters'
import { formStep } from '../../form/exactStep'
import { DISPLAY_TESS_QUALITY } from '../../viewport3d/tessQuality'

const knob = () => creaseRimAt(cylinderCage({ size: { x: 40, y: 40, z: 25 }, segments: { x: 8, y: 1, z: 2 } }), 0)
const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer
const plane = (x: number, y: number, z: number) => ({ origin: { x, y, z }, normal: { x: 0, y: 0, z: 1 }, xDir: { x: 1, y: 0, z: 0 } })
type Pt = [number, number]
const circle = (id: string, r: number) => [[{ kind: 'arc' as const, c: [0, 0] as Pt, r, a0: 0, a1: Math.PI * 2, ccw: true, srcId: `${id}.c0` }]]
const square = (id: string, h: number) => [[
  { kind: 'line' as const, a: [-h, -h] as Pt, b: [h, -h] as Pt, srcId: `${id}.e0` },
  { kind: 'line' as const, a: [h, -h] as Pt, b: [h, h] as Pt, srcId: `${id}.e1` },
  { kind: 'line' as const, a: [h, h] as Pt, b: [-h, h] as Pt, srcId: `${id}.e2` },
  { kind: 'line' as const, a: [-h, h] as Pt, b: [-h, -h] as Pt, srcId: `${id}.e3` }]]

describe('shell on parts with bosses, fillets and a blind hole (real occt-wasm)', () => {
  let engine: GeomEngine
  beforeAll(async () => { engine = new GeomEngine(); await engine.init() }, 120_000)
  afterAll(async () => { await engine.disposeKernel() })

  async function edgesWhere(body: BodyHandle, where: (p: number[]) => boolean): Promise<StableId[]> {
    const t = await engine.tessellate(body, DISPLAY_TESS_QUALITY)
    const out: StableId[] = []
    for (let e = 0; e + 1 < t.edgeOffsets.length; e++) {
      let all = true
      for (let q = t.edgeOffsets[e]; q < t.edgeOffsets[e + 1]; q++) if (!where([t.edgePositions[q * 3], t.edgePositions[q * 3 + 1], t.edgePositions[q * 3 + 2]])) { all = false; break }
      if (all) out.push(t.edgeIds[e])
    }
    return out
  }
  /** the face carrying the most triangles lying wholly where `where` holds */
  async function faceWhere(body: BodyHandle, where: (p: number[]) => boolean): Promise<StableId> {
    const t = await engine.tessellate(body, DISPLAY_TESS_QUALITY)
    const count = new Map<number, number>()
    for (let tri = 0; tri < t.index.length / 3; tri++) {
      if ([0, 1, 2].every((k) => { const v = t.index[tri * 3 + k] * 3; return where([t.position[v], t.position[v + 1], t.position[v + 2]]) })) count.set(t.triFace[tri], (count.get(t.triFace[tri]) ?? 0) + 1)
    }
    return t.faceIds[[...count.entries()].sort((a, b) => b[1] - a[1])[0][0]]
  }
  const boss = async (target: BodyHandle, loops: ReturnType<typeof circle> | ReturnType<typeof square>, x: number, y: number, z0: number) =>
    engine.makeExtrude({ featureId: 'EXJ', op: 'add', target, end: { kind: 'blind', distance: 8 }, profile: { sketchId: 'SK', plane: plane(x, y, z0), loops } })

  const BOSSES: Array<[string, ReturnType<typeof circle> | ReturnType<typeof square>, number]> = [['a round boss', circle('SK', 4), 1], ['a square boss', square('SK', 4), 4]]
  for (const [name, loops, blends] of BOSSES) {
    it(`a plate with ${name} shells open at the boss end; each rounded wall is named by the faces it joins, the same every time`, async () => {
      const plate = await engine.makeBox('BOX', { x: 40, y: 40, z: 20 })
      const part = await boss(plate.body!, loops, 20, 20, -8)
      expect(part.ok).toBe(true)
      const end = await faceWhere(part.body!, (p) => Math.abs(p[2] + 8) < 1e-5)
      const once = await engine.applyShell({ featureId: 'SHL', body: part.body!, removeFaces: [end], thickness: 1.5 })
      expect(once.diagnostics).toEqual([{ code: 'OK', severity: 'info' }])
      const named = once.elementMap!.generated.filter((id) => id.startsWith('SHL:SHL:blend:('))
      expect(named).toHaveLength(blends)
      // each joins the plate's underside and a boss side
      for (const id of named) expect(id).toMatch(/^SHL:SHL:blend:\(BOX:[^|]+\|EXJ:XTR:SK[^|]*:side\)$/)
      const again = await engine.applyShell({ featureId: 'SHL', body: part.body!, removeFaces: [end], thickness: 1.5 })
      expect(again.elementMap!.generated).toEqual(once.elementMap!.generated)
      const solid = (await engine.measure(part.body!, 'volume')).value
      const walls = (await engine.measure(once.body!, 'volume')).value
      expect(walls).toBeLessThan(solid / 2)
    }, 300_000)
  }

  it('the stage 4b form part - knob, shaft, rounded rim and root, end chamfer, a 3 mm blind hole in the opened end - shells', async () => {
    const res = await engine.importStep(bytes(formStep(knob(), 'Knob', 3).text), 'FRM1')
    const shaft = await boss(res.bodies[0].handle, circle('SK', 4), 0, 0, -8)
    const rim = await edgesWhere(shaft.body!, (p) => Math.abs(p[2]) < 1e-6 && Math.hypot(p[0], p[1]) > 10)
    const rounded = await engine.applyFillet({ featureId: 'FRR', body: shaft.body!, edges: rim, radius: 1.5, propagateTangent: true })
    const rootEdges = await edgesWhere(rounded.body!, (p) => Math.abs(p[2]) < 1e-6 && Math.abs(Math.hypot(p[0], p[1]) - 4) < 1e-3)
    const root = await engine.applyFillet({ featureId: 'FIL', body: rounded.body!, edges: rootEdges, radius: 1, propagateTangent: true })
    const endEdges = await edgesWhere(root.body!, (p) => Math.abs(p[2] + 8) < 1e-6 && Math.abs(Math.hypot(p[0], p[1]) - 4) < 1e-3)
    const chamfered = await engine.applyChamfer({ featureId: 'CHA', body: root.body!, edges: endEdges, distance: 0.5, propagateTangent: true })
    expect([rounded.ok, root.ok, chamfered.ok]).toEqual([true, true, true])
    const hole = await engine.makeExtrude({ featureId: 'HOL', op: 'cut', target: chamfered.body!, end: { kind: 'blind', distance: 10 },
      profile: { sketchId: 'SH', plane: plane(0, 0, -8), loops: circle('SH', 1.5) } })
    expect(hole.ok).toBe(true)
    const part = hole.body!
    const end = await faceWhere(part, (p) => Math.abs(p[2] + 8) < 1e-6)
    const shelled = await engine.applyShell({ featureId: 'SHL', body: part, removeFaces: [end], thickness: 1.5 })
    expect(shelled.ok).toBe(true)
    const solid = (await engine.measure(part, 'volume')).value
    const walls = (await engine.measure(shelled.body!, 'volume')).value
    expect(walls).toBeGreaterThan(2000)
    expect(walls).toBeLessThan(solid / 3)
    // the hole is still the hole: its wall and floor come through untouched
    const before = await engine.tessellate(part, DISPLAY_TESS_QUALITY)
    const after = await engine.tessellate(shelled.body!, DISPLAY_TESS_QUALITY)
    const holeFaces = before.faceIds.filter((f) => f.startsWith('HOL:'))
    expect(holeFaces.length).toBeGreaterThan(0)
    for (const id of holeFaces) expect(after.faceIds).toContain(id)
  }, 600_000)

  it('a slot cut across the form shells at 1.5 mm (G1 at its star points); a wall too thick to offset fails naming the order that works, which does', async () => {
    // the stage 4b knob: the default cylinder, its middle ring 1.25x wider, the bottom rim creased
    const c = cylinderCage()
    c.positions = c.positions.map((q) => (Math.abs(q[2] - 15) < 1e-9 ? [q[0] * 1.25, q[1] * 1.25, q[2]] : q))
    const res = await engine.importStep(bytes(formStep(creaseRimAt(c, 0), 'Knob', 3).text), 'FRM1')
    const form = res.bodies[0].handle
    const slot = (target: BodyHandle) => engine.makeExtrude({ featureId: 'EXC', op: 'cut', target, end: { kind: 'blind', distance: 20 },
      profile: { sketchId: 'SL', plane: plane(0, 0, 25), loops: [[
        { kind: 'line', a: [-2, -40], b: [2, -40], srcId: 'SL.e0' }, { kind: 'line', a: [2, -40], b: [2, 40], srcId: 'SL.e1' },
        { kind: 'line', a: [2, 40], b: [-2, 40], srcId: 'SL.e2' }, { kind: 'line', a: [-2, 40], b: [-2, -40], srcId: 'SL.e3' }]] } })
    const slotted = await slot(form)
    expect(slotted.ok).toBe(true)
    const bottom = await faceWhere(slotted.body!, (p) => Math.abs(p[2]) < 1e-6)
    // before the G1 pass (Form stage 13) this shell failed: the kinks at the star points stopped the offset
    const shelled = await engine.applyShell({ featureId: 'SHL', body: slotted.body!, removeFaces: [bottom], thickness: 1.5 })
    expect(shelled.ok).toBe(true)
    const failed = await engine.applyShell({ featureId: 'SHL', body: slotted.body!, removeFaces: [bottom], thickness: 3 })
    expect(failed.ok).toBe(false)
    expect(String(failed.diagnostics[0].params?.reason)).toMatch(/Offsets stop where a cut trims form faces \(FRM1\); Shell the form before that cut, then cut - that order works\.$/)
    // that order: the form shells, then the slot cuts it
    const first = await engine.applyShell({ featureId: 'SHL', body: form, removeFaces: [await faceWhere(form, (p) => Math.abs(p[2]) < 1e-6)], thickness: 3 })
    expect(first.ok).toBe(true)
    const cut = await slot(first.body!)
    expect(cut.ok).toBe(true)
    expect((await engine.measure(cut.body!, 'volume')).value).toBeLessThan((await engine.measure(first.body!, 'volume')).value)
  }, 600_000)
})
