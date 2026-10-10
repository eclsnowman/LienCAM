// WO-2200 - the mesh relief in the geometry engine, on the real occt-wasm kernel.
//
// A relief whose working grid needs more than 256 control points per side is a
// MESH relief: the body is still the exact face at 256 x 256 (WO-2170's cap,
// never above), and its relief face is meshed from the working grid at full
// detail - what the Model screen draws, CAM machines and STL exports.
//
// - the exact face is byte-identical with or without the working grid (the
//   text sign and the terrain at the standard's sizes): STEP is unchanged;
// - the mesh relief's face IS the working grid: every sample inside the
//   rectangle is a vertex of the body's mesh at its height, and the mesh is
//   closed;
// - a hole cut into the relief afterwards leaves that face to the kernel's own
//   mesh (the grid no longer describes it), and the body's mesh stays closed;
// - a relief that fits in 256 control points stays an exact relief;
// - build time and memory for the 2000 x 2000 picture (S9's) at 100 mm and at
//   the 2048 working-grid cap.

import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { OcctKernel } from 'occt-wasm'
import { GeomEngine, type ReliefEditRequest } from '../../geom/worker/geom-engine'
import type { BodyHandle, StableId, TessBuffers } from '../../geom/geom-service'
import { autoParams } from '../../relief/adjust'
import { capPicture, type Picture } from '../../relief/picture'
import { defaultSettings, isMeshRelief, uprightAxes, type FaceFrame, type ReliefSettings } from '../../relief/reliefHeights'
import { reliefKernelFields, reliefRowName, type ReliefKernelFields } from '../../relief/reliefFeature'
import { workingGridSize } from '../../relief/heightGrid'
import { sanitizeTriangleMesh } from '../../cam3d/input/sanitize'
import { DISPLAY_TESS_QUALITY } from '../../viewport3d/tessQuality'

const FIX = path.resolve(__dirname, '../../../docs/design/relief-references/fixtures')
const TOP = 'F1:BOX:zMax' as StableId

let engine: GeomEngine
let kernel: OcctKernel
beforeAll(async () => {
  engine = new GeomEngine()
  await engine.init()
  kernel = await OcctKernel.init()
}, 120_000)
afterAll(async () => { await engine.disposeKernel() })

async function load(file: string): Promise<Picture> {
  const sharp = (await import('sharp')).default
  const sixteen = file.includes('16bit')
  const { data, info } = await sharp(path.join(FIX, file)).greyscale().raw({ depth: sixteen ? 'ushort' : 'uchar' }).toBuffer({ resolveWithObject: true })
  const n = info.width * info.height
  const src = sixteen ? new Uint16Array(data.buffer, data.byteOffset, n) : data
  const grey = new Float32Array(n)
  for (let i = 0; i < n; i++) grey[i] = src[i] / (sixteen ? 65535 : 255)
  return capPicture({ cols: info.width, rows: info.height, grey, bitDepth: sixteen ? 16 : 8 })
}

/** A plate whose top face fits the picture to `placed` mm (the 5 % margin rule), and the settings a fresh open gives. */
function onPlate(pic: Picture, placed: [number, number], s: Partial<ReliefSettings> = {}, plateMm?: { x: number; y: number }) {
  const plate = { x: plateMm?.x ?? placed[0] / 0.9, y: plateMm?.y ?? placed[1] / 0.9, z: 12 }
  const face: FaceFrame = { centre: { x: plate.x / 2, y: plate.y / 2, z: plate.z }, ...uprightAxes({ x: 0, y: 0, z: 1 }), widthMm: plate.x, heightMm: plate.y }
  const auto = autoParams(pic)
  const settings = { ...defaultSettings(pic, face, auto), ...s }
  return { plate, face, auto, settings }
}

/** The request the Model screen sends (SolidsWorkbenchPage reliefKernelRequest). */
function request(body: BodyHandle, f: ReliefKernelFields, withDetail = true, featureId = 'R1'): ReliefEditRequest {
  return {
    featureId, body, featureKey: TOP, delta: 0, kind: 'relief',
    relief: {
      origin: f.frame.origin, xDir: f.frame.xDir, yDir: f.frame.yDir, normal: f.frame.normal, widthMm: f.frame.widthMm, heightMm: f.frame.heightMm, n: f.poles.n, heights: f.poles.heights,
      ...(withDetail && f.detail !== undefined ? { detail: { cols: f.detail.cols, rows: f.detail.rows, heights: f.detail.heights } } : {}),
    },
  }
}

/** The STEP data section: the header's time stamp and the exporter's running product number left out. */
function stepData(step: string): string {
  return step.slice(step.indexOf('\nDATA;')).replace(/STEP translator [\d.]+ \d+/g, 'STEP translator')
}

function closed(t: TessBuffers): { boundaryEdges: number; oversharedEdges: number; watertight: boolean } {
  const c = sanitizeTriangleMesh(Float32Array.from(t.position), Uint32Array.from(t.index))
  return { boundaryEdges: c.boundaryEdges, oversharedEdges: c.oversharedEdges, watertight: c.watertight }
}

describe('WO-2200 the mesh relief in the geometry engine', () => {
  it('the text sign and the terrain at the standard\'s sizes: the exact face (STEP) is byte-identical with or without the working grid', async () => {
    for (const [file, placed] of [['fixture-03-text-sign.png', [100, 50]], ['fixture-02-terrain-heightmap.png', [100, 100]]] as const) {
      const pic = await load(file)
      const { plate, face, auto, settings } = onPlate(pic, [placed[0], placed[1]])
      const f = reliefKernelFields(pic, { face, settings, autoParams: auto })
      expect(f.poles.n).toBe(256)
      expect(f.detail).toBeDefined()
      const box = (await engine.makeBox('F1', plate)).body!
      const exact = await engine.editFeature(request(box, f, false, 'R1'))
      const mesh = await engine.editFeature(request(box, f, true, 'R2'))
      expect(exact.ok && mesh.ok).toBe(true)
      expect(mesh.diagnostics[0].params).toMatchObject({ surface: 'mesh', controlPoints: 256 })
      const a = stepData(new TextDecoder().decode(await engine.exportStep([exact.body!])))
      const b = stepData(new TextDecoder().decode(await engine.exportStep([mesh.body!])))
      console.log(`${file}: exact face STEP data ${a.length} bytes, identical with the working grid sent: ${a === b}`)
      expect(a.length).toBeGreaterThan(100_000)
      expect(b).toBe(a)
    }
  }, 300_000)

  it('the mesh relief\'s face is the working grid: every sample inside is a vertex at its height, and the body\'s mesh is closed', async () => {
    const pic = await load('fixture-03-text-sign.png')
    const { plate, face, auto, settings } = onPlate(pic, [40, 20])
    const f = reliefKernelFields(pic, { face, settings, autoParams: auto })
    const d = f.detail!
    expect([d.cols, d.rows]).toEqual([401, 201])
    const box = (await engine.makeBox('F1', plate)).body!
    const r = await engine.editFeature(request(box, f))
    expect(r.ok).toBe(true)
    const t = await engine.tessellate(r.body!, DISPLAY_TESS_QUALITY)
    const key = (x: number, y: number, z: number) => `${Math.fround(x)},${Math.fround(y)},${Math.fround(z)}`
    const verts = new Set<string>()
    for (let i = 0; i < t.position.length; i += 3) verts.add(key(t.position[i], t.position[i + 1], t.position[i + 2]))
    const o = f.frame.origin
    let found = 0, checked = 0
    for (let rr = 1; rr < d.rows - 1; rr++) {
      for (let c = 1; c < d.cols - 1; c++) {
        checked++
        const x = o.x + (f.frame.widthMm * c) / (d.cols - 1), y = o.y + (f.frame.heightMm * rr) / (d.rows - 1), z = o.z + d.heights[rr * d.cols + c]
        if (verts.has(key(x, y, z))) found++
      }
    }
    console.log(`text sign 40 x 20 mm: ${found} of ${checked} working grid samples are body vertices; ${t.index.length / 3} triangles`)
    expect(found).toBe(checked)
    expect(closed(t)).toEqual({ boundaryEdges: 0, oversharedEdges: 0, watertight: true })
  }, 300_000)

  it('a hole beside the mesh relief keeps it the working grid, closed; a hole into it leaves that face to the kernel\'s own mesh, as the exact relief meshes', async () => {
    const pic = await load('fixture-03-text-sign.png')
    // a 40 x 20 mm sign centred on a 70 x 40 plate: the relief spans x 15..55, y 10..30
    const { plate, face, auto, settings } = onPlate(pic, [40, 20], { widthMm: 40, heightMm: 20 }, { x: 70, y: 40 })
    const f = reliefKernelFields(pic, { face, settings, autoParams: auto })
    const hole = async (body: BodyHandle, x: number, y: number) => {
      const cyl = kernel.translate(kernel.makeCylinder(2, plate.z + 20), x, y, -5)
      const tool = await engine.restoreBody(kernel.toBREPBinary(cyl).slice().buffer, { featureId: 'hole-tool', modified: {}, generated: [], deleted: [] })
      const cut = await engine.applyBoolean({ featureId: 'hole', op: 'cut', target: body, tools: [tool] })
      expect(cut.ok).toBe(true)
      return engine.tessellate(cut.body!, DISPLAY_TESS_QUALITY)
    }
    const box = (await engine.makeBox('F1', plate)).body!
    const mesh = await engine.editFeature(request(box, f, true, 'R1'))
    const exact = await engine.editFeature(request(box, f, false, 'R2'))
    expect(mesh.ok && exact.ok).toBe(true)
    const grid = await engine.tessellate(mesh.body!, DISPLAY_TESS_QUALITY)
    // beside it: the relief face is still its whole rectangle, meshed from the grid
    const beside = await hole(mesh.body!, 7, 20)
    console.log(`hole beside the relief: ${grid.index.length / 3} triangles before, ${beside.index.length / 3} after`)
    expect(beside.index.length).toBeGreaterThan(0.99 * grid.index.length)
    expect(closed(beside)).toEqual({ boundaryEdges: 0, oversharedEdges: 0, watertight: true })
    // into it: the grid no longer describes the face; the kernel meshes it, exactly as it meshes the exact relief
    const intoMesh = await hole(mesh.body!, 35, 20)
    const intoExact = await hole(exact.body!, 35, 20)
    const a = closed(intoMesh), b = closed(intoExact)
    console.log(`hole into the relief: mesh relief ${intoMesh.index.length / 3} triangles, ${a.boundaryEdges} open edges; exact relief ${intoExact.index.length / 3}, ${b.boundaryEdges} open edges (WO-2170 finding 4)`)
    expect(intoMesh.index.length).toBe(intoExact.index.length)
    expect(a).toEqual(b)
  }, 300_000)

  it('a working grid with a sample that has no height is dropped, not refused: the relief is built from its exact face (rule 11)', async () => {
    const pic = await load('fixture-03-text-sign.png')
    const { plate, face, auto, settings } = onPlate(pic, [100, 50])
    const f = reliefKernelFields(pic, { face, settings, autoParams: auto })
    expect(f.detail).toBeDefined()
    const heights = Float32Array.from(f.detail!.heights)
    heights[7] = Number.NaN
    const bad = { ...f, detail: { ...f.detail!, heights } } as ReliefKernelFields
    const box = (await engine.makeBox('F1', plate)).body!
    const built = await engine.editFeature(request(box, bad, true, 'R3'))
    expect(built.ok).toBe(true)
    expect(built.diagnostics[0].params).toMatchObject({ surface: 'exact', controlPoints: 256 })
  }, 300_000)

  it('a relief that fits in 256 control points stays an exact relief (no working grid sent, no "mesh relief" in its row)', async () => {
    const pic = await load('fixture-03-text-sign.png')
    const { face, auto, settings } = onPlate(pic, [25, 12.5], { widthMm: 25, heightMm: 12.5 })
    expect(workingGridSize(settings.widthMm, settings.heightMm)).toEqual({ cols: 251, rows: 126 })
    expect(isMeshRelief(workingGridSize(settings.widthMm, settings.heightMm))).toBe(false)
    const f = reliefKernelFields(pic, { face, settings, autoParams: auto })
    expect(f.detail).toBeUndefined()
    expect(f.poles.n).toBe(251)
    expect(reliefRowName('Relief 1', settings)).toBe('Relief 1')
    expect(reliefRowName('Relief 1', { widthMm: 26, heightMm: 13 })).toBe('Relief 1 (mesh relief)')
    expect(reliefRowName('Relief 1 (mesh relief)', settings)).toBe('Relief 1')
  })

  it('the 2000 x 2000 picture: build time and memory at 100 mm (S9) and at the 2048 working-grid cap', async () => {
    const grey = new Float32Array(2000 * 2000)
    for (let y = 0; y < 2000; y++) for (let x = 0; x < 2000; x++) grey[y * 2000 + x] = Math.min(1, Math.max(0, 0.5 + 0.25 * Math.sin(x / 37) * Math.cos(y / 53) + 0.2 * Math.sin((x + y) / 11)))
    const pic: Picture = { cols: 2000, rows: 2000, grey, bitDepth: 8 }
    for (const placed of [100, 204.7]) {
      const { plate, face, auto, settings } = onPlate(pic, [placed, placed])
      const rss0 = process.memoryUsage().rss
      const t0 = performance.now()
      const f = reliefKernelFields(pic, { face, settings, autoParams: auto })
      const t1 = performance.now()
      const box = (await engine.makeBox('F1', plate)).body!
      const r = await engine.editFeature(request(box, f))
      expect(r.ok).toBe(true)
      const t2 = performance.now()
      const t = await engine.tessellate(r.body!, DISPLAY_TESS_QUALITY)
      const t3 = performance.now()
      const rss1 = process.memoryUsage().rss
      console.log(`2000 x 2000 picture at ${settings.widthMm} mm: working grid ${f.detail!.cols} x ${f.detail!.rows}; heights ${((t1 - t0) / 1000).toFixed(1)} s, ` +
        `kernel build ${((t2 - t1) / 1000).toFixed(1)} s, body mesh ${((t3 - t2) / 1000).toFixed(1)} s (${t.index.length / 3} triangles, ` +
        `${((t.position.byteLength + t.normal.byteLength + t.index.byteLength + t.triFace.byteLength) / 2 ** 20).toFixed(0)} MB of buffers); rss ${(rss0 / 2 ** 20).toFixed(0)} -> ${(rss1 / 2 ** 20).toFixed(0)} MB`)
      expect(closed(t).watertight).toBe(true)
    }
  }, 900_000)
})
