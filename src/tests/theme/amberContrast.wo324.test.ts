// WO-324 recorded the amber theme's fill-primitive contrast honestly,
// without fixing it. WO-325 fixes it: amber is a LIGHT accent, so the
// on-accent foreground must go dark, not white -- see tokens.css's amber
// block header ("FIXED (WO-325)") for the full reasoning. Parses tokens.css
// TEXT directly -- the pattern uiThemeContrast.test.ts already established
// for the high-contrast block -- so this can never silently drift from the
// shipped CSS the way a hand-copied hex list could. Node env (no DOM
// needed).
//
// This file's job is now to prove the fix: the amber theme's on-accent text
// clears the 4.5:1 body floor, AND a regression guard proves the OLD
// white-on-amber pairing would still fail if someone reintroduced it -- so
// a future edit can't silently regress the thing Operator reported.

import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'

const TOKENS_PATH = 'src/theme/tokens.css'
const WHITE = '#ffffff'

let baseVars: Record<string, string>
let amberVars: Record<string, string>

/** Extract `--name: #hex;` pairs from a `{ ... }` block's raw body text. */
function parseHexVars(blockBody: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of blockBody.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    out[m[1]] = m[2].toLowerCase()
  }
  return out
}

beforeAll(() => {
  const css = readFileSync(TOKENS_PATH, 'utf8')

  // Base :root block: from the file's opening `:root {` to its matching `}`.
  const baseMatch = css.match(/:root\s*\{([\s\S]*?)\n\}/)
  expect(baseMatch, 'base :root block not found in tokens.css').not.toBeNull()
  baseVars = parseHexVars(baseMatch![1])

  // Amber override block (WO-307 palette, WO-324 wiring).
  const amberMatch = css.match(/:root\[data-theme="amber"\]\s*\{([\s\S]*?)\n\}/)
  expect(amberMatch, ':root[data-theme="amber"] block not found in tokens.css').not.toBeNull()
  amberVars = parseHexVars(amberMatch![1])
})

// ---- WCAG 2.1 relative luminance / contrast ratio (standard formula) ----
function srgbToLinear(byte: number): number {
  const c = byte / 255
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}
function relativeLuminance(hex: string): number {
  const n = parseInt(hex.replace('#', ''), 16)
  const r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b)
}
function contrastRatio(hexA: string, hexB: string): number {
  const lA = relativeLuminance(hexA)
  const lB = relativeLuminance(hexB)
  const lighter = Math.max(lA, lB)
  const darker = Math.min(lA, lB)
  return (lighter + 0.05) / (darker + 0.05)
}

describe('WO-324 amber contrast (recorded honestly here, fixed in WO-325)', () => {
  it('sanity: the default (unthemed) fill primitive passes today -- proves the amber numbers below are a regression, not a pre-existing failure', () => {
    // --blue-600 is the base palette's own "identity FILL - white text sits
    // on it" (tokens.css base :root comment) -- --role-primary-fill /
    // --accent-strong pairs it with --text-on-accent (#ffffff) for every
    // filled primary button/badge (tokens.css Tier-2 comment: "primary fills
    // 5.26:1").
    expect(contrastRatio(WHITE, baseVars['--blue-600'])).toBeGreaterThanOrEqual(4.5)
  })

  it('amber ships a Tier-2 --text-on-accent override, dark, distinct from the base theme\'s white', () => {
    expect(amberVars['--text-on-accent']).toBeDefined()
    expect(amberVars['--text-on-accent']).not.toBe(baseVars['--text-on-accent'])
  })

  it('on-accent text on amber-fill (--blue-600, the identity FILL / --accent-strong primitive): PASSES the 4.5:1 body floor', () => {
    const ratio = contrastRatio(amberVars['--text-on-accent'], amberVars['--blue-600'])
    expect(ratio).toBeCloseTo(6.5, 1)
    expect(ratio).toBeGreaterThanOrEqual(4.5)
  })

  it('on-accent text on amber-base (--blue-500, the identity BASE / --accent primitive): PASSES the 4.5:1 body floor', () => {
    const ratio = contrastRatio(amberVars['--text-on-accent'], amberVars['--blue-500'])
    expect(ratio).toBeCloseTo(8.61, 1)
    expect(ratio).toBeGreaterThanOrEqual(4.5)
  })

  it('both amber identity primitives clear WCAG 2.1\'s 4.5:1 body-text floor with the shipped on-accent text -- the failure Operator reported, now fixed', () => {
    for (const name of ['--blue-500', '--blue-600'] as const) {
      const ratio = contrastRatio(amberVars['--text-on-accent'], amberVars[name])
      expect(ratio, `${name}: ${amberVars[name]}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('regression guard: white text on either amber identity primitive would still FAIL 4.5:1 if reintroduced -- proves the fix is the pairing, not the hue', () => {
    for (const name of ['--blue-500', '--blue-600'] as const) {
      const ratio = contrastRatio(WHITE, amberVars[name])
      expect(ratio, `${name}: ${amberVars[name]}`).toBeLessThan(4.5)
    }
    expect(contrastRatio(WHITE, amberVars['--blue-500'])).toBeCloseTo(2.11, 1)
    expect(contrastRatio(WHITE, amberVars['--blue-600'])).toBeCloseTo(2.79, 1)
  })
})
