import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { OcctKernel } from 'occt-wasm'
import type { ShapeHandle } from 'occt-wasm'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'

const FIXTURES = join(process.cwd(), 'src/tests/geom/fixtures')
const OPEN_FACE = 'IMP1:step:face#0'

function fixtureBytes(name: string): ArrayBuffer {
  const bytes = readFileSync(join(FIXTURES, name))
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

describe('WO-2084 shell on Step Test With Holes', () => {
  let engine: GeomEngine

  beforeAll(async () => {
    engine = new GeomEngine()
    await engine.init()
  }, 60_000)

  afterAll(async () => {
    await engine.disposeKernel()
  })

  // WO-2799 preserves every valid disconnected skin; it no longer imposes
  // a one-piece wall thickness. This is the same face picked in headed S1.
  it('keeps all ten pieces of the recorded 1 mm top-face shell and names the separation', async () => {
    const imported = await engine.importStep(fixtureBytes('step-test-with-holes.step'), 'IMP1')
    expect(imported.bodies, JSON.stringify(imported.diagnostics)).toHaveLength(1)
    const source = imported.bodies[0].handle
    const sourceSnapshots = engine.snapshotsFor(source)
    expect(sourceSnapshots[OPEN_FACE]).toMatchObject({ type: 'plane' })
    expect(sourceSnapshots[OPEN_FACE].normal?.[2]).toBeGreaterThan(0.999)
    const volumeBefore = (await engine.measure(source, 'volume')).value
    const shell = await engine.applyShell({ featureId: 'S1', body: source, removeFaces: [OPEN_FACE], thickness: 1 })
    expect(shell.ok, JSON.stringify(shell.diagnostics)).toBe(true)
    expect(shell.body).toBeDefined()
    expect(shell.diagnostics).toEqual([{ code: 'OK', severity: 'info', params: {
      pieces: 10, reason: 'Shell left 10 separate pieces: with this face open the pocket no longer joins the outer walls',
    } }])
    const step = await engine.exportStep([shell.body!])
    const kernel = await OcctKernel.init()
    let roundTrip: ShapeHandle | undefined
    try {
      roundTrip = kernel.importStep(step)
      expect(kernel.isValid(roundTrip)).toBe(true)
      const pieces = kernel.getSubShapes(roundTrip, 'solid')
      expect(pieces).toHaveLength(10)
      expect(pieces.every((p) => kernel.isValid(p) && kernel.getVolume(p) > 0)).toBe(true)
      expect(kernel.getVolume(roundTrip)).toBeCloseTo((await engine.measure(shell.body!, 'volume')).value, 3)
      // Eight disconnected blind-hole cups, independent cylindrical/frustum
      // hand volumes (r2.5, mouth r3 over 0.5 mm, depths 8 and 10).
      const cups = pieces.filter((p) => {
        const b = kernel.getBoundingBox(p, false)
        return Math.abs(b.xmax - b.xmin - 7) < 1e-5
      })
      expect(cups).toHaveLength(8)
      const volumes = cups.map((p) => kernel.getVolume(p)).sort((a, b) => a - b)
      const hand = (depth: number) => Math.PI * (3.5 ** 2 * (depth + 1)
        - 2.5 ** 2 * (depth - 0.5) - 0.5 / 3 * (2.5 ** 2 + 2.5 * 3 + 3 ** 2))
      for (let i = 0; i < 8; i++) expect(volumes[i]).toBeCloseTo(hand(i < 4 ? 8 : 10), 5)
    } finally {
      if (roundTrip !== undefined) kernel.release(roundTrip)
      kernel[Symbol.dispose]()
    }
    expect((await engine.measure(source, 'volume')).value).toBeCloseTo(volumeBefore, 8)
    await engine.disposeAll()
  }, 180_000)

  it('keeps the working plate-holes 2 mm shell valid and closed', async () => {
    const imported = await engine.importStep(fixtureBytes('plate-holes.step'), 'CONTROL')
    expect(imported.bodies, JSON.stringify(imported.diagnostics)).toHaveLength(1)
    const source = imported.bodies[0].handle
    const top = Object.entries(engine.snapshotsFor(source)).filter(([, snapshot]) =>
      snapshot.type === 'plane' && (snapshot.normal?.[2] ?? 0) > 0.999,
    )
    expect(top).toHaveLength(1)
    const volumeBefore = (await engine.measure(source, 'volume')).value
    const shell = await engine.applyShell({ featureId: 'CONTROL-SHELL', body: source, removeFaces: [top[0][0]], thickness: 2 })

    expect(shell.ok, JSON.stringify(shell.diagnostics)).toBe(true)
    expect(shell.body).toBeDefined()
    const volumeAfter = (await engine.measure(shell.body!, 'volume')).value
    expect(volumeAfter).toBeGreaterThan(0)
    expect(volumeAfter).toBeLessThan(volumeBefore)

    const step = await engine.exportStep([shell.body!])
    const kernel = await OcctKernel.init()
    let roundTrip: ShapeHandle | undefined
    try {
      roundTrip = kernel.importStep(step)
      expect(kernel.isValid(roundTrip)).toBe(true)
      expect(kernel.isSolid(roundTrip)).toBe(true)
    } finally {
      if (roundTrip !== undefined) kernel.release(roundTrip)
      kernel[Symbol.dispose]()
    }
    expect((await engine.measure(source, 'volume')).value).toBeCloseTo(volumeBefore, 8)
    await engine.disposeAll()
  }, 180_000)
})
