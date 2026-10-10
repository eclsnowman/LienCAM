// Single-key sketch shortcuts (Stage 6) — pure dispatch map + focus
// guard. The viewport key handler (sketch mode only) dispatches through
// shortcutActionForKeyEvent, so pinning this module pins the behavior.

import { describe, it, expect, beforeEach } from 'vitest'
import {
  SKETCH_TOOL_SHORTCUTS,
  SHORTCUT_KEY_BY_TOOL,
  SKETCH_UTILITY_SHORTCUTS,
  SHORTCUT_KEY_BY_UTILITY,
  isTypingTarget,
  shortcutToolForKeyEvent,
  shortcutActionForKeyEvent,
} from '../../lib/sketch/tools/shortcuts'
import { ARMABLE_TOOLS } from '../../lib/sketch/tools/toolMachine'
import { sketcherToolStore, sketcherTools } from '../../lib/sketch/sketcher'

describe('shortcut dispatch map', () => {
  it('maps the doctrine keys to their tools (PLAN 3.4 + remaining-shortcuts)', () => {
    expect(SKETCH_TOOL_SHORTCUTS).toEqual({
      l: 'line',
      r: 'rect-corner',
      c: 'circle-center',
      s: 'spline',
      g: 'text',
      a: 'arc-3pt',
      d: 'smart-dimension',
      t: 'trim',
      k: 'split',
      o: 'offset',
      m: 'mirror',
      e: 'extend',
      f: 'fillet',
      h: 'chamfer',
      '1': 'pattern-linear',
      '2': 'pattern-circular',
      '3': 'pattern-path',
      v: 'move',
      w: 'rotate',
      x: 'scale',
    })
  })

  it('every shortcut target is an armable tool', () => {
    for (const tool of Object.values(SKETCH_TOOL_SHORTCUTS)) {
      expect(ARMABLE_TOOLS.has(tool)).toBe(true)
    }
  })

  it('existing shortcuts remain unchanged (the original 10)', () => {
    // The five new keys (e/f/h/1/2) are additive; none of the original
    // doctrine keys were remapped or removed.
    expect(SKETCH_TOOL_SHORTCUTS.l).toBe('line')
    expect(SKETCH_TOOL_SHORTCUTS.r).toBe('rect-corner')
    expect(SKETCH_TOOL_SHORTCUTS.c).toBe('circle-center')
    expect(SKETCH_TOOL_SHORTCUTS.s).toBe('spline')
    expect(SKETCH_TOOL_SHORTCUTS.g).toBe('text')
    expect(SKETCH_TOOL_SHORTCUTS.a).toBe('arc-3pt')
    expect(SKETCH_TOOL_SHORTCUTS.d).toBe('smart-dimension')
    expect(SKETCH_TOOL_SHORTCUTS.t).toBe('trim')
    expect(SKETCH_TOOL_SHORTCUTS.o).toBe('offset')
    expect(SKETCH_TOOL_SHORTCUTS.m).toBe('mirror')
  })

  it('every new tool key dispatches to its tool', () => {
    expect(shortcutToolForKeyEvent({ key: 'e' })).toBe('extend')
    expect(shortcutToolForKeyEvent({ key: 'f' })).toBe('fillet')
    expect(shortcutToolForKeyEvent({ key: 'h' })).toBe('chamfer')
    expect(shortcutToolForKeyEvent({ key: '1' })).toBe('pattern-linear')
    expect(shortcutToolForKeyEvent({ key: '2' })).toBe('pattern-circular')
    expect(shortcutToolForKeyEvent({ key: '3' })).toBe('pattern-path')
  })

  it('uppercase keys dispatch too (caps lock / shift), for old and new keys', () => {
    expect(shortcutToolForKeyEvent({ key: 'L' })).toBe('line')
    expect(shortcutToolForKeyEvent({ key: 'R' })).toBe('rect-corner')
    expect(shortcutToolForKeyEvent({ key: 'E' })).toBe('extend')
    expect(shortcutToolForKeyEvent({ key: 'F' })).toBe('fillet')
    expect(shortcutToolForKeyEvent({ key: 'H' })).toBe('chamfer')
    // Pattern shortcuts are the plain, unshifted digit keys. Shift+1/2
    // produce layout punctuation (for example !/@ on a US keyboard).
    expect(shortcutToolForKeyEvent({ key: '1' })).toBe('pattern-linear')
    expect(shortcutToolForKeyEvent({ key: '2' })).toBe('pattern-circular')
    expect(shortcutToolForKeyEvent({ key: '!' })).toBeNull()
    expect(shortcutToolForKeyEvent({ key: '@' })).toBeNull()
  })

  it('unknown keys and multi-char keys return null', () => {
    expect(shortcutToolForKeyEvent({ key: 'z' })).toBeNull()
    expect(shortcutToolForKeyEvent({ key: 'Enter' })).toBeNull()
    expect(shortcutToolForKeyEvent({ key: 'Escape' })).toBeNull()
    expect(shortcutToolForKeyEvent({ key: 'F1' })).toBeNull()
  })

  it('modifier chords fall through to the browser/app', () => {
    expect(shortcutToolForKeyEvent({ key: 'l', ctrlKey: true })).toBeNull()
    expect(shortcutToolForKeyEvent({ key: 'c', metaKey: true })).toBeNull()
    expect(shortcutToolForKeyEvent({ key: 'a', altKey: true })).toBeNull()
    // New keys honor the same chord guard.
    expect(shortcutToolForKeyEvent({ key: 'e', ctrlKey: true })).toBeNull()
    expect(shortcutToolForKeyEvent({ key: 'f', metaKey: true })).toBeNull()
    expect(shortcutToolForKeyEvent({ key: '1', altKey: true })).toBeNull()
  })

  it('tooltip hints derive from the same map (single source of truth)', () => {
    expect(SHORTCUT_KEY_BY_TOOL['line']).toBe('L')
    expect(SHORTCUT_KEY_BY_TOOL['smart-dimension']).toBe('D')
    expect(SHORTCUT_KEY_BY_TOOL['mirror']).toBe('M')
    // New tools derive their hint from the same map.
    expect(SHORTCUT_KEY_BY_TOOL['extend']).toBe('E')
    expect(SHORTCUT_KEY_BY_TOOL['fillet']).toBe('F')
    expect(SHORTCUT_KEY_BY_TOOL['chamfer']).toBe('H')
    expect(SHORTCUT_KEY_BY_TOOL['pattern-linear']).toBe('1')
    expect(SHORTCUT_KEY_BY_TOOL['pattern-circular']).toBe('2')
    expect(SHORTCUT_KEY_BY_TOOL['pattern-path']).toBe('3')
    expect(Object.keys(SHORTCUT_KEY_BY_TOOL))
      .toHaveLength(Object.keys(SKETCH_TOOL_SHORTCUTS).length)
  })
})

describe('Measure utility shortcut', () => {
  it('maps i to the measure utility', () => {
    expect(SKETCH_UTILITY_SHORTCUTS).toEqual({ i: 'measure' })
  })

  it('shortcutActionForKeyEvent returns a utility action for i (upper and lower)', () => {
    expect(shortcutActionForKeyEvent({ key: 'i' })).toEqual({
      kind: 'utility', utility: 'measure',
    })
    expect(shortcutActionForKeyEvent({ key: 'I' })).toEqual({
      kind: 'utility', utility: 'measure',
    })
  })

  it('shortcutToolForKeyEvent returns null for Measure (it is not a SketchToolId)', () => {
    // The tool-only projection never surfaces Measure, so the tool click
    // machine and the SketchToolId union stay uncontaminated.
    expect(shortcutToolForKeyEvent({ key: 'i' })).toBeNull()
    expect(shortcutToolForKeyEvent({ key: 'I' })).toBeNull()
  })

  it('shortcutActionForKeyEvent returns a tool action for arming keys', () => {
    expect(shortcutActionForKeyEvent({ key: 'l' })).toEqual({
      kind: 'tool', tool: 'line',
    })
    expect(shortcutActionForKeyEvent({ key: 'E' })).toEqual({
      kind: 'tool', tool: 'extend',
    })
    expect(shortcutActionForKeyEvent({ key: '2' })).toEqual({
      kind: 'tool', tool: 'pattern-circular',
    })
  })

  it('typing/modifier guards also reject Measure', () => {
    expect(
      shortcutActionForKeyEvent({ key: 'i', target: { tagName: 'INPUT' } }),
    ).toBeNull()
    expect(
      shortcutActionForKeyEvent({
        key: 'i', target: { tagName: 'DIV', isContentEditable: true },
      }),
    ).toBeNull()
    expect(shortcutActionForKeyEvent({ key: 'i', ctrlKey: true })).toBeNull()
    expect(shortcutActionForKeyEvent({ key: 'i', metaKey: true })).toBeNull()
    expect(shortcutActionForKeyEvent({ key: 'i', altKey: true })).toBeNull()
    expect(shortcutActionForKeyEvent({ key: 'i', repeat: true })).toBeNull()
    // A canvas (non-typing target) is the one case that dispatches.
    expect(
      shortcutActionForKeyEvent({ key: 'i', target: { tagName: 'CANVAS' } }),
    ).toEqual({ kind: 'utility', utility: 'measure' })
  })

  it('utility hint derives from the same utility map', () => {
    expect(SHORTCUT_KEY_BY_UTILITY['measure']).toBe('I')
    expect(Object.keys(SHORTCUT_KEY_BY_UTILITY))
      .toHaveLength(Object.keys(SKETCH_UTILITY_SHORTCUTS).length)
  })
})

describe('Measure toggle flips shared sketcher state', () => {
  beforeEach(() => {
    sketcherToolStore.__reset()
  })

  it('starts false, toggles true, then false', () => {
    expect(sketcherToolStore.getState().measureOpen).toBe(false)
    sketcherTools.toggleMeasure()
    expect(sketcherToolStore.getState().measureOpen).toBe(true)
    sketcherTools.toggleMeasure()
    expect(sketcherToolStore.getState().measureOpen).toBe(false)
  })

  it('setMeasureOpen writes the requested state', () => {
    sketcherTools.setMeasureOpen(true)
    expect(sketcherToolStore.getState().measureOpen).toBe(true)
    // toggleMeasure reads the live state, so it flips back to false.
    sketcherTools.toggleMeasure()
    expect(sketcherToolStore.getState().measureOpen).toBe(false)
  })

  it('closes on a real document switch', () => {
    sketcherTools.toggleMeasure()
    expect(sketcherToolStore.getState().measureOpen).toBe(true)
    sketcherTools.resetForDocumentSwitch()
    expect(sketcherToolStore.getState().measureOpen).toBe(false)
  })

  it('measureOpen is part of SketcherToolState (typed state, not a DOM bridge)', () => {
    // The flag lives on the store-free Sketcher tool state, so CAM and
    // Model sketch hosts read+write the same value.
    expect(typeof sketcherToolStore.getState().measureOpen).toBe('boolean')
  })
})

describe('focus guard (never while typing)', () => {
  it('text fields and editable targets are typing targets', () => {
    expect(isTypingTarget({ tagName: 'INPUT' })).toBe(true)
    expect(isTypingTarget({ tagName: 'input' })).toBe(true) // case-insensitive
    expect(isTypingTarget({ tagName: 'TEXTAREA' })).toBe(true)
    expect(isTypingTarget({ tagName: 'SELECT' })).toBe(true)
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true)
    expect(isTypingTarget({ tagName: 'SPAN', closest: () => ({ tagName: 'DIV' }) })).toBe(true)
  })

  it('ordinary targets are not', () => {
    expect(isTypingTarget({ tagName: 'DIV' })).toBe(false)
    expect(isTypingTarget({ tagName: 'CANVAS' })).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
    expect(isTypingTarget(undefined)).toBe(false)
  })

  it('shortcutToolForKeyEvent includes the focus guard', () => {
    expect(
      shortcutToolForKeyEvent({ key: 'l', target: { tagName: 'INPUT' } }),
    ).toBeNull()
    expect(
      shortcutToolForKeyEvent({ key: 'l', target: { tagName: 'DIV', isContentEditable: true } }),
    ).toBeNull()
    expect(
      shortcutToolForKeyEvent({ key: 'l', target: { tagName: 'CANVAS' } }),
    ).toBe('line')
  })

  it('digit shortcuts yield to all four typing target kinds', () => {
    for (const target of [
      { tagName: 'INPUT' },
      { tagName: 'TEXTAREA' },
      { tagName: 'SELECT' },
      { tagName: 'DIV', isContentEditable: true },
    ]) {
      expect(shortcutToolForKeyEvent({ key: '1', target })).toBeNull()
      expect(shortcutToolForKeyEvent({ key: '2', target })).toBeNull()
    }
  })
})
