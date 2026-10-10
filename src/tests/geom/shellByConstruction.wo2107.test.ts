// WO-2107: Shell on Step Test With Holes works the way other CAD tells its
// users to do it by hand - hollow the plain block, then cut each hole and
// pocket back in grown by the wall - when the direct shell (MakeThickSolid)
// fails. Through the production entry point (GeomEngine.applyShell) on the
// face picked in headed run S1. Where the walls cannot join up (1 mm, 2 mm)
// the body is left alone and the message says how many pieces and the
// thinnest wall that keeps it one piece, as Fusion and standard editor refuse it.
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
    it(`${thickness} mm: body unchanged, the message names ${pieces} pieces and the thinnest one-piece wall`, async () => {
      const shell = await engine.applyShell({ featureId: 'S1', body: source, removeFaces: [OPEN_FACE], thickness })
      expect(shell.ok).toBe(false)
      expect(shell.body).toBeUndefined()
      expect(shell.diagnostics).toHaveLength(1)
      const diag = shell.diagnostics[0]
      expect(diag.code).toBe('SHELL_FAILED')
      expect(diag.params?.pieces).toBe(pieces)
      const onePiece = Number(diag.params?.onePieceThickness)
      expect(onePiece).toBeGreaterThan(2)
      expect(onePiece).toBeLessThanOrEqual(2.5)
      const reason = String(diag.params?.reason)
      expect(reason).toContain(`${pieces} separate pieces`)
      expect(reason).toContain(`The thinnest wall that keeps it one piece is ${onePiece} mm`)
      expect(reason).toContain('left unchanged')
      expect(reason.toLowerCase()).not.toContain('webassembly')

      // The one-piece thickness it names does build.
      const retry = await engine.applyShell({ featureId: 'S2', body: source, removeFaces: [OPEN_FACE], thickness: onePiece })
      expect(retry.ok, JSON.stringify(retry.diagnostics)).toBe(true)
      await engine.dispose(retry.body!)

      expect((await engine.measure(source, 'volume')).value).toBeCloseTo(sourceVolume, 8)
    }, 300_000)
  }

  it('leaks no kernel handles on the construction route', async () => {
    const baseline = engine.debugKernelShapeCount()
    const split = await engine.applyShell({ featureId: 'S1', body: source, removeFaces: [OPEN_FACE], thickness: 1 })
    expect(split.ok).toBe(false)
    expect(engine.debugKernelShapeCount()).toBe(baseline)
    const built = await engine.applyShell({ featureId: 'S1', body: source, removeFaces: [OPEN_FACE], thickness: 2.5 })
    expect(built.ok).toBe(true)
    await engine.dispose(built.body!)
    expect(engine.debugKernelShapeCount()).toBe(baseline)
  }, 300_000)
})
