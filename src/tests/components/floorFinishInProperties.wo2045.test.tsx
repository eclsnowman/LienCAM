// @vitest-environment jsdom
//
// WO-2045: Adaptive Floor finish pass is one stored ACParams field viewed
// through both the Properties panel and the operation editor. This mounts both
// real surfaces, edits in each direction, and pins the panel's stale contract.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HeightParams, Operation, Setup, Tool } from '../../types'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'
import { smartHeightPlanFixture } from '../helpers/smartHeightPlanFixture'

const memory = new Map<string, string>()
const storage: Storage = {
  get length() { return memory.size },
  clear: () => memory.clear(),
  getItem: key => memory.get(key) ?? null,
  key: index => [...memory.keys()][index] ?? null,
  removeItem: key => { memory.delete(key) },
  setItem: (key, value) => { memory.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })

const { PropertiesPanel } = await import('../../components/panels/PropertiesPanel')
const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { useCamStore } = await import('../../store')
const {
  defaultACParams,
  defaultHeights,
  defaultLinking,
  defaultPasses,
} = await import('../../components/modals/newOperationModalDefaults')

const SETUP_ID = 'setup-wo2045'
const OP_ID = 'adaptive-wo2045'
const TOOL_ID = 'tool-wo2045'

const tool = {
  id: TOOL_ID,
  name: '6mm Flat End Mill',
  type: 'flat_end_mill',
  diameter: 6,
  fluteLength: 20,
  shankDiameter: 6,
  overallLength: 50,
  numberOfFlutes: 2,
} as unknown as Tool

function seedAdaptive(): void {
  const params = {
    ...defaultACParams,
    boundarySource: 'stock' as const,
    geometryId: '',
    loopIds: [],
    floorFinish: false,
    preservedParam: 'kept',
  }
  const heights = { ...defaultHeights }
  const operation = {
    id: OP_ID,
    name: 'Adaptive Clearing 1',
    type: 'adaptive_clearing_2d',
    enabled: true,
    status: 'ready',
    toolId: TOOL_ID,
    geometrySelections: [],
    heights,
    passes: { ...defaultPasses },
    linking: { ...defaultLinking },
    params,
    toolpathMoves: [{ type: 'rapid', x: 0, y: 0, z: 10 }],
    computeTimeMs: 42,
    estimatedCutTimeMs: 84,
    generationFingerprint: 'ready-toolpath',
    smartHeight: smartHeightAuthorityFixture('adaptive_clearing_2d', {
      setupId: SETUP_ID,
      heights: heights as HeightParams,
      params,
      stockId: 'stock-1',
    }),
  } as unknown as Operation
  const setup = {
    id: SETUP_ID,
    name: 'Setup 1',
    notes: '',
    stock: null,
    operations: [operation],
    wcs: {
      id: 'wcs-1',
      label: 'G54',
      fixtureOffset: 54,
      stockId: 'stock-1',
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: 1, z: 0 },
      zAxis: { x: 0, y: 0, z: 1 },
    },
  } as unknown as Setup
  const resolvedSnapshot = {
    version: 1 as const,
    wcs: { clearance: 10, retract: 5, feed: 2, top: 0, bottom: -5 },
    machine: { clearance: 10, retract: 5, feed: 2, top: 0, bottom: -5 },
    intent: {
      version: 1 as const,
      clearance: { reference: 'wcs_plane' as const, offset: 10, provenance: 'inferred' as const },
      retract: { reference: 'wcs_plane' as const, offset: 5, provenance: 'inferred' as const },
      feed: { reference: 'wcs_plane' as const, offset: 2, provenance: 'inferred' as const },
      top: { reference: 'wcs_plane' as const, offset: 0, provenance: 'inferred' as const },
      bottom: { reference: 'wcs_plane' as const, offset: -5, provenance: 'inferred' as const },
    },
    dependencyIds: ['stock-1'],
  }

  act(() => {
    const state = useCamStore.getState()
    useCamStore.setState({
      toolLibrary: [tool],
      previewOperationSmartHeightPlan: vi.fn(async (_setupId: string, candidate: Operation) =>
        smartHeightPlanFixture(candidate, resolvedSnapshot)),
      project: {
        ...state.project,
        setups: [setup],
        activeSetupId: SETUP_ID,
        activeOperationId: OP_ID,
      },
    } as never)
  })
}

function operationNow(): Operation {
  return useCamStore.getState().project.setups[0].operations[0]
}

function storedFloorFinish(): boolean | undefined {
  return (operationNow().params as { floorFinish?: boolean }).floorFinish
}

beforeEach(() => {
  memory.clear()
  act(() => {
    useCamStore.getState().closeModal()
    useCamStore.getState().newProject()
  })
  seedAdaptive()
})

afterEach(cleanup)

describe('WO-2045: Adaptive Floor finish pass in Properties', () => {
  it('edits the same stored field from both screens and invalidates the toolpath', async () => {
    render(<><PropertiesPanel /><NewOperationModal /></>)

    const propertyRow = screen.getByTestId('props-adaptive-floor-finish')
    const propertyCheckbox = within(propertyRow).getByRole('checkbox') as HTMLInputElement
    expect(propertyRow.textContent).toContain('Floor finish pass')
    expect(propertyRow.textContent).toContain('Off')
    expect(propertyCheckbox.checked).toBe(false)

    fireEvent.click(propertyCheckbox)

    expect(storedFloorFinish()).toBe(true)
    expect((operationNow().params as { preservedParam?: string }).preservedParam).toBe('kept')
    expect(operationNow().status).toBe('pending')
    expect(operationNow().toolpathMoves).toBeUndefined()
    expect(operationNow().computeTimeMs).toBeUndefined()
    expect(operationNow().estimatedCutTimeMs).toBeUndefined()
    expect(operationNow().generationFingerprint).toBeUndefined()
    expect(propertyRow.textContent).toContain('On')

    act(() => useCamStore.getState().openEditOperation(SETUP_ID, OP_ID))
    const modal = screen.getByTestId('op-modal-panel')
    fireEvent.click(within(modal).getByText('Passes').closest('button')!)

    const editorLabel = within(modal).getByText('Floor finish pass')
    const editorCheckbox = editorLabel.closest('label')!
      .querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(editorCheckbox.checked).toBe(true)

    fireEvent.click(editorCheckbox)
    await waitFor(() => expect((within(modal).getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(within(modal).getByTestId('op-create'))

    await waitFor(() => {
      expect(screen.queryByTestId('op-modal-panel')).toBeNull()
      expect(storedFloorFinish()).toBe(false)
      expect(propertyCheckbox.checked).toBe(false)
      expect(propertyRow.textContent).toContain('Off')
    })
  })
})
