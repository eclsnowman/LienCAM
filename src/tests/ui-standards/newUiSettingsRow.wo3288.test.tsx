// @vitest-environment jsdom
//
// WO-3288 (UI M2 W0 follow-up): the Settings > Appearance row for the New UI switch. The row
// shows the switch state (off by default), flips it through setNewUi, and the choice persists.
// When storage is denied the choice still holds for the session.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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
const { useCamStore } = await import('../../store')
const { isNewUiOn, NEW_UI_STORAGE_KEY, resetNewUiQueryForTests, setNewUi } = await import('../../ui2/newUiSwitch')

const { NewUiGate } = await import('../../ui2/NewUiGate')

const ROW = 'settings-new-ui'

function openSettings(): void {
  render(<SettingsModal />)
  act(() => { useCamStore.getState().openModal('settings') })
}

beforeEach(() => {
  mem.clear()
  resetNewUiQueryForTests()
  act(() => { useCamStore.getState().closeModal() })
})
afterEach(() => {
  cleanup()
  Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })
  resetNewUiQueryForTests()
})

describe('WO-3288 Settings > Appearance New UI row', () => {
  it('shows a New UI row, off by default, beside the theme picker', () => {
    openSettings()
    const row = screen.getByTestId(ROW) as HTMLInputElement
    expect(row.type).toBe('checkbox')
    expect(row.checked).toBe(false)
    const theme = screen.getByTestId('settings-theme')
    expect(theme.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('round trip through the gate: tick the row, the shell renders, Classic UI returns the classic app', async () => {
    const legacy = <main data-testid="legacy"><SettingsModal /></main>
    const { unmount } = render(<NewUiGate legacy={legacy} />)
    act(() => { useCamStore.getState().openModal('settings') })
    expect(screen.getByTestId('legacy')).toBeTruthy()
    fireEvent.click(screen.getByTestId(ROW))
    expect(mem.get(NEW_UI_STORAGE_KEY)).toBe('1')
    expect(await screen.findByTestId('ui2-root', {}, { timeout: 20000 })).toBeTruthy()
    expect(screen.queryByTestId('legacy')).toBeNull()
    fireEvent.click(await screen.findByTestId('ui2-classic-ui', {}, { timeout: 20000 }))
    expect(await screen.findByTestId('legacy')).toBeTruthy()
    expect(screen.queryByTestId('ui2-root')).toBeNull()
    expect(mem.get(NEW_UI_STORAGE_KEY)).toBe('0')
    unmount()
    render(<NewUiGate legacy={legacy} />)
    expect(screen.getByTestId('legacy')).toBeTruthy()
    expect(isNewUiOn()).toBe(false)
  }, 60_000)

  it('reflects a switch that was already on when Settings opens', () => {
    setNewUi(true)
    openSettings()
    expect((screen.getByTestId(ROW) as HTMLInputElement).checked).toBe(true)
  })

  it('keeps the choice for the session when storage is denied', () => {
    const denied = {
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('denied') },
    }
    Object.defineProperty(globalThis, 'localStorage', { value: denied, configurable: true })
    setNewUi(true)
    expect(isNewUiOn()).toBe(true)
    setNewUi(false)
    expect(isNewUiOn()).toBe(false)
  })

  it('has its words in all four languages', () => {
    for (const lang of ['en', 'de', 'es', 'fr']) {
      const src = readFileSync(join(__dirname, '..', '..', 'i18n', 'locales', lang, 'ui2-settings-row.wo3288.ts'), 'utf8')
      expect(src).toMatch(/newUi:\s*'[^']+'/)
      expect(src).toMatch(/newUiHint:\s*'[^']+'/)
    }
  })
})
