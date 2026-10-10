// WO-060: rendered-geometry regression for the exact clip band found by the
// WO-047 audit. This intentionally drives the real app in Chromium: jsdom has
// no layout engine and cannot prove scrollWidth <= clientWidth.

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
  tabLabelsShown: number
}

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

async function measure(page: Page, width: number): Promise<HeaderMeasurement> {
  await page.setViewportSize({ width, height: HEIGHT })
  await page.waitForTimeout(100)
  return page.evaluate((measuredWidth) => {
    const visibleCount = (selector: string) => Array.from(document.querySelectorAll(selector))
      .filter((node) => getComputedStyle(node).display !== 'none').length
    const header = document.querySelector<HTMLElement>('header.top-toolbar')
    if (!header) throw new Error('top toolbar missing')
    return {
      width: measuredWidth,
      clientWidth: header.clientWidth,
      scrollWidth: header.scrollWidth,
      rightLabelsShown: visibleCount('.toolbar-section-right .tb-btn span'),
      tabLabelsShown: visibleCount('.header-mode-tabs .mode-tab span'),
    }
  }, width)
}

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

  it('fits across the old clip band and restores labels at 1650px with Linux font margin', async () => {
    if (!page) throw new Error('browser page not initialized')
    const measurements = []
    for (const width of [1501, 1599, 1600, 1639, 1640, 1648, 1649, 1650, 1920]) {
      measurements.push(await measure(page, width))
    }

    for (const result of measurements) {
      expect(
        result.scrollWidth,
        `w=${result.width}: header scrollWidth ${result.scrollWidth} exceeds clientWidth ${result.clientWidth}`,
      ).toBeLessThanOrEqual(result.clientWidth)
      expect(result.tabLabelsShown, `w=${result.width}: all mode labels stay visible`).toBe(8)
    }

    for (const result of measurements) {
      expect(result.rightLabelsShown, `w=${result.width}: utility label boundary`).toBe(result.width < 1650 ? 0 : 4)
    }
  }, 60_000)
})
