// @vitest-environment jsdom
//
// React-render SMOKE test for the WYSIWYG in-canvas text editor
// (SketchTextInput). This is the HARD UI render gate required by
// docs/CONVENTIONS.md for UI changes -- tsc + pure vitest miss hooks-order and
// JSX-wiring bugs. It mounts the overlay while a text edit is open, asserts the
// field appears at the anchor bound to the LIVE entity string, that typing
// drives the store (entity mutates live), and that Enter commits / Esc cancels.

import type { SketcherOverlaySurface } from '../../lib/sketch/sketcher'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'

// jsdom's localStorage is broken under vitest's node flags and the store uses
// persist(); install an in-memory shim BEFORE importing the store.
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
// The overlay runs a per-frame rAF position sync; keep it single-shot in jsdom.
vi.stubGlobal('requestAnimationFrame', () => 0)
vi.stubGlobal('cancelAnimationFrame', () => undefined)

const { SketchTextInput } = await import('../../lib/sketch/sketcher/overlays/SketchTextInput')
const { useCamStore } = await import('../../store')
const { createCamOverlaysPort } =
  await import('../../components/viewport/camOverlaysPort')
import type { CNCViewport } from '../../lib/viewport/CNCViewport'
import type { SketchTextEntity } from '../../lib/sketch/types'

// Minimal viewport stub: the overlay only needs worldToScreen.
const fakeViewport = {
  worldToScreen: (x: number, y: number) => ({ x: 100 + x, y: 100 + y }),
} as unknown as CNCViewport
const viewportRef = { current: fakeViewport }

afterEach(cleanup)

beforeEach(() => {
  act(() => {
    useCamStore.setState({
      viewer: { ...useCamStore.getState().viewer, mode: 'sketch' },
      activeSketch: {
        id: 'sk', layerId: 'L',
        entities: [{
          id: 'tx', kind: 'text', construction: false,
          at: { x: 5, y: 8 }, text: 'HI', height: 6, rotation: 0,
          fontStyle: 'single-line',
        }],
        constraints: [], dimensions: [], solveStatus: null,
      },
      sketchHistory: [], projectHistory: [], canUndo: false,
      sketchTextEditId: null, sketchTextValue: 'HI', sketchTextHeight: 6,
      sketchTextRotationDeg: 0, sketchTextStyle: 'single-line',
    } as never)
    // Open the edit through the real action so the module edit flags (orig /
    // dirty / isNew) are reset deterministically between tests.
    useCamStore.getState().beginSketchTextEdit('tx')
  })
})

const txt = () =>
  useCamStore.getState().activeSketch!.entities[0] as SketchTextEntity

// WO SKC-14C: the overlays read the host through this port instead of `useCamStore` +
// a `viewportRef`. Same CAM store underneath -- every seeded field below still drives them.
const port = createCamOverlaysPort(() => viewportRef.current as unknown as SketcherOverlaySurface)

describe('SketchTextInput (WYSIWYG in-canvas text editor)', () => {
  it('does NOT render when no text edit is open', () => {
    act(() => { useCamStore.setState({ sketchTextEditId: null } as never) })
    render(<SketchTextInput port={port} />)
    expect(screen.queryByLabelText('Sketch text')).toBeNull()
  })

  it('renders at the anchor, bound to the live entity string, and auto-focuses', () => {
    render(<SketchTextInput port={port} />)
    const input = screen.getByLabelText('Sketch text') as HTMLInputElement
    expect(input).not.toBeNull()
    expect(input.value).toBe('HI')
    expect(document.activeElement).toBe(input)
  })

  it('is VISUALLY INVISIBLE (no second visible box beside the real glyphs)', () => {
    // The real cyan-tinted glyphs in the sketch layer are the single WYSIWYG
    // surface; the input must contribute NO visible box: no border, no
    // background, transparent text + caret. Asserted via inline style (jsdom
    // does not apply app.css).
    render(<SketchTextInput port={port} />)
    const input = screen.getByLabelText('Sketch text') as HTMLInputElement
    expect(input.style.borderStyle).toBe('none')
    expect(input.style.background).toBe('transparent')
    expect(input.style.color).toBe('transparent')
  })

  it('typing drives the store (entity mutates LIVE)', () => {
    render(<SketchTextInput port={port} />)
    const input = screen.getByLabelText('Sketch text') as HTMLInputElement
    act(() => { fireEvent.change(input, { target: { value: 'HELLO' } }) })
    expect(txt().text).toBe('HELLO')
    // The controlled field reflects the live value.
    expect((screen.getByLabelText('Sketch text') as HTMLInputElement).value).toBe('HELLO')
  })

  it('Enter commits (blur with no field target ends the edit)', () => {
    render(<SketchTextInput port={port} />)
    const input = screen.getByLabelText('Sketch text') as HTMLInputElement
    act(() => { fireEvent.keyDown(input, { key: 'Enter' }) })
    expect(useCamStore.getState().sketchTextEditId).toBeNull()
  })

  it('Esc cancels the edit', () => {
    render(<SketchTextInput port={port} />)
    const input = screen.getByLabelText('Sketch text') as HTMLInputElement
    act(() => { fireEvent.keyDown(input, { key: 'Escape' }) })
    expect(useCamStore.getState().sketchTextEditId).toBeNull()
  })

  it('CARET sync (M1b): typing and arrow keys push selectionStart to the store', () => {
    render(<SketchTextInput port={port} />)
    const input = screen.getByLabelText('Sketch text') as HTMLInputElement
    // The edit opened with the caret at the end of 'HI' (store + auto-focus).
    expect(useCamStore.getState().sketchTextCaretIndex).toBe(2)
    // Typing: the change handler syncs the moved insertion point.
    act(() => { fireEvent.change(input, { target: { value: 'HIYA' } }) })
    expect(input.selectionStart).toBe(4)
    expect(useCamStore.getState().sketchTextCaretIndex).toBe(4)
    // Arrow key: the DOM moves the caret, keyup syncs it (jsdom does not
    // emulate the caret move itself, so place it explicitly like the
    // browser would before the keyup fires).
    act(() => {
      input.setSelectionRange(1, 1)
      fireEvent.keyUp(input, { key: 'ArrowLeft' })
    })
    expect(useCamStore.getState().sketchTextCaretIndex).toBe(1)
  })
})
