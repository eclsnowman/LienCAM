// @vitest-environment jsdom
//
// WO UI-11B: MachineLibraryModal's invalid-JSON import catch (premise
// inventory ":187-199", a FULLY silent catch — not even console.warn) now
// lands a warning console event. Behavior otherwise unchanged: the malformed
// file is still just ignored (no machine added, no throw).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act, fireEvent } from '@testing-library/react'

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

const { MachineLibraryModal } = await import('../../components/modals/MachineLibraryModal')
const { useCamStore } = await import('../../store')

afterEach(cleanup)

beforeEach(() => {
  act(() => {
    useCamStore.getState().closeModal()
    useCamStore.setState({ consoleEvents: [], consoleReadThroughId: 0 })
  })
})

describe('MachineLibraryModal invalid-JSON import (silent-catch fix)', () => {
  it('a malformed file lands one warning console event and adds no machine', async () => {
    const before = useCamStore.getState().machineLibrary.length

    render(<MachineLibraryModal />)
    act(() => { useCamStore.getState().openModal('machine-config') })

    // WO-916 made the UCCNC import optional and widened this input to accept a
    // .pro alongside a .json, so an exact accept="" match no longer finds it.
    // Select on the stable data-testid instead: the accept list is a product
    // decision that may widen again, and this test is about the malformed-file
    // WARNING, not about which extensions the picker offers.
    // WO-1642: the picker's test id follows the selected machine's controller
    // (UCCNC machines also offer .pro). A fresh library selects the neutral
    // starter rather than Operator's UCCNC machine, so accept either id.
    const input = document.querySelector(
      'input[type="file"][data-testid="uccnc-profile-local-input"], input[type="file"][data-testid="machine-library-import-input"]',
    ) as HTMLInputElement
    expect(input, 'the local profile file input must exist for this test to mean anything').not.toBeNull()
    const file = new File(['not valid json {{{'], 'bad.json', { type: 'application/json' })
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    await act(async () => {
      fireEvent.change(input)
      await new Promise((r) => setTimeout(r, 30))
    })

    expect(useCamStore.getState().machineLibrary).toHaveLength(before)
    const events = useCamStore.getState().consoleEvents.filter((e) => e.source === 'machine')
    expect(events).toHaveLength(1)
    expect(events[0].severity).toBe('warning')
    expect(events[0].message).toContain('bad.json')
  })
})
