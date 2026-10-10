// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DEMO_EXAMPLES, ProjectStartupFlow, demoExampleAssetUrl } from '../../components/modals/DemoExamplePickerModal'
import { isDemoBuild } from '../../lib/demoBuild'
import { useCamStore } from '../../store'
import { createSampleMachine } from '../../lib/machine/sampleMachine'
import { ConfirmModal } from '../../components/modals/ConfirmModal'
import { clearProjectSaveBaseline } from '../../store/projectSaveBaseline'

// jsdom has no IndexedDB or viewport. Keep the real project-open/migration
// path; the built-browser evidence below exercises its real durable caches.
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

beforeEach(() => {
  vi.stubEnv('VITE_DEMO_BUILD', 'true')
  act(() => useCamStore.setState({
    project: initial.project, machineLibrary: [createSampleMachine()],
    machineChoiceRequired: false, activeModal: null,
    appSettings: { ...initial.appSettings, defaultMachineId: null },
  }))
})
afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('WO-2393 production first-open flow', () => {
  it('rebases Vite absolute imported URLs and public walkthrough URLs under the demo mount', () => {
    window.history.replaceState({}, '', '/LienCAM/app/')
    vi.stubEnv('BASE_URL', './')
    expect(demoExampleAssetUrl('/examples/01-fixture-plate/fixture-plate.camproject', `${window.location.origin}/LienCAM/app/assets/fixture-plate-hash.camproject`))
      .toBe('./assets/fixture-plate-hash.camproject')
    expect(demoExampleAssetUrl('/public/help/form-walkthrough-grip-handle/grip-handle.camproject', '/help/form-walkthrough-grip-handle/grip-handle.camproject'))
      .toBe('./help/form-walkthrough-grip-handle/grip-handle.camproject')
    window.history.replaceState({}, '', '/')
  })
  it('requires a build flag; desktop and URL parameters cannot opt in', () => {
    vi.stubEnv('VITE_DEMO_BUILD', '')
    window.history.replaceState({}, '', '?demo=1')
    expect(isDemoBuild()).toBe(false)
    window.history.replaceState({}, '', '/')
  })

  it('lists Full Suite first, every shipped kit project and the Form walkthroughs, excluding other files', async () => {
    function projects(dir: string): string[] {
      return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name)
        return entry.isDirectory() ? projects(path) : path.endsWith('.camproject') ? [`/${path.replace(/\\/g, '/')}`] : []
      })
    }
    expect(DEMO_EXAMPLES.filter((e) => e.path.startsWith('/examples/')).map((e) => e.path).sort())
      .toEqual(projects('examples').sort())
    expect(DEMO_EXAMPLES.filter((e) => e.group === 'Form walkthrough')).toHaveLength(2)
    expect(DEMO_EXAMPLES[0]).toMatchObject({ label: 'Full Suite', path: '/Example Projects/Full Suite.camproject' })
    expect(DEMO_EXAMPLES.some((e) => /Feature Tour/.test(e.label + e.path))).toBe(false)
    expect(DEMO_EXAMPLES.every((e) => e.path.endsWith('.camproject'))).toBe(true)
    expect(DEMO_EXAMPLES.some((e) => /Sample Parts|\.stl/i.test(e.path))).toBe(false)
    render(<ProjectStartupFlow />)
    await screen.findByRole('dialog', { name: 'Try an example' })
    const dialog = screen.getByRole('dialog', { name: 'Try an example' })
    expect(Array.from(dialog.querySelectorAll('.machine-choice-name'), (element) => element.textContent))
      .toEqual(DEMO_EXAMPLES.map((example) => example.label))
    expect(Array.from(dialog.querySelectorAll('[data-example-url]'), (element) => element.getAttribute('data-example-url')))
      .toEqual(DEMO_EXAMPLES.map((example) => demoExampleAssetUrl(example.path, example.url)))
  })

  it('loads a shipped file with the production opener and explicitly uses the generic starter', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => fixture })
    vi.stubGlobal('fetch', fetchMock)
    const load = vi.spyOn(useCamStore.getState(), 'loadProjectFromFile')
    act(() => useCamStore.setState({ machineLibrary: [createSampleMachine(), real] }))
    render(<ProjectStartupFlow />)
    fireEvent.click(await screen.findByRole('button', { name: /Fixture Plate/ }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Try an example' })).toBeNull())
    const example = DEMO_EXAMPLES.find((e) => e.label === 'Fixture Plate')!
    expect(fetchMock).toHaveBeenCalledWith(demoExampleAssetUrl(example.path, example.url))
    expect(load).toHaveBeenCalledOnce()
    const project = useCamStore.getState().project
    expect(project.id).toBe(JSON.parse(fixture).id)
    expect(project.geometry.length).toBeGreaterThan(0)
    expect(project.machine).toEqual(createSampleMachine())
    expect(useCamStore.getState().machineChoiceRequired).toBe(false)
    expect(useCamStore.getState().machineLibrary).toContainEqual(real)
    // A later unrelated open still follows the original machine-choice route.
    act(() => useCamStore.setState({ project: { ...project, id: 'another-project', machine: { ...real, id: 'foreign' } } }))
    await screen.findByText('Choose a machine for this project')
  })

  it('desktop first open shows only the original machine-choice flow', async () => {
    vi.stubEnv('VITE_DEMO_BUILD', '')
    act(() => useCamStore.setState({ machineLibrary: [createSampleMachine(), real] }))
    render(<ProjectStartupFlow />)
    await screen.findByText('Choose a machine for this project')
    expect(screen.queryByRole('dialog', { name: 'Try an example' })).toBeNull()
    fireEvent.click(screen.getByText('Use this machine'))
    expect(useCamStore.getState().project.machine.id).toBe('operator')
  })

  it('desktop with only the starter stays in the normal empty app', () => {
    vi.stubEnv('VITE_DEMO_BUILD', '')
    render(<ProjectStartupFlow />)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(useCamStore.getState().machineChoiceRequired).toBe(false)
  })

  it('dismisses to the empty app and never reopens during the session', async () => {
    const view = render(<ProjectStartupFlow />)
    fireEvent.click(await screen.findByRole('button', { name: 'Start with an empty project' }))
    view.rerender(<ProjectStartupFlow />)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(useCamStore.getState().project.geometry).toHaveLength(0)
  })

  it('skips any restored saved project, including an empty one', () => {
    act(() => useCamStore.setState({ project: { ...initial.project, id: 'saved-empty-project' } }))
    render(<ProjectStartupFlow />)
    expect(screen.queryByRole('dialog', { name: 'Try an example' })).toBeNull()
  })

  it('waits for asynchronous hydration before deciding first open', async () => {
    vi.spyOn(useCamStore.persist, 'hasHydrated').mockReturnValue(false)
    let finish: (() => void) | undefined
    vi.spyOn(useCamStore.persist, 'onFinishHydration').mockImplementation((listener) => {
      finish = () => listener(useCamStore.getState())
      return () => { finish = undefined }
    })
    render(<ProjectStartupFlow />)
    expect(screen.queryByRole('dialog')).toBeNull()
    act(() => {
      useCamStore.setState({ project: { ...initial.project, id: 'opfs-saved-project' } })
      finish!()
    })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('allows Escape dismissal and traps focus inside the picker', async () => {
    render(<ProjectStartupFlow />)
    const dialog = await screen.findByRole('dialog', { name: 'Try an example' })
    expect(dialog.contains(document.activeElement)).toBe(true)
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true })
    expect(document.activeElement?.textContent).toBe('Start with an empty project')
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('contains CAM shortcut keys while the startup dialog is open', async () => {
    const behind = vi.fn()
    window.addEventListener('keydown', behind)
    try {
      render(<ProjectStartupFlow />)
      const dialog = await screen.findByRole('dialog', { name: 'Try an example' })
      fireEvent.keyDown(dialog, { key: 'g' })
      expect(behind).not.toHaveBeenCalled()
    } finally { window.removeEventListener('keydown', behind) }
  })

  it('keeps invalid project files in the picker instead of claiming they opened', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => '{}' })
    vi.stubGlobal('fetch', fetchMock)
    // Startup recovery has no file baseline. Answer the real WO-2704 guard
    // before reaching the invalid-file behavior this test already proves.
    clearProjectSaveBaseline()
    const before = useCamStore.getState().project
    render(<><ProjectStartupFlow /><ConfirmModal /></>)
    fireEvent.click(await screen.findByRole('button', { name: /Fixture Plate/ }))
    await screen.findByTestId('confirm-dialog')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(useCamStore.getState().project).toBe(before)
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect((await screen.findByRole('alert')).textContent).toContain('could not be opened')
    expect(useCamStore.getState().project.id).toBe(initial.project.id)
    expect(useCamStore.getState().project).toBe(before)
    expect(screen.getByRole('dialog', { name: 'Try an example' })).toBeTruthy()
    await waitFor(() => expect(screen.getByRole('button', { name: /Fixture Plate/ }).hasAttribute('disabled')).toBe(false))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps failures visible and supports retry', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({ ok: true, text: async () => fixture })
    vi.stubGlobal('fetch', fetchMock)
    clearProjectSaveBaseline()
    const before = useCamStore.getState().project
    render(<><ProjectStartupFlow /><ConfirmModal /></>)
    fireEvent.click(await screen.findByRole('button', { name: /Fixture Plate/ }))
    await screen.findByTestId('confirm-dialog')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(useCamStore.getState().project).toBe(before)
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect((await screen.findByRole('alert')).textContent).toContain('HTTP 404')
    expect(useCamStore.getState().project.id).toBe(initial.project.id)
    expect(useCamStore.getState().project).toBe(before)
    expect(screen.getByRole('dialog', { name: 'Try an example' })).toBeTruthy()
    await waitFor(() => expect(screen.getByRole('button', { name: /Fixture Plate/ }).hasAttribute('disabled')).toBe(false))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: /Fixture Plate/ }))
    await screen.findByTestId('confirm-dialog')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(useCamStore.getState().project).toBe(before)
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(useCamStore.getState().project.id).toBe(JSON.parse(fixture).id)
    expect(useCamStore.getState().project.geometry.length).toBeGreaterThan(0)
  })
})
