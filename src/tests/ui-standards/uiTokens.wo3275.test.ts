// WO-3275 (UI M2 Wave 0): the New UI token source. src/theme/tokens.ts carries the M1 design
// tokens unchanged (compared with the M1 study's tokens.mjs, copied whole into this order's
// evidence), every theme fills every role, every theme passes the contrast floor
// (tools/ui-contrast.mjs), and the emitted CSS lives only under the New UI root, so the shipped
// theme (tokens.css, [data-theme] on <html>) cannot change.
import { describe, expect, it } from 'vitest'
import * as tokens from '../../theme/tokens'

interface M1Tokens {
  THEMES: unknown
  STOP: unknown
  TOOL_BODY: unknown
  SCALE: unknown
  MOVES: [string, string, string, string, boolean?][]
  LAYOUT: { targets: [number, number, string][] } & Record<string, unknown>
}
interface ContrastTool {
  checkThemes(themes: unknown, stop: unknown): { rows: unknown[]; failures: unknown[] }
}
const m1 = (await import(/* @vite-ignore */ new URL('../evidence/WO-3275/m1-tokens.reference.mjs', import.meta.url).href)) as M1Tokens
const { checkThemes } = (await import(/* @vite-ignore */ new URL('../../../tools/ui-contrast.mjs', import.meta.url).href)) as ContrastTool

describe('WO-3275 tokens.ts', () => {
  it('ports the M1 themes, safety token, tool body and scales unchanged', () => {
    expect(tokens.THEMES).toEqual(m1.THEMES)
    expect(tokens.STOP).toEqual(m1.STOP)
    expect(tokens.TOOL_BODY).toEqual(m1.TOOL_BODY)
    expect(tokens.SCALE).toEqual(m1.SCALE)
  })

  it('ports the move colours and the window size classes unchanged', () => {
    const moves = m1.MOVES.map(([id, label, dark, light, dashed]) => ({ id, label, dark, light, ...(dashed ? { dashed } : {}) }))
    expect(tokens.MOVES).toEqual(moves)
    const { targets, ...rest } = m1.LAYOUT
    const { targets: ours, ...ourRest } = tokens.LAYOUT
    expect(ourRest).toEqual(rest)
    expect(ours.map(t => [t.width, t.height, t.name])).toEqual(targets)
  })

  it('fills every role in every theme', () => {
    expect(tokens.UI2_THEME_IDS).toEqual(['dark', 'amber', 'light'])
    const roles = Object.keys(tokens.THEMES.dark).sort()
    for (const id of tokens.UI2_THEME_IDS) expect(Object.keys(tokens.THEMES[id]).sort()).toEqual(roles)
  })

  it('passes the contrast floor in every theme', () => {
    const { rows, failures } = checkThemes(tokens.THEMES, tokens.STOP)
    expect(rows.length).toBeGreaterThan(60)
    expect(failures).toEqual([])
  })

  it('emits custom properties only under the New UI root', () => {
    const css = tokens.tokenCss()
    const selectors = [...css.matchAll(/^([^{]+)\{/gm)].map(m => m[1])
    expect(selectors).toEqual([
      '[data-ui2]',
      '[data-ui2][data-ui2-theme=dark]',
      '[data-ui2][data-ui2-theme=amber]',
      '[data-ui2][data-ui2-theme=light]',
      '[data-ui2][data-ui2-theme=light]',
    ])
    expect(css).not.toMatch(/:root|\[data-theme/)
    expect(css).toContain('--stop:#e5484d')
    expect(css).toContain('--acc-soft:#1f3550')
    expect(css).toContain('--ic-acc-fill2:#4792e1')
    expect(css).toContain('--m-top:#c3cbd4')
    expect(css).toContain('--tool-flutes:#33cc44')
  })

  it('keeps the safety token out of every theme', () => {
    for (const id of tokens.UI2_THEME_IDS) {
      expect(Object.keys(tokens.THEMES[id])).not.toContain('stop')
      expect(tokens.tokenCss().split('\n').filter(l => l.includes(`=${id}]`)).join('')).not.toContain('--stop')
    }
  })

  it('classes window sizes per spec 5.1', () => {
    expect(tokens.sizeClassFor(1024, 600)).toEqual({ width: 'compact', short: true })
    expect(tokens.sizeClassFor(1440, 900)).toEqual({ width: 'regular', short: false })
    expect(tokens.sizeClassFor(1920, 1080)).toEqual({ width: 'wide', short: false })
  })
})
