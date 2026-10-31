// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { typedMock } from '../support/typedMock'

// WO-3256: the clean-profile journey end to end through the real App - picker,
// guide, each editor and back, with live counts - and the shared-project reopen.
vi.mock('../../components/viewport/Viewport', () => typedMock<typeof import('../../components/viewport/Viewport')>({
  Viewport: () => <div data-testid="viewport-stub" />,
}))
const { default: App } = await import('../../App')
const { useCamStore } = await import('../../store')
const { useProjectPicker } = await import('../../lib/projectOpen/picker')
const { createSampleMachine } = await import('../../lib/machine/sampleMachine')
const { useGuidedSetup } = await import('../../components/modals/GuidedSetupModal')
const initial = useCamStore.getInitialState()
const desktopHost = { openProjectFile: vi.fn(async () => null), recentProjects: vi.fn(async () => []) }
const tool = (id: string, name: string, n = 101) => ({
  id, name, type: 'flat_end_mill', diameter: 6, shankDiameter: 6, overallLength: 50, fluteLength: 18,
  shoulderLength: 0, numberOfFlutes: 2, cornerRadius: 0, angleFromAxisDeg: 59, material: 'carbide',
  coating: 'none', toolNumber: n, notes: '',
  feedsAndSpeeds: { default: { rpm: 18000, feedRate: 1500, plungeRate: 500, depthOfCut: 1.5, stepover: 3, coolant: 'none' } },
}) as unknown as import('../../types').Tool

beforeEach(() => {
  useGuidedSetup.getState().hide()
  useProjectPicker.getState().close()
  vi.stubEnv('VITE_DEMO_BUILD', '')
  vi.stubGlobal('liencamHost', desktopHost)
  act(() => useCamStore.setState({
    project: initial.project, machineLibrary: [createSampleMachine()], toolLibrary: [],
    machineChoiceRequired: false, activeModal: null, workspace: 'cam', projectOpen: null,
  }))
})
afterEach(() => {
  cleanup()
  useProjectPicker.getState().close()
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks()
})

describe('WO-3256 Guided setup journeys', () => {
  it('clean profile: units, machine library, then a saved tool returns with its real count', async () => {
    render(<App />)
    await screen.findByRole('dialog', { name: 'Open a project' })
    fireEvent.click(screen.getByRole('button', { name: 'Guided setup' }))
    let dialog = within(await screen.findByRole('dialog', { name: 'Guided setup' }))
    expect(dialog.getByText('Tools in your library: 0')).toBeTruthy()

    // Units: the existing Settings, a real change, back to the guide with the new fact.
    fireEvent.click(dialog.getByRole('button', { name: 'Open Settings' }))
    expect(await screen.findByTestId('settings-modal-panel')).toBeTruthy()
    act(() => useCamStore.getState().setDisplayUnits('inch'))
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    dialog = within(await screen.findByRole('dialog', { name: 'Guided setup' }))
    expect(dialog.getByText('Display units: inches (in). G-code export units: millimetres (mm).')).toBeTruthy()

    // Machine: open and leave with no choice made.
    const machineBefore = useCamStore.getState().project.machine
    fireEvent.click(dialog.getByRole('button', { name: 'Open Machine Library' }))
    act(() => useCamStore.getState().closeModal())
    dialog = within(await screen.findByRole('dialog', { name: 'Guided setup' }))
    expect(useCamStore.getState().project.machine).toBe(machineBefore)

    // Tools: one saved in the library while the editor is open.
    fireEvent.click(dialog.getByRole('button', { name: 'Open Tool Library' }))
    act(() => { expect(useCamStore.getState().addTool(tool('t1', 'Flat 6mm'))).toBe(true) })
    act(() => useCamStore.getState().closeModal())
    dialog = within(await screen.findByRole('dialog', { name: 'Guided setup' }))
    expect(dialog.getByText('Tools in your library: 1')).toBeTruthy()

    fireEvent.click(dialog.getByRole('button', { name: 'Continue to project' }))
    expect(screen.queryByRole('dialog', { name: 'Guided setup' })).toBeNull()
    expect(useCamStore.getState().toolLibrary).toHaveLength(1)
  })

  it('reopens from Settings with zero records added and the same count', async () => {
    act(() => useCamStore.setState({ toolLibrary: [tool('t1', 'Flat 6mm', 101), tool('t2', 'Flat 3mm', 102)] }))
    render(<App />); act(() => useProjectPicker.getState().close())
    for (let i = 0; i < 2; i++) {
      act(() => useCamStore.getState().openModal('settings'))
      fireEvent.click(await within(await screen.findByTestId('settings-modal-panel')).findByRole('button', { name: 'Guided setup' }))
      const dialog = within(await screen.findByRole('dialog', { name: 'Guided setup' }))
      expect(dialog.getByText('Tools in your library: 2')).toBeTruthy()
      fireEvent.click(dialog.getByRole('button', { name: 'Skip setup' }))
    }
    expect(useCamStore.getState().toolLibrary).toHaveLength(2)
  })

  it('a project that already has a machine shows its name', async () => {
    const machine = { ...createSampleMachine(), id: 'shop', name: 'Shop router' }
    act(() => useCamStore.setState({ project: { ...initial.project, machine }, machineLibrary: [machine] }))
    render(<App />); act(() => useProjectPicker.getState().close())
    act(() => useCamStore.getState().openModal('settings'))
    fireEvent.click(await within(await screen.findByTestId('settings-modal-panel')).findByRole('button', { name: 'Guided setup' }))
    expect(await screen.findByText('Project machine: Shop router')).toBeTruthy()
  })
})
