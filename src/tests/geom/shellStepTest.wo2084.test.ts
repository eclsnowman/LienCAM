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

  // WO-2107: MakeThickSolid still aborts on this face, but Shell now builds it
  // by construction where it can; at 1 mm the part would fall into 10 pieces,
  // so the body stays unchanged and the message says so (shellByConstruction.
  // wo2107.test.ts covers the thicknesses that build).
  it('refuses the recorded 1 mm top-face shell naming the pieces, without inventing a wall-thickness cause', async () => {
    const imported = await engine.importStep(fixtureBytes('step-test-with-holes.step'), 'IMP1')
    expect(imported.bodies, JSON.stringify(imported.diagnostics)).toHaveLength(1)
    const source = imported.bodies[0].handle
    const sourceSnapshots = engine.snapshotsFor(source)

    // This is the exact face picked in headed run S1, not a search that could
    // silently choose an easier face when STEP enumeration changes.
    expect(sourceSnapshots[OPEN_FACE]).toMatchObject({ type: 'plane' })
    expect(sourceSnapshots[OPEN_FACE].normal?.[2]).toBeGreaterThan(0.999)

    const volumeBefore = (await engine.measure(source, 'volume')).value
    const shell = await engine.applyShell({
      featureId: 'S1',
      body: source,
      removeFaces: [OPEN_FACE],
      thickness: 1,
    })

    expect(shell.ok).toBe(false)
    expect(shell.body).toBeUndefined()
    expect(shell.diagnostics[0].code).toBe('SHELL_FAILED')
    expect(shell.diagnostics[0].params?.pieces).toBe(10)
    const reason = String(shell.diagnostics[0].params?.reason)
    expect(reason).toContain('would split this part into 10 separate pieces')
    expect(reason).toContain(OPEN_FACE)
    expect(reason).toContain('a 1 mm shell')
    expect(reason).toContain('The thinnest wall that keeps it one piece is')
    expect(reason).toContain('body was left unchanged')
    expect(reason).not.toContain('exceeds the local wall geometry')
    expect(reason.toLowerCase()).not.toContain('webassembly')

    // The failed attempt is non-mutating, so Undo has nothing corrupt to
    // recover from and the original imported body remains byte-equivalent.
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
