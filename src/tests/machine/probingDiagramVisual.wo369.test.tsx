// WO-369: structural guard for the audited probing-diagram visual system.
// The reactive arithmetic and machine-control contract stay in WO-357/358;
// this file pins the drawing grammar that must survive without color.
// WO-2063 (v2 brief): the Probing screen no longer draws these diagrams; the
// cases that read ProbingPanel.tsx for them are retired. The app.css rules
// below still exist, so their pins stay.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../../styles/app.css', import.meta.url), 'utf8')

function cssRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css)
  if (!match) throw new Error(`Missing CSS rule: ${selector}`)
  return match[1]
}

describe('WO-369 audited probing diagram visual grammar', () => {
  it('keeps dotted, dashed, and solid states visible without color', () => {
    expect(cssRule('.control-probe-diagram-arrow-casing')).toMatch(/stroke-width:\s*5/)
    expect(cssRule('.control-probe-diagram-arrow-casing')).toMatch(/stroke-linecap:\s*butt/)
    expect(cssRule('.control-probe-diagram-arrow-shaft')).toMatch(/stroke-linecap:\s*butt/)
    expect(css).toMatch(/arrow-pending[\s\S]*arrow-casing[\s\S]*stroke-dasharray:\s*1\.5 5/)
    expect(css).toMatch(/arrow-next[\s\S]*arrow-casing[\s\S]*stroke-dasharray:\s*9 5/)
    expect(css).toMatch(/arrow-landed[\s\S]*arrow-casing[\s\S]*stroke-dasharray:\s*none/)
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce/)
  })

  it('WO-384 locks readable desktop zones and responsive fallbacks', () => {
    expect(cssRule('.control-probing-columns')).toMatch(/minmax\(400px,\s*0\.9fr\)/)
    expect(cssRule('.control-probing-columns')).toMatch(/minmax\(480px,\s*1\.1fr\)/)
    expect(cssRule('.control-probing-columns')).toMatch(/minmax\(360px,\s*0\.9fr\)/)
    expect(cssRule('.control-probing-controls-col')).toMatch(/display:\s*contents/)
    expect(cssRule('.control-probe-routine-tile')).toMatch(/min-height:\s*52px/)
    expect(cssRule('.control-probe-feature-size-help')).toMatch(/font-size:\s*var\(--font-size-md\)/)
    expect(cssRule('.control-probe-path-check')).toMatch(/font-size:\s*var\(--font-size-md\)/)
    expect(cssRule('.control-probe-diagram-captions')).toMatch(/font-size:\s*var\(--font-size-md\)/)
    expect(css).toMatch(/@media \(max-width:\s*1280px\)/)
    expect(css).toMatch(/@media \(max-width:\s*760px\)/)
  })

  it('WO-386 places guidance in the right workflow column using the normal HMI surface', () => {
    expect(cssRule('.control-probe-guided')).toMatch(/surface-2\) 66%/)
    expect(cssRule('.control-probe-guided')).not.toMatch(/select-viewport/)
    expect(css).toMatch(/\.control-probe-guided\s*\{\s*grid-column:\s*3;\s*grid-row:\s*2 \/ 4;/)
    expect(cssRule('.control-probe-diagram-captions')).toMatch(/grid-template-columns:\s*repeat\(2/)
  })

  it('uses tokens only in the shipped probing-diagram block', () => {
    const start = css.indexOf('/* WO-369: audited reactive shop drawing.')
    const end = css.indexOf('.control-probe-diagram-caption {', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(css.slice(start, end)).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d/)
  })
})
