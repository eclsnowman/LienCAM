// @vitest-environment jsdom

import { createElement } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MachineController, MachineProgram } from '../../lib/machine/controller'
import { buildProgramParts } from '../../lib/program/programParts'
import type { MachineConfig, Project, Setup, ToolpathMove } from '../../types'
import { makeMachine, makeOp, makeStock, makeWcs } from '../post/helpers'
import { typedMock } from '../support/typedMock'

// ControlPage owns the MDI gate under test. Its program preview owns a WebGL
// canvas that is unrelated to this behavior and unavailable in jsdom.
vi.mock('../../components/machine/ProgramPanel', () =>
  typedMock<typeof import('../../components/machine/ProgramPanel')>({
    ProgramPanel: () => createElement('div', { 'data-testid': 'program-panel-stub' }),
  }))

const {
  __resetEstopInterlockForTest,
  clearPathFidelity,
  connectMachine,
  disconnectMachine,
  getMachineController,
  loadGeometryProgram,
  loadMachineProgram,
  pathFidelityReport,
  sendMdiLine,
  setMachineSingleBlock,
  setPathToleranceMm,
  startMachineJob,
} = await import('../../lib/machine/machineSession')
const { useMachineControl } = await import('../../store/machineControlStore')
const { useCamStore } = await import('../../store')
const { ControlPage } = await import('../../components/machine/ControlPage')
const { ControlStepRow, ControlTransportBar } = await import('../../components/machine/ControlTransportBar')
const { JogPanel } = await import('../../components/machine/JogPanel')
const {
  currentOperatorTransport,
  executeOperatorCycleStart,
  executeOperatorFeedHold,
} = await import('../../lib/machine/operatorTransport')

const CAP = 4_095
const TRACE = { opId: 'op1', setupId: 'setup1' }
type ProgramController = MachineController & {
  loadProgram(program: MachineProgram): { ok: boolean; reason: string | null }
}

function programController(): ProgramController {
  const ctrl = getMachineController()
  if (typeof ctrl.loadProgram !== 'function') throw new Error('simulator has no machine-program route')
  return ctrl as ProgramController
}

function machineProgram(count: number, rapidEvery = 4_000): MachineProgram {
  const steps = Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    kind: 'line' as const,
    to: { x: 0, y: 0, z: 0 },
    feedMmMin: 1_000,
    ...((index + 1) % rapidEvery === 0 ? { rapid: true as const } : {}),
  }))
  return {
    frame: 'work',
    units: 'mm',
    steps,
    index: Object.fromEntries(steps.map((step) => [step.id, { opId: 'op1', setupId: 'setup1', moveOrdinal: step.id - 1 }])),
  }
}

function toolpath(count: number): ToolpathMove[] {
  return Array.from({ length: count }, (_, index) => ({
    type: (index + 1) % 4_000 === 0 ? 'rapid' as const : 'feed' as const,
    x: 10,
    y: 5,
    z: 2,
    ...((index + 1) % 4_000 === 0 ? {} : { feed: 60_000 }),
  }))
}

function machine(): MachineConfig {
  return makeMachine({
    id: 'wo1054-machine',
    name: 'WO-1054 test machine',
    travel: { x: 600, y: 400, z: 100 },
    homeConvention: {
      x: { homesToward: 'min', machineZeroAt: 'min' },
      y: { homesToward: 'min', machineZeroAt: 'min' },
      z: { homesToward: 'min', machineZeroAt: 'min' },
    },
    rapidRate: 60_000,
  })
}

function setup(): Setup {
  return {
    id: 'setup1',
    name: 'Setup 1',
    wcs: makeWcs({ id: 'w1', label: 'G54', fixtureOffset: 54, origin: { x: 10, y: 5, z: 2 } }),
    stock: makeStock({ material: 'aluminum' }),
    operations: [makeOp({ id: 'op1', name: 'Contour', type: 'contour_2d' })],
    notes: '',
  }
}

let originalProject: Project

beforeEach(async () => {
  vi.useFakeTimers()
  originalProject = useCamStore.getState().project
  useCamStore.setState((state) => ({
    project: { ...state.project, machine: machine(), setups: [setup()], activeSetupId: 'setup1' },
  }))
  const pending = connectMachine('simulator')
  await vi.advanceTimersByTimeAsync(300)
  await pending
  __resetEstopInterlockForTest()
  if (!getMachineController().home()) throw new Error('simulator refused homing')
  await vi.advanceTimersByTimeAsync(2_000)
})

afterEach(async () => {
  cleanup()
  if (getMachineController().connectionPhase() !== 'disconnected') {
    setMachineSingleBlock(false)
    const pending = disconnectMachine()
    await vi.advanceTimersByTimeAsync(300)
    await pending
  }
  useCamStore.setState({ project: originalProject })
  clearPathFidelity()
  setPathToleranceMm(null)
  useMachineControl.setState({ consoleLines: [] })
  vi.useRealTimers()
})

describe('WO-1054 pure program parts', () => {
  it.each([
    [1, 1],
    [4_095, 1],
    [4_096, 2],
    [6_284, 2],
    [50_000, 13],
  ])('covers %i moves exactly once in %i part(s)', (count, expectedParts) => {
    const original = machineProgram(count)
    const result = buildProgramParts(original, CAP)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.parts).toHaveLength(expectedParts)
    expect(result.parts.every((part) => part.steps.length <= CAP)).toBe(true)
    expect(result.parts.flatMap((part) => part.steps.map((step) => step.id)))
      .toEqual(original.steps.map((step) => step.id))
    for (const part of result.parts.slice(0, -1)) {
      expect(part.steps.at(-1)).toMatchObject({ kind: 'line', rapid: true })
    }
  })

  it('keeps a continuous over-cap cut whole for the streaming backend', () => {
    const result = buildProgramParts(machineProgram(4_096, 10_000), CAP)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.parts).toHaveLength(1)
    expect(result.parts[0].steps).toHaveLength(4_096)
    expect(result.capacity.splitRefusal)
      .toContain('one continuous cutting stretch of 4,096 moves has no rapid to split at')
  })
})

describe('WO-1054 session executes one operator program as controller-sized parts', () => {
  it.each([
    [6_284, 2],
    [50_000, 13],
  ])('executes all %i moves once and in order across %i parts', async (count, expectedParts) => {
    const ctrl = programController()
    const loadedIds: number[][] = []
    const originalLoad = ctrl.loadProgram.bind(ctrl)
    const load = vi.spyOn(ctrl, 'loadProgram').mockImplementation((program) => {
      loadedIds.push(program.steps.map((step) => step.id))
      return originalLoad(program)
    })
    const acked: number[] = []
    const unsubscribe = useMachineControl.subscribe((state) => acked.push(state.job.ackedLines))

    expect(loadGeometryProgram(`wo1054-${count}`, toolpath(count), TRACE)).toEqual({ ok: true, reason: null })
    expect(useMachineControl.getState().programReadiness.reason)
      .toBe(`program has ${count} moves - running in ${expectedParts} parts`)
    const consoleText = useMachineControl.getState().consoleLines.map((line) => line.text)
    expect(consoleText).toContain(
      `Toolpath program "wo1054-${count}" loaded: ${count} moves, runs in G54.`,
    )
    expect(consoleText).toContain(`program has ${count} moves - running in ${expectedParts} parts`)
    expect(startMachineJob()).toBe(true)
    await vi.advanceTimersByTimeAsync(count * 60 + 5_000)

    unsubscribe()
    load.mockRestore()
    expect(loadedIds).toHaveLength(expectedParts)
    expect(loadedIds.flat()).toEqual(Array.from({ length: count }, (_, index) => index + 1))
    expect(useMachineControl.getState().job).toMatchObject({
      phase: 'complete',
      totalLines: count,
      ackedLines: count,
    })
    expect(acked.every((value, index) => index === 0 || value >= acked[index - 1])).toBe(true)
  // The 50,000-move row deliberately exercises all 13 controller-sized parts.
  }, 60_000)

  it('a Stop/Reset from a confirmed-idle part boundary ends the job without loading the next part', async () => {
    const ctrl = programController()
    const load = vi.spyOn(ctrl, 'loadProgram')
    const realMachineState = ctrl.machineState.bind(ctrl)
    let stoppedAtConfirmedIdle = false
    const machineState = vi.spyOn(ctrl, 'machineState').mockImplementation(() => {
      const state = realMachineState()
      if (
        !stoppedAtConfirmedIdle
        && state === 'idle'
        && ctrl.jobProgress().phase === 'complete'
        && load.mock.calls.length === 1
      ) {
        // The simulator is already idle, so reset emits no status transition.
        // The reset-in-progress subscription is the only synchronous stop edge.
        stoppedAtConfirmedIdle = true
        ctrl.reset()
      }
      return state
    })
    expect(loadGeometryProgram('wo1054-stop', toolpath(6_284), TRACE).ok).toBe(true)
    expect(startMachineJob()).toBe(true)
    await vi.advanceTimersByTimeAsync(4_000 * 60 + 5_000)

    expect(stoppedAtConfirmedIdle).toBe(true)
    expect(load).toHaveBeenCalledTimes(1)
    expect(useMachineControl.getState().programReadiness.reason).toContain('Stop/Reset')
    expect(useMachineControl.getState().job).toMatchObject({
      phase: 'failed',
      totalLines: 6_284,
      ackedLines: 4_000,
    })
    expect(useMachineControl.getState().cycleEvents.at(-1)?.event).toBe('stopped')
    expect(pathFidelityReport()).not.toBeNull()
    machineState.mockRestore()
    load.mockRestore()
  })

  it('Feed Hold at a confirmed-idle part boundary defers the next part until Cycle Resume', async () => {
    const ctrl = programController()
    const load = vi.spyOn(ctrl, 'loadProgram')
    const realMachineState = ctrl.machineState.bind(ctrl)
    let heldAtConfirmedIdle = false
    const machineState = vi.spyOn(ctrl, 'machineState').mockImplementation(() => {
      const state = realMachineState()
      if (
        !heldAtConfirmedIdle
        && state === 'idle'
        && ctrl.jobProgress().phase === 'complete'
        && load.mock.calls.length === 1
      ) {
        heldAtConfirmedIdle = true
        expect(executeOperatorFeedHold()).toBe(true)
      }
      return state
    })

    expect(loadGeometryProgram('wo1054-hold', toolpath(6_284), TRACE).ok).toBe(true)
    expect(startMachineJob()).toBe(true)
    await vi.advanceTimersByTimeAsync(4_000 * 60 + 5_000)

    expect(heldAtConfirmedIdle).toBe(true)
    expect(load).toHaveBeenCalledTimes(1)
    expect(useMachineControl.getState().job).toMatchObject({
      phase: 'paused',
      totalLines: 6_284,
      ackedLines: 4_000,
    })
    expect(currentOperatorTransport()).toMatchObject({ action: 'resume', cycleStartEnabled: true })
    expect(currentOperatorTransport().nextAction)
      .toBe('Program held at part 1 of 2 - Cycle Start continues')
    render(createElement(ControlTransportBar))
    expect(screen.getByTestId('control-next-action').textContent)
      .toContain('Program held at part 1 of 2 - Cycle Start continues')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(load).toHaveBeenCalledTimes(1)
    expect(useMachineControl.getState().job.phase).toBe('paused')

    expect(await executeOperatorCycleStart()).toBe(true)
    expect(load).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(2_284 * 60 + 5_000)
    expect(useMachineControl.getState().job).toMatchObject({
      phase: 'complete',
      totalLines: 6_284,
      ackedLines: 6_284,
    })

    machineState.mockRestore()
    load.mockRestore()
  })

  it.each([
    ['CYCLE START', 'control-cyclestart', 'transport'],
    ['Step Forward', 'control-step-forward', 'step'],
  ] as const)(
    '%s at a held part boundary loads part 2 and executes only its first line in Single Block',
    async (_gesture, buttonTestId, surface) => {
      const ctrl = programController()
      const load = vi.spyOn(ctrl, 'loadProgram')
      const realMachineState = ctrl.machineState.bind(ctrl)
      let heldAtConfirmedIdle = false
      const machineState = vi.spyOn(ctrl, 'machineState').mockImplementation(() => {
        const state = realMachineState()
        if (
          !heldAtConfirmedIdle
          && state === 'idle'
          && ctrl.jobProgress().phase === 'complete'
          && load.mock.calls.length === 1
        ) {
          heldAtConfirmedIdle = true
          expect(executeOperatorFeedHold()).toBe(true)
        }
        return state
      })

      expect(loadGeometryProgram('wo1054-held-step', toolpath(6_284), TRACE).ok).toBe(true)
      expect(startMachineJob()).toBe(true)
      await vi.advanceTimersByTimeAsync(4_000 * 60 + 5_000)
      expect(heldAtConfirmedIdle).toBe(true)
      expect(load).toHaveBeenCalledTimes(1)
      expect(useMachineControl.getState().job).toMatchObject({
        phase: 'paused',
        totalLines: 6_284,
        ackedLines: 4_000,
      })

      setMachineSingleBlock(true)
      expect(currentOperatorTransport()).toMatchObject({
        action: 'single-block',
        cycleStartEnabled: true,
        nextAction: 'Program held at part 1 of 2 - Cycle Start continues',
      })
      if (surface === 'transport') render(createElement(ControlTransportBar))
      else render(createElement(ControlStepRow))
      const button = screen.getByTestId(buttonTestId) as HTMLButtonElement
      expect(button.disabled).toBe(false)

      fireEvent.click(button)
      expect(load).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(load).toHaveBeenCalledTimes(2)
      expect(getMachineController().singleBlockMode()).toBe(true)
      expect(useMachineControl.getState().job).toMatchObject({
        totalLines: 6_284,
        ackedLines: 4_001,
      })

      machineState.mockRestore()
      load.mockRestore()
    },
  )

  it('jog and MDI stay refused while the controller is idle between held parts', async () => {
    const ctrl = programController()
    const load = vi.spyOn(ctrl, 'loadProgram')
    const jog = vi.spyOn(ctrl, 'jog')
    const realMachineState = ctrl.machineState.bind(ctrl)
    let heldAtConfirmedIdle = false
    const machineState = vi.spyOn(ctrl, 'machineState').mockImplementation(() => {
      const state = realMachineState()
      if (
        !heldAtConfirmedIdle
        && state === 'idle'
        && ctrl.jobProgress().phase === 'complete'
        && load.mock.calls.length === 1
      ) {
        heldAtConfirmedIdle = true
        expect(executeOperatorFeedHold()).toBe(true)
      }
      return state
    })

    expect(loadGeometryProgram('wo1054-manual-doors', toolpath(6_284), TRACE).ok).toBe(true)
    expect(startMachineJob()).toBe(true)
    await vi.advanceTimersByTimeAsync(4_000 * 60 + 5_000)
    expect(heldAtConfirmedIdle).toBe(true)
    expect(ctrl.hasActiveJob()).toBe(false)
    expect(ctrl.machineState()).toBe('idle')
    expect(useMachineControl.getState().job.phase).toBe('paused')
    expect(currentOperatorTransport().nextAction)
      .toBe('Program held at part 1 of 2 - Cycle Start continues')
    expect(currentOperatorTransport().nextAction).not.toContain('Machine idle')

    render(createElement(JogPanel))
    const jogButton = screen.getByTestId('control-jog-x-plus') as HTMLButtonElement
    expect(jogButton.disabled).toBe(true)
    expect(jogButton.getAttribute('data-tooltip')).toBe('A program is running - jogging is locked out.')
    fireEvent.pointerDown(jogButton)
    expect(jog).not.toHaveBeenCalled()

    render(createElement(ControlPage))
    const mdiInput = screen.getByTestId('control-mdi-input') as HTMLInputElement
    expect(mdiInput.disabled).toBe(true)
    expect(mdiInput.placeholder).toBe('A program is running - MDI is locked out.')
    expect(sendMdiLine('G0 X1')).toBe(false)
    expect(useMachineControl.getState().consoleLines.at(-1)?.text)
      .toBe('A program is running - MDI is locked out.')

    machineState.mockRestore()
    jog.mockRestore()
    load.mockRestore()
  })

  it('an E-STOP during a between-parts hold ends the program and cannot resume it', async () => {
    const ctrl = programController()
    const load = vi.spyOn(ctrl, 'loadProgram')
    const realMachineState = ctrl.machineState.bind(ctrl)
    let heldAtConfirmedIdle = false
    const machineState = vi.spyOn(ctrl, 'machineState').mockImplementation(() => {
      const state = realMachineState()
      if (
        !heldAtConfirmedIdle
        && state === 'idle'
        && ctrl.jobProgress().phase === 'complete'
        && load.mock.calls.length === 1
      ) {
        heldAtConfirmedIdle = true
        expect(executeOperatorFeedHold()).toBe(true)
      }
      return state
    })

    expect(loadGeometryProgram('wo1054-held-estop', toolpath(6_284), TRACE).ok).toBe(true)
    expect(startMachineJob()).toBe(true)
    await vi.advanceTimersByTimeAsync(4_000 * 60 + 5_000)
    expect(useMachineControl.getState().job.phase).toBe('paused')
    expect(load).toHaveBeenCalledTimes(1)

    ctrl.emergencyStop()
    await vi.advanceTimersByTimeAsync(5_000)

    expect(useMachineControl.getState().job).toMatchObject({
      phase: 'failed',
      totalLines: 6_284,
      ackedLines: 4_000,
    })
    expect(useMachineControl.getState().programReadiness.reason).toContain('entered an alarm')
    expect(useMachineControl.getState().consoleLines.map((line) => line.text).join('\n'))
      .toContain('entered an alarm')
    expect(await executeOperatorCycleStart()).toBe(false)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(load).toHaveBeenCalledTimes(1)

    machineState.mockRestore()
    load.mockRestore()
  })

  it('an alarm in the unheld gap ends the program before the next part loads', async () => {
    const ctrl = programController()
    const load = vi.spyOn(ctrl, 'loadProgram')
    const realMachineState = ctrl.machineState.bind(ctrl)
    let alarmedAtConfirmedIdle = false
    let transportAtBoundary = ''
    const machineState = vi.spyOn(ctrl, 'machineState').mockImplementation(() => {
      const state = realMachineState()
      if (
        !alarmedAtConfirmedIdle
        && state === 'idle'
        && ctrl.jobProgress().phase === 'complete'
        && load.mock.calls.length === 1
      ) {
        alarmedAtConfirmedIdle = true
        transportAtBoundary = currentOperatorTransport().nextAction
        ctrl.emergencyStop()
      }
      return state
    })

    expect(loadGeometryProgram('wo1054-gap-alarm', toolpath(6_284), TRACE).ok).toBe(true)
    expect(startMachineJob()).toBe(true)
    await vi.advanceTimersByTimeAsync(4_000 * 60 + 5_000)

    expect(alarmedAtConfirmedIdle).toBe(true)
    expect(transportAtBoundary).toBe('Program is running - waiting for part 2 of 2')
    expect(transportAtBoundary).not.toContain('Machine idle')
    expect(load).toHaveBeenCalledTimes(1)
    expect(useMachineControl.getState().job.phase).toBe('failed')
    expect(useMachineControl.getState().programReadiness.reason).toContain('entered an alarm')

    machineState.mockRestore()
    load.mockRestore()
  })

  it('Single Block armed in the unheld gap loads part 2 and executes only its first line', async () => {
    const ctrl = programController()
    const load = vi.spyOn(ctrl, 'loadProgram')
    const realMachineState = ctrl.machineState.bind(ctrl)
    let armedAtConfirmedIdle = false
    let transportAtBoundary = ''
    const machineState = vi.spyOn(ctrl, 'machineState').mockImplementation(() => {
      const state = realMachineState()
      if (
        !armedAtConfirmedIdle
        && state === 'idle'
        && ctrl.jobProgress().phase === 'complete'
        && load.mock.calls.length === 1
      ) {
        armedAtConfirmedIdle = true
        transportAtBoundary = currentOperatorTransport().nextAction
        setMachineSingleBlock(true)
      }
      return state
    })

    expect(loadGeometryProgram('wo1054-gap-single-block', toolpath(6_284), TRACE).ok).toBe(true)
    expect(startMachineJob()).toBe(true)
    await vi.advanceTimersByTimeAsync(4_000 * 60 + 5_000)

    expect(armedAtConfirmedIdle).toBe(true)
    expect(transportAtBoundary).toBe('Program is running - waiting for part 2 of 2')
    expect(load).toHaveBeenCalledTimes(2)
    expect(ctrl.singleBlockMode()).toBe(true)
    expect(useMachineControl.getState().job).toMatchObject({
      phase: 'paused',
      totalLines: 6_284,
      ackedLines: 4_001,
    })

    machineState.mockRestore()
    load.mockRestore()
  })

  it('a fault inside a part ends the whole program and loads nothing later', async () => {
    const ctrl = programController()
    const load = vi.spyOn(ctrl, 'loadProgram')
    expect(loadGeometryProgram('wo1054-fault', toolpath(6_284), TRACE).ok).toBe(true)
    expect(startMachineJob()).toBe(true)
    await vi.advanceTimersByTimeAsync(1_000)

    ctrl.emergencyStop()
    await vi.advanceTimersByTimeAsync(80_000)

    expect(load).toHaveBeenCalledTimes(1)
    expect(useMachineControl.getState().programReadiness.reason).toContain('controller fault')
    expect(useMachineControl.getState().job).toMatchObject({
      phase: 'failed',
      totalLines: 6_284,
    })
    load.mockRestore()
  })

  it('a refusal at the next-part load ends the program without starting that part', async () => {
    const ctrl = programController()
    const originalLoad = ctrl.loadProgram.bind(ctrl)
    const load = vi.spyOn(ctrl, 'loadProgram')
      .mockImplementationOnce((program) => originalLoad(program))
      .mockReturnValueOnce({ ok: false, reason: 'deliberate next-part refusal' })
    const start = vi.spyOn(ctrl, 'startJob')

    expect(loadGeometryProgram('wo1054-refusal', toolpath(6_284), TRACE).ok).toBe(true)
    expect(startMachineJob()).toBe(true)
    await vi.advanceTimersByTimeAsync(4_000 * 60 + 5_000)

    expect(load).toHaveBeenCalledTimes(2)
    expect(start).toHaveBeenCalledTimes(1)
    expect(useMachineControl.getState().programReadiness.reason).toContain('deliberate next-part refusal')
    start.mockRestore()
    load.mockRestore()
  })

  it('a successful text load replaces an armed multipart program instead of resuming it later', async () => {
    const ctrl = programController()
    const load = vi.spyOn(ctrl, 'loadProgram')
    expect(loadGeometryProgram('wo1054-replaced', toolpath(6_284), TRACE).ok).toBe(true)

    const text = 'G21\nG90\nG0 X0 Y0\nG1 X1 Y0 F60000\nM30\n'
    expect(loadMachineProgram('replacement.nc', text).lines.length).toBeGreaterThan(0)
    expect(startMachineJob()).toBe(true)
    await vi.advanceTimersByTimeAsync(5_000)

    expect(load).toHaveBeenCalledTimes(1)
    expect(useMachineControl.getState().job.totalLines).toBeLessThan(10)
    load.mockRestore()
  })
})
