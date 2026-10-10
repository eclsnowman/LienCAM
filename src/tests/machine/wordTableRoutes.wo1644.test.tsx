// @vitest-environment jsdom
//
// WO-1644 - ONE G-CODE WORD TABLE PER DIALECT, READ BY EVERY ROUTE.
//
// Acceptance, behavioural: over every file in src/tests/fixtures/foreign-gcode/,
// each G and M word is accepted identically by the shared reader, the typed MDI
// line and the loaded-program door; and a word removed from the table is
// refused identically by all three, with the same sentence.
//
// The MDI and program routes run through the real session singleton on a real
// `UccncController` over a fake bridge socket, as the WO-1636 suite does. The
// file itself also runs whole through the interpreter the program door uses.
//
// NOT CLAIMED: hardware. Nothing here is a board readback.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
import { interpretGcodeProgram, readGcodeProgram } from '../../lib/gcode'
import {
  gcodeWordEntry,
  gcodeWordRefusal,
  gcodeWordTable,
  gcodeWordTableWithout,
  isGcodeMacroMCode,
  useGcodeWordTable,
} from '../../lib/gcode/wordTable'

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

const OFFSET = { x: 10, y: 5, z: 2 }

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
        G54: { ...OFFSET }, G55: { x: 110, y: 5, z: 2 }, G56: { ...OFFSET },
        G57: { ...OFFSET }, G58: { ...OFFSET }, G59: { ...OFFSET },
      }
      events.onMessage({
        t: 'hello',
        v: {
          protocol: 1,
          bridge: 'wo-1644-fake 0.0',
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

const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const {
  __resetEstopInterlockForTest,
  connectMachine,
  disconnectMachine,
  getMachineController,
  loadGcodeTextToolpathProgram,
  sendMdiLine,
} = await import('../../lib/machine/machineSession')

function uccncMachine(): MachineConfig {
  const controllerDefinition = createDefaultControllerDefinition()
  for (const axis of controllerDefinition.axes) {
    axis.softLimitMin = axis.axis === 'Z' ? -60 : 0
    axis.softLimitMax = axis.axis === 'X' ? 600 : axis.axis === 'Y' ? 400 : 150
  }
  controllerDefinition.stated = controllerDefinition.axes.flatMap((axis) =>
    (['min', 'max'] as const).map((end) => ({
      controller: 'uccnc' as const,
      key: axisSoftLimitStatementKey(axis.axis, end),
    })),
  )
  return makeMachine({
    id: 'wo1644-machine',
    name: 'WO-1644 Test Machine',
    controller: 'uccnc',
    travel: { x: 600, y: 400, z: 200 },
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

function bridgeStatus(): MachineStatus {
  return {
    state: 'idle',
    subState: null,
    machinePos: { x: 10, y: 5, z: 12 },
    workPos: { x: 0, y: 0, z: 10 },
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

beforeEach(async () => {
  vi.useFakeTimers()
  bridgeSockets.length = 0
  originalProject = useCamStore.getState().project
  originalLibrary = useCamStore.getState().machineLibrary
  originalControl = useCamStore.getState().control
  install(uccncMachine())
  const pending = connectMachine('bridge')
  await vi.advanceTimersByTimeAsync(300)
  await pending
  act(() => { __resetEstopInterlockForTest() })
  act(() => {
    bridgeSockets.at(-1)!.emit({ t: 'status', v: bridgeStatus() } as BridgeMessage)
    bridgeSockets.at(-1)!.emit({ t: 'homed', v: { axes: ['X', 'Y', 'Z'] } } as BridgeMessage)
  })
  await act(async () => { await vi.advanceTimersByTimeAsync(10) })
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
  useMachineControl.setState({ consoleLines: [], parserModal: null })
  act(() => { __resetEstopInterlockForTest() })
  act(() => { useMachineControl.getState().setProgram(null, null, [], null) })
  vi.useRealTimers()
})

const FIXTURE_DIR = join(__dirname, '../fixtures/foreign-gcode')
const FIXTURES = readdirSync(FIXTURE_DIR).filter((file) => /\.(nc|ngc|gcode)$/i.test(file)).sort()

function stripComments(text: string): string {
  return text.split('\n').map((line) => line.replace(/\([^)]*\)/g, ' ').replace(/;.*$/, '')).join('\n')
}

/** Every distinct G and M word the corpus carries, spelled as the table spells them. */
const CORPUS_WORDS: string[] = [...new Set(FIXTURES.flatMap((file) =>
  [...stripComments(readFileSync(join(FIXTURE_DIR, file), 'utf8')).matchAll(/\b([GM])\s*(\d+(?:\.\d+)?)/gi)]
    .map((m) => `${m[1].toUpperCase()}${Number(m[2])}`),
))].sort()

const letterOf = (word: string): 'G' | 'M' => word[0] as 'G' | 'M'
const valueOf = (word: string): number => Number(word.slice(1))

/** What each route said about one word, as the operator reads it. */
interface RouteVerdicts {
  reader: string
  mdi: string
  program: string
}

async function verdictsFor(word: string): Promise<RouteVerdicts> {
  const programText = `G21 G90 G54\nG0 X0 Y0 Z10\n${word}\nM30\n`
  const read = readGcodeProgram(programText, {
    dialect: 'uccnc',
    sessionWcs: 'G54',
    initialPosition: { x: 0, y: 0, z: 10 },
    workOffsets: { G54: OFFSET },
  })
  const reader = read.ok ? 'read' : read.refusal.message

  useMachineControl.setState({ consoleLines: [] })
  act(() => { sendMdiLine(word) })
  await act(async () => { await vi.advanceTimersByTimeAsync(10) })
  const mdi = useMachineControl.getState().consoleLines.map((line) => line.text).join('\n')

  let loaded = { ok: false, reason: null as string | null }
  act(() => { loaded = loadGcodeTextToolpathProgram(`${word}.nc`, programText) })
  const program = loaded.ok ? 'loaded' : loaded.reason ?? ''
  return { reader, mdi, program }
}

describe('WO-1644: the corpus words are in the table, and every route accepts them alike', () => {
  it('reads the corpus words', () => {
    expect(CORPUS_WORDS.length).toBeGreaterThan(20)
    expect(CORPUS_WORDS).toEqual(expect.arrayContaining(['G0', 'G28', 'G43', 'G53', 'G64', 'M2001', 'M6', 'M8']))
  })

  it('every corpus word is in the UCCNC table, or in its user macro range', () => {
    const table = gcodeWordTable('uccnc')
    for (const word of CORPUS_WORDS) {
      const known = gcodeWordEntry(table, letterOf(word), valueOf(word)) !== null
        || (letterOf(word) === 'M' && isGcodeMacroMCode(table, valueOf(word)))
      expect(known, word).toBe(true)
    }
  })

  it.each(CORPUS_WORDS)('%s: no route refuses it as a word the table does not carry', async (word) => {
    const seen = await verdictsFor(word)
    for (const [route, said] of Object.entries(seen)) {
      expect(said, `${route} for ${word}`).not.toContain(`${word} is not in the`)
    }
  })

  it.each(FIXTURES.filter((file) => file !== 'linuxcnc-spiral.ngc'))(
    '%s runs whole through the program route interpreter',
    (file) => {
      const text = readFileSync(join(FIXTURE_DIR, file), 'utf8')
      const result = interpretGcodeProgram(text, {
        dialect: 'uccnc',
        sessionWcs: 'G54',
        initialPosition: { x: 0, y: 0, z: 0 },
        machineUnits: 'mm',
        workOffsets: { G54: OFFSET, G55: { x: 110, y: 5, z: 2 } },
      })
      expect(result.ok, result.ok ? file : result.refusal.message).toBe(true)
    },
  )

  it('the LinuxCNC corpus file stops on its O-word subroutine, never on a G or M word', () => {
    const text = readFileSync(join(FIXTURE_DIR, 'linuxcnc-spiral.ngc'), 'utf8')
    const result = interpretGcodeProgram(text, {
      dialect: 'linuxcnc',
      sessionWcs: 'G54',
      initialPosition: { x: 0, y: 0, z: 0 },
      machineUnits: 'mm',
      workOffsets: { G54: OFFSET },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.refusal.reason).toContain('address O')
  })
})

describe('WO-1644: a word removed from the table is refused by every route with the same sentence', () => {
  const removable = CORPUS_WORDS.filter((word) => gcodeWordEntry(gcodeWordTable('uccnc'), letterOf(word), valueOf(word)) !== null)

  it.each(removable)('without %s', async (word) => {
    const without = gcodeWordTableWithout(gcodeWordTable('uccnc'), [word])
    const restore = useGcodeWordTable(without)
    try {
      const sentence = gcodeWordRefusal(without, letterOf(word), valueOf(word))
      const seen = await verdictsFor(word)
      expect(seen.reader, 'reader').toContain(sentence)
      expect(seen.mdi, 'MDI').toContain(sentence)
      expect(seen.program, 'loaded program').toContain(sentence)
      // Nothing reached the wire for the MDI line.
      expect(bridgeSockets.at(-1)!.sent.map((m) => m.m)).not.toContain('startJob')
    } finally {
      restore()
    }
  })
})

describe('WO-1644: mixed MDI lines run word by word in controller order', () => {
  it.each([
    ['G0 X10 M8', ['selectWcs', 'loadMoves', 'startJob']],
    ['G17 G40 G49 G80 G90', []],
  ])('%s runs', async (line, wire) => {
    const socket = bridgeSockets.at(-1)!
    const mark = socket.sent.length
    let ok = false
    act(() => { ok = sendMdiLine(line) })
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    expect(ok).toBe(true)
    const errors = useMachineControl.getState().consoleLines.filter((l) => l.severity === 'error').map((l) => l.text)
    expect(errors, errors.join(" | ")).toEqual([])
    const calls = socket.sent.slice(mark).map((m) => m.m)
    expect(calls.filter((m) => ['selectWcs', 'loadMoves', 'startJob', 'setOutput', 'spindleOn'].includes(m)), calls.join(',')).toEqual(wire)
  })
})
