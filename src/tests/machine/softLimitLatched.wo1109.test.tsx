// @vitest-environment jsdom
//
// WO-1109: a bridge soft-limit latch is a visible, edge-reported state. These
// tests drive the real BridgeTransport parser, session event handler and React
// controls together; no controller command is mocked or relaxed.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ControlTransportBar } from '../../components/machine/ControlTransportBar'
import { JogPanel } from '../../components/machine/JogPanel'
import { BridgeTransport, type BridgeMessage } from '../../lib/machine/bridgeTransport'
import type { MachineStatus } from '../../lib/machine/controller'
import {
  __resetEstopInterlockForTest,
  buildContractEvents,
  SOFT_LIMIT_CLEARED_NOTICE,
  SOFT_LIMIT_TRIPPED_NOTICE,
  SOFT_LIMIT_UNLOCK_TITLE,
} from '../../lib/machine/machineSession'
import { useCamStore } from '../../store'
import { useMachineControl } from '../../store/machineControlStore'
import { useUiPrefs } from '../../store/uiPrefs'

const DEFAULT_UNLOCK_TOOLTIP = 'Clear the alarm lock ($X) - confirm position is safe first'

class FakeWebSocket {
  static readonly OPEN = 1
  static latest: FakeWebSocket | null = null

  readonly url: string
  readyState = FakeWebSocket.OPEN
  onopen: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  readonly send = vi.fn()

  constructor(url: string) {
    this.url = url
    FakeWebSocket.latest = this
  }

  open(): void {
    this.onopen?.()
  }

  push(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent)
  }

  close(): void {
    this.onclose?.({ code: 1000, reason: '' } as CloseEvent)
  }
}

function statusFrame(softLimitLatched: boolean | undefined): MachineStatus {
  const status: MachineStatus & { softLimitLatched?: boolean } = {
    state: 'idle',
    subState: null,
    machinePos: { x: 10, y: 20, z: 30 },
    workPos: { x: 1, y: 2, z: 3 },
    feedMmMin: 0,
    spindleRpm: null,
    overrides: { feed: 100, rapid: null, spindle: 100 },
    executingMoveId: null,
    buffer: { moves: 0, capacitySeconds: 1 },
    inputs: {
      estop: false,
      hardLimit: false,
      softLimit: false,
      probe: false,
      limits: null,
      door: null,
      hold: false,
    },
    homed: { X: true, Y: true, Z: true },
    spindle: null,
  }
  if (softLimitLatched !== undefined) status.softLimitLatched = softLimitLatched
  return status
}

let activeTransport: BridgeTransport | null = null

async function startTransport(observed: BridgeMessage[] = []): Promise<FakeWebSocket> {
  activeTransport = new BridgeTransport('ws://127.0.0.1:8325', null)
  const started = activeTransport.start({
    onMessage: (message) => {
      observed.push(message)
      if (message.t === 'status') buildContractEvents().onStatus?.(message.v)
    },
    onClose: () => {},
  })
  const socket = FakeWebSocket.latest
  if (!socket) throw new Error('fake bridge socket was not constructed')
  socket.open()
  await started
  return socket
}

function renderControls(): void {
  render(
    <>
      <ControlTransportBar sections="nav" />
      <JogPanel />
    </>,
  )
}

function consoleText(): string[] {
  return useMachineControl.getState().consoleLines.map((line) => line.text)
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', FakeWebSocket)
  useCamStore.getState().newProject()
  useUiPrefs.setState({ collapsedPropsGroups: {} })
  // Settle any latch left by the previous case, then discard that deliberate
  // test reset line so every assertion starts with an empty operator console.
  buildContractEvents().onStatus?.(statusFrame(false))
  // Operator 2026-09-14 ("A: Flash, all motion off"): this suite is about the
  // soft-limit latch's own Unlock tooltip, not the fresh-connect E-STOP
  // latch, which would otherwise cover Unlock with ESTOP_BLOCKS_MOTION.
  __resetEstopInterlockForTest()
  useMachineControl.setState({
    connectionPhase: 'connected',
    connectionKind: 'bridge',
    machineState: 'idle',
    homed: true,
    alarm: null,
    consoleLines: [],
  })
})

afterEach(async () => {
  cleanup()
  await activeTransport?.close()
  activeTransport = null
  FakeWebSocket.latest = null
  vi.unstubAllGlobals()
})

describe('WO-1109 latched soft-limit visibility', () => {
  it('shows the latch, names Unlock once, stays silent across repeated frames, then clears once', async () => {
    const observed: BridgeMessage[] = []
    const socket = await startTransport(observed)
    renderControls()

    act(() => socket.push({ t: 'status', v: statusFrame(true) }))

    expect(observed.at(-1)).toMatchObject({
      t: 'status',
      v: { softLimitLatched: true },
    })
    expect(screen.getByTestId('control-state-chip').textContent).toBe('Soft limit')
    const unlock = screen.getByTestId('control-unlock')
    expect(unlock.getAttribute('title')).toBe(SOFT_LIMIT_UNLOCK_TITLE)
    expect(unlock.getAttribute('data-tooltip')).toBe(SOFT_LIMIT_UNLOCK_TITLE)
    expect(consoleText()).toEqual([SOFT_LIMIT_TRIPPED_NOTICE])

    act(() => {
      for (let frame = 0; frame < 20; frame += 1) {
        socket.push({ t: 'status', v: statusFrame(true) })
      }
    })
    expect(consoleText()).toEqual([SOFT_LIMIT_TRIPPED_NOTICE])

    act(() => socket.push({ t: 'status', v: statusFrame(false) }))

    expect(screen.getByTestId('control-state-chip').textContent).toBe('Idle')
    expect(consoleText()).toEqual([SOFT_LIMIT_TRIPPED_NOTICE, SOFT_LIMIT_CLEARED_NOTICE])
    expect(unlock.getAttribute('title')).toBe(null)
    expect(unlock.getAttribute('data-tooltip')).toBe(DEFAULT_UNLOCK_TOOLTIP)
  })

  it('preserves an older bridge frame with no latch field and reads it as false', async () => {
    const observed: BridgeMessage[] = []
    const socket = await startTransport(observed)
    renderControls()

    act(() => socket.push({ t: 'status', v: statusFrame(undefined) }))

    expect(observed.at(-1)).toEqual({ t: 'status', v: statusFrame(undefined) })
    expect(screen.getByTestId('control-state-chip').textContent).toBe('Idle')
    expect(consoleText()).toEqual([])
    const unlock = screen.getByTestId('control-unlock')
    expect(unlock.getAttribute('title')).toBe(null)
    expect(unlock.getAttribute('data-tooltip')).toBe(DEFAULT_UNLOCK_TOOLTIP)
  })

  it('names Unlock when a collapsed Jog panel is expanded after the latch arrives', async () => {
    const socket = await startTransport()
    useUiPrefs.setState({ collapsedPropsGroups: { 'control-jog': true } })
    renderControls()

    expect(screen.queryByTestId('control-unlock')).toBeNull()
    act(() => socket.push({ t: 'status', v: statusFrame(true) }))
    expect(screen.getByTestId('control-state-chip').textContent).toBe('Soft limit')

    fireEvent.click(screen.getByTestId('control-jog-toggle'))
    const unlock = screen.getByTestId('control-unlock')
    await waitFor(() => expect(unlock.getAttribute('title')).toBe(SOFT_LIMIT_UNLOCK_TITLE))
    expect(unlock.getAttribute('data-tooltip')).toBe(SOFT_LIMIT_UNLOCK_TITLE)

    act(() => socket.push({ t: 'status', v: statusFrame(false) }))
    expect(unlock.getAttribute('title')).toBe(null)
    expect(unlock.getAttribute('data-tooltip')).toBe(DEFAULT_UNLOCK_TOOLTIP)
  })
})
