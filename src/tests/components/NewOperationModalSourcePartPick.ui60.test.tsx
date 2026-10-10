// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ImportedGeometry, Setup } from '../../types'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (key) => mem.get(key) ?? null,
  key: (index) => Array.from(mem.keys())[index] ?? null,
  removeItem: (key) => { mem.delete(key) },
  setItem: (key, value) => { mem.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', {
  value: memStorage,
  configurable: true,
})

const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { useCamStore } = await import('../../store')

const CURVES_ID = 'curves-source'
const SOLID_ID = 'solid-source'
let pickedPart: ((id: string) => void) | null = null
let allowedPartIds: readonly string[] = []

function seedProject() {
  const geometry = [
    {
      id: CURVES_ID,
      name: 'Plate profile',
      type: 'curves_2d',
      format: 'svg',
      loaded: true,
      loops: [{
        id: 'outer',
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
        closed: true,
        type: 'contour',
        layerId: 'layer-1',
        area: 100,
      }],
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      boundingBox: {
        min: { x: 0, y: 0, z: 0 },
        max: { x: 10, y: 10, z: 0 },
      },
    },
    {
      id: SOLID_ID,
      name: 'Solid body',
      type: 'mesh',
      format: 'stl',
      loaded: true,
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      boundingBox: {
        min: { x: 0, y: 0, z: 0 },
        max: { x: 10, y: 10, z: 5 },
      },
    },
  ] as unknown as ImportedGeometry[]
  const setup = {
    id: 'setup-1',
    name: 'Setup 1',
    wcs: {
      id: 'wcs-1',
      label: 'G54',
      fixtureOffset: 54,
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: 1, z: 0 },
      zAxis: { x: 0, y: 0, z: 1 },
    },
    stock: null,
    operations: [],
    notes: '',
  } as unknown as Setup

  const current = useCamStore.getState()
  useCamStore.setState({
    project: {
      ...current.project,
      geometry,
      setups: [setup],
      activeSetupId: setup.id,
    },
  })
}

beforeEach(() => {
  act(() => { useCamStore.getState().newProject() })
  pickedPart = null
  allowedPartIds = []
  ;(window as unknown as Record<string, unknown>).__cncViewport = {
    setPartPickMode: (
      callback: ((id: string) => void) | null,
      allowedIds: readonly string[] = [],
    ) => {
      pickedPart = callback
      allowedPartIds = allowedIds
    },
    setSelectedPart: vi.fn(),
  }
  seedProject()
})

afterEach(() => {
  cleanup()
  delete (window as unknown as Record<string, unknown>).__cncViewport
})

describe('UI-60 operation source part viewport picking', () => {
  it('uses one whole-part picker for every 2D and 2.5D operation', () => {
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
    fireEvent.click(screen.getByText('Geometry'))
    fireEvent.click(screen.getByTestId('op-pick-source-part'))

    expect(screen.getByTestId('op-source-part-pick-banner')).not.toBeNull()
    // WO-329 (1fb177b8) widened the viewport picker to also admit a
    // loop-less STL mesh for chain-eligible op types: picking it now derives
    // its edge chains through the same path the dropdown uses, so both doors
    // open the same lock (isViewportPickableOperationSource,
    // NewOperationModalBody.tsx). SOLID_ID is a loop-less STL mesh, so it is
    // admitted alongside CURVES_ID for the default contour_2d type.
    expect(allowedPartIds).toEqual([CURVES_ID, SOLID_ID])
    const choose = pickedPart
    expect(choose).not.toBeNull()
    act(() => { choose?.(CURVES_ID) })

    expect(screen.queryByTestId('op-source-part-pick-banner')).toBeNull()
    expect((screen.getByTestId('op-geometry-select') as HTMLSelectElement).value)
      .toBe(CURVES_ID)
  })

  it('uses the same picker contract for the two solid operations', () => {
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
    fireEvent.click(screen.getByText('Parallel Finish (3D)'))
    fireEvent.click(screen.getByText('Geometry'))
    fireEvent.click(screen.getByTestId('op-parallel3d-pick-source'))

    expect(allowedPartIds).toEqual([SOLID_ID])
    const choose = pickedPart
    act(() => { choose?.(SOLID_ID) })

    expect((screen.getByTestId('op-parallel3d-part-select') as HTMLSelectElement).value)
      .toBe(SOLID_ID)
  })
})
