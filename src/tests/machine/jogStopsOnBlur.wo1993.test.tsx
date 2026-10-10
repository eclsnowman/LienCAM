// @vitest-environment jsdom
//
// WO-1993 - losing the browser window/tab must stop a held jog immediately.
// This is Tier 2 evidence: the rendered JogPanel drives the real machine
// session and UccncController through a fake bridge, then the assertion reads
// the stop calls at that bridge boundary.

import { act } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransport,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, MachineStatus } from '../../lib/machine/controller'
import { typedMock } from '../support/typedMock'

interface FakeBridgeTransport extends BridgeTransport {
  sent: BridgeCallMessage[]
  reportIdle(): void
}

const bridge = vi.hoisted(() => ({ last: null as FakeBridgeTransport | null }))

const CAPABILITIES: ControllerCapabilities = {
  geometryQueue: true,
  executingMoveId: true,
  bufferSeconds: true,
  gcodeText: false,
  perAxisHoming: true,
  ownsSpindle: false,
  spindleCommands: false,
  machineProgram: true,
}

const IDLE_STATUS: MachineStatus = {
  state: 'idle',
  subState: null,
  machinePos: null,
  workPos: null,
  feedMmMin: null,
  spindleRpm: null,
  overrides: null,
  executingMoveId: null,
  buffer: null,
  inputs: {
    estop: false,
    hardLimit: false,
    softLimit: false,
    probe: false,
    limits: null,
    door: null,
    hold: false,
  },
  homed: null,
  spindle: null,
}

vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()

  class FakeBridgeTransport extends actual.BridgeTransport {
    static isSupported(): boolean { return true }
    sent: BridgeCallMessage[] = []
    private fakeEvents: BridgeTransportEvents | null = null

    constructor() {
      super()
      bridge.last = this
    }

    async start(events: BridgeTransportEvents): Promise<void> {
      this.fakeEvents = events
      this.emit({
        t: 'hello',
        v: {
          protocol: 1,
          bridge: 'WO-1993 fake bridge',
          capabilities: CAPABILITIES,
          readOnly: false,
        },
      })
    }

    send(message: BridgeCallMessage): void {
      this.sent.push(message)
      if (message.m === 'queryStatus') this.reportIdle()
      this.emit({ t: 'reply', seq: message.seq, ok: true, v: true })
    }

    reportIdle(): void {
      this.emit({ t: 'status', v: IDLE_STATUS })
    }

    async close(): Promise<void> {
      this.fakeEvents = null
    }

    private emit(message: BridgeMessage): void {
      this.fakeEvents?.onMessage(message)
    }
  }

  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({
    ...actual,
    BridgeTransport: FakeBridgeTransport,
  })
})

const memory = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    get length() { return memory.size },
    clear: () => memory.clear(),
    getItem: (key: string) => memory.get(key) ?? null,
    key: (index: number) => [...memory.keys()][index] ?? null,
    removeItem: (key: string) => { memory.delete(key) },
    setItem: (key: string, value: string) => { memory.set(key, String(value)) },
  } satisfies Storage,
})

const { JogPanel } = await import('../../components/machine/JogPanel')
const session = await import('../../lib/machine/machineSession')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useUiPrefs } = await import('../../store/uiPrefs')

async function connectIdleBridge(): Promise<FakeBridgeTransport> {
  await act(async () => { await session.connectMachine('bridge') })
  const current = bridge.last
  if (!current) throw new Error('The fake bridge was not installed.')
  act(() => {
    current.reportIdle()
    session.__resetEstopInterlockForTest()
  })
  return current
}

beforeEach(() => {
  // WO-2066: the bridge is UCCNC's route only, so this bridge test's machine declares UCCNC.
  useCamStore.setState((state) => ({
    project: { ...state.project, machine: { ...state.project.machine, controller: 'uccnc' } },
  }))
  bridge.last = null
  memory.clear()
  Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  useMachineControl.setState({ consoleLines: [], homed: false })
  useUiPrefs.setState({ collapsedPropsGroups: {}, machineJogContinuous: true })
})

afterEach(async () => {
  cleanup()
  if (session.getMachineController().connectionPhase() !== 'disconnected') {
    await session.disconnectMachine()
  }
  session.__resetEstopInterlockForTest()
})

describe('WO-1993 held jog focus boundary', () => {
  it.each([
    {
      boundary: 'window blur',
      loseFocus: () => window.dispatchEvent(new Event('blur')),
    },
    {
      boundary: 'hidden document',
      loseFocus: () => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true })
        document.dispatchEvent(new Event('visibilitychange'))
      },
    },
  ])('sends the controller stop immediately on $boundary', async ({ loseFocus }) => {
    const wire = await connectIdleBridge()
    render(<JogPanel selectedConnectionKind="bridge" />)
    const button = await waitFor(() => {
      const jog = screen.getByTestId('control-jog-x-plus') as HTMLButtonElement
      expect(jog.disabled).toBe(false)
      return jog
    })

    fireEvent.pointerDown(button)
    expect(wire.sent.map((message) => message.m)).toContain('jogStart')
    expect(wire.sent.map((message) => message.m)).toContain('jogHold')

    const boundaryAt = wire.sent.length
    act(() => { loseFocus() })

    expect(wire.sent.slice(boundaryAt).map((message) => message.m))
      .toEqual(['jogStop', 'jogCancel'])
  })
})
