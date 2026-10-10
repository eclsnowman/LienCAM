// @vitest-environment jsdom
//
// WO-324: pure-logic + DOM-application coverage for the shared UI-theme
// module (mirrors src/tests/lib/viewportThemes.test.ts's shape for the
// sibling GEO-25 viewport theme). The repo's vitest env is 'node' by
// default; the directive above flips THIS file to jsdom so applyUiTheme's
// document.documentElement assertions have a real DOM.
//
// Originally THEME-HICONTRAST-BUILD (Q-57) coverage for a 'high-contrast'
// id. WO-324 (Operator, "Make it an alternate theme in settings. I will need to
// drive it for a while before I can decide.") retargets this file at the two
// ids Settings now actually offers -- 'default' and 'amber'. 'high-contrast'
// is retired from the type entirely (not just unreachable from the UI), so
// coverage for it below asserts the id is REJECTED, not accepted.

import { describe, it, expect, afterEach } from 'vitest'
import {
  applyUiTheme,
  applyUiColorMode,
  DEFAULT_UI_COLOR_MODE,
  DEFAULT_UI_THEME,
  isUiColorMode,
  UI_COLOR_MODE_DOM_ATTRIBUTE,
  UI_COLOR_MODES,
  isUiThemeId,
  UI_THEME_DOM_ATTRIBUTE,
  UI_THEME_IDS,
  UI_THEME_LABELS,
} from '../../theme/uiTheme'

afterEach(() => {
  document.documentElement.removeAttribute(UI_THEME_DOM_ATTRIBUTE)
  document.documentElement.removeAttribute(UI_COLOR_MODE_DOM_ATTRIBUTE)
})

describe('WO-1200 uiColorMode', () => {
  it('ships dark and light as an axis independent from the two UI themes', () => {
    expect(UI_COLOR_MODES).toEqual(['dark', 'light'])
    expect(DEFAULT_UI_COLOR_MODE).toBe('dark')
    for (const mode of UI_COLOR_MODES) expect(isUiColorMode(mode)).toBe(true)
    expect(isUiColorMode('amber')).toBe(false)
    expect(isUiColorMode('system')).toBe(false)
  })

  it('applies light without changing the selected theme and removes only its own dark default attribute', () => {
    applyUiTheme('amber')
    applyUiColorMode('light')
    expect(document.documentElement.getAttribute(UI_THEME_DOM_ATTRIBUTE)).toBe('amber')
    expect(document.documentElement.getAttribute(UI_COLOR_MODE_DOM_ATTRIBUTE)).toBe('light')
    applyUiColorMode('dark')
    expect(document.documentElement.getAttribute(UI_THEME_DOM_ATTRIBUTE)).toBe('amber')
    expect(document.documentElement.hasAttribute(UI_COLOR_MODE_DOM_ATTRIBUTE)).toBe(false)
  })
})

describe('WO-324 uiTheme', () => {
  it('ships exactly the two ids Settings offers, default-only default', () => {
    expect(UI_THEME_IDS).toEqual(['default', 'amber'])
    expect(DEFAULT_UI_THEME).toBe('default')
    for (const id of UI_THEME_IDS) {
      expect(typeof UI_THEME_LABELS[id]).toBe('string')
      expect(UI_THEME_LABELS[id].length).toBeGreaterThan(0)
    }
    expect(UI_THEME_LABELS['amber']).toBe('Amber')
  })

  it('isUiThemeId: valid ids true, anything else (incl. the retired high-contrast id and stale/tampered persisted values) false', () => {
    for (const id of UI_THEME_IDS) expect(isUiThemeId(id)).toBe(true)
    expect(isUiThemeId('high-contrast')).toBe(false)
    expect(isUiThemeId('dark')).toBe(false)
    expect(isUiThemeId('highContrast')).toBe(false)
    expect(isUiThemeId(undefined)).toBe(false)
    expect(isUiThemeId(null)).toBe(false)
    expect(isUiThemeId(42)).toBe(false)
    expect(isUiThemeId('')).toBe(false)
  })

  it('applyUiTheme("amber") sets data-theme on the document root', () => {
    expect(document.documentElement.getAttribute(UI_THEME_DOM_ATTRIBUTE)).toBeNull()
    applyUiTheme('amber')
    expect(document.documentElement.getAttribute(UI_THEME_DOM_ATTRIBUTE)).toBe('amber')
  })

  it('applyUiTheme("default") REMOVES the attribute rather than writing data-theme="default"', () => {
    applyUiTheme('amber')
    expect(document.documentElement.hasAttribute(UI_THEME_DOM_ATTRIBUTE)).toBe(true)
    applyUiTheme('default')
    expect(document.documentElement.hasAttribute(UI_THEME_DOM_ATTRIBUTE)).toBe(false)
  })

  it('applyUiTheme is idempotent and a no-op-safe toggle both directions', () => {
    expect(() => applyUiTheme('default')).not.toThrow()
    expect(document.documentElement.hasAttribute(UI_THEME_DOM_ATTRIBUTE)).toBe(false)
    applyUiTheme('amber')
    applyUiTheme('amber')
    expect(document.documentElement.getAttribute(UI_THEME_DOM_ATTRIBUTE)).toBe('amber')
  })
})
