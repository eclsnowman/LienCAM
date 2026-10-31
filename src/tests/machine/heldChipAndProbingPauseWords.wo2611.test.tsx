// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { MachineStatusChip } from '../../components/toolbar/MachineStatusChip'
import { deriveMachineChip, type MachineChipFacts } from '../../lib/machine/machineChip'
import * as session from '../../lib/machine/machineSession'
import { currentOperatorTransport, deriveOperatorTransport } from '../../lib/machine/operatorTransport'
import { useMachineControl } from '../../store/machineControlStore'
import { useCamStore } from '../../store'

const facts: MachineChipFacts = {
  connectionPhase: 'connected', machineState: 'idle', jobPhase: 'paused',
  datumResolver: null,
}
const card = {
  mode: 'toolChange', step: 'awaiting-swap', tool: 1, resumeLine: 3,
  message: 'Fit T1', warnings: [],
} as const

beforeEach(() => vi.useFakeTimers())

/** WO-3190 (CT-2): connecting arms the software stop and the header chip reads
 * that latch as E-STOP. A held or paused job cannot exist under it, so clear it
 * the operator's way - CLEAR (pressEstop) on the connected simulator - before
 * the route under test sets its own store facts. */
async function connectAndClear(): Promise<void> {
  const connecting = session.connectMachine('simulator')
  await vi.advanceTimersByTimeAsync(1000)
  await connecting
  const cleared = session.pressEstop()
  await vi.advanceTimersByTimeAsync(1500)
  expect(await cleared).toMatchObject({ ok: true })
  expect(session.estopNeedsReset()).toBe(false)
}
afterEach(async () => {
  cleanup()
  session.stopProbing()
  await vi.advanceTimersByTimeAsync(2000)
  const pending = session.disconnectMachine()
  await vi.advanceTimersByTimeAsync(100)
  await pending
  useMachineControl.setState({ toolChange: null })
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('WO-2611 Held routes', () => {
  it.each(['empty', 'ready', 'streaming', 'paused', 'complete', 'failed'] as const)(
    'Feed Hold reads Held with job %s', jobPhase => {
      expect(deriveMachineChip({ ...facts, jobPhase, machineState: 'hold' }))
        .toEqual({ state: 'held', label: 'Held' })
    },
  )
  it.each(['disconnected', 'connecting'] as const)('connection %s wins over both holds', connectionPhase => {
    expect(deriveMachineChip({ ...facts, connectionPhase, machineState: 'hold', toolChangeWaiting: true }).state).toBe('offline')
  })
  it('Alarm wins over a waiting card', () => {
    expect(deriveMachineChip({ ...facts, machineState: 'alarm', toolChangeWaiting: true }).state).toBe('alarm')
  })
  it.each(['run', 'jog', 'home'] as const)('motion %s stays Running with a card open', machineState => {
    expect(deriveMachineChip({ ...facts, machineState, toolChangeWaiting: true }).state).toBe('running')
  })
  it.each(['awaiting-swap', 'ready'] as const)('subscribes to the %s card, then repaints after Continue', async step => {
    await connectAndClear()
    const job = useMachineControl.getState().job
    useMachineControl.setState({ connectionPhase: 'connected', machineState: 'idle', toolChange: null,
      job: { ...job, phase: 'paused' } })
    render(<MachineStatusChip />)
    const chip = screen.getByTestId('machine-status-chip')
    expect(chip.textContent).toBe('Running')
    act(() => useMachineControl.setState({ toolChange: { ...card, step, warnings: [] } }))
    expect(chip.textContent).toBe('Held')
    expect(chip.getAttribute('data-state')).toBe('held')
    expect(chip.getAttribute('aria-label')).toBe('Machine status: Held')
    act(() => useMachineControl.setState({ toolChange: null, machineState: 'run', job: { ...job, phase: 'streaming' } }))
    expect(chip.textContent).toBe('Running')
  })
  it.each(['stopping', 'parking', 'probing', 'arming', 'failed'] as const)('card phase %s keeps its previous chip', async step => {
    await connectAndClear()
    useMachineControl.setState({ connectionPhase: 'connected', machineState: 'idle',
      job: { ...useMachineControl.getState().job, phase: 'paused' }, toolChange: { ...card, step, warnings: [] } })
    render(<MachineStatusChip />)
    expect(screen.getByTestId('machine-status-chip').textContent).toBe('Running')
  })
  it('clamp cards and generic paused jobs keep their previous chip', async () => {
    await connectAndClear()
    useMachineControl.setState({ connectionPhase: 'connected', machineState: 'idle',
      job: { ...useMachineControl.getState().job, phase: 'paused' },
      toolChange: { ...card, mode: 'clampPause', warnings: [] } })
    render(<MachineStatusChip />)
    expect(screen.getByTestId('machine-status-chip').textContent).toBe('Running')
  })
})

describe('WO-2611 probing Pause words', () => {
  it.each(['Edge probe', 'Measure tool'])('%s Feed Hold keeps CYCLE START / Stop/Reset', routine => {
    const state = deriveOperatorTransport({ ...useMachineControl.getState(), connectionPhase: 'connected',
      machineState: 'hold', programHold: { owner: 'probe-cycle', routine } })
    expect(state.nextAction).toBe(`${routine} is held - CYCLE START resumes it; Stop/Reset ends it.`)
    expect(state.action).toBe('resume')
    expect(state.cycleStartEnabled).toBe(true)
  })
  it('uses the real routine Pause flag, then restores the Feed Hold sentence after Resume', async () => {
    useCamStore.getState().newProject()
    const machine = useCamStore.getState().project.machine
    useCamStore.getState().setProjectMachine({ ...machine, id: 'wo2611-simulator', controller: 'grbl',
      controllerDefinition: undefined, unsentSettings: undefined, travel: { x: 100, y: 100, z: 100 },
      homeConvention: { x: { homesToward: 'min', machineZeroAt: 'min' },
        y: { homesToward: 'min', machineZeroAt: 'min' }, z: { homesToward: 'max', machineZeroAt: 'max' } } })
    const connecting = session.connectMachine('simulator')
    await vi.advanceTimersByTimeAsync(1000)
    await connecting
    session.__resetEstopInterlockForTest()
    const ctrl = session.getMachineController()
    ctrl.home()
    await vi.advanceTimersByTimeAsync(3000)
    ctrl.jogToMachineZ(-5, 6000)
    await vi.advanceTimersByTimeAsync(1000)
    const pending = session.runDirectionalProbeTouch('Z', '-', {
      fastFeed: 60, slowFeed: 30, retract: 2, maxTravel: 50, padThickness: 0,
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(session.isProbeCycleActive()).toBe(true)
    expect(ctrl.machineState()).toBe('run')
    session.pauseProbing()
    await vi.advanceTimersByTimeAsync(1000)
    expect(session.isProbeCyclePaused()).toBe(true)
    const paused = currentOperatorTransport()
    expect(paused.nextAction).toMatch(/is paused - Resume on the probing screen resumes it; Stop ends it\.$/)
    expect(paused.nextAction).not.toMatch(/CYCLE START|Stop\/Reset/)
    expect(paused.action).toBe('resume')
    expect(paused.cycleStartEnabled).toBe(true)
    session.resumeProbing()
    expect(session.isProbeCyclePaused()).toBe(false)
    await vi.advanceTimersByTimeAsync(500)
    expect(ctrl.machineState()).toBe('run')
    ctrl.feedHold()
    await vi.advanceTimersByTimeAsync(100)
    expect(currentOperatorTransport().nextAction).toMatch(/is held - CYCLE START resumes it; Stop\/Reset ends it\.$/)
    session.stopProbing()
    await vi.advanceTimersByTimeAsync(2000)
    expect(await pending).toMatchObject({ ok: false, stopped: true })
  })
})
