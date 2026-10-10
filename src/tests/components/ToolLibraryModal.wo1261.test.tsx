// @vitest-environment jsdom

import { answerPendingConfirm, expectNoConfirm } from './confirmDialog.support'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Operation, ResolvedHeightSnapshotV1 } from '../../types'
import { smartHeightPlanFixture } from '../helpers/smartHeightPlanFixture'
import { defaultHeightIntent } from '../../lib/cam/heightIntent'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (key) => mem.get(key) ?? null,
  key: (index) => Array.from(mem.keys())[index] ?? null,
  removeItem: (key) => { mem.delete(key) },
  setItem: (key, value) => { mem.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { ToolLibraryModal } = await import('../../components/modals/ToolLibraryModal')
const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { useCamStore } = await import('../../store')

const DEFAULT_LIBRARY_ID = 'lib-default'

const heightSnapshot: ResolvedHeightSnapshotV1 = {
  version: 1,
  wcs: { clearance: 15, retract: 12, feed: 10.5, top: 10, bottom: 0 },
  machine: { clearance: 15, retract: 12, feed: 10.5, top: 10, bottom: 0 },
  intent: defaultHeightIntent(),
  dependencyIds: ['stock:wo1261-stock', 'geometry:wo1261-solid'],
}

function openToolLibrary() {
  act(() => { useCamStore.getState().openModal('tool-library') })
}

function createDefaultTool() {
  openToolLibrary()
  fireEvent.click(screen.getByRole('button', { name: 'New' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))
}

function diameterInput(): HTMLInputElement {
  const row = screen.getByText('Diameter').closest('.mform-row')
  const input = row?.querySelector('input')
  if (!(input instanceof HTMLInputElement)) throw new Error('Diameter input not rendered')
  return input
}

beforeEach(() => {
  mem.clear()
  act(() => {
    useCamStore.getState().closeModal()
    useCamStore.setState({
      toolLibrary: [],
      toolLibraries: [{ id: DEFAULT_LIBRARY_ID, name: 'My Tools' }],
      holders: [],
    })
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  cleanup()
})

describe('WO-1261 new-tool save path', () => {
  it('saves an untouched default tool, disables invalid actions, and persists across reopen', () => {
    render(<ToolLibraryModal />)
    openToolLibrary()

    expect(screen.getByText(/No tools .* add one or import/)).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'New' }))

    expect(screen.getByRole('button', { name: 'Save Changes' })).not.toBeNull()
    expect((screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Export' }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))
    expect(useCamStore.getState().toolLibrary).toHaveLength(1)
    expect(useCamStore.getState().toolLibrary[0]).toMatchObject({
      name: 'New Tool',
      diameter: 6,
      libraryId: DEFAULT_LIBRARY_ID,
    })
    expect(screen.getByRole('option', { name: 'My Tools (1)' })).not.toBeNull()
    expect((screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByRole('button', { name: 'Export' }) as HTMLButtonElement).disabled).toBe(false)

    act(() => { useCamStore.getState().closeModal() })
    openToolLibrary()
    expect(screen.getByText('New Tool')).not.toBeNull()
    expect(useCamStore.getState().toolLibrary).toHaveLength(1)
  })

  it('commits real new/existing diameter edits and warns only after an actual edit', async () => {
    render(<ToolLibraryModal />)
    openToolLibrary()
    fireEvent.click(screen.getByRole('button', { name: 'New' }))

    // A pristine unsaved draft is saveable, but navigating to another new
    // draft does not claim that the operator edited anything.
    fireEvent.click(screen.getByRole('button', { name: 'New' }))
    expectNoConfirm()  // WO-1268: a pristine draft asks nothing

    const diameter = diameterInput()
    act(() => {
      fireEvent.focus(diameter)
      fireEvent.change(diameter, { target: { value: '6.35' } })
      fireEvent.blur(diameter)
    })
    expect(screen.getByRole('button', { name: 'Save Changes' })).not.toBeNull()

    // Refusing the discard keeps the edited draft on screen.
    fireEvent.click(screen.getByRole('button', { name: 'New' }))
    // WO-1268: the dirty draft asks through the app's own themed confirm; keep editing.
    const asked = await answerPendingConfirm(false)
    expect(asked.title).toBe('Discard unsaved changes?')
    expect(diameterInput().value).toBe('6.35')

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))
    expect(useCamStore.getState().toolLibrary).toHaveLength(1)
    expect(useCamStore.getState().toolLibrary[0].diameter).toBe(6.35)

    // The same real field path remains saveable after the draft becomes an
    // existing selected tool; Save updates in place instead of adding a copy.
    const existingDiameter = diameterInput()
    act(() => {
      fireEvent.focus(existingDiameter)
      fireEvent.change(existingDiameter, { target: { value: '6.5' } })
      fireEvent.blur(existingDiameter)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))
    expect(useCamStore.getState().toolLibrary).toHaveLength(1)
    expect(useCamStore.getState().toolLibrary[0].diameter).toBe(6.5)
  })

  it('offers the saved tool to an operation and enables Create Operation', async () => {
    render(<><ToolLibraryModal /><NewOperationModal /></>)
    createDefaultTool()
    const savedTool = useCamStore.getState().toolLibrary[0]

    act(() => {
      const current = useCamStore.getState()
      const geometry = {
        id: 'wo1261-solid', name: 'WO-1261 solid', type: 'mesh', format: 'stl', loaded: true,
        position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
        boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 20, z: 10 } },
      }
      const wcs = {
        id: 'wo1261-wcs', label: 'G54', fixtureOffset: 54,
        origin: { x: 0, y: 0, z: 0 }, stockId: 'wo1261-stock',
        xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      }
      const setup = {
        id: 'wo1261-setup', name: 'Setup 1', wcs, stock: null, operations: [], notes: '',
      }
      useCamStore.setState({
        previewOperationSmartHeightPlan: vi.fn(async (_setupId: string, operation: Operation) =>
          smartHeightPlanFixture(operation, heightSnapshot)),
        project: {
          ...current.project,
          geometry: [geometry],
          setups: [setup],
          activeSetupId: setup.id,
        },
      } as never)
      current.closeModal()
      current.openModal('new-operation')
    })

    fireEvent.click(screen.getByText('Adaptive Rough (3D)'))
    fireEvent.click(screen.getByText('Tool'))
    expect(screen.getByText(savedTool.name)).not.toBeNull()
    fireEvent.click(screen.getByText(savedTool.name))

    await waitFor(() => {
      expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false)
    })
  })
})
