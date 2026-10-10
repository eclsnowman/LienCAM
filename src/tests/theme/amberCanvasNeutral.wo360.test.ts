import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync('src/theme/tokens.css', 'utf8')

function block(pattern: RegExp, label: string): string {
  const match = css.match(pattern)
  expect(match, `${label} block not found in tokens.css`).not.toBeNull()
  return match![1]
}

function hexToken(source: string, token: string): string {
  const match = source.match(new RegExp(`${token}\\s*:\\s*(#[0-9a-fA-F]{6})\\s*;`))
  expect(match, `${token} not found`).not.toBeNull()
  return match![1].toLowerCase()
}

function channels(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16)
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
}

const base = block(/:root\s*\{([\s\S]*?)\n\}/, 'base :root')
const amber = block(/:root\[data-theme="amber"\]\s*\{([\s\S]*?)\n\}/, 'amber theme')

describe('WO-360 amber viewport background neutrality', () => {
  it('keeps the amber canvas on its neutral reference after the default page well deepened', () => {
    // WO-1151 (6a697f93b) deepened the default canvas to #0d1117 while
    // deliberately leaving amber's neutral viewport reference at #111418.
    const amberHex = hexToken(amber, '--vp-canvas')
    const [red, green, blue] = channels(amberHex)
    expect(amberHex).toBe('#111418')
    expect(amberHex).not.toBe(hexToken(base, '--vp-canvas'))
    expect(blue).toBeGreaterThanOrEqual(Math.min(red, green))
  })

  it('keeps the amber grid plane equal to the neutral default reference', () => {
    const amberHex = hexToken(amber, '--vp-grid-plane')
    const [red, green, blue] = channels(amberHex)
    expect(amberHex).toBe(hexToken(base, '--vp-grid-plane'))
    expect(blue).toBeGreaterThanOrEqual(Math.min(red, green))
  })

  it('keeps the intended amber viewport accents unchanged', () => {
    expect(hexToken(amber, '--vp-grid')).toBe('#36312a')
    expect(hexToken(amber, '--vp-stock')).toBe('#8a662a')
    expect(hexToken(amber, '--vp-stock-edge')).toBe('#d4a04a')
    expect(hexToken(amber, '--vp-workpiece')).toBe('#ccb38a')
    expect(hexToken(amber, '--vp-workpiece-edge')).toBe('#ecdbbf')
  })
})
