// @vitest-environment jsdom
//
// WO-2319: what happens once a second catalog exists. No language ships yet,
// so the catalog set is replaced with English plus a small German catalog that
// leaves one key out. The picker, store, lazy load and English fallback are
// the real code; only the file collection (import.meta.glob) is stood in for.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent, waitFor, within } from '@testing-library/react'
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

const { germanLoads } = vi.hoisted(() => ({ germanLoads: vi.fn() }))

vi.mock('../../i18n/catalogs', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../i18n/catalogs')>()
  const languages: readonly string[] = ['en', 'de']
  return typedMock<typeof import('../../i18n/catalogs')>({
    ...real,
    AVAILABLE_LANGUAGES: languages,
    isAvailableLanguage: (value: unknown): value is string =>
      typeof value === 'string' && languages.includes(value),
    loadCatalog: async (language: string) => {
      if (language !== 'de') return real.loadCatalog(language)
      germanLoads()
      return { language: { section: 'Sprache' } }
    },
  })
})

const { SettingsModal } = await import('../../components/modals/SettingsModal')
const { useCamStore } = await import('../../store')
const { useUiPrefs, UI_PREFS_STORAGE_KEY } = await import('../../store/uiPrefs')
const { i18n, applyLanguage } = await import('../../i18n')

afterEach(cleanup)

describe('WO-2319: a second catalog adds a choice with no further code', () => {
  it('lists it, loads it only when chosen, falls back to English for a missing key, and keeps it across a reload', async () => {
    expect(germanLoads).not.toHaveBeenCalled()
    render(<SettingsModal />)
    act(() => { useCamStore.getState().openModal('settings') })

    act(() => { fireEvent.click(screen.getByTestId('settings-language')) })
    const options = within(screen.getByRole('listbox')).getAllByRole('option')
    expect(options.map((option) => option.textContent)).toEqual(['English', 'Deutsch'])

    act(() => { fireEvent.click(screen.getByTestId('settings-language-option-de')) })
    await waitFor(() => {
      expect(screen.getByTestId('settings-language-header').textContent).toBe('Sprache')
    })
    expect(germanLoads).toHaveBeenCalledTimes(1)
    // The German file has no 'label' - English shows instead of a blank.
    expect(screen.getByText('Interface language')).not.toBeNull()
    expect(document.documentElement.lang).toBe('de')
    expect((JSON.parse(memStorage.getItem(UI_PREFS_STORAGE_KEY)!) as { state: { language: string } }).state.language).toBe('de')

    // Reload: drop the in-memory choice, put the stored record back, read it.
    const stored = memStorage.getItem(UI_PREFS_STORAGE_KEY)!
    act(() => { useUiPrefs.setState({ language: 'en' }) })
    await waitFor(() => { expect(i18n.language).toBe('en') })
    memStorage.setItem(UI_PREFS_STORAGE_KEY, stored)
    await act(async () => { await useUiPrefs.persist.rehydrate() })
    expect(useUiPrefs.getState().language).toBe('de')
    await waitFor(() => { expect(i18n.language).toBe('de') })

    await act(async () => {
      useUiPrefs.getState().setLanguage('en')
      await applyLanguage('en')
    })
    expect(screen.getByTestId('settings-language-header').textContent).toBe('Language')
    expect(document.documentElement.lang).toBe('en')
  })
})
