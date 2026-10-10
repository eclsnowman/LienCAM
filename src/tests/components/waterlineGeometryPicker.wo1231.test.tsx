// @vitest-environment jsdom
//
// Waterline is a 3D solid operation. Its Geometry tab owns the solid picker;
// the generic 2D source picker must remain unavailable there while still being
// offered to profile operations that consume loops.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ImportedGeometry, Setup } from '../../types'

const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    get length() { return mem.size },
    clear: () => mem.clear(),
    getItem: (key: string) => mem.get(key) ?? null,
    key: (index: number) => Array.from(mem.keys())[index] ?? null,
    removeItem: (key: string) => { mem.delete(key) },
    setItem: (key: string, value: string) => { mem.set(key, String(value)) },
  } satisfies Storage,
})

const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { useCamStore } = await import('../../store')

function seedProject() {
  const solid = {
    id: 'waterline-solid', name: 'Waterline solid', type: 'brep', format: 'step', loaded: true,
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 5 } },
  } as unknown as ImportedGeometry
  const setup = {
    id: 'setup-1', name: 'Setup 1', stock: null, operations: [], notes: '',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54,
      origin: { x: 0, y: 0, z: 0 }, xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
    },
  } as unknown as Setup
  const current = useCamStore.getState()
  useCamStore.setState({
    project: { ...current.project, geometry: [solid], setups: [setup], activeSetupId: setup.id },
  } as never)
}

beforeEach(() => {
  act(() => { useCamStore.getState().newProject() })
  ;(window as unknown as Record<string, unknown>).__cncViewport = {
    setPartPickMode: vi.fn(), setSelectedPart: vi.fn(),
  }
  seedProject()
})

afterEach(() => {
  cleanup()
  delete (window as unknown as Record<string, unknown>).__cncViewport
})

function openOperationGeometry(type: 'waterline' | 'contour') {
  render(<NewOperationModal />)
  act(() => { useCamStore.getState().openModal('new-operation') })
  if (type === 'waterline') fireEvent.click(screen.getByTestId('op-type-waterline3d'))
  fireEvent.click(screen.getByText('Geometry'))
}

describe('WO-1231 waterline Geometry picker', () => {
  it('shows its solid picker but not the generic 2D picker', () => {
    openOperationGeometry('waterline')

    expect(screen.getByTestId('op-waterline3d-pick-source')).not.toBeNull()
    expect(screen.queryByTestId('op-waterline3d-part-select')).not.toBeNull()
    expect(screen.queryByTestId('op-pick-source-part')).toBeNull()
    expect(screen.queryByTestId('op-geometry-select')).toBeNull()
  })

  it('keeps the generic 2D picker for contour', () => {
    openOperationGeometry('contour')

    expect(screen.getByTestId('op-pick-source-part')).not.toBeNull()
    expect(screen.getByTestId('op-geometry-select')).not.toBeNull()
  })
})
