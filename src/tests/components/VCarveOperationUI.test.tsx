// @vitest-environment jsdom
//
// WO-1174: the New Operation dialog authors a V-carve. Picking the card, a
// V-bit and closed outlines resolves a live Smart Height plan; Create writes a
// smart_v2 authority with the region formula. Choosing a separate clearing
// tool creates the flat-clearing sibling operation, listed before the carve.

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

const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { useCamStore } = await import('../../store')
const { validatePersistedSmartHeightState } = await import('../../lib/cam/smartHeights')

const vbit = {
  id: 'vbit-1', name: '90 deg V-bit', type: 'v_bit', diameter: 12,
  tipDiameter: 0, fluteLength: 10, shankDiameter: 6, overallLength: 50,
  numberOfFlutes: 2, angleFromAxisDeg: 45,
} as unknown as Tool

const endMill = {
  id: 'em-4', name: '4 mm end mill', type: 'flat_end_mill', diameter: 4,
  fluteLength: 12, shankDiameter: 4, overallLength: 40, numberOfFlutes: 2,
} as unknown as Tool

const snapshot: ResolvedHeightSnapshotV1 = {
  version: 1,
  wcs: { clearance: 15, retract: 5, feed: 2, top: 10, bottom: 8 },
  machine: { clearance: 15, retract: 5, feed: 2, top: 10, bottom: 8 },
  intent: {
    version: 1,
    clearance: { reference: 'wcs_plane', offset: 15, provenance: 'inferred' },
    retract: { reference: 'wcs_plane', offset: 5, provenance: 'inferred' },
    feed: { reference: 'wcs_plane', offset: 2, provenance: 'inferred' },
    top: { reference: 'wcs_plane', offset: 10, provenance: 'inferred' },
    bottom: { reference: 'wcs_plane', offset: 8, provenance: 'inferred' },
  },
  dependencyIds: ['art-1', vbit.id],
}

function geometry(): ImportedGeometry {
  return {
    id: 'art-1', name: 'Sign.dxf', filename: 'Sign.dxf',
    type: 'curves_2d', format: 'dxf', loaded: true, loopsVersion: 4,
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    boundingBox: {
      min: { x: 0, y: 0, z: 10 }, max: { x: 40, y: 10, z: 10 },
      size: { x: 40, y: 10, z: 0 }, center: { x: 20, y: 5, z: 10 },
    },
    loops: [
      {
        id: 'letter', layerId: 'art-layer', closed: true, type: 'contour', area: 400,
        points: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 10 }, { x: 0, y: 10 }],
      },
      {
        id: 'scribe', layerId: 'art-layer', closed: false, type: 'contour', area: 0,
        points: [{ x: 0, y: 20 }, { x: 10, y: 25 }],
      },
    ],
    layers2d: [{
      id: 'art-layer', name: 'Artwork', color: '#fff', visible: true,
      frame: 'geometry_local',
      projectionPlane: {
        origin: { x: 0, y: 0, z: 10 }, normal: { x: 0, y: 0, z: 1 },
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

function seed(operations: Operation[] = []) {
  const activeSetup = setup(operations)
  const preview = vi.fn(async (_setupId: string, operation: Operation) => {
    const validated = validatePersistedSmartHeightState(operation.smartHeight)
    expect(validated.ok && validated.state.kind === 'smart_v2').toBe(true)
    return smartHeightPlanFixture(operation, snapshot)
  })
  const state = useCamStore.getState()
  useCamStore.setState({
    toolLibrary: [vbit, endMill], computeOperationToolpath: vi.fn(),
    previewOperationSmartHeightPlan: preview,
    project: {
      ...state.project, setups: [activeSetup], activeSetupId: activeSetup.id,
      activeOperationId: activeSetup.operations[0]?.id, geometry: [geometry()],
    },
  } as never)
  return preview
}

async function authorNewVCarve(): Promise<void> {
  fireEvent.click(screen.getByTestId('op-type-vcarve'))
  fireEvent.click(screen.getByText('Tool'))
  fireEvent.click(screen.getByText(vbit.name))
  fireEvent.click(screen.getByText('Geometry'))
  fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: 'art-1' } })
  fireEvent.click(screen.getByRole('button', { name: /All loops/ }))
}

beforeEach(() => {
  act(() => useCamStore.getState().newProject())
  act(() => useCamStore.getState().closeModal())
})
afterEach(cleanup)

describe('V-carve authoring UI', () => {
  it('authors the closed outlines as a V2 region formula on the bit\'s own limit', async () => {
    const preview = seed()
    render(<NewOperationModal />)
    act(() => useCamStore.getState().openModal('new-operation'))
    await authorNewVCarve()
    fireEvent.click(screen.getByText('Heights'))
    await waitFor(() => expect(screen.getByTestId('vcarve-height-policy')).not.toBeNull())
    await waitFor(() => expect(screen.getByTestId('resolved-height-plan')).not.toBeNull())
    expect(preview).toHaveBeenCalled()
    expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByTestId('op-create'))

    const ops = useCamStore.getState().project.setups[0].operations
    expect(ops).toHaveLength(1)
    const created = ops[0]
    expect(created.type).toBe('vcarve')
    // Only the closed loop is carved; the open scribe line is not an outline.
    expect(created.geometrySelections).toEqual(['letter'])
    expect(created.params).toMatchObject({ role: 'carve', startDepthMm: 0, flatClearing: { mode: 'vbit' } })
    expect(created.smartHeight).toMatchObject({
      kind: 'smart_v2',
      intent: {
        policy: { operationType: 'vcarve', variant: 'tool_limit' },
        machining: {
          scope: { value: { kind: 'selected_paths', geometryIds: ['art-1'], loopIds: ['letter'] } },
          end: { value: { formula: { kind: 'vcarve_region', startDepthMm: 0, flatDepth: { kind: 'tool_limit' } } } },
        },
      },
    })
  })

  it('a flat depth switches the policy variant and a clearing tool creates the sibling operation first', async () => {
    seed()
    render(<NewOperationModal />)
    act(() => useCamStore.getState().openModal('new-operation'))
    await authorNewVCarve()
    fireEvent.click(screen.getByText('Passes'))
    fireEvent.click(screen.getByTestId('vcarve-depth-flat'))
    fireEvent.click(screen.getByTestId('vcarve-clear-tool'))
    // Without a clearing tool the dialog refuses to create.
    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(true))
    fireEvent.change(screen.getByTestId('vcarve-clearing-tool'), { target: { value: endMill.id } })
    fireEvent.click(screen.getByText('Heights'))
    await waitFor(() => expect(screen.getByTestId('resolved-height-plan')).not.toBeNull())
    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('op-create'))

    const ops = useCamStore.getState().project.setups[0].operations
    expect(ops).toHaveLength(2)
    const [clearing, carve] = ops
    expect(clearing.type).toBe('vcarve')
    expect(clearing.toolId).toBe(endMill.id)
    expect(clearing.name).toMatch(/flat clearing$/)
    expect(clearing.params).toMatchObject({
      role: 'flat_clearing', flatDepthMm: 2, vbit: { angleFromAxisDeg: 45, tipDiameter: 0 },
    })
    expect(clearing.smartHeight).toMatchObject({
      kind: 'smart_v2',
      intent: { policy: { operationType: 'vcarve', variant: 'flat_depth' } },
    })
    expect(carve.toolId).toBe(vbit.id)
    expect(carve.params).toMatchObject({
      role: 'carve', flatDepthMm: 2, flatClearing: { mode: 'tool', clearingToolDiameter: 4 },
    })
    expect(carve.smartHeight).toMatchObject({
      intent: {
        policy: { operationType: 'vcarve', variant: 'flat_depth' },
        machining: { end: { value: { formula: { kind: 'vcarve_region', flatDepth: { kind: 'explicit', depthMm: 2 } } } } },
      },
    })
  })

  it('editing the carve keeps the clearing tool and updates the sibling; dropping the tool removes it (audit finding 3)', async () => {
    seed()
    render(<NewOperationModal />)
    act(() => useCamStore.getState().openModal('new-operation'))
    await authorNewVCarve()
    fireEvent.click(screen.getByText('Passes'))
    fireEvent.click(screen.getByTestId('vcarve-depth-flat'))
    fireEvent.click(screen.getByTestId('vcarve-clear-tool'))
    fireEvent.change(screen.getByTestId('vcarve-clearing-tool'), { target: { value: endMill.id } })
    fireEvent.click(screen.getByText('Heights'))
    await waitFor(() => expect(screen.getByTestId('resolved-height-plan')).not.toBeNull())
    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('op-create'))
    let ops = useCamStore.getState().project.setups[0].operations
    expect(ops).toHaveLength(2)
    const carveId = ops[1].id
    const siblingId = ops[0].id

    // Re-open the carve: the clearing tool is re-hydrated; a new flat depth reaches the sibling.
    act(() => useCamStore.getState().openEditOperation('setup-1', carveId))
    fireEvent.click(screen.getByText('Passes'))
    expect((screen.getByTestId('vcarve-clearing-tool') as HTMLSelectElement).value).toBe(endMill.id)
    // The flat depth field is the first numeric input of the Carve depth section (value 2).
    const flat = screen.getAllByDisplayValue('2')[0] as HTMLInputElement
    fireEvent.change(flat, { target: { value: '3' } })
    fireEvent.blur(flat)
    fireEvent.click(screen.getByText('Heights'))
    await waitFor(() => expect(screen.getByTestId('resolved-height-plan')).not.toBeNull())
    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('op-create'))
    ops = useCamStore.getState().project.setups[0].operations
    expect(ops).toHaveLength(2)
    const sibling = ops.find(o => o.id === siblingId)!
    expect(sibling.params).toMatchObject({ role: 'flat_clearing', flatDepthMm: 3 })
    expect(ops.find(o => o.id === carveId)!.params).toMatchObject({ flatDepthMm: 3 })

    // Switch the carve to clearing with its own bit: the sibling is removed.
    act(() => useCamStore.getState().openEditOperation('setup-1', carveId))
    fireEvent.click(screen.getByText('Passes'))
    fireEvent.click(screen.getByTestId('vcarve-clear-vbit'))
    fireEvent.click(screen.getByText('Heights'))
    await waitFor(() => expect(screen.getByTestId('resolved-height-plan')).not.toBeNull())
    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('op-create'))
    ops = useCamStore.getState().project.setups[0].operations
    expect(ops).toHaveLength(1)
    expect(ops[0].id).toBe(carveId)
  })
})
