// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImportedGeometry, Operation, Setup, Tool, ToolpathMove } from '../../types'
import type { ComputeParallel3dArgs } from '../../cam3d/integration/parallel3dOperation'
import type { ComputeRest3dArgs } from '../../cam3d/integration/rest3dOperation'
import type { PartMesh } from '../../cam3d/kernel/types'
import { Cam3dClient, type WorkerLike } from '../../cam3d/worker/client'
import { typedMock } from '../support/typedMock'

const computeMocks = vi.hoisted(() => ({
  parallel: vi.fn(async (_args: ComputeParallel3dArgs) => ({
    moves: [{ type: 'feed' as const, x: 1, y: 0, z: 0, role: 'cut' as const }],
    computeTimeMs: 1,
  })),
  rest: vi.fn(async (_args: ComputeRest3dArgs) => ({
    moves: [{ type: 'feed' as const, x: 9, y: 0, z: 0, role: 'cut' as const }],
    computeTimeMs: 2,
  })),
}))

vi.mock('../../cam3d/integration/parallel3dOperation', async importOriginal => typedMock<typeof import('../../cam3d/integration/parallel3dOperation')>({
  ...(await importOriginal<typeof import('../../cam3d/integration/parallel3dOperation')>()),
  acquirePartMesh: vi.fn(async (
    _source: { format: 'stl' | 'step'; bytes: ArrayBuffer },
    _camTolerance: number,
  ): Promise<PartMesh> => ({
    positions: new Float32Array([0, 0, 0, 20, 0, 0, 0, 20, 10]),
    indices: new Uint32Array([0, 1, 2]),
    bounds: { min: [0, 0, 0], max: [20, 20, 10] },
    source: 'fixture' as const,
  })),
  computeParallel3dMoves: computeMocks.parallel,
}))

vi.mock('../../cam3d/integration/rest3dOperation', async importOriginal => typedMock<typeof import('../../cam3d/integration/rest3dOperation')>({
  ...(await importOriginal<typeof import('../../cam3d/integration/rest3dOperation')>()),
  computeRest3dMoves: computeMocks.rest,
}))

vi.mock('../../cam3d/integration/appClient', async importOriginal => typedMock<typeof import('../../cam3d/integration/appClient')>({
  ...(await importOriginal<typeof import('../../cam3d/integration/appClient')>()),
  getCam3dClient: vi.fn(() => new Cam3dClient({
    postMessage: () => {},
    terminate: () => {},
    onmessage: null,
    onerror: null,
  } satisfies WorkerLike)),
  disposeCam3dClient: vi.fn(),
}))

vi.mock('../../lib/stepCache', async importOriginal => typedMock<typeof import('../../lib/stepCache')>({
  ...(await importOriginal<typeof import('../../lib/stepCache')>()),
  loadCachedStep: vi.fn(async () => new ArrayBuffer(8)),
}))

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: key => mem.get(key) ?? null,
  key: index => Array.from(mem.keys())[index] ?? null,
  removeItem: key => { mem.delete(key) },
  setItem: (key, value) => { mem.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { PropertiesPanel } = await import('../../components/panels/PropertiesPanel')
const { useCamStore } = await import('../../store')
const { buildParallel3dSmartIntent } = await import('../../lib/cam/smartHeights')
const { defaultHeightIntent } = await import('../../lib/cam/heightIntent')
const { DEFAULT_PARALLEL3D_PARAMS } = await import('../../cam3d/integration/parallel3dOperation')

const SETUP_ID = 'setup-rest-toggle'
const GEO_ID = 'geo-rest-toggle'
const TOOL_ID = 'tool-rest-toggle'

const tool = {
  id: TOOL_ID,
  name: '6 mm ball',
  type: 'ball_end_mill',
  diameter: 6,
  fluteLength: 20,
  shankDiameter: 6,
  overallLength: 50,
  numberOfFlutes: 2,
  material: 'carbide',
  coating: 'none',
  notes: '',
  feedsAndSpeeds: { default: { rpm: 12000, feedRate: 1000, plungeRate: 300, depthOfCut: 2, stepover: 1 } },
} as Tool

const geometry = {
  id: GEO_ID,
  name: 'Toggle fixture',
  filename: 'toggle.step',
  type: 'brep',
  format: 'step',
  loaded: true,
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
  boundingBox: {
    min: { x: 0, y: 0, z: 0 },
    max: { x: 20, y: 20, z: 10 },
    size: { x: 20, y: 20, z: 10 },
    center: { x: 10, y: 10, z: 5 },
  },
} as ImportedGeometry

const heights = {
  clearanceHeight: 15,
  clearanceHeightMode: 'absolute' as const,
  retractHeight: 12,
  feedHeight: 11,
  topHeight: 10,
  topHeightMode: 'model_top' as const,
  bottomHeight: 0,
  bottomHeightMode: 'model_bottom' as const,
}

function operation(overrides: Partial<Operation> = {}): Operation {
  return {
    id: 'finish-op',
    name: 'Parallel finish',
    type: 'parallel_3d',
    enabled: true,
    status: 'ready',
    toolId: TOOL_ID,
    geometrySelections: [GEO_ID],
    heights,
    smartHeight: {
      kind: 'smart_v2',
      intent: buildParallel3dSmartIntent({
        setupId: SETUP_ID,
        geometryIds: [GEO_ID],
        safetyIntent: defaultHeightIntent(),
      }),
    },
    passes: { stepdown: 2, stepover: 1, stockToLeave: 0, finishPasses: 0, springPasses: 0 },
    linking: {
      entryType: 'plunge', leadInRadius: 0, leadOutRadius: 0, rampAngle: 2,
      rampLength: 5, retractType: 'full', transitionType: 'safe_height',
    },
    params: { ...DEFAULT_PARALLEL3D_PARAMS },
    toolpathMoves: [{ type: 'feed', x: 1, y: 0, z: 0, role: 'cut' }],
    ...overrides,
  }
}

function precedingOperation(): Operation {
  return operation({
    id: 'rough-op',
    name: 'Computed rough',
    type: 'adaptive_3d',
    smartHeight: undefined,
    params: {},
    toolpathMoves: [{ type: 'feed', x: 0, y: 0, z: 2, role: 'cut' }],
  })
}

function seed(operations: Operation[], activeOperationId?: string): void {
  const setup = {
    id: SETUP_ID,
    name: 'Setup 1',
    wcs: {
      id: 'wcs-rest-toggle', label: 'G54', fixtureOffset: 54,
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
    },
    stock: {
      type: 'rectangular', width: 20, height: 20, depth: 10,
      offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum',
    },
    operations,
    notes: '',
  } satisfies Setup
  act(() => {
    useCamStore.setState(state => ({
      toolLibrary: [tool],
      project: {
        ...state.project,
        geometry: [geometry],
        setups: [setup],
        activeSetupId: SETUP_ID,
        activeOperationId: activeOperationId ?? null,
      },
      viewer: { ...state.viewer, selectedGeometryId: null, selectedStockId: null, selectedNestId: null },
    }))
  })
}

function currentOperation(): Operation {
  return useCamStore.getState().project.setups[0].operations.at(-1)!
}

beforeEach(() => {
  computeMocks.parallel.mockClear()
  computeMocks.rest.mockClear()
  act(() => { useCamStore.getState().newProject() })
  act(() => { useCamStore.getState().closeModal() })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

// WO-1641 repin: the toggle WO-1210 built is GONE. Operator ruling 2026-09-17: "why would
// a user ever disable rest Machining? Why would we give them an option to have
// it waste that cutting time? We already know it's removed." What WO-1210's
// coverage becomes is the proof that no opt-in survives anywhere the operator
// can reach, and that the strategy they picked is the strategy that computes.
describe('WO-1641 no rest opt-in reaches the operator', () => {
  it('offers no rest toggle and no stock-source choice on a 3D finish in the new-operation modal', () => {
    seed([precedingOperation()])
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })

    expect(screen.queryByTestId('op-type-rest3d')).toBeNull()
    expect(screen.queryByText('Rest Machining (3D)')).toBeNull()
    fireEvent.click(screen.getByText('Parallel Finish (3D)'))
    fireEvent.click(screen.getByText('Passes'))

    expect(screen.queryByTestId('rest-machining-toggle')).toBeNull()
    expect(screen.queryByTestId('rest-machining-toggle-row')).toBeNull()
    expect(screen.queryByTestId('rest-machining-stock-source')).toBeNull()
    expect(screen.queryByTestId('rest-machining-stock-source-row')).toBeNull()
  })

  it('offers no rest toggle in the Properties panel, and says nothing about rest availability', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const first = operation()
    seed([first], first.id)
    render(<PropertiesPanel />)

    expect(screen.queryByTestId('props-rest-machining-toggle')).toBeNull()
    expect(screen.queryByTestId('props-rest-machining-stock-source')).toBeNull()
    // The old panel warned the FIRST operation that rest was unavailable to it.
    // There is nothing for it to opt into now, so there is nothing to refuse.
    expect(warn.mock.calls.flat().join(' ')).not.toContain('earlier enabled operation')
  })

  it('computes the strategy the operator chose, even when stale rest params ride along in the record', async () => {
    // A finish whose params still carry the retired keys (what an in-memory
    // project made before this change looks like). They must steer nothing:
    // the rest compute path is unwired, so Parallel computes both times.
    const finish = operation({
      status: 'pending',
      toolpathMoves: undefined,
      params: { ...DEFAULT_PARALLEL3D_PARAMS, restMachining: true, stockSource: 'previous_tool' },
    })
    seed([precedingOperation(), finish], finish.id)

    await useCamStore.getState().computeOperationToolpath(SETUP_ID, finish.id)
    const withStaleParams = currentOperation().toolpathMoves as ToolpathMove[]
    expect(computeMocks.rest).not.toHaveBeenCalled()
    expect(computeMocks.parallel).toHaveBeenCalledTimes(1)

    useCamStore.getState().updateOperation(SETUP_ID, finish.id, {
      params: { ...DEFAULT_PARALLEL3D_PARAMS },
      status: 'pending',
      toolpathMoves: undefined,
    })
    await useCamStore.getState().computeOperationToolpath(SETUP_ID, finish.id)

    // Same path, same moves: the keys made no difference to what was computed.
    expect(currentOperation().toolpathMoves).toEqual(withStaleParams)
    expect(computeMocks.rest).not.toHaveBeenCalled()
    expect(computeMocks.parallel).toHaveBeenCalledTimes(2)
  })
})
