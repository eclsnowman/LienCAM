// @vitest-environment jsdom
//
// React-render SMOKE + selection-contract test for the sketch confirm overlay
// (fillet/offset/pattern staged flows). Its value fields were type="number"
// with no select-on-click at all; they now consume the shared selectAllOnClick
// contract on type="text" inputs (inputMode text so equation symbols are
// reachable), with the number-input arrow stepping preserved manually (1 for
// counts, 0.1 otherwise, clamped at the field min like the native spinner).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act, fireEvent } from '@testing-library/react'

// In-memory Storage shim BEFORE importing the store (same scaffolding as the
// other *.smoke.test.tsx files).
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

const { SketchConfirmOverlay } = await import('../../lib/sketch/sketcher/overlays/SketchConfirmOverlay')
const { useCamStore } = await import('../../store')
const { createCamOverlaysPort } =
  await import('../../components/viewport/camOverlaysPort')
const { sketcherToolStore } = await import('../../lib/sketch/sketcher')

afterEach(cleanup)

// Arm a LINEAR PATTERN staged flow: the confirmOverlayModel 'linpat' branch
// needs only chain.vector + chain.ids (no geometry preview), so an empty
// sketch is enough to put the overlay (and its Count field) on screen. The
// armed tool, chain and pattern count are package-owned now; the sketch doc +
// units + viewer mode stay on the CAM store.
beforeEach(() => {
  act(() => {
    sketcherToolStore.__reset()
    useCamStore.setState({
      activeSketch: {
        id: 's1', layerId: 'L1', entities: [],
        constraints: [], dimensions: [],
        solveStatus: { dof: 0, conflicting: [], redundant: [] },
      },
    } as never)
    sketcherToolStore.setState({
      tool: 'pattern-linear',
      chain: { kind: 'linpat', ids: ['e1'], vector: { x: 10, y: 0 } },
      linearPatternCount: 3,
    } as never)
    useCamStore.getState().setDisplayUnits('mm')
    useCamStore.getState().setViewerMode('sketch')
  })
})

// WO SKC-14C: the overlays read the host through this port instead of `useCamStore` +
// a `viewportRef`. Same CAM store underneath -- every seeded field below still drives them.
const port = createCamOverlaysPort(() => null)

describe('SketchConfirmOverlay: click-selects-all contract on staged-value fields', () => {
  const renderCountInput = () => {
    const { container } = render(<SketchConfirmOverlay port={port} />)
    return container.querySelector('.sketch-confirm-field input') as HTMLInputElement
  }

  it('mounts the staged overlay; the Count field is a text input (equation symbols reachable)', () => {
    const input = renderCountInput()
    expect(input).not.toBeNull()
    expect(input.type).toBe('text')
    expect(input.inputMode).toBe('text') // count fields accept "=..." equations
    expect(input.value).toBe('3')
  })

  it('focus selects all; first-click mouseUp re-selects; second click keeps the caret', () => {
    const input = renderCountInput()
    fireEvent.focus(input)
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(input.value.length)

    input.setSelectionRange(1, 1)
    const notPrevented = fireEvent.mouseUp(input)
    expect(notPrevented).toBe(false) // preventDefault: caret drop suppressed
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(input.value.length)

    input.setSelectionRange(1, 1)
    expect(fireEvent.mouseUp(input)).toBe(true) // one-shot consumed
    expect(input.selectionStart).toBe(1)
  })

  it('preserves arrow stepping: +1/-1 for the integer count, clamped at min (2)', () => {
    const input = renderCountInput()
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(sketcherToolStore.getState().linearPatternCount).toBe(4)
    expect(input.value).toBe('4')

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(sketcherToolStore.getState().linearPatternCount).toBe(2)
    // Clamped at the field min (2), exactly like the native spinner was.
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(sketcherToolStore.getState().linearPatternCount).toBe(2)
    expect(input.value).toBe('2')
  })
})
