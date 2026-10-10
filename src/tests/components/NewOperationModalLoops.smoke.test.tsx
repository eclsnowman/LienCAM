// @vitest-environment jsdom
//
// React-render SMOKE test for the per-loop selection UI in NewOperationModal.
//
// WHY THIS EXISTS: operation geometry must be explicitly chosen. A new operation
// starts empty except a Pocket on a sketch; clearing the final loop stays empty.
// The modal list and workspace picker expose the same clear-selection action. Legacy edited operations
// may still carry the old empty-array-means-all persistence contract.
// tsc + the pure-logic vitest suite cannot catch checkbox/render behavior, so this
// mounts the real modal, selects a geometry, and exercises the checkboxes.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react'

// jsdom's built-in localStorage is broken under vitest's node launch flags; the
// store's persist() needs a working backend. Install an in-memory shim BEFORE the
// store import. Pure test scaffolding; no app change. (Same pattern as NestModal.)
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
const { fmtDim } = await import('../../lib/ui/unitFormat')

// The modal's default displayUnits is 'mm', so an override echoes through the
// unit shim's mm formatter. Derive the expected string from the SAME formatter
// the component uses rather than hardcoding decimal places.
const fmtMm = (mm: number) => fmtDim(mm, 'mm')

const GEO_ID = 'geo-test'
const SETUP_ID = 'setup-test'

// A geometry with three closed loops + a setup the modal can find via activeSetupId.
// Cast loosely — this is render scaffolding, the modal only reads id/name/type/loops
// and loop id/closed/type/area/points.
function seedProjectWithLoops() {
  const loops = [
    { id: 'loop-a', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], closed: true, type: 'contour', layerId: 'L', area: 100 },
    { id: 'loop-b', points: [{ x: 2, y: 2 }, { x: 4, y: 2 }, { x: 4, y: 4 }], closed: true, type: 'hole', layerId: 'L', area: 4 },
    { id: 'loop-c', points: [{ x: 6, y: 6 }, { x: 8, y: 6 }, { x: 8, y: 8 }], closed: true, type: 'hole', layerId: 'L', area: 4 },
    { id: 'open-a', points: [{ x: -2, y: 0 }, { x: 12, y: 0 }], closed: false, type: 'open', layerId: 'L', area: 0 },
    { id: 'open-b', points: [{ x: -2, y: 6 }, { x: 12, y: 6 }], closed: false, type: 'open', layerId: 'L', area: 0 },
  ]
  const geometry = [{
    id: GEO_ID, name: 'part.svg', type: 'curves_2d', format: 'svg', loaded: true, loops,
    stockId: 'stock-test',
    layers2d: [{
      id: 'L', name: 'SVG plane', color: '#fff', visible: true,
      projectionPlane: { origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 } },
    }],
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 0 } },
  }]
  const wcs = {
    id: 'wcs-1', label: 'G54', fixtureOffset: 54,
    origin: { x: 0, y: 0, z: 0 },
    xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
    stockId: 'stock-test',
  }
  const setup = { id: SETUP_ID, name: 'Setup 1', wcs, stock: null, operations: [], notes: '' }
  act(() => {
    const s = useCamStore.getState() as unknown as { project: Record<string, unknown> }
    useCamStore.setState({
      toolLibrary: [{
        id: 'tool-contour', name: 'Flat 6mm', type: 'flat_end_mill', diameter: 6,
        fluteLength: 20, shankDiameter: 6, overallLength: 50, numberOfFlutes: 2,
      }],
      computeOperationToolpath: vi.fn(),
      project: {
        ...s.project,
        geometry,
        stocks: [{
          id: 'stock-test', name: 'Stock', mode: 'explicit',
          bounds: {
            min: { x: -5, y: -5, z: -10 }, max: { x: 15, y: 15, z: 0 },
            size: { x: 20, y: 20, z: 10 }, center: { x: 5, y: 5, z: -5 },
          },
          position: { x: 0, y: 0, z: 0 },
        }],
        setups: [setup], activeSetupId: SETUP_ID,
      },
    } as never)
  })
}

async function waitForContourHeightReady() {
  fireEvent.click(screen.getByText('Heights'))
  await waitFor(() => {
    const refusal = screen.queryByTestId('contour-height-preflight-error')
    if (refusal) throw new Error(refusal.textContent ?? 'Contour Smart Height preflight refused without a message')
    expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false)
  })
}

// Open the modal, go to the Geometry tab, and select the test geometry so the
// per-loop checkbox list renders (default op is contour_2d, which uses loops).
function openModalOnGeometry() {
  act(() => { useCamStore.getState().openModal('new-operation') })
  fireEvent.click(screen.getByText('Geometry'))
  const select = screen.getByTestId('op-geometry-select') as HTMLSelectElement
  fireEvent.change(select, { target: { value: GEO_ID } })
}

function loopCheckboxes(): HTMLInputElement[] {
  return Array.from(document.querySelectorAll('.op-loop-list input[type="checkbox"]')) as HTMLInputElement[]
}

afterEach(() => {
  cleanup()
  delete (window as unknown as Record<string, unknown>).__cncViewport
})

beforeEach(() => {
  act(() => { useCamStore.getState().closeModal() })
})

describe('NewOperationModal loop-selection smoke', () => {
  it('offers intent-first end conditions with a visible depth default and Custom fallback', () => {
    seedProjectWithLoops()
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
    fireEvent.click(screen.getByText('2D Pocket'))
    fireEvent.click(screen.getByText('Heights'))

    const control = screen.getByTestId('end-condition-control')
    const select = control.querySelector('select') as HTMLSelectElement
    expect(select.value).toBe('depth_from_top')
    expect(screen.getByText('Depth from top')).not.toBeNull()
    expect(screen.getAllByText(/down from stock top/).length).toBeGreaterThan(0)
    expect((screen.getByText('Depth from top').parentElement?.querySelector('input') as HTMLInputElement).value)
      .toBe('5')

    fireEvent.change(select, { target: { value: 'through_stock' } })
    expect((control.querySelector('select') as HTMLSelectElement).value).toBe('through_stock')
    expect(screen.getByText('Past stock bottom')).not.toBeNull()
    expect(screen.getByText(/past its bottom/)).not.toBeNull()

    fireEvent.change(control.querySelector('select') as HTMLSelectElement, {
      target: { value: 'custom' },
    })
    expect(screen.getByText(/Advanced Reference plane and Offset controls/)).not.toBeNull()
  })

  it('starts a new Contour with every loop unchecked', () => {
    seedProjectWithLoops()
    render(<NewOperationModal />)
    openModalOnGeometry()

    const boxes = loopCheckboxes()
    expect(boxes.length).toBe(3)
    expect(boxes.every(b => !b.checked)).toBe(true)
    expect(screen.getByTestId('op-loops-empty-warn')).not.toBeNull()
    expect((screen.getByTestId('op-loops-clear') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('button', { name: /All loops/ }).className).not.toContain('op-toggle-active')
  })

  it('(a) unchecking every loop leaves them UNCHECKED (no snap-back to all)', () => {
    seedProjectWithLoops()
    render(<NewOperationModal />)
    openModalOnGeometry()

    fireEvent.click(screen.getByRole('button', { name: /All loops/ }))
    let boxes = loopCheckboxes()
    expect(boxes.every(b => b.checked)).toBe(true)
    fireEvent.click(boxes[0])
    fireEvent.click(loopCheckboxes()[1])
    fireEvent.click(loopCheckboxes()[2])

    boxes = loopCheckboxes()
    expect(boxes.every(b => !b.checked)).toBe(true) // stays empty, no snap-back

    // Fail-loud surfacing (ADR-0003): explicit-empty must NOT be silently treated as
    // "all". A warning shows and Create is disabled.
    expect(screen.getByTestId('op-loops-empty-warn')).not.toBeNull()
    expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(true)
  })

  it('the modal Clear selection control clears the list in one click', () => {
    seedProjectWithLoops()
    render(<NewOperationModal />)
    openModalOnGeometry()

    fireEvent.click(screen.getByRole('button', { name: /All loops/ }))
    expect(loopCheckboxes().every(b => b.checked)).toBe(true)
    fireEvent.click(screen.getByTestId('op-loops-clear'))
    expect(loopCheckboxes().every(b => !b.checked)).toBe(true)
    expect(screen.getByTestId('op-loops-empty-warn')).not.toBeNull()

    // "All loops" is now an explicit selection, not an implicit empty sentinel.
    fireEvent.click(screen.getByRole('button', { name: /All loops/ }))
    expect(loopCheckboxes().every(b => b.checked)).toBe(true)
    expect(screen.queryByTestId('op-loops-empty-warn')).toBeNull()
  })

  it('keeps the complete movable configuration surface mounted while viewport picking is active', () => {
    seedProjectWithLoops()
    const setLoopPickMode = vi.fn()
    const setPickedLoops = vi.fn()
    ;(window as unknown as Record<string, unknown>).__cncViewport = {
      setLoopPickMode,
      setPickedLoops,
    }
    render(<NewOperationModal />)

    act(() => { useCamStore.getState().openModal('new-operation') })
    const nameInput = screen.getByPlaceholderText('Contour 1') as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: 'Outside roughing' } })
    fireEvent.click(screen.getByText('Tool'))
    fireEvent.click(screen.getByText('Flat 6mm'))
    fireEvent.click(screen.getByText('Geometry'))
    fireEvent.change(screen.getByTestId('op-geometry-select') as HTMLSelectElement, {
      target: { value: GEO_ID },
    })

    fireEvent.click(screen.getByTestId('op-loop-pick-toggle'))

    expect(screen.getByTestId('op-modal-backdrop').className).toContain('modal-backdrop-transparent')
    expect(screen.getByTestId('op-modal-panel').getAttribute('data-presentation'))
      .toBe('floating-configuration')
    expect(screen.getByTestId('op-loop-pick-banner').textContent).toMatch(/click highlighted loops/i)
    expect(screen.getByTestId('op-loop-pick-toggle').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('op-create')).not.toBeNull()
    expect(screen.getByText('Geometry')).not.toBeNull()
    const panel = screen.getByTestId('op-modal-panel') as HTMLElement
    const header = screen.getByText(/New Operation/).closest('.modal-header') as HTMLElement
    expect(header.style.cursor).toBe('move')
    const initialTransform = panel.style.transform
    fireEvent.pointerDown(header, { pointerId: 7, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 150, clientY: 130 })
    expect(panel.style.transform).not.toBe(initialTransform)
    fireEvent.pointerUp(window, { pointerId: 7, clientX: 150, clientY: 130 })

    // The live callback updates the still-mounted panel and its bottom feedback.
    const callback = setLoopPickMode.mock.calls.at(-1)?.[0] as (loopId: string, selected: boolean) => void
    act(() => callback('loop-a', true))
    expect(screen.getByTestId('op-loop-pick-toggle').textContent).toContain('1 selected')
    expect(screen.getByTestId('op-loop-pick-banner').textContent).toContain('1 loop selected')

    const workspaceClear = screen.getByTestId('op-loop-pick-clear') as HTMLButtonElement
    expect(workspaceClear.disabled).toBe(false)
    fireEvent.click(workspaceClear)
    expect(setPickedLoops).toHaveBeenLastCalledWith([])
    expect(screen.getByTestId('op-loop-pick-banner').textContent).toContain('0 loops selected')
    expect(loopCheckboxes().every(box => !box.checked)).toBe(true)
    expect((screen.getByTestId('op-loop-pick-clear') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('op-loop-pick-toggle').getAttribute('aria-pressed')).toBe('true')

    // Switching tabs while picking proves this is the real wizard, not a picker
    // facsimile; the previously entered operation state remains intact.
    fireEvent.click(screen.getByText('Type & Name'))
    expect((screen.getByPlaceholderText('Contour 1') as HTMLInputElement).value).toBe('Outside roughing')
    expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(true)
  })

  it('retires stale picker context when path eligibility changes and re-arms explicitly', () => {
    seedProjectWithLoops()
    const setLoopPickMode = vi.fn()
    ;(window as unknown as Record<string, unknown>).__cncViewport = {
      setLoopPickMode,
      setPickedLoops: vi.fn(),
    }
    render(<NewOperationModal />)

    act(() => { useCamStore.getState().openModal('new-operation') })
    fireEvent.change(screen.getByPlaceholderText('Contour 1'), {
      target: { value: 'Open edge finish' },
    })
    fireEvent.click(screen.getByText('Tool'))
    fireEvent.click(screen.getByText('Flat 6mm'))
    fireEvent.click(screen.getByText('Geometry'))
    fireEvent.change(screen.getByTestId('op-geometry-select') as HTMLSelectElement, {
      target: { value: GEO_ID },
    })
    fireEvent.click(screen.getByTestId('op-loop-pick-toggle'))
    const staleCallback = setLoopPickMode.mock.calls.at(-1)?.[0] as (loopId: string, selected: boolean) => void

    // Changing from closed profiles to open paths changes the picker's eligible
    // family. The old session is retired, while the newly chosen configuration
    // and the rest of the operation draft remain available.
    fireEvent.click(screen.getByTestId('contour-path-open'))
    expect(setLoopPickMode).toHaveBeenLastCalledWith(null)
    expect(screen.queryByTestId('op-loop-pick-banner')).toBeNull()
    expect(screen.getByTestId('contour-path-open').className).toContain('op-toggle-active')
    expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByText('Type & Name'))
    expect((screen.getByPlaceholderText('Contour 1') as HTMLInputElement).value).toBe('Open edge finish')
    fireEvent.click(screen.getByText('Geometry'))

    // Even if an old viewport event was already queued, its invalidated callback
    // cannot write a closed-loop selection into the new open-path draft.
    act(() => staleCallback('loop-a', true))
    expect(screen.getByTestId('op-loop-pick-toggle').textContent).not.toContain('selected')

    fireEvent.click(screen.getByTestId('op-loop-pick-toggle'))
    const currentCallback = setLoopPickMode.mock.calls.at(-1)?.[0] as (loopId: string, selected: boolean) => void
    expect(currentCallback).not.toBe(staleCallback)
    act(() => currentCallback('open-a', true))
    expect(screen.getByTestId('op-loop-pick-toggle').textContent).toContain('1 selected')

    // Re-arming invalidates the prior generation permanently; it cannot disturb
    // the current open-path selection either.
    act(() => staleCallback('loop-b', true))
    expect(screen.getByTestId('op-loop-pick-toggle').textContent).toContain('1 selected')
  })

  it('routes Cancel and Escape to stop loop picking before ordinary modal close', () => {
    seedProjectWithLoops()
    const setLoopPickMode = vi.fn()
    ;(window as unknown as Record<string, unknown>).__cncViewport = {
      setLoopPickMode,
      setPickedLoops: vi.fn(),
    }
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
    fireEvent.change(screen.getByPlaceholderText('Contour 1'), {
      target: { value: 'Keep this setup' },
    })
    fireEvent.click(screen.getByText('Geometry'))
    fireEvent.change(screen.getByTestId('op-geometry-select') as HTMLSelectElement, {
      target: { value: GEO_ID },
    })

    fireEvent.click(screen.getByTestId('op-loop-pick-toggle'))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(setLoopPickMode).toHaveBeenLastCalledWith(null)
    expect(screen.getByTestId('op-create')).not.toBeNull()
    expect(screen.queryByTestId('op-loop-pick-banner')).toBeNull()
    expect(screen.getByTestId('op-modal-backdrop').className)
      .not.toContain('modal-backdrop-transparent')
    expect((screen.getByTestId('op-modal-panel') as HTMLElement).style.transform).toBe('')
    expect(screen.getByText('Geometry').closest('button')?.className).toContain('op-modal-tab-active')
    expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByText('Type & Name'))
    expect((screen.getByPlaceholderText('Contour 1') as HTMLInputElement).value).toBe('Keep this setup')
    fireEvent.click(screen.getByText('Geometry'))

    fireEvent.click(screen.getByTestId('op-loop-pick-toggle'))
    fireEvent.keyDown(window, { key: 'Escape' })

    expect(setLoopPickMode).toHaveBeenLastCalledWith(null)
    expect(screen.getByTestId('op-create')).not.toBeNull()
    expect(screen.queryByTestId('op-loop-pick-banner')).toBeNull()
    fireEvent.click(screen.getByText('Type & Name'))
    expect((screen.getByPlaceholderText('Contour 1') as HTMLInputElement).value).toBe('Keep this setup')
    fireEvent.click(screen.getByText('Geometry'))

    // Header close follows the same picker-first contract as footer Cancel.
    fireEvent.click(screen.getByTestId('op-loop-pick-toggle'))
    fireEvent.click(document.querySelector('.op-modal .modal-close-btn') as HTMLButtonElement)
    expect(setLoopPickMode).toHaveBeenLastCalledWith(null)
    expect(screen.getByTestId('op-create')).not.toBeNull()
    fireEvent.click(screen.getByText('Type & Name'))
    expect((screen.getByPlaceholderText('Contour 1') as HTMLInputElement).value).toBe('Keep this setup')

    // Once the picker is disarmed, Cancel has its ordinary close behavior.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByTestId('op-create')).toBeNull()
  })

  it('disarms the viewport picker when Create completes through the existing reset path', async () => {
    seedProjectWithLoops()
    const setLoopPickMode = vi.fn()
    ;(window as unknown as Record<string, unknown>).__cncViewport = {
      setLoopPickMode,
      setPickedLoops: vi.fn(),
    }
    render(<NewOperationModal />)

    act(() => { useCamStore.getState().openModal('new-operation') })
    fireEvent.click(screen.getByText('Tool'))
    fireEvent.click(screen.getByText('Flat 6mm'))
    fireEvent.click(screen.getByText('Geometry'))
    fireEvent.change(screen.getByTestId('op-geometry-select') as HTMLSelectElement, {
      target: { value: GEO_ID },
    })
    fireEvent.click(screen.getByTestId('op-loop-pick-toggle'))
    const callback = setLoopPickMode.mock.calls.at(-1)?.[0] as (loopId: string, selected: boolean) => void
    act(() => callback('loop-a', true))

    await waitForContourHeightReady()
    fireEvent.click(screen.getByTestId('op-create'))

    expect(setLoopPickMode).toHaveBeenLastCalledWith(null)
    expect(screen.queryByTestId('op-create')).toBeNull()
    expect(useCamStore.getState().project.setups[0].operations).toHaveLength(1)
    expect(useCamStore.getState().project.setups[0].operations[0].geometrySelections)
      .toEqual(['loop-a'])
  })
})

describe('NewOperationModal open-contour UI', () => {
  it('toggles path family, filters loop choices, and swaps closed side controls for left/right', () => {
    seedProjectWithLoops()
    render(<NewOperationModal />)
    openModalOnGeometry()

    expect(screen.getByTestId('contour-path-closed').className).toContain('op-toggle-active')
    expect(loopCheckboxes()).toHaveLength(3)
    expect(screen.getByRole('button', { name: 'Outside profile' })).not.toBeNull()

    fireEvent.click(screen.getByTestId('contour-path-open'))

    expect(screen.getByTestId('contour-path-open').className).toContain('op-toggle-active')
    expect(loopCheckboxes()).toHaveLength(2)
    expect(screen.queryByRole('button', { name: 'Outside profile' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Left of drawn path' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Right of drawn path' }).className)
      .toContain('op-toggle-active')

    fireEvent.click(screen.getByRole('button', { name: 'Left of drawn path' }))
    expect(screen.getByRole('button', { name: 'Left of drawn path' }).className)
      .toContain('op-toggle-active')
  })

  it('hides seam overlap and holding tabs in open mode while preserving closed draft tab state', () => {
    seedProjectWithLoops()
    render(<NewOperationModal />)
    openModalOnGeometry()

    fireEvent.click(screen.getByText('Linking'))
    const tabs = screen.getByTestId('contour-tabs-enabled') as HTMLInputElement
    fireEvent.click(tabs)
    expect((screen.getByTestId('contour-tabs-enabled') as HTMLInputElement).checked).toBe(true)

    fireEvent.click(screen.getByText('Geometry'))
    fireEvent.click(screen.getByTestId('contour-path-open'))
    fireEvent.click(screen.getByText('Linking'))
    expect(screen.queryByTestId('contour-tabs-enabled')).toBeNull()

    fireEvent.click(screen.getByText('Passes'))
    fireEvent.click(screen.getByTestId('disclosure-passes-advanced'))
    expect(screen.queryByText('Contour overlap')).toBeNull()
    expect(screen.getByText('Spring passes')).not.toBeNull()

    fireEvent.click(screen.getByText('Geometry'))
    fireEvent.click(screen.getByTestId('contour-path-closed'))
    fireEvent.click(screen.getByRole('button', { name: /All loops/ }))
    fireEvent.click(screen.getByText('Linking'))
    expect((screen.getByTestId('contour-tabs-enabled') as HTMLInputElement).checked).toBe(true)
  })

  it('shows fixed outside-stock Plunge entry without Ramp choice or angle in open mode', () => {
    seedProjectWithLoops()
    render(<NewOperationModal />)
    openModalOnGeometry()

    fireEvent.click(screen.getByTestId('contour-path-open'))
    fireEvent.click(screen.getByText('Linking'))

    const fixedPlunge = screen.getByRole('button', { name: 'Plunge (outside stock)' }) as HTMLButtonElement
    expect(fixedPlunge.disabled).toBe(true)
    expect(fixedPlunge.className).toContain('op-toggle-active')
    expect(screen.queryByRole('button', { name: 'Ramp (linear)' })).toBeNull()
    expect(screen.queryByText('Ramp angle')).toBeNull()
  })

  it('keeps the closed Ramp draft when open mode is visited before save', async () => {
    seedProjectWithLoops()
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
    fireEvent.click(screen.getByText('Tool'))
    fireEvent.click(screen.getByText('Flat 6mm'))
    fireEvent.click(screen.getByText('Geometry'))
    fireEvent.change(screen.getByTestId('op-geometry-select') as HTMLSelectElement, {
      target: { value: GEO_ID },
    })

    fireEvent.click(screen.getByText('Linking'))
    fireEvent.click(screen.getByRole('button', { name: 'Plunge' }))
    fireEvent.click(screen.getByRole('button', { name: 'Ramp (linear)' }))
    fireEvent.click(screen.getByText('Geometry'))
    fireEvent.click(screen.getByTestId('contour-path-open'))
    fireEvent.click(screen.getByText('Linking'))
    expect(screen.getByRole('button', { name: 'Plunge (outside stock)' })).not.toBeNull()

    fireEvent.click(screen.getByText('Geometry'))
    fireEvent.click(screen.getByTestId('contour-path-closed'))
    fireEvent.click(screen.getByRole('button', { name: /All loops/ }))
    fireEvent.click(screen.getByText('Linking'))
    expect(screen.getByRole('button', { name: 'Ramp (linear)' }).className)
      .toContain('op-toggle-active')
    await waitForContourHeightReady()
    fireEvent.click(screen.getByTestId('op-create'))

    const created = useCamStore.getState().project.setups[0].operations[0]
    expect(created.linking.entryType).toBe('ramp_linear')
  })

  it('rejects a wrong-type viewport hit and restores the accepted open selection', () => {
    seedProjectWithLoops()
    const setLoopPickMode = vi.fn()
    const setPickedLoops = vi.fn()
    ;(window as unknown as Record<string, unknown>).__cncViewport = {
      setLoopPickMode,
      setPickedLoops,
    }
    render(<NewOperationModal />)
    openModalOnGeometry()
    fireEvent.click(screen.getByTestId('contour-path-open'))
    fireEvent.click(loopCheckboxes()[0])

    fireEvent.click(screen.getByText('Pick from viewport'))
    const callback = setLoopPickMode.mock.calls.at(-1)?.[0] as (loopId: string, selected: boolean) => void
    act(() => callback('loop-a', true))
    expect(setPickedLoops).toHaveBeenLastCalledWith(['open-a'])

    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    const boxes = loopCheckboxes()
    expect(boxes[0].checked).toBe(true)
    expect(boxes[1].checked).toBe(false)
  })

  it('persists open path fields and normalizes unsupported tabs/overlap on create', async () => {
    seedProjectWithLoops()
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
    fireEvent.click(screen.getByText('Tool'))
    fireEvent.click(screen.getByText('Flat 6mm'))
    fireEvent.click(screen.getByText('Geometry'))
    fireEvent.change(screen.getByTestId('op-geometry-select') as HTMLSelectElement, {
      target: { value: GEO_ID },
    })

    // Enable tabs while closed, then switch to open. Draft closed settings stay
    // intact, while the saved open operation must normalize unsupported fields.
    fireEvent.click(screen.getByText('Linking'))
    fireEvent.click(screen.getByTestId('contour-tabs-enabled'))
    fireEvent.click(screen.getByText('Geometry'))
    fireEvent.click(screen.getByTestId('contour-path-open'))
    fireEvent.click(screen.getByRole('button', { name: 'Left of drawn path' }))
    fireEvent.click(loopCheckboxes()[0])
    await waitForContourHeightReady()
    fireEvent.click(screen.getByTestId('op-create'))

    const created = useCamStore.getState().project.setups[0].operations[0]
    const params = created.params as Record<string, unknown>
    expect(params.pathType).toBe('open')
    expect(params.openSide).toBe('left')
    expect(params.tabs).toBe(false)
    expect(created.passes.overlapMm).toBe(0)
    expect(created.linking.entryType).toBe('plunge')

    act(() => { useCamStore.getState().openEditOperation(SETUP_ID, created.id) })
    fireEvent.click(screen.getByText('Geometry'))
    expect(screen.getByTestId('contour-path-open').className).toContain('op-toggle-active')
    expect(screen.getByRole('button', { name: 'Left of drawn path' }).className)
      .toContain('op-toggle-active')
  })

  it('normalizes a legacy open-contour entry when the operation is edited', async () => {
    seedProjectWithLoops()
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
    fireEvent.click(screen.getByText('Tool'))
    fireEvent.click(screen.getByText('Flat 6mm'))
    fireEvent.click(screen.getByText('Geometry'))
    fireEvent.change(screen.getByTestId('op-geometry-select') as HTMLSelectElement, {
      target: { value: GEO_ID },
    })
    fireEvent.click(screen.getByTestId('contour-path-open'))
    fireEvent.click(loopCheckboxes()[0])
    await waitForContourHeightReady()
    fireEvent.click(screen.getByTestId('op-create'))

    const created = useCamStore.getState().project.setups[0].operations[0]
    act(() => {
      const state = useCamStore.getState()
      useCamStore.setState({
        project: {
          ...state.project,
          setups: state.project.setups.map(candidate => candidate.id === SETUP_ID
            ? {
                ...candidate,
                operations: candidate.operations.map(operation => operation.id === created.id
                  ? { ...operation, linking: { ...operation.linking, entryType: 'arc' as const } }
                  : operation),
              }
            : candidate),
        },
      })
      state.openEditOperation(SETUP_ID, created.id)
    })

    fireEvent.click(screen.getByText('Linking'))
    expect(screen.getByRole('button', { name: 'Plunge (outside stock)' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Ramp (linear)' })).toBeNull()
    await waitForContourHeightReady()
    fireEvent.click(screen.getByTestId('op-create'))

    const updated = useCamStore.getState().project.setups[0].operations
      .find(operation => operation.id === created.id)
    expect(updated?.linking.entryType).toBe('plunge')
  })

  it('keeps default closed contour payloads free of open-only optional keys', async () => {
    seedProjectWithLoops()
    render(<NewOperationModal />)
    act(() => { useCamStore.getState().openModal('new-operation') })
    fireEvent.click(screen.getByText('Tool'))
    fireEvent.click(screen.getByText('Flat 6mm'))
    fireEvent.click(screen.getByText('Geometry'))
    fireEvent.change(screen.getByTestId('op-geometry-select') as HTMLSelectElement, {
      target: { value: GEO_ID },
    })
    fireEvent.click(screen.getByRole('button', { name: /All loops/ }))
    await waitForContourHeightReady()
    fireEvent.click(screen.getByTestId('op-create'))

    const params = useCamStore.getState().project.setups[0].operations[0].params as Record<string, unknown>
    expect(Object.prototype.hasOwnProperty.call(params, 'pathType')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(params, 'openSide')).toBe(false)
  })
})

// ── Per-hole depths editor (manual override) ──────────────────────────────────
// WHY: a "Per-hole depths" table was added to the Drill tab so the user can type
// a custom bottom depth per hole (DXF/sketch circles or B-rep holes), writing
// DrillParams.perHoleDepthOverrides[loopId]. tsc + the pure resolveHoleBottoms
// unit tests can't catch render/hooks-order or the empty-clears-the-key behavior,
// so this mounts the real modal on the Drill op and exercises the table.

// Like seedProjectWithLoops, but the geometry also carries a detected-holes
// layer (layers2d[].holes) linking loop-b and loop-c to DIFFERENT model bottoms.
// Mirrors deriveBrepLayer('holes') output so the modal's per-hole placeholder can
// surface each hole's detected world bottom when perHoleDepth is on.
const HOLE_B_BOTTOM = -9
const HOLE_C_BOTTOM = -15
function seedProjectWithDetectedHoles() {
  const loops = [
    { id: 'loop-a', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], closed: true, type: 'contour', layerId: 'L', area: 100 },
    { id: 'loop-b', points: [{ x: 2, y: 2 }, { x: 4, y: 2 }, { x: 4, y: 4 }], closed: true, type: 'hole', layerId: 'L', area: 4 },
    { id: 'loop-c', points: [{ x: 6, y: 6 }, { x: 8, y: 6 }, { x: 8, y: 8 }], closed: true, type: 'hole', layerId: 'L', area: 4 },
  ]
  // A holes layer (frame untagged so holeBottomWorldZ returns bottomZ verbatim;
  // position.z is 0 here anyway). Two holes, TWO different bottoms.
  const layers2d = [{
    id: 'holes-layer', name: 'Holes',
    holes: [
      { id: 'h-b', loopId: 'loop-b', bottomZ: HOLE_B_BOTTOM },
      { id: 'h-c', loopId: 'loop-c', bottomZ: HOLE_C_BOTTOM },
    ],
  }]
  const geometry = [{
    id: GEO_ID, name: 'part.step', type: 'solid_3d', format: 'step', loaded: true, loops, layers2d,
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 0 } },
  }]
  const wcs = {
    id: 'wcs-1', label: 'G54', fixtureOffset: 54,
    origin: { x: 0, y: 0, z: 0 },
    xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
  }
  // A drill op already configured with perHoleDepth ON (the precondition the bug
  // needs). The modal edit-prefill (NewOperationModal ~302) seeds drill state from
  // this op, so the "from model" checkbox renders checked without the OCCT derive.
  const drillOp = {
    id: 'op-drill', name: 'Drill 1', type: 'drill', toolId: '',
    heights: {
      clearanceHeight: 10, clearanceHeightMode: 'absolute', retractHeight: 2,
      feedHeight: 0.5, topHeight: 0, topHeightMode: 'absolute',
      bottomHeight: -5, bottomHeightMode: 'absolute',
    },
    passes: { stepdown: 2, stepover: 1, finishPasses: 1, stockToLeave: 0 },
    linking: {},
    params: { geometryId: GEO_ID, loopIds: [], cycleType: 'simple', perHoleDepth: true },
  }
  const setup = { id: SETUP_ID, name: 'Setup 1', wcs, stock: null, operations: [drillOp], notes: '' }
  act(() => {
    const s = useCamStore.getState() as unknown as { project: Record<string, unknown> }
    useCamStore.setState({
      project: { ...s.project, geometry, setups: [setup], activeSetupId: SETUP_ID },
    } as never)
  })
}

// Open the modal, pick the Drill op type, select the geometry, and land on the
// Passes tab where the drill controls (incl. the per-hole table) render.
function openModalOnDrillPasses() {
  act(() => { useCamStore.getState().openModal('new-operation') })
  fireEvent.click(screen.getByText('Drill'))               // Type tab card
  fireEvent.click(screen.getByText('Geometry'))            // Geometry tab
  fireEvent.change(screen.getByTestId('op-geometry-select') as HTMLSelectElement, { target: { value: GEO_ID } })
  fireEvent.click(screen.getByText('Passes'))              // Passes tab (drill controls)
}

function perHoleInputs(): HTMLInputElement[] {
  return screen.getAllByTestId('drill-perhole-input') as HTMLInputElement[]
}

describe('NewOperationModal drill per-hole depths smoke', () => {
  it('renders the per-hole table with one editable depth field per selected hole', () => {
    seedProjectWithLoops()  // 3 closed loops -> empty selection == all -> 3 rows
    render(<NewOperationModal />)
    openModalOnDrillPasses()

    // The section + table render (mounting the Drill op did not throw a
    // hooks-order error — the regression class this smoke guards).
    expect(screen.getByTestId('drill-perhole-table')).not.toBeNull()
    const rows = screen.getAllByTestId('drill-perhole-row')
    expect(rows.length).toBe(3)

    // Each row has exactly one editable depth field, defaulting to "auto"
    // (empty value, placeholder advertising the auto fallback).
    const inputs = perHoleInputs()
    expect(inputs.length).toBe(3)
    expect(inputs.every(i => i.value === '')).toBe(true)
    expect(inputs[0].placeholder.toLowerCase()).toContain('auto')
  })

  it('typing a depth sets perHoleDepthOverrides; clearing it removes the key', () => {
    seedProjectWithLoops()
    render(<NewOperationModal />)
    openModalOnDrillPasses()

    // The modal holds the in-progress op in local React state (not the store)
    // until Create, so assert via the rendered field value, not the store.
    // Type a depth into the first hole's field; it commits and displays back.
    let inputs = perHoleInputs()
    fireEvent.change(inputs[0], { target: { value: '-7.5' } })
    inputs = perHoleInputs()
    expect(inputs[0].value).toBe(fmtMm(-7.5))            // override echoed
    expect(inputs[1].value).toBe('')                    // siblings still auto

    // Clear it -> back to auto (empty), the key is removed.
    fireEvent.change(perHoleInputs()[0], { target: { value: '' } })
    expect(perHoleInputs()[0].value).toBe('')
  })

  // The placeholder bug: with "Per-hole depth (from model)" ON and holes whose
  // detected bottoms DIFFER, each row's placeholder must advertise THAT hole's
  // detected world bottom (the value the toolpath uses) — not the op-level bottom
  // repeated for every row. Before the fix all three read the same op-level value.
  it('per-hole placeholders show each holes OWN detected bottom when perHoleDepth is on', () => {
    seedProjectWithDetectedHoles()  // loop-b bottom -9, loop-c bottom -15
    render(<NewOperationModal />)
    // Open the EXISTING drill op (perHoleDepth: true) in edit mode; the prefill
    // seeds the drill state from the op, so the "from model" toggle is on without
    // needing the OCCT derive flow (which can't run under jsdom).
    act(() => { useCamStore.getState().openEditOperation(SETUP_ID, 'op-drill') })
    fireEvent.click(screen.getByText('Passes'))

    // perHoleDepth is ON for this op; assert the toggle is checked so the test is
    // anchored to that precondition.
    const fromModel = screen.getByLabelText(/Per-hole depth \(from model\)/i) as HTMLInputElement
    expect(fromModel.checked).toBe(true)

    const inputs = perHoleInputs()
    expect(inputs.length).toBe(3)
    // Row order is closedLoops order: #1 loop-a (no detected hole), #2 loop-b, #3 loop-c.
    // HELP-QA-7 (4e4ff54e0) moved the resolved auto value from the clipped
    // placeholder into the field's data-tooltip; the per-hole truth contract
    // is unchanged, just read from the tooltip now.
    const tB = inputs[1].getAttribute('data-tooltip') ?? ''
    const tC = inputs[2].getAttribute('data-tooltip') ?? ''
    // Each detected hole advertises its OWN bottom...
    expect(tB).toContain(fmtMm(HOLE_B_BOTTOM))
    expect(tC).toContain(fmtMm(HOLE_C_BOTTOM))
    // ...and the two are DIFFERENT (the bug had them identical).
    expect(tB).not.toBe(tC)
    // The hole with no detected bottom (loop-a) falls back to the op-level bottom,
    // so it must NOT show either detected value.
    const tA = inputs[0].getAttribute('data-tooltip') ?? ''
    expect(tA).not.toContain(fmtMm(HOLE_B_BOTTOM))
    expect(tA).not.toContain(fmtMm(HOLE_C_BOTTOM))
  })

  // Review-in-viewport: clicking a hole's "#N" label yields the modal to a
  // compact banner (highlighting that hole amber in the 3D view); "Back to
  // operation" returns to the per-hole table with form state intact. getVp() is
  // undefined under jsdom, so we assert only that the guarded call does not
  // crash and that the banner <-> table render transitions happen.
  it('clicking a hole #N enters review; Back returns to the table', () => {
    seedProjectWithLoops()
    render(<NewOperationModal />)
    openModalOnDrillPasses()

    // Table is showing; the #N labels are clickable review links.
    expect(screen.getByTestId('drill-perhole-table')).not.toBeNull()
    const links = screen.getAllByTestId('drill-perhole-review-link')
    expect(links.length).toBe(3)

    // Click hole #2's label -> review banner replaces the modal body (no crash
    // from the undefined-getVp guard); the per-hole table is gone.
    fireEvent.click(links[1])
    const banner = screen.getByTestId('drill-perhole-review-banner')
    expect(banner).not.toBeNull()
    expect(banner.textContent).toContain('#2')
    expect(screen.queryByTestId('drill-perhole-table')).toBeNull()

    // "Back to operation" restores the full modal body + the per-hole table.
    fireEvent.click(screen.getByTestId('drill-perhole-review-back'))
    expect(screen.queryByTestId('drill-perhole-review-banner')).toBeNull()
    expect(screen.getByTestId('drill-perhole-table')).not.toBeNull()
    expect(screen.getAllByTestId('drill-perhole-row').length).toBe(3)
  })
})
