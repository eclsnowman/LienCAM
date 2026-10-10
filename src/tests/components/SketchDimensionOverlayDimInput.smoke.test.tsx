// @vitest-environment jsdom
//
// React-render SMOKE + selection-contract test for the sketch dimension VALUE
// editor (SketchDimensionOverlay's DimValueInput) — the REPRODUCED-BROKEN site
// of the "clicking a number field does not select all" bug.
//
// ROOT CAUSE (real-browser event trace, 2026-07): the editor opens ALREADY
// FOCUSED (mount effect focus()+select()), so the user's first click fired NO
// focus event and no app code ran — the browser's default mousedown caret
// placement won. The fix consumes the shared selectAllOnClick contract and
// ARMS the one-shot select-on-mouseUp from the programmatic mount focus too:
// first click into the auto-focused field selects all (Chrome-URL-bar feel),
// second click places the caret.

import type { SketcherOverlaySurface } from '../../lib/sketch/sketcher'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act, fireEvent } from '@testing-library/react'
import type { RefObject } from 'react'
import type { SketchDimension, SketchEntity } from '../../lib/sketch/types'
import type { CNCViewport } from '../../lib/viewport/CNCViewport'

// jsdom's localStorage is broken under vitest's node launch flags and the store
// persists on every set(). Install an in-memory Storage shim BEFORE importing
// the store (same scaffolding as the other *.smoke.test.tsx files).
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

const { SketchDimensionOverlay, DimValueInput } =
  await import('../../lib/sketch/sketcher/overlays/SketchDimensionOverlay')
const { useCamStore } = await import('../../store')
const { createCamOverlaysPort } =
  await import('../../components/viewport/camOverlaysPort')

afterEach(cleanup)

const fakeViewport = {
  getLastSketchCursor: () => ({ x: 0, y: 0 }),
  worldToScreen: () => ({ x: 0, y: 0 }),
  getWorldPerPixel: () => 1,
} as unknown as CNCViewport
const viewportRef: RefObject<CNCViewport | null> = { current: fakeViewport }

// Fixtures: two points + a driving distance dim between them (labelAnchor set
// so dimensionDisplay never needs the outward-side heuristic).
const pa: SketchEntity = { id: 'pa', kind: 'point', construction: false, at: { x: 0, y: 0 } }
const pb: SketchEntity = { id: 'pb', kind: 'point', construction: false, at: { x: 25, y: 0 } }
const dimD1: SketchDimension = {
  id: 'd1', kind: 'distance', driving: true, value: 25,
  a: { entityId: 'pa', site: 'self' }, b: { entityId: 'pb', site: 'self' },
  labelAnchor: { x: 12.5, y: 5 },
}

beforeEach(() => {
  act(() => {
    useCamStore.setState({
      activeSketch: null, sketchTool: 'select', sketchToolChain: null,
      sketchSelectedIds: [], sketchDimEditor: null,
    } as never)
  })
})

// WO SKC-14C: the overlays read the host through this port instead of `useCamStore` +
// a `viewportRef`. Same CAM store underneath -- every seeded field below still drives them.
const port = createCamOverlaysPort(() => viewportRef.current as unknown as SketcherOverlaySurface)

describe('DimValueInput: auto-focused editor selection contract', () => {
  const renderInput = () => {
    const { container } = render(<DimValueInput port={port} dim={dimD1} units="mm" />)
    return container.querySelector('input.sketch-dim-input') as HTMLInputElement
  }

  it('mounts focused with the WHOLE value selected (text input, text keypad)', () => {
    const input = renderInput()
    expect(input).not.toBeNull()
    expect(input.type).toBe('text')
    // "sketch-dim equations wiring": inputMode is "text", not "decimal" -- an equation types
    // letters ("sqrt", "sin") and symbols a decimal-only mobile keypad would hide.
    expect(input.inputMode).toBe('text')
    expect(document.activeElement).toBe(input)
    expect(input.value).toBe('25')
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(input.value.length)
  })

  it('FIRST user click into the auto-focused field selects all (armed by the mount focus)', () => {
    const input = renderInput()
    // The field is ALREADY focused: a click fires NO focus event. The
    // mousedown collapses the selection to a caret; the armed one-shot must
    // consume that click's mouseUp: preventDefault + re-select.
    fireEvent.mouseDown(input)
    input.setSelectionRange(1, 1)
    const notPrevented = fireEvent.mouseUp(input)

    expect(notPrevented).toBe(false) // preventDefault WAS called
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(input.value.length)
  })

  it('SECOND click places the caret (one-shot consumed)', () => {
    const input = renderInput()
    fireEvent.mouseUp(input) // first click consumes the one-shot
    input.setSelectionRange(1, 1)
    const notPrevented = fireEvent.mouseUp(input)

    expect(notPrevented).toBe(true)
    expect(input.selectionStart).toBe(1)
    expect(input.selectionEnd).toBe(1)
  })
})

describe('SketchDimensionOverlay: dim editor render smoke', () => {
  it('mounts the overlay with the editor OPEN without a hooks/render crash', () => {
    act(() => {
      useCamStore.setState({
        activeSketch: {
          id: 's1', layerId: 'L1', entities: [pa, pb],
          constraints: [], dimensions: [dimD1],
          solveStatus: { dof: 0, conflicting: [], redundant: [] },
        },
        sketchTool: 'select', sketchToolChain: null,
        sketchSelectedIds: [],
        sketchDimEditor: { dimId: 'd1' },
      } as never)
      useCamStore.getState().setDisplayUnits('mm')
      useCamStore.getState().setViewerMode('sketch')
    })
    const { container } = render(<SketchDimensionOverlay port={port} />)
    const input = container.querySelector('input.sketch-dim-input') as HTMLInputElement
    expect(input).not.toBeNull()
    expect(input.type).toBe('text')
    // Auto-focused with the whole value selected, ready to type over.
    expect(document.activeElement).toBe(input)
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(input.value.length)
  })
})
