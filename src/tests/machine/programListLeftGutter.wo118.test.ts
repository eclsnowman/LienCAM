import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appCss = readFileSync('src/styles/app.css', 'utf8')
const programPanel = readFileSync('src/components/machine/ProgramPanel.tsx', 'utf8')

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const matches = Array.from(appCss.matchAll(new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, 'gm')))
  if (matches.length === 0) throw new Error(`no CSS rule found for "${selector}"`)
  return matches.map((match) => match[1]).join('\n')
}

describe('WO-118 program-list left gutter', () => {
  it('reclaims only the Control rail row left padding', () => {
    expect(ruleBody('.gcode-line')).toMatch(/padding:\s*0 12px/)
    expect(
      ruleBody('.control-col-main .control-program-main .control-gcode-list .gcode-line'),
    ).toMatch(/padding-left:\s*0/)
  })

  it('sizes the number column to the loaded program without shifting while scrolling', () => {
    const lineNumber = ruleBody('.gcode-lineno')
    expect(lineNumber).toMatch(/width:\s*64px/)
    expect(lineNumber).toMatch(/padding-right:\s*14px/)
    expect(
      ruleBody('.control-col-main .control-program-main .control-gcode-list .gcode-lineno'),
    ).toMatch(
      /width:\s*calc\(var\(--control-gcode-line-number-width,\s*6ch\)\s*\+\s*21px\)/,
    )
    expect(programPanel).toContain(
      "'--control-gcode-line-number-width': `${Math.max(1, String(lines.length).length)}ch`",
    )
  })

  it('preserves the right-side Run from here reserve byte-for-byte', () => {
    expect(programPanel).toContain(
      "style={{ marginLeft: 'auto', padding: '0 6px', fontSize: 11 }}",
    )
  })
})
