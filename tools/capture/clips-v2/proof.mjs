import { isMain } from '../../lib/is-main.mjs';
import { chromium } from 'playwright'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs'
import { writeFile as writeFileAsync } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { withViteCaptureServer, captureSourceProvenance } from '../lib/provenance.mjs'
import { realGpuVerdict } from '../lib/real-gpu.mjs'
import { ffmpegPath } from '../lib/clip-runner.mjs'
import os from 'node:os'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const EVIDENCE = path.join(ROOT, 'src/tests/evidence/WO-2551')
const OUTPUT = path.join(ROOT, 'docs/media/clips-v2')
const json = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
const delay = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))
export function validateSequence(s) {
  if (s.version !== 1 || s.viewport?.width !== 1920 || s.viewport?.height !== 1080 ||
      !Number.isFinite(s.durationSeconds) || s.durationSeconds < 20 || s.durationSeconds > 30 ||
      !/^examples\/[\w/-]+\.camproject$/.test(s.project) || !Array.isArray(s.steps)) throw new Error('Invalid proof sequence')
  let end = 0
  for (const step of s.steps) {
    if (!['play', 'pause', 'orbit'].includes(step.action) || !Number.isFinite(step.at) || step.at < end ||
        !Number.isFinite(step.duration) || step.duration <= 0 || step.at + step.duration > s.durationSeconds) throw new Error('Invalid action timing')
    if (step.action === 'orbit' && [step.from, step.to].some(p => !Array.isArray(p) || p.length !== 2 || p.some(n => !Number.isFinite(n) || n < 0.1 || n > 0.9))) throw new Error('Invalid orbit coordinates')
    end = step.at + step.duration
  }
  if (s.steps[0]?.action !== 'play' || s.steps.at(-1)?.action !== 'pause' || !s.steps.some(x => x.action === 'orbit')) throw new Error('Proof must play, orbit, then pause')
  return s
}
export function ffmpeg(args) {
  const r = spawnSync(ffmpegPath(), ['-hide_banner', '-filter_threads', '2', '-filter_complex_threads', '2', '-threads', '2', ...args], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(r.error?.message || r.stderr)
  return r.stderr
}
export async function cpuCheck() {
  if (process.platform !== 'win32') {
    const snapshot = () => os.cpus().reduce((a, c) => ({ idle: a.idle + c.times.idle, total: a.total + Object.values(c.times).reduce((x, y) => x + y, 0) }), { idle: 0, total: 0 })
    const values = []
    for (let i = 0; i < 3; i++) {
      const before = snapshot(); await delay(1000); const after = snapshot()
      values.push(100 * (1 - (after.idle - before.idle) / (after.total - before.total)))
    }
    const average = values.reduce((a, b) => a + b) / 3
    if (average >= 60) throw new Error('Shared PC CPU >= 60%; capture deferred')
    return { values, average }
  }
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', "Get-Counter '\\Processor(_Total)\\% Processor Time' -SampleInterval 1 -MaxSamples 3 | ForEach-Object {$_.CounterSamples.CookedValue}"], { encoding: 'utf8' })
  const values = r.stdout.trim().split(/\s+/).map(Number)
  if (r.status !== 0 || values.length !== 3 || values.some(x => !Number.isFinite(x))) throw new Error('CPU samples unavailable')
  const average = values.reduce((a, b) => a + b, 0) / 3
  console.log('CPU samples:', values, 'average:', average)
  if (average >= 60) throw new Error('Shared PC CPU >= 60%; capture deferred')
  return { values, average }
}
export async function wait(page, label, predicate) {
  const end = Date.now() + 120000
  while (Date.now() < end) {
    if (await predicate()) return
    await page.waitForTimeout(150)
  }
  throw new Error('Preparation timed out: ' + label)
}
export async function prepare(page, url, sequence, { allowSoftwareRehearsal = false } = {}) {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  // Release-demo builds have an example picker; normal dev builds do not.
  const empty = page.getByRole('button', { name: 'Start with an empty project' })
  if (await empty.isVisible()) await empty.click()
  await page.locator('#liencam-splash').waitFor({ state: 'hidden' })
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Open project', exact: true }).click()
  await (await chooser).setFiles(path.join(ROOT, sequence.project))
  await wait(page, 'project opened', () => page.evaluate(() => window.__camStore?.getState().project.geometry.length > 0))
  const machine = page.getByRole('button', { name: 'Use this machine', exact: true })
  if (await machine.isVisible()) {
    await page.locator('.machine-choice-item').filter({ hasText: 'Sample hobby router' }).click()
    await machine.click()
  }
  await page.getByTestId('mode-tab-toolpath').click()
  await page.getByRole('button', { name: 'REGEN ALL', exact: true }).click()
  await wait(page, 'all toolpaths ready', () => page.evaluate(() => {
    const ops = window.__camStore.getState().project.setups.flatMap(s => s.operations)
    if (ops.some(o => o.status === 'error')) throw new Error('Application regeneration error')
    return ops.length > 0 && ops.every(o => o.status === 'ready')
  }))
  await page.locator('.tree-setup-header').first().click()
  await page.getByTestId('mode-tab-simulation').click()
  await page.getByLabel('Simulate Stock Removal', { exact: true }).check()
  await page.getByTestId('sim-hide-toolpath').check()
  await page.getByTestId('sim-display-stock').click()
  const slider = page.getByRole('slider', { name: 'Simulation position' })
  await wait(page, 'simulation duration', async () => +await slider.getAttribute('max') > 0)
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
  // WO-2653 explicitly permits software rendering for rehearsals on Spark.
  // Default proof/final-take hardware requirements remain in force.
  if (!gpu.ok && !allowSoftwareRehearsal) throw new Error('Application GPU rejected: ' + renderer)
  return { renderer, gpu, durationMs, speed, project: await page.evaluate(() => {
    const p = window.__camStore.getState().project
    return { id: p.id, activeSetupId: p.activeSetupId, activeOperationId: p.activeOperationId, operations: p.setups.flatMap(s => s.operations.map(o => ({ name: o.name, status: o.status, moves: o.moves?.length }))) }
  }) }
}
// This lives solely in the recorder. No app import or normal user path can install it.
export async function installPointer(page) {
  await page.evaluate(() => {
    const cursor = document.createElement('div'), ring = document.createElement('div')
    cursor.id = 'wo2551-pointer'; ring.id = 'wo2551-click'
    cursor.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;width:26px;height:32px;filter:drop-shadow(0 1px 2px #000);'
    cursor.innerHTML = '<svg width="26" height="32" viewBox="0 0 26 32"><path d="M2 2 L2 24 L8 19 L13 29 L18 27 L13 17 L23 17 Z" fill="white" stroke="#111" stroke-width="2"/></svg>'
    ring.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483646;pointer-events:none;width:40px;height:40px;border:3px solid #48c8e6;border-radius:50%;background:#48c8e622;opacity:0;transition:opacity .25s'
    document.body.append(cursor, ring)
    const move = e => { cursor.style.transform = `translate(${e.clientX}px,${e.clientY}px)`; ring.style.transform = `translate(${e.clientX - 23}px,${e.clientY - 23}px)` }
    document.addEventListener('pointermove', move, true)
    document.addEventListener('pointerdown', e => { move(e); ring.style.opacity = '1' }, true)
    document.addEventListener('pointerup', () => { setTimeout(() => { ring.style.opacity = '0' }, 250) }, true)
  })
}
export async function travel(page, from, to, milliseconds, ease = true) {
  const start = performance.now()
  // CDP input acknowledgement can exceed one vsync during stock carving.
  // Follow wall time, never catch up an accumulating queue of 60-Hz moves.
  while (performance.now() - start < milliseconds) {
    const t = Math.min(1, (performance.now() - start) / milliseconds), u = ease ? t * t * (3 - 2 * t) : t
    await page.mouse.move(from.x + (to.x - from.x) * u, from.y + (to.y - from.y) * u)
    await delay(Math.min(1000 / 30, start + milliseconds - performance.now()))
  }
  await page.mouse.move(to.x, to.y)
}
async function perform(page, sequence) {
  const start = performance.now(), actions = []
  let pointer = { x: 1380, y: 900 }
  await page.mouse.move(pointer.x, pointer.y)
  for (const step of sequence.steps) {
    await delay(start + step.at * 1000 - performance.now())
    const began = (performance.now() - start) / 1000
    if (step.action === 'orbit') {
      const rect = await page.locator('.viewport-canvas').boundingBox()
      const point = p => ({ x: rect.x + rect.width * p[0], y: rect.y + rect.height * p[1] })
      const from = point(step.from), to = point(step.to)
      await travel(page, pointer, from, 500)
      await page.mouse.down()
      await travel(page, from, to, step.duration * 1000 - 600)
      await page.mouse.up(); pointer = to
    } else {
      const locator = page.getByRole('button', { name: step.action === 'play' ? 'Play' : 'Pause', exact: true })
      const rect = await locator.boundingBox()
      if (!rect) throw new Error('Playback button unavailable: ' + step.action)
      const to = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
      await travel(page, pointer, to, step.duration * 1000 - 180)
      await page.mouse.down(); await delay(120); await page.mouse.up(); pointer = to
    }
    const readback = await page.evaluate(() => ({ positionMs: +document.querySelector('.sim-scrubber').value, camera: window.__cncViewport.saveCameraState(), playing: !!document.querySelector('button[aria-label="Pause"]') }))
    actions.push({ ...step, began, ended: (performance.now() - start) / 1000, readback })
  }
  await delay(start + sequence.durationSeconds * 1000 - performance.now())
  return actions
}
// Shared compositor capture for proof and ordered walkthroughs. Ack precedes disk I/O.
export async function startCompositorCapture(context, page, raw) {
  mkdirSync(raw, { recursive: true })
  for (const name of readdirSync(raw)) if (/^frame-\d+\.jpg$/.test(name) || name === 'frames.txt') rmSync(path.join(raw, name))
  const session = await context.newCDPSession(page), frames = [], writes = [], diskErrors = []
  session.on('Page.screencastFrame', event => {
    // Acknowledge before I/O. Synchronous JPEG writes can stall Chromium's
    // capture delivery while the app itself continues rendering normally.
    session.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {})
    const name = `frame-${String(frames.length).padStart(6, '0')}.jpg`
    writes.push(writeFileAsync(path.join(raw, name), Buffer.from(event.data, 'base64')).catch(e => diskErrors.push(e.message)))
    frames.push({ name, timestamp: event.metadata.timestamp })
  })
  await session.send('Page.startScreencast', { format: 'jpeg', quality: 95, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 })
  return { frames, async stop() {
    await session.send('Page.stopScreencast')
    await Promise.all(writes)
    await session.detach()
    if (diskErrors.length) throw new Error('Capture disk writes failed: ' + diskErrors.join('; '))
  } }
}
export function encodeCompositorCapture(raw, frames, durationSeconds, output) {
  if (!frames.length) throw new Error('Compositor returned no frames')
  const first = frames[0].timestamp
  const concat = frames.map((f, i) => `file '${f.name}'\noption framerate 1000\nduration ${Math.max(0.001, (frames[i + 1]?.timestamp ?? first + durationSeconds) - f.timestamp).toFixed(6)}\n`).join('') + `file '${frames.at(-1).name}'\noption framerate 1000\n`
  writeFileSync(path.join(raw, 'frames.txt'), concat)
  ffmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', path.join(raw, 'frames.txt'), '-t', String(durationSeconds), '-vf', 'fps=30', '-c:v', 'libx264', '-threads', '2', '-preset', 'fast', '-crf', '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output])
}
export async function runProof({ record = false } = {}) {
  mkdirSync(EVIDENCE, { recursive: true }); mkdirSync(OUTPUT, { recursive: true })
  rmSync(path.join(EVIDENCE, 'failed.png'), { force: true })
  if (record) {
    // Clear success receipts before even CPU/preparation checks: a failed rerun
    // must not leave an earlier successful proof appearing to be current.
    for (const name of ['proof.mp4', 'strip-1fps.jpg']) rmSync(path.join(OUTPUT, name), { force: true })
    for (const name of ['capture.json', 'telemetry.json', 'motion.json']) rmSync(path.join(EVIDENCE, name), { force: true })
  }
  const s = validateSequence(JSON.parse(readFileSync(new URL('./proof.json', import.meta.url))))
  const source = captureSourceProvenance({ repoRoot: ROOT })
  if (source.workingTreeDirty) throw new Error('Application source must be committed before capture')
  const cpu = await cpuCheck()
  const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=d3d11', '--ignore-gpu-blocklist'] })
  try {
    await withViteCaptureServer({ port: 2551, repoRoot: ROOT }, async ({ baseUrl }) => {
      const context = await browser.newContext({ viewport: s.viewport, deviceScaleFactor: 1 })
      const page = await context.newPage(), errors = []
      page.setDefaultTimeout(30000); page.on('pageerror', e => errors.push(e.message))
      try {
        const prep = await prepare(page, baseUrl, s)
        console.log('Preparation:', JSON.stringify(prep))
        await installPointer(page)
        await page.mouse.move(1380, 900)
        await page.screenshot({ path: path.join(EVIDENCE, 'prepared.png') })
        if (!record) {
          const actions = await perform(page, s)
          await page.screenshot({ path: path.join(EVIDENCE, 'rehearsed.png') })
          json(path.join(EVIDENCE, 'rehearsal.json'), { prep, cpu, actions, errors })
          console.log('Rehearsal:', JSON.stringify(actions))
          return
        }
        const captureCpu = await cpuCheck()
        const raw = path.join(EVIDENCE, 'raw'); mkdirSync(raw, { recursive: true })
        for (const name of readdirSync(raw)) if (/^frame-\d+\.jpg$/.test(name) || name === 'frames.txt') rmSync(path.join(raw, name))
        for (const name of ['proof.mp4', 'strip-1fps.jpg']) rmSync(path.join(OUTPUT, name), { force: true })
        const capture = await startCompositorCapture(context, page, raw), frames = capture.frames
        await page.evaluate(() => {
          window.__wo2551Samples = []
          const start = performance.now()
          const sample = () => {
            window.__wo2551Samples.push({ t: (performance.now() - start) / 1000, sim: +document.querySelector('.sim-scrubber').value, camera: window.__cncViewport.getCamera().position.toArray(), stockSync: document.querySelector('.sim-panel').getAttribute('data-stock-sync') })
            if (performance.now() - start < 27000) requestAnimationFrame(sample)
          }
          requestAnimationFrame(sample)
        })
        const actions = await perform(page, s)
        await capture.stop()
        const telemetry = await page.evaluate(() => window.__wo2551Samples)
        json(path.join(EVIDENCE, 'telemetry.json'), telemetry)
        if (errors.length) throw new Error('Application page errors: ' + errors.join('; '))
        if (frames.length < 300) throw new Error('Capture too sparse: ' + frames.length)
        encodeCompositorCapture(raw, frames, s.durationSeconds, path.join(OUTPUT, 'proof.mp4'))
        ffmpeg(['-y', '-i', path.join(OUTPUT, 'proof.mp4'), '-vf', 'fps=1,scale=480:270,tile=5x6', '-frames:v', '1', path.join(OUTPUT, 'strip-1fps.jpg')])
        json(path.join(EVIDENCE, 'capture.json'), { source, capturedAt: new Date().toISOString(), projectSha256: createHash('sha256').update(readFileSync(path.join(ROOT, s.project))).digest('hex'), prep, cpu, captureCpu, frames, actions, errors, bytes: statSync(path.join(OUTPUT, 'proof.mp4')).size, sha256: createHash('sha256').update(readFileSync(path.join(OUTPUT, 'proof.mp4'))).digest('hex') })
        // The analyzer cleans raw originals after measurements; --keep-raw preserves them.
        console.log('Captured frames:', frames.length)
      } catch (e) {
        await page.screenshot({ path: path.join(EVIDENCE, 'failed.png') }).catch(() => {})
        throw e
      } finally { await context.close() }
    })
  } finally { await browser.close() }
}
if (isMain(import.meta.url)) {
  runProof({ record: process.argv.includes('--record') }).catch(e => { console.error(e); process.exitCode = 1 })
}
