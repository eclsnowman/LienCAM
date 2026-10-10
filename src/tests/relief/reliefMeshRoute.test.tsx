// @vitest-environment jsdom
//
// WO-2200 - the fine-detail (mesh) relief route, through the Model screen's own
// buttons on the real kernel (createLocalGeomService) with the fake scene
// runtime: the portrait fixture on a plate sized so the standard's render size
// lands (70 x 90 mm; its working grid is 700 x 901, far above the exact face's
// 256 control points per side). Relief on the rail, a click on the plate's top
// face, the picture opened through the palette's file input with no other
// click, Apply.
//
// The proof (WO-2200 "Proof"): the applied body's mesh - what the Model screen
// draws, what CAM machines and what STL exports (DISPLAY_TESS_QUALITY) -
// keeps the working grid's detail: its high-pass RMS is within 10 % of the
// height map's own. On main the relief face is the 256 x 256 exact face and
// detail finer than its 0.35 mm pole pitch is smoothed away (measured 0.69 of
// the height map's at 1 px, 0.78 at 2 px), so this test fails there.
//
// jsdom cannot decode a JPEG (the app decodes it with the browser), so the
// portrait is handed to the palette as the same picture in a grey PNG.

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'

const stepBytes = new Map<string, ArrayBuffer>()
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async (id: string, bytes: ArrayBuffer) => { stepBytes.set(id, bytes) }),
  loadCachedStep: vi.fn(async (id: string) => stepBytes.get(id) ?? null),
  removeCachedStep: vi.fn(async (id: string) => { stepBytes.delete(id) }),
  computeStepSha256: vi.fn(async () => null),
}))
import { SolidsWorkbenchPage, type SolidsWorkbenchHooks } from '../../components/model3d'
import { resetDocumentHolder } from '../../doc/documentHolder'
import { createLocalGeomService, GeomEngine } from '../../geom'
import type { TessBuffers } from '../../geom/geom-service'
import { useCamStore } from '../../store'
import { useReliefStore } from '../../components/model3d/relief/reliefStore'
import { isReliefFeaturePayload, pictureOf } from '../../relief/reliefFeature'
import { adjustedFor, reliefFrame, sampleReliefGrid, type ReliefFrame } from '../../relief/reliefHeights'
import { gaussian, MANUAL_ADJUST } from '../../relief/adjust'
import { workingGridSize } from '../../relief/heightGrid'
import { sanitizeTriangleMesh } from '../../cam3d/input/sanitize'
import { DISPLAY_TESS_QUALITY } from '../../viewport3d/tessQuality'
import { createFakeSceneRuntime, type FakeSceneRuntime } from '../model3d/fakeSceneRuntime'
import { waitForLoadedModel3d as waitFor } from '../model3d/loadTolerantWaitFor'

const PORTRAIT = resolve(process.cwd(), 'docs/design/relief-references/fixtures/fixture-01-portrait-photo-lincoln.jpg')
/** the face is the standard's placed size / 0.9, so the 5 % margin rule lands the portrait at 70 x 90 mm */
const PLATE = { x: 70 / 0.9, y: 100, z: 15 }

function hooks(): SolidsWorkbenchHooks {
  const value = window.__solidsWorkbenchHooks
  if (value === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return value
}

function clickWorld(runtime: FakeSceneRuntime, origin: { x: number; y: number; z: number }, direction: { x: number; y: number; z: number }): void {
  runtime.rayOverride = { origin, direction }
  fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
}

let plateStep: ArrayBuffer
let portraitPng: Buffer

beforeAll(async () => {
  const engine = new GeomEngine()
  await engine.init()
  const box = await engine.makeBox('PLATE', PLATE)
  plateStep = await engine.exportStep([box.body!])
  await engine.disposeKernel()
  const sharp = (await import('sharp')).default
  portraitPng = await sharp(PORTRAIT).greyscale().png().toBuffer()
}, 120_000)

beforeEach(() => {
  stepBytes.clear()
  resetDocumentHolder()
  useReliefStore.getState().closeSession()
  vi.stubGlobal('alert', vi.fn())
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  resetDocumentHolder()
})
afterAll(() => { useReliefStore.getState().closeSession() })

/**
 * The relief face of a body mesh, rasterised onto the working grid: each grid
 * point's height (along the frame's normal) read off the triangle above it.
 * Triangles count when their centre lies over the relief rectangle and near
 * the face (the plate's bottom is 15 mm away).
 */
function rasterise(t: TessBuffers, f: ReliefFrame, cols: number, rows: number): Float32Array {
  const out = new Float32Array(cols * rows).fill(Number.NaN)
  const P = t.position
  const loc = (i: number): [number, number, number] => {
    const x = P[i * 3] - f.origin.x, y = P[i * 3 + 1] - f.origin.y, z = P[i * 3 + 2] - f.origin.z
    return [
      x * f.xDir.x + y * f.xDir.y + z * f.xDir.z,
      x * f.yDir.x + y * f.yDir.y + z * f.yDir.z,
      x * f.normal.x + y * f.normal.y + z * f.normal.z,
    ]
  }
  const sx = (cols - 1) / f.widthMm, sy = (rows - 1) / f.heightMm
  for (let k = 0; k < t.index.length; k += 3) {
    const a = loc(t.index[k]), b = loc(t.index[k + 1]), c = loc(t.index[k + 2])
    const cu = (a[0] + b[0] + c[0]) / 3, cv = (a[1] + b[1] + c[1]) / 3, cw = (a[2] + b[2] + c[2]) / 3
    if (cu <= 0 || cv <= 0 || cu >= f.widthMm || cv >= f.heightMm || cw < -5) continue
    const det = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
    if (Math.abs(det) < 1e-14) continue
    const c0 = Math.max(0, Math.ceil(Math.min(a[0], b[0], c[0]) * sx - 1e-6)), c1 = Math.min(cols - 1, Math.floor(Math.max(a[0], b[0], c[0]) * sx + 1e-6))
    const r0 = Math.max(0, Math.ceil(Math.min(a[1], b[1], c[1]) * sy - 1e-6)), r1 = Math.min(rows - 1, Math.floor(Math.max(a[1], b[1], c[1]) * sy + 1e-6))
    for (let r = r0; r <= r1; r++) {
      const v = r / sy
      for (let cc = c0; cc <= c1; cc++) {
        const u = cc / sx
        const l0 = ((b[1] - c[1]) * (u - c[0]) + (c[0] - b[0]) * (v - c[1])) / det
        const l1 = ((c[1] - a[1]) * (u - c[0]) + (a[0] - c[0]) * (v - c[1])) / det
        const l2 = 1 - l0 - l1
        if (l0 < -1e-9 || l1 < -1e-9 || l2 < -1e-9) continue
        out[r * cols + cc] = l0 * a[2] + l1 * b[2] + l2 * c[2]
      }
    }
  }
  return out
}

/** RMS of what a gaussian of `sigma` grid pixels takes away, over the grid's inside (the edge ramp left out). */
function highPassRms(a: Float32Array, cols: number, rows: number, sigma: number, margin = 8): number {
  const low = gaussian(a, cols, rows, sigma)
  let sum = 0, n = 0
  for (let r = margin; r < rows - margin; r++) {
    for (let c = margin; c < cols - margin; c++) {
      const d = a[r * cols + c] - low[r * cols + c]
      sum += d * d
      n++
    }
  }
  return Math.sqrt(sum / n)
}

describe('WO-2200 the fine-detail (mesh) relief route', () => {
  it('the portrait applied through the Relief palette keeps the height map\'s detail (high-pass RMS within 10 %), closed, "mesh relief" in its row', async () => {
    const runtime = createFakeSceneRuntime()
    useCamStore.getState().newProject()
    render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    fireEvent.change(screen.getByTestId('workbench-import-step-input'), { target: { files: [new File([plateStep], 'plate.step')] } })
    await waitFor(() => expect(hooks().scheduler.statusOf('IMP1')).toBe('ok'), { timeout: 30_000 })

    // the operator clicks the plate's top face, then Relief on the rail, then opens the portrait
    clickWorld(runtime, { x: PLATE.x / 2, y: PLATE.y / 2, z: 100 }, { x: 0, y: 0, z: -1 })
    fireEvent.click(screen.getByTestId('workbench-relief'))
    await waitFor(() => expect(useReliefStore.getState().target?.ownerId).toBe('IMP1'), { timeout: 20_000 })
    fireEvent.change(screen.getByTestId('relief-file-input'), { target: { files: [new File([new Uint8Array(portraitPng)], 'fixture-01-portrait-photo-lincoln.png', { type: 'image/png' })] } })
    await waitFor(() => expect(useReliefStore.getState().settings).not.toBeNull(), { timeout: 20_000 })
    const s = useReliefStore.getState().settings!
    expect(s.heightMm).toBeCloseTo(90, 3)
    expect(useReliefStore.getState().autoParams?.kind).toBe('photo')
    await waitFor(() => expect(screen.getByTestId('relief-status-line').textContent).toMatch(/grid 700 x 901 @ 0\.10 mm/), { timeout: 30_000 })
    const status = screen.getByTestId('relief-status-line').textContent ?? ''
    console.log('WO-2200 portrait status line:', status)

    // Apply: ONE relief feature consuming the plate
    const rss0 = process.memoryUsage().rss
    const t0 = performance.now()
    fireEvent.click(screen.getByTestId('relief-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('REL1')).not.toBeUndefined(), { timeout: 120_000 })
    await waitFor(() => expect(hooks().scheduler.statusOf('REL1')).toBe('ok'), { timeout: 120_000 })
    const applyMs = performance.now() - t0
    const node = hooks().dag.getNode('REL1')!
    expect(isReliefFeaturePayload(node.payload)).toBe(true)
    if (!isReliefFeaturePayload(node.payload)) return

    // the body's mesh at the Model screen's display quality (the same buffers CAM and STL take)
    const t1 = performance.now()
    const tess = await hooks().client.tessellate(hooks().getBodyHandle('REL1')!, DISPLAY_TESS_QUALITY)
    const tessMs = performance.now() - t1
    const rss1 = process.memoryUsage().rss

    // the height map the palette made: the same chain, sampled on the working grid (10 / mm)
    const p = node.payload
    const picture = await pictureOf(p.image)
    const adjusted = adjustedFor(picture, p.autoParams, MANUAL_ADJUST, p.settings)
    const { cols, rows } = workingGridSize(p.settings.widthMm, p.settings.heightMm)
    const map = sampleReliefGrid(adjusted, picture.cols, picture.rows, p.settings, cols, rows).heights
    const body = rasterise(tess, reliefFrame(p.face, p.settings), cols, rows)
    let missing = 0
    for (let r = 8; r < rows - 8; r++) for (let c = 8; c < cols - 8; c++) if (Number.isNaN(body[r * cols + c])) missing++
    expect(missing).toBe(0)
    // the edge points a triangle only touches: on the face (0), as the relief's edge is
    for (let i = 0; i < body.length; i++) if (Number.isNaN(body[i])) body[i] = 0
    const ratios = [1, 2].map((sigma) => highPassRms(body, cols, rows, sigma) / highPassRms(map, cols, rows, sigma))
    console.log(`WO-2200 portrait: body high-pass RMS / height map's at 1 px ${ratios[0].toFixed(3)}, at 2 px ${ratios[1].toFixed(3)}; ` +
      `${tess.index.length / 3} triangles; Apply to built ${(applyMs / 1000).toFixed(1)} s, display mesh ${(tessMs / 1000).toFixed(1)} s; ` +
      `rss ${(rss0 / 2 ** 20).toFixed(0)} -> ${(rss1 / 2 ** 20).toFixed(0)} MB`)
    for (const ratio of ratios) {
      expect(ratio).toBeGreaterThan(0.9)
      expect(ratio).toBeLessThan(1.1)
    }

    // it says what it is: the tree row and the status line
    expect(node.payload.name).toBe('Relief 1 (mesh relief)')
    expect(status).toMatch(/mesh relief at the grid's full detail \(STL export\); STEP export keeps the exact face, 256 x 256 control points/)

    // closed: CAM takes the mesh as it is (every edge shared by two triangles after the positional weld)
    const clean = sanitizeTriangleMesh(Float32Array.from(tess.position), Uint32Array.from(tess.index))
    expect(clean.boundaryEdges).toBe(0)
    expect(clean.oversharedEdges).toBe(0)
    expect(clean.watertight).toBe(true)
  }, 300_000)
})
