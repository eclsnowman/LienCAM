// @vitest-environment jsdom
//
// WO-1752 - A CONNECTION BOUNDARY ENDS A WAITING MACRO.
//
// Both real controller families go through their production session wiring:
// a fake UCCNC bridge socket and a fake GRBL serial pipe. A macro is stopped
// while held and while its real confirm dialog is open. Reconnecting cannot
// make the old CYCLE START or answer reach that run.

import { act, cleanup, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities } from '../../lib/machine/controller'
import type { TransportEvents } from '../../lib/machine/types'
import { createDefaultControllerDefinition, type MachineMacro } from '../../types'
import { typedMock } from '../support/typedMock'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (key) => mem.get(key) ?? null,
  key: (index) => Array.from(mem.keys())[index] ?? null,
  removeItem: (key) => { mem.delete(key) },
  setItem: (key, value) => { mem.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const BRIDGE_CAPABILITIES: ControllerCapabilities = {
  geometryQueue: true,
  executingMoveId: true,
  bufferSeconds: true,
  gcodeText: false,
  machineProgram: true,
  perAxisHoming: true,
  ownsSpindle: false,
  spindleCommands: false,
}

vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()
  class FakeBridgeTransport extends actual.BridgeTransport {
    private fakeEvents: BridgeTransportEvents | null = null

    static isSupported(): boolean { return true }

    async start(events: BridgeTransportEvents): Promise<void> {
      this.fakeEvents = events
      const zero = { x: 0, y: 0, z: 0 }
      const offsets = { G54: zero, G55: zero, G56: zero, G57: zero, G58: zero, G59: zero }
      events.onMessage({
        t: 'hello',
        v: {
          protocol: 1,
          bridge: 'wo-1752-fake 0.0',
          capabilities: BRIDGE_CAPABILITIES,
          readOnly: false,
          workOffsets: { current: offsets, profile: offsets },
        },
      } as BridgeMessage)
    }

    send(message: BridgeCallMessage): void {
      if (message.m === 'selectWcs') {
        this.fakeEvents?.onMessage({ t: 'reply', seq: message.seq, ok: true, v: true })
      }
    }

    async close(): Promise<void> {
      this.fakeEvents?.onClose('closed')
      this.fakeEvents = null
    }
  }
  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({
    ...actual,
    BridgeTransport: FakeBridgeTransport,
  })
})

vi.mock('../../lib/machine/webSerialTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/webSerialTransport')>()
  class FakeWebSerialTransport extends actual.WebSerialTransport {
    private fakeEvents: TransportEvents | null = null

    static isSupported(): boolean { return true }
    static async requestPort(): Promise<SerialPort> { return {} as SerialPort }
    static async grantedPorts(): Promise<SerialPort[]> { return [] }

    async start(events: TransportEvents): Promise<void> {
      this.fakeEvents = events
      events.onChunk(new TextEncoder().encode("Grbl 1.1h ['$' for help]\r\n"))
    }

    async write(_data: Uint8Array): Promise<void> {}

    async close(): Promise<void> {
      this.fakeEvents?.onClose('closed')
      this.fakeEvents = null
    }
  }
  return typedMock<typeof import('../../lib/machine/webSerialTransport')>({
    ...actual,
    WebSerialTransport: FakeWebSerialTransport,
  })
})

const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const {
  __resetEstopInterlockForTest,
  connectMachine,
  disconnectMachine,
  getMachineController,
} = await import('../../lib/machine/machineSession')
const {
  __resetMacroRuntimeForTest,
  activeMacroAsk,
  activeMacroRun,
  answerMacroAsk,
  continueHeldMacro,
  runUserMacro,
} = await import('../../lib/machine/macros/macroRuntime')

type ConnectionKind = 'bridge' | 'serial' | 'simulator'

const HOLD: MachineMacro = {
  id: 'hold',
  name: 'Held old run',
  body: "hold()\nsay('OLD HOLD RESUMED')\nline('M8')",
}

const CONFIRM: MachineMacro = {
  id: 'confirm',
  name: 'Asked old run',
  body: "confirm('Continue old run?')\nsay('OLD QUESTION RESUMED')\nline('M8')",
}

function selectMachine(kind: ConnectionKind): void {
  const machine = useCamStore.getState().project.machine
  useCamStore.getState().setProjectMachine({
    ...machine,
    id: `wo1752-${kind}`,
    name: `WO-1752 ${kind} bench`,
    controller: kind === 'bridge' ? 'uccnc' : 'grbl',
    controllerDefinition: createDefaultControllerDefinition(),
    macros: [HOLD, CONFIRM],
  })
}

async function connect(kind: ConnectionKind): Promise<void> {
  selectMachine(kind)
  await connectMachine(kind, kind === 'serial' ? 115200 : undefined)
  act(() => { __resetEstopInterlockForTest() })
}

async function disconnect(): Promise<void> {
  await act(async () => { await disconnectMachine() })
  await act(async () => { await Promise.resolve() })
}

function rows(): string[] {
  return useMachineControl.getState().consoleLines.map((line) => line.text)
}

beforeEach(() => {
  mem.clear()
  useCamStore.getState().newProject()
  useMachineControl.setState({ consoleLines: [] })
})

afterEach(async () => {
  cleanup()
  act(() => { __resetMacroRuntimeForTest() })
  if (getMachineController().connectionPhase() !== 'disconnected') await disconnect()
})

describe.each([
  ['UCCNC bridge', 'bridge'],
  ['GRBL serial', 'serial'],
] as const)('WO-1752: lost connection on %s', (_label, kind) => {
  it('ends hold() and confirm(), closes the dialog, and cannot resume either old run after reconnect', async () => {
    await connect(kind)

    act(() => { expect(runUserMacro(HOLD)).toBe(true) })
    expect(activeMacroRun()).toMatchObject({ name: HOLD.name, phase: 'held' })

    await disconnect()

    expect(activeMacroRun()).toBeNull()
    expect(rows().filter((row) => row === `Macro "${HOLD.name}" stopped: the machine connection was lost.`)).toHaveLength(1)

    await connect(kind)
    act(() => { expect(continueHeldMacro()).toBe(false) })
    await act(async () => { await Promise.resolve() })
    expect(rows()).not.toContain('OLD HOLD RESUMED')

    act(() => { expect(runUserMacro(CONFIRM)).toBe(true) })
    const questionId = activeMacroAsk()?.id
    expect(questionId).toBeTypeOf('number')
    await waitFor(() => expect(screen.getByTestId('macro-ask-dialog')).toBeTruthy())

    await disconnect()

    await waitFor(() => expect(screen.queryByTestId('macro-ask-dialog')).toBeNull())
    expect(activeMacroRun()).toBeNull()
    expect(activeMacroAsk()).toBeNull()
    expect(rows().filter((row) => row === `Macro "${CONFIRM.name}" stopped: the machine connection was lost.`)).toHaveLength(1)

    await connect(kind)
    act(() => { expect(answerMacroAsk(questionId!, true)).toBe(false) })
    await act(async () => { await Promise.resolve() })
    expect(rows()).not.toContain('OLD QUESTION RESUMED')
  })
})

// ARCHITECT REVIEW, 2026-09-20. The outcome is that nothing a macro would have
// sent reaches a LATER CONNECTION, and a disconnect is not the only way to get
// one. Connecting a controller over a live one is a SWAP: it publishes no
// `disconnected` at all (connected -> connecting -> connected), which is why
// machineSession's own adoptControllerJobStateAtBoundary() exists. The first
// fix stopped the macro only inside the `disconnected` branch, so a macro held
// on one controller survived a swap to another, and answering it afterwards
// resumed the OLD run against the NEW controller. Both cases now hang off the
// session boundary instead.
// WO-2066: the swaps below used to put a GRBL session's machine onto the
// bridge, which only the removed every-controller bridge route allowed (a live
// session pins its machine, and only UCCNC has a bridge route now). They now
// swap each real session for that machine's own simulator - still a different
// controller connected over a live one, with no disconnect between.
describe('WO-1752: a swap to another controller is a later connection too', () => {
  it('ends a held macro when a simulator is connected over a live serial session', async () => {
    await connect('serial')

    act(() => { expect(runUserMacro(HOLD)).toBe(true) })
    expect(activeMacroRun()).toMatchObject({ name: HOLD.name, phase: 'held' })

    // No disconnect anywhere: straight onto the other controller.
    await connect('simulator')

    expect(activeMacroRun()).toBeNull()
    expect(rows().filter((row) => row === `Macro "${HOLD.name}" stopped: the machine connection changed.`)).toHaveLength(1)
    // A swap is not a lost connection and must not claim to be one.
    expect(rows()).not.toContain(`Macro "${HOLD.name}" stopped: the machine connection was lost.`)

    act(() => { expect(continueHeldMacro()).toBe(false) })
    await act(async () => { await Promise.resolve() })
    expect(rows()).not.toContain('OLD HOLD RESUMED')
  })

  it('closes an open question on a swap and the old answer sends nothing to the new controller', async () => {
    await connect('bridge')

    act(() => { expect(runUserMacro(CONFIRM)).toBe(true) })
    const questionId = activeMacroAsk()?.id
    expect(questionId).toBeTypeOf('number')
    await waitFor(() => expect(screen.getByTestId('macro-ask-dialog')).toBeTruthy())

    await connect('simulator')

    await waitFor(() => expect(screen.queryByTestId('macro-ask-dialog')).toBeNull())
    expect(activeMacroRun()).toBeNull()
    expect(activeMacroAsk()).toBeNull()
    expect(rows().filter((row) => row === `Macro "${CONFIRM.name}" stopped: the machine connection changed.`)).toHaveLength(1)

    act(() => { expect(answerMacroAsk(questionId!, true)).toBe(false) })
    await act(async () => { await Promise.resolve() })
    expect(rows()).not.toContain('OLD QUESTION RESUMED')
  })
})
