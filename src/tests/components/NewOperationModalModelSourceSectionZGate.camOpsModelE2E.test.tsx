// @vitest-environment jsdom
//
// The shared model-body capability map gates Section-at-Z honestly: supported
// profile consumers (contour, pocket, adaptive clearing, face) offer the affordance
// because store compute consumes their selected section loops. Unsupported
// profile/cylinder consumers still hide it, avoiding a selection the store
// would discard. This file pins both sides of that UI/store contract.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

const MODEL_ID = 'modelbody:F1'

function seedProject() {
  const geometry = [
    {
      id: MODEL_ID,
      name: 'Model F1',
      type: 'model',
      format: 'model',
      filename: 'Model F1',
      loaded: true,
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      boundingBox: {
        min: { x: 0, y: 0, z: 0 },
        max: { x: 20, y: 20, z: 10 },
      },
      modelBody: { ref: { bodyId: 'F1', stableIds: ['F1:F0'], version: 1 } },
    },
  ] as unknown as ImportedGeometry[]
  const setup = {
    id: 'setup-1',
    name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54,
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
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
  seedProject()
})

afterEach(() => {
  cleanup()
})

function openModalAndSelectModelBody(opTypeCardText: string) {
  render(<NewOperationModal />)
  act(() => { useCamStore.getState().openModal('new-operation') })
  fireEvent.click(screen.getByText(opTypeCardText))
  fireEvent.click(screen.getByText('Geometry'))
}

function selectModelSource() {
  const select = screen.getByTestId('op-geometry-select') as HTMLSelectElement
  fireEvent.change(select, { target: { value: MODEL_ID } })
}

describe('MODEL-BODY-BIND-ADAPTIVE: Section-at-Z follows the shared model-body capability', () => {
  it('adaptive_clearing_2d: offers Section-at-Z for a modeled-body source', () => {
    // defaultACParams.boundarySource is already 'geometry' (mirrors pocket),
    // so the geometry picker is reachable with no toggle click.
    openModalAndSelectModelBody('2D Adaptive Clearing')
    selectModelSource()
    expect(screen.queryByTestId('brep-section-z')).not.toBeNull()
    expect(screen.queryByText('From 3D model')).not.toBeNull()
  })

  it('face: offers Section-at-Z for a modeled-body Contour boundary (WO-1963)', () => {
    openModalAndSelectModelBody('2D Face')
    fireEvent.click(screen.getByText('Contour'))
    selectModelSource()
    // WO-1963 made Face a supported profile consumer, using the same
    // persisted section-loop binding as Contour/Pocket/Adaptive Clearing.
    const section = screen.getByTestId('brep-section-z') as HTMLButtonElement
    expect(section.disabled).toBe(false)
    expect(screen.queryByText('From 3D model')).not.toBeNull()
  })

  it('thread_mill: no Section-at-Z button for a modeled-body source', () => {
    openModalAndSelectModelBody('Thread Mill')
    selectModelSource()
    expect(screen.queryByTestId('brep-section-z')).toBeNull()
    // WO-1942: Thread Mill now shows the "From 3D model" block for its cylinder pick.
  })

  it('regression: contour_2d STILL offers Section-at-Z for a modeled-body source (Stage 2/4 unchanged)', () => {
    openModalAndSelectModelBody('2D Contour')
    selectModelSource()
    expect(screen.queryByTestId('brep-section-z')).not.toBeNull()
  })

  it('regression: pocket_2d STILL offers Section-at-Z for a modeled-body source (Stage 2/4 unchanged)', () => {
    // defaultPocketParams.boundarySource is already 'geometry'; no toggle needed.
    openModalAndSelectModelBody('2D Pocket')
    selectModelSource()
    expect(screen.queryByTestId('brep-section-z')).not.toBeNull()
  })
})
