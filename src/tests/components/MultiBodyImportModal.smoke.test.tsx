// @vitest-environment jsdom
//
// React-render SMOKE test for MultiBodyImportModal (the multi-body STEP import
// landing-shape chooser, Operator Q-76). tsc + the pure vitest suite do NOT catch
// render-time defects (hooks-order bugs, missing selectors); this mounts the
// modal open and asserts its chrome + both plainly-worded options render, and
// that clicking an option resolves the awaited choice. Mirrors
// MachineChoiceModal.smoke.test.tsx (localStorage shim + store-driven closed->open).

import { describe, it, expect, afterEach } from 'vitest'
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

const { MultiBodyImportModal } = await import('../../components/modals/MultiBodyImportModal')
const { useCamStore } = await import('../../store')

afterEach(() => {
  cleanup()
  // Settle any pending request so the module-level resolver never leaks.
  act(() => { useCamStore.getState().resolveMultiBodyImportChoice('combined') })
})

describe('MultiBodyImportModal render smoke', () => {
  it('renders nothing while no choice is pending', () => {
    render(<MultiBodyImportModal />)
    expect(document.querySelector('.modal-backdrop')).toBeNull()
  })

  it('opens on requestMultiBodyImportChoice with the body count + both options; combined is the pre-selected default', () => {
    render(<MultiBodyImportModal />)
    expect(document.querySelector('.modal-backdrop')).toBeNull()

    act(() => {
      void useCamStore.getState().requestMultiBodyImportChoice({
        geoId: 'g1', name: 'part.step', bodyCount: 3, currentMode: 'combined',
      })
    })

    expect(document.querySelector('.modal-backdrop')).not.toBeNull()
    expect(document.querySelector('.modal-container')).not.toBeNull()
    // Body count is surfaced (contextual feedback) and the file is named.
    expect(screen.getByText(/This file has 3 separate bodies/)).not.toBeNull()
    expect(screen.getByText(/part\.step/)).not.toBeNull()
    // Both plainly-worded options render; combined carries the (default) marker.
    expect(screen.getByText(/Keep as one item \(default\)/)).not.toBeNull()
    expect(screen.getByText(/One item per body/)).not.toBeNull()

    act(() => { useCamStore.getState().resolveMultiBodyImportChoice('combined') })
    expect(document.querySelector('.modal-backdrop')).toBeNull()
  })

  it('clicking "One item per body" resolves the awaited choice with individual and closes', async () => {
    render(<MultiBodyImportModal />)
    let resolved: 'combined' | 'individual' | null = null
    act(() => {
      void useCamStore.getState().requestMultiBodyImportChoice({
        geoId: 'g2', name: 'assembly.step', bodyCount: 2, currentMode: 'combined',
      }).then((m) => { resolved = m })
    })

    const individual = screen.getByTestId('multibody-choice-individual')
    await act(async () => { fireEvent.click(individual) })

    expect(resolved).toBe('individual')
    expect(document.querySelector('.modal-backdrop')).toBeNull()
  })

  it('re-opened preselected to individual marks that option the default', () => {
    render(<MultiBodyImportModal />)
    act(() => {
      void useCamStore.getState().requestMultiBodyImportChoice({
        geoId: 'g3', name: 'rechoose.step', bodyCount: 4, currentMode: 'individual',
      })
    })
    // The stored pick is preselected -> "One item per body" carries (default).
    expect(screen.getByText(/One item per body \(default\)/)).not.toBeNull()
    act(() => { useCamStore.getState().resolveMultiBodyImportChoice('individual') })
  })
})
