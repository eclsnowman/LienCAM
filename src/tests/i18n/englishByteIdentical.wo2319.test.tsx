// @vitest-environment jsdom
//
// WO-2319: with the translation layer in the app, every screen in this sample
// reads exactly as it did on main - character for character, including
// tooltips, accessible names and placeholders.
//
// The golden (fixtures/english-main.wo2319.json) was recorded from main's own
// source by src/tests/evidence/WO-2319/record-main-golden.mjs (it checks out
// main's product files, runs this file with
// WO2319_RECORD=1 and restores them). The only intended difference is the new
// Settings > Language section, which is removed before comparing; every other
// character must match.
//
// Viewport is stubbed (jsdom has no WebGL), as in AppBottomConsole.smoke.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, act, waitFor } from '@testing-library/react'
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

// WO-2724/2725 add About and opening preferences; WO-2672 adds move colors.
// Preserve the complete rendered-English pin for those intentional additions.
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '../evidence/WO-2805/english-main.wo2319.json')
const RECORD = process.env.WO2319_RECORD === '1'

// Added by this order on purpose; everything else must be main's text.
const ADDED_BY_WO2319 = ['settings-language-header', 'settings-language-row']
// Build provenance, not words: the commit and version change with every commit.
const PROVENANCE = ['settings-build-info', 'settings-app-version']
const ATTRIBUTES = ['title', 'aria-label', 'placeholder', 'alt', 'aria-description']

/** Every piece of English a user can read or hear, in document order. */
function englishOf(root: HTMLElement): string[] {
  const copy = root.cloneNode(true) as HTMLElement
  for (const id of ADDED_BY_WO2319) {
    copy.querySelectorAll(`[data-testid="${id}"]`).forEach((node) => node.remove())
  }
  for (const id of PROVENANCE) {
    copy.querySelectorAll(`[data-testid="${id}"]`).forEach((node) => { node.textContent = `<${id}>` })
  }
  const out: string[] = []
  const walker = document.createTreeWalker(copy, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT)
  for (let node: Node | null = walker.currentNode; node !== null; node = walker.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.parentElement?.closest('script, style') != null) continue
      const text = node.textContent ?? ''
      if (text.trim() !== '') out.push(text)
    } else if (node instanceof Element) {
      for (const name of ATTRIBUTES) {
        const value = node.getAttribute(name)
        if (value !== null && value.trim() !== '') out.push(`@${name}=${value}`)
      }
    }
  }
  return out
}

// The Model workbench is left out: it needs a WebGL context jsdom cannot give.
async function screens(): Promise<Record<string, string[]>> {
  const result: Record<string, string[]> = {}
  act(() => {
    useCamStore.getState().newProject()
    useCamStore.setState({ consoleEvents: [], consoleReadThroughId: 0 })
    useCamStore.getState().setWorkspace('cam')
  })
  render(<App />)
  result['cam workspace'] = englishOf(document.body)
  act(() => { useCamStore.getState().openModal('settings') })
  result['settings dialog'] = englishOf(document.body)
  act(() => { useCamStore.getState().openModal('tool-library') })
  result['tool library dialog'] = englishOf(document.body)
  act(() => { useCamStore.getState().closeModal() })
  act(() => { useCamStore.getState().setWorkspace('control') })
  await waitFor(() => {
    expect(document.querySelector('[data-testid="control-workspace-loading"]')).toBeNull()
  }, { timeout: 30_000 })
  result['control workspace'] = englishOf(document.body)
  act(() => { useCamStore.getState().setWorkspace('cam') })
  return result
}

afterEach(cleanup)

describe('WO-2319: English renders byte-identical to main through the app shell', () => {
  it('matches main for the CAM and Control workspaces and the Settings and Tool Library dialogs', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    let actual: Record<string, string[]>
    try {
      actual = await screens()
    } finally {
      errorSpy.mockRestore()
    }
    if (RECORD) {
      mkdirSync(dirname(FIXTURE), { recursive: true })
      writeFileSync(FIXTURE, `${JSON.stringify(actual, null, 2)}\n`)
    }
    const main = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, string[]>
    expect(Object.keys(actual)).toEqual(Object.keys(main))
    for (const screen of Object.keys(main)) {
      expect(main[screen].length, `${screen}: main recorded text`).toBeGreaterThan(20)
      expect(actual[screen], screen).toEqual(main[screen])
    }
  }, 60_000)

  it('really shows the Language section it strips before comparing', () => {
    act(() => {
      useCamStore.getState().setWorkspace('cam')
      useCamStore.getState().openModal('settings')
    })
    render(<App />)
    expect(document.querySelector('[data-testid="settings-language-header"]')?.textContent).toBe('Language')
    act(() => { useCamStore.getState().closeModal() })
  })
})
