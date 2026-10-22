// @vitest-environment jsdom
//
// WO-2319: Settings > Language through the real Settings dialog - it lists
// only languages with a catalog, and the choice is the
// one stored in the UI preferences record, so it survives a reload.

import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent, within } from '@testing-library/react'

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

const { AVAILABLE_LANGUAGES, languageName } = await import('../../i18n/catalogs')
const { SettingsModal } = await import('../../components/modals/SettingsModal')
const { useCamStore } = await import('../../store')
const { useUiPrefs, UI_PREFS_STORAGE_KEY } = await import('../../store/uiPrefs')

function openSettings() {
  render(<SettingsModal />)
  act(() => { useCamStore.getState().openModal('settings') })
}

function storedLanguage(): unknown {
  return (JSON.parse(memStorage.getItem(UI_PREFS_STORAGE_KEY)!) as { state: { language?: unknown } }).state.language
}

beforeEach(() => { act(() => { useCamStore.getState().closeModal() }) })
afterEach(cleanup)

describe('WO-2319: Settings > Language', () => {
  it('shows the Language section with English chosen', () => {
    openSettings()
    expect(screen.getByTestId('settings-language-header').textContent).toBe('Language')
    expect(screen.getByText('Interface language')).not.toBeNull()
    expect(screen.getByTestId('settings-language').textContent).toContain('English')
  })

  it('lists every discovered catalog language, with English first', () => {
    openSettings()
    act(() => { fireEvent.click(screen.getByTestId('settings-language')) })
    const options = within(screen.getByRole('listbox')).getAllByRole('option')
    expect(options.map((option) => option.textContent)).toEqual(AVAILABLE_LANGUAGES.map(languageName))
    expect(screen.getByTestId('settings-language-option-en')).toBe(options[0])
  })

  it('discloses machine translation only for available translated catalogs', () => {
    openSettings()
    const notes = {
      de: 'Maschinell übersetzt - Korrekturen willkommen: Hilfe > Problem melden.',
      es: 'Traducción automática - Correcciones bienvenidas: Ayuda > Informar de un problema.',
      fr: 'Traduction automatique - Corrections bienvenues : Aide > Signaler un problème.',
    }
    expect(screen.queryByTestId('settings-language-note-en')).toBeNull()
    for (const [code, note] of Object.entries(notes)) {
      const node = screen.queryByTestId(`settings-language-note-${code}`)
      if (AVAILABLE_LANGUAGES.includes(code)) {
        expect(node?.textContent, code).toBe(`${languageName(code)}: ${note}`)
        expect(node?.getAttribute('lang'), code).toBe(code)
      } else {
        expect(node, `${code} has no catalog yet`).toBeNull()
      }
    }
  })

  it('stores the choice in the UI preferences record, and refuses a language with no catalog', () => {
    expect(AVAILABLE_LANGUAGES).not.toContain('xx-unavailable')
    act(() => { useUiPrefs.getState().setLanguage('xx-unavailable') })
    expect(useUiPrefs.getState().language).toBe('en')
    openSettings()
    act(() => { fireEvent.click(screen.getByTestId('settings-language')) })
    act(() => { fireEvent.click(screen.getByTestId('settings-language-option-en')) })
    expect(useUiPrefs.getState().language).toBe('en')
    expect(storedLanguage()).toBe('en')
  })

  it('comes back after a reload; a stored language whose catalog is gone shows English', async () => {
    const blob = JSON.parse(memStorage.getItem(UI_PREFS_STORAGE_KEY)!) as { state: Record<string, unknown> }
    blob.state.language = 'en'
    memStorage.setItem(UI_PREFS_STORAGE_KEY, JSON.stringify(blob))
    await act(async () => { await useUiPrefs.persist.rehydrate() })
    expect(useUiPrefs.getState().language).toBe('en')

    blob.state.language = 'xx-retired'
    memStorage.setItem(UI_PREFS_STORAGE_KEY, JSON.stringify(blob))
    await act(async () => { await useUiPrefs.persist.rehydrate() })
    expect(useUiPrefs.getState().language).toBe('en')
    openSettings()
    expect(screen.getByTestId('settings-language').textContent).toContain('English')
    expect(screen.getByTestId('settings-language-header').textContent).toBe('Language')
  })
})
