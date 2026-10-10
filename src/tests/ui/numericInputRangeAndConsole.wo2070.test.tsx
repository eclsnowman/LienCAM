// @vitest-environment jsdom
//
// WO-2070: a number field with a min/max shows its allowed range in its hover
// text (COHESION-STANDARD.md section 24), and a commit that clamps what the
// operator typed writes exactly one plain line to the console. Everything
// else about NumericInput/OptionalNumericInput is unchanged: no red outline,
// no banner, no dialog, no refused keystroke, an in-range commit stays
// silent, and a non-number draft still reverts with no console event.
//
// Exercised through the REAL commit path (render, type via fireEvent.change,
// commit via a real .focus()/.blur() or Enter) and the REAL store's
// addConsoleEvent (no mock) -- section 24's own example strings are asserted
// verbatim so a wording regression fails this file, not just a shape check.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import * as React from 'react'
import { NumericInput, OptionalNumericInput } from '../../components/ui/NumericInput'
import { useCamStore } from '../../store'

beforeEach(() => {
  useCamStore.setState({ consoleEvents: [], consoleReadThroughId: 0 })
})
afterEach(cleanup)

describe('NumericInput: hover text shows the range (section 24)', () => {
  it('both limits, after the caller-given tooltip', () => {
    const { container } = render(
      React.createElement(NumericInput, {
        value: 5, onChange: vi.fn(), min: 0.1, max: 50, tooltip: 'Probing depth', units: 'mm',
      }),
    )
    const input = container.querySelector('input') as HTMLInputElement
    expect(input.getAttribute('data-tooltip')).toBe('Probing depth: 0.1 to 50 mm')
  })

  it('one limit only ("at least")', () => {
    const { container } = render(
      React.createElement(NumericInput, {
        value: 5, onChange: vi.fn(), min: 0.1, tooltip: 'Probing depth', units: 'mm',
      }),
    )
    const input = container.querySelector('input') as HTMLInputElement
    expect(input.getAttribute('data-tooltip')).toBe('Probing depth: at least 0.1 mm')
  })

  it('one limit only ("at most")', () => {
    const { container } = render(
      React.createElement(NumericInput, {
        value: 5, onChange: vi.fn(), max: 50, tooltip: 'Probing depth', units: 'mm',
      }),
    )
    const input = container.querySelector('input') as HTMLInputElement
    expect(input.getAttribute('data-tooltip')).toBe('Probing depth: at most 50 mm')
  })

  it('no caller tooltip: the range stands alone', () => {
    const { container } = render(
      React.createElement(NumericInput, { value: 5, onChange: vi.fn(), min: 0.1, max: 50, units: 'mm' }),
    )
    const input = container.querySelector('input') as HTMLInputElement
    expect(input.getAttribute('data-tooltip')).toBe('0.1 to 50 mm')
  })

  it('no min/max: the caller tooltip is untouched', () => {
    const { container } = render(
      React.createElement(NumericInput, { value: 5, onChange: vi.fn(), tooltip: 'Feed rate', units: 'mm' }),
    )
    const input = container.querySelector('input') as HTMLInputElement
    expect(input.getAttribute('data-tooltip')).toBe('Feed rate')
  })

  it('no min/max and no tooltip: no hover text at all', () => {
    const { container } = render(
      React.createElement(NumericInput, { value: 5, onChange: vi.fn() }),
    )
    const input = container.querySelector('input') as HTMLInputElement
    expect(input.hasAttribute('data-tooltip')).toBe(false)
  })

  it('range follows the displayed unit (inch)', () => {
    const { container } = render(
      React.createElement(NumericInput, {
        value: 12.7, onChange: vi.fn(), min: 0, max: 25.4, tooltip: 'Width', units: 'inch',
      }),
    )
    const input = container.querySelector('input') as HTMLInputElement
    expect(input.getAttribute('data-tooltip')).toBe('Width: 0 to 1 in')
  })

  it('a feed field labels its range mm/min (or in/min)', () => {
    const { container } = render(
      React.createElement(NumericInput, {
        value: 500, onChange: vi.fn(), min: 100, max: 1000, tooltip: 'Plunge feed', units: 'mm', kind: 'feed',
      }),
    )
    const input = container.querySelector('input') as HTMLInputElement
    expect(input.getAttribute('data-tooltip')).toBe('Plunge feed: 100 to 1000 mm/min')
  })

  // WO-2070 attempt 1's audit finding: a caller that never passes `units` is
  // not necessarily a millimeter length -- e.g. SketchToolbox's polygon side
  // count (`<NumericInput min={3} .../>`, no units) and pattern instance
  // count (`min={2}`, no units) are plain unitless counts. Before that fix
  // they advertised "at least 3 mm" / "at least 2 mm".
  it('a field with no units prop shows its range with no unit word', () => {
    const { container } = render(
      React.createElement(NumericInput, { value: 6, onChange: vi.fn(), min: 3, tooltip: 'Sides' }),
    )
    const input = container.querySelector('input') as HTMLInputElement
    expect(input.getAttribute('data-tooltip')).toBe('Sides: at least 3')
  })

  it('a field with no units prop and both limits shows no unit word', () => {
    const { container } = render(
      React.createElement(NumericInput, { value: 6, onChange: vi.fn(), min: 3, max: 12, tooltip: 'Sides' }),
    )
    const input = container.querySelector('input') as HTMLInputElement
    expect(input.getAttribute('data-tooltip')).toBe('Sides: 3 to 12')
  })
})

describe('NumericInput: a clamped commit logs exactly one console line (section 24)', () => {
  it('below min: "-3 is below 0.1 mm - set to 0.1 mm"', () => {
    const onChange = vi.fn()
    const { container } = render(
      React.createElement(NumericInput, {
        value: 5, onChange, min: 0.1, max: 50, tooltip: 'Probing depth', units: 'mm',
      }),
    )
    const input = container.querySelector('input') as HTMLInputElement

    input.focus()
    fireEvent.change(input, { target: { value: '-3' } })
    input.blur()

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(0.1)

    const events = useCamStore.getState().consoleEvents
    expect(events.length).toBe(1)
    expect(events[0].severity).toBe('warning')
    expect(events[0].message).toBe('Probing depth: -3 is below 0.1 mm - set to 0.1 mm')
  })

  it('above max: "999 is above 50 mm - set to 50 mm"', () => {
    const onChange = vi.fn()
    const { container } = render(
      React.createElement(NumericInput, {
        value: 5, onChange, min: 0.1, max: 50, tooltip: 'Probing depth', units: 'mm',
      }),
    )
    const input = container.querySelector('input') as HTMLInputElement

    input.focus()
    fireEvent.change(input, { target: { value: '999' } })
    input.blur()

    expect(onChange).toHaveBeenCalledWith(50)
    const events = useCamStore.getState().consoleEvents
    expect(events.length).toBe(1)
    expect(events[0].message).toBe('Probing depth: 999 is above 50 mm - set to 50 mm')
  })

  // Audit finding (attempt 3): min===max collapses the range to one number,
  // so a classifier that reads direction off `result.value === min` can't
  // tell above from below (both limits are the same value). Machine Library
  // reaches this: an axis maxCutting of exactly 1 makes a feedrate field's
  // min={1}, max={maxXY} collapse the same way.
  it('collapsed range (min === max): an above-max commit still says "above"', () => {
    const onChange = vi.fn()
    const { container } = render(
      React.createElement(NumericInput, {
        value: 1, onChange, min: 1, max: 1, tooltip: 'Feed rate', units: 'mm',
      }),
    )
    const input = container.querySelector('input') as HTMLInputElement

    input.focus()
    fireEvent.change(input, { target: { value: '2' } })
    input.blur()

    // onChange is not asserted here: the field's own value prop is already 1
    // (the only value a collapsed min=max=1 range can hold), so the resolved
    // (clamped) value never differs from it at display precision -- see
    // commit()'s own "untouched field" guard. The notice fires independently
    // of that guard because a real clamp happened (typed 2, canonical != 1).
    const events = useCamStore.getState().consoleEvents
    expect(events.length).toBe(1)
    expect(events[0].message).toBe('Feed rate: 2 is above 1 mm - set to 1 mm')
  })

  it('collapsed range (min === max): a below-min commit still says "below"', () => {
    const onChange = vi.fn()
    const { container } = render(
      React.createElement(NumericInput, {
        value: 1, onChange, min: 1, max: 1, tooltip: 'Feed rate', units: 'mm',
      }),
    )
    const input = container.querySelector('input') as HTMLInputElement

    input.focus()
    fireEvent.change(input, { target: { value: '0.5' } })
    input.blur()

    const events = useCamStore.getState().consoleEvents
    expect(events.length).toBe(1)
    expect(events[0].message).toBe('Feed rate: 0.5 is below 1 mm - set to 1 mm')
  })

  it('an in-range commit logs nothing', () => {
    const onChange = vi.fn()
    const { container } = render(
      React.createElement(NumericInput, {
        value: 5, onChange, min: 0.1, max: 50, tooltip: 'Probing depth', units: 'mm',
      }),
    )
    const input = container.querySelector('input') as HTMLInputElement

    input.focus()
    fireEvent.change(input, { target: { value: '10' } })
    input.blur()

    expect(onChange).toHaveBeenCalledWith(10)
    expect(useCamStore.getState().consoleEvents.length).toBe(0)
  })

  it('a value exactly at a limit (no clamp) logs nothing', () => {
    const onChange = vi.fn()
    const { container } = render(
      React.createElement(NumericInput, {
        value: 5, onChange, min: 0.1, max: 50, tooltip: 'Probing depth', units: 'mm',
      }),
    )
    const input = container.querySelector('input') as HTMLInputElement

    input.focus()
    fireEvent.change(input, { target: { value: '0.1' } })
    input.blur()

    expect(onChange).toHaveBeenCalledWith(0.1)
    expect(useCamStore.getState().consoleEvents.length).toBe(0)
  })

  it('a non-number draft reverts silently: no onChange, no console event', () => {
    const onChange = vi.fn()
    const { container } = render(
      React.createElement(NumericInput, {
        value: 5, onChange, min: 0.1, max: 50, tooltip: 'Probing depth', units: 'mm',
      }),
    )
    const input = container.querySelector('input') as HTMLInputElement

    input.focus()
    fireEvent.change(input, { target: { value: 'abc' } })
    // fireEvent.blur (not a raw .blur()): this assertion checks the DOM's
    // reverted display, which needs React's setLocalStr to have flushed --
    // fireEvent wraps in act() so it has by the time this returns.
    fireEvent.blur(input)

    expect(onChange).not.toHaveBeenCalled()
    expect(input.value).toBe('5')
    expect(useCamStore.getState().consoleEvents.length).toBe(0)
  })

  it('Enter (which also fires a synchronous native blur) still logs exactly once', () => {
    const onChange = vi.fn()
    const { container } = render(
      React.createElement(NumericInput, {
        value: 5, onChange, min: 0.1, max: 50, tooltip: 'Probing depth', units: 'mm',
      }),
    )
    const input = container.querySelector('input') as HTMLInputElement

    input.focus()
    fireEvent.change(input, { target: { value: '-3' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(useCamStore.getState().consoleEvents.length).toBe(1)
  })

  it('names the field by ariaLabel when there is no tooltip', () => {
    const onChange = vi.fn()
    const { container } = render(
      React.createElement(NumericInput, {
        value: 5, onChange, min: 1, max: 100, ariaLabel: 'Feed rate', units: 'mm',
      }),
    )
    const input = container.querySelector('input') as HTMLInputElement

    input.focus()
    fireEvent.change(input, { target: { value: '0' } })
    input.blur()

    const events = useCamStore.getState().consoleEvents
    expect(events.length).toBe(1)
    expect(events[0].message).toBe('Feed rate: 0 is below 1 mm - set to 1 mm')
  })

  // WO-2070 requeue direction (2): when neither ariaLabel nor tooltip is
  // given, the notice reads the visible label already on screen instead of
  // falling straight to "Value" -- here, SketchToolbox's real shape: the
  // NumericInput sits inside a <label> that wraps a separate <span> naming
  // the field (an implicit native label association, not a `for`/`id` pair).
  it('names the field from a wrapping <label> when neither prop is given', () => {
    const onChange = vi.fn()
    const { container } = render(
      React.createElement(
        'label', null,
        React.createElement('span', null, 'Sides'),
        React.createElement(NumericInput, { value: 6, onChange, min: 3 }),
      ),
    )
    const input = container.querySelector('input') as HTMLInputElement

    input.focus()
    fireEvent.change(input, { target: { value: '1' } })
    input.blur()

    const events = useCamStore.getState().consoleEvents
    expect(events.length).toBe(1)
    expect(events[0].message).toBe('Sides: 1 is below 3 - set to 3')
  })

  // PropertiesPanel's real shape: no <label> element at all -- a sibling
  // ".props-label" div in the same row names the field next to a
  // ".props-value" div that holds the (otherwise unlabelled) input.
  it('names the field from a sibling row-label element when neither prop is given', () => {
    const onChange = vi.fn()
    const { container } = render(
      React.createElement(
        'div', { className: 'props-group' },
        React.createElement('div', { className: 'props-label' }, 'Sheet margin'),
        React.createElement(
          'div', { className: 'props-value' },
          React.createElement(NumericInput, { value: 5, onChange, min: 1, max: 100, units: 'mm' }),
        ),
      ),
    )
    const input = container.querySelector('input') as HTMLInputElement

    input.focus()
    fireEvent.change(input, { target: { value: '200' } })
    input.blur()

    const events = useCamStore.getState().consoleEvents
    expect(events.length).toBe(1)
    expect(events[0].message).toBe('Sheet margin: 200 is above 100 mm - set to 100 mm')
  })

  // WO-2070 attempt 1's audit finding, on the clamp-notice path -- a polygon
  // side count clamped without a caller-given name previously logged
  // "Value: 1 is below 3 mm - set to 3 mm". No `units` prop -> no unit word.
  it('a field with no units prop logs its clamp notice with no unit word', () => {
    const onChange = vi.fn()
    const { container } = render(
      React.createElement(NumericInput, { value: 6, onChange, min: 3 }),
    )
    const input = container.querySelector('input') as HTMLInputElement

    input.focus()
    fireEvent.change(input, { target: { value: '1' } })
    input.blur()

    expect(onChange).toHaveBeenCalledWith(3)
    const events = useCamStore.getState().consoleEvents
    expect(events.length).toBe(1)
    expect(events[0].message).toBe('Value: 1 is below 3 - set to 3')
  })

  it('a feed field in inch reports the typed and set values in inch, unconverted twice', () => {
    const onChange = vi.fn()
    // min = 25.4 mm/min = 1 in/min (canonical stays mm/min; display is inch).
    const { container } = render(
      React.createElement(NumericInput, {
        value: 50.8, onChange, min: 25.4, tooltip: 'Plunge feed', units: 'inch', kind: 'feed',
      }),
    )
    const input = container.querySelector('input') as HTMLInputElement

    input.focus()
    fireEvent.change(input, { target: { value: '0.5' } })
    input.blur()

    const events = useCamStore.getState().consoleEvents
    expect(events.length).toBe(1)
    expect(events[0].message).toBe('Plunge feed: 0.5 is below 1 in/min - set to 1 in/min')
  })

  // WO-2070 attempt 2's substantiated audit finding: min=0.1 mm displays as
  // "0.0039" in inch (4 decimals). Typing that exact displayed string
  // round-trips to a canonical value (0.0039 * 25.4 = 0.09906 mm) that is
  // genuinely below the 0.1 mm floor, so it still clamps and onChange still
  // fires -- but the typed and set values render IDENTICALLY ("0.0039"), so
  // a notice claiming one was "below" the other would read as
  // self-contradictory to the operator. No console event, even though a
  // clamp (and an onChange) did happen.
  it('typing the field\'s own displayed limit (in a lower-resolution unit) logs nothing', () => {
    const onChange = vi.fn()
    const { container } = render(
      React.createElement(NumericInput, {
        value: 5, onChange, min: 0.1, tooltip: 'Overshoot', units: 'inch',
      }),
    )
    const input = container.querySelector('input') as HTMLInputElement

    input.focus()
    fireEvent.change(input, { target: { value: '0.0039' } })
    input.blur()

    expect(onChange).toHaveBeenCalledWith(0.1)
    expect(useCamStore.getState().consoleEvents.length).toBe(0)
  })
})

describe('OptionalNumericInput: range hover text and clamp console line', () => {
  it('shows its range the same way NumericInput does', () => {
    const { container } = render(
      React.createElement(OptionalNumericInput, {
        value: 5, onChange: vi.fn(), min: 0.1, max: 50, tooltip: 'Overshoot', units: 'mm',
      }),
    )
    const input = container.querySelector('input') as HTMLInputElement
    expect(input.getAttribute('data-tooltip')).toBe('Overshoot: 0.1 to 50 mm')
  })

  it('a clamped commit logs one console line', () => {
    const onChange = vi.fn()
    const { container } = render(
      React.createElement(OptionalNumericInput, {
        value: 5, onChange, min: 0.1, max: 50, tooltip: 'Overshoot', units: 'mm',
      }),
    )
    const input = container.querySelector('input') as HTMLInputElement

    input.focus()
    fireEvent.change(input, { target: { value: '-3' } })
    input.blur()

    expect(onChange).toHaveBeenCalledWith(0.1)
    const events = useCamStore.getState().consoleEvents
    expect(events.length).toBe(1)
    expect(events[0].message).toBe('Overshoot: -3 is below 0.1 mm - set to 0.1 mm')
  })

  it('clearing to blank ("auto") logs nothing', () => {
    const onChange = vi.fn()
    const { container } = render(
      React.createElement(OptionalNumericInput, {
        value: 5, onChange, min: 0.1, max: 50, tooltip: 'Overshoot', units: 'mm',
      }),
    )
    const input = container.querySelector('input') as HTMLInputElement

    input.focus()
    fireEvent.change(input, { target: { value: '' } })
    input.blur()

    expect(onChange).toHaveBeenCalledWith(undefined)
    expect(useCamStore.getState().consoleEvents.length).toBe(0)
  })
})
