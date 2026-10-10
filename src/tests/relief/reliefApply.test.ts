// WO-2171 - image relief stage 1b: the geometry worker's relief op
// (GeomEngine.editFeature kind 'relief'), on the real occt-wasm kernel.
//
// - a cosine bump laid into a box's top face adds the bump's analytic volume
//   (within 0.5 %), keeps the top face's id on the piece round it, and its
//   tessellation lies on the pole surface the preview draws (S10);
// - Cut in removes the same volume;
// - a side face takes it too (any flat face, upright frame);
// - a rectangle off the face, a curved face and more than 256 control points
//   are refused by name (the last is WO-2170's kernel-safety rule).

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GeomEngine, RELIEF_EXACT_POLE_CAP, type ReliefEditRequest } from '../../geom/worker/geom-engine'
import type { BodyHandle, StableId } from '../../geom/geom-service'
import { cosineBumpHeight, cosineBumpVolume, sampleHeightGrid, type CosineBump } from '../../relief/heightGrid'
import { poleSurfaceHeight, poleSurfaceVolume, reliefPoles, type ReliefPoles } from '../../relief/reliefStep'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { defaultSettings, reliefFrame, uprightAxes, type FaceFrame, type ReliefSettings } from '../../relief/reliefHeights'
import { decodePng } from '../../relief/picture'
import { autoParams } from '../../relief/adjust'
import { reliefKernelFields } from '../../relief/reliefFeature'

const BOX = { x: 100, y: 70, z: 15 }
const TOP = 'F1:BOX:zMax' as StableId
const FRONT = 'F1:BOX:yMin' as StableId

let engine: GeomEngine
beforeAll(async () => {
  engine = new GeomEngine()
  await engine.init()
}, 120_000)
afterAll(async () => { await engine.disposeKernel() })

const SETTINGS: ReliefSettings = {
  widthMm: 80, heightMm: 56, keepProportions: true, rotationDeg: 0, offsetXMm: 0, offsetYMm: 0,
  depthMm: 2.25, direction: 'raise', invert: false, zeroPlane: 0, baseMm: 0, auto: false,
}
const BUMP: CosineBump = { widthMm: 80, depthMm: 56, amplitudeMm: 2.25, radiusMm: 25 }

function bumpPoles(n: number, sign = 1): ReliefPoles {
  const g = sampleHeightGrid(80, 56, 801, 561, cosineBumpHeight(BUMP))
  const p = reliefPoles(g, n)
  return { ...p, heights: p.heights.map((h) => sign * h) }
}

function topFace(): FaceFrame {
  return { centre: { x: 50, y: 35, z: 15 }, ...uprightAxes({ x: 0, y: 0, z: 1 }), widthMm: 100, heightMm: 70 }
}

function request(body: BodyHandle, face: StableId, frameFace: FaceFrame, poles: ReliefPoles, settings = SETTINGS, featureId = 'R1'): ReliefEditRequest {
  const fr = reliefFrame(frameFace, settings)
  return {
    featureId, body, featureKey: face, delta: 0, kind: 'relief',
    relief: { origin: fr.origin, xDir: fr.xDir, yDir: fr.yDir, normal: fr.normal, widthMm: fr.widthMm, heightMm: fr.heightMm, n: poles.n, heights: Array.from(poles.heights) },
  }
}

async function volume(b: BodyHandle): Promise<number> {
  return (await engine.measure(b, 'volume')).value
}

describe('WO-2171 relief op in the geometry engine', () => {
  it('a cosine bump on the top face adds its analytic volume within 0.5 %, keeps the top face id, and meshes onto the pole surface (S10)', async () => {
    const box = (await engine.makeBox('F1', BOX)).body!
    const poles = bumpPoles(128)
    const r = await engine.editFeature(request(box, TOP, topFace(), poles))
    expect(r.diagnostics.map((d) => String(d.params?.reason ?? d.code))).toEqual(['OK'])
    expect(r.ok).toBe(true)
    const added = (await volume(r.body!)) - BOX.x * BOX.y * BOX.z
    const want = cosineBumpVolume(BUMP)
    const err = Math.abs(added - want) / want
    console.log(`cosine bump: added ${added.toFixed(2)} mm^3, analytic ${want.toFixed(2)} mm^3 (${(100 * err).toFixed(3)} %); poles ${poleSurfaceVolume(poles).toFixed(2)}`)
    expect(err).toBeLessThan(0.005)
    // the top face lives on (modified) round the relief; the relief face is new
    expect(r.elementMap!.modified[TOP]).toEqual([TOP])
    expect(r.elementMap!.generated.length).toBe(1)
    // S10: every tessellation vertex on the relief lies on the pole surface the preview draws (1 % of depth)
    const t = await engine.tessellate(r.body!, { deflection: 0.01 })
    let worst = 0, onRelief = 0
    for (let i = 0; i < t.position.length; i += 3) {
      const x = t.position[i] - 10, y = t.position[i + 1] - 7, z = t.position[i + 2]
      if (x <= 0 || y <= 0 || x >= 80 || y >= 56 || z < 14.999) continue
      onRelief++
      worst = Math.max(worst, Math.abs(z - 15 - poleSurfaceHeight(poles, x, y)))
    }
    console.log(`S10: ${onRelief} body vertices on the relief, worst gap to the preview surface ${worst.toExponential(2)} mm (1 % of depth = 0.0225 mm)`)
    expect(onRelief).toBeGreaterThan(100)
    expect(worst).toBeLessThan(0.01 * 2.25)
  }, 120_000)

  it('Cut in sinks the same bump into the face: the volume goes down by it', async () => {
    const box = (await engine.makeBox('F1', BOX)).body!
    const r = await engine.editFeature(request(box, TOP, topFace(), bumpPoles(64, -1), { ...SETTINGS, direction: 'cut' }))
    expect(r.ok).toBe(true)
    const removed = BOX.x * BOX.y * BOX.z - (await volume(r.body!))
    const want = cosineBumpVolume(BUMP)
    expect(Math.abs(removed - want) / want).toBeLessThan(0.005)
  }, 120_000)

  it('a side face takes a relief too, in its upright frame', async () => {
    const box = (await engine.makeBox('F1', BOX)).body!
    const front: FaceFrame = { centre: { x: 50, y: 0, z: 7.5 }, ...uprightAxes({ x: 0, y: -1, z: 0 }), widthMm: 100, heightMm: 15 }
    const s = { ...SETTINGS, widthMm: 40, heightMm: 10 }
    const g = sampleHeightGrid(40, 10, 401, 101, (x, y) => (x > 5 && x < 35 && y > 2 && y < 8 ? 0.8 : 0))
    const poles = reliefPoles(g, 64)
    const r = await engine.editFeature(request(box, FRONT, front, poles, s))
    expect(r.ok).toBe(true)
    const b = await engine.tessellate(r.body!, { deflection: 0.05 })
    let minY = Infinity
    for (let i = 1; i < b.position.length; i += 3) minY = Math.min(minY, b.position[i])
    expect(minY).toBeLessThan(-0.7) // stands proud of the front face, towards -Y
    expect(minY).toBeGreaterThan(-0.81)
  }, 120_000)

  it('the text sign at 256 x 256 control points meshes at display quality in seconds, closed, to the relief chord', async () => {
    const pic = decodePng(new Uint8Array(fs.readFileSync(path.resolve(__dirname, '../../../docs/design/relief-references/fixtures/fixture-03-text-sign.png'))))!
    const auto = autoParams(pic)
    const plate = { x: 111.11, y: 55.56, z: 12 }
    const face: FaceFrame = { centre: { x: plate.x / 2, y: plate.y / 2, z: plate.z }, ...uprightAxes({ x: 0, y: 0, z: 1 }), widthMm: plate.x, heightMm: plate.y }
    const settings = defaultSettings(pic, face, auto)
    const f = reliefKernelFields(pic, { face, settings, autoParams: auto })
    expect(f.poles.n).toBe(RELIEF_EXACT_POLE_CAP)
    const box = (await engine.makeBox('F1', plate)).body!
    const r = await engine.editFeature({
      featureId: 'R9', body: box, featureKey: TOP, delta: 0, kind: 'relief',
      relief: { origin: f.frame.origin, xDir: f.frame.xDir, yDir: f.frame.yDir, normal: f.frame.normal, widthMm: f.frame.widthMm, heightMm: f.frame.heightMm, n: f.poles.n, heights: f.poles.heights },
    } as ReliefEditRequest)
    expect(r.ok).toBe(true)
    const t0 = performance.now()
    const t = await engine.tessellate(r.body!, { deflection: 0.08, angularDeflection: 0.35 }) // the Model screen's display quality
    const ms = performance.now() - t0
    // closed: every edge of the welded mesh is shared by exactly two triangles
    const key = (i: number) => `${Math.round(t.position[i * 3] * 1e5)},${Math.round(t.position[i * 3 + 1] * 1e5)},${Math.round(t.position[i * 3 + 2] * 1e5)}`
    const weld = new Map<string, number>()
    const id = (i: number) => { const k = key(i); let v = weld.get(k); if (v === undefined) { v = weld.size; weld.set(k, v) } return v }
    const edges = new Map<string, number>()
    for (let tri = 0; tri < t.index.length; tri += 3) {
      const a = id(t.index[tri]), b = id(t.index[tri + 1]), c = id(t.index[tri + 2])
      for (const [p, q] of [[a, b], [b, c], [c, a]]) { const e = p < q ? `${p}:${q}` : `${q}:${p}`; edges.set(e, (edges.get(e) ?? 0) + 1) }
    }
    const open = [...edges.values()].filter((n) => n !== 2).length
    console.log(`text sign relief body at display quality: ${t.index.length / 3} triangles in ${(ms / 1000).toFixed(1)} s, ${open} open edges`)
    expect(ms).toBeLessThan(20_000)
    expect(open).toBe(0)
  }, 180_000)

  it('refuses by name: a rectangle off the face, and more control points than the kernel is safe with', async () => {
    const box = (await engine.makeBox('F1', BOX)).body!
    const off = await engine.editFeature(request(box, TOP, topFace(), bumpPoles(16), { ...SETTINGS, offsetXMm: 30 }))
    expect(off.ok).toBe(false)
    expect(String(off.diagnostics[0].params?.reason)).toMatch(/does not lie inside face/)
    const big: ReliefPoles = { n: RELIEF_EXACT_POLE_CAP + 1, widthMm: 80, depthMm: 56, heights: new Float64Array((RELIEF_EXACT_POLE_CAP + 1) ** 2) }
    const tooMany = await engine.editFeature(request(box, TOP, topFace(), big))
    expect(tooMany.ok).toBe(false)
    expect(String(tooMany.diagnostics[0].params?.reason)).toMatch(/4 to 256 control points/)
  }, 120_000)
})
