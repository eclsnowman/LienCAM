// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { DEMO_EXAMPLES, ProjectStartupFlow, demoExampleAssetUrl } from '../../components/modals/DemoExamplePickerModal'
import { useCamStore } from '../../store'
import { createSampleMachine } from '../../lib/machine/sampleMachine'

// jsdom has no IndexedDB; keep the real project-open path (as WO-2393's test does).
vi.mock('../../lib/stlCache', async () => {
  const { typedMock } = await import('../support/typedMock')
  return typedMock<typeof import('../../lib/stlCache')>({
    cacheSTL: vi.fn().mockResolvedValue(undefined),
    loadCachedSTL: vi.fn().mockResolvedValue(null),
    removeCachedSTL: vi.fn().mockResolvedValue(undefined),
  })
})

const initial = useCamStore.getInitialState()
const fixture = readFileSync('examples/01-fixture-plate/fixture-plate.camproject', 'utf8')
const real = { ...createSampleMachine(), id: 'operator', name: 'Operator Machine' }
// What electron/preload.cjs exposes; the installed app is never a demo build.
const desktopHost = { platform: 'win32', versions: { chrome: '1', electron: '1' } }

beforeEach(() => {
  vi.stubEnv('VITE_DEMO_BUILD', '')
  vi.stubGlobal('liencamHost', desktopHost)
  act(() => useCamStore.setState({
    project: initial.project, machineLibrary: [createSampleMachine(), real],
    machineChoiceRequired: false, activeModal: null,
    appSettings: { ...initial.appSettings, defaultMachineId: null },
  }))
})
afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('WO-2532 the desktop app offers Try an example', () => {
  it('a fresh desktop start shows the browser demo picker, with every shipped example and no machine prompt behind it', async () => {
    render(<ProjectStartupFlow />)
    const dialog = await screen.findByRole('dialog', { name: 'Try an example' })
    expect(Array.from(dialog.querySelectorAll('.machine-choice-name'), (e) => e.textContent))
      .toEqual(DEMO_EXAMPLES.map((example) => example.label))
    expect(DEMO_EXAMPLES.filter((e) => e.group === 'CNC starter kit').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'Start with an empty project' })).toBeTruthy()
    expect(screen.queryByText('Choose a machine for this project')).toBeNull()
    expect(useCamStore.getState().machineChoiceRequired).toBe(false)
  })

  it('choosing the Fixture Plate opens the packaged file with the production opener and the sample router', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => fixture })
    vi.stubGlobal('fetch', fetchMock)
    const load = vi.spyOn(useCamStore.getState(), 'loadProjectFromFile')
    render(<ProjectStartupFlow />)
    fireEvent.click(await screen.findByRole('button', { name: /Fixture Plate/ }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Try an example' })).toBeNull())
    const example = DEMO_EXAMPLES.find((e) => e.label === 'Fixture Plate')!
    // A package-relative asset URL, never a network address.
    const url = demoExampleAssetUrl(example.path, example.url)
    expect(fetchMock).toHaveBeenCalledWith(url)
    expect(url).not.toMatch(/^https?:/)
    expect(load).toHaveBeenCalledOnce()
    const state = useCamStore.getState()
    expect(state.project.id).toBe(JSON.parse(fixture).id)
    expect(state.project.geometry.length).toBeGreaterThan(0)
    expect(state.project.machine).toEqual(createSampleMachine())
    expect(state.machineChoiceRequired).toBe(false)
    expect(state.machineLibrary).toContainEqual(real)
  })

  it('starting empty hands over to the machine choice, as the browser does', async () => {
    render(<ProjectStartupFlow />)
    fireEvent.click(await screen.findByRole('button', { name: 'Start with an empty project' }))
    await screen.findByText('Choose a machine for this project')
    expect(screen.queryByRole('dialog', { name: 'Try an example' })).toBeNull()
    fireEvent.click(screen.getByText('Use this machine'))
    expect(useCamStore.getState().project.machine.id).toBe('operator')
  })

  it('a restored desktop project, even an empty one, is not interrupted', async () => {
    act(() => useCamStore.setState({ project: { ...initial.project, id: 'saved-desktop-project' } }))
    render(<ProjectStartupFlow />)
    await screen.findByText('Choose a machine for this project')
    expect(screen.queryByRole('dialog', { name: 'Try an example' })).toBeNull()
  })

  it('an ordinary browser session (no desktop host, no demo flag) still starts without the picker', () => {
    vi.stubGlobal('liencamHost', undefined)
    act(() => useCamStore.setState({ machineLibrary: [createSampleMachine()] }))
    render(<ProjectStartupFlow />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
