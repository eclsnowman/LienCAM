// @vitest-environment jsdom
//
// WO-3303 (UI M2 W2-10): the New UI Machine window, the machine pill, the gantry drawing and the
// machine choice card, through the real store and the real definition hook. Each case fails at
// its own assertion on a build without the window.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { createCommandRegistry } from '../../commands'
import { ENGLISH_CATALOG } from '../../i18n/catalogs'
import { useCamStore } from '../../store'
import { useMachineControl } from '../../store/machineControlStore'
import { createDefaultControllerDefinition, type MachineConfig } from '../../types'
import { MachineStatusChip } from '../../components/toolbar/MachineStatusChip'
import {
  GantryDrawing, MACHINE_PAGES, MachinePill, MachineWindow, closeMachineWindow, fixingCounts, fixingItems,
  openMachineDefinition, openMachineWindow, registration,
} from '../../ui2/machine'
import { setMachinePage } from '../../ui2/machine/windowState'

// the connect-time E-STOP latch is its own state (the pill would read E-STOP); this file reads the others
vi.mock('../../lib/machine/machineSession', async importOriginal => {
  const { typedMock } = await import('../support/typedMock')
  return typedMock<typeof import('../../lib/machine/machineSession')>({
    ...(await importOriginal<typeof import('../../lib/machine/machineSession')>()),
    estopNeedsReset: () => false,
  })
})

const state = () => useCamStore.getState()
const id = (testId: string) => screen.queryByTestId(testId)

function machineWith(overrides: Partial<MachineConfig>, name = 'Bench router', mid = 'wo3303-a'): MachineConfig {
  return { ...state().project.machine, id: mid, name, controller: 'uccnc', ...overrides }
}

/** A definition with one real validator complaint (a drive fault pin with port and no pin) and one import note. */
function brokenDefinition() {
  return {
    ...createDefaultControllerDefinition(),
    driveFaultInputs: [{ port: 2, pin: 0, negate: null }],
    importIssues: [{ key: 'Spindle.Max', message: 'not understood' }],
  }
}

function seed(machines: MachineConfig[], project = machines[0]) {
  act(() => {
    useCamStore.setState({ machineLibrary: machines, project: { ...state().project, machine: project }, machineChoiceRequired: false, activeModal: null })
  })
}

beforeEach(() => {
  localStorage.clear()
  act(() => { closeMachineWindow() })
})
afterEach(cleanup)

describe('WO-3303 machine pill', () => {
  it('names the machine and its state, and opens the window', () => {
    seed([machineWith({})])
    render(<><MachinePill /><MachineWindow /></>)
    expect(id('machine-pill')).not.toBeNull()
    expect(id('machine-pill-open')?.textContent).toContain('Bench router')
    expect(id('machine-pill-state')?.textContent).toBe('Offline')
    expect(id('machine-window')).toBeNull()
    fireEvent.click(screen.getByTestId('machine-pill-open'))
    expect(id('machine-window')).not.toBeNull()
  })

  it.each([
    ['connected', 'idle', 'Not homed'],
    ['connected', 'run', 'Running'],
    ['connected', 'hold', 'Held'],
  ] as const)('shows %s/%s as %s', (phase, machineState, word) => {
    seed([machineWith({})])
    act(() => { useMachineControl.setState({ connectionPhase: phase, machineState } as never) })
    render(<MachinePill />)
    expect(id('machine-pill-state')?.textContent).toBe(word)
    act(() => { useMachineControl.setState({ connectionPhase: 'disconnected', machineState: 'idle' } as never) })
  })

  it('drops a card to choose the machine when the project has none, and closes only by choosing', () => {
    const a = machineWith({}, 'Bench router', 'wo3303-a')
    const b = machineWith({}, 'Mill 3-axis', 'wo3303-b')
    seed([a, b], a)
    act(() => { useCamStore.setState({ machineChoiceRequired: true, appSettings: { ...state().appSettings, defaultMachineId: 'wo3303-b' } }) })
    render(<MachinePill />)
    expect(id('machine-choice-card')).not.toBeNull()
    // the default leads and is already chosen
    expect(screen.getByTestId('machine-choice-wo3303-b').getAttribute('aria-pressed') ?? screen.getByTestId('machine-choice-wo3303-b').getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByTestId('machine-choice-wo3303-a'))
    fireEvent.click(within(screen.getByTestId('machine-choice-card')).getByText('Use this machine'))
    expect(state().project.machine.id).toBe('wo3303-a')
    expect(state().machineChoiceRequired).toBe(false)
    expect(id('machine-choice-card')).toBeNull()
  })
})

describe('WO-3303 machine window', () => {
  it('lists the library page and the seven definition areas, and picks the project machine', () => {
    const a = machineWith({}, 'Bench router', 'wo3303-a')
    const b = machineWith({}, 'Mill 3-axis', 'wo3303-b')
    seed([a, b], a)
    render(<MachineWindow />)
    act(() => { openMachineWindow() })
    expect(MACHINE_PAGES).toEqual(['library', 'overview', 'machine', 'spindle', 'outputs', 'probing', 'controller', 'allSettings'])
    const nav = within(screen.getByTestId('machine-window')).getByRole('navigation')
    expect(within(nav).getAllByRole('button').map(b => b.textContent)).toEqual([
      'Library', 'Overview', 'Machine', 'Spindle', 'Outputs & coolant', 'Probing', 'Controller', 'All settings',
    ])
    expect(id('machine-library-row-wo3303-a')).not.toBeNull()
    fireEvent.click(screen.getByTestId('machine-library-row-wo3303-b'))
    fireEvent.click(screen.getByTestId('machine-library-use'))
    expect(state().project.machine.id).toBe('wo3303-b')
  })

  it('removes a machine from the library only after a confirmation that names it', () => {
    const a = machineWith({}, 'Bench router', 'wo3303-a')
    const b = machineWith({}, 'Mill 3-axis', 'wo3303-b')
    seed([a, b], a)
    render(<MachineWindow />)
    act(() => { openMachineWindow() })
    expect(id('machine-library-row-wo3303-b')).not.toBeNull()
    fireEvent.click(screen.getByTestId('machine-library-row-wo3303-b'))
    fireEvent.click(screen.getByTestId('machine-library-remove'))
    expect(state().machineLibrary).toHaveLength(2)
    fireEvent.click(screen.getByText('Remove Mill 3-axis'))
    expect(state().machineLibrary.map(m => m.id)).toEqual(['wo3303-a'])
  })

  it('counts what needs fixing per area in the list, on the Overview, and on the area itself', () => {
    seed([machineWith({ controllerDefinition: brokenDefinition() })])
    render(<MachineWindow />)
    act(() => { openMachineDefinition('overview') })
    expect(id('machine-window')).not.toBeNull()
    const nav = within(screen.getByTestId('machine-window')).getByRole('navigation')
    // the validator complaint belongs to Controller (its pin editor), and so does the import note
    expect(within(nav).getByText('Controller (2)')).toBeTruthy()
    expect(within(nav).getByText('Machine')).toBeTruthy()
    expect(screen.getAllByTestId('machine-fixing-item')).toHaveLength(2)
    expect(screen.getByTestId('machine-overview-fix-controller').textContent).toBe('2 to fix')
    fireEvent.click(screen.getAllByTestId(/machine-fixing-go-/)[0])
    expect(screen.getByTestId('machine-definition').getAttribute('data-page')).toBe('controller')
    expect(screen.getAllByTestId('machine-def-fixing-item')).toHaveLength(2)
  })

  it('says nothing needs fixing for a clean definition', () => {
    seed([machineWith({ controllerDefinition: createDefaultControllerDefinition() })])
    render(<MachineWindow />)
    act(() => { openMachineDefinition('overview') })
    expect(id('machine-fixing-none')).not.toBeNull()
  })

  it('opens a definition area with today\'s editor in it, and Save writes the same record', () => {
    seed([machineWith({ controllerDefinition: createDefaultControllerDefinition() })])
    render(<MachineWindow />)
    act(() => { openMachineDefinition('spindle') })
    expect(id('machine-area-spindle')).not.toBeNull()
    expect(id('machine-def-save')).not.toBeNull()
    fireEvent.change(within(screen.getByTestId('machine-def-kind')).getByRole('combobox'), { target: { value: 'laser' } })
    fireEvent.click(screen.getByTestId('machine-def-save'))
    expect(state().machineLibrary[0].kind).toBe('laser')
  })

  it('carries the software-side machine capabilities on the Overview', () => {
    seed([machineWith({ controllerDefinition: createDefaultControllerDefinition() })])
    render(<MachineWindow />)
    act(() => { openMachineDefinition('overview') })
    const rows = ['homing', 'probing', 'coolant', 'softLimits', 'ramps']
    for (const row of rows) expect(id(`machine-capability-${row}`)).not.toBeNull()
    expect(id('machine-capability-ramps')?.textContent).toContain('Not configured in this machine definition')
  })
})

describe('WO-3303 a machine with no controller definition keeps what today\'s panel shows', () => {
  it('shows the G30 reference positions and the operator-stop park editors on the Overview', () => {
    seed([machineWith({ controllerDefinition: undefined })])
    render(<MachineWindow />)
    act(() => { openMachineDefinition('overview') })
    expect(id('machine-overview')).not.toBeNull()
    expect(id('machine-def-reference-positions')).not.toBeNull()
    expect(id('machine-def-operator-stop-park')).not.toBeNull()
  })

  it('shows the Linux network setup on the Overview and the Controller area, defined or not', () => {
    const host = { platform: 'linux', setupControllerNetwork: async () => ({ ok: true, message: '' }), controllerNetworkPorts: async () => ({ ports: [] }) }
    Object.assign(window, { liencamHost: host })
    try {
      for (const controllerDefinition of [undefined, createDefaultControllerDefinition()]) {
        seed([machineWith({ controllerDefinition })])
        const view = render(<MachineWindow />)
        for (const area of ['overview', 'controller'] as const) {
          act(() => { openMachineDefinition(area) })
          expect(screen.queryAllByTestId('linux-controller-network')).toHaveLength(1)
        }
        view.unmount()
        act(() => { closeMachineWindow() })
      }
    } finally {
      delete (window as { liencamHost?: unknown }).liencamHost
    }
  })
})

describe('WO-3303 the setup walkthrough survives creating the definition', () => {
  it('stays up on the Overview after its first Next creates the controller definition', () => {
    seed([machineWith({ controllerDefinition: undefined })])
    render(<MachineWindow />)
    act(() => { openMachineDefinition('overview') })
    fireEvent.click(screen.getByTestId('machine-def-panel-run-walkthrough'))
    expect(id('setup-walkthrough')).not.toBeNull()
    fireEvent.click(screen.getByTestId('setup-walkthrough-next'))
    // the draft now carries a definition: the walkthrough is still the thing on screen
    expect(id('setup-walkthrough')).not.toBeNull()
    expect(screen.getByTestId('machine-window-body').getAttribute('data-page')).toBe('overview')
    fireEvent.click(screen.getByTestId('setup-walkthrough-exit'))
    expect(id('setup-walkthrough')).toBeNull()
  })

  it('is left behind when the window goes to another page', () => {
    seed([machineWith({ controllerDefinition: undefined })])
    render(<MachineWindow />)
    act(() => { openMachineDefinition('overview') })
    fireEvent.click(screen.getByTestId('machine-def-panel-run-walkthrough'))
    act(() => { setMachinePage('spindle') })
    expect(id('setup-walkthrough')).toBeNull()
  })
})

describe('WO-3303 status chip in the New UI app bar', () => {
  it.each(['cam', 'control'] as const)('opens machine settings by click, Enter and Space in the %s workspace', workspace => {
    seed([machineWith({})])
    act(() => { useCamStore.setState({ workspace }) })
    render(<div data-ui2=""><MachineStatusChip /></div>)
    const chip = () => screen.getByTestId('machine-status-chip')
    expect(chip().getAttribute('role')).toBe('button')
    expect(chip().getAttribute('tabindex')).toBe('0')
    fireEvent.click(chip())
    expect(state().activeModal).toBe('machine-config')
    act(() => { useCamStore.setState({ activeModal: null }) })
    fireEvent.keyDown(chip(), { key: 'Enter' })
    expect(state().activeModal).toBe('machine-config')
    act(() => { useCamStore.setState({ activeModal: null }) })
    fireEvent.keyDown(chip(), { key: ' ' })
    expect(state().activeModal).toBe('machine-config')
  })

  it('leaves the classic chip exactly as it was: a status, not a button, and a click does nothing', () => {
    seed([machineWith({})])
    render(<MachineStatusChip />)
    const chip = screen.getByTestId('machine-status-chip')
    expect(chip.getAttribute('role')).toBe('status')
    expect(chip.hasAttribute('tabindex')).toBe(false)
    fireEvent.click(chip)
    expect(state().activeModal).toBeNull()
  })
})

describe('WO-3303 window selection', () => {
  it('reopens on the project machine, not the profile picked last time', () => {
    const a = machineWith({}, 'Bench router', 'wo3303-a')
    const b = machineWith({}, 'Mill 3-axis', 'wo3303-b')
    seed([a, b], a)
    render(<MachineWindow />)
    act(() => { openMachineWindow() })
    expect(id('machine-library-row-wo3303-b')).not.toBeNull()
    fireEvent.click(screen.getByTestId('machine-library-row-wo3303-b'))
    expect(screen.getByTestId('machine-window-body').getAttribute('data-machine-id')).toBe('wo3303-b')
    act(() => { closeMachineWindow() })
    act(() => { openMachineDefinition('overview') })
    expect(screen.getByTestId('machine-window-body').getAttribute('data-machine-id')).toBe('wo3303-a')
  })

  it('after Remove the window shows the project machine again', () => {
    const a = machineWith({}, 'Bench router', 'wo3303-a')
    const b = machineWith({}, 'Mill 3-axis', 'wo3303-b')
    seed([a, b], a)
    render(<MachineWindow />)
    act(() => { openMachineWindow() })
    expect(id('machine-library-row-wo3303-b')).not.toBeNull()
    fireEvent.click(screen.getByTestId('machine-library-row-wo3303-b'))
    fireEvent.click(screen.getByTestId('machine-library-remove'))
    fireEvent.click(screen.getByText('Remove Mill 3-axis'))
    expect(screen.getByTestId('machine-window-body').getAttribute('data-machine-id')).toBe('wo3303-a')
  })

  it('"Use this machine" binds the saved library record, as Use for this project does', () => {
    const a = machineWith({}, 'Bench router', 'wo3303-a')
    const b = machineWith({ travel: { x: 111, y: 222, z: 33 } }, 'Mill 3-axis', 'wo3303-b')
    seed([a, b], a)
    render(<MachineWindow />)
    act(() => { openMachineWindow() })
    expect(id('machine-library-row-wo3303-b')).not.toBeNull()
    fireEvent.click(screen.getByTestId('machine-library-row-wo3303-b'))
    fireEvent.click(screen.getByText('Use this machine'))
    expect(state().project.machine.id).toBe('wo3303-b')
    expect(state().project.machine.travel.x).toBe(111)
  })
})

describe('WO-3303 project machine versus the Control machine', () => {
  function projectBControlA() {
    const a = machineWith({ controllerDefinition: createDefaultControllerDefinition() }, 'Bench router', 'wo3303-a')
    const b = machineWith({ controllerDefinition: createDefaultControllerDefinition() }, 'Mill 3-axis', 'wo3303-b')
    seed([a, b], b)
    act(() => { useCamStore.setState({ control: { ...state().control, activeMachineId: 'wo3303-a' } }) })
  }
  afterEach(() => { act(() => { useCamStore.setState({ control: { ...state().control, activeMachineId: null } }) }) })

  it('opens on the project machine, not the one Control drives', () => {
    projectBControlA()
    render(<><MachinePill /><MachineWindow /></>)
    fireEvent.click(screen.getByTestId('machine-pill-open'))
    expect(id('machine-window-body')).not.toBeNull()
    expect(screen.getByTestId('machine-window-body').getAttribute('data-machine-id')).toBe('wo3303-b')
    expect(screen.getByTestId('machine-window').textContent).toContain('Machine: Mill 3-axis')
  })

  it('shows the project machine on a definition area and after Remove of another profile', () => {
    projectBControlA()
    render(<MachineWindow />)
    act(() => { openMachineDefinition('overview') })
    expect(id('machine-window-body')).not.toBeNull()
    expect(screen.getByTestId('machine-window-body').getAttribute('data-machine-id')).toBe('wo3303-b')
    expect(id('machine-definition') ?? id('machine-overview')).not.toBeNull()
    act(() => { openMachineWindow() })
    fireEvent.click(screen.getByTestId('machine-library-row-wo3303-a'))
    fireEvent.click(screen.getByTestId('machine-library-remove'))
    fireEvent.click(screen.getByText('Remove Bench router'))
    expect(screen.getByTestId('machine-window-body').getAttribute('data-machine-id')).toBe('wo3303-b')
    expect(screen.getByTestId('machine-window').textContent).toContain('Machine: Mill 3-axis')
  })
})

describe('WO-3303 links inside the hosted areas navigate the window', () => {
  it('the Controller area GRBL table link opens All settings', () => {
    seed([machineWith({ controller: 'grbl', controllerDefinition: createDefaultControllerDefinition() })])
    render(<MachineWindow />)
    act(() => { openMachineDefinition('controller') })
    expect(id('machine-def-controller-grbl-table-link')).not.toBeNull()
    fireEvent.click(screen.getByTestId('machine-def-controller-grbl-table-link'))
    expect(screen.getByTestId('machine-window-body').getAttribute('data-page')).toBe('allSettings')
  })

  it('the Controller area fault settings link opens All settings', () => {
    seed([machineWith({ controller: 'uccnc', controllerDefinition: createDefaultControllerDefinition() })])
    render(<MachineWindow />)
    act(() => { openMachineDefinition('controller') })
    expect(id('machine-def-controller-faults-link')).not.toBeNull()
    fireEvent.click(screen.getByTestId('machine-def-controller-faults-link'))
    expect(screen.getByTestId('machine-window-body').getAttribute('data-page')).toBe('allSettings')
  })
})

describe('WO-3303 gantry drawing', () => {
  it('draws a square gantry: both legs at the same Y, a rail and a carriage under each, the beam across', () => {
    render(<GantryDrawing travel={{ x: 600, y: 400, z: 120 }} xHome="negative" yHome="positive" label="Gantry" />)
    expect(id('machine-gantry')).not.toBeNull()
    expect(screen.getByTestId('machine-gantry').getAttribute('data-gantry')).toBe('square')
    const legs = screen.getAllByTestId('machine-gantry-leg')
    expect(legs).toHaveLength(2)
    expect(legs[0].getAttribute('data-leg-y')).toBe(legs[1].getAttribute('data-leg-y'))
    expect(legs[0].getAttribute('data-leg-x')).not.toBe(legs[1].getAttribute('data-leg-x'))
    for (const leg of legs) {
      expect(leg.querySelector('.ui2-gantry-rail')).not.toBeNull()
      expect(leg.querySelector('.ui2-gantry-block')).not.toBeNull()
    }
    expect(id('machine-gantry-beam')).not.toBeNull()
    expect(id('machine-gantry-home')).not.toBeNull()
  })

  it('marks no home corner when the homing direction is not stated', () => {
    render(<GantryDrawing travel={{ x: 600, y: 400, z: 120 }} xHome={null} yHome={null} label="Gantry" />)
    expect(id('machine-gantry')).not.toBeNull()
    expect(id('machine-gantry-home')).toBeNull()
  })
})

describe('WO-3303 fixing list and commands', () => {
  it('attributes every problem and import note to one area, never dropping any', () => {
    const items = fixingItems({
      problems: ['Homing order lists X more than once.', 'The e-stop pin is port 2 pin 0.'],
      pinLabels: ['e-stop'],
      importIssues: [{ key: 'K', message: 'm' }],
    })
    expect(items.map(i => i.area)).toEqual(['machine', 'controller', 'controller'])
    expect(Object.values(fixingCounts(items)).reduce((a, b) => a + b, 0)).toBe(items.length)
  })

  it('registers machine.open and machine.openDefinition, which open the window', async () => {
    seed([machineWith({})])
    const registry = createCommandRegistry()
    for (const spec of registration.commands ?? []) registry.register(spec)
    render(<MachineWindow />)
    const ctx = { workspace: 'setup' } as const
    await act(async () => { await registry.run('machine.open', ctx) })
    expect(id('machine-window-body')).not.toBeNull()
    expect(screen.getByTestId('machine-window-body').getAttribute('data-page')).toBe('library')
    await act(async () => { await registry.run('machine.openDefinition', ctx) })
    expect(screen.getByTestId('machine-window-body').getAttribute('data-page')).toBe('overview')
    // it does not take over the hosted editor modal, which stays the door for the CAM half and import
    expect(registration.windows?.[0].replaces).toBeUndefined()
    expect(registration.appBarItems?.[0].area).toBe('status')
  })
})

describe('WO-3303 words', () => {
  it('has the same keys in de, es and fr as in en (no key missing, no extra)', async () => {
    const en = ENGLISH_CATALOG['ui2-machine.wo3303']
    expect(en).toBeTruthy()
    const keys = Object.keys(en ?? {}).sort()
    for (const lang of ['de', 'es', 'fr']) {
      const mod = (await import(`../../i18n/locales/${lang}/ui2-machine.wo3303.ts`)).default as Record<string, string>
      expect(Object.keys(mod).sort(), lang).toEqual(keys)
    }
  })
})
