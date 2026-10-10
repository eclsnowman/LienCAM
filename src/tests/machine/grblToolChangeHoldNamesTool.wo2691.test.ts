// @vitest-environment jsdom
//
// WO-2691 (C5 of the 10-08 journey audit, .planning/JOURNEY-2026-10-08.md):
// a GRBL post has no M6, so a tool change is posted as
//
//     ( change tool to T2 )
//     M0
//
// (src/lib/post/emit.ts emitToolChange, 'pause' mode). At that hold Control's
// status line said only "CYCLE START resumes the held program." - nothing
// about fitting T2. It now names the tool from the program's own words at the
// held line and ends with the control that continues it.
//
// Operator text only: what is sent and how CYCLE START resumes do not change.
// Both controllers a GRBL user meets are driven through the production session
// and the operator's file door (loadGcodeFile):
//  - the app's simulator with the Sample hobby router (GRBL) - the journey's
//    own setup, holding ON the M0 line;
//  - the real GrblController over a byte-level fake of GRBL 1.1, which
//    acknowledges an M0 only once the operator resumes (docs/machine/
//    GRBL-PROTOCOL.md), so the hold is read one line earlier.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from '@testing-library/react'

const memory = new Map<string, string>()
const storage: Storage = {
  get length() { return memory.size },
  clear: () => memory.clear(),
  getItem: (key) => memory.get(key) ?? null,
  key: (index) => [...memory.keys()][index] ?? null,
  removeItem: (key) => { memory.delete(key) },
  setItem: (key, value) => { memory.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })

import { typedMock } from '../support/typedMock'

// Real GRBL controller, fake byte bridge: an M0 is acknowledged only after `~`.
let serial: { sent: string[]; x: number; held: boolean } | null = null
vi.mock('../../lib/machine/webSerialTransport', async importOriginal => {
  const actual = await importOriginal<typeof import('../../lib/machine/webSerialTransport')>()
  class FakeSerial extends actual.WebSerialTransport {
    static isSupported() { return true }
    static async requestPort() { return {} as SerialPort }
    static async grantedPorts(): Promise<SerialPort[]> { return [] }
    sent: string[] = []
    x = 0
    held = false
    pending: string[] = []
    fakeEvents: import('../../lib/machine/types').TransportEvents | null = null
    constructor() { super({} as SerialPort); serial = this }
    feed(text: string) { this.fakeEvents?.onChunk(new TextEncoder().encode(text)) }
    status() { this.feed(`<${this.held ? 'Hold:0' : 'Idle'}|MPos:${this.x},0,-1|WCO:0,0,-10>\n`) }
    async start(events: import('../../lib/machine/types').TransportEvents) {
      this.fakeEvents = events
      setTimeout(() => { this.feed("Grbl 1.1h ['$' for help]\n"); this.status() }, 1)
    }
    async write(bytes: Uint8Array) {
      const text = new TextDecoder().decode(bytes)
      this.sent.push(text)
      if (text === '?') { this.status(); return }
      if (text === '~') {
        this.held = false; this.feed('ok\n')
        for (const line of this.pending.splice(0)) {
          const x = /(?:^|\s)X(-?[\d.]+)/i.exec(line)
          if (x) this.x = Number(x[1])
          this.feed('ok\n')
        }
        this.status(); return
      }
      if (!text.endsWith('\n')) return
      if (this.held) { this.pending.push(text); return }
      if (/(?:^|\s)M0(?:\s|$)/i.test(text.trim())) { this.held = true; this.status(); return }
      const x = /(?:^|\s)X(-?[\d.]+)/i.exec(text)
      if (x) this.x = Number(x[1])
      setTimeout(() => { this.feed('ok\n'); this.status() }, 1)
    }
    async close() { this.fakeEvents?.onClose(null) }
  }
  return typedMock<typeof import('../../lib/machine/webSerialTransport')>({ ...actual, WebSerialTransport: FakeSerial })
})

const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineActions } = await import('../../store/machineActionsStore')
const { createDefaultControllerDefinition } = await import('../../types')
const { axisSoftLimitStatementKey } = await import('../../lib/machine/resolvedMachineMotion')
const {
  __resetEstopInterlockForTest,
  connectMachine,
  disconnectMachine,
  getMachineController,
  loadGcodeFile,
  setWorkOffsetValue,
} = await import('../../lib/machine/machineSession')
const operatorTransportModule = await import('../../lib/machine/operatorTransport')
const { currentOperatorTransport, executeOperatorCycleStart, executeOperatorFeedHold } = operatorTransportModule
const { emitProgram } = await import('../../lib/post/emit')
const { GRBL_CONFIG } = await import('../../lib/post/dialects/grbl')
const { resolveFeedrates } = await import('../../lib/cam/feedrates')
const { resolveSpindle, resolveCoolant } = await import('../../lib/post/resolve')
const { makeMachine, makeOp, makeTool, makeWcs, move } = await import('../post/helpers')

/** The sentence the WO names: what happened, the tool, the control. */
const FIT_T2 = 'Held for a tool change - fit T2, then press CYCLE START.'
const PLAIN = 'CYCLE START resumes the held program.'

const consoleText = () => useMachineControl.getState().consoleLines.map((l) => l.text).join('\n')
async function advance(ms: number, step = 50): Promise<void> {
  for (let t = 0; t < ms; t += step) await act(async () => { await vi.advanceTimersByTimeAsync(step) })
}
async function runUntil(done: () => boolean, ms = 60000): Promise<void> {
  for (let t = 0; t < ms; t += 50) {
    await advance(50)
    if (done()) return
  }
  throw new Error(`never reached; console:\n${consoleText()}`)
}

/** Two operations, T1 then T2, through the shipped GRBL post. */
function postedGrblProgram(): string {
  const machine = makeMachine()
  const op = (id: string, toolNumber: number, moves: ReturnType<typeof move>[]) => {
    const tool = makeTool({ id: `t${toolNumber}`, toolNumber })
    const operation = makeOp({ id, name: id, toolId: tool.id, toolpathMoves: moves })
    return {
      op: operation,
      tool,
      feeds: resolveFeedrates(tool, operation.feedrateOverride, machine.rapidRate),
      spindle: resolveSpindle(operation, tool, machine),
      coolant: resolveCoolant(tool, machine),
      moves,
    }
  }
  const { lines } = emitProgram({
    machine,
    setup: {
      wcs: makeWcs(),
      operations: [
        op('Rough', 1, [
          move({ type: 'rapid', x: 10, y: 10, z: 5, role: 'rapid' }),
          move({ type: 'feed', x: 10, y: 10, z: -1, feed: 300, role: 'plunge' }),
          move({ type: 'feed', x: 30, y: 10, z: -1, feed: 600, role: 'cut' }),
        ]),
        op('Finish', 2, [
          move({ type: 'rapid', x: 10, y: 20, z: 5, role: 'rapid' }),
          move({ type: 'feed', x: 10, y: 20, z: -1, feed: 300, role: 'plunge' }),
          move({ type: 'feed', x: 30, y: 20, z: -1, feed: 600, role: 'cut' }),
        ]),
      ],
    },
  }, GRBL_CONFIG)
  return lines.join('\n')
}

describe('WO-2691 GRBL tool-change hold on the app simulator (Sample hobby router, GRBL post)', () => {
  const text = postedGrblProgram()

  beforeEach(async () => {
    vi.useFakeTimers()
    memory.clear()
    useCamStore.getState().newProject()
    useMachineActions.setState({ byMachine: {}, macroArrangementByMachine: {} })
    const pending = connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(300)
    await pending
    __resetEstopInterlockForTest()
    getMachineController().home()
    await vi.advanceTimersByTimeAsync(3000)
    // The journey's own zero (run-1706-baseline: "G54 set at machine -300, -225, -60").
    for (const [axis, mm] of [['X', -300], ['Y', -225], ['Z', -60]] as const) {
      expect(setWorkOffsetValue('G54', axis, mm)).toBe(true)
      await vi.advanceTimersByTimeAsync(50)
    }
    useMachineControl.setState({ consoleLines: [] })
  })

  afterEach(async () => {
    getMachineController().emergencyStop()
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await pending
    vi.useRealTimers()
  })

  it('the post writes the change as a comment and an M0, on the sample GRBL machine', () => {
    expect(useCamStore.getState().project.machine).toMatchObject({ name: 'Sample hobby router (GRBL)', controller: 'grbl' })
    const lines = text.split('\n')
    const pause = lines.indexOf('( change tool to T2 )')
    expect(pause, text).toBeGreaterThan(0)
    expect(lines[pause + 1]).toBe('M0')
    expect(text).not.toMatch(/M6/)
  })

  it('held at the M0, the line names T2 and CYCLE START; CYCLE START still resumes and the program completes', async () => {
    expect(loadGcodeFile('post-grbl.gcode', text, null), consoleText()).toMatchObject({ door: 'text' })
    await advance(300)
    expect(await executeOperatorCycleStart(), consoleText()).toBe(true)
    await runUntil(() => useMachineControl.getState().machineState === 'hold')
    await advance(300)
    const held = currentOperatorTransport()
    expect(held, consoleText()).toMatchObject({
      action: 'resume',
      cycleStartEnabled: true,
      nextAction: FIT_T2,
      cycleStartDetail: 'Resume the held program.',
    })
    // Nothing else changes: CYCLE START resumes it to the end.
    expect(await executeOperatorCycleStart(), consoleText()).toBe(true)
    await runUntil(() => useMachineControl.getState().job.phase === 'complete'
      && useMachineControl.getState().machineState === 'idle')
  })

  it('a Feed Hold inside a cut is not a tool change and keeps the plain sentence', async () => {
    expect(loadGcodeFile('post-grbl.gcode', text, null), consoleText()).toMatchObject({ door: 'text' })
    await advance(300)
    expect(await executeOperatorCycleStart(), consoleText()).toBe(true)
    const at = () => getMachineController().status().workPos!
    await runUntil(() => at().z < -0.5 && at().x > 15 && Math.abs(at().y - 10) < 0.01)
    expect(executeOperatorFeedHold()).toBe(true)
    await advance(1500)
    expect(useMachineControl.getState().machineState).toBe('hold')
    expect(currentOperatorTransport()).toMatchObject({ action: 'resume', nextAction: PLAIN })
  })
})

describe('WO-2691 GRBL tool-change hold on the real GRBL controller (byte-level GRBL 1.1)', () => {
  // The journey's posted shape (post-grbl-Untitled_Project.gcode lines 3167-3173),
  // kept inside this fake's travel; it holds on the M0 and acks it only on resume.
  const text = 'G90 G94 G17 G21\nG54\nT1\nG0 X10 Y0 Z-1\nM5\nG0 Z-2\n( change tool to T2 )\nM0\nG54\nG0 X35\nM30'

  beforeEach(async () => {
    vi.useFakeTimers()
    memory.clear()
    useCamStore.getState().newProject()
    const definition = createDefaultControllerDefinition()
    definition.axes = definition.axes.map(axis => ({ ...axis, softLimitMin: axis.axis === 'Z' ? -100 : 0, softLimitMax: axis.axis === 'Z' ? 0 : 100 }))
    definition.stated = ['X', 'Y', 'Z'].flatMap(axis => [axisSoftLimitStatementKey(axis as 'X' | 'Y' | 'Z', 'min'), axisSoftLimitStatementKey(axis as 'X' | 'Y' | 'Z', 'max')]).map(key => ({ controller: 'grbl', key }))
    useCamStore.getState().setProjectMachine({
      ...useCamStore.getState().project.machine,
      controller: 'grbl',
      controllerDefinition: definition,
      macros: [],
      travel: { x: 100, y: 100, z: 100 },
    })
    useMachineActions.setState({ byMachine: {}, macroArrangementByMachine: {} })
    const connected = connectMachine('serial', 115200)
    await vi.advanceTimersByTimeAsync(300)
    await connected
    __resetEstopInterlockForTest()
    getMachineController().home()
    await advance(300)
    useMachineControl.setState({ homed: true, activeTool: 1, consoleLines: [] })
  })

  afterEach(async () => {
    const disconnected = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await disconnected
    vi.useRealTimers()
  })

  it('held at the M0, the line names T2; CYCLE START sends ~ and the rest runs', async () => {
    expect(loadGcodeFile('grbl-change.gcode', text, null), consoleText()).toMatchObject({ door: 'text' })
    await advance(300)
    expect(await executeOperatorCycleStart(), consoleText()).toBe(true)
    await advance(1000)
    expect(serial!.held).toBe(true)
    expect(serial!.x).toBe(10)
    expect(currentOperatorTransport(), consoleText()).toMatchObject({
      action: 'resume',
      cycleStartEnabled: true,
      nextAction: FIT_T2,
      cycleStartDetail: 'Resume the held program.',
    })
    // The resume is the same byte it always was.
    const before = serial!.sent.length
    expect(await executeOperatorCycleStart(), consoleText()).toBe(true)
    await advance(1000)
    expect(serial!.sent.slice(before)).toContain('~')
    expect(serial!.held).toBe(false)
    expect(serial!.x).toBe(35)
  })
})

describe('WO-2691 which holds are a tool change (the verdict, words only)', () => {
  const { deriveOperatorTransport } = operatorTransportModule
  /** Held ON `line` (the simulator's cursor sits on the pause it reached). */
  const heldAt = (programText: string, line: number) => deriveOperatorTransport({
    connectionPhase: 'connected', machineState: 'hold', homed: true, activeWcs: 'G54', noHomeSwitches: false,
    job: {
      phase: 'paused', name: 'held.nc', totalLines: 20, sentLines: line, ackedLines: line,
      ackedSourceLine: line, sentSourceLine: line, startedAt: null, pausedAt: null, error: null, toolChanges: [],
    },
    programReadiness: { ready: true, reason: 'Program checks passed.' },
    singleBlock: false, fitTrace: null, toolChange: null, programText, pausedProgram: null,
  })

  it.each([
    ['the GRBL post\'s comment + M0', 'G0 X1 Y1 Z5\nG0 Z15\n( change tool to T2 )\nM0\nG0 X5', 4, FIT_T2],
    ['a semicolon comment', 'G0 X1 Y1 Z5\n; tool change T2\nM0\nG0 X5', 3, FIT_T2],
    ['a T word before the M0', 'G0 X1 Y1 Z5\nM5\nT2\nM0\nG0 X5', 4, FIT_T2],
    ['a comment that names no tool', 'G0 X1 Y1 Z5\n( tool change )\nM0\nG0 X5', 3,
      'Held for a tool change - fit the next tool, then press CYCLE START.'],
    ['a plain M0', 'G0 X1 Y1 Z5\nM5\nM0\nG0 X5', 3, PLAIN],
    ['a comment before the last move is not this stop\'s', '( change tool to T2 )\nG0 X1 Y1 Z5\nM0\nG0 X5', 3, PLAIN],
    ['the M0 after an M6 that already held', 'G0 X1 Y1 Z5\nT2 M6\nM0\nG0 X5', 3, PLAIN],
    // Review 10-08 (astra): compact words are the same words to the controller.
    ['a compact move after the comment is not this stop\'s', '( change tool to T2 )\nG1X10\nM0\nG0X5', 3, PLAIN],
    ['a compact axis-only move after the comment', '( change tool to T2 )\nX10Y5\nM0\nG0X5', 3, PLAIN],
    ['a compact T word before the M0', 'G0X1Y1Z5\nM5\nT2\nM0\nG0X5', 4, FIT_T2],
    ['the M0 after a compact M6 that already held', 'G0X1Y1Z5\nT2M6\nM0\nG0X5', 3, PLAIN],
  ])('%s', (_name, text, line, sentence) => {
    expect(heldAt(text, line)).toMatchObject({ action: 'resume', cycleStartEnabled: true, nextAction: sentence })
  })
})
