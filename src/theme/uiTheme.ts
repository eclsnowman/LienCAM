// THEME-HICONTRAST-BUILD (Operator Q-57 verdict 2026-07-25 verbatim "approve as
// an option"): an opt-in, app-wide 2D UI chrome theme -- mirrors the GEO-25
// viewport-theme selector idiom (src/lib/viewport/lighting/viewportThemes.ts:
// id/label/default plumbing + a subscribed uiPrefs slice) but swaps CSS
// custom-property VALUES instead of Three.js materials.
//
// The swap itself is ONE extra selector block in src/theme/tokens.css --
// `:root[data-theme="high-contrast"]` -- overriding ONLY the Tier-1
// primitives that file's own header comment already reserves for exactly
// this purpose ("a future theme redefines ONLY these via a [data-theme=...]
// block"). Every Tier-2/Tier-3 semantic/component token still reads
// `var(--slate-400)` etc and picks the swap up for free -- no new token
// vocabulary, no selector rewrites, and src/styles/app.css (confirmed
// read-only: it only aliases OLD var names onto tokens.css tokens via var(),
// it never redeclares a primitive) needs no edit at all.
//
// Palette source, incl. every measured WCAG 2.1 contrast ratio:
// coordination/reports/THEME-HICONTRAST-RECON.report.md (delta table) +
// coordination/reports/THEME-HICONTRAST-MOCKUP.html. Cross-checked by
// src/tests/theme/uiThemeContrast.test.ts, which parses tokens.css directly
// (not a hand-copied hex list) so the test can never silently drift from the
// shipped CSS.
//
// 'default' is not a color override at all -- it is the ABSENCE of the
// data-theme attribute, so the current look stays byte-identical (Operator's
// "current look stays default" requirement) rather than a re-derivation
// that could drift by a rounding step.
//
// WO-324 (Operator, verdict on card Q-THE-AMBER-THEME-SEE-ALL-OF-IT-AN-
// 1786569820206, 2026-08-12: "Make it an alternate theme in settings. I will
// need to drive it for a while before I can decide."): adds 'amber' as a
// second real id, wired to the WO-307 `[data-theme="amber"]` block in
// tokens.css. `high-contrast` is DELIBERATELY DROPPED from this type, not
// carried forward alongside it -- WO-270's "brand identity, not a free for
// all" verdict means the Settings picker offers exactly Default and Amber,
// no third option and no re-derivation of the old list. Its CSS block stays
// in tokens.css (untouched, orphaned) but is no longer a member of
// UiThemeId, so isUiThemeId('high-contrast') is false and a value stored
// under that id from before this WO falls back to 'default' the same way any
// other unrecognized string would -- see uiPrefs.ts's persist `merge`.

export type UiThemeId = 'default' | 'amber'
export type UiColorMode = 'dark' | 'light'

export const UI_THEME_IDS: readonly UiThemeId[] = ['default', 'amber']

/** Operator Q-57 (and reaffirmed for 'amber' by WO-324): opt-in only -- every
 *  existing and new user keeps the current look until they deliberately
 *  switch. */
export const DEFAULT_UI_THEME: UiThemeId = 'default'
export const UI_COLOR_MODES: readonly UiColorMode[] = ['dark', 'light']
export const DEFAULT_UI_COLOR_MODE: UiColorMode = 'dark'

export const UI_THEME_LABELS: Record<UiThemeId, string> = {
  default: 'Default',
  amber: 'Amber',
}

export function isUiThemeId(value: unknown): value is UiThemeId {
  return typeof value === 'string' && (UI_THEME_IDS as readonly string[]).includes(value)
}

export function isUiColorMode(value: unknown): value is UiColorMode {
  return typeof value === 'string' && (UI_COLOR_MODES as readonly string[]).includes(value)
}

/** DOM attribute name the tokens.css `[data-theme="..."]` block selects on. */
export const UI_THEME_DOM_ATTRIBUTE = 'data-theme'
export const UI_COLOR_MODE_DOM_ATTRIBUTE = 'data-color-mode'

/** Apply (or clear) the data-theme attribute on the document root.
 *  'default' REMOVES the attribute rather than writing data-theme="default"
 *  -- no CSS rule targets that value, and removing it means the base :root
 *  block is the ONLY thing painting an unthemed page, nothing to shadow.
 *  SSR/worker/test-safe: no-ops when `document` is unavailable, mirroring
 *  viewportColors.ts's SSR guard (same directory). */
export function applyUiTheme(theme: UiThemeId): void {
  if (typeof document === 'undefined' || !document.documentElement) return
  if (theme === 'amber') {
    document.documentElement.setAttribute(UI_THEME_DOM_ATTRIBUTE, 'amber')
  } else {
    document.documentElement.removeAttribute(UI_THEME_DOM_ATTRIBUTE)
  }
}

/** Dark is represented by no attribute, keeping the existing cascade unchanged. */
export function applyUiColorMode(mode: UiColorMode): void {
  if (typeof document === 'undefined' || !document.documentElement) return
  if (mode === 'light') document.documentElement.setAttribute(UI_COLOR_MODE_DOM_ATTRIBUTE, 'light')
  else document.documentElement.removeAttribute(UI_COLOR_MODE_DOM_ATTRIBUTE)
}
