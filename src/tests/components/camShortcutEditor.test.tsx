// @vitest-environment jsdom
//
// WO-3257: the operator-facing side of the editable CAM shortcuts, through the real
// components: Settings -> Keyboard shortcuts, Help -> Keyboard shortcuts (live map and the
// downloadable text), and the tooltip hints in the design tree and the properties panel.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

const { SettingsModal } = await import('../../components/modals/SettingsModal')
const { HelpCenterModal } = await import('../../components/modals/HelpCenterModal')
const { DesignTree } = await import('../../components/panels/DesignTree')
const { PropertiesPanel } = await import('../../components/panels/PropertiesPanel')
const { useGlobalShortcuts } = await import('../../hooks/useGlobalShortcuts')
const { useCamStore } = await import('../../store')
const { useUiPrefs, UI_PREFS_STORAGE_KEY } = await import('../../store/uiPrefs')
const { queryByTooltip } = await import('../support/tooltipQuery')
const { defaultContourParams, defaultHeights, defaultLinking, defaultPasses } = await import(
  '../../components/modals/newOperationModalDefaults'
)
type Setup = import('../../types').Setup
type Operation = import('../../types').Operation
type Tool = import('../../types').Tool

const SELECTED = 'computeOperationToolpath'
const ALL = 'computeAllToolpaths'
const NEWOP = 'openModal:new-operation'

function Host(): null {
  useGlobalShortcuts()
  return null
}

beforeEach(() => {
  mem.clear()
  act(() => {
    useUiPrefs.setState({ camShortcutOverrides: null })
    useCamStore.getState().newProject()
    useCamStore.setState({ activeModal: 'settings', workspace: 'cam' })
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  act(() => {
    useUiPrefs.setState({ camShortcutOverrides: null })
    useCamStore.setState({ activeModal: null })
  })
})

const input = (id: string) => screen.getByTestId(`cam-shortcut-input-${id}`)
const text = (id: string) => input(id).textContent
const stored = () => useUiPrefs.getState().camShortcutOverrides

/** Focus the recording control of one row and press a key in it, as an operator does. */
function record(id: string, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const el = input(id)
  act(() => { el.focus() })
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  act(() => { el.dispatchEvent(event) })
  return event
}

describe('Settings -> Keyboard shortcuts', () => {
  it('lists the three actions with their current keys', () => {
    render(<SettingsModal />)
    expect(screen.queryByTestId('settings-cam-shortcuts')).not.toBeNull()
    expect([text(SELECTED), text(ALL), text(NEWOP)]).toEqual(['G', 'Shift+G', 'N'])
  })

  it('records a letter and changes nothing until Apply', () => {
    render(<SettingsModal />)
    record(SELECTED, 'r')
    expect(text(SELECTED)).toBe('R')
    expect(stored()).toBeNull()
    fireEvent.click(screen.getByTestId(`cam-shortcut-apply-${SELECTED}`))
    expect(stored()).toEqual({ version: 1, bindings: { [SELECTED]: { key: 'r', shift: false } } })
    expect(text(SELECTED)).toBe('R')
  })

  it('records Shift with a letter', () => {
    render(<SettingsModal />)
    record(NEWOP, 'W', { shiftKey: true })
    fireEvent.click(screen.getByTestId(`cam-shortcut-apply-${NEWOP}`))
    expect(text(NEWOP)).toBe('Shift+W')
  })

  it('refuses a key another action has and names that action', () => {
    render(<SettingsModal />)
    record(SELECTED, 'r')
    fireEvent.click(screen.getByTestId(`cam-shortcut-apply-${SELECTED}`))
    record(ALL, 'r')
    fireEvent.click(screen.getByTestId(`cam-shortcut-apply-${ALL}`))
    expect(screen.getByTestId(`cam-shortcut-conflict-${ALL}`).textContent).toMatch(/Generate selected/)
    expect(stored()).toEqual({ version: 1, bindings: { [SELECTED]: { key: 'r', shift: false } } })
    // The attempt stays in the box beside the message until it is changed or cancelled.
    expect(text(ALL)).toBe('R')
    record(ALL, 'Escape')
    expect(text(ALL)).toBe('Shift+G')
  })

  it('refuses a key the other defaults still hold', () => {
    render(<SettingsModal />)
    record(NEWOP, 'G', { shiftKey: true })
    fireEvent.click(screen.getByTestId(`cam-shortcut-apply-${NEWOP}`))
    expect(screen.getByTestId(`cam-shortcut-conflict-${NEWOP}`).textContent).toMatch(/Generate all/)
    expect(stored()).toBeNull()
  })

  it('Enter applies and Escape cancels, and neither closes Settings', () => {
    render(<SettingsModal />)
    const escaped = record(SELECTED, 'Escape')
    expect(escaped.defaultPrevented).toBe(true)
    expect(useCamStore.getState().activeModal).toBe('settings')
    record(SELECTED, 'r')
    expect(text(SELECTED)).toBe('R')
    record(SELECTED, 'Escape')
    expect(text(SELECTED)).toBe('G')
    expect(useCamStore.getState().activeModal).toBe('settings')
    record(SELECTED, 'r')
    const entered = record(SELECTED, 'Enter')
    expect(entered.defaultPrevented).toBe(true)
    expect(useCamStore.getState().activeModal).toBe('settings')
    expect(stored()).toEqual({ version: 1, bindings: { [SELECTED]: { key: 'r', shift: false } } })
  })

  it('Escape outside a recording control still closes Settings', () => {
    render(<SettingsModal />)
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(useCamStore.getState().activeModal).toBeNull()
  })

  it('ignores keys that are not a letter and modifier chords while recording', () => {
    render(<SettingsModal />)
    for (const [key, init] of [['1', {}], ['Delete', {}], ['F5', {}], ['g', { ctrlKey: true }], ['g', { altKey: true }]] as const) record(SELECTED, key, init)
    expect(text(SELECTED)).toBe('G')
    expect(stored()).toBeNull()
  })

  it('runs nothing while recording, even for the keys the actions use', () => {
    const computeOne = vi.fn(async () => {})
    const computeAll = vi.fn(async () => {})
    const openModal = vi.fn()
    act(() => {
      useCamStore.setState((s) => ({
        project: { ...s.project, activeSetupId: 'su1', activeOperationId: 'op1' },
        computeOperationToolpath: computeOne,
        computeAllToolpaths: computeAll,
      }))
    })
    const realOpenModal = useCamStore.getState().openModal
    act(() => { useCamStore.setState({ openModal }) })
    render(<><Host /><SettingsModal /></>)
    record(SELECTED, 'g'); record(NEWOP, 'n'); record(ALL, 'G', { shiftKey: true })
    expect(computeOne).not.toHaveBeenCalled()
    expect(computeAll).not.toHaveBeenCalled()
    expect(openModal).not.toHaveBeenCalled()
    expect(useCamStore.getState().activeModal).toBe('settings')
    act(() => { useCamStore.setState({ openModal: realOpenModal }) })
  })

  it('clears a row, restores a row, and restores all', () => {
    render(<SettingsModal />)
    record(SELECTED, 'r'); fireEvent.click(screen.getByTestId(`cam-shortcut-apply-${SELECTED}`))
    fireEvent.click(screen.getByTestId(`cam-shortcut-clear-${ALL}`))
    expect(text(ALL)).toBe('Unassigned')
    expect(stored()?.bindings[ALL]).toBeNull()
    fireEvent.click(screen.getByTestId(`cam-shortcut-restore-${ALL}`))
    expect(text(ALL)).toBe('Shift+G')
    expect(text(SELECTED)).toBe('R')
    fireEvent.click(screen.getByTestId('cam-shortcut-restore-all'))
    expect([text(SELECTED), text(ALL), text(NEWOP)]).toEqual(['G', 'Shift+G', 'N'])
    expect(stored()).toEqual({ version: 1, bindings: {} })
  })

  it('Restore into a key another row now uses is refused with the same message and changes nothing', () => {
    render(<SettingsModal />)
    record(SELECTED, 'r'); fireEvent.click(screen.getByTestId(`cam-shortcut-apply-${SELECTED}`))
    record(ALL, 'g'); fireEvent.click(screen.getByTestId(`cam-shortcut-apply-${ALL}`))
    fireEvent.click(screen.getByTestId(`cam-shortcut-restore-${SELECTED}`))
    expect(screen.getByTestId(`cam-shortcut-conflict-${SELECTED}`).textContent).toMatch(/Generate all/)
    expect(text(SELECTED)).toBe('R')
    expect(text(ALL)).toBe('G')
  })

  it('a cleared row frees its key for another action', () => {
    render(<SettingsModal />)
    fireEvent.click(screen.getByTestId(`cam-shortcut-clear-${ALL}`))
    record(NEWOP, 'G', { shiftKey: true })
    fireEvent.click(screen.getByTestId(`cam-shortcut-apply-${NEWOP}`))
    expect(text(NEWOP)).toBe('Shift+G')
  })

  it('persists in the UI preferences blob and survives a reload', async () => {
    render(<SettingsModal />)
    record(SELECTED, 'r'); fireEvent.click(screen.getByTestId(`cam-shortcut-apply-${SELECTED}`))
    const blob = JSON.parse(mem.get(UI_PREFS_STORAGE_KEY) ?? '{}') as { state?: { camShortcutOverrides?: unknown } }
    expect(blob.state?.camShortcutOverrides).toEqual({ version: 1, bindings: { [SELECTED]: { key: 'r', shift: false } } })
    const saved = mem.get(UI_PREFS_STORAGE_KEY)!
    act(() => { useUiPrefs.setState({ camShortcutOverrides: null }) })
    mem.set(UI_PREFS_STORAGE_KEY, saved)
    await act(async () => { await useUiPrefs.persist.rehydrate() })
    expect(stored()).toEqual({ version: 1, bindings: { [SELECTED]: { key: 'r', shift: false } } })
  })

  it('keeps a malformed stored blob, shows the defaults, and replaces it only on an edit', async () => {
    mem.set(UI_PREFS_STORAGE_KEY, JSON.stringify({ state: { camShortcutOverrides: { version: 1, bindings: { [SELECTED]: { key: 'g', shift: true } } } }, version: 1 }))
    await act(async () => { await useUiPrefs.persist.rehydrate() })
    render(<SettingsModal />)
    expect([text(SELECTED), text(ALL), text(NEWOP)]).toEqual(['G', 'Shift+G', 'N'])
    expect(stored()).toEqual({ version: 1, bindings: { [SELECTED]: { key: 'g', shift: true } } })
    record(NEWOP, 'm'); fireEvent.click(screen.getByTestId(`cam-shortcut-apply-${NEWOP}`))
    expect(stored()).toEqual({ version: 1, bindings: { [NEWOP]: { key: 'm', shift: false } } })
  })
})

describe('Help -> Keyboard shortcuts', () => {
  async function openHelpTopic() {
    act(() => { useCamStore.setState({ activeModal: 'help' }) })
    render(<HelpCenterModal />)
    await waitFor(() => expect(screen.getByTestId('help-center')).toBeTruthy())
    fireEvent.change(screen.getByTestId('help-search'), { target: { value: 'keyboard' } })
    fireEvent.click(screen.getByTestId('help-topic-keyboard-shortcuts'))
    await waitFor(() => expect(screen.queryByTestId('cam-shortcut-map')).not.toBeNull())
  }
  const row = (id: string) => screen.getByTestId(`cam-shortcut-map-row-${id}`).textContent ?? ''

  it('shows the map in force, and follows a remap while open', async () => {
    await openHelpTopic()
    expect(row(SELECTED)).toMatch(/G$/)
    expect(row(ALL)).toMatch(/Shift\+G$/)
    expect(row(NEWOP)).toMatch(/N$/)
    act(() => { useUiPrefs.getState().setCamShortcutBinding(SELECTED, { key: 'r', shift: false }) })
    expect(row(SELECTED)).toMatch(/R$/)
    act(() => { useUiPrefs.getState().setCamShortcutBinding(NEWOP, null) })
    expect(row(NEWOP)).toMatch(/Unassigned$/)
  })

  it('downloads the printable text with the current keys and releases the object URL', async () => {
    act(() => { useUiPrefs.getState().setCamShortcutBinding(SELECTED, { key: 'r', shift: false }) })
    await openHelpTopic()
    let blob: Blob | null = null
    const create = vi.fn((b: Blob) => { blob = b; return 'blob:cam-shortcuts' })
    const revoke = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { value: create, configurable: true, writable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: revoke, configurable: true, writable: true })
    const clicked: HTMLAnchorElement[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicked.push(this) })
    fireEvent.click(screen.getByTestId('cam-shortcut-map-download'))
    expect(create).toHaveBeenCalledTimes(1)
    const body = await new Promise<string>((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.readAsText(blob!)
    })
    expect(body).toMatch(/Generate selected operation: R/)
    expect(body).toMatch(/Generate all toolpaths: Shift\+G/)
    expect(body).toMatch(/New operation: N/)
    expect(clicked[0]?.getAttribute('download')).toMatch(/\.txt$/)
    await waitFor(() => expect(revoke).toHaveBeenCalledWith('blob:cam-shortcuts'))
  })
})

const TOOL = {
  id: 't1', name: 'Flat 6mm', type: 'flat_end_mill', diameter: 6,
  fluteLength: 20, shankDiameter: 6, overallLength: 50, numberOfFlutes: 2,
} as unknown as Tool

function seedSetupWithOp(): void {
  act(() => {
    useCamStore.setState((s) => ({
      toolLibrary: [TOOL],
      project: {
        ...s.project,
        setups: [{
          id: 'su1', name: 'Setup A',
          wcs: {
            id: 'w1', label: 'G54', fixtureOffset: 54,
            origin: { x: 0, y: 0, z: 0 },
            xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
          },
          operations: [{
            id: 'op1', name: 'Contour 1', type: 'contour_2d', enabled: true,
            status: 'pending', toolId: 't1', geometrySelections: [],
            heights: { ...defaultHeights }, passes: { ...defaultPasses }, linking: { ...defaultLinking },
            params: { ...defaultContourParams },
          } as unknown as Operation],
          notes: '',
        } as unknown as Setup],
        activeSetupId: 'su1',
        activeOperationId: 'op1',
      },
      activeModal: null,
    }))
    useUiPrefs.setState({ treeSetupsExpanded: true, expandedSetupIds: ['su1'] })
  })
}

describe('tooltip hints read the map in force', () => {
  it('design tree: add operation, generate all and compute toolpath', () => {
    seedSetupWithOp()
    render(<DesignTree />)
    expect(queryByTooltip('Add operation (N)')).not.toBeNull()
    expect(queryByTooltip('Regenerate all toolpaths (Shift+G)')).not.toBeNull()
    expect(queryByTooltip('Compute toolpath (G)')).not.toBeNull()
    act(() => {
      useUiPrefs.getState().setCamShortcutBinding(SELECTED, { key: 'r', shift: false })
      useUiPrefs.getState().setCamShortcutBinding(ALL, { key: 'y', shift: true })
      useUiPrefs.getState().setCamShortcutBinding(NEWOP, null)
    })
    expect(queryByTooltip('Compute toolpath (R)')).not.toBeNull()
    expect(queryByTooltip('Regenerate all toolpaths (Shift+Y)')).not.toBeNull()
    expect(queryByTooltip('Add operation')).not.toBeNull()
    expect(queryByTooltip('Add operation (N)')).toBeNull()
    expect(queryByTooltip('Compute toolpath (G)')).toBeNull()
  })

  it('properties panel: the compute hint follows the selected-operation key', () => {
    seedSetupWithOp()
    render(<PropertiesPanel />)
    expect(queryByTooltip("Compute (regenerate) this operation's toolpath (G)")).not.toBeNull()
    act(() => { useUiPrefs.getState().setCamShortcutBinding(SELECTED, { key: 'r', shift: false }) })
    expect(queryByTooltip("Compute (regenerate) this operation's toolpath (R)")).not.toBeNull()
    act(() => { useUiPrefs.getState().setCamShortcutBinding(SELECTED, null) })
    expect(queryByTooltip("Compute (regenerate) this operation's toolpath")).not.toBeNull()
  })
})
