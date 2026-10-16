// WO-064: real-layout regression for the supported 960px header floor.
// jsdom cannot prove element bounds, overflow, or hit-test reachability, so
// this test drives the real app in Chromium at every required and responsive
// boundary width.
//
// WO-2849: WO-2831 (About button, landed 2026-10-15) made the header 17
// controls and moved the utility labels' return to 1730px (5 labels). The
// 960px floor still fits with every control reachable; pins follow it.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import http from 'node:http'
import { chromium, type Browser, type Page } from 'playwright'

const PORT = 4264
const BASE = `http://localhost:${PORT}/`
const HEIGHT = 900
const WIDTHS = [960, 1280, 1433, 1434, 1440, 1441, 1442, 1475, 1479, 1480, 1501, 1599, 1600, 1639, 1640, 1648, 1649, 1650, 1726, 1729, 1730, 1920] as const
const CONTROLS = 17
const UTILITY_LABELS = 5
const UTILITY_LABELS_FROM = 1730

interface ControlMeasurement {
  name: string
  disabled: boolean
  insideHeader: boolean
  hitTarget: boolean
}

interface HeaderMeasurement {
  width: number
  clientWidth: number
  scrollWidth: number
  rightLabelsShown: number
  tabLabelsShown: number
  controls: ControlMeasurement[]
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
    const headerRect = header.getBoundingClientRect()
    const controls = Array.from(header.querySelectorAll<HTMLButtonElement>('button')).map((button) => {
      const rect = button.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return {
        name: button.dataset.testid ?? button.dataset.tooltip ?? button.textContent?.trim() ?? '(unnamed)',
        disabled: button.disabled,
        insideHeader:
          rect.left >= headerRect.left
          && rect.right <= headerRect.right
          && rect.top >= headerRect.top
          && rect.bottom <= headerRect.bottom,
        hitTarget: hit === button || (hit !== null && button.contains(hit)),
      }
    })
    return {
      width: measuredWidth,
      clientWidth: header.clientWidth,
      scrollWidth: header.scrollWidth,
      rightLabelsShown: visibleCount('.toolbar-section-right .tb-btn span'),
      tabLabelsShown: visibleCount('.header-mode-tabs .mode-tab span'),
      controls,
    }
  }, width)
}

describe('WO-064 header supported-width floor', () => {
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

  it('fits and keeps every control reachable from 960px through full width', async () => {
    if (!page) throw new Error('browser page not initialized')
    const measurements = []
    for (const width of WIDTHS) measurements.push(await measure(page, width))

    const failures: string[] = []
    for (const result of measurements) {
      if (result.scrollWidth > result.clientWidth) {
        failures.push(`w=${result.width}: scrollWidth=${result.scrollWidth} clientWidth=${result.clientWidth}`)
      }
      if (result.controls.length !== CONTROLS) {
        failures.push(`w=${result.width}: expected ${CONTROLS} controls, found ${result.controls.length}`)
      }
      for (const control of result.controls) {
        if (!control.insideHeader || (!control.disabled && !control.hitTarget)) {
          failures.push(
            `w=${result.width}: ${control.name} disabled=${control.disabled} insideHeader=${control.insideHeader} hitTarget=${control.hitTarget}`,
          )
        }
      }
    }

    expect(failures, failures.join('\n')).toEqual([])
  }, 60_000)

  it('sheds labels only inside the two declared responsive ranges', async () => {
    if (!page) throw new Error('browser page not initialized')
    const measurements = new Map<number, HeaderMeasurement>()
    for (const width of [1433, 1434, 1439, 1440, 1441, 1639, 1640, 1648, 1649, 1650, 1729, 1730, 1920]) {
      measurements.set(width, await measure(page, width))
    }

    for (const [width, result] of measurements) {
      expect(result.tabLabelsShown, `w=${width}: workflow label boundary`).toBe(width < 1440 ? 0 : 8)
      expect(result.rightLabelsShown, `w=${width}: utility label boundary`).toBe(width < UTILITY_LABELS_FROM ? 0 : UTILITY_LABELS)
    }
  }, 60_000)
})
