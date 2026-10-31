import { chromium } from 'playwright'
import { mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { deterministicTake } from './v02-deterministic.mjs'
import { realGpuVerdict } from '../lib/real-gpu.mjs'
import { withFrozenV02Server } from './v02-frozen.mjs'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const EVIDENCE = path.join(ROOT, 'src/tests/evidence/WO-2572')
const OUTPUT = path.join(ROOT, 'docs/media/clips-v2')
const json = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
const delay = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))
import { cpuCheck, wait, ffmpeg, travel, installPointer, startCompositorCapture } from './proof.mjs'
async function waitForCaptureCpu() {
  const deadline = Date.now() + 120000
  while (true) {
    try { return await cpuCheck() } catch (error) {
      if (!error.message.startsWith('Shared PC CPU >= 60%') || Date.now() >= deadline) throw error
      console.log('Capture deferred; waiting ten seconds before three fresh CPU samples')
      await delay(10000)
    }
  }
}
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

export function validateSequence(s) {
  // The operator rejected 50x. "As long as the job needs" takes precedence over
  // the approximate 45-90 s guidance: the supplied program needs 246 s at 10x.
  if (s.version !== 1 || s.viewport?.width !== 1920 || s.viewport?.height !== 1080 ||
      s.durationSeconds < 45 || s.durationSeconds > 600 || !Number.isFinite(s.durationSeconds) ||
      s.project !== 'examples/01-fixture-plate/fixture-plate.camproject') throw new Error('Invalid V02 sequence')
  let end = 0
  for (const step of s.steps) {
    if (!['play', 'orbit', 'zoom', 'compare', 'opacity'].includes(step.action) || !Number.isFinite(step.at) || step.at < end ||
        !Number.isFinite(step.duration) || step.duration < .8 || step.at + step.duration > s.durationSeconds) throw new Error('Invalid V02 action timing')
    if (step.action === 'orbit' && [step.from, step.to].some(p => !Array.isArray(p) || p.length !== 2 || p.some(n => !Number.isFinite(n) || n < .1 || n > .9))) throw new Error('Invalid orbit coordinates')
    if (step.action === 'zoom' && (!Number.isFinite(step.deltaY) || Math.abs(step.deltaY) > 500)) throw new Error('Invalid zoom')
    end = step.at + step.duration
  }
  if (s.steps.filter(x => x.action === 'play').length !== 1 || s.steps.filter(x => x.action === 'compare').length !== 1 || s.steps.filter(x => x.action === 'opacity').length !== 1 ||
      s.steps.at(-3)?.action !== 'orbit' || !s.steps.at(-3)?.finished || s.steps.at(-2)?.action !== 'compare' || s.steps.at(-1)?.action !== 'opacity' ||
      end > s.durationSeconds - 5) throw new Error('V02 must finish, Compare, fade stock, and hold for at least five seconds')
  return s
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
export async function runV02({ record = false, inspectProject = false, prepareOnly = false } = {}) {
  if (record && inspectProject) throw new Error('Project inspection is readback only, not a recording')
  mkdirSync(EVIDENCE, { recursive: true }); mkdirSync(OUTPUT, { recursive: true })
  rmSync(path.join(EVIDENCE, 'failed.png'), { force: true })
  rmSync(path.join(EVIDENCE, 'alpha3-failed.png'), { force: true })
  if (record) {
    // Clear success receipts before even CPU/preparation checks: a failed rerun
    // must not leave an earlier successful proof appearing to be current.
    for (const name of ['V02.mp4', 'V02-strip-1fps.jpg']) rmSync(path.join(OUTPUT, name), { force: true })
    for (const name of ['capture.json', 'telemetry.json', 'motion.json', 'prepared.png', 'finished.png']) rmSync(path.join(EVIDENCE, name), { force: true })
  }
  const s = validateSequence(JSON.parse(readFileSync(new URL('./v02.json', import.meta.url))))
  const cpu = inspectProject ? null : await waitForCaptureCpu()
  // The operator proved this backend smooth at the desk (WO-2929). Keep the actual
  // canvas renderer in the receipt; a launch flag alone proves no backend.
  const browser = await chromium.launch({ headless: false, args: ['--use-gl=angle', '--use-angle=gl', '--ignore-gpu-blocklist', '--force-device-scale-factor=1', '--window-position=0,0'] })
  try {
    await withFrozenV02Server(async ({ baseUrl, source }) => {
      const context = await browser.newContext({ viewport: s.viewport, deviceScaleFactor: 1 })
      const page = await context.newPage(), errors = [], pending = new Set()
      await page.clock.install()
      // Keep the real app viewport at the delivery dimensions; capture the compositor.
      const windowControl = await context.newCDPSession(page)
      const { windowId } = await windowControl.send('Browser.getWindowForTarget')
      await windowControl.send('Browser.setWindowBounds', { windowId, bounds: { left: 0, top: 0, width: 1936, height: 1175, windowState: 'normal' } })
      await page.bringToFront()
      await page.waitForTimeout(500)
      const captureRegion = await page.evaluate(() => ({
        x: Math.round(screenX + (outerWidth - innerWidth) / 2),
        y: Math.round(screenY + outerHeight - innerHeight - (outerWidth - innerWidth) / 2),
        width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
        outerWidth, outerHeight, screenX, screenY,
      }))
      await windowControl.detach()
      if (captureRegion.width !== 1920 || captureRegion.height !== 1080 || captureRegion.dpr !== 1) throw new Error('Desktop region must be native 1920x1080: ' + JSON.stringify(captureRegion))
      page.on('request', r => pending.add(r.url()))
      page.on('requestfinished', r => pending.delete(r.url()))
      page.on('requestfailed', r => pending.delete(r.url()))
      page.setDefaultTimeout(30000); page.on('pageerror', e => { errors.push(e.message); console.error('PAGE ERROR:', e.stack) })
      page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log('BROWSER', m.type(), m.text()) })
      page.on('response', r => { if (r.status() >= 400) console.error('HTTP', r.status(), r.url()) })
      page.on('requestfailed', r => console.error('REQUEST FAILED:', r.url(), r.failure()?.errorText))
      try {
        const prep = await prepareV02(page, baseUrl, s)
        // Opening the shipped recipe selects fixed Stock 1. Its shared selection
        // owner enables the STOCK move sphere, distinct from the WCS move sphere.
        // Toggle the real active tree button off before any recorded frame.
        const exitGizmo = page.getByRole('button', { name: 'Exit gizmo', exact: true })
        if (await exitGizmo.isVisible()) await exitGizmo.click()
        await page.waitForFunction(() => !window.__cncViewport.scene.getObjectByName('__wcs_gizmo__') && !window.__cncViewport.scene.getObjectByName('__stock_gizmo__'))
        prep.gizmosOff = true
        if (inspectProject) {
          const projectReadback = await page.evaluate(() => {
            const p = window.__camStore.getState().project
            return { geometry: p.geometry.map(g => ({ name: g.name, type: g.type })), stocks: p.sceneStock.fixedStocks, setups: p.setups.map(setup => ({ wcs: setup.wcs, operations: setup.operations.map(op => {
              const moves = op.toolpathMoves ?? [], cutting = moves.filter(m => m.type !== 'rapid')
              return { name: op.name, status: op.status, type: op.type, tool: window.__camStore.getState().toolLibrary.find(t => t.id === op.toolId), params: op.params, heights: op.heights, generatedMoves: moves.length, minimumCutZ: Math.min(...cutting.map(m => m.z)), selectedLoops: op.params?.loopIds?.length ?? 0 }
            }) })) }
          })
          json(path.join(EVIDENCE, 'project-diagnostic.json'), { source, prep, projectReadback })
          console.log('Application fixture diagnostic:', JSON.stringify(projectReadback))
          return
        }
        // Compile the translucent stock material before the take. The first
        // opaque -> blended transition otherwise stalls the GPU at fade start.
        // Exercise only real UI controls, then restore the original stock view.
        await page.getByTestId('sim-display-compare').click()
        const opacity = page.getByTestId('sim-stock-opacity')
        await opacity.focus(); await opacity.press('Home')
        await page.waitForTimeout(600)
        await opacity.press('End')
        await page.getByTestId('sim-display-stock').click()
        prep.opacityPrewarmed = true
        if (prep.durationMs / prep.speed > 250_000) throw new Error('Rehearse new timing for this program duration')
        const canvas = await page.locator('.viewport-canvas').boundingBox()
        await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2)
        await zoom(page, -1300, 2200)
        await page.waitForTimeout(800)
        prep.initialCamera = await page.evaluate(() => window.__cncViewport.saveCameraState())
        console.log('Preparation:', JSON.stringify(prep))
        await installPointer(page)
        // Owner requested no pointer in any delivered frame. Retain the two
        // telemetry elements and real input listeners, but paint neither.
        await page.addStyleTag({ content: '* { cursor: none !important; } #wo2551-pointer, #wo2551-click { visibility: hidden !important; }' })
        await page.mouse.move(1380, 900)
        await page.evaluate(() => { document.title = 'WO-2572 capture' })
        prep.desktopWindow = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-File', path.join(ROOT, 'tools/capture/clips-v2/v02-window.ps1'), '-Title', 'WO-2572 capture'], { encoding: 'utf8' }))
        await page.waitForTimeout(600)
        await page.screenshot({ path: path.join(EVIDENCE, 'prepared.png') })
        // Calibration compares real screencast pixels against the prepared app.
        const calibrationRaw = path.join(EVIDENCE, 'calibration-cdp')
        const calibrationCapture = await startCompositorCapture(context, page, calibrationRaw)
        await page.waitForTimeout(700)
        await calibrationCapture.stop()
        if (!calibrationCapture.frames.length) throw new Error('Compositor calibration returned no frame')
        const calibrationImage = path.join(calibrationRaw, calibrationCapture.frames.at(-1).name)
        const calibration = JSON.parse(execFileSync('python', ['-c', `
import json,sys
import numpy as np
from PIL import Image
a=np.asarray(Image.open(sys.argv[1]).convert('RGB'),dtype=np.int16)
b=np.asarray(Image.open(sys.argv[2]).convert('RGB'),dtype=np.int16)
print(json.dumps(dict(mad=float(np.abs(a-b).mean()) if a.shape == b.shape else 999,width=a.shape[1],height=a.shape[0])))
`, calibrationImage, path.join(EVIDENCE, 'prepared.png')], { encoding: 'utf8' }))
        captureRegion.calibration = calibration
        json(path.join(EVIDENCE, 'cdp-calibration.json'), { source, calibration, frames: calibrationCapture.frames, gpuCompositing: true })
        if (calibration.mad > 2 || calibration.width !== 1920 || calibration.height !== 1080) throw new Error('Compositor does not show this app: ' + JSON.stringify(calibration))
        if (prepareOnly) return
        if (!record) {
          const actions = await perform(page, s)
          await page.screenshot({ path: path.join(EVIDENCE, 'rehearsed.png') })
          json(path.join(EVIDENCE, 'rehearsal.json'), { prep, cpu, actions, errors })
          console.log('Rehearsal:', JSON.stringify(actions))
          return
        }
        const captureCpu = await waitForCaptureCpu()
        const raw = path.join(EVIDENCE, 'raw')
        await page.clock.pauseAt(await page.evaluate(() => Date.now() + 100))
        await page.evaluate(durationSeconds => {
          window.__wo2572Samples = []
          window.__v02Pointer = { x: 1380, y: 900, down: false }
          document.addEventListener('pointermove', e => Object.assign(window.__v02Pointer, { x: e.clientX, y: e.clientY }), true)
          document.addEventListener('pointerdown', () => { window.__v02Pointer.down = true }, true)
          document.addEventListener('pointerup', () => { window.__v02Pointer.down = false }, true)
          const start = performance.now()
          const sample = () => {
            const vp = window.__cncViewport, slider = document.querySelector('[data-testid="sim-stock-opacity"]')
            const rect = slider?.getBoundingClientRect(), pointer = { ...window.__v02Pointer }
            const camera = vp.getCamera(), box = document.querySelector('.viewport-canvas canvas').getBoundingClientRect()
            const projected = vp.toolMarkerGroup.position.clone().project(camera)
            const toolScreen = [box.x+(projected.x+1)*box.width/2, box.y+(1-projected.y)*box.height/2]
            window.__wo2572Samples.push({ toolScreen, pointerHidden: getComputedStyle(document.getElementById('wo2551-pointer')).visibility === 'hidden', t: (performance.now() - start) / 1000, wallTime: Date.now() / 1000, zoom: vp.getCamera().zoom, tool: vp.toolGeoConfig ? { type: vp.toolGeoConfig.type, diameter: vp.toolGeoConfig.diameter } : null, toolVisible: !!vp.toolMarkerGroup?.visible, toolPosition: vp.toolMarkerGroup?.position.toArray() ?? null, sim: +document.querySelector('.sim-scrubber').value, camera: vp.getCamera().position.toArray(), stockSync: document.querySelector('.sim-panel').getAttribute('data-stock-sync'), stockMs: +document.querySelector('.sim-panel').getAttribute('data-stock-ms'), playing: !!document.querySelector('button[aria-label="Pause"]'), comparePressed: document.querySelector('[data-testid="sim-display-compare"]').getAttribute('aria-pressed') === 'true', opacity: window.__camStore.getState().viewer.stockSimOpacity, sliderOpacity: slider ? +slider.value : null, materialOpacity: vp.stockSimSurfaceMesh?.material.opacity ?? vp.voxelSimMaterial?.uniforms.uAlpha.value ?? null, wcsGizmo: !!vp.scene.getObjectByName('__wcs_gizmo__'), stockGizmo: !!vp.scene.getObjectByName('__stock_gizmo__'), overlayText: [...document.querySelectorAll('#wo2551-pointer, #wo2551-click')].map(e => e.textContent).join(''), presentationOverlays: document.querySelectorAll('#wo2551-pointer, #wo2551-click').length, originMarkerVisible: vp.wcsGroup.visible && vp.wcsGroup.children.length > 0, pointer, pointerOnSlider: !!rect && pointer.x >= rect.left && pointer.x <= rect.right && pointer.y >= rect.top && pointer.y <= rect.bottom })
            if (performance.now() - start < (durationSeconds + 1) * 1000) requestAnimationFrame(sample)
          }
          requestAnimationFrame(sample)
        }, s.durationSeconds)
        const { frames, actions } = await deterministicTake(page, s, raw)
        ffmpeg(['-y', '-framerate', '30', '-i', path.join(raw, 'frame-%06d.jpg'), '-c:v', 'libx264', '-threads', '2', '-preset', 'fast', '-crf', '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(OUTPUT, 'V02.mp4')])
        const telemetry = await page.evaluate(() => window.__wo2572Samples)
        await page.screenshot({ path: path.join(EVIDENCE, 'finished.png') })
        const final = telemetry.at(-1)
        if (Math.abs(final.sim - prep.durationMs) > 1 || final.stockSync !== 'exact' || Math.abs(final.stockMs - prep.durationMs) > 1 || final.playing) throw new Error('Final stock readback is incomplete')
        json(path.join(EVIDENCE, 'telemetry.json'), telemetry)
        if (errors.length) throw new Error('Application page errors: ' + errors.join('; '))
        if (frames.length < 300) throw new Error('Capture too sparse: ' + frames.length)
        ffmpeg(['-y', '-i', path.join(OUTPUT, 'V02.mp4'), '-vf', `fps=1,scale=480:270,tile=8x${Math.ceil(s.durationSeconds / 8)}`, '-frames:v', '1', path.join(OUTPUT, 'V02-strip-1fps.jpg')])
        json(path.join(EVIDENCE, 'capture.json'), { source, recorder: { method: 'CDP deterministic frame screenshots', clock: 'Playwright clock 33/34 ms steps, >= two rAF ticks, one screenshot per frame', gpuCompositing: true, quality: 95, timestampEncoding: 'explicit frame index / 30; CFR 30 fps', captureRegion, headless: false, browserScreencast: false }, recorderSha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'), sequenceSha256: createHash('sha256').update(readFileSync(new URL('./v02.json', import.meta.url))).digest('hex'), capturedAt: new Date().toISOString(), projectSha256: createHash('sha256').update(readFileSync(path.join(ROOT, 'tools/capture/clips-v2/.alpha3-source', s.project))).digest('hex'), prep, cpu, captureCpu, frames, actions, errors, bytes: statSync(path.join(OUTPUT, 'V02.mp4')).size, sha256: createHash('sha256').update(readFileSync(path.join(OUTPUT, 'V02.mp4'))).digest('hex') })
        console.log('Captured frames:', frames.length)
      } catch (e) {
        console.error('PENDING:', [...pending]); console.error('PAGE DIAGNOSTIC:', await page.evaluate(() => ({ html: document.body.innerHTML.slice(0, 3000), store: !!window.__camStore, location: location.href })).catch(() => null))
        await page.screenshot({ path: path.join(EVIDENCE, 'alpha3-failed.png') }).catch(() => {})
        throw e
      } finally { await context.close() }
    })
  } finally { await browser.close() }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runV02({ record: process.argv.includes('--record'), inspectProject: process.argv.includes('--inspect-project'), prepareOnly: process.argv.includes('--prepare-only') }).catch(e => { console.error(e); process.exitCode = 1 })
}
