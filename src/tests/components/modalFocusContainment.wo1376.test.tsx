// @vitest-environment jsdom
//
// WO-1376: none of the modal-backdrop dialogs moved keyboard focus into
// themselves on open, trapped Tab, or returned focus on close - the backdrop
// blocked the mouse only, so Tab walked to toolbar buttons behind the scrim
// and Enter/Space activated them while a dialog was open (Codex audit
// BUG-484). Drives SettingsModal and ConfirmModal exactly as a real dialog
// opens (a focused control triggers it), rather than a hand-built payload.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'

// jsdom's built-in localStorage is broken under vitest's node launch flags, and
// the Zustand store uses persist() which writes on every set(). Install a
// minimal in-memory Storage shim BEFORE importing the store (mirrors
// SettingsModal.smoke.test.tsx).
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
const { ConfirmModal } = await import('../../components/modals/ConfirmModal')
const { useCamStore } = await import('../../store')

function makeOpener(label: string): HTMLButtonElement {
  const opener = document.createElement('button')
  opener.type = 'button'
  opener.textContent = label
  document.body.appendChild(opener)
  opener.focus()
  expect(document.activeElement).toBe(opener)
  return opener
}

function tabCycle(panel: HTMLElement, shiftKey: boolean, times: number) {
  for (let i = 0; i < times; i++) {
    const active = document.activeElement
    expect(active).not.toBeNull()
    fireEvent.keyDown(active as Element, { key: 'Tab', shiftKey })
    expect(panel.contains(document.activeElement)).toBe(true)
  }
}

beforeEach(() => {
  act(() => { useCamStore.getState().closeModal() })
})

afterEach(() => {
  if (useCamStore.getState().confirmDialog) act(() => useCamStore.getState().resolveConfirm(false))
  cleanup()
  document.body.querySelectorAll('button[data-wo1376-opener]').forEach((el) => el.remove())
})

describe('WO-1376 modal-backdrop dialogs keep keyboard focus inside them', () => {
  it('SettingsModal: focus enters on open, Tab/Shift+Tab never leave it, focus returns to the opener on close', () => {
    const opener = makeOpener('Open Settings')
    opener.setAttribute('data-wo1376-opener', '')

    render(<SettingsModal />)
    expect(screen.queryByTestId('settings-modal-panel')).toBeNull()

    act(() => { useCamStore.getState().openModal('settings') })
    const panel = screen.getByTestId('settings-modal-panel')

    // Acceptance 1: after open, document.activeElement is inside the dialog.
    expect(panel.contains(document.activeElement)).toBe(true)
    expect(document.activeElement).not.toBe(opener)

    tabCycle(panel, false, 20)
    tabCycle(panel, true, 20)

    // Acceptance 2: after close, focus is back on the control that opened it.
    act(() => { useCamStore.getState().closeModal() })
    expect(screen.queryByTestId('settings-modal-panel')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  it('ConfirmModal: focus enters on open (the autoFocus Confirm button), Tab/Shift+Tab never leave it, focus returns to the opener on close', async () => {
    const opener = makeOpener('Open Confirm')
    opener.setAttribute('data-wo1376-opener', '')

    render(<ConfirmModal />)
    const settled: { value: boolean | null } = { value: null }
    act(() => {
      void useCamStore.getState()
        .requestConfirm({ title: 'Delete item?', body: 'x', confirmLabel: 'Delete', tone: 'danger' })
        .then((v: boolean) => { settled.value = v })
    })

    const panel = screen.getByTestId('confirm-dialog')

    // Acceptance 1: the dialog's own autoFocus control (Confirm) wins - the
    // hook must not fight it.
    expect(panel.contains(document.activeElement)).toBe(true)
    expect(document.activeElement).toBe(screen.getByTestId('confirm-dialog-confirm'))

    tabCycle(panel, false, 20)
    tabCycle(panel, true, 20)

    // Acceptance 2: after close, focus is back on the control that opened it.
    act(() => { useCamStore.getState().resolveConfirm(false) })
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByTestId('confirm-dialog')).toBeNull()
    expect(document.activeElement).toBe(opener)
    expect(settled.value).toBe(false)
  })

  it('SettingsModal: opener focused AFTER the dialog is already mounted (real App order), across two open/close cycles', () => {
    // All 14 modal-backdrop dialogs are mounted unconditionally at App boot
    // (App.tsx) - the component instance already exists, closed, before any
    // opener is ever focused. This drives that real order instead of
    // focusing the opener before render(), which the AUDIT found hides a
    // one-time-capture bug: the first open would see whatever had focus at
    // mount time (nothing, in the real app), and every later open would
    // restore focus to nothing at all.
    render(<SettingsModal />)
    expect(screen.queryByTestId('settings-modal-panel')).toBeNull()

    for (let i = 0; i < 2; i++) {
      const opener = makeOpener(`Open Settings ${i}`)
      opener.setAttribute('data-wo1376-opener', '')

      act(() => { useCamStore.getState().openModal('settings') })
      const panel = screen.getByTestId('settings-modal-panel')

      expect(panel.contains(document.activeElement)).toBe(true)
      expect(document.activeElement).not.toBe(opener)

      act(() => { useCamStore.getState().closeModal() })
      expect(screen.queryByTestId('settings-modal-panel')).toBeNull()
      expect(document.activeElement).toBe(opener)

      opener.remove()
    }
  })
})
