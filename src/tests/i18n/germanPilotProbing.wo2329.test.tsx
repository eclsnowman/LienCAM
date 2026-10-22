// @vitest-environment jsdom
//
// WO-2329: the Probing screen in German, through the real app. The operator
// chooses Deutsch in Settings > Language, then opens Control > Probing: the
// routine names and the run checks are the glossary's German (Kante,
// Außenecke, Antasten), while the axis letters, G-words and numbers on the
// screen stay as they are. Its own file, because ProbingPanel reads its
// routine names once, when Control first opens in a session.
//
// Nothing here is stood in for except the 3D viewport (jsdom has no WebGL).

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, act, fireEvent, waitFor } from '@testing-library/react'
import { typedMock } from '../support/typedMock'

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

vi.mock('../../components/viewport/Viewport', () => typedMock<typeof import('../../components/viewport/Viewport')>({
  Viewport: () => <div data-testid="viewport-stub" />,
}))

const { default: App } = await import('../../App')
const { useCamStore } = await import('../../store')
const { i18n } = await import('../../i18n')

function byTestId(id: string): HTMLElement {
  const node = document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  if (node === null) throw new Error(`no [data-testid="${id}"] on screen`)
  return node
}

/** Visible text and tooltips, trimmed, in document order. */
function wordsOf(root: HTMLElement): string[] {
  const out: string[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT)
  for (let node: Node | null = walker.currentNode; node !== null; node = walker.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent ?? '').trim()
      if (text !== '') out.push(text)
    } else if (node instanceof Element) {
      for (const name of ['data-tooltip', 'aria-label', 'title']) {
        const value = node.getAttribute(name)
        if (value !== null && value.trim() !== '') out.push(`@${name}=${value.trim()}`)
      }
    }
  }
  return out
}

afterEach(cleanup)

describe('WO-2329: Probing in German', () => {
  it('shows the routine names and run checks in German, with axis letters and G-words unchanged', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      act(() => {
        useCamStore.getState().newProject()
        useCamStore.getState().setWorkspace('cam')
      })
      render(<App />)
      act(() => { useCamStore.getState().openModal('settings') })
      act(() => { fireEvent.click(byTestId('settings-language')) })
      act(() => { fireEvent.click(byTestId('settings-language-option-de')) })
      await waitFor(() => { expect(byTestId('settings-language-header').textContent).toBe('Sprache') })
      expect(i18n.language).toBe('de')
      act(() => { useCamStore.getState().closeModal() })

      act(() => { useCamStore.getState().setWorkspace('control') })
      await waitFor(() => {
        expect(document.querySelector('[data-testid="control-workspace-loading"]')).toBeNull()
        expect(document.querySelector('[data-testid="control-view-probing"]')).not.toBeNull()
      }, { timeout: 30_000 })
      act(() => { fireEvent.click(byTestId('control-view-probing')) })
      const probing = () => wordsOf(byTestId('control-probing-panel'))
      await waitFor(() => { expect(probing()).toContain('Kante') })
      const words = probing()
      for (const german of ['Außenecke', 'Innenecke', 'Bohrung', 'Zapfen', 'Kalibrieren']) {
        expect(words, german).toContain(german)
      }
      // A run check in German, the glossary's Antasten in the tab's Help.
      expect(words).toContain('Die Verfahrgrenzen der Maschine sind noch nicht bekannt - die Steuerungseinstellungen wurden nicht gelesen.')
      expect(words.some((word) => word.startsWith('@aria-label=Hilfe: '))).toBe(true)
      // Axis letters, the work offset and its G-words stay as they are.
      expect(words).toContain('Z0')
      expect(words).toContain('G54')
      expect(words).toContain('@data-tooltip=Set work X zero here (G10 L20)')
    } finally {
      errorSpy.mockRestore()
    }
  }, 120_000)
})
