// WO-3279: a tooltip sits beside its control and inside the viewport in Dialog and Window, at any
// Window offset including after a drag. jsdom has no layout, so this runs the kit gallery in a
// real browser (the same dev-server and Chromium mechanism as the WO-1492 strip test) and
// measures real boxes. A box measured in a transformed ancestor's coordinates is the defect this
// guards: Window is transformed, which makes it the containing block of a fixed child.
//
// A BROKEN HARNESS IS NOT A GREEN BRANCH: if the dev server or the browser cannot start, every
// test FAILS with INCONCLUSIVE (infrastructure) rather than passing or being skipped. The one
// way out is deliberate: PW_SKIP_BROWSER=1 (a box with no browser, on purpose) skips the
// measurement and says so. PW_CHROMIUM (optional) names a Chromium binary when Playwright's own
// is not installed.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
// Imported by URL: a bare .mjs import has no declaration file and fails `tsc -b` (TS7016).
const { startDevServer } = await import(new URL('../evidence/WO-1492/capture.mjs', import.meta.url).href)

type DevServer = Awaited<ReturnType<typeof startDevServer>>
const BOOT_TIMEOUT_MS = 300_000
const VIEWPORT = { width: 1000, height: 800 }
/** The tooltip may sit this far from its control (the kit gap is 6 px). */
const NEAR = 8

interface Box { x: number; y: number; width: number; height: number }
/** Set on purpose (PW_SKIP_BROWSER=1) by whoever runs the suite where no browser exists. */
const SKIP_BROWSER = process.env.PW_SKIP_BROWSER === '1'
let infrastructure: string | null = null
let server: DevServer | null = null
let browser: Browser | null = null

beforeAll(async () => {
  if (SKIP_BROWSER) return
  try {
    server = await startDevServer()
    const executablePath = process.env.PW_CHROMIUM
    browser = await chromium.launch(executablePath ? { executablePath, args: ['--no-sandbox'] } : {})
  } catch (error) {
    infrastructure = String((error as Error).message).split('\n')[0]
  }
}, BOOT_TIMEOUT_MS)

afterAll(async () => {
  if (browser) await browser.close()
  if (server) server.stop()
})

function requireLive(): void {
  if (infrastructure || !server || !browser) {
    throw new Error(`INCONCLUSIVE (infrastructure, not this branch): the tooltip placement was NEVER MEASURED. ${infrastructure ?? ''}`)
  }
}

async function open(opener: string): Promise<Page> {
  requireLive()
  const page = await browser!.newPage({ viewport: VIEWPORT })
  await page.goto(`${server!.base}src/tests/evidence/WO-3279/gallery.html?theme=dark`)
  await page.waitForSelector('[data-testid=surfaces-gallery]')
  await page.click(`[data-gallery=${opener}] button`)
  return page
}

async function box(page: Page, selector: string): Promise<Box> {
  const b = await page.locator(selector).boundingBox()
  if (!b) throw new Error(`no box for ${selector}`)
  return b
}

/** Focus the unavailable footer action, then check its tooltip against it and the viewport. */
async function expectTooltipBeside(page: Page): Promise<void> {
  await page.focus('[role=dialog] .kit-card-primary')
  await page.waitForSelector('[role=tooltip]')
  const button = await box(page, '[role=dialog] .kit-card-primary')
  const tip = await box(page, '[role=tooltip]')
  expect(tip.x).toBeGreaterThanOrEqual(0)
  expect(tip.y).toBeGreaterThanOrEqual(0)
  expect(tip.x + tip.width).toBeLessThanOrEqual(VIEWPORT.width)
  expect(tip.y + tip.height).toBeLessThanOrEqual(VIEWPORT.height)
  const gap = tip.y >= button.y + button.height ? tip.y - (button.y + button.height) : button.y - (tip.y + tip.height)
  expect(gap).toBeGreaterThanOrEqual(0)
  expect(gap).toBeLessThanOrEqual(NEAR)
}

async function dragWindow(page: Page, dx: number, dy: number): Promise<void> {
  const h = await box(page, '.kit-window .kit-card-header')
  const x = h.x + h.width / 2
  const y = h.y + h.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx, y + dy, { steps: 6 })
  await page.mouse.up()
}

/** A test that measures in the browser: it fails (INCONCLUSIVE) when there is none, unless skipped on purpose. */
function browserTest(name: string, body: () => Promise<void>): void {
  it(name, async () => {
    if (SKIP_BROWSER) {
      console.warn(`PW_SKIP_BROWSER=1: NOT MEASURED: ${name}`)
      return
    }
    await body()
  }, BOOT_TIMEOUT_MS)
}

describe('WO-3279 tooltip placement in a real browser', () => {
  browserTest('Dialog: the footer tooltip sits beside its button inside the viewport', async () => {
    const page = await open('dialog')
    await expectTooltipBeside(page)
    await page.close()
  })

  browserTest('Window at its centred position (a transform at zero offset)', async () => {
    const page = await open('window')
    await expectTooltipBeside(page)
    await page.close()
  })

  browserTest('Window dragged to a non-zero offset', async () => {
    const page = await open('window')
    await dragWindow(page, 60, -40)
    await expectTooltipBeside(page)
    await page.close()
  })

  browserTest('Window dragged until its footer button is at the right and bottom edge: the tooltip flips above and slides left, on screen', async () => {
    const page = await open('window')
    await dragWindow(page, 90, 70)
    const button = await box(page, '[role=dialog] .kit-card-primary')
    expect(button.x + button.width).toBeLessThanOrEqual(VIEWPORT.width)
    expect(button.y + button.height).toBeLessThanOrEqual(VIEWPORT.height)
    await expectTooltipBeside(page)
    await page.close()
  })
})
