// @vitest-environment jsdom

// WO-329: "an STL cannot be picked in the viewport until you have already
// picked it." Operator reported three times that a fresh STL (no derived edge
// chains yet) hovers and highlights in the source-part viewport picker for
// every other geometry type, but never for a mesh STL - only the dropdown
// could ever make one reachable, because isViewportPickableOperationSource
// excluded a loopless STL from the eligible-id set. These tests pin the
// corrected contract: the viewport is now a second door into the exact same
// action the dropdown performs (setGeoId), not a copy of its logic.

import { readFileSync } from 'node:fs'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImportedGeometry, Setup } from '../../types'
import { typedMock } from '../support/typedMock'

const stlCache = vi.hoisted(() => ({ load: vi.fn<() => Promise<ArrayBuffer | null>>() }))
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  loadCachedSTL: stlCache.load,
  cacheSTL: vi.fn(async () => {}),
  removeCachedSTL: vi.fn(async () => {}),
}))

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

const GEO_ID = 'wo329-fresh-stl'
const GEO_NAME = 'Fresh STL'
const SETUP_ID = 'wo329-setup'
const TOOL_ID = 'wo329-tool'

let pickedPart: ((id: string) => void) | null = null
let allowedPartIds: readonly string[] = []

function fixtureBuffer(): ArrayBuffer {
  const bytes = readFileSync('src/tests/mesh/fixtures/obj_1_Platte C.stl')
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function seedProject(): void {
  const geometry: ImportedGeometry[] = [{
    id: GEO_ID,
    name: GEO_NAME,
    filename: 'obj_1_Platte C.stl',
    type: 'mesh',
    format: 'stl',
    loaded: true,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    boundingBox: {
      min: { x: -27, y: -27, z: 0 },
      max: { x: 27, y: 27, z: 4 },
      size: { x: 54, y: 54, z: 4 },
      center: { x: 0, y: 0, z: 2 },
    },
  }]
  const setup = {
    id: SETUP_ID,
    name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54,
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: 1, z: 0 },
      zAxis: { x: 0, y: 0, z: 1 },
    },
    stock: {
      type: 'rectangular',
      offsetX: 0,
      offsetY: 0,
      offsetZTop: 0,
      offsetZBottom: 0,
      material: 'aluminum',
    },
    operations: [],
    notes: '',
  } as unknown as Setup
  const current = useCamStore.getState()
  useCamStore.setState({
    toolLibrary: [{
      id: TOOL_ID, name: 'WO-329 6mm Flat', type: 'flat_end_mill', diameter: 6,
      fluteLength: 20, shankDiameter: 6, overallLength: 50, numberOfFlutes: 2,
    } as never],
    project: {
      ...current.project,
      geometry,
      setups: [setup],
      activeSetupId: SETUP_ID,
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
  stlCache.load.mockReset()
  stlCache.load.mockResolvedValue(fixtureBuffer())
  seedProject()
})

afterEach(() => {
  cleanup()
  delete (window as unknown as Record<string, unknown>).__cncViewport
})

describe('WO-329: a fresh STL is reachable through the viewport source-part picker', () => {
  it('offers the viewport picker for a fresh (loopless) STL under Contour and includes it in the eligible ids', () => {
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
    fireEvent.click(screen.getByText('Geometry'))

    // The bug this WO fixes: this button used to be entirely absent when the
    // only candidate source was a fresh STL (stlContourPick.wo251.test.tsx's
    // "does not offer a dead viewport picker" pinned that as intentional at
    // the time - Operator's report overturned it).
    const btn = screen.getByTestId('op-pick-source-part')
    fireEvent.click(btn)

    expect(screen.getByTestId('op-source-part-pick-banner')).toBeTruthy()
    expect(allowedPartIds).toEqual([GEO_ID])
    expect(pickedPart).not.toBeNull()
  })

  it('picking the STL in the viewport derives its chains via the same path the dropdown uses, showing a deriving indicator until it resolves', async () => {
    let resolveBytes: ((bytes: ArrayBuffer) => void) | null = null
    stlCache.load.mockReset()
    stlCache.load.mockImplementation(() => new Promise((resolve) => { resolveBytes = resolve }))

    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
    fireEvent.click(screen.getByText('Geometry'))
    fireEvent.click(screen.getByTestId('op-pick-source-part'))
    const choose = pickedPart
    expect(choose).not.toBeNull()

    act(() => { choose?.(GEO_ID) })

    // The banner closes the instant the pick lands (same as every other
    // viewport-pick flow), but the derive it triggered is still in flight -
    // without an indicator this is indistinguishable from nothing happening.
    expect(screen.queryByTestId('op-source-part-pick-banner')).toBeNull()
    expect((screen.getByTestId('op-geometry-select') as HTMLSelectElement).value).toBe(GEO_ID)
    expect(screen.getByTestId('mesh-edge-chain-deriving')).toBeTruthy()
    expect(screen.queryByTestId('mesh-edge-chain-error')).toBeNull()
    expect(useCamStore.getState().project.geometry[0].loops ?? []).toHaveLength(0)

    await act(async () => { resolveBytes?.(fixtureBuffer()) })

    await waitFor(() => {
      expect(document.querySelectorAll('.op-loop-list input[type="checkbox"]').length).toBeGreaterThan(0)
    })
    expect(screen.queryByTestId('mesh-edge-chain-deriving')).toBeNull()
    expect(useCamStore.getState().project.geometry[0].loops?.length).toBeGreaterThan(0)

    // Exactly the label the dropdown path produces for the same materialized
    // chains (stlContourPick.wo251.test.tsx's own assertion for this string).
    const option = Array.from((screen.getByTestId('op-geometry-select') as HTMLSelectElement).options)
      .find((o) => o.value === GEO_ID)
    expect(option?.text).toMatch(/^Fresh STL \(\d+ STL edge chains\)$/)
  })

  it('surfaces a derive failure after a viewport pick through the same error surface the dropdown uses', async () => {
    const consoleEvents: Array<{ severity: string, message: string }> = []
    const realAddConsoleEvent = useCamStore.getState().addConsoleEvent
    useCamStore.getState().addConsoleEvent = (event) => {
      consoleEvents.push({ severity: event.severity, message: event.message })
      return realAddConsoleEvent(event)
    }

    stlCache.load.mockReset()
    stlCache.load.mockRejectedValueOnce(new Error('disk read failed'))

    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
    fireEvent.click(screen.getByText('Geometry'))
    fireEvent.click(screen.getByTestId('op-pick-source-part'))
    const choose = pickedPart
    act(() => { choose?.(GEO_ID) })

    await waitFor(() => {
      expect(screen.getByTestId('mesh-edge-chain-error')).toBeTruthy()
    })
    const expectedMessage =
      `STL edge chains could not be loaded for "${GEO_NAME}": its cached mesh data could not be read (disk read failed).`
    expect(screen.getByTestId('mesh-edge-chain-error').textContent).toBe(expectedMessage)
    expect(screen.queryByTestId('mesh-edge-chain-deriving')).toBeNull()
    expect(useCamStore.getState().project.geometry[0].loops ?? []).toHaveLength(0)

    // The same console event the dropdown path fires (NewOperationModalBody
    // :1706-1714's addConsoleEvent call, unchanged by this WO).
    expect(consoleEvents).toHaveLength(1)
    expect(consoleEvents[0]).toEqual({ severity: 'error', message: expectedMessage })

    useCamStore.getState().addConsoleEvent = realAddConsoleEvent
  })

  it('does not admit the same fresh STL for an operation family that cannot consume mesh edge chains', () => {
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
    fireEvent.click(screen.getByText('Engrave / Trace'))
    fireEvent.click(screen.getByText('Geometry'))

    // Engrave has no chain admission (WO-258); since WO-2859 Drill consumes an
    // STL's holes, so Engrave is the example. A loopless STL must stay
    // unreachable from the viewport here exactly as it is from the dropdown -
    // this WO only widens the chain-consuming families, never every type.
    expect(screen.queryByTestId('op-pick-source-part')).toBeNull()
  })

  it('leaves the solid-operation viewport picker (parallel_3d) unaffected', () => {
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
    fireEvent.click(screen.getByText('Parallel Finish (3D)'))
    fireEvent.click(screen.getByText('Geometry'))
    fireEvent.click(screen.getByTestId('op-parallel3d-pick-source'))

    // A mesh STL was already viewport-pickable here before this WO (solid
    // operations key on geometry.type alone) - still true, unchanged.
    expect(allowedPartIds).toEqual([GEO_ID])
  })

  it('offers the same solid picker to the waterline finish (WO-1176)', () => {
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
    fireEvent.click(screen.getByText('Waterline Finish (3D)'))
    fireEvent.click(screen.getByText('Geometry'))
    fireEvent.click(screen.getByTestId('op-waterline3d-pick-source'))

    // waterline_3d joined the solid-operation branch of
    // isViewportPickableOperationSource: a mesh STL is pickable for it too.
    expect(allowedPartIds).toEqual([GEO_ID])
  })
})
