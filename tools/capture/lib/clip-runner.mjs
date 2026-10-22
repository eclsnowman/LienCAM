import { isMain } from '../../lib/is-main.mjs';
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { verifyBuild, withBuildServer } from './scene-runner.mjs'
import { CHROMIUM_CAPTURE_ARGS } from './harness.mjs'
import { readAppState } from '../../examples/lib/drive.mjs'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const ACTIONS = ['import', 'open', 'stock', 'setup', 'tools', 'operation', 'secondSide', 'regen', 'simulate', 'post', 'export', 'hold']
const json = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex')

export function loadClips(file = path.join(ROOT, 'tools/capture/clips/v01-v03.json')) {
  const list = JSON.parse(readFileSync(file, 'utf8'))
  if (list.version !== 1 || list.theme !== 'dark' || list.uiScale !== 1 || list.viewport?.width !== 1920 || list.viewport?.height !== 1080 || !list.clips?.length) throw new Error('Clips require 1920x1080, dark, 100% scale')
  const ids = new Set()
  for (const clip of list.clips) {
    if (!/^V\d\d$/.test(clip.id) || ids.has(clip.id) || !clip.name || !clip.steps?.length) throw new Error('Invalid or duplicate clip id')
    ids.add(clip.id)
    for (const input of [clip.project, clip.drawing].filter(Boolean)) {
      if (!input.startsWith('examples/') || input.split(/[\\/]/).includes('..') || !existsSync(path.join(ROOT, input))) throw new Error(`${clip.id}: input must be a shipped example`)
    }
    if (!clip.project) throw new Error(`${clip.id}: project required`)
    for (const step of clip.steps) if (!ACTIONS.includes(step.action) || !step.caption || !/^[\x20-\x7e]+$/.test(step.caption)) throw new Error(`${clip.id}: invalid action or caption`)
  }
  return list
}

export function ffmpegPath() {
  if (process.env.FFMPEG) return process.env.FFMPEG
  const python = spawnSync('python', ['-c', 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())'], { encoding: 'utf8' })
  return python.status === 0 ? python.stdout.trim() : 'ffmpeg'
}

function ffmpeg(args) {
  // Filters and decoders otherwise consume every desk core even when x264 is
  // capped. Keep frame strips and focused media checks within the same budget.
  const result = spawnSync(ffmpegPath(), ['-hide_banner', '-filter_threads', '2', '-filter_complex_threads', '2', '-threads', '2', ...args], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 })
  if (result.error || result.status !== 0) throw new Error(`ffmpeg failed: ${result.error?.message || result.stderr}`)
  return result.stderr
}

export function inspectClip(file) {
  // Decode the entire output, not just an encoder receipt or MP4 header.
  const text = ffmpeg(['-threads', '2', '-i', file, '-map', '0:v:0', '-f', 'null', '-'])
  const duration = text.match(/Duration: (\d+):(\d+):(\d+\.\d+)/)
  const video = text.match(/Video: (\w+)[^\n]*?, (\d+)x(\d+)/)
  if (!duration || !video) throw new Error('Missing video stream or duration')
  return { codec: video[1], width: +video[2], height: +video[3], durationSeconds: +duration[1] * 3600 + +duration[2] * 60 + +duration[3] }
}

export async function waitForClipState(id, label, check, timeout = 120_000) {
  const end = Date.now() + timeout
  do {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 150))
  } while (Date.now() < end)
  throw new Error(`${id}: state check failed: ${label}`)
}

async function caption(page, text) {
  // A caption overlay only; application state and geometry are never injected.
  await page.evaluate(text => {
    let node = document.getElementById('capture-caption')
    if (!node) {
      node = document.createElement('div'); node.id = 'capture-caption'
      node.style.cssText = 'position:fixed;left:420px;right:420px;top:76px;z-index:2147483647;pointer-events:none;background:rgba(8,12,18,.94);color:white;padding:16px 24px;border:1px solid #6b8799;border-radius:8px;font:24px/1.4 Arial;text-align:center;box-shadow:0 4px 18px #0008'
      document.body.append(node)
    }
    node.textContent = text
  }, text)
}

async function perform(page, clip, step, record, evidence) {
  const state = () => readAppState(page)
  const visible = id => page.getByTestId(id).isVisible()
  const tab = async id => {
    await page.getByTestId(`mode-tab-${id}`).click()
    await waitForClipState(clip.id, `tab ${id}`, async () => id === 'postprocess'
      ? await visible('post-gcode-preview')
      : (await page.getByTestId(`mode-tab-${id}`).getAttribute('class')).includes('mode-tab-active'))
  }
  const chooseSetup = async index => {
    await tab('toolpath')
    await page.locator('.tree-setup-header').nth(index).click()
    const wanted = (await state()).project.setups[index].id
    await waitForClipState(clip.id, 'select complete setup', async () => { const p = (await state()).project; return p.activeSetupId === wanted && p.activeOperationId === null })
  }
  const framePart = async () => {
    const canvas = page.locator('.viewport-canvas')
    await canvas.click({ button: 'right', position: { x: 650, y: 350 } })
    await page.locator('[role="menuitem"][data-action="fit-all"]').click()
    await canvas.click({ button: 'right', position: { x: 650, y: 350 } })
    await page.locator('[role="menuitem"][data-action="view-top"]').click()
    const grid = page.getByRole('button', { name: 'Toggle grid', exact: true })
    if ((await grid.getAttribute('class')).includes('vp-btn-on')) await grid.click()
    await page.mouse.move(970, 490)
    const camera = () => page.evaluate(() => {
      const c = window.__cncViewport?.getCamera()
      if (!c) throw new Error('Production camera readback missing')
      return { width: (c.right - c.left) / c.zoom, height: (c.top - c.bottom) / c.zoom }
    })
    const p = (await state()).project
    const setup = p.setups.find(s => s.id === p.activeSetupId) || p.setups[0]
    const stock = p.sceneStock.fixedStocks.find(s => s.id === setup.wcs.stockId)
    if (!stock) throw new Error(`${clip.id}: framing stock missing`)
    const before = await camera()
    await page.mouse.wheel(0, -100)
    await page.waitForTimeout(250)
    const calibrated = await camera()
    const gain = Math.log(before.height / calibrated.height) / -100
    const ratio = Math.min(calibrated.width * 0.7 / stock.width, calibrated.height * 0.65 / stock.height)
    if (!Number.isFinite(gain) || Math.abs(gain) < 0.00001) throw new Error(`${clip.id}: zoom control did not change camera`)
    await page.mouse.wheel(0, Math.log(ratio) / gain)
    await page.waitForTimeout(600)
    const after = await camera()
    record.framing = { view: 'top', fit: 'Fit all', grid: false, stockWidthFraction: stock.width / after.width, stockHeightFraction: stock.height / after.height }
    if (record.framing.stockWidthFraction > 0.8 || record.framing.stockHeightFraction > 0.8) throw new Error(`${clip.id}: stock extends beyond framing margin`)
  }
  switch (step.action) {
    case 'import': {
      const chooser = page.waitForEvent('filechooser')
      await page.getByRole('button', { name: 'Import geometry', exact: true }).click()
      await (await chooser).setFiles(path.join(ROOT, clip.drawing))
      await waitForClipState(clip.id, 'DXF loops and layers', async () => (await state())?.project.geometry.some(g => g.filename === path.basename(clip.drawing) && g.loops.length === 6 && g.layers2d.length === 3))
      break
    }
    case 'open': {
      const project = JSON.parse(readFileSync(path.join(ROOT, clip.project), 'utf8'))
      const chooser = page.waitForEvent('filechooser')
      await page.getByRole('button', { name: 'Open project', exact: true }).click()
      await (await chooser).setFiles(path.join(ROOT, clip.project))
      await waitForClipState(clip.id, 'open kit recipe', async () => (await state())?.project.id === project.id && !await page.getByTestId('project-open-indicator').count())
      const use = page.getByRole('button', { name: 'Use this machine', exact: true })
      if (await use.isVisible()) { await page.locator('.machine-choice-item').filter({ hasText: 'Sample hobby router' }).click(); await use.click() }
      await waitForClipState(clip.id, 'generic starter machine', async () => (await state()).project.machine.name === 'Sample hobby router (GRBL)')
      await framePart()
      break
    }
    case 'stock': {
      await tab('setup')
      const fixed = page.locator('.fixed-stock-node').filter({ has: page.getByTestId('fixed-stock-gizmo-btn') })
      if (!await fixed.locator('.stock-number-input').first().isVisible()) await fixed.locator('.fixed-stock-header').click()
      await waitForClipState(clip.id, 'stock fields', () => fixed.locator('.stock-number-input').first().isVisible())
      break
    }
    case 'setup':
      await tab('setup')
      await page.locator('.viewport-canvas').click({ position: { x: 50, y: 250 } })
      await page.locator('.tree-setup-header').nth(step.setup || 0).click()
      await waitForClipState(clip.id, 'kit holding method visible', async () => {
        const setup = (await state()).project.setups[step.setup || 0]
        return !!setup.holdingMethod && await page.getByTestId('setup-holding-method').inputValue() === setup.holdingMethod
      })
      record.holdingMethod = await page.getByTestId('setup-holding-method').inputValue()
      await page.screenshot({ path: path.join(evidence, `${clip.id}-holding-${step.setup || 0}.png`) })
      await page.waitForTimeout(1500)
      await page.getByRole('button', { name: 'Edit setup', exact: true }).nth(step.setup || 0).click()
      await waitForClipState(clip.id, 'setup offset', async () => await page.getByTestId('stock-work-offset-select').inputValue() === String(54 + (step.setup || 0)))
      await page.waitForTimeout(4000)
      await page.locator('.setup-modal .modal-close-btn').click()
      break
    case 'tools':
      await page.getByTestId('mode-tab-toollibrary').click()
      await waitForClipState(clip.id, 'four project tools', async () => (await state()).project.setups.flatMap(s => s.operations).map(o => o.toolId).filter((id, i, a) => a.indexOf(id) === i).length === 4 && await page.locator('.tool-modal').isVisible())
      await page.waitForTimeout(5000)
      await page.locator('.tool-modal .modal-close-btn').click()
      break
    case 'operation': {
      await tab('toolpath')
      await framePart()
      const op = (await state()).project.setups[0].operations[step.index]
      if (!await page.locator('.tree-op').filter({ hasText: op.name }).count()) await page.locator('.tree-setup-header').first().click()
      await page.locator('.tree-op').filter({ hasText: op.name }).getByRole('button', { name: 'Edit operation', exact: true }).click()
      await page.locator('.op-modal-tab').filter({ hasText: step.tab }).click()
      await waitForClipState(clip.id, 'operation editor tab', () => page.locator('.op-modal-tab-active').filter({ hasText: step.tab }).isVisible())
      record.operation = { name: op.name, type: op.type, loopIds: op.params.loopIds, heights: op.heights, params: op.params }
      await page.waitForTimeout(4500)
      await page.locator('.op-modal .modal-close-btn').click()
      break
    }
    case 'secondSide':
      await tab('setup')
      await page.getByRole('button', { name: 'Add setup', exact: true }).click()
      await page.getByTestId('setup-second-side-of').selectOption((await state()).project.setups[0].id)
      await page.getByTestId('setup-second-side-axis').selectOption('y')
      await waitForClipState(clip.id, 'second side about Y', async () => await page.getByTestId('setup-second-side-axis').inputValue() === 'y' && !await visible('setup-second-side-refusal'))
      await page.waitForTimeout(5000)
      await page.locator('.setup-modal .modal-close-btn').click()
      break
    case 'regen':
      await tab('toolpath')
      await page.getByRole('button', { name: 'REGEN ALL', exact: true }).click()
      await waitForClipState(clip.id, 'all operations ready', async () => {
        const ops = (await state()).project.setups.flatMap(s => s.operations)
        if (ops.some(o => o.status === 'error')) throw new Error(`${clip.id}: production compute failed`)
        return ops.length > 0 && ops.every(o => o.status === 'ready')
      })
      await chooseSetup(0)
      break
    case 'simulate': {
      await chooseSetup(step.setup || 0)
      await tab('simulation')
      await page.getByLabel('Simulate Stock Removal', { exact: true }).check()
      await page.getByTestId('sim-hide-toolpath').check()
      await page.getByTestId('sim-display-compare').click()
      await page.getByTestId('sim-stock-opacity').fill('1')
      record.stockOpacity = +await page.getByTestId('sim-stock-opacity').inputValue()
      await page.getByTestId('sim-display-stock').click()
      await page.getByRole('button', { name: 'Display mode', exact: true }).click()
      await page.getByTestId('shading-shaded-edges').check()
      await page.locator('.planes-flyout-close').click()
      await framePart()
      const slider = page.getByRole('slider', { name: 'Simulation position' })
      await waitForClipState(clip.id, 'simulation duration', async () => +await slider.getAttribute('max') > 0)
      const max = +await slider.getAttribute('max')
      for (const fraction of [0.25, 0.55, 1]) {
        await slider.fill(String(Math.min(Math.floor(max), Math.round(max * fraction))))
        await waitForClipState(clip.id, 'production stock simulation synchronized', async () => await page.locator('.sim-panel').getAttribute('data-stock-sync') === 'exact' && !await visible('sim-frame-error') && Math.abs(+await page.locator('.sim-panel').getAttribute('data-stock-ms') - +await slider.inputValue()) <= 1)
        await page.waitForTimeout(1500)
      }
      await page.screenshot({ path: path.join(evidence, `${clip.id}-simulation-${step.setup || 0}.png`) })
      record.simulation = { setup: step.setup || 0, durationMs: max, positionMs: +await slider.inputValue(), stockSync: await page.locator('.sim-panel').getAttribute('data-stock-sync'), stockOpacity: record.stockOpacity, displayStock: await page.getByTestId('sim-display-stock').getAttribute('aria-pressed') }
      break
    }
    case 'post': {
      await tab('postprocess')
      await page.getByTestId('post-definition-select').click()
      await page.getByRole('option', { name: 'UCCNC', exact: true }).click()
      await page.getByLabel('All operations', { exact: true }).check()
      await page.getByRole('button', { name: 'Combined (one file)', exact: true }).click()
      if (step.pause) {
        const toggle = page.locator('.mform-row').filter({ hasText: 'Pause between setups (M0)' }).locator('label.toggle')
        if (!await toggle.locator('input').isChecked()) await toggle.click()
        await waitForClipState(clip.id, 'between-setup pause enabled', () => toggle.locator('input').isChecked())
      }
      await waitForClipState(clip.id, 'posted preview', async () => {
        const text = await page.getByTestId('post-gcode-preview').innerText()
        return /G21/.test(text) && /G54/.test(text) && /M30/.test(text) && (!step.pause || /G55/.test(text) && /M0/.test(text))
      })
      record.gcode = await page.getByTestId('post-gcode-preview').innerText()
      if (clip.id === 'V02' && !['T2', 'T3', 'T4', 'T6'].every(t => record.gcode.includes(t))) throw new Error(`${clip.id}: missing posted tool`)
      break
    }
    case 'export': {
      const [file] = await Promise.all([
        page.waitForEvent('download'),
        page.locator('.post-modal').getByRole('button', { name: /^Export \./ }).click(),
      ])
      await file.saveAs(path.join(evidence, `${clip.id}-export.nc`))
      record.exportBytes = statSync(path.join(evidence, `${clip.id}-export.nc`)).size
      if (!record.exportBytes) throw new Error(`${clip.id}: empty export`)
      break
    }
    case 'hold': break
  }
  const snapshot = await state()
  record.readback = { projectId: snapshot.project.id, machine: snapshot.project.machine.name,
    setups: snapshot.project.setups.map(s => ({ name: s.name, wcs: s.wcs, operations: s.operations.map(o => ({ name: o.name, type: o.type, status: o.status, toolId: o.toolId })) })) }
}

export async function runClips({ build, catalog, only, evidence = 'src/tests/evidence/WO-2396', runName = 'run' }) {
  const list = loadClips(catalog), receipt = verifyBuild(path.resolve(build))
  if (!receipt.demoBuild) throw new Error('Clips require the release demo build')
  if (!/^[a-zA-Z0-9-]+$/.test(runName)) throw new Error('Invalid run name')
  if (only?.some(id => !list.clips.some(c => c.id === id))) throw new Error('Unknown clip id')
  const out = path.join(ROOT, 'docs/media'), dir = path.resolve(ROOT, evidence)
  if (!dir.startsWith(`${ROOT}src${path.sep}tests${path.sep}evidence${path.sep}`)) throw new Error('Evidence must stay in src/tests/evidence')
  mkdirSync(out, { recursive: true }); mkdirSync(dir, { recursive: true })
  const result = { buildCommit: receipt.commit, buildHash: receipt.buildHash, clips: [] }
  const browser = await chromium.launch({ headless: true, args: CHROMIUM_CAPTURE_ARGS })
  try {
    await withBuildServer(path.resolve(build), async url => {
      for (const clip of list.clips.filter(c => !only || only.includes(c.id))) {
        const output = path.join(out, `${clip.id}.mp4`), strip = path.join(dir, `${clip.id}-strip.png`)
        const previousMtimeMs = existsSync(output) ? statSync(output).mtimeMs : null
        for (const file of [output, strip, path.join(dir, `${clip.id}-provenance.json`), path.join(dir, `${clip.id}-failed.png`)]) rmSync(file, { force: true })
        for (const file of readdirSync(dir).filter(name => name.startsWith(`${clip.id}-recording-`) && name.endsWith('.jpg'))) rmSync(path.join(dir, file), { force: true })
        const entry = { id: clip.id, actions: [], status: 'running', previousMtimeMs }; result.clips.push(entry)
        const context = await browser.newContext({ viewport: list.viewport, deviceScaleFactor: 1, acceptDownloads: true })
        const page = await context.newPage(), errors = []
        page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(30_000)
        const frames = [], session = await context.newCDPSession(page)
        let frameStart, frameSequence = 0
        session.on('Page.screencastFrame', event => {
          session.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {})
          // Bound desk I/O while preserving UI changes at up to 5 fps; caption
          // holds use the real timestamps and the deliverable plays at 25 fps.
          if (frames.length && Date.now() - frames.at(-1).time < 200) return
          const file = path.join(dir, `${clip.id}-recording-${String(frameSequence++).padStart(6, '0')}.jpg`)
          writeFileSync(file, Buffer.from(event.data, 'base64'))
          frames.push({ file, time: Date.now() })
        })
        try {
          console.log(`[${clip.id}] Opening release build ${receipt.commit}`)
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 })
          await page.getByRole('button', { name: 'Start with an empty project' }).click()
          await page.locator('#liencam-splash').waitFor({ state: 'hidden' })
          await page.getByRole('button', { name: 'Application settings', exact: true }).click()
          await page.getByTestId('settings-interface-scale').click()
          await page.getByRole('option', { name: '100%', exact: true }).click()
          await page.getByTestId('settings-light-mode').setChecked(false)
          await page.locator('.settings-modal .modal-close-btn').click()
          await waitForClipState(clip.id, 'dark 100% UI', async () => await page.locator('.app-shell').getAttribute('data-ui-scale') === '1' && await page.locator('html').getAttribute('data-color-mode') !== 'light')
          const start = Date.now()
          frameStart = start
          await session.send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 3 })
          for (const step of clip.steps) {
            const action = { ...step, startedAtMs: Date.now() - start, passed: false }; entry.actions.push(action)
            console.log(`[${clip.id}] ${step.action}: ${step.caption}`)
            await caption(page, step.caption)
            await perform(page, clip, step, action, dir)
            if (entry.actions.length === 1) {
              // The file chooser opens on an empty scene. Keep the first caption
              // and imported/opened part as the opening, rather than blank UI.
              frameStart = Date.now()
              entry.leadingTrimMs = frameStart - start
              while (frames.length && frames[0].time < frameStart) rmSync(frames.shift().file, { force: true })
              await page.screenshot({ path: path.join(dir, `${clip.id}-opening.png`) })
            }
            await page.mouse.move(1900, 1050)
            await page.waitForTimeout(3500)
            action.passed = true; action.finishedAtMs = Date.now() - start
            console.log(`[${clip.id}] state check passed`)
          }
          await page.waitForTimeout(Math.max(0, 65_000 - (Date.now() - frameStart)))
          if (errors.length) throw new Error(`${clip.id}: browser errors: ${errors.join('; ')}`)
          await page.screenshot({ path: path.join(dir, `${clip.id}-live.png`) })
          await session.send('Page.stopScreencast')
          const frameEnd = Date.now()
          await context.close()
          if (!frames.length) throw new Error(`${clip.id}: Chromium produced no recording frames`)
          // CDP records each rendered UI change with its actual hold duration.
          // This avoids Playwright's native VP8 encoder stalling on this host.
          // If the busy host stretches the run, preserve every action by scaling
          // the complete timeline, rather than truncating away the last steps.
          const scale = Math.min(1, 110_000 / (frameEnd - frameStart))
          const concat = path.join(dir, `${clip.id}-recording.txt`)
          writeFileSync(concat, frames.map((frame, index) => {
            const duration = ((frames[index + 1]?.time || frameEnd) - (index === 0 ? frameStart : frame.time)) * scale / 1000
            return `file '${path.basename(frame.file)}'\nduration ${Math.max(0.04, duration).toFixed(3)}\n`
          }).join('') + `file '${path.basename(frames.at(-1).file)}'\n`)
          // CDP can deliver a queued pre-paint frame after the load check.
          // DXF imports take an extra paint compared with opening a recipe.
          const encodedLeadTrimSeconds = clip.steps[0].action === 'import' ? 1.5 : 1
          ffmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', concat, '-ss', String(encodedLeadTrimSeconds), '-an', '-vf', 'fps=25,scale=1920:1080', '-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
            '-metadata', `comment=clipId=${clip.id};buildCommit=${receipt.commit};buildHash=${receipt.buildHash}`, output])
          entry.recording = { mode: 'Chromium CDP rendered-frame stream', frames: frames.length, wallDurationMs: frameEnd - frameStart, timelineScale: scale, encodedLeadTrimSeconds }
          const info = inspectClip(output)
          if (info.codec !== 'h264' || info.width !== 1920 || info.height !== 1080 || info.durationSeconds < 60 || info.durationSeconds > 120.1) throw new Error(`${clip.id}: invalid encoded media`)
          ffmpeg(['-y', '-i', output, '-vf', `fps=1,scale=320:180,tile=10x${Math.ceil(info.durationSeconds / 10)}`, '-threads', '2', '-frames:v', '1', strip])
          Object.assign(entry, info, { status: 'passed', bytes: statSync(output).size, sha256: hash(output), mtimeMs: statSync(output).mtimeMs })
          entry.replaced = previousMtimeMs === null || entry.mtimeMs > previousMtimeMs
          json(path.join(dir, `${clip.id}-provenance.json`), { ...entry, buildCommit: receipt.commit, buildHash: receipt.buildHash,
            captureCommit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim(), capturedAt: new Date().toISOString(), source: 'production Chromium rendered-frame recording; captions only', frameStrip: `${clip.id}-strip.png` })
        } catch (error) {
          entry.status = 'failed'; entry.error = `${clip.id}: ${error.message}`
          await page.screenshot({ path: path.join(dir, `${clip.id}-failed.png`) }).catch(() => {})
          await context.close().catch(() => {})
          rmSync(output, { force: true })
          console.error(entry.error)
        } finally {
          for (const frame of frames) rmSync(frame.file, { force: true })
          rmSync(path.join(dir, `${clip.id}-recording.txt`), { force: true })
          json(path.join(dir, `${runName}.json`), result)
        }
      }
    })
  } finally { await browser.close() }
  if (result.clips.some(c => c.status !== 'passed')) throw new Error(result.clips.filter(c => c.status !== 'passed').map(c => c.error).join('\n'))
  return result
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2), option = key => args.includes(key) ? args[args.indexOf(key) + 1] : undefined
  try {
    if (!args[0]) throw new Error('Usage: node tools/capture/lib/clip-runner.mjs <release-build> [--catalog file] [--only V01,V02] [--evidence directory] [--run-name run-1]')
    await runClips({ build: args[0], catalog: option('--catalog'), only: option('--only')?.split(','), evidence: option('--evidence'), runName: option('--run-name') || 'run' })
  } catch (error) { console.error(error.stack); process.exitCode = 1 }
}
