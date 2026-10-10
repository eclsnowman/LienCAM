// @vitest-environment jsdom
//
// WO-1473 (BUG-394): the text tool is WYSIWYG -- a click places an EMPTY text
// entity and opens the live in-canvas editor at it (toolController.ts placeText
// never receives a string). But TextInputRow's "Text" field rendered live and
// editable BEFORE placement too, with a header comment claiming it fed the
// cursor ghost and the committed entity -- false on main (no ghost, no string
// threaded to placement). Typing into it pre-placement discarded the text with
// no indication anything was lost.
//
// This test proves: the Text string field is absent while the text tool is
// armed and nothing is being edited yet (pre-placement), present once a placed
// entity is being edited (sketchTextEditId set), and every other pre-placement
// control (Height, Angle, Letter spacing, Mirror, Font) stays live throughout.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'

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

beforeEach(() => {
  act(() => {
    sketcherToolStore.setState({ tool: 'select' })
    useCamStore.setState({ sketchTextEditId: null } as never)
  })
})

// The string field is the ONLY <input> in TextInputRow with spellCheck={false};
// NumericInput (Height/Angle/Letter spacing) also renders type="text" (see its
// own comment: select-all-on-focus needs type=text, not type=number), so the
// Text field needs a selector NumericInput can't collide with. The "Text" tool
// arm-button (SketchToolbox toolbar) also shares the plain string "Text",
// ruling out getByText('Text') for presence checks too.
const TEXT_FIELD_SELECTOR = 'input[spellcheck="false"]'

describe('WO-1473: TextInputRow Text field only live once an entity is being edited', () => {
  it('does NOT render the Text field while the text tool is armed pre-placement', () => {
    act(() => { sketcherToolStore.setState({ tool: 'text' }) })
    const { container } = render(<SketchToolbox />)
    expect(container.querySelector(TEXT_FIELD_SELECTOR)).toBeNull()
  })

  it('still renders Height, Angle, Letter spacing, Mirror and Font pre-placement', () => {
    act(() => { sketcherToolStore.setState({ tool: 'text' }) })
    render(<SketchToolbox />)
    expect(screen.getByText(/Height/)).not.toBeNull()
    expect(screen.getByText('Angle (deg)')).not.toBeNull()
    expect(screen.getByText('Letter spacing (mm)')).not.toBeNull()
    // "Mirror" collides with the MODIFY section's mirror TOOL button; the
    // toggle's own Normal/Mirrored label is what SketchToolboxFont.smoke
    // already uses to query it unambiguously.
    expect(screen.getByText('Normal')).not.toBeNull()
    expect(screen.getByText('Font')).not.toBeNull()
  })

  it('renders the Text field once a placed entity is being edited', () => {
    act(() => { useCamStore.setState({ sketchTextEditId: 'text-1', sketchTextValue: 'LC-12' } as never) })
    const { container } = render(<SketchToolbox />)
    const input = container.querySelector<HTMLInputElement>(TEXT_FIELD_SELECTOR)
    expect(input).not.toBeNull()
    expect(input!.value).toBe('LC-12')
  })
})
