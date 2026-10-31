// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { typedMock } from '../support/typedMock'

// WO-3256: the guide comes back ONCE when the exact editor it opened closes,
// and is cleared by anything else that could make a return stale.
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
async function openGuide() {
  act(() => useCamStore.getState().openModal('settings'))
  fireEvent.click(await within(await screen.findByTestId('settings-modal-panel')).findByRole('button', { name: 'Guided setup' }))
  return within(await screen.findByRole('dialog', { name: 'Guided setup' }))
}
const operator = { ...createSampleMachine(), id: 'operator', name: 'Operator machine' }
const CHILDREN = [
  ['Open Settings', 'settings'],
  ['Open Machine Library', 'machine-config'],
  ['Open Tool Library', 'tool-library'],
] as const

beforeEach(() => {
  useGuidedSetup.getState().hide()
  useProjectPicker.getState().close()
  vi.stubEnv('VITE_DEMO_BUILD', '')
  vi.stubGlobal('liencamHost', desktopHost)
  act(() => useCamStore.setState({
    project: initial.project, machineLibrary: [createSampleMachine()],
    machineChoiceRequired: false, activeModal: null, workspace: 'cam', projectOpen: null,
  }))
})
afterEach(() => {
  cleanup()
  useProjectPicker.getState().close()
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks()
})

describe('WO-3256 Guided setup return', () => {
  it.each(CHILDREN)('%s opens its editor and the guide returns once when it closes', async (button, modal) => {
    render(<App />); act(() => useProjectPicker.getState().close())
    const dialog = await openGuide()
    fireEvent.click(dialog.getByRole('button', { name: button }))
    expect(useCamStore.getState().activeModal).toBe(modal)
    expect(guide()).toBeNull()
    act(() => useCamStore.getState().closeModal())
    expect(await screen.findByRole('dialog', { name: 'Guided setup' })).toBeTruthy()
    // Once: after Skip, nothing brings it back.
    fireEvent.click(screen.getByRole('button', { name: 'Skip setup' }))
    act(() => useCamStore.getState().openModal(modal))
    act(() => useCamStore.getState().closeModal())
    expect(guide()).toBeNull()
  })

  it('does not return to a guide the operator replaced with another editor', async () => {
    render(<App />); act(() => useProjectPicker.getState().close())
    fireEvent.click((await openGuide()).getByRole('button', { name: 'Open Settings' }))
    act(() => useCamStore.getState().openModal('tool-library'))
    act(() => useCamStore.getState().closeModal())
    expect(guide()).toBeNull()
  })

  it('does not return after the project is replaced meanwhile', async () => {
    render(<App />); act(() => useProjectPicker.getState().close())
    fireEvent.click((await openGuide()).getByRole('button', { name: 'Open Tool Library' }))
    act(() => useCamStore.setState({ project: { ...initial.project, id: 'replaced-while-open' } }))
    act(() => useCamStore.getState().closeModal())
    expect(guide()).toBeNull()
  })

  it('does not return into an open still in flight', async () => {
    render(<App />); act(() => useProjectPicker.getState().close())
    fireEvent.click((await openGuide()).getByRole('button', { name: 'Open Settings' }))
    let requestId = 0
    act(() => { requestId = useCamStore.getState().beginProjectOpen() })
    act(() => useCamStore.getState().closeModal())
    expect(guide()).toBeNull()
    act(() => useCamStore.getState().failProjectOpenRead(requestId, 'error', 'delayed'))
    expect(guide()).toBeNull()
  })

  it('a workspace change clears the return, and Machine Library going to Control never gets covered', async () => {
    render(<App />); act(() => useProjectPicker.getState().close())
    fireEvent.click((await openGuide()).getByRole('button', { name: 'Open Machine Library' }))
    act(() => { useCamStore.getState().setWorkspace('control'); useCamStore.getState().closeModal() })
    expect(guide()).toBeNull()
    act(() => useCamStore.getState().setWorkspace('cam'))
    expect(guide()).toBeNull()
  })

  it('a workspace change with the guide itself showing closes it', async () => {
    render(<App />); act(() => useProjectPicker.getState().close())
    await openGuide()
    act(() => useCamStore.getState().setWorkspace('control'))
    expect(guide()).toBeNull()
    act(() => useCamStore.getState().setWorkspace('cam'))
    expect(guide()).toBeNull()
  })

  it('the machine choice keeps precedence: the guide hides, defers its return, and changes no machine', async () => {
    render(<App />); act(() => useProjectPicker.getState().close())
    fireEvent.click((await openGuide()).getByRole('button', { name: 'Open Tool Library' }))
    act(() => useCamStore.setState({ machineLibrary: [createSampleMachine(), operator], project: { ...initial.project, machine: operator } }))
    const library = useCamStore.getState().machineLibrary
    act(() => useCamStore.setState({ project: { ...initial.project, machine: { ...createSampleMachine(), id: 'gone-from-library' } } }))
    act(() => useCamStore.getState().closeModal())
    expect(guide()).toBeNull()
    expect(useCamStore.getState().machineChoiceRequired).toBe(true)
    act(() => useCamStore.setState({ project: { ...useCamStore.getState().project, machine: operator } }))
    expect(await screen.findByRole('dialog', { name: 'Guided setup' })).toBeTruthy()
    expect(useCamStore.getState().machineLibrary).toBe(library)
  })

  it('a rising machine choice hides a guide that is showing and it comes back after', async () => {
    render(<App />); act(() => useProjectPicker.getState().close())
    act(() => useCamStore.setState({ machineLibrary: [createSampleMachine(), operator], project: { ...initial.project, machine: operator } }))
    await openGuide()
    act(() => useCamStore.setState({ project: { ...useCamStore.getState().project, machine: { ...createSampleMachine(), id: 'gone-from-library' } } }))
    expect(useCamStore.getState().machineChoiceRequired).toBe(true)
    expect(guide()).toBeNull()
    act(() => useCamStore.setState({ project: { ...useCamStore.getState().project, machine: operator } }))
    expect(await screen.findByRole('dialog', { name: 'Guided setup' })).toBeTruthy()
  })

  it('the Open picker rising over the guide hides it for good', async () => {
    render(<App />); act(() => useProjectPicker.getState().close())
    await openGuide()
    act(() => useProjectPicker.getState().show('examples'))
    expect(guide()).toBeNull()
    act(() => useProjectPicker.getState().close())
    expect(guide()).toBeNull()
  })

  it('another editor raised over the visible guide replaces it: never two layers at once', async () => {
    render(<App />); act(() => useProjectPicker.getState().close())
    await openGuide()
    act(() => useCamStore.getState().openModal('settings'))
    expect(guide()).toBeNull()
    expect(screen.getByTestId('settings-modal-panel')).toBeTruthy()
    act(() => useCamStore.getState().closeModal())
    expect(guide()).toBeNull()
  })
})
