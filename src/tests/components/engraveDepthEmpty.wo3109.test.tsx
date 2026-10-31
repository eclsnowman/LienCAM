// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImportedGeometry, Operation, ResolvedHeightSnapshotV1, Setup, Tool } from '../../types'
import { smartHeightPlanFixture } from '../helpers/smartHeightPlanFixture'

const memory = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    get length() { return memory.size }, clear: () => memory.clear(),
    getItem: (key: string) => memory.get(key) ?? null,
    key: (index: number) => Array.from(memory.keys())[index] ?? null,
    removeItem: (key: string) => { memory.delete(key) },
    setItem: (key: string, value: string) => { memory.set(key, String(value)) },
  } satisfies Storage,
})

const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { useCamStore } = await import('../../store')
const { validatePersistedSmartHeightState } = await import('../../lib/cam/smartHeights')

const ENGRAVE_TOOL = {
  id: 'engrave-tool', name: '90 degree engraving bit', type: 'chamfer_mill', diameter: 6,
  tipDiameter: 0.5, fluteLength: 10, shankDiameter: 6, overallLength: 50,
  numberOfFlutes: 2, angleFromAxisDeg: 45,
} as unknown as Tool
const V_BIT = {
  id: 'v-bit', name: '90 degree V-bit', type: 'v_bit', diameter: 6,
  tipDiameter: 0, fluteLength: 10, shankDiameter: 6, overallLength: 50,
  numberOfFlutes: 2, angleFromAxisDeg: 45,
} as unknown as Tool
const SNAPSHOT: ResolvedHeightSnapshotV1 = {
  version: 1,
  wcs: { clearance: 15, retract: 5, feed: 2, top: 10, bottom: 9 },
  machine: { clearance: 15, retract: 5, feed: 2, top: 10, bottom: 9 },
  intent: {
    version: 1,
    clearance: { reference: 'wcs_plane', offset: 15, provenance: 'inferred' },
    retract: { reference: 'wcs_plane', offset: 5, provenance: 'inferred' },
    feed: { reference: 'wcs_plane', offset: 2, provenance: 'inferred' },
    top: { reference: 'wcs_plane', offset: 10, provenance: 'inferred' },
    bottom: { reference: 'wcs_plane', offset: 9, provenance: 'inferred' },
  },
  dependencyIds: ['art', ENGRAVE_TOOL.id, V_BIT.id],
}

function seed() {
  const geometry = {
    id: 'art', name: 'Artwork.svg', filename: 'Artwork.svg', type: 'curves_2d', format: 'svg', loaded: true,
    loopsVersion: 1, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 0 }, size: { x: 10, y: 10, z: 0 }, center: { x: 5, y: 5, z: 0 } },
    loops: [{ id: 'loop', layerId: 'art-layer', closed: true, type: 'contour', area: 100,
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }] }],
    layers2d: [{ id: 'art-layer', name: 'Artwork', color: '#fff', visible: true }],
  } as unknown as ImportedGeometry
  const setup = {
    id: 'setup-1', name: 'Setup 1', notes: '', operations: [], stock: { type: 'auto' },
    wcs: { id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 } },
  } as unknown as Setup
  const current = useCamStore.getState()
  useCamStore.setState({
    toolLibrary: [ENGRAVE_TOOL, V_BIT], computeOperationToolpath: vi.fn(),
    previewOperationSmartHeightPlan: vi.fn(async (_setupId: string, operation: Operation) => {
      expect(validatePersistedSmartHeightState(operation.smartHeight).ok).toBe(true)
      return smartHeightPlanFixture(operation, SNAPSHOT)
    }),
    project: { ...current.project, geometry: [geometry], setups: [setup], activeSetupId: setup.id },
  } as never)
}

async function author(type: 'engrave' | 'vcarve') {
  fireEvent.click(screen.getByText(type === 'engrave' ? 'Engrave / Trace' : 'V-Carve'))
  fireEvent.click(screen.getByText('Tool'))
  fireEvent.click(screen.getByText(type === 'engrave' ? ENGRAVE_TOOL.name : V_BIT.name))
  fireEvent.click(screen.getByText('Geometry'))
  fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: 'art' } })
  fireEvent.click(screen.getByRole('button', { name: /All loops/ }))
  if (type === 'engrave') {
    fireEvent.click(screen.getByText('Passes'))
    fireEvent.click(screen.getByText('V-engrave'))
  }
  fireEvent.click(screen.getByText('Heights'))
  fireEvent.click(screen.getByRole('button', { name: 'Expand Top Height height' }))
  await waitFor(() => expect(screen.getByTestId(type === 'engrave' ? 'engrave-height-policy' : 'vcarve-height-policy')).not.toBeNull())
}

function engravingDepth(): HTMLInputElement {
  return screen.getByText('Engraving depth').closest('.op-field-row')!.querySelector('input')!
}

beforeEach(() => {
  act(() => useCamStore.getState().newProject())
  act(() => useCamStore.getState().closeModal())
  seed()
})
afterEach(cleanup)

describe('WO-3109 empty engrave depth presentation', () => {
  it('keeps an unset V-engrave depth visually empty through clear and retype, then authors the entered depth', async () => {
    render(<NewOperationModal />)
    act(() => useCamStore.getState().openModal('new-operation'))
    await author('engrave')

    const depth = engravingDepth()
    expect(depth.value).toBe('')
    expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(true)

    fireEvent.focus(depth)
    fireEvent.change(depth, { target: { value: '1.25' } })
    fireEvent.blur(depth)
    await waitFor(() => expect(depth.value).toBe('1.25'))
    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))

    fireEvent.focus(depth)
    fireEvent.change(depth, { target: { value: '' } })
    fireEvent.blur(depth)
    await waitFor(() => expect(depth.value).toBe(''))
    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(true))

    fireEvent.focus(depth)
    fireEvent.change(depth, { target: { value: '2.5' } })
    fireEvent.blur(depth)
    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('op-create'))
    expect(useCamStore.getState().project.setups[0].operations[0].smartHeight).toMatchObject({
      intent: { machining: { end: { value: { formula: { depth: { kind: 'explicit', depthMm: 2.5 } } } } } },
    })
  })

  it('keeps the V-Carve unset route on the bit limit instead of manufacturing a numeric depth', async () => {
    render(<NewOperationModal />)
    act(() => useCamStore.getState().openModal('new-operation'))
    await author('vcarve')
    fireEvent.click(screen.getByText('Passes'))

    expect(screen.getByTestId('vcarve-depth-tool-limit').className).toContain('op-toggle-active')
    expect(screen.queryByText('Flat depth')?.closest('.op-field-row')).toBeNull()
    await waitFor(() => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('op-create'))
    expect(useCamStore.getState().project.setups[0].operations[0].smartHeight).toMatchObject({
      intent: { policy: { operationType: 'vcarve', variant: 'tool_limit' } },
    })
  })
})
