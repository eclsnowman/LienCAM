// @vitest-environment jsdom
//
// WO-287: the override percent field obeys the shared numeric-entry contract
// (src/components/ui/selectAllOnClick.ts) - click selects the WHOLE value so it
// can be typed over. It was a raw type="number" input calling select() on
// focus, which the HTML spec makes a no-op, so the operator had to clear the
// field by hand on the one panel touched while the machine is cutting.
//
// These tests also pin the behaviour that must NOT change with the entry fix:
// the 10-200 clamp, Enter-commits / Escape-restores, and the disabled state.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ConnectionPhase,
  LoadOutcome,
  MachineController,
  MachineState,
  MachineStatus,
  StreamerProgress,
} from '../../lib/machine/controller'
import { typedMock } from '../support/typedMock'

// WO-422: the panel speaks the controller-neutral override vocabulary now,
// not GRBL realtime bytes, so this mock records OverrideChange values. What
// each change becomes on the wire is pinned separately, against the real
// backend, in grblControllerContract.wo418.test.ts.
const setOverride = vi.fn()

/** A full MachineController stub - OverridePanel only ever calls
 *  `setOverride`, but the module's real `getMachineController` returns a
 *  genuine `MachineController`, so the mock has to be one too rather than the
 *  single-method shape a bare object literal used to get away with. */
function stubMachineController(): MachineController {
  const status: MachineStatus = {
    state: 'idle', subState: null, machinePos: null, workPos: null,
    feedMmMin: null, spindleRpm: null, overrides: null, executingMoveId: null,
    buffer: null, inputs: null, homed: null, spindle: null,
  }
  const jobProgress: StreamerProgress = {
    phase: 'empty', totalLines: 0, sentLines: 0, ackedLines: 0,
    ackedSourceLine: 0, sentSourceLine: 0, bytesInFlight: 0,
  }
  return {
    capabilities: {
      geometryQueue: false, executingMoveId: false, bufferSeconds: false,
      gcodeText: true, perAxisHoming: false,
      ownsSpindle: false, spindleCommands: false,
    },
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    connectionPhase: vi.fn((): ConnectionPhase => 'connected'),
    firmwareVersion: vi.fn(() => null),
    machineState: vi.fn((): MachineState => 'idle'),
    status: vi.fn(() => status),
    queryStatus: vi.fn(),
    refreshState: vi.fn(() => true),
    querySettings: vi.fn(() => true),
    verifiedIdle: vi.fn(() => true),
    homedThisSession: vi.fn(() => true),
    resetInProgress: vi.fn(() => false),
    subscribeResetInProgress: vi.fn(() => () => {}),
    jog: vi.fn(() => true),
    jogToWorkXY: vi.fn(() => true),
    jogToMachineZ: vi.fn(() => true),
    jogCancel: vi.fn(),
    home: vi.fn(() => true),
    feedHold: vi.fn(),
    cycleResume: vi.fn(() => true),
    reset: vi.fn(),
    unlock: vi.fn(() => true),
    emergencyStop: vi.fn(),
    resetToIdle: vi.fn(async () => ({ ok: true, reason: null })),
    setOverride,
    selectWcs: vi.fn(() => true),
    zeroWorkAxis: vi.fn(() => true),
    probe: vi.fn(async () => ({ ok: true, at: null })),
    sendCommand: vi.fn(() => true),
    sendCommandAwait: vi.fn(() => null),
    loadJob: vi.fn((): LoadOutcome => ({ ok: false, reason: 'stub controller' })),
    loadJobFrom: vi.fn((): LoadOutcome => ({ ok: false, reason: 'stub controller' })),
    startJob: vi.fn(() => true),
    pauseJob: vi.fn(),
    resumeJob: vi.fn(() => true),
    stopJob: vi.fn(),
    stepJob: vi.fn(() => true),
    setSingleBlockMode: vi.fn(),
    singleBlockMode: vi.fn(() => false),
    hasActiveJob: vi.fn(() => false),
    jobProgress: vi.fn(() => jobProgress),
    stoppedJobProgress: vi.fn(() => null),
  }
}

vi.mock('../../lib/machine/machineSession', () => typedMock<typeof import('../../lib/machine/machineSession')>({
  getMachineController: () => stubMachineController(),
  // WO-2669: the panel reads the session's Rapid note; this GRBL stub owns its own rapid override.
  appRapidOverrideNote: () => null,
}))

/** One short token per override the panel sent, in order: 'feed:reset',
 *  'feed:+10', 'spindle:-1', 'rapid:25%' ... */
function sent(): string[] {
  return setOverride.mock.calls.map(([change]) => {
    if (change.to === 'reset') return `${change.kind}:reset`
    if (change.to === 'percent') return `${change.kind}:${change.percent}%`
    return `${change.kind}:${change.direction > 0 ? '+' : '-'}${change.coarse ? 10 : 1}`
  })
}

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (key: string) => mem.get(key) ?? null,
  key: (index: number) => Array.from(mem.keys())[index] ?? null,
  removeItem: (key: string) => { mem.delete(key) },
  setItem: (key: string, value: string) => { mem.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { OverridePanel } = await import('../../components/machine/OverridePanel')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useUiPrefs } = await import('../../store/uiPrefs')

function field(name: 'Feed' | 'Spindle') {
  return screen.getByTestId(`control-ovr-${name.toLowerCase()}`) as HTMLInputElement
}

/** The click the contract is about: focus, then the mouseUp that a real browser
 *  would use to collapse the selection to a caret at the click point. */
function clickInto(input: HTMLInputElement) {
  input.focus()
  fireEvent.mouseDown(input)
  fireEvent.mouseUp(input)
}

/**
 * Type `text` the way a browser does: whatever is selected is REPLACED. The new
 * value is derived from the input's live selection, never hardcoded - so if the
 * click left a caret instead of a selection (the type="number" bug) this
 * produces the appended string and the assertion fails.
 */
function typeOver(input: HTMLInputElement, text: string) {
  const start = input.selectionStart ?? input.value.length
  const end = input.selectionEnd ?? input.value.length
  const next = input.value.slice(0, start) + text + input.value.slice(end)
  fireEvent.change(input, { target: { value: next } })
}

beforeEach(() => {
  setOverride.mockClear()
  useUiPrefs.setState({ collapsedPropsGroups: {} })
  useMachineControl.setState({
    connectionPhase: 'connected',
    overrides: { feed: 100, rapid: 100, spindle: 100 },
    consoleLines: [],
  })
})

afterEach(cleanup)

describe('WO-287 override percent field uses the shared numeric-entry contract', () => {
  it('is a text input with a numeric keypad, not type="number"', () => {
    render(<OverridePanel />)

    // The selection APIs are a spec no-op on type="number" - that is precisely
    // why the canonical contract requires type="text".
    expect(field('Feed').type).toBe('text')
    expect(field('Feed').getAttribute('inputmode')).toBe('numeric')
  })

  it('selects the whole value when the field is clicked', () => {
    render(<OverridePanel />)
    const feed = field('Feed')

    clickInto(feed)

    expect(feed.value).toBe('100')
    expect(feed.selectionStart).toBe(0)
    expect(feed.selectionEnd).toBe(3)
  })

  it('replaces the value when the user types after a click instead of appending', () => {
    render(<OverridePanel />)
    const feed = field('Feed')

    clickInto(feed)
    typeOver(feed, '120')

    expect(feed.value).toBe('120')
    expect(feed.value).not.toBe('100120')
  })

  it('sends only the typed-over value on Enter, not the appended one', () => {
    render(<OverridePanel />)
    const feed = field('Feed')

    clickInto(feed)
    typeOver(feed, '120')
    fireEvent.keyDown(feed, { key: 'Enter' })

    // 100 -> 120 is two coarse +10% steps from the absolute 100% reset. An
    // appended "100120" would have been refused with a console line instead.
    expect(sent()).toEqual([
      'feed:reset',
      'feed:+10',
      'feed:+10',
    ])
  })

  it('leaves the caret alone on the second click of a double-click', () => {
    render(<OverridePanel />)
    const feed = field('Feed')

    clickInto(feed)
    // Already focused: no second focus event, so the one-shot arm is spent and
    // the browser's own caret placement stands.
    feed.setSelectionRange(1, 1)
    fireEvent.mouseUp(feed)

    expect(feed.selectionStart).toBe(1)
    expect(feed.selectionEnd).toBe(1)
  })

  it('keeps the spindle field on the same contract', () => {
    render(<OverridePanel />)
    const spindle = field('Spindle')

    clickInto(spindle)
    typeOver(spindle, '84')
    fireEvent.keyDown(spindle, { key: 'Enter' })

    expect(spindle.type).toBe('text')
    expect(sent()).toEqual([
      'spindle:reset',
      'spindle:-10',
      'spindle:-1',
      'spindle:-1',
      'spindle:-1',
      'spindle:-1',
      'spindle:-1',
      'spindle:-1',
    ])
  })
})

describe('WO-287 the override behaviour the entry fix must not change', () => {
  it.each(['9', '0', '201', '999'])('refuses %j - the 10-200 clamp still holds', (typed) => {
    render(<OverridePanel />)
    const feed = field('Feed')

    clickInto(feed)
    typeOver(feed, typed)
    fireEvent.keyDown(feed, { key: 'Enter' })

    expect(sent()).toEqual([])
    const line = useMachineControl.getState().consoleLines.at(-1)
    expect(line?.severity).toBe('error')
    expect(line?.text).toMatch(/Feed override was not sent/i)
    expect(line?.text).toMatch(/10% to 200%/i)
  })

  // 10% is the absolute reset plus nine coarse -10% steps; 200% is the reset
  // plus ten coarse +10% steps. Both ends of the clamp are still accepted.
  it.each([
    { typed: '10', step: 'feed:-10' as const, count: 9 },
    { typed: '200', step: 'feed:+10' as const, count: 10 },
  ])('accepts the boundary value $typed', ({ typed, step, count }) => {
    render(<OverridePanel />)
    const feed = field('Feed')

    clickInto(feed)
    typeOver(feed, typed)
    fireEvent.keyDown(feed, { key: 'Enter' })

    expect(sent()).toEqual([
      'feed:reset',
      ...Array.from({ length: count }, () => step),
    ])
  })

  it.each(['', 'abc', '12.5', '-40'])('refuses the non-integer entry %j', (typed) => {
    render(<OverridePanel />)
    const feed = field('Feed')

    clickInto(feed)
    typeOver(feed, typed)
    fireEvent.keyDown(feed, { key: 'Enter' })

    expect(sent()).toEqual([])
    expect(useMachineControl.getState().consoleLines.at(-1)?.severity).toBe('error')
  })

  it('commits on Enter and blurs the field', () => {
    render(<OverridePanel />)
    const feed = field('Feed')

    clickInto(feed)
    typeOver(feed, '150')
    fireEvent.keyDown(feed, { key: 'Enter' })

    expect(setOverride.mock.calls.length).toBe(1 + 5)
    expect(document.activeElement).not.toBe(feed)
  })

  it('does NOT commit on blur - only Enter sends bytes to a live machine', () => {
    render(<OverridePanel />)
    const feed = field('Feed')

    clickInto(feed)
    typeOver(feed, '150')
    act(() => feed.blur())

    expect(sent()).toEqual([])
    expect(feed.value).toBe('100')
  })

  it('restores the last committed value on Escape', () => {
    render(<OverridePanel />)
    const feed = field('Feed')

    clickInto(feed)
    typeOver(feed, '137')
    expect(feed.value).toBe('137')

    fireEvent.keyDown(feed, { key: 'Escape' })

    expect(feed.value).toBe('100')
    expect(document.activeElement).not.toBe(feed)
    expect(sent()).toEqual([])
  })

  it('restores the value committed most recently, not the one first rendered', () => {
    render(<OverridePanel />)
    act(() => useMachineControl.setState({ overrides: { feed: 75, rapid: 100, spindle: 100 } }))
    const feed = field('Feed')
    expect(feed.value).toBe('75')

    clickInto(feed)
    typeOver(feed, '137')
    fireEvent.keyDown(feed, { key: 'Escape' })

    expect(feed.value).toBe('75')
  })

  it('does not clobber a half-typed entry when the machine reports a new value', () => {
    render(<OverridePanel />)
    const feed = field('Feed')

    clickInto(feed)
    typeOver(feed, '137')
    act(() => useMachineControl.setState({ overrides: { feed: 88, rapid: 50, spindle: 120 } }))

    expect(feed.value).toBe('137')
    expect(document.activeElement).toBe(feed)
  })

  it('keeps the disabled state, tooltip, test id and aria-label', () => {
    act(() => useMachineControl.setState({ connectionPhase: 'disconnected' }))
    render(<OverridePanel />)
    const feed = screen.getByTestId('control-ovr-feed') as HTMLInputElement

    expect(feed.disabled).toBe(true)
    expect(feed.getAttribute('aria-label')).toBe('Feed override percent')
    expect(feed.getAttribute('data-tooltip')).toBe(
      'Live feed override - type 10 to 200 and press Enter',
    )
    expect(screen.getByRole('spinbutton', { name: 'Feed override percent' })).toBe(feed)
    expect(feed.getAttribute('min')).toBe('10')
    expect(feed.getAttribute('max')).toBe('200')
    expect(feed.getAttribute('step')).toBe('1')
  })
})
