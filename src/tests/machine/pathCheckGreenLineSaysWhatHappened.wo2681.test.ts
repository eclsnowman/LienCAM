// @vitest-environment jsdom
// WO-2681: the path check's end-of-run line says what happened. A short jump
// over the threshold is said as a short jump (size, where, how long) at warn
// level - never inside "stayed on the commanded path". A clean run keeps the
// green line, a sustained departure keeps the red one, and the out-of-range
// move-id bookkeeping never reaches the operator's console. Production session
// throughout: connectMachine('simulator'), loadMachineProgram, Home All,
// executeOperatorCycleStart, with the controller's status frames displaced for
// a counted number of frames mid-run.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import type { MachineStatus } from '../../lib/machine/controller'
import { typedMock } from '../support/typedMock'

vi.mock('../../components/machine/ProgramPreview', () => typedMock<typeof import('../../components/machine/ProgramPreview')>({
  ProgramPreview: () => createElement('div', { 'data-testid': 'program-preview-stub' }),
}))

const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const {
  __resetEstopInterlockForTest, connectMachine, disconnectMachine, getMachineController,
  loadMachineProgram, pathFidelityReport,
} = await import('../../lib/machine/machineSession')
const { executeOperatorCycleStart } = await import('../../lib/machine/operatorTransport')

const initial = useCamStore.getInitialState()
const initialControl = useMachineControl.getState()

// The long X move is block 4 of what the controller is sent (ids follow the
// program's motion order); a Y offset on it is perpendicular to the path.
// WO-2712: locate both XY axes at work zero on the first rapid. Leaving Y
// omitted held it at machine Y0 (work Y243) under the sample's logical G54,
// adding a 243 mm feed leg instead of this test's intended 20 mm Y move.
const PROGRAM = ['G90 G21 G54', 'G0 X0 Y0 Z10', 'G1 Z5 F600', 'G1 X40 F600', 'G1 Y20', 'G0 Z12', 'M30'].join('\n')
const JUMP_MM = 1

interface Injection {
  /** Displace this many consecutive status frames... */
  frames: number
  /** ...starting this many frames into the long X move. */
  after: number
  /** A second window of the same length, starting this many frames in. */
  again?: number
  /** An executing id outside the queued range on one frame of the X move. */
  outOfRangeId?: boolean
}

async function connectSimulator(): Promise<void> {
  const pending = connectMachine('simulator', 115200)
  await vi.advanceTimersByTimeAsync(350)
  await pending
  await vi.advanceTimersByTimeAsync(50)
  __resetEstopInterlockForTest()
}

/** Wrap the controller's status frames: the injected frames report a position
 *  JUMP_MM off the long X move, both machine and work, as a real jump would. */
function injectOnXMove(injection: Injection): { displaced: () => number } {
  const ctrl = getMachineController()
  const original = ctrl.status!.bind(ctrl)
  let xFrames = 0
  let displaced = 0
  let xMoveId: number | null = null
  ;(ctrl as { status: () => MachineStatus }).status = () => {
    const frame = original()
    if (frame.state !== 'run' || frame.executingMoveId === null || frame.machinePos === null) return frame
    const pos = frame.machinePos
    // WO-2712: identify the same X move in its stated WORK frame; machine
    // coordinates now include the sample's front-left-top G54 placement.
    const work = frame.workPos
    if (xMoveId === null && work && work.x > 5 && work.x < 35 && Math.abs(work.y) < 1e-9) xMoveId = frame.executingMoveId
    if (frame.executingMoveId !== xMoveId) return frame
    const n = xFrames++
    if (injection.outOfRangeId && n === 1) return { ...frame, executingMoveId: 1079590912 }
    const inWindow = (start: number | undefined): boolean =>
      start !== undefined && n >= start && n < start + injection.frames
    if (!inWindow(injection.after) && !inWindow(injection.again)) return frame
    displaced++
    return {
      ...frame,
      machinePos: { ...pos, y: pos.y + JUMP_MM },
      workPos: frame.workPos === null ? null : { ...frame.workPos, y: frame.workPos.y + JUMP_MM },
    }
  }
  return { displaced: () => displaced }
}

async function run(injection: Injection | null, program = PROGRAM, runMs = 30_000): Promise<{
  pathLine: { text: string; severity: string }
  all: string
  displaced: number
}> {
  await connectSimulator()
  const loaded = loadMachineProgram('wo2681.nc', program, null)
  expect(loaded.lines.length).toBeGreaterThan(0)
  const ctrl = getMachineController()
  expect(ctrl.homeAxes?.(['X', 'Y', 'Z'])).toBe(true)
  await vi.advanceTimersByTimeAsync(5_000)
  const probe = injection === null ? null : injectOnXMove(injection)
  expect(await executeOperatorCycleStart()).toBe(true)
  await vi.advanceTimersByTimeAsync(runMs)
  expect(useMachineControl.getState().job.phase).toBe('complete')
  const lines = useMachineControl.getState().consoleLines
  const pathLines = lines.filter((line) => line.text.startsWith('Path check:'))
  expect(pathLines).toHaveLength(1)
  return {
    pathLine: { text: pathLines[0].text, severity: pathLines[0].severity },
    all: lines.map((line) => line.text).join('\n'),
    displaced: probe?.displaced() ?? 0,
  }
}

describe('WO-2681 the path check line says what happened', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useCamStore.setState(initial, true)
    useMachineControl.setState({ ...initialControl, consoleLines: [] })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    getMachineController().emergencyStop()
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(100)
    await pending
    vi.useRealTimers()
    useCamStore.setState(initial, true)
  })

  it('(a) a run within the threshold keeps the green line', async () => {
    const { pathLine } = await run(null)
    expect(pathLine.text).toMatch(/^Path check: the machine stayed on the commanded path - worst 0\.00 mm /)
    expect(pathLine.severity).toBe('info')
    expect(pathFidelityReport()!.verdict).toBe('clean')
  })

  it('(b) a two-frame jump over the threshold is said as a short jump, at warn, never "stayed on"', async () => {
    const { pathLine, displaced } = await run({ frames: 2, after: 4 })
    expect(displaced).toBe(2)
    const report = pathFidelityReport()!
    // The sustained rule is unchanged: two frames do not make a departure.
    expect(report.verdict).toBe('clean')
    expect(report.spans).toEqual([])
    expect(report.worst!.deviationMm).toBeCloseTo(JUMP_MM, 6)
    expect(report.worst!.deviationMm).toBeGreaterThan(report.thresholdMm!)
    // Main: "Path check: the machine stayed on the commanded path - worst 1.00 mm ..."
    expect(pathLine.text).not.toContain('stayed on the commanded path')
    expect(pathLine.text).toMatch(
      /^Path check: the machine was off the commanded path briefly - 1\.00 mm at G54 X [\d.]+ mm Y 1\.00 mm Z 5\.00 mm .* for 2 status frames \(about \d+ ms\), against a 0\.03 mm threshold, over \d+ matched status frames\. None lasted the 3 status frames that count as leaving the path\.$/,
    )
    expect(pathLine.text).not.toMatch(/LEFT THE COMMANDED PATH/)
    expect(pathLine.severity).toBe('warn')
  })

  it('(b) a one-frame jump says one status frame', async () => {
    const { pathLine, displaced } = await run({ frames: 1, after: 4 })
    expect(displaced).toBe(1)
    expect(pathFidelityReport()!.verdict).toBe('clean')
    expect(pathLine.text).not.toContain('stayed on the commanded path')
    expect(pathLine.text).toMatch(/off the commanded path briefly - 1\.00 mm at .* for one status frame \(about \d+ ms\)/)
    expect(pathLine.severity).toBe('warn')
  })

  it('(b) two separate short jumps: the worst one, and how many there were', async () => {
    const { pathLine, displaced } = await run({ frames: 2, after: 4, again: 12 })
    expect(displaced).toBe(4)
    expect(pathFidelityReport()!.verdict).toBe('clean')
    expect(pathLine.text).toMatch(/off the commanded path briefly - 1\.00 mm at .* for 2 status frames /)
    expect(pathLine.text).toContain(' That happened 2 times in this run. None lasted the 3 status frames')
    expect(pathLine.severity).toBe('warn')
  })

  it('(c) a sustained departure keeps the red line and its rule', async () => {
    const { pathLine, displaced } = await run({ frames: 6, after: 4 })
    expect(displaced).toBe(6)
    expect(pathFidelityReport()!.verdict).toBe('divergence')
    expect(pathLine.text).toMatch(/^Path check: THE MACHINE LEFT THE COMMANDED PATH - up to 1\.00 mm off at G54 /)
    expect(pathLine.text).toMatch(/\(6 status frames\), against a 0\.03 mm threshold\. Check the part before running this program again\.$/)
    expect(pathLine.severity).toBe('error')
  })

  it('a short jump in a recording that reached its cap is still said as a short jump', async () => {
    // Review (astra 10-08): a slow X move runs the recording past its 60000
    // frame cap; main rewrote the clean report to "the first 60000 status
    // frames stayed on the commanded path" over a two-frame 1.00 mm jump.
    const slow = PROGRAM.replace('G1 X40 F600', 'G1 X40 F0.4').replace('G1 Y20', 'G1 Y20 F600')
    const { pathLine, displaced } = await run({ frames: 2, after: 4 }, slow, 6_100_000)
    expect(displaced).toBe(2)
    const report = pathFidelityReport()!
    expect(report.samples.total).toBe(60_000)
    expect(report.verdict).toBe('unknown')
    expect(report.spans).toEqual([])
    expect(report.worst!.deviationMm).toBeCloseTo(JUMP_MM, 6)
    expect(pathLine.text).not.toContain('stayed on the commanded path')
    expect(pathLine.text).toMatch(
      /^Path check: CANNOT ASSESS the whole job - the first 60000 status frames were recorded, and the rest were not\. In those frames the machine was off the commanded path briefly - 1\.00 mm at G54 .* for 2 status frames \(about \d+ ms\), against a 0\.03 mm threshold, over \d+ matched status frames\. None lasted the 3 status frames that count as leaving the path\.$/,
    )
    expect(pathLine.severity).toBe('warn')
  }, 600_000)

  it('no outcome puts the out-of-range move id bookkeeping on the console', async () => {
    const clean = await run({ frames: 0, after: 0, outOfRangeId: true })
    expect(pathFidelityReport()!.samples.outOfRange).toBe(1)
    expect(clean.pathLine.text).toMatch(/^Path check: the machine stayed on the commanded path/)
    expect(clean.all).not.toMatch(/out-of-range move id|outside the queued range/)
  })

  it('a short jump on a run that also carried an out-of-range id: short-jump line, no bookkeeping', async () => {
    const { pathLine, all } = await run({ frames: 2, after: 4, outOfRangeId: true })
    expect(pathFidelityReport()!.samples.outOfRange).toBe(1)
    expect(pathLine.text).toMatch(/off the commanded path briefly/)
    expect(all).not.toMatch(/out-of-range move id|outside the queued range/)
  })
})
