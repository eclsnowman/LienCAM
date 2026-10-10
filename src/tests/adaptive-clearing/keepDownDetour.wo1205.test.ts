// WO-1237: current main already removes Operator's named keep-down detour. Pin the exact
// production request corpus without retaining WO-1205's now-dormant rejection rule.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import http from 'node:http'
import { chromium, type Browser, type Page } from 'playwright'

const PORT = 46207
const BASE = `http://127.0.0.1:${PORT}`

interface FixtureMetric {
  request: number
  passes: number
  retracts: number
  links: number
  cutLengthMm: number
  badChainRides: number
  outAndBackDetours: number
}

interface LegacyControl {
  routedRides: number
  outAndBackDetours: number
  longForwardRoutes: number
  lowStretchNearReversals: number
}

function waitForServer(url: string, timeoutMs = 90_000): Promise<void> {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const poll = () => {
      http.get(url, (response) => { response.resume(); resolve() }).on('error', () => {
        if (Date.now() - started >= timeoutMs) reject(new Error(`Vite did not start at ${url}`))
        else setTimeout(poll, 250)
      })
    }
    poll()
  })
}

function stopProcessTree(child: ChildProcess | undefined): void {
  if (!child?.pid) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  else child.kill('SIGTERM')
}

describe('WO-1237 production keep-down detour regression', () => {
  let server: ChildProcess | undefined
  let browser: Browser | undefined
  let page: Page | undefined

  beforeAll(async () => {
    server = spawn(process.execPath, [
      'node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort',
    ], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })
    await waitForServer(BASE)
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage()
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    stopProcessTree(server)
  })

  it('keeps the named chain absent and accounts for every recorded adaptive request', async () => {
    if (!page) throw new Error('browser page not initialized')
    await page.goto(`${BASE}/src/tests/evidence/WO-1205/browser-replay.html`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
      () => Boolean(Reflect.get(window, '__wo1237Replay') || Reflect.get(window, '__wo1237ReplayError')),
      null,
      { timeout: 420_000 },
    )
    const outcome = await page.evaluate(() => ({
      report: Reflect.get(window, '__wo1237Replay') as {
        fixtures: FixtureMetric[]
        legacyControl: LegacyControl
      } | undefined,
      error: Reflect.get(window, '__wo1237ReplayError') as string | undefined,
    }))
    if (outcome.error || !outcome.report) throw new Error(outcome.error ?? 'browser replay returned no report')
    console.log('WO-1237 production request accounting:', JSON.stringify(outcome.report.fixtures))
    console.log('WO-1237 detour-family positive control:', JSON.stringify(outcome.report.legacyControl))
    expect(outcome.report.fixtures).toHaveLength(8)
    expect(outcome.report.fixtures.every((fixture) => fixture.badChainRides === 0)).toBe(true)
    expect(outcome.report.fixtures.every((fixture) => fixture.outAndBackDetours === 0)).toBe(true)
    expect(outcome.report.legacyControl).toEqual({
      routedRides: 6,
      outAndBackDetours: 2,
      longForwardRoutes: 2,
      lowStretchNearReversals: 2,
    })
    // WO-1896 re-pin: the production requests ask for climb, which now keeps the material on
    // the cutter's right -- the other stream. Before -> after, per request (passes, links, cut
    // mm): 0: 2, 0, 711.82 -> 2, 0, 711.61 | 1: 10, 1, 772.41 -> 6, 1, 772.20 | 2: 12, 0,
    // 812.39 -> 16, 0, 790.50 | 3: 21, 0, 801.02 -> 22, 1, 788.26 | 4: 23, 0, 788.92 -> 28, 1,
    // 796.63 | 5: 25, 2, 770.12 -> 20, 1, 881.36 | 6: 22, 0, 802.28 -> 24, 1, 717.76 | 7: 6, 1,
    // 435.51 -> 6, 1, 435.63. Retracts stay 0 on every request; total cut 5894.46 -> 5893.94 mm.
    // Measured on both streams by src/tests/evidence/WO-1896/detour-probe.js: no keep-down or
    // wall ride leaves the stock (WO-1194 air metric 0 everywhere), none travels at depth
    // through standing stock, and the old numbers are exactly the 'conventional' stream now.
    expect(outcome.report.fixtures.map((fixture) => ({
      request: fixture.request,
      passes: fixture.passes,
      retracts: fixture.retracts,
      links: fixture.links,
      cutLengthMm: Number(fixture.cutLengthMm.toFixed(6)),
    }))).toEqual([
      { request: 0, passes: 2, retracts: 0, links: 0, cutLengthMm: 711.606806 },
      { request: 1, passes: 6, retracts: 0, links: 1, cutLengthMm: 772.203234 },
      { request: 2, passes: 16, retracts: 0, links: 0, cutLengthMm: 790.49949 },
      { request: 3, passes: 22, retracts: 0, links: 1, cutLengthMm: 788.263654 },
      { request: 4, passes: 28, retracts: 0, links: 1, cutLengthMm: 796.625149 },
      { request: 5, passes: 20, retracts: 0, links: 1, cutLengthMm: 881.360708 },
      { request: 6, passes: 24, retracts: 0, links: 1, cutLengthMm: 717.758394 },
      { request: 7, passes: 6, retracts: 0, links: 1, cutLengthMm: 435.625812 },
    ])
  }, 480_000)
})
