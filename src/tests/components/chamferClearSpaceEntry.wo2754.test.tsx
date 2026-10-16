// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImportedGeometry, Operation, ResolvedHeightSnapshotV1, Setup, Tool } from '../../types'
import { smartHeightPlanFixture } from '../helpers/smartHeightPlanFixture'

const memory = new Map<string, string>()
const storage: Storage = {
  get length() { return memory.size }, clear: () => memory.clear(),
  getItem: key => memory.get(key) ?? null, key: index => Array.from(memory.keys())[index] ?? null,
  removeItem: key => { memory.delete(key) },
  setItem: (key, value) => { memory.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })

const { PropertiesPanel } = await import('../../components/panels/PropertiesPanel')
const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { useCamStore } = await import('../../store')
const {
  buildChamferSmartHeightIntent,
  deriveChamferEdgeBindings,
  validatePersistedSmartHeightState,
} = await import('../../lib/cam/smartHeights')
const { defaultHeightIntent } = await import('../../lib/cam/heightIntent')
const {
  defaultChamferParams, defaultHeights, defaultLinking, defaultPasses,
} = await import('../../components/modals/newOperationModalDefaults')

const tool = {
  id: 'chamfer-tool-1', name: '90 degree V-bit', type: 'chamfer_mill', diameter: 10,
  fluteLength: 12, shankDiameter: 6, overallLength: 50, numberOfFlutes: 2,
  angleFromAxisDeg: 45,
} as unknown as Tool

const snapshot: ResolvedHeightSnapshotV1 = {
  version: 1,
  wcs: { clearance: 15, retract: 5, feed: 2, top: 12, bottom: 9 },
  machine: { clearance: 15, retract: 5, feed: 2, top: 12, bottom: 9 },
  intent: {
    version: 1,
    clearance: { reference: 'wcs_plane', offset: 15, provenance: 'inferred' },
    retract: { reference: 'wcs_plane', offset: 5, provenance: 'inferred' },
    feed: { reference: 'wcs_plane', offset: 2, provenance: 'inferred' },
    top: { reference: 'wcs_plane', offset: 12, provenance: 'inferred' },
    bottom: { reference: 'wcs_plane', offset: 9, provenance: 'inferred' },
  },
  dependencyIds: ['part-1', tool.id],
}

function geometry(): ImportedGeometry {
  return {
    id: 'part-1', name: 'Chamfer.dxf', filename: 'Chamfer.dxf',
    type: 'curves_2d', format: 'dxf', loaded: true, loopsVersion: 4,
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 20, z: 12 },
      size: { x: 20, y: 20, z: 12 }, center: { x: 10, y: 10, z: 6 },
    },
    loops: [{
      id: 'chamfer-loop', layerId: 'chamfer-layer', closed: true, type: 'contour', area: 400,
      points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }],
    }],
    layers2d: [{
      id: 'chamfer-layer', name: 'Chamfer', color: '#fff', visible: true,
      frame: 'geometry_local',
      projectionPlane: {
        origin: { x: 0, y: 0, z: 12 }, normal: { x: 0, y: 0, z: 1 },
        xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 },
      },
    }],
  } as ImportedGeometry
}

function setup(operations: Operation[] = []): Setup {
  return {
    id: 'setup-1', name: 'Setup 1', notes: '', operations,
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54,
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
    },
    stock: null,
  } as unknown as Setup
}

function baseChamfer(): Operation {
  return {
    id: 'base-chamfer', name: 'Base Chamfer', type: 'chamfer',
    enabled: true, status: 'ready', toolId: tool.id, geometrySelections: ['chamfer-loop'],
    heights: { ...defaultHeights }, passes: { ...defaultPasses }, linking: { ...defaultLinking },
    params: {
      ...defaultChamferParams, geometryId: 'part-1', loopIds: ['chamfer-loop'],
      chamferWidth: 1, tipOffset: 2,
    },
} as unknown as Operation
}

function smartChamferWithStaleMirrors(): Operation {
  const source = geometry()
  const derived = deriveChamferEdgeBindings([source], ['chamfer-loop'])
  if (!derived.ok) throw new Error(derived.refusals[0].message)
  return {
    ...baseChamfer(), id: 'smart-chamfer', name: 'Smart Chamfer',
    params: {
      ...defaultChamferParams, geometryId: 'part-1', loopIds: ['chamfer-loop'],
      chamferWidth: 7, tipOffset: 8, planeOffset: -99,
    },
    smartHeight: {
      kind: 'smart_v2',
      intent: buildChamferSmartHeightIntent({
        setupId: 'setup-1', safetyIntent: defaultHeightIntent(),
        datumReference: 'geometry_plane', datumOffsetMm: 0,
        chamferWidthMm: 1, tipOffsetMm: 2,
        features: derived.bindings.map(binding => ({
          loopId: binding.loopId, feature: binding.feature,
          fingerprint: binding.evidenceFingerprint,
        })),
      }),
    },
    resolvedHeights: snapshot,
} as unknown as Operation
}

function seed(operations: Operation[] = []) {
  const activeSetup = setup(operations)
  const preview = vi.fn(async (_setupId: string, operation: Operation) => {
    const validated = validatePersistedSmartHeightState(operation.smartHeight)
    expect(validated.ok && validated.state.kind === 'smart_v2').toBe(true)
    return smartHeightPlanFixture(operation, snapshot)
  })
  const state = useCamStore.getState()
  useCamStore.setState({
    toolLibrary: [tool], computeOperationToolpath: vi.fn(),
    previewOperationSmartHeightPlan: preview,
    previewChamferSmartHeights: vi.fn(() => snapshot),
    project: {
      ...state.project, setups: [activeSetup], activeSetupId: activeSetup.id,
      activeOperationId: activeSetup.operations[0]?.id, geometry: [geometry()],
    },
  } as never)
  return preview
}

async function authorNewChamfer(): Promise<void> {
  fireEvent.click(screen.getByText('2D Chamfer'))
  fireEvent.click(screen.getByText('Tool'))
  fireEvent.click(screen.getByText(tool.name))
  fireEvent.click(screen.getByText('Geometry'))
  fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: 'part-1' } })
  fireEvent.click(screen.getByRole('button', { name: /All loops/ }))
  fireEvent.click(screen.getByText('Heights'))
  await waitFor(() => expect(screen.getByTestId('chamfer-height-policy')).not.toBeNull())
}

beforeEach(() => {
  act(() => useCamStore.getState().newProject())
  act(() => useCamStore.getState().closeModal())
})
afterEach(cleanup)


describe('WO-2754 Chamfer entry policy in the actual editor routes', () => {
  it('creates a Chamfer with the selected clear-space policy', async () => {
    seed()
    render(<NewOperationModal />)
    act(() => useCamStore.getState().openModal('new-operation'))
    await authorNewChamfer()
    fireEvent.click(screen.getByText('Linking'))
    fireEvent.change(screen.getByLabelText('Chamfer entry and exit'), { target: { value: 'clear_space' } })
    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('op-create'))
    await waitFor(() => expect(useCamStore.getState().project.setups[0].operations.at(-1)?.params.entryPolicy).toBe('clear_space'))
  })
  it('reads an absent saved field as authored, saves clear-space and reopens it', async () => {
    const op = smartChamferWithStaleMirrors()
    op.params = { ...op.params, chamferWidth: 1, tipOffset: 2, planeOffset: 0 }
    delete op.params.entryPolicy
    seed([op])
    render(<NewOperationModal />)
    act(() => useCamStore.getState().openEditOperation('setup-1', op.id))
    fireEvent.click(screen.getByText('Linking'))
    const field = screen.getByLabelText('Chamfer entry and exit') as HTMLSelectElement
    expect(field.value).toBe('authored')
    fireEvent.change(field, { target: { value: 'clear_space' } })
    expect(screen.queryByText('Ramp angle')).toBeNull()
    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('op-create'))
    await waitFor(() => expect(useCamStore.getState().project.setups[0].operations.find(o => o.id === op.id)?.params.entryPolicy).toBe('clear_space'))
    cleanup()
    render(<NewOperationModal />)
    act(() => useCamStore.getState().openEditOperation('setup-1', op.id))
    fireEvent.click(screen.getByText('Linking'))
    expect((screen.getByLabelText('Chamfer entry and exit') as HTMLSelectElement).value).toBe('clear_space')
    expect(useCamStore.getState().project.setups[0].operations[0].linking).toEqual(op.linking)
  })
  it('quick edit and duplication retain the policy and all authored heights', () => {
    const op = smartChamferWithStaleMirrors()
    op.params = { ...op.params, chamferWidth: 1, tipOffset: 2, planeOffset: 0 }
    seed([op])
    act(() => useCamStore.setState(s => ({ project: { ...s.project, activeOperationId: op.id, activeSetupId: 'setup-1' } })))
    render(<PropertiesPanel />)
    fireEvent.change(screen.getByLabelText('Chamfer entry and exit'), { target: { value: 'clear_space' } })
    const edited = useCamStore.getState().project.setups[0].operations[0]
    expect(edited.params.entryPolicy).toBe('clear_space')
    expect(edited.heights).toEqual(op.heights)
    expect(edited.linking).toEqual(op.linking)
    act(() => useCamStore.getState().duplicateOperation('setup-1', op.id))
    const copy = useCamStore.getState().project.setups[0].operations.find(o => o.id !== op.id)!
    expect(copy.params.entryPolicy).toBe('clear_space')
    expect(copy.heights).toEqual(edited.heights)
  })
})
