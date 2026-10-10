// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildChamferToolpath } from '../../lib/cam/chamfer2d'
import type { ChamferWorkerPayload } from '../../lib/cam/types'
import {
  buildChamferSmartHeightIntent,
  deriveChamferEdgeBindings,
} from '../../lib/cam/smartHeights'
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
    center: {
      x: (min.x + max.x) / 2,
      y: (min.y + max.y) / 2,
      z: (min.z + max.z) / 2,
    },
  }
}

const stock: PhysicalStock = {
  id: 'stock-1', name: 'Stock 1', mode: 'explicit',
  bounds: bbox({ x: -10, y: -10, z: 0 }, { x: 30, y: 30, z: 20 }),
  position: { x: -10, y: -10, z: 0 },
} as PhysicalStock

function chamferGeometry(points?: Array<{ x: number; y: number }>): ImportedGeometry {
  return {
    id: 'part-1', name: 'Part 1', filename: 'part.step', type: 'brep', format: 'step',
    boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: 10, y: 10, z: 12 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    loaded: true, stockId: stock.id,
    loops: [{
      id: 'edge-1', layerId: 'edges',
      points: points ?? [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
      closed: true, type: 'contour', area: 100,
    }],
    layers2d: [{
      id: 'edges', name: 'Edges', color: '#fff', visible: true, frame: 'geometry_local',
      projectionPlane: {
        origin: { x: 0, y: 0, z: 12 },
        normal: { x: 0, y: 0, z: 1 },
        u: { x: 1, y: 0, z: 0 },
        v: { x: 0, y: 1, z: 0 },
      },
    }],
  } as unknown as ImportedGeometry
}

const tool: Tool = {
  id: 'chamfer-tool', name: '90 degree chamfer mill', type: 'chamfer_mill', diameter: 10,
  tipDiameter: 0, angleFromAxisDeg: 45,
  fluteLength: 12, shankDiameter: 10, overallLength: 50, numberOfFlutes: 3,
  material: 'carbide', coating: 'none', notes: '',
  feedsAndSpeeds: { default: { rpm: 8000, feedRate: 300, plungeRate: 120, depthOfCut: 2, stepover: 1 } },
} as Tool

const safety: Pick<HeightIntentV1, 'clearance' | 'retract' | 'feed'> = {
  clearance: { reference: 'wcs_plane', offset: 30, provenance: 'user' },
  retract: { reference: 'wcs_plane', offset: 25, provenance: 'user' },
  feed: { reference: 'wcs_plane', offset: 22, provenance: 'user' },
}

function operation(geometry: ImportedGeometry): Operation {
  const derived = deriveChamferEdgeBindings([geometry], ['edge-1'])
  if (!derived.ok) throw new Error(derived.refusals[0].message)
  const features = derived.bindings.map(binding => ({
    loopId: binding.loopId,
    feature: binding.feature,
    fingerprint: binding.evidenceFingerprint,
  }))
  return {
    id: 'chamfer-1', name: 'Chamfer 1', type: 'chamfer', enabled: true, status: 'pending',
    toolId: tool.id, geometrySelections: ['edge-1'],
    heights: {
      clearanceHeight: -999, clearanceHeightMode: 'absolute',
      retractHeight: -999, feedHeight: -999,
      topHeight: -999, topHeightMode: 'absolute',
      bottomHeight: -999, bottomHeightMode: 'absolute',
    },
    smartHeight: {
      kind: 'smart_v2',
      intent: buildChamferSmartHeightIntent({
        setupId: 'setup-1', safetyIntent: safety,
        datumReference: 'wcs_plane', datumOffsetMm: 12,
        chamferWidthMm: 1, tipOffsetMm: 2, features,
      }),
    },
    passes: {
      stepdown: 2, stepover: 1, stockToLeave: 0,
      floorStockToLeave: 0, finishPasses: 1, springPasses: 0,
    },
    linking: {
      entryType: 'plunge', rampAngle: 0, rampLength: 0,
      leadInRadius: 0, leadOutRadius: 0,
      retractType: 'full', transitionType: 'safe_height',
    },
    params: {
      geometryId: geometry.id, loopIds: ['edge-1'], loopSides: { 'edge-1': 'outer' },
      direction: 'climb', overlapMm: 0,
      // Deliberately stale mirrors. V2 must compile 1 and 2 from its formula.
      chamferWidth: 7, tipOffset: 3,
      heightReference: 'stock_bottom', planeOffset: -50,
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
      type: 'rectangular', width: 40, height: 40, depth: 20,
      offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum',
    },
    operations: [op], notes: '',
  } as Setup
}

const sceneStock: SceneStock = {
  mode: 'fixed', autoOffsetXY: 0, autoOffsetZTop: 0,
  fixedWidth: 40, fixedHeight: 40, fixedDepth: 20, fixedStocks: [],
} as SceneStock

describe('Chamfer Smart Height V2 store dispatch', () => {
  let originalWorker: typeof Worker | undefined
  let requests: Array<{ type: string; payload: ChamferWorkerPayload }>

  beforeEach(() => {
    requests = []
    originalWorker = globalThis.Worker
    ;(globalThis as { Worker?: unknown }).Worker = class {
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: ((event: ErrorEvent) => void) | null = null
      postMessage(data: { type: string; payload: ChamferWorkerPayload }): void {
        requests.push(data)
        queueMicrotask(() => this.onmessage?.({
          data: { type: 'TOOLPATH_COMPLETE', moves: [], computeTimeMs: 1 },
        } as MessageEvent))
      }
      terminate(): void { /* no-op */ }
    }
    ;(window as unknown as Record<string, unknown>).__cncViewport = {
      getStockBounds: () => ({ min: { x: -10, y: -10, z: 0 }, max: { x: 30, y: 30, z: 20 } }),
    }
  })

  afterEach(() => {
    ;(globalThis as { Worker?: unknown }).Worker = originalWorker
    delete (window as unknown as Record<string, unknown>).__cncViewport
    vi.restoreAllMocks()
  })

  function load(geometry: ImportedGeometry, op: Operation): void {
    useCamStore.setState(state => ({
      toolLibrary: [tool],
      project: {
        ...state.project,
        geometry: [geometry], stocks: [stock], sceneStock,
        setups: [setup(op)], activeSetupId: 'setup-1',
      } as Project,
    }))
  }

  it('previews and dispatches one formula, ignoring stale legacy height and strategy mirrors', async () => {
    const geometry = chamferGeometry()
    const op = operation(geometry)
    load(geometry, op)

    const preview = useCamStore.getState().previewChamferSmartHeights('setup-1', op)
    expect(preview.wcs).toMatchObject({ top: 12, bottom: 9, feed: 22, retract: 25, clearance: 30 })
    expect(requests).toHaveLength(0)

    await useCamStore.getState().computeOperationToolpath('setup-1', op.id)
    expect(requests).toHaveLength(1)
    expect(requests[0].type).toBe('COMPUTE_CHAMFER')
    expect(requests[0].payload.heights).toMatchObject({ topHeight: 12, bottomHeight: 9 })
    expect(requests[0].payload.params).toMatchObject({ chamferWidth: 1, tipOffset: 2 })
    expect(useCamStore.getState().project.setups[0].operations[0].resolvedHeights?.wcs)
      .toMatchObject({ top: 12, bottom: 9 })
  })

  it('keeps the finished chamfer size while moving contact off the zero-radius tip', async () => {
    const geometry = chamferGeometry()
    const op = operation(geometry)
    load(geometry, op)
    await useCamStore.getState().computeOperationToolpath('setup-1', op.id)

    const payload = requests[0].payload
    const outerMoves = buildChamferToolpath(payload)
    const outerCut = outerMoves.filter(move => move.role === 'cut')
    expect(outerCut.length).toBeGreaterThan(0)
    expect(new Set(outerCut.map(move => move.z))).toEqual(new Set([9]))
    expect(Math.min(...outerCut.map(move => move.x))).toBeCloseTo(-2, 9)
    expect(Math.max(...outerCut.map(move => move.x))).toBeCloseTo(12, 9)
    expect(Math.min(...outerCut.map(move => move.y))).toBeCloseTo(-2, 9)
    expect(Math.max(...outerCut.map(move => move.y))).toBeCloseTo(12, 9)

    const innerMoves = buildChamferToolpath({
      ...payload,
      params: { ...payload.params, loopSides: { 'edge-1': 'inner' } },
    })
    const innerCut = innerMoves.filter(move => move.role === 'cut')
    expect(Math.min(...innerCut.map(move => move.x))).toBeCloseTo(2, 9)
    expect(Math.max(...innerCut.map(move => move.x))).toBeCloseTo(8, 9)
    expect(Math.min(...innerCut.map(move => move.y))).toBeCloseTo(2, 9)
    expect(Math.max(...innerCut.map(move => move.y))).toBeCloseTo(8, 9)

    const halfAngleRad = 45 * Math.PI / 180
    const contactRadius = payload.params.tipOffset * Math.tan(halfAngleRad)
    const wallContactZ = 9 + contactRadius / Math.tan(halfAngleRad)
    expect(contactRadius).toBeCloseTo(2, 9)
    expect(wallContactZ).toBeCloseTo(11, 9)
    expect(12 - wallContactZ).toBeCloseTo(payload.params.chamferWidth, 9)
  })

  it('refuses replaced edge topology before worker dispatch', async () => {
    const authored = chamferGeometry()
    const op = operation(authored)
    const replaced = chamferGeometry([
      { x: 0, y: 0 }, { x: 11, y: 0 }, { x: 11, y: 10 }, { x: 0, y: 10 },
    ])
    load(replaced, op)

    await useCamStore.getState().computeOperationToolpath('setup-1', op.id)
    expect(requests).toHaveLength(0)
    expect(useCamStore.getState().project.setups[0].operations[0].errorMessage)
      .toMatch(/edge scope changed|feature identity is stale/)
  })
})
