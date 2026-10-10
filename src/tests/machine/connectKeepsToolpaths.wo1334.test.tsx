// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransport,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, MachineStatus } from '../../lib/machine/controller'
import { HUANYANG_GT } from '../../lib/machine/vfd/huanyangGt'
import { vfdLinkFromTemplate, type VfdDefinition } from '../../lib/machine/vfd'
import {
  createDefaultControllerDefinition,
  type MachineConfig,
  type MachineSpindleLinkDefinition,
  type Operation,
  type Project,
  type Setup,
  type ToolpathMove,
} from '../../types'
import { makeMachine, makeOp, makeStock, makeTool, makeWcs, stampGenerationCurrent } from '../post/helpers'
import { axisSoftLimitStatementKey } from '../../lib/machine/resolvedMachineMotion'
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

const MACHINE_ID = 'wo1334-machine'
const OFFSETS = {
  G54: { x: 10, y: 5, z: 2 },
  G55: { x: 110, y: 5, z: 2 },
  G56: { x: 0, y: 0, z: 0 },
  G57: { x: 0, y: 0, z: 0 },
  G58: { x: 0, y: 0, z: 0 },
  G59: { x: 0, y: 0, z: 0 },
}
const CAPABILITIES: ControllerCapabilities = {
  geometryQueue: true,
  executingMoveId: true,
  bufferSeconds: true,
  gcodeText: false,
  machineProgram: true,
  perAxisHoming: true,
  ownsSpindle: true,
  spindleCommands: true,
}

interface FakeBridgeTransport extends BridgeTransport {
  sent: BridgeCallMessage[]
  emit(message: BridgeMessage): void
}

const bridge = vi.hoisted(() => ({
  instances: [] as FakeBridgeTransport[],
  declared: null as VfdDefinition | null,
}))

vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()
  class FakeBridgeTransportImpl extends actual.BridgeTransport {
    static isSupported(): boolean { return true }
    sent: BridgeCallMessage[] = []
    private fakeEvents: BridgeTransportEvents | null = null

    constructor() {
      super()
      bridge.instances.push(this)
    }

    async start(events: BridgeTransportEvents): Promise<void> {
      this.fakeEvents = events
      this.emit({
        t: 'hello',
        v: {
          protocol: 1,
          bridge: `WO-1334-${bridge.instances.length}`,
          capabilities: CAPABILITIES,
          readOnly: false,
          workOffsets: { current: OFFSETS, profile: OFFSETS },
          vfd: {
            present: true,
            verified: bridge.declared?.verified === true,
            name: bridge.declared?.name ?? null,
            definition: bridge.declared,
          },
        },
      })
      this.emit({
        t: 'vfd',
        v: {
          up: true,
          running: false,
          faulted: false,
          runStateWord: 3,
          commandWord: 0,
          setpointWord: 0,
          consecutiveFailures: 0,
          lastStopReason: 'none',
          lastError: null,
          statusWords: [],
          status: {},
          upToSpeed: null,
          port: 'COM3',
        },
      })
    }

    send(message: BridgeCallMessage): void {
      this.sent.push(message)
      if (message.m === 'applyVfdDefinition') {
        const argument = message.a as { definition: MachineSpindleLinkDefinition }
        this.emit({ t: 'reply', seq: message.seq, ok: true, v: { definition: argument.definition } })
      }
      if (message.m === 'setWorkOffset') {
        const argument = message.a as { x?: number; y?: number; z?: number }
        this.emit({
          t: 'reply',
          seq: message.seq,
          ok: true,
          v: { ok: true, offset: { x: argument.x ?? 0, y: argument.y ?? 0, z: argument.z ?? 0 } },
        })
      }
      if (message.m === 'selectWcs') {
        this.emit({ t: 'reply', seq: message.seq, ok: true, v: true })
      }
    }

    async close(): Promise<void> { this.fakeEvents?.onClose('closed') }
    emit(message: BridgeMessage): void { this.fakeEvents?.onMessage(message) }
  }

  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({
    ...actual,
    BridgeTransport: FakeBridgeTransportImpl,
    vfdPortLinkState: () => ({
      ...actual.VFD_PORT_LINK_DISCONNECTED,
      connected: true,
      linkPresent: true,
      spindleTurning: false,
      declared: bridge.declared,
      applied: bridge.declared,
      machineId: MACHINE_ID,
    }),
  })
})

const { useMachineControl } = await import('../../store/machineControlStore')
const { useCamStore } = await import('../../store')
const { ProgramPanel } = await import('../../components/machine/ProgramPanel')
const { operationGenerationIsCurrent } = await import('../../lib/cam/generationFingerprint')
const {
  __resetEstopInterlockForTest,
  clearPathFidelity,
  connectMachine,
  disconnectMachine,
  getMachineController,
} = await import('../../lib/machine/machineSession')

function machine(): MachineConfig {
  const controllerDefinition = createDefaultControllerDefinition()
  for (const axis of controllerDefinition.axes) {
    axis.softLimitMin = axis.axis === 'Z' ? -50 : 0
    axis.softLimitMax = axis.axis === 'X' ? 600 : axis.axis === 'Y' ? 400 : 50
  }
  controllerDefinition.stated = controllerDefinition.axes.flatMap((axis) =>
    (['min', 'max'] as const).map((end) => ({
      controller: 'uccnc' as const,
      key: axisSoftLimitStatementKey(axis.axis, end),
    })),
  )
  // WO-1718: the machine definition is the one source of its VFD link; the
  // bridge is handed it on connect and never seeds it.
  return makeMachine({
    id: MACHINE_ID,
    name: 'WO-1334 Test Machine',
    controllerDefinition,
    spindleLinkDefinition: vfdLinkFromTemplate('huanyang-gt', MACHINE_ID),
  })
}

function moves(originX: number): ToolpathMove[] {
  return [
    { type: 'rapid', x: originX, y: 5, z: 12 },
    { type: 'feed', x: originX, y: 5, z: 1, feed: 300 },
    { type: 'feed', x: originX + 20, y: 5, z: 1, feed: 900 },
  ]
}

function setup(id: string, name: string, fixtureOffset: 54 | 55, originX: number): Setup {
  const operation: Operation = makeOp({
    id: `op-${id}`,
    name: `Op ${name}`,
    status: 'ready',
    toolpathMoves: moves(originX),
  })
  return {
    id,
    name,
    wcs: makeWcs({ label: `G${fixtureOffset}`, fixtureOffset, origin: { x: originX, y: 5, z: 2 } }),
    stock: makeStock(),
    operations: [operation],
    notes: '',
  }
}

function installCurrentProject(): Project {
  const activeMachine = machine()
  const tool = makeTool()
  const setups = [setup('setup-1', 'Setup 1', 54, 10), setup('setup-2', 'Setup 2', 55, 110)]
  const project: Project = {
    ...useCamStore.getState().project,
    machine: activeMachine,
    setups,
    activeSetupId: setups[0].id,
    toolLibrary: [tool],
  }
  for (const candidate of setups) {
    stampGenerationCurrent(project, candidate, candidate.operations[0], tool)
  }
  useCamStore.setState({
    project,
    toolLibrary: [tool],
    machineLibrary: [activeMachine],
    machineWorkOffsets: {},
  })
  return project
}

function idleStatus(): MachineStatus {
  return {
    state: 'idle',
    subState: null,
    machinePos: { x: 0, y: 0, z: 0 },
    workPos: { x: 0, y: 0, z: 0 },
    feedMmMin: 0,
    spindleRpm: 0,
    overrides: null,
    executingMoveId: 0,
    buffer: { moves: null, capacitySeconds: null },
    inputs: null,
    homed: null,
    spindle: null,
  }
}

function expectEveryOperationCurrent(): void {
  const project = useCamStore.getState().project
  for (const candidate of project.setups) {
    expect(candidate.operations[0].status).toBe('ready')
    expect(operationGenerationIsCurrent(project, candidate, candidate.operations[0])).toBe(true)
  }
}

async function connect(): Promise<void> {
  const pending = connectMachine('bridge')
  await vi.advanceTimersByTimeAsync(300)
  await pending
  act(() => {
    __resetEstopInterlockForTest()
    const socket = bridge.instances.at(-1)!
    socket.emit({ t: 'status', v: idleStatus() } as BridgeMessage)
    socket.emit({ t: 'homed', v: { axes: ['X', 'Y', 'Z'] } } as BridgeMessage)
  })
}

let originalState: ReturnType<typeof useCamStore.getState>

beforeEach(() => {
  vi.useFakeTimers()
  originalState = useCamStore.getState()
  bridge.instances.length = 0
  bridge.declared = {
    ...structuredClone(HUANYANG_GT),
    provenance: { kind: 'factory', source: 'WO-1334 fake bridge cache' },
  }
  installCurrentProject()
})

afterEach(async () => {
  cleanup()
  if (getMachineController().connectionPhase() !== 'disconnected') {
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(300)
    await pending
  }
  useCamStore.setState(originalState, true)
  useMachineControl.setState({ consoleLines: [] })
  clearPathFidelity()
  vi.useRealTimers()
})

describe('WO-1334 connecting does not outdate computed toolpaths', () => {
  it('keeps both setups current through connect, reconnect and in-place reopen, then loads all', async () => {
    const before = structuredClone(useCamStore.getState().project.machine)
    expectEveryOperationCurrent()

    await connect()
    const after = structuredClone(useCamStore.getState().project.machine)
    const changedMachineFields = Object.keys(after).filter((key) =>
      JSON.stringify(before[key as keyof MachineConfig]) !== JSON.stringify(after[key as keyof MachineConfig]),
    )
    // WO-1718: connect writes nothing to the machine record - the app pushes
    // the definition's own VFD link to the bridge instead of being seeded by it.
    expect(changedMachineFields).toEqual([])
    const pushed = bridge.instances.at(-1)!.sent.filter((call) => call.m === 'applyVfdDefinition')
    expect(pushed).toHaveLength(1)
    expect((pushed[0].a as { definition: MachineSpindleLinkDefinition }).definition)
      .toEqual(before.spindleLinkDefinition)
    expect(after.spindleLinkDefinition?.provenance).toMatchObject({ kind: 'edited-here' })
    expectEveryOperationCurrent()

    let pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(300)
    await pending
    await connect()
    expectEveryOperationCurrent()

    act(() => {
      bridge.instances.at(-1)!.emit({
        t: 'console',
        v: {
          dir: 'rx',
          text: '[bridge] THE CONTROLLER IS OPEN AGAIN (attempt 1) - this link is live.',
          severity: 'warn',
        },
      })
    })
    await vi.advanceTimersByTimeAsync(10)
    expectEveryOperationCurrent()

    render(<ProgramPanel />)
    fireEvent.click(screen.getByTestId('control-load-menu'))
    expect(screen.getByTestId('control-load-all-setups').textContent).toContain('All 2 setups')
    await act(async () => {
      fireEvent.click(screen.getByTestId('control-load-all-setups'))
      await vi.advanceTimersByTimeAsync(10)
    })
    expect(useMachineControl.getState().programReadiness.ready).toBe(true)
    expect(bridge.instances.at(-1)!.sent.filter((call) => call.m === 'loadMoves')).toHaveLength(1)

    act(() => {
      const setup2 = useCamStore.getState().project.setups[1]
      useCamStore.getState().updateSetup(setup2.id, {
        wcs: { ...setup2.wcs, origin: { ...setup2.wcs.origin, x: setup2.wcs.origin.x + 1 } },
      })
    })
    expect(useCamStore.getState().project.setups.map((candidate) => candidate.operations[0].status))
      .toEqual(['ready', 'outdated'])
  })
})
