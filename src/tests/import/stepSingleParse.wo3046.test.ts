// WO-3046: STEP import reads the file once.
// CAM Import geometry gets its part name/colour from the geom reader's
// names-only read (readStepAttributes), never from a second full importStep,
// and that read hands back exactly what importStep's bodies carried.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { beforeAll, describe, it, expect } from 'vitest'
import { createLocalGeomService, type GeomClient } from '../../geom'
import { GeomEngine } from '../../geom/worker/geom-engine'
import { readStepDisplayAttributes } from '../../lib/import/stepAttributes'
import { loadOcctModel, _resetOcctModelForTest, type OcctModelModule } from '../../lib/cam/geometry/occt/model/loader'
import { readStepShape, indexSubshapes } from '../../lib/cam/geometry/occt/model/core'
import type { TopoDS_Shape } from '../../lib/cam/geometry/occt/model/vendor/occt-model.js'

const HERE = dirname(fileURLToPath(import.meta.url))
// The emscripten occt-model glue expects CommonJS globals in Node.
;(globalThis as Record<string, unknown>).require ??= createRequire(import.meta.url)
;(globalThis as Record<string, unknown>).__dirname ??= HERE
;(globalThis as Record<string, unknown>).__filename ??= fileURLToPath(import.meta.url)
const ROOT = join(HERE, '..', '..', '..')
const FILES = [
  'src/tests/geom/fixtures/tray.step',
  'src/tests/geom/fixtures/plate-holes.step',
  'src/tests/geom/fixtures/no-attributes.step',
  'Sample Parts/Workbench Part.step',
  'test_fixtures/brep/fix_two_solids.step',
]
function bytes(rel: string): ArrayBuffer {
  const buf = readFileSync(join(ROOT, rel))
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}

/** The real local geom service, with every importStep call counted. */
function countingService(): { calls: { importStep: number }; factory: () => GeomClient } {
  const calls = { importStep: 0 }
  const factory = () => {
    const svc = createLocalGeomService()
    return {
      ...svc,
      importStep: (b: ArrayBuffer, id: string) => { calls.importStep++; return svc.importStep(b, id) },
    } as GeomClient
  }
  return { calls, factory }
}

describe('WO-3046 CAM Import geometry: no second full STEP import for the name', () => {
  it('readStepDisplayAttributes runs no full importStep and still reads "Part 1" from tray.step', async () => {
    const { calls, factory } = countingService()
    const out = await readStepDisplayAttributes(bytes(FILES[0]), 'IMP1', factory)
    expect(calls.importStep, 'full importStep calls during the attribute read').toBe(0)
    expect(out).toEqual({ name: 'Part 1', color: undefined, partCount: 1, warning: undefined })
  }, 60_000)
})

describe('WO-3046 names-only read is identical to importStep', () => {
  it.each(FILES)('%s: same per-body name/colour and diagnostics', async (rel) => {
    const engine = new GeomEngine({ stepImportCache: false })
    await engine.init()
    try {
      const full = await engine.importStep(bytes(rel), 'IMP7')
      const expected = full.bodies.map((b) => ({ name: b.name, color: b.color }))
      for (const b of full.bodies) await engine.dispose(b.handle)
      const quick = await engine.readStepAttributes(bytes(rel), 'IMP7')
      expect(quick.parts).toEqual(expected)
      expect(quick.diagnostics).toEqual(full.diagnostics)
    } finally {
      await engine.disposeKernel()
    }
  }, 60_000)
})

// ---- Item 6: occt-model heal skipped only when BRepCheck_Analyzer finds the shape valid ----

const MODEL_WASM = join(ROOT, 'src/lib/cam/geometry/occt/model/vendor/occt-model.wasm')
const HEAL_FILES = [
  'Sample Parts/Tray.step',
  'Sample Parts/Workbench Part.step',
  'test_fixtures/brep/fix_freeform.step',
  'test_fixtures/brep/fix_two_solids.step',
  'src/tests/model3d/fixtures/wo1455/open-shell-30x20x10.step',
]

/** The real occt-model module with ShapeFix_Shape_2 counted and, when given,
 *  a stand-in BRepCheck_Analyzer that answers `verdict` (WO-3047's rebuild binds
 *  the real one). */
function modelWith(oc: OcctModelModule, verdict?: boolean | 'throws') {
  const counts = { shapeFix: 0, analyzer: 0 }
  const Real = oc.ShapeFix_Shape_2
  const wrapped = Object.create(oc) as OcctModelModule & Record<string, unknown>
  wrapped.ShapeFix_Shape_2 = function (s: unknown) {
    counts.shapeFix++
    return new Real(s as never)
  } as unknown as typeof Real
  if (verdict !== undefined) {
    ;(wrapped as Record<string, unknown>).BRepCheck_Analyzer = function () {
      counts.analyzer++
      if (verdict === 'throws') throw new Error('analyzer failed')
      return { IsValid_1: () => verdict, delete: () => {} }
    }
  }
  return { wrapped, counts }
}

/** Face/edge/solid counts, volume and bbox: the shape identity the order measures. */
function shapeFacts(oc: OcctModelModule, shape: TopoDS_Shape) {
  const { faces, edges } = indexSubshapes(oc, shape)
  const facts = { faces: faces.length, edges: edges.length, volume: 0, bbox: [] as number[] }
  for (const f of [...faces, ...edges]) f.delete()
  const props = new oc.GProp_GProps_1()
  oc.BRepGProp.VolumeProperties_1(shape, props, true, false, false)
  facts.volume = props.Mass()
  props.delete()
  const box = new oc.Bnd_Box_1()
  oc.BRepBndLib.Add(shape, box, false)
  const lo = box.CornerMin()
  const hi = box.CornerMax()
  facts.bbox = [lo.X(), lo.Y(), lo.Z(), hi.X(), hi.Y(), hi.Z()]
  lo.delete(); hi.delete(); box.delete()
  return facts
}

function readFacts(oc: OcctModelModule, rel: string) {
  const { shape, solidCount } = readStepShape(oc, bytes(rel), rel)
  try { return { solidCount, ...shapeFacts(oc, shape) } } finally { shape.delete() }
}

describe('WO-3046 occt-model heal skip', () => {
  let oc: OcctModelModule
  beforeAll(async () => {
    _resetOcctModelForTest()
    oc = await loadOcctModel({ wasmBinary: readFileSync(MODEL_WASM) })
  }, 120_000)

  it('a build without the BRepCheck binding heals every shape exactly as before', () => {
    const { wrapped, counts } = modelWith(oc)
    // WO-3047's rebuild binds BRepCheck_Analyzer: remove it to pin the no-binding route.
    ;(wrapped as Record<string, unknown>).BRepCheck_Analyzer = undefined
    for (const rel of HEAL_FILES) readStepShape(wrapped, bytes(rel), rel).shape.delete()
    expect(counts.shapeFix).toBe(HEAL_FILES.length)
  }, 120_000)

  it('the real rebuilt build (WO-3047) skips ShapeFix on a valid shape', () => {
    const { wrapped, counts } = modelWith(oc)
    readStepShape(wrapped, bytes(HEAL_FILES[1]), HEAL_FILES[1]).shape.delete()
    expect(counts.shapeFix).toBe(0)
  }, 120_000)

  it.each(HEAL_FILES)('%s: a valid verdict skips ShapeFix and the shape facts are identical', (rel) => {
    const healed = readFacts(modelWith(oc).wrapped, rel)
    const { wrapped, counts } = modelWith(oc, true)
    const skipped = readFacts(wrapped, rel)
    expect(counts.shapeFix, 'ShapeFix_Shape runs on a shape BRepCheck calls valid').toBe(0)
    expect(counts.analyzer).toBe(1)
    expect(skipped).toEqual(healed)
  }, 120_000)

  it.each([false, 'throws'] as const)('verdict %s: ShapeFix still runs (an invalid or unchecked shape heals)', (verdict) => {
    const rel = 'src/tests/model3d/fixtures/wo1455/open-shell-30x20x10.step'
    const { wrapped, counts } = modelWith(oc, verdict)
    const facts = readFacts(wrapped, rel)
    expect(counts.shapeFix).toBe(1)
    expect(facts).toEqual(readFacts(modelWith(oc).wrapped, rel))
  }, 120_000)
})

describe('WO-3046 committed timing evidence (src/tests/evidence/WO-3046/timing.json)', () => {
  it('records a faster attribute read and a faster skipped heal, with identical attributes', () => {
    const t = JSON.parse(readFileSync(join(ROOT, 'src/tests/evidence/WO-3046/timing.json'), 'utf8'))
    const tray = t.rows.find((r: { file: string }) => r.file === 'Tray.step')
    expect(tray.sameAttributes).toBe(true)
    expect(tray.newMs).toBeLessThan(tray.oldMs)
    const heal = t.heal.find((r: { file: string }) => r.file === 'Tray.step')
    expect(heal.readHealSkippedMs).toBeLessThan(heal.readAndHealMs)
  })
})
