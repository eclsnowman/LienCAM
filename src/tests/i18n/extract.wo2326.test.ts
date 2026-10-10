// @vitest-environment jsdom
import React from 'react'
import { readFileSync, writeFileSync } from 'node:fs'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, act, waitFor } from '@testing-library/react'
import { typedMock } from '../support/typedMock'
import type { BottomConsoleProps } from '../../components/panels/BottomConsole'

const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  get length() { return mem.size }, clear: () => mem.clear(),
  getItem: (k: string) => mem.get(k) ?? null, key: (i: number) => [...mem.keys()][i] ?? null,
  removeItem: (k: string) => { mem.delete(k) }, setItem: (k: string, v: string) => { mem.set(k, String(v)) },
} })
vi.mock('../../components/viewport/Viewport', () => typedMock<typeof import('../../components/viewport/Viewport')>({ Viewport: () => React.createElement('div', { 'data-testid': 'viewport-stub' }) }))
const { default: App } = await import('../../App')
const { useCamStore } = await import('../../store')
const { BottomConsole } = await import('../../components/panels/BottomConsole')
const { UserDataStoragePanel } = await import('../../components/modals/UserDataStoragePanel')
const { requestStoragePersistence } = await import('../../lib/storagePersistence')
const { formatDurationHMS, formatComputeMs, formatElapsedSeconds } = await import('../../lib/format')
// WO-2634 deliberately changed index502 after rotated STEP features became
// re-derived; both interpolation and isolated-import routes use that new pin.
const RECORD = process.env.WO2326_RECORD === '1'
const FIXTURE = 'src/tests/evidence/WO-2685/main-rendered.wo2326.json'

function englishOf(root: HTMLElement): string[] {
  const copy = root.cloneNode(true) as HTMLElement
  // Commit hash/version, clocks, and per-browser byte totals are provenance.
  for (const id of ['settings-build-info', 'settings-app-version']) {
    copy.querySelectorAll(`[data-testid="${id}"]`).forEach(n => { n.textContent = `<${id}>` })
  }
  copy.querySelectorAll('time, .console-event-time').forEach(n => n.remove())
  const out: string[] = []
  const walker = document.createTreeWalker(copy, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT)
  for (let n: Node | null = walker.currentNode; n; n = walker.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE && !n.parentElement?.closest('script, style')) {
      if (n.textContent?.trim()) out.push(n.textContent)
    } else if (n instanceof Element) {
      for (const a of ['title', 'aria-label', 'placeholder', 'alt', 'aria-description']) {
        const value = n.getAttribute(a)
        if (value?.trim()) out.push(`@${a}=${value}`)
      }
    }
  }
  return out
}

afterEach(cleanup)
describe('WO-2326: English through production stores and components', () => {
  it('matches main in workspaces, dialogs, console and populated User Data', async () => {
    const actual: Record<string, string[]> = {}
    act(() => {
      useCamStore.getState().newProject()
      useCamStore.getState().setWorkspace('cam')
      useCamStore.setState({ consoleEvents: [], consoleReadThroughId: 0 })
    })
    render(React.createElement(App))
    actual.cam = englishOf(document.body)
    for (const modal of ['settings', 'tool-library', 'machine-config', 'new-setup', 'new-operation', 'sketch-entry', 'model-entry', 'export', 'post-process', 'new-nest']) {
      act(() => { useCamStore.getState().openModal(modal) })
      actual[modal] = englishOf(document.body)
    }
    act(() => {
      useCamStore.getState().closeModal()
      useCamStore.getState().setWorkspace('control')
    })
    await waitFor(() => { expect(document.querySelector('[data-testid="control-workspace-loading"]')).toBeNull() }, { timeout: 30000 })
    // ControlPage installs WO-1136's native titles in a passive effect after
    // the lazy host mounts. The spinner disappearing alone can precede it.
    await waitFor(() => {
      for (const axis of ['x', 'y', 'z']) {
        const input = document.querySelector<HTMLInputElement>(`[data-testid="control-dro-machine-${axis}"]`)
        expect(input).not.toBeNull()
        expect(input!.title).toBe(input!.placeholder)
        expect(input!.title).not.toBe('')
      }
    })
    actual.control = englishOf(document.body)
    cleanup()
    act(() => { useCamStore.setState({ consoleEvents: [], consoleReadThroughId: 0 }) })
    await requestStoragePersistence({} as Navigator, message => useCamStore.getState().addConsoleEvent({ severity: 'info', source: 'app', message }))
    await requestStoragePersistence({ storage: { persisted: async () => true, persist: async () => true } } as unknown as Navigator,
      message => useCamStore.getState().addConsoleEvent({ severity: 'info', source: 'app', message }))
    await requestStoragePersistence({ storage: { persist: async () => false } } as unknown as Navigator,
      message => useCamStore.getState().addConsoleEvent({ severity: 'info', source: 'app', message }))
    render(React.createElement<BottomConsoleProps>(BottomConsole, { defaultExpanded: true }))
    actual.console = englishOf(document.body)
    cleanup()
    render(React.createElement(UserDataStoragePanel, { serviceOptions: { legacyStorage: localStorage, durableStorage: null } }))
    await waitFor(() => { expect(document.body.textContent).toContain('Active project') })
    actual['user-data'] = englishOf(document.body)
    if (RECORD) writeFileSync(FIXTURE, JSON.stringify(actual, null, 2) + '\n')
    const golden = JSON.parse(readFileSync(FIXTURE, 'utf8')) as typeof actual
    expect(actual).toEqual(golden)
  }, 60000)

  it('preserves durations and decimal formatting', () => {
    expect([0, 45000, 154000, 3780000].map(formatDurationHMS)).toEqual(['0s', '45s', '2m 34s', '1h 03m'])
    expect([NaN, 12, 1234].map(formatComputeMs)).toEqual(['-', '12 ms', '1.2 s'])
    expect(formatElapsedSeconds(12999)).toBe('12s')
  })

  it.skipIf(RECORD)('keeps every extracted English template identical to main, including interpolation', async () => {
    const { textFor } = await import('../../i18n')
    const t = textFor('console-and-operator-messages')
    const golden = JSON.parse(readFileSync('src/tests/evidence/WO-2650/main-messages.wo2326.json', 'utf8')) as { entries: { key: string; value: string }[] }
    for (const item of golden.entries) {
      const args = Object.fromEntries([...item.value.matchAll(/\{\{(\w+)\}\}/g)].map(m => [m[1], `part <&> 1234.5 ${m[1]}`]))
      const expected = item.value.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => args[k])
      // Key names are read from the independently committed main inventory.
      expect(t(item.key as never, args), item.key).toBe(expected)
    }
  })

  it.skipIf(RECORD)('forwards helper messages through the installed production text lookup', async () => {
    const { i18n } = await import('../../i18n')
    i18n.addResourceBundle('wo2326-test', 'console-and-operator-messages', { format6: 'Elapsed {{value1}}s' })
    try {
      await i18n.changeLanguage('wo2326-test')
      expect(formatComputeMs(1234)).toBe('Elapsed 1.2s')
    } finally {
      await i18n.changeLanguage('en')
      i18n.removeResourceBundle('wo2326-test', 'console-and-operator-messages')
    }
  })

  it.skipIf(RECORD)('keeps isolated helper imports free of persisted UI writes before store boot', async () => {
    // The first attempt found that eager i18n boot changed isolated-library
    // persistence. Exercise the real imports with a fresh module cache.
    vi.resetModules()
    const write = vi.spyOn(localStorage, 'setItem')
    try {
      const format = await import('../../lib/format')
      const storage = await import('../../lib/storagePersistence')
      expect(format.formatComputeMs(1234)).toBe('1.2 s')
      expect(storage.STORAGE_PERSISTENT_LINE).toBe('Browser storage: persistent')
      const { operatorText } = await import('../../i18n/locales/en/console-and-operator-messages')
      const golden = JSON.parse(readFileSync('src/tests/evidence/WO-2650/main-messages.wo2326.json', 'utf8')) as { entries: { key: string; value: string }[] }
      for (const item of golden.entries) {
        const args = Object.fromEntries([...item.value.matchAll(/\{\{(\w+)\}\}/g)].map(m => [m[1], `part <&> $& {{raw}} 1234.5 ${m[1]}`]))
        const expected = item.value.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => args[k])
        expect(operatorText(item.key as never, args), item.key).toBe(expected)
      }
      expect(write).not.toHaveBeenCalled()
    } finally {
      write.mockRestore()
    }
  })
})
