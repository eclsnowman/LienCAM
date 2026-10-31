// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { typedMock } from '../support/typedMock'

// WO-3256: record conservation. Opening, closing or skipping the guide changes
// exactly zero project ids, machines, tools, libraries, holders, appSettings or
// history entries, and persists nothing of its own.
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
const { default: App } = await import('../../App')
const { useCamStore } = await import('../../store')
const { useUiPrefs } = await import('../../store/uiPrefs')
const { useProjectPicker } = await import('../../lib/projectOpen/picker')
const { createSampleMachine } = await import('../../lib/machine/sampleMachine')
const { fmtDim, fmtFeed } = await import('../../lib/ui/unitFormat')
const { useGuidedSetup } = await import('../../components/modals/GuidedSetupModal')
const initial = useCamStore.getInitialState()
const desktopHost = { openProjectFile: vi.fn(async () => null), recentProjects: vi.fn(async () => []) }

function records() {
  const s = useCamStore.getState()
  return {
    projectId: s.project.id, project: s.project, machine: s.project.machine,
    machineLibrary: s.machineLibrary, toolLibrary: s.toolLibrary, toolLibraries: s.toolLibraries,
    holders: s.holders, appSettings: s.appSettings, history: s.projectHistory.length,
  }
}
const tool = (id: string, name: string, n = 101) => ({
  id, name, type: 'flat_end_mill', diameter: 6, shankDiameter: 6, overallLength: 50, fluteLength: 18,
  shoulderLength: 0, numberOfFlutes: 2, cornerRadius: 0, angleFromAxisDeg: 59, material: 'carbide',
  coating: 'none', toolNumber: n, notes: '',
  feedsAndSpeeds: { default: { rpm: 18000, feedRate: 1500, plungeRate: 500, depthOfCut: 1.5, stepover: 3, coolant: 'none' } },
}) as unknown as import('../../types').Tool

beforeEach(() => {
  useGuidedSetup.getState().hide()
  mem.clear()
  useProjectPicker.getState().close()
  vi.stubEnv('VITE_DEMO_BUILD', '')
  vi.stubGlobal('liencamHost', desktopHost)
  act(() => useCamStore.setState({
    project: initial.project, machineLibrary: [createSampleMachine()],
    toolLibrary: [tool('t1', 'Flat 6mm', 101), tool('t2', 'Flat 3mm', 102)],
    machineChoiceRequired: false, activeModal: null, workspace: 'cam', projectOpen: null,
  }))
})
afterEach(() => {
  cleanup()
  useProjectPicker.getState().close()
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks()
})

async function openFromSettings() {
  act(() => useCamStore.getState().openModal('settings'))
  fireEvent.click(await within(await screen.findByTestId('settings-modal-panel')).findByRole('button', { name: 'Guided setup' }))
  return within(await screen.findByRole('dialog', { name: 'Guided setup' }))
}

describe('WO-3256 Guided setup record conservation', () => {
  it.each(['Skip setup', 'Continue to project'])('open + %s + re-entry adds, selects and changes zero records', async (leave) => {
    render(<App />); act(() => useProjectPicker.getState().close())
    const before = records()
    for (let round = 0; round < 2; round++) {
      const dialog = await openFromSettings()
      expect(dialog.getByText('Tools in your library: 2')).toBeTruthy()
      fireEvent.click(dialog.getByRole('button', { name: leave }))
    }
    const after = records()
    expect(after.toolLibrary).toHaveLength(2)
    expect(after).toEqual(before)
    for (const key of Object.keys(before) as (keyof typeof before)[]) expect(after[key], key).toBe(before[key])
  })

  it('visiting each editor and leaving it unsaved changes zero records', async () => {
    render(<App />); act(() => useProjectPicker.getState().close())
    const before = records()
    for (const name of ['Open Settings', 'Open Machine Library', 'Open Tool Library']) {
      fireEvent.click((await openFromSettings()).getByRole('button', { name }))
      act(() => useCamStore.getState().closeModal())
      fireEvent.click(await screen.findByRole('button', { name: 'Skip setup' }))
    }
    const after = records()
    for (const key of Object.keys(before) as (keyof typeof before)[]) expect(after[key], key).toBe(before[key])
  })

  it('shows the live unit facts and leaves canonical millimetre values alone', async () => {
    render(<App />); act(() => useProjectPicker.getState().close())
    await openFromSettings()
    const mmBefore = { thick: useCamStore.getState().appSettings.defaultStockThicknessMm }
    act(() => useCamStore.getState().setDisplayUnits('inch'))
    const dialog = within(screen.getByRole('dialog', { name: 'Guided setup' }))
    expect(dialog.getByText('Display units: inches (in). G-code export units: millimetres (mm).')).toBeTruthy()
    expect(fmtDim(25.4, 'inch')).toBe('1.0000')
    expect(fmtDim(6.35, 'inch')).toBe('0.2500')
    expect(fmtFeed(254, 'inch')).toBe('10.0')
    const settings = useCamStore.getState().appSettings
    expect(settings.exportUnits).toBe('mm')
    expect(Math.abs(settings.defaultStockThicknessMm - mmBefore.thick)).toBeLessThan(1e-9)
  })

  it('persists nothing of its own: no completion bit, no uiPrefs field', async () => {
    render(<App />); act(() => useProjectPicker.getState().close())
    const prefsBefore = JSON.stringify(useUiPrefs.getState(), (_k, v) => typeof v === 'function' ? undefined : v)
    const dialog = await openFromSettings()
    fireEvent.click(dialog.getByRole('button', { name: 'Skip setup' }))
    const prefsAfter = JSON.stringify(useUiPrefs.getState(), (_k, v) => typeof v === 'function' ? undefined : v)
    expect(prefsAfter).toBe(prefsBefore)
    expect([...mem.entries()].filter(([k, v]) => /guided/i.test(k) || /guided/i.test(v))).toEqual([])
  })

  it('an interrupted reload shows no guide, and re-entry lists the same two tools', async () => {
    const view = render(<App />); act(() => useProjectPicker.getState().close())
    await openFromSettings()
    view.unmount()
    cleanup()
    render(<App />); act(() => useProjectPicker.getState().close())
    expect(screen.queryByRole('dialog', { name: 'Guided setup' })).toBeNull()
    expect((await openFromSettings()).getByText('Tools in your library: 2')).toBeTruthy()
  })

  it('a returning profile with a configured machine and tools is never auto-opened', async () => {
    act(() => useCamStore.setState({ project: { ...initial.project, id: 'configured-profile' } }))
    render(<App />); act(() => useProjectPicker.getState().close())
    await screen.findByRole('button', { name: 'Close project picker' }).catch(() => undefined)
    expect(screen.queryByRole('dialog', { name: 'Guided setup' })).toBeNull()
  })
})
