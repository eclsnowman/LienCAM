// @vitest-environment jsdom
//
// WO-1430: TransformInput's shared draft/commit/cancel contract (BUG-376).
//
// GATE NOTE: uses the input's REAL `.focus()`/`.blur()`, not `fireEvent.focus`
// (which does not move `document.activeElement` -- a documented Testing
// Library gotcha). Only a truly-focused element's `.blur()` synchronously
// dispatches a real native "blur" event, and it is exactly that synchronous
// dispatch -- racing React's still-queued Escape setDraft -- that reproduces
// BUG-376 (verified against main's pre-fix TransformInput: with real
// `.focus()`, Escape committed the cancelled draft's typed value).

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

function renderInput(onChange: (v: number) => void = () => {}, value = 12.5, units?: 'mm' | 'inch') {
  const { container } = render(
    <TransformInput axis="X" color="red" value={value} onChange={onChange} units={units} />,
  )
  return container.querySelector('input.props-number-input') as HTMLInputElement
}

describe('TransformInput: Escape truly cancels (BUG-376)', () => {
  it('typing a new value then pressing Escape never calls onChange, regardless of blur timing', () => {
    const onChange = vi.fn()
    const input = renderInput(onChange)

    input.focus() // real focus, not fireEvent.focus -- see file header
    fireEvent.change(input, { target: { value: '99' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(onChange).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalledWith(99)
    expect(input.value).toBe('12.5')
  })

  it('reproduces under unit conversion too (inch display)', () => {
    const onChange = vi.fn()
    const input = renderInput(onChange, 25.4, 'inch')

    input.focus()
    fireEvent.change(input, { target: { value: '5' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(onChange).not.toHaveBeenCalled()
    expect(input.value).toBe('1')
  })
})

describe('TransformInput: untouched field commits nothing', () => {
  it('focusing then blurring (tab through) without editing calls onChange zero times', () => {
    const onChange = vi.fn()
    const input = renderInput(onChange)

    input.focus()
    input.blur()

    expect(onChange).not.toHaveBeenCalled()
  })

  it('clicking away from an untouched field calls onChange zero times', () => {
    const onChange = vi.fn()
    const input = renderInput(onChange, 0, 'mm')

    input.focus()
    input.blur()

    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('TransformInput: a real edit still commits on blur/Enter (unchanged behavior)', () => {
  it('a changed value commits on blur', () => {
    const onChange = vi.fn()
    const input = renderInput(onChange)

    input.focus()
    fireEvent.change(input, { target: { value: '20' } })
    input.blur()

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(20)
  })

  it('a changed value commits on Enter', () => {
    const onChange = vi.fn()
    const input = renderInput(onChange)

    input.focus()
    fireEvent.change(input, { target: { value: '20' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onChange).toHaveBeenCalledWith(20)
  })
})
