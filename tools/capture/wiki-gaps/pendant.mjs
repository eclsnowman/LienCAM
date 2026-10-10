// WO-2709 phone-pendant wiki-gap candidates P-4..P-7 at 390x844.
// Serves the REAL pendant app with `node pendant/server.mjs` WITHOUT --bridge
// (its built-in SimulatedGrbl; no pairing token exists). Never hardware.
//
// --compare also renders the same app in BRIDGE mode (?pair=<dummy>) against a
// Playwright-mocked /bridge WebSocket that sends the desktop's status payload
// shape (src/lib/machine/pendantBridge.ts machineStatusPayload). Those frames
// go to candidates/compare/ only, to show what the shipped bridge-connected
// UI differs in. All data in them is fake.
//
//   node tools/capture/wiki-gaps/pendant.mjs [--compare]
import { chromium } from 'playwright'
import sharp from 'sharp'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { CHROMIUM_CAPTURE_ARGS } from '../lib/harness.mjs'
import { OUT, clearCandidate, waitForCpu, writeSidecar } from './common.mjs'

const PORT = 47324
const BASE = `http://127.0.0.1:${PORT}/`
const VIEWPORT = { width: 390, height: 844 }
const VIEWPORT_W = VIEWPORT.width
const DPR = 2
const compare = process.argv.includes('--compare')
const PENDANT_SOURCES = ['pendant', 'src/theme/tokens.css']
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function startServer() {
  // stdout is not kept: the server prints this PC's LAN addresses.
  const server = spawn(process.execPath, ['pendant/server.mjs', '--port', String(PORT)], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  let text = ''
  server.stdout.on('data', (c) => { text += c })
  server.stderr.on('data', (c) => { text += c })
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(BASE)).ok) return server } catch { /* not yet */ }
    if (server.exitCode !== null) throw new Error('pendant server exited: ' + text.replace(/\d+\.\d+\.\d+\.\d+/g, '<ip>'))
    await sleep(200)
  }
  throw new Error('pendant server did not answer')
}

const server = await startServer()
await waitForCpu()
const browser = await chromium.launch({ headless: true, args: CHROMIUM_CAPTURE_ARGS })
const errors = []
try {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: DPR, isMobile: true, hasTouch: true })
  const page = await context.newPage()
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()) })
  // The app scrolls inside #body (the header and tabs stay put), so a
  // Playwright full-page shot is only the viewport. mode 'screen' keeps the
  // one phone screen as seen (optionally scrolled to `scrollTo`); mode 'tall'
  // stitches the header + every #body scroll position into one long picture.
  const stitch = async (pg, file) => {
    const geo = await pg.evaluate(() => {
      const b = document.querySelector('#body'); const r = b.getBoundingClientRect()
      return { top: r.top, height: b.clientHeight, scrollHeight: b.scrollHeight }
    })
    const scale = await pg.evaluate(() => window.devicePixelRatio)
    const W = Math.round(VIEWPORT_W * scale)
    const parts = []
    let covered = 0
    let first = true
    for (let s = 0; covered < geo.scrollHeight; s += geo.height) {
      const at = Math.min(s, geo.scrollHeight - geo.height)
      await pg.evaluate((y) => { document.querySelector('#body').scrollTop = y }, at)
      await sleep(250)
      const buf = await pg.screenshot({ animations: 'disabled' })
      if (first) parts.push(await sharp(buf).extract({ left: 0, top: 0, width: W, height: Math.round(geo.top * scale) }).toBuffer())
      first = false
      const from = covered - at
      const rows = geo.height - from
      parts.push(await sharp(buf).extract({ left: 0, top: Math.round((geo.top + from) * scale), width: W, height: Math.round(rows * scale) }).toBuffer())
      covered = at + geo.height
    }
    const metas = await Promise.all(parts.map((b) => sharp(b).metadata()))
    const H = metas.reduce((a, m) => a + m.height, 0)
    let y = 0
    const composite = parts.map((input, i) => { const o = { input, left: 0, top: y }; y += metas[i].height; return o })
    await sharp({ create: { width: W, height: H, channels: 4, background: '#000' } }).composite(composite).png().toFile(file)
    await pg.evaluate(() => { document.querySelector('#body').scrollTop = 0 })
    return { stitchedFromScrollHeightCssPx: geo.scrollHeight, bodyClientHeightCssPx: geo.height }
  }
  const shot = async (name, gap, appState, { mode = 'screen', scrollTo = null, ...extra } = {}) => {
    clearCandidate(name)
    let how
    if (mode === 'tall') {
      how = { capture: 'tall: header + every #body scroll position stitched', ...(await stitch(page, path.join(OUT, name))) }
    } else {
      await page.evaluate((sel) => {
        const b = document.querySelector('#body')
        b.scrollTop = sel ? document.querySelector(sel).offsetTop - 10 : 0
      }, scrollTo)
      await sleep(300)
      await page.screenshot({ path: path.join(OUT, name), animations: 'disabled' })
      how = { capture: 'one phone screen as seen' + (scrollTo ? `, #body scrolled to ${scrollTo}` : '') }
    }
    writeSidecar(name, {
      gap, route: 'tools/capture/wiki-gaps/pendant.mjs', viewport: [VIEWPORT.width, VIEWPORT.height],
      appState, sourcePaths: PENDANT_SOURCES,
      extra: { server: 'node pendant/server.mjs (standalone, no --bridge; built-in SimulatedGrbl)', pageUrl: page.url(), deviceScaleFactor: DPR, ...how, ...extra },
    })
  }
  const api = (p, body) => page.evaluate(async ([p, body]) => (await fetch('/api/' + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json(), [p, body])

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.querySelector('#hdr-state')?.textContent === 'IDLE')
  // Stand the simulated probe inside the simulator's virtual bore (centre
  // X50 Y50, top Z0; pendant/sim-grbl.mjs) so the DRO reads a real position
  // and the Bore routine below has a hole to touch.
  for (const command of ['G53 G0 X50 Y50', 'G53 G0 Z-5']) {
    const r = await api('command', { command })
    if (!r.ok) throw new Error('move refused: ' + JSON.stringify(r))
    await sleep(300)
    await page.waitForFunction(() => document.querySelector('#hdr-state')?.textContent === 'IDLE', null, { timeout: 15000 })
  }
  await sleep(500)
  const dro = await page.evaluate(() => ['x', 'y', 'z'].map((a) => document.querySelector('#dro-' + a).textContent))

  // P-4 JOG tab, one screen (at 390x844 the app hides QUICK MACROS; see layout() in app.js).
  const macrosShown = await page.locator('#macro-panel').evaluate((el) => !el.classList.contains('hidden'))
  await shot('P-4-phone-jog.png', 'P-4', `Phone 390x844, one screen (the JOG tab fits; QUICK MACROS ${macrosShown ? 'shown' : 'hidden by the app at this height'}), JOG tab. Standalone simulator, IDLE, G54, probe moved over the simulator's virtual bore (DRO ${dro.join(' / ')}). Theme BLUE.`, { dro, macrosShown })

  // P-7 STATUS & OVR, before any probing (a finished run leaves the sim's probe pin TRIGGERED).
  await page.locator('#tabs .tab[data-tab="pane-status"]').click()
  await sleep(500)
  await shot('P-7a-phone-status-ovr-screen1.png', 'P-7', 'Phone 390x844, STATUS & OVR tab, first screen as seen (top of the pane), cards in their default open/closed state.')
  await page.evaluate(() => document.querySelectorAll('#pane-status details').forEach((d) => { d.open = true }))
  await sleep(300)
  await shot('P-7-phone-status-ovr.png', 'P-7', 'Phone 390x844, STATUS & OVR tab, tall stitched (whole scrolling pane), every card opened by the route: coordinate systems, parser modal state, spindle & feed, realtime overrides, active tool, work coordinate system G54-G59, hardware signals. Standalone simulator values.', { mode: 'tall' })

  // P-5 PROBING tab, Bore picked, both cards open, path-clear ticked.
  await page.locator('#tabs .tab[data-tab="pane-probe"]').click()
  await page.locator('.probe-tile', { hasText: 'Bore' }).first().click()
  await page.evaluate(() => document.querySelectorAll('#pane-probe details').forEach((d) => { d.open = true }))
  await page.locator('#probe-path-clear').check()
  await sleep(400)
  const tiles = await page.locator('.probe-tile .probe-tile-name').allInnerTexts()
  await shot('P-5-phone-probing.png', 'P-5', 'Phone 390x844, PROBING tab, tall stitched (whole scrolling pane): SELECT PROBE ROUTINE grid, Bore picked, BORE DIAGRAM and BORE PARAMETERS open (defaults), path-clear tick ticked, START PROBE ROUTINE. Nothing run.', { mode: 'tall', routines: tiles })

  // P-6 run Bore on the simulator; result card with APPLY AS WORK ZERO.
  await page.locator('#btn-probe-start').click()
  try {
    await page.locator('#probe-result').waitFor({ state: 'visible', timeout: 120_000 })
  } catch (error) {
    throw new Error('Bore run did not finish: ' + await page.locator('#probe-exec').innerText())
  }
  await sleep(600)
  const result = await page.locator('#result-box').innerText()
  const progress = await page.locator('#probe-exec').innerText()
  const p6 = 'Phone 390x844, PROBING tab after START PROBE ROUTINE (Bore) on the standalone simulator: PROBING PROGRESS card COMPLETE with its touch log, and the result card with APPLY AS WORK ZERO (G10 L20). Apply NOT pressed.'
  await shot('P-6-phone-probe-result.png', 'P-6', p6 + ' One screen, scrolled to the progress card.', { scrollTo: '#probe-exec', result, progress })
  await shot('P-6b-phone-probe-result-tall.png', 'P-6', p6 + ' Tall stitched (whole scrolling pane).', { mode: 'tall', result, progress })

  await context.close()

  if (compare) {
    const cmpDir = path.join(OUT, 'compare')
    fs.mkdirSync(cmpDir, { recursive: true })
    const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, isMobile: true, hasTouch: true })
    const p = await ctx.newPage()
    p.on('pageerror', (e) => errors.push('bridge: ' + e.message))
    // Desktop status payload shape (pendantBridge.ts machineStatusPayload), fake values.
    const payload = {
      state: 'Idle', mpos: [50, 50, -5], wpos: [50, 50, -5], wco: [0, 0, 0], activeWcs: 'G54',
      theme: 'default', colorMode: 'dark', feed: 0, spindleRpm: 0, spindleState: 'off',
      overrides: { feed: 100, rapid: 100, spindle: 100 },
      overrideAvailability: { feed: 'supported', rapid: 'supported', spindle: 'supported' },
      parserState: { motion: 'G0', distance: 'G90', units: 'G21', wcs: 'G54', spindle: 'M5' },
      tool: 1, toolInfo: { number: 1, name: 'Active tool', diameterMm: null }, tlo: 0, pins: '',
    }
    await p.routeWebSocket(/\/bridge/, (ws) => {
      ws.onMessage((text) => {
        const m = JSON.parse(String(text))
        if (m.type === 'hello') {
          ws.send(JSON.stringify({ type: 'hello-ack', role: 'pendant', clientId: 'mock', lanIps: ['192.0.2.10'], port: PORT }))
          ws.send(JSON.stringify({ type: 'bridge-status', connected: true }))
          ws.send(JSON.stringify({ type: 'status', data: payload }))
        }
      })
    })
    const url = `${BASE}?pair=demo0000demo0000demo&broker=${encodeURIComponent(`ws://127.0.0.1:${PORT}/bridge`)}`
    await p.goto(url, { waitUntil: 'domcontentloaded' })
    await p.waitForFunction(() => document.querySelector('#hdr-state')?.textContent === 'IDLE', null, { timeout: 15000 })
    const notes = {}
    for (const [tab, name] of [['pane-jog', 'bridge-jog.png'], ['pane-probe', 'bridge-probing.png'], ['pane-status', 'bridge-status-ovr.png']]) {
      await p.locator(`#tabs .tab[data-tab="${tab}"]`).click()
      if (tab !== 'pane-jog') await p.evaluate(() => document.querySelectorAll('.pane.active details').forEach((d) => { d.open = true }))
      await sleep(400)
      await stitch(p, path.join(cmpDir, name))
      notes[name] = await p.locator('#app').innerText()
    }
    notes.themeChipDisabled = await p.locator('#btn-theme').isDisabled()
    fs.writeFileSync(path.join(cmpDir, 'bridge-mock.json'), JSON.stringify({
      purpose: 'Bridge-mode render of the same pendant app against a mocked /bridge WebSocket, for comparison with the standalone candidates. Fake data only; not candidates.',
      pageUrl: url, payload, notes,
    }, null, 2) + '\n')
    await ctx.close()
    console.log('compare frames written')
  }
  if (errors.length) throw new Error('browser errors: ' + JSON.stringify(errors))
} finally {
  await browser.close()
  server.kill()
}
