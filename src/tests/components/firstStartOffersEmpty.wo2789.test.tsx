// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { typedMock } from '../support/typedMock'

// Keep the real App/startup/store path; jsdom has no WebGL renderer.
vi.mock('../../components/viewport/Viewport', () => typedMock<typeof import('../../components/viewport/Viewport')>({
  Viewport: () => <div data-testid="viewport-stub" />,
}))
const { default: App } = await import('../../App')
const { useCamStore } = await import('../../store')
const { useProjectPicker } = await import('../../lib/projectOpen/picker')
const { createSampleMachine } = await import('../../lib/machine/sampleMachine')
const initial = useCamStore.getInitialState()
const desktopHost = { openProjectFile: vi.fn(async () => null), recentProjects: vi.fn(async () => []) }

beforeEach(() => {
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

describe('WO-2789 first-start empty choice through the real App', () => {
  it.each(['desktop', 'browser demo'])('first-start %s offers an empty project and dismisses without replacing it', async (platform) => {
    if (platform === 'browser demo') {
      vi.stubGlobal('liencamHost', undefined)
      vi.stubEnv('VITE_DEMO_BUILD', 'true')
    }
    const before = useCamStore.getState().project
    const newProject = vi.spyOn(useCamStore.getState(), 'newProject')
    render(<App />)
    await screen.findByRole('dialog', { name: 'Open a project' })
    fireEvent.click(screen.getByRole('button', { name: 'Start with an empty project' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Open a project' })).toBeNull())
    expect(useProjectPicker.getState().section).toBeNull()
    expect(useCamStore.getState().project).toBe(before)
    expect(before.geometry).toEqual([])
    expect(before.setups).toEqual([])
    expect(newProject).not.toHaveBeenCalled()
  })

  it.each(['recent', 'examples'] as const)('offers the same dismissal when an empty project opens the %s picker', async (section) => {
    act(() => useCamStore.setState({ project: { ...initial.project, id: 'another-empty-project' } }))
    render(<App />)
    act(() => useProjectPicker.getState().show(section))
    fireEvent.click(await screen.findByRole('button', { name: 'Start with an empty project' }))
    expect(useProjectPicker.getState().section).toBeNull()
    expect(useCamStore.getState().project.id).toBe('another-empty-project')
  })

  it('keeps the existing machine choice after starting empty', async () => {
    const operator = { ...createSampleMachine(), id: 'operator', name: 'Operator machine' }
    act(() => useCamStore.setState({ machineLibrary: [createSampleMachine(), operator] }))
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Start with an empty project' }))
    await screen.findByText('Choose a machine for this project')
    expect(useCamStore.getState().project.geometry).toEqual([])
    expect(useCamStore.getState().machineChoiceRequired).toBe(true)
  })

  it('does not offer dismissal as starting empty when a real project is already open', async () => {
    const project = JSON.parse(readFileSync('examples/01-fixture-plate/fixture-plate.camproject', 'utf8'))
    act(() => useCamStore.setState({ project }))
    render(<App />)
    act(() => useProjectPicker.getState().show())
    await screen.findByRole('dialog', { name: 'Open a project' })
    expect(screen.queryByRole('button', { name: 'Start with an empty project' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Close project picker' }))
    expect(useCamStore.getState().project).toBe(project)
  })
})
