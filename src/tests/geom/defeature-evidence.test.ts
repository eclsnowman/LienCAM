// GEO-6 real-app VISUAL EVIDENCE generator (criterion 7). Drives the SAME
// engine defeature path as the app, on a REAL vendor STEP, and renders kernel
// hidden-line multiview SVGs + exports before/after STEP to
// coordination/evidence/GEO-6/. The SVGs are kernel-rendered (not swiftshader —
// occt hidden-line removal, GPU-independent), so they are reproducible visual
// proof of the before/after geometry. File writes are gated behind
// GEO6_EVIDENCE=1 so the normal suite run stays read-only; the heal ASSERTIONS
// always run (this doubles as an integration test of the visual pipeline).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { OcctKernel } from 'occt-wasm'
import type { ShapeHandle } from 'occt-wasm'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { recognizeFeatures, healRemoval, gatherFaces, releaseFaceRecs, HM } from '../../geom/worker/defeature.ts'

const FIX = join(process.cwd(), 'src/tests/geom/fixtures')
const OUT = join(process.cwd(), 'test_fixtures/evidence/GEO-6')
const WRITE = process.env.GEO6_EVIDENCE === '1'

function write(name: string, data: string): void {
  if (!WRITE) return
  mkdirSync(OUT, { recursive: true })
  writeFileSync(join(OUT, name), data)
}
function loadStep(k: OcctKernel, name: string): ShapeHandle {
  const buf = readFileSync(join(FIX, name))
  return k.importStep(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
}

describe('GEO-6 real-app visual evidence', () => {
  let k: OcctKernel
  const report: Record<string, unknown> = { wo: 'GEO-6', generatedFrom: 'src/tests/geom/defeature-evidence.test.ts' }
  beforeAll(async () => { k = await OcctKernel.init() }, 60_000)
  afterAll(() => {
    write('capture-report.json', JSON.stringify(report, null, 2) + '\n')
    try { k[Symbol.dispose]() } catch { /* */ }
  })

  it('real 87-face plate: hole-batch removal, before/after multiview SVG + STEP', () => {
    const shape = loadStep(k, 'step-test-with-holes.step')
    const volBefore = k.getVolume(shape)
    write('01-plate-before.svg', k.toMultiviewSVG(shape))
    write('01-plate-before.step', k.exportStep(shape))

    const recs = gatherFaces(k, shape)
    const feats = recognizeFeatures(k, shape, recs)
    const holes = feats.filter((f) => f.removable && (f.type === 'throughHole' || f.type === 'blindHole' || f.type === 'counterboreStack'))
    const scratch: ShapeHandle[] = []
    const heal = healRemoval(k, shape, holes, scratch, recs)
    expect(heal.ok).toBe(true)
    const healed = heal.shape!
    write('02-plate-after-holes-removed.svg', k.toMultiviewSVG(healed))
    write('02-plate-after-holes-removed.step', k.exportStep(healed))
    report.plate = {
      part: 'step-test-with-holes.step', facesBefore: recs.length,
      holesRemoved: holes.length, pocketPreserved: feats.some((f) => f.type === 'pocket'),
      volumeBefore: round(volBefore), volumeAfter: round(k.getVolume(healed)),
      volumeDelta: heal.volumeDelta, watertightSolid: k.isValid(healed) && k.isSolid(healed),
      facesAfter: heal.faceCount,
    }
    for (const s of scratch) if (s !== healed) { try { k.release(s) } catch { /* */ } }
    try { k.release(healed) } catch { /* */ }
    releaseFaceRecs(k, recs)
    try { k.release(shape) } catch { /* */ }
  }, 120_000)

  it('synthetic fillet band removal, before/after multiview SVG (planar-neighbour class)', () => {
    const box = k.makeBox(40, 20, 10)
    const edges = k.getSubShapes(box, 'edge')
    let target: ShapeHandle | null = null
    for (const e of edges) {
      const vs = k.getSubShapes(e, 'vertex')
      if (vs.length === 2) {
        const a = k.vertexPosition(vs[0]), b = k.vertexPosition(vs[1])
        if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6 && Math.abs(a.z - b.z) > 1e-6 && Math.abs(a.x - 40) < 1e-6 && Math.abs(a.y - 20) < 1e-6) target = e
      }
      for (const v of vs) { try { k.release(v) } catch { /* */ } }
    }
    const evo = k.filletWithHistory(box, [target!], 3, [], HM)
    const filleted = evo.result
    for (const e of edges) { try { k.release(e) } catch { /* */ } }
    try { k.release(box) } catch { /* */ }
    write('03-fillet-before.svg', k.toMultiviewSVG(filleted))

    const recs = gatherFaces(k, filleted)
    const feats = recognizeFeatures(k, filleted, recs)
    const fillet = feats.filter((f) => f.type === 'filletPlanar' && f.removable)
    const scratch: ShapeHandle[] = []
    const heal = healRemoval(k, filleted, fillet, scratch, recs)
    expect(heal.ok).toBe(true)
    write('04-fillet-after-removed.svg', k.toMultiviewSVG(heal.shape!))
    report.fillet = { class: 'filletPlanar', volumeBefore: round(k.getVolume(filleted)), volumeAfter: round(k.getVolume(heal.shape!)), volumeDelta: heal.volumeDelta }
    for (const s of scratch) if (s !== heal.shape) { try { k.release(s) } catch { /* */ } }
    try { k.release(heal.shape!) } catch { /* */ }
    releaseFaceRecs(k, recs)
    try { k.release(filleted) } catch { /* */ }
  }, 60_000)
})

function round(v: number): number { return Math.round(v * 1000) / 1000 }
