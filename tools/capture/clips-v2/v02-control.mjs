// WO-2572 control only: no recorder, no product mutation, no clip replacement.
// Preparation and performance copied verbatim from v02.mjs at a846bd06bf.
import { chromium } from 'playwright'
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { realGpuVerdict } from '../lib/real-gpu.mjs'
import { withFrozenV02Server } from './v02-frozen.mjs'
import { cpuCheck, wait, travel, installPointer } from './proof.mjs'
import { validateSequence } from './v02.mjs'
const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const OUT = path.join(ROOT, 'src/tests/evidence/WO-2572')
const afterFix = process.argv.includes('--after-fix')
let EVIDENCE
const delay = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))
const json = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
async function prepareV02(page, url, sequence) {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !!window.__camStore, null, { timeout: 30000 })
  await page.waitForTimeout(1000)
  // Release-demo builds have an example picker; normal dev builds do not.
  const empty = page.getByRole('button', { name: 'Start with an empty project' })
  if (await empty.isVisible()) await empty.click()
  await page.locator('#liencam-splash').waitFor({ state: 'hidden' })
  console.log('Frozen app ready; opening supplied project')
  await page.screenshot({ path: path.join(EVIDENCE, 'alpha3-before-open.png') })
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Open project', exact: true }).click()
  const browse = page.getByRole('button', { name: /^Browse/ })
  if (await browse.isVisible()) await browse.click()
  await (await chooser).setFiles(path.join(ROOT, 'tools/capture/clips-v2/.alpha3-source', sequence.project))
  console.log('File chooser supplied; waiting for project')
  await wait(page, 'project opened', () => page.evaluate(() => window.__camStore?.getState().project.geometry.length > 0))
  const machine = page.getByRole('button', { name: 'Use this machine', exact: true })
  if (await machine.isVisible()) {
    await page.locator('.machine-choice-item').filter({ hasText: 'Sample hobby router' }).click()
    await machine.click()
  }
  console.log('Project opened; regenerate all operations')
  await page.getByTestId('mode-tab-toolpath').click()
  await page.getByRole('button', { name: 'REGEN ALL', exact: true }).click()
  await wait(page, 'all toolpaths ready', () => page.evaluate(() => {
    const ops = window.__camStore.getState().project.setups.flatMap(s => s.operations)
    if (ops.some(o => o.status === 'error')) throw new Error('Application regeneration error')
    return ops.length > 0 && ops.every(o => o.status === 'ready')
  }))
  console.log('All operations ready; enter simulation')
  await page.locator('.tree-setup-header').first().click()
  await page.getByTestId('mode-tab-simulation').click()
  await page.getByLabel('Simulate Stock Removal', { exact: true }).check()
  await page.getByTestId('sim-hide-toolpath').check()
  await page.getByTestId('sim-display-stock').click()
  const slider = page.getByRole('slider', { name: 'Simulation position' })
  await wait(page, 'simulation duration', async () => +await slider.getAttribute('max') > 0)
  const durationMs = +await slider.getAttribute('max')
  const speed = 10
  await page.getByTestId('sim-speed-chip').click()
  await page.locator('.sim-speed-flyout button').filter({ hasText: new RegExp('^' + speed + 'x$|^x' + speed + '$') }).click()
  const canvas = page.locator('.viewport-canvas')
  await canvas.click({ button: 'right', position: { x: 650, y: 350 } })
  await page.locator('[role="menuitem"][data-action="fit-all"]').click()
  await canvas.click({ button: 'right', position: { x: 650, y: 350 } })
  await page.locator('[role="menuitem"][data-action="view-iso"]').click()
  const grid = page.getByRole('button', { name: 'Toggle grid', exact: true })
  if ((await grid.getAttribute('class')).includes('vp-btn-on')) await grid.click()
  await page.waitForTimeout(2000)
  const renderer = await page.evaluate(() => {
    const gl = document.querySelector('.viewport-canvas canvas').getContext('webgl2')
    const ext = gl?.getExtension('WEBGL_debug_renderer_info')
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '(unknown)'
  })
  const gpu = realGpuVerdict(renderer)
  if (!gpu.ok) throw new Error('Application GPU rejected: ' + renderer)
  return { renderer, gpu, durationMs, speed, project: await page.evaluate(() => {
    const p = window.__camStore.getState().project
    return { id: p.id, activeSetupId: p.activeSetupId, activeOperationId: p.activeOperationId, operations: p.setups.flatMap(s => s.operations.map(o => ({ name: o.name, status: o.status, moves: o.moves?.length }))) }
  }) }
}


async function zoom(page, amount, ms) {
  const start = performance.now(); let applied = 0, lastInputWallTime = Date.now() / 1000
  let beganWallTime = null
  while (performance.now() - start < ms) {
    const t = Math.min(1, (performance.now() - start) / ms), u = t
    const next = amount * u
    if (Math.abs(next - applied) > .01) {
      lastInputWallTime = Date.now() / 1000
      beganWallTime ??= lastInputWallTime
      await page.mouse.wheel(0, next - applied); applied = next
    }
    await delay(33)
  }
  if (Math.abs(amount - applied) > .01) {
    lastInputWallTime = Date.now() / 1000
    beganWallTime ??= lastInputWallTime
    await page.mouse.wheel(0, amount - applied)
  }
  return { beganWallTime, endedWallTime: lastInputWallTime }
}
async function perform(page, sequence) {
  const start = performance.now(), actions = []
  let pointer = { x: 1380, y: 900 }
  await page.mouse.move(pointer.x, pointer.y)
  for (const step of sequence.steps) {
    await delay(start + step.at * 1000 - performance.now())
    const began = (performance.now() - start) / 1000
    let motion = null
    if (step.action === 'orbit') {
      if (step.finished && !await page.evaluate(() => {
        const slider = document.querySelector('.sim-scrubber'), panel = document.querySelector('.sim-panel')
        return +slider.value >= +slider.max - 1 && panel.dataset.stockSync === 'exact' && Math.abs(+panel.dataset.stockMs - +slider.max) <= 1
      })) throw new Error('Finished stock not reached before final orbit')
      const rect = await page.locator('.viewport-canvas').boundingBox()
      const point = p => ({ x: rect.x + rect.width * p[0], y: rect.y + rect.height * p[1] })
      const from = point(step.from), to = point(step.to)
      await travel(page, pointer, from, 500)
      await page.mouse.down()
      const beganWallTime = Date.now() / 1000
      await travel(page, from, to, step.duration * 1000 - 600, false)
      motion = { beganWallTime, endedWallTime: Date.now() / 1000 }
      await page.mouse.up(); pointer = to
    } else if (step.action === 'zoom') {
      const rect = await page.locator('.viewport-canvas').boundingBox()
      const to = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
      await travel(page, pointer, to, 500)
      motion = await zoom(page, step.deltaY, step.duration * 1000 - 500); pointer = to
    } else if (step.action === 'opacity') {
      const slider = page.getByTestId('sim-stock-opacity'), rect = await slider.boundingBox()
      if (!rect || +await slider.inputValue() !== 1) throw new Error('Compare must expose full stock opacity before fading')
      // Native range thumb is 16 px wide. Drag its real center to the low end;
      // no synthetic input, DOM value assignment, or store writes.
      const from = { x: rect.x + rect.width - 8, y: rect.y + rect.height / 2 }
      const to = { x: rect.x + 8, y: from.y }
      await travel(page, pointer, from, 500)
      await page.mouse.down()
      motion = { beganWallTime: Date.now() / 1000 }
      await travel(page, from, to, step.duration * 1000 - 600, false)
      motion.endedWallTime = Date.now() / 1000
      await page.mouse.up(); pointer = to
      if (+await slider.inputValue() !== +await slider.getAttribute('min')) throw new Error('Stock opacity drag did not reach its low end')
    } else {
      if (step.action === 'compare' && !await page.evaluate(() => document.querySelector('.sim-panel').dataset.stockSync === 'exact' && !document.querySelector('button[aria-label="Pause"]'))) throw new Error('Compare requires completed playback')
      const locator = step.action === 'compare' ? page.getByTestId('sim-display-compare') : page.getByRole('button', { name: 'Play', exact: true })
      const rect = await locator.boundingBox()
      if (!rect) throw new Error('Playback button unavailable: ' + step.action)
      const to = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
      await travel(page, pointer, to, step.duration * 1000 - 180)
      await page.mouse.down(); await delay(120); await page.mouse.up(); pointer = to
    }
    const readback = await page.evaluate(() => ({ positionMs: +document.querySelector('.sim-scrubber').value, camera: window.__cncViewport.saveCameraState(), playing: !!document.querySelector('button[aria-label="Pause"]'), stockSync: document.querySelector('.sim-panel').dataset.stockSync, stockMs: +document.querySelector('.sim-panel').dataset.stockMs, comparePressed: document.querySelector('[data-testid="sim-display-compare"]').getAttribute('aria-pressed') === 'true', opacity: window.__camStore.getState().viewer.stockSimOpacity }))
    actions.push({ ...step, motion, began, ended: (performance.now() - start) / 1000, readback })
  }
  await delay(start + sequence.durationSeconds * 1000 - performance.now())
  return actions
}

function stats(values) {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y)
  return { count: a.length, min: a[0], median: a[Math.floor((a.length - 1) * .5)], p95: a[Math.floor((a.length - 1) * .95)], max: a.at(-1), mean: a.reduce((x, y) => x + y, 0) / a.length }
}
function summarize(samples, csv) {
  const active = samples.filter(s => s.playing)
  const gaps = active.slice(1).map((s, i) => ({ start: active[i].t, durationMs: (s.t - active[i].t) * 1000 }))
  const runs = []
  let start = null
  for (let i = 1; i <= active.length; i++) {
    const a = active[i - 1], b = active[i]
    const near = b && a.tool === b.tool && a.xy && b.xy && Math.hypot(a.xy[0] - b.xy[0], a.xy[1] - b.xy[1]) <= .5
    if (near && start === null) start = a.t
    if (!near && start !== null) {
      const durationMs = (a.t - start) * 1000
      if (durationMs >= 100) runs.push({ start, durationMs })
      start = null
    }
  }
  const lines = csv.trim().split(/\r?\n/), headers = lines.shift().split(',')
  const rows = lines.map(line => Object.fromEntries(line.split(',').map((v, i) => [headers[i], headers[i] === 'browserPids' ? v : +v])))
  const timing = rows.slice(1).map((r, i) => (r.elapsedSeconds - rows[i].elapsedSeconds) * 1000)
  return {
    samples: samples.length, activeSamples: active.length, appRafGapMs: stats(gaps.map(g => g.durationMs)),
    cutterNearDuplicateRunsAtLeast100ms: runs, cutterNearDuplicateCount: runs.length,
    cutterNearDuplicateMaxMs: Math.max(0, ...runs.map(r => r.durationMs)),
    cutterUnsampledGapsAtLeast100ms: gaps.filter(g => g.durationMs >= 100),
    load: { samples: rows.length, firstWallTimeMs: rows[0]?.wallTimeMs, lastWallTimeMs: rows.at(-1)?.wallTimeMs,
      firstTelemetryWallTimeMs: samples[0].wallTimeMs, lastTelemetryWallTimeMs: samples.at(-1).wallTimeMs,
      cadenceMs: stats(timing), totalCpuPercent: stats(rows.map(r => r.totalCpuPercent)),
      browserCpuPercent: stats(rows.map(r => r.browserCpuPercent)), gpuUtilPercent: stats(rows.map(r => r.gpuUtilPercent)),
      freeRamMiB: stats(rows.map(r => r.freeRamMiB)), sampleWorkMs: stats(rows.map(r => r.sampleWorkMs)) },
  }
}
async function control(flag) {
  const name = flag ? 'B-software' : 'A-default'
  EVIDENCE = path.join(OUT, (afterFix ? 'control-after-fix-' : 'control-') + name)
  mkdirSync(EVIDENCE, { recursive: true })
  const s = validateSequence(JSON.parse(readFileSync(new URL('./v02.json', import.meta.url))))
  const cpu = await cpuCheck()
  const fleet = execFileSync(process.execPath, ['tools/fleet-status.mjs'], { cwd: ROOT, encoding: 'utf8' })
  writeFileSync(path.join(EVIDENCE, 'fleet.txt'), fleet)
  const args = ['--use-gl=angle', '--use-angle=gl', '--ignore-gpu-blocklist', '--force-device-scale-factor=1', '--window-position=0,0']
  if (flag) args.push('--disable-gpu-compositing')
  const browser = await chromium.launch({ headless: false, args })
  try {
    return await withFrozenV02Server(async ({ baseUrl, source }) => {
      const context = await browser.newContext({ viewport: s.viewport, deviceScaleFactor: 1 })
      const page = await context.newPage(), errors = []
      page.on('pageerror', e => errors.push(e.message))
      const cdp = await browser.newBrowserCDPSession()
      const info = await cdp.send('SystemInfo.getInfo')
      const processes = await cdp.send('SystemInfo.getProcessInfo')
      const browserId = processes.processInfo.find(p => p.type === 'browser').id
      const wc = await context.newCDPSession(page)
      const { windowId } = await wc.send('Browser.getWindowForTarget')
      await wc.send('Browser.setWindowBounds', { windowId, bounds: { left: 0, top: 0, width: 1936, height: 1189, windowState: 'normal' } })
      await wc.detach()
      await page.bringToFront()
      const prep = await prepareV02(page, baseUrl, s)
      const exitGizmo = page.getByRole('button', { name: 'Exit gizmo', exact: true })
      if (await exitGizmo.isVisible()) await exitGizmo.click()
      await page.getByTestId('sim-display-compare').click()
      const opacity = page.getByTestId('sim-stock-opacity')
      await opacity.focus(); await opacity.press('Home'); await page.waitForTimeout(600); await opacity.press('End')
      await page.getByTestId('sim-display-stock').click()
      const canvas = await page.locator('.viewport-canvas').boundingBox()
      await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2)
      await zoom(page, -1300, 2200); await page.waitForTimeout(800)
      await installPointer(page)
      await page.mouse.move(1380, 900)
      await page.screenshot({ path: path.join(EVIDENCE, 'prepared.png') })
      const captureCpu = await cpuCheck()
      const ready = path.join(EVIDENCE, 'load.ready'), stop = path.join(EVIDENCE, 'load.stop')
      rmSync(ready, { force: true }); rmSync(stop, { force: true })
      const load = spawn('powershell.exe', ['-NoProfile', '-File', path.join(ROOT, 'tools/capture/clips-v2/v02-control-load.ps1'),
        '-BrowserId', String(browserId), '-LifetimeId', String(process.pid), '-Output', path.join(EVIDENCE, 'load.csv'), '-Ready', ready, '-Stop', stop],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let loadLog = ''
      load.stdout.on('data', d => { loadLog += d }); load.stderr.on('data', d => { loadLog += d })
      const loadDone = new Promise(resolve => { load.on('error', e => { loadLog += e.message; resolve(1) }); load.on('exit', resolve) })
      let actions, samples
      try {
        const deadline = Date.now() + 30000
        while (!existsSync(ready)) {
          if (load.exitCode !== null || Date.now() > deadline) throw new Error('Load monitor startup: ' + loadLog)
          await delay(100)
        }
        // Obtain the first actual one-second sample BEFORE starting the sequence.
        while (readFileSync(path.join(EVIDENCE, 'load.csv'), 'utf8').trim().split('\n').length < 2) {
          if (load.exitCode !== null || Date.now() > deadline) throw new Error('No initial load sample: ' + loadLog)
          await delay(100)
        }
        await page.evaluate(() => {
          const start = performance.now()
          window.__control = { running: true, samples: [] }
          const sample = () => {
            if (!window.__control.running) return
            const vp = window.__cncViewport, camera = vp.getCamera(), tool = vp.toolMarkerGroup
            const pos = tool?.getWorldPosition(camera.position.clone())
            const screen = pos?.clone().project(camera), rect = document.querySelector('.viewport-canvas').getBoundingClientRect()
            window.__control.samples.push({ t: (performance.now() - start) / 1000, wallTimeMs: Date.now(),
              playing: !!document.querySelector('button[aria-label="Pause"]'), sim: +document.querySelector('.sim-scrubber').value,
              tool: vp.toolGeoConfig?.type, visible: !!tool?.visible, position: pos?.toArray(),
              xy: screen ? [(screen.x + 1) * rect.width / 2, (1 - screen.y) * rect.height / 2] : null })
            requestAnimationFrame(sample)
          }
          requestAnimationFrame(sample)
        })
        console.log(name + ': control sequence started; load monitor already sampled')
        actions = await perform(page, s)
        samples = await page.evaluate(() => { window.__control.running = false; return window.__control.samples })
        json(path.join(EVIDENCE, 'samples.json'), samples)
        json(path.join(EVIDENCE, 'actions.json'), actions)
        await page.screenshot({ path: path.join(EVIDENCE, 'finished.png') })
      } finally {
        writeFileSync(stop, 'stop\n')
        const exit = await loadDone
        writeFileSync(path.join(EVIDENCE, 'load-log.txt'), loadLog)
        if (exit !== 0) throw new Error('Load monitor exit ' + exit + ': ' + loadLog)
        rmSync(ready, { force: true }); rmSync(stop, { force: true })
      }
      const result = { name, source, args, prep, cpu, captureCpu, errors, gpuFeatureStatus: info.gpu.featureStatus,
        otherModelLanes: fleet.split(/\r?\n/).find(l => l.startsWith('Fleet:')), ...summarize(samples, readFileSync(path.join(EVIDENCE, 'load.csv'), 'utf8')) }
      json(path.join(EVIDENCE, 'summary.json'), result)
      console.log(name + ': ' + JSON.stringify({ raf: result.appRafGapMs, nearDuplicateCount: result.cutterNearDuplicateCount, load: result.load }))
      await context.close()
      return result
    })
  } finally { await browser.close() }
}
const result = { task: 'WO-2572 control measurement 2026-10-28; no outside recorder',
  method: 'Same unchanged 280-second v02.json performance at native 10x. rAF samples contain rendered tool world and projected pixel coordinates. Near duplicate = adjacent cutter positions <=0.5 viewport pixels with the same tool during playback, runs >=100 ms. This is an in-page geometry proxy, not the decoded-pixel MAD metric. Unsampled >=100 ms rAF gaps reported separately; no frames invented. Load fixed absolute 1-second schedule, first sample precedes sequence; initial process tree frozen after all operations regenerate.',
  sequenceSha256: createHash('sha256').update(readFileSync(new URL('./v02.json', import.meta.url))).digest('hex'), runs: [] }
try {
  for (const flag of (afterFix ? [false] : [false, true])) {
    result.runs.push(await control(flag))
    json(path.join(OUT, (afterFix ? 'control-after-fix-20261028.json' : 'control-20261028.json')), result)
  }
  if (afterFix) {
    result.before = JSON.parse(readFileSync(path.join(OUT, 'control-20261028.json'), 'utf8')).runs[0].appRafGapMs
    result.verdict = 'Default-GPU after-fix measurement; compare timing without claiming decoded-video acceptance'
    json(path.join(OUT, 'control-after-fix-20261028.json'), result)
  } else {
  const [a, b] = result.runs
  const overloaded = result.runs.some(r => r.load.totalCpuPercent.mean >= 60 || r.load.gpuUtilPercent.p95 >= 90 || r.load.freeRamMiB.min < 2048)
  result.verdict = overloaded ? 'load' : a.appRafGapMs.p95 < 100 && b.appRafGapMs.p95 >= 100 ? 'stutter follows the flag' : 'stutter is in the app'
  result.verdictLimit = 'Sequential shared-PC controls cannot prove exclusive causality. Live-lane, CPU/GPU and cadence evidence accompany both runs. Verdict concerns in-page timing, not external capture smoothness.'
  json(path.join(OUT, (afterFix ? 'control-after-fix-20261028.json' : 'control-20261028.json')), result)
  }
} catch (error) {
  result.error = error.stack
  json(path.join(OUT, (afterFix ? 'control-after-fix-20261028.json' : 'control-20261028.json')), result)
  console.error(error)
  process.exitCode = 1
}
