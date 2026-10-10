// @vitest-environment jsdom
//
// WO-1969: an Engrave set to follow the surface rides the part's top surface at
// its depth below it. Driven through the production path: the store resolves
// the op, samples the modelled dome under the path, dispatches the worker
// request, and the worker's own builder (buildEngraveToolpath) turns it into
// moves that come back through the store's completion handler.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildEngraveToolpath } from '../../lib/cam/engrave2d'
import { dropPointOverTriangles } from '../../cam3d/kernel/dropCutter'
import type { EngraveWorkerPayload, ToolpathMove } from '../../lib/cam/types'
import { buildEngraveSmartHeightIntent } from '../../lib/cam/smartHeights'
import { useCamStore } from '../../store'
import type {
  BoundingBox,
  HeightIntentV1,
  ImportedGeometry,
  Operation,
  PhysicalStock,
  Project,
  SceneStock,
  Setup,
  Tool,
  Vec3,
  WCS,
} from '../../types'

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

// A spherical cap: sphere radius 40 centred 20 below the table, so the dome
// stands 20 mm tall at the origin and meets Z 0 at radius ~34.64. Closed with
// a flat bottom disc so it is a real solid.
const SPHERE_R = 40
const SPHERE_CZ = -20
const BASE_R = Math.sqrt(SPHERE_R ** 2 - SPHERE_CZ ** 2)

function domeMesh(rings = 48, segments = 128): { positions: number[]; indices: number[] } {
  const positions: number[] = [0, 0, SPHERE_R + SPHERE_CZ]
  for (let r = 1; r <= rings; r++) {
    const radius = (BASE_R * r) / rings
    const z = r === rings ? 0 : Math.sqrt(SPHERE_R ** 2 - radius ** 2) + SPHERE_CZ
    for (let s = 0; s < segments; s++) {
      const a = (2 * Math.PI * s) / segments
      positions.push(radius * Math.cos(a), radius * Math.sin(a), z)
    }
  }
  const ring = (r: number, s: number) => 1 + (r - 1) * segments + (s % segments)
  const indices: number[] = []
  for (let s = 0; s < segments; s++) indices.push(0, ring(1, s), ring(1, s + 1))
  for (let r = 1; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      indices.push(ring(r, s), ring(r + 1, s), ring(r + 1, s + 1))
      indices.push(ring(r, s), ring(r + 1, s + 1), ring(r, s + 1))
    }
  }
  const bottom = positions.length / 3
  positions.push(0, 0, 0)
  for (let s = 0; s < segments; s++) indices.push(bottom, ring(rings, s + 1), ring(rings, s))
  return { positions, indices }
}

const DOME = domeMesh()

/** The dome's real surface height under (x, y): a pinpoint dropped on every triangle. */
function surfaceAt(x: number, y: number): number {
  return dropPointOverTriangles('flat', 0.001, x, y, -1000, DOME.positions, DOME.indices)
}

const stock: PhysicalStock = {
  id: 'stock-1', name: 'Stock 1', mode: 'explicit',
  bounds: bbox({ x: -60, y: -60, z: 0 }, { x: 60, y: 60, z: 25 }),
  position: { x: -60, y: -60, z: 0 },
} as PhysicalStock

function dome(): ImportedGeometry {
  return {
    id: 'dome-1', name: 'Dome', filename: '', type: 'model', format: 'model', loaded: true,
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    boundingBox: bbox({ x: -BASE_R, y: -BASE_R, z: 0 }, { x: BASE_R, y: BASE_R, z: 20 }),
    modelItemId: 'item-1', stockId: stock.id,
    modelBody: {
      ref: { bodyId: 'body-1', stableIds: [], version: 1 },
      display: {
        positions: DOME.positions, normals: [], indices: DOME.indices,
        edgePositions: [], edgeOffsets: [],
        bbox: { min: [-BASE_R, -BASE_R, 0], max: [BASE_R, BASE_R, 20] },
      },
    },
  } as unknown as ImportedGeometry
}

function drawing(from: { x: number; y: number }, to: { x: number; y: number }): ImportedGeometry {
  return {
    id: 'drawing-1', name: 'Drawing 1', filename: 'drawing.dxf', type: 'dxf', format: 'dxf',
    boundingBox: bbox({ x: from.x, y: from.y, z: 0 }, { x: to.x, y: to.y, z: 0 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    loaded: true, stockId: stock.id,
    loops: [{ id: 'line-1', layerId: 'paths', points: [from, to], closed: false, type: 'open' }],
    layers2d: [{ id: 'paths', name: 'Paths', color: '#fff', visible: true }],
  } as unknown as ImportedGeometry
}

const tool: Tool = {
  id: 'vbit-1', name: '90 degree V-bit', type: 'v_bit', diameter: 6,
  tipDiameter: 0.2, angleFromAxisDeg: 45,
  fluteLength: 6, shankDiameter: 6, overallLength: 50, numberOfFlutes: 2,
  material: 'carbide', coating: 'none', notes: '',
  feedsAndSpeeds: { default: { rpm: 12000, feedRate: 600, plungeRate: 200, depthOfCut: 1, stepover: 1 } },
} as Tool

const safety: Pick<HeightIntentV1, 'clearance' | 'retract' | 'feed'> = {
  clearance: { reference: 'wcs_plane', offset: 40, provenance: 'user' },
  retract: { reference: 'wcs_plane', offset: 30, provenance: 'user' },
  feed: { reference: 'wcs_plane', offset: 25, provenance: 'user' },
}

const DEPTH = 0.3
const TOLERANCE = 0.01

function operation(followSurface: boolean, stepdown = 2): Operation {
  return {
    id: 'engrave-1', name: 'Engrave 1', type: 'engrave', enabled: true, status: 'pending',
    toolId: tool.id, geometrySelections: ['line-1'],
    heights: {
      clearanceHeight: -999, clearanceHeightMode: 'absolute',
      retractHeight: -999, feedHeight: -999,
      topHeight: -999, topHeightMode: 'absolute',
      bottomHeight: 999, bottomHeightMode: 'absolute',
    },
    smartHeight: {
      kind: 'smart_v2',
      intent: buildEngraveSmartHeightIntent({
        setupId: 'setup-1', safetyIntent: safety,
        datumReference: 'wcs_plane', datumOffsetMm: 20,
        axialOffsetMm: 0, depth: { kind: 'explicit', depthMm: DEPTH },
        followSurface,
        scope: { geometryIds: ['drawing-1'], loopIds: ['line-1'], includeOpen: true, includeClosed: false },
      }),
    },
    passes: {
      stepdown, stepover: 1, stockToLeave: 0,
      floorStockToLeave: 0, finishPasses: 1, springPasses: 0,
    },
    linking: {
      entryType: 'plunge', rampAngle: 0, rampLength: 0,
      leadInRadius: 0, leadOutRadius: 0,
      retractType: 'full', transitionType: 'safe_height',
    },
    params: {
      geometryId: 'drawing-1', loopIds: ['line-1'], includeOpen: true, includeClosed: false,
      mode: 'trace', depthModel: 'constant', side: 'center', sideOffset: 0,
      axialOffset: 0, targetLineWidth: 0, useWidthForDepth: false,
      direction: 'as_drawn', heightReference: 'wcs_plane', planeOffset: 20,
      tolerance: TOLERANCE,
    },
  } as unknown as Operation
}

function setup(op: Operation): Setup {
  return {
    id: 'setup-1', name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54,
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 },
      zAxis: { x: 0, y: 0, z: 1 }, stockId: stock.id,
    } as WCS,
    stock: {
      type: 'rectangular', width: 120, height: 120, depth: 25,
      offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum',
    },
    operations: [op], notes: '',
  } as Setup
}

const sceneStock: SceneStock = {
  mode: 'fixed', autoOffsetXY: 0, autoOffsetZTop: 0,
  fixedWidth: 120, fixedHeight: 120, fixedDepth: 25, fixedStocks: [],
} as SceneStock

describe('WO-1969: surface-following Engrave through the store', () => {
  let originalWorker: typeof Worker | undefined
  let requests: Array<{ type: string; payload: EngraveWorkerPayload }>

  beforeEach(() => {
    requests = []
    originalWorker = globalThis.Worker
    // The toolpath worker, minus the thread: the same builder it runs for
    // COMPUTE_ENGRAVE, answering through the store's own completion handler.
    ;(globalThis as { Worker?: unknown }).Worker = class {
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: ((event: ErrorEvent) => void) | null = null
      postMessage(data: { type: string; payload: EngraveWorkerPayload }): void {
        requests.push(data)
        const payload = structuredClone(data.payload)
        queueMicrotask(() => this.onmessage?.({
          data: { type: 'TOOLPATH_COMPLETE', opId: payload.opId, moves: buildEngraveToolpath(payload), computeTimeMs: 1 },
        } as MessageEvent))
      }
      terminate(): void { /* no-op */ }
    }
    ;(window as unknown as Record<string, unknown>).__cncViewport = {
      getStockBounds: () => ({ min: { x: -60, y: -60, z: 0 }, max: { x: 60, y: 60, z: 25 } }),
    }
  })

  afterEach(() => {
    ;(globalThis as { Worker?: unknown }).Worker = originalWorker
    delete (window as unknown as Record<string, unknown>).__cncViewport
    vi.restoreAllMocks()
  })

  function load(op: Operation, path: ImportedGeometry): void {
    useCamStore.setState(state => ({
      toolLibrary: [tool],
      consoleEvents: [],
      project: {
        ...state.project,
        geometry: [dome(), path], stocks: [stock], sceneStock,
        modelItemPlacements: [{ modelItemId: 'item-1', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }],
        setups: [setup(op)], activeSetupId: 'setup-1',
      } as Project,
    }))
  }

  async function generate(op: Operation, path: ImportedGeometry): Promise<Operation> {
    load(op, path)
    await useCamStore.getState().computeOperationToolpath('setup-1', op.id)
    return useCamStore.getState().project.setups[0].operations[0]
  }

  const cutting = (moves: readonly ToolpathMove[]) =>
    moves.filter(move => move.type === 'feed' && move.role === 'cut')

  it('rides a line across a dome at the depth below the surface under every point', async () => {
    const result = await generate(operation(true), drawing({ x: -30, y: 0 }, { x: 30, y: 0 }))
    expect(result.errorMessage).toBeUndefined()
    expect(result.status).toBe('ready')
    const cuts = cutting(result.toolpathMoves ?? [])
    expect(cuts.length).toBeGreaterThan(60)

    // Every cutting point sits DEPTH below the real surface under it.
    let worst = 0
    for (const move of cuts) worst = Math.max(worst, Math.abs(move.z - (surfaceAt(move.x, move.y) - DEPTH)))
    expect(worst).toBeLessThanOrEqual(TOLERANCE)

    // And the straight feed between two points stays within tolerance too:
    // the sampling is fine enough that the chord never leaves the surface band.
    let worstBetween = 0
    for (let i = 1; i < cuts.length; i++) {
      const a = cuts[i - 1]
      const b = cuts[i]
      for (const t of [0.25, 0.5, 0.75]) {
        const x = a.x + (b.x - a.x) * t
        const y = a.y + (b.y - a.y) * t
        const z = a.z + (b.z - a.z) * t
        worstBetween = Math.max(worstBetween, Math.abs(z - (surfaceAt(x, y) - DEPTH)))
      }
    }
    expect(worstBetween).toBeLessThanOrEqual(TOLERANCE)

    // Not one fixed Z: the cut follows 20 mm of dome rise and fall.
    const zs = cuts.map(move => move.z)
    expect(Math.max(...zs) - Math.min(...zs)).toBeGreaterThan(10)
    expect(Math.max(...zs)).toBeCloseTo(20 - DEPTH, 1)

    // The height envelope is the sampled surface's span: Top at its highest
    // point, Bottom the depth below its lowest - every cut lies inside it.
    const wcs = result.resolvedHeights!.wcs
    expect(wcs.top).toBeCloseTo(surfaceAt(0, 0), 2)
    expect(wcs.bottom).toBeLessThanOrEqual(Math.min(...zs) + 1e-9)
    expect(wcs.bottom).toBeGreaterThan(Math.min(...zs) - 2)
    expect(wcs.feed).toBe(25)

    // Plunge lands on the surface under the start, not at a flat plane.
    const plunge = (result.toolpathMoves ?? []).find(move => move.role === 'plunge')!
    expect(plunge.z).toBeCloseTo(surfaceAt(-30, 0) - DEPTH, 2)
    expect(requests[0].payload.params).toMatchObject({ axialOffset: 0, useWidthForDepth: false })

    // On the part the whole way: nothing to say on the console.
    expect(useCamStore.getState().consoleEvents.filter(event => event.message.includes('runs off the part')))
      .toHaveLength(0)
  })

  it('steps down in passes measured from the surface, the last at the full depth', async () => {
    const result = await generate(operation(true, 0.2), drawing({ x: -20, y: 5 }, { x: 25, y: -5 }))
    expect(result.status).toBe('ready')
    const moves = result.toolpathMoves ?? []
    const plunges = moves.filter(move => move.role === 'plunge')
    expect(plunges).toHaveLength(2)
    expect(plunges[0].z).toBeCloseTo(surfaceAt(-20, 5) - 0.2, 2)
    expect(plunges[1].z).toBeCloseTo(surfaceAt(-20, 5) - DEPTH, 2)
    const lastPass = moves.slice(moves.indexOf(plunges[1]))
    for (const move of cutting(lastPass)) {
      expect(Math.abs(move.z - (surfaceAt(move.x, move.y) - DEPTH))).toBeLessThanOrEqual(TOLERANCE)
    }
  })

  it('holds the last surface height where the path runs off the part, and says so once', async () => {
    const result = await generate(operation(true), drawing({ x: -50, y: 5 }, { x: 50, y: 5 }))
    expect(result.status).toBe('ready')
    expect(result.errorMessage).toBeUndefined()
    const cuts = cutting(result.toolpathMoves ?? [])
    const edge = Math.sqrt(BASE_R ** 2 - 25)
    const off = cuts.filter(move => Math.abs(move.x) > edge + 0.5)
    const on = cuts.filter(move => Math.abs(move.x) < edge - 0.5)
    expect(off.length).toBeGreaterThan(0)
    for (const move of on) {
      expect(Math.abs(move.z - (surfaceAt(move.x, move.y) - DEPTH))).toBeLessThanOrEqual(TOLERANCE)
    }
    // Off the part: no dive to the table, no jump up - it holds the height of
    // the surface where it left (the dome meets Z 0 at its rim).
    for (const move of off) {
      expect(move.z).toBeGreaterThanOrEqual(-DEPTH - 0.05)
      expect(move.z).toBeLessThanOrEqual(-DEPTH + 0.5)
    }
    const lines = useCamStore.getState().consoleEvents.filter(event => event.message.includes('runs off the part'))
    expect(lines).toHaveLength(1)
    expect(lines[0].message).toBe(
      '"Engrave 1": part of the engraved path runs off the part, so it stays at the last surface height there.',
    )
  })

  it('leaves constant-depth Engrave at its one flat Z (control)', async () => {
    const result = await generate(operation(false), drawing({ x: -30, y: 0 }, { x: 30, y: 0 }))
    expect(result.status).toBe('ready')
    const zs = new Set(cutting(result.toolpathMoves ?? []).map(move => move.z))
    expect([...zs]).toEqual([20 - DEPTH])
    expect((requests[0].payload.params as unknown as Record<string, unknown>).surfaceFollow).toBeUndefined()
  })
})
