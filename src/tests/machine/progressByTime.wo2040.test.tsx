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
const { deriveOperatorProgramPercent } = await import('../../lib/machine/operatorTransport')
const { buildProgramContext } = await import('../../lib/machine/programContext')
const { GRBL_CONFIG, postProject } = await import('../../lib/post')
const { useCamStore } = await import('../../store')
const { useMachineControl } = await import('../../store/machineControlStore')
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
const originalJob = useMachineControl.getState().job

function estimatedProgram(estimatedCutTimeMs: number): {
  project: Project
  gcode: string
  context: ReturnType<typeof buildProgramContext>
} {
  const tool = makeTool({ id: 'progress-tool', toolNumber: 1 })
  const operation: Operation = makeOp({
    id: 'progress-op',
    name: 'Long adaptive',
    toolId: tool.id,
    toolpathMoves: [
      move({ type: 'rapid', x: 0, y: 0, z: 5, role: 'rapid' }),
      move({ type: 'feed', x: 90, y: 0, z: 0, feed: 600, role: 'cut' }),
      move({ type: 'feed', x: 100, y: 0, z: 0, feed: 600, role: 'cut' }),
    ],
    estimatedCutTimeMs,
  })
  const setup: Setup = {
    id: 'progress-setup',
    name: 'Progress setup',
    wcs: makeWcs(),
    stock: makeStock(),
    operations: [operation],
    notes: '',
  }
  const project: Project = {
    id: 'progress-project',
    name: 'Progress project',
    version: '1',
    createdAt: '',
    updatedAt: '',
    machine: makeMachine({ controller: 'grbl' }),
    toolLibrary: [tool],
    geometry: [],
    setups: [setup],
    activeSetupId: setup.id,
    activeOperationId: null,
    sceneStock: {} as Project['sceneStock'],
    notes: '',
  }
  stampGenerationCurrent(project, setup, operation, tool)
  const posted = postProject(project, [setup], GRBL_CONFIG, {
    mode: 'combined',
    pauseBetweenSetups: false,
    baseName: 'progress',
    ext: 'nc',
  }).combined!
  return {
    project,
    gcode: posted.gcode,
    context: buildProgramContext(project, setup, GRBL_CONFIG, posted.gcode, posted.operationSpans!),
  }
}

function progressText(): string {
  return screen.getByTestId('control-progress-text').textContent ?? ''
}

function setJob(values: Partial<typeof originalJob>): void {
  useMachineControl.setState((state) => ({ job: { ...state.job, ...values } }))
}

describe('WO-2040 operator program percent', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-26T17:00:00-05:00'))
    act(() => {
      useMachineControl.getState().setProgram(null, null, [], null)
      useMachineControl.setState({ machineState: 'idle' })
    })
  })

  afterEach(() => {
    cleanup()
    act(() => {
      useMachineControl.getState().setProgram(null, null, [], null)
      useMachineControl.setState({ job: originalJob, machineState: 'unknown' })
      useCamStore.setState({ project: originalProject, toolLibrary: originalToolLibrary })
    })
    vi.useRealTimers()
  })

  it('chooses time before distance or moves, then distance before moves', () => {
    const base = {
      phase: 'streaming' as const,
      elapsedMs: 22 * 60_000,
      estimatedMs: 31 * 60_000,
      completedDistance: 900,
      totalDistance: 1_000,
      completedMoves: 20,
      totalMoves: 100,
    }
    expect(deriveOperatorProgramPercent(base)).toBe(71)
    expect(deriveOperatorProgramPercent({ ...base, estimatedMs: null })).toBe(90)
    expect(deriveOperatorProgramPercent({
      ...base,
      estimatedMs: null,
      completedDistance: 0,
      totalDistance: 0,
    })).toBe(20)
    expect(deriveOperatorProgramPercent({ ...base, elapsedMs: 99_999_999 })).toBe(99)
    expect(deriveOperatorProgramPercent({ ...base, phase: 'complete' })).toBe(100)
  })

  it('renders about 70 percent after 22 of 31 estimated minutes and advances with pause-aware time', async () => {
    const estimate = 31 * 60_000
    const { project, gcode, context } = estimatedProgram(estimate)
    act(() => {
      useCamStore.setState({ project, toolLibrary: project.toolLibrary })
      useMachineControl.getState().setProgram('full-suite-shape.nc', gcode, [], context)
      useMachineControl.setState({ machineState: 'run' })
      setJob({
        phase: 'streaming',
        totalLines: 100,
        sentLines: 100,
        ackedLines: 20,
        ackedSourceLine: 1,
        startedAt: Date.now() - 22 * 60_000,
        pausedAt: null,
      })
    })
    render(<ProgramPanel />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })

    expect(progressText()).toContain('20/100 (71%)')
    expect(screen.getByTestId('control-progress-fill').getAttribute('style')).toBe('width: 71%;')
    expect(Number(screen.getByTestId('control-run-clock').getAttribute('data-elapsed-ms'))).toBe(22 * 60_000)

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(progressText()).toContain('(74%)')

    act(() => {
      useMachineControl.setState({ machineState: 'hold' })
      setJob({ phase: 'streaming', pausedAt: null })
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    const heldPercent = progressText().match(/\((\d+)%\)/)?.[1]
    await act(async () => { await vi.advanceTimersByTimeAsync(3 * 60_000) })
    expect(progressText()).toContain(`(${heldPercent}%)`)

    act(() => { useMachineControl.setState({ machineState: 'run' }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(Number(progressText().match(/\((\d+)%\)/)?.[1])).toBeGreaterThan(Number(heldPercent))
  })

  it('uses whole-program distance after Run from line instead of resumed-slice time', async () => {
    const estimate = 31 * 60_000
    const { project, gcode, context } = estimatedProgram(estimate)
    const nearEndLine = gcode.split('\n').findIndex((line) => /\bX90(?:\.0+)?\b/.test(line)) + 1
    expect(nearEndLine).toBeGreaterThan(1)

    act(() => {
      useCamStore.setState({ project, toolLibrary: project.toolLibrary })
      useMachineControl.getState().setProgram('resumed-near-end.nc', gcode, [], context)
      useMachineControl.getState().setArmedFromLine(nearEndLine)
      useMachineControl.setState({ machineState: 'run' })
      setJob({
        phase: 'streaming',
        totalLines: 5,
        sentLines: 5,
        ackedLines: 4,
        ackedSourceLine: nearEndLine,
        startedAt: Date.now() - 40_000,
        pausedAt: null,
      })
    })
    render(<ProgramPanel />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })

    // Resumed time / the whole estimate would read 2%. The absolute program
    // distance says this run is near done, even though its move count is 4/5.
    expect(progressText()).toBe('4/5 (86%)')
  })

  it('falls back to acknowledged path distance without changing the move-count wording', async () => {
    const gcode = [
      'G21 G90',
      'G0 X0 Y0 Z0',
      'G1 X90 F600',
      'G1 X100',
      'M30',
      '',
    ].join('\n')
    act(() => {
      useMachineControl.getState().setProgram('distance.nc', gcode, [], null)
      setJob({
        phase: 'streaming',
        totalLines: 4,
        sentLines: 4,
        ackedLines: 1,
        ackedSourceLine: 3,
        startedAt: Date.now() - 30_000,
        pausedAt: null,
      })
    })
    render(<ProgramPanel />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })

    expect(progressText()).toBe('1/4 (90%)')
  })

  it('retains move-count progress when neither estimate nor path distance exists', async () => {
    act(() => {
      useMachineControl.getState().setProgram('actions.nc', 'M3 S1000\nM5\nM30\n', [], null)
      setJob({
        phase: 'streaming',
        totalLines: 4,
        sentLines: 4,
        ackedLines: 1,
        ackedSourceLine: 1,
        startedAt: Date.now() - 30_000,
        pausedAt: null,
      })
    })
    render(<ProgramPanel />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })

    expect(progressText()).toBe('1/4 (25%)')
  })
})
