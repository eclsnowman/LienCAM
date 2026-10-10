// WO-1959: Pencil 3D finishes a body built in the Model screen.
//
// The fixture is WO-1954's: a block with a raised boss, built by the REAL
// modeling kernel (createLocalGeomService - the same OCCT engine the Model
// workbench runs) and tessellated by the workbench's own display pass
// (progressiveTessellate -> modelBodyDisplayFromCached ->
// buildModelBodyGeometry), so the CAM row this file machines is the row the
// Model screen would publish. The pencil_3d operation is computed through the
// production entry point, computeOperationToolpath, against a REAL cam3d engine
// (Cam3dClient <-> Cam3dDispatcher over a real BvhKernel, in-process). Nothing
// about the strategy is stubbed.
//
// A pencil pass runs where the ball touches two surfaces at once. On this part
// that is the inside corner where the boss walls meet the block top: the ball
// tip sits on the floor and its centre is one radius off the boss.
//
// The equivalence case writes the SAME kernel triangles out as a binary STL
// and imports it through the production STL importer (acquirePartMesh), placed
// where the modeled body sits, and compares the two toolpaths.

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
// WO-1954's boss, kept byte for byte (it sits 0.2 mm off Parallel's raster grid
// to avoid a tangency tie there). One fixture for every modeled-body finish.
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

const SETUP_ID = 'setup-wo1959'
const STOCK_ID = 'stock-wo1959'
const OP_ID = 'pencil-wo1959'
const STL_GEO_ID = 'stl-wo1959'

const ball3: Tool = {
  id: 'wo1959-ball-3', name: '3 mm ball', type: 'ball_end_mill', diameter: 3, fluteLength: 32,
  shankDiameter: 3, overallLength: 60, numberOfFlutes: 2, material: 'carbide', coating: 'none',
  notes: '', feedsAndSpeeds: {},
} as unknown as Tool
const R = 1.5
// The op's path tolerance: how far a pass point may sit from the true ball contact.
const TOLERANCE = 0.05 // DEFAULT_PENCIL3D_PARAMS.tolerance: what the wizard gives the operator

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
    {},
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
  name: 'WO-1959 block',
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

function pencilOperation(geoId: string): Operation {
  return stampSmartHeightAuthority(
    {
      id: OP_ID,
      name: 'Pencil boss corner',
      type: 'pencil_3d',
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
      passes: { stepover: 1.5, stepdown: 2, stockToLeave: 0, finishPasses: 0, springPasses: 0 },
      linking: {
        entryType: 'plunge', rampAngle: 3, rampLength: 10, leadInRadius: 0,
        leadOutRadius: 0, retractType: 'full', transitionType: 'safe_height',
      },
      params: { tolerance: TOLERANCE, stockToLeave: 0, useStockBoundary: false, direction: 'climb' },
    } as unknown as Operation,
    { setupId: SETUP_ID, geometryIds: [geoId], stockId: STOCK_ID },
  ) as Operation
}

function install(geo: ImportedGeometry): void {
  const setup = {
    id: SETUP_ID,
    name: 'WO-1959 setup',
    wcs: {
      id: `wcs-${SETUP_ID}`, label: 'G54', fixtureOffset: 54,
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      stockId: STOCK_ID,
    },
    stock: null,
    operations: [pencilOperation(geo.id)],
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
 *  Path-to-path, not point-to-point: the two sources may sample each pass at
 *  different places ALONG the same line. The
 *  the segments are bucketed on a 1 mm XY grid; a point searches its own cell
 *  and the eight around it, and only a point with nothing within one cell falls
 *  back to every segment (so a real divergence is still measured exactly). */
function directedDeviation(a: readonly ToolpathMove[], b: readonly ToolpathMove[]): number {
  const segs = cutSegments(b)
  const CELL = 1
  const key = (i: number, j: number) => `${i},${j}`
  const grid = new Map<string, [ToolpathMove, ToolpathMove][]>()
  for (const s of segs) {
    const i0 = Math.floor(Math.min(s[0].x, s[1].x) / CELL), i1 = Math.floor(Math.max(s[0].x, s[1].x) / CELL)
    const j0 = Math.floor(Math.min(s[0].y, s[1].y) / CELL), j1 = Math.floor(Math.max(s[0].y, s[1].y) / CELL)
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const k = key(i, j)
        const bucket = grid.get(k)
        if (bucket) bucket.push(s)
        else grid.set(k, [s])
      }
    }
  }
  let worst = 0
  for (const p of cuts(a)) {
    let best = Infinity
    const pi = Math.floor(p.x / CELL), pj = Math.floor(p.y / CELL)
    for (let i = pi - 1; i <= pi + 1; i++) {
      for (let j = pj - 1; j <= pj + 1; j++) {
        for (const s of grid.get(key(i, j)) ?? []) best = Math.min(best, pointToSegment(p, s))
      }
    }
    if (best > CELL) for (const s of segs) best = Math.min(best, pointToSegment(p, s))
    if (best > worst) worst = best
  }
  return worst
}

/** Distance from a point to the boss as a solid box (0 inside it). */
function distanceToBoss(x: number, y: number, z: number): number {
  const ox = PLACEMENT.position.x, oy = PLACEMENT.position.y
  const dx = Math.max(BOSS.x0 + ox - x, 0, x - (BOSS.x1 + ox))
  const dy = Math.max(BOSS.y0 + oy - y, 0, y - (BOSS.y1 + oy))
  const dz = Math.max(FLOOR_Z - z, 0, z - BOSS_TOP_Z)
  return Math.hypot(dx, dy, dz)
}

let built: BuiltBody

beforeAll(async () => {
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
})

describe('WO-1959 pencil finish cuts a modeled body', () => {
  it('computes a real toolpath on a Model-screen block with a boss, running along the inside corner where the boss meets the floor', async () => {
    expect(built.modeled.format).toBe('model')
    const moves = await computeReady(built.modeled)
    const cut = cuts(moves)
    expect(cut.length).toBeGreaterThan(20)
    expect(bridge.cam3dCalls).toBeGreaterThan(0)

    const ox = PLACEMENT.position.x
    const oy = PLACEMENT.position.y
    const sample = (label: string, pts: ToolpathMove[]) => {
      const picks = [0, Math.floor(pts.length / 2), pts.length - 1].map((i) => pts[i])
      console.log(`[WO-1959] ${label}: ${pts.length} points; samples ` +
        picks.map((p) => `(${p.x.toFixed(3)}, ${p.y.toFixed(3)}, ${p.z.toFixed(3)})`).join(' '))
    }
    sample('all cuts', cut)
    // No cut ever puts the ball inside the boss: its centre (tip + R) is never
    // closer than R to the boss solid (the drop cutter's guarantee, checked on
    // the placed part - a dropped or doubled Model Item pose moves the path
    // 10 / 5 mm and fails here).
    let closest = Infinity
    for (const m of cut) closest = Math.min(closest, distanceToBoss(m.x, m.y, m.z + R))
    console.log(`[WO-1959] closest ball centre to the boss: ${closest.toFixed(4)} mm (R ${R})`)
    expect(closest).toBeGreaterThanOrEqual(R - 1e-3)

    // The pass is the inside corner: the tip sits on the floor and the ball
    // centre is one radius off the boss, so the ball touches the floor and a
    // boss wall at once. The pencil grid is one tolerance cell, so the pass
    // sits within a cell of the true two-contact line (a cell diagonal round
    // the boss's outer corners).
    const CELL = TOLERANCE * Math.SQRT2
    const inCorner = (m: ToolpathMove) =>
      Math.abs(m.z - FLOOR_Z) <= TOLERANCE && Math.abs(distanceToBoss(m.x, m.y, m.z + R) - R) <= CELL
    const corner = cut.filter(inCorner)
    const lifted = cut.filter((m) => !inCorner(m))
    for (const m of lifted) {
      console.log(`[WO-1959] off-corner cut (${m.x.toFixed(3)}, ${m.y.toFixed(3)}, ${m.z.toFixed(3)}), ` +
        `ball centre ${distanceToBoss(m.x, m.y, m.z + R).toFixed(4)} mm from the boss`)
    }
    console.log(`[WO-1959] ${corner.length} of ${cut.length} cut points on the inside corner`)
    // A pencil sample that lands exactly one radius from a boss edge reads the
    // edge as touching and lifts the ball onto it (the same point, to 1e-14 mm,
    // on the imported STL twin below: a pencil-engine trait, not this route).
    // It never gouges (above); it is reported in the WO result.
    expect(corner.length).toBeGreaterThanOrEqual(Math.floor(cut.length * 0.98))

    // The pass runs round all four inside corners. The linker's ramp entry
    // (role 'lead_in') descends ALONG the pass, so the corner's XY track is the
    // ramp plus the cut: that track stays one radius (within a cell) off the
    // boss footprint and covers every wall end to end.
    const track = moves.filter((m) => m.type !== 'rapid' && (m.role === 'cut' || m.role === 'lead_in'))
    const xyToBoss = (m: ToolpathMove) => Math.hypot(
      Math.max(BOSS.x0 + ox - m.x, 0, m.x - (BOSS.x1 + ox)),
      Math.max(BOSS.y0 + oy - m.y, 0, m.y - (BOSS.y1 + oy)))
    for (const m of track) {
      expect(xyToBoss(m)).toBeGreaterThanOrEqual(R - 1e-3)
      expect(xyToBoss(m)).toBeLessThanOrEqual(R + CELL)
    }
    const side = {
      west: track.filter((m) => m.x < BOSS.x0 + ox),
      east: track.filter((m) => m.x > BOSS.x1 + ox),
      south: track.filter((m) => m.y < BOSS.y0 + oy),
      north: track.filter((m) => m.y > BOSS.y1 + oy),
    }
    const along = { west: 'y', east: 'y', south: 'x', north: 'x' } as const
    const span = {
      west: [BOSS.y0 + oy, BOSS.y1 + oy], east: [BOSS.y0 + oy, BOSS.y1 + oy],
      south: [BOSS.x0 + ox, BOSS.x1 + ox], north: [BOSS.x0 + ox, BOSS.x1 + ox],
    } as const
    for (const name of ['west', 'east', 'south', 'north'] as const) {
      const pts = side[name]
      const vs = pts.map((m) => m[along[name]])
      const lo = vs.reduce((p, v) => Math.min(p, v), Infinity)
      const hi = vs.reduce((p, v) => Math.max(p, v), -Infinity)
      sample(`${name} corner track`, pts)
      console.log(`[WO-1959] ${name} corner track: ${along[name]} ${lo.toFixed(3)} .. ${hi.toFixed(3)} ` +
        `(boss wall ${span[name][0]} .. ${span[name][1]})`)
      expect(pts.length, name).toBeGreaterThan(10)
      expect(lo, name).toBeLessThanOrEqual(span[name][0])
      expect(hi, name).toBeGreaterThanOrEqual(span[name][1])
    }

    // How much of the corner is cut at floor depth, for the record (the ramp
    // descends along the closed loop; see the WO result).
    let trackLength = 0, floorLength = 0
    for (let i = 1; i < track.length; i++) {
      const d = Math.hypot(track[i].x - track[i - 1].x, track[i].y - track[i - 1].y)
      trackLength += d
      if (Math.abs(track[i].z - FLOOR_Z) <= TOLERANCE && Math.abs(track[i - 1].z - FLOOR_Z) <= TOLERANCE) floorLength += d
    }
    console.log(`[WO-1959] corner track ${trackLength.toFixed(2)} mm; at floor depth ${floorLength.toFixed(2)} mm ` +
      `(${track.length - cut.length} ramp points, ${cut.length} cut points)`)
  }, 300_000)

  it('gives the same toolpath as the same shape imported as an STL (within 0.01 mm)', async () => {
    const modeledMoves = await computeReady(built.modeled)
    const modeledHeights = currentOp().resolvedHeights
    const stlMoves = await computeReady(importedStlTwin())
    const stlHeights = currentOp().resolvedHeights

    const a = cuts(modeledMoves)
    const b = cuts(stlMoves)
    const deviation = Math.max(directedDeviation(modeledMoves, stlMoves), directedDeviation(stlMoves, modeledMoves))
    console.log(`[WO-1959] modeled ${modeledMoves.length} moves (${a.length} cut), ` +
      `STL ${stlMoves.length} moves (${b.length} cut); max deviation ${deviation.toExponential(2)} mm`)
    expect(a.length).toBeGreaterThan(20)
    expect(Math.abs(a.length - b.length)).toBeLessThanOrEqual(Math.ceil(a.length * 0.01))
    expect(deviation).toBeLessThanOrEqual(0.01)
    // Same heights for the same shape.
    expect(modeledHeights).toBeDefined()
    console.log(`[WO-1959] machine heights modeled ${JSON.stringify(modeledHeights?.machine)} STL ${JSON.stringify(stlHeights?.machine)}`)
    expect(stlHeights?.machine).toEqual(modeledHeights?.machine)
  }, 300_000)

  it('previews the same Smart Heights for the modeled body as for the STL', async () => {
    install(built.modeled)
    const modeled = await useCamStore.getState().previewParallel3dSmartHeights(SETUP_ID, currentOp())
    install(importedStlTwin())
    const stl = await useCamStore.getState().previewParallel3dSmartHeights(SETUP_ID, currentOp())
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
    expect(op.errorMessage ?? '').toMatch(/retry Pencil 3D/)
    expect(op.toolpathMoves ?? []).toHaveLength(0)
    expect(bridge.cam3dCalls).toBe(0)
  })
})
