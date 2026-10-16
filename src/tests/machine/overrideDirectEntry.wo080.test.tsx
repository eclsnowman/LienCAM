// @vitest-environment jsdom

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
  return screen.getByRole('spinbutton', { name: `${name} override percent` }) as HTMLInputElement
}

function typeWithKeyboard(input: HTMLInputElement, value: string) {
  input.focus()
  fireEvent.change(input, { target: { value } })
  fireEvent.keyDown(input, { key: 'Enter' })
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

describe('WO-080 override direct entry', () => {
  it('applies a typed feed value on Enter using exact GRBL realtime bytes', () => {
    render(<OverridePanel />)

    typeWithKeyboard(field('Feed'), '137')

    expect(sent()).toEqual([
      'feed:reset',
      'feed:+10',
      'feed:+10',
      'feed:+10',
      'feed:+1',
      'feed:+1',
      'feed:+1',
      'feed:+1',
      'feed:+1',
      'feed:+1',
      'feed:+1',
    ])
  })

  it('reverts to the live value and blurs on Escape', () => {
    render(<OverridePanel />)
    const feed = field('Feed')
    feed.focus()
    fireEvent.change(feed, { target: { value: '137' } })

    fireEvent.keyDown(feed, { key: 'Escape' })

    expect(feed.value).toBe('100')
    expect(document.activeElement).not.toBe(feed)
    expect(sent()).toEqual([])
  })

  it.each(['', 'abc', '9', '201', '12.5'])(
    'refuses ambiguous or out-of-range feed entry %j with a plain console line',
    (typed) => {
      render(<OverridePanel />)

      typeWithKeyboard(field('Feed'), typed)

      expect(sent()).toEqual([])
      const line = useMachineControl.getState().consoleLines.at(-1)
      expect(line?.severity).toBe('error')
      expect(line?.text).toMatch(/Feed override was not sent/i)
      expect(line?.text).toMatch(/10% to 200%/i)
    },
  )

  it('does not clobber an edited focused field when the live report changes', () => {
    render(<OverridePanel />)
    const feed = field('Feed')
    feed.focus()
    fireEvent.change(feed, { target: { value: '137' } })

    act(() => useMachineControl.setState({ overrides: { feed: 88, rapid: 50, spindle: 120 } }))

    expect(feed.value).toBe('137')
  })

  it('tracks the reported machine value exactly while unfocused', () => {
    render(<OverridePanel />)

    act(() => useMachineControl.setState({ overrides: { feed: 88, rapid: 50, spindle: 120 } }))

    expect(field('Feed').value).toBe('88')
    expect(field('Spindle').value).toBe('120')
  })

  it('keeps rapid limited to its three legal buttons with no direct field', () => {
    render(<OverridePanel />)

    expect(screen.queryByRole('spinbutton', { name: /Rapid override percent/i })).toBeNull()
    expect(screen.getByTestId('control-ovr-rapid-25')).toBeTruthy()
    expect(screen.getByTestId('control-ovr-rapid-50')).toBeTruthy()
    expect(screen.getByTestId('control-ovr-rapid-100')).toBeTruthy()
  })

  it('supports the complete apply flow with focus and keyboard events only', () => {
    render(<OverridePanel />)
    const spindle = field('Spindle')

    typeWithKeyboard(spindle, '84')

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

  it('does not render dedicated reset controls for feed or spindle', () => {
    render(<OverridePanel />)

    expect(screen.queryByTestId('control-ovr-feed-reset')).toBeNull()
    expect(screen.queryByTestId('control-ovr-spindle-reset')).toBeNull()
  })
})
