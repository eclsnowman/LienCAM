// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { typedMock } from '../support/typedMock'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (key) => mem.get(key) ?? null,
  key: (index) => Array.from(mem.keys())[index] ?? null,
  removeItem: (key) => { mem.delete(key) },
  setItem: (key, value) => { mem.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

vi.mock('../../components/viewport/Viewport', () => typedMock<typeof import('../../components/viewport/Viewport')>({
  Viewport: () => <div data-testid="viewport-stub" />,
}))
vi.mock('../../components/model3d/SolidsWorkbenchPage', () => typedMock<typeof import('../../components/model3d/SolidsWorkbenchPage')>({
  SolidsWorkbenchPage: () => <div data-testid="model-workspace-stub" />,
}))

class ControlledFileReader {
  static instances: ControlledFileReader[] = []
  result: string | ArrayBuffer | null = null
  error: DOMException | null = null
  onload: ((event: ProgressEvent<FileReader>) => void) | null = null
  onerror: ((event: ProgressEvent<FileReader>) => void) | null = null
  onabort: ((event: ProgressEvent<FileReader>) => void) | null = null

  constructor() { ControlledFileReader.instances.push(this) }
  readAsText(): void {}
  succeed(text: string): void {
    this.result = text
    this.onload?.({} as ProgressEvent<FileReader>)
  }
  fail(message: string): void {
    this.error = new DOMException(message, 'NotReadableError')
    this.onerror?.({} as ProgressEvent<FileReader>)
  }
  abortRead(): void { this.onabort?.({} as ProgressEvent<FileReader>) }
}

vi.stubGlobal('FileReader', ControlledFileReader)

const { TopToolbar } = await import('../../components/toolbar/TopToolbar')
const { ConfirmModal } = await import('../../components/modals/ConfirmModal')
const { default: App } = await import('../../App')
const { useCamStore, liveProjectSaveState } = await import('../../store')

afterEach(cleanup)

beforeEach(() => {
  ControlledFileReader.instances = []
  act(() => {
    useCamStore.setState((s) => ({
      project: { ...s.project, id: 'ui85-baseline', name: 'Baseline', geometry: [], setups: [] },
      projectOpen: null,
      workspace: 'cam',
      consoleEvents: [],
      consoleReadThroughId: 0,
    }))
  })
})

function chooseFile(container: HTMLElement, name: string): void {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement
  fireEvent.change(input, { target: { files: [new File(['project'], name)] } })
}

async function chooseFileAndDiscard(container: HTMLElement, name: string): Promise<void> {
  const before = useCamStore.getState().project
  const opening = useCamStore.getState().projectOpen
  const readerCount = ControlledFileReader.instances.length
  // The hand-installed baseline fixture has never been opened or saved.
  expect(liveProjectSaveState()).toBe('unknown')
  chooseFile(container, name)
  await screen.findByTestId('confirm-dialog')
  expect(useCamStore.getState().project).toBe(before)
  expect(useCamStore.getState().projectOpen).toBe(opening)
  expect(ControlledFileReader.instances).toHaveLength(readerCount)
  expect(screen.getByTestId('confirm-dialog-alt').textContent).toBe('Discard')
  fireEvent.click(screen.getByTestId('confirm-dialog-alt'))
  await waitFor(() => expect(ControlledFileReader.instances).toHaveLength(readerCount + 1))
  expect(useCamStore.getState().project).toBe(before)
}

describe('UI-85 FileReader ownership and accessible progress', () => {
  it('starts immediately, ignores a stale reader, and names reader error/abort outcomes', async () => {
    const { container } = render(<><TopToolbar /><ConfirmModal /></>)

    await chooseFileAndDiscard(container, 'old.camproject')
    const oldReader = ControlledFileReader.instances[0]
    const oldRequest = useCamStore.getState().projectOpen?.requestId
    expect(screen.getByTestId('project-open-indicator').textContent).toMatch(/Opening.*Reading project file/)
    expect(screen.getByRole('banner').getAttribute('aria-busy')).toBe('true')

    await chooseFileAndDiscard(container, 'new.camproject')
    const newReader = ControlledFileReader.instances[1]
    const newRequest = useCamStore.getState().projectOpen?.requestId
    expect(newRequest).not.toBe(oldRequest)

    act(() => oldReader.fail('old read failed'))
    expect(useCamStore.getState().projectOpen?.requestId).toBe(newRequest)
    expect(useCamStore.getState().consoleEvents).toHaveLength(0)

    act(() => newReader.abortRead())
    expect(useCamStore.getState().projectOpen).toBeNull()
    expect(useCamStore.getState().consoleEvents.at(-1)).toMatchObject({
      severity: 'warning', source: 'project',
    })
    expect(useCamStore.getState().consoleEvents.at(-1)?.message).toMatch(/canceled.*finished reading/i)

    await chooseFileAndDiscard(container, 'error.camproject')
    act(() => ControlledFileReader.instances[2].fail('disk unavailable'))
    expect(useCamStore.getState().projectOpen).toBeNull()
    expect(useCamStore.getState().consoleEvents.at(-1)).toMatchObject({
      severity: 'error', source: 'project',
    })
    expect(useCamStore.getState().consoleEvents.at(-1)?.message).toMatch(/disk unavailable/i)
  })

  it('New Project invalidates an in-flight file read before its late onload', async () => {
    const { container } = render(<><TopToolbar /><ConfirmModal /></>)
    await chooseFileAndDiscard(container, 'late.camproject')
    const reader = ControlledFileReader.instances[0]
    expect(useCamStore.getState().projectOpen).not.toBeNull()

    act(() => useCamStore.getState().newProject())
    const freshId = useCamStore.getState().project.id
    act(() => reader.succeed(JSON.stringify({ id: 'late-project' })))
    await Promise.resolve()

    expect(useCamStore.getState().project.id).toBe(freshId)
    expect(useCamStore.getState().projectOpen).toBeNull()
  })

  it('shows toolbar progress in both workspaces and accessible CAM footer progress', async () => {
    render(<App />)
    act(() => { useCamStore.getState().beginProjectOpen() })

    const toolbarStatus = screen.getByTestId('project-open-indicator')
    const footerStatus = screen.getByTestId('project-open-footer')
    expect(toolbarStatus.getAttribute('role')).toBe('status')
    expect(toolbarStatus.getAttribute('aria-live')).toBe('polite')
    expect(footerStatus.getAttribute('aria-busy')).toBe('true')
    expect(footerStatus.textContent).toMatch(/Opening - Reading project file/)

    act(() => useCamStore.getState().setWorkspace('part'))
    await waitFor(() => expect(screen.getByTestId('model-workspace-stub')).not.toBeNull())
    expect(screen.getByTestId('project-open-indicator').textContent).toMatch(/Opening.*Reading project file/)
    expect(screen.getByRole('banner').getAttribute('aria-busy')).toBe('true')
  })
})
