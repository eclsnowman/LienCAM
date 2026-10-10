// WO-1956: Waterline 3D finishes a body built in the Model screen.
//
// Same fixture and route as WO-1954's parallelFinishModeledBody.wo1954.test.ts:
// a block with a raised boss built by the REAL modeling kernel
// (createLocalGeomService) and tessellated by the workbench's own display pass
// (progressiveTessellate -> modelBodyDisplayFromCached -> buildModelBodyGeometry).
// The operation is computed through the production entry point,
// computeOperationToolpath, against a REAL cam3d engine (Cam3dClient <->
// Cam3dDispatcher over a real BvhKernel, in-process) with the REAL opencamlib
// waterline slicer - the same wasm the app's worker runs, loaded the way
// faceScopedFinish.wo1223.test.ts loads it. Nothing about the strategy is stubbed.
//
// The equivalence case writes the SAME kernel triangles out as a binary STL and
// imports it through the production STL importer, placed where the modeled body
// sits, and compares the two toolpaths.

import { createRequire } from 'node:module'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLocalGeomService, type GeomClient } from '../../geom'
import type { BodyHandle, ProfileRegion } from '../../geom/geom-service'
import { GeometryCache } from '../../viewport3d/GeometryCache'
import { progressiveTessellate } from '../../viewport3d/progressiveTessellate'
import { modelBodyDisplayFromCached } from '../../viewport3d/modelBodyDisplay'
import { buildModelBodyGeometry } from '../../lib/cam/modelBodyAdapter'
import { BvhKernel } from '../../cam3d/kernel/bvhKernel'
import { Cam3dDispatcher } from '../../cam3d/worker/dispatcher'
import { Cam3dClient, type WorkerLike } from '../../cam3d/worker/client'
import type { Cam3dRequest, Cam3dResponse } from '../../cam3d/worker/protocol'
import {
  createOclWaterlineSlicer,
  type OclWaterlineModule,
  type WaterlineSlicer,
} from '../../cam3d/kernel/oclWaterline'
import { stampSmartHeightAuthority } from '../helpers/smartHeightAuthorityFixture'
import { typedMock } from '../support/typedMock'
import type {
  ImportedGeometry,
  ModelItemPlacementRecord,
  Operation,
  Setup,
  Tool,
  ToolpathMove,
} from '../../types'

const bridge = vi.hoisted(() => ({
  stlBytes: null as ArrayBuffer | null,
  cam3dCalls: 0,
  client: null as unknown,
}))

vi.mock('../../cam3d/integration/appClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../cam3d/integration/appClient')>()
  return typedMock<typeof import('../../cam3d/integration/appClient')>({
    ...actual,
    getCam3dClient: () => {
      bridge.cam3dCalls++
      return bridge.client as Cam3dClient
    },
  })
})

vi.mock('../../lib/stlCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/stlCache')>()
  return typedMock<typeof import('../../lib/stlCache')>({
    ...actual,
    loadCachedSTL: vi.fn(async () => bridge.stlBytes),
  })
})

const { useCamStore } = await import('../../store')
const { cancelAllSerializedCam3dComputes } = await import('../../store/toolpathBatchScheduler')

// --- the part: 60 x 40 x 20 block, 20 x 14 boss standing 10 mm on its top ----
const BLOCK = { x0: 0, y0: 0, x1: 60, y1: 40, height: 20 }
const BOSS = { x0: 20, y0: 13.2, x1: 40, y1: 27.2, height: 10 }
const FLOOR_Z = BLOCK.height // the block top the boss stands on
const BOSS_TOP_Z = BLOCK.height + BOSS.height

// The Model Item sits away from the origin, so a pose that is dropped or
// applied twice shows up in every world coordinate below.
const PLACEMENT: ModelItemPlacementRecord = {
  modelItemId: 'item-1',
  position: { x: 10, y: 5, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
}

const SETUP_ID = 'setup-wo1956'
const STOCK_ID = 'stock-wo1956'
const OP_ID = 'waterline-wo1956'
const STL_GEO_ID = 'stl-wo1956'

const ball3: Tool = {
  id: 'wo1956-ball-3', name: '3 mm ball', type: 'ball_end_mill', diameter: 3, fluteLength: 32,
  shankDiameter: 3, overallLength: 60, numberOfFlutes: 2, material: 'carbide', coating: 'none',
  notes: '', feedsAndSpeeds: {},
} as unknown as Tool
const R = 1.5

function rectProfile(sketchId: string, z: number, x0: number, y0: number, x1: number, y1: number): ProfileRegion {
  const c: [number, number][] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
  return {
    sketchId,
    plane: { origin: { x: 0, y: 0, z }, normal: { x: 0, y: 0, z: 1 }, xDir: { x: 1, y: 0, z: 0 } },
    loops: [c.map((a, i) => ({ kind: 'line' as const, a, b: c[(i + 1) % 4], srcId: `${sketchId}-${i}` }))],
  }
}

interface BuiltBody {
  modeled: ImportedGeometry
  stl: ArrayBuffer
}

/** Model the block + boss in the real kernel and publish it as the Model screen does. */
async function buildBlockWithBoss(): Promise<BuiltBody> {
  const client: GeomClient = createLocalGeomService()
  await client.init()
  const cache = new GeometryCache()
  try {
    const block = await client.makeExtrude({
      featureId: 'BLOCK',
      profiles: [rectProfile('S-BLOCK', 0, BLOCK.x0, BLOCK.y0, BLOCK.x1, BLOCK.y1)],
      end: { kind: 'blind', distance: BLOCK.height },
      op: 'newBody',
    })
    expect(block.ok, JSON.stringify(block.diagnostics)).toBe(true)
    const boss = await client.makeExtrude({
      featureId: 'BOSS',
      profiles: [rectProfile('S-BOSS', BLOCK.height, BOSS.x0, BOSS.y0, BOSS.x1, BOSS.y1)],
      end: { kind: 'blind', distance: BOSS.height },
      op: 'add',
      target: block.body as BodyHandle,
    })
    expect(boss.ok, JSON.stringify(boss.diagnostics)).toBe(true)
    await progressiveTessellate(client, cache, 'BOSS', boss.body as BodyHandle)
    const cached = cache.get('BOSS')!
    const display = modelBodyDisplayFromCached(cached)
    const modeled = {
      ...buildModelBodyGeometry(
        { bodyId: 'BOSS', lineageId: 'BLOCK', name: 'Block with boss' },
        {
          bodyId: 'BOSS', lineageId: 'BLOCK', version: cached.version,
          stableIds: [...cached.faceIds, ...cached.edgeIds], display,
        },
        undefined,
        PLACEMENT.modelItemId,
      ),
      stockId: STOCK_ID,
    }
    return { modeled, stl: binaryStl(display.positions, display.indices) }
  } finally {
    cache.disposeAll()
    await client.terminate().catch(() => undefined)
  }
}

function binaryStl(positions: readonly number[], indices: readonly number[]): ArrayBuffer {
  const triangles = indices.length / 3
  const buf = new ArrayBuffer(84 + triangles * 50)
  const view = new DataView(buf)
  view.setUint32(80, triangles, true)
  for (let t = 0; t < triangles; t++) {
    const base = 84 + t * 50
    for (let v = 0; v < 3; v++) {
      const i = indices[t * 3 + v] * 3
      for (let k = 0; k < 3; k++) view.setFloat32(base + 12 + v * 12 + k * 4, positions[i + k], true)
    }
  }
  return buf
}

/** The REAL opencamlib slicer (see faceScopedFinish.wo1223.test.ts for why the
 *  emscripten build is required directly under a `window` shim). */
const nodeRequire = createRequire(import.meta.url)
function realOclSlicer(): WaterlineSlicer {
  return createOclWaterlineSlicer({
    load: async () =>
      nodeRequire('@opencamlib/opencamlib/lib/emscripten/index.js') as OclWaterlineModule,
  })
}

function makeClient(): Cam3dClient {
  const kernel = new BvhKernel()
  const fakeWorker: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(message: unknown): void { dispatcher.handle(message as Cam3dRequest) },
    terminate(): void {},
  }
  const dispatcher = new Cam3dDispatcher(
    kernel,
    (msg: Cam3dResponse) => { fakeWorker.onmessage?.({ data: msg } as MessageEvent) },
    { slicer: realOclSlicer() },
  )
  return new Cam3dClient(fakeWorker)
}

// World bounds of the placed part: the stock box is exactly the part.
const WORLD = {
  min: { x: BLOCK.x0 + PLACEMENT.position.x, y: BLOCK.y0 + PLACEMENT.position.y, z: 0 },
  max: { x: BLOCK.x1 + PLACEMENT.position.x, y: BLOCK.y1 + PLACEMENT.position.y, z: BOSS_TOP_Z },
}
const STOCK = {
  id: STOCK_ID,
  name: 'WO-1956 block',
  mode: 'explicit' as const,
  bounds: {
    min: WORLD.min,
    max: WORLD.max,
    size: { x: WORLD.max.x - WORLD.min.x, y: WORLD.max.y - WORLD.min.y, z: WORLD.max.z - WORLD.min.z },
    center: {
      x: (WORLD.min.x + WORLD.max.x) / 2, y: (WORLD.min.y + WORLD.max.y) / 2, z: (WORLD.min.z + WORLD.max.z) / 2,
    },
  },
  position: { x: 0, y: 0, z: 0 },
}

/** The same shape as an imported STL, placed where the modeled body sits. The
 *  STL importer recentres the mesh (xy centroid on the origin, base on z 0), so
 *  its position is the placed part's xy centre. */
function importedStlTwin(): ImportedGeometry {
  return {
    id: STL_GEO_ID,
    name: 'Block with boss.stl',
    filename: 'block-with-boss.stl',
    type: 'mesh',
    format: 'stl',
    loaded: true,
    position: {
      x: (BLOCK.x0 + BLOCK.x1) / 2 + PLACEMENT.position.x,
      y: (BLOCK.y0 + BLOCK.y1) / 2 + PLACEMENT.position.y,
      z: PLACEMENT.position.z,
    },
    rotation: { x: 0, y: 0, z: 0 },
    boundingBox: STOCK.bounds,
    stockId: STOCK_ID,
  } as ImportedGeometry
}

function waterlineOperation(geoId: string): Operation {
  return stampSmartHeightAuthority(
    {
      id: OP_ID,
      name: 'Waterline boss',
      type: 'waterline_3d',
      enabled: true,
      status: 'pending',
      toolId: ball3.id,
      geometrySelections: [geoId],
      heights: {
        clearanceHeight: BOSS_TOP_Z + 13,
        clearanceHeightMode: 'absolute',
        retractHeight: BOSS_TOP_Z + 5,
        feedHeight: BOSS_TOP_Z + 3,
        topHeight: 0,
        topHeightMode: 'model_top',
        bottomHeight: 0,
        bottomHeightMode: 'model_bottom',
      },
      passes: { stepdown: 2, stepover: 1.5, stockToLeave: 0, finishPasses: 0, springPasses: 0 },
      linking: {
        entryType: 'plunge', rampAngle: 3, rampLength: 10, leadInRadius: 0,
        leadOutRadius: 0, retractType: 'full', transitionType: 'safe_height',
      },
      params: {
        stepdown: 2, tolerance: 0.05, stockToLeave: 0, minSlopeDeg: 0,
        flatAreaDetection: false, order: 'level', direction: 'climb', useStockBoundary: false,
      },
    } as unknown as Operation,
    { setupId: SETUP_ID, geometryIds: [geoId], stockId: STOCK_ID },
  ) as Operation
}

function install(geo: ImportedGeometry): void {
  const setup = {
    id: SETUP_ID,
    name: 'WO-1956 setup',
    wcs: {
      id: `wcs-${SETUP_ID}`, label: 'G54', fixtureOffset: 54,
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      stockId: STOCK_ID,
    },
    stock: null,
    operations: [waterlineOperation(geo.id)],
    notes: '',
  } as unknown as Setup
  useCamStore.setState((state) => ({
    toolLibrary: [ball3],
    toolpathBatch: null,
    project: {
      ...state.project,
      geometry: [geo],
      setups: [setup],
      stocks: [STOCK],
      activeSetupId: SETUP_ID,
      modelItemPlacements: [PLACEMENT],
    },
  }))
}

function currentOp(): Operation {
  return useCamStore.getState().project.setups[0].operations[0]
}

async function computeReady(geo: ImportedGeometry): Promise<ToolpathMove[]> {
  install(geo)
  await useCamStore.getState().computeOperationToolpath(SETUP_ID, OP_ID)
  const op = currentOp()
  expect(`${op.status}${op.errorMessage ? `: ${op.errorMessage}` : ''}`).toBe('ready')
  return op.toolpathMoves ?? []
}

const cuts = (moves: readonly ToolpathMove[]) => moves.filter((m) => m.type !== 'rapid' && m.role === 'cut')

/** The cutting segments of a toolpath: each cut move from the point before it. */
function cutSegments(moves: readonly ToolpathMove[]): [ToolpathMove, ToolpathMove][] {
  const out: [ToolpathMove, ToolpathMove][] = []
  for (let i = 1; i < moves.length; i++) {
    if (moves[i].type !== 'rapid' && moves[i].role === 'cut') out.push([moves[i - 1], moves[i]])
  }
  return out
}

function pointToSegment(p: ToolpathMove, [a, b]: [ToolpathMove, ToolpathMove]): number {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z
  const len2 = dx * dx + dy * dy + dz * dz
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy + (p.z - a.z) * dz) / len2))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy), p.z - (a.z + t * dz))
}

/** Largest distance from any cut point of `a` to the cutting path of `b` (3D).
 *  Path-to-path: the two sources may start each ring at a different point. */
function directedDeviation(a: readonly ToolpathMove[], b: readonly ToolpathMove[]): number {
  const segs = cutSegments(b)
  let worst = 0
  for (const p of cuts(a)) {
    let best = Infinity
    for (const s of segs) {
      const d = pointToSegment(p, s)
      if (d < best) best = d
      if (best < 1e-9) break
    }
    if (best > worst) worst = best
  }
  return worst
}

/** XY distance from a point OUTSIDE (or on) an axis-aligned rectangle to it. */
function distanceToRect(x: number, y: number, r: { x0: number; y0: number; x1: number; y1: number }): number {
  const dx = Math.max(r.x0 - x, 0, x - r.x1)
  const dy = Math.max(r.y0 - y, 0, y - r.y1)
  return Math.hypot(dx, dy)
}

const worldRect = (r: { x0: number; y0: number; x1: number; y1: number }) => ({
  x0: r.x0 + PLACEMENT.position.x, y0: r.y0 + PLACEMENT.position.y,
  x1: r.x1 + PLACEMENT.position.x, y1: r.y1 + PLACEMENT.position.y,
})

const globalWithWindow = globalThis as { window?: unknown }
let hadWindow = false
let built: BuiltBody

beforeAll(async () => {
  hadWindow = 'window' in globalWithWindow
  if (!hadWindow) globalWithWindow.window = globalThis
  built = await buildBlockWithBoss()
  bridge.stlBytes = built.stl
}, 120_000)

beforeEach(() => {
  bridge.client = makeClient()
  bridge.cam3dCalls = 0
  cancelAllSerializedCam3dComputes()
})

afterAll(() => {
  cancelAllSerializedCam3dComputes()
  if (!hadWindow) delete globalWithWindow.window
})

describe('WO-1956 waterline finish cuts a modeled body', () => {
  it('computes contour rings at each Z level that follow the boss walls and the block walls', async () => {
    expect(built.modeled.format).toBe('model')
    const moves = await computeReady(built.modeled)
    const cut = cuts(moves)
    expect(cut.length).toBeGreaterThan(20)
    expect(bridge.cam3dCalls).toBeGreaterThan(0)

    const bossRect = worldRect(BOSS)
    const blockRect = worldRect(BLOCK)
    const eps = 0.1
    // A ball whose tip is at level Z touches a vertical wall with its centre R
    // off the wall, so every ring sits R outside the wall it follows (a corner
    // is an arc of radius R about the wall corner - still R from the rectangle).
    const bossLevels = cut.filter((m) => m.z > FLOOR_Z + eps && m.z < BOSS_TOP_Z - eps)
    const blockLevels = cut.filter((m) => m.z > eps && m.z < FLOOR_Z - eps)
    const levels = (pts: ToolpathMove[]) =>
      [...new Set(pts.map((m) => m.z.toFixed(3)))].sort((a, b) => Number(b) - Number(a))
    const worst = (pts: ToolpathMove[], rect: typeof bossRect) =>
      Math.max(...pts.map((m) => Math.abs(distanceToRect(m.x, m.y, rect) - R)))
    const sample = (label: string, pts: ToolpathMove[]) => {
      const picks = [0, Math.floor(pts.length / 3), Math.floor((2 * pts.length) / 3), pts.length - 1].map((i) => pts[i])
      console.log(`[WO-1956] ${label}: ${pts.length} cut points at Z ${levels(pts).join(', ')}; samples ` +
        picks.map((p) => `(${p.x.toFixed(3)}, ${p.y.toFixed(3)}, ${p.z.toFixed(3)})`).join(' '))
    }
    sample('boss walls', bossLevels)
    sample('block walls', blockLevels)
    const bossWorst = worst(bossLevels, bossRect)
    const blockWorst = worst(blockLevels, blockRect)
    console.log(`[WO-1956] worst |wall distance - R|: boss ${bossWorst.toFixed(4)} mm, block ${blockWorst.toFixed(4)} mm`)

    expect(levels(bossLevels).length).toBeGreaterThanOrEqual(3)
    expect(levels(blockLevels).length).toBeGreaterThanOrEqual(5)
    expect(bossWorst).toBeLessThanOrEqual(0.1)
    expect(blockWorst).toBeLessThanOrEqual(0.1)
    // Each ring goes all the way round its wall: it reaches all four sides.
    for (const [pts, rect] of [[bossLevels, bossRect], [blockLevels, blockRect]] as const) {
      expect(Math.min(...pts.map((m) => m.x))).toBeCloseTo(rect.x0 - R, 1)
      expect(Math.max(...pts.map((m) => m.x))).toBeCloseTo(rect.x1 + R, 1)
      expect(Math.min(...pts.map((m) => m.y))).toBeCloseTo(rect.y0 - R, 1)
      expect(Math.max(...pts.map((m) => m.y))).toBeCloseTo(rect.y1 + R, 1)
    }
    // Nothing above the boss top.
    expect(Math.max(...cut.map((m) => m.z))).toBeLessThanOrEqual(BOSS_TOP_Z + 1e-6)
  }, 300_000)

  it('gives the same toolpath as the same shape imported as an STL (within 0.01 mm)', async () => {
    const modeledMoves = await computeReady(built.modeled)
    const modeledHeights = currentOp().resolvedHeights
    bridge.client = makeClient()
    const stlMoves = await computeReady(importedStlTwin())
    const stlHeights = currentOp().resolvedHeights

    const a = cuts(modeledMoves)
    const b = cuts(stlMoves)
    const deviation = Math.max(directedDeviation(modeledMoves, stlMoves), directedDeviation(stlMoves, modeledMoves))
    console.log(`[WO-1956] modeled ${modeledMoves.length} moves (${a.length} cut), ` +
      `STL ${stlMoves.length} moves (${b.length} cut); max deviation ${deviation.toExponential(2)} mm`)
    expect(a.length).toBeGreaterThan(20)
    expect(Math.abs(a.length - b.length)).toBeLessThanOrEqual(Math.ceil(a.length * 0.01))
    expect(deviation).toBeLessThanOrEqual(0.01)
    expect(modeledHeights).toBeDefined()
    console.log(`[WO-1956] machine heights modeled ${JSON.stringify(modeledHeights?.machine)} STL ${JSON.stringify(stlHeights?.machine)}`)
    expect(stlHeights?.machine).toEqual(modeledHeights?.machine)
  }, 300_000)

  it('previews the same Smart Heights for the modeled body as for the STL', async () => {
    install(built.modeled)
    const modeled = await useCamStore.getState().previewWaterline3dSmartHeights(SETUP_ID, currentOp())
    install(importedStlTwin())
    const stl = await useCamStore.getState().previewWaterline3dSmartHeights(SETUP_ID, currentOp())
    expect(modeled.machine.top).toBeCloseTo(BOSS_TOP_Z, 3)
    expect(stl.machine).toEqual(modeled.machine)
  }, 120_000)

  it('refuses a modeled body with no tessellation by name, before any cam3d work', async () => {
    const bare: ImportedGeometry = {
      ...built.modeled,
      modelBody: {
        ...built.modeled.modelBody!,
        display: { ...built.modeled.modelBody!.display!, positions: [], indices: [] },
      },
    }
    install(bare)
    await useCamStore.getState().computeOperationToolpath(SETUP_ID, OP_ID)
    const op = currentOp()
    expect(op.status).toBe('unsupported')
    expect(op.errorMessage ?? '').toMatch(/no tessellated geometry/)
    expect(op.errorMessage ?? '').toMatch(/retry Waterline 3D/)
    expect(op.toolpathMoves ?? []).toHaveLength(0)
    expect(bridge.cam3dCalls).toBe(0)
  })
})
