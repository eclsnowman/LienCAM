// WO-060: rendered-geometry regression for the exact clip band found by the
// WO-047 audit. This intentionally drives the real app in Chromium: jsdom has
// no layout engine and cannot prove scrollWidth <= clientWidth.
//
// WO-2831: WO-2724 added About as a fifth labelled utility. The full-label
// header then needs 1727px on Linux Chromium (WO-2830 header-measure.json), so
// 1650-1726px clipped About and pushed the machine status chip off screen. The
// labels now return at 1730px. About's icon also widened the compact header to
// 1476px, so 1440-1475px clipped too; the file-command labels now go below
// 1480px while the mode-tab labels stay at 1440px. About and the chip must stay
// on screen at every width down to the 960px floor, and so must E-STOP in the
// Control workspace.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import http from 'node:http'
import { chromium, type Browser, type Page } from 'playwright'

const PORT = 4260
const BASE = `http://localhost:${PORT}/`
const HEIGHT = 900

interface HeaderMeasurement {
  width: number
  clientWidth: number
  scrollWidth: number
  rightLabelsShown: number
  leftLabelsShown: number
  tabLabelsShown: number
  offScreen: string[]
}

const UTILITY_LABELS = 5
const FILE_LABELS = 4
const MODE_LABELS = 8
const FULL_LABELS_FROM = 1730
const FILE_LABELS_FROM = 1480
const MODE_LABELS_FROM = 1440
const WIDTHS = [960, 1280, 1439, 1440, 1475, 1479, 1480, 1501, 1599, 1600, 1649, 1650, 1700, 1726, 1727, 1729, 1730, 1920]

function waitForServer(url: string, timeoutMs = 90_000): Promise<void> {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const poll = () => {
      http.get(url, (response) => {
        response.resume()
        resolve()
      }).on('error', () => {
        if (Date.now() - started >= timeoutMs) {
          reject(new Error(`Vite did not start at ${url}`))
        } else {
          setTimeout(poll, 250)
        }
      })
    }
    poll()
  })
}

function stopProcessTree(child: ChildProcess | undefined): void {
  if (!child?.pid) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
    })
  } else {
    child.kill('SIGTERM')
  }
}

async function measure(page: Page, width: number, mustShow: string[]): Promise<HeaderMeasurement> {
  await page.setViewportSize({ width, height: HEIGHT })
  await page.waitForTimeout(100)
  return page.evaluate(({ measuredWidth, selectors }) => {
    const visibleCount = (selector: string) => Array.from(document.querySelectorAll(selector))
      .filter((node) => getComputedStyle(node).display !== 'none').length
    const header = document.querySelector<HTMLElement>('header.top-toolbar')
    if (!header) throw new Error('top toolbar missing')
    return {
      width: measuredWidth,
      clientWidth: header.clientWidth,
      scrollWidth: header.scrollWidth,
      rightLabelsShown: visibleCount('.toolbar-section-right .tb-btn span'),
      leftLabelsShown: visibleCount('.toolbar-section-left .tb-btn span'),
      tabLabelsShown: visibleCount('.header-mode-tabs .mode-tab span'),
      offScreen: selectors.filter((selector) => {
        const node = document.querySelector<HTMLElement>(selector)
        if (!node || getComputedStyle(node).display === 'none') return true
        const box = node.getBoundingClientRect()
        return box.width <= 0 || box.left < 0 || box.right > window.innerWidth
      }),
    }
  }, { measuredWidth: width, selectors: mustShow })
}

const HEADER_MUST_SHOW = ['button[aria-label="About LienCAM"]', '[data-testid="machine-status-chip"]']

describe('WO-060 header clip-band boundary', () => {
  let server: ChildProcess | undefined
  let browser: Browser | undefined
  let page: Page | undefined

  beforeAll(async () => {
    server = spawn(process.execPath, [
      'node_modules/vite/bin/vite.js',
      '--port', String(PORT),
      '--strictPort',
    ], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await waitForServer(BASE)
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1600, height: HEIGHT } })
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('header.top-toolbar .mode-tab-strip', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    stopProcessTree(server)
  })

  it('fits at every width with About; labels return at 1440, 1480 and 1730px', async () => {
    if (!page) throw new Error('browser page not initialized')
    const measurements = []
    for (const width of WIDTHS) {
      measurements.push(await measure(page, width, HEADER_MUST_SHOW))
    }
    if (process.env.WO2831_CAPTURE) {
      console.log(JSON.stringify({ measurements }))
      for (const width of [1650, 1920]) {
        await measure(page, width, HEADER_MUST_SHOW)
        await page.screenshot({
          path: `src/tests/evidence/WO-2831/header-${width}-${process.env.WO2831_CAPTURE}.png`,
          clip: { x: 0, y: 0, width, height: 120 },
        })
      }
    }

    for (const result of measurements) {
      expect(
        result.scrollWidth,
        `w=${result.width}: header scrollWidth ${result.scrollWidth} exceeds clientWidth ${result.clientWidth}`,
      ).toBeLessThanOrEqual(result.clientWidth)
      expect(result.offScreen, `w=${result.width}: About and the machine status chip stay on screen`).toEqual([])
    }

    for (const result of measurements) {
      expect(result.rightLabelsShown, `w=${result.width}: utility label boundary`)
        .toBe(result.width < FULL_LABELS_FROM ? 0 : UTILITY_LABELS)
      expect(result.leftLabelsShown, `w=${result.width}: file-command label boundary`)
        .toBe(result.width < FILE_LABELS_FROM ? 0 : FILE_LABELS)
      expect(result.tabLabelsShown, `w=${result.width}: mode label boundary`)
        .toBe(result.width < MODE_LABELS_FROM ? 0 : MODE_LABELS)
    }
  }, 60_000)

  it('keeps the header and E-STOP on screen in the Control workspace', async () => {
    if (!page) throw new Error('browser page not initialized')
    await page.click('[data-testid="mode-tab-control"]')
    await page.waitForSelector('[data-testid="control-estop"]', { timeout: 30_000 })
    const mustShow = [...HEADER_MUST_SHOW, '[data-testid="control-estop"]']
    for (const width of WIDTHS) {
      const result = await measure(page, width, mustShow)
      expect(
        result.scrollWidth,
        `control w=${result.width}: header scrollWidth ${result.scrollWidth} exceeds clientWidth ${result.clientWidth}`,
      ).toBeLessThanOrEqual(result.clientWidth)
      expect(result.offScreen, `control w=${result.width}: About, status chip and E-STOP stay on screen`).toEqual([])
    }
  }, 60_000)
})
