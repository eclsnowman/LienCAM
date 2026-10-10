// WO-2653: disposable takes, shipping UI input, readback-only app inspection.
// node tools/capture/clips-v2/v02.mjs [absolute scratch directory outside repo]
import { chromium } from 'playwright'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, existsSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureSourceProvenance, withViteCaptureServer } from '../lib/provenance.mjs'
import { installPointer, travel } from './proof.mjs'

export const ROOT = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)))
export const EVIDENCE = path.join(ROOT, 'src/tests/evidence/WO-2653')
const json = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const assert = (ok, message) => { if (!ok) throw new Error(message) }
export async function sampleCpu() {
  const snapshot = () => os.cpus().reduce((a, c) => ({ idle: a.idle + c.times.idle, total: a.total + Object.values(c.times).reduce((x, y) => x + y, 0) }), { idle: 0, total: 0 })
  const values = []
  for (let i = 0; i < 3; i++) {
    const before = snapshot(); await pause(1000); const after = snapshot()
    values.push(100 * (1 - (after.idle - before.idle) / (after.total - before.total)))
  }
  const average = values.reduce((a, b) => a + b) / 3
  assert(average < 60, `PLATFORM: CPU ${average.toFixed(2)}% >= 60%`)
  return { values, average, cores: os.cpus().length, loadAverage: os.loadavg() }
}
export function scratchFolder(requested) {
  const base = requested ? path.resolve(requested) : os.tmpdir()
  let ancestor = base
  while (!existsSync(ancestor)) ancestor = path.dirname(ancestor)
  const actual = path.resolve(realpathSync(ancestor), path.relative(ancestor, base))
  const repo = realpathSync(ROOT)
  assert(actual !== repo && !actual.startsWith(repo + path.sep), 'Disposable outputs must be outside the repository')
  mkdirSync(actual, { recursive: true })
  // A private child prevents collisions or deletion of a caller's old samples.
  return mkdtempSync(path.join(actual, 'wo2653-'))
}
// The frame list goes through a file: a long take's JSON overflows a Windows command line.
function stripFrames(scratch, out, frames) {
  const list = path.join(scratch, 'strip-frames.json')
  writeFileSync(list, JSON.stringify(frames))
  execFileSync('python3', [fileURLToPath(new URL('./strip.py', import.meta.url)), scratch, path.join(out, 'strip-1fps.jpg'), '@' + list], { maxBuffer: 1024 * 1024 })
  rmSync(list, { force: true })
}
// Only scratch files created by this sampler are deleted. Never delete a caller's directory.
export async function sampleFrames(page, scratch, out) {
  const frames = [], started = Date.now(); let busy = false, pending = Promise.resolve()
  const snap = async () => {
    const name = `sample-${String(frames.length).padStart(5, '0')}.jpg`
    await page.screenshot({ path: path.join(scratch, name), type: 'jpeg', quality: 65 })
    frames.push({ file: name, seconds: (Date.now() - started) / 1000 })
  }
  await snap()
  const timer = setInterval(() => {
    if (busy) return
    busy = true; pending = snap().catch(() => {}).finally(() => { busy = false })
  }, 1000)
  return async () => {
    clearInterval(timer); await pending; await snap().catch(() => {})
    json(path.join(out, 'frames.json'), { sampleRateRequested: 1, frames })
    stripFrames(scratch, out, frames)
    for (const frame of frames) rmSync(path.join(scratch, frame.file), { force: true })
  }
}
// Decode the disposable continuous recording, keeping exactly one real frame
// per second. Periodic live screenshots alone can miss seconds under load.
export function videoStrip(file, scratch, out) {
  const prefix = 'decoded-'
  for (const name of readdirSync(scratch).filter(name => /^decoded-\d+\.jpg$/.test(name))) rmSync(path.join(scratch, name), { force: true })
  execFileSync(process.env.FFMPEG_BIN || process.env.FFMPEG || 'ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-filter_threads', '2', '-threads', '2', '-i', file, '-vf', 'fps=1,scale=240:135', '-q:v', '6', path.join(scratch, prefix + '%06d.jpg')], { maxBuffer: 8 * 1024 * 1024 })
  const names = readdirSync(scratch).filter(name => /^decoded-\d+\.jpg$/.test(name)).sort()
  assert(names.length > 0, 'Disposable video decoded no 1-fps frames')
  const frames = names.map((name, i) => ({ file: name, seconds: i }))
  stripFrames(scratch, out, frames)
  json(path.join(out, 'frames.json'), { sampleRate: 1, capture: 'Decoded continuous Playwright recording, fps=1, no time scaling', frameCount: frames.length })
  for (const name of names) rmSync(path.join(scratch, name), { force: true })
  return { frameCount: frames.length, sampleRate: 1 }
}
class AppFailure extends Error {}
// WO-2653 architect 10-07: the same scripts against a built bundle served by
// `vite preview`, without the dev server's dependency optimizer or on-demand
// transforms. CLIP_PREVIEW_DIST names a `vite build --outDir` folder.
async function withPreviewServer(dist, run) {
  const port = 2654, baseUrl = `http://127.0.0.1:${port}/`
  const answers = () => fetch(baseUrl).then(r => r.ok, () => false)
  assert(existsSync(path.join(dist, 'index.html')), 'No built index.html in ' + dist)
  assert(!await answers(), 'Preview port already answers at ' + baseUrl)
  const server = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'preview', '--outDir', dist, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: ROOT, detached: process.platform !== 'win32', stdio: ['ignore', 'inherit', 'inherit'] })
  try {
    const deadline = Date.now() + 60000
    while (!await answers()) { assert(server.exitCode === null && Date.now() < deadline, 'Preview server did not answer at ' + baseUrl); await pause(300) }
    return await run({ baseUrl })
  } finally { try { process.platform === 'win32' ? server.kill() : process.kill(-server.pid) } catch {} }
}
export async function runClip(id, requestedScratch) {
  const script = path.join(ROOT, `tools/capture/clips-v2/${id.toLowerCase()}.json`)
  const sequence = JSON.parse(readFileSync(script, 'utf8'))
  assert(sequence.id === id && sequence.version === 1 && sequence.steps.length, 'Invalid rehearsal sequence')
  const dist = process.env.CLIP_PREVIEW_DIST ? path.resolve(process.env.CLIP_PREVIEW_DIST) : null, receipt = process.env.CLIP_RECEIPT
  assert(!receipt || /^[a-z0-9-]+$/.test(receipt), 'CLIP_RECEIPT must be a plain folder name')
  const scratch = scratchFolder(requestedScratch), out = receipt ? path.join(EVIDENCE, id, receipt) : path.join(EVIDENCE, id)
  mkdirSync(out, { recursive: true })
  rmSync(path.join(out, 'strip-1fps.jpg'), { force: true })
  const source = captureSourceProvenance({ repoRoot: ROOT })
  assert(!source.workingTreeDirty, 'Commit production source before rehearsal')
  const result = { id, source, scriptSha256: createHash('sha256').update(readFileSync(script)).digest('hex'), helperSha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'), startedAt: new Date().toISOString(), steps: [], completedScriptActions: [], pageErrors: [], consoleErrors: [], consoleErrorLocations: [], networkFailures: [], warnings: [], status: 'running', scratch, capture: 'Playwright disposable 1080p video; real wall-time 1-fps JPEG samples; software rendering permitted by WO-2653',
    server: dist ? { kind: 'vite preview of built bundle', dist, indexSha256: createHash('sha256').update(readFileSync(path.join(dist, 'index.html'))).digest('hex'), build: existsSync(path.join(dist, 'wo2653-build.json')) ? JSON.parse(readFileSync(path.join(dist, 'wo2653-build.json'), 'utf8')) : null } : { kind: 'vite dev server' } }
  const save = () => json(path.join(out, 'run.json'), result)
  const epoch = Date.now(); let browser, context, finishFrames, video
  try {
    result.cpu = await sampleCpu()
    const angle = process.env.CLIP_ANGLE || (process.platform === 'win32' ? 'd3d11' : 'gl-egl')
    result.launchArgs = ['--use-gl=angle', '--use-angle=' + angle, '--ignore-gpu-blocklist', ...(angle === 'swiftshader' ? ['--enable-unsafe-swiftshader'] : [])]
    browser = await chromium.launch({ headless: true, args: result.launchArgs })
    await (dist ? run => withPreviewServer(dist, run) : run => withViteCaptureServer({ repoRoot: ROOT, port: 2653 }, run))(async ({ baseUrl }) => {
      context = await browser.newContext({ viewport: sequence.viewport, deviceScaleFactor: 1, recordVideo: { dir: scratch, size: sequence.viewport } })
      const page = await context.newPage(); video = page.video(); page.setDefaultTimeout(15000)
      page.on('pageerror', e => result.pageErrors.push(e.message))
      page.on('console', m => { if (m.type() === 'error') { result.consoleErrors.push(m.text()); result.consoleErrorLocations.push(m.location()) } if (m.type() === 'warning') result.warnings.push(m.text()) })
      page.on('requestfailed', request => result.networkFailures.push({ url: request.url(), method: request.method(), error: request.failure()?.errorText }))
      const state = () => page.evaluate(() => {
        const p = window.__camStore?.getState().project
        const panel = document.querySelector('.sim-panel'), slider = document.querySelector('.sim-scrubber')
        return { projectId: p?.id, activeSetupId: p?.activeSetupId, activeOperationId: p?.activeOperationId, machine: { name: p?.machine.name, hasDefinition: !!p?.machine.controllerDefinition }, geometry: p?.geometry.map(g => ({ name: g.name, filename: g.filename, type: g.type, format: g.format })),
          setups: p?.setups.map(s => ({ id: s.id, name: s.name, wcs: s.wcs, operations: s.operations.map(o => ({ id: o.id, name: o.name, type: o.type, toolId: o.toolId, enabled: o.enabled, status: o.status, moves: o.toolpathMoves?.length, error: o.error })) })),
          sim: panel ? { position: +slider?.value, duration: +slider?.max, stockSync: panel.dataset.stockSync, stockMs: +panel.dataset.stockMs, playing: !!document.querySelector('[aria-label="Pause"]') } : null,
          camera: window.__camStore?.getState().workspace === 'part' ? window.__geo23MatrixProbe?.getCameraPose() : window.__cncViewport?.saveCameraState(), mode: window.__camStore?.getState().viewer.mode, workspace: window.__camStore?.getState().workspace }
      })
      let pointer = { x: 1380, y: 900 }
      const click = async (locator, options = {}) => {
        await locator.waitFor({ state: 'visible' }); await locator.scrollIntoViewIfNeeded()
        const r = await locator.boundingBox(); assert(r, 'Visible button has no bounds')
        const to = { x: r.x + r.width / 2, y: r.y + r.height / 2 }
        await travel(page, pointer, to, 650); await locator.click({ delay: 120, timeout: 120000, ...options }); pointer = to
      }
      const button = name => page.getByRole('button', { name, exact: true })
      const tid = name => page.getByTestId(name)
      const wait = async (predicate, label, ms = 120000) => {
        const deadline = Date.now() + ms
        while (Date.now() < deadline) { if (await predicate()) return; await page.waitForTimeout(150) }
        throw new Error('Readback timed out: ' + label)
      }
      const step = async (action, act, check, timeoutMs) => {
        const entry = { action, beganSeconds: (Date.now() - epoch) / 1000, passed: false }; result.steps.push(entry); save()
        console.log(`[${id}] ${action}`)
        try { await act(); await wait(check, action, timeoutMs); await page.waitForTimeout(sequence.holdMs ?? 800); entry.passed = true; entry.readback = await state() }
        catch (e) { entry.error = e.stack; entry.readback = await state().catch(() => null); throw e }
        finally { entry.endedSeconds = (Date.now() - epoch) / 1000; save() }
      }
      const tab = async name => step(`Open ${name}`, () => click(tid(`mode-tab-${name}`)), async () => name === 'postprocess' ? tid('post-gcode-preview').isVisible() : (await tid(`mode-tab-${name}`).getAttribute('class')).includes('mode-tab-active'))
      // WO-2700: the plain Model tab now offers a NEW model. Clips that work on
      // the shipped project's own model open it the operator's way: the
      // "Edit model" button on its design-tree row.
      const editModel = async () => step('Edit model from its design-tree row', () => click(page.locator('[data-testid^="model-edit-btn-"]').first()), async () => (await tid('mode-tab-part').getAttribute('class')).includes('mode-tab-active'))
      const open = async () => {
        const kit = JSON.parse(readFileSync(path.join(ROOT, sequence.project), 'utf8'))
        await step('Open shipped project through file picker', async () => {
          const chooser = page.waitForEvent('filechooser'); await click(button('Open project')); await (await chooser).setFiles(path.join(ROOT, sequence.project))
          // WO-2704: when the current project may hold unsaved work (an earlier
          // import, an edit), Open asks Save / Discard / Cancel after the file
          // is picked. The operator answers Discard. A clean project is not
          // asked: stop watching as soon as the open has begun or finished.
          const discard = tid('confirm-dialog-alt').filter({ hasText: /^Discard$/ })
          const deadline = Date.now() + 15000
          while (Date.now() < deadline) {
            if (await discard.isVisible()) { result.unsavedWorkQuestion = 'Discard'; await click(discard); break }
            if ((await state()).projectId === kit.id || await tid('project-open-indicator').count()) break
            await page.waitForTimeout(100)
          }
        }, async () => (await state()).projectId === kit.id && !await tid('project-open-indicator').count())
        await step('Read actual renderer after opening the project', async () => {}, async () => {
          result.renderer = await page.evaluate(() => {
            const gl = document.querySelector('.viewport-canvas canvas')?.getContext('webgl2'), ext = gl?.getExtension('WEBGL_debug_renderer_info')
            return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '(unknown)'
          })
          return result.renderer !== '(unknown)'
        })
        if (await button('Use this machine').isVisible()) await step('Choose sample hobby router', async () => {
          await click(page.locator('.machine-choice-item').filter({ hasText: 'Sample hobby router' })); await click(button('Use this machine'))
        }, async () => !await button('Use this machine').isVisible())
      }
      const chooseSetup = async index => {
        await tab('toolpath'); const expected = (await state()).setups[index]
        assert(expected, `Setup ${index} absent`)
        await step(`Select entire setup ${index + 1}: ${expected.name}`, () => click(page.locator('.tree-setup-header').nth(index)), async () => {
          const s = await state(); return s.activeSetupId === expected.id && s.activeOperationId === null
        })
      }
      const camera = () => page.evaluate(() => window.__camStore.getState().workspace === 'part' ? window.__geo23MatrixProbe?.getCameraPose() : window.__cncViewport.saveCameraState())
      const frame = async () => {
        const canvas = page.locator('.viewport-canvas')
        for (const action of ['fit-all', 'view-iso']) await step(`Camera ${action}`, async () => {
          await canvas.click({ button: 'right', position: { x: 650, y: 350 } }); await click(page.locator(`[role="menuitem"][data-action="${action}"]`))
        }, async () => !await page.locator(`[role="menuitem"][data-action="${action}"]`).isVisible() && !!await camera())
        const gizmo = button('Exit gizmo')
        if (await gizmo.isVisible()) await step('Exit move gizmo', () => click(gizmo), () => page.evaluate(() => !window.__cncViewport.scene.getObjectByName('__wcs_gizmo__') && !window.__cncViewport.scene.getObjectByName('__stock_gizmo__')))
        const grid = button('Toggle grid')
        if ((await grid.getAttribute('class')).includes('vp-btn-on')) await step('Hide grid', () => click(grid), async () => !(await grid.getAttribute('class')).includes('vp-btn-on'))
        await step('Read actual renderer', async () => {}, async () => {
          result.renderer = await page.evaluate(() => { const gl = document.querySelector('.viewport-canvas canvas').getContext('webgl2'), ext = gl.getExtension('WEBGL_debug_renderer_info'); return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '(unknown)' })
          return result.renderer !== '(unknown)'
        })
        const before = await camera()
        await step('Tighten framing with a smooth real wheel zoom', async () => {
          const r = await canvas.boundingBox(), to = { x: r.x + r.width / 2, y: r.y + r.height / 2 }
          await travel(page, pointer, to, 500); pointer = to
          // CLIP_WHEEL: total wheel travel; V03/V05 parts read small at the default 550 (10-09).
          const wheel = Number(process.env.CLIP_WHEEL || 550)
          for (let i = 0; i < 30; i++) { await page.mouse.wheel(0, -wheel / 30); await page.waitForTimeout(50) }
        }, async () => JSON.stringify(await camera()) !== JSON.stringify(before))
      }
      const orbit = async (delta = [60, 20]) => {
        const before = await camera()
        await step('Smooth orbit through production left drag', async () => {
          const canvas = (await state()).workspace === 'part' ? tid('solids-workbench-canvas') : page.locator('.viewport-canvas canvas')
          const r = await canvas.boundingBox(), from = { x: r.x + r.width * .72, y: r.y + r.height * .25 }, to = { x: from.x + delta[0], y: from.y + delta[1] }
          const target = await page.evaluate(({ from, to }) => {
            const hit = p => { const e = document.elementFromPoint(p.x, p.y); return { tag: e?.tagName, className: e?.getAttribute('class') } }
            const controls = window.__cncViewport?.controls
            return { from, to, startHit: hit(from), endHit: hit(to), camControls: controls ? { enabled: controls.enabled, enableRotate: controls.enableRotate, mouseButtons: controls.mouseButtons } : null }
          }, { from, to })
          result.orbitTargets ??= []; result.orbitTargets.push(target)
          assert(target.startHit.tag === 'CANVAS' && target.endHit.tag === 'CANVAS', 'Orbit coordinates are covered by a UI surface')
          await travel(page, pointer, from, 500); await page.mouse.down()
          try { await travel(page, from, to, 3000, false) } finally { await page.mouse.up() }
          pointer = to
        }, async () => JSON.stringify(await camera()) !== JSON.stringify(before))
      }
      const simulate = async index => {
        await chooseSetup(index); await tab('simulation')
        // Exact stock removal on a 126k-move job keeps the page busy past
        // Playwright's 15 s default while the toggle's click is dispatched
        // (V04 attempt 3); the same 120 s allowance as click() applies.
        await step('Enable real stock removal', async () => {
          await page.getByLabel('Simulate Stock Removal', { exact: true }).check({ timeout: 120000 }); await tid('sim-hide-toolpath').check({ timeout: 120000 }); await click(tid('sim-display-stock'))
        }, async () => await page.getByLabel('Simulate Stock Removal', { exact: true }).isChecked() && await tid('sim-display-stock').getAttribute('aria-pressed') === 'true')
        await wait(async () => (await state()).sim?.duration > 0, 'simulation frame')
        await step('Select 10x playback (never 50x)', async () => {
          await click(tid('sim-speed-chip')); await click(page.locator('.sim-speed-flyout button').filter({ hasText: /^10x$|^x10$/ }))
        }, async () => (await tid('sim-speed-chip').innerText()).includes('10'))
        await frame()
        const before = (await state()).sim.position
        await step('Play complete setup through production Play button', () => click(button('Play')), async () => (await state()).sim.position > before)
        await orbit(sequence.orbitDelta)
        await step('Wait for complete exact finished stock (no seek)', async () => {}, async () => {
          const s = (await state()).sim
          if (await tid('sim-frame-error').isVisible()) throw new AppFailure('Simulation frame error: ' + await tid('sim-frame-error').innerText())
          return s.position >= s.duration - 1 && !s.playing && s.stockSync === 'exact' && Math.abs(s.stockMs - s.duration) <= 1
        }, Math.max(120000, (await state()).sim.duration / 10 + 30000))
        await orbit(sequence.finishedOrbitDelta ?? [50, 100])
        await step('Compare completed stock and target', () => click(tid('sim-display-compare')), async () => await tid('sim-display-compare').getAttribute('aria-pressed') === 'true')
        await step('Fade completed stock using native slider drag', async () => {
          const slider = tid('sim-stock-opacity'), r = await slider.boundingBox(), from = { x: r.x + r.width - 8, y: r.y + r.height / 2 }, to = { x: r.x + 8, y: from.y }
          await travel(page, pointer, from, 500); await page.mouse.down()
          try { await travel(page, from, to, 3000, false) } finally { await page.mouse.up() }
          pointer = to
        }, async () => +await tid('sim-stock-opacity').inputValue() === +await tid('sim-stock-opacity').getAttribute('min'))
        await step('Hold finished features', () => page.waitForTimeout(5000), async () => (await state()).sim.stockSync === 'exact')
      }
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 90000 }); await page.locator('#liencam-splash').waitFor({ state: 'hidden' })
      const empty = button('Start with an empty project'); if (await empty.isVisible()) await click(empty)
      await installPointer(page); finishFrames = await sampleFrames(page, scratch, out)
      for (const s of sequence.steps) {
        switch (s.action) {
          case 'open': await open(); break
          case 'importSTEP':
            await step('Import knob STEP through the production geometry picker', async () => {
              const chooser = page.waitForEvent('filechooser'); await click(button('Import geometry')); await (await chooser).setFiles(path.join(ROOT, 'examples/06-knob-handwheel/knob.step'))
            }, async () => (await state()).geometry.some(g => g.filename === 'knob.step' && g.format === 'step'))
            break
          case 'setup': await chooseSetup(s.index ?? 0); await frame(); break
          case 'secondSide':
            await tab('setup')
            await step('Inspect second-side setup turned about Y', async () => {
              await click(button('Add setup')); await tid('setup-second-side-of').selectOption((await state()).setups[0].id); await tid('setup-second-side-axis').selectOption('y')
            }, async () => await tid('setup-second-side-axis').inputValue() === 'y' && !await tid('setup-second-side-refusal').isVisible())
            await step('Cancel practice setup; retain saved two-sided job', () => click(page.locator('.setup-modal .modal-close-btn')), async () => !await page.locator('.setup-modal').isVisible() && (await state()).setups.length === 2); break
          case 'tools':
            await step('Inspect project tools', () => click(tid('mode-tab-toollibrary')), async () => await page.locator('.tool-modal').isVisible() && new Set((await state()).setups.flatMap(s => s.operations.map(o => o.toolId))).size === 4)
            await step('Close tool library', () => click(page.locator('.tool-modal .modal-close-btn')), async () => !await page.locator('.tool-modal').isVisible()); break
          case 'operation': {
            await tab('toolpath'); const op = (await state()).setups[s.setup ?? 0].operations[s.index]
            const row = page.locator('.tree-setup').nth(s.setup ?? 0).locator('.tree-op').filter({ has: page.getByTestId('tree-name-op').filter({ hasText: new RegExp('^' + op.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$') }) })
            if (!await row.isVisible()) await step('Expand selected setup operations', () => click(page.locator('.tree-setup-header').nth(s.setup ?? 0)), () => row.isVisible())
            await step(`Inspect ${op.name}: ${s.tab}`, async () => {
              await click(row.getByRole('button', { name: 'Edit operation', exact: true })); await click(page.locator('.op-modal-tab').filter({ hasText: s.tab }))
            }, () => page.locator('.op-modal-tab-active').filter({ hasText: s.tab }).isVisible())
            await step('Close operation editor', () => click(page.locator('.op-modal .modal-close-btn')), async () => !await page.locator('.op-modal').isVisible()); break
          }
          case 'regen':
            await tab('toolpath')
            await step('Regenerate all operations', () => click(button('REGEN ALL')), async () => {
              const ops = (await state()).setups.flatMap(s => s.operations)
              if (ops.some(o => o.status === 'error')) throw new AppFailure('Production regeneration failed: ' + JSON.stringify(ops.filter(o => o.status === 'error')))
              return ops.length > 0 && ops.every(o => o.status === 'ready') && !await page.locator('.status-batch').count()
            }, sequence.regenTimeoutMs ?? 120000); break
          case 'simulate': await simulate(s.index ?? 0); break
          case 'post':
            await tab('postprocess')
            await step(`Post all operations to ${s.definition ?? 'UCCNC'} (${s.separate ? 'separate setups' : 'combined'})`, async () => {
              await click(tid('post-definition-select')); await click(page.getByRole('option', { name: s.definition ?? 'UCCNC', exact: true })); await page.getByLabel('All operations', { exact: true }).check(); await click(button(s.separate ? 'Separate files (one per setup)' : 'Combined (one file)'))
              if (s.pause) {
                const toggle = page.locator('.mform-row').filter({ hasText: 'Pause between setups (M0)' }).locator('label.toggle')
                if (!await toggle.locator('input').isChecked()) await click(toggle)
                assert(await toggle.locator('input').isChecked(), 'Between-setup pause toggle did not turn on')
              }
            }, async () => {
              const text = await tid('post-gcode-preview').innerText()
              result.posted = { definition: s.definition ?? 'UCCNC', separate: !!s.separate, bytes: text.length, toolWords: [...new Set(text.match(/T\d+/g))], g54: /G54/.test(text), g55: /G55/.test(text), m0: /M0/.test(text) }
              return /G21/.test(text) && /G54/.test(text) && /M(?:30|2)\b/.test(text) && (!s.pause || /G55/.test(text) && /M0/.test(text)) && (!s.tools || s.tools.every(t => text.includes(t)))
            })
            if (s.separate) {
              result.postedFiles = []
              for (let i = 0; i < (await state()).setups.length; i++) {
                await step(`Inspect separate posted setup file ${i + 1}`, async () => {
                  await click(tid('post-preview-file-select')); await click(page.getByRole('option', { name: new RegExp('^' + (i + 1) + ' of ') }))
                }, async () => {
                  const text = await tid('post-gcode-preview').innerText(), label = await tid('post-preview-file-select').innerText()
                  if (!label.startsWith(`${i + 1} of `) || !/G21/.test(text) || !/G5[4-9]/.test(text) || !/M(?:30|2)\b/.test(text)) return false
                  result.postedFiles.push({ label, bytes: text.length, workOffsetWords: [...new Set(text.match(/G5[4-9]/g))] }); return true
                })
              }
            }
            break
          case 'export': {
            let download
            await step('Export generated program through production button', async () => {
              const pending = page.waitForEvent('download'); await click(page.locator('.post-modal').getByRole('button', { name: /^Export \./ })); download = await pending
            }, async () => await download.failure() === null)
            // Browser's download is disposed with the context; no program is committed.
            break
          }
          case 'sketch':
            await tab('toolpath')
            await step('Reopen stored gear sketch', async () => {
              const edit = page.locator('.tree-layer-row').getByRole('button', { name: /^Edit (?:in )?Sketch$/i }).first()
              if (!await edit.isVisible()) {
                const row = page.locator('.tree-item-geo').first()
                const expand = row.getByRole('button', { name: 'Expand layers', exact: true })
                if (await expand.isVisible()) await click(expand)
              }
              await click(edit)
            }, () => tid('cam-sketch-dof-chip').isVisible()); break
          case 'finishSketch':
            await step('Finish stored sketch through real Finish button', () => click(button('Finish')), async () => !await tid('cam-sketch-dof-chip').isVisible()); break
          case 'gear':
            await step('Inspect native Gear parameters without drawing a replacement', () => click(button('Gear')), () => tid('gear-row').isVisible())
            result.gear = { teeth: await page.getByLabel('Gear teeth', { exact: true }).inputValue(), module: await page.getByLabel('Gear module', { exact: true }).inputValue() }; break
          case 'formCircular':
            await step('Set four circular Form copies through real input', async () => {
              const input = page.getByLabel('Circular copies', { exact: true })
              if (!await input.isVisible()) await click(tid('form-circular'))
              await input.fill('4'); await input.press('Enter')
            }, async () => await page.getByLabel('Circular copies', { exact: true }).inputValue() === '4'); break
          case 'formEdit': case 'reliefEdit':
            await editModel()
            result.renderer = await page.evaluate(() => {
              const gl = document.querySelector('[data-testid="solids-workbench-canvas"]')?.getContext('webgl2'), ext = gl?.getExtension('WEBGL_debug_renderer_info')
              return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '(unknown)'
            })
            await step('Wait for Model Ready before editing (exact handle checked after Finish)', async () => {}, async () => {
              const status = await tid('solids-workbench-status').innerText()
              if (/initialization failed|unavailable|failed to initialize/i.test(status)) throw new AppFailure('Model kernel failed: ' + status)
              return /Ready/i.test(status)
            })
            await step(`Edit saved ${s.action === 'formEdit' ? 'Lobed knob' : 'Relief'} feature`, async () => {
              const name = s.action === 'formEdit' ? 'Lobed knob' : 'Relief'
              await click(page.locator('[data-testid^="feature-row-"]').filter({ hasText: name }).first(), { button: 'right' })
              await click(tid('tree-context-menu-edit'))
            }, () => tid(s.action === 'formEdit' ? 'form-finish' : 'relief-cancel').isVisible()); break
          case 'formDisplay':
            await step(`Form display ${s.mode}`, () => click(tid(`form-display-${s.mode}`)), async () => (await tid(`form-display-${s.mode}`).getAttribute('aria-pressed')) === 'true' || (await tid(`form-display-${s.mode}`).getAttribute('class')).includes('active')); break
          case 'formFinish':
            await step('Finish Form and rebuild downstream features', () => click(tid('form-finish')), async () => {
              result.modelBodies = await page.evaluate(() => {
                const hooks = window.__solidsWorkbenchHooks
                return hooks.getExportBodies().map(body => ({ ...body, handle: hooks.getBodyHandle(body.id) ?? null }))
              })
              return !await tid('form-finish').isVisible() && /Ready/i.test(await tid('solids-workbench-status').innerText()) && result.modelBodies.some(body => !body.mesh && body.visible && body.handle !== null)
            })
            {
              const before = await camera()
              await step('Tighten finished Form framing with the real Model wheel', async () => {
                const r = await tid('solids-workbench-canvas').boundingBox(), to = { x: r.x + r.width / 2, y: r.y + r.height / 2 }
                await travel(page, pointer, to, 500); pointer = to
                for (let i = 0; i < 20; i++) { await page.mouse.wheel(0, -350 / 20); await page.waitForTimeout(50) }
              }, async () => JSON.stringify(await camera()) !== JSON.stringify(before))
            }
            await orbit([80, -50]); break
          case 'zebra':
            await step('Inspect finished skin with Zebra display', async () => { await click(tid('workbench-display-mode-btn')); await tid('workbench-zebra').check() }, () => tid('workbench-zebra').isChecked())
            await step('Close Model display flyout', () => click(tid('workbench-display-mode-btn')), async () => !await tid('workbench-display-mode-flyout').isVisible()); break
          case 'reliefStyle':
            await step(`Preview relief ${s.style}`, () => click(tid(`relief-dir-${s.style}`)), async () => (await tid(`relief-dir-${s.style}`).getAttribute('class')).includes('active')); break
          case 'reliefImage':
            await step('Open shipped medallion picture through real file picker', async () => {
              const chooser = page.waitForEvent('filechooser'); await click(tid('relief-open')); await (await chooser).setFiles(path.join(ROOT, 'examples/07-relief-medallion/medallion.png'))
            }, async () => await tid('relief-file-name').innerText() === 'medallion.png'); break
          case 'reliefCancel':
            await step('Cancel preview and keep shipped CAM geometry', () => click(tid('relief-cancel')), async () => !await tid('relief-cancel').isVisible()); break
          case 'simulator':
            await tab('control')
            if (!(await state()).machine.hasDefinition) {
              await step('Define sample machine with its existing travels for the simulator', async () => {
                await click(tid('control-view-machine')); await click(tid('machine-def-panel-define')); await click(tid('machine-def-panel-save'))
              }, async () => (await state()).machine.hasDefinition)
              await step('Return to Control main', () => click(tid('control-view-main')), () => tid('control-kind-select').isVisible())
            }
            await step('Connect exclusively to built-in simulator', async () => { await tid('control-kind-select').selectOption('simulator'); await click(tid('control-connect')) }, async () => await tid('control-disconnect').isVisible() && await tid('control-kind-select').inputValue() === 'simulator' && await page.getByText('LienCAM Simulated Controller', { exact: true }).isVisible())
            await step('Clear simulator software stop', async () => { const clear = button('CLEAR'); if (await clear.isVisible()) await click(clear) }, async () => !await button('CLEAR').isVisible())
            await step('Home simulator and read datum', () => click(tid('control-home')), async () => !await tid('control-datum-chip').isVisible() && /[0-9]/.test(await tid('control-dro-x').innerText()))
            result.controllerEvidence = 'Built-in simulator UI readback only. No physical controller connected; no board readback claimed.'
            await step('Open machine diagnostics and read the virtual contact part', async () => {
              await click(tid('control-view-machine')); await click(tid('control-machine-tab-diagnostics'))
            }, () => tid('simulated-part-position').isVisible())
            result.virtualPart = { position: await tid('simulated-part-position').innerText(), size: await tid('simulated-part-size').innerText(), bore: await tid('simulated-part-bore').innerText(), bow: await tid('simulated-part-bow').innerText() }
            await step('Return to simulator controls', () => click(tid('control-view-main')), () => tid('control-mdi-input').isVisible())
            await step('Open simulator probing', () => click(tid('control-view-probing')), () => tid('control-probing-panel').isVisible()); break
          case 'probe':
            await step(`Inspect ${s.kind} routine`, () => click(tid(`control-work-probe-routine-${s.kind}`)), () => tid('probing-step-card').isVisible())
            result.probeReadback = { routine: s.kind, sentence: await tid('probing-step-sentence').innerText(), result: await tid('control-work-probe-result').count() ? await tid('control-work-probe-result').innerText() : null }; break
          case 'probeNext': {
            const before = await tid('probing-step-sentence').innerText()
            await step('Next previews the next production motion', () => click(tid('probing-step-next')), async () => await tid('probing-step-sentence').innerText() !== before); break
          }
          case 'probeZero': {
            const numbers = text => [...text.matchAll(/-?\d+(?:\.\d+)?/g)].map(m => +m[0])
            const [x, y, z] = numbers(result.virtualPart.position), [sx, sy] = numbers(result.virtualPart.size)
            const target = { x: x + sx * .8, y: y + sy * .8, z: z + 5 }
            await step('Open main simulator controls for virtual Z0 approach', () => click(tid('control-view-main')), () => tid('control-mdi-input').isVisible())
            assert(await tid('control-kind-select').inputValue() === 'simulator' && await tid('control-disconnect').isVisible(), 'Z0 rehearsal must be isolated to the connected simulator')
            await step('Position only the simulator above a solid part of its virtual stock', async () => {
              const input = tid('control-mdi-input'); await input.fill(`G21 G90 G53 G0 X${target.x.toFixed(3)} Y${target.y.toFixed(3)} Z${target.z.toFixed(3)}`); await input.press('Enter')
            }, async () => /Idle/i.test(await tid('control-state-chip').innerText()) && Math.abs(parseFloat(await tid('control-dro-machine-z').inputValue()) - target.z) < .05)
            await step('Open Z0 production routine on the simulator', async () => { await click(tid('control-view-probing')); await click(tid('control-work-probe-routine-workZero')) }, () => tid('control-probe-run-guided').isEnabled())
            await step('Run virtual Z0 touches and read the written work reference', () => click(tid('control-probe-run-guided')), async () => {
              result.virtualZero = await tid('control-work-probe-z-set').innerText()
              return result.virtualZero.includes('Work Z0 set:')
            })
            break
          }
          case 'hold': await step('Hold final view', () => page.waitForTimeout(5000), async () => result.pageErrors.length === 0); break
          default: throw new Error('Unimplemented scripted action: ' + s.action)
        }
        result.completedScriptActions.push(s); save()
      }
      // Optional idle tail so a boot begun late in the story can reach its
      // 30-second liveness timeout (SolidsWorkbenchPage) before teardown.
      if (+process.env.CLIP_TAIL_MS > 0) { result.tailMs = +process.env.CLIP_TAIL_MS; await page.waitForTimeout(result.tailMs) }
      assert(result.completedScriptActions.length === sequence.steps.length, 'The script did not complete every declared story action')
      assert(result.steps.every(s => s.passed), 'Unasserted production step')
      assert(!result.pageErrors.length, 'Application page errors: ' + result.pageErrors.join('; '))
      assert(!result.consoleErrors.length, 'Application console errors: ' + result.consoleErrors.join('; '))
      result.status = 'PASS'
      await finishFrames(); finishFrames = null
      await context.close(); context = null
    })
  } catch (e) {
    result.status = e.message.startsWith('PLATFORM:') ? 'PLATFORM' : e instanceof AppFailure || result.pageErrors.length || result.consoleErrors.length ? 'BROKE-APP' : 'BROKE-SCRIPT'
    result.error = e.stack; result.reproduce = (dist ? `CLIP_PREVIEW_DIST=${dist} ` : '') + `node tools/capture/clips-v2/${id.toLowerCase()}.mjs`
    console.error(`[${id}] ${result.status}: ${e.message}`)
  } finally {
    if (finishFrames) await finishFrames().catch(e => { result.stripError = e.message })
    await context?.close(); await browser?.close()
    if (video) {
      const file = await video.path().catch(() => null)
      if (file) {
        try { result.strip = videoStrip(file, scratch, out) } catch (e) { result.stripError = e.message; if (result.status === 'PASS') result.status = 'PLATFORM' }
        // 10-09 keep-take: CLIP_KEEP_DIR (outside the repo) retains a PASS take as a candidate final,
        // H.264 1080p, with the run receipt beside it; without it the take stays disposable.
        if (process.env.CLIP_KEEP_DIR && result.status === 'PASS') {
          try {
            const keep = scratchFolder(process.env.CLIP_KEEP_DIR)
            execFileSync(process.env.FFMPEG_BIN || process.env.FFMPEG || 'ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', file, '-c:v', 'libx264', '-crf', '18', '-preset', 'slow', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(keep, `${id}.mp4`)], { maxBuffer: 8 * 1024 * 1024 })
            result.keptTake = path.join(keep, `${id}.mp4`)
            writeFileSync(path.join(keep, `${id}.run.json`), JSON.stringify(result, null, 2))
          } catch (e) { result.keepError = e.message }
        }
        rmSync(file, { force: true })
      }
    }
    if (result.status === 'PASS' && (result.pageErrors.length || result.consoleErrors.length)) {
      result.status = 'BROKE-APP'; result.error = 'Late application errors: ' + [...result.pageErrors, ...result.consoleErrors].join('; ')
      result.reproduce = (dist ? `CLIP_PREVIEW_DIST=${dist} ` : '') + `node tools/capture/clips-v2/${id.toLowerCase()}.mjs`
    }
    // WO-2106's bridge-host comments document these refused supervisor GETs.
    // The Linux simulator story completed; a Windows-only local service is
    // absent on Spark. Preserve every error rather than hiding this limitation.
    if (id === 'V07' && result.status === 'BROKE-APP' && result.pageErrors.length === 0 &&
        result.completedScriptActions.length === sequence.steps.length && result.steps.every(s => s.passed) &&
        result.consoleErrors.length > 0 && result.consoleErrors.every(e => e.includes('net::ERR_CONNECTION_REFUSED')) &&
        result.networkFailures.length === result.consoleErrors.length && result.networkFailures.every(r => r.method === 'GET' && /^http:\/\/127\.0\.0\.1:\d+\/status$/.test(r.url))) {
      result.status = 'PLATFORM'
      result.platformReason = 'No Windows bridge supervisor on Spark: ' + [...new Set(result.networkFailures.map(r => r.url))].join(', ') + '. All simulator UI steps and virtual Z0 readback completed; console errors are retained. Windows rehearsal remains due.'
    }
    result.runtimeSeconds = (Date.now() - epoch) / 1000; result.finishedAt = new Date().toISOString(); save()
  }
  return result
}
