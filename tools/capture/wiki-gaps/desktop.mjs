// WO-2709 desktop wiki-gap candidates: G01, G02 (Probing.md) and P-1
// (Phone-Pendant.md pairing popover). Built-in simulator ONLY - never a board.
// Served the help-capture way (branch Vite via withViteCaptureServer).
// P-1 uses FAKE pairing data: the session's pendantBridge snapshot is set to
// documentation-only addresses (RFC 5737) and a dummy token; no broker runs.
//
//   node tools/capture/wiki-gaps/desktop.mjs            all three
//   node tools/capture/wiki-gaps/desktop.mjs --explore  debug dump to --scratch <dir>
import { chromium } from 'playwright'
import sharp from 'sharp'
import fs from 'node:fs'
import path from 'node:path'
import { withViteCaptureServer, dismissMachineModal, CHROMIUM_CAPTURE_ARGS } from '../lib/harness.mjs'
import { OUT, clearCandidate, waitForCpu, writeSidecar } from './common.mjs'

const argv = process.argv.slice(2)
const explore = argv.includes('--explore')
const scratchArg = argv.indexOf('--scratch')
const SCRATCH = scratchArg >= 0 ? path.resolve(argv[scratchArg + 1]) : path.join(OUT, '..', 'debug')
const only = (argv.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean)
const want = (gap) => !only.length || only.includes(gap)
const VIEWPORT = { width: 1920, height: 1080 }
const FAKE = {
  token: 'demo0000demo0000demo',
  lanIps: ['192.0.2.10', '198.51.100.7'],
  port: 8324,
}
FAKE.url = `http://${FAKE.lanIps[0]}:${FAKE.port}/?${new URLSearchParams({ pair: FAKE.token, broker: `ws://${FAKE.lanIps[0]}:${FAKE.port}/bridge` })}`
const DESKTOP_SOURCES = ['src', 'index.html']

await waitForCpu()
await withViteCaptureServer({ port: 47209, repoRoot: process.cwd(), timeoutMs: 300_000 }, async ({ baseUrl }) => {
  const browser = await chromium.launch({ headless: true, args: CHROMIUM_CAPTURE_ARGS })
  const errors = []
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 })
  page.on('pageerror', (e) => errors.push(e.message))
  const refused = []
  page.on('requestfailed', (r) => refused.push(r.url() + ' ' + (r.failure()?.errorText ?? '')))
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    // A refused request to a local service the app polls (recorded below) is
    // not a page fault; anything else fails the capture.
    if (/ERR_CONNECTION_REFUSED/.test(m.text())) return
    errors.push('console: ' + m.text())
  })
  const tid = (id) => page.getByTestId(id)
  const debug = async (name) => {
    fs.mkdirSync(SCRATCH, { recursive: true })
    await page.screenshot({ path: path.join(SCRATCH, name + '.png') })
    fs.writeFileSync(path.join(SCRATCH, name + '.txt'), await page.locator('body').innerText())
    console.log('debug', name)
  }
  const shotFull = async (name) => {
    clearCandidate(name)
    await page.mouse.move(1, 1)
    await page.waitForTimeout(400)
    await page.screenshot({ path: path.join(OUT, name), animations: 'disabled' })
  }
  const crop = async (name, box) => {
    const file = path.join(OUT, name)
    const buf = await sharp(file).extract({
      left: Math.max(0, Math.floor(box.x)), top: Math.max(0, Math.floor(box.y)),
      width: Math.min(VIEWPORT.width - Math.max(0, Math.floor(box.x)), Math.ceil(box.width)),
      height: Math.min(VIEWPORT.height - Math.max(0, Math.floor(box.y)), Math.ceil(box.height)),
    }).png().toBuffer()
    fs.writeFileSync(file, buf)
  }
  const union = (...boxes) => {
    const x = Math.min(...boxes.map((b) => b.x)), y = Math.min(...boxes.map((b) => b.y))
    const r = Math.max(...boxes.map((b) => b.x + b.width)), btm = Math.max(...boxes.map((b) => b.y + b.height))
    return { x, y, width: r - x, height: btm - y }
  }
  const pad = (b, p) => ({ x: b.x - p, y: b.y - p, width: b.width + 2 * p, height: b.height + 2 * p })
  const mdi = async (line) => {
    await tid('control-mdi-input').fill(line)
    await tid('control-mdi-input').press('Enter')
  }
  const waitIdle = () => page.waitForFunction(() => /idle/i.test(document.querySelector('[data-testid="control-state-chip"]')?.textContent ?? ''), null, { timeout: 60_000 })

  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => !!window.__camStore)
    await dismissMachineModal(page)
    // The Help control capture's demo machine (tools/capture/help/control.mjs),
    // declared as a GRBL controller: its dialect states G38.3, so the
    // simulator runs the from-the-top probing plan the BEFORE START picture
    // shows (a UCCNC text dialect falls back to probing beside the faces).
    await page.evaluate(async (CONTROLLER) => {
      const { createDefaultControllerDefinition } = await import('/src/types/index.ts')
      const s = window.__camStore.getState()
      const definition = createDefaultControllerDefinition(['X', 'Y', 'Z'])
      definition.axes.forEach((axis, i) => {
        axis.stepPin = { port: 1, pin: 2 + i * 2, negate: false }
        axis.dirPin = { port: 1, pin: 3 + i * 2, negate: false }
        axis.softLimitMin = 0
        axis.softLimitMax = [800, 600, 150][i]
      })
      definition.stated = definition.axes.flatMap((axis) => ['softLimitMin', 'softLimitMax'].map((end) => ({ controller: CONTROLLER, key: `liencam.axes.${axis.axis}.${end}` })))
      const machine = { ...s.project.machine, id: 'help-simulator', name: 'Help demo router', controller: CONTROLLER, travel: { x: 800, y: 600, z: 150 }, controllerDefinition: definition }
      s.addMachineToLibrary(machine)
      s.setProjectMachine(machine)
    }, 'grbl')
    await tid('mode-tab-control').click()
    await tid('control-page').waitFor()
    await tid('control-kind-select').selectOption('simulator')
    await tid('control-connect').click()
    await tid('control-disconnect').waitFor()
    if (/CLEAR/.test(await tid('control-estop').innerText())) await tid('control-estop').click()
    await tid('control-home').click()
    await page.locator('[data-testid="control-homed-led"].control-led-ok').waitFor({ timeout: 60_000 })
    await waitIdle()
    if (explore) await debug('01-connected-homed')

    // ---------------- P-2: consent tick before enabling (real-machine wording)
    // The tick only shows on a non-simulator connection. The route sets the
    // session's connectionKind to 'serial' over the connected simulator (a
    // test seam: no port is opened, nothing is enabled), shoots the popover
    // unticked and ticked, closes it and restores 'simulator'.
    if (want('P-2')) {
      await page.evaluate(async () => {
        const { useMachineControl } = await import('/src/store/machineControlStore.ts')
        useMachineControl.setState({ connectionKind: 'serial' })
      })
      await tid('pendant-status-button').click()
      await page.locator('#pendant-pairing-popover .pendant-confirm-row').waitFor()
      const frames = [['P-2a-pendant-consent-unticked.png', false], ['P-2b-pendant-consent-ticked.png', true]]
      for (const [name, tick] of frames) {
        if (tick) await page.locator('#pendant-pairing-popover .pendant-confirm-row input').check()
        const enabled = await tid('pendant-enable').isEnabled()
        if (enabled !== tick) throw new Error(`P-2 Enable button state ${enabled} with tick ${tick}`)
        const popText = await page.locator('#pendant-pairing-popover').innerText()
        await shotFull(name)
        // Only the button + popover: the stubbed 'serial' kind also relabels the
        // Machine panel's connection select, which would not match the simulator.
        const btnBox = await tid('pendant-status-button').boundingBox()
        const popBox = await page.locator('#pendant-pairing-popover').boundingBox()
        await crop(name, pad(union(btnBox, popBox), 12))
        writeSidecar(name, {
          gap: 'P-2', route: 'tools/capture/wiki-gaps/desktop.mjs --only=P-2', viewport: [VIEWPORT.width, VIEWPORT.height],
          appState: `Control > Main, built-in simulator connected and homed; session connectionKind STUBBED to 'serial' so the popover shows the real-machine consent (the simulator skips it). Pendant button clicked; popover "Enable phone control" before enabling, tick ${tick ? 'TICKED (Enable remote control live)' : 'NOT ticked (Enable remote control greyed)'}. Cropped to the Pendant button + popover.`,
          sourcePaths: DESKTOP_SOURCES, extra: { popoverText: popText, enableButtonEnabled: enabled },
        })
      }
      await page.keyboard.press('Escape')
      await page.locator('#pendant-pairing-popover').waitFor({ state: 'detached' })
      await page.evaluate(async () => {
        const { useMachineControl } = await import('/src/store/machineControlStore.ts')
        useMachineControl.setState({ connectionKind: 'simulator' })
      })
    }

    // ---------------- P-1: Pendant button + enabled pairing popover (FAKE data)
    if (want('P-1')) {
      const name = 'P-1-pendant-pairing.png'
      const stub = await page.evaluate(async (fake) => {
        const { pendantBridge } = await import('/src/lib/machine/pendantRuntime.ts')
        // Test seam: the session bridge's own snapshot, set as a connected broker
        // would set it. No socket exists, so nothing is served or paired.
        pendantBridge.snapshotValue = {
          ...pendantBridge.snapshot(),
          enabled: true, phase: 'connected', brokerUrl: `ws://127.0.0.1:${fake.port}/bridge`,
          pairingToken: fake.token, connectedPendants: 0, lanIps: fake.lanIps, brokerPort: fake.port,
          lastError: null, lastActivity: null,
        }
        pendantBridge.notify()
        return pendantBridge.snapshot()
      }, FAKE)
      await tid('pendant-status-button').click()
      await page.locator('#pendant-pairing-popover').waitFor()
      await page.locator('#pendant-pairing-popover svg').first().waitFor()
      const url = await page.getByLabel('Pendant pairing URL').inputValue()
      if (url !== FAKE.url) throw new Error('P-1 URL is not the fake URL: ' + url)
      const popText = await page.locator('#pendant-pairing-popover').innerText()
      if (!popText.includes('Session code ' + FAKE.token.slice(0, 8))) throw new Error('P-1 session code not fake')
      if (explore) await debug('02-pendant-popover')
      await shotFull(name)
      const panel = await page.locator('.control-machine-status-row').first().evaluateHandle((el) => el.closest('.control-panel') || el)
      const panelBox = await panel.asElement().boundingBox()
      const popBox = await page.locator('#pendant-pairing-popover').boundingBox()
      const btnBox = await tid('pendant-status-button').boundingBox()
      await crop(name, pad(union(panelBox, popBox), 12))
      // Annotated twin: a ring round the phone-icon Pendant button (its
      // "Pendant" label is hidden in this row, so the wiki must point at it).
      const cropBox = pad(union(panelBox, popBox), 12)
      const nameRing = 'P-1b-pendant-pairing-annotated.png'
      clearCandidate(nameRing)
      {
        const meta = await sharp(path.join(OUT, name)).metadata()
        const cx = btnBox.x - Math.max(0, Math.floor(cropBox.x)) + btnBox.width / 2
        const cy = btnBox.y - Math.max(0, Math.floor(cropBox.y)) + btnBox.height / 2
        const rx = btnBox.width / 2 + 10, ry = btnBox.height / 2 + 9
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${meta.width}" height="${meta.height}"><ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="none" stroke="#ff9f1c" stroke-width="3"/></svg>`
        await sharp(path.join(OUT, name)).composite([{ input: Buffer.from(svg) }]).png().toFile(path.join(OUT, nameRing))
      }
      writeSidecar(nameRing, {
        gap: 'P-1',
        route: 'tools/capture/wiki-gaps/desktop.mjs --only=P-1',
        viewport: [VIEWPORT.width, VIEWPORT.height],
        appState: 'Same picture as P-1-pendant-pairing.png with an orange ring drawn round the phone-icon Pendant button (annotation added by the capture script, not app UI).',
        sourcePaths: DESKTOP_SOURCES,
        extra: { fakeData: { addresses: FAKE.lanIps, token: FAKE.token, sessionCode: FAKE.token.slice(0, 8), url: FAKE.url } },
      })
      writeSidecar(name, {
        gap: 'P-1',
        route: 'tools/capture/wiki-gaps/desktop.mjs --only=P-1',
        viewport: [VIEWPORT.width, VIEWPORT.height],
        appState: 'Control > Main, built-in simulator connected, CLEAR pressed, homed, idle. Pendant button (phone icon) clicked; pairing popover in the enabled state from a STUBBED pendantBridge snapshot (no broker running). Cropped to the Machine panel + popover.',
        sourcePaths: DESKTOP_SOURCES,
        extra: {
          fakeData: { addresses: FAKE.lanIps, token: FAKE.token, sessionCode: FAKE.token.slice(0, 8), url: FAKE.url, qrValue: FAKE.url },
          stubbedSnapshot: stub,
          pendantButtonBoxInFullFrame: btnBox,
          popoverText: popText,
        },
      })
      await page.evaluate(async () => {
        const { pendantBridge } = await import('/src/lib/machine/pendantRuntime.ts')
        pendantBridge.disable()
      })
      await page.keyboard.press('Escape')
      await page.locator('#pendant-pairing-popover').waitFor({ state: 'detached' })
    }

    // ---------------- Probing: read the simulated part, open Outside corner
    if (want('G01') || want('G02')) {
      await tid('control-view-machine').click()
      await tid('control-machine-tab-diagnostics').click()
      await tid('simulated-part-position').waitFor()
      const part = {
        position: await tid('simulated-part-position').innerText(),
        size: await tid('simulated-part-size').innerText(),
      }
      const nums = (t) => [...t.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => +m[0])
      const [px, py, pz] = nums(part.position)
      const [sx, sy, sz] = nums(part.size)
      console.log('simulated part', part)
      if (explore) await debug('03-diagnostics-part')
      await tid('control-view-main').click()
      await tid('control-mdi-input').waitFor()
      // Stand the probe above the part's front-right corner, inside it by 8 mm,
      // 5 mm above its top, so the Outside corner plan starts from the top.
      // (Front-left is beside the simulated part's 10 mm boss, which a
      // go-around move at that height touches.)
      const start = { x: px + sx - 8, y: py + 8, z: pz + 5 }
      globalThis.__partInfo = { part, px, py, pz, sx, sy, sz, start }
      await mdi(`G21 G90 G53 G0 X${start.x.toFixed(3)} Y${start.y.toFixed(3)} Z${start.z.toFixed(3)}`)
      await page.waitForTimeout(500)
      await waitIdle()
      await tid('control-view-probing').click()
      await tid('control-probing-panel').waitFor()
      await tid('control-work-probe-routine-outsideCorner').click()
      await tid('probing-step-card').waitFor()
      await tid('control-work-probe-corner').selectOption('-+') // front-right
      await page.waitForTimeout(1200)
      if (explore) await debug('04-outside-corner-selected')
      const probingState = 'Control > Probing, built-in simulator connected (GRBL-dialect demo machine, 800x600x150), CLEAR pressed, homed, idle. Simulated part: ' + part.position + '; ' + part.size + '. Probe stood 8 mm inside the front-right corner, 5 mm above the top (machine X' + start.x + ' Y' + start.y + ' Z' + start.z + ').'

      if (want('G01')) {
        const name = 'G01-probing-tab-outside-corner.png'
        const sentence = await tid('probing-step-sentence').innerText()
        const ok = /idle/i.test(await tid('control-state-chip').innerText())
          && /Outside corner setup/i.test(await tid('control-probe-setup-card').innerText())
          && (await tid('control-work-probe-corner').inputValue()) === '-+'
          && /BEFORE START/.test(await tid('probing-step-card').innerText())
          && await tid('control-probe-run-guided').isEnabled()
        if (!ok) throw new Error('G01 state predicate failed')
        await shotFull(name)
        writeSidecar(name, {
          gap: 'G01', route: 'tools/capture/wiki-gaps/desktop.mjs --only=G01', viewport: [VIEWPORT.width, VIEWPORT.height],
          appState: probingState + ' Outside corner picked, corner front-right, setup defaults; BEFORE START picture on step 1 (YOU), Picture key open, Start probing / Stop. Nothing run yet.',
          sourcePaths: DESKTOP_SOURCES, extra: { stepSentence: sentence },
        })
      }

      if (want('G02')) {
        await tid('control-probe-run-guided').click()
        await tid('control-work-probe-apply').waitFor({ state: 'visible', timeout: 90_000 })
        await waitIdle()
        await page.waitForTimeout(800)
        const result = await tid('control-work-probe-result').innerText()
        const sentence = await tid('probing-step-sentence').innerText()
        const statusLine = await page.locator('body').innerText()
        if (!/probe finished/i.test(statusLine) || !/Press Confirm/.test(sentence) || !/Corner at machine/.test(result)) throw new Error('G02 run did not reach its Confirm step: ' + sentence + ' / ' + result)
        const name = 'G02-probe-result-confirm.png'
        await shotFull(name)
        writeSidecar(name, {
          gap: 'G02', route: 'tools/capture/wiki-gaps/desktop.mjs --only=G02', viewport: [VIEWPORT.width, VIEWPORT.height],
          appState: probingState + ' Start probing pressed; the simulator run finished ("Outside corner probe finished. Ready."); result step 6 with its Confirm button, BEFORE Confirm (nothing written).',
          sourcePaths: DESKTOP_SOURCES, extra: { stepSentence: sentence, resultText: result },
        })
      }
    }
    if (explore) {
      fs.writeFileSync(path.join(SCRATCH, 'part.json'), JSON.stringify(globalThis.__partInfo ?? null, null, 2))
    }
  } catch (error) {
    fs.mkdirSync(SCRATCH, { recursive: true })
    await page.screenshot({ path: path.join(SCRATCH, 'failure.png') }).catch(() => {})
    fs.writeFileSync(path.join(SCRATCH, 'failure.txt'), String(error?.stack || error) + '\n\n' + await page.locator('body').innerText().catch(() => ''))
    throw error
  } finally {
    await browser.close()
  }
  if (refused.length) console.log('refused requests (local services not running):', refused)
  if (refused.some((r) => !/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(r))) throw new Error('non-local request failed: ' + JSON.stringify(refused))
  if (errors.length) throw new Error('browser errors: ' + JSON.stringify(errors))
})
