// @vitest-environment jsdom
//
// React-render SMOKE test for the sketch TEXT tool's UNIFIED font picker (Operator:
// "more fonts and not knowing I needed to switch it to outlined text to get
// options was unclear"). The font choice used to be hidden behind an "outline"
// toggle; it is now a single ALWAYS-VISIBLE dropdown that lists the single-line
// Hershey entry plus every outline face, and one pick sets BOTH style + family.
//
// WHY THIS EXISTS: the picker is a user-facing toolbox param row shown while the
// text tool is armed. This is the HARD UI render gate required by
// docs/CONVENTIONS.md for UI changes — tsc + pure-logic vitest miss hooks-order
// and JSX-wiring bugs. The test mounts the toolbox, asserts the Font dropdown is
// visible with the text tool armed WITHOUT any outline toggle, and that changing
// it drives style + family in the store.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import { SINGLE_LINE_FONT_VALUE } from '../../lib/sketch/textOutline'

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
const { useCamStore } = await import('../../store')
const { sketcherToolStore } = await import('../../lib/sketch/sketcher')

afterEach(cleanup)

// The armed tool now lives in the package store; the text* fields (style,
// family, edit id, mirror) stay on the CAM store.
beforeEach(() => {
  act(() => {
    sketcherToolStore.setState({ tool: 'select' })
    useCamStore.setState({
      sketchTextStyle: 'single-line',
      sketchTextFontFamily: 'Rounded Mplus 1c',
      sketchTextEditId: null,
    } as never)
  })
})

describe('SketchToolbox unified font picker', () => {
  it('does NOT render the Font picker while a non-text tool is armed', () => {
    render(<SketchToolbox />)
    expect(screen.queryByText('Font')).toBeNull()
  })

  it('renders the Font dropdown ALWAYS-VISIBLE while the text tool is armed (no outline toggle needed)', () => {
    act(() => { sketcherToolStore.setState({ tool: 'text' }) })
    render(<SketchToolbox />)
    // The label is present and it is a <select> (a dropdown, not a hidden gate).
    expect(screen.getByText('Font')).not.toBeNull()
    const select = screen.getByRole('combobox') as HTMLSelectElement
    // Single-line default -> the sentinel is the selected value.
    expect(select.value).toBe(SINGLE_LINE_FONT_VALUE)
    // The Import button is visible next to the picker (not gated behind outline).
    expect(screen.getByText('Import font...')).not.toBeNull()
    // The old style toggle is gone.
    expect(screen.queryByText('Single-line')).toBeNull()
    expect(screen.queryByText('Outline')).toBeNull()
  })

  it('choosing an outline face sets style outline + family in one action', () => {
    act(() => { sketcherToolStore.setState({ tool: 'text' }) })
    render(<SketchToolbox />)
    const select = screen.getByRole('combobox') as HTMLSelectElement
    act(() => { fireEvent.change(select, { target: { value: 'Helvetiker Bold' } }) })
    expect(useCamStore.getState().sketchTextStyle).toBe('outline')
    expect(useCamStore.getState().sketchTextFontFamily).toBe('Helvetiker Bold')
    // Selecting the Hershey entry flips back to single-line.
    act(() => { fireEvent.change(select, { target: { value: SINGLE_LINE_FONT_VALUE } }) })
    expect(useCamStore.getState().sketchTextStyle).toBe('single-line')
  })

  // MIRROR toggle (flip-TEXT, spec T5b): lives with font/height because it
  // applies to FREE text too (the on-path anchor pill carries its own copy).
  // Renders ONLY while the text tool is armed / a text is edited -- the same
  // at-rest gate as the whole TextInputRow (first test above proves rest).
  // NOTE: the queries use the toggle's unique Normal/Mirrored labels, not the
  // word "Mirror" -- the MODIFY section's mirror TOOL button also says that.
  it('renders the Mirror toggle with the text tool armed and drives sketchTextMirrored', () => {
    act(() => {
      useCamStore.setState({ sketchTextMirrored: false } as never)
      sketcherToolStore.setState({ tool: 'text' })
    })
    render(<SketchToolbox />)
    const btn = screen.getByText('Normal').closest('button')!
    expect(btn.getAttribute('aria-pressed')).toBe('false')
    act(() => { fireEvent.click(btn) })
    expect(useCamStore.getState().sketchTextMirrored).toBe(true)
    // The button reflects the new state (label + pressed).
    const on = screen.getByText('Mirrored').closest('button')!
    expect(on.getAttribute('aria-pressed')).toBe('true')
  })

  it('does NOT render the Mirror toggle at rest (select tool, no text edit)', () => {
    render(<SketchToolbox />)
    expect(screen.queryByText('Normal')).toBeNull()
    expect(screen.queryByText('Mirrored')).toBeNull()
  })
})
