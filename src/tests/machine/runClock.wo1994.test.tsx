// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Operation, Project, Setup } from '../../types'
import { typedMock } from '../support/typedMock'

vi.mock('../../components/machine/ProgramPreview', () =>
  typedMock<typeof import('../../components/machine/ProgramPreview')>({
    ProgramPreview: () => <div data-testid="program-preview-stub" />,
  }))

const memory = new Map<string, string>()
const memoryStorage: Storage = {
  get length() { return memory.size },
  clear: () => memory.clear(),
  getItem: (key) => memory.get(key) ?? null,
  key: (index) => Array.from(memory.keys())[index] ?? null,
  removeItem: (key) => { memory.delete(key) },
  setItem: (key, value) => { memory.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage, configurable: true })

const { ProgramPanel } = await import('../../components/machine/ProgramPanel')
const { RunClock, runClockSnapshot } = await import('../../components/machine/RunClock')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
const {
  connectMachine,
  disconnectMachine,
  getMachineController,
  loadMachineProgram,
  loadSetupToolpathProgram,
  __resetEstopInterlockForTest,
} = await import('../../lib/machine/machineSession')
const { buildProgramContext } = await import('../../lib/machine/programContext')
const { GRBL_CONFIG, UCCNC_CONFIG, postProject } = await import('../../lib/post')
const {
  makeMachine,
  makeOp,
  makeStock,
  makeTool,
  makeWcs,
  move,
  stampGenerationCurrent,
} = await import('../post/helpers')

const originalProject = useCamStore.getState().project
const originalToolLibrary = useCamStore.getState().toolLibrary

function clockProject(controller: 'grbl' | 'uccnc' = 'grbl'): {
  project: Project
  gcode: string
  context: ReturnType<typeof buildProgramContext>
} {
  const tool = makeTool({ id: 'clock-tool', toolNumber: 1 })
  const moves = [move({ type: 'rapid', x: 0, y: 0, z: 5, role: 'rapid' })]
  for (let index = 0; index < 80; index++) {
    moves.push(move({
      type: 'feed',
      x: index % 2 === 0 ? 40 : 0,
      y: index,
      z: 0,
      feed: 600,
      role: 'cut',
    }))
  }
  const operation: Operation = makeOp({
    id: 'clock-op',
    name: 'Clock cut',
    toolId: tool.id,
    toolpathMoves: moves,
    estimatedCutTimeMs: 120_000,
  })
  const setup: Setup = {
    id: 'clock-setup',
    name: 'Clock setup',
    wcs: makeWcs(),
    stock: makeStock(),
    operations: [operation],
    notes: '',
  }
  const project: Project = {
    id: 'clock-project',
    name: 'Clock project',
    version: '1',
    createdAt: '',
    updatedAt: '',
    machine: makeMachine({ controller }),
    toolLibrary: [tool],
    geometry: [],
    setups: [setup],
    activeSetupId: setup.id,
    activeOperationId: null,
    sceneStock: {} as Project['sceneStock'],
    notes: '',
  }
  stampGenerationCurrent(project, setup, operation, tool)
  const postConfig = controller === 'uccnc' ? UCCNC_CONFIG : GRBL_CONFIG
  const posted = postProject(project, [setup], postConfig, {
    mode: 'combined',
    pauseBetweenSetups: false,
    baseName: 'clock',
    ext: 'nc',
  }).combined!
  const context = buildProgramContext(
    project,
    setup,
    postConfig,
    posted.gcode,
    posted.operationSpans!,
  )
  return { project, gcode: posted.gcode, context }
}

async function settle(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

describe('WO-1994 whole-program run clock', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    const pending = connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(300)
    await pending
    await vi.advanceTimersByTimeAsync(300)
    __resetEstopInterlockForTest()
    expect(getMachineController().setMachinePosition?.(getMachineController().status().machinePos!)).toBe(true)
  }, 30_000)

  afterEach(async () => {
    cleanup()
    getMachineController().emergencyStop()
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(200)
    await pending
    useMachineControl.setState({ cycleEvents: [] })
    useCamStore.setState({ project: originalProject, toolLibrary: originalToolLibrary })
    vi.useRealTimers()
  })

  it('derives elapsed and estimated remaining time without allowing a negative remainder', () => {
    expect(runClockSnapshot(35_000, 5_000, null, 120_000)).toEqual({
      elapsedMs: 30_000,
      remainingMs: 90_000,
    })
    expect(runClockSnapshot(200_000, 5_000, null, 120_000).remainingMs).toBe(0)

    render(
      <RunClock
        phase="streaming"
        startedAt={5_000}
        pausedAt={null}
        estimatedMs={120_000}
      />,
    )
    expect(screen.getByTestId('control-run-clock').textContent).toContain('Est. remaining')
  })

  it('uses the posted program estimate and excludes a real simulator hold from elapsed time', async () => {
    const { project, gcode, context } = clockProject()
    act(() => { useCamStore.setState({ project, toolLibrary: project.toolLibrary }) })
    act(() => { loadMachineProgram('clock.nc', gcode, context) })
    render(<ProgramPanel />)

    expect(screen.queryByTestId('control-run-clock')).toBeNull()
    act(() => { expect(getMachineController().startJob()).toBe(true) })
    await settle(5_000)

    const running = screen.getByTestId('control-run-clock')
    const beforeHold = Number(running.getAttribute('data-elapsed-ms'))
    expect(beforeHold).toBeGreaterThanOrEqual(4_500)
    expect(Number(running.getAttribute('data-remaining-ms'))).toBe(120_000 - beforeHold)
    expect(running.textContent).toContain('Elapsed')
    expect(running.textContent).toContain('Est. remaining')

    act(() => { getMachineController().pauseJob() })
    await settle(600)
    expect(useMachineControl.getState().job.phase).toBe('paused')
    const held = screen.getByTestId('control-run-clock')
    const atHold = Number(held.getAttribute('data-elapsed-ms'))
    expect(held.getAttribute('data-paused')).toBe('true')

    await settle(15_000)
    expect(Number(screen.getByTestId('control-run-clock').getAttribute('data-elapsed-ms'))).toBe(atHold)

    act(() => { expect(getMachineController().resumeJob()).toBe(true) })
    await settle(2_000)
    const afterResume = Number(screen.getByTestId('control-run-clock').getAttribute('data-elapsed-ms'))
    expect(afterResume - atHold).toBeGreaterThanOrEqual(1_500)
    expect(afterResume - atHold).toBeLessThanOrEqual(2_500)
  }, 30_000)

  it('excludes a text-program M0 hold that has no paused event stamp', async () => {
    act(() => {
      loadMachineProgram(
        'm0.nc',
        // WO-2712: keep the M0 after a short feed leg in the sample's
        // negative machine frame rather than a 228 mm approach from fresh G54.
        'G21 G90\nG53 G1 X-20 F600\nM0\nG53 G1 X0 F600\nG53 G1 X-20 F600\nM30\n',
      )
    })
    render(<ProgramPanel />)

    act(() => { expect(getMachineController().startJob()).toBe(true) })
    await settle(4_000)

    expect(useMachineControl.getState().machineState).toBe('hold')
    expect(useMachineControl.getState().job.phase).toBe('paused')
    expect(useMachineControl.getState().job.pausedAt).toBeNull()
    const atHold = Number(screen.getByTestId('control-run-clock').getAttribute('data-elapsed-ms'))

    await settle(30_000)
    expect(Number(screen.getByTestId('control-run-clock').getAttribute('data-elapsed-ms'))).toBe(atHold)

    act(() => { expect(getMachineController().resumeJob()).toBe(true) })
    await settle(1_000)
    const afterResume = Number(screen.getByTestId('control-run-clock').getAttribute('data-elapsed-ms'))
    expect(afterResume - atHold).toBeGreaterThanOrEqual(500)
    expect(afterResume - atHold).toBeLessThanOrEqual(1_500)
  }, 30_000)

  it('excludes a GRBL-shaped hold while the streamer phase remains streaming', async () => {
    const disconnected = disconnectMachine()
    await vi.advanceTimersByTimeAsync(300)
    await disconnected

    act(() => {
      useMachineControl.setState((state) => ({
        machineState: 'hold',
        job: {
          ...state.job,
          phase: 'streaming',
          name: 'grbl-m0.nc',
          totalLines: 6,
          sentLines: 3,
          ackedLines: 3,
          startedAt: Date.now() - 1_000,
          pausedAt: null,
        },
      }))
    })
    render(<ProgramPanel />)
    await settle(0)

    const held = screen.getByTestId('control-run-clock')
    expect(held.getAttribute('data-paused')).toBe('true')
    const atHold = Number(held.getAttribute('data-elapsed-ms'))

    await settle(30_000)
    expect(Number(screen.getByTestId('control-run-clock').getAttribute('data-elapsed-ms'))).toBe(atHold)

    act(() => { useMachineControl.setState({ machineState: 'run' }) })
    await settle(1_000)
    const afterResume = Number(screen.getByTestId('control-run-clock').getAttribute('data-elapsed-ms'))
    expect(afterResume - atHold).toBeGreaterThanOrEqual(500)
    expect(afterResume - atHold).toBeLessThanOrEqual(1_500)
  }, 30_000)

  it('shows the estimate for the staged geometry-program door used by LienCNC', async () => {
    const { project } = clockProject('uccnc')
    const disconnected = disconnectMachine()
    await vi.advanceTimersByTimeAsync(300)
    await disconnected
    act(() => { useCamStore.setState({ project, toolLibrary: project.toolLibrary }) })
    const connected = connectMachine('simulator', 115200)
    await vi.advanceTimersByTimeAsync(300)
    await connected
    await vi.advanceTimersByTimeAsync(300)
    __resetEstopInterlockForTest()
    expect(getMachineController().setMachinePosition?.(getMachineController().status().machinePos!)).toBe(true)
    const loading = loadSetupToolpathProgram('clock-setup')
    await vi.advanceTimersByTimeAsync(2_000)
    const loaded = await loading
    expect(loaded).toEqual({ ok: true, reason: null })
    expect(useMachineControl.getState().programText).toBeNull()
    expect(useMachineControl.getState().stagedProgram).not.toBeNull()
    render(<ProgramPanel />)

    act(() => { expect(getMachineController().startJob()).toBe(true) })
    await settle(1_000)
    const clock = screen.getByTestId('control-run-clock')
    const elapsed = Number(clock.getAttribute('data-elapsed-ms'))
    expect(Number(clock.getAttribute('data-remaining-ms'))).toBe(120_000 - elapsed)
    expect(clock.textContent).not.toContain('unavailable')
  }, 30_000)
})
