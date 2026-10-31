// @vitest-environment jsdom
// WO-2534: through the production New Operation dialog, a drill on detected holes shows the
// Bottom Height offset box to 3 decimals (the row above reads WCS -15.202 mm) while the
// operation keeps the exact value. Also pins the display helper for mm and inch.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImportedGeometry, Operation, PhysicalStock, ResolvedHeightSnapshotV1, Setup, Tool } from '../../types'
import { smartHeightPlanFixture } from '../helpers/smartHeightPlanFixture'

const memory = new Map<string, string>()
const storage: Storage = {
  get length() { return memory.size }, clear: () => memory.clear(),
  getItem: key => memory.get(key) ?? null, key: index => Array.from(memory.keys())[index] ?? null,
  removeItem: key => { memory.delete(key) }, setItem: (key, value) => { memory.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })

const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { useCamStore } = await import('../../store')
const { heightOffsetBoxValue } = await import('../../components/modals/useHeightOffsetDisplay')

const EXACT = -15.2017213

const stock = {
  id: 'stock-1', name: 'Stock 1', mode: 'explicit',
  bounds: {
    min: { x: 0, y: 0, z: 0 }, max: { x: 100, y: 80, z: 20 },
    size: { x: 100, y: 80, z: 20 }, center: { x: 50, y: 40, z: 10 },
  },
  position: { x: 0, y: 0, z: 0 },
} as PhysicalStock

const tool = {
  id: 'drill-1', name: '6 mm Drill', type: 'drill', diameter: 6,
  fluteLength: 25, shankDiameter: 6, overallLength: 60, numberOfFlutes: 2,
  angleFromAxisDeg: 59, tipDiameter: 0,
} as unknown as Tool

const snapshot: ResolvedHeightSnapshotV1 = {
  version: 1,
  wcs: { clearance: 30, retract: 25, feed: 22, top: 20, bottom: EXACT },
  machine: { clearance: 30, retract: 25, feed: 22, top: 20, bottom: EXACT },
  intent: {
    version: 1,
    clearance: { reference: 'wcs_plane', offset: 30, provenance: 'inferred' },
    retract: { reference: 'wcs_plane', offset: 25, provenance: 'inferred' },
    feed: { reference: 'wcs_plane', offset: 22, provenance: 'inferred' },
    top: { reference: 'wcs_plane', offset: 20, provenance: 'inferred' },
    bottom: { reference: 'wcs_plane', offset: EXACT, provenance: 'inferred' },
  },
  dependencyIds: [stock.id, 'part-1'],
}

const geometry = {
  id: 'part-1', name: 'Hole.step', filename: 'Hole.step', type: 'brep', format: 'step',
  loaded: true, stockId: stock.id,
  position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
  boundingBox: {
    min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 20, z: 10 },
    size: { x: 20, y: 20, z: 10 }, center: { x: 10, y: 10, z: 5 },
  },
  loops: [{
    id: 'hole-1', layerId: 'holes', closed: true, type: 'contour', area: 28,
    points: [{ x: 7, y: 10 }, { x: 10, y: 13 }, { x: 13, y: 10 }, { x: 10, y: 7 }],
  }],
  layers2d: [{
    id: 'holes', name: 'Holes', color: '#fff', visible: true, frame: 'geometry_local',
    holes: [{ center: [10, 10], diameter: 6, topZ: 10, bottomZ: 4, through: false, loopId: 'hole-1' }],
  }],
} as unknown as ImportedGeometry

const activeSetup = {
  id: 'setup-1', name: 'Setup 1', notes: '', operations: [] as Operation[],
  wcs: {
    id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
    xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 }, stockId: stock.id,
  },
  stock: null,
} as unknown as Setup

beforeEach(() => {
  act(() => useCamStore.getState().newProject())
  act(() => useCamStore.getState().closeModal())
})
afterEach(cleanup)

describe('WO-2534 height offset box shows 3 decimals', () => {
  it('rounds the displayed offset in mm and inch without touching the stored value', () => {
    expect(heightOffsetBoxValue(15.2017213, 'mm')).toBe(15.202)
    expect(heightOffsetBoxValue(5, 'mm')).toBe(5)
    expect(heightOffsetBoxValue(15.2017213, 'inch')).toBeCloseTo(0.598 * 25.4, 9)
  })

  async function openDrillHeights() {
    const state = useCamStore.getState()
    useCamStore.setState({
      toolLibrary: [tool], computeOperationToolpath: vi.fn(),
      previewOperationSmartHeightPlan: vi.fn(async (_id: string, operation: Operation) =>
        smartHeightPlanFixture(operation, snapshot)),
      previewDrillBoreSmartHeights: vi.fn(() => snapshot),
      project: {
        ...state.project, setups: [activeSetup], activeSetupId: activeSetup.id,
        stocks: [stock], geometry: [geometry],
      },
    } as never)
    render(<NewOperationModal />)
    act(() => useCamStore.getState().openModal('new-operation'))
    fireEvent.click(screen.getByText('Drill'))
    fireEvent.click(screen.getByText('Tool'))
    fireEvent.click(screen.getByText(tool.name))
    fireEvent.click(screen.getByText('Geometry'))
    fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: 'part-1' } })
    fireEvent.click(screen.getByRole('button', { name: /All loops/ }))
    fireEvent.click(screen.getByText('Heights'))
    await waitFor(() => expect(screen.getByTestId('drill-bore-height-policy')).not.toBeNull())
    await waitFor(() => expect(screen.getByTestId('resolved-height-plan')).not.toBeNull())
  }

  it('Drill on model holes: box 15.202, row WCS -15.202 mm, operation keeps the exact bottom', async () => {
    await openDrillHeights()
    fireEvent.click(screen.getByRole('button', { name: /Expand Bottom Height/ }))
    const box = () => screen.getByTestId('standard-height-bottom-offset-control').querySelector('input') as HTMLInputElement
    await waitFor(() => expect(screen.getByTestId('standard-height-bottom-resolved').textContent).toContain('-15.202'))
    expect(screen.getByTestId('standard-height-bottom-resolved').textContent).not.toContain('15.2017')
    expect(box().value).toBe('15.202')

    // Focusing and leaving the box untouched keeps the exact value.
    fireEvent.focus(box())
    fireEvent.blur(box())
    expect(box().value).toBe('15.202')
    // WO-3137 invalidates the previous plan when an offset changes.
    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('op-create'))
    const created = useCamStore.getState().project.setups[0].operations.at(-1)!
    // The untouched box wrote nothing: still the detected-floors plan, no rounded depth stored anywhere.
    expect(created.smartHeight).toMatchObject({
      kind: 'smart_v2', intent: { policy: { operationType: 'drill', variant: 'detected_features' } },
    })
    expect(JSON.stringify(created)).not.toContain('15.202')
  })

  it('a typed offset stays as typed after blur and commit', async () => {
    await openDrillHeights()
    fireEvent.click(screen.getByRole('button', { name: /Expand Bottom Height/ }))
    fireEvent.change(screen.getByTestId('standard-height-bottom-source-control'), { target: { value: 'wcs_plane' } })
    const box = () => screen.getByTestId('standard-height-bottom-offset-control').querySelector('input') as HTMLInputElement
    fireEvent.focus(box())
    fireEvent.change(box(), { target: { value: '12.34567' } })
    fireEvent.blur(box())
    await waitFor(() => expect(box().value).toBe('12.34567'))
    // Saved and reopened: the operator's value is still shown as typed.
    // WO-3137 invalidates the previous plan when an offset changes.
    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('op-create'))
    const created = useCamStore.getState().project.setups[0].operations.at(-1)!
    act(() => useCamStore.getState().closeModal())
    act(() => useCamStore.getState().openEditOperation(activeSetup.id, created.id))
    fireEvent.click(screen.getByText('Heights'))
    fireEvent.click(screen.getByRole('button', { name: /Expand Bottom Height/ }))
    await waitFor(() => expect(box().value).toBe('12.34567'))
  })
})
