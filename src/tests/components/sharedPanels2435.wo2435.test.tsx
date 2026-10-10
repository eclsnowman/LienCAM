// @vitest-environment jsdom
// WO-2435: the Setup dialog adopts the shared ResizableSplit / collapse toggle
// from WO-2430. Drives the real SetupModal: drag the bar, step it with the
// arrow keys, double-click to reset, collapse the work offset pane and reopen
// it, and reload the UI preferences to show size + collapsed state come back.
// The control census must not change.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

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

const { SetupModal } = await import('../../components/modals/SetupModal')
const { useCamStore } = await import('../../store')
const { useUiPrefs } = await import('../../store/uiPrefs')
const { PERSISTED_USER_DATA_REGISTRY } = await import('../../store/persistedKeys')

const uiKey = PERSISTED_USER_DATA_REGISTRY.uiPreferences.key
const PREF = 'setupModal.wcsPane'

function pointer(type: string, init: { clientX?: number; pointerId?: number }) {
  const Ctor = (window as unknown as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? MouseEvent
  const event = new Ctor(type, { bubbles: true, cancelable: true, clientX: init.clientX ?? 0, button: 0 })
  Object.defineProperty(event, 'pointerId', { value: init.pointerId ?? 1 })
  return event
}

const bar = () => screen.getByTestId('setup-modal-split-bar')
const wcsPane = () => screen.getByTestId('setup-modal-wcs').parentElement as HTMLElement
const controlCount = () =>
  screen.getByTestId('setup-modal-panel').querySelectorAll('input, select, button, textarea').length

async function reload() {
  const saved = window.localStorage.getItem(uiKey)
  act(() => { useUiPrefs.setState({ panelSizes: {}, collapsedPropsGroups: {} }) })
  if (saved !== null) window.localStorage.setItem(uiKey, saved)
  await act(async () => { await useUiPrefs.persist.rehydrate() })
}

function openSetup() {
  act(() => { useCamStore.getState().openModal('new-setup') })
}

describe('WO-2435 Setup dialog shared panels', () => {
  beforeEach(() => {
    window.localStorage.clear()
    useUiPrefs.setState({ panelSizes: {}, collapsedPropsGroups: {} })
    act(() => { useCamStore.getState().closeModal() })
    ;(window as unknown as { innerWidth: number }).innerWidth = 1440
  })
  afterEach(() => { cleanup() })

  it('shows the split at the old default width with every pane present', () => {
    openSetup()
    render(<SetupModal />)
    expect(screen.getByTestId('setup-modal-basics')).toBeTruthy()
    expect(screen.getByTestId('setup-modal-wcs')).toBeTruthy()
    expect(wcsPane().style.width).toBe('390px')
  })

  it('drags, steps with arrows, resets on double-click, and never goes below the 350px minimum', () => {
    openSetup()
    render(<SetupModal />)
    fireEvent(bar(), pointer('pointerdown', { clientX: 500 }))
    fireEvent(window, pointer('pointermove', { clientX: 460 }))
    fireEvent(window, pointer('pointerup', { clientX: 460 }))
    expect(wcsPane().style.width).toBe('430px')
    expect(useUiPrefs.getState().panelSizes[PREF]).toBe(430)

    fireEvent.keyDown(bar(), { key: 'ArrowLeft' })
    expect(wcsPane().style.width).toBe('438px')
    fireEvent.keyDown(bar(), { key: 'ArrowRight', shiftKey: true })
    expect(wcsPane().style.width).toBe('406px')

    fireEvent.keyDown(bar(), { key: 'Home' })
    expect(wcsPane().style.width).toBe('350px')
    fireEvent.keyDown(bar(), { key: 'ArrowRight', shiftKey: true })
    expect(wcsPane().style.width).toBe('350px')

    fireEvent.doubleClick(bar())
    expect(wcsPane().style.width).toBe('390px')
  })

  it('collapses the work offset pane to its header, reopens it, and keeps every control', () => {
    openSetup()
    render(<SetupModal />)
    const expanded = controlCount()
    const toggle = screen.getByTestId('setup-modal-wcs-collapse')
    fireEvent.click(toggle)
    expect(screen.getByTestId('setup-modal-wcs-header')).toBeTruthy()
    expect(screen.getByTestId('setup-modal-wcs-summary').textContent).toContain('G54')
    expect(screen.queryByTestId('setup-second-side-of')).toBeNull()
    expect(screen.getByTestId('setup-modal-basics')).toBeTruthy()
    fireEvent.click(screen.getByTestId('setup-modal-wcs-collapse'))
    expect(screen.queryByTestId('setup-modal-wcs-summary')).toBeNull()
    expect(controlCount()).toBe(expanded)
  })

  it('census: the split layout holds the same controls as the plain one-column layout plus the one chevron', () => {
    openSetup()
    const { unmount } = render(<SetupModal />)
    const split = controlCount()
    unmount()
    ;(window as unknown as { innerWidth: number }).innerWidth = 700
    render(<SetupModal />)
    expect(screen.queryByTestId('setup-modal-split')).toBeNull()
    expect(controlCount() + 1).toBe(split)
  })

  it('scales the pane default and minimum with the UI scale (150%)', () => {
    openSetup()
    act(() => { useUiPrefs.setState({ uiScale: 1.5 }) })
    render(<SetupModal />)
    expect(wcsPane().style.width).toBe('585px')
    expect(wcsPane().style.minWidth).toBe('525px')
    act(() => { useUiPrefs.setState({ uiScale: 1 }) })
  })

  it('keeps an active numeric draft when the layout switches at the breakpoint', () => {
    openSetup()
    render(<SetupModal />)
    const panel = screen.getByTestId('setup-modal-panel')
    const field = Array.from(panel.querySelectorAll('input')).find(
      (el) => el.getAttribute('aria-label')?.toLowerCase().includes('clearance height'),
    ) as HTMLInputElement
    expect(field).toBeTruthy()
    field.focus()
    fireEvent.change(field, { target: { value: '42' } })
    expect(field.value).toBe('42')
    act(() => {
      ;(window as unknown as { innerWidth: number }).innerWidth = 700
      window.dispatchEvent(new Event('resize'))
    })
    expect(screen.queryByTestId('setup-modal-split')).toBeNull()
    expect(field.isConnected).toBe(true)
    expect(field.value).toBe('42')
  })

  it('stacks the panes when the scaled minimums cannot fit the dialog (intermediate width)', () => {
    act(() => { useUiPrefs.setState({ uiScale: 1.5 }) })
    ;(window as unknown as { innerWidth: number }).innerWidth = 1000
    openSetup()
    render(<SetupModal />)
    expect(screen.queryByTestId('setup-modal-split')).toBeNull()
    expect(screen.getByTestId('setup-modal-grid')).toBeTruthy()
    act(() => {
      ;(window as unknown as { innerWidth: number }).innerWidth = 1440
      window.dispatchEvent(new Event('resize'))
    })
    expect(screen.getByTestId('setup-modal-split')).toBeTruthy()
    act(() => { useUiPrefs.setState({ uiScale: 1 }) })
  })

  it('brings size and collapsed state back after a reload', async () => {
    openSetup()
    render(<SetupModal />)
    fireEvent.keyDown(bar(), { key: 'ArrowLeft', shiftKey: true })
    fireEvent.click(screen.getByTestId('setup-modal-wcs-collapse'))
    cleanup()
    await reload()
    render(<SetupModal />)
    expect(useUiPrefs.getState().panelSizes[PREF]).toBe(422)
    expect(screen.getByTestId('setup-modal-wcs-summary')).toBeTruthy()
    fireEvent.click(screen.getByTestId('setup-modal-wcs-collapse'))
    expect(wcsPane().style.width).toBe('422px')
  })
})
