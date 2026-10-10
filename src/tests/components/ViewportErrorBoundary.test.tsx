// @vitest-environment jsdom
//
// React-render gate for ViewportErrorBoundary (VIEW-ERRORBOUNDARY, ADAPTIVE-VIEW-CRASH
// follow-up per docs/planning/POST-MERGE-WORKPLAN.md). tsc + pure-logic vitest miss
// hooks-order/JSX wiring bugs and cannot prove a React error boundary actually contains a
// render-time throw -- this is the real render gate docs/CONVENTIONS.md requires for UI
// changes.
//
// RED->GREEN proof, both in this one file so the "before" behavior is pinned alongside
// the fix instead of only asserted in prose:
//   - "RED: an unguarded view throw" describes (and pins, via the REAL app-level
//     src/components/ErrorBoundary.tsx) the PRE-VIEW-ERRORBOUNDARY behavior this lane
//     found in App.tsx: a render-time throw anywhere under the viewport mount had no
//     boundary of its own, so it propagated all the way to the app-level boundary and
//     wiped the sibling UI (tree/properties stand-ins here) along with it.
//   - "GREEN: ViewportErrorBoundary contains the same throw" proves the fix: the SAME
//     throwing child, now wrapped in the new ViewportErrorBoundary (exactly as App.tsx
//     wires it around <Viewport>), fails loud IN PLACE with the real error message by
//     name (ADR-0003) while the app-level boundary never trips and the sibling UI stays
//     mounted and interactive.
// Retry and resetKey (tab-switch-equivalent) recovery are also pinned below.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { Component } from 'react'
import { ErrorBoundary } from '../../components/ErrorBoundary'
import { ViewportErrorBoundary } from '../../components/viewport/ViewportErrorBoundary'

afterEach(cleanup)

/** Throws exactly once per mount (React's own StrictMode/error-boundary double-invoke of
 *  a throwing render is a single logical "this render attempt failed", not two separate
 *  failures) with a NAMED, distinctive message -- ADR-0003 proof that the boundary
 *  surfaces the real reason, not a generic string. */
class ThrowsOnRender extends Component<{ message: string }> {
  render(): never {
    throw new Error(this.props.message)
  }
}

/** Throws only while `armed.current` is true -- lets a single instance flip from
 *  failing to healthy across a boundary retry/reset, proving the boundary actually
 *  re-renders (not just permanently swallows) its children. */
function makeArmedThrower() {
  const armed = { current: true }
  function ArmedThrower() {
    if (armed.current) throw new Error('SYNTHETIC-VIEW-RENDER-THROW: armed thrower tripped')
    return <div data-testid="armed-thrower-ok">view is fine now</div>
  }
  return { armed, ArmedThrower }
}

describe('RED: an unguarded view throw (pre-VIEW-ERRORBOUNDARY behavior, pinned)', () => {
  it('propagates to the app-level boundary and wipes sibling UI with it', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <ErrorBoundary>
        <div data-testid="sibling-tree">Design tree</div>
        {/* No ViewportErrorBoundary here -- this is the pre-fix wiring App.tsx had
            around <Viewport> before this lane's change. */}
        <ThrowsOnRender message="SYNTHETIC-VIEW-RENDER-THROW: red-proof unguarded throw" />
        <div data-testid="sibling-properties">Properties panel</div>
      </ErrorBoundary>,
    )

    // The APP-LEVEL fallback trips (its own copy, softened by this lane but still the
    // same component) -- proving an unguarded view throw escapes all the way up.
    expect(screen.getByText('LienCAM encountered an error')).not.toBeNull()
    // ...and takes the siblings down with it: nothing else in the tree survives.
    expect(screen.queryByTestId('sibling-tree')).toBeNull()
    expect(screen.queryByTestId('sibling-properties')).toBeNull()

    consoleSpy.mockRestore()
  })
})

describe('GREEN: ViewportErrorBoundary contains the same throw in place', () => {
  it('shows the named in-panel error and keeps the app-level boundary untripped + siblings alive', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <ErrorBoundary>
        <div data-testid="sibling-tree">Design tree</div>
        <ViewportErrorBoundary>
          <ThrowsOnRender message="SYNTHETIC-VIEW-RENDER-THROW: green-proof contained throw" />
        </ViewportErrorBoundary>
        <div data-testid="sibling-properties">Properties panel</div>
      </ErrorBoundary>,
    )

    // Contained: the view-level fallback shows, named by the real error message.
    const boundary = screen.getByTestId('viewport-error-boundary')
    expect(boundary).not.toBeNull()
    expect(boundary.getAttribute('role')).toBe('alert')
    expect(screen.getByTestId('viewport-error-boundary-message').textContent).toBe(
      'SYNTHETIC-VIEW-RENDER-THROW: green-proof contained throw',
    )

    // The app-level boundary never trips.
    expect(screen.queryByText('LienCAM encountered an error')).toBeNull()

    // The rest of the app shell (tree/properties stand-ins) stays fully alive.
    expect(screen.getByTestId('sibling-tree')).not.toBeNull()
    expect(screen.getByTestId('sibling-properties')).not.toBeNull()

    consoleSpy.mockRestore()
  })

  it('never falls back to a generic message when the error has one (ADR-0003)', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <ViewportErrorBoundary>
        <ThrowsOnRender message="expected a finite positive feed, received undefined" />
      </ViewportErrorBoundary>,
    )
    const text = screen.getByTestId('viewport-error-boundary-message').textContent ?? ''
    expect(text).toContain('expected a finite positive feed, received undefined')
    expect(text.toLowerCase()).not.toBe('something went wrong')
    consoleSpy.mockRestore()
  })
})

describe('Retry: the user can retry the SAME view without a reload', () => {
  it('clicking "Retry this view" clears the error and re-renders children fresh', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { armed, ArmedThrower } = makeArmedThrower()

    render(
      <ViewportErrorBoundary>
        <ArmedThrower />
      </ViewportErrorBoundary>,
    )
    expect(screen.getByTestId('viewport-error-boundary')).not.toBeNull()

    // Disarm the thrower (simulating the transient condition clearing, e.g. the
    // frame-build state that caused the throw is no longer present) then retry.
    armed.current = false
    fireEvent.click(screen.getByTestId('viewport-error-boundary-retry'))

    expect(screen.queryByTestId('viewport-error-boundary')).toBeNull()
    expect(screen.getByTestId('armed-thrower-ok')).not.toBeNull()

    consoleSpy.mockRestore()
  })
})

describe('Leave without reload: changing resetKey auto-retries (tab-switch equivalent)', () => {
  it('a resetKey change clears a caught error even without clicking Retry', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { armed, ArmedThrower } = makeArmedThrower()

    const { rerender } = render(
      <ViewportErrorBoundary resetKey="toolpath">
        <ArmedThrower />
      </ViewportErrorBoundary>,
    )
    expect(screen.getByTestId('viewport-error-boundary')).not.toBeNull()

    // The view is still broken -- a resetKey change alone (e.g. the user switched to a
    // different mode tab) must not silently pretend to have fixed it if it hasn't.
    rerender(
      <ViewportErrorBoundary resetKey="setup">
        <ArmedThrower />
      </ViewportErrorBoundary>,
    )
    expect(screen.getByTestId('viewport-error-boundary')).not.toBeNull()

    // Now the underlying condition clears (as it would on a genuinely different view) and
    // the SAME resetKey change lets the user back in without a retry click or reload.
    armed.current = false
    rerender(
      <ViewportErrorBoundary resetKey="simulation">
        <ArmedThrower />
      </ViewportErrorBoundary>,
    )
    expect(screen.queryByTestId('viewport-error-boundary')).toBeNull()
    expect(screen.getByTestId('armed-thrower-ok')).not.toBeNull()

    consoleSpy.mockRestore()
  })
})
