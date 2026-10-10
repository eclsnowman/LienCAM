// @vitest-environment jsdom
import { act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransport,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities } from '../../lib/machine/controller'
import {
  createDefaultControllerDefinition,
  type MachineConfig,
  type MachineOutputDefinition,
  type Project,
} from '../../types'
import { axisSoftLimitStatementKey } from '../../lib/machine/resolvedMachineMotion'
import { makeMachine } from '../post/helpers'
import { typedMock } from '../support/typedMock'

// WO-1800 proves the application door, not a hand-built controller payload:
// sendMdiLine -> machineSession -> UccncController -> fake bridge wire. The
// fake models the recorded stale first setOutput sample, then controls only the
// later getOutput observations. It never retries an output write.

const CAPABILITIES: ControllerCapabilities = {
  geometryQueue: true,
  executingMoveId: true,
  bufferSeconds: true,
  gcodeText: false,
  machineProgram: true,
  perAxisHoming: true,
  ownsSpindle: false,
  spindleCommands: false,
}

interface OutputArgs { port: number; pin: number; on: boolean; negate: boolean }
interface ReadArgs { port: number; pin: number; negate: boolean }
type ReadReply = boolean | null | 'error' | 'hold'

interface FakeBridgeTransport extends BridgeTransport {
  sent: BridgeCallMessage[]
}

const sockets: FakeBridgeTransport[] = []
const boardState = new Map<string, boolean>()
const readCounts = new Map<string, number>()
let readReply: (args: ReadArgs, count: number) => ReadReply = (args) => boardState.get(pinKey(args)) ?? false

function pinKey(args: { port: number; pin: number }): string {
  return `${args.port}:${args.pin}`
}

function rawReadback(args: ReadArgs, on: boolean | null): Record<string, unknown> {
  return {
    port: args.port,
    pin: args.pin,
    ucPin: 99,
    level: on === null ? null : on !== args.negate,
    on,
  }
}

vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()
  class Fake extends actual.BridgeTransport {
    static isSupported(): boolean { return true }
    sent: BridgeCallMessage[] = []
    private fakeEvents: BridgeTransportEvents | null = null

    constructor(...args: ConstructorParameters<typeof actual.BridgeTransport>) {
      super(...args)
      sockets.push(this)
    }

    async start(events: BridgeTransportEvents): Promise<void> {
      this.fakeEvents = events
      const zero = { x: 0, y: 0, z: 0 }
      const offsets = { G54: zero, G55: zero, G56: zero, G57: zero, G58: zero, G59: zero }
      events.onMessage({
        t: 'hello',
        v: {
          protocol: 1,
          bridge: 'wo-1800-fake 0.0',
          capabilities: CAPABILITIES,
          readOnly: false,
          workOffsets: { current: offsets, profile: offsets },
        },
      } as BridgeMessage)
    }

    send(message: BridgeCallMessage): void {
      this.sent.push(message)
      if (message.m === 'setOutput') {
        const args = message.a as unknown as OutputArgs
        const key = pinKey(args)
        const prior = boardState.get(key) ?? false
        boardState.set(key, args.on)
        // The production capture's defect: this successful write reply carries
        // the value from before the write became visible to GetOutput.
        this.fakeEvents?.onMessage({
          t: 'reply',
          seq: message.seq,
          ok: true,
          v: rawReadback(args, prior),
        })
        return
      }
      if (message.m === 'getOutput') {
        const args = message.a as unknown as ReadArgs
        const key = pinKey(args)
        const count = (readCounts.get(key) ?? 0) + 1
        readCounts.set(key, count)
        const reply = readReply(args, count)
        if (reply === 'hold') return
        if (reply === 'error') {
          this.fakeEvents?.onMessage({ t: 'reply', seq: message.seq, ok: false, error: 'output word unavailable' })
          return
        }
        this.fakeEvents?.onMessage({
          t: 'reply',
          seq: message.seq,
          ok: true,
          v: rawReadback(args, reply),
        })
        return
      }
      this.fakeEvents?.onMessage({ t: 'reply', seq: message.seq, ok: true, v: true })
    }

    async close(): Promise<void> {
      this.fakeEvents?.onClose('closed')
    }
  }
  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({ ...actual, BridgeTransport: Fake })
})

const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineActions } = await import('../../store/machineActionsStore')
const {
  __resetEstopInterlockForTest,
  clearPathFidelity,
  connectMachine,
  disconnectMachine,
  getMachineController,
  sendMdiLine,
} = await import('../../lib/machine/machineSession')
const outputControllerModule = await import('../../lib/machine/uccncController')
// The fallback keeps the fix-absent negative control executable after the
// pre-WO source (which has no named budget yet) is temporarily restored.
const OUTPUT_CONFIRMATION_BUDGET_MS = outputControllerModule.OUTPUT_CONFIRMATION_BUDGET_MS ?? 750

const OUTPUTS: MachineOutputDefinition[] = [
  { name: 'vacuum', role: 'vacuum', onCode: 'M10', offCode: 'M11', pin: { port: 3, pin: 16, negate: false } },
  { name: 'pump', onCode: 'M12', offCode: 'M13', pin: { port: 1, pin: 17, negate: true } },
]

function testMachine(): MachineConfig {
  const definition = createDefaultControllerDefinition()
  for (const axis of definition.axes) {
    axis.softLimitMin = axis.axis === 'Z' ? -50 : 0
    axis.softLimitMax = axis.axis === 'X' ? 600 : axis.axis === 'Y' ? 400 : 150
  }
  definition.stated = definition.axes.flatMap((axis) =>
    (['min', 'max'] as const).map((end) => ({
      controller: 'uccnc' as const,
      key: axisSoftLimitStatementKey(axis.axis, end),
    })),
  )
  definition.outputs = OUTPUTS
  return makeMachine({
    id: 'wo1800-machine',
    name: 'WO-1800 Test Machine',
    controller: 'uccnc',
    travel: { x: 600, y: 400, z: 200 },
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'min', homePositionMm: -50 },
    },
    rapidRate: 5000,
    controllerDefinition: definition,
  })
}

function install(machine: MachineConfig): void {
  const state = useCamStore.getState()
  useCamStore.setState({
    machineLibrary: [machine],
    project: { ...state.project, machine, setups: [], activeSetupId: null },
    control: {
      ...state.control,
      activeMachineId: machine.id,
      sessionMachine: null,
      appliedMachine: null,
      sessionActiveMachineId: undefined,
    },
  })
}

function socket(): FakeBridgeTransport {
  return sockets[sockets.length - 1]
}

function outputCalls(method: 'setOutput' | 'getOutput'): BridgeCallMessage[] {
  return socket().sent.filter((message) => message.m === method)
}

function mdiRows(word: string): string[] {
  return useMachineControl.getState().consoleLines
    .map((line) => line.text)
    .filter((line) => line.startsWith(`MDI ${word}:`))
}

async function advance(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

async function connect(): Promise<void> {
  install(testMachine())
  const pending = connectMachine('bridge')
  await advance(300)
  await pending
  act(() => { __resetEstopInterlockForTest() })
  act(() => { useMachineControl.getState().setProgram(null, null, [], null) })
}

let originalProject: Project
let originalLibrary: MachineConfig[]
let originalControl: ReturnType<typeof useCamStore.getState>['control']

describe('WO-1800 output confirmation through sendMdiLine and UccncController', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    sockets.length = 0
    boardState.clear()
    readCounts.clear()
    readReply = (args) => boardState.get(pinKey(args)) ?? false
    originalProject = useCamStore.getState().project
    originalLibrary = useCamStore.getState().machineLibrary
    originalControl = useCamStore.getState().control
    await connect()
  })

  afterEach(async () => {
    if (getMachineController().connectionPhase() !== 'disconnected') {
      const pending = disconnectMachine()
      await advance(300)
      await pending
    }
    useCamStore.setState({
      project: originalProject,
      machineLibrary: originalLibrary,
      control: originalControl,
      machineWorkOffsets: {},
    })
    clearPathFidelity()
    useMachineControl.setState({ consoleLines: [] })
    useMachineActions.setState({ byMachine: {} })
    act(() => { __resetEstopInterlockForTest() })
    act(() => { useMachineControl.getState().setProgram(null, null, [], null) })
    vi.useRealTimers()
  })

  it('reproduces the stale first sample, then confirms delayed ON and OFF with read-only calls', async () => {
    readReply = (args, count) => count === 1 ? !boardState.get(pinKey(args)) : (boardState.get(pinKey(args)) ?? false)

    expect(sendMdiLine('M10')).toBe(true)
    await advance(250)
    expect(mdiRows('M10')).toEqual([
      'MDI M10: vacuum on (port 3 pin 16) (controller readback confirmed).',
    ])

    readCounts.clear()
    expect(sendMdiLine('M11')).toBe(true)
    await advance(250)
    expect(mdiRows('M11')).toEqual([
      'MDI M11: vacuum off (port 3 pin 16) (controller readback confirmed).',
    ])
    expect(outputCalls('setOutput')).toHaveLength(2)
    expect(outputCalls('getOutput')).toHaveLength(4)
  })

  it('keeps active-low logic and confirmations on different ports independent', async () => {
    expect(sendMdiLine('M10')).toBe(true)
    expect(sendMdiLine('M12')).toBe(true)
    await advance(150)

    expect(outputCalls('setOutput').map((message) => message.a)).toEqual([
      { port: 3, pin: 16, on: true, negate: false },
      { port: 1, pin: 17, on: true, negate: true },
    ])
    expect(outputCalls('getOutput').map((message) => message.a)).toEqual([
      { port: 3, pin: 16, negate: false },
      { port: 1, pin: 17, negate: true },
    ])
    expect(mdiRows('M10')[0]).toContain('controller readback confirmed')
    expect(mdiRows('M12')[0]).toContain('pump on (port 1 pin 17, inverted) (controller readback confirmed)')
  })

  it('keeps an accepted write non-refusing when later reads are unknown or fail', async () => {
    readReply = (_args, count) => count % 2 === 0 ? 'error' : null
    expect(sendMdiLine('M10')).toBe(true)
    await advance(OUTPUT_CONFIRMATION_BUDGET_MS + 100)

    expect(outputCalls('setOutput')).toHaveLength(1)
    expect(outputCalls('getOutput').length).toBeGreaterThan(1)
    expect(mdiRows('M10')).toEqual([
      'MDI M10: vacuum on (port 3 pin 16) (write accepted; the controller could not confirm the requested state).',
    ])
    expect(mdiRows('M10')[0]).not.toContain('refused')
  })

  it('reports a persistent opposite sample as unconfirmed, not a physical fault', async () => {
    readReply = () => false
    expect(sendMdiLine('M10')).toBe(true)
    await advance(OUTPUT_CONFIRMATION_BUDGET_MS + 100)

    expect(outputCalls('setOutput')).toHaveLength(1)
    expect(mdiRows('M10')).toEqual([
      'MDI M10: vacuum on (port 3 pin 16) (write accepted; controller readback remained off, so the requested state is unconfirmed).',
    ])
    expect(mdiRows('M10')[0]).not.toContain('but the board reads')
  })

  it('lets a rapid newer command own the same pin without cancelling another pin', async () => {
    expect(sendMdiLine('M10')).toBe(true)
    expect(sendMdiLine('M12')).toBe(true)
    expect(sendMdiLine('M11')).toBe(true)
    await advance(200)

    expect(mdiRows('M10')).toEqual([])
    expect(mdiRows('M11')[0]).toContain('vacuum off')
    expect(mdiRows('M12')[0]).toContain('pump on')
    expect(outputCalls('setOutput')).toHaveLength(3)
  })

  it('stops confirmation on disconnect without publishing the old session receipt', async () => {
    readReply = () => 'hold'
    expect(sendMdiLine('M10')).toBe(true)
    await advance(75)
    expect(outputCalls('getOutput')).toHaveLength(1)

    const pending = disconnectMachine()
    await advance(300)
    await pending
    await advance(OUTPUT_CONFIRMATION_BUDGET_MS)
    expect(mdiRows('M10')).toEqual([])
    expect(outputCalls('setOutput')).toHaveLength(1)
  })

  it('dispatches Stop while confirmation is waiting and never repeats actuation', async () => {
    readReply = () => 'hold'
    expect(sendMdiLine('M10')).toBe(true)
    await advance(75)
    getMachineController().stopJob()

    expect(socket().sent.map((message) => message.m)).toContain('stopJob')
    expect(outputCalls('setOutput')).toHaveLength(1)
    await advance(OUTPUT_CONFIRMATION_BUDGET_MS + 100)
    expect(outputCalls('setOutput')).toHaveLength(1)
    expect(mdiRows('M10')[0]).toContain('write accepted')
  })
})
