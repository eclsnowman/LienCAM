// @vitest-environment jsdom
//
// React-render SMOKE test for BottomConsole (WO UI-11A acceptance #3): mounts
// the real component against the real consoleEvents store slice (seeded via
// the real addConsoleEvent action, not fixtures) and drives the collapsed ->
// expanded -> filter -> entityRef-click path a user actually takes.
// Harness copied from DesignTreeAutoStock.smoke.test.tsx (localStorage shim +
// store reset pattern).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'

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

const { BottomConsole } = await import('../../components/panels/BottomConsole')
const { useCamStore } = await import('../../store')

afterEach(cleanup)

beforeEach(() => {
  act(() => {
    useCamStore.setState({ consoleEvents: [], consoleReadThroughId: 0 })
  })
})

describe('BottomConsole render smoke test', () => {
  it('mounts without throwing or a hooks-order violation', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() => render(<BottomConsole />)).not.toThrow()
      const hooksOrderCalls = errorSpy.mock.calls.filter(([msg]) =>
        typeof msg === 'string' && /hooks|hook order|Rendered (more|fewer) hooks/i.test(msg),
      )
      expect(hooksOrderCalls).toEqual([])
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('collapsed strip shows only the latest event', () => {
    act(() => {
      useCamStore.getState().addConsoleEvent({ severity: 'info', source: 'app', message: 'first event' })
      useCamStore.getState().addConsoleEvent({ severity: 'success', source: 'batch', message: 'latest event' })
    })
    render(<BottomConsole />)
    const strip = screen.getByTestId('console-strip')
    expect(strip.textContent).toContain('latest event')
    expect(strip.textContent).not.toContain('first event')
    // Not expanded: the timeline is not in the DOM at all.
    expect(screen.queryByTestId('console-timeline')).toBeNull()
  })

  it('shows an empty-state strip with no events', () => {
    render(<BottomConsole />)
    expect(screen.getByTestId('console-strip').textContent).toMatch(/no events/i)
  })

  it('expanding reveals the scrollable timeline with every event', () => {
    act(() => {
      useCamStore.getState().addConsoleEvent({ severity: 'info', source: 'app', message: 'alpha' })
      useCamStore.getState().addConsoleEvent({ severity: 'warning', source: 'sketch', message: 'beta' })
    })
    render(<BottomConsole />)
    fireEvent.click(screen.getByTestId('console-strip'))
    const timeline = screen.getByTestId('console-timeline')
    expect(timeline.textContent).toContain('alpha')
    expect(timeline.textContent).toContain('beta')
  })

  it('the severity filter hides non-matching events', () => {
    act(() => {
      useCamStore.getState().addConsoleEvent({ severity: 'info', source: 'app', message: 'info-msg' })
      useCamStore.getState().addConsoleEvent({ severity: 'error', source: 'batch', message: 'error-msg' })
    })
    render(<BottomConsole />)
    fireEvent.click(screen.getByTestId('console-strip'))
    fireEvent.click(screen.getByTestId('console-filter-error'))

    const timeline = screen.getByTestId('console-timeline')
    expect(timeline.textContent).toContain('error-msg')
    expect(timeline.textContent).not.toContain('info-msg')
  })

  it('clear empties the timeline', () => {
    act(() => {
      useCamStore.getState().addConsoleEvent({ severity: 'info', source: 'app', message: 'to-clear' })
    })
    render(<BottomConsole />)
    fireEvent.click(screen.getByTestId('console-strip'))
    expect(screen.getByTestId('console-timeline').textContent).toContain('to-clear')

    fireEvent.click(screen.getByText('Clear'))
    expect(useCamStore.getState().consoleEvents).toEqual([])
    expect(screen.getByTestId('console-timeline').textContent).toMatch(/no events/i)
  })

  it('entityRef click dispatches the selection action (spy)', () => {
    const originalSetActiveOperation = useCamStore.getState().setActiveOperation
    const spy = vi.fn()
    act(() => { useCamStore.setState({ setActiveOperation: spy }) })

    let eventId = -1
    act(() => {
      useCamStore.getState().addConsoleEvent({
        severity: 'warning', source: 'app', message: 'linked event',
        entityRef: { kind: 'op', id: 'op-99' },
      })
      eventId = useCamStore.getState().consoleEvents[0].id
    })

    try {
      render(<BottomConsole />)
      fireEvent.click(screen.getByTestId('console-strip'))
      fireEvent.click(screen.getByTestId(`console-event-${eventId}`))
      expect(spy).toHaveBeenCalledWith('op-99')
    } finally {
      act(() => { useCamStore.setState({ setActiveOperation: originalSetActiveOperation }) })
    }
  })

  // BK-80: entityRef click dispatch must handle EVERY kind in the union — a
  // per-kind test each, so removing a branch fails its own test (not just
  // silently falling through). 'geometry' twins the 'op' test above;
  // 'setup' is the kind that previously reached the timeline (BottomConsole
  // already typed it) but had NO click branch — a silent no-op (BK-80).
  it('entityRef kind "geometry" dispatches setSelectedGeometry (spy)', () => {
    const original = useCamStore.getState().setSelectedGeometry
    const spy = vi.fn()
    act(() => { useCamStore.setState({ setSelectedGeometry: spy }) })

    let eventId = -1
    act(() => {
      useCamStore.getState().addConsoleEvent({
        severity: 'success', source: 'import', message: 'geo linked',
        entityRef: { kind: 'geometry', id: 'geo-99' },
      })
      eventId = useCamStore.getState().consoleEvents[0].id
    })

    try {
      render(<BottomConsole />)
      fireEvent.click(screen.getByTestId('console-strip'))
      fireEvent.click(screen.getByTestId(`console-event-${eventId}`))
      expect(spy).toHaveBeenCalledWith('geo-99')
    } finally {
      act(() => { useCamStore.setState({ setSelectedGeometry: original }) })
    }
  })

  it('entityRef kind "setup" dispatches setActiveSetup + clears geometry selection, like DesignTree (spy)', () => {
    const originalSetActiveSetup = useCamStore.getState().setActiveSetup
    const originalSetSelectedGeometry = useCamStore.getState().setSelectedGeometry
    const setupSpy = vi.fn()
    const geoSpy = vi.fn()
    act(() => { useCamStore.setState({ setActiveSetup: setupSpy, setSelectedGeometry: geoSpy }) })

    let eventId = -1
    act(() => {
      useCamStore.getState().addConsoleEvent({
        severity: 'info', source: 'nest', message: 'setup linked',
        entityRef: { kind: 'setup', id: 'setup-99' },
      })
      eventId = useCamStore.getState().consoleEvents[0].id
    })

    try {
      render(<BottomConsole />)
      fireEvent.click(screen.getByTestId('console-strip'))
      fireEvent.click(screen.getByTestId(`console-event-${eventId}`))
      // BK-80 was a silent no-op here before this WO — this assertion is the
      // regression gate.
      expect(setupSpy).toHaveBeenCalledWith('setup-99')
      expect(geoSpy).toHaveBeenCalledWith(null)
    } finally {
      act(() => {
        useCamStore.setState({ setActiveSetup: originalSetActiveSetup, setSelectedGeometry: originalSetSelectedGeometry })
      })
    }
  })

  it('markConsoleRead runs on expand (unread-error badge reflects it)', () => {
    act(() => {
      useCamStore.getState().addConsoleEvent({ severity: 'error', source: 'app', message: 'oops' })
    })
    render(<BottomConsole />)
    expect(screen.getByTestId('console-unread-badge').textContent).toBe('1')

    fireEvent.click(screen.getByTestId('console-strip'))
    expect(screen.queryByTestId('console-unread-badge')).toBeNull()
  })
})
