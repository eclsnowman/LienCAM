// @vitest-environment jsdom
//
// WO-270 -- brand identity, not a free for all.
//
// Operator ruling 2026-08-12: "We also have some earlier attempts at themeing changable
// in the setting menu. We should pick a look and stick with it, I want to
// remove the UI theme, Viewport Theme, and selection glow settings. We need
// brand identity, not a free for all."
//
// This file is the ABSENCE gate for that removal. It replaces the three
// render-gate tests in SettingsModal.smoke.test.tsx that used to prove each
// control rendered.
//
// The interesting half is not "the controls are gone" -- it is the user who
// ALREADY picked one. Their choice is still sitting in their browser under the
// uiPrefs key. This file seeds exactly that blob BEFORE the store module is
// imported (persist binds storage at module load, so the seed has to be in
// place first) and proves the app resolves the shipped look anyway, without
// crashing and without quietly wiping their stored data.
//
// -- NARROWED by WO-324 (Operator, verdict on card
// Q-THE-AMBER-THEME-SEE-ALL-OF-IT-AN-1786569820206, 2026-08-12: "Make it an
// alternate theme in settings. I will need to drive it for a while before I
// can decide.") --
//
// WO-324 deliberately brings back ONE of the three controls this file used to
// gate the absence of: the UI theme picker (relabeled "Theme", now offering
// only Default/Amber, not the old high-contrast/etc list). That FORCES edits
// here, since the picker existing is no longer something this file can assert
// is absent. What must still hold, and does not change below:
//   - Viewport theme and Selection glow are STILL absent -- Operator did not ask
//     for either back, and restoring them would be out of scope.
//   - The picker itself must still refuse to offer the old experimental
//     looks (no 'high-contrast' option) -- new coverage added below.
//   - A value stored under the old 'high-contrast' id (from before WO-270 ever
//     shipped) must resolve safely to 'default', not crash and not silently
//     re-apply -- this is now a MORE interesting case than before, because
//     uiTheme is a live field again, so it is asserted more precisely below
//     (resolves to DEFAULT_UI_THEME) rather than merely "never breaks".
// See the "## Worker result" section of queue/WO-324-*.md for the assertion
// -by-assertion account of what changed and why each change is safe.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'

// jsdom's built-in localStorage is broken under vitest's node launch flags, and
// the store writes through persist() on every set(). Install a minimal
// in-memory Storage shim BEFORE importing the store. Pure test scaffolding.
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

// THE SEED. A user who used all three removed controls: a non-default viewport
// theme, a non-default selection glow, and the high-contrast UI theme -- plus
// an ordinary unrelated preference (panel width) that must survive untouched.
// Written before the dynamic imports below so the store rehydrates from it the
// way a real reload would.
const STORED_PANEL_LEFT_WIDTH = 321
mem.set('liencam-ui-prefs', JSON.stringify({
  state: {
    panelLeftWidth: STORED_PANEL_LEFT_WIDTH,
    viewportTheme: 'deep-slate',
    selectionGlow: 'brightness-halo',
    uiTheme: 'high-contrast',
  },
  version: 1,
}))

const { SettingsModal } = await import('../../components/modals/SettingsModal')
const { useCamStore } = await import('../../store')
const { useUiPrefs, getSelectionGlow, UI_PREFS_STORAGE_KEY } = await import('../../store/uiPrefs')
const { DEFAULT_VIEWPORT_THEME } = await import('../../lib/viewport/lighting/viewportThemes')
const { DEFAULT_SELECTION_GLOW } = await import('../../lib/viewport/lighting/selectionGlowTokens')
const { UI_THEME_DOM_ATTRIBUTE, DEFAULT_UI_THEME } = await import('../../theme/uiTheme')

/** The two controls WO-270 removed that WO-324 did NOT bring back, by the
 *  test id and the visible label each one carried in Settings > Display.
 *  (The third, the UI theme picker, is back as of WO-324 -- see
 *  'settings-theme' below, which is asserted PRESENT, not absent.) */
const STILL_REMOVED_CONTROLS = [
  { testId: 'settings-viewport-theme', label: 'Viewport theme' },
  { testId: 'settings-selection-glow', label: 'Selection glow' },
] as const

beforeEach(() => {
  act(() => { useCamStore.getState().closeModal() })
})

afterEach(cleanup)

function openSettings(): void {
  // Mount CLOSED first so opening is a true closed->open hook transition --
  // the path that catches hooks-order render crashes after a selector removal.
  render(<SettingsModal />)
  expect(screen.queryByText('Settings')).toBeNull()
  act(() => { useCamStore.getState().openModal('settings') })
}

describe('WO-270: Viewport theme and Selection glow are still gone from the settings menu', () => {
  it('renders neither still-removed control -- Viewport theme, Selection glow', () => {
    openSettings()
    // The modal really is up -- otherwise "absent" would be trivially true for
    // every control in the app and this test would pass on a broken render.
    expect(screen.getByTestId('settings-modal-panel')).not.toBeNull()

    for (const { testId, label } of STILL_REMOVED_CONTROLS) {
      expect(screen.queryByTestId(testId)).toBeNull()
      expect(screen.queryByText(label)).toBeNull()
    }
  })

  // WO-324: was "drops the Display section header the three controls
  // shared" -- asserted `queryByText('Display')` is null. Safe to narrow, not
  // weaken: the "Display" header itself is still gone (WO-324 titles its
  // replacement "Theme", never resurrecting the old name), and the new
  // "Theme" header is added to the kept-headers list alongside the others so
  // this still fails loudly if the resurrected section fails to render.
  it('keeps "Display" gone; the resurrected Theme control gets its own header', () => {
    openSettings()
    expect(screen.queryByText('Display')).toBeNull()
    for (const kept of ['STL Projection', 'Units', 'Nesting', 'Navigation', 'Theme', 'Performance', 'Startup', 'About']) {
      expect(screen.getByText(kept)).not.toBeNull()
    }
  })

  // New in WO-324: the WO's explicit instruction is that the resurrected
  // picker must "refuse to offer the old experimental looks" -- this proves
  // that from the real render, not just from uiTheme.ts's own unit coverage.
  it('the Theme control keeps identity choice separate from the light-mode toggle', () => {
    openSettings()
    const trigger = screen.getByTestId('settings-theme')
    expect(trigger).not.toBeNull()
    act(() => { fireEvent.click(trigger) })
    expect(screen.getByTestId('settings-theme-option-default')).not.toBeNull()
    expect(screen.getByTestId('settings-theme-option-amber')).not.toBeNull()
    expect(screen.queryByTestId('settings-theme-option-high-contrast')).toBeNull()
    const lightMode = screen.getByTestId('settings-light-mode') as HTMLInputElement
    expect(lightMode.checked).toBe(false)
  })

  it('WO-1200 toggles light mode from Settings, persists it, and preserves Amber', () => {
    const storedBefore = memStorage.getItem(UI_PREFS_STORAGE_KEY)!
    act(() => {
      useUiPrefs.getState().setUiTheme('amber')
      useUiPrefs.getState().setUiColorMode('dark')
    })
    openSettings()
    try {
      fireEvent.click(screen.getByLabelText('Light mode'))
      expect(useUiPrefs.getState().uiTheme).toBe('amber')
      expect(document.documentElement.getAttribute('data-color-mode')).toBe('light')
      expect(JSON.parse(memStorage.getItem(UI_PREFS_STORAGE_KEY)!).state.uiColorMode).toBe('light')
      fireEvent.click(screen.getByLabelText('Light mode'))
      expect(document.documentElement.hasAttribute('data-color-mode')).toBe(false)
      expect(useUiPrefs.getState().uiTheme).toBe('amber')
    } finally {
      act(() => {
        useUiPrefs.getState().setUiColorMode('dark')
        useUiPrefs.getState().setUiTheme('default')
      })
      // Keep the separate legacy-hydration fixture intact after this write test.
      memStorage.setItem(UI_PREFS_STORAGE_KEY, storedBefore)
    }
  })

  it('leaves the settings the WO did not name alone', () => {
    openSettings()
    // Guards the blast radius: "remove the three he named" is the whole order,
    // and the Display section sat between Navigation and Performance.
    for (const testId of [
      'settings-projection-tolerance-preset',
      'settings-display-units',
      'settings-export-units',
      'settings-nav-preset',
      'settings-brep-quality',
      'settings-sim-engine',
    ]) {
      expect(screen.getByTestId(testId)).not.toBeNull()
    }
  })
})

describe('WO-270: a user who DID set one of them does not break', () => {
  // WO-324: added the uiTheme assertion. viewportTheme/selectionGlow are
  // still frozen (unchanged by this WO); uiTheme is now a live, validated
  // field again, so "resolves the shipped look" for it means "an invalid
  // stored id falls back to DEFAULT_UI_THEME", not "the field is inert".
  it('ignores every stored value from the removed/retired ids and resolves the shipped default', () => {
    // The seeded blob asked for deep-slate + brightness-halo + high-contrast.
    expect(useUiPrefs.getState().viewportTheme).toBe(DEFAULT_VIEWPORT_THEME)
    expect(useUiPrefs.getState().selectionGlow).toBe(DEFAULT_SELECTION_GLOW)
    expect(getSelectionGlow()).toBe(DEFAULT_SELECTION_GLOW)
    // 'high-contrast' is no longer a member of UiThemeId (WO-324) -- an
    // unrecognized id, resolved the same way any other bad string would be.
    expect(useUiPrefs.getState().uiTheme).toBe(DEFAULT_UI_THEME)
  })

  // WO-324: comment updated -- uiTheme is a live field again (it does have an
  // effect now, for a VALID id), but the seeded 'high-contrast' specifically
  // is not one, so it still can never paint. The assertions themselves are
  // unchanged and still safe: they were never "nothing writes this attribute
  // ever", only "this stored value never reaches it".
  it('never applies the stored (retired) high-contrast id to the document root', () => {
    // 'high-contrast' fails isUiThemeId, so it resolves to 'default' at
    // rehydrate -- asserted both at module load and after a fresh rehydrate.
    expect(document.documentElement.hasAttribute(UI_THEME_DOM_ATTRIBUTE)).toBe(false)
    act(() => { void useUiPrefs.persist.rehydrate() })
    expect(document.documentElement.hasAttribute(UI_THEME_DOM_ATTRIBUTE)).toBe(false)
  })

  it('renders the settings menu from that stored blob without crashing, Theme control resolved to Default', () => {
    openSettings()
    expect(screen.getByTestId('settings-modal-panel')).not.toBeNull()
    for (const { testId } of STILL_REMOVED_CONTROLS) {
      expect(screen.queryByTestId(testId)).toBeNull()
    }
    // The seeded 'high-contrast' must not leak into the picker's displayed
    // value -- it shows the resolved fallback, not the raw stored string.
    expect(screen.getByTestId('settings-theme').textContent).toContain('Default')
    act(() => { useCamStore.getState().closeModal() })
    expect(screen.queryByTestId('settings-modal-panel')).toBeNull()
  })

  it('keeps the unrelated preferences stored alongside them', () => {
    // Ignoring the removed three must not cost a user their panel layout.
    expect(useUiPrefs.getState().panelLeftWidth).toBe(STORED_PANEL_LEFT_WIDTH)
  })

  it('does not delete the stored values it ignores', () => {
    // Operator's "do not": ignore the stored preference, do not migrate or delete
    // it. uiTheme IS a declared field again (WO-324), but rehydrate only
    // updates in-memory state via the validating `merge` -- it never calls
    // storage.setItem -- so the raw stored 'high-contrast' string is never
    // rewritten just because it was read once and found invalid.
    const raw = JSON.parse(mem.get(UI_PREFS_STORAGE_KEY)!)
    expect(raw.state.uiTheme).toBe('high-contrast')
  })
})

describe('WO-270: Viewport theme and Selection glow are removed, not hidden behind a switch', () => {
  // WO-324 safely changed: was "exposes no setter that could flip any of the
  // three back on", asserting setUiTheme undefined alongside the other two.
  // That assertion is now the opposite of true on purpose -- WO-324's whole
  // job is to add setUiTheme back as a real, validated setter for the ONE
  // control Operator asked to drive. Viewport theme and Selection glow still have
  // no setter; that half is unchanged and still asserted below.
  it('exposes no setter for Viewport theme or Selection glow; Theme keeps a real one', () => {
    const state = useUiPrefs.getState() as unknown as Record<string, unknown>
    expect(state.setViewportTheme).toBeUndefined()
    expect(state.setSelectionGlow).toBeUndefined()
    expect(typeof state.setUiTheme).toBe('function')
  })

  // WO-324 safely changed: was "leaves a seeded uiTheme key inert rather than
  // acted on", asserting the raw in-memory `state.uiTheme` EQUALED the seeded
  // 'high-contrast' string (true only because the field did not exist and
  // nothing validated it). Now that uiTheme is a real, validated field, the
  // correct -- and stronger -- guarantee is that the invalid seed resolves to
  // DEFAULT_UI_THEME in memory, never the raw unrecognized string, while still
  // never touching the document. This still proves "not acted on": the seed
  // does not paint the document, and it is not the value read back either.
  it('resolves an invalid seeded uiTheme value to the default rather than acting on it', () => {
    const state = useUiPrefs.getState() as unknown as Record<string, unknown>
    expect(state.uiTheme).toBe(DEFAULT_UI_THEME)
    expect(document.documentElement.hasAttribute(UI_THEME_DOM_ATTRIBUTE)).toBe(false)
  })
})
