// @vitest-environment jsdom
// WO-2434: the Tool Library dialog's tool list and tool editor sit either side
// of the shared ResizableSplit; the list collapses to its header line and
// opens again; sizes and collapsed state survive a reload of the UI
// preferences. Drives the real modal, not the split in isolation.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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

const {
  ToolLibraryModal, TOOL_LIST_PANE_KEY, TOOL_LIST_PANE_DEFAULT, TOOL_LIST_PANE_MIN, TOOL_LIST_PANE_MAX,
} = await import('../../components/modals/ToolLibraryModal')
const { useCamStore } = await import('../../store')
const { ExportModal } = await import('../../components/modals/ExportModal')
const { openExportWindow } = await import('../../lib/exportCenter')
const { useUiPrefs } = await import('../../store/uiPrefs')
const { PERSISTED_USER_DATA_REGISTRY } = await import('../../store/persistedKeys')
const uiKey = PERSISTED_USER_DATA_REGISTRY.uiPreferences.key

function mkTool(name: string, n: number) {
  return {
    id: crypto.randomUUID(), name, type: 'flat_end_mill' as const,
    diameter: 6, shankDiameter: 6, overallLength: 50, fluteLength: 18, shoulderLength: 0,
    numberOfFlutes: 2, cornerRadius: 0, angleFromAxisDeg: 59,
    material: 'carbide' as const, coating: 'none' as const, toolNumber: n, notes: '',
    feedsAndSpeeds: { default: { rpm: 18000, feedRate: 1500, plungeRate: 500, depthOfCut: 1.5, stepover: 3, coolant: 'none' as const } },
  }
}

function pointer(type: string, init: { clientX?: number; pointerId?: number }) {
  const Ctor = (window as unknown as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? MouseEvent
  const event = new Ctor(type, { bubbles: true, cancelable: true, clientX: init.clientX ?? 0, button: 0 })
  Object.defineProperty(event, 'pointerId', { value: init.pointerId ?? 1 })
  return event
}

const bar = () => screen.getByTestId('tool-library-split-bar')
const listPane = () => (screen.getByTestId('tool-library-split').firstElementChild as HTMLElement)

async function reload() {
  const saved = window.localStorage.getItem(uiKey)
  act(() => { useUiPrefs.setState({ panelSizes: {}, collapsedPropsGroups: {} }) })
  if (saved !== null) window.localStorage.setItem(uiKey, saved)
  await act(async () => { await useUiPrefs.persist.rehydrate() })
}

function open() {
  render(<ToolLibraryModal />)
  act(() => { useCamStore.getState().openModal('tool-library') })
}

beforeEach(() => {
  window.localStorage.clear()
  act(() => {
    useUiPrefs.setState({ panelSizes: {}, collapsedPropsGroups: {} })
    useCamStore.getState().closeModal()
    useCamStore.setState({ toolLibrary: [] })
    useCamStore.getState().addTool(mkTool('Flat A', 101))
    useCamStore.getState().addTool(mkTool('Flat B', 102))
  })
})
afterEach(() => { act(() => { useCamStore.getState().closeModal() }); cleanup(); vi.unstubAllGlobals() })

describe('WO-2434 Tool Library shared panels', () => {
  it('opens at the old layout: 315px list, labelled separator, editor present', () => {
    open()
    expect(bar().getAttribute('role')).toBe('separator')
    expect(bar().getAttribute('aria-label')).toBe('Resize the tool list and tool editor')
    expect(bar().getAttribute('aria-valuenow')).toBe(String(TOOL_LIST_PANE_DEFAULT))
    expect(listPane().style.width).toBe('315px')
    expect(listPane().style.minWidth).toBe(`${TOOL_LIST_PANE_MIN}px`)
    expect(document.querySelector('.tool-editor-col')).not.toBeNull()
  })

  it('scales the list default and bounds with the interface scale (150%)', () => {
    act(() => { useUiPrefs.getState().setUiScale(1.5) })
    try {
      open()
      expect(listPane().style.width).toBe(`${Math.round(TOOL_LIST_PANE_DEFAULT * 1.5)}px`)
      expect(listPane().style.minWidth).toBe(`${Math.round(TOOL_LIST_PANE_MIN * 1.5)}px`)
      fireEvent(bar(), pointer('pointerdown', { clientX: 500 }))
      act(() => { window.dispatchEvent(pointer('pointermove', { clientX: -5000 })) })
      expect(listPane().style.width).toBe(`${Math.round(TOOL_LIST_PANE_MIN * 1.5)}px`)
      act(() => { window.dispatchEvent(pointer('pointermove', { clientX: 5000 })) })
      expect(listPane().style.width).toBe(`${Math.round(TOOL_LIST_PANE_MAX * 1.5)}px`)
      act(() => { window.dispatchEvent(pointer('pointerup', {})) })
    } finally {
      act(() => { useUiPrefs.getState().setUiScale(1) })
    }
  })

  it('keeps every control: library scope, list actions, tabs, footer, collapse chevron', async () => {
    open()
    expect(screen.getByTestId('tool-library-scope')).not.toBeNull()
    for (const label of ['New library']) expect(screen.getByLabelText(label)).not.toBeNull()
    for (const txt of ['New', 'Dup', 'Import']) {
      expect(screen.getAllByText(txt).some(el => el.closest('button.machine-list-btn'))).toBe(true)
    }
    for (const txt of ['General', 'Cutter', 'Cutting Data', 'Post']) {
      expect(screen.getByText(txt).closest('button.tool-tab')).not.toBeNull()
    }
    expect(screen.getByText('Delete')).not.toBeNull()
    expect(screen.getByTestId('tool-list-collapse').getAttribute('aria-expanded')).toBe('true')
    // WO-2449 moved CSV to the central Export window; both tools still export.
    const save = vi.fn(async (_name: string, _data: string | Uint8Array) => 'saved')
    vi.stubGlobal('liencamHost', { saveFile: save })
    render(<ExportModal />)
    act(() => { openExportWindow('tools') })
    expect(screen.getByTestId('export-format-tools').textContent).toContain('CSV')
    await act(async () => { fireEvent.click(screen.getByTestId('export-save-tools')) })
    expect(save).toHaveBeenCalledOnce()
    expect(save.mock.lastCall![0]).toBe('tool_library.csv')
    expect(save.mock.lastCall![1]).toContain('Flat A')
    expect(save.mock.lastCall![1]).toContain('Flat B')
  })

  it('drags the bar, steps it with arrows, resets on double-click, and stops at the bounds', () => {
    open()
    fireEvent(bar(), pointer('pointerdown', { clientX: 400 }))
    act(() => { window.dispatchEvent(pointer('pointermove', { clientX: 470 })) })
    expect(listPane().style.width).toBe('385px')
    act(() => { window.dispatchEvent(pointer('pointermove', { clientX: 5000 })) })
    expect(listPane().style.width).toBe(`${TOOL_LIST_PANE_MAX}px`)
    act(() => { window.dispatchEvent(pointer('pointermove', { clientX: -5000 })) })
    expect(listPane().style.width).toBe(`${TOOL_LIST_PANE_MIN}px`)
    act(() => { window.dispatchEvent(pointer('pointerup', {})) })

    fireEvent.doubleClick(bar())
    expect(listPane().style.width).toBe('315px')
    fireEvent.keyDown(bar(), { key: 'ArrowRight' })
    expect(listPane().style.width).toBe('323px')
    fireEvent.keyDown(bar(), { key: 'ArrowLeft', shiftKey: true })
    expect(listPane().style.width).toBe('291px')
  })

  it('collapses the tool list to its header and opens it again', () => {
    open()
    expect(screen.getByText('Flat A')).not.toBeNull()
    fireEvent.click(screen.getByTestId('tool-list-collapse'))
    expect(screen.getByTestId('tool-list-collapsed')).not.toBeNull()
    expect(screen.queryByText('Flat A')).toBeNull()
    expect(screen.queryByTestId('tool-library-scope')).toBeNull()
    // The editor keeps working while the list is folded.
    expect(screen.getByText('Cutter').closest('button.tool-tab')).not.toBeNull()
    fireEvent.click(screen.getByTestId('tool-list-collapse'))
    expect(screen.getByText('Flat A')).not.toBeNull()
    expect(screen.getByTestId('tool-library-scope')).not.toBeNull()
  })

  it('sizes and collapsed state come back after a reload', async () => {
    open()
    fireEvent.keyDown(bar(), { key: 'End' })
    expect(listPane().style.width).toBe(`${TOOL_LIST_PANE_MAX}px`)
    fireEvent.click(screen.getByTestId('tool-list-collapse'))
    cleanup()
    await reload()
    expect(useUiPrefs.getState().panelSizes[TOOL_LIST_PANE_KEY]).toBe(TOOL_LIST_PANE_MAX)
    expect(useUiPrefs.getState().collapsedPropsGroups[TOOL_LIST_PANE_KEY]).toBe(true)
    open()
    expect(screen.getByTestId('tool-list-collapsed')).not.toBeNull()
    fireEvent.click(screen.getByTestId('tool-list-collapse'))
    expect(listPane().style.width).toBe(`${TOOL_LIST_PANE_MAX}px`)
  })
})
