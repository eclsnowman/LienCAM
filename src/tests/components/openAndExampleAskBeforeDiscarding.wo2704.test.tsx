// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'

const memory = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  get length() { return memory.size }, clear: () => memory.clear(),
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => memory.set(key, String(value)),
  removeItem: (key: string) => memory.delete(key), key: (i: number) => [...memory.keys()][i] ?? null,
} })
// jsdom lacks IndexedDB; only the binary cache adapter is substituted.
// Project parsing, replacement, save packaging and confirm buttons stay real.
vi.mock('../../lib/stlCache', async () => {
  const { typedMock } = await import('../support/typedMock')
  return typedMock<typeof import('../../lib/stlCache')>({
    cacheSTL: vi.fn().mockResolvedValue(undefined),
    loadCachedSTL: vi.fn().mockResolvedValue(null),
    removeCachedSTL: vi.fn().mockResolvedValue(undefined),
  })
})
const { TopToolbar } = await import('../../components/toolbar/TopToolbar')
const { DemoExamplePickerModal } = await import('../../components/modals/DemoExamplePickerModal')
const { HelpCenterModal } = await import('../../components/modals/HelpCenterModal')
const { ConfirmModal } = await import('../../components/modals/ConfirmModal')
const { useCamStore, liveProjectSaveState } = await import('../../store')
const { openHelpTopic, useHelpOpen } = await import('../../help/helpOpen')
const { clearProjectSaveBaseline } = await import('../../store/projectSaveBaseline')
const currentFile = readFileSync('Example Projects/Adaptive Clearing Shapes.camproject', 'utf8')
const replacementFile = readFileSync('examples/01-fixture-plate/fixture-plate.camproject', 'utf8')
const replacementId = JSON.parse(replacementFile).id
const savedHost = globalThis as typeof globalThis & { liencamHost?: { saveFile: ReturnType<typeof vi.fn> } }
let saveFile: ReturnType<typeof vi.fn>
let fetchFile: ReturnType<typeof vi.fn>
let opened: ReturnType<typeof vi.fn>
const enterModel = useCamStore.getState().enterModelWorkspace

beforeEach(async () => {
  act(() => { useCamStore.setState({ activeModal: null, enterModelWorkspace: vi.fn(async () => {}) }) })
  await act(async () => { await useCamStore.getState().loadProjectFromFile(currentFile) })
  saveFile = vi.fn(async () => '/projects/current.camproject')
  savedHost.liencamHost = { saveFile }
  opened = vi.fn()
  fetchFile = vi.fn(async () => ({ ok: true, text: async () => replacementFile, blob: async () => new Blob(['video']) }))
  vi.stubGlobal('fetch', fetchFile)
  URL.createObjectURL = vi.fn(() => 'blob:video')
  URL.revokeObjectURL = vi.fn()
})
afterEach(() => {
  cleanup()
  act(() => { useCamStore.getState().resolveConfirm(false) })
  useCamStore.setState({ enterModelWorkspace: enterModel })
  useHelpOpen.setState({ overlay: false, requested: null })
  delete savedHost.liencamHost
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
function edit() { act(() => { useCamStore.getState().updateProjectMeta({ name: 'My unsaved work' }) }) }
async function start(route: string) {
  if (route === 'Open') {
    const view = render(<><TopToolbar /><ConfirmModal /></>)
    fireEvent.click(screen.getByRole('button', { name: 'Open project' }))
    fireEvent.change(view.container.querySelector('input[type="file"]')!, {
      target: { files: [new File([replacementFile], 'replacement.camproject', { type: 'application/json' })] },
    })
  } else if (route === 'Try an example') {
    render(<><DemoExamplePickerModal onDismiss={() => {}} onOpened={opened} /><ConfirmModal /></>)
    fireEvent.click(screen.getByRole('button', { name: /Fixture Plate/ }))
  } else {
    render(<><HelpCenterModal /><ConfirmModal /></>)
    act(() => { openHelpTopic('form-walkthrough-grip-handle') })
    fireEvent.click(await screen.findByTestId('help-open-example'))
  }
}
async function choose(button: 'cancel' | 'alt' | 'confirm') {
  const dialog = await screen.findByTestId('confirm-dialog')
  expect(dialog.textContent).toContain('Save changes to "My unsaved work"?')
  expect(screen.getByTestId('confirm-dialog-confirm').textContent).toBe('Save')
  expect(screen.getByTestId('confirm-dialog-alt').textContent).toBe('Discard')
  expect(screen.getByTestId('confirm-dialog-cancel').textContent).toBe('Cancel')
  fireEvent.click(screen.getByTestId(`confirm-dialog-${button}`))
}
async function settled() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) }) }

describe.each(['Open', 'Try an example', 'Help example'])('WO-2704: %s uses the real replacement door', route => {
  it('Cancel preserves the project and starts no project-open lifecycle', async () => {
    edit()
    const before = useCamStore.getState().project
    const begin = vi.spyOn(useCamStore.getState(), 'beginProjectOpen')
    await start(route)
    await choose('cancel')
    await settled()
    expect(useCamStore.getState().project).toBe(before)
    expect(begin).not.toHaveBeenCalled()
    expect(saveFile).not.toHaveBeenCalled()
    if (route === 'Try an example') {
      expect(fetchFile).not.toHaveBeenCalled()
      expect(opened).not.toHaveBeenCalled()
      expect(screen.getByRole('button', { name: /Fixture Plate/ }).hasAttribute('disabled')).toBe(false)
    }
    if (route === 'Help example') expect(useCamStore.getState().activeModal).toBe('help')
  })
  it('Discard replaces the project without a save', async () => {
    edit()
    await start(route)
    await choose('alt')
    await waitFor(() => expect(useCamStore.getState().project.id).toBe(replacementId))
    expect(saveFile).not.toHaveBeenCalled()
    if (route === 'Try an example') expect(opened).toHaveBeenCalledWith(replacementId)
    if (route === 'Help example') expect(useCamStore.getState().activeModal).toBeNull()
  })
  it('Save writes the current content before opening the replacement', async () => {
    edit()
    await start(route)
    await choose('confirm')
    await waitFor(() => expect(useCamStore.getState().project.id).toBe(replacementId))
    expect(saveFile).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(saveFile.mock.calls[0][1])).name).toBe('My unsaved work')
  })
  it.each(['cancelled', 'failed', 'thrown'])('a %s save preserves the project', async outcome => {
    saveFile.mockImplementation(async () => { if (outcome === 'cancelled') return null; throw new Error('disk full') })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const save = outcome === 'failed' ? vi.spyOn(useCamStore.getState(), 'saveProjectToFile').mockResolvedValue('failed') : null
    edit()
    const before = useCamStore.getState().project
    await start(route)
    await choose('confirm')
    await settled()
    expect(useCamStore.getState().project).toBe(before)
    if (save) expect(save).toHaveBeenCalledTimes(1)
    else expect(saveFile).toHaveBeenCalledTimes(1)
    log.mockRestore()
  })
  it('an edit while Save is pending prevents replacement', async () => {
    let finish!: (path: string) => void
    saveFile.mockImplementation(() => new Promise<string>(resolve => { finish = resolve }))
    edit()
    await start(route)
    await choose('confirm')
    await waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1))
    const id = useCamStore.getState().project.id
    act(() => { useCamStore.getState().updateProjectMeta({ name: 'Changed during save' }) })
    await act(async () => { finish('/projects/current.camproject') })
    await settled()
    expect(useCamStore.getState().project.id).toBe(id)
    expect(useCamStore.getState().project.name).toBe('Changed during save')
  })
  it('a clean project opens without a prompt', async () => {
    expect(liveProjectSaveState()).toBe('clean')
    await start(route)
    await waitFor(() => expect(useCamStore.getState().project.id).toBe(replacementId))
    expect(screen.queryByTestId('confirm-dialog')).toBeNull()
    expect(saveFile).not.toHaveBeenCalled()
  })
  it('unknown startup content asks as New does', async () => {
    edit()
    clearProjectSaveBaseline()
    await start(route)
    await choose('cancel')
    await settled()
    expect(useCamStore.getState().project.name).toBe('My unsaved work')
  })
})

describe('WO-2704: Help over an editor yields to the replacement dialog', () => {
  it('keeps Help and the editor open when Escape cancels the confirm', async () => {
    edit()
    const before = useCamStore.getState().project
    act(() => { useCamStore.getState().openModal('settings') })
    await start('Help example')
    await screen.findByTestId('confirm-dialog')
    expect(screen.getByTestId('help-center-backdrop').hasAttribute('inert')).toBe(true)
    expect(screen.getByTestId('help-center-backdrop').getAttribute('data-help-overlay')).toBeNull()
    fireEvent.keyDown(screen.getByTestId('confirm-dialog-cancel'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).toBeNull())
    expect(useCamStore.getState().project).toBe(before)
    expect(useCamStore.getState().activeModal).toBe('settings')
    expect(useHelpOpen.getState().overlay).toBe(true)
    expect(screen.getByTestId('help-center-backdrop').getAttribute('data-help-overlay')).toBe('true')
    expect(screen.getByTestId('help-center-backdrop').hasAttribute('inert')).toBe(false)
  })
})
