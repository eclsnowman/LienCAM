import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { chromium, type Browser } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { ToolDiagram } from '../../components/modals/ToolDiagram'
import type { ToolCoating } from '../../types'

const css = readFileSync('src/theme/tokens.css', 'utf8')
// Original dark literals, pinned independently of the shipped CSS.
const palette: string[][] = JSON.parse(readFileSync('src/tests/evidence/WO-1258/palette.json', 'utf8'))
let browser: Browser
beforeAll(async () => { browser = await chromium.launch({ headless: true }) }, 15000)
afterAll(async () => { await browser?.close() })
function contrast(a: string, b: string) {
  const luminance = (value: string) => {
    const channels = value.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(c => {
      c /= 255
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    })
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
  }
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

it.each(['default', 'amber'])('preserves every original dark drawing value in %s identity', async theme => {
  const page = await browser.newPage()
  try {
    await page.setContent(`<style>${css}</style>`)
    const values = await page.evaluate(theme => {
      document.documentElement.dataset.theme = theme
      document.documentElement.dataset.colorMode = 'dark'
      const style = getComputedStyle(document.documentElement)
      return Object.fromEntries([...style].filter(k => k.startsWith('--diagram-')).map(k => [k, style.getPropertyValue(k).trim()]))
    }, theme)
    for (const [name, dark] of palette) expect(values[`--diagram-${name}`], name).toBe(dark)
  } finally { await page.close() }
})

it.each(['default', 'amber'])('renders every light drawing ink at >= 3:1 in %s identity', async theme => {
  const coatings: ToolCoating[] = ['none', 'tin', 'ticn', 'tialn', 'dlc', 'zrn']
  const markup = coatings.map(coating => renderToStaticMarkup(<ToolDiagram
    type="drill" diameter={10} shankDiameter={12} overallLength={80} fluteLength={35}
    lengthBelowHolder={50} angleFromAxisDeg={59} coating={coating}
  />)).join('')
  const page = await browser.newPage()
  try {
    await page.setContent(`<style>${css}</style>${markup}`)
    const result = await page.evaluate(({theme, names}) => {
      document.documentElement.dataset.theme = theme
      document.documentElement.dataset.colorMode = 'light'
      const ground = getComputedStyle(document.querySelector('svg > rect')!).fill
      const unthemedLabels = [...document.querySelectorAll('svg text')].filter(el => !el.getAttribute('fill')?.startsWith('var(--diagram-')).map(el => el.textContent)
      const ink = [...document.querySelectorAll('svg [fill],svg [stroke]')].flatMap(el =>
        ['fill','stroke'].flatMap(property => {
          const value = el.getAttribute(property) || ''
          if (!value.startsWith('var(--diagram-') || /ground|fill|material-helix/.test(value)) return []
          return [{name:value, color:getComputedStyle(el).getPropertyValue(property)}]
        }))
      // Also resolve the angle-help and holder family members not used by ToolDiagram.
      const probe = document.createElement('span')
      document.body.append(probe)
      for (const name of names) {
        if (/ground|fill|material-helix/.test(name)) continue
        probe.style.color = `var(--diagram-${name})`
        ink.push({name, color:getComputedStyle(probe).color})
      }
      return {ground,ink,unthemedLabels, silhouettes:document.querySelectorAll('.tool-diagram-silhouette').length}
    }, {theme, names:palette.map(([name])=>name)})
    expect(result.ground).toBe('rgb(234, 240, 245)')
    expect(result.silhouettes).toBe(12)
    expect(result.unthemedLabels).toEqual([])
    expect(result.ink.length).toBeGreaterThan(100)
    for (const {name,color} of result.ink) expect(contrast(color,result.ground), `${name}: ${color} on ${result.ground}`).toBeGreaterThanOrEqual(3)
  } finally { await page.close() }
})
