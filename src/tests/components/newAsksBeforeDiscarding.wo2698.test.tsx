// @vitest-environment jsdom
//
// WO-2698 (2026-10-09, newcomer journey D2): with an unsaved project open,
// New in the top toolbar replaced it at once - no prompt, Undo greyed.
//
// Through the REAL toolbar and the REAL themed confirm (both rendered, buttons
// clicked): New on unsaved work asks Save / Discard / Cancel; Cancel keeps the
// project; Discard replaces it; Save replaces it only when the file was written
// and nothing changed while it was being written; a known-clean project (just
// opened, just saved, just started) goes straight to New; a project nobody has
// a baseline for (restored at startup) asks.
//
// Defect proof (RED on main): every "asks" case fails - main's New replaces the
// project with no dialog.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'

// jsdom's built-in localStorage is broken under vitest's node launch flags and
// the Zustand store persists on every set(). Install an in-memory Storage shim
// BEFORE importing the store (same pattern as topToolbarCompactNames.wo1833).
const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { TopToolbar } = await import('../../components/toolbar/TopToolbar')
const { ConfirmModal } = await import('../../components/modals/ConfirmModal')
const { useCamStore } = await import('../../store')
const { createSampleMachine } = await import('../../lib/machine/sampleMachine')
const { DemoExamplePickerModal } = await import('../../components/modals/DemoExamplePickerModal')

type SaveHost = { saveFile: (filename: string, data: string | Uint8Array) => Promise<string | null> }
const hostGlobal = globalThis as typeof globalThis & { liencamHost?: SaveHost }

// Shipped examples, opened the way "Try an example" opens them (sample
// machine, loadProjectFromFile). Full Suite is the journey's project. Its
// embedded part binaries need IndexedDB to SAVE, which jsdom lacks, so the
// Save-path cases use a shipped example that carries no binaries.
const FULL_SUITE = 'Example Projects/Full Suite.camproject'
const SHAPES = 'Example Projects/Adaptive Clearing Shapes.camproject'

async function openExample(file: string): Promise<string> {
  const project = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), file), 'utf8'))
  project.machine = createSampleMachine()
  project.name = 'Full Suite'
  await act(async () => { await useCamStore.getState().loadProjectFromFile(JSON.stringify(project)) })
  const opened = useCamStore.getState().project
  expect(opened.name).toBe('Full Suite')
  return opened.id
}
const openFullSuite = () => openExample(FULL_SUITE)
const openShapes = () => openExample(SHAPES)

/** An ordinary edit to what Save writes. */
function editProject(name = 'Full Suite (edited)'): void {
  act(() => { useCamStore.getState().updateProjectMeta({ name }) })
}

function renderShell() {
  return render(<><TopToolbar /><ConfirmModal /></>)
}

function clickNew(): void {
  fireEvent.click(screen.getByRole('button', { name: 'New project' }))
}

async function dialog(): Promise<HTMLElement> {
  return await screen.findByTestId('confirm-dialog')
}

beforeEach(() => {
  hostGlobal.liencamHost = { saveFile: vi.fn(async () => 'C:/projects/Full_Suite.camproject') }
})

afterEach(() => {
  cleanup()
  act(() => { useCamStore.getState().resolveConfirm(false) })
  delete hostGlobal.liencamHost
})

describe('WO-2698: New asks before discarding unsaved work (real toolbar + themed confirm)', () => {
  it('unsaved project: New asks Save / Discard / Cancel and replaces nothing yet', async () => {
    const id = await openFullSuite()
    editProject()
    renderShell()
    clickNew()
    const d = await dialog()
    expect(d.textContent).toContain('Save changes to "Full Suite (edited)"?')
    expect(screen.getByTestId('confirm-dialog-confirm').textContent).toBe('Save')
    expect(screen.getByTestId('confirm-dialog-alt').textContent).toBe('Discard')
    expect(screen.getByTestId('confirm-dialog-cancel').textContent).toBe('Cancel')
    expect(useCamStore.getState().project.id).toBe(id)
  })

  it('Cancel keeps the whole project untouched', async () => {
    const id = await openFullSuite()
    editProject()
    const before = useCamStore.getState().project
    renderShell()
    clickNew()
    await dialog()
    fireEvent.click(screen.getByTestId('confirm-dialog-cancel'))
    await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).toBeNull())
    expect(useCamStore.getState().project).toBe(before)
    expect(useCamStore.getState().project.id).toBe(id)
    expect(hostGlobal.liencamHost!.saveFile).not.toHaveBeenCalled()
  })

  it('Discard starts the new project without saving', async () => {
    const id = await openFullSuite()
    editProject()
    renderShell()
    clickNew()
    await dialog()
    fireEvent.click(screen.getByTestId('confirm-dialog-alt'))
    await waitFor(() => expect(useCamStore.getState().project.id).not.toBe(id))
    expect(useCamStore.getState().project.geometry).toHaveLength(0)
    expect(hostGlobal.liencamHost!.saveFile).not.toHaveBeenCalled()
  })

  it('Save writes the file through the ordinary Save, then starts the new project', async () => {
    const id = await openShapes()
    editProject()
    renderShell()
    clickNew()
    await dialog()
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'))
    await waitFor(() => expect(useCamStore.getState().project.id).not.toBe(id))
    const saveFile = hostGlobal.liencamHost!.saveFile as ReturnType<typeof vi.fn>
    expect(saveFile).toHaveBeenCalledTimes(1)
    const [filename, data] = saveFile.mock.calls[0]
    expect(filename).toBe('Full_Suite_(edited).camproject')
    expect(JSON.parse(String(data)).name).toBe('Full Suite (edited)')
  })

  it('Save cancelled in the Save dialog keeps the project', async () => {
    hostGlobal.liencamHost = { saveFile: vi.fn(async () => null) }
    const id = await openShapes()
    editProject()
    renderShell()
    clickNew()
    await dialog()
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'))
    await waitFor(() => expect(hostGlobal.liencamHost!.saveFile).toHaveBeenCalledTimes(1))
    await act(async () => { await Promise.resolve() })
    expect(useCamStore.getState().project.id).toBe(id)
    expect(useCamStore.getState().project.name).toBe('Full Suite (edited)')
  })

  it('Save that fails (the write throws) keeps the project', async () => {
    const failure = new Error('disk full')
    hostGlobal.liencamHost = { saveFile: vi.fn(async () => { throw failure }) }
    const id = await openShapes()
    editProject()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      renderShell()
      clickNew()
      await dialog()
      fireEvent.click(screen.getByTestId('confirm-dialog-confirm'))
      await waitFor(() => expect(hostGlobal.liencamHost!.saveFile).toHaveBeenCalledTimes(1))
      await waitFor(() => expect(logged).toHaveBeenCalledWith(failure))
      expect(useCamStore.getState().project.id).toBe(id)
      expect(useCamStore.getState().project.name).toBe('Full Suite (edited)')
    } finally {
      logged.mockRestore()
    }
  })

  it('Save that refuses (a model document cannot be flushed) reports failed and keeps the project', async () => {
    const id = await openFullSuite()
    expect(useCamStore.getState().project.modelItems?.length ?? 0).toBeGreaterThan(0)
    editProject()
    const realFlush = useCamStore.getState().flushModelItemDocument
    act(() => { useCamStore.setState({ flushModelItemDocument: async () => false }) })
    try {
      renderShell()
      clickNew()
      await dialog()
      fireEvent.click(screen.getByTestId('confirm-dialog-confirm'))
      await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).toBeNull())
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      expect(hostGlobal.liencamHost!.saveFile).not.toHaveBeenCalled()
      expect(useCamStore.getState().project.id).toBe(id)
    } finally {
      act(() => { useCamStore.setState({ flushModelItemDocument: realFlush }) })
    }
  })

  it('an edit made while the save is being written keeps the project (it is still unsaved)', async () => {
    let finishWrite: (to: string | null) => void = () => {}
    hostGlobal.liencamHost = { saveFile: vi.fn(() => new Promise<string | null>((r) => { finishWrite = r })) }
    const id = await openShapes()
    editProject()
    renderShell()
    clickNew()
    await dialog()
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'))
    await waitFor(() => expect(hostGlobal.liencamHost!.saveFile).toHaveBeenCalledTimes(1))
    editProject('Full Suite (edited again mid-save)')
    await act(async () => { finishWrite('C:/projects/Full_Suite.camproject') })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(useCamStore.getState().project.id).toBe(id)
    expect(useCamStore.getState().project.name).toBe('Full Suite (edited again mid-save)')
    expect(screen.queryByTestId('confirm-dialog')).toBeNull()
    // ...and the next New still asks, because that edit is not in any file.
    clickNew()
    await dialog()
  })

  it('a project just opened (no edits) goes straight to New, no prompt', async () => {
    const id = await openFullSuite()
    renderShell()
    clickNew()
    await waitFor(() => expect(useCamStore.getState().project.id).not.toBe(id))
    expect(screen.queryByTestId('confirm-dialog')).toBeNull()
  })

  it('Try an example > Full Suite through the real picker, then New: no prompt; after an edit: the prompt', async () => {
    const fullSuite = fs.readFileSync(path.resolve(process.cwd(), FULL_SUITE), 'utf8')
    // Begin the journey with a real untouched new project, independent of
    // the preceding test's file baseline.
    act(() => { useCamStore.getState().newProject() })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => fullSuite }))
    let openedId: string | null = null
    try {
      const picker = render(<><DemoExamplePickerModal onDismiss={() => {}} onOpened={(id) => { openedId = id }} /><ConfirmModal /></>)
      fireEvent.click(await screen.findByRole('button', { name: /Full Suite/ }))
      await waitFor(() => expect(openedId).not.toBeNull())
      expect(screen.queryByTestId('confirm-dialog')).toBeNull()
      picker.unmount()
    } finally {
      vi.unstubAllGlobals()
    }
    hostGlobal.liencamHost = { saveFile: vi.fn(async () => 'C:/projects/Full_Suite.camproject') }
    expect(useCamStore.getState().project.name).toBe('Full Suite')
    const firstId = useCamStore.getState().project.id
    // The journey's step with an edit: New asks.
    editProject()
    renderShell()
    clickNew()
    await dialog()
    fireEvent.click(screen.getByTestId('confirm-dialog-cancel'))
    await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).toBeNull())
    expect(useCamStore.getState().project.id).toBe(firstId)
    cleanup()
    // Re-opened untouched through the same picker: New goes straight through.
    // The unsaved edit survived Cancel, so WO-2704 asks before the re-open.
    const beforeReopen = useCamStore.getState().project
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => fullSuite })
    vi.stubGlobal('fetch', fetchMock)
    openedId = null
    try {
      const picker = render(<><DemoExamplePickerModal onDismiss={() => {}} onOpened={(id) => { openedId = id }} /><ConfirmModal /></>)
      fireEvent.click(await screen.findByRole('button', { name: /Full Suite/ }))
      const d = await dialog()
      expect(d.textContent).toContain('Save changes to "Full Suite (edited)"?')
      expect(useCamStore.getState().project).toBe(beforeReopen)
      expect(fetchMock).not.toHaveBeenCalled()
      expect(openedId).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
      await waitFor(() => expect(openedId).not.toBeNull())
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(hostGlobal.liencamHost!.saveFile).not.toHaveBeenCalled()
      picker.unmount()
    } finally {
      vi.unstubAllGlobals()
    }
    hostGlobal.liencamHost = { saveFile: vi.fn(async () => 'C:/projects/Full_Suite.camproject') }
    const reopenedId = useCamStore.getState().project.id
    renderShell()
    clickNew()
    await waitFor(() => expect(useCamStore.getState().project.id).not.toBe(reopenedId))
    expect(screen.queryByTestId('confirm-dialog')).toBeNull()
  })

  it('a project just saved with the toolbar Save goes straight to New, no prompt', async () => {
    const id = await openShapes()
    editProject()
    renderShell()
    fireEvent.click(screen.getByRole('button', { name: 'Save project' }))
    await waitFor(() => expect(hostGlobal.liencamHost!.saveFile).toHaveBeenCalledTimes(1))
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    clickNew()
    await waitFor(() => expect(useCamStore.getState().project.id).not.toBe(id))
    expect(screen.queryByTestId('confirm-dialog')).toBeNull()
  })

  it('a fresh, untouched new project goes straight to New, no prompt', async () => {
    act(() => { useCamStore.getState().newProject() })
    const id = useCamStore.getState().project.id
    renderShell()
    clickNew()
    await waitFor(() => expect(useCamStore.getState().project.id).not.toBe(id))
    expect(screen.queryByTestId('confirm-dialog')).toBeNull()
  })

  it('a project with no known baseline (restored at startup) asks', async () => {
    await openFullSuite()
    // A restore installs a project without passing through open / new / save.
    const restored = { ...useCamStore.getState().project, id: 'restored-from-browser-storage' }
    act(() => { useCamStore.setState({ project: restored }) })
    renderShell()
    clickNew()
    await dialog()
    expect(useCamStore.getState().project.id).toBe('restored-from-browser-storage')
  })

  it('two-button confirms are unchanged: no third button, boolean answers', async () => {
    renderShell()
    let answer: boolean | undefined
    act(() => { void useCamStore.getState().requestConfirm({ title: 'Delete this?' }).then((ok) => { answer = ok }) })
    await dialog()
    expect(screen.queryByTestId('confirm-dialog-alt')).toBeNull()
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'))
    await waitFor(() => expect(answer).toBe(true))
  })
})
