// @vitest-environment jsdom
// WO-2436: the Machine Library dialog's list/editor split uses the shared
// ResizableSplit + collapse toggle. Drives the real modal: drag, arrow keys,
// double-click reset, collapse/reopen, reload of the UI prefs, control census.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'

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

const { MachineLibraryModal, MACHINE_LIST_PANEL_KEY, MACHINE_LIST_COLLAPSE_KEY } =
  await import('../../components/modals/MachineLibraryModal')
const { useCamStore } = await import('../../store')
const { useUiPrefs } = await import('../../store/uiPrefs')
const { PERSISTED_USER_DATA_REGISTRY } = await import('../../store/persistedKeys')
const uiKey = PERSISTED_USER_DATA_REGISTRY.uiPreferences.key

function pointer(type: string, clientX: number) {
  const Ctor = (window as unknown as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? MouseEvent
  const e = new Ctor(type, { bubbles: true, cancelable: true, clientX, button: 0 })
  Object.defineProperty(e, 'pointerId', { value: 1 })
  return e
}

const bar = () => screen.getByTestId('machine-library-split-bar')
const listPane = () => screen.getByTestId('machine-list-header').closest('.resizable-split-pane') as HTMLElement
const controls = () => document.querySelectorAll('.machine-editor-col button, .machine-editor-col input, .machine-editor-col select, .machine-list-col .machine-list-btn').length

async function reload() {
  const saved = window.localStorage.getItem(uiKey)
  act(() => { useUiPrefs.setState({ panelSizes: {}, collapsedPropsGroups: {} }) })
  if (saved !== null) window.localStorage.setItem(uiKey, saved)
  await act(async () => { await useUiPrefs.persist.rehydrate() })
}

describe('WO-2436 Machine Library resizable / collapsible list', () => {
  beforeEach(() => {
    mem.clear()
    useUiPrefs.setState({ panelSizes: {}, collapsedPropsGroups: {} })
    act(() => { useCamStore.getState().openModal('machine-config') })
    render(<MachineLibraryModal />)
  })
  afterEach(() => { cleanup(); act(() => { useCamStore.getState().closeModal() }) })

  it('defaults to the old layout: 192px list + 8px bar = 200px, no header row above the list', () => {
    expect(listPane().style.width).toBe('192px')
    expect(bar().getAttribute('role')).toBe('separator')
    expect(document.querySelector('.machine-list-col .panel-header')).toBeNull()
  })

  it('scales the default with the UI scale: 200px column x 1.5 = 300px, less the 8px bar', () => {
    cleanup()
    document.documentElement.style.setProperty('--ui-scale', '1.5')
    try {
      render(<MachineLibraryModal />)
      expect(listPane().style.width).toBe('292px')
    } finally {
      document.documentElement.style.removeProperty('--ui-scale')
    }
  })

  it('drags, steps with the arrow keys and double-click resets', () => {
    fireEvent(bar(), pointer('pointerdown', 192))
    act(() => { window.dispatchEvent(pointer('pointermove', 252)) })
    act(() => { window.dispatchEvent(pointer('pointerup', 252)) })
    expect(listPane().style.width).toBe('252px')
    fireEvent.keyDown(bar(), { key: 'ArrowLeft' })
    expect(listPane().style.width).toBe('244px')
    fireEvent.doubleClick(bar())
    expect(listPane().style.width).toBe('192px')
  })

  it('collapses to its header, reopens, keeps every control, and survives a reload', async () => {
    const before = controls()
    const listBtns = document.querySelectorAll('.machine-list-col .machine-list-btn').length
    expect(listBtns).toBeGreaterThan(0)
    fireEvent.keyDown(bar(), { key: 'ArrowRight', shiftKey: true })
    expect(listPane().style.width).toBe('224px')
    fireEvent.click(screen.getByTestId('machine-list-collapse'))
    expect(document.querySelectorAll('.machine-list-col .machine-list-btn').length).toBe(0)
    expect(screen.getByTestId('machine-list-header')).toBeTruthy()
    await reload()
    expect(useUiPrefs.getState().collapsedPropsGroups[MACHINE_LIST_COLLAPSE_KEY]).toBe(true)
    expect(useUiPrefs.getState().panelSizes[MACHINE_LIST_PANEL_KEY]).toBe(224)
    expect(document.querySelectorAll('.machine-list-col .machine-list-btn').length).toBe(0)
    fireEvent.click(screen.getByTestId('machine-list-collapse'))
    expect(controls()).toBe(before)
    expect(listPane().style.width).toBe('224px')
  })
})
