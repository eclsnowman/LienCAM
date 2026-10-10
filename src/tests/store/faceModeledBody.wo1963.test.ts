// WO-1963: Face cuts a body built in the Model screen.
//
// The body is WO-1954's block (60 x 40 x 20), built by the REAL modeling
// kernel (createLocalGeomService - the OCCT engine the Model workbench runs)
// and tessellated by the workbench's own display pass (progressiveTessellate
// -> modelBodyDisplayFromCached -> buildModelBodyGeometry), so the CAM row this
// file faces is the row the Model screen would publish. The Face operation is
// computed through the production entry point, computeOperationToolpath, and
// the Worker global forwards into the REAL toolpathWorker handler (the
// int17aR3OpCompute.test.ts harness), so the moves below are the real facing
// builder's output. Nothing about the strategy is stubbed.
//
// The equivalence case takes the SAME kernel triangles as an imported STL
// placed where the modeled body sits, and gives it the loops the Design Tree's
// "Project STL" action gives an STL: projectSTLToLoopsInPlane over the part's
// world triangles, landed through the store's appendGeometryProjection on a
// world-baked layer. Only the viewport's collectWorldPositions is stood in for
// (the placed triangles are computed here, as the viewport holds them).

import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest'
import { createLocalGeomService, type GeomClient } from '../../geom'
import type { BodyHandle, ProfileRegion } from '../../geom/geom-service'
import { GeometryCache } from '../../viewport3d/GeometryCache'
import { progressiveTessellate } from '../../viewport3d/progressiveTessellate'
import { modelBodyDisplayFromCached } from '../../viewport3d/modelBodyDisplay'
import { buildModelBodyGeometry } from '../../lib/cam/modelBodyAdapter'
import { buildFaceSmartHeightIntent } from '../../lib/cam/smartHeights'
import { buildPlaneFrame, projectSTLToLoopsInPlane } from '../../lib/geometry/stlProjection'
import { useCamStore } from '../../store'
import type { WorkerRequestMsg, WorkerResponseMsg } from '../../lib/cam/types'
import type {
  HeightIntentV1,
  ImportedGeometry,
  Layer2D,
  ModelItemPlacementRecord,
  Operation,
  PhysicalStock,
  Project,
  Setup,
  Tool,
  ToolpathMove,
  WCS,
} from '../../types'

// --- the part: WO-1954's 60 x 40 x 20 block ----------------------------------
const BLOCK = { x0: 0, y0: 0, x1: 60, y1: 40, height: 20 }
const TOP_Z = BLOCK.height
// The Model Item sits away from the origin, so a pose that is dropped or
// applied twice shows up in every world coordinate below.
const PLACEMENT: ModelItemPlacementRecord = {
  modelItemId: 'item-1',
  position: { x: 10, y: 5, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
}
const WORLD = {
  minX: BLOCK.x0 + PLACEMENT.position.x, minY: BLOCK.y0 + PLACEMENT.position.y,
  maxX: BLOCK.x1 + PLACEMENT.position.x, maxY: BLOCK.y1 + PLACEMENT.position.y,
}

const SETUP_ID = 'setup-wo1963'
const STOCK_ID = 'stock-wo1963'
const OP_ID = 'face-wo1963'
const STL_GEO_ID = 'stl-wo1963'
// One millimetre of material above the block top: the Face takes the stock
// down to the block's top face.
const STOCK_TOP_Z = TOP_Z + 1

const endMill6: Tool = {
  id: 'wo1963-em-6', name: '6 mm end mill', type: 'flat_end_mill', diameter: 6, fluteLength: 20,
  shankDiameter: 6, overallLength: 50, numberOfFlutes: 2, material: 'carbide', coating: 'none',
  notes: '', feedsAndSpeeds: {},
} as unknown as Tool

const stock: PhysicalStock = {
  id: STOCK_ID, name: 'WO-1963 block stock', mode: 'explicit',
  bounds: {
    min: { x: WORLD.minX, y: WORLD.minY, z: 0 },
    max: { x: WORLD.maxX, y: WORLD.maxY, z: STOCK_TOP_Z },
    size: { x: WORLD.maxX - WORLD.minX, y: WORLD.maxY - WORLD.minY, z: STOCK_TOP_Z },
    center: { x: (WORLD.minX + WORLD.maxX) / 2, y: (WORLD.minY + WORLD.maxY) / 2, z: STOCK_TOP_Z / 2 },
  },
  position: { x: 0, y: 0, z: 0 },
} as PhysicalStock

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
  positions: number[]
  indices: number[]
}

/** Model the block in the real kernel and publish it as the Model screen does. */
async function buildBlock(): Promise<BuiltBody> {
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
    await progressiveTessellate(client, cache, 'BLOCK', block.body as BodyHandle)
    const cached = cache.get('BLOCK')!
    const display = modelBodyDisplayFromCached(cached)
    const modeled = {
      ...buildModelBodyGeometry(
        { bodyId: 'BLOCK', lineageId: 'BLOCK', name: 'Block' },
        {
          bodyId: 'BLOCK', lineageId: 'BLOCK', version: cached.version,
          stableIds: [...cached.faceIds, ...cached.edgeIds], display,
        },
        undefined,
        PLACEMENT.modelItemId,
      ),
      stockId: STOCK_ID,
    }
    return { modeled, positions: [...display.positions], indices: [...display.indices] }
  } finally {
    cache.disposeAll()
    await client.terminate().catch(() => undefined)
  }
}

/** The same shape as an imported STL, placed where the modeled body sits. The
 *  STL importer recentres the mesh (xy centroid on the origin, base on z 0), so
 *  its position is the placed part's xy centre. */
function importedStlTwin(): ImportedGeometry {
  return {
    id: STL_GEO_ID,
    name: 'Block.stl',
    filename: 'block.stl',
    type: 'mesh',
    format: 'stl',
    loaded: true,
    position: {
      x: (WORLD.minX + WORLD.maxX) / 2,
      y: (WORLD.minY + WORLD.maxY) / 2,
      z: PLACEMENT.position.z,
    },
    rotation: { x: 0, y: 0, z: 0 },
    boundingBox: {
      min: { x: WORLD.minX, y: WORLD.minY, z: 0 },
      max: { x: WORLD.maxX, y: WORLD.maxY, z: TOP_Z },
      size: { x: WORLD.maxX - WORLD.minX, y: WORLD.maxY - WORLD.minY, z: TOP_Z },
      center: { x: (WORLD.minX + WORLD.maxX) / 2, y: (WORLD.minY + WORLD.maxY) / 2, z: TOP_Z / 2 },
    },
    stockId: STOCK_ID,
    loops: [],
    layers2d: [],
  } as unknown as ImportedGeometry
}

/** What the Design Tree's "Project STL" does: slice the placed triangles with a
 *  horizontal plane, then land the loops on the part's top face as a new
 *  world-baked projection layer (DesignTree.tsx handleProjectSTL). */
function projectStlTwin(body: BuiltBody): void {
  const { positions, indices } = body
  const world = new Float32Array(indices.length * 3)
  for (let t = 0; t < indices.length; t++) {
    const i = indices[t] * 3
    world[t * 3] = positions[i] + PLACEMENT.position.x
    world[t * 3 + 1] = positions[i + 1] + PLACEMENT.position.y
    world[t * 3 + 2] = positions[i + 2] + PLACEMENT.position.z
  }
  const tol = useCamStore.getState().appSettings.projectionToleranceDefault ?? 0.02
  const slice = projectSTLToLoopsInPlane(world, {
    planeNormal: { x: 0, y: 0, z: 1 },
    planeOrigin: { x: 0, y: 0, z: TOP_Z / 2 },
    simplificationTolerance: tol,
    minPerimeter: Math.max(0.1, tol * 6),
  })
  expect(slice.loops.length).toBe(1)
  const normal = { x: 0, y: 0, z: 1 }
  const { xAxis, yAxis } = buildPlaneFrame(normal)
  const layer: Layer2D = {
    id: 'wo1963-proj', name: 'STL Projection 1', color: '#00e5ff', visible: true,
    projectionPlane: {
      origin: { x: (WORLD.minX + WORLD.maxX) / 2, y: (WORLD.minY + WORLD.maxY) / 2, z: TOP_Z },
      xAxis, yAxis, normal,
    },
  }
  useCamStore.getState().appendGeometryProjection(
    STL_GEO_ID, slice.loops.map((loop) => ({ ...loop, layerId: layer.id })), layer,
  )
}

const safetyIntent: Pick<HeightIntentV1, 'clearance' | 'retract' | 'feed'> = {
  clearance: { reference: 'wcs_plane', offset: STOCK_TOP_Z + 15, provenance: 'user' },
  retract: { reference: 'wcs_plane', offset: STOCK_TOP_Z + 5, provenance: 'user' },
  feed: { reference: 'wcs_plane', offset: STOCK_TOP_Z + 2, provenance: 'user' },
}

/** A Face over the picked part's outline, taking the stock down to the block top. */
function faceOperation(geoId: string): Operation {
  return {
    id: OP_ID, name: 'Face block top', type: 'face', enabled: true, status: 'pending',
    toolId: endMill6.id, geometrySelections: [],
    heights: {
      clearanceHeight: -999, clearanceHeightMode: 'absolute',
      retractHeight: -999, feedHeight: -999,
      topHeight: -999, topHeightMode: 'absolute',
      bottomHeight: -999, bottomHeightMode: 'absolute',
    },
    smartHeight: {
      kind: 'smart_v2',
      intent: buildFaceSmartHeightIntent({
        setupId: SETUP_ID, safetyIntent, mode: 'explicit_depth',
        stockId: STOCK_ID, explicitTargetWcsMm: TOP_Z,
      }),
    },
    passes: { stepdown: 2, stepover: 4, stockToLeave: 0, floorStockToLeave: 0, finishPasses: 0, springPasses: 0 },
    linking: {
      entryType: 'plunge', rampAngle: 0, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
      retractType: 'full', transitionType: 'safe_height',
    },
    params: {
      boundarySource: 'geometry', geometryId: geoId, loopIds: [],
      stockOffset: 0, boundaryContainment: 'outside', avoidanceLoopIds: [],
      pattern: 'zigzag', passAngle: 0, direction: 'both_ways', fromOtherSide: false,
      passExtension: 0, chipThinning: false, bothSidesPerLevel: false,
      floorStockToLeave: 0, finishPass: false, entryType: 'plunge', leadInRadius: 0,
      leadOutRadius: 0, keepToolDown: false, maxStayDownDistance: 0,
      extendBeforeRetract: false, transition: 'direct', tolerance: 0.05,
    },
  } as unknown as Operation
}

function install(geo: ImportedGeometry): void {
  const setup = {
    id: SETUP_ID, name: 'WO-1963 setup',
    wcs: {
      id: `wcs-${SETUP_ID}`, label: 'G54', fixtureOffset: 54,
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      stockId: STOCK_ID,
    } as WCS,
    stock: null,
    operations: [faceOperation(geo.id)],
    notes: '',
  } as unknown as Setup
  useCamStore.setState((state) => ({
    toolLibrary: [endMill6],
    toolpathBatch: null,
    project: {
      ...state.project,
      geometry: [geo],
      setups: [setup],
      stocks: [stock],
      activeSetupId: SETUP_ID,
      modelItemPlacements: [PLACEMENT],
    } as Project,
  }))
}

const currentOp = (): Operation => useCamStore.getState().project.setups[0].operations[0]

// --- the REAL toolpath worker, driven in-process (int17aR3OpCompute harness) ---
let workerRequests: WorkerRequestMsg[] = []
let workerSelf: {
  postMessage: (m: WorkerResponseMsg) => void
  onmessage: ((e: { data: WorkerRequestMsg }) => Promise<void>) | null
}
let activeShim: { onmessage: ((e: { data: WorkerResponseMsg }) => void) | null } | null = null
let OrigWorker: typeof Worker | undefined
let built: BuiltBody

beforeAll(async () => {
  ;(globalThis as { self?: unknown }).self = {
    postMessage: (m: WorkerResponseMsg) => { activeShim?.onmessage?.({ data: m }) },
    onmessage: null,
  }
  await import('../../lib/cam/toolpathWorker')
  workerSelf = (globalThis as { self: typeof workerSelf }).self
  expect(typeof workerSelf.onmessage).toBe('function')
  built = await buildBlock()
}, 120_000)

afterAll(() => {
  delete (globalThis as { self?: unknown }).self
})

beforeEach(() => {
  workerRequests = []
  activeShim = null
  OrigWorker = (globalThis as { Worker?: typeof Worker }).Worker
  ;(globalThis as { Worker?: unknown }).Worker = class {
    onmessage: ((e: { data: WorkerResponseMsg }) => void) | null = null
    onerror: ((e: unknown) => void) | null = null
    postMessage(data: WorkerRequestMsg): void {
      workerRequests.push(data)
      activeShim = this
      void workerSelf.onmessage!({ data })
    }
    terminate(): void { activeShim = null }
  }
})

afterEach(() => {
  ;(globalThis as { Worker?: unknown }).Worker = OrigWorker
})

async function computeReady(): Promise<ToolpathMove[]> {
  await useCamStore.getState().computeOperationToolpath(SETUP_ID, OP_ID)
  const op = currentOp()
  expect(`${op.status}${op.errorMessage ? `: ${op.errorMessage}` : ''}`).toBe('ready')
  return op.toolpathMoves ?? []
}

const cuts = (moves: readonly ToolpathMove[]) =>
  moves.filter((m) => m.type === 'feed' || m.type === 'arc_cw' || m.type === 'arc_ccw')

/** The cutting segments of a toolpath: each cut move from the point before it. */
function cutSegments(moves: readonly ToolpathMove[]): [ToolpathMove, ToolpathMove][] {
  const out: [ToolpathMove, ToolpathMove][] = []
  for (let i = 1; i < moves.length; i++) {
    const m = moves[i]
    if (m.type === 'feed' || m.type === 'arc_cw' || m.type === 'arc_ccw') out.push([moves[i - 1], m])
  }
  return out
}

function pointToSegment(p: ToolpathMove, [a, b]: [ToolpathMove, ToolpathMove]): number {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z
  const len2 = dx * dx + dy * dy + dz * dz
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy + (p.z - a.z) * dz) / len2))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy), p.z - (a.z + t * dz))
}

/** Largest distance from any cut point of `a` to the cutting path of `b` (3D). */
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

describe('WO-1963 Face cuts a modeled body', () => {
  it('computes a real facing toolpath over the Model-screen block top, at the block top Z', async () => {
    expect(built.modeled.format).toBe('model')
    install(built.modeled)
    const moves = await computeReady()

    expect(workerRequests).toHaveLength(1)
    expect(workerRequests[0].type).toBe('COMPUTE_FACE')
    const cut = cuts(moves)
    expect(cut.length).toBeGreaterThan(10)
    for (const m of moves) {
      for (const axis of ['x', 'y', 'z'] as const) expect(Number.isFinite(m[axis])).toBe(true)
    }

    // The final pass lies ON the block top, and nothing cuts below it.
    const zs = cut.map((m) => m.z)
    expect(Math.min(...zs)).toBeCloseTo(TOP_Z, 6)
    const floor = cut.filter((m) => Math.abs(m.z - TOP_Z) < 1e-6)
    expect(floor.length).toBeGreaterThan(10)

    // The floor pass covers the placed block's top outline: its cutter
    // centres reach within one tool radius of every side, and stay inside
    // the outline grown by one radius (the tool edge may clear the edge).
    const R = endMill6.diameter / 2
    const xs = floor.map((m) => m.x)
    const ys = floor.map((m) => m.y)
    expect(Math.min(...xs)).toBeLessThanOrEqual(WORLD.minX + R + 1e-6)
    expect(Math.max(...xs)).toBeGreaterThanOrEqual(WORLD.maxX - R - 1e-6)
    expect(Math.min(...ys)).toBeLessThanOrEqual(WORLD.minY + R + 1e-6)
    expect(Math.max(...ys)).toBeGreaterThanOrEqual(WORLD.maxY - R - 1e-6)
    for (const m of floor) {
      expect(m.x).toBeGreaterThanOrEqual(WORLD.minX - R - 1e-6)
      expect(m.x).toBeLessThanOrEqual(WORLD.maxX + R + 1e-6)
      expect(m.y).toBeGreaterThanOrEqual(WORLD.minY - R - 1e-6)
      expect(m.y).toBeLessThanOrEqual(WORLD.maxY + R + 1e-6)
    }

    const picks = [0, Math.floor(floor.length / 2), floor.length - 1].map((i) => floor[i])
    console.log(`[WO-1963] modeled face: ${moves.length} moves, ${cut.length} cut, ${floor.length} at Z ${TOP_Z}; ` +
      `floor x ${Math.min(...xs).toFixed(3)}..${Math.max(...xs).toFixed(3)} ` +
      `y ${Math.min(...ys).toFixed(3)}..${Math.max(...ys).toFixed(3)}; samples ` +
      picks.map((p) => `(${p.x.toFixed(3)}, ${p.y.toFixed(3)}, ${p.z.toFixed(3)})`).join(' '))
    console.log(`[WO-1963] heights ${JSON.stringify(currentOp().resolvedHeights?.machine)}`)
  }, 300_000)

  it('gives the same toolpath as the same block imported as an STL (within 0.01 mm)', async () => {
    install(built.modeled)
    const modeledMoves = await computeReady()
    const modeledHeights = currentOp().resolvedHeights

    install(importedStlTwin())
    projectStlTwin(built)
    const stlMoves = await computeReady()
    const stlHeights = currentOp().resolvedHeights

    const a = cuts(modeledMoves)
    const b = cuts(stlMoves)
    const deviation = Math.max(directedDeviation(modeledMoves, stlMoves), directedDeviation(stlMoves, modeledMoves))
    console.log(`[WO-1963] modeled ${modeledMoves.length} moves (${a.length} cut), ` +
      `STL ${stlMoves.length} moves (${b.length} cut); max deviation ${deviation.toExponential(2)} mm`)
    expect(a.length).toBeGreaterThan(10)
    expect(b.length).toBe(a.length)
    expect(deviation).toBeLessThanOrEqual(0.01)
    expect(modeledHeights).toBeDefined()
    expect(stlHeights?.machine).toEqual(modeledHeights?.machine)
  }, 300_000)

  it('refuses a modeled body with no tessellation by name, before any worker request', async () => {
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
    expect(op.errorMessage ?? '').toMatch(/profile could not be derived/)
    expect(op.errorMessage ?? '').toMatch(/no tessellated geometry/)
    expect(op.toolpathMoves ?? []).toHaveLength(0)
    expect(workerRequests).toHaveLength(0)
  })
})
