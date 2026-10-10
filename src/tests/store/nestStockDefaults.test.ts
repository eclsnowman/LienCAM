// N1d nest-stock app-preference slice (groundwork — type + store-slice only):
// `appSettings.defaultStockThicknessMm` and `appSettings.defaultStockPaddingXYMm`
// are APP preferences (sibling of `project`, persisted in localStorage, NOT part
// of the .camproject export). They:
//   - default to 12 (thickness, mm) and 0 (padding, mm);
//   - are mutable via setDefaultStockThickness / setDefaultStockPadding;
//   - prefill the nest thickness selector + new bound stocks (behavior comes later).
//
// Mirrors the structure of appSettings.test.ts (snapshot + restore so tests don't
// bleed). No behavior is asserted here — this is pure groundwork (N1d Item 1).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { useCamStore } from '../../store'

const state = () => useCamStore.getState()

// Snapshot + restore both prefs so tests don't bleed into one another.
let savedThickness: number
let savedPadding: number
beforeEach(() => {
  savedThickness = state().appSettings.defaultStockThicknessMm
  savedPadding = state().appSettings.defaultStockPaddingXYMm
})
afterEach(() => {
  useCamStore.setState((s) => ({
    appSettings: {
      ...s.appSettings,
      defaultStockThicknessMm: savedThickness,
      defaultStockPaddingXYMm: savedPadding,
    },
  }))
})

describe('appSettings nest-stock defaults (N1d)', () => {
  it('defaults: thickness 12mm, padding 0mm', () => {
    expect(state().appSettings.defaultStockThicknessMm).toBe(12)
    expect(state().appSettings.defaultStockPaddingXYMm).toBe(0)
  })

  it('setDefaultStockThickness updates only the thickness pref', () => {
    state().setDefaultStockThickness(19)
    expect(state().appSettings.defaultStockThicknessMm).toBe(19)
    // Padding untouched.
    expect(state().appSettings.defaultStockPaddingXYMm).toBe(0)

    state().setDefaultStockThickness(6.35)
    expect(state().appSettings.defaultStockThicknessMm).toBe(6.35)
  })

  it('setDefaultStockPadding updates only the padding pref', () => {
    state().setDefaultStockPadding(5)
    expect(state().appSettings.defaultStockPaddingXYMm).toBe(5)
    // Thickness untouched.
    expect(state().appSettings.defaultStockThicknessMm).toBe(12)

    state().setDefaultStockPadding(2.5)
    expect(state().appSettings.defaultStockPaddingXYMm).toBe(2.5)
  })
})
