// @vitest-environment jsdom
//
// WO-1336 - MDI RUNS A LINE OF G-CODE ON A CONTROLLER WHOSE WIRE TAKES NO TEXT.
//
// Operator, at the machine 2026-09-11 ~01:50Z: "Have we ever tested MDI to confirm
// the controller obeys g-code sent via the MDI?" The same minute, typing `M5`
// into the MDI box on his AXBB-E answered:
//
//   [RED] sendCommand: This controller takes geometry, not G-code text -
//   nothing was loaded. Refused text: M5
//
// WHAT IS PROVEN HERE, THROUGH THE APPLICATION'S OWN ENTRY POINT (rule 6): the
// Control page is RENDERED, the line is TYPED into the MDI box and ENTER is
// pressed, on the real session singleton talking to a real `UccncController`
// over a fake bridge socket that reports Operator's capabilities - `gcodeText:
// false`, a geometry program route, and a Huanyang GT on the Modbus link.
// Every assertion below is about what reached THAT WIRE.
//
//   - `G0 X10 Y20` -> ONE `loadMoves` carrying one rapid to work (10, 20, 0),
//     then `startJob` - in that order,
//   - `G55` -> `selectWcs(G55)`, and the Control page's active-WCS chip reads
//     G55 once the controller confirms it,
//   - `M3 S18000` -> `spindleOn` at the setpoint word for 18,000 RPM (7,500 on
//     this inverter's own calibration), and `M5` -> `spindleOff`,
//   - `G91` -> held modal state, with NOTHING on the wire (WO-1636 re-pin: the
//     mode now holds for the following lines, as a controller holds it),
//   - a word this route cannot carry one line at a time (`M8`, `T1`) and a move
//     that leaves the table are refused the same way, by word and by line, and
//     the wire stays empty.
//
// NOT CLAIMED: hardware. This order's Tier 1 evidence is the machine seat's
// three checks on Operator's board - a G0 to a work coordinate landing the DRO
// there, M3 S / M5 through the inverter, and G55 selecting the frame. Nothing
// here touches it and the desk lane does not claim it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransport,
  BridgeTransportEvents,
  BridgeVfdFrameObserver,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, MachineStatus } from '../../lib/machine/controller'
import {
  UNASSIGNED_PIN,
  createDefaultControllerDefinition,
  type MachineConfig,
  type Project,
} from '../../types'
import { makeMachine, makeTool } from '../post/helpers'
import { mdiOutputByNumberMessage } from '../../lib/machine/operatorMessages'
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

/** Operator's AXBB-E as the bridge reports it: no G-code interpreter, a geometry
 *  program route, and a spindle that lives on a separate Modbus link
 *  (`spindleCommands` is DERIVED by the backend from `hello.vfd.present`, so
 *  the false claimed here is what the real bridge sends). */
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
const G55_OFFSET = { x: 110, y: 5, z: 2 }
const UNSET_OFFSET = { x: 0, y: 0, z: 0 }

/** Which inverter the bridge declares in its hello. The Huanyang GT's setpoint
 *  is RPM / 2.4, which is what turns 18,000 into the word 7,500. */
let helloVfd: { present: boolean; verified: boolean; name: string | null } | null = null

interface FakeBridgeTransport extends BridgeTransport {
  sent: BridgeCallMessage[]
  emit(message: BridgeMessage): void
  frames(kind: string): BridgeCallMessage[]
  /** Every call that reached the wire, in order, as `method` - the one place
   *  the ORDER of "stage the moves" against "start the job" can be read without
   *  believing anything this software says about itself. */
  wireOrder(): string[]
}

const bridgeSockets: FakeBridgeTransport[] = []

vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()
  class FakeBridgeTransport extends actual.BridgeTransport {
    static isSupported(): boolean { return true }
    sent: BridgeCallMessage[] = []
    private fakeEvents: BridgeTransportEvents | null = null
    private readonly fakeVfdObserver: BridgeVfdFrameObserver | null

    constructor(url?: string, machineId?: string | null, onVfdFrame?: BridgeVfdFrameObserver | null) {
      super(url, machineId, onVfdFrame)
      this.fakeVfdObserver = onVfdFrame ?? null
      bridgeSockets.push(this)
    }

    async start(events: BridgeTransportEvents): Promise<void> {
      this.fakeEvents = events
      const offsets = {
        G54: { ...G54_OFFSET },
        G55: { ...G55_OFFSET },
        G56: { ...UNSET_OFFSET },
        G57: { ...UNSET_OFFSET },
        G58: { ...UNSET_OFFSET },
        G59: { ...UNSET_OFFSET },
      }
      this.fakeEvents.onMessage({
        t: 'hello',
        v: {
          protocol: 1,
          bridge: 'wo-1336-fake 0.0',
          capabilities: PROGRAM_BRIDGE_CAPABILITIES,
          readOnly: false,
          workOffsets: { current: offsets, profile: offsets },
          ...(helloVfd ? { vfd: helloVfd } : {}),
        },
      } as BridgeMessage)
    }

    send(message: BridgeCallMessage): void {
      this.sent.push(message)
      // A REAL BRIDGE ANSWERS EVERY CALL. The connect-time offset
      // reconciliation awaits each receipt, so a fake that answered only
      // `selectWcs` would hang the connection - a property of the fake, never
      // of the product.
      if (message.m === 'selectWcs') {
        this.fakeEvents?.onMessage({ t: 'reply', seq: message.seq, ok: true, v: true })
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
      if (message.t === 'vfd') this.fakeVfdObserver?.(message.v)
    }

    frames(kind: string): BridgeCallMessage[] {
      return this.sent.filter((m) => m.m === kind)
    }

    wireOrder(): string[] {
      return this.sent.map((m) => m.m)
    }
  }

  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({
    ...actual,
    BridgeTransport: FakeBridgeTransport,
  })
})

const { ControlPage } = await import('../../components/machine/ControlPage')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineActions } = await import('../../store/machineActionsStore')
const { useCamStore } = await import('../../store')
const {
  __resetEstopInterlockForTest,
  clearPathFidelity,
  connectMachine,
  disconnectMachine,
  getMachineController,
  runMachineAction,
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
  // WO-1649: THIS MACHINE STATES ITS OUTPUTS AND WIRES NEITHER OF THEM. The
  // point the tests below make is that a word the machine NAMES but has not
  // wired is refused saying what to fill in; the word has to be in the list for
  // there to be anything to name. (A machine that lists no outputs at all is a
  // different case on purpose - its M8 is not ours to refuse, it goes to the
  // controller as written.) The list used to be implied by UCCNC relay keys the
  // resolver read directly, which is what made it a UCCNC-only answer.
  controllerDefinition.outputs = [
    { name: 'flood coolant', role: 'flood', onCode: 'M8', offCode: null, pin: { ...UNASSIGNED_PIN } },
    { name: 'mist coolant', role: 'mist', onCode: 'M7', offCode: null, pin: { ...UNASSIGNED_PIN } },
  ]
  return makeMachine({
    id: 'wo1336-machine',
    name: 'WO-1336 Test Machine',
    travel: { x: 600, y: 400, z: 100 },
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'min', homePositionMm: -50 },
    },
    rapidRate: 5000,
    controllerDefinition,
    // The machine record's half of the spindle declaration; the live bridge's
    // half is `hello.vfd`. A driven spindle needs BOTH. `status` is the field
    // SpindlePanel reads to decide whether power is derived, so the fixture
    // states it rather than leaving the rendered panel to guess.
    spindleLinkDefinition: { status: [] } as unknown as MachineConfig['spindleLinkDefinition'],
  })
}

const TOOLS = [makeTool({ id: 't1', toolNumber: 1, name: '6 mm flat end mill' })]

function applyProject(): void {
  useCamStore.setState({
    project: {
      ...useCamStore.getState().project,
      machine: machine(),
      setups: [],
      activeSetupId: null,
      toolLibrary: TOOLS,
    },
    toolLibrary: TOOLS,
  })
}

function idleBridgeStatus(machineZ = 0): MachineStatus {
  return {
    state: 'idle',
    subState: null,
    machinePos: { x: 0, y: 0, z: machineZ },
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
let originalToolLibrary: ReturnType<typeof useCamStore.getState>['toolLibrary']

beforeEach(() => {
  vi.useFakeTimers()
  bridgeSockets.length = 0
  helloVfd = { present: true, verified: false, name: 'Huanyang GT' }
  useMachineActions.setState({ byMachine: {} })
  originalProject = useCamStore.getState().project
  originalToolLibrary = useCamStore.getState().toolLibrary
  applyProject()
})

afterEach(async () => {
  cleanup()
  if (getMachineController().connectionPhase() !== 'disconnected') {
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(300)
    await pending
  }
  useCamStore.setState({
    project: originalProject,
    toolLibrary: originalToolLibrary,
    machineWorkOffsets: {},
  })
  clearPathFidelity()
  useMachineControl.setState({ consoleLines: [] })
  vi.useRealTimers()
})

function socket(): FakeBridgeTransport {
  return bridgeSockets[bridgeSockets.length - 1]
}

function consoleText(): string {
  return useMachineControl.getState().consoleLines.map((line) => line.text).join('\n')
}

async function connectBridge(options: { homed?: boolean } = {}): Promise<void> {
  const pending = connectMachine('bridge')
  await vi.advanceTimersByTimeAsync(300)
  await pending
  act(() => { __resetEstopInterlockForTest() })
  act(() => {
    socket().emit({ t: 'status', v: idleBridgeStatus() } as BridgeMessage)
    if (options.homed !== false) {
      socket().emit({ t: 'homed', v: { axes: ['X', 'Y', 'Z'] } } as BridgeMessage)
    }
  })
}

/** THE OPERATOR'S OWN GESTURE: type the line into the rendered MDI box and
 *  press Enter. Nothing here calls the session directly. */
async function typeMdi(line: string): Promise<void> {
  const input = screen.getByTestId('control-mdi-input') as HTMLInputElement
  expect(input.disabled).toBe(false)
  act(() => { fireEvent.change(input, { target: { value: line } }) })
  await act(async () => {
    fireEvent.keyDown(input, { key: 'Enter' })
    await Promise.resolve()
  })
  // The bridge's selectWcs receipt is a promise; the staging happens behind it.
  await act(async () => { await vi.advanceTimersByTimeAsync(10) })
}

/** Calls that MOVE something or change the machine's frame - the ones a refused
 *  line must not have made. Status polling and the connect-time reconciliation
 *  are not in this list because they are not what the operator typed. */
const COMMANDING_CALLS = new Set([
  'loadMoves', 'startJob', 'selectWcs', 'spindleOn', 'spindleOff', 'sendCommand', 'sendCommandAwait',
])

function commandingCallsSince(mark: number): string[] {
  return socket().sent.slice(mark).map((m) => m.m).filter((m) => COMMANDING_CALLS.has(m))
}

interface StagedWireMove {
  id: number
  kind: string
  to: { x?: number; y?: number; z?: number }
  feedMmMin?: number
  rapid?: true
}

describe('WO-1336: an MDI line is a one-line program on a geometry controller', () => {
  beforeEach(async () => {
    await connectBridge()
    render(<ControlPage />)
  })

  it('G0 X10 Y20 stages one rapid in work coordinates, then starts it', async () => {
    const mark = socket().sent.length
    await typeMdi('G0 X10 Y20')

    const loads = socket().frames('loadMoves')
    expect(loads).toHaveLength(1)
    const moves = (loads[0].a as { moves: StagedWireMove[] }).moves
    expect(moves).toHaveLength(1)
    // Sparse means sparse: the line names no Z, so no Z is staged and the
    // controller retains its current axis position.
    expect(moves[0].to).toEqual({ x: 10, y: 20 })
    expect(moves[0].rapid).toBe(true)

    // STAGED, THEN STARTED - in that order, read off the wire.
    const order = commandingCallsSince(mark)
    expect(order.indexOf('loadMoves')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('startJob')).toBeGreaterThan(order.indexOf('loadMoves'))

    // Two rows: the line as typed, and what it became.
    expect(consoleText()).toContain('G0 X10 Y20')
    // WO-1667: the row names both frames (the G54 origin is machine X10 Y5).
    expect(consoleText()).toContain('MDI G0 X10 Y20: one move in G54, ending at G54 X 10.00 mm Y 20.00 mm (machine X 20.00 mm Y 25.00 mm)')
  })

  it('G1 with a feed stages a cutting move at that feed', async () => {
    await typeMdi('G1 X20 Y20 Z-1 F300')
    const moves = (socket().frames('loadMoves')[0].a as { moves: StagedWireMove[] }).moves
    expect(moves).toHaveLength(1)
    expect(moves[0].to).toMatchObject({ x: 20, y: 20, z: -1 })
    expect(moves[0].rapid).toBeUndefined()
    expect(moves[0].feedMmMin).toBe(300)
  })

  it('G55 selects the frame and the active-WCS chip follows the confirmation', async () => {
    expect(screen.getByTestId('control-active-wcs').textContent).toBe('G54')
    await typeMdi('G55')

    const selects = socket().frames('selectWcs')
    expect((selects.at(-1)!.a as { wcs: string }).wcs).toBe('G55')
    expect(useMachineControl.getState().activeWcs).toBe('G55')
    expect(screen.getByTestId('control-active-wcs').textContent).toBe('G55')
    expect(consoleText()).toContain('MDI G55: G55 is the active work offset.')
    // A frame word moves nothing.
    expect(socket().frames('loadMoves')).toHaveLength(0)
  })

  it('M3 S18000 reaches the inverter at the setpoint word for 18,000 RPM', async () => {
    await typeMdi('M3 S18000')
    const starts = socket().frames('spindleOn')
    expect(starts).toHaveLength(1)
    const call = starts[0].a as { direction: string; setpointWord: number }
    expect(call.direction).toBe('cw')
    // The bridge takes a setpoint WORD; the Huanyang GT's own calibration is
    // RPM / 2.4, so 18,000 RPM is the word 7,500.
    expect(call.setpointWord).toBe(7_500)
    expect(call.setpointWord * 2.4).toBe(18_000)
    expect(consoleText()).toContain('MDI M3 S18000: the spindle is commanded to 18000 RPM CW.')
  })

  it('M4 S12000 runs the inverter the other way', async () => {
    await typeMdi('M4 S12000')
    const call = socket().frames('spindleOn')[0].a as { direction: string; setpointWord: number }
    expect(call.direction).toBe('ccw')
    expect(call.setpointWord).toBe(5_000)
  })

  it('M5 stops the spindle - the line Operator typed when he found the refusal', async () => {
    await typeMdi('M5')
    expect(socket().frames('spindleOff')).toHaveLength(1)
    expect(consoleText()).toContain('MDI M5: the spindle is commanded off.')
  })

  it('M3 with no S speed is refused rather than run at an invented one', async () => {
    const mark = socket().sent.length
    await typeMdi('M3')
    expect(commandingCallsSince(mark)).toEqual([])
    expect(consoleText()).toContain('M3 starts the spindle with no S speed to run at')
  })

  // WO-1636 re-pin: G91 is no longer refused. It is held modal state, as on a
  // controller that reads the line itself, and the following lines use it.
  it('G91 is held modal state, and nothing reaches the wire', async () => {
    const mark = socket().sent.length
    await typeMdi('G91')
    expect(commandingCallsSince(mark)).toEqual([])
    expect(useMachineControl.getState().parserModal?.distanceMode).toBe('incremental')
    expect(consoleText()).toContain('MDI G91: held - ')
  })

  it('G91 on a motion line moves incrementally from where the tool is', async () => {
    act(() => {
      socket().emit({ t: 'status', v: { ...idleBridgeStatus(), workPos: { x: 5, y: 0, z: 0 } } } as BridgeMessage)
    })
    const mark = socket().sent.length
    await typeMdi('G91 G0 X10')
    expect(commandingCallsSince(mark)).toEqual(['selectWcs', 'loadMoves', 'startJob'])
    const moves = (socket().frames('loadMoves')[0].a as { moves: StagedWireMove[] }).moves
    expect(moves[0].to).toMatchObject({ x: 15 })
  })

  it('a word this wire cannot be given one line at a time is refused by word', async () => {
    const mark = socket().sent.length
    await typeMdi('Q1')
    expect(commandingCallsSince(mark)).toEqual([])
    expect(consoleText()).toContain('MDI Q1: Q1 has no G or M word on this line to act on it')
  })

  // WO-2521: a T alone is no longer refused - it selects the tool a later M6
  // fits, as it does in a pause, and nothing goes to the wire.
  it('T1 alone selects T1 for a later M6 and sends nothing', async () => {
    const mark = socket().sent.length
    await typeMdi('T1')
    expect(commandingCallsSince(mark)).toEqual([])
    expect(consoleText()).toContain('MDI T1: T1 is selected; M6 fits it.')
  })

  // WO-1635: a coolant word names what it switches and that the bridge has no
  // call for it, rather than the generic sentence.
  // WO-1637: a coolant word switches the pin the machine definition names; this
  // record assigns none, so it is refused naming the setting to fill in.
  // WO-1649: and it is named in the DEFINITION's own words - the output the
  // operator can point at a pin - not a UCCNC setting key, which a machine that
  // never saw a UCCNC profile does not have.
  it('a coolant word with no pin in the definition is refused naming the setting', async () => {
    const mark = socket().sent.length
    await typeMdi('M8')
    expect(commandingCallsSince(mark)).toEqual([])
    expect(socket().frames('setOutput')).toHaveLength(0)
    expect(consoleText()).toContain(
      'MDI M8: M8 switches flood coolant, and this machine definition assigns it no pin - '
      + 'fill in the pin of the "flood coolant" output in the machine definition',
    )
  })

  // A LINE RUNS WHOLE OR NOT AT ALL. Audit of attempt 1: the dispatcher
  // returned as soon as it recognised ONE category, so a mixed line executed
  // the word it recognised and dropped the rest in silence - the operator read
  // one green row for a line half of which never happened.
  // WO-1644: A MIXED LINE RUNS WORD BY WORD IN CONTROLLER ORDER, as UCCNC and
  // LinuxCNC run one block - spindle first, then the work offset. Neither word
  // is dropped: both reach the wire, in that order.
  it('G55 M5 runs both words in controller order - the stop, then the frame', async () => {
    const mark = socket().sent.length
    await typeMdi('G55 M5')
    expect(commandingCallsSince(mark)).toEqual(['spindleOff', 'selectWcs'])
    expect(consoleText()).toContain('MDI G55 M5: run word by word in controller order: M5, then G55.')
  })

  // An output word whose pin the definition does not assign is known to be
  // refused before anything is sent, so it is asked first and the spindle word
  // ahead of it in controller order never goes.
  it('M3 S18000 M8 with no pin for M8 does not start the spindle and drop the coolant word', async () => {
    const mark = socket().sent.length
    await typeMdi('M3 S18000 M8')
    expect(commandingCallsSince(mark)).toEqual([])
    expect(socket().frames('spindleOn')).toHaveLength(0)
    expect(consoleText()).toContain('MDI M8: M8 switches flood coolant, and this machine definition assigns it no pin')
    expect(consoleText()).toContain('MDI M3 S18000 M8: stopped at M8; nothing on this line was sent.')
  })

  it('M3 S1000 M5 commands neither - one of them would have to be dropped', async () => {
    const mark = socket().sent.length
    await typeMdi('M3 S1000 M5')
    expect(commandingCallsSince(mark)).toEqual([])
    expect(socket().frames('spindleOn')).toHaveLength(0)
    expect(socket().frames('spindleOff')).toHaveLength(0)
    expect(consoleText()).toContain(
      'MDI M3 S1000 M5: M3 and M5 each command the spindle direction',
    )
  })

  it('G54 G55 selects neither frame - only one of them could be obeyed', async () => {
    const mark = socket().sent.length
    await typeMdi('G54 G55')
    expect(commandingCallsSince(mark)).toEqual([])
    expect(useMachineControl.getState().activeWcs).toBe('G54')
    expect(consoleText()).toContain('MDI G54 G55: G54 and G55 each select a work offset')
  })

  // ONE UNAMBIGUOUS COMMAND PER CATEGORY. Second audit of this order, exactly:
  // `M3 M4 S1000` sent one CCW start while silently dropping M3, and
  // `M3 S1000 S2000` sent 1000 RPM while silently dropping S2000. A spindle
  // turning the opposite way from the word the operator typed is the worst
  // outcome this order can produce. Each of these asserts the WIRE is empty -
  // a refusal that returns false after sending a `spindleOn` is the defect, so
  // the return value alone cannot be the evidence.
  it.each([
    ['M3 M4', 'M3 and M4 each command the spindle direction'],
    ['M3 M4 S1000', 'M3 and M4 each command the spindle direction'],
    ['M4 M5', 'M4 and M5 each command the spindle direction'],
    ['M3 M5', 'M3 and M5 each command the spindle direction'],
    ['M3 S1000 S2000', 'S1000 and S2000 each set the spindle speed'],
  ])('%s refuses the whole line and sends nothing', async (line, said) => {
    const mark = socket().sent.length
    await typeMdi(line)
    expect(commandingCallsSince(mark)).toEqual([])
    expect(socket().frames('spindleOn')).toHaveLength(0)
    expect(socket().frames('spindleOff')).toHaveLength(0)
    expect(consoleText()).toContain(`MDI ${line}: ${said}`)
    expect(consoleText()).toContain('nothing on this line was sent')
  })

  // IDENTICAL REPEATS STATE ONE THING TWICE. They are not two answers, so they
  // are not a conflict, and the line runs exactly as `M3 S1000` does.
  it('M3 S1000 S1000 states one speed twice and runs', async () => {
    await typeMdi('M3 S1000 S1000')
    const starts = socket().frames('spindleOn')
    expect(starts).toHaveLength(1)
    const call = starts[0].a as { direction: string; setpointWord: number }
    expect(call.direction).toBe('cw')
    // The Huanyang GT's calibration is RPM / 2.4 and the word is an integer:
    // 1,000 RPM is 417, the same word `M3 S1000` alone would send.
    expect(call.setpointWord).toBe(417)
    expect(consoleText()).toContain('MDI M3 S1000 S1000: the spindle is commanded to 1000 RPM CW.')
  })

  // ...and a bare `S1000 S1000` is not refused for stating two speeds either -
  // it is refused because no word on the line would ever run at that speed.
  it('S1000 S1000 is refused for having no start, not for repeating itself', async () => {
    const mark = socket().sent.length
    await typeMdi('S1000 S1000')
    expect(commandingCallsSince(mark)).toEqual([])
    expect(consoleText()).toContain(
      'MDI S1000 S1000: S1000 sets a spindle speed and this line has no M3 or M4 to run at it',
    )
  })

  // A SPEED BELONGS TO A START: `M5 S1000` would stop the spindle and drop the
  // speed - the same silent half-execution, so the same whole-line refusal.
  it('M5 S1000 stops nothing - the speed would have been dropped', async () => {
    const mark = socket().sent.length
    await typeMdi('M5 S1000')
    expect(commandingCallsSince(mark)).toEqual([])
    expect(socket().frames('spindleOff')).toHaveLength(0)
    expect(consoleText()).toContain(
      'MDI M5 S1000: S1000 sets a spindle speed and this line has no M3 or M4 to run at it',
    )
  })

  // The rule runs BEFORE the motion branch, so an ambiguous move is as refused
  // as an ambiguous spindle word, and nothing is staged.
  it.each([
    ['G0 G1 X10', 'G0 and G1 each select a motion mode'],
    ['G0 X10 X20', 'X10 and X20 each give this line an X value'],
  ])('%s is refused before anything is staged', async (line, said) => {
    const mark = socket().sent.length
    await typeMdi(line)
    expect(commandingCallsSince(mark)).toEqual([])
    expect(socket().frames('loadMoves')).toHaveLength(0)
    expect(consoleText()).toContain(`MDI ${line}: ${said}`)
  })

  it('an unsupported word on a MOTION line is refused by the shared reader, and nothing is staged', async () => {
    const mark = socket().sent.length
    await typeMdi('G0 X10 M19')
    expect(commandingCallsSince(mark)).toEqual([])
    expect(socket().frames('loadMoves')).toHaveLength(0)
    expect(consoleText()).toContain('M19 is not in the UCCNC G-code word table')
  })

  // LEXICAL GARBAGE THE TOKENIZER WOULD HAVE THROWN AWAY. `tokenizeLine`
  // records address words and ignores every other character, so `M5 #` arrives
  // at the accounting as the single word `M5` - it would stop the spindle and
  // never mention the `#`, which is the same half-executed line by a different
  // door. The shared linter reads the characters, so it is asked first.
  it.each([
    ['M5 #', 'Stray token "#"'],
    ['M3 S1000 %', 'Stray token "%"'],
    ['G55 @', 'Stray token "@"'],
    ['M5 W10', 'Unknown address letter "W"'],
    ['M5 X', 'Address "X" is missing its numeric argument.'],
    // A NUMBER WITH NO ADDRESS is the likeliest typo of the lot - the operator
    // meant `X10` or `S10` and lost the letter. The tokenizer drops it too.
    ['M5 10', 'Stray token "1"'],
  ])('%s is refused whole - the character the tokenizer drops is read first', async (line, said) => {
    const mark = socket().sent.length
    await typeMdi(line)
    expect(commandingCallsSince(mark)).toEqual([])
    expect(socket().frames('spindleOn')).toHaveLength(0)
    expect(socket().frames('spindleOff')).toHaveLength(0)
    expect(socket().frames('selectWcs')).toHaveLength(0)
    expect(consoleText()).toContain(`MDI ${line}: ${said}`)
    expect(consoleText()).toContain('Nothing on this line was sent.')
  })

  // ...and a MOTION line carrying the same garbage is refused by the SHARED
  // READER, which reads the characters itself. That is why the gate above sits
  // below the motion branch: this path already has an authority, and it is not
  // given a second one.
  it('G0 X10 # stages nothing - the shared reader reads the stray character itself', async () => {
    const mark = socket().sent.length
    await typeMdi('G0 X10 #')
    expect(commandingCallsSince(mark)).toEqual([])
    expect(socket().frames('loadMoves')).toHaveLength(0)
    expect(socket().frames('startJob')).toHaveLength(0)
    expect(consoleText()).toContain('token "#" is not understood')
  })

  // THE GATE READS CODE, NOT ONLY GARBAGE. A parenthesised comment is g-code
  // the linter accepts, so the line it is attached to still runs - a lexical
  // gate that refused this would be a new refusal nobody asked for.
  it('G55 (frame) still selects the frame - a comment is code the linter reads', async () => {
    await typeMdi('G55 (frame)')
    expect((socket().frames('selectWcs').at(-1)!.a as { wcs: string }).wcs).toBe('G55')
    expect(useMachineControl.getState().activeWcs).toBe('G55')
  })

  // The single-category lines still dispatch: the accounting refuses lines it
  // cannot honour whole, and refuses nothing it can.
  it('a frame word with a line number is still selected', async () => {
    await typeMdi('N10 G55')
    expect((socket().frames('selectWcs').at(-1)!.a as { wcs: string }).wcs).toBe('G55')
    expect(useMachineControl.getState().activeWcs).toBe('G55')
  })

  // WO-1635: a dwell is the board's own dwell step, staged and started like a
  // move. UCCNC's P is milliseconds unless the machine states otherwise.
  it('a dwell stages the board dwell step and starts it', async () => {
    const mark = socket().sent.length
    await typeMdi('G4 P1')
    expect(commandingCallsSince(mark)).toEqual(['selectWcs', 'loadMoves', 'startJob'])
    const steps = (socket().frames('loadMoves').at(-1)!.a as { moves: { kind: string; seconds?: number }[] }).moves
    expect(steps.map((step) => step.kind)).toEqual(['dwell'])
    expect(steps[0].seconds).toBeCloseTo(0.001, 9)
    expect(consoleText()).toContain('MDI G4 P1: a 0.001 s dwell in G54')
  })

  // A SECOND MDI MOVE REPLACES THE FIRST, and the operator watched the first
  // one run - telling them their "program" was replaced would be a sentence
  // about something that was never loaded.
  it('two MDI moves in a row do not claim a program was replaced', async () => {
    await typeMdi('G0 X10 Y20')
    act(() => {
      socket().emit({ t: 'jobEvent', v: { event: 'completed' } } as BridgeMessage)
      socket().emit({ t: 'status', v: idleBridgeStatus() } as BridgeMessage)
    })
    await typeMdi('G0 X20 Y30')
    expect(consoleText()).toContain('MDI G0 X20 Y30: one move in G54, ending at G54 X 20.00 mm Y 30.00 mm (machine X 30.00 mm Y 35.00 mm)')
    expect(consoleText()).not.toContain('has been replaced by this move')
  })

  // WO-1635: A CONFIGURED MACHINE ACTION TAKES THE SAME TRANSLATION. Operator's
  // flood output `M64 P2 S<rpm>` used to be handed to `sendCommand`, which on
  // this wire can only answer "takes geometry, not G-code text". The bridge has
  // no output call, so the word is refused BY NAME and nothing reaches the wire.
  it('a configured machine action is translated, and an output word is refused by name', async () => {
    const mark = socket().sent.length
    const result = runMachineAction(['M64 P2 S12000'])
    expect(result.ok).toBe(false)
    expect(commandingCallsSince(mark)).toEqual([])
    expect(consoleText()).not.toContain('Refused text: M64 P2 S12000')
    expect(consoleText()).toContain(`MDI M64 P2 S12000: ${mdiOutputByNumberMessage('M64', 'switches digital output P2 on')}`)
  })

  it('a move off the table is refused by the same travel check a file gets', async () => {
    const mark = socket().sent.length
    // G54 X is 10 on the machine, so work X 700.00 mm is machine X 710.00 mm - past the
    // 600 mm soft limit this machine states.
    await typeMdi('G0 X700 Y20')
    expect(commandingCallsSince(mark)).toEqual([])
    expect(consoleText()).toContain(
      '"G0 X700 Y20", line 1: Step 1 (move 0, a line) reaches X 710, outside the X travel 0..600. '
      + 'The whole program is refused and nothing was staged.',
    )
  })
})

// ---------------------------------------------------------------------------
// THE GATE BETWEEN STAGING AND STARTING - the row may not outrun the wire.
//
// Staging a program and starting it are two events, and every gate a program
// obeys sits between them. On a machine with no datum, `G0 X10 Y20` stages and
// Cycle Start REFUSES: `loadMoves` reaches the wire and `startJob` never does.
// The console row that describes the line is written after that outcome, so it
// cannot say "started" about a move the board was never told to run.
// ---------------------------------------------------------------------------
describe('WO-1336: a line the homing gate refuses is not a line that ran', () => {
  beforeEach(async () => {
    await connectBridge({ homed: false })
    act(() => { useMachineControl.getState().setProgram(null, null, [], null) })
    render(<ControlPage />)
  })

  it('G0 X10 Y20 on an unhomed machine stages, is refused Cycle Start, and says so', async () => {
    const mark = socket().sent.length
    await typeMdi('G0 X10 Y20')

    // THE WIRE IS THE CLAIM. The moves were staged; the job was never started.
    const wire = commandingCallsSince(mark)
    expect(wire).toContain('loadMoves')
    expect(wire).not.toContain('startJob')
    expect(socket().frames('startJob')).toHaveLength(0)

    // The gate said why, in its own words.
    expect(consoleText()).toContain('Cycle Start: refused - ')

    // AND THE ROW DOES NOT LIE. This is the defect attempt 3 shipped: the row
    // was written before `onStaged`, so it claimed "staged and started" while
    // the refusal sat under it.
    expect(consoleText()).not.toContain('staged and started')
    expect(consoleText()).toContain(
      'MDI G0 X10 Y20: one move in G54, ending at G54 X 10.00 mm Y 20.00 mm (machine X 20.00 mm Y 25.00 mm), '
      + 'staged, and NOT started - Cycle Start refused it for the reason above.',
    )

    if (process.env.WRITE_EVIDENCE !== '1') return
    const said = useMachineControl.getState().consoleLines.map((line) => line.text)
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync('src/tests/evidence/WO-1336', { recursive: true })
    writeFileSync(
      'src/tests/evidence/WO-1336/refused-start.md',
      '# WO-1336 - the gate between staging and starting\n\n'
      + 'Generated by `src/tests/machine/mdiGeometry.wo1336.test.tsx` (`WRITE_EVIDENCE=1`).\n\n'
      + '`G0 X10 Y20` typed into the rendered Control page\'s MDI box on a connected machine\n'
      + 'with NO axis homed. Staging and starting are two events and the program gates sit\n'
      + 'between them, so the line stages and Cycle Start refuses it. Below is what the fake\n'
      + 'bridge socket received and what the operator read, captured in this run.\n\n'
      + '## Commanding calls that reached the wire\n\n'
      + `${wire.map((m) => `- \`${m}\``).join('\n')}\n\n`
      + '`startJob` is absent: the board was never told to run the move.\n\n'
      + '## The console, in order\n\n'
      + `${said.map((text) => `- ${text.replace(/\s+/g, ' ')}`).join('\n')}\n\n`
      + 'The row describing the line is written AFTER the start is attempted, so it reports\n'
      + 'the refusal rather than claiming "staged and started" over the top of it.\n',
    )
  })

  it('the same line on a homed machine still starts, and says THAT', async () => {
    act(() => { socket().emit({ t: 'homed', v: { axes: ['X', 'Y', 'Z'] } } as BridgeMessage) })
    const mark = socket().sent.length
    await typeMdi('G0 X10 Y20')

    expect(commandingCallsSince(mark)).toContain('startJob')
    expect(consoleText()).toContain('staged and started.')
    expect(consoleText()).not.toContain('NOT started')
  })
})

// ---------------------------------------------------------------------------
// EVERY LINE, AND THE WIRE CALL IT BECAME - the order's Tier 2 desk evidence.
//
// Each row below is TYPED into the rendered MDI box on a real `UccncController`
// over the fake bridge socket, and what is recorded is what that socket
// RECEIVED plus the console row the operator read. The table is written from
// the observations of the same run (`WRITE_EVIDENCE=1`), so a row that lies
// fails the test that writes it.
// ---------------------------------------------------------------------------

interface MdiRow {
  line: string
  /** What the wire is expected to receive, in order. */
  wire: string[]
}

// EVERY MOTION LINE SELECTS ITS FRAME FIRST, even when that frame is already
// active. That is WO-1312's rule and the file door's own unconditional first
// step: the controller CONFIRMS the frame before a single move is staged, so
// nothing is ever staged against a frame this software merely believes in.
const MDI_TABLE: MdiRow[] = [
  { line: 'G0 X10 Y20', wire: ['selectWcs', 'loadMoves', 'startJob'] },
  { line: 'G1 X20 Y20 Z-1 F300', wire: ['selectWcs', 'loadMoves', 'startJob'] },
  { line: 'G55 G0 X10 Y20', wire: ['selectWcs', 'loadMoves', 'startJob'] },
  { line: 'G55', wire: ['selectWcs'] },
  { line: 'M3 S18000', wire: ['spindleOn'] },
  { line: 'M4 S12000', wire: ['spindleOn'] },
  { line: 'M5', wire: ['spindleOff'] },
  { line: 'M3', wire: [] },
  { line: 'G91', wire: [] },
  { line: 'G91 G0 X10', wire: ['selectWcs', 'loadMoves', 'startJob'] },
  { line: 'M8', wire: [] },
  // WO-2521: a typed tool change runs as it does in a pause - the spindle stops
  // and, with no tool-change park on this record, T1 is set as fitted.
  { line: 'T1 M6', wire: ['spindleOff'] },
  { line: 'G4 P1', wire: ['selectWcs', 'loadMoves', 'startJob'] },
  { line: 'G0 X700 Y20', wire: [] },
  // MIXED WORDS (WO-1644): run word by word in controller order; a line with a
  // word known to be refused reaches the wire with nothing at all.
  { line: 'G55 M5', wire: ['spindleOff', 'selectWcs'] },
  { line: 'M3 S18000 M8', wire: [] },
  { line: 'M3 S1000 M5', wire: [] },
  { line: 'G54 G55', wire: [] },
  { line: 'G0 X10 M19', wire: [] },
  // ONE UNAMBIGUOUS COMMAND PER CATEGORY: two different words from one category
  // refuse the whole line, and identical repeats state one thing twice and run.
  { line: 'M3 M4', wire: [] },
  { line: 'M3 M4 S1000', wire: [] },
  { line: 'M4 M5', wire: [] },
  { line: 'M3 M5', wire: [] },
  { line: 'M3 S1000 S2000', wire: [] },
  { line: 'M5 S1000', wire: [] },
  { line: 'S1000 S1000', wire: [] },
  { line: 'G0 G1 X10', wire: [] },
  { line: 'G0 X10 X20', wire: [] },
  { line: 'M3 S1000 S1000', wire: ['spindleOn'] },
  // EVERY CHARACTER IS READ: what the tokenizer would have dropped refuses the
  // line, and a comment - which is code - does not.
  { line: 'M5 #', wire: [] },
  { line: 'G0 X10 #', wire: [] },
  { line: 'M5 X', wire: [] },
  { line: 'G55 (frame)', wire: ['selectWcs'] },
]

const OBSERVED = new Map<string, { wire: string[]; said: string }>()

describe('WO-1336: every typed line, and the wire call it became', () => {
  beforeEach(async () => {
    await connectBridge()
    // NOTHING LOADED, every row. The store is a singleton across this file, so
    // without this a row would inherit the previous row's staged line and the
    // table would print a sentence about the FIXTURE instead of the product.
    act(() => { useMachineControl.getState().setProgram(null, null, [], null) })
    render(<ControlPage />)
  })

  it.each(MDI_TABLE)('$line', async (row) => {
    const mark = socket().sent.length
    await typeMdi(row.line)
    const wire = commandingCallsSince(mark)
    // The wire is the claim. Everything the row says it does, it did; and a
    // refused row made no call at all.
    expect(wire).toEqual(row.wire)
    const said = useMachineControl.getState().consoleLines
      .map((entry) => entry.text)
      .filter((text) => text.startsWith(`MDI ${row.line}:`) || text.startsWith(`"${row.line}"`))
      .at(-1)
    expect(said, 'every line gets a console row saying what it became').toBeTruthy()
    OBSERVED.set(row.line, { wire, said: said! })
  })

  it('renders the wire table to evidence FROM WHAT THIS RUN OBSERVED', async () => {
    const missing = MDI_TABLE.filter((row) => !OBSERVED.has(row.line)).map((row) => row.line)
    expect(missing, 'the table may only print lines this run actually typed').toEqual([])
    if (process.env.WRITE_EVIDENCE !== '1') return

    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync('src/tests/evidence/WO-1336', { recursive: true })
    const rows = MDI_TABLE.map((row) => {
      const seen = OBSERVED.get(row.line)!
      const wire = seen.wire.length === 0 ? 'nothing' : seen.wire.map((m) => `\`${m}\``).join(' -> ')
      return `| \`${row.line}\` | ${wire} | ${seen.said.replace(/\s+/g, ' ')} |`
    })
    writeFileSync(
      'src/tests/evidence/WO-1336/mdi-wire-table.md',
      '# WO-1336 - every MDI line, and the wire call it became\n\n'
      + 'Generated by `src/tests/machine/mdiGeometry.wo1336.test.tsx` (`WRITE_EVIDENCE=1`).\n\n'
      + 'Each line was TYPED into the rendered Control page\'s MDI box and sent with Enter, on a\n'
      + 'real `UccncController` over a fake bridge socket declaring Operator\'s capabilities\n'
      + '(`gcodeText: false`, a geometry program route, a Huanyang GT on the Modbus link).\n'
      + 'The middle column is what that socket RECEIVED; the right column is the console row the\n'
      + 'operator read. Both were captured in the run that wrote this file, so a row that lies\n'
      + 'fails the test that writes it.\n\n'
      + 'Tier 2 (desk) only. Tier 1 is the machine seat\'s three checks on the board: a G0 to a\n'
      + 'work coordinate landing the DRO there, M3 S / M5 through the inverter, and G55\n'
      + 'selecting the frame.\n\n'
      + '| Typed | Reached the wire as | What the console said |\n'
      + '| --- | --- | --- |\n'
      + `${rows.join('\n')}\n`,
    )
  })
})
