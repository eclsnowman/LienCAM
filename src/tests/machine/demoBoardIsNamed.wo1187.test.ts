// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransport,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities } from '../../lib/machine/controller'
import { typedMock } from '../support/typedMock'

interface FakeBridgeTransport extends BridgeTransport {
  sent: BridgeCallMessage[]
  emit(message: BridgeMessage): void
}

const bridge = vi.hoisted(() => ({
  last: null as FakeBridgeTransport | null,
  nextBoard: -19,
}))

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
          bridge: 'WO-1187 bridge fixture',
          capabilities: CAPABILITIES,
          readOnly: false,
          uccnc: {
            installRoot: 'C:\\UCCNC',
            profile: 'C:\\UCCNC\\Profiles\\LienCNC.pro',
            uc100Dll: 'C:\\UCCNC\\UC100.dll',
            ftd2xxDll: 'C:\\UCCNC\\FTD2XX.dll',
            profiles: ['C:\\UCCNC\\Profiles\\LienCNC.pro'],
            board: bridge.nextBoard,
          },
          definitionSource: 'cache-baseline',
          definitionDrift: [],
        },
      })
    }

    send(message: BridgeCallMessage): void {
      this.sent.push(message)
    }

    async close(): Promise<void> {}

    emit(message: BridgeMessage): void {
      this.fakeEvents?.onMessage(message)
    }
  }

  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({
    ...actual,
    BridgeTransport: FakeBridgeTransport,
  })
})

const session = await import('../../lib/machine/machineSession')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')

async function connect(board: number): Promise<void> {
  bridge.nextBoard = board
  await session.connectMachine('bridge')
}

function boardLines(): string[] {
  return useMachineControl.getState().consoleLines
    .map((line) => line.text)
    .filter((line) => line.startsWith('board '))
}

beforeEach(() => {
  bridge.last = null
  bridge.nextBoard = -19
  useCamStore.getState().newProject()
  // WO-2066: the bridge is UCCNC's route only, so this bridge test's machine declares UCCNC.
  useCamStore.setState((state) => ({
    project: { ...state.project, machine: { ...state.project.machine, controller: 'uccnc' } },
  }))
  useCamStore.setState((state) => ({
    machineDatumRevokedAxes: {},
    control: { ...state.control, activeMachineId: null, sessionMachine: null },
  }))
  useMachineControl.setState({ consoleLines: [], homed: false })
})

afterEach(async () => {
  if (session.getMachineController().connectionPhase() !== 'disconnected') {
    await session.disconnectMachine()
  }
})

describe('WO-1187 demo boards can never look like physical machines', () => {
  it('names a demo board loudly once, including across the bridge repeated connected phase', async () => {
    await connect(-19)
    bridge.last?.emit({ t: 'phase', v: { phase: 'connected', version: 'WO-1187 bridge fixture' } })

    expect(boardLines()).toEqual([
      'board -19 - THIS IS THE DEMO CONTROLLER. Nothing will move; every command is simulated.',
    ])
  })

  it('names a positive board as real hardware once', async () => {
    await connect(1)
    bridge.last?.emit({ t: 'phase', v: { phase: 'connected', version: 'WO-1187 bridge fixture' } })

    expect(boardLines()).toEqual(['board 1 (REAL HARDWARE).'])
  })

  it('lets demo homing run but never clears the physical machine datum revocation', async () => {
    const machineId = useCamStore.getState().project.machine.id
    useCamStore.setState({ machineDatumRevokedAxes: { [machineId]: ['X', 'Y', 'Z'] } })
    await connect(-19)
    // This case isolates demo-board datum provenance after an operator CLEAR.
    session.__resetEstopInterlockForTest()

    expect(session.getMachineController().homeAxes?.(['Z', 'X', 'Y'])).toBe(true)
    expect(bridge.last?.sent.some((message) => message.m === 'homeAxes')).toBe(true)
    bridge.last?.emit({ t: 'homed', v: { axes: ['Z', 'X', 'Y'] } })

    expect(useMachineControl.getState().homed).toBe(true)
    expect(useCamStore.getState().machineDatumRevokedAxes[machineId]).toEqual(['X', 'Y', 'Z'])

    await session.disconnectMachine()
    expect(session.currentResolvedMachineMotion().datum).toMatchObject({
      known: false,
      source: 'configured-only',
    })
    expect(useCamStore.getState().machineDatumRevokedAxes[machineId]).toEqual(['X', 'Y', 'Z'])
  })

  it('keeps real-board homing as the authority that clears the durable revocation', async () => {
    const machineId = useCamStore.getState().project.machine.id
    useCamStore.setState({ machineDatumRevokedAxes: { [machineId]: ['X', 'Y', 'Z'] } })
    await connect(1)

    bridge.last?.emit({ t: 'homed', v: { axes: ['Z', 'X', 'Y'] } })

    expect(useCamStore.getState().machineDatumRevokedAxes[machineId]).toBeUndefined()
  })
})
