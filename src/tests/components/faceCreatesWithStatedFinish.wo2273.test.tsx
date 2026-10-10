// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PhysicalStock, Setup, Tool } from '../../types'

const memory = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  get length() { return memory.size }, clear: () => memory.clear(),
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => memory.set(key, String(value)),
  removeItem: (key: string) => memory.delete(key),
  key: (index: number) => Array.from(memory.keys())[index] ?? null,
} })
const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { useCamStore } = await import('../../store')
const preview = useCamStore.getState().previewOperationSmartHeightPlan
const stock = {
  id: 'stock-2273', name: 'Stock 1', mode: 'explicit',
  bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 100, y: 80, z: 20 },
    size: { x: 100, y: 80, z: 20 }, center: { x: 50, y: 40, z: 10 } },
  position: { x: 0, y: 0, z: 0 },
} as PhysicalStock
const tool = {
  id: 'tool-2273', name: 'Face mill 12mm', type: 'flat_end_mill', diameter: 12,
  fluteLength: 25, shankDiameter: 12, overallLength: 60, numberOfFlutes: 3,
} as unknown as Tool

function seed(withStock = true) {
  const state = useCamStore.getState()
  const setup = {
    id: 'setup-2273', name: 'Setup 1', notes: '', operations: [], stock: null,
    wcs: { id: 'wcs-2273', label: 'G54', fixtureOffset: 54,
      origin: { x: 0, y: 0, z: 20 }, xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      ...(withStock ? { stockId: stock.id,
        originBinding: { kind: 'stock_corner', stockId: stock.id, cornerIndex: 4 } } : {}),
    },
  } as unknown as Setup
  act(() => useCamStore.setState({
    toolLibrary: [tool], previewOperationSmartHeightPlan: preview,
    computeOperationToolpath: vi.fn(),
    project: { ...state.project, setups: [setup], activeSetupId: setup.id,
      stocks: withStock ? [stock] : [], geometry: [] },
  }))
}
function openFace() {
  render(<NewOperationModal />)
  act(() => useCamStore.getState().openModal('new-operation'))
  fireEvent.click(screen.getByText('2D Face'))
  fireEvent.click(screen.getByText('Tool'))
  fireEvent.click(screen.getByText(tool.name))
}
beforeEach(() => {
  act(() => useCamStore.getState().newProject())
  act(() => useCamStore.getState().closeModal())
  seed()
})
afterEach(cleanup)

describe('WO-2273 new Face states its automatic finished face', () => {
  it('creates from Stock without opening Heights and stores the plane its row displays', async () => {
    openFace()
    fireEvent.click(screen.getByText('Geometry'))
    expect(screen.queryByTestId('face-height-mode')).toBeNull()
    const create = screen.getByTestId('op-create') as HTMLButtonElement
    await waitFor(() => expect(create.disabled).toBe(false))
    fireEvent.click(create)
    const created = useCamStore.getState().project.setups[0].operations[0]
    expect(created.type).toBe('face')
    expect(created.params).toMatchObject({ boundarySource: 'stock' })
    expect(created.smartHeight).toMatchObject({ kind: 'smart_v2', intent: {
      policy: { operationType: 'face', variant: 'explicit_depth' },
      machining: { end: { value: { kind: 'bounded_plane', plane: {
        reference: 'wcs_plane', offsetMm: -5,
      } } } },
    } })
    // Read the same persisted operation through the production editor and resolver.
    act(() => useCamStore.getState().openEditOperation('setup-2273', created.id))
    fireEvent.click(screen.getByText('Heights'))
    await waitFor(() => expect(screen.getByTestId('standard-height-bottom-resolved').textContent)
      .toContain('-5.000'))
    fireEvent.click(within(screen.getByTestId('standard-height-bottom')).getByRole('button'))
    expect((screen.getByTestId('face-height-mode') as HTMLSelectElement).value).toBe('explicit_depth')
    const plan = await preview('setup-2273', created)
    expect(plan.machining.physicalTarget).toMatchObject({ wcsMm: -5 })
  })

  it('names the Finished face choice when a source cannot resolve any finished face', async () => {
    seed(false)
    openFace()
    const create = screen.getByTestId('op-create') as HTMLButtonElement
    expect(create.disabled).toBe(true)
    expect(create.getAttribute('data-tooltip')).toContain('Heights > Bottom Height > Finished face')
  })

  it('keeps an operator-selected unresolved model face and explains how to choose it', async () => {
    openFace()
    fireEvent.click(screen.getByText('Heights'))
    fireEvent.change(screen.getByTestId('face-height-mode'), { target: { value: 'target_face' } })
    await waitFor(() => expect(screen.getByTestId('op-create').getAttribute('data-tooltip'))
      .toContain('Heights > Bottom Height > Finished face'))
    expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('face-height-mode') as HTMLSelectElement).value).toBe('target_face')
  })
})
