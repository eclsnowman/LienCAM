// GEO-25 (Q-50 viewport display theme): pure-logic coverage for the shared
// theme module both renderers (SolidsWorkbenchPage.tsx / CNCViewport.ts)
// consume. No `three` / DOM dependency (mirrors rigDescriptors.ts), so this
// runs under the repo's default 'node' vitest environment.

import { describe, it, expect } from 'vitest'
import {
  DEFAULT_VIEWPORT_THEME,
  VIEWPORT_THEME_COLORS,
  VIEWPORT_THEME_EDGE_WIDTH_PX,
  VIEWPORT_THEME_IDS,
  VIEWPORT_THEME_LABELS,
  hexToNumber,
  hexToUnitRGB,
  isViewportThemeId,
  viewportThemeUsesFatLineEdges,
} from '../../lib/viewport/lighting/viewportThemes'

describe('GEO-25 viewportThemes', () => {
  it('ships exactly the four Q-50 themes, brand-blue default', () => {
    expect(VIEWPORT_THEME_IDS).toEqual(['classic', 'cool-slate', 'brand-blue', 'deep-slate'])
    expect(DEFAULT_VIEWPORT_THEME).toBe('brand-blue')
    for (const id of VIEWPORT_THEME_IDS) {
      expect(typeof VIEWPORT_THEME_LABELS[id]).toBe('string')
      expect(VIEWPORT_THEME_LABELS[id].length).toBeGreaterThan(0)
    }
  })

  it('classic is the one theme with no color override entry', () => {
    expect(VIEWPORT_THEME_COLORS).not.toHaveProperty('classic')
    expect(Object.keys(VIEWPORT_THEME_COLORS).sort()).toEqual(['brand-blue', 'cool-slate', 'deep-slate'])
  })

  it('every non-classic theme cites the exact Q-50 card hex values (evidence: coordination/evidence/GEO-25/*.summary.json)', () => {
    expect(VIEWPORT_THEME_COLORS['cool-slate'].bodyHex).toBe('#7e8ea1')
    expect(VIEWPORT_THEME_COLORS['cool-slate'].edgeHex).toBe('#2d3748')
    expect(VIEWPORT_THEME_COLORS['brand-blue'].bodyHex).toBe('#7ec0ff')
    expect(VIEWPORT_THEME_COLORS['brand-blue'].edgeHex).toBe('#1e4a7a')
    expect(VIEWPORT_THEME_COLORS['deep-slate'].bodyHex).toBe('#546070')
    expect(VIEWPORT_THEME_COLORS['deep-slate'].edgeHex).toBe('#e2e8f0')
  })

  it('shares the consistent 1.25px resting-edge width across every non-classic theme', () => {
    // Interaction overlays intentionally use their own heavier 4px/5px
    // contract; this token controls only resting modeled topology.
    expect(VIEWPORT_THEME_EDGE_WIDTH_PX).toBe(1.25)
  })

  it('viewportThemeUsesFatLineEdges: classic is the only thin-edge theme', () => {
    expect(viewportThemeUsesFatLineEdges('classic')).toBe(false)
    expect(viewportThemeUsesFatLineEdges('cool-slate')).toBe(true)
    expect(viewportThemeUsesFatLineEdges('brand-blue')).toBe(true)
    expect(viewportThemeUsesFatLineEdges('deep-slate')).toBe(true)
  })

  it('isViewportThemeId: valid ids true, anything else (incl. stale/tampered persisted values) false', () => {
    for (const id of VIEWPORT_THEME_IDS) expect(isViewportThemeId(id)).toBe(true)
    expect(isViewportThemeId('deep-slate-inverse')).toBe(false) // the prototype's pre-Q-50-card candidate id
    expect(isViewportThemeId('dark')).toBe(false)
    expect(isViewportThemeId(undefined)).toBe(false)
    expect(isViewportThemeId(null)).toBe(false)
    expect(isViewportThemeId(42)).toBe(false)
    expect(isViewportThemeId('')).toBe(false)
  })

  it('hexToNumber round-trips the Q-50 card values to their numeric THREE.Color hex form', () => {
    expect(hexToNumber('#7ec0ff')).toBe(0x7ec0ff)
    expect(hexToNumber('#1e4a7a')).toBe(0x1e4a7a)
    expect(hexToNumber('#000000')).toBe(0)
    expect(hexToNumber('#ffffff')).toBe(0xffffff)
  })

  it('hexToUnitRGB produces the hex-byte/255 vertex-color convention (matches DEFAULT_HIGHLIGHT_COLORS shape)', () => {
    const [r, g, b] = hexToUnitRGB('#7ec0ff')
    expect(r).toBeCloseTo(0x7e / 255, 10)
    expect(g).toBeCloseTo(0xc0 / 255, 10)
    expect(b).toBeCloseTo(0xff / 255, 10)
    expect(hexToUnitRGB('#000000')).toEqual([0, 0, 0])
    expect(hexToUnitRGB('#ffffff')).toEqual([1, 1, 1])
  })
})
