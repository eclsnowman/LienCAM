// All actions stay on the built-in simulator. Never connect to board hardware.
import { chromium } from 'playwright'
import sharp from 'sharp'
import fs from 'node:fs'
import path from 'node:path'
import { withViteCaptureServer, dismissMachineModal, CHROMIUM_CAPTURE_ARGS } from '../lib/harness.mjs'
import { HELP_EVIDENCE } from './evidence-root.mjs'

const out = path.resolve(HELP_EVIDENCE, 'control')
const traceOnly = process.argv.includes('--trace-only')
fs.mkdirSync(out, { recursive: true })
// WO-2708 pattern: Windows can reserve 62396-63095; CAPTURE_PORT moves this route off it.
await withViteCaptureServer({ port: Number(process.env.CAPTURE_PORT || 62501), repoRoot: process.cwd(), timeoutMs: 300000 }, async ({ baseUrl }) => {
  const browser = await chromium.launch({ headless: true, args: CHROMIUM_CAPTURE_ARGS })
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })
    const errors = []
    page.on('pageerror', e => errors.push(e.message))
    const shot = async (topic, slot, predicate) => {
      if (traceOnly && !['control-overview', 'run-job'].includes(slot)) return
      if (!await predicate()) throw new Error('Scene predicate failed: ' + topic)
      if (/Machine travel unset/.test(await page.locator('body').innerText())) throw new Error('Demo travel is incomplete')
      const png = path.join(out, slot + '.png')
      fs.rmSync(png, { force: true })
      await page.mouse.move(1, 1)
      await page.screenshot({ path: png, animations: 'disabled' })
      let image = sharp(png)
      const selector = slot === 'connect-flow' ? '.control-col-left .control-panel' : null
      if (selector) {
        const b = await page.locator(selector).first().boundingBox()
        image = image.extract({ left: Math.floor(b.x), top: Math.floor(b.y), width: Math.floor(b.width), height: Math.floor(b.height) })
      }
      if (slot === 'jog-zero') {
        const clips = []
        for (const sel of ['.control-col-left .control-panel:nth-child(2)', '.control-col-right .control-panel:first-child']) {
          const b = await page.locator(sel).boundingBox()
          clips.push(await sharp(png).extract({ left: Math.floor(b.x), top: Math.floor(b.y), width: Math.floor(b.width), height: Math.floor(b.height) }).png().toBuffer())
        }
        const sizes = await Promise.all(clips.map(c => sharp(c).metadata()))
        image = sharp({ create: { width: sizes[0].width + sizes[1].width + 12, height: Math.max(...sizes.map(s => s.height)), channels: 3, background: '#101217' } }).composite(clips.map((input, i) => ({ input, left: i ? sizes[0].width + 12 : 0, top: 0 })))
      }
      await image.webp({ quality: 88 }).toFile(path.resolve('public/help', topic, slot + '.webp'))
      fs.writeFileSync(path.join(out, slot + '.json'), JSON.stringify({ capturedAt: new Date().toISOString(), viewport: [1920, 1080], simulatorOnly: true, text: await page.locator('body').innerText(), errors }, null, 2))
      console.log('captured', topic, slot)
    }
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => !!window.__camStore)
    await dismissMachineModal(page)
    await page.evaluate(async () => {
      const { createDefaultControllerDefinition } = await import('/src/types/index.ts')
      const s = window.__camStore.getState()
      const definition = createDefaultControllerDefinition(['X', 'Y', 'Z'])
      definition.axes.forEach((axis, i) => {
        axis.stepPin = { port: 1, pin: 2 + i * 2, negate: false }
        axis.dirPin = { port: 1, pin: 3 + i * 2, negate: false }
        axis.softLimitMin = 0
        axis.softLimitMax = [800, 600, 150][i]
      })
      definition.stated = definition.axes.flatMap(axis => ['softLimitMin', 'softLimitMax'].map(end => ({ controller: 'uccnc', key: `liencam.axes.${axis.axis}.${end}` })))
      // A positive-travel UCCNC demo machine: the sample's home-at-max convention is not a fact about it (WO-2712).
      const machine = { ...s.project.machine, id: 'help-simulator', name: 'Help demo router', controller: 'uccnc', travel: { x: 800, y: 600, z: 150 }, controllerDefinition: definition, homeConvention: undefined }
      s.addMachineToLibrary(machine)
      s.setProjectMachine(machine)
    })
    await page.getByTestId('mode-tab-control').click()
    await page.getByTestId('control-page').waitFor()
    await page.getByTestId('control-kind-select').selectOption('simulator')
    await shot('control-connect', 'connect-flow', () => page.getByTestId('control-connect').isVisible())
    await page.getByTestId('control-connect').click()
    await page.getByTestId('control-disconnect').waitFor()
    if (/CLEAR/.test(await page.getByTestId('control-estop').innerText())) await page.getByTestId('control-estop').click()
    await page.getByTestId('control-home').click()
    await page.locator('[data-testid="control-homed-led"].control-led-ok').waitFor({ timeout: 60000 })
    await page.getByTestId('control-zero-all').click()
    // Put the example's stock top above the simulated table before setting G54;
    // the posted cuts go below work Z0 and must stay inside machine travel.
    await page.getByTestId('control-mdi-input').fill('G90 G0 X100 Y100 Z30')
    await page.getByTestId('control-mdi-input').press('Enter')
    await page.waitForFunction(() => Number(document.querySelector('[data-testid="control-dro-machine-z"]')?.value) === 30, null, { timeout: 30000 })
    await page.getByTestId('control-zero-all').click()
    // Load the shipped posted example through the production Control file input.
    const program = page.getByTestId('control-file-input')
    await program.setInputFiles(path.resolve('examples/gcode/02-toe-clamps-uccnc.nc'))
    await page.waitForFunction(() => document.querySelector('[data-testid="control-progress-text"]')?.textContent?.includes('/'), null, { timeout: 15000 })
    await page.waitForTimeout(1500)
    await page.locator('button').filter({ hasText: /^TOP$/ }).click()
    await page.getByRole('button', { name: 'Fit program extents', exact: true }).click()
    await page.waitForTimeout(600)
    await shot('control-tab-overview', 'control-overview', () => page.getByTestId('control-disconnect').isVisible())
    await shot('control-jog-zero', 'jog-zero', () => page.getByTestId('control-zero-x').isVisible())
    await page.getByTestId('control-cyclestart').click()
    await page.waitForFunction(() => {
      const text = document.querySelector('[data-testid="control-progress-text"]')?.textContent ?? ''
      const match = text.match(/(\d+)\/(\d+) \((\d+)%\)/)
      return match && +match[1] > 100 && +match[3] > 0 && +match[3] < 80
    }, null, { timeout: 120000 })
    await shot('control-run-job', 'run-job', async () => /run/i.test(await page.getByTestId('control-state-chip').innerText()))
    await page.getByTestId('control-stop-reset').click()
    if (errors.length) throw new Error(JSON.stringify(errors))
  } catch (error) {
    for (const page of browser.contexts().flatMap(context => context.pages())) {
      await page.screenshot({ path: path.join(out, 'trace-failure.png') })
      fs.writeFileSync(path.join(out, 'trace-failure.txt'), await page.locator('body').innerText())
    }
    throw error
  } finally { await browser.close() }
})
