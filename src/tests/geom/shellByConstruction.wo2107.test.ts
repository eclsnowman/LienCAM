// WO-2107: Shell on Step Test With Holes works the way other CAD tells its
// users to do it by hand - hollow the plain block, then cut each hole and
// pocket back in grown by the wall - when the direct shell (MakeThickSolid)
// fails. Through the production entry point (GeomEngine.applyShell) on the
// face picked in headed run S1. Where the walls cannot join up (1 mm, 2 mm)
// WO-2799 preserves every valid piece in a compound and reports the separation.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { OcctKernel } from 'occt-wasm'
import type { ShapeHandle } from 'occt-wasm'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'
import type { BodyHandle } from '../../geom/geom-service.ts'

const FIXTURE = join(process.cwd(), 'src/tests/geom/fixtures/step-test-with-holes.step')
const OPEN_FACE = 'IMP1:step:face#0'

function fixtureBytes(): ArrayBuffer {
  const bytes = readFileSync(FIXTURE)
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

describe('WO-2107 Shell by shelling the block first, then cutting the holes back in', () => {
  let engine: GeomEngine
  let source: BodyHandle
  let sourceVolume: number

  beforeAll(async () => {
    engine = new GeomEngine()
    await engine.init()
    const imported = await engine.importStep(fixtureBytes(), 'IMP1')
    expect(imported.bodies, JSON.stringify(imported.diagnostics)).toHaveLength(1)
    source = imported.bodies[0].handle
    const snapshot = engine.snapshotsFor(source)[OPEN_FACE]
    expect(snapshot).toMatchObject({ type: 'plane' })
    expect(snapshot.normal?.[2]).toBeGreaterThan(0.999)
    sourceVolume = (await engine.measure(source, 'volume')).value
  }, 60_000)

  afterAll(async () => {
    await engine.disposeKernel()
  })

  /** Kernel truth about the exported result, read back from its STEP. */
  async function readBack(body: BodyHandle) {
    const step = await engine.exportStep([body])
    const kernel = await OcctKernel.init()
    let shape: ShapeHandle | undefined
    try {
      shape = kernel.importStep(step)
      const faces = kernel.getSubShapes(shape, 'face')
      return {
        valid: kernel.isValid(shape),
        solids: kernel.getSubShapes(shape, 'solid').length,
        cones: faces.filter((f) => kernel.surfaceType(f) === 'cone').length,
        volume: kernel.getVolume(shape),
        parts: kernel.getSubShapes(shape, 'solid').map((solid) => ({
          valid: kernel.isValid(solid), volume: kernel.getVolume(solid), bounds: kernel.getBoundingBox(solid, false),
        })),
      }
    } finally {
      if (shape !== undefined) kernel.release(shape)
      kernel[Symbol.dispose]()
    }
  }

  for (const thickness of [2.5, 3]) {
    it(`${thickness} mm: one closed valid solid, lighter, all 20 chamfer cones, exports, faces pickable, source untouched`, async () => {
      const shell = await engine.applyShell({ featureId: 'S1', body: source, removeFaces: [OPEN_FACE], thickness })
      expect(shell.ok, JSON.stringify(shell.diagnostics)).toBe(true)
      const body = shell.body!

      const volume = (await engine.measure(body, 'volume')).value
      expect(volume).toBeLessThan(sourceVolume)
      expect(volume).toBeGreaterThan(0)

      // STEP export works and reads back as one valid closed solid with every
      // chamfer cone of the source.
      const back = await readBack(body)
      expect(back.valid).toBe(true)
      expect(back.solids).toBe(1)
      expect(back.cones).toBe(20)
      expect(back.volume).toBeCloseTo(volume, 3)

      // Shell-grammar ids: the opened face keeps its id or splits `#j`; the
      // walls are `:inner` companions of the faces they lie the wall away from.
      const snapshots = engine.snapshotsFor(body)
      const ids = Object.keys(snapshots)
      expect(Object.values(snapshots).filter((s) => s.type === 'cone')).toHaveLength(20)
      const inner = ids.filter((id) => id.startsWith('S1:SHL:') && id.includes(':inner'))
      expect(inner.length).toBeGreaterThan(0)
      expect(ids.every((id) => id.startsWith('IMP1:') || id.startsWith(`S1:SHL:${OPEN_FACE}`) || id.startsWith('S1:SHL:IMP1:'))).toBe(true)
      expect(shell.elementMap?.generated).toEqual(expect.arrayContaining(inner))
      // Every face id resolves on the result.
      const resolved = await engine.resolve(body, ids)
      expect(resolved.filter((r) => r.status !== 'exact')).toEqual([])

      // A later edit can pick a shell face: push the cavity floor (the inner
      // companion of the part's bottom face - one face at 2.5 mm, split `#j`
      // by the hole walls at 3 mm) up by 0.5 mm.
      const bottom = Object.entries(engine.snapshotsFor(source)).find(([, s]) => s.type === 'plane' && (s.normal?.[2] ?? 0) < -0.999 && s.area > 1000)
      expect(bottom).toBeDefined()
      const floorIds = ids.filter((id) => id === `S1:SHL:${bottom![0]}:inner` || id.startsWith(`S1:SHL:${bottom![0]}:inner#`))
      expect(floorIds.length).toBeGreaterThan(0)
      for (const id of floorIds) expect(snapshots[id].centroid[2]).toBeCloseTo(-14 + thickness, 6)
      const cavityFloor = floorIds.reduce((a, b) => (snapshots[b].area > snapshots[a].area ? b : a))
      const edit = await engine.editFeature({ featureId: 'E1', body, featureKey: cavityFloor, delta: 0.5, kind: 'faceOffset' })
      expect(edit.ok, JSON.stringify(edit.diagnostics)).toBe(true)
      expect((await engine.measure(edit.body!, 'volume')).value).not.toBeCloseTo(volume, 3)

      // Undo: the source body is untouched.
      expect((await engine.measure(source, 'volume')).value).toBeCloseTo(sourceVolume, 8)
      await engine.dispose(edit.body!)
      await engine.dispose(body)
    }, 300_000)
  }

  for (const [thickness, pieces] of [[1, 10], [2, 5]] as const) {
    it(`${thickness} mm: preserves all ${pieces} valid pieces, exports the complete compound and leaves the source untouched`, async () => {
      const shell = await engine.applyShell({ featureId: 'S1', body: source, removeFaces: [OPEN_FACE], thickness })
      expect(shell.ok, JSON.stringify(shell.diagnostics)).toBe(true)
      expect(shell.body).toBeDefined()
      expect(shell.diagnostics).toEqual([{ code: 'OK', severity: 'info', params: {
        pieces, reason: `Shell left ${pieces} separate pieces: with this face open the pocket no longer joins the outer walls`,
      } }])
      const back = await readBack(shell.body!)
      console.log('WO2815_SHELL=' + JSON.stringify({ thickness, sourceVolume, back }))
      expect(back.valid).toBe(true)
      expect(back.solids).toBe(pieces)
      expect(back.parts.every((p) => p.valid && p.volume > 0)).toBe(true)
      expect(back.volume).toBeCloseTo((await engine.measure(shell.body!, 'volume')).value, 3)
      expect(back.volume).toBeGreaterThan(0)
      expect(back.volume).toBeLessThan(sourceVolume)
      expect(back.cones).toBe(20)
      // Independent hand volumes: the isolated blind-hole cups have a 2.5 mm
      // bore and a 0.5 mm x 45-degree mouth chamfer (radius 3 at z0).
      // Subtract the cylindrical/frustum hole from the grown outer cylinder.
      const cupVolume = (depth: number) => Math.PI * (
        (2.5 + thickness) ** 2 * (depth + thickness)
        - 2.5 ** 2 * (depth - 0.5)
        - 0.5 / 3 * (2.5 ** 2 + 2.5 * 3 + 3 ** 2))
      const cups = back.parts.filter((p) => Math.abs(p.bounds.xmax - p.bounds.xmin - 2 * (2.5 + thickness)) < 1e-5)
      expect(cups).toHaveLength(thickness === 1 ? 8 : 4)
      const expectedDepths = thickness === 1 ? [8, 8, 8, 8, 10, 10, 10, 10] : [8, 8, 8, 8]
      expect(cups.map((p) => Math.round(-p.bounds.zmin - thickness)).sort((a, b) => a - b)).toEqual(expectedDepths)
      for (const cup of cups) {
        const depth = Math.round(-cup.bounds.zmin - thickness)
        expect(cup.volume).toBeCloseTo(cupVolume(depth), 5)
        expect(cup.bounds.ymax - cup.bounds.ymin).toBeCloseTo(2 * (2.5 + thickness), 5)
      }
      const ids = Object.keys(engine.snapshotsFor(shell.body!))
      expect((await engine.resolve(shell.body!, ids)).every((r) => r.status === 'exact')).toBe(true)
      expect((await engine.measure(source, 'volume')).value).toBeCloseTo(sourceVolume, 8)
      await engine.dispose(shell.body!)
    }, 300_000)
  }

  it('leaks no kernel handles on the construction route', async () => {
    const baseline = engine.debugKernelShapeCount()
    const split = await engine.applyShell({ featureId: 'S1', body: source, removeFaces: [OPEN_FACE], thickness: 1 })
    expect(split.ok).toBe(true)
    await engine.dispose(split.body!)
    expect(engine.debugKernelShapeCount()).toBe(baseline)
    const built = await engine.applyShell({ featureId: 'S1', body: source, removeFaces: [OPEN_FACE], thickness: 2.5 })
    expect(built.ok).toBe(true)
    await engine.dispose(built.body!)
    expect(engine.debugKernelShapeCount()).toBe(baseline)
  }, 300_000)
})
