// @vitest-environment jsdom
//
// WO-2400: after a pause and return, the program's later tool changes still
// happen.
//
// Desk rehearsal of pin 7034b11f7, 2026-10-01 11:39 PM CT (3 of 3 runs): Load
// `wo2256-air-two-tools.nc` (a `T19` preselect at the top, `T1 M6` later),
// CYCLE START, CYCLE START at the first M0, Feed Hold inside a cut, Jog X+1,
// CYCLE START (the kept stop's return), CYCLE START at the next M0 -> the run
// went straight past the `T1 M6`: no park, no guided card, T19 to the end. The
// return is staged as its own program - prelude, then the file from the paused
// line - and that text named no tool before the M6, so the reader took `T1 M6`
// for the file's FIRST tool rather than a change from T19.
//
// Driven through the production entry points on the simulator's native route
// (no G-code text door: the bridge's shape, WO-2042's harness as WO-2259 uses
// it): the file door (`loadGcodeTextToolpathProgram`), the transport's CYCLE
// START / Feed Hold, the controller's jog, and the ProgramPanel tool-change
// card's own Continue button. Each file's uninterrupted run is the reference:
// after the return the run does at every later hold what that run did there.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ProgramPanel } from '../../components/machine/ProgramPanel'
import {
  __resetEstopInterlockForTest,
  armProgramFromLine,
  connectMachine,
  disconnectMachine,
  getMachineController,
  loadGcodeTextToolpathProgram,
  loadMachineProgram,
  setWorkOffsetValue,
} from '../../lib/machine/machineSession'
import { executeOperatorCycleStart, executeOperatorFeedHold } from '../../lib/machine/operatorTransport'
import { findTool } from '../../lib/machine/toolTable'
import { useCamStore } from '../../store'
import { useMachineActions } from '../../store/machineActionsStore'
import { useMachineControl } from '../../store/machineControlStore'
import { useMachineToolTable } from '../../store/machineToolTableStore'
import { positionMacroBody } from '../../types'

const SIM_ID = 'wo2400-simulator'
const PARK = { id: 'm6-pad', label: 'Fixed tool probe', x: 60, y: 70, z: -20 }
const SAFE_Z = -2
/** The reference tool: measured at machine Z -38 before the run (the
 *  simulator's setter answers every tool at -40, so T1's length is -2 mm). */
const REFERENCE_TOOL = 5

/** The rehearsal file's shape: three sections, M0s between them, the file's
 *  tool named by a preselect alone, and a later `T1 M6`. */
function program(toolWords: string, section2 = 'G0 X0 Y10'): string {
  return [
    'G21 G90 G17', //       1
    'G54', //               2
    toolWords, //           3  the file's own tool
    'G0 X0 Y0 Z5', //       4  section 1
    'G1 Z-1 F600', //       5
    'G1 X20 F600', //       6
    'G0 Z5', //             7
    'M5', //                8
    'M0', //                9
    section2, //            10 section 2
    'G1 Z-1 F300', //       11
    'G1 X40 F600', //       12 the pause is inside this cut
    'G1 X40 Y20', //        13
    'G0 Z5', //             14
    'M5', //                15
    'M0', //                16 the M0 after the return
    'G0 X10 Y30', //        17 section 3
    'G1 Z-1 F300', //       18
    'G1 X50 F600', //       19
    'G0 Z5', //             20
    'M5', //                21
    'M9', //                22
    'T1 M6', //             23 the later tool change
    'M0', //                24
    'G0 X10 Y40 Z5', //     25 section 4
    'G1 Z-2 F300', //       26
    'G1 X70 F600', //       27
    'G0 Z5', //             28
    'M5', //                29
    'M30', //               30
  ].join('\n')
}
/** The rehearsal's file: T19 preselected, never fitted by an M6. */
const PRESELECT_T19 = program('T19')
/** The same with the file's tool fitted by an M6 - and the later M6 to the
 *  SAME tool. */
const FITTED_T1 = program('T1 M6')
/** T19 fitted, then T1 preselected before the pause: the later `T1 M6`. */
const FITTED_T19_SELECT_T1 = program('T19 M6', 'T1 G0 X0 Y10')

async function advance(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

const consoleLines = () => useMachineControl.getState().consoleLines
const consoleText = () => consoleLines().map((line) => line.text).join('\n')

function here() {
  const at = getMachineController().status().workPos!
  return { x: at.x, y: at.y, z: at.z }
}

/** The simulator on the native route (WO-2042's shape, as WO-2259 drives it):
 *  no G-code text door; the park runs as machine-Z / work-XY jogs and a tool
 *  length goes into the work offset's Z through the controller's call. */
function nativeRoute(): void {
  const sim = getMachineController() as unknown as {
    capabilities: { gcodeText: boolean }
    setWorkOffset?: (wcs: string, offset: Record<string, number>) => Promise<unknown>
    wco: Record<string, Record<string, number>>
  }
  sim.capabilities.gcodeText = false
  sim.setWorkOffset = async (wcs, offset) => {
    sim.wco = { ...sim.wco, [wcs]: { ...sim.wco[wcs], ...offset } }
    return { ok: true, reason: null, offset: { ...sim.wco[wcs] } }
  }
}

/** What the run did from a point on, in order: each M0 it held at, each M6
 *  park (the tool it asked for and the line), each tool the card measured,
 *  and the tool in the spindle at the end. */
type Story = { events: string[]; activeTool: number | null; t1MachineZ: number | null }

/** Run on to the end, answering every hold as the operator does: CYCLE START
 *  at an M0, Continue on the tool-change card. */
async function runToEnd(): Promise<Story> {
  const events: string[] = []
  let seen = consoleLines().length
  let atM0 = false
  for (let t = 0; t <= 240_000 && useMachineControl.getState().job.phase !== 'complete'; t += 50) {
    await advance(50)
    const lines = consoleLines()
    for (const line of lines.slice(seen)) {
      const m0 = /stopped at the M0 on line (\d+)\./.exec(line.text)
      if (m0) {
        events.push(`M0 ${m0[1]}`)
        atM0 = true
      }
      const park = /^M6 on line (\d+): moving to "([^"]+)"\. Fit T(\d+)/.exec(line.text)
      if (park) events.push(`park T${park[3]} line ${park[1]} at ${park[2]}`)
      const measured = /^T(\d+) measured: contact at machine Z (\S+) mm\. Tool length offset (\S+) mm applied\./.exec(line.text)
      if (measured) events.push(`T${measured[1]} measured at ${measured[2]}, ${measured[3]} mm applied`)
    }
    seen = lines.length
    const s = useMachineControl.getState()
    if (s.toolChange?.mode === 'toolChange' && s.toolChange.step === 'awaiting-swap') {
      events.push(`fit T${s.toolChange.tool}`)
      fireEvent.click(screen.getByTestId('control-tc-continue'))
      await advance(50)
      continue
    }
    if (atM0 && getMachineController().machineState() === 'idle') {
      atM0 = false
      await advance(300)
      expect(await executeOperatorCycleStart(), consoleText()).toBe(true)
    }
  }
  expect(useMachineControl.getState().job.phase, consoleText()).toBe('complete')
  const table = useMachineToolTable.getState().tableFor(SIM_ID)
  return {
    events,
    activeTool: useMachineControl.getState().activeTool,
    t1MachineZ: findTool(table, 1)?.probedMachineZ ?? null,
  }
}

async function runUntil(done: () => boolean, ms = 60_000): Promise<void> {
  for (let t = 0; t < ms; t += 50) {
    await advance(50)
    if (done()) return
  }
  throw new Error(`never reached; console:\n${consoleText()}`)
}

function load(text: string): void {
  render(createElement(ProgramPanel))
  expect(loadGcodeTextToolpathProgram('wo2400.nc', text, { publishListing: true }), consoleText())
    .toEqual({ ok: true, reason: null })
}

/** CYCLE START, CYCLE START at the M0 on line 9, on into line 12's cut. */
async function intoLine12(text: string): Promise<void> {
  load(text)
  await advance(300)
  expect(await executeOperatorCycleStart(), consoleText()).toBe(true)
  await runUntil(() => /stopped at the M0 on line 9\./.test(consoleText()) && getMachineController().machineState() === 'idle')
  await advance(300)
  expect(await executeOperatorCycleStart(), consoleText()).toBe(true)
  await runUntil(() => {
    const at = here()
    return at.z < -0.5 && Math.abs(at.y - 10) < 0.01 && at.x > 10
  })
}

/** The file run straight through - the reference. */
async function straightRun(text: string): Promise<Story> {
  await intoLine12(text)
  return runToEnd()
}

/** Feed Hold inside line 12, Jog X+1, CYCLE START (the return), and on to
 *  the end. */
async function pauseJogReturn(text: string): Promise<Story> {
  await intoLine12(text)
  expect(executeOperatorFeedHold()).toBe(true)
  await advance(1500)
  expect(getMachineController().machineState(), consoleText()).toBe('hold')
  expect(getMachineController().jog('X', 1, 1000)).toBe(true)
  await advance(3000)
  expect(consoleText()).toMatch(/Stopped at line 12 so you can move/)
  expect(await executeOperatorCycleStart(), consoleText()).toBe(true)
  expect(consoleText()).toMatch(/going back to .* and carrying on from inside line 12\./)
  return runToEnd()
}

describe('WO-2400 after a pause and return, the later tool change still happens - simulator, native route', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    useMachineActions.setState({ byMachine: {}, macroArrangementByMachine: {} })
    useCamStore.setState((s) => ({ control: { ...s.control, activeMachineId: null } }))
    const machine = useCamStore.getState().project.machine
    useCamStore.getState().setProjectMachine({
      ...machine,
      id: SIM_ID,
      name: 'WO-2400 simulator',
      controller: 'grbl',
      controllerDefinition: undefined,
      unsentSettings: undefined,
      travel: { x: 100, y: 100, z: 100 },
      homeConvention: {
        x: { homesToward: 'min', machineZeroAt: 'min' },
        y: { homesToward: 'min', machineZeroAt: 'min' },
        z: { homesToward: 'max', homePositionMm: 5 },
      },
      macros: [{
        id: PARK.id,
        name: PARK.label,
        body: positionMacroBody({ x: PARK.x, y: PARK.y, z: PARK.z, zFirst: true }),
        usedForToolChange: true,
      }],
      safeZMachine: SAFE_Z,
    } as never)
    const connected = connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(300)
    await connected
    __resetEstopInterlockForTest()
    getMachineController().home()
    await vi.advanceTimersByTimeAsync(2000)
    useMachineToolTable.setState({ byMachine: {}, availableMeasurement: null })
    const tools = useMachineToolTable.getState()
    tools.setProbeConfig(SIM_ID, { maxTravel: 50 })
    tools.recordProbedZ(SIM_ID, REFERENCE_TOOL, -38, 1)
    tools.setReference(SIM_ID, REFERENCE_TOOL)
    for (const axis of ['X', 'Y'] as const) {
      expect(setWorkOffsetValue('G54', axis, 0)).toBe(true)
      await vi.advanceTimersByTimeAsync(50)
    }
    expect(setWorkOffsetValue('G54', 'Z', -10)).toBe(true)
    await vi.advanceTimersByTimeAsync(50)
    nativeRoute()
    useMachineControl.getState().clearConsole()
  })

  afterEach(async () => {
    cleanup()
    vi.restoreAllMocks()
    getMachineController().emergencyStop()
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await pending
    vi.useRealTimers()
  })

  const reference: Record<string, Story> = {}

  it('reference: the T19 file run straight through parks for the T1 M6 and measures T1', async () => {
    reference.preselect = await straightRun(PRESELECT_T19)
    expect(reference.preselect.events).toEqual([
      'M0 16',
      `park T1 line 23 at ${PARK.label}`,
      'fit T1',
      'T1 measured at -40.00, -2.00 mm applied',
      'M0 24',
    ])
    expect(reference.preselect.activeTool).toBe(1)
    expect(reference.preselect.t1MachineZ).not.toBeNull()
  })

  it('pause in line 12 -> Jog X+1 -> CYCLE START: the later T1 M6 parks, Continue measures T1, as the straight run', async () => {
    const resumed = await pauseJogReturn(PRESELECT_T19)
    expect(resumed).toEqual(reference.preselect)
    expect(consoleLines().filter((line) => line.severity === 'error').map((line) => line.text)).toEqual([])
  })

  it('reference: T19 fitted and T1 preselected - the later T1 M6 is a change from T19', async () => {
    reference.selected = await straightRun(FITTED_T19_SELECT_T1)
    expect(reference.selected.events).toEqual([
      'M0 16',
      `park T1 line 23 at ${PARK.label}`,
      'fit T1',
      'T1 measured at -40.00, -2.00 mm applied',
      'M0 24',
    ])
  })

  it('T19 fitted, T1 preselected: after the return the later T1 M6 still changes from T19, as the straight run', async () => {
    expect(await pauseJogReturn(FITTED_T19_SELECT_T1)).toEqual(reference.selected)
  })

  it('reference: the file fits T1 at the top - the later T1 M6 to the same tool', async () => {
    reference.same = await straightRun(FITTED_T1)
    expect(reference.same.events.filter((event) => event.startsWith('M0'))).toEqual(['M0 16', 'M0 24'])
  })

  it('a later M6 to the tool already fitted: after the return it does what the straight run does', async () => {
    expect(await pauseJogReturn(FITTED_T1)).toEqual(reference.same)
  })
})

// Run from line is the text door's (`armProgramFromLine` reads the loaded
// TEXT program): its holds at a running M6 are staged over the whole file's
// text (`stageRunningM6Holds`), not read from the slice's own tools, so the
// later M6 holds there as in the straight run - checked here, not changed.
describe('WO-2400 Run from line on the text door keeps the later M6 hold', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    const connected = connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(300)
    await connected
    __resetEstopInterlockForTest()
    getMachineController().home()
    await vi.advanceTimersByTimeAsync(3000)
    for (const [axis, mm] of [['X', 10], ['Y', 10], ['Z', -10]] as const) {
      expect(setWorkOffsetValue('G54', axis, mm)).toBe(true)
      await vi.advanceTimersByTimeAsync(50)
    }
    useMachineControl.getState().clearConsole()
  })

  afterEach(async () => {
    getMachineController().emergencyStop()
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await pending
    vi.useRealTimers()
  })

  /** The text door's holds from line 12 on: the job's paused source lines. */
  async function holdsFrom(start: () => Promise<void>): Promise<number[]> {
    const holds: number[] = []
    await start()
    for (let t = 0; t < 120_000 && useMachineControl.getState().job.phase !== 'complete'; t += 50) {
      await vi.advanceTimersByTimeAsync(50)
      const s = useMachineControl.getState()
      if (s.job.phase === 'paused' && getMachineController().machineState() !== 'run') {
        await vi.advanceTimersByTimeAsync(300)
        const line = useMachineControl.getState().job.ackedSourceLine
        if (line >= 12) holds.push(line)
        expect(await executeOperatorCycleStart(), consoleText()).toBe(true)
      }
    }
    expect(useMachineControl.getState().job.phase, consoleText()).toBe('complete')
    return holds
  }

  it('Run from line 12 holds at the T1 M6 on line 23 as the straight run does', async () => {
    loadMachineProgram('wo2400.nc', PRESELECT_T19)
    await vi.advanceTimersByTimeAsync(300)
    const straight = await holdsFrom(async () => {
      expect(await executeOperatorCycleStart(), consoleText()).toBe(true)
    })
    expect(straight).toContain(23)
    loadMachineProgram('wo2400.nc', PRESELECT_T19)
    await vi.advanceTimersByTimeAsync(300)
    const fromLine = await holdsFrom(async () => {
      const armed = await armProgramFromLine(12)
      expect(armed.ok, JSON.stringify(armed)).toBe(true)
      expect(await executeOperatorCycleStart(), consoleText()).toBe(true)
    })
    expect(fromLine).toEqual(straight)
  })
})
