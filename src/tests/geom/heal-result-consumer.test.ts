// GEO-11-R2 (blocker 2, EVERY HealResult consumer) — a HealResult reported as
// success but carrying a non-finite volumeDelta must be REFUSED BY NAME at EVERY
// production consumer, not just defeatureBatch. `healRemoval`'s own finite-data
// gate already prevents minting such a result, but the charter's every-consumer
// defense (bar 2) requires each call site to validate at its OWN accept point —
// the producer is not trusted. The audit census found exactly two consumers:
//   - defeatureBatch          (geom-engine.ts ~3336) — per-item + running-total
//   - editFeature holeDiameter (geom-engine.ts ~3734) — the second, R1-unguarded one
//
// These tests INJECT the auditor's fault by mocking `healRemoval` to return a
// poisoned success ({ ok:true, shape, volumeDelta:Infinity }), and — for the
// running-total branch — spy `getVolume` to report a non-finite total. Each
// consumer must refuse with NO body minted. The finite control (real heal) proves
// the gate is non-vacuous. See coordination/evidence/GEO-11/mutation-proof-R2.md
// for the fault-injection runs that show each gate biting.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
// Imported BEFORE GeomEngine below on purpose: it transitively imports
// defeature.ts, which triggers this file's mock factory during ITS
// static-import resolution. A `typedMock` import placed after it left the
// factory closing over a binding not yet initialized - "Cannot access
// '__vi_import_N__' before initialization" (see holderClearance3d.wo278.test.ts).
import { typedMock } from '../support/typedMock'
import { OcctKernel } from 'occt-wasm'
import type { ShapeHandle } from 'occt-wasm'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'
import type { BodyHandle, FeatureVerdict, StableId } from '../../geom/geom-service.ts'

// A hoisted seam: when `impl` is set, the mocked `healRemoval` delegates to it;
// otherwise it calls the real implementation (so control tests exercise the real
// heal path unchanged).
type HealRemoval = typeof import('../../geom/worker/defeature.ts')['healRemoval']
const seam = vi.hoisted(() => ({ impl: null as null | HealRemoval }))
vi.mock('../../geom/worker/defeature.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../geom/worker/defeature.ts')>()
  return typedMock<typeof import('../../geom/worker/defeature.ts')>({
    ...actual,
    healRemoval: (...args) => (seam.impl ?? actual.healRemoval)(...args),
  })
})

const BOX = { x: 60, y: 30, z: 12 }
const TOP: StableId = 'F1:BOX:zMax' as StableId

/** drill one hole into the box top and return the holed body + recognized hole. */
async function holedBox(
  engine: GeomEngine,
  style: Parameters<GeomEngine['makeHole']>[0]['style'],
  depth: Parameters<GeomEngine['makeHole']>[0]['depth'],
  cls: FeatureVerdict['featureClass'][],
): Promise<{ body: BodyHandle; hole: FeatureVerdict }> {
  const b0 = (await engine.makeBox('F1', BOX)).body!
  const drill = await engine.makeHole({ featureId: 'H', body: b0, face: TOP, points: [{ x: 30, y: 15, z: 12 }], style, depth })
  const b = drill.body!
  const verdicts = await engine.recognizeFeatures(b)
  const hole = verdicts.find((v) => cls.includes(v.featureClass))!
  return { body: b, hole }
}

describe('GEO-11-R2 every HealResult consumer fail-closes on a non-finite success (real occt-wasm kernel)', () => {
  let engine: GeomEngine
  beforeAll(async () => { engine = new GeomEngine(); await engine.init() }, 60_000)
  afterAll(async () => { await engine.disposeKernel() })
  // each test sets its own seam; clear it after so control tests use the real heal.
  const clear = () => { seam.impl = null; vi.restoreAllMocks() }

  // ================= consumer 1: editFeature holeDiameter =====================

  it('#hd-inf: holeDiameter REFUSES a heal success carrying an Infinity volumeDelta — no body minted', async () => {
    const { body, hole } = await holedBox(engine, { kind: 'simple', diameter: 6 }, { kind: 'throughAll' }, ['throughHole'])
    // the auditor's injection: a "successful" heal with a poisoned delta.
    seam.impl = (_k, shape) => ({ ok: true, shape, volumeDelta: Infinity })
    const r = await engine.editFeature({ featureId: 'E1', body, featureKey: hole.featureKey, delta: 2, kind: 'holeDiameter' })
    expect(r.ok, 'a non-finite heal delta must NOT mint an edited body').toBe(false)
    expect(r.body, 'no body handle is returned on refusal (no body minted)').toBeUndefined()
    expect(JSON.stringify(r.diagnostics ?? []), 'the refusal names the non-finite delta at the consumer boundary').toMatch(/non-finite volumeDelta|Infinity/i)
    clear()
  }, 120_000)

  it('#hd-ok: holeDiameter still succeeds on a real (finite) heal — the gate is non-vacuous', async () => {
    seam.impl = null
    const { body, hole } = await holedBox(engine, { kind: 'simple', diameter: 6 }, { kind: 'throughAll' }, ['throughHole'])
    const r = await engine.editFeature({ featureId: 'E2', body, featureKey: hole.featureKey, delta: 2, kind: 'holeDiameter' })
    expect(r.ok, 'a finite real heal still edits the hole').toBe(true)
    expect(r.body, 'a body handle is minted on success').toBeDefined()
    clear()
  }, 120_000)

  // ================= consumer 2: defeatureBatch (both branches) ===============

  it('#df-item-inf: defeatureBatch REFUSES a per-item heal success with an Infinity delta — no body minted', async () => {
    const { body, hole } = await holedBox(engine, { kind: 'simple', diameter: 6 }, { kind: 'blind', distance: 4 }, ['blindHole'])
    seam.impl = (_k, shape) => ({ ok: true, shape, volumeDelta: Infinity })
    const r = await engine.defeatureBatch({ featureId: 'DF', body, featureKeys: [hole.featureKey] })
    expect(r.ok, 'a non-finite per-item delta must NOT heal the batch').toBe(false)
    expect(r.body, 'no body handle is returned on refusal').toBeUndefined()
    const item = r.report?.items.find((i) => i.featureKey === hole.featureKey)
    expect(item?.healed, 'the poisoned item is counted a failure, not a heal').toBe(false)
    expect(item?.reason, 'the item refusal names the non-finite delta at the consumer boundary').toMatch(/non-finite volumeDelta|Infinity/i)
    clear()
  }, 120_000)

  it('#df-total-inf: defeatureBatch REFUSES when the running-total volume is non-finite — no body minted', async () => {
    const { body, hole } = await holedBox(engine, { kind: 'simple', diameter: 6 }, { kind: 'blind', distance: 4 }, ['blindHole'])
    // the item passes the per-item finite gate (finite delta) BUT the healed body's
    // volume reads non-finite at the running-total boundary. Return a real copy as
    // the healed shape and poison getVolume for exactly that handle.
    const realGetVolume = OcctKernel.prototype.getVolume
    const poison = { handle: -1 as number }
    seam.impl = (k, shape) => {
      const copy = (k as OcctKernel).copy(shape as ShapeHandle)
      poison.handle = copy as number
      return { ok: true, shape: copy, volumeDelta: 42 }
    }
    vi.spyOn(OcctKernel.prototype, 'getVolume').mockImplementation(function (this: OcctKernel, h: ShapeHandle) {
      return (h as number) === poison.handle ? Infinity : realGetVolume.call(this, h)
    })
    const r = await engine.defeatureBatch({ featureId: 'DF2', body, featureKeys: [hole.featureKey] })
    expect(r.ok, 'a non-finite running-total volume must NOT mint a body').toBe(false)
    expect(r.body, 'no body handle is returned on refusal').toBeUndefined()
    expect(JSON.stringify(r.diagnostics ?? []), 'the refusal names the non-finite volume at the consumer boundary').toMatch(/non-finite volume|Infinity/i)
    clear()
  }, 120_000)

  it('#df-ok: defeatureBatch still heals on a real (finite) heal — the gates are non-vacuous', async () => {
    seam.impl = null
    const { body, hole } = await holedBox(engine, { kind: 'simple', diameter: 6 }, { kind: 'blind', distance: 4 }, ['blindHole'])
    const r = await engine.defeatureBatch({ featureId: 'DF3', body, featureKeys: [hole.featureKey] })
    expect(r.ok, 'a finite real heal still defeatures the hole').toBe(true)
    expect(r.report?.healed, 'the hole healed').toBe(1)
    expect(Number.isFinite(r.report?.totalVolumeDelta), 'a finite total delta').toBe(true)
    clear()
  }, 120_000)
})
