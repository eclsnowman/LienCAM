// @vitest-environment jsdom
//
// WO-1407 guarded the New Operation modal rest-machining checkbox against
// locking the operator out. WO-1641 removed the checkbox, so this file proves
// the stronger thing: the state of the operation above a finish gates nothing.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImportedGeometry, Operation, Setup, Tool } from '../../types'
import type { PartMesh } from '../../cam3d/kernel/types'
import { Cam3dClient, type WorkerLike } from '../../cam3d/worker/client'
import { typedMock } from '../support/typedMock'

vi.mock('../../cam3d/integration/parallel3dOperation', async importOriginal => typedMock<typeof import('../../cam3d/integration/parallel3dOperation')>({
  ...(await importOriginal<typeof import('../../cam3d/integration/parallel3dOperation')>()),
  acquirePartMesh: vi.fn(async (): Promise<PartMesh> => ({
    positions: new Float32Array([0, 0, 0, 20, 0, 0, 0, 20, 10]),
    indices: new Uint32Array([0, 1, 2]),
    bounds: { min: [0, 0, 0], max: [20, 20, 10] },
    source: 'fixture' as const,
  })),
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
const { useCamStore } = await import('../../store')

const SETUP_ID = 'setup-wo1407-modal'
const GEO_ID = 'geo-wo1407-modal'
const TOOL_ID = 'tool-wo1407-modal'

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
  name: 'Modal guard fixture',
  filename: 'modal-guard.step',
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

function precedingOperation(): Operation {
  return {
    id: 'rough-op',
    name: 'Computed rough',
    type: 'adaptive_3d',
    enabled: true,
    status: 'ready',
    toolId: TOOL_ID,
    geometrySelections: [GEO_ID],
    heights,
    passes: { stepdown: 2, stepover: 1, stockToLeave: 0, finishPasses: 0, springPasses: 0 },
    linking: {
      entryType: 'plunge', leadInRadius: 0, leadOutRadius: 0, rampAngle: 2,
      rampLength: 5, retractType: 'full', transitionType: 'safe_height',
    },
    params: {},
    toolpathMoves: [{ type: 'feed', x: 0, y: 0, z: 2, role: 'cut' }],
  }
}

function seed(operations: Operation[]): void {
  const setup = {
    id: SETUP_ID,
    name: 'Setup 1',
    wcs: {
      id: 'wcs-wo1407-modal', label: 'G54', fixtureOffset: 54,
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
        activeOperationId: null,
      },
      viewer: { ...state.viewer, selectedGeometryId: null, selectedStockId: null, selectedNestId: null },
    }))
  })
}

function stalePredecessor(): void {
  act(() => {
    useCamStore.getState().updateOperation(SETUP_ID, 'rough-op', {
      status: 'outdated',
      toolpathMoves: undefined,
    })
  })
}

function openParallelPasses(): void {
  render(<NewOperationModal />)
  act(() => { useCamStore.getState().openModal('new-operation') })
  fireEvent.click(screen.getByText('Parallel Finish (3D)'))
  fireEvent.click(screen.getByText('Passes'))
}

function expectNoRestOptIn(): void {
  expect(screen.queryByTestId('rest-machining-toggle')).toBeNull()
  expect(screen.queryByTestId('rest-machining-toggle-row')).toBeNull()
  expect(screen.queryByTestId('rest-machining-stock-source')).toBeNull()
  expect(screen.queryByTestId('rest-machining-stock-source-row')).toBeNull()
}

beforeEach(() => {
  act(() => { useCamStore.getState().newProject() })
  act(() => { useCamStore.getState().closeModal() })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

// WO-1641 repin: the modal checkbox WO-1407 guarded is gone. Operator,
// 2026-09-17: "I don't want the user to have to turn on things that should
// logically be on for them." What survives is the invariant underneath the
// guard - the state of the operation above a finish never locks the operator
// out of anything - and it is now structural rather than conditional.
describe('WO-1641 a stale predecessor locks the New Operation modal out of nothing', () => {
  it('offers no rest opt-in while the predecessor is computed, nor after it goes stale', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    seed([precedingOperation()])
    openParallelPasses()

    expectNoRestOptIn()

    stalePredecessor()

    expectNoRestOptIn()
    expect(warn.mock.calls.flat().join(' ')).not.toContain('earlier enabled operation')
  })

  it('offers no rest opt-in when the modal opens over an already-stale predecessor', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    seed([precedingOperation()])
    stalePredecessor()

    openParallelPasses()
    expectNoRestOptIn()
    expect(warn.mock.calls.flat().join(' ')).not.toContain('earlier enabled operation')
  })
})
