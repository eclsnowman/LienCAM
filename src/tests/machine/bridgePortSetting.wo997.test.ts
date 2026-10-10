import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BridgeCallMessage,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import { typedMock } from '../support/typedMock'

const openedUrls: string[] = []

vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()
  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({
    ...actual,
    BridgeTransport: class extends actual.BridgeTransport {
      static isSupported(): boolean { return true }

      constructor(url: string = actual.bridgeUrl()) {
        super(url)
        openedUrls.push(url)
      }

      async start(events: BridgeTransportEvents): Promise<void> {
        events.onMessage({
          t: 'hello',
          v: {
            protocol: 1,
            bridge: 'wo-997-test-bridge',
            capabilities: {
              geometryQueue: true,
              executingMoveId: true,
              bufferSeconds: true,
              gcodeText: false,
              perAxisHoming: true,
              ownsSpindle: false,
              spindleCommands: false,
            },
            readOnly: false,
          },
        })
      }

      send(_message: BridgeCallMessage): void {}
      async close(): Promise<void> {}
    },
  })
})

const storage = new Map<string, string>()
const memoryStorage: Storage = {
  get length() { return storage.size },
  clear: () => storage.clear(),
  getItem: (key) => storage.get(key) ?? null,
  key: (index) => [...storage.keys()][index] ?? null,
  removeItem: (key) => { storage.delete(key) },
  setItem: (key, value) => { storage.set(key, String(value)) },
}
vi.stubGlobal('localStorage', memoryStorage)

const { useCamStore } = await import('../../store')
const {
  INVALID_BRIDGE_PORT_MESSAGE,
  UI_PREFS_STORAGE_KEY,
  UI_PREFS_VERSION,
  machineBridgePort,
  useUiPrefs,
} = await import('../../store/uiPrefs')
const { connectMachine, disconnectMachine } = await import('../../lib/machine/machineSession')

function activeMachineId(): string {
  return useCamStore.getState().project.machine.id
}

beforeEach(() => {
  // WO-2066: the bridge is UCCNC's route only, so this bridge test's machine declares UCCNC.
  useCamStore.setState((state) => ({
    project: { ...state.project, machine: { ...state.project.machine, controller: 'uccnc' } },
  }))
  storage.clear()
  openedUrls.length = 0
  useUiPrefs.setState({ machineLinks: {} })
})

afterEach(async () => {
  await disconnectMachine()
})

describe('WO-997 bridge port setting', () => {
  it('keeps the existing bridge URL when this machine has no configured port', async () => {
    expect(machineBridgePort(activeMachineId())).toBe(8325)

    await connectMachine('bridge')

    expect(openedUrls).toEqual(['ws://127.0.0.1:8325/'])
  })

  it('dials the configured port for the active machine', async () => {
    useUiPrefs.getState().setMachineBridgePort(activeMachineId(), 9123)

    await connectMachine('bridge')

    expect(openedUrls).toEqual(['ws://127.0.0.1:9123/'])
  })

  it('persists and restores bridge ports independently by machine id', async () => {
    useUiPrefs.getState().setMachineBridgePort('router-a', 9001)
    useUiPrefs.getState().setMachineBridgePort('router-b', 9002)
    const persisted = storage.get(UI_PREFS_STORAGE_KEY)
    expect(persisted).toBeTruthy()
    expect(JSON.parse(persisted!).state.machineLinks).toEqual({
      'router-a': { bridgePort: 9001 },
      'router-b': { bridgePort: 9002 },
    })

    useUiPrefs.setState({ machineLinks: {} })
    storage.set(UI_PREFS_STORAGE_KEY, persisted!)
    await useUiPrefs.persist.rehydrate()

    expect(machineBridgePort('router-a')).toBe(9001)
    expect(machineBridgePort('router-b')).toBe(9002)
  })

  it.each([0, 65536, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses invalid port %s with a plain sentence',
    (port) => {
      expect(() => useUiPrefs.getState().setMachineBridgePort(activeMachineId(), port))
        .toThrow(INVALID_BRIDGE_PORT_MESSAGE)
      expect(useUiPrefs.getState().machineLinks).toEqual({})
    },
  )

  it('refuses a tampered persisted port at connect instead of dialing the default', async () => {
    storage.set(UI_PREFS_STORAGE_KEY, JSON.stringify({
      state: { machineLinks: { [activeMachineId()]: { bridgePort: 'not-a-port' } } },
      version: UI_PREFS_VERSION,
    }))
    await useUiPrefs.persist.rehydrate()

    await expect(connectMachine('bridge')).rejects.toThrow(INVALID_BRIDGE_PORT_MESSAGE)
    expect(openedUrls).toEqual([])
  })
})
