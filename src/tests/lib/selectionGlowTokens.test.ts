// GEO-26 Stage A/B: pure-logic coverage for the shared selection/hover glow
// token module (src/lib/viewport/lighting/selectionGlowTokens.ts). Mirrors
// viewportThemes.test.ts's shape (sibling module, same test directory) for
// the color-table assertions. Stage B killed the dev-only ?glowCandidate=
// query-param/localStorage runtime selector (getActiveGlowCandidate()/
// setActiveGlowCandidate()), so this file no longer needs jsdom for that --
// it runs in the repo's 'node' default like viewportThemes.test.ts now.
// The persisted-preference read/write/migration/fail-safe path that
// REPLACES the dev selector is covered in src/tests/store/uiPrefs.test.ts
// (selectionGlow), not here -- this file stays pure-logic only.

import { describe, expect, it } from 'vitest'
import { VIEWPORT_THEME_IDS, type ViewportThemeId } from '../../lib/viewport/lighting/viewportThemes'
import {
  DEFAULT_SELECTION_GLOW,
  SELECTION_ORANGE_HOVER,
  SELECTION_ORANGE_SELECTED,
  SELECTION_GLOW_CANDIDATE_IDS,
  SELECTION_GLOW_CANDIDATE_LABELS,
  isSelectionGlowCandidateId,
  resolveSelectionGlowColors,
} from '../../lib/viewport/lighting/selectionGlowTokens'

describe('GEO-26 selectionGlowTokens', () => {
  it('ships exactly 4 candidates including the current/shipped baseline', () => {
    expect(SELECTION_GLOW_CANDIDATE_IDS).toEqual([
      'current', 'signature', 'complementary', 'brightness-halo',
    ])
    for (const id of SELECTION_GLOW_CANDIDATE_IDS) {
      expect(typeof SELECTION_GLOW_CANDIDATE_LABELS[id]).toBe('string')
      expect(SELECTION_GLOW_CANDIDATE_LABELS[id].length).toBeGreaterThan(0)
    }
  })

  it('SHIPPED-DEFAULT GUARANTEE: candidate "current" resolves to null for every theme (callers keep their own pre-existing color)', () => {
    for (const theme of VIEWPORT_THEME_IDS) {
      expect(resolveSelectionGlowColors('current', theme)).toBeNull()
    }
  })

  it('every non-current candidate resolves a real color pair on every one of the 4 themes (per-theme lookup table, not a single global pair)', () => {
    const nonCurrent = SELECTION_GLOW_CANDIDATE_IDS.filter((id) => id !== 'current')
    for (const candidate of nonCurrent) {
      for (const theme of VIEWPORT_THEME_IDS) {
        const colors = resolveSelectionGlowColors(candidate, theme)
        expect(colors).not.toBeNull()
        expect(typeof colors!.hover).toBe('number')
        expect(typeof colors!.selected).toBe('number')
        expect(colors!.hover).toBeGreaterThanOrEqual(0)
        expect(colors!.hover).toBeLessThanOrEqual(0xffffff)
        expect(colors!.selected).toBeGreaterThanOrEqual(0)
        expect(colors!.selected).toBeLessThanOrEqual(0xffffff)
      }
    }
  })

  it('hover and selected are always distinct colors within one candidate+theme pair (no collision)', () => {
    const nonCurrent = SELECTION_GLOW_CANDIDATE_IDS.filter((id) => id !== 'current')
    for (const candidate of nonCurrent) {
      for (const theme of VIEWPORT_THEME_IDS) {
        const colors = resolveSelectionGlowColors(candidate, theme)!
        expect(colors.hover).not.toBe(colors.selected)
      }
    }
  })

  it('"signature" is the orange contrast default with lighter hover and darker selection on every theme', () => {
    for (const theme of VIEWPORT_THEME_IDS) {
      const colors = resolveSelectionGlowColors('signature', theme)!
      expect(colors.hover).toBe(SELECTION_ORANGE_HOVER)
      expect(colors.selected).toBe(SELECTION_ORANGE_SELECTED)
    }
    expect(SELECTION_GLOW_CANDIDATE_LABELS.signature).toBe('Orange Contrast')
  })

  it('"complementary" is genuinely per-theme-tuned: the blue-body themes (cool-slate, brand-blue) diverge from the neutral-body themes (classic, deep-slate)', () => {
    const blue1 = resolveSelectionGlowColors('complementary', 'cool-slate')!
    const blue2 = resolveSelectionGlowColors('complementary', 'brand-blue')!
    const neutral1 = resolveSelectionGlowColors('complementary', 'classic')!
    const neutral2 = resolveSelectionGlowColors('complementary', 'deep-slate')!
    expect(blue1).toEqual(blue2)
    expect(neutral1).toEqual(neutral2)
    expect(blue1).not.toEqual(neutral1)
  })

  it('"brightness-halo" carries haloOpacityMul/haloWidthMul intensity knobs, absent from the other candidates', () => {
    for (const theme of VIEWPORT_THEME_IDS) {
      const halo = resolveSelectionGlowColors('brightness-halo', theme)!
      expect(halo.haloOpacityMul).toBeGreaterThan(1)
      expect(halo.haloWidthMul).toBeGreaterThan(1)
      const signature = resolveSelectionGlowColors('signature', theme)!
      expect(signature.haloOpacityMul).toBeUndefined()
      expect(signature.haloWidthMul).toBeUndefined()
    }
  })

  it('isSelectionGlowCandidateId: valid ids true, anything else (incl. tampered persisted values) false', () => {
    for (const id of SELECTION_GLOW_CANDIDATE_IDS) expect(isSelectionGlowCandidateId(id)).toBe(true)
    expect(isSelectionGlowCandidateId('classic')).toBe(false)
    expect(isSelectionGlowCandidateId('signature-v2')).toBe(false)
    expect(isSelectionGlowCandidateId(undefined)).toBe(false)
    expect(isSelectionGlowCandidateId(null)).toBe(false)
    expect(isSelectionGlowCandidateId(42)).toBe(false)
    expect(isSelectionGlowCandidateId('')).toBe(false)
  })

  it('DEFAULT_SELECTION_GLOW is "signature" (Q-53 processing ruling Operator endorsed verbatim) and is itself a valid, resolvable candidate id', () => {
    expect(DEFAULT_SELECTION_GLOW).toBe('signature')
    expect(isSelectionGlowCandidateId(DEFAULT_SELECTION_GLOW)).toBe(true)
    for (const theme of VIEWPORT_THEME_IDS) {
      expect(resolveSelectionGlowColors(DEFAULT_SELECTION_GLOW, theme)).not.toBeNull()
    }
  })

  // MUTATION PROOF (queue-vetting / charter bar): flips ONE theme's ONE
  // candidate color to prove resolution genuinely reads a per-theme table
  // (not a single shared constant that would make every theme's assertion
  // above pass vacuously). This test intentionally FAILS if 'complementary'
  // stops being per-theme-resolved -- e.g. if a future edit collapsed the
  // per-theme table back to one shared constant, `brand-blue`'s selected
  // color would silently equal `classic`'s and this assertion would break.
  it('MUTATION PROOF: complementary/brand-blue selected differs from complementary/classic selected (per-theme table, not a shared constant)', () => {
    const brandBlue = resolveSelectionGlowColors('complementary', 'brand-blue' satisfies ViewportThemeId)!
    const classic = resolveSelectionGlowColors('complementary', 'classic' satisfies ViewportThemeId)!
    expect(brandBlue.selected).not.toBe(classic.selected)
  })
})
