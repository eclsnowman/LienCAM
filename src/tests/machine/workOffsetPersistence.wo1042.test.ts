import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  persistMerge,
  persistPartialize,
  useCamStore,
  type WorkOffsetSyncState,
} from '../../store'
import { useMachineControl } from '../../store/machineControlStore'
import {
  buildContractEvents,
  machineWorkOffsetWriteInFlight,
  reconcileWorkOffsetsOnConnect,
  setWorkOffsetValue,
  WORK_OFFSET_WRITE_BUSY,
  workGotoZeroRefusal,
  zeroWorkAxes,
} from '../../lib/machine/machineSession'
import { UccncController, SUPPORTED_BRIDGE_PROTOCOL } from '../../lib/machine/uccncController'
import type { UccncTransport } from '../../lib/machine/uccncController'
import type {
  BridgeCallMessage,
  BridgeHelloPush,
  BridgeMessage,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type {
  ControllerCapabilities,
  ControllerEvents,
  MachineController,
  MachineStatus,
  ZeroWorkAxisReceipt,
} from '../../lib/machine/controller'
import type { MachineVec3, WcsId } from '../../lib/machine/types'
import { SimulatedController } from '../../lib/machine/simulatedController'

const WCS: WcsId[] = ['G54', 'G55', 'G56', 'G57', 'G58', 'G59']
const SAMPLE_MACHINE_PROFILE: MachineVec3 = { x: 81.2275, y: 61.3225, z: 12.16 }
const ZERO: MachineVec3 = { x: 0, y: 0, z: 0 }

const NO_CAPS: ControllerCapabilities = {
  geometryQueue: false,
  executingMoveId: false,
  bufferSeconds: false,
  gcodeText: false,
  perAxisHoming: false,
  ownsSpindle: false,
  spindleCommands: false,
}

function allOffsets(g54: MachineVec3): Record<WcsId, MachineVec3> {
  return Object.fromEntries(WCS.map((wcs) => [wcs, wcs === 'G54' ? { ...g54 } : { ...ZERO }])) as Record<WcsId, MachineVec3>
}

class FakeTransport implements UccncTransport {
  events: BridgeTransportEvents | null = null
  sent: BridgeCallMessage[] = []
  held = allOffsets(SAMPLE_MACHINE_PROFILE)
  refuseWrites = false

  async start(events: BridgeTransportEvents): Promise<void> {
    this.events = events
  }

  send(message: BridgeCallMessage): void {
    this.sent.push(message)
    if (message.m !== 'setWorkOffset') return
    const wcs = message.a?.wcs as WcsId
    const requested = message.a ?? {}
    const next = {
      ...this.held[wcs],
      ...(requested.x === undefined ? {} : { x: requested.x as number }),
      ...(requested.y === undefined ? {} : { y: requested.y as number }),
      ...(requested.z === undefined ? {} : { z: requested.z as number }),
    }
    if (!this.refuseWrites) this.held[wcs] = next
    queueMicrotask(() => this.emit({
      t: 'reply',
      seq: message.seq,
      ok: !this.refuseWrites,
      v: this.refuseWrites
        ? { ok: false, reason: 'refused by fixture', offset: null }
        : { ok: true, reason: null, offset: next },
      ...(this.refuseWrites ? { error: 'refused by fixture' } : {}),
    }))
  }

  async close(): Promise<void> {}

  emit(message: BridgeMessage): void {
    this.events?.onMessage(message)
  }
}

function controllerEvents(): ControllerEvents {
  return {}
}

async function connectedController(
  workOffsets?: NonNullable<BridgeHelloPush['v']['workOffsets']>,
): Promise<{ controller: UccncController; transport: FakeTransport }> {
  const controller = new UccncController(controllerEvents())
  const transport = new FakeTransport()
  if (workOffsets) transport.held = structuredClone(workOffsets.current)
  const connecting = controller.connect({ kind: 'messages', transport })
  transport.emit({
    t: 'hello',
    v: {
      protocol: SUPPORTED_BRIDGE_PROTOCOL,
      bridge: 'wo-1042-fixture',
      capabilities: NO_CAPS,
      readOnly: false,
      ...(workOffsets ? { workOffsets } : {}),
    },
  })
  await connecting
  return { controller, transport }
}

function setStored(
  machineId: string,
  offset: Partial<MachineVec3>,
  state: WorkOffsetSyncState = 'not-sent',
): void {
  useCamStore.getState().setMachineWorkOffset(machineId, 'G54', offset, state)
}

type OffsetReceipt = { ok: boolean; reason: string | null; offset: MachineVec3 | null }

/** A controller whose offset receipts are settled BY THE TEST, so a write can
 *  be held in flight for as long as a test needs. `accept(i)`/`refuse(i)`
 *  answer the i-th `setWorkOffset` call - and under the one-in-flight rule a
 *  multi-axis pass produces exactly ONE such call. */
function deferredOffsetController(): {
  controller: MachineController
  accept: (index: number, offset: MachineVec3) => void
  refuse: (index: number) => void
  calls: () => Array<{ wcs: WcsId; offset: Partial<MachineVec3> }>
} {
  const waiting: Array<(receipt: OffsetReceipt) => void> = []
  const calls: Array<{ wcs: WcsId; offset: Partial<MachineVec3> }> = []
  const controller = {
    setWorkOffset: (wcs: WcsId, offset: Partial<MachineVec3>) => {
      calls.push({ wcs, offset })
      return new Promise<OffsetReceipt>((resolve) => { waiting.push(resolve) })
    },
    refreshState: vi.fn(),
  } as unknown as MachineController
  return {
    controller,
    accept: (index, offset) => waiting[index]({ ok: true, reason: null, offset }),
    refuse: (index) => waiting[index]({ ok: false, reason: 'refused by fixture', offset: null }),
    calls: () => calls,
  }
}

/** The shape EVERY real multi-axis caller has: `applyProbeZero`
 *  (`pendantMachine.ts:361-363`), the Confirm loop in
 *  `ProbeRoutineRunPanel.tsx:114-117` and the one in
 *  `ProbingPanel.tsx:1929-1934` all dispatch two or three axes of ONE WCS
 *  synchronously. Under the one-in-flight rule those axes JOIN one intent -
 *  they must never become competing writes, and none of them may be refused
 *  by the slot its own siblings took. */
function dispatchAxes(
  wcs: WcsId,
  values: Partial<Record<'X' | 'Y' | 'Z', number>>,
  controller: MachineController,
): void {
  for (const axis of ['X', 'Y', 'Z'] as const) {
    const value = values[axis]
    if (value !== undefined) expect(setWorkOffsetValue(wcs, axis, value, controller)).toBe(true)
  }
}

/** One status frame, delivered exactly the way a contract backend delivers it:
 *  through the events object `machineSession` hands every backend. */
function deliverStatus(machinePos: MachineVec3, workPos: MachineVec3): void {
  buildContractEvents().onStatus?.({ machinePos, workPos } as MachineStatus)
}

/** A connection reporting position, with `offset` as the active WCS's value
 *  and `at` as where the tool is. After WO-1083 these frames are scenery: the
 *  store may not read one, and the tests below hold them to that. */
function reportingOffset(offset: MachineVec3, at: MachineVec3 = { x: 12, y: 20, z: 30 }): void {
  deliverStatus(at, { x: at.x - offset.x, y: at.y - offset.y, z: at.z - offset.z })
}

/** A controller whose `zeroWorkAxis` answers WO-1083's receipt: the WHOLE WCS
 *  row after the write, from the backend that applied it. `row` is what the
 *  bridge holds once this axis is zeroed. */
function receiptZeroController(
  row: (axis: 'X' | 'Y' | 'Z') => MachineVec3 | undefined,
  wcs?: WcsId,
): MachineController & { refreshState: ReturnType<typeof vi.fn> } {
  return {
    zeroWorkAxis: vi.fn(() => true),
    zeroWorkAxisAwait: vi.fn((axis: 'X' | 'Y' | 'Z') => {
      const offset = row(axis)
      return Promise.resolve(offset ? { confirmed: true, wcs, offset } : { confirmed: true, wcs })
    }),
    refreshState: vi.fn(),
  } as unknown as MachineController & { refreshState: ReturnType<typeof vi.fn> }
}

/** WO-1083's predecessor: a bridge that applies the zero and answers a bare
 *  `true`. The receipt reader turns that into `{confirmed: true}` with no
 *  `offset` - "applied, cannot say". */
function oldBridgeZeroController(): MachineController & { refreshState: ReturnType<typeof vi.fn> } {
  return receiptZeroController(() => undefined)
}

/** WO-1017's gate only exists on a machine with no home switches, so every
 *  test of what a stored offset may buy has to be on one. */
function switchlessMachine(): void {
  const machine = useCamStore.getState().project.machine
  useCamStore.getState().updateMachine({ ...machine, noHomingSwitches: true })
}

describe('WO-1042: app-owned work offsets', () => {
  let machineId: string

  beforeEach(() => {
    machineId = useCamStore.getState().project.machine.id
    useCamStore.setState({ machineWorkOffsets: {} })
    // A real reconnect boundary, delivered the way a backend delivers it.
    // Repeating `connected` is now deliberately detail-only (WO-1148), so the
    // connecting edge is what gives each test its fresh session revision.
    useMachineControl.setState({ consoleLines: [] })
    buildContractEvents().onConnectionPhase?.('connecting', null)
    buildContractEvents().onConnectionPhase?.('connected', null)
    useMachineControl.setState({ activeWcs: 'G54' })
  })

  it('older hello: restores every stored WCS before the active WCS is known', async () => {
    setStored(machineId, { x: 7, y: 8, z: 9 })
    useCamStore.getState().setMachineWorkOffset(machineId, 'G55', { x: 4, y: 5, z: 6 }, 'not-sent')
    useMachineControl.setState({ activeWcs: null })
    const { controller, transport } = await connectedController()

    expect(useMachineControl.getState().activeWcs).toBeNull()
    await reconcileWorkOffsetsOnConnect(machineId, controller)

    const restoreCalls = transport.sent.filter((call) => call.m === 'setWorkOffset')
    expect(restoreCalls).toHaveLength(2)
    expect(restoreCalls).toMatchObject([
      { m: 'setWorkOffset', a: { wcs: 'G54', x: 7, y: 8, z: 9 } },
      { m: 'setWorkOffset', a: { wcs: 'G55', x: 4, y: 5, z: 6 } },
    ])
    expect(transport.sent.some((call) => call.m === 'sendCommand')).toBe(false)
    expect(useCamStore.getState().machineWorkOffsets[machineId]?.G54?.state).toBe('restored')
    expect(useCamStore.getState().machineWorkOffsets[machineId]?.G55?.state).toBe('restored')
  })

  it('profile-less hello with default zeros restores a held store value', async () => {
    setStored(machineId, { x: 7, y: 8, z: 9 })
    useMachineControl.setState({ activeWcs: null })
    const { controller, transport } = await connectedController({
      current: allOffsets(ZERO),
      profile: null,
    })

    await reconcileWorkOffsetsOnConnect(machineId, controller)

    const restoreCalls = transport.sent.filter((call) => call.m === 'setWorkOffset')
    expect(restoreCalls).toHaveLength(1)
    expect(restoreCalls).toMatchObject([
      { m: 'setWorkOffset', a: { wcs: 'G54', x: 7, y: 8, z: 9 } },
    ])
  })

  it('profile-less hello with an empty store adopts nothing and records unknown provenance', async () => {
    useMachineControl.setState({ activeWcs: null })
    const { controller, transport } = await connectedController({
      current: allOffsets(ZERO),
      profile: null,
    })

    expect(useMachineControl.getState().activeWcs).toBeNull()
    await reconcileWorkOffsetsOnConnect(machineId, controller)

    expect(useCamStore.getState().machineWorkOffsets[machineId]?.G54).toEqual({
      offset: {},
      state: 'unknown',
    })
    expect(useCamStore.getState().machineWorkOffsets[machineId]?.G59).toEqual({
      offset: {},
      state: 'unknown',
    })
    expect(transport.sent.filter((call) => call.m === 'setWorkOffset')).toHaveLength(0)
    expect(useMachineControl.getState().consoleLines.some(
      (line) => line.text.includes('has no stored zero for G54'),
    )).toBe(true)
  })

  it('profile-less hello with a nonzero current value pushes this software\'s value and says so (WO-1182)', async () => {
    const stored = { x: 7, y: 8, z: 9 }
    setStored(machineId, stored)
    const { controller, transport } = await connectedController({
      current: allOffsets(SAMPLE_MACHINE_PROFILE),
      profile: null,
    })

    await reconcileWorkOffsetsOnConnect(machineId, controller)

    expect(transport.sent.filter((call) => call.m === 'setWorkOffset')).toMatchObject([
      { m: 'setWorkOffset', a: { wcs: 'G54', ...stored } },
    ])
    expect(useMachineControl.getState().consoleLines.some(
      (line) => line.text.includes("sending this software's"),
    )).toBe(true)
    expect(useMachineControl.getState().consoleLines.some((line) => line.text.includes('not changed'))).toBe(false)
  })

  it('a normal connect after a profile-less connect restores the stored value, never defaults', async () => {
    const stored = { x: 10, y: 20, z: 30 }
    setStored(machineId, stored)
    const first = await connectedController({ current: allOffsets(ZERO), profile: null })

    await reconcileWorkOffsetsOnConnect(machineId, first.controller)
    expect(first.transport.sent.filter((call) => call.m === 'setWorkOffset')).toMatchObject([
      { m: 'setWorkOffset', a: { wcs: 'G54', ...stored } },
    ])

    const second = await connectedController({
      current: allOffsets(SAMPLE_MACHINE_PROFILE),
      profile: allOffsets(SAMPLE_MACHINE_PROFILE),
    })
    await reconcileWorkOffsetsOnConnect(machineId, second.controller)

    const restoreCalls = second.transport.sent.filter((call) => call.m === 'setWorkOffset')
    expect(restoreCalls).toHaveLength(1)
    expect(restoreCalls).toMatchObject([{ m: 'setWorkOffset', a: { wcs: 'G54', ...stored } }])
    expect(restoreCalls[0]?.a).not.toMatchObject(ZERO)
  })

  it('a partial work zero never makes profile-less default axes durable or overwrites a later profile seed', async () => {
    setStored(machineId, { x: 7 }, 'sent')
    const first = await connectedController({ current: allOffsets(ZERO), profile: null })

    await reconcileWorkOffsetsOnConnect(machineId, first.controller)

    const firstRestoreCalls = first.transport.sent.filter((call) => call.m === 'setWorkOffset')
    expect(firstRestoreCalls).toHaveLength(1)
    expect(firstRestoreCalls[0]?.a).toEqual({ wcs: 'G54', x: 7 })
    expect(useCamStore.getState().machineWorkOffsets[machineId]?.G54).toEqual({
      offset: { x: 7 },
      state: 'restored',
    })

    const second = await connectedController({
      current: allOffsets(SAMPLE_MACHINE_PROFILE),
      profile: allOffsets(SAMPLE_MACHINE_PROFILE),
    })
    await reconcileWorkOffsetsOnConnect(machineId, second.controller)

    const secondRestoreCalls = second.transport.sent.filter((call) => call.m === 'setWorkOffset')
    expect(secondRestoreCalls).toHaveLength(1)
    expect(secondRestoreCalls[0]?.a).toEqual({ wcs: 'G54', x: 7 })
    expect(second.transport.held.G54).toEqual({
      x: 7,
      y: SAMPLE_MACHINE_PROFILE.y,
      z: SAMPLE_MACHINE_PROFILE.z,
    })
    expect(useCamStore.getState().machineWorkOffsets[machineId]?.G54).toEqual({
      offset: { x: 7 },
      state: 'restored',
    })
  })

  it('empty store: adopts the real profile-seeded G54 and zero G55-G59 without sending', async () => {
    const offsets = { current: allOffsets(SAMPLE_MACHINE_PROFILE), profile: allOffsets(SAMPLE_MACHINE_PROFILE) }
    const { controller, transport } = await connectedController(offsets)

    await reconcileWorkOffsetsOnConnect(machineId, controller)

    expect(useCamStore.getState().machineWorkOffsets[machineId]?.G54).toEqual({
      offset: SAMPLE_MACHINE_PROFILE,
      state: 'adopted-from-profile',
    })
    expect(useCamStore.getState().machineWorkOffsets[machineId]?.G59).toEqual({
      offset: ZERO,
      state: 'adopted-from-profile',
    })
    expect(transport.sent.filter((call) => call.m === 'setWorkOffset')).toHaveLength(0)
  })

  it('bridge still equals profile: restores a differing stored offset', async () => {
    const stored = { x: 10, y: 20, z: 30 }
    setStored(machineId, stored)
    const offsets = { current: allOffsets(SAMPLE_MACHINE_PROFILE), profile: allOffsets(SAMPLE_MACHINE_PROFILE) }
    const { controller, transport } = await connectedController(offsets)

    await reconcileWorkOffsetsOnConnect(machineId, controller)

    expect(transport.held.G54).toEqual(stored)
    expect(useCamStore.getState().machineWorkOffsets[machineId]?.G54).toEqual({
      offset: stored,
      state: 'restored',
    })
    const machinePos = { x: 100, y: 200, z: 300 }
    transport.emit({
      t: 'status',
      v: {
        ...controller.status(),
        state: 'idle',
        machinePos,
        workPos: {
          x: machinePos.x - stored.x,
          y: machinePos.y - stored.y,
          z: machinePos.z - stored.z,
        },
      },
    })
    expect(controller.status().workPos).toEqual({ x: 90, y: 180, z: 270 })
  })

  it('bridge and store agree: sends nothing', async () => {
    setStored(machineId, SAMPLE_MACHINE_PROFILE)
    const offsets = { current: allOffsets(SAMPLE_MACHINE_PROFILE), profile: allOffsets(SAMPLE_MACHINE_PROFILE) }
    const { controller, transport } = await connectedController(offsets)

    await reconcileWorkOffsetsOnConnect(machineId, controller)

    expect(transport.sent.filter((call) => call.m === 'setWorkOffset')).toHaveLength(0)
    expect(useCamStore.getState().machineWorkOffsets[machineId]?.G54?.state).toBe('restored')
  })

  it('bridge changed this session and differs from store: this software\'s value is pushed (WO-1182)', async () => {
    setStored(machineId, { x: 10, y: 20, z: 30 })
    const current = allOffsets(SAMPLE_MACHINE_PROFILE)
    current.G54 = { x: 90, y: 91, z: 92 }
    const offsets = { current, profile: allOffsets(SAMPLE_MACHINE_PROFILE) }
    const { controller, transport } = await connectedController(offsets)

    await reconcileWorkOffsetsOnConnect(machineId, controller)

    expect(transport.sent.filter((call) => call.m === 'setWorkOffset')).toMatchObject([
      { m: 'setWorkOffset', a: { wcs: 'G54', x: 10, y: 20, z: 30 } },
    ])
    expect(useMachineControl.getState().consoleLines.some((line) => line.text.includes('not changed'))).toBe(false)
  })

  it('bridge changed this session but equals store: sends nothing', async () => {
    const changed = { x: 90, y: 91, z: 92 }
    setStored(machineId, changed)
    const current = allOffsets(SAMPLE_MACHINE_PROFILE)
    current.G54 = changed
    const { controller, transport } = await connectedController({ current, profile: allOffsets(SAMPLE_MACHINE_PROFILE) })

    await reconcileWorkOffsetsOnConnect(machineId, controller)

    expect(transport.sent.filter((call) => call.m === 'setWorkOffset')).toHaveLength(0)
    expect(useCamStore.getState().machineWorkOffsets[machineId]?.G54?.state).toBe('restored')
  })

  it('empty store takes the bridge\'s session value - the controller has one, so it is used (WO-1182)', async () => {
    const current = allOffsets(SAMPLE_MACHINE_PROFILE)
    current.G54 = { x: 90, y: 91, z: 92 }
    const { controller, transport } = await connectedController({
      current,
      profile: allOffsets(SAMPLE_MACHINE_PROFILE),
    })

    await reconcileWorkOffsetsOnConnect(machineId, controller)

    expect(transport.sent.filter((call) => call.m === 'setWorkOffset')).toHaveLength(0)
    expect(useCamStore.getState().machineWorkOffsets[machineId]?.G54).toEqual({
      offset: { x: 90, y: 91, z: 92 },
      state: 'restored',
    })
  })

  it('accepted setWorkOffset receipt updates the store; a refusal does not', async () => {
    setStored(machineId, { y: 2 }, 'not-sent')
    const accepted = {
      setWorkOffset: vi.fn(async () => ({ ok: true, reason: null, offset: { x: 5, y: 2, z: 3 } })),
      refreshState: vi.fn(),
    } as unknown as MachineController
    expect(setWorkOffsetValue('G54', 'X', 5, accepted)).toBe(true)
    await vi.waitFor(() => {
      expect(useCamStore.getState().machineWorkOffsets[machineId]?.G54).toEqual({
        offset: { x: 5, y: 2 },
        state: 'sent',
      })
    })

    const refused = {
      setWorkOffset: vi.fn(async () => ({ ok: false, reason: 'no', offset: null })),
      refreshState: vi.fn(),
    } as unknown as MachineController
    expect(setWorkOffsetValue('G54', 'X', 99, refused)).toBe(true)
    await vi.waitFor(() => expect(machineWorkOffsetWriteInFlight(machineId)).toBe(false))
    expect(refused.setWorkOffset).toHaveBeenCalledOnce()
    expect(useCamStore.getState().machineWorkOffsets[machineId]?.G54).toEqual({
      offset: { x: 5, y: 2 },
      state: 'sent',
    })
  })

  it('a refused connect restore leaves the durable value not-sent', async () => {
    setStored(machineId, { x: 7, y: 8, z: 9 }, 'sent')
    const { controller, transport } = await connectedController()
    transport.refuseWrites = true

    await reconcileWorkOffsetsOnConnect(machineId, controller)

    expect(useCamStore.getState().machineWorkOffsets[machineId]?.G54).toEqual({
      offset: { x: 7, y: 8, z: 9 },
      state: 'not-sent',
    })
  })

  // ---------------------------------------------------------------------
  // THE RACE CLASS HAS NO CODE TO LIVE IN. Ten audit rounds of this order died
  // inside code that worked a work offset out of a status frame. WO-1083 gave
  // the zero receipt the echo the set receipt always had, so the value comes
  // from the thread that applied the write; these tests hold the store to it.
  // ---------------------------------------------------------------------

  it('fifty arbitrary status frames across a zero write nothing at all', async () => {
    // The frames deliberately disagree with each other and with the zero: the
    // bridge samples status on its own loop, so a frame describing the world
    // BEFORE the zero can be delivered after its receipt. None of them is a
    // source of truth any more, so none of them may leave a mark.
    for (let i = 0; i < 25; i++) reportingOffset({ x: i, y: i * 2, z: i * 3 }, { x: i + 1, y: i, z: i })
    expect(useCamStore.getState().machineWorkOffsets[machineId]).toBeUndefined()

    const stub = receiptZeroController(() => ({ x: 12, y: 20, z: 30 }))
    expect(zeroWorkAxes(['X'], stub).ok).toBe(true)
    await vi.waitFor(() => expect(stub.refreshState).toHaveBeenCalledOnce())

    const afterReceipt = useCamStore.getState().machineWorkOffsets[machineId]?.G54
    expect(afterReceipt).toEqual({ offset: { x: 12 }, state: 'sent' })

    for (let i = 0; i < 25; i++) reportingOffset({ x: -i, y: i * 7, z: 99 - i }, { x: i, y: i, z: i })
    // Byte for byte what the receipt wrote. Not one frame moved it.
    expect(useCamStore.getState().machineWorkOffsets[machineId]?.G54).toEqual(afterReceipt)
  })

  it('a zero on a connection that has never reported a position still stores the receipt', async () => {
    // Attempt 5 refused this case: with no frame to measure against, nothing
    // could be proven. The value no longer comes from a frame, so a first zero
    // on a silent connection is now stored like any other.
    const stub = receiptZeroController(() => ({ x: 4, y: 5, z: 6 }))

    expect(zeroWorkAxes(['Z'], stub).ok).toBe(true)
    await vi.waitFor(() => expect(stub.refreshState).toHaveBeenCalledOnce())

    expect(useCamStore.getState().machineWorkOffsets[machineId]?.G54).toEqual({
      offset: { z: 6 },
      state: 'sent',
    })
  })

  it('an OLD bridge confirms without an offset: nothing is stored, and it says why', async () => {
    const stub = oldBridgeZeroController()

    expect(zeroWorkAxes(['X', 'Y'], stub).ok).toBe(true)
    await vi.waitFor(() => expect(stub.refreshState).toHaveBeenCalledOnce())

    expect(useCamStore.getState().machineWorkOffsets[machineId]).toBeUndefined()
    expect(useMachineControl.getState().consoleLines.some(
      (line) => line.text.includes('does not report the resulting offset'),
    )).toBe(true)

    // ...and no status frame may fill the hole it left.
    reportingOffset({ x: 12, y: 20, z: 30 })
    expect(useCamStore.getState().machineWorkOffsets[machineId]).toBeUndefined()
  })

  it('an old bridge still arms WO-1017 - the operator zeroed here, only the memory is lost', async () => {
    switchlessMachine()
    const stub = oldBridgeZeroController()

    expect(workGotoZeroRefusal(['X'])).not.toBeNull()
    expect(zeroWorkAxes(['X'], stub).ok).toBe(true)
    await vi.waitFor(() => expect(stub.refreshState).toHaveBeenCalledOnce())

    expect(workGotoZeroRefusal(['X'])).toBeNull()
    expect(useCamStore.getState().machineWorkOffsets[machineId]).toBeUndefined()
  })

  it('a receipt that does NOT confirm writes nothing and arms nothing', async () => {
    switchlessMachine()
    const stub = {
      zeroWorkAxisAwait: vi.fn(() => Promise.resolve({ confirmed: false })),
      refreshState: vi.fn(),
    } as unknown as MachineController

    zeroWorkAxes(['X'], stub)
    await vi.waitFor(() => expect(stub.refreshState).toHaveBeenCalledOnce())

    expect(useCamStore.getState().machineWorkOffsets[machineId]).toBeUndefined()
    expect(workGotoZeroRefusal(['X'])).not.toBeNull()
  })

  it('the receipt names the system it zeroed in, and that is where the value lands', async () => {
    // The app thinks G54 is active; the bridge answers that it zeroed G55. The
    // machine is the authority on which system it wrote, so the value is
    // stored - and WO-1017 armed - under the bridge's answer, not the app's.
    switchlessMachine()
    const stub = receiptZeroController(() => ({ x: 7, y: 8, z: 9 }), 'G55')

    expect(zeroWorkAxes(['X'], stub).ok).toBe(true)
    await vi.waitFor(() => expect(stub.refreshState).toHaveBeenCalledOnce())

    expect(useCamStore.getState().machineWorkOffsets[machineId]?.G54).toBeUndefined()
    expect(useCamStore.getState().machineWorkOffsets[machineId]?.G55).toEqual({
      offset: { x: 7 },
      state: 'sent',
    })
    // The app is still pointing at G54, which nobody established, so the gate
    // keeps refusing rather than borrowing G55's zero.
    expect(workGotoZeroRefusal(['X'])).not.toBeNull()
  })

  it('the SIMULATOR writes the store through the same table', async () => {
    const sim = new SimulatedController({})
    sim.selectWcs('G54')
    // Zeroing an axis sets its offset to where the tool stands, so the stored
    // value must be the simulator's OWN machine position - read from it, not
    // assumed, and not taken from a frame.
    const at = sim.status().machinePos!

    expect(zeroWorkAxes(['X', 'Z'], sim).ok).toBe(true)
    await vi.waitFor(() => {
      expect(useCamStore.getState().machineWorkOffsets[machineId]?.G54).toBeDefined()
    })

    // Y is deliberately absent: this pass never named it.
    expect(useCamStore.getState().machineWorkOffsets[machineId]?.G54).toEqual({
      offset: { x: at.x, z: at.z },
      state: 'sent',
    })
  })

  it('round-trips through the existing persisted root slice', () => {
    setStored(machineId, { x: 1, y: 2, z: 3 })
    useCamStore.getState().setMachineWorkOffsetLabel(machineId, 'G54', 'Left vise')
    const live = useCamStore.getState()
    const persisted = persistPartialize(live)
    const merged = persistMerge(persisted, { ...live, machineWorkOffsets: {} })

    expect(persisted.machineWorkOffsets[machineId]?.G54).toEqual({
      label: 'Left vise',
      offset: { x: 1, y: 2, z: 3 },
      state: 'not-sent',
    })
    expect(merged.machineWorkOffsets[machineId]?.G54).toEqual({
      label: 'Left vise',
      offset: { x: 1, y: 2, z: 3 },
      state: 'not-sent',
    })
  })

  it('never falls back to G10 text when a controller has no setWorkOffset intent', () => {
    const sendCommand = vi.fn(() => true)
    const legacy = { sendCommand } as unknown as MachineController

    expect(setWorkOffsetValue('G54', 'X', 1, legacy)).toBe(false)
    expect(sendCommand).not.toHaveBeenCalled()
  })

  it('preserves the acknowledged G10 write for a text-only backend', async () => {
    const sendCommandAwait = vi.fn(async () => ({ ok: true, message: null }))
    const textBackend = {
      capabilities: { gcodeText: true },
      sendCommandAwait,
      refreshState: vi.fn(),
    } as unknown as MachineController

    expect(setWorkOffsetValue('G55', 'X', 25, textBackend)).toBe(true)
    await Promise.resolve()
    expect(sendCommandAwait).toHaveBeenCalledWith('G10 L2 P2 X25')
    await vi.waitFor(() => {
      expect(useCamStore.getState().machineWorkOffsets[machineId]?.G55).toEqual({
        offset: { x: 25 },
        state: 'sent',
      })
    })
  })

  // ---------------------------------------------------------------------
  // WO-1042 attempt 4: the write-authority table. One test per row, so a
  // later change that widens who may write a stored offset breaks a test
  // named after the row it broke.
  // ---------------------------------------------------------------------

  it('table row 1 - a zeroWorkAxis receipt writes ONLY the axis it named, as sent', async () => {
    // The receipt echoes the WHOLE WCS row - X11 Y22 Z33 - because a caller
    // reconciling a coordinate system wants the system. Only Y may take
    // provenance from it: this command named Y and nothing else.
    const stub = receiptZeroController(() => ({ x: 11, y: 22, z: 33 }))

    expect(zeroWorkAxes(['Y'], stub).ok).toBe(true)
    await vi.waitFor(() => expect(stub.refreshState).toHaveBeenCalledOnce())

    expect(useCamStore.getState().machineWorkOffsets[machineId]?.G54).toEqual({
      offset: { y: 22 },
      state: 'sent',
    })
  })

  it('table row 2 - a typed value is stored by its RECEIPT, never optimistically', async () => {
    type Receipt = { ok: boolean; reason: string | null; offset: MachineVec3 | null }
    let settle!: (receipt: Receipt) => void
    const pending = new Promise<Receipt>((resolve) => { settle = resolve })
    const stub = {
      setWorkOffset: vi.fn(() => pending),
      refreshState: vi.fn(),
    } as unknown as MachineController

    expect(setWorkOffsetValue('G54', 'X', 5, stub)).toBe(true)
    await vi.waitFor(() => expect(stub.setWorkOffset).toHaveBeenCalledOnce())
    // Nothing durable yet. A number the machine has not accepted is not a
    // value this software may later push back onto the machine.
    expect(useCamStore.getState().machineWorkOffsets[machineId]?.G54).toBeUndefined()

    settle({ ok: true, reason: null, offset: { x: 5, y: 9, z: 9 } })
    await vi.waitFor(() => {
      expect(useCamStore.getState().machineWorkOffsets[machineId]?.G54).toEqual({
        offset: { x: 5 },
        state: 'sent',
      })
    })
  })

  it('table row 2 - a REFUSED typed value leaves no durable trace to push later', async () => {
    setStored(machineId, { x: 5, y: 2 }, 'sent')
    const refused = {
      setWorkOffset: vi.fn(async () => ({ ok: false, reason: 'no', offset: null })),
      refreshState: vi.fn(),
    } as unknown as MachineController

    expect(setWorkOffsetValue('G54', 'X', 99, refused)).toBe(true)
    await vi.waitFor(() => {
      expect(useCamStore.getState().machineWorkOffsets[machineId]?.G54).toEqual({
        offset: { x: 5, y: 2 },
        state: 'sent',
      })
    })

    // The proof that matters: the next connect must never push 99 at the
    // machine, because the machine already said no to it.
    const { controller, transport } = await connectedController()
    await reconcileWorkOffsetsOnConnect(machineId, controller)
    const pushed = transport.sent.filter((call) => call.m === 'setWorkOffset')
    expect(pushed).toMatchObject([{ m: 'setWorkOffset', a: { wcs: 'G54', x: 5, y: 2 } }])
  })

  it('table row 2 - a refused typed value on an EMPTY slot leaves nothing stored', async () => {
    const refused = {
      setWorkOffset: vi.fn(async () => ({ ok: false, reason: 'no', offset: null })),
      refreshState: vi.fn(),
    } as unknown as MachineController

    expect(setWorkOffsetValue('G56', 'Z', 42, refused)).toBe(true)
    await vi.waitFor(() => expect(machineWorkOffsetWriteInFlight(machineId)).toBe(false))
    // Not an empty record with a badge - no record at all. Nothing optimistic
    // was written, so a refusal has nothing to take back.
    expect(useCamStore.getState().machineWorkOffsets[machineId]?.G56).toBeUndefined()
  })

  it('table row 3 - adoption writes all three axes from PROFILE, as adopted-from-profile', async () => {
    const { controller } = await connectedController({
      current: allOffsets(SAMPLE_MACHINE_PROFILE),
      profile: allOffsets(SAMPLE_MACHINE_PROFILE),
    })

    await reconcileWorkOffsetsOnConnect(machineId, controller)

    expect(useCamStore.getState().machineWorkOffsets[machineId]?.G54).toEqual({
      offset: SAMPLE_MACHINE_PROFILE,
      state: 'adopted-from-profile',
    })
  })

  it('table row 4 - a connect restore is restored, never sent', async () => {
    const stored = { x: 10, y: 20, z: 30 }
    setStored(machineId, stored)
    const { controller, transport } = await connectedController({
      current: allOffsets(SAMPLE_MACHINE_PROFILE),
      profile: allOffsets(SAMPLE_MACHINE_PROFILE),
    })

    await reconcileWorkOffsetsOnConnect(machineId, controller)

    expect(transport.held.G54).toEqual(stored)
    expect(useCamStore.getState().machineWorkOffsets[machineId]?.G54).toEqual({
      offset: stored,
      state: 'restored',
    })
    expect(useMachineControl.getState().consoleLines.some(
      (line) => line.text.includes('not re-established on this machine this session'),
    )).toBe(true)
  })

  it('table row 5 - a status frame writes nothing at all, in any state', () => {
    deliverStatus({ x: 50, y: 60, z: 70 }, { x: 1, y: 2, z: 3 })
    expect(useCamStore.getState().machineWorkOffsets[machineId]).toBeUndefined()

    // ...and it does not edit an existing value either.
    setStored(machineId, { x: 9 }, 'sent')
    deliverStatus({ x: 50, y: 60, z: 70 }, { x: 1, y: 2, z: 3 })
    expect(useCamStore.getState().machineWorkOffsets[machineId]?.G54).toEqual({
      offset: { x: 9 },
      state: 'sent',
    })
  })

  // ---------------------------------------------------------------------
  // What each state means to WO-1017's switchless work-zero motion gate.
  // A number the operator did not establish HERE never buys a goto.
  // ---------------------------------------------------------------------

  it('gate - a restore does NOT arm the WO-1017 switchless work-zero gate', async () => {
    switchlessMachine()
    useMachineControl.setState({ activeWcs: 'G57' })
    useCamStore.getState().setMachineWorkOffset(machineId, 'G57', { x: 10, y: 20, z: 30 }, 'not-sent')
    const { controller, transport } = await connectedController({
      current: allOffsets(SAMPLE_MACHINE_PROFILE),
      profile: allOffsets(SAMPLE_MACHINE_PROFILE),
    })

    await reconcileWorkOffsetsOnConnect(machineId, controller)

    // The push really happened - this is not a gate that passed by accident
    // of nothing being restored.
    expect(transport.sent.filter(
      (call) => call.m === 'setWorkOffset' && call.a?.wcs === 'G57',
    )).toHaveLength(1)
    expect(useCamStore.getState().machineWorkOffsets[machineId]?.G57?.state).toBe('restored')
    expect(workGotoZeroRefusal(['X', 'Y'])).not.toBeNull()
  })

  it('gate - an adopted profile value does NOT arm it either', async () => {
    switchlessMachine()
    useMachineControl.setState({ activeWcs: 'G58' })
    const { controller } = await connectedController({
      current: allOffsets(SAMPLE_MACHINE_PROFILE),
      profile: allOffsets(SAMPLE_MACHINE_PROFILE),
    })

    await reconcileWorkOffsetsOnConnect(machineId, controller)

    expect(useCamStore.getState().machineWorkOffsets[machineId]?.G58?.state).toBe('adopted-from-profile')
    expect(workGotoZeroRefusal(['X', 'Y'])).not.toBeNull()
  })

  it('gate - a bridge that already agrees does NOT arm it', async () => {
    switchlessMachine()
    useMachineControl.setState({ activeWcs: 'G59' })
    useCamStore.getState().setMachineWorkOffset(machineId, 'G59', ZERO, 'not-sent')
    const { controller } = await connectedController({
      current: allOffsets(SAMPLE_MACHINE_PROFILE),
      profile: allOffsets(SAMPLE_MACHINE_PROFILE),
    })

    await reconcileWorkOffsetsOnConnect(machineId, controller)

    expect(useCamStore.getState().machineWorkOffsets[machineId]?.G59?.state).toBe('restored')
    expect(workGotoZeroRefusal(['X', 'Y'])).not.toBeNull()
  })

  it('gate - a work zero SET here this session does arm it, for that axis only', async () => {
    switchlessMachine()
    useMachineControl.setState({ activeWcs: 'G56' })
    const stub = receiptZeroController(() => ({ x: 1, y: 2, z: 3 }))

    expect(workGotoZeroRefusal(['X'])).not.toBeNull()
    expect(zeroWorkAxes(['X'], stub).ok).toBe(true)
    await vi.waitFor(() => expect(stub.refreshState).toHaveBeenCalledOnce())

    expect(workGotoZeroRefusal(['X'])).toBeNull()
    expect(workGotoZeroRefusal(['X', 'Y'])).not.toBeNull()
  })

  // ---------------------------------------------------------------------
  // WO-1042 attempt 5: ONE IN-FLIGHT OFFSET WRITE PER MACHINE. These tests
  // replace the burst/rollback ones: with no overlap there is nothing to roll
  // back, so the only questions left are who may take the slot, what a refusal
  // leaves behind, and that a real multi-axis caller is ONE operation.
  // ---------------------------------------------------------------------

  it('(a) a second write while one is in flight is REFUSED and the store is untouched', async () => {
    const { controller, accept, calls } = deferredOffsetController()
    expect(setWorkOffsetValue('G54', 'X', 10, controller)).toBe(true)
    await Promise.resolve()
    expect(calls()).toHaveLength(1)
    expect(machineWorkOffsetWriteInFlight(machineId)).toBe(true)

    const second = {
      setWorkOffset: vi.fn(),
      refreshState: vi.fn(),
    } as unknown as MachineController
    expect(setWorkOffsetValue('G54', 'Y', 20, second)).toBe(false)
    expect(second.setWorkOffset).not.toHaveBeenCalled()
    expect(useCamStore.getState().machineWorkOffsets[machineId]?.G54).toBeUndefined()
    expect(useMachineControl.getState().consoleLines.some(
      (line) => line.text === WORK_OFFSET_WRITE_BUSY,
    )).toBe(true)

    // The slot is one per MACHINE, not one per path: a zero is refused by it
    // too, and never reaches the controller.
    const zeroStub = {
      zeroWorkAxisAwait: vi.fn(),
      zeroWorkAxis: vi.fn(),
      refreshState: vi.fn(),
    } as unknown as MachineController
    expect(zeroWorkAxes(['X'], zeroStub)).toEqual({ ok: false, zeroed: [], refused: ['X'] })
    expect(zeroStub.zeroWorkAxisAwait).not.toHaveBeenCalled()
    expect(zeroStub.zeroWorkAxis).not.toHaveBeenCalled()

    accept(0, { x: 10, y: 0, z: 0 })
    await vi.waitFor(() => {
      expect(useCamStore.getState().machineWorkOffsets[machineId]?.G54).toEqual({
        offset: { x: 10 },
        state: 'sent',
      })
    })
    expect(machineWorkOffsetWriteInFlight(machineId)).toBe(false)
  })

  it('(b) a REFUSED receipt writes nothing - value and state stand as they were', async () => {
    setStored(machineId, { x: 5, y: 2 }, 'sent')
    const refused = {
      setWorkOffset: vi.fn(async () => ({ ok: false, reason: 'the machine said no', offset: null })),
      refreshState: vi.fn(),
    } as unknown as MachineController

    expect(setWorkOffsetValue('G54', 'X', 99, refused)).toBe(true)
    await vi.waitFor(() => expect(machineWorkOffsetWriteInFlight(machineId)).toBe(false))
    expect(useCamStore.getState().machineWorkOffsets[machineId]?.G54).toEqual({
      offset: { x: 5, y: 2 },
      state: 'sent',
    })

    // The proof that matters: the next connect pushes the stored 5, never the
    // 99 the machine refused.
    const { controller, transport } = await connectedController()
    await reconcileWorkOffsetsOnConnect(machineId, controller)
    expect(transport.sent.filter((call) => call.m === 'setWorkOffset')).toMatchObject([
      { m: 'setWorkOffset', a: { wcs: 'G54', x: 5, y: 2 } },
    ])
  })

  it('(b) a write whose promise REJECTS - a dead bridge - refuses and frees the slot', async () => {
    setStored(machineId, { x: 5 }, 'sent')
    const dead = {
      setWorkOffset: vi.fn(async () => { throw new Error('the bridge connection closed') }),
      refreshState: vi.fn(),
    } as unknown as MachineController

    expect(setWorkOffsetValue('G54', 'X', 7, dead)).toBe(true)
    await vi.waitFor(() => expect(machineWorkOffsetWriteInFlight(machineId)).toBe(false))
    expect(useCamStore.getState().machineWorkOffsets[machineId]?.G54).toEqual({
      offset: { x: 5 },
      state: 'sent',
    })
    expect(useMachineControl.getState().consoleLines.some(
      (line) => line.text.includes('the bridge connection closed'),
    )).toBe(true)

    // A dead bridge must not disable the offset controls for the rest of the
    // session: the very next write goes through.
    const alive = {
      setWorkOffset: vi.fn(async () => ({ ok: true, reason: null, offset: { x: 7, y: 0, z: 0 } })),
      refreshState: vi.fn(),
    } as unknown as MachineController
    expect(setWorkOffsetValue('G54', 'X', 7, alive)).toBe(true)
    await vi.waitFor(() => {
      expect(useCamStore.getState().machineWorkOffsets[machineId]?.G54).toEqual({
        offset: { x: 7 },
        state: 'sent',
      })
    })
  })

  it('(c) a real multi-axis pass is ONE intent, and only its axes are stored', async () => {
    setStored(machineId, { z: 3 }, 'sent')
    const { controller, accept, calls } = deferredOffsetController()
    dispatchAxes('G54', { X: 10, Y: 20 }, controller)
    await Promise.resolve()

    // Not two competing writes, and not one of them refused by the other's
    // slot: the intent has always been {wcs, x?, y?, z?}.
    expect(calls()).toEqual([{ wcs: 'G54', offset: { x: 10, y: 20 } }])

    // The receipt echoes the whole WCS. Z came from the bridge, not from this
    // operation, so the stored Z keeps the provenance it already had.
    accept(0, { x: 10, y: 20, z: 99 })
    await vi.waitFor(() => {
      expect(useCamStore.getState().machineWorkOffsets[machineId]?.G54).toEqual({
        offset: { x: 10, y: 20, z: 3 },
        state: 'sent',
      })
    })
  })

  it('(c) a multi-axis pass arms WO-1017 for exactly the axes it named', async () => {
    switchlessMachine()
    useMachineControl.setState({ activeWcs: 'G57' })
    const { controller, accept } = deferredOffsetController()
    dispatchAxes('G57', { X: 10, Y: 20 }, controller)
    await Promise.resolve()
    accept(0, { x: 10, y: 20, z: 0 })

    await vi.waitFor(() => {
      expect(useCamStore.getState().machineWorkOffsets[machineId]?.G57?.state).toBe('sent')
    })
    expect(workGotoZeroRefusal(['X', 'Y'])).toBeNull()
    expect(workGotoZeroRefusal(['Z'])).not.toBeNull()
  })

  it('(c) a three-axis zero is ONE operation - its own slot refuses no axis of it', async () => {
    const stub = receiptZeroController(() => ({ x: 1, y: 2, z: 3 }))

    expect(zeroWorkAxes(['X', 'Y', 'Z'], stub)).toEqual({ ok: true, zeroed: ['X', 'Y', 'Z'], refused: [] })
    expect(stub.zeroWorkAxisAwait).toHaveBeenCalledTimes(3)
    await vi.waitFor(() => expect(machineWorkOffsetWriteInFlight(machineId)).toBe(false))
  })

  it('a zero holds the slot until its receipt, and releases it then', async () => {
    let confirmZero!: (receipt: ZeroWorkAxisReceipt) => void
    const receipt = new Promise<ZeroWorkAxisReceipt>((resolve) => { confirmZero = resolve })
    const stub = {
      zeroWorkAxisAwait: vi.fn(() => receipt),
      refreshState: vi.fn(),
    } as unknown as MachineController

    expect(zeroWorkAxes(['X'], stub).ok).toBe(true)
    expect(machineWorkOffsetWriteInFlight(machineId)).toBe(true)
    const other = {
      setWorkOffset: vi.fn(),
      refreshState: vi.fn(),
    } as unknown as MachineController
    expect(setWorkOffsetValue('G54', 'Y', 3, other)).toBe(false)
    expect(other.setWorkOffset).not.toHaveBeenCalled()

    confirmZero({ confirmed: true, offset: { x: 5, y: 6, z: 7 } })
    await vi.waitFor(() => expect(machineWorkOffsetWriteInFlight(machineId)).toBe(false))
  })

  it('(d) the connect restore skips - with a console line - when an operator write holds the slot', async () => {
    setStored(machineId, { x: 7, y: 8, z: 9 }, 'not-sent')
    const { controller: writing, accept } = deferredOffsetController()
    expect(setWorkOffsetValue('G54', 'X', 12, writing)).toBe(true)
    await Promise.resolve()

    const { controller, transport } = await connectedController()
    await reconcileWorkOffsetsOnConnect(machineId, controller)
    expect(transport.sent.filter((call) => call.m === 'setWorkOffset')).toHaveLength(0)
    expect(useMachineControl.getState().consoleLines.some(
      (line) => line.text.includes('Work zero restore skipped'),
    )).toBe(true)

    accept(0, { x: 12, y: 8, z: 9 })
    await vi.waitFor(() => expect(machineWorkOffsetWriteInFlight(machineId)).toBe(false))

    // Once the slot is free the restore runs, and it pushes the value the
    // operator's write left behind - never the one it superseded.
    await reconcileWorkOffsetsOnConnect(machineId, controller)
    expect(transport.sent.filter((call) => call.m === 'setWorkOffset')).toMatchObject([
      { m: 'setWorkOffset', a: { wcs: 'G54', x: 12, y: 8, z: 9 } },
    ])
    expect(machineWorkOffsetWriteInFlight(machineId)).toBe(false)
  })

  it('(d) an operator write DURING the connect restore is refused, never interleaved', async () => {
    setStored(machineId, { x: 7, y: 8, z: 9 }, 'not-sent')
    const { controller } = await connectedController()
    const restoring = reconcileWorkOffsetsOnConnect(machineId, controller)

    const stub = {
      setWorkOffset: vi.fn(),
      refreshState: vi.fn(),
    } as unknown as MachineController
    expect(setWorkOffsetValue('G54', 'X', 1, stub)).toBe(false)
    expect(stub.setWorkOffset).not.toHaveBeenCalled()

    await restoring
    expect(machineWorkOffsetWriteInFlight(machineId)).toBe(false)
  })
})
