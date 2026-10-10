// @vitest-environment jsdom
//
// React-render SMOKE test for the sketch SPLINE tool's "Close loop" toggle row
// (Operator decision D5). The repo's vitest env is 'node' by default (vite.config.ts);
// the directive above flips THIS file to jsdom so a real React tree can mount.
//
// WHY THIS EXISTS: the toggle is a user-facing toolbox param row shown only while
// the spline tool is armed. This is the HARD UI render gate required by
// docs/CONVENTIONS.md for UI changes — tsc + pure-logic vitest miss hooks-order
// and JSX-wiring bugs. The test mounts the toolbox, asserts the row appears only
// while the spline tool is armed, and clicks it to confirm sketchSplineClosed
// flips (default OFF -> ON).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'

// jsdom's built-in localStorage is broken under vitest's node launch flags, and
// the Zustand store uses persist() which writes on every set(). Install a minimal
// in-memory Storage shim BEFORE importing the store. Pure test scaffolding.
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

const { SketchToolbox } = await import('../../components/panels/sketch/SketchToolbox')
await import('../../store')
const { sketcherToolStore } = await import('../../lib/sketch/sketcher')

afterEach(cleanup)

// The package tool store is a process singleton; reset it to defaults (tool =
// 'select', splineClosed = false) before each case so the tests are
// order-independent.
beforeEach(() => {
  act(() => {
    sketcherToolStore.__reset()
  })
})

describe('SketchToolbox spline "Close loop" toggle', () => {
  it('does NOT render the row while a non-spline tool is armed', () => {
    render(<SketchToolbox />)
    expect(screen.queryByText('Close loop')).toBeNull()
  })

  it('renders the row while the spline tool is armed', () => {
    act(() => { sketcherToolStore.setState({ tool: 'spline' }) })
    render(<SketchToolbox />)
    expect(screen.getByText('Close loop')).not.toBeNull()
  })

  it('flips splineClosed when the toggle is clicked (default OFF -> ON)', () => {
    act(() => { sketcherToolStore.setState({ tool: 'spline' }) })
    render(<SketchToolbox />)
    expect(sketcherToolStore.getState().splineClosed).toBe(false)

    // The toggle button label reads Open when off, Closed when on.
    act(() => { fireEvent.click(screen.getByText('Open')) })
    expect(sketcherToolStore.getState().splineClosed).toBe(true)
    expect(screen.getByText('Closed')).not.toBeNull()
  })
})
