// @vitest-environment jsdom
//
// React-render SMOKE + selection-contract test for the PropertiesPanel
// transform X/Y/Z fields (TransformInput). These were still the DEAD pattern
// the prior fix (18610ab) called out: type="number" + bare e.target.select()
// in onFocus — select() is a spec no-op on number inputs, and even on text
// the mouseUp caret drop wins without the one-shot re-select. Now consumes
// the shared selectAllOnClick contract on a type="text" inputMode="decimal"
// input, with the number-input arrow-key stepping (0.1) preserved manually.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'

// In-memory Storage shim BEFORE importing the store (jsdom's localStorage is
// broken under vitest's node launch flags; the Zustand store persists on set).
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

const { TransformInput } = await import('../../components/panels/PropertiesPanel')

afterEach(cleanup)

function renderInput(onChange: (v: number) => void = () => {}) {
  const { container } = render(
    <TransformInput axis="X" color="red" value={12.5} onChange={onChange} />,
  )
  return container.querySelector('input.props-number-input') as HTMLInputElement
}

describe('PropertiesPanel TransformInput: click-selects-all contract', () => {
  it('renders type="text" inputMode="decimal" (selection APIs are a no-op on number inputs)', () => {
    const input = renderInput()
    expect(input).not.toBeNull()
    expect(input.type).toBe('text')
    expect(input.inputMode).toBe('decimal')
    expect(input.value).toBe('12.5')
  })

  it('focus selects the whole value; the click mouseUp re-selects (one-shot)', () => {
    const input = renderInput()
    fireEvent.focus(input)
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(input.value.length)

    // Click caret collapse, then the paired mouseUp: preventDefault + re-select.
    input.setSelectionRange(2, 2)
    const notPrevented = fireEvent.mouseUp(input)
    expect(notPrevented).toBe(false)
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(input.value.length)

    // Second click while focused: caret placement wins (flag consumed).
    input.setSelectionRange(2, 2)
    expect(fireEvent.mouseUp(input)).toBe(true)
    expect(input.selectionStart).toBe(2)
    expect(input.selectionEnd).toBe(2)
  })

  it('preserves arrow-key stepping (0.1 like the old number spinner) and commits on Enter', () => {
    const onChange = vi.fn()
    const input = renderInput(onChange)

    fireEvent.focus(input)
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(input.value).toBe('12.6') // draft stepped, no float noise
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input.value).toBe('12.4')

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith(12.4) // mm passthrough (no units prop)
  })

  it('Escape reverts the draft to the last committed value', () => {
    const input = renderInput()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '99' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input.value).toBe('12.5')
  })
})
