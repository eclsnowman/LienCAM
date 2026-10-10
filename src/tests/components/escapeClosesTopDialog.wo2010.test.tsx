// @vitest-environment jsdom
//
// WO-2010: Escape closes the TOPMOST dialog. Macro editor over Machine actions:
// one Escape closes the editor, the second closes Machine actions. Model entry
// closes on Escape. Machine choice is forced-choice (no X) and stays open.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

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

const { useCamStore } = await import('../../store')
const { MachineActionsModal } = await import('../../components/machine/MachineActionsModal')
const { ModelEntryModal } = await import('../../components/modals/ModelEntryModal')

function Host() {
  const [open, setOpen] = useState(true)
  return <MachineActionsModal open={open} onClose={() => setOpen(false)} />
}

const backdrops = () => document.querySelectorAll('.modal-backdrop').length
const escape = () => act(() => { fireEvent.keyDown(window, { key: 'Escape' }) })

afterEach(() => {
  cleanup()
  useCamStore.getState().closeModal()
})

describe('WO-2010 Escape closes the top dialog', () => {
  it('macro editor over Machine actions: Escape x2 closes the editor, then Machine actions', () => {
    render(<Host />)
    expect(backdrops()).toBe(1)
    fireEvent.click(screen.getByTestId('control-action-add'))
    expect(backdrops()).toBe(2)
    expect(screen.getByTestId('macro-editor-modal')).toBeTruthy()

    escape()
    expect(backdrops()).toBe(1)
    expect(screen.queryByTestId('macro-editor-modal')).toBeNull()
    expect(screen.getByTestId('control-actions-modal')).toBeTruthy()

    escape()
    expect(backdrops()).toBe(0)
  })

  it('Machine actions alone closes on Escape', () => {
    render(<Host />)
    escape()
    expect(backdrops()).toBe(0)
  })

  it('Model entry closes on Escape', () => {
    render(<ModelEntryModal />)
    expect(backdrops()).toBe(0)
    act(() => useCamStore.getState().openModal('model-entry'))
    expect(backdrops()).toBe(1)
    escape()
    expect(useCamStore.getState().activeModal).toBeNull()
    expect(backdrops()).toBe(0)
  })

  // A macro's ask/confirm/choose dialog mounts its own root at the end of <body>
  // and answers Escape from a window bubble listener (WO-1715). Stand in for it.
  function stackForeignDialog() {
    const el = document.createElement('div')
    el.className = 'modal-backdrop'
    document.body.appendChild(el)
    let answered = 0
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      answered += 1
      el.remove()
      window.removeEventListener('keydown', onKey)
    }
    window.addEventListener('keydown', onKey)
    return () => answered
  }

  it('a foreign dialog stacked over Machine actions answers its own Escape; Machine actions stays', () => {
    render(<Host />)
    const answered = stackForeignDialog()
    escape()
    expect(answered()).toBe(1)
    expect(screen.getByTestId('control-actions-modal')).toBeTruthy()
    expect(backdrops()).toBe(1)
    escape()
    expect(backdrops()).toBe(0)
  })

  it('a foreign dialog stacked over the macro editor answers first; then the editor, then Machine actions', () => {
    render(<Host />)
    fireEvent.click(screen.getByTestId('control-action-add'))
    const answered = stackForeignDialog()
    escape()
    expect(answered()).toBe(1)
    expect(screen.getByTestId('macro-editor-modal')).toBeTruthy()
    escape()
    expect(screen.queryByTestId('macro-editor-modal')).toBeNull()
    expect(screen.getByTestId('control-actions-modal')).toBeTruthy()
    escape()
    expect(backdrops()).toBe(0)
  })
})
