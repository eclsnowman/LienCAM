// @vitest-environment jsdom
//
// WO-2863 (the operator's second "use it like the operator" sweep, 10-15/16, G3 + G6): on the
// simulator route (Simulate Sample hobby router (GRBL)), Control's readouts
// must say what the controller has.
//  - G3: Load Setup 1, CYCLE START, then Stop/Reset while it runs. Status went
//    Idle, the Off button lit, and the spindle still read "10000 rpm" - the
//    simulator's Stop left its spindle turning. GRBL's own Stop is a soft reset
//    (grbl/controller.ts stopJob -> softReset), which turns the spindle off.
//  - G6: the GRBL post writes a tool change as "( change tool to T3 )" then M0.
//    The status line named T3 at the hold, but the TOOL panel still read T2
//    after CYCLE START resumed it.
// Both drive the production session with the simulated controller through
// Control's own doors (Load Setup, CYCLE START, Stop/Reset).
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'

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

const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineActions } = await import('../../store/machineActionsStore')
const {
  __resetEstopInterlockForTest,
  cancelGuidedToolChange,
  connectMachine,
  disconnectMachine,
  getMachineController,
  loadGcodeFile,
  loadSetupToolpathProgram,
  sendMdiLine,
  setWorkOffsetValue,
} = await import('../../lib/machine/machineSession')
const { currentOperatorTransport, executeOperatorCycleStart, executeOperatorFeedHold, executeOperatorStopReset } =
  await import('../../lib/machine/operatorTransport')
const { ToolGlance } = await import('../../components/machine/ToolGlance')
const { topics: machineHelp } = await import('../../help/topics/machine')
const { makeMachine, makeOp, makeTool, makeWcs, move, stampGenerationCurrent } = await import('../post/helpers')
const { emitProgram } = await import('../../lib/post/emit')
const { GRBL_CONFIG } = await import('../../lib/post/dialects/grbl')
const { resolveFeedrates } = await import('../../lib/cam/feedrates')
const { resolveSpindle, resolveCoolant } = await import('../../lib/post/resolve')

type Setup = import('../../types').Setup
type Tool = import('../../types').Tool

const speeds = (rpm: number) => ({ default: { rpm, feedRate: 1500, plungeRate: 600, depthOfCut: 1, stepover: 3, coolant: 'none' as const } })
const T2 = makeTool({ id: 't2', toolNumber: 2, feedsAndSpeeds: speeds(10000) })
const T3 = makeTool({ id: 't3', toolNumber: 3, feedsAndSpeeds: speeds(12000) })

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

function cut(id: string, tool: Tool, y: number) {
  return makeOp({
    id, name: `Op ${id}`, toolId: tool.id,
    toolpathMoves: [
      move({ type: 'rapid', x: 10, y, z: 5, role: 'rapid' }),
      move({ type: 'feed', x: 10, y, z: -1, feed: 600, role: 'plunge' }),
      move({ type: 'feed', x: 80, y, z: -1, feed: 1500, role: 'cut' }),
      move({ type: 'rapid', x: 80, y, z: 5, role: 'rapid' }),
    ],
  })
}

/** Setup 1 in the store as Control's Load menu reads it: one T2 operation,
 *  which loads on the toolpath route. */
function storeSetup(): void {
  const setup: Setup = {
    id: 's1', name: 'Setup 1', wcs: makeWcs(),
    stock: { type: 'rectangular', width: 100, depth: 100, height: 20 } as unknown as Setup['stock'],
    operations: [cut('a', T2, 10)],
    machineActions: [],
    notes: '',
  }
  useCamStore.setState((state) => ({
    toolLibrary: [T2, T3],
    project: { ...state.project, geometry: [], setups: [setup], activeSetupId: setup.id },
  }))
  const state = useCamStore.getState()
  const view = { ...state.project, toolLibrary: state.toolLibrary }
  for (const s of view.setups) {
    for (const op of s.operations) stampGenerationCurrent(view, s, op, T2)
  }
}

const FIT_T3 = 'Held for a tool change - fit T3, then press CYCLE START.'

/** Two operations, T2 then T3, through the shipped GRBL post (as WO-2691):
 *  the change is written "( change tool to T3 )" and an M0, no T word. */
function postedGrblProgram(): string {
  const machine = makeMachine()
  const op = (id: string, tool: Tool, y: number) => {
    const moves = [
      move({ type: 'rapid', x: 10, y, z: 5, role: 'rapid' }),
      move({ type: 'feed', x: 10, y, z: -1, feed: 300, role: 'plunge' }),
      move({ type: 'feed', x: 30, y, z: -1, feed: 600, role: 'cut' }),
    ]
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
    setup: { wcs: makeWcs(), operations: [op('Rough', T2, 10), op('Finish', T3, 20)] },
  }, GRBL_CONFIG)
  return lines.join('\n')
}

/** The TOOL panel's current tool, as rendered. */
function toolPanelReads(): string {
  cleanup()
  render(createElement(ToolGlance, { onChangeTool: () => {} }))
  return screen.getByTestId('control-tool-glance-current').textContent ?? ''
}

describe('WO-2863 Control readouts on the simulator (Sample hobby router, GRBL)', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    memory.clear()
    useCamStore.getState().newProject()
    useMachineActions.setState({ byMachine: {}, macroArrangementByMachine: {} })
    expect(useCamStore.getState().project.machine).toMatchObject({ name: 'Sample hobby router (GRBL)', controller: 'grbl' })
    const pending = connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(300)
    await pending
    __resetEstopInterlockForTest()
    getMachineController().home()
    await vi.advanceTimersByTimeAsync(3000)
    for (const [axis, mm] of [['X', -300], ['Y', -225], ['Z', -60]] as const) {
      expect(setWorkOffsetValue('G54', axis, mm)).toBe(true)
      await vi.advanceTimersByTimeAsync(50)
    }
    useMachineControl.setState({ consoleLines: [] })
  })

  afterEach(async () => {
    cleanup()
    cancelGuidedToolChange()
    getMachineController().emergencyStop()
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await pending
    vi.useRealTimers()
  })

  it('G3: Stop/Reset while the program runs leaves the spindle at 0 rpm, at Idle, and it stays there', async () => {
    storeSetup()
    // c13-mdi.png: the spindle typed on at the MDI line, as the sweep did.
    expect(sendMdiLine('M3 S10000'), consoleText()).toBe(true)
    await runUntil(() => (useMachineControl.getState().spindleRpm ?? 0) >= 10000)
    const loaded = await loadSetupToolpathProgram('s1')
    expect(loaded, consoleText()).toMatchObject({ ok: true })
    await advance(300)
    expect(await executeOperatorCycleStart(), consoleText()).toBe(true)
    // Running, with the spindle the operator started from MDI at 10000 rpm.
    await runUntil(() => useMachineControl.getState().machineState === 'run'
      && (useMachineControl.getState().spindleRpm ?? 0) >= 10000)

    expect(executeOperatorStopReset(), consoleText()).toBeTruthy()
    for (const seconds of [0, 5, 9]) {
      if (seconds > 0) await advance(seconds === 5 ? 5000 : 4000)
      else await advance(1000)
      const state = useMachineControl.getState()
      expect(state.machineState, `${seconds}s after Stop/Reset\n${consoleText()}`).toBe('idle')
      expect(state.spindleRpm ?? 0, `${seconds}s after Stop/Reset\n${consoleText()}`).toBe(0)
      expect(getMachineController().status().spindleRpm ?? 0).toBe(0)
      expect(state.commandedAccessories?.spindle).toBe('off')
    }
  })

  it('G6: held at the post\'s "( change tool to T3 )" M0 the TOOL panel reads T2; CYCLE START resumes and it reads T3', async () => {
    const text = postedGrblProgram()
    const lines = text.split('\n')
    const pause = lines.indexOf('( change tool to T3 )')
    expect(pause, text).toBeGreaterThan(0)
    expect(lines[pause + 1]).toBe('M0')
    // The post names the first tool with a T word and the change only in a
    // comment: no T3 word, no M6 - the shape the sweep ran.
    expect(lines).toContain('T2')
    expect(lines.filter((line) => !line.startsWith('(')).join('\n')).not.toMatch(/T3|M6/)
    // The operator has T2 in the spindle (fitted from the Tools tab).
    useMachineControl.getState().setActiveTool(2)
    expect(loadGcodeFile('post-grbl.gcode', text, null), consoleText()).toMatchObject({ door: 'text' })
    await advance(300)
    expect(await executeOperatorCycleStart(), consoleText()).toBe(true)
    await runUntil(() => useMachineControl.getState().machineState === 'hold')
    await advance(300)
    expect(currentOperatorTransport(), consoleText()).toMatchObject({ action: 'resume', nextAction: FIT_T3 })
    // At the hold T2 is still in the spindle: the operator has not said otherwise.
    expect(toolPanelReads()).toBe('T2')

    // CYCLE START resumes - the same resume it always was - and T3 is the tool.
    expect(await executeOperatorCycleStart(), consoleText()).toBe(true)
    await advance(500)
    expect(useMachineControl.getState().machineState, consoleText()).not.toBe('hold')
    expect(toolPanelReads(), consoleText()).toBe('T3')
    await runUntil(() => useMachineControl.getState().job.phase === 'complete'
      && useMachineControl.getState().machineState === 'idle')
    expect(toolPanelReads(), consoleText()).toBe('T3')
  })

  it('G6 control: a Feed Hold inside a cut is not a tool change, and CYCLE START out of it leaves the tool as it was', async () => {
    const text = postedGrblProgram()
    useMachineControl.getState().setActiveTool(2)
    expect(loadGcodeFile('post-grbl.gcode', text, null), consoleText()).toMatchObject({ door: 'text' })
    await advance(300)
    expect(await executeOperatorCycleStart(), consoleText()).toBe(true)
    const at = () => getMachineController().status().workPos!
    await runUntil(() => at().z < -0.5 && at().x > 15 && Math.abs(at().y - 10) < 0.01)
    expect(executeOperatorFeedHold()).toBe(true)
    await advance(1500)
    expect(currentOperatorTransport()).toMatchObject({ action: 'resume', nextAction: 'CYCLE START resumes the held program.' })
    expect(await executeOperatorCycleStart(), consoleText()).toBe(true)
    await advance(500)
    expect(toolPanelReads()).toBe('T2')
  })
})

describe('WO-2863 Help "The Control tab" says which routes show a tool-change card', () => {
  it('keeps the card sentence and says a GRBL post holds on the status sentence instead', () => {
    const topic = machineHelp.find((t) => t.id === 'control-tab-overview')!
    const text = JSON.stringify(topic.sections)
    expect(text).toContain('a tool-change card has its own Continue button. That card appears where the program has an M6.')
    expect(text).toContain('A GRBL post has no M6 - it writes the change as a comment and an M0 - so no card appears: '
      + 'the program holds, the status sentence names the tool to fit, and CYCLE START resumes it.')
  })
})
