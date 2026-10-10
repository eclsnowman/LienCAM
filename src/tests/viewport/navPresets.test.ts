import { describe, it, expect } from 'vitest'
import { NAV_PRESETS, resolveNavAction } from '../../types'
import type { NavModifierState, NavButtonAction } from '../../types'

// Pure unit tests for resolveNavAction — the modifier -> action table logic for
// faithful CAD presets. No DOM / Three (the viewport remapper's
// OrbitControls-swap compensation is exercised by manual feel-check, not here).

const NONE: NavModifierState = { shift: false, ctrl: false, alt: false }
const SHIFT: NavModifierState = { shift: true, ctrl: false, alt: false }
const CTRL: NavModifierState = { shift: false, ctrl: true, alt: false }
const ALT: NavModifierState = { shift: false, ctrl: false, alt: true }

function resolveMiddle(preset: keyof typeof NAV_PRESETS, mods: NavModifierState): NavButtonAction {
  return resolveNavAction(NAV_PRESETS[preset], 'MIDDLE', mods)
}

describe('resolveNavAction — faithful preset middle-button combos', () => {
  it('Fusion 360: MMB=pan, Shift+MMB=orbit, LEFT=none', () => {
    expect(resolveMiddle('fusion', NONE)).toBe('pan')
    expect(resolveMiddle('fusion', SHIFT)).toBe('orbit')
    // Unmapped modifier (Ctrl) falls back to the static middle mapping (pan).
    expect(resolveMiddle('fusion', CTRL)).toBe('pan')
    expect(resolveNavAction(NAV_PRESETS.fusion, 'LEFT', NONE)).toBe('none')
  })

  it('SolidWorks: MMB=orbit, Ctrl+MMB=pan, Shift+MMB=zoom, LEFT=none', () => {
    expect(resolveMiddle('solidworks', NONE)).toBe('orbit')
    expect(resolveMiddle('solidworks', CTRL)).toBe('pan')
    expect(resolveMiddle('solidworks', SHIFT)).toBe('zoom')
    expect(resolveNavAction(NAV_PRESETS.solidworks, 'LEFT', NONE)).toBe('none')
  })

  it('Inventor: MMB=pan, Shift+MMB=orbit, Ctrl+MMB=zoom, LEFT=none', () => {
    expect(resolveMiddle('inventor', NONE)).toBe('pan')
    expect(resolveMiddle('inventor', SHIFT)).toBe('orbit')
    expect(resolveMiddle('inventor', CTRL)).toBe('zoom')
    expect(resolveNavAction(NAV_PRESETS.inventor, 'LEFT', NONE)).toBe('none')
  })

  it('Creo: MMB=orbit, Shift+MMB=pan, Ctrl+MMB=zoom, LEFT=none', () => {
    expect(resolveMiddle('creo', NONE)).toBe('orbit')
    expect(resolveMiddle('creo', SHIFT)).toBe('pan')
    expect(resolveMiddle('creo', CTRL)).toBe('zoom')
    expect(resolveNavAction(NAV_PRESETS.creo, 'LEFT', NONE)).toBe('none')
  })
})

describe('resolveNavAction — exact modifier matching, not subset', () => {
  it('Shift+MMB rule does NOT fire when an extra modifier is also held', () => {
    // Fusion Shift+MMB=orbit, but Shift+Ctrl+MMB matches no rule -> static pan.
    expect(resolveMiddle('fusion', { shift: true, ctrl: true, alt: false })).toBe('pan')
  })

  it('alt-only does not match a bare or shift/ctrl rule -> static fallback', () => {
    expect(resolveMiddle('fusion', ALT)).toBe('pan')      // static MIDDLE = pan
    expect(resolveMiddle('solidworks', ALT)).toBe('orbit') // static MIDDLE = orbit
  })
})

describe('resolveNavAction — bare-button presets ignore modifiers', () => {
  it('liencnc-default has no modifierRules: action is the static mapping', () => {
    expect(resolveNavAction(NAV_PRESETS['liencnc-default'], 'LEFT', NONE)).toBe('orbit')
    expect(resolveNavAction(NAV_PRESETS['liencnc-default'], 'LEFT', SHIFT)).toBe('orbit')
    expect(resolveNavAction(NAV_PRESETS['liencnc-default'], 'MIDDLE', NONE)).toBe('zoom')
    expect(resolveNavAction(NAV_PRESETS['liencnc-default'], 'RIGHT', CTRL)).toBe('pan')
  })

  it('onshape / orbit-middle ignore modifiers entirely', () => {
    expect(resolveNavAction(NAV_PRESETS.onshape, 'RIGHT', SHIFT)).toBe('orbit')
    expect(resolveNavAction(NAV_PRESETS.onshape, 'MIDDLE', CTRL)).toBe('pan')
    expect(resolveNavAction(NAV_PRESETS['orbit-middle'], 'MIDDLE', SHIFT)).toBe('orbit')
  })
})
