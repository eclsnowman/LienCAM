import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BridgeCallMessage,
  BridgeHelloPush,
  BridgeMessage,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities } from '../../lib/machine/controller'
import type { MachineVec3, WcsId } from '../../lib/machine/types'
import { typedMock } from '../support/typedMock'

const bridgeFixture = vi.hoisted(() => ({
  starts: 0,
  activeEvents: null as BridgeTransportEvents | null,
}))

const CAPABILITIES: ControllerCapabilities = {
  geometryQueue: true,
  executingMoveId: true,
  bufferSeconds: true,
  gcodeText: false,
  perAxisHoming: true,
  ownsSpindle: false,
  spindleCommands: false,
}

const ZERO: MachineVec3 = { x: 0, y: 0, z: 0 }
const WCS: WcsId[] = ['G54', 'G55', 'G56', 'G57', 'G58', 'G59']

function allOffsets(g54: MachineVec3): Record<WcsId, MachineVec3> {
  return Object.fromEntries(
    WCS.map((wcs) => [wcs, wcs === 'G54' ? { ...g54 } : { ...ZERO }]),
  ) as Record<WcsId, MachineVec3>
}

vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()

  class SessionTransport extends actual.BridgeTransport {
    private sessionEvents: BridgeTransportEvents | null = null

    static isSupported(): boolean { return true }

    async start(events: BridgeTransportEvents): Promise<void> {
      this.sessionEvents = events
      bridgeFixture.activeEvents = events
      const session = bridgeFixture.starts++
      events.onMessage({
        t: 'console',
        v: session === 0
          ? {
              dir: 'rx',
              severity: 'info',
              text: '[bridge] the spindle link is open on COM3 - the inverter reported standby (stopped), so the link was kept.',
            }
          : {
              dir: 'rx',
              severity: 'info',
              text: '[bridge] no --vfd given - the spindle link is not started (no serial port opened)',
            },
      })
      const hello: BridgeHelloPush = {
        t: 'hello',
        v: {
          protocol: 1,
          bridge: `liencam-uccnc-bridge/WO-1102-${session + 1}`,
          capabilities: CAPABILITIES,
          readOnly: false,
          definitionSource: 'cache-baseline',
          definitionDrift: [],
          ...(session === 0
            ? { vfd: { present: true, verified: false, name: 'COM3 fixture' } }
            : {
                workOffsets: {
                  current: allOffsets(ZERO),
                  profile: null,
                },
              }),
        },
      }
      events.onMessage(hello)
    }

    send(message: BridgeCallMessage): void {
      if (message.m !== 'setWorkOffset') return
      const requested = message.a ?? {}
      const offset = {
        x: Number(requested.x ?? 0),
        y: Number(requested.y ?? 0),
        z: Number(requested.z ?? 0),
      }
      queueMicrotask(() => this.emit({
        t: 'reply',
        seq: message.seq,
        ok: true,
        v: { ok: true, reason: null, offset },
      }))
    }

    async close(): Promise<void> {
      this.sessionEvents = null
      bridgeFixture.activeEvents = null
    }

    private emit(message: BridgeMessage): void {
      this.sessionEvents?.onMessage(message)
    }
  }

  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({
    ...actual,
    BridgeTransport: SessionTransport,
  })
})

const session = await import('../../lib/machine/machineSession')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-08-29T12:34:56.000Z'))
  useCamStore.getState().newProject()
  // WO-2066: the bridge is UCCNC's route only, so this bridge test's machine declares UCCNC.
  useCamStore.setState((state) => ({
    project: { ...state.project, machine: { ...state.project.machine, controller: 'uccnc' } },
  }))
  const machine = useCamStore.getState().project.machine
  useCamStore.getState().updateMachine({ ...machine, name: 'LienCNC V2' })
  useCamStore.setState({ machineWorkOffsets: {} })
  useMachineControl.setState({ consoleLines: [] })
  bridgeFixture.starts = 0
  bridgeFixture.activeEvents = null
})

afterEach(async () => {
  await session.disconnectMachine()
  vi.useRealTimers()
})

describe('WO-1102: console history has an explicit bridge-session boundary', () => {
  it('keeps old COM3 text above the next machine-named boundary and current text below it', async () => {
    await session.connectMachine('bridge')
    await session.disconnectMachine()

    const machine = useCamStore.getState().project.machine
    useCamStore.getState().setMachineWorkOffset(machine.id, 'G54', { x: 7, y: 8, z: 9 }, 'not-sent')
    await session.connectMachine('bridge')

    const lines = useMachineControl.getState().consoleLines.map((line) => line.text)
    const boundaries = lines
      .map((text, index) => ({ text, index }))
      .filter(({ text }) => text === '--- connected to LienCNC V2 at 2026-08-29T12:34:56.000Z ---')

    expect(boundaries).toHaveLength(2)
    const firstBoundary = boundaries[0].index
    const secondBoundary = boundaries[1].index
    const oldCom3 = lines.findIndex((text) => text.includes('spindle link is open on COM3'))
    const currentNoVfd = lines.findIndex((text) => text.includes('no --vfd given'))

    expect(oldCom3).toBeGreaterThan(firstBoundary)
    expect(oldCom3).toBeLessThan(secondBoundary)
    expect(lines.slice(secondBoundary).some((text) => text.includes('COM3'))).toBe(false)
    expect(currentNoVfd).toBeGreaterThan(secondBoundary)

    for (const appLine of [
      "Machine configured from this computer's data (the .pro was not opened).",
      'Bridge start-up check: cached settings agree with the profile on every key.',
      'Work zero restored from this computer through a profile-less bridge: G54 X7 Y8 Z9 - not re-established on this machine this session.',
    ]) {
      expect(lines.slice(secondBoundary + 1)).toContain(appLine)
    }

    bridgeFixture.activeEvents?.onMessage({
      t: 'phase',
      v: { phase: 'connected', version: 'liencam-uccnc-bridge/WO-1102-2' },
    })
    expect(useMachineControl.getState().consoleLines.filter((line) =>
      line.text.startsWith('--- connected to LienCNC V2 at '),
    )).toHaveLength(2)
  })
})
