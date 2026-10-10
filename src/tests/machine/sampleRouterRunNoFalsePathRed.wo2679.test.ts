// @vitest-environment jsdom
// WO-2679: the shipped sample router's first run on the in-app simulator ends
// with no false path-check red. Production session throughout: connectMachine,
// loadMachineProgram, Home All, executeOperatorCycleStart.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import type { MachineConfig } from '../../types'
import { createDefaultControllerDefinition } from '../../types'
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

// The machine seat's 10-08 desk file.
const PLAIN_FILE = readFileSync(
  resolve(process.cwd(), 'docs/machine/final-session-programs/final-o9-comments-first.nc'),
  'utf8',
)
const initial = useCamStore.getInitialState()
const initialControl = useMachineControl.getState()

async function connectSimulatorWith(machine: MachineConfig): Promise<void> {
  useCamStore.setState({ project: { ...initial.project, machine }, machineLibrary: [machine] })
  const pending = connectMachine('simulator', 115200)
  await vi.advanceTimersByTimeAsync(350)
  await pending
  await vi.advanceTimersByTimeAsync(50)
  // Clear the fresh-connection E-STOP latch, as the operator does.
  __resetEstopInterlockForTest()
}

/** The desk order: Load, then Home All, then Cycle Start, to the end. */
async function loadHomeAndRun(name: string, text: string): Promise<{ errors: string[]; pathLine: string }> {
  const loaded = loadMachineProgram(name, text, null)
  expect(loaded.lines.length).toBeGreaterThan(0)
  const ctrl = getMachineController()
  expect(ctrl.homeAxes?.(['X', 'Y', 'Z'])).toBe(true)
  await vi.advanceTimersByTimeAsync(5_000)
  expect(ctrl.status?.().homed).toEqual({ X: true, Y: true, Z: true })
  expect(await executeOperatorCycleStart()).toBe(true)
  await vi.advanceTimersByTimeAsync(30_000)
  expect(useMachineControl.getState().job.phase).toBe('complete')
  const lines = useMachineControl.getState().consoleLines
  const pathLine = lines.find((line) => line.text.startsWith('Path check:'))?.text ?? ''
  return { errors: lines.filter((line) => line.severity === 'error').map((line) => line.text), pathLine }
}

function sampleRouter(): MachineConfig {
  return useCamStore.getInitialState().project.machine
}

describe('WO-2679 the sample router run ends without a false path red', () => {
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

  it('fresh-profile sample router: Load, Home All, Cycle Start of the desk file ends green', async () => {
    await connectSimulatorWith(sampleRouter())
    const { errors, pathLine } = await loadHomeAndRun('final-o9-comments-first.nc', PLAIN_FILE)

    // Main: "THE MACHINE LEFT THE COMMANDED PATH - up to 6.15 mm off at G54 X -4.35 ...".
    expect(errors).toEqual([])
    expect(pathLine).toMatch(/^Path check: the machine stayed on the commanded path - worst 0\.00 mm /)
    const report = pathFidelityReport()!
    expect(report.verdict).toBe('clean')
    expect(report.worst!.deviationMm).toBeLessThan(1e-9)
    // The 5.35 mm sample was the simulator flying G0 Z15 toward its pre-home
    // X-5 Y-5. Every frame of that rapid is now on X0 Y0.
    const rapid = report.evidence!.filter((row) => row.reportedMoveId === 6)
    expect(rapid.length).toBeGreaterThan(0)
    for (const row of rapid) {
      expect(row.machinePos!.x).toBeCloseTo(0, 9)
      expect(row.machinePos!.y).toBeCloseTo(0, 9)
    }
  })

  it('a machine with no stated tolerance is never judged against 0.00 mm', async () => {
    await connectSimulatorWith(sampleRouter())
    const { pathLine } = await loadHomeAndRun('final-o9-comments-first.nc', PLAIN_FILE)
    expect(pathLine).not.toContain('against a 0.00 mm threshold')
    expect(pathLine).toContain('against a 0.03 mm threshold')
    expect(pathFidelityReport()?.toleranceMm).toBe(0.01)
  })

  it('an arc whose start X was never named turns about the centre the run reaches', async () => {
    // WO-2712: the sample's stated travel is X/Y -406..0, Z -95..0 (home at
    // max). G54 X stays at machine X0 so work X is machine X; Y/Z sit on the table.
    const sample = sampleRouter()
    useCamStore.getState().setMachineWorkOffset(sample.id, 'G54', { x: 0, y: -200, z: -60 }, 'not-sent')
    await connectSimulatorWith(sample)
    // X is never named before the arc, so its start - and its centre - come
    // from where the run begins (X0 after Home All), not from the load.
    const program = ['G90 G21 G54', 'G0 Z10', 'G1 Y4 F600', 'G2 X-4 Y4 I-2 J0', 'G0 Z12', 'M30'].join('\n')
    const { errors, pathLine } = await loadHomeAndRun('arc.nc', program)
    expect(errors).toEqual([])
    expect(pathLine).toMatch(/^Path check: the machine stayed on the commanded path/)
    const report = pathFidelityReport()!
    expect(report.verdict).toBe('clean')
    const onArc = report.evidence!.filter((row) => row.reportedMoveId === 4)
    expect(onArc.length).toBeGreaterThan(0)
    for (const row of onArc) {
      expect(Math.hypot(row.machinePos!.x + 2, row.machinePos!.y + 196)).toBeCloseTo(2, 9)
    }
    const end = getMachineController().status!().machinePos!
    expect([end.x, end.y, end.z].map((v) => Number(v.toFixed(9)))).toEqual([-4, -196, -48])
  })

  it('a G91 block adds to where the run is, not to where the program was loaded', async () => {
    // WO-2712: stated travel X/Y -406..0 (home at max), so the step is -X; the
    // fresh-profile G54 Z (the simulated part's top) places Z12.
    await connectSimulatorWith(sampleRouter())
    const g54z = useMachineControl.getState().offsets.G54![2]
    const program = ['G90 G21 G54', 'G0 Z10', 'G91 G0 X-3', 'G90 G0 Z12', 'M30'].join('\n')
    const { errors } = await loadHomeAndRun('incremental.nc', program)
    expect(errors).toEqual([])
    const end = getMachineController().status!().machinePos!
    expect([end.x, end.y, end.z].map((v) => Number(v.toFixed(9)))).toEqual([-3, 0, Number((g54z + 12).toFixed(9))])
  })

  it('a LienCNC-style stated tolerance is unchanged (Linearerror 0.03 -> 0.09 mm)', async () => {
    const definition = createDefaultControllerDefinition()
    for (const axis of definition.axes) {
      axis.softLimitMin = -10
      axis.softLimitMax = 100
    }
    const stated: MachineConfig = {
      ...sampleRouter(), id: 'wo2679-stated', name: 'Stated router', controller: 'uccnc',
      controllerDefinition: definition,
      unsentSettings: [{ controller: 'uccnc', key: 'Generalsettings.Linearerror', value: '0.03' }],
    }
    // WO-2712: the sample's stated home end is not this machine's.
    delete stated.homeConvention
    await connectSimulatorWith(stated)
    const { errors, pathLine } = await loadHomeAndRun('final-o9-comments-first.nc', PLAIN_FILE)
    expect(errors).toEqual([])
    expect(pathFidelityReport()?.toleranceMm).toBe(0.03)
    expect(pathFidelityReport()?.thresholdMm).toBeCloseTo(0.09, 10)
    expect(pathLine).toContain('against a 0.09 mm threshold')
  })

  it('a run that truly leaves the path still says so, once, in red', async () => {
    await connectSimulatorWith(sampleRouter())
    const ctrl = getMachineController()
    // The machine drifts 1 mm in Y through the whole X0 -> X20 cut (line 9).
    const real = ctrl.status!.bind(ctrl)
    vi.spyOn(ctrl, 'status').mockImplementation((): MachineStatus => {
      const status = real()
      if (status.executingMoveId !== 9) return status
      const off = <P extends { y: number }>(p: P | null | undefined): P | null =>
        p ? { ...p, y: p.y + 1 } : null
      return { ...status, machinePos: off(status.machinePos), workPos: off(status.workPos) }
    })
    const { errors } = await loadHomeAndRun('final-o9-comments-first.nc', PLAIN_FILE)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/^Path check: THE MACHINE LEFT THE COMMANDED PATH - up to 1\.00 mm off/)
    expect(errors[0]).toContain('against a 0.03 mm threshold')
    expect(pathFidelityReport()?.verdict).toBe('divergence')
  })
  // Review 10-08 (astra): a refused start keeps the staged program; a later
  // length change must not lose the start-relative record, or the retry's
  // Z-only block keeps the X of the refused attempt.
  it('review retry after length rebase preserves the actual start', async () => {
    const { SimulatedController } = await import('../../lib/machine/simulatedController')
    const home = { homesToward: 'min', machineZeroAt: 'min' } as const
    const ctrl = new SimulatedController({}, {
      travelMm: { x: 100, y: 100, z: 100 },
      homeConvention: { x: home, y: home, z: home },
    })
    try {
      await ctrl.connect({ kind: 'none' })
      expect(ctrl.home()).toBe(true)
      await vi.advanceTimersByTimeAsync(2000)
      const initialX = ctrl.status().machinePos!.x
      expect(ctrl.loadJob('G90 G21\nG0 Z10\nM30').ok).toBe(true)
      expect(ctrl.sendCommand('G43.1 Z200')).toBe(true)
      expect(ctrl.jog('X', 5, 600)).toBe(true)
      await vi.advanceTimersByTimeAsync(2000)
      expect(ctrl.startJob()).toBe(false)
      expect(ctrl.machineState()).toBe('alarm')
      expect(ctrl.unlock()).toBe(true)
      expect(ctrl.sendCommand('G43.1 Z0')).toBe(true)
      expect(ctrl.jog('X', -5, 600)).toBe(true)
      await vi.advanceTimersByTimeAsync(2000)
      expect(ctrl.status().machinePos!.x).toBeCloseTo(initialX, 9)
      expect(ctrl.startJob()).toBe(true)
      await vi.advanceTimersByTimeAsync(10000)
      expect(ctrl.status().machinePos!.x).toBeCloseTo(initialX, 9)
    } finally {
      await ctrl.disconnect()
    }
  })
})
