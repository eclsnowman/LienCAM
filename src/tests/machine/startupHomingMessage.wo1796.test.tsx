// @vitest-environment jsdom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  BridgeApplyDefinitionReply,
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransport,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, MachineStatus } from '../../lib/machine/controller'
import { typedMock } from '../support/typedMock'

interface FakeBridgeTransport extends BridgeTransport {
  emit(message: BridgeMessage): void
}

const fakeBridge = vi.hoisted(() => ({ last: null as FakeBridgeTransport | null }))

const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    get length() { return mem.size },
    clear: () => mem.clear(),
    getItem: (key: string) => mem.get(key) ?? null,
    key: (index: number) => Array.from(mem.keys())[index] ?? null,
    removeItem: (key: string) => { mem.delete(key) },
    setItem: (key: string, value: string) => { mem.set(key, String(value)) },
  } as Storage,
  configurable: true,
})
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const CAPABILITIES: ControllerCapabilities = {
  geometryQueue: true,
  executingMoveId: true,
  bufferSeconds: true,
  gcodeText: false,
  perAxisHoming: true,
  ownsSpindle: false,
  spindleCommands: false,
}

const APPLY_REFUSAL: BridgeApplyDefinitionReply = {
  ok: false,
  error: 'a program is loaded',
  reHome: [],
  configuredThisSession: false,
  lines: [],
}

vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()

  class FakeBridgeTransport extends actual.BridgeTransport {
    private fakeEvents: BridgeTransportEvents | null = null

    static isSupported(): boolean { return true }

    constructor() {
      super()
      fakeBridge.last = this
    }

    async start(events: BridgeTransportEvents): Promise<void> {
      this.fakeEvents = events
      this.emit({
        t: 'hello',
        v: {
          protocol: 1,
          bridge: 'wo1796-fake-bridge',
          capabilities: CAPABILITIES,
          readOnly: false,
        },
      })
    }

    send(message: BridgeCallMessage): void {
      this.emit({
        t: 'reply',
        seq: message.seq,
        ok: true,
        v: message.m === 'applyMachineDefinition' ? APPLY_REFUSAL : true,
      })
    }

    async close(): Promise<void> {
      this.fakeEvents?.onClose('closed')
    }

    emit(message: BridgeMessage): void {
      this.fakeEvents?.onMessage(message)
    }
  }

  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({
    ...actual,
    BridgeTransport: FakeBridgeTransport,
  })
})

const { ControlPage } = await import('../../components/machine/ControlPage')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { createDefaultControllerDefinition } = await import('../../types')
const session = await import('../../lib/machine/machineSession')

const ADVICE =
  'Not homed yet - machine coordinates unknown. Press Home All, or type a machine coordinate to set it.'

const BASE_STATUS: MachineStatus = {
  state: 'idle',
  subState: null,
  machinePos: { x: 10, y: 20, z: 30 },
  workPos: { x: 1, y: 2, z: 3 },
  feedMmMin: 0,
  spindleRpm: 0,
  overrides: null,
  executingMoveId: null,
  buffer: null,
  probeCycle: null,
  inputs: null,
  homed: null,
  spindle: null,
}

function report(homed: MachineStatus['homed']): void {
  fakeBridge.last!.emit({ t: 'status', v: { ...BASE_STATUS, homed } })
}

function adviceLines() {
  return useMachineControl.getState().consoleLines.filter((line) => line.text === ADVICE)
}

beforeEach(async () => {
  useCamStore.getState().newProject()
  useCamStore.setState({ machineDatumRevokedAxes: {} })
  const machine = useCamStore.getState().project.machine!
  const definition = createDefaultControllerDefinition()
  definition.axes.forEach((axis, index) => {
    axis.stepPin = { port: 1, pin: 2 + index * 3, negate: false }
    axis.dirPin = { port: 1, pin: 3 + index * 3, negate: false }
    axis.homePin = { port: 1, pin: 4 + index * 3, negate: false }
  })
  useCamStore.getState().updateMachine({
    ...machine,
    controller: 'uccnc',
    noHomingSwitches: false,
    controllerDefinition: definition,
  })
  useMachineControl.setState({ homed: false, settings: {}, consoleLines: [] })
  await session.connectMachine('bridge')
})

afterEach(async () => {
  cleanup()
  await session.disconnectMachine()
})

describe('WO-1796 truthful bridge homing advice', () => {
  it('stays silent after hello until the first actual status confirms a state', () => {
    render(<ControlPage />)

    expect(session.getMachineController().status().homed).toBeNull()
    expect(session.getMachineController().homedAxesThisSession?.()).toEqual({})
    expect(adviceLines()).toHaveLength(0)

    act(() => report({ X: true, Y: true, Z: true }))

    expect(useMachineControl.getState().homed).toBe(true)
    expect(adviceLines()).toHaveLength(0)
  })

  it('announces confirmed unhomed and partial states once per transition', () => {
    render(<ControlPage />)

    act(() => report({ X: false, Y: false, Z: false }))
    expect(adviceLines()).toHaveLength(1)

    act(() => report({ X: false, Y: false, Z: false }))
    expect(adviceLines()).toHaveLength(1)

    act(() => report({ X: true, Y: true, Z: true }))
    act(() => report({ X: true, Y: false, Z: true }))
    expect(adviceLines()).toHaveLength(2)
  })

  it('does not reuse a stale homed report across reconnect', async () => {
    render(<ControlPage />)
    act(() => report({ X: true, Y: true, Z: true }))

    await act(async () => { await session.disconnectMachine() })
    await act(async () => { await session.connectMachine('bridge') })

    expect(session.getMachineController().status().homed).toBeNull()
    expect(adviceLines()).toHaveLength(0)

    act(() => report({ X: false, Y: false, Z: false }))
    expect(adviceLines()).toHaveLength(1)
  })

  it('does not narrate an apply-refusal unknown as a re-home instruction', async () => {
    render(<ControlPage />)
    act(() => report({ X: true, Y: true, Z: true }))

    const machine = useCamStore.getState().project.machine!
    const outcome = await act(async () => session.applyConnectedMachineDefinition(
      machine.controllerDefinition!,
      {},
      machine.id,
    ))

    expect(outcome.result).toMatchObject({ ok: false, error: 'a program is loaded' })
    expect(useMachineControl.getState().homed).toBe(false)
    expect(session.getMachineController().homedAxesThisSession?.()).toEqual({})
    expect(session.getMachineController().status().homed).toEqual({ X: true, Y: true, Z: true })
    expect(adviceLines()).toHaveLength(0)

    act(() => report({ X: true, Y: true, Z: true }))
    expect(useMachineControl.getState().homed).toBe(true)
    expect(adviceLines()).toHaveLength(0)
  })
})
