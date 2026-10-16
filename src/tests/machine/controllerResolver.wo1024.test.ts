// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'

vi.mock('../../components/machine/ProgramPreview', () =>
  typedMock<typeof import('../../components/machine/ProgramPreview')>({
    ProgramPreview: () => createElement('div', { 'data-testid': 'program-preview-stub' }),
  }))

import { MachineActionsModal } from '../../components/machine/MachineActionsModal'
import { ProgramPanel } from '../../components/machine/ProgramPanel'
import { SpindlePanel } from '../../components/machine/SpindlePanel'
import { PostProcessModal } from '../../components/modals/PostProcessModal'
import { CONTROLLER_NEUTRAL_STOP_LINES } from '../../lib/machine/machineActions'
import {
  resolveDeclaredController,
  UNDECLARED_CONTROLLER_REASON,
} from '../../lib/machine/machineChoice'
import { executePendantMachineCommand } from '../../lib/machine/pendantMachine'
import { buildProgramContext } from '../../lib/machine/programContext'
import * as machineSession from '../../lib/machine/machineSession'
import type { MachineController } from '../../lib/machine/controller'
import { GRBL_CONFIG } from '../../lib/post'
import { useCamStore } from '../../store'
import { useMachineActions } from '../../store/machineActionsStore'
import { useMachineControl } from '../../store/machineControlStore'
import { useUiPrefs } from '../../store/uiPrefs'
import type { ControllerType, MachineConfig } from '../../types'

const CONTROLLERS: ControllerType[] = ['uccnc', 'grbl', 'linuxcnc', 'generic']

function machineWithController(controller: unknown): MachineConfig {
  const base = useCamStore.getState().project.machine
  if (!base) throw new Error('test project did not seed a machine')
  return { ...base, controller: controller as ControllerType }
}

function setRuntimeController(controller: unknown): void {
  const state = useCamStore.getState()
  useCamStore.setState({
    project: {
      ...state.project,
      machine: machineWithController(controller),
    },
  })
}

function seedOneSetup(): void {
  const wcs = {
    id: 'wcs-wo1024',
    label: 'G54',
    fixtureOffset: 54,
    origin: { x: 0, y: 0, z: 0 },
    xAxis: { x: 1, y: 0, z: 0 },
    yAxis: { x: 0, y: 1, z: 0 },
    zAxis: { x: 0, y: 0, z: 1 },
  }
  const setup = {
    id: 'setup-wo1024',
    name: 'Controller resolver setup',
    wcs,
    stock: {
      type: 'rectangular',
      width: 10,
      height: 10,
      depth: 10,
      offsetX: 0,
      offsetY: 0,
      offsetZTop: 0,
      offsetZBottom: 0,
      material: 'aluminum',
    },
    operations: [],
    notes: '',
  }
  const state = useCamStore.getState()
  useCamStore.setState({
    project: { ...state.project, setups: [setup] },
  } as never)
}

beforeEach(() => {
  useCamStore.getState().newProject()
  setRuntimeController('')
  useMachineActions.setState({ byMachine: {}, macroArrangementByMachine: {} })
  useUiPrefs.setState({ collapsedPropsGroups: {} })
  useMachineControl.setState({
    connectionPhase: 'connected',
    consoleLines: [],
    programText: null,
    programContext: null,
    programContextVerdict: null,
    job: { ...useMachineControl.getState().job, phase: 'empty', name: null },
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  useCamStore.getState().closeModal()
})

describe('WO-1024 controller identity resolution', () => {
  it.each(CONTROLLERS)('resolves declared %s to the matching dialect', (controller) => {
    const result = resolveDeclaredController(machineWithController(controller))
    expect(result).toEqual(expect.objectContaining({ ok: true, controller }))
    expect(result.ok && result.dialect.id).toBe(controller)
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['empty', machineWithController('')],
    ['legacy', machineWithController('mach4')],
  ])('refuses %s without choosing a dialect', (_label, machine) => {
    expect(resolveDeclaredController(machine as MachineConfig | null | undefined)).toEqual({
      ok: false,
      reason: UNDECLARED_CONTROLLER_REASON,
    })
  })
})

describe('WO-1024 machine action boundaries', () => {
  it('refuses a spindle start once but gives text-route Off a real M5 before latching', () => {
    const commandSpindle = vi
      .spyOn(machineSession, 'commandSpindle')
      .mockImplementation((direction, _rpm, textLines) => {
        if (direction !== 'off') throw new Error('undeclared spindle start reached dispatch')
        return textLines().length > 0
          ? { ok: true, route: 'text' }
          : { ok: false, route: 'text', reason: machineSession.SPINDLE_REFUSAL.notSent }
      })
    vi.spyOn(machineSession, 'spindleRoute').mockReturnValue('text')
    vi.spyOn(machineSession, 'getMachineController').mockReturnValue({
      capabilities: { ownsSpindle: false },
      status: () => ({ spindle: null }),
    } as never)

    render(createElement(SpindlePanel, { onOpenActions: () => {} }))
    fireEvent.click(screen.getByTestId('control-spindle-cw'))

    expect(commandSpindle).not.toHaveBeenCalled()
    expect(useMachineControl.getState().consoleLines.map((line) => line.text)).toEqual([
      UNDECLARED_CONTROLLER_REASON,
    ])

    fireEvent.click(screen.getByTestId('control-spindle-off'))
    expect(commandSpindle).toHaveBeenCalledTimes(1)
    expect(commandSpindle.mock.calls[0][0]).toBe('off')
    expect(commandSpindle.mock.calls[0][2]()).toEqual(
      CONTROLLER_NEUTRAL_STOP_LINES.spindleOff,
    )
    expect(screen.getByTestId('control-spindle-off').className).toContain('control-latched')
  })

  it('real commandSpindle routes Off to the controller spindleOff stub', () => {
    const spindleOff = vi.fn()
    const controller = {
      capabilities: { spindleCommands: true },
      spindleOn: vi.fn(),
      spindleOff,
    } as unknown as MachineController

    const result = machineSession.commandSpindle(
      'off',
      0,
      () => CONTROLLER_NEUTRAL_STOP_LINES.spindleOff,
      controller,
    )

    expect(result).toEqual({ ok: true, route: 'calls' })
    expect(spindleOff).toHaveBeenCalledTimes(1)
  })

  it('refuses the pendant default without sending text and records the reason', async () => {
    const runMachineAction = vi.spyOn(machineSession, 'runMachineAction')

    const outcome = await executePendantMachineCommand(
      { kind: 'spindle', direction: 'cw' },
      { clientId: 'phone-wo1024', emit: vi.fn() },
    )

    expect(runMachineAction).not.toHaveBeenCalled()
    expect(outcome).toEqual({ ok: false, error: UNDECLARED_CONTROLLER_REASON })
    expect(useMachineControl.getState().consoleLines.at(-1)?.text).toBe(
      UNDECLARED_CONTROLLER_REASON,
    )
  })

  it('sends the controller-neutral M5 for pendant Off without a declaration', async () => {
    const runMachineAction = vi
      .spyOn(machineSession, 'runMachineAction')
      .mockReturnValue({ ok: true, sent: 1 })

    const outcome = await executePendantMachineCommand(
      { kind: 'spindle', direction: 'off' },
      { clientId: 'phone-wo1024', emit: vi.fn() },
    )

    expect(outcome).toEqual({ ok: true })
    expect(runMachineAction).toHaveBeenCalledWith(
      CONTROLLER_NEUTRAL_STOP_LINES.spindleOff,
      { action: 'spindleOff' },
    )
  })

  it('carries a customised spindle-stop identity through the pendant', async () => {
    const machineId = useCamStore.getState().project.machine?.id ?? 'default'
    useMachineActions.setState({
      byMachine: {
        [machineId]: { overrides: { spindleOff: ['S0 M5'] }, custom: [], parks: [] },
      },
    })
    const runMachineAction = vi
      .spyOn(machineSession, 'runMachineAction')
      .mockReturnValue({ ok: true, sent: 1 })

    const outcome = await executePendantMachineCommand(
      { kind: 'spindle', direction: 'off' },
      { clientId: 'phone-wo477', emit: vi.fn() },
    )

    expect(outcome).toEqual({ ok: true })
    expect(runMachineAction).toHaveBeenCalledWith(
      ['S0 M5'],
      { action: 'spindleOff' },
    )
  })

  it('keeps an operator-typed pendant override usable without a default controller', async () => {
    const machineId = useCamStore.getState().project.machine?.id ?? 'default'
    useMachineActions.setState({
      byMachine: {
        [machineId]: { overrides: { spindleCw: ['M42'] }, custom: [], parks: [] },
      },
    })
    const runMachineAction = vi
      .spyOn(machineSession, 'runMachineAction')
      .mockReturnValue({ ok: true, sent: 1 })

    const outcome = await executePendantMachineCommand(
      { kind: 'spindle', direction: 'cw' },
      { clientId: 'phone-wo1024', emit: vi.fn() },
    )

    expect(outcome).toEqual({ ok: true })
    expect(runMachineAction).toHaveBeenCalledWith(
      ['M42'],
      { action: 'spindleCw' },
    )
  })

  it('carries a customised coolant-off identity and clears a typed latch', () => {
    const machineId = useCamStore.getState().project.machine?.id ?? 'default'
    useMachineActions.setState({
      byMachine: {
        [machineId]: {
          overrides: { coolantMist: ['M42'], coolantOff: ['M5 M9'] },
          custom: [],
          parks: [],
        },
      },
    })
    const runMachineAction = vi
      .spyOn(machineSession, 'runMachineAction')
      .mockReturnValue({ ok: true, sent: 1 })
    vi.spyOn(machineSession, 'getMachineController').mockReturnValue({
      capabilities: { ownsSpindle: false },
      status: () => ({ spindle: null }),
    } as never)

    render(createElement(SpindlePanel, { onOpenActions: () => {} }))
    const mist = screen.getByTestId('control-coolant-mist')
    fireEvent.click(mist)
    expect(runMachineAction).toHaveBeenLastCalledWith(
      ['M42'],
      { action: 'coolantMist' },
    )
    expect(mist.className).toContain('control-latched')

    runMachineAction.mockClear()
    fireEvent.click(mist)

    expect(runMachineAction).toHaveBeenCalledWith(
      ['M5 M9'],
      { action: 'coolantOff' },
    )
    expect(mist.className).not.toContain('control-latched')
  })

  it('leaves built-in action rows editable but empty and reports why', () => {
    render(createElement(MachineActionsModal, { open: true, onClose: () => {} }))
    expect((screen.getByTestId('control-action-spindleCw') as HTMLTextAreaElement).value).toBe('')
    expect(useMachineControl.getState().consoleLines.at(-1)?.text).toBe(
      UNDECLARED_CONTROLLER_REASON,
    )
  })
})

describe('WO-1024 post boundaries', () => {
  it('refuses Post Process through the existing diagnostics surface', () => {
    seedOneSetup()
    render(createElement(PostProcessModal))
    act(() => useCamStore.getState().openModal('post-process'))

    expect(screen.getByText(UNDECLARED_CONTROLLER_REASON)).toBeTruthy()
    // WO-2880: the code is row metadata, never on-screen text.
    expect(document.querySelector('[data-code="CONTROLLER_UNDECLARED"]')).toBeTruthy()
    expect(screen.queryByText(/CONTROLLER_UNDECLARED/)).toBeNull()
  })

  it('refuses ProgramPanel post-to-control with the resolver reason', async () => {
    seedOneSetup()
    render(createElement(ProgramPanel))

    fireEvent.click(screen.getByTestId('control-load-menu'))
    fireEvent.click(screen.getByTestId('control-load-setup-item-setup-wo1024'))

    // WO-1653: loading a setup now stages a recompute (stageOperationsForEmission)
    // before this resolver check runs, so the refusal is no longer synchronous
    // with the click.
    await waitFor(() => expect(screen.getByTestId('control-load-error').textContent).toBe(
      UNDECLARED_CONTROLLER_REASON,
    ))
    expect(useMachineControl.getState().consoleLines.at(-1)?.text).toBe(
      UNDECLARED_CONTROLLER_REASON,
    )
  })

  it('marks an imported context as comparison-failed, not project-changed', () => {
    seedOneSetup()
    const project = useCamStore.getState().project
    const context = buildProgramContext(project, project.setups[0], GRBL_CONFIG, '', [])
    useMachineControl.setState({
      programText: '',
      programContext: context,
      job: { ...useMachineControl.getState().job, name: 'legacy-controller.nc' },
    })

    render(createElement(ProgramPanel))

    const contextChip = screen.getByTestId('control-program-context')
    expect(contextChip.getAttribute('data-staleness')).toBe('comparison-failed')
    expect(contextChip.textContent).toBe('Cannot verify against project')
  })
})
