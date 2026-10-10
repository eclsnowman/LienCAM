import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../../styles/app.css', import.meta.url), 'utf8')

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const matches = Array.from(css.matchAll(new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, 'gm')))
  if (matches.length === 0) throw new Error(`Missing CSS rule: ${selector}`)
  return matches.map((match) => match[1]).join('\n')
}

describe('WO-389 bounded Control transport geometry', () => {
  it('uses shrinkable grid tracks and bounds the E-STOP button to its column', () => {
    const cluster = ruleBody('.control-uix-transport')
    expect(cluster).toMatch(/grid-template-columns:\s*minmax\(0, 1\.4fr\) repeat\(2, minmax\(0, 1fr\)\)/)
    expect(cluster).toMatch(/min-width:\s*0/)
    expect(cluster).toMatch(/max-width:\s*100%/)

    const estop = ruleBody('.control-uix-transport .control-btn-estop')
    expect(estop).toMatch(/min-width:\s*0/)
    expect(estop).toMatch(/max-width:\s*100%/)
  })

  it('wraps a long reset refusal across a full bounded transport row', () => {
    const refusal = ruleBody('.control-estop-refusal')
    expect(refusal).toMatch(/white-space:\s*normal/)
    expect(refusal).toMatch(/overflow-wrap:\s*anywhere/)
    expect(refusal).toMatch(/min-width:\s*0/)
    expect(refusal).toMatch(/max-width:\s*100%/)
    expect(ruleBody('.control-uix-transport .control-estop-refusal')).toMatch(/grid-column:\s*1 \/ -1/)
  })
})
