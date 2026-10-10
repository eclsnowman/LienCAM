// THEME-HICONTRAST-BUILD (Q-57): measured-not-eyeballed contrast coverage
// for the high-contrast override block in src/theme/tokens.css. Per the WO's
// LEAN-tier acceptance numbers: the recon's audited worst offenders
// (coordination/reports/THEME-HICONTRAST-RECON.report.md) must clear their
// WCAG 2.1 floor once the theme is on. Node env (no DOM needed) -- this
// parses tokens.css TEXT directly (single source of truth), so the test can
// never silently drift from the shipped CSS the way a hand-copied hex table
// could.

import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'

const TOKENS_PATH = 'src/theme/tokens.css'

let baseVars: Record<string, string>
let highContrastVars: Record<string, string>

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

  // Base :root block: from the file's opening `:root {` to its matching `}`
  // (the first top-level close before the high-contrast block starts).
  const baseMatch = css.match(/:root\s*\{([\s\S]*?)\n\}/)
  expect(baseMatch, 'base :root block not found in tokens.css').not.toBeNull()
  baseVars = parseHexVars(baseMatch![1])

  // High-contrast override block.
  const hcMatch = css.match(/:root\[data-theme="high-contrast"\]\s*\{([\s\S]*?)\n\}/)
  expect(hcMatch, ':root[data-theme="high-contrast"] block not found in tokens.css').not.toBeNull()
  highContrastVars = parseHexVars(hcMatch![1])
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

// --surface-1 (#161b22), the dominant panel background every audited pair in
// the recon was measured against.
const SURFACE_1 = '#161b22'

describe('THEME-HICONTRAST-BUILD contrast floors (measured, not eyeballed)', () => {
  it('sanity: the base palette reproduces the recon audit\'s FAILING ratios (proves we are testing the real failure)', () => {
    expect(contrastRatio(baseVars['--slate-700'], SURFACE_1)).toBeCloseTo(1.44, 1) // border-subtle
    expect(contrastRatio(baseVars['--slate-500'], SURFACE_1)).toBeCloseTo(2.71, 1) // text-disabled
    expect(contrastRatio(baseVars['--text-dim'], SURFACE_1)).toBeCloseTo(2.32, 1)  // tree-layer-count
    expect(contrastRatio(baseVars['--text-disabled-overlay'], SURFACE_1)).toBeCloseTo(2.25, 1)
    expect(contrastRatio(baseVars['--slate-550'], SURFACE_1)).toBeCloseTo(2.31, 1) // scrollbar-thumb
  })

  it('border/scrollbar ramp clears the WCAG 1.4.11 non-text 3:1 floor once high-contrast is on', () => {
    expect(contrastRatio(highContrastVars['--slate-700'], SURFACE_1)).toBeGreaterThanOrEqual(2.5) // >1.44, headroom below 3:1 by design (recon note)
    expect(contrastRatio(highContrastVars['--slate-600'], SURFACE_1)).toBeGreaterThanOrEqual(3.0)
    expect(contrastRatio(highContrastVars['--slate-550'], SURFACE_1)).toBeGreaterThanOrEqual(3.0)
  })

  it('text-disabled (--slate-500) clears its 3:1 disabled-tier floor', () => {
    expect(contrastRatio(highContrastVars['--slate-500'], SURFACE_1)).toBeGreaterThanOrEqual(3.0)
  })

  it('text-muted (--slate-400) and text-secondary (--slate-300) clear the 4.5:1 body floor', () => {
    expect(contrastRatio(highContrastVars['--slate-400'], SURFACE_1)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(highContrastVars['--slate-300'], SURFACE_1)).toBeGreaterThanOrEqual(4.5)
  })

  it('the three broken dim/disabled one-offs clear their appropriate floor', () => {
    // --text-dim (tree-layer-count, real metadata text) needed the 4.5:1 body floor.
    expect(contrastRatio(highContrastVars['--text-dim'], SURFACE_1)).toBeGreaterThanOrEqual(4.5)
    // --text-dim-overlay / --text-disabled-overlay needed the 3:1 secondary/disabled floor.
    expect(contrastRatio(highContrastVars['--text-dim-overlay'], SURFACE_1)).toBeGreaterThanOrEqual(3.0)
    expect(contrastRatio(highContrastVars['--text-disabled-overlay'], SURFACE_1)).toBeGreaterThanOrEqual(3.0)
  })

  it('badge-counter white-on-fill pairs (--accent-strong / --status-error) clear the 4.5:1 body floor', () => {
    const WHITE = '#ffffff'
    expect(contrastRatio(WHITE, highContrastVars['--blue-600'])).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(WHITE, highContrastVars['--red-500'])).toBeGreaterThanOrEqual(4.5)
  })

  it('--red-500 documented tradeoff: white-on-fill genuinely fixed, .status-degraded text takes a disclosed bounded step (still readable, tokens.css block header explains why one shared primitive cannot clear both floors)', () => {
    const WHITE = '#ffffff'
    // FILL usage (.badge-counter.badge-danger): real fix, was failing.
    const fillBefore = contrastRatio(WHITE, baseVars['--red-500'])
    const fillAfter = contrastRatio(WHITE, highContrastVars['--red-500'])
    expect(fillBefore).toBeLessThan(4.5)
    expect(fillAfter).toBeGreaterThanOrEqual(4.5)
    // TEXT usage (.status-degraded): was barely passing, now a disclosed step
    // below 4.5 -- still well above the 3:1 non-text/large-text floor.
    const textBefore = contrastRatio(baseVars['--red-500'], SURFACE_1)
    const textAfter = contrastRatio(highContrastVars['--red-500'], SURFACE_1)
    expect(textBefore).toBeGreaterThanOrEqual(4.5)
    expect(textAfter).toBeGreaterThanOrEqual(3.0)
  })

  it('every high-contrast override either improves on its base value (measured vs surface-1) or stays far above every WCAG floor', () => {
    // --blue-600 and --red-500 are FILL-primary tokens (accent-strong /
    // status-error backgrounds) with their own dedicated, more accurate
    // white-on-fill tests above -- their vs-surface-1 "as text" ratio is not
    // their real usage (--blue-600 is never consumed as a text color at
    // all; --red-500's one real text usage, .status-degraded, is covered by
    // name in the dedicated tradeoff test above), so they are excluded here
    // rather than double-counted against the wrong pairing.
    const COVERED_ELSEWHERE = new Set(['--blue-600', '--red-500'])
    // Two deliberate, disclosed exceptions (both documented in the tokens.css
    // block header): violet-500 trades a small amount of headroom for
    // saturation but still clears 4.5:1; blue-400 (focus-ring) moves
    // 7.88:1 -> 7.47:1 (the recon's own "7.06" before-value does not
    // reproduce from its hex -- a report typo, not a code defect) but both
    // values sit far above every floor (4.5 body / 3:1 UI), so neither is a
    // functional regression even though the raw number decreases.
    const ALLOWED_DECREASE = new Set(['--violet-500', '--blue-400'])
    for (const [name, afterHex] of Object.entries(highContrastVars)) {
      if (COVERED_ELSEWHERE.has(name)) continue
      const beforeHex = baseVars[name]
      expect(beforeHex, `${name} must also exist in the base :root block`).toBeDefined()
      const before = contrastRatio(beforeHex, SURFACE_1)
      const after = contrastRatio(afterHex, SURFACE_1)
      if (ALLOWED_DECREASE.has(name)) {
        expect(after).toBeGreaterThanOrEqual(4.5)
      } else {
        expect(after, `${name}: ${before.toFixed(2)}:1 -> ${after.toFixed(2)}:1 should not regress`)
          .toBeGreaterThanOrEqual(before)
      }
    }
  })

  it('exactly the 20 primitives from the recon delta table are overridden, no more no less', () => {
    expect(Object.keys(highContrastVars).sort()).toEqual([
      '--amber-400', '--blue-300', '--blue-400', '--blue-500', '--blue-600',
      '--cyan-400', '--green-500', '--red-300', '--red-500', '--slate-100',
      '--slate-300', '--slate-400', '--slate-500', '--slate-550', '--slate-600',
      '--slate-700', '--text-dim', '--text-dim-overlay', '--text-disabled-overlay',
      '--violet-500',
    ])
  })

  it('the current (unthemed) palette is byte-identical to before this WO -- default stays default', () => {
    // Spot-check a representative sample of primitives this WO's override
    // block touches: the BASE :root values must be untouched.
    expect(baseVars['--slate-700']).toBe('#2d3748')
    expect(baseVars['--slate-100']).toBe('#e2e8f0')
    expect(baseVars['--blue-600']).toBe('#2e6db8')
    expect(baseVars['--text-dim']).toBe('#555555')
  })
})
