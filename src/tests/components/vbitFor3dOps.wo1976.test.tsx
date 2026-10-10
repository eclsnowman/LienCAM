// @vitest-environment jsdom
// WO-1976: a V-bit can be chosen for Parallel finish (WO-1971 kernel); the other 3D ops
// whose engines still refuse a V-bit keep their end-mill-only gate.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react'
import type { ImportedGeometry, Operation, ResolvedHeightSnapshotV1, Setup, Tool } from '../../types'
import { smartHeightPlanFixture } from '../helpers/smartHeightPlanFixture'

// jsdom's localStorage is unreliable under vitest's node launch flags and the
// Zustand store uses persist(); install an in-memory shim BEFORE importing the
// store (mirrors the other *.smoke.test.tsx files).
const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { useCamStore } = await import('../../store')
const { defaultHeightIntent } = await import('../../lib/cam/heightIntent')

const SETUP_ID = 'setup-1'
const GEO_ID = 'geo-solid-1'
const TOOL_ID = 'tool-flat-1'

const vbitTool = {
  id: 'tool-vbit-1', name: 'V-bit 60', type: 'v_bit', diameter: 6, angleFromAxisDeg: 30, tipDiameter: 0,
  fluteLength: 10, numberOfFlutes: 2,
} as unknown as Tool

const flatTool = {
  id: TOOL_ID, name: 'Flat 6mm', type: 'flat_end_mill', diameter: 6,
  fluteLength: 20, numberOfFlutes: 2,
} as unknown as Tool

const parallelSnapshot: ResolvedHeightSnapshotV1 = {
  version: 1,
  wcs: { clearance: 15, retract: 12, feed: 10.5, top: 10, bottom: 2 },
  machine: { clearance: 15, retract: 12, feed: 10.5, top: 10, bottom: 2 },
  intent: defaultHeightIntent(),
  dependencyIds: [GEO_ID],
}

// A single imported SOLID (STL mesh) so the parallel_3d part picker default-selects it.
function seedSolid(): void {
  const geo = {
    id: GEO_ID, name: 'Widget', type: 'mesh', format: 'stl', loaded: true,
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 20, z: 10 } },
  } as unknown as ImportedGeometry
  const wcs = {
    id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
    xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
  }
  const setup = { id: SETUP_ID, name: 'Setup 1', wcs, stock: null, operations: [], notes: '' } as unknown as Setup
  act(() => {
    const s = useCamStore.getState() as unknown as { project: Record<string, unknown> }
    useCamStore.setState({
      toolLibrary: [flatTool, vbitTool],
      previewOperationSmartHeightPlan: vi.fn(async (_setupId: string, operation: Operation) =>
        smartHeightPlanFixture(operation, parallelSnapshot)),
      project: { ...s.project, geometry: [geo], setups: [setup], activeSetupId: SETUP_ID },
    } as never)
  })
}

afterEach(cleanup)
beforeEach(() => {
  act(() => { useCamStore.getState().newProject() })
  act(() => { useCamStore.getState().closeModal() })
})

const createBtn = () => screen.getByTestId('op-create') as HTMLButtonElement

async function pickVbitFor(label: string) {
  seedSolid()
  render(<NewOperationModal />)
  act(() => { useCamStore.getState().openModal('new-operation') })
  fireEvent.click(screen.getByText(label))
  fireEvent.click(screen.getByText('Tool'))
  fireEvent.click(screen.getByText('V-bit 60'))
}

describe('V-bit in the New Operation dialog (WO-1976)', () => {
  it('Parallel finish: choosing a V-bit enables Create', async () => {
    await pickVbitFor('Parallel Finish (3D)')
    await waitFor(() => expect(createBtn().disabled).toBe(false))
  })

  it('Parallel finish: a flat end mill still enables Create', async () => {
    seedSolid()
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
    fireEvent.click(screen.getByText('Parallel Finish (3D)'))
    fireEvent.click(screen.getByText('Tool'))
    fireEvent.click(screen.getByText('Flat 6mm'))
    await waitFor(() => expect(createBtn().disabled).toBe(false))
  })

  it('Waterline keeps its refusal for a V-bit', async () => {
    await pickVbitFor('Waterline Finish (3D)')
    await new Promise(r => setTimeout(r, 50))
    expect(createBtn().disabled).toBe(true)
  })

  it('Scallop keeps its refusal with the named message', async () => {
    await pickVbitFor('Scallop Finish (3D)')
    await new Promise(r => setTimeout(r, 50))
    expect(createBtn().disabled).toBe(true)
    expect(createBtn().getAttribute('data-tooltip')).toBe('3D finish needs a flat, ball, or bull-nose end mill')
  })

  it.each(['Pencil Cleanup (3D)', 'Steep and Shallow (3D)', 'Adaptive Rough (3D)'])(
    '%s keeps its end-mill-only gate for a V-bit', async (label) => {
      await pickVbitFor(label)
      await new Promise(r => setTimeout(r, 50))
      expect(createBtn().disabled).toBe(true)
    })
})
