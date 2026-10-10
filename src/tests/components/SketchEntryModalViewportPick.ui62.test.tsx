// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ImportedGeometry } from '../../types'

class StubWorker {
  onmessage: ((event: unknown) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  postMessage(): void {}
  terminate(): void {}
}
vi.stubGlobal('Worker', StubWorker)

const memory = new Map<string, string>()
const memoryStorage: Storage = {
  get length() { return memory.size },
  clear: () => memory.clear(),
  getItem: (key) => memory.get(key) ?? null,
  key: (index) => Array.from(memory.keys())[index] ?? null,
  removeItem: (key) => { memory.delete(key) },
  setItem: (key, value) => { memory.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', {
  value: memoryStorage,
  configurable: true,
})

const { SketchEntryModal } = await import('../../components/modals/SketchEntryModal')
const { useCamStore } = await import('../../store')

const SINGLE_PART_ID = 'single-part'
const MULTI_PART_ID = 'multi-part'
const LOCKED_PART_ID = 'locked-part'
let pickedPart: ((id: string) => void) | null = null
let hoverPart: ((id: string | null) => void) | null = null
let allowedPartIds: readonly string[] = []
const setSelectedPart = vi.fn()

function loop(id: string, layerId: string, offset = 0) {
  return {
    id,
    layerId,
    closed: true,
    type: 'contour' as const,
    area: 100,
    points: [
      { x: offset, y: 0 },
      { x: offset + 10, y: 0 },
      { x: offset + 10, y: 10 },
      { x: offset, y: 10 },
    ],
  }
}

function seedGeometry() {
  const common = {
    type: 'curves_2d' as const,
    format: 'dxf' as const,
    loaded: true,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    boundingBox: {
      min: { x: 0, y: 0, z: 0 },
      max: { x: 10, y: 10, z: 0 },
      size: { x: 10, y: 10, z: 0 },
      center: { x: 5, y: 5, z: 0 },
    },
  }
  const geometry = [
    {
      ...common,
      id: SINGLE_PART_ID,
      name: 'Single layer plate',
      filename: 'single.dxf',
      loops: [loop('single-loop', 'single-layer')],
      layers2d: [{
        id: 'single-layer',
        name: 'Single Profile',
        color: '#fff',
        visible: true,
      }],
    },
    {
      ...common,
      id: MULTI_PART_ID,
      name: 'Multi layer plate',
      filename: 'multi.dxf',
      loops: [
        loop('multi-loop-a', 'multi-layer-a'),
        loop('multi-loop-b', 'multi-layer-b', 20),
      ],
      layers2d: [
        { id: 'multi-layer-a', name: 'Outer Profile', color: '#fff', visible: true },
        { id: 'multi-layer-b', name: 'Hole Pattern', color: '#fff', visible: true },
      ],
    },
    {
      ...common,
      id: LOCKED_PART_ID,
      name: 'Locked plate',
      filename: 'locked.dxf',
      loops: [loop('locked-loop', 'locked-layer')],
      layers2d: [{
        id: 'locked-layer',
        name: 'Locked Profile',
        color: '#fff',
        visible: true,
        locked: true,
      }],
    },
  ] as unknown as ImportedGeometry[]

  const current = useCamStore.getState()
  useCamStore.setState({
    project: { ...current.project, geometry },
  })
}

beforeEach(() => {
  act(() => { useCamStore.getState().newProject() })
  pickedPart = null
  hoverPart = null
  allowedPartIds = []
  setSelectedPart.mockClear()
  ;(window as unknown as Record<string, unknown>).__cncViewport = {
    setPartPickMode: (
      callback: ((id: string) => void) | null,
      allowedIds: readonly string[] = [],
      _selectedIds: readonly string[] = [],
      _presentation?: 'standard' | 'nest-membership',
      onHover?: ((id: string | null) => void) | null,
    ) => {
      pickedPart = callback
      hoverPart = callback ? (onHover ?? null) : null
      if (callback) allowedPartIds = allowedIds
    },
    setSelectedPart,
  }
  seedGeometry()
})

afterEach(() => {
  cleanup()
  delete (window as unknown as Record<string, unknown>).__cncViewport
})

function openChooser() {
  render(<SketchEntryModal />)
  act(() => { useCamStore.getState().openModal('sketch-entry') })
}

describe('UI-62 sketch entry viewport part picking', () => {
  it('WO-069: opens the chooser modal FIRST (not the viewport pick) with "New sketch" as the top option', () => {
    openChooser()
    // The modal is open, NOT the pick banner -- the pick is no longer
    // auto-armed on open (WO-069 flow-order fix).
    expect(screen.queryByTestId('sketch-entry-part-pick-banner')).toBeNull()
    expect(document.querySelector('.sketch-entry-modal')).not.toBeNull()
    // "New sketch" is the FIRST option card in the modal body, above
    // "Pick existing in viewport" (Operator's arrow markup, WO-069).
    const cards = document.querySelectorAll('.modal-body .op-type-card')
    expect(cards.length).toBeGreaterThanOrEqual(2)
    expect(cards[0].textContent).toContain('New sketch')
    expect(cards[1].textContent).toContain('Pick existing in viewport')
  })

  it('WO-069: Cancel in the modal footer closes the chooser cleanly', () => {
    openChooser()
    expect(document.querySelector('.sketch-entry-modal')).not.toBeNull()
    fireEvent.click(screen.getByText('Cancel'))
    expect(useCamStore.getState().activeModal).toBeNull()
    expect(document.querySelector('.sketch-entry-modal')).toBeNull()
  })

  it('opens the only editable layer on a picked part directly', () => {
    openChooser()
    // WO-069: the pick starts from the "Pick existing in viewport" button,
    // not auto-armed on open.
    expect(screen.queryByTestId('sketch-entry-part-pick-banner')).toBeNull()
    fireEvent.click(screen.getByTestId('sketch-entry-pick-existing'))
    expect(screen.getByTestId('sketch-entry-part-pick-banner')).not.toBeNull()

    expect(allowedPartIds).toEqual([SINGLE_PART_ID, MULTI_PART_ID])
    const choose = pickedPart
    expect(choose).not.toBeNull()
    act(() => { choose?.(SINGLE_PART_ID) })

    const state = useCamStore.getState()
    expect(state.activeModal).toBeNull()
    expect(state.viewer.mode).toBe('sketch')
    expect(state.activeSketch?.layerId).toBe('single-layer')
    expect(state.viewer.selectedGeometryId).toBe(SINGLE_PART_ID)
    expect(setSelectedPart).toHaveBeenCalledWith(SINGLE_PART_ID)
  })

  it('narrows the row fallback when a picked part has multiple editable layers', () => {
    openChooser()
    // WO-069: arm the pick via the button, not auto-armed on open.
    fireEvent.click(screen.getByTestId('sketch-entry-pick-existing'))

    const choose = pickedPart
    act(() => { choose?.(MULTI_PART_ID) })

    expect(screen.getByTestId('sketch-entry-picked-part-note')).not.toBeNull()
    expect(screen.queryByText('Single Profile')).toBeNull()
    expect(screen.getByText('Outer Profile')).not.toBeNull()
    fireEvent.click(screen.getByText('Hole Pattern'))

    expect(useCamStore.getState().activeSketch?.layerId).toBe('multi-layer-b')
    expect(useCamStore.getState().viewer.mode).toBe('sketch')
  })

  it('preserves new-sketch entry alongside the viewport-first path', () => {
    openChooser()
    // WO-069: the modal opens first, so "New sketch" is directly reachable
    // -- no need to cancel out of an auto-armed pick first.
    expect(screen.queryByTestId('sketch-entry-part-pick-banner')).toBeNull()
    fireEvent.click(screen.getByText('New sketch'))

    expect(useCamStore.getState().viewer.mode).toBe('sketch')
    expect(useCamStore.getState().activeSketch).not.toBeNull()
  })

  it('posts a console line on arm and re-arms via the manual button as the alternate path', () => {
    openChooser()
    // WO-069: the pick is no longer auto-armed on open -- the user clicks
    // "Pick existing in viewport" to arm it.
    expect(screen.queryByTestId('sketch-entry-part-pick-banner')).toBeNull()
    fireEvent.click(screen.getByTestId('sketch-entry-pick-existing'))

    // Contextual-feedback rule (Operator 2026-07-25): arming a pick posts a
    // plain-words console line, not just a silent highlight.
    const armedEvents = useCamStore.getState().consoleEvents
    expect(armedEvents.some((e) => e.message.includes('Pick the part to edit'))).toBe(true)

    // Cancel returns to the chooser; the "Pick existing in viewport" button
    // is still there and still works (re-arm after a canceled session).
    fireEvent.click(screen.getByTestId('sketch-entry-part-pick-cancel'))
    expect(screen.queryByTestId('sketch-entry-part-pick-banner')).toBeNull()
    const manualButton = screen.getByTestId('sketch-entry-pick-existing')
    expect(manualButton).not.toBeNull()

    pickedPart = null
    fireEvent.click(manualButton)
    expect(screen.getByTestId('sketch-entry-part-pick-banner')).not.toBeNull()
    expect(pickedPart).not.toBeNull()
    act(() => { pickedPart?.(SINGLE_PART_ID) })
    expect(useCamStore.getState().activeSketch?.layerId).toBe('single-layer')
  })

  it('posts a hover console line naming the candidate part', () => {
    openChooser()
    // WO-069: arm the pick via the button, not auto-armed on open.
    fireEvent.click(screen.getByTestId('sketch-entry-pick-existing'))

    expect(hoverPart).not.toBeNull()
    const before = useCamStore.getState().consoleEvents.length
    act(() => { hoverPart?.(MULTI_PART_ID) })

    const events = useCamStore.getState().consoleEvents
    expect(events.length).toBeGreaterThan(before)
    expect(events.at(-1)?.message).toContain('Multi layer plate')
    expect(events.at(-1)?.message).toContain('hovering')
  })
})
