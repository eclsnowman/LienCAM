// WO-1135: homed DRO letters need a second, distance-readable channel without
// changing the pre-WO-1135 26 x 21px label box. Chromium geometry evidence
// lives beside this test in src/tests/evidence/WO-1135/measurements.json.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../../styles/app.css', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
type Rect = { x: number; y: number; width: number; height: number }
type Wo1119Record = {
  state: string
  viewport: { width: number; height: number }
  measured: { X: { label: Rect } }
}

const wo1119Evidence: { evidence: Wo1119Record[] } = JSON.parse(
  readFileSync(new URL('../evidence/WO-1119/measurements.json', import.meta.url), 'utf8'),
)
const preWo1135Record = wo1119Evidence.evidence.find((record) =>
  record.state === 'none-homed' && record.viewport.width === 1680 && record.viewport.height === 900,
)
if (!preWo1135Record) throw new Error('WO-1119 1680x900 none-homed baseline is missing')
const preWo1135Label = preWo1135Record.measured.X.label

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css)
  if (!match) throw new Error(`Missing CSS rule: ${selector}`)
  return match[1]
}

function declaration(body: string, property: string): string {
  const match = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`).exec(body)
  if (!match) throw new Error(`Missing ${property} declaration`)
  return match[1].trim()
}

describe('WO-1135 homed DRO axis box', () => {
  const axis = rule('.control-dro-row .control-dro-axis')
  const homed = rule('.control-dro-row .control-dro-axis-homed')

  it('keeps the pre-WO-1135 26 x 21px label box fixed in both states', () => {
    expect(preWo1135Label).toEqual({ x: 21, y: 307, width: 26, height: 21 })
    expect(declaration(axis, 'box-sizing')).toBe('border-box')
    expect(declaration(axis, 'display')).toBe('inline-flex')
    expect(declaration(axis, 'width')).toBe(`${preWo1135Label.width}px`)
    expect(declaration(axis, 'height')).toBe(`${preWo1135Label.height}px`)
    expect(declaration(axis, 'padding')).toBe('0 2px')
    expect(declaration(axis, 'border')).toBe('1px solid transparent')
    expect(declaration(axis, 'border-radius')).toBe('10px')
  })

  it('uses the active token for the homed border and a tighter, stronger glow only', () => {
    expect(declaration(homed, 'color')).toBe('var(--text-active)')
    expect(declaration(homed, 'border-color')).toBe('var(--text-active)')
    expect(declaration(homed, 'text-shadow')).toBe(
      '0 0 6px color-mix(in srgb, var(--text-active) 70%, transparent)',
    )
    expect(axis).not.toMatch(/text-shadow|box-shadow/)
  })
})
