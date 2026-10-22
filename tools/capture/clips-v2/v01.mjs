import { isMain } from '../../lib/is-main.mjs';
import { chromium } from 'playwright'
import { mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs'
import { writeFile as writeFileAsync } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { withViteCaptureServer, captureSourceProvenance } from '../lib/provenance.mjs'
import { execFileSync } from 'node:child_process'
import { verifyBuild, withBuildServer } from '../lib/scene-runner.mjs'
import { readAppState } from '../../examples/lib/drive.mjs'
import { realGpuVerdict } from '../lib/real-gpu.mjs'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const EVIDENCE = path.join(ROOT, 'src/tests/evidence/WO-2571')
const OUTPUT = path.join(ROOT, 'docs/media/clips-v2')
const json = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
const delay = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))
import { prepare, cpuCheck, ffmpeg, travel, installPointer } from './proof.mjs'
// Same preparation controls as proof.mjs, with production readbacks instead of
// the development-only store hook. The recorded perform() sequence is shared.
async function prepareProduction(page, url, sequence) {
  const wait = async check => {
    const deadline = Date.now() + 120000
    while (Date.now() < deadline) { if (await check()) return; await page.waitForTimeout(150) }
    throw new Error('Production V01 preparation timed out')
  }
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.locator('#liencam-splash').waitFor({ state: 'hidden' })
  const empty = page.getByRole('button', { name: 'Start with an empty project' })
  if (await empty.isVisible()) await empty.click()
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Open project', exact: true }).click()
  const picker = page.getByRole('dialog', { name: 'Open a project' })
  if (await picker.isVisible()) await picker.getByRole('button', { name: 'Browse...' }).click()
  await (await chooser).setFiles(path.join(ROOT, sequence.project))
  await wait(async () => (await readAppState(page))?.project.geometry.length > 0)
  const machine = page.getByRole('button', { name: 'Use this machine', exact: true })
  if (await machine.isVisible()) {
    await page.locator('.machine-choice-item').filter({ hasText: 'Sample hobby router' }).click()
    await machine.click()
  }
  await page.getByTestId('mode-tab-toolpath').click()
  await page.getByRole('button', { name: 'REGEN ALL', exact: true }).click()
  await wait(async () => {
    const ops = (await readAppState(page))?.project.setups.flatMap(s => s.operations) || []
    if (ops.some(o => o.status === 'error')) throw new Error('Application regeneration error')
    return ops.length > 0 && ops.every(o => o.status === 'ready') &&
      await page.locator('.status-bar .status-item').first().innerText() === 'Ready' && !await page.locator('.status-batch').count()
  })
  await page.locator('.tree-setup-header').first().click()
  await page.getByTestId('mode-tab-simulation').click()
  await page.getByLabel('Simulate Stock Removal', { exact: true }).check()
  await page.getByTestId('sim-hide-toolpath').check()
  await page.getByTestId('sim-display-stock').click()
  const slider = page.getByRole('slider', { name: 'Simulation position' })
  await wait(async () => +await slider.getAttribute('max') > 0)
  const durationMs = +await slider.getAttribute('max')
  const speed = [0.1, 0.5, 1, 5, 10, 50, 100].filter(x => durationMs / x > 28000).at(-1) || 0.1
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
  const p = (await readAppState(page)).project
  return { renderer, gpu, durationMs, speed, project: { id: p.id, activeSetupId: p.activeSetupId, activeOperationId: p.activeOperationId,
    operations: p.setups.flatMap(s => s.operations.map(o => ({ name: o.name, status: o.status, moves: o.moves?.length }))) } }
}
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
export function validateSequence(s) {
  if (s.version !== 1 || s.viewport?.width !== 1920 || s.viewport?.height !== 1080 ||
      s.durationSeconds < 45 || s.durationSeconds > 90 || !Number.isFinite(s.durationSeconds) ||
      s.project !== 'examples/02-toe-clamps/toe-clamps.camproject') throw new Error('Invalid V01 sequence')
  let end = 0
  for (const step of s.steps) {
    if (!['play', 'orbit', 'zoom', 'compare', 'opacity'].includes(step.action) || !Number.isFinite(step.at) || step.at < end ||
        !Number.isFinite(step.duration) || step.duration < .8 || step.at + step.duration > s.durationSeconds) throw new Error('Invalid V01 action timing')
    if (step.action === 'orbit' && [step.from, step.to].some(p => !Array.isArray(p) || p.length !== 2 || p.some(n => !Number.isFinite(n) || n < .1 || n > .9))) throw new Error('Invalid orbit coordinates')
    if (step.action === 'zoom' && (!Number.isFinite(step.deltaY) || Math.abs(step.deltaY) > 500)) throw new Error('Invalid zoom')
    end = step.at + step.duration
  }
  if (s.steps.filter(x => x.action === 'play').length !== 1 || s.steps.filter(x => x.action === 'compare').length !== 1 || s.steps.filter(x => x.action === 'opacity').length !== 1 ||
      s.steps.at(-3)?.action !== 'orbit' || !s.steps.at(-3)?.finished || s.steps.at(-2)?.action !== 'compare' || s.steps.at(-1)?.action !== 'opacity' ||
      end > s.durationSeconds - 5) throw new Error('V01 must finish, Compare, fade stock, and hold for at least five seconds')
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
    const readback = await page.evaluate(() => ({ positionMs: +document.querySelector('.sim-scrubber').value, camera: window.__cncViewport.saveCameraState(), playing: !!document.querySelector('button[aria-label="Pause"]'), stockSync: document.querySelector('.sim-panel').dataset.stockSync, stockMs: +document.querySelector('.sim-panel').dataset.stockMs, comparePressed: document.querySelector('[data-testid="sim-display-compare"]').getAttribute('aria-pressed') === 'true', opacity: Number(document.querySelector('[data-testid="sim-stock-opacity"]')?.value ?? window.__cncViewport.stockSimSurfaceMesh?.material.opacity ?? window.__cncViewport.voxelSimMaterial?.uniforms.uAlpha.value ?? 1) }))
    actions.push({ ...step, motion, began, ended: (performance.now() - start) / 1000, readback })
  }
  await delay(start + sequence.durationSeconds * 1000 - performance.now())
  return actions
}
export async function runV01({ record = false, inspectProject = false, inspectEnding = false, rehearsal = null, build, evidence, frozenCommit } = {}) {
  const EVIDENCE = evidence ? path.resolve(ROOT, evidence) : rehearsal?.evidence || path.join(ROOT, 'src/tests/evidence/WO-2571')
  const OUTPUT = rehearsal?.output || path.join(ROOT, 'docs/media/clips-v2')
  const stripFile = path.join(evidence ? EVIDENCE : OUTPUT, 'V01-strip-1fps.jpg')
  if (evidence && !EVIDENCE.startsWith(path.join(ROOT, 'src/tests/evidence/WO-2631') + path.sep)) throw new Error('Frozen evidence must stay under WO-2631')
  if (record && inspectProject) throw new Error('Project inspection is readback only, not a recording')
  if (record && inspectEnding) throw new Error('Ending inspection is diagnostic only, not a recording')
  mkdirSync(EVIDENCE, { recursive: true }); mkdirSync(OUTPUT, { recursive: true })
  rmSync(path.join(EVIDENCE, 'failed.png'), { force: true })
  if (record) {
    // Clear success receipts before even CPU/preparation checks: a failed rerun
    // must not leave an earlier successful proof appearing to be current.
    rmSync(path.join(OUTPUT, 'V01.mp4'), { force: true }); rmSync(stripFile, { force: true })
    for (const name of ['capture.json', 'telemetry.json', 'motion.json', 'prepared.png', 'finished.png']) rmSync(path.join(EVIDENCE, name), { force: true })
  }
  const s = validateSequence(JSON.parse(readFileSync(new URL('./v01.json', import.meta.url))))
  const source = captureSourceProvenance({ repoRoot: ROOT })
  if (source.workingTreeDirty) throw new Error('Application source must be committed before capture')
  if (build) Object.assign(source, { build: verifyBuild(path.resolve(build), ROOT) })
  if (frozenCommit) {
    if (!build) throw new Error('Frozen capture requires a stamped production build')
    source.frozenCommit = execFileSync('git', ['rev-parse', frozenCommit], { cwd: ROOT, encoding: 'utf8' }).trim()
    const changed = execFileSync('git', ['diff', '--name-only', source.frozenCommit, 'HEAD', '--', 'src', ':!src/tests', 'public', 'examples', 'index.html', 'package.json', 'package-lock.json', 'vite.config.mts'], { cwd: ROOT, encoding: 'utf8' }).trim()
    if (changed) throw new Error(`Application differs from frozen build: ${changed}`)
  }
  const cpu = inspectProject ? null : await waitForCaptureCpu()
  const browser = await chromium.launch({ headless: true, args: rehearsal?.angle ? ['--use-gl=angle', '--use-angle=' + rehearsal.angle, '--ignore-gpu-blocklist', ...(rehearsal.software ? ['--enable-unsafe-swiftshader'] : [])] : ['--use-gl=angle', '--use-angle=d3d11', '--ignore-gpu-blocklist'] })
  try {
    const serve = build ? run => withBuildServer(path.resolve(build), baseUrl => run({ baseUrl })) : run => withViteCaptureServer({ port: 2552, repoRoot: ROOT }, run)
    await serve(async ({ baseUrl }) => {
      const context = await browser.newContext({ viewport: s.viewport, deviceScaleFactor: 1, ...(rehearsal ? { recordVideo: { dir: OUTPUT, size: s.viewport } } : {}) })
      const page = await context.newPage(), errors = []
      page.setDefaultTimeout(30000); page.on('pageerror', e => errors.push(e.message))
      if (rehearsal?.onPage) await rehearsal.onPage(page)
      try {
        const prep = build ? await prepareProduction(page, baseUrl, s) : await prepare(page, baseUrl, s, { allowSoftwareRehearsal: !record && rehearsal?.software === true })
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
              return { name: op.name, status: op.status, params: op.params, heights: op.heights, generatedMoves: moves.length, minimumCutZ: Math.min(...cutting.map(m => m.z)), cuttingZValues: [...new Set(cutting.map(m => m.z))].sort((a, b) => a - b) }
            }) })) }
          })
          json(path.join(EVIDENCE, 'tab-diagnostic.json'), { source, prep, projectReadback })
          console.log('Application tab diagnostic:', JSON.stringify(projectReadback))
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
        if (prep.speed !== 10 || prep.durationMs / prep.speed > 49_000) throw new Error('Rehearse new timing for this program duration')
        const canvas = await page.locator('.viewport-canvas').boundingBox()
        await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2)
        await zoom(page, -550, 1600)
        await page.waitForTimeout(800)
        prep.initialCamera = await page.evaluate(() => window.__cncViewport.saveCameraState())
        console.log('Preparation:', JSON.stringify(prep))
        await installPointer(page)
        await page.mouse.move(1380, 900)
        await page.screenshot({ path: path.join(EVIDENCE, 'prepared.png') })
        if (!record) {
          // Inspection uses the real End button only outside a recorded take.
          // Its screenshots are camera/opacity diagnostics, never clip proof.
          if (inspectEnding) {
            await page.getByRole('button', { name: 'Skip to end', exact: true }).click()
            await page.waitForFunction(() => document.querySelector('.sim-panel').dataset.stockSync === 'exact' && +document.querySelector('.sim-scrubber').value >= +document.querySelector('.sim-scrubber').max - 1)
          }
          let inspectionAt = 0
          const inspectionSteps = s.steps.filter(step => step.action !== 'play').map(step => {
            const next = { ...step, at: inspectionAt }
            inspectionAt += step.duration + .5
            return next
          })
          const actions = await perform(page, inspectEnding ? { durationSeconds: inspectionAt + 1, steps: inspectionSteps } : s)
          await page.screenshot({ path: path.join(EVIDENCE, 'rehearsed.png') })
          json(path.join(EVIDENCE, 'rehearsal.json'), { prep, cpu, actions, errors })
          if (inspectEnding) {
            const slider = page.getByTestId('sim-stock-opacity')
            for (const value of [.15, .35, .5, .75, 1]) {
              const file = path.join(EVIDENCE, `ending-opacity-${value}.png`)
              rmSync(file, { force: true })
              await slider.focus(); await slider.press('Home')
              for (let i = 0; i < Math.round((value - .15) / .05); i++) await slider.press('ArrowRight')
              await page.waitForTimeout(500)
              await page.screenshot({ path: file })
            }
            const rect = await page.locator('.viewport-canvas').boundingBox()
            await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2)
            await zoom(page, -350, 2000)
            await slider.focus(); await slider.press('Home')
            for (let i = 0; i < 7; i++) await slider.press('ArrowRight')
            await page.waitForTimeout(500)
            rmSync(path.join(EVIDENCE, 'ending-close-0.5.png'), { force: true })
            await page.screenshot({ path: path.join(EVIDENCE, 'ending-close-0.5.png') })
          }
          console.log('Rehearsal:', JSON.stringify(actions))
          return
        }
        const captureCpu = await waitForCaptureCpu()
        const raw = path.join(EVIDENCE, 'raw'); mkdirSync(raw, { recursive: true })
        for (const name of readdirSync(raw)) if (/^frame-\d+\.jpg$/.test(name) || name === 'frames.txt') rmSync(path.join(raw, name))
        rmSync(path.join(OUTPUT, 'V01.mp4'), { force: true }); rmSync(stripFile, { force: true })
        const session = await context.newCDPSession(page), frames = [], writes = [], diskErrors = []
        session.on('Page.screencastFrame', event => {
          // Acknowledge before I/O. Synchronous JPEG writes can stall Chromium's
          // capture delivery while the app itself continues rendering normally.
          session.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {})
          const name = `frame-${String(frames.length).padStart(6, '0')}.jpg`
          writes.push(writeFileAsync(path.join(raw, name), Buffer.from(event.data, 'base64')).catch(e => diskErrors.push(e.message)))
          frames.push({ name, timestamp: event.metadata.timestamp })
        })
        await page.evaluate(durationSeconds => {
          window.__wo2552Samples = []
          window.__v01Pointer = { x: 1380, y: 900, down: false }
          document.addEventListener('pointermove', e => Object.assign(window.__v01Pointer, { x: e.clientX, y: e.clientY }), true)
          document.addEventListener('pointerdown', () => { window.__v01Pointer.down = true }, true)
          document.addEventListener('pointerup', () => { window.__v01Pointer.down = false }, true)
          const start = performance.now()
          const sample = () => {
            const vp = window.__cncViewport, slider = document.querySelector('[data-testid="sim-stock-opacity"]')
            const rect = slider?.getBoundingClientRect(), pointer = { ...window.__v01Pointer }
            window.__wo2552Samples.push({ t: (performance.now() - start) / 1000, wallTime: Date.now() / 1000, zoom: vp.getCamera().zoom, sim: +document.querySelector('.sim-scrubber').value, camera: vp.getCamera().position.toArray(), stockSync: document.querySelector('.sim-panel').getAttribute('data-stock-sync'), stockMs: +document.querySelector('.sim-panel').getAttribute('data-stock-ms'), playing: !!document.querySelector('button[aria-label="Pause"]'), comparePressed: document.querySelector('[data-testid="sim-display-compare"]').getAttribute('aria-pressed') === 'true', opacity: Number(slider?.value ?? vp.stockSimSurfaceMesh?.material.opacity ?? vp.voxelSimMaterial?.uniforms.uAlpha.value ?? 1), sliderOpacity: slider ? +slider.value : null, materialOpacity: vp.stockSimSurfaceMesh?.material.opacity ?? vp.voxelSimMaterial?.uniforms.uAlpha.value ?? null, wcsGizmo: !!vp.scene.getObjectByName('__wcs_gizmo__'), stockGizmo: !!vp.scene.getObjectByName('__stock_gizmo__'), originMarkerVisible: vp.wcsGroup.visible && vp.wcsGroup.children.length > 0, pointer, pointerOnSlider: !!rect && pointer.x >= rect.left && pointer.x <= rect.right && pointer.y >= rect.top && pointer.y <= rect.bottom })
            if (performance.now() - start < (durationSeconds + 1) * 1000) requestAnimationFrame(sample)
          }
          requestAnimationFrame(sample)
        }, s.durationSeconds)
        await session.send('Page.startScreencast', { format: 'jpeg', quality: 95, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 })
        const actions = await perform(page, s)
        await session.send('Page.stopScreencast')
        await Promise.all(writes)
        if (diskErrors.length) throw new Error('Capture disk writes failed: ' + diskErrors.join('; '))
        const telemetry = await page.evaluate(() => window.__wo2552Samples)
        await page.screenshot({ path: path.join(EVIDENCE, 'finished.png') })
        const final = telemetry.at(-1)
        if (Math.abs(final.sim - prep.durationMs) > 1 || final.stockSync !== 'exact' || Math.abs(final.stockMs - prep.durationMs) > 1 || final.playing) throw new Error('Final stock readback is incomplete')
        json(path.join(EVIDENCE, 'telemetry.json'), telemetry)
        if (errors.length) throw new Error('Application page errors: ' + errors.join('; '))
        if (frames.length < 300) throw new Error('Capture too sparse: ' + frames.length)
        const first = frames[0].timestamp
        // image2's default 25-Hz timebase would quantize a 60-Hz capture back
        // to 40 ms. Give each image a millisecond timebase before fps conversion.
        const concat = frames.map((f, i) => `file '${f.name}'\noption framerate 1000\nduration ${Math.max(0.001, (frames[i + 1]?.timestamp ?? first + s.durationSeconds) - f.timestamp).toFixed(6)}\n`).join('') + `file '${frames.at(-1).name}'\noption framerate 1000\n`
        writeFileSync(path.join(raw, 'frames.txt'), concat)
        ffmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', path.join(raw, 'frames.txt'), '-t', String(s.durationSeconds), '-vf', 'fps=30', '-c:v', 'libx264', '-threads', '2', '-preset', 'fast', '-crf', '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-metadata', `comment=${JSON.stringify(source)}`, path.join(OUTPUT, 'V01.mp4')])
        ffmpeg(['-y', '-i', path.join(OUTPUT, 'V01.mp4'), '-vf', `fps=1,scale=480:270,tile=8x${Math.ceil(s.durationSeconds / 8)}`, '-frames:v', '1', stripFile])
        json(path.join(EVIDENCE, 'capture.json'), { source, capturedAt: new Date().toISOString(), projectSha256: createHash('sha256').update(readFileSync(path.join(ROOT, s.project))).digest('hex'), prep, cpu, captureCpu, frames, actions, errors, bytes: statSync(path.join(OUTPUT, 'V01.mp4')).size, sha256: createHash('sha256').update(readFileSync(path.join(OUTPUT, 'V01.mp4'))).digest('hex') })
        // The analyzer cleans raw originals after measurements; --keep-raw preserves them.
        console.log('Captured frames:', frames.length)
      } catch (e) {
        if (!inspectProject) await page.screenshot({ path: path.join(EVIDENCE, 'failed.png') }).catch(() => {})
        throw e
      } finally { await context.close() }
    })
  } finally { await browser.close() }
}
if (isMain(import.meta.url)) {
  const option = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined
  runV01({ record: process.argv.includes('--record'), inspectProject: process.argv.includes('--inspect-project'), inspectEnding: process.argv.includes('--inspect-ending'),
    build: option('--build'), evidence: option('--evidence'), frozenCommit: option('--frozen-commit') }).catch(e => { console.error(e); process.exitCode = 1 })
}
