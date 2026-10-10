// WO-2170 - image relief stage 1a: the kernel measured on relief faces.
//
// Normal slice: the helpers, and the exact route (explicit poles -> STEP face
// -> split + sew -> engine hand-off -> tessellation -> through-hole cut ->
// Parallel Finish (3D)) at 128 and 256 control points per side on a cosine
// bump with a known volume: the volume error must stay under 0.5 %. The mesh
// route runs once too.
//
// RELIEF_BENCH=1: every size (128, 256, 512, 1024), the fixtures of
// docs/design/relief-references/fixtures/ (portrait, text sign) and the
// cosine bump, both routes plus the kernel's own point fit, written to
// src/tests/evidence/WO-2170/kernel-times.json. One command:
//   $env:RELIEF_BENCH='1'; npx vitest run src/tests/relief/reliefKernel.test.ts

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { OcctKernel } from 'occt-wasm'
import { GeomEngine } from '../../geom/worker/geom-engine'
import { BvhKernel } from '../../cam3d/kernel/bvhKernel'
import { Cam3dDispatcher } from '../../cam3d/worker/dispatcher'
import { Cam3dClient, type WorkerLike } from '../../cam3d/worker/client'
import type { Cam3dRequest, Cam3dResponse } from '../../cam3d/worker/protocol'
import { defaultManifoldFactory, type ManifoldWasmModule } from '../../mesh/manifoldKernel'
import { sanitizeTriangleMesh } from '../../cam3d/input/sanitize'
import type { Tool } from '../../types'
import {
  cosineBumpHeight, cosineBumpVolume, fadeToEdges, gridVolume, imageToHeightGrid, sampleHeightGrid, smoothGrid,
  workingGridSize, type CosineBump, type HeightGrid,
} from '../../relief/heightGrid'
import { grevilleFraction, poleSurfaceHeight, poleSurfaceVolume, reliefPoles } from '../../relief/reliefStep'
import { importReliefFace } from '../../relief/reliefKernel'
import { meshVolume, reliefPlateMesh, type PlateSpec } from '../../relief/reliefMesh'
import {
  CAM_DEFLECTION_MM, measureExactRoute, measureFitRoute, measureMeshRoute,
  type BenchCase, type BenchContext, type RouteRecord,
} from '../../relief/kernelBench'

const BENCH = process.env.RELIEF_BENCH === '1'
const ROOT = path.resolve(__dirname, '../../..')
const FIXTURES = path.join(ROOT, 'docs/design/relief-references/fixtures')
const EVIDENCE = path.join(ROOT, 'src/tests/evidence/WO-2170/kernel-times.json')

const PLATE: PlateSpec = { x: 100, y: 70, z: 15 }
/** The relief area: 80 x 56 centred on the plate top (10 mm margins at the long sides, 7 mm at the short). */
const AREA = { w: 80, d: 56 }
/** RELIEF-WHAT-GOOD-LOOKS-LIKE.md S2: 4 % of the shorter placed side, rounded to 0.25 mm. */
const defaultDepth = (w: number, d: number) => Math.round((0.04 * Math.min(w, d)) / 0.25) * 0.25
const BUMP: CosineBump = { widthMm: AREA.w, depthMm: AREA.d, amplitudeMm: defaultDepth(AREA.w, AREA.d), radiusMm: 25 }

function ballTool(diameter: number): Tool {
  return {
    id: `ball-${diameter}`, name: `ball d${diameter}`, type: 'ball_end_mill', diameter,
    fluteLength: 10, shankDiameter: Math.max(3, diameter), overallLength: 50, numberOfFlutes: 2,
    material: 'carbide', coating: 'none', notes: '', feedsAndSpeeds: {},
  } as Tool
}

/** The standard's finishing default: a 1.6 mm ball at 10 % stepover. */
const BENCH_FINISH = { tool: ballTool(1.6), stepover: 0.16 }
/** A coarse finish for the normal slice: proves the route, costs seconds. */
const QUICK_FINISH = { tool: ballTool(3.2), stepover: 1.5 }

function placedCase(fixture: string, grid: HeightGrid, referenceVolume: number, referenceSource: string, finish: BenchCase['finish']): BenchCase {
  const origin = { x: (PLATE.x - grid.widthMm) / 2, y: (PLATE.y - grid.depthMm) / 2 }
  return {
    fixture, grid, plate: PLATE, origin, referenceVolume, referenceSource,
    hole: { x: origin.x + 0.65 * grid.widthMm, y: origin.y + 0.5 * grid.depthMm, radius: 3 },
    finish,
  }
}

function bumpCase(perMm: number, finish: BenchCase['finish']): BenchCase {
  const { cols, rows } = workingGridSize(AREA.w, AREA.d, perMm)
  const grid = sampleHeightGrid(AREA.w, AREA.d, cols, rows, cosineBumpHeight(BUMP))
  return placedCase('cosine-bump', grid, cosineBumpVolume(BUMP), 'analytic A R^2 (pi/2 - 2/pi)', finish)
}

/** A fixture picture placed as large as fits the relief area, prepared the way the standard's Auto would (smooth, invert for light artwork), faded to the face over 2 mm. */
async function fixtureCase(file: string, fixture: string, opts: { invert: boolean; smoothMm: number }): Promise<BenchCase> {
  const sharp = (await import('sharp')).default
  const { data, info } = await sharp(path.join(FIXTURES, file)).greyscale().raw().toBuffer({ resolveWithObject: true })
  const px = new Float32Array(info.width * info.height)
  for (let i = 0; i < px.length; i++) px[i] = data[i * info.channels] / 255
  const scale = Math.min(AREA.w / info.width, AREA.d / info.height)
  const w = info.width * scale, d = info.height * scale
  const { cols, rows } = workingGridSize(w, d)
  let grid = imageToHeightGrid(px, info.width, info.height, w, d, defaultDepth(w, d), cols, rows, opts.invert)
  grid = fadeToEdges(smoothGrid(grid, opts.smoothMm), 2)
  return placedCase(fixture, grid, gridVolume(grid), `working grid ${cols} x ${rows} (10 / mm), bilinear integral`, BENCH_FINISH)
}

let ctx: BenchContext
beforeAll(async () => {
  const kernel = await OcctKernel.init()
  const engine = new GeomEngine()
  await engine.init()
  const bvh = new BvhKernel()
  const worker: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(message: unknown): void { dispatcher.handle(message as Cam3dRequest) },
    terminate(): void { /* in-process channel */ },
  }
  const dispatcher = new Cam3dDispatcher(bvh, (msg: Cam3dResponse) => { worker.onmessage?.({ data: msg } as MessageEvent) })
  const manifold: ManifoldWasmModule = await defaultManifoldFactory()
  manifold.setup()
  ctx = {
    kernel, engine, cam: new Cam3dClient(worker), manifold,
    peakMemoryMb: () => process.resourceUsage().maxRSS / 1024,
  }
}, 120_000)

afterAll(async () => {
  await ctx?.cam.dispose()
  await ctx?.engine.disposeKernel()
})

describe('relief height grid helpers', () => {
  it('the working grid integral of the cosine bump matches its closed-form volume', () => {
    const c = bumpCase(10, QUICK_FINISH)
    expect(c.grid.cols).toBe(801)
    expect(c.grid.rows).toBe(561)
    expect(Math.abs(gridVolume(c.grid) / c.referenceVolume - 1)).toBeLessThan(1e-4)
  })

  it('pole positions are the Greville points and the basis integrates to the rectangle', () => {
    expect(grevilleFraction(0, 128)).toBe(0)
    expect(grevilleFraction(127, 128)).toBe(1)
    // interior poles away from the clamped ends are evenly spaced
    expect(grevilleFraction(64, 128) - grevilleFraction(63, 128)).toBeCloseTo(1 / 125, 12)
    const ones = { n: 64, widthMm: 80, depthMm: 56, heights: new Float64Array(64 * 64).fill(1) }
    expect(poleSurfaceVolume(ones)).toBeCloseTo(80 * 56, 9)
  })

  it('the mesh route body is closed, outward, and carries the relief volume', () => {
    const c = bumpCase(5, QUICK_FINISH)
    const m = reliefPlateMesh(c.grid, PLATE, c.origin)
    const clean = sanitizeTriangleMesh(m.positions, m.indices)
    expect(clean.watertight).toBe(true)
    expect(clean.droppedDegenerateTriangles).toBe(0)
    const v = meshVolume(m) - PLATE.x * PLATE.y * PLATE.z
    expect(Math.abs(v / c.referenceVolume - 1)).toBeLessThan(0.005)
  })
})

describe('exact relief face on the kernel (cosine bump, known volume)', () => {
  it('128 control points per side: whole route through to Parallel Finish, volume within 0.5 %', { timeout: 240_000 }, async () => {
    const r = await measureExactRoute(ctx, bumpCase(10, QUICK_FINISH), 128)
    expect(r.error).toBeUndefined()
    expect(r.ok).toBe(true)
    expect(Math.abs(r.volumeErrorPct!)).toBeLessThan(0.5)
    // the kernel's body carries the pole surface we wrote (closed-form volume)
    expect(Math.abs(r.volumeErrorPct! - r.poleVolumeErrorPct!)).toBeLessThan(0.01)
    expect(r.steps.tessellate.triangles).toBeGreaterThan(0)
    expect(Math.abs(r.hole!.removed / r.hole!.expected - 1)).toBeLessThan(0.01)
    expect((r.steps.parallelFinish as { cutMoves: number }).cutMoves).toBeGreaterThan(50)
  })

  it('256 control points per side: volume within 0.5 %', { timeout: 240_000 }, async () => {
    const r = await measureExactRoute(ctx, bumpCase(10, QUICK_FINISH), 256, { finish: false })
    expect(r.error).toBeUndefined()
    expect(Math.abs(r.volumeErrorPct!)).toBeLessThan(0.5)
    expect(Math.abs(r.volumeErrorPct! - r.poleVolumeErrorPct!)).toBeLessThan(0.01)
  })

  it('the kernel reads back exactly the poles written (face points match the closed-form surface)', () => {
    let seed = 7
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
    const g = fadeToEdges(sampleHeightGrid(43, 29, 200, 150, () => rnd() * 2), 2)
    const p = reliefPoles(g, 40)
    const { face } = importReliefFace(ctx.kernel, p, { origin: { x: 5, y: 3 }, baseZ: 15 })
    const uv = ctx.kernel.uvBounds(face)
    let worst = 0
    for (let a = 0; a <= 1; a += 0.0625) {
      for (let b = 0; b <= 1; b += 0.0625) {
        const q = ctx.kernel.pointOnSurface(face, uv.uMin + a * (uv.uMax - uv.uMin), uv.vMin + b * (uv.vMax - uv.vMin))
        worst = Math.max(worst, Math.abs(q.z - 15 - poleSurfaceHeight(p, q.x - 5, q.y - 3)))
      }
    }
    ctx.kernel.release(face)
    expect(worst).toBeLessThan(1e-9)
  })

  it('the pole surface never dips below the face (convex hull), unlike a fitted one', () => {
    const p = reliefPoles(bumpCase(10, QUICK_FINISH).grid, 128)
    expect(p.heights.reduce((a, b) => Math.min(a, b), Infinity)).toBe(0)
  })
})

describe('mesh relief route (a)', () => {
  it('builds, cuts the hole and finishes on a 5 / mm grid', { timeout: 240_000 }, async () => {
    const r = await measureMeshRoute(ctx, bumpCase(5, QUICK_FINISH))
    expect(r.error).toBeUndefined()
    expect(Math.abs(r.volumeErrorPct!)).toBeLessThan(0.5)
    expect(Math.abs(r.hole!.removed / r.hole!.expected - 1)).toBeLessThan(0.01)
    expect((r.steps.parallelFinish as { cutMoves: number }).cutMoves).toBeGreaterThan(50)
  })
})

describe.runIf(BENCH)('RELIEF_BENCH=1: the full measurement', () => {
  it('measures every size on every fixture and writes kernel-times.json', { timeout: 6 * 3600_000 }, async () => {
    // Optional slices of the run, merged into the same file:
    // RELIEF_BENCH_CASES=cosine-bump,portrait  RELIEF_BENCH_SIZES=512  RELIEF_BENCH_ROUTES=exact,mesh,exact-fit
    const pick = (name: string) => process.env[name]?.split(',').map((s) => s.trim()).filter(Boolean)
    const sizes = (pick('RELIEF_BENCH_SIZES') ?? ['128', '256', '512', '1024']).map(Number)
    const routes = pick('RELIEF_BENCH_ROUTES') ?? ['mesh', 'exact', 'exact-fit']
    const wanted = pick('RELIEF_BENCH_CASES') ?? ['cosine-bump', 'portrait', 'text-sign']
    const cases = [
      ...(wanted.includes('cosine-bump') ? [bumpCase(10, BENCH_FINISH)] : []),
      ...(wanted.includes('portrait') ? [await fixtureCase('fixture-01-portrait-photo-lincoln.jpg', 'portrait', { invert: false, smoothMm: 0.2 })] : []),
      ...(wanted.includes('text-sign') ? [await fixtureCase('fixture-03-text-sign.png', 'text-sign', { invert: true, smoothMm: 0.15 })] : []),
    ]
    const out = {
      workOrder: 'WO-2170',
      when: new Date().toISOString(),
      box: { host: os.hostname(), cpu: os.cpus()[0]?.model, cores: os.cpus().length, memoryGb: Math.round(os.totalmem() / 2 ** 30), node: process.version, platform: `${os.platform()} ${os.release()}` },
      command: "$env:RELIEF_BENCH='1'; npx vitest run src/tests/relief/reliefKernel.test.ts",
      plate: PLATE,
      camDeflectionMm: CAM_DEFLECTION_MM,
      finish: { tool: `${BENCH_FINISH.tool.type} d${BENCH_FINISH.tool.diameter}`, stepover: BENCH_FINISH.stepover },
      cases: cases.map((c) => ({ fixture: c.fixture, reliefMm: [c.grid.widthMm, c.grid.depthMm], origin: c.origin, workingGrid: [c.grid.cols, c.grid.rows], depthMm: c.grid.heights.reduce((a, b) => Math.max(a, b), 0), referenceVolume: c.referenceVolume, referenceSource: c.referenceSource, hole: c.hole })),
      records: [] as RouteRecord[],
    }
    // keep earlier slices' records and case entries; a re-measured record replaces its old one
    const prior = fs.existsSync(EVIDENCE) ? JSON.parse(fs.readFileSync(EVIDENCE, 'utf8')) as typeof out : undefined
    const sameRecord = (a: RouteRecord, b: RouteRecord) => a.route === b.route && a.fixture === b.fixture && a.n === b.n
    if (prior) {
      out.records = prior.records
      out.cases = [...prior.cases.filter((p) => !out.cases.some((c) => c.fixture === p.fixture)), ...out.cases]
    }
    const record = (r: RouteRecord) => {
      out.records = [...out.records.filter((o) => !sameRecord(o, r)), r]
      fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true })
      fs.writeFileSync(EVIDENCE, JSON.stringify(out, null, 1) + '\n', 'utf8')
      return r
    }
    // A kernel that traps (the 1024 hole cut: "memory access out of bounds") is
    // dead afterwards - MEASURED: the next restoreBody failed with "null function
    // or function signature mismatch". Every failed record gets fresh kernels.
    const renewKernels = async () => {
      await ctx.engine.disposeKernel().catch(() => undefined)
      try { ctx.kernel[Symbol.dispose]() } catch { /* already broken */ }
      ctx.kernel = await OcctKernel.init()
      ctx.engine = new GeomEngine()
      await ctx.engine.init()
    }
    const mine: RouteRecord[] = []
    const keep = async (r: RouteRecord) => {
      mine.push(record(r))
      if (!r.ok) await renewKernels()
    }
    for (const c of cases) {
      if (routes.includes('mesh')) await keep(await measureMeshRoute(ctx, c))
      for (const n of sizes) {
        if (routes.includes('exact')) await keep(await measureExactRoute(ctx, c, n))
        if (routes.includes('exact-fit') && (c.fixture === 'cosine-bump' || n <= 256)) await keep(measureFitRoute(ctx, c, n))
      }
      // the size where the kernel's point fit was first seen to blow up (reliefStep.ts header)
      if (routes.includes('exact-fit') && !process.env.RELIEF_BENCH_SIZES) await keep(measureFitRoute(ctx, c, 64))
    }
    expect(mine.filter((r) => r.route === 'exact' && r.fixture === 'cosine-bump' && r.n! <= 256).every((r) => r.ok)).toBe(true)
  })
})
