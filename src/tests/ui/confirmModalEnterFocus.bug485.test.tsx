// @vitest-environment jsdom
//
// Codex audit BUG-485: Enter on a focused Cancel approved a destructive
// confirm, because ConfirmModal's window keydown handler resolved true on ANY
// Enter. Enter on a focused button is that button's own activation; the
// dialog-wide Enter shortcut applies only when no control has focus.
// Driven through the real ConfirmModal and the store's requestConfirm.

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { ConfirmModal } from '../../components/modals/ConfirmModal'
import { useCamStore } from '../../store'

afterEach(() => {
  if (useCamStore.getState().confirmDialog) act(() => useCamStore.getState().resolveConfirm(false))
  cleanup()
})

function openDeleteConfirm(): { settled: { value: boolean | null } } {
  const settled: { value: boolean | null } = { value: null }
  render(<ConfirmModal />)
  act(() => {
    void useCamStore.getState()
      .requestConfirm({ title: 'Delete model item?', body: 'x', confirmLabel: 'Delete', tone: 'danger' })
      .then((v: boolean) => { settled.value = v })
  })
  return { settled }
}

const flush = () => act(async () => { await Promise.resolve() })

describe('BUG-485 ConfirmModal Enter follows the focused control', () => {
  it('Enter on a focused Cancel never approves; its activation cancels', async () => {
    const { settled } = openDeleteConfirm()
    const cancel = screen.getByTestId('confirm-dialog-cancel')
    cancel.focus()
    fireEvent.keyDown(cancel, { key: 'Enter' })
    await flush()
    expect(settled.value).toBe(null)
    expect(useCamStore.getState().confirmDialog).not.toBe(null)
    // jsdom does not synthesise a button's Enter activation; the browser does.
    fireEvent.click(cancel)
    await flush()
    expect(settled.value).toBe(false)
  })

  it('Enter on the close icon does not approve', async () => {
    const { settled } = openDeleteConfirm()
    const close = screen.getByLabelText('Cancel', { selector: 'button.modal-close-btn' })
    fireEvent.keyDown(close, { key: 'Enter' })
    await flush()
    expect(settled.value).toBe(null)
  })

  it('Enter with no control focused still confirms, Escape still cancels', async () => {
    const first = openDeleteConfirm()
    fireEvent.keyDown(screen.getByTestId('confirm-dialog'), { key: 'Enter' })
    await flush()
    expect(first.settled.value).toBe(true)
    cleanup()

    const second = openDeleteConfirm()
    fireEvent.keyDown(screen.getByTestId('confirm-dialog-cancel'), { key: 'Escape' })
    await flush()
    expect(second.settled.value).toBe(false)
  })
})
