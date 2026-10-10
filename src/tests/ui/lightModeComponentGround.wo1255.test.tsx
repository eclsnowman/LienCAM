import { readFileSync } from 'node:fs'
import { chromium, type Browser } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const productCss = `${readFileSync('src/theme/tokens.css', 'utf8')}\n${readFileSync('src/styles/app.css', 'utf8')}`

let browser: Browser

type Rgb = [number, number, number]

function rgb(value: string): Rgb {
  const channels = value.match(/\d+(?:\.\d+)?/g)?.slice(0, 3).map(Number)
  if (!channels || channels.length !== 3) throw new Error(`Expected computed rgb(), received ${value}`)
  return channels as Rgb
}

function luminance(color: Rgb) {
  const channels = color.map((channel) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

function contrast(foreground: Rgb, background: Rgb) {
  const [high, low] = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
  return (high + 0.05) / (low + 0.05)
}

beforeAll(async () => {
  browser = await chromium.launch({ headless: true })
}, 15_000)

afterAll(async () => {
  await browser?.close()
})

describe('WO-1255 sketch prompt theme behavior', () => {
  it.each(['light', 'dark'] as const)('keeps prompt text at >= 4.5:1 in %s mode', async (mode) => {
    const page = await browser.newPage()
    try {
      await page.setContent(`
        <style>${productCss}</style>
        <div class="sketch-prompt-bar" role="status">Choose the first point</div>
      `)
      const colors = await page.evaluate((colorMode) => {
        document.documentElement.dataset.colorMode = colorMode
        const prompt = document.querySelector('.sketch-prompt-bar')
        if (!prompt) throw new Error('Sketch prompt bar did not render')
        const style = getComputedStyle(prompt)
        return { background: style.backgroundColor, text: style.color }
      }, mode)

      expect(
        contrast(rgb(colors.text), rgb(colors.background)),
        `${mode}: ${colors.text} on ${colors.background}`,
      ).toBeGreaterThanOrEqual(4.5)
    } finally {
      await page.close()
    }
  })
})
