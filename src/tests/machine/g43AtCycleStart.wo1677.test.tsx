// @vitest-environment jsdom
//
// WO-1677 - `G43 H<n>` AT CYCLE START, MEASURED ON THE WIRE.
//
// The audit passed WO-1677 on the load line's words and the staged work-frame
// moves. Neither is the machine. This file presses CYCLE START on the real
// session singleton, talking to a real `UccncController` over a fake bridge
// socket (and to the simulator, the G-code-text path), and reads what actually
// leaves for the controller.
//
// The opus review (2026-09-18) found the first design wrote the length into
// G54 Z AFTER the bridge had baked the work offset into the staged moves, so
// the cut ran with zero length and G54 was left shifted. The fix round folds
// tool n's length into the Z the geometry route stages, per section, so:
//
//   - tool 3 measured +45.2 mm against the reference: every Z the H governs
//     reaches the machine at the SAME machine Z the tool-length panel's own
//     path (`toolOffsetLine` -> `applyToolLengthOffset`) would put it at -
//     same value, same sign, measured against that path in the same test;
//   - the length is in the loadMoves itself, so it is in effect before the
//     first move it governs is staged, on every section, and a `G43 Z.. H3`
//     after an XY-only move is covered like any other;
//   - no program ever writes the operator's work offset, so nothing is left
//     shifted after completion, a Stop, an E-STOP or a lost link;
//   - an unmeasured tool 3 stages the file's own Z, and the console names it
//     once.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup } from '@testing-library/react'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransport,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, MachineStatus } from '../../lib/machine/controller'
import { createDefaultControllerDefinition, type MachineConfig, type Project } from '../../types'
import { makeMachine, makeTool } from '../post/helpers'
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
const UNSET = { x: 0, y: 0 }

interface FakeBridgeTransport extends BridgeTransport {
  sent: BridgeCallMessage[]
  emit(message: BridgeMessage): void
}

const bridgeSockets: FakeBridgeTransport[] = []

vi.mock('../../lib/machine/bridgeTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/machine/bridgeTransport')>()
  class FakeBridgeTransport extends actual.BridgeTransport {
    static isSupported(): boolean { return true }
    sent: BridgeCallMessage[] = []
    private fakeEvents: BridgeTransportEvents | null = null

    constructor() {
      super()
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
      this.fakeEvents.onMessage({
        t: 'hello',
        v: {
          protocol: 1,
          bridge: 'wo-1677-review-fake 0.0',
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
      // The board's receipt echoes the whole row, as the real bridge does.
      if (message.m === 'setWorkOffset') {
        const a = message.a as { wcs: string; x?: number; y?: number; z?: number }
        this.fakeEvents?.onMessage({
          t: 'reply',
          seq: message.seq,
          ok: true,
          v: { ok: true, offset: { x: a.x ?? G54_OFFSET.x, y: a.y ?? G54_OFFSET.y, z: a.z ?? G54_OFFSET.z } },
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
    BridgeTransport: FakeBridgeTransport,
  })
})

const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineActions } = await import('../../store/machineActionsStore')
const { useMachineToolTable } = await import('../../store/machineToolTableStore')
const { useCamStore } = await import('../../store')
const { executeOperatorCycleStart, executeOperatorStopReset } = await import('../../lib/machine/operatorTransport')
const { toolOffsetLine } = await import('../../lib/machine/toolTable')
const {
  __resetEstopInterlockForTest,
  applyToolLengthOffset,
  clearPathFidelity,
  clearToolLengthOffset,
  connectMachine,
  disconnectMachine,
  getMachineController,
  loadGcodeTextToolpathProgram,
  setWorkOffsetValue,
} = await import('../../lib/machine/machineSession')

const MACHINE_ID = 'wo1677-review-machine'

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
    name: 'WO-1677 Review Machine',
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

const TOOLS = [
  makeTool({ id: 't1', toolNumber: 1, name: '6 mm flat end mill' }),
  makeTool({ id: 't3', toolNumber: 3, name: 'long reach', overallLength: 80 }),
]

/** Tool 3 measured on the pad 45.2 mm HIGHER in machine Z than the reference
 *  tool 1 - it sticks 45.2 mm further out of the holder. This is what the
 *  tool-length measure writes (`recordProbedZ`) and what the table stores. */
const REF_PROBED_Z = -60
const T3_PROBED_Z = -14.8
const T3_DELTA = 45.2

function measureTool3(probedZ = T3_PROBED_Z): void {
  const table = useMachineToolTable.getState()
  table.addTool(MACHINE_ID, 1)
  table.addTool(MACHINE_ID, 3)
  table.recordProbedZ(MACHINE_ID, 1, REF_PROBED_Z, Date.now())
  table.recordProbedZ(MACHINE_ID, 3, probedZ, Date.now())
  table.setReference(MACHINE_ID, 1)
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
  useMachineActions.setState({ byMachine: {} })
  useMachineToolTable.setState({ byMachine: {} })
  originalProject = useCamStore.getState().project
  originalToolLibrary = useCamStore.getState().toolLibrary
  useCamStore.setState({
    project: { ...originalProject, machine: machine(), setups: [], toolLibrary: TOOLS },
    toolLibrary: TOOLS,
  })
})

afterEach(async () => {
  cleanup()
  if (getMachineController().connectionPhase() !== 'disconnected') {
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(300)
    await pending
  }
  useCamStore.setState({ project: originalProject, toolLibrary: originalToolLibrary, machineWorkOffsets: {} })
  clearPathFidelity()
  useMachineControl.setState({ consoleLines: [] })
  vi.useRealTimers()
})

async function connect(kind: 'simulator' | 'bridge'): Promise<void> {
  const pending = connectMachine(kind)
  await vi.advanceTimersByTimeAsync(300)
  await pending
  act(() => { __resetEstopInterlockForTest() })
  if (kind === 'bridge') {
    act(() => {
      socket().emit({ t: 'status', v: idleBridgeStatus() } as BridgeMessage)
      socket().emit({ t: 'homed', v: { axes: ['X', 'Y', 'Z'] } } as BridgeMessage)
    })
  } else {
    if (!getMachineController().home()) throw new Error('The simulator refused the homed fixture.')
    await vi.advanceTimersByTimeAsync(2_000)
  }
}

function socket(): FakeBridgeTransport {
  return bridgeSockets[bridgeSockets.length - 1]
}

function consoleText(): string {
  return useMachineControl.getState().consoleLines.map((line) => line.text).join('\n')
}

/** Every call that left for the bridge, as `method` or `setWorkOffset(G54 z=..)`. */
function wire(from = 0): string[] {
  return socket().sent.slice(from).map((m) => {
    if (m.m !== 'setWorkOffset') return m.m
    const a = m.a as { wcs: string; x?: number; y?: number; z?: number }
    const axes = (['x', 'y', 'z'] as const)
      .filter((k) => a[k] !== undefined)
      .map((k) => `${k}=${Number(a[k]!.toFixed(4))}`)
    return `setWorkOffset(${a.wcs} ${axes.join(' ')})`
  })
}

function offsetFrames(from = 0): string[] {
  return wire(from).filter((call) => call.startsWith('setWorkOffset'))
}

function completeRun(machineZ = 0): void {
  act(() => {
    socket().emit({ t: 'status', v: { ...idleBridgeStatus(machineZ), buffer: { moves: 0, capacitySeconds: null } } } as BridgeMessage)
    socket().emit({ t: 'jobEvent', v: { event: 'completed', fault: null } } as BridgeMessage)
  })
}

async function load(name: string, text: string): Promise<void> {
  const loaded = loadGcodeTextToolpathProgram(name, text)
  await act(async () => { await vi.advanceTimersByTimeAsync(20) })
  expect(loaded).toEqual({ ok: true, reason: null })
}

async function cycleStart(): Promise<void> {
  let accepted = false
  await act(async () => {
    accepted = await executeOperatorCycleStart()
    await vi.advanceTimersByTimeAsync(20)
  })
  expect(accepted).toBe(true)
}

const TLO_NC = 'G21 G90 G54\nT3 M6\nG43 H3\nG0 X0 Y0 Z10\nG1 Z-1 F300\nG0 Z10\nG49\nM30\n'

/** The Z of every staged line move the bridge was handed, in call order. */
function stagedZ(from = 0): number[] {
  return socket().sent.slice(from)
    .filter((m) => m.m === 'loadMoves')
    .flatMap((m) => (m.a as { moves: { kind: string; to?: { z?: number } }[] }).moves)
    .filter((move) => move.kind === 'line' && typeof move.to?.z === 'number')
    .map((move) => Number(move.to!.z!.toFixed(4)))
}

const round = (z: number): number => Number(z.toFixed(4))

/** The G54 Z the panel's path leaves in force for tool 3: bare Z plus 45.2. */
const PANEL_G54_Z = round(G54_OFFSET.z + T3_DELTA)

describe('WO-1677: G43 H3 on the UCCNC bridge wire', () => {
  beforeEach(async () => { await connect('bridge') })

  it('stages every Z the H governs at the machine Z the tool-length panel would reach for tool 3', async () => {
    measureTool3()
    const row = toolOffsetLine(useMachineToolTable.getState().tableFor(MACHINE_ID), 3)
    expect(row).toEqual({ ok: true, line: `G43.1 Z${T3_DELTA}`, deltaMm: T3_DELTA })

    // THE PANEL'S OWN PATH (ToolsProbePanel / guided tool change): toolOffsetLine
    // -> applyToolLengthOffset, on this very connection. It raises G54 Z by 45.2.
    let mark = socket().sent.length
    expect(applyToolLengthOffset(row.ok ? row.deltaMm : NaN)).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(20) })
    expect(offsetFrames(mark)).toEqual([`setWorkOffset(G54 z=${PANEL_G54_Z})`])
    // Take it back out, the panel's G49 - so the program starts from the bare zero.
    mark = socket().sent.length
    expect(clearToolLengthOffset()).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(20) })
    expect(offsetFrames(mark)).toEqual([`setWorkOffset(G54 z=${G54_OFFSET.z})`])

    // THE FILE: G0 Z10, G1 Z-1, G0 Z10 under G43 H3.
    mark = socket().sent.length
    await load('tlo.nc', TLO_NC)
    await cycleStart()
    // The bridge adds the bare G54 Z (2) to each staged Z; the panel's path
    // adds 47.2 to the file's own. Same machine Z, value and sign: a tool
    // 45.2 mm longer is held 45.2 mm higher for the same file Z.
    const machineZ = stagedZ(mark).map((z) => round(z + G54_OFFSET.z))
    expect(machineZ).toEqual([10, -1, 10].map((z) => round(z + PANEL_G54_Z)))

    // NOTHING writes the work offset - not at load, Cycle Start or completion.
    completeRun()
    await act(async () => { await vi.advanceTimersByTimeAsync(20) })
    expect(offsetFrames(mark)).toEqual([])
  })

  // THE REVIEW'S REPRODUCTION (fix round 2): the operator measured tool 3 and
  // pressed Apply on the panel (or the guided tool change applied it), and the
  // length is STILL IN FORCE in G54 Z when the file is loaded. The file's
  // G43 H3 must REPLACE that length, as on a real controller - never add a
  // second copy of it. Positive delta (a longer tool) and negative delta (a
  // shorter tool, which a double count drives |delta| too deep).
  for (const [label, probedZ] of [['longer', T3_PROBED_Z], ['shorter', REF_PROBED_Z - 20]] as const) {
    it(`a panel-applied tool-3 length left in force is not counted twice (${label} than the reference)`, async () => {
      measureTool3(probedZ)
      const row = toolOffsetLine(useMachineToolTable.getState().tableFor(MACHINE_ID), 3)
      const delta = row.ok ? row.deltaMm : NaN
      expect(delta).toBe(round(probedZ - REF_PROBED_Z))
      let mark = socket().sent.length
      expect(applyToolLengthOffset(delta)).toBe(true)
      await act(async () => { await vi.advanceTimersByTimeAsync(20) })
      const inForceG54Z = round(G54_OFFSET.z + delta)
      expect(offsetFrames(mark)).toEqual([`setWorkOffset(G54 z=${inForceG54Z})`])

      mark = socket().sent.length
      await load('tlo.nc', TLO_NC)
      await cycleStart()
      // The bridge adds the G54 Z IN FORCE (bare + delta) to each staged Z.
      // The machine Z must be the file's Z plus the bare G54 Z plus delta ONCE.
      const machineZ = stagedZ(mark).map((z) => round(z + inForceG54Z))
      expect(machineZ).toEqual([10, -1, 10].map((z) => round(z + G54_OFFSET.z + delta)))
      completeRun()
      await act(async () => { await vi.advanceTimersByTimeAsync(20) })
      expect(offsetFrames(mark)).toEqual([])
    })
  }

  it('an UNMEASURED tool 3 stages the file\'s own Z and is named in exactly one console row', async () => {
    const before = socket().sent.length
    await load('tlo-unmeasured.nc', TLO_NC)
    await cycleStart()
    expect(stagedZ(before)).toEqual([10, -1, 10])
    completeRun()
    await act(async () => { await vi.advanceTimersByTimeAsync(20) })
    expect(offsetFrames(before)).toEqual([])
    expect(consoleText().match(/no measured length/g)?.length).toBe(1)
  })

  it('a G43 Z.. H3 AFTER an XY positioning move is in force on the first Z move', async () => {
    // Fanuc/Haas-style Fusion preamble: position XY, then G43 with the Z
    // approach on the same block. The H3 length must govern the Z approach and
    // the cut, not only the end of the program.
    measureTool3()
    const before = socket().sent.length
    await load('tlo-xy-first.nc', 'G21 G90 G54\nT3 M6\nG0 X0 Y0\nG43 Z10 H3\nG1 Z-1 F300\nG0 Z10\nM30\n')
    await cycleStart()
    // Every Z after G43 H3 carries +45.2 - the approach, the cut, the retract.
    expect(stagedZ(before).slice(-3)).toEqual([10, -1, 10].map((z) => round(z + T3_DELTA)))
    completeRun()
    await act(async () => { await vi.advanceTimersByTimeAsync(20) })
    expect(offsetFrames(before)).toEqual([])
  })

  it('the length is in the moves the bridge stages before startJob, with no late offset write', async () => {
    // THE BRIDGE BAKES THE WORK OFFSET INTO THE STAGED MOVES AT loadMoves
    // (pendant/uccnc-bridge/Machine.cs LoadMoves: `oz = offsets[activeWcs, 2]`,
    // `r.Z = r.Z.Value + oz`, resolved into the staged list; StartJob streams
    // that list and reads no offset). So the length must be IN that list.
    measureTool3()
    const before = socket().sent.length
    await load('tlo.nc', TLO_NC)
    await cycleStart()
    const calls = wire(before)
    const lastStageAt = calls.lastIndexOf('loadMoves')
    const startAt = calls.indexOf('startJob')
    expect(lastStageAt).not.toBe(-1)
    expect(startAt).not.toBe(-1)
    expect(lastStageAt).toBeLessThan(startAt)
    expect(stagedZ(before)).toContain(round(-1 + T3_DELTA))
    expect(offsetFrames(before)).toEqual([])
  })

  it('a STOP mid-run leaves the operator\'s G54 Z exactly where it was', async () => {
    measureTool3()
    const before = socket().sent.length
    await load('tlo.nc', TLO_NC)
    await cycleStart()
    act(() => {
      socket().emit({ t: 'jobEvent', v: { event: 'started', fault: null } } as BridgeMessage)
    })
    let stopped = false
    act(() => { stopped = executeOperatorStopReset() })
    expect(stopped).toBe(true)
    act(() => {
      socket().emit({ t: 'status', v: idleBridgeStatus() } as BridgeMessage)
      socket().emit({ t: 'jobEvent', v: { event: 'stopped', fault: null } } as BridgeMessage)
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    // The run reached the wire carrying the length, and at no point - load,
    // Cycle Start, Stop or after - did anything write the work offset, so
    // there is nothing to restore and nothing left shifted.
    expect(wire(before)).toContain('stopJob')
    expect(stagedZ(before)).toContain(round(-1 + T3_DELTA))
    expect(offsetFrames(before)).toEqual([])
  })

  // THE REVIEW'S SECOND CASE (fix round 2): the program-internal M6. At the
  // hold the guided tool change measures tool 5 and applies its length into
  // G54 Z (ProgramPanel's Continue: recordProbedZ -> toolOffsetLine ->
  // applyToolLengthOffset). The section after the M6 is staged AFTER that, so
  // it must carry tool 5's length exactly once - whether tool 5 was already in
  // the table at load or first measured at this hold.
  const TWO_TOOL_NC = 'G21 G90 G54\nT3 M6\nG43 H3\nG0 X0 Y0 Z10\nG1 Z-1 F300\nG0 Z10\n'
    + 'T5 M6\nG43 H5\nG0 Z10\nG1 Z-1 F300\nG0 Z10\nG49\nM30\n'
  const T5_PROBED_Z = REF_PROBED_Z - 12.5
  for (const [label, measuredAtLoad] of [['measured before load', true], ['first measured at the hold', false]] as const) {
    it(`the M6 guided Continue's tool-5 length is counted once after the hold (${label})`, async () => {
      measureTool3()
      const tools = useMachineToolTable.getState()
      tools.addTool(MACHINE_ID, 5)
      if (measuredAtLoad) tools.recordProbedZ(MACHINE_ID, 5, T5_PROBED_Z, Date.now())
      const before = socket().sent.length
      await load('two-tool.nc', TWO_TOOL_NC)
      await cycleStart()
      // Tool 3's section: the length in force is none, so the fold is tool 3's.
      expect(stagedZ(before)).toEqual([10, -1, 10].map((z) => round(z + T3_DELTA)))

      // The section ends at T5 M6 and the program holds, at its retract.
      completeRun(round(10 + T3_DELTA + G54_OFFSET.z))
      await act(async () => { await vi.advanceTimersByTimeAsync(20) })
      // The guided Continue at the hold: measure tool 5, apply its length.
      useMachineToolTable.getState().recordProbedZ(MACHINE_ID, 5, T5_PROBED_Z, Date.now())
      const row = toolOffsetLine(useMachineToolTable.getState().tableFor(MACHINE_ID), 5)
      expect(row).toEqual({ ok: true, line: 'G43.1 Z-12.5', deltaMm: -12.5 })
      const mark = socket().sent.length
      expect(applyToolLengthOffset(-12.5)).toBe(true)
      await act(async () => { await vi.advanceTimersByTimeAsync(20) })
      const inForceG54Z = round(G54_OFFSET.z - 12.5)
      expect(offsetFrames(mark)).toEqual([`setWorkOffset(G54 z=${inForceG54Z})`])

      await cycleStart()
      // The bridge bakes the G54 Z in force (bare - 12.5) into the second
      // section. Machine Z = file Z + bare G54 Z + tool 5's length, once.
      const machineZ = stagedZ(mark).map((z) => round(z + inForceG54Z))
      expect(machineZ).toEqual([10, -1, 10].map((z) => round(z + G54_OFFSET.z - 12.5)))
    })
  }
})

describe('WO-1677: G43 H3 on the G-code-text path (simulator)', () => {
  beforeEach(async () => {
    await connect('simulator')
    for (const axis of ['X', 'Y', 'Z'] as const) {
      setWorkOffsetValue('G54', axis, axis === 'Z' ? -10 : 100)
      await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    }
  })

  it('stages the same tool-3 length the panel applies, and sends no G43.1/G49 of its own', async () => {
    measureTool3()
    const ctrl = getMachineController()
    const sent: string[] = []
    const original = ctrl.sendCommand.bind(ctrl)
    const spy = vi.spyOn(ctrl, 'sendCommand').mockImplementation((text: string) => {
      sent.push(text)
      return original(text)
    })
    const row = toolOffsetLine(useMachineToolTable.getState().tableFor(MACHINE_ID), 3)
    expect(applyToolLengthOffset(row.ok ? row.deltaMm : NaN)).toBe(true)
    expect(sent.filter((line) => /G43|G49/.test(line))).toEqual(['G43.1 Z45.2'])
    expect(clearToolLengthOffset()).toBe(true)
    sent.length = 0

    const staged: number[] = []
    type LoadProgram = NonNullable<typeof ctrl.loadProgram>
    const loadProgram: LoadProgram = ctrl.loadProgram!.bind(ctrl)
    const loadSpy = vi.spyOn(ctrl as { loadProgram: LoadProgram }, 'loadProgram').mockImplementation((program) => {
      for (const step of program.steps) {
        if (step.kind === 'line' && typeof step.to.z === 'number') staged.push(round(step.to.z))
      }
      return loadProgram(program)
    })
    await load('tlo.nc', TLO_NC)
    await cycleStart()
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
    // Preview and run read the same staged moves: the file's Z plus the
    // panel's 45.2, and no controller-side offset to leave behind.
    expect(staged).toEqual([10, -1, 10].map((z) => round(z + T3_DELTA)))
    expect(sent.filter((line) => /G43|G49/.test(line))).toEqual([])
    loadSpy.mockRestore()
    spy.mockRestore()
  })
})
