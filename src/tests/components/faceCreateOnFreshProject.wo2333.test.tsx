// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
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
  id: 'stock-2333', name: 'Stock 1', mode: 'explicit',
  bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 100, y: 80, z: 20 },
    size: { x: 100, y: 80, z: 20 }, center: { x: 50, y: 40, z: 10 } },
  position: { x: 0, y: 0, z: 0 },
} as PhysicalStock
const tool = {
  id: 'tool-2333', name: 'Face mill 12mm', type: 'flat_end_mill', diameter: 12,
  fluteLength: 25, shankDiameter: 12, overallLength: 60, numberOfFlutes: 3,
} as unknown as Tool

function seed(withStock = true) {
  const state = useCamStore.getState()
  const setup = {
    id: 'setup-2333', name: 'Setup 1', notes: '', operations: [], stock: null,
    wcs: { id: 'wcs-2333', label: 'G54', fixtureOffset: 54,
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

describe('WO-2333 fresh-project Face preflight', () => {
  it('routes the fresh-PC journey through automatic Face creation only', () => {
    // The journey is a Node CLI; execute its import in Node, outside jsdom's
    // browser URL loader. Importing it must not start the nine-step CLI.
    const result = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { automaticFaceOperations } from './e2e/fresh-pc-journey.mjs'
      import { OPERATIONS } from './e2e/steps/cam-steps.mjs'
      console.log(JSON.stringify({ operations: automaticFaceOperations(OPERATIONS), original: OPERATIONS }))
    `], { encoding: 'utf8' })
    const { operations, original } = JSON.parse(result)
    expect(operations[0]).toEqual({ name: 'Journey Face', type: '2D Face', tool: 'Journey 6mm end mill' })
    expect(operations.slice(1)).toEqual(original.slice(1))
    expect(original[0].face).toEqual({ targetWcs: -1 })
  })

  it('waits for preflight, then enables Create without authoring a finished face', async () => {
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const resolver = vi.fn(async (...args: Parameters<typeof preview>) => {
      const plan = await preview(...args)
      await pending
      return plan
    })
    act(() => useCamStore.setState({ previewOperationSmartHeightPlan: resolver }))
    openFace()
    fireEvent.click(screen.getByText('Geometry'))
    fireEvent.click(screen.getByRole('button', { name: /^Stock$/ }))
    const create = screen.getByTestId('op-create') as HTMLButtonElement
    expect(create.disabled).toBe(true)
    // WO-3137 gives the actual idle/pending reason instead of the old generic instruction.
    expect(create.getAttribute('data-tooltip')).toBe('Smart Height has not resolved for the current inputs.')
    await waitFor(() => expect(resolver).toHaveBeenCalled())
    expect(create.disabled).toBe(true)
    expect(screen.queryByTestId('face-height-mode')).toBeNull()
    await act(async () => { release(); await pending })
    await waitFor(() => expect(create.disabled).toBe(false))
    fireEvent.click(screen.getByText('Heights'))
    expect(screen.getByTestId('standard-height-bottom-resolved').textContent).toContain('-5.000')
    await waitFor(() => expect(create.disabled).toBe(false))
    fireEvent.click(create)
    const created = useCamStore.getState().project.setups[0].operations[0]
    expect(created.type).toBe('face')
    expect(created.params).toMatchObject({ boundarySource: 'stock' })
    const plan = await preview('setup-2333', created)
    expect(plan.machining.physicalTarget).toMatchObject({ wcsMm: -5 })
  })

  it('keeps the automatic finished plane editable before creating', async () => {
    openFace()
    fireEvent.click(screen.getByText('Geometry'))
    fireEvent.click(screen.getByRole('button', { name: /^Stock$/ }))
    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByText('Heights'))
    fireEvent.click(within(screen.getByTestId('standard-height-bottom')).getByRole('button'))
    const input = screen.getByTestId('face-explicit-target').querySelector('input')!
    fireEvent.change(input, { target: { value: '-1' } })
    fireEvent.blur(input)
    await waitFor(() => expect(screen.getByTestId('standard-height-bottom-resolved').textContent).toContain('-1.000'))
    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('op-create'))
    const created = useCamStore.getState().project.setups[0].operations[0]
    const plan = await preview('setup-2333', created)
    expect(plan.machining.physicalTarget).toMatchObject({ wcsMm: -1 })
  })
})
