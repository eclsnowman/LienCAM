// @vitest-environment jsdom
// WO-2453: Machine Library and Tool Library collapse their side list to the
// shared narrow strip (WO-2452) - sized pane is the strip, expanding restores.

import type React from 'react'
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

const { MachineLibraryModal } = await import('../../components/modals/MachineLibraryModal')
const { ToolLibraryModal } = await import('../../components/modals/ToolLibraryModal')
const { useCamStore } = await import('../../store')
const { useUiPrefs } = await import('../../store/uiPrefs')

const paneOf = (testId: string) => screen.getByTestId(testId).closest('.resizable-split-pane') as HTMLElement

describe('WO-2453 dialogs follow the shared collapsed-pane fix', () => {
  afterEach(() => { cleanup(); act(() => { useCamStore.getState().closeModal() }) })

  for (const [name, modal, open, toggle, header] of [
    ['Machine Library', MachineLibraryModal, 'machine-config', 'machine-list-collapse', 'machine-list-header'],
    ['Tool Library', ToolLibraryModal, 'tool-library', 'tool-list-collapse', 'tool-list-collapse'],
  ] as const) {
    it(`${name}: collapsed list is a narrow strip, expanding restores it`, () => {
      mem.clear()
      useUiPrefs.setState({ panelSizes: {}, collapsedPropsGroups: {} })
      act(() => { useCamStore.getState().openModal(open as never) })
      const Modal = modal as () => React.JSX.Element
      render(<Modal />)
      const openWidth = paneOf(header).style.width
      expect(paneOf(header).className).not.toContain('resizable-split-strip')
      fireEvent.click(screen.getAllByTestId(toggle)[0])
      expect(paneOf(header).className).toContain('resizable-split-strip')
      expect(paneOf(header).style.width).toBe('36px')
      fireEvent.click(screen.getAllByTestId(toggle)[0])
      expect(paneOf(header).className).not.toContain('resizable-split-strip')
      expect(paneOf(header).style.width).toBe(openWidth)
    })
  }
})
