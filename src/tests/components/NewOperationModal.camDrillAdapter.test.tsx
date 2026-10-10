// @vitest-environment jsdom
//
// CAM-DRILL-ADAPTER: wizard offers Detect holes for a modeled-body drill source.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ImportedGeometry, ModelItemPlacementRecord, Setup } from '../../types'

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
      boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 40, y: 20, z: 10 } },
      modelItemId: 'legacy',
      modelBody: {
        ref: { bodyId: 'F1', stableIds: ['F1:F0'], version: 1 },
        display: {
          positions: [0, 0, 0, 1, 0, 0, 1, 1, 0],
          normals: [],
          indices: [0, 1, 2],
          edgePositions: [],
          edgeOffsets: [],
          bbox: { min: [0, 0, 0], max: [40, 20, 10] },
        },
      },
    },
  ] as unknown as ImportedGeometry[]
  const setup = {
    id: 'setup-1', name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
    },
    stock: null, operations: [], notes: '',
  } as unknown as Setup
  const modelItemPlacements: ModelItemPlacementRecord[] = [
    { modelItemId: 'legacy', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
  ]
  const current = useCamStore.getState()
  useCamStore.setState({
    project: { ...current.project, geometry, setups: [setup], activeSetupId: setup.id, modelItemPlacements },
    toolLibrary: [{
      id: 't1', name: 'D6', type: 'drill', diameter: 6,
      fluteLength: 20, shankDiameter: 6, overallLength: 50, numberOfFlutes: 2,
    } as never],
  })
}

function selectImportedStepSource(): void {
  const current = useCamStore.getState()
  const model = current.project.geometry[0]
  const step = {
    ...model,
    id: 'brep-1',
    name: 'Imported STEP',
    filename: 'imported.step',
    type: 'brep',
    format: 'step',
    modelItemId: undefined,
    modelBody: undefined,
  } as ImportedGeometry
  useCamStore.setState({
    project: { ...current.project, geometry: [step] },
  })
}

beforeEach(() => {
  act(() => { useCamStore.getState().newProject() })
  seedProject()
  ;(window as unknown as Record<string, unknown>).__cncViewport = {
    setPartPickMode: vi.fn(),
    setSelectedPart: vi.fn(),
    setBrepPickMode: vi.fn(),
    setPickedBrepSelections: vi.fn(),
  }
})
afterEach(() => {
  cleanup()
  delete (window as unknown as Record<string, unknown>).__cncViewport
})

describe('NewOperationModal model drill Detect holes (CAM-DRILL-ADAPTER)', () => {
  it('shows Detect holes when drill + modeled body is selected', async () => {
    act(() => {
      useCamStore.setState({ activeModal: 'new-operation' })
    })
    render(<NewOperationModal />)

    const cards = document.querySelectorAll('.op-type-card')
    const drill = Array.from(cards).find((c) => /drill/i.test(c.textContent ?? ''))
    expect(drill).toBeTruthy()
    fireEvent.click(drill as HTMLElement)

    const geoTab = Array.from(document.querySelectorAll('button, [role="tab"]'))
      .find((el) => /geometry/i.test(el.textContent ?? ''))
    if (geoTab) fireEvent.click(geoTab)

    const select = await screen.findByTestId('op-geometry-select')
    const opts = Array.from((select as HTMLSelectElement).options)
    const modelOpt = opts.find((o) => /modeled body/i.test(o.text))
    expect(modelOpt).toBeTruthy()
    fireEvent.change(select, { target: { value: modelOpt!.value } })

    const detect = await screen.findByTestId('brep-detect-holes')
    expect(detect.textContent).toMatch(/Detect holes/i)
  })

  it('offers cylindrical face picking for Drill on an imported STEP source', async () => {
    act(() => {
      selectImportedStepSource()
      useCamStore.setState({ activeModal: 'new-operation' })
    })
    render(<NewOperationModal />)

    const cards = document.querySelectorAll('.op-type-card')
    const drill = Array.from(cards).find((c) => /drill/i.test(c.textContent ?? ''))
    expect(drill).toBeTruthy()
    fireEvent.click(drill as HTMLElement)

    const geoTab = Array.from(document.querySelectorAll('button, [role="tab"]'))
      .find((el) => /geometry/i.test(el.textContent ?? ''))
    if (geoTab) fireEvent.click(geoTab)

    const select = await screen.findByTestId('op-geometry-select')
    fireEvent.change(select, { target: { value: 'brep-1' } })

    expect(await screen.findByTestId('brep-pick-face')).toBeTruthy()
    expect(await screen.findByTestId('brep-detect-holes')).toBeTruthy()
  })

  it('offers Pick face for Bore on a modeled-body source', async () => {
    act(() => {
      useCamStore.setState({ activeModal: 'new-operation' })
    })
    render(<NewOperationModal />)

    const cards = document.querySelectorAll('.op-type-card')
    const bore = Array.from(cards).find((c) => /^Bore/.test((c.textContent ?? '').trim()))
    expect(bore).toBeTruthy()
    fireEvent.click(bore as HTMLElement)

    const geoTab = Array.from(document.querySelectorAll('button, [role="tab"]'))
      .find((el) => /geometry/i.test(el.textContent ?? ''))
    if (geoTab) fireEvent.click(geoTab)

    const select = await screen.findByTestId('op-geometry-select')
    const modelOpt = Array.from((select as HTMLSelectElement).options)
      .find((o) => /modeled body/i.test(o.text))
    expect(modelOpt).toBeTruthy()
    fireEvent.change(select, { target: { value: modelOpt!.value } })

    expect(await screen.findByTestId('brep-pick-face')).toBeTruthy()
    expect(screen.queryByText(/Section at Z/i)).toBeNull()
  })
})
