// @vitest-environment jsdom
//
// WO-1874 - A PROGRAM THE BOARD REFUSED IS NEVER RUN AS THE OLD PROGRAM.
//
// WO-1835 Finding 1 (docs/audits/CONTROL-PATH-ADMISSION-2026-09-22.md, motion
// hazard): `UccncController.loadProgram` validated app-side, sent the staging
// frame with `fireAndForget`, and returned `{ok:true}` unconditionally. The
// bridge answers a protocol SUCCESS whose value carries `{ok:false, reason}`
// when `Machine.LoadMoves` refuses (Bridge.cs, case "loadMoves"), and that
// refusal leaves `staged` untouched - so the PREVIOUS program stays on the
// board. The app threw the answer away, armed the new program's cuts and parts,
// and Cycle Start started the program that was there before.
//
// WHAT IS PROVEN HERE, on the real session singleton talking to a real
// `UccncController` over a fake bridge socket, read off what reached THE WIRE:
//
//   - a bridge that answers `loadMoves` with `{ok:false, reason:"X"}` leaves the
//     load reported as not-ok with X, writes a console line naming `loadMoves`
//     and X, and leaves the session holding no armed program;
//   - after that refusal, CYCLE START is refused and NO `startJob` frame goes
//     out - the program staged before it is not started;
//   - a bridge that answers `{ok:true}` loads, arms and starts exactly as it
//     always did.
//
// NOT CLAIMED: hardware. The physical check - a deliberately refused load on the
// real board, then Cycle Start, in air - is owed to the machine seat.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from '@testing-library/react'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransport,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, MachineStatus } from '../../lib/machine/controller'
import { createDefaultControllerDefinition, type MachineConfig, type Project } from '../../types'
import { makeMachine } from '../post/helpers'
import { axisSoftLimitStatementKey } from '../../lib/machine/resolvedMachineMotion'
import { typedMock } from '../support/typedMock'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

/** Operator's AXBB-E as the bridge reports it: no G-code interpreter. */
const PROGRAM_BRIDGE_CAPABILITIES: ControllerCapabilities = {
  geometryQueue: true,
  executingMoveId: true,
  bufferSeconds: true,
  gcodeText: false,
  machineProgram: true,
  perAxisHoming: true,
  ownsSpindle: false,
  spindleCommands: false,
}

const G54_OFFSET = { x: 10, y: 5, z: 2 }
const UNSET = { x: 0, y: 0, z: 0 }

/** What the fake board answers the next `loadMoves` with. `null` = it takes it,
 *  which is the answer the real bridge gives whenever `Machine.LoadMoves`
 *  succeeds. A string is the board's own refusal, in its own words. */
let refuseLoadWith: string | null = null

interface FakeBridgeTransport extends BridgeTransport {
  sent: BridgeCallMessage[]
  emit(message: BridgeMessage): void
}

const bridgeSockets: FakeBridgeTransport[] = []

vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()
  class Fake extends actual.BridgeTransport {
    static isSupported(): boolean { return true }
    sent: BridgeCallMessage[] = []
    private fakeEvents: BridgeTransportEvents | null = null

    constructor(...args: ConstructorParameters<typeof actual.BridgeTransport>) {
      super(...args)
      bridgeSockets.push(this)
    }

    async start(events: BridgeTransportEvents): Promise<void> {
      this.fakeEvents = events
      const offsets = {
        G54: { ...G54_OFFSET },
        G55: { ...UNSET },
        G56: { ...UNSET },
        G57: { ...UNSET },
        G58: { ...UNSET },
        G59: { ...UNSET },
      }
      events.onMessage({
        t: 'hello',
        v: {
          protocol: 1,
          bridge: 'wo-1874-fake 0.0',
          capabilities: PROGRAM_BRIDGE_CAPABILITIES,
          readOnly: false,
          workOffsets: { current: offsets, profile: offsets },
        },
      } as BridgeMessage)
    }

    send(message: BridgeCallMessage): void {
      this.sent.push(message)
      if (message.m === 'selectWcs') {
        this.fakeEvents?.onMessage({ t: 'reply', seq: message.seq, ok: true, v: true })
      }
      // THE SHAPE Bridge.cs ACTUALLY SENDS: a protocol success whose VALUE
      // carries the refusal. `ok` at the envelope level stays true.
      if (message.m === 'loadMoves') {
        this.fakeEvents?.onMessage({
          t: 'reply',
          seq: message.seq,
          ok: true,
          v: refuseLoadWith === null
            ? { ok: true, reason: null }
            : { ok: false, reason: refuseLoadWith },
        })
      }
      if (message.m === 'setWorkOffset') {
        const a = message.a as { wcs: string; x?: number; y?: number; z?: number }
        this.fakeEvents?.onMessage({
          t: 'reply',
          seq: message.seq,
          ok: true,
          v: { ok: true, offset: { x: a.x ?? 0, y: a.y ?? 0, z: a.z ?? 0 } },
        })
      }
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
    BridgeTransport: Fake,
  })
})

const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineActions } = await import('../../store/machineActionsStore')
const { useCamStore } = await import('../../store')
const { executeOperatorCycleStart } = await import('../../lib/machine/operatorTransport')
const {
  __resetEstopInterlockForTest,
  clearPathFidelity,
  connectMachine,
  disconnectMachine,
  getMachineController,
  loadGcodeTextToolpathProgram,
} = await import('../../lib/machine/machineSession')

const MACHINE_ID = 'wo1874-machine'

function machine(): MachineConfig {
  const controllerDefinition = createDefaultControllerDefinition()
  for (const axis of controllerDefinition.axes) {
    axis.softLimitMin = axis.axis === 'Z' ? -150 : 0
    axis.softLimitMax = axis.axis === 'X' ? 600 : axis.axis === 'Y' ? 400 : 150
  }
  controllerDefinition.stated = controllerDefinition.axes.flatMap((axis) =>
    (['min', 'max'] as const).map((end) => ({
      controller: 'uccnc' as const,
      key: axisSoftLimitStatementKey(axis.axis, end),
    })),
  )
  controllerDefinition.outputs = []
  return makeMachine({
    id: MACHINE_ID,
    name: 'WO-1874 Machine',
    travel: { x: 600, y: 400, z: 300 },
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'min', homePositionMm: -150 },
    },
    rapidRate: 5000,
    controllerDefinition,
  })
}

function idleBridgeStatus(): MachineStatus {
  return {
    state: 'idle',
    subState: null,
    machinePos: { x: 0, y: 0, z: 0 },
    workPos: { x: 0, y: 0, z: 0 },
    feedMmMin: 0,
    spindleRpm: null,
    overrides: null,
    executingMoveId: 0,
    buffer: { moves: null, capacitySeconds: null },
    inputs: null,
    homed: null,
    spindle: null,
  }
}

let originalProject: Project

beforeEach(() => {
  vi.useFakeTimers()
  bridgeSockets.length = 0
  refuseLoadWith = null
  useMachineActions.setState({ byMachine: {} })
  originalProject = useCamStore.getState().project
  useCamStore.setState({ project: { ...originalProject, machine: machine(), setups: [] } })
})

afterEach(async () => {
  if (getMachineController().connectionPhase() !== 'disconnected') {
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(300)
    await pending
  }
  useCamStore.setState({ project: originalProject, machineWorkOffsets: {} })
  clearPathFidelity()
  useMachineControl.setState({ consoleLines: [] })
  vi.useRealTimers()
})

function socket(): FakeBridgeTransport {
  return bridgeSockets[bridgeSockets.length - 1]
}

async function connect(): Promise<void> {
  const pending = connectMachine('bridge')
  await vi.advanceTimersByTimeAsync(300)
  await pending
  act(() => { __resetEstopInterlockForTest() })
  act(() => {
    socket().emit({ t: 'status', v: idleBridgeStatus() } as BridgeMessage)
    socket().emit({ t: 'homed', v: { axes: ['X', 'Y', 'Z'] } } as BridgeMessage)
  })
}

const NC_A = 'G21 G90 G54\nG0 X10 Y10 Z5\nG1 Z-1 F300\nG0 Z5\nM30\n'
const NC_B = 'G21 G90 G54\nG0 X40 Y40 Z5\nG1 Z-2 F300\nG0 Z5\nM30\n'

/** Every call method that left for the bridge, in wire order. */
function wire(from = 0): string[] {
  return socket().sent.slice(from).map((m) => m.m)
}

function consoleText(): string {
  return useMachineControl.getState().consoleLines.map((line) => line.text).join('\n')
}

/** Open a file through the app's own door and let the board answer. */
async function load(name: string, text: string): Promise<{ ok: boolean; reason: string | null }> {
  let outcome: { ok: boolean; reason: string | null } = { ok: false, reason: 'not run' }
  await act(async () => {
    outcome = loadGcodeTextToolpathProgram(name, text)
    await vi.advanceTimersByTimeAsync(20)
  })
  return outcome
}

async function cycleStart(): Promise<boolean> {
  let accepted = false
  await act(async () => {
    accepted = await executeOperatorCycleStart()
    await vi.advanceTimersByTimeAsync(20)
  })
  return accepted
}

/** The board's own answer to the load the controller last sent (WO-1874). */
function stagedLoadVerdict(): Promise<{ ok: boolean; reason: string | null }> | null {
  const ctrl = getMachineController() as {
    stagedLoadVerdict?: () => Promise<{ ok: boolean; reason: string | null }> | null
  }
  return ctrl.stagedLoadVerdict?.() ?? null
}

const REFUSAL = 'the program frame is missing, so nothing was staged'

describe('WO-1874: a program the board refused is never run as the old program', () => {
  beforeEach(async () => { await connect() })

  it('reports the load as not-ok in the board\'s own words and arms nothing', async () => {
    refuseLoadWith = REFUSAL
    await load('refused.nc', NC_B)

    await expect(stagedLoadVerdict()).resolves.toEqual({ ok: false, reason: REFUSAL })

    // The bridge's own reason reaches the operator on the console, against the
    // call it answered - COHESION-STANDARD s13, console not banners.
    expect(consoleText()).toContain(`loadMoves: ${REFUSAL}`)

    const state = useMachineControl.getState()
    expect(state.programReadiness.ready).toBe(false)
    expect(state.programReadiness.reason).toContain(REFUSAL)
    // Nothing in the session says the refused program is loaded.
    expect(state.job.name).toBeNull()
    expect(state.stagedProgram).toBeNull()
  })

  it('does not start the previously staged program after a refused load', async () => {
    // Program A is on the board and armed, the honest way.
    expect(await load('accepted.nc', NC_A)).toEqual({ ok: true, reason: null })
    expect(useMachineControl.getState().programReadiness.ready).toBe(true)

    // The operator opens a second file; the board refuses to stage it, which
    // leaves A staged - `Machine.LoadMoves` refuses without touching `staged`.
    refuseLoadWith = REFUSAL
    await load('refused.nc', NC_B)

    const mark = socket().sent.length
    expect(await cycleStart()).toBe(false)
    // THE WHOLE POINT, READ OFF THE WIRE: no start frame for program A.
    expect(wire(mark)).not.toContain('startJob')
    expect(wire(mark)).not.toContain('stepJob')
  })

  it('loads, arms and starts unchanged when the board takes the program', async () => {
    refuseLoadWith = null
    expect(await load('accepted.nc', NC_A)).toEqual({ ok: true, reason: null })

    const state = useMachineControl.getState()
    expect(state.programReadiness.ready).toBe(true)
    expect(state.job.name).toBe('accepted.nc')
    await expect(stagedLoadVerdict()).resolves.toEqual({ ok: true, reason: null })

    const mark = socket().sent.length
    expect(await cycleStart()).toBe(true)
    expect(wire(mark)).toContain('startJob')
    expect(consoleText()).not.toContain('loadMoves:')
  })

  it('treats a bridge that answers nothing about the load exactly as before', async () => {
    // An older bridge answers `loadMoves` with a bare `true`. That is not a
    // refusal - it is a bridge that does not answer this question - and
    // inventing one out of its silence would refuse a load the board took
    // (LIENCAM.md rule 11).
    const original = socket().send.bind(socket())
    const patched = socket() as unknown as { send: (m: BridgeCallMessage) => void }
    patched.send = (message: BridgeCallMessage) => {
      if (message.m !== 'loadMoves') { original(message); return }
      socket().sent.push(message)
      socket().emit({ t: 'reply', seq: message.seq, ok: true, v: true } as BridgeMessage)
    }

    expect(await load('old-bridge.nc', NC_A)).toEqual({ ok: true, reason: null })
    expect(useMachineControl.getState().programReadiness.ready).toBe(true)
    expect(useMachineControl.getState().job.name).toBe('old-bridge.nc')
    expect(consoleText()).not.toContain('loadMoves:')
  })
})
