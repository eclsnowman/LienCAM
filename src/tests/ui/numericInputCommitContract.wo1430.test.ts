// @vitest-environment jsdom
//
// WO-1430: shared draft/commit/cancel contract for NumericInput and
// OptionalNumericInput (BUG-376/404 family).
//
// GATE NOTE: these tests use the input's REAL `.focus()`/`.blur()` (not
// `fireEvent.focus`, which per Testing Library's own documented gotcha does
// NOT move `document.activeElement`). Only a truly-focused element's
// `.blur()` call synchronously dispatches a real native "blur" event -- and
// it is exactly that synchronous dispatch, racing React's still-queued
// Escape setState, that reproduces BUG-376/404. A harness built on
// `fireEvent.focus` never exercises the race at all (verified against
// main's pre-fix NumericInput.tsx: with `fireEvent.focus` the bug is
// invisible; with real `.focus()` main commits the cancelled draft).

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import * as React from 'react'
import { NumericInput, OptionalNumericInput } from '../../components/ui/NumericInput'

afterEach(cleanup)

describe('NumericInput: Escape truly cancels', () => {
  it('typing a new value then pressing Escape never calls onChange, regardless of blur timing', () => {
    const onChange = vi.fn()
    const { container } = render(
      React.createElement(NumericInput, { value: 5, onChange, units: 'mm' }),
    )
    const input = container.querySelector('input') as HTMLInputElement

    input.focus() // real focus, not fireEvent.focus -- see file header
    fireEvent.change(input, { target: { value: '99' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(onChange).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalledWith(99)
    expect(input.value).toBe('5')
  })
})

describe('NumericInput: untouched field commits nothing', () => {
  it('focusing then blurring (tab through) without editing calls onChange zero times', () => {
    const onChange = vi.fn()
    const { container } = render(
      React.createElement(NumericInput, { value: 5, onChange, units: 'mm' }),
    )
    const input = container.querySelector('input') as HTMLInputElement

    input.focus()
    input.blur()

    expect(onChange).not.toHaveBeenCalled()
  })

  it('clicking away from an untouched field (real focus + blur) calls onChange zero times', () => {
    const onChange = vi.fn()
    const { container } = render(
      React.createElement(NumericInput, { value: 12.5, onChange, units: 'inch' }),
    )
    const input = container.querySelector('input') as HTMLInputElement

    input.focus()
    input.blur()

    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('NumericInput: a real edit still commits on blur/Enter (unchanged behavior)', () => {
  it('a changed value commits on blur', () => {
    const onChange = vi.fn()
    const { container } = render(
      React.createElement(NumericInput, { value: 5, onChange, units: 'mm' }),
    )
    const input = container.querySelector('input') as HTMLInputElement

    input.focus()
    fireEvent.change(input, { target: { value: '12.5' } })
    input.blur()

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(12.5)
  })
})

describe('OptionalNumericInput: Escape truly cancels', () => {
  it('typing a new value then pressing Escape never calls onChange', () => {
    const onChange = vi.fn()
    const { container } = render(
      React.createElement(OptionalNumericInput, { value: 5, onChange, units: 'mm' }),
    )
    const input = container.querySelector('input') as HTMLInputElement

    input.focus()
    fireEvent.change(input, { target: { value: '99' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(onChange).not.toHaveBeenCalled()
    expect(input.value).toBe('5')
  })

  it('clearing to blank then pressing Escape never calls onChange', () => {
    const onChange = vi.fn()
    const { container } = render(
      React.createElement(OptionalNumericInput, { value: 5, onChange, units: 'mm' }),
    )
    const input = container.querySelector('input') as HTMLInputElement

    input.focus()
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(onChange).not.toHaveBeenCalled()
    expect(input.value).toBe('5')
  })
})

describe('OptionalNumericInput: untouched field commits nothing', () => {
  it('focusing then blurring without editing calls onChange zero times', () => {
    const onChange = vi.fn()
    const { container } = render(
      React.createElement(OptionalNumericInput, { value: 5, onChange, units: 'mm' }),
    )
    const input = container.querySelector('input') as HTMLInputElement

    input.focus()
    input.blur()

    expect(onChange).not.toHaveBeenCalled()
  })

  it('an already-blank ("auto") field left blank on blur calls onChange zero times', () => {
    const onChange = vi.fn()
    const { container } = render(
      React.createElement(OptionalNumericInput, { value: undefined, onChange, units: 'mm' }),
    )
    const input = container.querySelector('input') as HTMLInputElement

    input.focus()
    input.blur()

    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('OptionalNumericInput: a real edit still commits on blur (unchanged behavior)', () => {
  it('a changed value commits on blur', () => {
    const onChange = vi.fn()
    const { container } = render(
      React.createElement(OptionalNumericInput, { value: 5, onChange, units: 'mm' }),
    )
    const input = container.querySelector('input') as HTMLInputElement

    input.focus()
    fireEvent.change(input, { target: { value: '12.5' } })
    input.blur()

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(12.5)
  })

  it('clearing a set value to blank commits undefined ("auto")', () => {
    const onChange = vi.fn()
    const { container } = render(
      React.createElement(OptionalNumericInput, { value: 5, onChange, units: 'mm' }),
    )
    const input = container.querySelector('input') as HTMLInputElement

    input.focus()
    fireEvent.change(input, { target: { value: '' } })
    input.blur()

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(undefined)
  })
})
