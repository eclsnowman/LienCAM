// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImportedGeometry, Operation, PhysicalStock, Setup, Tool } from '../../types'
import type { ResolvedHeightPlanV2 } from '../../lib/cam/smartHeights'
import { smartHeightPlanFixture } from '../helpers/smartHeightPlanFixture'

const memory = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => memory.set(key, value),
  removeItem: (key: string) => memory.delete(key), clear: () => memory.clear(),
} })
const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { useCamStore } = await import('../../store')
const stock = { id: 'stock-1', name: 'Stock 1', mode: 'explicit',
  bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 100, y: 80, z: 20 },
    size: { x: 100, y: 80, z: 20 }, center: { x: 50, y: 40, z: 10 } },
  position: { x: 0, y: 0, z: 0 },
} as PhysicalStock
const flat = { id: 'flat', name: '6 mm flat', type: 'flat_end_mill', diameter: 6,
  fluteLength: 25, shankDiameter: 6, overallLength: 60, numberOfFlutes: 2 } as Tool
const nextFlat = { ...flat, id: 'next-flat', name: '8 mm flat', diameter: 8 } as Tool
const vbit = { ...flat, id: 'vbit', name: 'V-bit 60', type: 'v_bit', angleFromAxisDeg: 30, tipDiameter: 0 } as Tool
const source = { id: 'part-1', name: 'Open.svg', filename: 'Open.svg', loaded: true,
  type: 'curves_2d', format: 'svg', stockId: stock.id, boundingBox: stock.bounds,
  position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
  loops: [{ id: 'open', closed: false, type: 'contour', points: [{ x: 0, y: 0 }, { x: 20, y: 20 }] }],
} as ImportedGeometry
function seed(model = false) {
  const setup = { id: 'setup-1', name: 'Setup 1', notes: '', operations: [],
    stock: { type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 5, offsetZBottom: 0, material: '' },
    wcs: { id: 'wcs-1', label: 'G54', fixtureOffset: 54, stockId: stock.id,
      origin: { x: 0, y: 0, z: 0 }, xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 } },
  } as unknown as Setup
  useCamStore.setState({ toolLibrary: [flat, nextFlat, vbit], computeOperationToolpath: vi.fn(),
    project: { ...useCamStore.getState().project, setups: [setup], activeSetupId: setup.id,
      stocks: [stock], geometry: [model ? { ...source, type: 'brep', format: 'step', name: 'Part 1', loops: [] } as ImportedGeometry : source] },
  })
  render(<NewOperationModal />)
  act(() => useCamStore.getState().openModal('new-operation'))
}
function pick(label: string, tool = flat) {
  fireEvent.click(screen.getByText(label, { exact: true }))
  fireEvent.click(screen.getByText('Tool', { exact: true }))
  fireEvent.click(screen.getByText(tool.name, { exact: true }))
  fireEvent.click(screen.getByRole('button', { name: 'Geometry' }))
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function plan(op: Operation) {
  return smartHeightPlanFixture(op, { version: 1,
    wcs: { clearance: 30, retract: 25, feed: 22, top: 20, bottom: 0 },
    machine: { clearance: 30, retract: 25, feed: 22, top: 20, bottom: 0 },
  } as never)
}
const reason = () => screen.queryByTestId('op-create-reason')?.textContent
const disabled = () => (screen.getByTestId('op-create') as HTMLButtonElement).disabled
beforeEach(() => { act(() => useCamStore.getState().newProject()); act(() => useCamStore.getState().closeModal()) })
afterEach(cleanup)

describe('WO-3137 actual modal Create readiness', () => {
  it.each([['V-Carve', vbit], ['Thread Mill', flat]] as const)('%s explains open-only geometry without claiming a job is pending', async (label, tool) => {
    const preview = vi.fn()
    useCamStore.setState({ previewOperationSmartHeightPlan: preview })
    seed()
    pick(label, tool)
    fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: source.id } })
    await act(() => new Promise(resolve => setTimeout(resolve, 300)))
    expect(disabled()).toBe(true)
    expect(reason()).toBe('Select geometry with closed profiles to machine.')
    expect(preview).not.toHaveBeenCalled()
  })

  it('shows the real Adaptive preflight error and settles a later valid draft', async () => {
    const preview = vi.fn(async (_setup: string, op: Operation) => {
      if (op.toolId === flat.id) throw new Error("Adaptive 3D Smart Height refused (missing_evidence): Smart Height requires 'owning_stock' evidence.")
      return plan(op)
    })
    useCamStore.setState({ previewOperationSmartHeightPlan: preview })
    seed(true); pick('Adaptive Rough (3D)')
    fireEvent.change(screen.getByTestId('op-adaptive3d-part-select'), { target: { value: source.id } })
    await waitFor(() => expect(reason()).toBe("Select this part's stock in Setup."))
    expect(disabled()).toBe(true)
    // Retry a draft after the prerequisite is corrected; no validation is bypassed.
    preview.mockImplementation(async (_setup, op) => plan(op))
    fireEvent.click(screen.getByRole('button', { name: 'Type & Name' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Retry rough' } })
    await waitFor(() => expect(disabled()).toBe(false))
    fireEvent.click(screen.getByTestId('op-create'))
    expect(useCamStore.getState().project.setups[0].operations.at(-1)?.type).toBe('adaptive_3d')
  })

  it('invalidates resolved results during debounce and ignores cancelled late jobs across reopen', async () => {
    const jobs: { op: Operation; job: ReturnType<typeof deferred<ResolvedHeightPlanV2>> }[] = []
    useCamStore.setState({ previewOperationSmartHeightPlan: vi.fn((_setup, op) => {
      const job = deferred<ResolvedHeightPlanV2>(); jobs.push({ op, job }); return job.promise
    }) })
    seed(true); pick('Adaptive Rough (3D)')
    fireEvent.change(screen.getByTestId('op-adaptive3d-part-select'), { target: { value: source.id } })
    await waitFor(() => expect(jobs.length).toBeGreaterThan(0))
    expect(disabled()).toBe(true)
    const first = jobs.at(-1)!
    await act(async () => first.job.resolve(plan(first.op)))
    expect(disabled()).toBe(false)
    // A different cutter changes the actual height/strategy draft, not just its label.
    fireEvent.click(screen.getByText('Tool', { exact: true }))
    fireEvent.click(screen.getByText(nextFlat.name, { exact: true }))
    expect(disabled()).toBe(true)
    await waitFor(() => expect(jobs.length).toBeGreaterThan(1))
    expect(reason()).toBe('Calculating Smart Height...')
    const stale = jobs.at(-1)!
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    act(() => useCamStore.getState().openModal('new-operation'))
    pick('Adaptive Rough (3D)')
    await act(async () => stale.job.resolve(plan(stale.op)))
    expect(disabled()).toBe(true)
    await waitFor(() => expect(jobs.length).toBeGreaterThan(2))
    const live = jobs.at(-1)!
    await act(async () => live.job.resolve(plan(live.op)))
    expect(disabled()).toBe(false)
  })
  it('keeps closed V-Carve selection, explicit clear, New and Edit on the same readiness path', async () => {
    useCamStore.setState({ previewOperationSmartHeightPlan: vi.fn(async (_setup, op) => plan(op)) })
    seed()
    act(() => useCamStore.setState({ project: { ...useCamStore.getState().project,
      geometry: [{ ...source, loops: [{ ...source.loops![0], closed: true, area: 400,
        points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }],
      }] }],
    } }))
    pick('V-Carve', vbit)
    fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: source.id } })
    fireEvent.click(screen.getByRole('button', { name: /All loops/ }))
    await waitFor(() => expect(disabled()).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: /Clear/ }))
    expect(disabled()).toBe(true)
    expect(reason()).toMatch(/No loops are selected/)
    fireEvent.click(screen.getByRole('button', { name: /All loops/ }))
    await waitFor(() => expect(disabled()).toBe(false))
    fireEvent.click(screen.getByTestId('op-create'))
    const created = useCamStore.getState().project.setups[0].operations.at(-1)!
    act(() => useCamStore.getState().openEditOperation('setup-1', created.id))
    await waitFor(() => expect(disabled()).toBe(false))
    fireEvent.click(screen.getByTestId('op-create'))
    expect(useCamStore.getState().project.setups[0].operations).toHaveLength(1)
  })

})
