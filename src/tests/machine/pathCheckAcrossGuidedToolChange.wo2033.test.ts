// @vitest-environment jsdom
//
// WO-2033: the path check never scores a guided tool change.
//
// Driven on the simulator through the production ProgramPanel (the WO-2017 /
// WO-2025 staged-M6 harness) with the REAL path-fidelity analyser - nothing in
// pathFidelity is mocked. A two-tool program runs its guided M6: park over the
// pad, swap, Continue measures at the setter, rises to safe Z, and the program
// resumes with a SLOW (F600) move from the setter back to its next point.
//   1. that run ends without a path-check RED;
//   2. a real departure inside a cut BEFORE the tool change still reports RED;
//   3. a real departure inside a cut AFTER the tool change still reports RED.
// The departure is the simulator reporting a position 1 mm off the commanded
// cut for the whole of that one move - what a dropped or displaced block looks
// like to the check.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MachineStatus } from '../../lib/machine/controller'
import type { PathFidelityReport } from '../../lib/machine/pathFidelity'

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

const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useMachineToolTable } = await import('../../store/machineToolTableStore')
const {
  __resetEstopInterlockForTest,
  cancelGuidedToolChange,
  connectMachine,
  disconnectMachine,
  getMachineController,
  pathFidelityReport,
  setPathToleranceMm,
  stagedGeometryProgramPath,
} = await import('../../lib/machine/machineSession')

const SIM_ID = 'wo2033-simulator'
const PARK = { id: 'm6-pad', label: 'Fixed tool probe', x: 60, y: 70, z: -20 }
const SAFE_Z = -2
// Where the simulator's setter measure touches off. The reference is recorded
// there too, so T2's length offset is 0: the simulator executes staged XYZ as
// machine coordinates and would not follow a work-Z fold (a simulator gap this
// order does not own), which would read as a 2 mm departure in the next cut.
const SETTER_CONTACT_Z = -40
// The cut before the change runs X10 -> X30 at Y10 Z-5; the one after it runs
// X40 -> X60 at Y20 Z-5. The first move after T2 M6 is the SLOW return from the
// setter (F600) that the WO-2025 audit reproduced a false RED on.
const PROGRAM = [
  'G21',
  'G90',
  'T1 M6',
  'G0 X10 Y10 Z-1',
  'G1 Z-5 F600',
  'G1 X30 F600',
  'G0 Z-1',
  'T2 M6',
  'G1 X40 Y20 Z-1 F600',
  'G1 Z-5 F600',
  'G1 X60 F600',
  'G0 Z-1',
  'M30',
].join('\n')
const CUT_BEFORE = { x: 30, y: 10, z: -5 }
const CUT_AFTER = { x: 60, y: 20, z: -5 }
const RETURN_END = { x: 40, y: 20, z: -1 }

async function advance(ms: number): Promise<void> {
  const { act } = await import('@testing-library/react')
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

beforeEach(async () => {
  vi.useFakeTimers()
  mem.clear()
  useCamStore.getState().newProject()
  useMachineControl.setState({ consoleLines: [], parserModal: null, toolChange: null })
  useMachineToolTable.setState({ byMachine: {} })
  const { positionMacroBody } = await import('../../types')
  const { useMachineActions } = await import('../../store/machineActionsStore')
  useMachineActions.setState({ byMachine: {}, macroArrangementByMachine: {} })
  useCamStore.setState((s) => ({ control: { ...s.control, activeMachineId: null } }))
  const machine = useCamStore.getState().project.machine
  useCamStore.getState().setProjectMachine({
    ...machine,
    id: SIM_ID,
    name: 'WO-2033 simulator',
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
    safeZMachine: SAFE_Z,
  } as never)
  const connected = connectMachine('simulator', 115200)
  await vi.advanceTimersByTimeAsync(300)
  await connected
  useMachineControl.getState().clearConsole()
  __resetEstopInterlockForTest()
  getMachineController().home()
  await vi.advanceTimersByTimeAsync(2000)
  const tools = useMachineToolTable.getState()
  tools.recordProbedZ(SIM_ID, 1, SETTER_CONTACT_Z, 1)
  tools.setReference(SIM_ID, 1)
  tools.setProbeConfig(SIM_ID, { maxTravel: 50 })
})

afterEach(async () => {
  const { cleanup } = await import('@testing-library/react')
  cleanup()
  cancelGuidedToolChange()
  if (getMachineController().connectionPhase() !== 'disconnected') {
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(300)
    await pending
  }
  vi.useRealTimers()
})

/** The staged move id whose endpoint is `to`. */
function moveIdEndingAt(to: { x: number; y: number; z: number }): number {
  const staged = stagedGeometryProgramPath()
  expect(staged).not.toBeNull()
  const index = staged!.moves.findIndex((move) =>
    Math.abs(move.x - to.x) < 1e-6 && Math.abs(move.y - to.y) < 1e-6 && Math.abs(move.z - to.z) < 1e-6)
  expect(index).toBeGreaterThanOrEqual(0)
  return staged!.moveLines[index]
}

/** A departure: the simulator reports the tool 1 mm off the path for the whole
 * of the cut that ends at `to`. */
function departAt(to: { x: number; y: number; z: number }): (status: MachineStatus) => MachineStatus {
  const departId = moveIdEndingAt(to)
  const off = <T extends { y: number } | null | undefined>(p: T): T =>
    (p ? { ...p, y: p.y + 1 } : p) as T
  return (status) => status.executingMoveId !== departId || status.state !== 'run'
    ? status
    : { ...status, machinePos: off(status.machinePos), workPos: off(status.workPos) }
}

/** Run the two-tool program through the production panel, with the simulator's
 * status frames optionally rewritten on their way to the session. */
async function runTwoToolProgram(
  rewrite: (() => (status: MachineStatus) => MachineStatus) | null,
): Promise<{
  report: PathFidelityReport
  lines: string[]
}> {
  const { createElement } = await import('react')
  const { fireEvent, render, screen } = await import('@testing-library/react')
  const { ProgramPanel } = await import('../../components/machine/ProgramPanel')
  const { loadGcodeTextToolpathProgram, setWorkOffsetValue } = await import('../../lib/machine/machineSession')
  for (const axis of ['X', 'Y', 'Z'] as const) {
    expect(setWorkOffsetValue('G54', axis, 0)).toBe(true)
    await advance(50)
  }
  render(createElement(ProgramPanel))
  const loaded = loadGcodeTextToolpathProgram('two-tools.nc', PROGRAM)
  expect(loaded.reason ?? null).toBeNull()
  expect(loaded.ok).toBe(true)
  // The simulator carries no UCCNC Linearerror; give the check a tolerance so
  // it returns a verdict rather than UNKNOWN (threshold 3 x 0.05 = 0.15 mm).
  setPathToleranceMm(0.05)

  const ctrl = getMachineController()
  if (rewrite !== null) {
    const change = rewrite()
    const real = ctrl.status.bind(ctrl)
    ctrl.status = (): MachineStatus => change(real())
  }

  // The last run's report stays published until this run's analysis answers.
  const previousReport = pathFidelityReport()
  expect(ctrl.startJob()).toBe(true)
  for (let t = 0; t <= 20000 && useMachineControl.getState().toolChange?.step !== 'awaiting-swap'; t += 50) {
    await advance(50)
  }
  expect(useMachineControl.getState().toolChange?.step).toBe('awaiting-swap')
  fireEvent.click(screen.getByTestId('control-tc-continue'))
  for (let t = 0; t <= 30000 && useMachineControl.getState().job.phase !== 'complete'; t += 10) await advance(10)
  expect(useMachineControl.getState().job.phase).toBe('complete')
  for (let t = 0; t <= 2000 && pathFidelityReport() === previousReport; t += 10) await advance(10)
  const report = pathFidelityReport()
  expect(report).not.toBeNull()
  expect(report).not.toBe(previousReport)
  return { report: report!, lines: useMachineControl.getState().consoleLines.map((l) => l.text) }
}

describe('WO-2033: the path check never scores a guided tool change', () => {
  it('a two-tool program with a guided M6 and a slow return from the setter ends without a path-check RED', async () => {
    const { report, lines } = await runTwoToolProgram(null)
    expect(report.headline).not.toContain('LEFT THE COMMANDED PATH')
    expect(report.verdict).toBe('clean')
    expect(report.spans).toEqual([])
    // Both cuts were scored - frames on either side of the change - and the
    // slow return from the setter was not.
    const scoredIds = new Set(report.evidence!.map((row) => row.reportedMoveId))
    expect(scoredIds.has(moveIdEndingAt(CUT_BEFORE))).toBe(true)
    expect(scoredIds.has(moveIdEndingAt(CUT_AFTER))).toBe(true)
    expect(scoredIds.has(moveIdEndingAt(RETURN_END))).toBe(false)
    expect(report.limits.some((l) => /around the tool change were not scored/.test(l)
      && /Scoring resumed at the first move/.test(l))).toBe(true)
    expect(lines.some((l) => l.includes('LEFT THE COMMANDED PATH'))).toBe(false)
  })

  it('a real departure inside the cut BEFORE the tool change still reports RED', async () => {
    const { report } = await runTwoToolProgram(() => departAt(CUT_BEFORE))
    expect(report.verdict).toBe('divergence')
    // The departure itself is the worst thing the check saw - not the tool change.
    expect(report.headline).toContain('LEFT THE COMMANDED PATH - up to 1.00 mm off')
    expect(report.spans.some((s) => s.peakDeviationMm > 0.9 && s.peakDeviationMm < 1.1)).toBe(true)
  })

  it('a real departure inside the cut AFTER the tool change still reports RED', async () => {
    const { report } = await runTwoToolProgram(() => departAt(CUT_AFTER))
    expect(report.verdict).toBe('divergence')
    // The departure itself is the worst thing the check saw - not the tool change.
    expect(report.headline).toContain('LEFT THE COMMANDED PATH - up to 1.00 mm off')
    expect(report.spans.some((s) => s.peakDeviationMm > 0.9 && s.peakDeviationMm < 1.1)).toBe(true)
  })

  it('an executing id the tool change left on the board does not resume scoring at the setter', async () => {
    // UCCNC keeps its last executing id until new motion, and the change's own
    // staged moves are numbered from 1 like any program. Emulate a board whose
    // id through the hold - and on the frames after the resume, until the
    // resumed part moves - names move 7, a move past the return: a stale id
    // that must not be read as "the program has rejoined its path".
    const { report } = await runTwoToolProgram(() => {
      const stale = moveIdEndingAt(CUT_AFTER)
      const firstAfter = moveIdEndingAt(RETURN_END)
      let phase: 'program' | 'held' | 'resumed' = 'program'
      return (status) => {
        const id = status.executingMoveId
        if (phase === 'program' && typeof id === 'number' && id < 0) phase = 'held'
        if (phase === 'held' && id === firstAfter) phase = 'resumed'
        return phase === 'held' && (id === null || id === undefined || id < 0)
          ? { ...status, executingMoveId: stale }
          : status
      }
    })
    expect(report.headline).not.toContain('LEFT THE COMMANDED PATH')
    expect(report.verdict).toBe('clean')
    expect(report.evidence!.some((row) => row.reportedMoveId === moveIdEndingAt(CUT_AFTER))).toBe(true)
  })
})
