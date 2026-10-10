import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createLocalGeomService } from '../../geom/index.ts'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'
import { edgeId } from '../../geom/worker/stable-id.ts'
import { readStepDisplayAttributes } from '../../lib/import/stepAttributes.ts'
import { plainDiagnosticText } from '../../components/model3d/SolidsWorkbenchPage.tsx'

// WO-2093: a Model-screen edit refusal reads in plain words (what, where, what
// would work) with no internal codes or face ids, and an OCC-made STEP imports
// named after its file rather than "Open CASCADE STEP translator 7.9 N".

function fixtureBytes(path: string): ArrayBuffer {
  const bytes = readFileSync(path)
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

const STEP_TEST = join(process.cwd(), 'src/tests/geom/fixtures/step-test-with-holes.step')
const FIX_PLATE = join(process.cwd(), 'test_fixtures/brep/fix_plate_holes.step')
// Headed run S1 (.planning/direct-edit-imports-2026-09-27): the top face meets a
// hole's 0.5 mm top chamfer; the Fillet dialog opens at 2 mm and was refused
// as "FILLET_RADIUS_TOO_LARGE: edges=(IMP1:step:face#0^...)".
const SMALL_EDGE = '(IMP1:step:face#0∧IMP1:step:face#43)'

function expectNoInternals(text: string): void {
  expect(text).not.toMatch(/[A-Z]+_[A-Z_]+/)
  expect(text).not.toMatch(/IMP\d|:step:|face#|∧/)
  expect(text).not.toMatch(/\w+=/)
}

describe('WO-2093 plain-word edit messages', () => {
  let client: ReturnType<typeof createLocalGeomService>

  beforeAll(async () => {
    client = createLocalGeomService()
    await client.init()
  }, 60_000)

  afterAll(async () => {
    await client.disposeAll()
  })

  it('a too-large fillet on Step Test With Holes says so in plain words with the largest radius that fits', async () => {
    const imported = await client.importStep(fixtureBytes(STEP_TEST), 'IMP1')
    expect(imported.bodies).toHaveLength(1)
    const body = imported.bodies[0].handle
    expect((await client.tessellate(body, { deflection: 0.1 })).edgeIds).toContain(SMALL_EDGE)

    const refused = await client.applyFillet({ featureId: 'FIL1', body, edges: [SMALL_EDGE], radius: 2, propagateTangent: true })
    expect(refused.ok).toBe(false)
    const largest = refused.diagnostics[0].params?.largestRadius
    expect(typeof largest).toBe('number')
    expect(largest as number).toBeGreaterThan(0)
    expect(largest as number).toBeLessThan(2)

    const message = plainDiagnosticText(refused.diagnostics)
    expect(message).toBe(`largest radius that fits: ${largest} mm (2 mm is too big for the picked edge)`)
    expectNoInternals(message)

    // "What would work" is true: the named radius builds.
    const fits = await client.applyFillet({ featureId: 'FIL1', body, edges: [SMALL_EDGE], radius: largest as number, propagateTangent: true })
    expect(fits.ok, JSON.stringify(fits.diagnostics)).toBe(true)
    await client.dispose(fits.body!)
    await client.dispose(body)
  }, 120_000)

  it('a too-large chamfer names the largest chamfer that fits', async () => {
    const imported = await client.importStep(fixtureBytes(STEP_TEST), 'IMP1')
    const body = imported.bodies[0].handle
    const refused = await client.applyChamfer({ featureId: 'CHM1', body, edges: [SMALL_EDGE], distance: 2, propagateTangent: true })
    expect(refused.ok).toBe(false)
    const largest = refused.diagnostics[0].params?.largestDistance
    expect(typeof largest).toBe('number')
    const message = plainDiagnosticText(refused.diagnostics)
    expect(message).toBe(`largest chamfer that fits: ${largest} mm (2 mm is too big for the picked edge)`)
    expectNoInternals(message)
    await client.dispose(body)
  }, 120_000)

  it('other refusals drop codes and internal ids', () => {
    const shell = plainDiagnosticText([{
      code: 'SHELL_FAILED',
      severity: 'error',
      params: { faces: 'IMP1:step:face#3', reason: 'shell thickness 1 exceeds the local wall geometry at face IMP1:step:face#3, IMP1:step:face#7' },
    }])
    expect(shell).toBe('shell thickness 1 exceeds the local wall geometry at the picked faces')
    expectNoInternals(shell)

    const unresolved = plainDiagnosticText([{ code: 'REFERENCE_UNRESOLVED', severity: 'error', params: { op: 'FIL', ids: SMALL_EDGE } }])
    expect(unresolved).toBe('the picked edge or face is no longer on the model - pick it again')

    const bare = plainDiagnosticText([{ code: 'DRAFT_FAILED', severity: 'error' }])
    expect(bare).toBe('the draft could not be built on the picked faces')
    expectNoInternals(bare)
  })

  it('an OCC-made STEP imports named after its file, a named part keeps its name', async () => {
    const plate = await client.importStep(fixtureBytes(FIX_PLATE), 'IMP2')
    expect(plate.bodies.map((b) => b.name)).toEqual(['IMP2:step:body#0'])
    for (const b of plate.bodies) await client.dispose(b.handle)

    // The Model screen's import reads this; no name -> the file name is used.
    const service = async () => createLocalGeomService()
    const plateDisplay = await readStepDisplayAttributes(fixtureBytes(FIX_PLATE), 'IMP2', service)
    expect(plateDisplay.name).toBeUndefined()
    expect(plateDisplay.warning).toBeUndefined()

    const stepTestDisplay = await readStepDisplayAttributes(fixtureBytes(STEP_TEST), 'IMP3', service)
    expect(stepTestDisplay.name).toBe('Part 1')
  }, 120_000)
})

describe('WO-2093 largest-fit search spends a bounded share of the kernel', () => {
  it('repeats on one shape cost nothing; a spent budget names no value, never a wrong one', async () => {
    const engine = new GeomEngine()
    await engine.init()
    try {
      const edge = edgeId(['F1:BOX:xMin', 'F1:BOX:yMin'], '0')
      const ask = async (x: number) => {
        const box = await engine.makeBox('F1', { x, y: 20, z: 10 })
        const r = await engine.applyFillet({ featureId: 'R', body: box.body!, edges: [edge], radius: 25, propagateTangent: true })
        await engine.dispose(box.body!)
        return r
      }
      const first = await ask(40)
      const largest = first.diagnostics[0].params?.largestRadius
      expect(largest as number).toBeGreaterThan(19)
      expect(largest as number).toBeLessThan(20)
      // A preview replays onto a new handle each keystroke; same shape, same answer.
      for (let i = 0; i < 5; i++) expect((await ask(40)).diagnostics[0].params?.largestRadius).toBe(largest)

      // Distinct shapes until the failure budget is spent.
      let unknown: Awaited<ReturnType<typeof ask>> | undefined
      for (let i = 1; i < 200 && unknown === undefined; i++) {
        const r = await ask(40 + i * 0.01)
        if (r.diagnostics[0].params?.largestRadius === undefined) unknown = r
      }
      expect(unknown).toBeDefined()
      const message = plainDiagnosticText(unknown!.diagnostics)
      expect(message).toBe('fillet radius 25 is too large for the picked edge -- it cannot be constructed without self-intersecting the adjacent faces')
      // The kernel is still healthy afterwards.
      const box = await engine.makeBox('B', { x: 10, y: 10, z: 10 })
      expect((await engine.serializeBody(box.body!)).byteLength).toBeGreaterThan(0)
    } finally {
      await engine.disposeKernel()
    }
  }, 120_000)
})
