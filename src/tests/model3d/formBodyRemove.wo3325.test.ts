// WO-3325: Extrude Remove on a Form body. Operator report (10-30): "on a model with
// a form tool, new body from a sketch works, cut/remove does not seem to work."
// The preview sat on "Updating preview..." and Apply waited behind it.
//
// Measured: the cut itself is ~0.25 s on the shipped kernel, but the engine
// boxed every face of the Form body again - each B-spline face ~0.5 s - when
// the preview restored the target (~4.3 s), and again for every face of each
// cut result (~6.5 s per cut: once for the preview, once more for Apply).
// The engine now remembers a free-form face's box under its geometry, so
// what the preview already boxed is not boxed again.
//
// Route: the real occt-wasm engine (GeomEngine) for the kernel requests the
// Model page's preview and Apply make (restoreBody of the target, makeExtrude
// op 'cut'), and the production background replay (documentHolder ->
// modelBodyHoleRecognition -> headlessFeatureReplay) for save-and-reopen.
//
// Measured against: the kernel's own Intersect of the same tool and body - a
// Remove takes away exactly the overlap - and the cold-engine results.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { OcctKernel, type ShapeHandle } from 'occt-wasm'
import { GeomEngine } from '../../geom/worker/geom-engine'
import { createLocalGeomService, type GeomClient } from '../../geom'
import type { BodyHandle, ExtrudeRequest, OpResult, ProfileRegion } from '../../geom/geom-service'
import { boxCage } from '../../form/starters'
import { formStep } from '../../form/exactStep'
import { buildFormBody, makeFormFeaturePayload } from '../../form/formBody'
import { DISPLAY_TESS_QUALITY } from '../../viewport3d/tessQuality'
import { resetDocumentHolder, stashLoadedDocument } from '../../doc/documentHolder'
import { BASE_PLANE_XY_NODE_ID } from '../../doc/genesis'
import { finalizeSeedArchive, newSeededModelDag } from '../../doc/seedModelArchive'
import type { Sketch, SketchEntity } from '../../lib/sketch/sketcher'
import { __setModelBodyHeadlessClientFactoryForTests, resolveModelReferencesHeadless } from '../../lib/cam/modelBodyHoleRecognition'

// Every kernel box of free-form geometry (a B-spline face, or a solid that has
// one) that runs the full surface analysis - ~0.5 s a Form face - is counted. A
// face's box refined from the mesh it carries (useTriangulation) is quick and
// is not.
const ANALYTIC = new Set(['plane', 'cylinder', 'cone', 'sphere', 'torus'])
type Box = { xmin: number; ymin: number; zmin: number; xmax: number; ymax: number; zmax: number }
const proto = OcctKernel.prototype as unknown as { getBoundingBox: (shape: ShapeHandle, useTriangulation: boolean) => Box }
const kernelBox = proto.getBoundingBox
let freeFormBoxes = 0
proto.getBoundingBox = function (this: OcctKernel, shape: ShapeHandle, useTriangulation: boolean) {
  const isFace = this.getShapeType(shape) === 'face'
  const faces = isFace ? [shape] : this.getSubShapes(shape, 'face')
  if (faces.some((f) => !ANALYTIC.has(this.surfaceType(f)) && !(useTriangulation && this.hasTriangulation(f)))) freeFormBoxes += 1
  if (!isFace) for (const f of faces) this.release(f)
  return kernelBox.call(this, shape, useTriangulation)
}

// The reported picture: a rectangle on XY under one side of the form, extruded Up 15 mm.
const PLANE_XY = { origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 }, xDir: { x: 1, y: 0, z: 0 } }
const RECT: Array<[number, number]> = [[5, -30], [40, -30], [40, 5], [5, 5]]
const profile: ProfileRegion = {
  sketchId: 'SK1',
  plane: PLANE_XY,
  loops: [RECT.map((a, i) => ({ kind: 'line' as const, a, b: RECT[(i + 1) % 4], srcId: `L${i}` }))],
}
const extrude = (op: ExtrudeRequest['op'], target?: BodyHandle, featureId = 'EXT1'): ExtrudeRequest => ({
  featureId, profiles: [profile], end: { kind: 'blind', distance: 15 }, op, ...(target === undefined ? {} : { target }),
})
const FORM = makeFormFeaturePayload('Form 1', boxCage())

async function volume(engine: GeomClient | GeomEngine, h: BodyHandle | undefined): Promise<number> {
  expect(h).toBeDefined()
  return (await engine.measure(h!, 'volume')).value
}

describe('WO-3325 Extrude Remove on a Form body (real occt-wasm)', () => {
  let engine: GeomEngine
  let form: OpResult
  let formVolume: number
  let overlap: number
  beforeAll(async () => {
    engine = new GeomEngine()
    await engine.init()
    form = await buildFormBody(engine, FORM, 'FRM1')
    expect(form.ok).toBe(true)
    expect(form.diagnostics.at(-1)?.params?.surface).toBe('exact')
    formVolume = await volume(engine, form.body)
    const common = await engine.makeExtrude(extrude('intersect', form.body, 'OVERLAP'))
    expect(common.ok).toBe(true)
    overlap = await volume(engine, common.body)
    await engine.dispose(common.body!)
  }, 180_000)
  afterAll(async () => { await engine.disposeKernel() })

  it('Remove takes exactly the overlap out of the Form body; New body and Join still work', async () => {
    expect(overlap).toBeGreaterThan(1000)
    const cut = await engine.makeExtrude(extrude('cut', form.body))
    expect(cut.ok, JSON.stringify(cut.diagnostics)).toBe(true)
    expect(await volume(engine, cut.body)).toBeCloseTo(formVolume - overlap, 2)

    const box = await engine.makeExtrude(extrude('newBody'))
    expect(box.ok).toBe(true)
    expect(await volume(engine, box.body)).toBeCloseTo(35 * 35 * 15, 6)

    const join = await engine.makeExtrude(extrude('add', form.body))
    expect(join.ok).toBe(true)
    expect(await volume(engine, join.body)).toBeCloseTo(formVolume + 35 * 35 * 15 - overlap, 2)
    for (const r of [cut, box, join]) await engine.dispose(r.body!)
  }, 180_000)

  it('the preview restores the target and Apply cuts it again without boxing a Form face twice', async () => {
    await engine.tessellate(form.body!, DISPLAY_TESS_QUALITY)
    // the preview: a restored copy of the target, cut
    freeFormBoxes = 0
    const restored = await engine.restoreBody(await engine.serializeBody(form.body!), form.elementMap!)
    expect(freeFormBoxes, 'restoring the Form body boxed its faces again').toBe(0)
    const preview = await engine.makeExtrude(extrude('cut', restored))
    expect(preview.ok).toBe(true)
    // Apply: the same cut on the live target
    freeFormBoxes = 0
    const applied = await engine.makeExtrude(extrude('cut', form.body))
    expect(freeFormBoxes, 'Apply boxed again the faces the preview already boxed').toBe(0)
    expect(applied.ok).toBe(true)
    expect(await volume(engine, applied.body)).toBeCloseTo(await volume(engine, preview.body), 6)
    for (const h of [restored, preview.body!, applied.body!]) await engine.dispose(h)
  }, 180_000)

  it('a remembered box is the kernel\'s own: the warm cut names every face as a cold engine does', async () => {
    const warm = await engine.makeExtrude(extrude('cut', form.body))
    const cold = new GeomEngine()
    await cold.init()
    try {
      const coldForm = await buildFormBody(cold, FORM, 'FRM1')
      // the warm body carries the display mesh, as on the Model page
      await cold.tessellate(coldForm.body!, DISPLAY_TESS_QUALITY)
      const coldCut = await cold.makeExtrude(extrude('cut', coldForm.body))
      expect(warm.elementMap).toEqual(coldCut.elementMap)
      const restored = await engine.restoreBody(await engine.serializeBody(warm.body!), warm.elementMap!)
      const coldRestored = await cold.restoreBody(await cold.serializeBody(coldCut.body!), coldCut.elementMap!)
      const ids = async (e: GeomEngine, h: BodyHandle) => (await e.tessellate(h, DISPLAY_TESS_QUALITY)).faceIds
      expect(await ids(engine, restored)).toEqual(await ids(cold, coldRestored))
      await engine.dispose(restored)
    } finally {
      await cold.disposeKernel()
      await engine.dispose(warm.body!)
    }
  }, 240_000)

  it('the kernel\'s box of a Form solid is the union of its face boxes', async () => {
    const k = await OcctKernel.init()
    try {
      const shape = k.importStep(formStep(FORM.cage, 'Form 1', 3).text)
      const faces = k.getSubShapes(shape, 'face')
      const whole = kernelBox.call(k, shape, false)
      const union = faces.map((f) => kernelBox.call(k, f, false)).reduce((a, b) => ({
        xmin: Math.min(a.xmin, b.xmin), ymin: Math.min(a.ymin, b.ymin), zmin: Math.min(a.zmin, b.zmin),
        xmax: Math.max(a.xmax, b.xmax), ymax: Math.max(a.ymax, b.ymax), zmax: Math.max(a.zmax, b.zmax),
      }))
      for (const key of Object.keys(whole) as Array<keyof Box>) expect(Math.abs(union[key] - whole[key])).toBeLessThan(1e-6)
    } finally {
      k[Symbol.dispose]()
    }
  }, 180_000)
})

describe('WO-3325 save and reopen: the background replay rebuilds the cut Form body', () => {
  afterEach(() => {
    __setModelBodyHeadlessClientFactoryForTests(null)
    resetDocumentHolder()
  })

  it('Form 1, a sketch on XY, Extrude Remove targeting Form 1 -> the cut body', async () => {
    const results = new Map<string, number>()
    __setModelBodyHeadlessClientFactoryForTests(() => {
      const client = createLocalGeomService()
      const makeExtrude = client.makeExtrude.bind(client)
      client.makeExtrude = async (req) => {
        const r = await makeExtrude(req)
        if (r.ok && r.body !== undefined) results.set(req.featureId, (await client.measure(r.body, 'volume')).value)
        return r
      }
      return client
    })
    const entities = RECT.map(([x, y], i) => ({
      id: `r${i}`, kind: 'line', construction: false, start: { x, y }, end: { x: RECT[(i + 1) % 4][0], y: RECT[(i + 1) % 4][1] },
    })) as SketchEntity[]
    const sketch = { id: 'S1', layerId: 'L1', entities, constraints: [], dimensions: [], solveStatus: null } as unknown as Sketch
    const dag = newSeededModelDag()
    dag.insertNode({ id: 'FRM1', kind: 'feature', consumes: [], refs: [], payload: { ...FORM } as unknown as Record<string, unknown> })
    dag.insertNode({ id: 'sketch3d:S1', kind: 'sketch', consumes: [BASE_PLANE_XY_NODE_ID], refs: [], payload: { sketch, planeNodeId: BASE_PLANE_XY_NODE_ID } })
    dag.insertNode({
      id: 'F1', kind: 'feature', consumes: ['sketch3d:S1', 'FRM1'], refs: [],
      payload: {
        opType: 'extrude', sketchId: 'sketch3d:S1', profileSelector: { kind: 'whole-sketch' }, distance: 15, direction: 'up',
        endCondition: 'blind', boolMode: 'remove', targetFeatureId: 'FRM1', name: 'Extrude F1',
      },
    })
    stashLoadedDocument(finalizeSeedArchive(dag))
    await resolveModelReferencesHeadless('legacy', new Map([['F1', []]]))
    const engine = new GeomEngine()
    await engine.init()
    try {
      const f = await buildFormBody(engine, FORM, 'FRM1')
      const expected = await volume(engine, (await engine.makeExtrude(extrude('cut', f.body))).body)
      expect(results.get('F1'), 'the reopened document rebuilt the Remove').toBeCloseTo(expected, 4)
    } finally {
      await engine.disposeKernel()
    }
  }, 240_000)
})
