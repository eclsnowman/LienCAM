// WO-1194: A KEEP-DOWN RIDE MAY NOT DETOUR OUTSIDE THE STOCK.
//
// Operator's file (Untitled_Project (40).camproject, "3D Rough 2") produced four role-'stepover'
// out-and-back legs whose apex stood 3.04 mm OUTSIDE the stock footprint, at cutting feed,
// over ground that has nothing to cut. On screen they read as triangles hanging off the part.
//
// WHY THIS TEST DRIVES A BROWSER. The 15 planner requests the application made while
// regenerating that operation are recorded in src/tests/evidence/WO-1194/browser-plans.json.
// Replayed under Node the engine produces almost no routed keep-down ride at all (measured on
// this branch and on main: 2 rides, max segment 6.337 mm, zero air excursion), so a Node
// replay is blind to this defect -- attempt 1's first regression was byte-identical on both
// sides for exactly that reason and was rightly blocked. In Chromium the same requests
// reproduce it exactly: request 6, tool centre at local (10.55, 48.81) = Operator's world
// y 28.813, 3.04 mm into the air, with the 26.971 mm segment the work order measured.
//
// MUTATION CHECK against `git show main:...engine/processFeature.ts`: on main
// `maxRideAirBeyondEndpointsMm` is 3.0396664505004907 and `airRejections` is 0, so the first
// three expectations below all fail there. `keepDownRides` is 12 on BOTH sides -- the fix must
// route around inside the stock, not concede the rides to retracts (attempt 1 conceded them
// and regressed ten tests in src/tests/adaptive-clearing/).

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import http from 'node:http'
import { chromium, type Browser, type Page } from 'playwright'
import { exteriorAirDepth, routeAirExcursion } from '../../lib/cam/adaptiveClearing2d/engine/processFeature'
import type { Loops, Pt } from '../../lib/cam/adaptiveClearing2d/engine/clipperEngine'

const PORT = 46195
const BASE = `http://127.0.0.1:${PORT}`

interface BrowserReplayReport {
  requests: number
  keepDownRides: number
  maxRideAirDepthMm: number
  maxRideAirBeyondEndpointsMm: number
  maxRideSegmentMm: number
  worstAt: { request: number; x: number; y: number; depth: number } | null
  airRejections: number
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

describe('WO-1194 routed keep-down stays on the stock', () => {
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

  it('replays the recorded planner requests in Chromium: no keep-down ride leaves the stock', async () => {
    if (!page) throw new Error('browser page not initialized')
    await page.goto(`${BASE}/src/tests/evidence/WO-1194/browser-replay.html`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
      () => Boolean(Reflect.get(window, '__wo1194Replay') || Reflect.get(window, '__wo1194ReplayError')),
      null, { timeout: 300_000 })
    const outcome = await page.evaluate(() => ({
      report: Reflect.get(window, '__wo1194Replay') as BrowserReplayReport | undefined,
      error: Reflect.get(window, '__wo1194ReplayError') as string | undefined,
    }))
    if (outcome.error || !outcome.report) throw new Error(outcome.error ?? 'browser replay returned no report')
    const report = outcome.report
    console.log('WO-1194 browser replay:', JSON.stringify({ ...report, perRequest: undefined }))

    expect(report.requests).toBe(15)
    // THE DEFECT. main: 3.0396664505004907 mm of air beyond what the ride's own endpoints stand out.
    expect(report.maxRideAirBeyondEndpointsMm).toBeLessThanOrEqual(1e-9)
    expect(report.worstAt).toBeNull()
    // The gate actually fired on this corpus (main: 0).
    expect(report.airRejections).toBeGreaterThan(0)
    // ...and it fired without conceding the rides to retracts: the same 12 keep-down rides survive.
    // WO-1896 re-pin (12 -> 18): the recorded requests ask for climb, which now keeps the material
    // on the cutter's right -- the other stream. Zero air on it too; 18 keep-down rides survive.
    // WO-1896 fix round 2 (18 -> 20), measured per ride by src/tests/evidence/WO-1896/
    // wo1194Probe.wo1896.test.ts (wo1194-probe-prefixround.json vs wo1194-probe-fix2.json):
    // 13 of 15 requests are byte-identical in geometry and pass type. The two new rides are
    // the ring-entry allowance joining the wall ring at its seam at depth:
    //   request 1: lift (0.35 mm) + lead (0.42 mm) -> one 0.13 mm keep-down onto the ring's
    //     own path (0 mm from it); the tool no longer retracts there (retracts 1 -> 0).
    //   request 4: a 0.036 mm wallfollow on the same points becomes a keep-down link.
    // Both: 0 mm air (WO-1194's metric) and 0 mm2 of standing stock under the full sweep.
    // Requests 6 and 14 kept their fed 4.27 mm ride (0.9 mm2 of wall band under it): it is
    // cut through at feed, not kept down, so it is not counted here.
    // WO-2752 re-pin (20 -> 16), measured per ride by the same probe with only
    // src/lib/cam/adaptiveClearing2d swapped (src/tests/evidence/WO-2830/wo1194-ride-diff.json):
    // engine at bce92ee126 gives 20 (byte-identical to wo1194-probe-fix2.json), WO-2752
    // (02bbb81663, adaptive honours the milling direction, Operator 2026-10-11) gives 16, and
    // WO-2787 moves none. WO-2752 refuses a dominant cut on the wrong flank, so every request's
    // cut passes change and the links between them with it (requests 3 +1, 4 -1, 5 -1, 9 -1,
    // 10 +1, 11 -1, 13 -2). The air gate is not the cause: airRejections is 4 on both engines
    // and every surviving ride stands 0 mm in air.
    expect(report.keepDownRides).toBe(16)
  }, 420_000)

  it('refuses an out-and-back apex into air, and passes a long ride that stays on stock', () => {
    // The exterior air the 3D rougher hands the engine: a big box with the stock punched out.
    // Stock is the 50 mm square centred on the origin, as in Operator's file.
    const seed: Loops = [
      [{ x: -45, y: -45 }, { x: 45, y: -45 }, { x: 45, y: 45 }, { x: -45, y: 45 }],
      [{ x: -25, y: -25 }, { x: -25, y: 25 }, { x: 25, y: 25 }, { x: 25, y: -25 }],
    ]
    const airDepth = exteriorAirDepth(seed)
    const toolRadius = 4.76
    const tol = Math.max(0.0125 * 4, toolRadius * 0.05) // the engine's own wallTol

    expect(airDepth({ x: 0, y: 0 })).toBe(0)
    expect(airDepth({ x: 0, y: 24 })).toBe(0)
    expect(airDepth({ x: 0, y: 28.813 })).toBeCloseTo(3.813, 6)

    // The triangle: two legs out to an apex 3.81 mm past the stock edge and back. REFUSED.
    const triangle: Pt[] = [
      { x: -19.88, y: 25 }, { x: -9.45, y: 28.813 }, { x: 0.99, y: 25 },
    ]
    const hit = routeAirExcursion(triangle, airDepth, toolRadius, tol)
    expect(hit).not.toBeNull()
    expect(hit?.depth).toBeCloseTo(3.813, 3)

    // A LONG ride that stays on the stock is a GOOD outcome and must survive, however long its
    // legs are -- this is the B8 island route-around the work order requires to keep working.
    const onStock: Pt[] = [
      { x: -24, y: 24 }, { x: 24, y: 24 }, { x: 24, y: -24 }, { x: -24, y: -24 },
    ]
    expect(routeAirExcursion(onStock, airDepth, toolRadius, tol)).toBeNull()

    // A ride whose OWN ENDPOINTS stand in air (a stock-edge pass, where the caller deliberately
    // lets the cutter centre sit off the stock) may stay out that far without being refused.
    const alongTheEdge: Pt[] = [
      { x: -20, y: 27 }, { x: 0, y: 27 }, { x: 20, y: 27 },
    ]
    expect(routeAirExcursion(alongTheEdge, airDepth, toolRadius, tol)).toBeNull()
    // ...but not further.
    const edgeThenOut: Pt[] = [
      { x: -20, y: 27 }, { x: 0, y: 31 }, { x: 20, y: 27 },
    ]
    expect(routeAirExcursion(edgeThenOut, airDepth, toolRadius, tol)?.depth).toBeCloseTo(6, 3)

    // No exterior seed -> no separate stock belief -> the gate is dormant (the 2D corpus).
    expect(routeAirExcursion(triangle, exteriorAirDepth([]), toolRadius, tol)).toBeNull()
  })
})
