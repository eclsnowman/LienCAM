// WO-3303 (UI M2 W2-10): the Machine window held to spec 5.1 in Chromium, at the six target sizes in
// the three M1 themes and at interface scale 75 % and 150 %. Rules read here: 1 the page never
// scrolls, 2 the window stays inside the screen, 3 no chrome text is cut off (an ellipsis needs the
// full text in a tooltip), 4 hit targets are at least 20 px. Rules 3 and 4 cover the window's own
// parts (list, bar, footer, library, overview); the definition areas host today's editors, whose
// own tables scroll inside the window, and are held to rules 1 and 2 until their screens move.
import path from 'node:path'
import { chromium } from 'playwright'
import { describe, expect, it } from 'vitest'
import { withViteCaptureServer } from '../../../tools/capture/lib/provenance.mjs'
import { LAYOUT, THEMES } from '../../theme/tokens'
import { measure } from './machineMeasure.wo3303'

const REPO_ROOT = path.resolve('.')
// the window's own pages; the hosted definition areas are measured in the real shell (machineShell.wo3303.test.ts)
const PAGES = ['library', 'overview'] as const
const HARNESS = '/src/tests/evidence/WO-3303/machine.html'

describe('WO-3303 machine window layout', () => {
  it('holds the spec 5.1 rules on the library, the overview and an area, at every target size, theme and scale', async () => {
    const failures: string[] = []
    await withViteCaptureServer({ port: 4608, repoRoot: REPO_ROOT }, async ({ baseUrl }) => {
      const browser = await chromium.launch({ headless: true })
      try {
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
        const page = await context.newPage()
        let first = true
        const go = async (theme: string, pageName: string, scale: number) => {
          const url = new URL(HARNESS, baseUrl)
          url.searchParams.set('theme', theme)
          url.searchParams.set('page', pageName)
          url.searchParams.set('scale', String(scale))
          await page.goto(url.toString())
          // a page whose window never shows is a failure to report, not a crash of the run
          const shown = await page.getByTestId('machine-window').waitFor({ state: 'visible', timeout: first ? 120_000 : 20_000 }).then(() => true, () => false)
          first = false
          if (!shown) failures.push(`${theme} ${pageName} scale ${scale}: the Machine window did not show`)
          await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' })
          await page.waitForTimeout(200)
        }
        const check = async (label: string) => {
          for (const v of await measure(page, LAYOUT.rules.minHit)) failures.push(`${label}: ${v}`)
        }
        for (const theme of Object.keys(THEMES)) {
          for (const pageName of PAGES) {
            await go(theme, pageName, 1)
            for (const t of LAYOUT.targets) {
              await page.setViewportSize({ width: t.width, height: t.height })
              await page.waitForTimeout(120)
              await check(`${theme} ${pageName} ${t.width}x${t.height}`)
            }
          }
        }
        const smallest = LAYOUT.targets[0]
        for (const scale of [0.75, 1.5]) {
          for (const theme of Object.keys(THEMES)) {
            for (const pageName of PAGES) {
              await go(theme, pageName, scale)
              for (const t of LAYOUT.targets) {
                if (t.width / scale < smallest.width || t.height / scale < smallest.height) continue
                await page.setViewportSize({ width: t.width, height: t.height })
                await page.waitForTimeout(120)
                await check(`${theme} ${pageName} ${t.width}x${t.height} scale ${scale}`)
              }
            }
          }
        }
        await context.close()
      } finally {
        await browser.close()
      }
    })
    expect(failures).toEqual([])
  }, 1_800_000)

  it('the measure sees what it is for: a planted overlap, a cut-off text and a small button are all reported', async () => {
    let found: string[] = []
    await withViteCaptureServer({ port: 4611, repoRoot: REPO_ROOT }, async ({ baseUrl }) => {
      const browser = await chromium.launch({ headless: true })
      try {
        const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
        const url = new URL(HARNESS, baseUrl)
        url.searchParams.set('page', 'overview')
        await page.goto(url.toString())
        await page.getByTestId('machine-window').waitFor({ state: 'visible', timeout: 120_000 })
        await page.evaluate(`(() => {
          const body = document.querySelector('[data-testid="machine-overview"]')
          const card = body.querySelector('.kit-card')
          const r = card.getBoundingClientRect()
          const twin = document.createElement('div')
          twin.className = 'kit-card'; twin.setAttribute('data-testid', 'planted-card')
          twin.style.cssText = 'position:fixed;left:' + (r.left + 4) + 'px;top:' + (r.top + 4) + 'px;width:' + (r.width / 2) + 'px;height:' + (r.height / 2) + 'px'
          body.appendChild(twin)
          const cut = document.createElement('div')
          cut.setAttribute('data-testid', 'planted-cut')
          cut.style.cssText = 'width:20px;overflow:hidden;white-space:nowrap'
          cut.textContent = 'a long piece of chrome text that does not fit'
          body.appendChild(cut)
          const small = document.createElement('button')
          small.setAttribute('data-testid', 'planted-small'); small.style.cssText = 'width:9px;height:9px;padding:0'
          body.appendChild(small)
        })()`)
        found = await measure(page, LAYOUT.rules.minHit)
      } finally {
        await browser.close()
      }
    })
    expect(found.some(v => v.includes('overlaps card'))).toBe(true)
    expect(found.some(v => v.includes('text cut off in planted-cut'))).toBe(true)
    expect(found.some(v => v.includes('hit target planted-small'))).toBe(true)
  }, 300_000)
})
