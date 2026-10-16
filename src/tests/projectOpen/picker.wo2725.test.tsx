// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { typedMock } from '../support/typedMock'
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn().mockResolvedValue(undefined), loadCachedSTL: vi.fn().mockResolvedValue(null), removeCachedSTL: vi.fn().mockResolvedValue(undefined),
}))
const picture = 'data:image/png;base64,aGVsbG8='
vi.mock('../../lib/projectOpen/thumbnail', () => typedMock<typeof import('../../lib/projectOpen/thumbnail')>({ captureProjectThumbnail: vi.fn(async () => 'data:image/png;base64,aGVsbG8=') }))
const { DemoExamplePickerModal, DEMO_EXAMPLES, ProjectStartupFlow } = await import('../../components/modals/DemoExamplePickerModal')
const { TopToolbar } = await import('../../components/toolbar/TopToolbar')
const { ConfirmModal } = await import('../../components/modals/ConfirmModal')
const { SettingsModal } = await import('../../components/modals/SettingsModal')
const { HelpCenterModal } = await import('../../components/modals/HelpCenterModal')
const { useCamStore, liveProjectSaveState } = await import('../../store')
const { useUiPrefs } = await import('../../store/uiPrefs')
const { useProjectPicker } = await import('../../lib/projectOpen/picker')
const { openProjectText } = await import('../../lib/projectOpen/actions')
const { projectThumbnail } = await import('../../lib/projectOpen/host')
const current = readFileSync('Example Projects/Adaptive Clearing Shapes.camproject', 'utf8')
const replacement = readFileSync('examples/01-fixture-plate/fixture-plate.camproject', 'utf8')
const replacementId = JSON.parse(replacement).id
let host: ReturnType<typeof makeHost>
function makeHost() {
  return {
    openProjectFile: vi.fn(async () => ({ path: 'C:/parts/plate.camproject', text: replacement })),
    recentProjects: vi.fn(async () => [
      { path: 'C:/parts/plate.camproject', name: 'Plate', openedAt: '2026-10-10T12:00:00.000Z', thumbnail: picture },
      { path: 'C:/parts/missing.camproject', name: 'Missing', openedAt: '2026-10-09T12:00:00.000Z', missing: true },
    ]),
    rememberProject: vi.fn(async () => {}), removeRecentProject: vi.fn(async () => {}),
    saveFile: vi.fn(async (_name: string, _data: string | Uint8Array): Promise<string | null> => 'C:/parts/saved.camproject'),
  }
}
beforeEach(async () => {
  await act(async () => { await useCamStore.getState().loadProjectFromFile(current) })
  useCamStore.setState({ activeModal: null, machineChoiceRequired: false })
  useUiPrefs.getState().setProjectOpenDirectly(false)
  useProjectPicker.getState().close()
  host = makeHost()
  vi.stubGlobal('liencamHost', host)
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => replacement })))
})
afterEach(() => {
  cleanup()
  useCamStore.getState().resolveConfirm(false)
  useProjectPicker.getState().close()
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})
function picker() {
  const opened = vi.fn()
  render(<><DemoExamplePickerModal onDismiss={() => {}} onOpened={opened} /><ConfirmModal /></>)
  return opened
}
async function choose(choice: 'cancel' | 'alt' | 'confirm') {
  await screen.findByTestId('confirm-dialog')
  fireEvent.click(screen.getByTestId(`confirm-dialog-${choice}`))
}
it('lists cached desktop pictures, folder and missing-file removal without reading any project', async () => {
  picker()
  await screen.findByText('Plate')
  expect(host.openProjectFile).not.toHaveBeenCalled()
  expect(screen.getAllByText('C:/parts', { selector: '.project-folder' })[0]).toBeTruthy()
  expect(screen.getByTitle('C:/parts/missing.camproject').hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Remove Missing from list' }))
  await waitFor(() => expect(host.removeRecentProject).toHaveBeenCalledWith('C:/parts/missing.camproject'))
  expect(document.querySelector('.project-recent img')?.getAttribute('src')).toBe(picture)
})
it('web exposes Examples and Browse without path recents; Full Suite is first', () => {
  vi.stubGlobal('liencamHost', undefined)
  picker()
  expect(screen.queryByText('Recent projects')).toBeNull()
  expect(screen.getByRole('button', { name: 'Browse...' })).toBeTruthy()
  expect(DEMO_EXAMPLES[0].label).toBe('Full Suite')
  expect(document.querySelector('.project-example-card')?.textContent).toContain('Full Suite')
})
it('returning users see recents first and can reveal and collapse examples', async () => {
  picker()
  await screen.findByText('Plate')
  expect(screen.queryByRole('button', { name: /Full Suite/ })).toBeNull()
  expect(screen.getByRole('button', { name: 'Show examples' }).getAttribute('aria-expanded')).toBe('false')
  expect(screen.getByRole('button', { name: 'Browse...' }).classList.contains('project-picker-browse')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Examples' }))
  expect(screen.getByRole('button', { name: /Full Suite/ })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Hide examples' }))
  expect(screen.queryByRole('button', { name: /Full Suite/ })).toBeNull()
})
it('first-time desktop visitors keep examples visible after recents load', async () => {
  host.recentProjects.mockResolvedValueOnce([])
  picker()
  expect(await screen.findByRole('button', { name: /Full Suite/ })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Hide examples' }).getAttribute('aria-expanded')).toBe('true')
})
it('the explicit Help Examples route stays expanded for returning users', async () => {
  render(<DemoExamplePickerModal initialSection="examples" onDismiss={() => {}} onOpened={() => {}} />)
  await screen.findByText('Plate')
  expect(screen.getByRole('button', { name: /Full Suite/ })).toBeTruthy()
})
it('toolbar opens the shared window; the preference bypasses it and Settings turns it off', async () => {
  render(<><TopToolbar /><ProjectStartupFlow /><SettingsModal /></>)
  fireEvent.click(screen.getByRole('button', { name: 'Open project' }))
  await screen.findByRole('dialog', { name: 'Open a project' })
  fireEvent.click(screen.getByRole('checkbox', { name: 'Always go straight to the file browser' }))
  fireEvent.click(screen.getByRole('button', { name: 'Close project picker' }))
  host.openProjectFile.mockResolvedValueOnce(null as never)
  fireEvent.click(screen.getByRole('button', { name: 'Open project' }))
  await waitFor(() => expect(host.openProjectFile).toHaveBeenCalledOnce())
  expect(useProjectPicker.getState().section).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Application settings' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Always go straight to the file browser' }))
  expect(useUiPrefs.getState().projectOpenDirectly).toBe(false)
})
it('both Help entry points open the shared picker on Examples even when bypass is enabled', () => {
  useUiPrefs.getState().setProjectOpenDirectly(true)
  useCamStore.getState().openModal('help')
  render(<HelpCenterModal />)
  const buttons = screen.getAllByRole('button', { name: 'Open an example project' })
  expect(buttons).toHaveLength(2)
  fireEvent.click(buttons[0])
  expect(useProjectPicker.getState().section).toBe('examples')
  expect(useCamStore.getState().activeModal).toBeNull()
})
it('browse cancellation keeps the picker and original project', async () => {
  host.openProjectFile.mockResolvedValueOnce(null as never)
  const before = useCamStore.getState().project
  const opened = picker()
  fireEvent.click(screen.getByRole('button', { name: 'Browse...' }))
  await waitFor(() => expect(host.openProjectFile).toHaveBeenCalledOnce())
  expect(opened).not.toHaveBeenCalled()
  expect(useCamStore.getState().project).toBe(before)
})
describe.each(['recent', 'browse', 'example'])('%s preserves the real unsaved-work guard', (route) => {
  async function start() {
    act(() => useCamStore.getState().updateProjectMeta({ name: 'Unsaved work' }))
    const opened = picker()
    if (route === 'example') fireEvent.click(screen.getByRole('button', { name: 'Examples' }))
    if (route === 'recent') fireEvent.click(await screen.findByTitle('C:/parts/plate.camproject'))
    else fireEvent.click(screen.getByRole('button', { name: route === 'browse' ? 'Browse...' : /Fixture Plate/ }))
    return opened
  }
  it('Cancel retains changes, starts no replacement, and writes no recent', async () => {
    const opened = await start()
    await choose('cancel')
    await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).toBeNull())
    expect(useCamStore.getState().project.name).toBe('Unsaved work')
    expect(useCamStore.getState().projectOpen).toBeNull()
    expect(opened).not.toHaveBeenCalled()
    expect(host.rememberProject).not.toHaveBeenCalled()
  })
  it('Discard opens the selected project; only disk files enter Recents', async () => {
    const opened = await start()
    await choose('alt')
    await waitFor(() => expect(opened).toHaveBeenCalled())
    expect(useCamStore.getState().project.id).toBe(replacementId)
    expect(host.saveFile).not.toHaveBeenCalled()
    expect(host.rememberProject).toHaveBeenCalledTimes(route === 'example' ? 0 : 1)
  })
  it('Save captures the edited project and picture before replacement', async () => {
    const opened = await start()
    await choose('confirm')
    await waitFor(() => expect(opened).toHaveBeenCalled())
    const saved = JSON.parse(String(host.saveFile.mock.calls[0]?.[1]))
    expect(saved.name).toBe('Unsaved work')
    expect(saved.thumbnail).toBe(picture)
    expect(host.rememberProject).toHaveBeenCalledWith(expect.objectContaining({ path: 'C:/parts/saved.camproject', thumbnail: picture }))
  })
  it('a cancelled save preserves all edits and never replaces', async () => {
    host.saveFile.mockResolvedValue(null)
    const opened = await start()
    await choose('confirm')
    await waitFor(() => expect(host.saveFile).toHaveBeenCalled())
    expect(opened).not.toHaveBeenCalled()
    expect(useCamStore.getState().project.name).toBe('Unsaved work')
    expect(host.rememberProject).not.toHaveBeenCalled()
  })
})
describe.each(['recent', 'browse'])('%s reopens the current disk path after the unsaved-work decision', (route) => {
  const path = 'C:/parts/plate.camproject'
  async function start() {
    await act(async () => { await useCamStore.getState().loadProjectFromFile(replacement) })
    let disk = replacement
    host.openProjectFile.mockImplementation(async () => ({ path, text: disk }))
    host.saveFile.mockImplementation(async (_name, data) => {
      disk = String(data)
      return path
    })
    act(() => useCamStore.getState().updateProjectMeta({ name: 'Same-path unsaved edit' }))
    const opened = picker()
    if (route === 'recent') fireEvent.click(await screen.findByTitle(path))
    else fireEvent.click(screen.getByRole('button', { name: 'Browse...' }))
    await screen.findByTestId('confirm-dialog')
    return { opened, disk: () => JSON.parse(disk) }
  }
  it('Save then reopen loads the just-saved contents from the same path', async () => {
    const { opened, disk } = await start()
    await choose('confirm')
    await waitFor(() => expect(opened).toHaveBeenCalledOnce())
    expect(host.saveFile).toHaveBeenCalledOnce()
    expect(disk().name).toBe('Same-path unsaved edit')
    expect(useCamStore.getState().project.name).toBe(disk().name)
    expect(liveProjectSaveState()).toBe('clean')
    expect(host.openProjectFile).toHaveBeenCalledExactlyOnceWith(route === 'recent' ? path : undefined)
  })
  it('Cancel reads nothing and keeps the edited project', async () => {
    const { opened } = await start()
    expect(host.openProjectFile).not.toHaveBeenCalled()
    await choose('cancel')
    await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).toBeNull())
    expect(host.openProjectFile).not.toHaveBeenCalled()
    expect(opened).not.toHaveBeenCalled()
    expect(useCamStore.getState().project.name).toBe('Same-path unsaved edit')
  })
  it('Discard reads the existing disk contents only after the choice', async () => {
    const { opened, disk } = await start()
    expect(host.openProjectFile).not.toHaveBeenCalled()
    await choose('alt')
    await waitFor(() => expect(opened).toHaveBeenCalledOnce())
    expect(host.saveFile).not.toHaveBeenCalled()
    expect(useCamStore.getState().project.name).toBe(disk().name)
  })
  it('cancelling Save reads nothing and preserves the edited project', async () => {
    const { opened } = await start()
    host.saveFile.mockResolvedValue(null)
    await choose('confirm')
    await waitFor(() => expect(host.saveFile).toHaveBeenCalledOnce())
    expect(host.openProjectFile).not.toHaveBeenCalled()
    expect(opened).not.toHaveBeenCalled()
    expect(useCamStore.getState().project.name).toBe('Same-path unsaved edit')
  })
})
it('rejects a malformed file without promoting its recent entry', async () => {
  const before = useCamStore.getState().project
  await expect(openProjectText('{}', 'C:/parts/bad.camproject')).rejects.toThrow('could not be opened')
  expect(useCamStore.getState().project).toBe(before)
  expect(host.rememberProject).not.toHaveBeenCalled()
})
it('file-only thumbnails stay outside dirty comparisons and reject external image URLs', async () => {
  await openProjectText(JSON.stringify({ ...JSON.parse(replacement), thumbnail: picture }), 'C:/parts/plate.camproject')
  expect(liveProjectSaveState()).toBe('clean')
  expect(useCamStore.getState().project).not.toHaveProperty('thumbnail')
  expect(host.rememberProject).toHaveBeenCalledWith(expect.objectContaining({ thumbnail: picture }))
  expect(projectThumbnail('https://example.com/tracking.png')).toBeUndefined()
  expect(projectThumbnail('data:image/svg+xml;base64,abcd')).toBeUndefined()
  expect(projectThumbnail(`data:image/png;base64,${'A'.repeat(400_000)}`)).toBeUndefined()
})

it('ships a generated picture for every bundled example', () => {
  expect(DEMO_EXAMPLES.length).toBeGreaterThan(0)
  expect(DEMO_EXAMPLES.every((example) => typeof example.thumbnail === 'string')).toBe(true)
})
