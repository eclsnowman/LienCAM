// @vitest-environment jsdom
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransport,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type { ControllerCapabilities, MachineStatus } from '../../lib/machine/controller'
import {
  createDefaultControllerDefinition,
  type ControllerSetting,
  type MachineConfig,
  type MachineOutputDefinition,
  type Project,
} from '../../types'
import { makeMachine } from '../post/helpers'
import { axisSoftLimitStatementKey } from '../../lib/machine/resolvedMachineMotion'
import { typedMock } from '../support/typedMock'

// WO-1637 - ONE GENERAL OUTPUT SWITCH, DRIVEN BY THE MACHINE DEFINITION.
//
// Operator ruling 2026-09-17: "They define the pins. They point them at the use cases
// like a pump or a vacuum or whatever they want to run in the macro and it
// works." Two halves, one file:
//
//  1. THE BRIDGE. The REAL Machine.cs is compiled with csc against the WO-1326
//     fake board, which records every SetOutputBit / ClearOutputBit and holds
//     the output word GetOutput reads. Each case hands Machine.SetOutput the
//     (port, pin, negate) a definition names - Operator's, and a different one.
//  2. THE APP. The real session singleton talking to a real `UccncController`
//     over a fake bridge socket: typed MDI, macro lines, the Flood / Mist /
//     accessory buttons' action identities and a loaded program's own M8, each
//     read off the `setOutput` calls that reached THE WIRE, for Operator's
//     definition and a different one, with no code edited between them.
//
// NOT CLAIMED: hardware. WO-1666 measured the DLL itself: SetOutputBit /
// ClearOutputBit take the UC pin number (1-based) and the GetOutput word holds
// bit = UCpin - 1; the fake board honours both. Tier 1 is the relay clicking.

const BRIDGE_DIR = resolve('pendant/uccnc-bridge')
const FAKE_BOARD_SOURCE = resolve('src/tests/evidence/WO-1326/FakeUC100.cs')
const CSC = join(
  process.env.WINDIR ?? 'C:\\Windows',
  'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe',
)

const HARNESS = `
using System;
using System.Reflection;
namespace LienCAM {
public static class Wo1637OutputHarness {
  static readonly BindingFlags Priv = BindingFlags.NonPublic | BindingFlags.Instance;
  static void Set(Machine m, string name, object v) {
    FieldInfo f = typeof(Machine).GetField(name, Priv);
    if (f == null) throw new Exception("Machine has no field '" + name + "' - the harness is stale");
    f.SetValue(m, v);
  }

  static Machine Primed(bool readOnly) {
    Machine m = new Machine();
    Set(m, "opened", true);
    Set(m, "sentinelPassed", true);
    Set(m, "pinTable", BoardPinTables.AxbbE);
    Set(m, "readOnly", readOnly);
    m.LiveConsole = delegate(string text, string severity) { };
    return m;
  }

  static string Show(object v) { return v == null ? "null" : v.ToString(); }

  // One switch. Prints ok, the board's output calls, and the readback.
  static void Sw(string label, Machine m, int port, int pin, bool on, bool negate) {
    FakeBoard.OutputCalls.Clear();
    string err; Json.Obj rb;
    bool ok = m.SetOutput(port, pin, on, negate, out err, out rb);
    Console.WriteLine(label + ".ok=" + ok);
    Console.WriteLine(label + ".calls=" + string.Join(",", FakeBoard.OutputCalls.ToArray()));
    Console.WriteLine(label + ".err=" + Show(err));
    Console.WriteLine(label + ".ucPin=" + Show(rb == null ? null : rb["ucPin"]));
    Console.WriteLine(label + ".level=" + Show(rb == null ? null : rb["level"]));
    Console.WriteLine(label + ".on=" + Show(rb == null ? null : rb["on"]));
  }

  public static void Main(string[] args) {
    // SAMPLE_MACHINE'S DEFINITION (LienCNCV2.pro): M8 flood port 3 pin 14, M7 mist port 3 pin 16.
    FakeBoard.Reset();
    UC100.SetOffline(false);
    Machine m = Primed(false);
    Sw("sampleMachineFlood", m, 3, 14, true, false);
    Sw("sampleMachineMist", m, 3, 16, true, false);
    Sw("sampleMachineM9flood", m, 3, 14, false, false);
    Sw("sampleMachineM9mist", m, 3, 16, false, false);

    // A DIFFERENT DEFINITION: flood on port 1 pin 16 NEGATED, a vacuum on port 3
    // pin 1, a pump on port 1 pin 17. Same code.
    FakeBoard.Reset();
    m = Primed(false);
    Sw("otherFlood", m, 1, 16, true, true);
    Sw("otherFloodOff", m, 1, 16, false, true);
    Sw("otherVacuum", m, 3, 1, true, false);
    Sw("otherPump", m, 1, 17, true, false);

    // An INPUT pin named as an output: nothing is sent.
    FakeBoard.Reset();
    Sw("input", Primed(false), 2, 1, true, false);

    // Controller E-STOP: ON refused, OFF passes.
    FakeBoard.Reset();
    FakeBoard.StatusEstop = true;
    m = Primed(false);
    Sw("estopOn", m, 3, 14, true, false);
    Sw("estopOff", m, 3, 14, false, false);

    // Outputs inhibited: ON refused, OFF passes.
    FakeBoard.Reset();
    UC100.SetOffline(true);
    m = Primed(false);
    Sw("inhibitOn", m, 3, 14, true, false);
    Sw("inhibitOff", m, 3, 14, false, false);
    UC100.SetOffline(false);

    // Read-only bridge: ON refused, OFF passes.
    FakeBoard.Reset();
    m = Primed(true);
    Sw("readOnlyOn", m, 3, 14, true, false);
    Sw("readOnlyOff", m, 3, 14, false, false);

    // The board cannot report its outputs: switched, readback unknown.
    FakeBoard.Reset();
    FakeBoard.OutputRc = 7;
    Sw("unreadable", Primed(false), 3, 14, true, false);

    Console.WriteLine("harness.done=True");
  }
}}
`

function runHarness(): Map<string, string> {
  const root = mkdtempSync(join(tmpdir(), 'liencam-wo1637-'))
  const source = join(root, 'Harness.cs')
  const executable = join(root, 'Harness.exe')
  writeFileSync(source, HARNESS)
  try {
    execFileSync(CSC, [
      '/nologo', '/unsafe', `/out:${executable}`, '/main:LienCAM.Wo1637OutputHarness',
      resolve(BRIDGE_DIR, 'Bridge.cs'), resolve(BRIDGE_DIR, 'Machine.cs'),
      resolve(BRIDGE_DIR, 'Json.cs'), resolve(BRIDGE_DIR, 'Vfd.cs'),
      FAKE_BOARD_SOURCE, source,
    ], { stdio: 'pipe' })
    const out = execFileSync(executable, [], { encoding: 'utf8', timeout: 60_000 })
    const rows = new Map<string, string>()
    for (const line of out.split(/\r?\n/)) {
      const m = /^([A-Za-z0-9]+\.[A-Za-z]+)=(.*)$/.exec(line)
      if (m) rows.set(m[1], m[2])
    }
    return rows
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

let output: Map<string, string> | undefined
const row = (key: string): string | undefined => (output ??= runHarness()).get(key)

describe.skipIf(!existsSync(CSC))('WO-1637 bridge: one output switch for any pin the definition names', () => {
  it('ran every scenario', () => {
    expect(row('harness.done')).toBe('True')
  }, 120_000)

  it("Operator's M8 flood (port 3 pin 14) and M7 mist (port 3 pin 16) set their own board bits", () => {
    // AxbbPinDef: port 3 pin 14 -> UCpin 35, port 3 pin 16 -> UCpin 3.
    expect(row('sampleMachineFlood.ok')).toBe('True')
    expect(row('sampleMachineFlood.calls')).toBe('set 35')
    expect(row('sampleMachineFlood.ucPin')).toBe('35')
    expect(row('sampleMachineFlood.on')).toBe('True')
    expect(row('sampleMachineMist.calls')).toBe('set 3')
    expect(row('sampleMachineMist.ucPin')).toBe('3')
    expect(row('sampleMachineMist.on')).toBe('True')
  })

  it('M9 clears both, and the readback says off', () => {
    expect(row('sampleMachineM9flood.calls')).toBe('clear 35')
    expect(row('sampleMachineM9flood.on')).toBe('False')
    expect(row('sampleMachineM9mist.calls')).toBe('clear 3')
    expect(row('sampleMachineM9mist.on')).toBe('False')
  })

  it('a different definition fires exactly its own pins, with its polarity', () => {
    // port 1 pin 16 -> UCpin 11; negated, so ON drives the terminal LOW.
    expect(row('otherFlood.calls')).toBe('clear 11')
    expect(row('otherFlood.level')).toBe('False')
    expect(row('otherFlood.on')).toBe('True')
    expect(row('otherFloodOff.calls')).toBe('set 11')
    expect(row('otherFloodOff.on')).toBe('False')
    // port 3 pin 1 -> UCpin 38; port 1 pin 17 -> UCpin 25.
    expect(row('otherVacuum.calls')).toBe('set 38')
    expect(row('otherPump.calls')).toBe('set 25')
  })

  it('a pin that is not an output on this board sends nothing and says so', () => {
    expect(row('input.ok')).toBe('False')
    expect(row('input.calls')).toBe('')
    expect(row('input.err')).toContain('port 2 pin 1 is not an output')
  })

  it('E-STOP: ON is refused with nothing sent, OFF passes', () => {
    expect(row('estopOn.ok')).toBe('False')
    expect(row('estopOn.calls')).toBe('')
    expect(row('estopOn.err')).toContain('E-STOP')
    expect(row('estopOff.ok')).toBe('True')
    expect(row('estopOff.calls')).toBe('clear 35')
  })

  it('inhibited outputs: ON is refused naming the inhibit, OFF passes', () => {
    expect(row('inhibitOn.ok')).toBe('False')
    expect(row('inhibitOn.calls')).toBe('')
    expect(row('inhibitOn.err')).toContain('inhibited')
    expect(row('inhibitOff.calls')).toBe('clear 35')
  })

  it('read-only bridge: ON refused, OFF passes', () => {
    expect(row('readOnlyOn.ok')).toBe('False')
    expect(row('readOnlyOn.calls')).toBe('')
    expect(row('readOnlyOff.ok')).toBe('True')
    expect(row('readOnlyOff.calls')).toBe('clear 35')
  })

  it('an unreadable output word: switched, readback unknown rather than invented', () => {
    expect(row('unreadable.ok')).toBe('True')
    expect(row('unreadable.calls')).toBe('set 35')
    expect(row('unreadable.level')).toBe('null')
    expect(row('unreadable.on')).toBe('null')
  })
})

// ===========================================================================
// 2. THE APP: every route resolves pins from the definition, and only from it.
// ===========================================================================

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

const OFFSET = { x: 0, y: 0, z: 0 }

interface FakeBridgeTransport extends BridgeTransport {
  sent: BridgeCallMessage[]
  emit(message: BridgeMessage): void
}

const bridgeSockets: FakeBridgeTransport[] = []
/** A bridge refusal to answer `setOutput` with, when set. */
let outputRefusal: string | null = null
/** WO-1800: the fake board's output word. A successful `setOutput` stores the
 *  RAW terminal level (`on !== negate`) per port:pin; `getOutput` reads that
 *  stored level and derives the logical `on` with the requested negate,
 *  exactly like Machine.ReadOutputCore. The read never re-drives a pin. */
const rawOutputLevels = new Map<string, boolean>()

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
        G54: { ...OFFSET }, G55: { ...OFFSET }, G56: { ...OFFSET },
        G57: { ...OFFSET }, G58: { ...OFFSET }, G59: { ...OFFSET },
      }
      events.onMessage({
        t: 'hello',
        v: {
          protocol: 1,
          bridge: 'wo-1637-fake 0.0',
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
      if (message.m === 'setOutput') {
        const a = message.a as { port: number; pin: number; on: boolean; negate: boolean }
        if (outputRefusal !== null) {
          this.fakeEvents?.onMessage({ t: 'reply', seq: message.seq, ok: false, error: outputRefusal } as BridgeMessage)
          return
        }
        rawOutputLevels.set(`${a.port}:${a.pin}`, a.on !== a.negate)
        this.fakeEvents?.onMessage({
          t: 'reply',
          seq: message.seq,
          ok: true,
          v: { port: a.port, pin: a.pin, ucPin: 99, level: a.on !== a.negate, on: a.on },
        })
      }
      if (message.m === 'getOutput') {
        // WO-1800: the real read-only verb. It answers from the stored RAW
        // level and applies the requested negate; a pin never written reads
        // low, like a cleared output word.
        const a = message.a as { port: number; pin: number; negate: boolean }
        const level = rawOutputLevels.get(`${a.port}:${a.pin}`) ?? false
        this.fakeEvents?.onMessage({
          t: 'reply',
          seq: message.seq,
          ok: true,
          v: { port: a.port, pin: a.pin, ucPin: 99, level, on: level !== a.negate },
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
  return typedMock<typeof import('../../lib/machine/bridgeTransport')>({ ...actual, BridgeTransport: Fake })
})

const { uccncProfileOutputs } = await import('../../lib/machine/uccncProfileImport')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineActions } = await import('../../store/machineActionsStore')
const { executeOperatorCycleStart } = await import('../../lib/machine/operatorTransport')
const {
  ACTION_REFUSAL,
  __armEstopInterlockForTest,
  __resetEstopInterlockForTest,
  clearPathFidelity,
  connectMachine,
  disconnectMachine,
  getMachineController,
  loadGcodeTextToolpathProgram,
  runMachineAction,
  sendMdiLine,
} = await import('../../lib/machine/machineSession')

function spindleSetup(key: string, value: number | boolean): ControllerSetting {
  return {
    controller: 'uccnc',
    key: `Spindlesetupsettings.${key}`,
    value: typeof value === 'number' ? { kind: 'number', value } : { kind: 'boolean', value },
  }
}

/** Operator's LienCNCV2.pro, lines 264-288 - TEST DATA. */
const SAMPLE_MACHINE_RELAYS: ControllerSetting[] = [
  spindleSetup('Floodmistrelaysenabled', true),
  spindleSetup('M7relayport', 3), spindleSetup('M7relaypin', 16), spindleSetup('M7relaypinnegate', false),
  spindleSetup('M8relayport', 3), spindleSetup('M8relaypin', 14), spindleSetup('M8relaypinnegate', false),
  spindleSetup('M7ondelay', 1000), spindleSetup('M8ondelay', 1000), spindleSetup('M9delay', 0),
  spindleSetup('Spindlerelaysenabled', true),
  spindleSetup('M3relayport', 0), spindleSetup('M3relaypin', 0),
  spindleSetup('M4relayport', 0), spindleSetup('M4relaypin', 0),
]

/** A different user's machine: flood on port 1 pin 16 NEGATED, no mist, a
 *  vacuum on M10/M11 (port 3 pin 1), a pump on M12/M13 (port 1 pin 17) with its
 *  own on-delay, and a dust boot on M14 nobody has wired yet. */
const OTHER_RELAYS: ControllerSetting[] = [
  spindleSetup('Floodmistrelaysenabled', true),
  spindleSetup('M8relayport', 1), spindleSetup('M8relaypin', 16), spindleSetup('M8relaypinnegate', true),
  spindleSetup('M8ondelay', 0),
]
const OTHER_OUTPUTS: MachineOutputDefinition[] = [
  { name: 'vacuum', role: 'vacuum', onCode: 'M10', offCode: 'M11', pin: { port: 3, pin: 1, negate: false } },
  { name: 'coolant pump', onCode: 'M12', offCode: 'M13', pin: { port: 1, pin: 17, negate: false }, onDelayMs: 500 },
  { name: 'dust boot', onCode: 'M14', offCode: null, pin: { port: 0, pin: 0, negate: null } },
]

function uccncMachine(settings: ControllerSetting[], outputs?: MachineOutputDefinition[]): MachineConfig {
  const controllerDefinition = createDefaultControllerDefinition()
  for (const axis of controllerDefinition.axes) {
    axis.softLimitMin = axis.axis === 'Z' ? -50 : 0
    axis.softLimitMax = axis.axis === 'X' ? 600 : axis.axis === 'Y' ? 400 : 150
  }
  controllerDefinition.stated = controllerDefinition.axes.flatMap((axis) =>
    (['min', 'max'] as const).map((end) => ({
      controller: 'uccnc' as const,
      key: axisSoftLimitStatementKey(axis.axis, end),
    })),
  )
  controllerDefinition.settings = settings
  // WO-1649: the profile's own relays are list entries, filled by the importer's
  // own `uccncProfileOutputs`; a hand-made output is appended to the same list.
  controllerDefinition.outputs = [...uccncProfileOutputs(controllerDefinition), ...(outputs ?? [])]
  return makeMachine({
    id: 'wo1637-machine',
    name: 'WO-1637 Test Machine',
    controller: 'uccnc',
    travel: { x: 600, y: 400, z: 200 },
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'min', homePositionMm: -50 },
    },
    rapidRate: 5000,
    controllerDefinition,
  })
}

function install(target: MachineConfig): void {
  const state = useCamStore.getState()
  useCamStore.setState({
    machineLibrary: [target],
    project: { ...state.project, machine: target, setups: [], activeSetupId: null },
    control: {
      ...state.control,
      activeMachineId: target.id,
      sessionMachine: null,
      appliedMachine: null,
      sessionActiveMachineId: undefined,
    },
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
let originalLibrary: MachineConfig[]
let originalControl: ReturnType<typeof useCamStore.getState>['control']

function socket(): FakeBridgeTransport {
  return bridgeSockets[bridgeSockets.length - 1]
}

function consoleText(): string {
  return useMachineControl.getState().consoleLines.map((line) => line.text).join('\n')
}

interface WireOutput { port: number; pin: number; on: boolean; negate: boolean }

function outputsSince(mark: number): WireOutput[] {
  return socket().sent.slice(mark).filter((m) => m.m === 'setOutput').map((m) => m.a as unknown as WireOutput)
}

function callsSince(mark: number): string[] {
  return socket().sent.slice(mark).map((m) => m.m)
}

async function connect(target: MachineConfig): Promise<void> {
  install(target)
  const pending = connectMachine('bridge')
  await vi.advanceTimersByTimeAsync(300)
  await pending
  act(() => { __resetEstopInterlockForTest() })
  act(() => {
    socket().emit({ t: 'status', v: idleBridgeStatus() } as BridgeMessage)
    socket().emit({ t: 'homed', v: { axes: ['X', 'Y', 'Z'] } } as BridgeMessage)
  })
  act(() => { useMachineControl.getState().setProgram(null, null, [], null) })
}

async function settle(ms = 10): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

describe('WO-1637 app: one resolver, every route', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    bridgeSockets.length = 0
    outputRefusal = null
    rawOutputLevels.clear()
    originalProject = useCamStore.getState().project
    originalLibrary = useCamStore.getState().machineLibrary
    originalControl = useCamStore.getState().control
  })

  afterEach(async () => {
    if (getMachineController().connectionPhase() !== 'disconnected') {
      const pending = disconnectMachine()
      await vi.advanceTimersByTimeAsync(300)
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

  describe("Operator's definition", () => {
    beforeEach(async () => { await connect(uccncMachine(SAMPLE_MACHINE_RELAYS)) })

    it('typed M8 switches port 3 pin 14 on and says what reached the board', async () => {
      const mark = socket().sent.length
      expect(sendMdiLine('M8')).toBe(true)
      await settle()
      expect(outputsSince(mark)).toEqual([{ port: 3, pin: 14, on: true, negate: false }])
      // WO-1800: the sentence waits for the bounded, read-only getOutput to
      // match the accepted write. Advance past the first 50 ms confirmation
      // poll - the write above is the only actuation; later traffic is reads.
      await settle(60)
      expect(callsSince(mark)).toContain('getOutput')
      expect(consoleText()).toContain(
        "MDI M8: flood coolant on (port 3 pin 14) (controller readback confirmed); motion waits 1000 ms (the definition's on-delay).",
      )
    })

    it('typed M7 switches port 3 pin 16', async () => {
      const mark = socket().sent.length
      expect(sendMdiLine('M7')).toBe(true)
      await settle()
      expect(outputsSince(mark)).toEqual([{ port: 3, pin: 16, on: true, negate: false }])
    })

    it('typed M9 clears both relays', async () => {
      const mark = socket().sent.length
      expect(sendMdiLine('M9')).toBe(true)
      await settle()
      expect(outputsSince(mark)).toEqual([
        { port: 3, pin: 14, on: false, negate: false },
        { port: 3, pin: 16, on: false, negate: false },
      ])
    })

    it('a macro [M8, G53 G0 Z120]: the relay first, the move released only after the 1000 ms on-delay', async () => {
      const mark = socket().sent.length
      const result = runMachineAction(['M8', 'G53 G0 Z120'])
      await settle()
      expect(result).toEqual({ ok: true, sent: 2 })
      expect(outputsSince(mark)).toEqual([{ port: 3, pin: 14, on: true, negate: false }])
      expect(callsSince(mark)).toContain('loadMoves')
      expect(callsSince(mark)).not.toContain('startJob')
      await settle(900)
      expect(callsSince(mark)).not.toContain('startJob')
      await settle(200)
      expect(callsSince(mark)).toContain('startJob')
    })

    it('an E-STOP during the on-delay releases nothing', async () => {
      const mark = socket().sent.length
      runMachineAction(['M8', 'G53 G0 Z120'])
      await settle()
      act(() => { getMachineController().emergencyStop() })
      await settle(1500)
      expect(callsSince(mark)).not.toContain('startJob')
    })

    it('an E-STOP during the on-delay leaves nothing to hold a later, unrelated move', async () => {
      runMachineAction(['M8', 'G53 G0 Z120'])
      await settle(200)
      act(() => { getMachineController().emergencyStop() })
      act(() => { __resetEstopInterlockForTest() })
      const mark = socket().sent.length
      expect(runMachineAction(['G53 G0 Z120'])).toEqual({ ok: true, sent: 1 })
      await settle(50)
      expect(callsSince(mark)).toContain('startJob')
    })

    it("the Flood and Mist buttons' actions and Coolant Off take the same route", async () => {
      let mark = socket().sent.length
      expect(runMachineAction(['M8'], { action: 'coolantFlood' })).toEqual({ ok: true, sent: 1 })
      expect(runMachineAction(['M7'], { action: 'coolantMist' })).toEqual({ ok: true, sent: 1 })
      await settle()
      expect(outputsSince(mark).map((o) => [o.pin, o.on])).toEqual([[14, true], [16, true]])
      mark = socket().sent.length
      expect(runMachineAction(['M9'], { action: 'coolantOff' })).toEqual({ ok: true, sent: 1 })
      await settle()
      expect(outputsSince(mark).map((o) => [o.pin, o.on])).toEqual([[14, false], [16, false]])
    })

    it("a loaded program's own M8 between parts switches the relay and holds the next part for the on-delay", async () => {
      const target = uccncMachine(SAMPLE_MACHINE_RELAYS)
      target.coolantCapability = { flood: true }
      const pending = disconnectMachine()
      await vi.advanceTimersByTimeAsync(300)
      await pending
      await connect(target)
      const loaded = loadGcodeTextToolpathProgram(
        'flood.nc',
        'G21 G90 G54\nG0 X0 Y0 Z10\nG1 Z-1 F300\nM8\nG1 X5 F300\nG0 Z10\nM30\n',
      )
      await settle()
      expect(loaded).toEqual({ ok: true, reason: null })
      expect(await executeOperatorCycleStart()).toBe(true)
      await settle()
      const mark = socket().sent.length
      act(() => {
        socket().emit({
          t: 'status',
          v: { ...idleBridgeStatus(), buffer: { moves: 0, capacitySeconds: null } },
        } as BridgeMessage)
        socket().emit({ t: 'jobEvent', v: { event: 'completed', fault: null } } as BridgeMessage)
      })
      await settle()
      expect(outputsSince(mark)).toEqual([{ port: 3, pin: 14, on: true, negate: false }])
      expect(callsSince(mark)).not.toContain('startJob')
      await settle(1100)
      expect(callsSince(mark)).toContain('startJob')
    })

    // 2026-09-17 at the machine (finding h): Operator's real definition states the
    // M7 relay pin 16 but its coolant HAS IT flag is "Not stated", and a loaded
    // program's M7 was refused with "this machine states no such output" while
    // the typed M7 switched the pin. The file's word takes the SAME route as
    // the typed word: the definition's pin decides, not the older flag.
    it("a loaded program's M7 switches the definition's pin even when HAS IT is not stated", async () => {
      const target = uccncMachine(SAMPLE_MACHINE_RELAYS)
      delete (target as { coolantCapability?: unknown }).coolantCapability
      const pending = disconnectMachine()
      await vi.advanceTimersByTimeAsync(300)
      await pending
      await connect(target)
      const loaded = loadGcodeTextToolpathProgram(
        'mist.nc',
        'G21 G90 G54\nG0 X0 Y0 Z10\nG1 Z-1 F300\nM7\nG1 X5 F300\nM9\nG0 Z10\nM30\n',
      )
      await settle()
      expect(loaded).toEqual({ ok: true, reason: null })
      expect(consoleText()).not.toContain('states no such output')
      expect(await executeOperatorCycleStart()).toBe(true)
      await settle()
      const mark = socket().sent.length
      act(() => {
        socket().emit({
          t: 'status',
          v: { ...idleBridgeStatus(), buffer: { moves: 0, capacitySeconds: null } },
        } as BridgeMessage)
        socket().emit({ t: 'jobEvent', v: { event: 'completed', fault: null } } as BridgeMessage)
      })
      await settle()
      expect(outputsSince(mark)).toEqual([{ port: 3, pin: 16, on: true, negate: false }])
      expect(consoleText()).toContain(': mist coolant on (M7, port 3 pin 16).')
      expect(consoleText()).not.toContain('states no such output')
    })

    // WO-1649: the file's M7 means mist, and mist on THIS machine is whatever
    // its one output list says - here a hand-listed entry on M107. No relay
    // setting is involved; the list alone answers.
    it("a loaded program's M7 switches the mist the output list names, on its own word", async () => {
      const target = uccncMachine([])
      // A hand-made list: nothing the profile importer wrote, only this entry.
      target.controllerDefinition!.outputs = [
        { name: 'mist coolant', role: 'mist', onCode: 'M107', offCode: null, pin: { port: 2, pin: 5, negate: false } },
      ]
      delete (target as { coolantCapability?: unknown }).coolantCapability
      const pending = disconnectMachine()
      await vi.advanceTimersByTimeAsync(300)
      await pending
      await connect(target)
      const loaded = loadGcodeTextToolpathProgram(
        'mist.nc',
        'G21 G90 G54\nG0 X0 Y0 Z10\nG1 Z-1 F300\nM7\nG1 X5 F300\nM9\nG0 Z10\nM30\n',
      )
      await settle()
      expect(loaded).toEqual({ ok: true, reason: null })
      expect(consoleText()).not.toContain('states no such output')
      expect(await executeOperatorCycleStart()).toBe(true)
      await settle()
      const mark = socket().sent.length
      act(() => {
        socket().emit({
          t: 'status',
          v: { ...idleBridgeStatus(), buffer: { moves: 0, capacitySeconds: null } },
        } as BridgeMessage)
        socket().emit({ t: 'jobEvent', v: { event: 'completed', fault: null } } as BridgeMessage)
      })
      await settle()
      expect(outputsSince(mark)).toEqual([{ port: 2, pin: 5, on: true, negate: false }])
      expect(consoleText()).not.toContain('states no such output')
    })
  })

  describe('a different definition - same code, its own pins', () => {
    beforeEach(async () => {
      await connect(uccncMachine(OTHER_RELAYS, OTHER_OUTPUTS))
    })

    it('M8 fires port 1 pin 16 with its negate', async () => {
      const mark = socket().sent.length
      expect(sendMdiLine('M8')).toBe(true)
      await settle()
      expect(outputsSince(mark)).toEqual([{ port: 1, pin: 16, on: true, negate: true }])
      // WO-1800: the negated write drove the terminal LOW; the later read-only
      // getOutput sees raw level false and derives on=true through the negate,
      // so confirmation matches without echoing the request.
      await settle(60)
      expect(callsSince(mark)).toContain('getOutput')
      expect(consoleText()).toContain(
        'MDI M8: flood coolant on (port 1 pin 16, inverted) (controller readback confirmed).',
      )
    })

    it('M7 is not assigned: one console line names the setting, nothing sent', async () => {
      const mark = socket().sent.length
      expect(sendMdiLine('M7')).toBe(false)
      await settle()
      expect(outputsSince(mark)).toEqual([])
      expect(consoleText()).toContain(
        'MDI M7: M7 switches mist coolant, and this machine definition assigns it no pin - '
        + 'fill in the pin of the "mist coolant" output in the machine definition',
      )
    })

    it('the vacuum button action (M10) and its off word fire port 3 pin 1', async () => {
      const mark = socket().sent.length
      expect(runMachineAction(['M10'], { action: 'coolantFlood' })).toEqual({ ok: true, sent: 1 })
      expect(sendMdiLine('M11')).toBe(true)
      await settle()
      expect(outputsSince(mark)).toEqual([
        { port: 3, pin: 1, on: true, negate: false },
        { port: 3, pin: 1, on: false, negate: false },
      ])
    })

    it('a macro running the custom pump code M12 fires port 1 pin 17 and waits its own on-delay', async () => {
      const mark = socket().sent.length
      expect(runMachineAction(['M12', 'G53 G0 Z100'])).toEqual({ ok: true, sent: 2 })
      await settle()
      expect(outputsSince(mark)).toEqual([{ port: 1, pin: 17, on: true, negate: false }])
      expect(callsSince(mark)).not.toContain('startJob')
      await settle(600)
      expect(callsSince(mark)).toContain('startJob')
    })

    it('M9 clears every assigned output of THIS definition and nothing else', async () => {
      const mark = socket().sent.length
      expect(sendMdiLine('M9')).toBe(true)
      await settle()
      expect(outputsSince(mark)).toEqual([
        { port: 1, pin: 16, on: false, negate: true },
        { port: 3, pin: 1, on: false, negate: false },
        { port: 1, pin: 17, on: false, negate: false },
      ])
    })

    it('an output with no pin (dust boot M14): the named console line, nothing sent', async () => {
      const mark = socket().sent.length
      expect(sendMdiLine('M14')).toBe(false)
      await settle()
      expect(outputsSince(mark)).toEqual([])
      expect(consoleText()).toContain(
        'MDI M14: M14 switches dust boot, and this machine definition assigns it no pin - '
        + 'fill in the pin of the "dust boot" output in the machine definition',
      )
    })

    it('a bridge refusal is reported as a refusal, not a success', async () => {
      outputRefusal = 'the outputs are inhibited, so port 3 pin 1 cannot be energised'
      sendMdiLine('M10')
      await settle()
      expect(consoleText()).toContain('MDI M10: vacuum on (port 3 pin 1) was refused: the outputs are inhibited')
    })
  })

  describe('E-STOP latched: ON refused, OFF passes', () => {
    beforeEach(async () => {
      await connect(uccncMachine(OTHER_RELAYS, OTHER_OUTPUTS))
      act(() => { __armEstopInterlockForTest() })
    })

    it.each(['M8', 'M10', 'M12'])('typed %s: nothing on the wire, the E-STOP reason', async (line) => {
      const mark = socket().sent.length
      expect(sendMdiLine(line)).toBe(false)
      await settle()
      expect(outputsSince(mark)).toEqual([])
      expect(consoleText()).toContain(`MDI ${line}: ${ACTION_REFUSAL.estop}`)
    })

    it('a Flood button press: refused by the latch', async () => {
      const mark = socket().sent.length
      expect(runMachineAction(['M8'], { action: 'coolantFlood' }))
        .toEqual({ ok: false, sent: 0, reason: ACTION_REFUSAL.estop })
      await settle()
      expect(outputsSince(mark)).toEqual([])
    })

    it.each([
      ['M9', 3],
      ['M11', 1],
      ['M13', 1],
    ] as const)('typed %s passes and clears its pins', async (line, count) => {
      const mark = socket().sent.length
      expect(sendMdiLine(line)).toBe(true)
      await settle()
      const sent = outputsSince(mark)
      expect(sent).toHaveLength(count)
      expect(sent.every((o) => !o.on)).toBe(true)
    })

    it('an untyped macro [M11] and Coolant Off [M9] pass', async () => {
      const mark = socket().sent.length
      expect(runMachineAction(['M11'])).toEqual({ ok: true, sent: 1 })
      expect(runMachineAction(['M9'], { action: 'coolantOff' })).toEqual({ ok: true, sent: 1 })
      await settle()
      expect(outputsSince(mark).every((o) => !o.on)).toBe(true)
      expect(outputsSince(mark)).toHaveLength(4)
    })
  })
})

// WO-1650: A LOADED PROGRAM'S OWN OUTPUT WORDS, on a hand-made list - a pump on
// M10 and air on M11, words no dialect carries. The file loads, runs on the
// fake bridge, and each word switches the pin the list names; M9 stops both.
describe('WO-1650: a loaded program switches the outputs its machine lists', () => {
  const PUMP_AND_AIR: MachineOutputDefinition[] = [
    { name: 'coolant pump', onCode: 'M10', offCode: null, pin: { port: 1, pin: 17, negate: false } },
    { name: 'air', onCode: 'M11', offCode: null, pin: { port: 2, pin: 3, negate: true } },
  ]

  beforeEach(async () => {
    vi.useFakeTimers()
    bridgeSockets.length = 0
    outputRefusal = null
    rawOutputLevels.clear()
    originalProject = useCamStore.getState().project
    originalLibrary = useCamStore.getState().machineLibrary
    originalControl = useCamStore.getState().control
    await connect(uccncMachine([], PUMP_AND_AIR))
  })

  afterEach(async () => {
    if (getMachineController().connectionPhase() !== 'disconnected') {
      const pending = disconnectMachine()
      await vi.advanceTimersByTimeAsync(300)
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
    act(() => { __resetEstopInterlockForTest() })
    act(() => { useMachineControl.getState().setProgram(null, null, [], null) })
    vi.useRealTimers()
  })

  async function completePart(): Promise<void> {
    act(() => {
      socket().emit({
        t: 'status',
        v: { ...idleBridgeStatus(), buffer: { moves: 0, capacitySeconds: null } },
      } as BridgeMessage)
      socket().emit({ t: 'jobEvent', v: { event: 'completed', fault: null } } as BridgeMessage)
    })
    await settle()
  }

  it('M10 / M11 / M9 load, run, and switch exactly the listed pins at their lines', async () => {
    const loaded = loadGcodeTextToolpathProgram(
      'pump-air.nc',
      'G21 G90 G54\nG0 X0 Y0 Z10\nM10\nG1 Z-1 F300\nM11\nG1 X5 F300\nM9\nG0 Z10\nM30\n',
    )
    await settle()
    expect(loaded).toEqual({ ok: true, reason: null })
    expect(consoleText()).not.toContain('not in the UCCNC G-code word table')
    expect(await executeOperatorCycleStart()).toBe(true)
    await settle()

    let mark = socket().sent.length
    await completePart()
    expect(outputsSince(mark)).toEqual([{ port: 1, pin: 17, on: true, negate: false }])
    expect(consoleText()).toContain('Line 3: the file switches M10 coolant pump on (port 1 pin 17)')

    mark = socket().sent.length
    await completePart()
    expect(outputsSince(mark)).toEqual([{ port: 2, pin: 3, on: true, negate: true }])

    mark = socket().sent.length
    await completePart()
    expect(outputsSince(mark)).toEqual([
      { port: 1, pin: 17, on: false, negate: false },
      { port: 2, pin: 3, on: false, negate: true },
    ])
  })

  it('a pump switched on in the preamble goes out when the first move is released', async () => {
    const loaded = loadGcodeTextToolpathProgram(
      'pump-first.nc',
      'G21 G90 G54\nM10\nG0 X0 Y0 Z10\nG1 Z-1 F300\nM9\nG0 Z10\nM30\n',
    )
    await settle()
    expect(loaded).toEqual({ ok: true, reason: null })
    const mark = socket().sent.length
    expect(await executeOperatorCycleStart()).toBe(true)
    await settle()
    expect(outputsSince(mark)).toEqual([{ port: 1, pin: 17, on: true, negate: false }])
  })
})
