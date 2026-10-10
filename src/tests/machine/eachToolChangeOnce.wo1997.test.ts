// @vitest-environment jsdom
//
// WO-1997 (readiness walk 2026-09-25, finding 4): each tool change stops
// exactly once. A posted program with three tool changes - with and without
// the post's M0 after each M6 - runs on the simulated LienCNC V2 through the
// real session and Program panel, on both program routes:
//  - text: the controller streams the G-code (loadMachineProgram). The panel
//    maps a hold to an M6; this is the route the walk broke on.
//  - staged: the file interpreter the machine bridge uses
//    (loadGcodeTextToolpathProgram). Its M6 is a session boundary; the panel's
//    mapping never serves it.
// Every stop is read back from the store (tool-change card, job phase, machine
// position), and the operator's only gestures are the card's Continue and
// CYCLE START on a plain M0 hold.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

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
const { ProgramPanel } = await import('../../components/machine/ProgramPanel')
const { useMachineActions } = await import('../../store/machineActionsStore')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineToolTable } = await import('../../store/machineToolTableStore')
const { executeOperatorCycleStart } = await import('../../lib/machine/operatorTransport')
const { positionMacroBody } = await import('../../types')
const {
  __resetEstopInterlockForTest,
  cancelGuidedToolChange,
  connectMachine,
  disconnectMachine,
  getMachineController,
  loadGcodeTextToolpathProgram,
  loadMachineProgram,
  setWorkOffsetValue,
  textProgramHoldLine,
} = await import('../../lib/machine/machineSession')

const MACHINE_ID = 'wo1997-simulator'
const PARK = { id: 'm6-pad', label: 'Fixed tool probe', x: 5, y: 5, z: -2 }
/** T1 is in the spindle and measured (the reference); T2, T3 and T4 are changes. */
const TOOLS = [1, 2, 3, 4]
const LAST_X = TOOLS.length * 10 + 5

/** The UCCNC/LinuxCNC post's shape: `T<n> M6`, then its `M0` when the post
 * pauses for the change, then the work offset and the spindle. */
function postedProgram(withM0: boolean): string {
  const lines = ['G21', 'G90', 'G17']
  for (const tool of TOOLS) {
    if (tool !== TOOLS[0]) lines.push('M5', 'G0 Z-1')
    lines.push(`(Op T${tool})`, `T${tool} M6`)
    if (withM0) lines.push('M0')
    lines.push('G54', 'S12000 M3', `G0 X${tool * 10} Y${tool * 10}`, 'G1 Z-3 F1000', `G1 X${tool * 10 + 5} F6000`, 'G0 Z-1')
  }
  lines.push('M5', 'M30')
  return lines.join('\n')
}

function lineOf(text: string, content: string): number {
  return text.split('\n').indexOf(content) + 1
}

function configureMachine(): void {
  const machine = useCamStore.getState().project.machine
  useCamStore.getState().setProjectMachine({
    ...machine,
    id: MACHINE_ID,
    name: 'WO-1997 simulator',
    controller: 'grbl',
    controllerDefinition: undefined,
    unsentSettings: undefined,
    travel: { x: 100, y: 100, z: 100 },
    rapidRate: 60000,
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
    safeZMachine: PARK.z,
  })
}

async function advance(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

function writeEvidence(name: string, evidence: unknown): void {
  if (process.env.WRITE_EVIDENCE !== '1') return
  const directory = join(process.cwd(), 'src/tests/evidence/WO-1997')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, name), `${JSON.stringify(evidence, null, 2)}\n`)
}

interface RunRecord {
  guidedStops: { tool: number | null; resumeLine: number; heldAtLine: number }[]
  plainHolds: { ackedSourceLine: number }[]
  phase: string
  finalMachineX: number | undefined
  loopGuardTripped: boolean
}

/** Start the program and play the operator: Continue on every tool-change card
 * (the probe measures the fitted tool), CYCLE START on a plain hold. Stops at
 * program end, or after more stops than the program has changes (the loop). */
async function runToEnd(): Promise<RunRecord> {
  const record: RunRecord = { guidedStops: [], plainHolds: [], phase: '', finalMachineX: undefined, loopGuardTripped: false }
  expect(getMachineController().startJob()).toBe(true)
  for (let tick = 0; tick < 120; tick++) {
    await advance(500)
    const s = useMachineControl.getState()
    if (s.job.phase === 'complete' && s.machineState === 'idle' && s.toolChange === null) break
    if (record.guidedStops.length > TOOLS.length + 2) {
      record.loopGuardTripped = true
      break
    }
    if (s.toolChange?.step === 'awaiting-swap') {
      record.guidedStops.push({
        tool: s.toolChange.tool,
        resumeLine: s.toolChange.resumeLine,
        heldAtLine: s.toolChange.resumeLine - 1,
      })
      fireEvent.click(screen.getByTestId('control-tc-continue'))
      await advance(20000)
    } else if ((s.machineState === 'hold' || s.job.phase === 'paused') && s.toolChange === null) {
      record.plainHolds.push({ ackedSourceLine: s.job.ackedSourceLine })
      await act(async () => { expect(await executeOperatorCycleStart()).toBe(true) })
    }
  }
  const end = useMachineControl.getState()
  record.phase = end.job.phase
  record.finalMachineX = end.mpos?.x
  return record
}

describe('WO-1997 each tool change stops exactly once', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    memory.clear()
    useCamStore.getState().newProject()
    useMachineActions.setState({ byMachine: {}, macroArrangementByMachine: {} })
    useMachineToolTable.setState({ byMachine: {} })
    configureMachine()
    const connected = connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(300)
    await connected
    useMachineControl.getState().clearConsole()
    act(() => { __resetEstopInterlockForTest() })
    getMachineController().home()
    await vi.advanceTimersByTimeAsync(2000)
    // WO-2037: work Z 0 sits 10 mm below the top of Z travel. T2..T4 measure
    // 2 mm longer than T1, and the simulator now applies that length to the
    // program's Z as the machine does - with work Z 0 AT the top, the program's
    // G0 Z-1 would put the spindle 1 mm above Z max and the start is refused.
    for (const [axis, mm] of [['X', 0], ['Y', 0], ['Z', -10]] as const) {
      expect(setWorkOffsetValue('G54', axis, mm)).toBe(true)
      await vi.advanceTimersByTimeAsync(50)
    }
    const tools = useMachineToolTable.getState()
    tools.recordProbedZ(MACHINE_ID, 1, -42, 1)
    tools.setReference(MACHINE_ID, 1)
    tools.setProbeConfig(MACHINE_ID, { maxTravel: 50 })
  })

  afterEach(async () => {
    cleanup()
    cancelGuidedToolChange()
    const disconnected = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await disconnected
    vi.useRealTimers()
  })

  for (const route of ['text', 'staged'] as const) {
    for (const withM0 of [true, false]) {
      it(`${route} route, ${withM0 ? 'M0 after each M6' : 'no M0'}: T2, T3, T4 each stop once and the program ends`, async () => {
        const text = postedProgram(withM0)
        render(createElement(ProgramPanel))
        if (route === 'text') loadMachineProgram('three-changes.nc', text)
        else expect(loadGcodeTextToolpathProgram('three-changes.nc', text).ok).toBe(true)
        expect(useMachineControl.getState().programReadiness.ready).toBe(true)

        const record = await runToEnd()
        const evidence = {
          route,
          withM0,
          program: text.split('\n'),
          ...record,
          console: useMachineControl.getState().consoleLines.map((line) => line.text),
        }
        writeEvidence(`${route}-${withM0 ? 'with' : 'without'}-m0.json`, evidence)

        const detail = JSON.stringify({ ...record, console: evidence.console.slice(-12) })
        expect(record.loopGuardTripped, detail).toBe(false)
        // Exactly three guided stops, in order, each for its own tool at its own M6.
        expect(record.guidedStops.map((stop) => stop.tool), detail).toEqual([2, 3, 4])
        expect(record.guidedStops.map((stop) => stop.heldAtLine))
          .toEqual([2, 3, 4].map((tool) => lineOf(text, `T${tool} M6`)))
        // Run to M30: the last tool's cut ran and the program ended.
        expect(record.phase, detail).toBe('complete')
        expect(record.finalMachineX).toBeCloseTo(LAST_X, 1)
        // T1 was fitted and measured before the start: its M6 is not a stop. The
        // file's own M0 after it is a plain CYCLE START hold on the text route;
        // the staged route's Cycle Start already covers a pause before the
        // first move. Every M0 after a change is a separate stop.
        expect(record.plainHolds.length, detail).toBe(withM0 ? (route === 'text' ? 4 : 3) : 0)
        if (record.plainHolds.length === 1) {
          expect(record.plainHolds[0].ackedSourceLine).toBe(lineOf(text, 'T1 M6') + 1)
        }
        // Each changed tool was measured into this machine's table.
        const table = useMachineToolTable.getState().tableFor(MACHINE_ID).tools
        for (const tool of [2, 3, 4]) {
          expect(table.find((entry) => entry.tool === tool)?.probedMachineZ, `T${tool}`).toBeCloseTo(-40, 1)
        }
      }, 60000)
    }
  }

  it('reads the hold from either cursor shape and ignores holds that are not at a pause', () => {
    const text = postedProgram(true)
    loadMachineProgram('cursor.nc', text)
    const t2 = lineOf(text, 'T2 M6')
    const t1Pause = lineOf(text, 'T1 M6') + 1
    // Simulator: the cursor sits ON the held line.
    expect(textProgramHoldLine(text, { phase: 'paused', ackedSourceLine: t2, sentSourceLine: t2 }, 1)).toBe(t2)
    // GRBL: the M6 hold is not acknowledged until resume; the cursor is on the
    // line before, with more lines already sent into the buffer.
    expect(textProgramHoldLine(text, { phase: 'streaming', ackedSourceLine: t2 - 1, sentSourceLine: t2 + 4 }, 1)).toBe(t2)
    // The post's M0 after T1 M6 is its own pause, never T1's M6 again.
    expect(textProgramHoldLine(text, { phase: 'paused', ackedSourceLine: t1Pause, sentSourceLine: t1Pause }, 1))
      .toBe(t1Pause)
    // An operator Feed Hold mid-cut, before the next pause was sent: no pause.
    expect(textProgramHoldLine(text, { phase: 'paused', ackedSourceLine: t2 - 3, sentSourceLine: t2 - 2 }, 1)).toBeNull()
    // Every line acknowledged: the Nth hold of the job is its Nth pause.
    expect(textProgramHoldLine(text, { phase: 'complete', ackedSourceLine: 999, sentSourceLine: 999 }, 3)).toBe(t2 + 1)
  })
})
