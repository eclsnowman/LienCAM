// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { operationGenerationIsCurrent } from '../../lib/cam/generationFingerprint'
import { buildFaceSmartHeightIntent } from '../../lib/cam/smartHeights'
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
    min: { ...min },
    max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: {
      x: (min.x + max.x) / 2,
      y: (min.y + max.y) / 2,
      z: (min.z + max.z) / 2,
    },
  }
}

const safetyIntent: Pick<HeightIntentV1, 'clearance' | 'retract' | 'feed'> = {
  clearance: { reference: 'wcs_plane', offset: 30, provenance: 'user' },
  retract: { reference: 'wcs_plane', offset: 25, provenance: 'user' },
  feed: { reference: 'wcs_plane', offset: 20, provenance: 'user' },
}

const stock: PhysicalStock = {
  id: 'stock-wo2027',
  name: 'Stock',
  mode: 'explicit',
  bounds: bbox({ x: 0, y: 0, z: 0 }, { x: 100, y: 80, z: 20 }),
  position: { x: 0, y: 0, z: 0 },
} as PhysicalStock

const sceneStock: SceneStock = {
  mode: 'fixed',
  autoOffsetXY: 0,
  autoOffsetZTop: 0,
  fixedWidth: 100,
  fixedHeight: 80,
  fixedDepth: 20,
  fixedStocks: [],
}

function legacyRightHandTool(id: string, diameter: number): Tool {
  return {
    id,
    name: `${diameter} mm end mill`,
    type: 'flat_end_mill',
    diameter,
    fluteLength: 20,
    shankDiameter: diameter,
    overallLength: 50,
    numberOfFlutes: 2,
    material: 'carbide',
    coating: 'none',
    notes: '',
    feedsAndSpeeds: {
      default: {
        rpm: 12000,
        feedRate: 800,
        plungeRate: 200,
        depthOfCut: 2,
        stepover: diameter / 3,
      },
    },
    // Deliberately no cutHand. The production migration materializes this
    // legacy/right-hand semantic default as `cutHand: "right"` on reopen.
  } as Tool
}

function faceOperation(id: string, toolId: string): Operation {
  return {
    id,
    name: id,
    type: 'face',
    enabled: true,
    status: 'pending',
    toolId,
    geometrySelections: [],
    heights: {
      clearanceHeight: -999,
      clearanceHeightMode: 'absolute',
      retractHeight: -999,
      feedHeight: -999,
      topHeight: -999,
      topHeightMode: 'absolute',
      bottomHeight: -999,
      bottomHeightMode: 'absolute',
    },
    smartHeight: {
      kind: 'smart_v2',
      intent: buildFaceSmartHeightIntent({
        setupId: 'setup-wo2027',
        safetyIntent,
        mode: 'explicit_depth',
        stockId: stock.id,
        explicitTargetWcsMm: 10,
      }),
    },
    passes: {
      stepdown: 2,
      stepover: 2,
      stockToLeave: 0,
      floorStockToLeave: 2,
      finishPasses: 0,
      springPasses: 0,
    },
    linking: {
      entryType: 'plunge',
      rampAngle: 0,
      rampLength: 0,
      leadInRadius: 0,
      leadOutRadius: 0,
      retractType: 'full',
      transitionType: 'safe_height',
    },
    params: {
      boundarySource: 'stock',
      geometryId: '__stock__',
      loopIds: [],
      stockOffset: 0,
      boundaryContainment: 'outside',
      avoidanceLoopIds: [],
      pattern: 'zigzag',
      passAngle: 0,
      direction: 'both_ways',
      fromOtherSide: false,
      passExtension: 0,
      chipThinning: false,
      bothSidesPerLevel: false,
      floorStockToLeave: 2,
      finishPass: false,
      entryType: 'plunge',
      leadInRadius: 0,
      leadOutRadius: 0,
      keepToolDown: false,
      maxStayDownDistance: 0,
      extendBeforeRetract: false,
      transition: 'direct',
      tolerance: 0.05,
    },
  } as Operation
}

function setup(operations: Operation[]): Setup {
  return {
    id: 'setup-wo2027',
    name: 'Setup 1',
    wcs: {
      id: 'wcs-wo2027',
      label: 'G54',
      fixtureOffset: 54,
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: 1, z: 0 },
      zAxis: { x: 0, y: 0, z: 1 },
      stockId: stock.id,
    } as WCS,
    stock: {
      type: 'rectangular',
      width: 100,
      height: 80,
      depth: 20,
      offsetX: 0,
      offsetY: 0,
      offsetZTop: 0,
      offsetZBottom: 0,
      material: 'aluminum',
    },
    operations,
    notes: '',
  } as Setup
}

function installProject(tools: Tool[]): void {
  const operations = tools.map((tool, index) => faceOperation(`face-${index + 1}`, tool.id))
  useCamStore.setState((state) => ({
    toolLibrary: tools,
    project: {
      ...state.project,
      id: 'project-wo2027',
      name: 'WO-2027 multi-tool project',
      geometry: [] as ImportedGeometry[],
      stocks: [stock],
      sceneStock,
      setups: [setup(operations)],
      activeSetupId: 'setup-wo2027',
      activeOperationId: operations[0].id,
    } as Project,
    toolpathBatch: null,
  }))
}

describe('WO-2027 reopened projects keep generated toolpaths current', () => {
  let originalWorker: typeof Worker | undefined
  let savedProjectText: string

  beforeEach(() => {
    useCamStore.setState(useCamStore.getInitialState(), true)
    savedProjectText = ''
    originalWorker = globalThis.Worker
    ;(globalThis as { Worker?: unknown }).Worker = class {
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: ((event: ErrorEvent) => void) | null = null

      postMessage(data: { type: string; payload: { heights: Record<string, number> } }): void {
        const { heights } = data.payload
        queueMicrotask(() => this.onmessage?.({
          data: {
            type: 'TOOLPATH_COMPLETE',
            moves: [
              { type: 'rapid', role: 'rapid', x: 0, y: 0, z: heights.clearanceHeight },
              { type: 'feed', role: 'cut', x: 10, y: 10, z: heights.bottomHeight, feed: 800 },
            ],
            computeTimeMs: 1,
          },
        } as MessageEvent))
      }

      terminate(): void { /* no-op */ }
    }
    ;(window as unknown as Record<string, unknown>).__cncViewport = {
      getStockBounds: () => ({ min: { x: 0, y: 0, z: 0 }, max: { x: 100, y: 80, z: 20 } }),
    }
    vi.stubGlobal('liencamHost', {
      saveFile: async (_filename: string, data: string | Uint8Array) => {
        savedProjectText = typeof data === 'string' ? data : new TextDecoder().decode(data)
        return 'C:\\Temp\\WO-2027.camproject'
      },
    })
  })

  afterEach(() => {
    ;(globalThis as { Worker?: unknown }).Worker = originalWorker
    delete (window as unknown as Record<string, unknown>).__cncViewport
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('keeps every generated path current after save -> fresh store -> open, then outdates only an edited op', async () => {
    const tools = [legacyRightHandTool('tool-6', 6), legacyRightHandTool('tool-10', 10)]
    installProject(tools)

    for (const operation of useCamStore.getState().project.setups[0].operations) {
      await useCamStore.getState().computeOperationToolpath('setup-wo2027', operation.id)
    }
    expect(useCamStore.getState().project.setups[0].operations.map((operation) => operation.status))
      .toEqual(['ready', 'ready'])

    await useCamStore.getState().saveProjectToFile()
    expect(savedProjectText).not.toBe('')
    const saved = JSON.parse(savedProjectText) as Project
    expect(saved.toolLibrary.map((tool) => tool.cutHand)).toEqual([undefined, undefined])

    delete (window as unknown as Record<string, unknown>).__cncViewport
    useCamStore.setState(useCamStore.getInitialState(), true)
    await useCamStore.getState().loadProjectFromFile(savedProjectText)

    const reopened = useCamStore.getState().project
    expect(reopened.toolLibrary.map((tool) => tool.cutHand)).toEqual(['right', 'right'])
    expect(reopened.setups[0].operations.map((operation) => operation.status))
      .toEqual(['ready', 'ready'])
    expect(reopened.setups[0].operations.every((operation) =>
      operationGenerationIsCurrent(reopened, reopened.setups[0], operation)))
      .toBe(true)

    // Edit the last operation so the assertion isolates its own fingerprint;
    // an earlier operation may legitimately outdate a later rest-stock user.
    const edited = reopened.setups[0].operations[1]
    useCamStore.getState().updateOperation(reopened.setups[0].id, edited.id, {
      params: { ...edited.params, passAngle: 45 },
      status: 'outdated',
    })
    expect(useCamStore.getState().project.setups[0].operations.map((operation) => operation.status))
      .toEqual(['ready', 'outdated'])
  })
})
