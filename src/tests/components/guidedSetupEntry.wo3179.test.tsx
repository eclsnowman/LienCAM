// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { typedMock } from '../support/typedMock'

// WO-3256: the Guided setup is reachable from the startup Open picker (only
// where "Start with an empty project" is offered) and permanently from Settings.
// Everything runs through the real App; jsdom has no WebGL renderer.
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

const guide = () => screen.queryByRole('dialog', { name: 'Guided setup' })

beforeEach(() => {
  useGuidedSetup.getState().hide()
  useProjectPicker.getState().close()
  vi.stubEnv('VITE_DEMO_BUILD', '')
  vi.stubGlobal('liencamHost', desktopHost)
  act(() => useCamStore.setState({
    project: initial.project, machineLibrary: [createSampleMachine()],
    machineChoiceRequired: false, activeModal: null, workspace: 'cam',
  }))
})
afterEach(() => {
  cleanup()
  useProjectPicker.getState().close()
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks()
})

describe('WO-3256 Guided setup entry points', () => {
  it('opens from the empty-start picker without replacing or creating anything', async () => {
    const before = useCamStore.getState()
    const newProject = vi.spyOn(before, 'newProject')
    render(<App />)
    await screen.findByRole('dialog', { name: 'Open a project' })
    fireEvent.click(screen.getByRole('button', { name: 'Guided setup' }))
    expect(await screen.findByRole('dialog', { name: 'Guided setup' })).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: 'Open a project' })).toBeNull()
    expect(useProjectPicker.getState().section).toBeNull()
    const after = useCamStore.getState()
    expect(after.project).toBe(before.project)
    expect(after.machineLibrary).toBe(before.machineLibrary)
    expect(after.toolLibrary).toBe(before.toolLibrary)
    expect(after.appSettings).toBe(before.appSettings)
    expect(newProject).not.toHaveBeenCalled()
  })

  it('lists Units, Machine and Tools with the live current facts', async () => {
    const machine = createSampleMachine()
    render(<App />)
    await screen.findByRole('dialog', { name: 'Open a project' })
    fireEvent.click(screen.getByRole('button', { name: 'Guided setup' }))
    const dialog = await screen.findByRole('dialog', { name: 'Guided setup' })
    const text = dialog.textContent ?? ''
    expect(text).toContain('Display units: millimetres (mm). G-code export units: millimetres (mm).')
    expect(text).toContain('Display units and G-code export units are separate settings.')
    expect(text).toContain(`Tools in your library: ${useCamStore.getState().toolLibrary.length}`)
    expect(text).toContain('Saved changes stay when you leave setup.')
    expect(text).toMatch(/Project machine: /)
    if (useCamStore.getState().project.machine) expect(text).toContain(useCamStore.getState().project.machine!.name)
    expect(machine.name.length).toBeGreaterThan(0)
    for (const name of ['Open Settings', 'Open Machine Library', 'Open Tool Library', 'Skip setup', 'Continue to project']) {
      expect(within(dialog).getByRole('button', { name })).toBeTruthy()
    }
  })

  it('shows only on an unauthored project, like Start with an empty project', async () => {
    const project = JSON.parse(readFileSync('examples/01-fixture-plate/fixture-plate.camproject', 'utf8'))
    act(() => useCamStore.setState({ project }))
    render(<App />)
    act(() => useProjectPicker.getState().show())
    await screen.findByRole('dialog', { name: 'Open a project' })
    expect(screen.queryByRole('button', { name: 'Start with an empty project' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Guided setup' })).toBeNull()
  })

  it.each(['Start with an empty project', 'Close'])('leaves "%s" behaving as before and the guide closed', async (name) => {
    const before = useCamStore.getState().project
    render(<App />)
    await screen.findByRole('dialog', { name: 'Open a project' })
    fireEvent.click(screen.getByRole('button', { name }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Open a project' })).toBeNull())
    expect(guide()).toBeNull()
    expect(useCamStore.getState().project).toBe(before)
  })

  it('opens permanently from Settings, closing Settings, on any project', async () => {
    const project = JSON.parse(readFileSync('examples/01-fixture-plate/fixture-plate.camproject', 'utf8'))
    act(() => useCamStore.setState({ project }))
    render(<App />); act(() => useProjectPicker.getState().close())
    act(() => useCamStore.getState().openModal('settings'))
    fireEvent.click(await within(await screen.findByTestId('settings-modal-panel')).findByRole('button', { name: 'Guided setup' }))
    expect(await screen.findByRole('dialog', { name: 'Guided setup' })).toBeTruthy()
    expect(screen.queryByTestId('settings-modal-panel')).toBeNull()
    expect(useCamStore.getState().activeModal).toBe('guided-setup')
    expect(useCamStore.getState().project).toBe(project)
  })

  it('Skip and Continue both close the guide and change nothing', async () => {
    render(<App />); act(() => useProjectPicker.getState().close())
    for (const name of ['Skip setup', 'Continue to project']) {
      act(() => useCamStore.getState().openModal('settings'))
      fireEvent.click(await within(await screen.findByTestId('settings-modal-panel')).findByRole('button', { name: 'Guided setup' }))
      const dialog = await screen.findByRole('dialog', { name: 'Guided setup' })
      const before = useCamStore.getState()
      fireEvent.click(within(dialog).getByRole('button', { name }))
      expect(guide()).toBeNull()
      expect(useCamStore.getState().project).toBe(before.project)
      expect(useCamStore.getState().appSettings).toBe(before.appSettings)
      expect(useCamStore.getState().activeModal).toBeNull()
    }
  })

  it('Escape closes the guide', async () => {
    render(<App />); act(() => useProjectPicker.getState().close())
    act(() => useCamStore.getState().openModal('settings'))
    fireEvent.click(await within(await screen.findByTestId('settings-modal-panel')).findByRole('button', { name: 'Guided setup' }))
    const dialog = await screen.findByRole('dialog', { name: 'Guided setup' })
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(guide()).toBeNull()
  })

  it('no CAM shortcut acts while the guide is open, and N works again once it closes', async () => {
    const project = JSON.parse(readFileSync('examples/01-fixture-plate/fixture-plate.camproject', 'utf8'))
    act(() => useCamStore.setState({ project, machineLibrary: [createSampleMachine()] }))
    render(<App />); act(() => useProjectPicker.getState().close())
    act(() => useCamStore.getState().openModal('settings'))
    fireEvent.click(await within(await screen.findByTestId('settings-modal-panel')).findByRole('button', { name: 'Guided setup' }))
    const dialog = await screen.findByRole('dialog', { name: 'Guided setup' })
    const before = useCamStore.getState()
    const generate = vi.spyOn(before, 'computeAllToolpaths')
    for (const init of [{ key: 'n' }, { key: 'N' }, { key: 'g' }, { key: 'G', shiftKey: true }]) {
      fireEvent.keyDown(window, init)
      expect(useCamStore.getState().activeModal, init.key).not.toBe('new-operation')
    }
    expect(generate).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Guided setup' })).toBe(dialog)
    expect(useCamStore.getState().project).toBe(before.project)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Skip setup' }))
    expect(guide()).toBeNull()
    fireEvent.keyDown(window, { key: 'n' })
    expect(useCamStore.getState().activeModal).toBe('new-operation')
  })
})
