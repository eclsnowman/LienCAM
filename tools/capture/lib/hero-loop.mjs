// node tools/capture/lib/hero-loop.mjs dist [--evidence src/tests/evidence/WO-2395/reshoot-1]
// Requires FFmpeg with libx264 and libwebp_anim; FFMPEG_BIN selects its executable.
import { isMain } from '../../lib/is-main.mjs';
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { writeFile as writeFileAsync } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { verifyBuild, withBuildServer } from './scene-runner.mjs'
import { CHROMIUM_CAPTURE_ARGS } from './harness.mjs'
import { readAppState } from '../../examples/lib/drive.mjs'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const json = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const ffmpeg = args => execFileSync(process.env.FFMPEG_BIN || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 8 * 1024 * 1024 })

// WO-2631 (the operator 10-07 11:35 AM, "35 s as planned"): paced for a first-time
// viewer. Sketch 6 s, generate 6 s, simulate 21 s of carving plus a 2 s hold
// on the finished part. The 11 s 1/2/8 loop flashed past.
export const HERO_STAGES = [{ id: 'sketch', seconds: 6 }, { id: 'generate', seconds: 6 }, { id: 'simulate', seconds: 23, finishedHoldSeconds: 2 }]
export const HERO_SECONDS = HERO_STAGES.reduce((n, s) => n + s.seconds, 0)
// Live UI transitions retain the approved wall-time span before the 35 s edit.
const FADE_STEP_MS = 150
const ORBIT_MS = 28_000

export function loadHeroScene(file = path.join(ROOT, 'tools/capture/scenes/S01.json')) {
  const scene = JSON.parse(readFileSync(file, 'utf8'))
  if (scene.version !== 1 || scene.id !== 'S01' || scene.theme !== 'dark' || scene.uiScale !== 1 ||
      scene.viewport?.width !== 1920 || scene.viewport?.height !== 1080 || scene.fps !== 24 ||
      JSON.stringify(scene.stages) !== JSON.stringify(HERO_STAGES) ||
      scene.sketchGeometry !== 'lettering' || scene.simulationOperation !== 'V-carve 1' || scene.playbackSpeed !== '50x' ||
      scene.cameraMotion !== 'top-to-three-quarter-orbit' || JSON.stringify(scene.stockOpacityKeyframes) !== '[1,0.15,1]' ||
      !scene.project?.startsWith('examples/') || scene.project.split(/[\\/]/).includes('..')) {
    throw new Error('S01 requires a repository example, 1920x1080, dark, 100%, and a 35 second sketch/generate/simulate loop')
  }
  return scene
}

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

// Embedded metadata travels with all three public files; private evidence is
// deliberately not a required sidecar in the public release.
export function embedProvenance(file, provenance) {
  const original = readFileSync(file)
  const text = JSON.stringify(provenance)
  if (file.endsWith('.png')) {
    const data = Buffer.from(`LienCAM provenance\0${text}`)
    const typeAndData = Buffer.concat([Buffer.from('tEXt'), data])
    const chunk = Buffer.alloc(data.length + 12)
    chunk.writeUInt32BE(data.length); typeAndData.copy(chunk, 4)
    chunk.writeUInt32BE(crc32(typeAndData), chunk.length - 4)
    writeFileSync(file, Buffer.concat([original.subarray(0, -12), chunk, original.subarray(-12)]))
  } else if (file.endsWith('.webp')) {
    if (original.toString('ascii', 12, 16) !== 'VP8X') throw new Error('Animated WebP needs VP8X')
    const data = Buffer.from(`<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:liencam="https://liencam.org/media/" liencam:provenance="${text.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"/></rdf:RDF></x:xmpmeta>`)
    const chunk = Buffer.alloc(8 + data.length + (data.length % 2))
    chunk.write('XMP '); chunk.writeUInt32LE(data.length, 4); data.copy(chunk, 8)
    const bytes = Buffer.concat([original, chunk])
    bytes[20] |= 0x04
    bytes.writeUInt32LE(bytes.length - 8, 4)
    writeFileSync(file, bytes)
  } else throw new Error('Only PNG and WebP need chunk metadata; MP4 uses FFmpeg metadata')
}

export async function runHeroLoop({ build, evidence = 'src/tests/evidence/WO-2395/reshoot-4', repoRoot = ROOT, frozenCommit }) {
  const scene = loadHeroScene()
  const receipt = verifyBuild(build, repoRoot)
  if (!receipt.demoBuild) throw new Error('Build with VITE_DEMO_BUILD=true npm run build:media')
  const output = path.join(repoRoot, 'docs/media')
  const out = path.resolve(repoRoot, evidence)
  const evidenceRoot = path.join(repoRoot, 'src/tests/evidence/WO-2395')
  const allowedEvidenceRoot = frozenCommit ? path.join(repoRoot, 'src/tests/evidence/WO-2631') : evidenceRoot
  if (!out.startsWith(`${allowedEvidenceRoot}${path.sep}`)) throw new Error('Evidence must stay under its work order')
  if (frozenCommit) {
    frozenCommit = execFileSync('git', ['rev-parse', frozenCommit], { cwd: repoRoot, encoding: 'utf8' }).trim()
    const changed = execFileSync('git', ['diff', '--name-only', frozenCommit, 'HEAD', '--', 'src', ':!src/tests', 'public', 'examples', 'index.html', 'package.json', 'package-lock.json', 'vite.config.mts'], { cwd: repoRoot, encoding: 'utf8' }).trim()
    if (changed) throw new Error(`Application differs from frozen build: ${changed}`)
  }
  mkdirSync(output, { recursive: true }); mkdirSync(out, { recursive: true })
  const names = ['S01.mp4', 'S01.webp', 'S01.png']
  // WO-2631 owns the public hero and MP4; the historical fallback masters stay
  // with WO-2395. Keep the fresh PNG in this take's evidence instead.
  const fileFor = name => frozenCommit && name === 'S01.webp' ? path.join(output, 'hero.webp') :
    frozenCommit && name === 'S01.png' ? path.join(out, name) : path.join(output, name)
  const previous = Object.fromEntries(names.map(name => [name, existsSync(fileFor(name)) ? statSync(fileFor(name)).mtimeMs : null]))
  for (const name of names) rmSync(fileFor(name), { force: true })
  for (const name of ['run.json', 'frame-strip.png', 'frame-strip.html', 'failed.png']) rmSync(path.join(out, name), { force: true })
  const captureArgs = process.env.HERO_CAPTURE_ANGLE
    ? CHROMIUM_CAPTURE_ARGS.map(arg => arg.startsWith('--use-angle=') ? `--use-angle=${process.env.HERO_CAPTURE_ANGLE}` : arg)
    : CHROMIUM_CAPTURE_ARGS
  const provenance = { schemaVersion: 1, sceneId: scene.id, buildCommit: frozenCommit || receipt.commit,
    captureCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim(), buildCaptureCommit: receipt.commit, buildHash: receipt.buildHash,
    sourceHash: receipt.sourceHash, sceneSha256: hash(readFileSync(path.join(ROOT, 'tools/capture/scenes/S01.json'))),
    project: scene.project, projectSha256: hash(readFileSync(path.join(ROOT, scene.project))),
    viewport: scene.viewport, theme: scene.theme, uiScale: scene.uiScale, fps: scene.fps, durationSeconds: HERO_SECONDS,
    simulationOperation: scene.simulationOperation, cameraMotion: scene.cameraMotion, stockOpacityKeyframes: scene.stockOpacityKeyframes, captureArgs,
    editing: `Production UI recording; three stages time-scaled to ${scene.stages.map(s => s.seconds).join('/')} seconds (finished hold ${scene.stages[2].finishedHoldSeconds} s); no test evidence frames.` }
  const result = { ...provenance, startedAt: new Date().toISOString(), status: 'running', actions: [], stages: [], transitions: [], files: {} }
  json(path.join(out, 'run.json'), result)
  const browser = await chromium.launch({ headless: true, args: captureArgs })
  let context, page, session
  try {
    await withBuildServer(build, async url => {
      try {
      context = await browser.newContext({ viewport: scene.viewport, deviceScaleFactor: 1,
        ...(!frozenCommit ? { recordVideo: { dir: out, size: scene.viewport } } : {}) })
      page = await context.newPage()
      page.setDefaultTimeout(30_000)
      const errors = []
      page.on('pageerror', error => errors.push(error.message))
      const wait = async (check, timeout = 120_000) => {
        const deadline = Date.now() + timeout
        do { if (await check()) return; await page.waitForTimeout(150) } while (Date.now() < deadline)
        throw new Error('S01 state check timed out')
      }
      const step = async (action, act, check, liveOnly = false) => {
        const entry = { action, passed: false }
        result.actions.push(entry)
        console.log(`[S01] ${action}`)
        try {
          await act(); await wait(check)
          const s = liveOnly ? null : await readAppState(page)
          entry.passed = true
          entry.readback = { projectId: s?.project.id, machine: s?.project.machine.name,
            activeOperationId: s?.project.activeOperationId,
            operations: s?.project.setups.flatMap(setup => setup.operations.map(o => ({ id: o.id, name: o.name, type: o.type, status: o.status }))),
            ...await page.evaluate(() => {
              const panel = document.querySelector('.sim-panel')
              return { sketchDefinition: document.querySelector('[data-testid="cam-sketch-dof-chip"]')?.textContent || null,
                simulation: panel ? { position: panel.querySelector('[aria-label="Simulation position"]')?.value,
                  totalMs: panel.querySelector('[aria-label="Simulation position"]')?.max,
                  resolution: panel.querySelector('.sim-res-select')?.value,
                  opacity: panel.querySelector('[data-testid="sim-stock-opacity"]')?.value,
                  displayMode: panel.querySelector('[aria-pressed="true"]')?.textContent,
                  hideToolpath: panel.querySelector('[data-testid="sim-hide-toolpath"]')?.checked,
                  stockSync: panel.getAttribute('data-stock-sync'), stockMs: panel.getAttribute('data-stock-ms') } : null }
            }) }
        } finally { json(path.join(out, 'run.json'), result) }
      }
      const cameraSample = () => page.evaluate(() => {
        const camera = window.__cncViewport?.getCamera()
        if (!camera) throw new Error('Production viewport camera readback missing')
        return { position: camera.position.toArray(), quaternion: camera.quaternion.toArray() }
      })
      const shading = async mode => {
        await page.getByRole('button', { name: 'Display mode', exact: true }).click()
        await page.getByTestId(`shading-${mode}`).check()
        await page.locator('.planes-flyout-close').click()
      }
      const fadeStock = async target => {
        const control = page.getByTestId('sim-stock-opacity')
        const start = Number(await control.inputValue())
        const samples = []
        for (let i = 1; i <= 17; i++) {
          const value = Math.round((start + (target - start) * i / 17) * 20) / 20
          await control.fill(String(value))
          await page.waitForTimeout(FADE_STEP_MS)
          samples.push(Number(await control.inputValue()))
        }
        result.transitions.push({ kind: 'stock-opacity', start, target, samples })
      }
      const epoch = Date.now()
      const frames = [], writes = [], diskErrors = []
      if (frozenCommit) {
        const raw = path.join(out, 'raw'); mkdirSync(raw, { recursive: true })
        session = await context.newCDPSession(page)
        session.on('Page.screencastFrame', event => {
          // V01's smooth-capture method: ack before asynchronous disk I/O,
          // preserve real timestamps, and avoid Playwright's 25 fps recorder.
          session.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {})
          const name = `frame-${String(frames.length).padStart(6, '0')}.jpg`
          writes.push(writeFileAsync(path.join(raw, name), Buffer.from(event.data, 'base64')).catch(error => diskErrors.push(error.message)))
          frames.push({ name, timestamp: event.metadata.timestamp })
        })
        await session.send('Page.startScreencast', { format: 'jpeg', quality: 95, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 })
      }
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 })
      await page.locator('#liencam-splash').waitFor({ state: 'hidden' })
      await step('Start with an empty project', () => page.getByRole('button', { name: 'Start with an empty project', exact: true }).click(),
        async () => !await page.getByRole('dialog', { name: 'Open a project' }).count())
      await step('Set dark theme and UI scale 100%', async () => {
        await page.getByRole('button', { name: 'Application settings', exact: true }).click()
        await page.getByTestId('settings-interface-scale').click()
        await page.getByRole('option', { name: '100%', exact: true }).click()
        await page.getByTestId('settings-light-mode').uncheck()
        await page.locator('.settings-modal .modal-close-btn').click()
      }, async () => await page.locator('.app-shell').getAttribute('data-ui-scale') === '1' && await page.locator('html').getAttribute('data-color-mode') !== 'light')
      const kit = JSON.parse(readFileSync(path.join(ROOT, scene.project), 'utf8'))
      await step('Open current name-sign lettering', async () => {
        const chooser = page.waitForEvent('filechooser')
        await page.getByRole('button', { name: 'Open project', exact: true }).click()
        const picker = page.getByRole('dialog', { name: 'Open a project' })
        if (await picker.isVisible()) await picker.getByRole('button', { name: 'Browse...' }).click()
        await (await chooser).setFiles(path.join(ROOT, scene.project))
      }, async () => (await readAppState(page))?.project.id === kit.id && !await page.getByTestId('project-open-indicator').count())
      if (await page.getByRole('button', { name: 'Use this machine', exact: true }).isVisible()) {
        await step('Choose generic starter machine', async () => {
          await page.locator('.machine-choice-item').filter({ hasText: 'Sample hobby router' }).click()
          await page.getByRole('button', { name: 'Use this machine', exact: true }).click()
        }, async () => !await page.getByRole('button', { name: 'Use this machine', exact: true }).count())
      }
      await step('Verify generic starter machine', async () => {}, async () => (await readAppState(page))?.project.machine.name === 'Sample hobby router (GRBL)')
      await step('Open Toolpath', () => page.getByTestId('mode-tab-toolpath').click(), async () => (await page.getByTestId('mode-tab-toolpath').getAttribute('class')).includes('mode-tab-active'))
      await step('Frame the sign stock in top view without the grid', async () => {
        await page.mouse.click(1200, 350, { button: 'right' })
        await page.getByRole('menuitem', { name: 'Fit all', exact: true }).click()
        await page.mouse.click(1200, 350, { button: 'right' })
        await page.getByRole('menuitem', { name: 'Top view', exact: true }).click()
        const grid = page.getByRole('button', { name: 'Toggle grid', exact: true })
        if ((await grid.getAttribute('class')).includes('vp-btn-on')) await grid.click()
        await page.mouse.move(970, 537); await page.mouse.wheel(0, -700)
        await page.waitForTimeout(600)
      }, async () => !await page.getByRole('menuitem', { name: 'Top view', exact: true }).isVisible())
      const time = () => (Date.now() - epoch) / 1000
      // The sketch stage opens on the tree click, so the viewer sees the
      // lettering enter Sketch, then holds on the solved profile.
      await page.waitForTimeout(800)
      const sketchStart = time()
      await step('Edit imported profile through Edit in Sketch', async () => {
        const row = page.locator('.tree-item-geo').filter({ has: page.getByTestId('tree-name-geometry').filter({ hasText: scene.sketchGeometry }) })
        await row.click()
        // Layer controls are siblings of the geometry header. Lettering is
        // the first imported layer; scope to its layer row.
        const edit = page.locator('.tree-layer-row').getByRole('button', { name: 'Edit in Sketch', exact: true }).first()
        if (!await edit.isVisible()) await row.getByRole('button', { name: 'Expand layers', exact: true }).click()
        await edit.click()
      }, async () => await page.getByTestId('cam-sketch-dof-chip').isVisible())
      await step('Read the solver verdict on the fixed imported profile', async () => {}, async () => (await page.getByTestId('cam-sketch-dof-chip').textContent()).includes('Fully defined'))
      await page.mouse.move(1910, 1070)
      await page.waitForTimeout(4000)
      await page.screenshot({ path: path.join(out, 'sketch.png') })
      result.stages.push({ id: 'sketch', start: sketchStart, end: time(), seconds: scene.stages[0].seconds })
      const generateStart = time()
      // Current imported kit loop IDs are referenced by CAM. Finish rebakes
      // them and breaks those references (see finish-rebake-red evidence).
      // Cancel exits this inspection through the real UI without reauthoring
      // the kit; no source/store mutation masks the failure.
      await step('Exit sketch inspection with Cancel, preserving kit loop IDs', () => page.getByRole('button', { name: 'Cancel', exact: true }).click(), async () => !await page.getByTestId('cam-sketch-dof-chip').count())
      await step('Select the name-sign V-carve for generation and simulation', () => page.locator('.tree-op').filter({ hasText: scene.simulationOperation }).click(),
        async () => (await readAppState(page))?.project.activeOperationId === kit.setups.flatMap(s => s.operations).find(o => o.name === scene.simulationOperation).id)
      await step('Regenerate the lettering through its Regenerate button', () => page.getByRole('button', { name: 'Regenerate', exact: true }).click(), async () => {
        const ops = (await readAppState(page))?.project.setups.flatMap(s => s.operations) || []
        const selected = ops.find(o => o.name === scene.simulationOperation)
        if (selected?.status === 'error') throw new Error('Current lettering operation failed to generate')
        // Autosave can still report the previous ready snapshot just after
        // REGEN ALL. The live footer also has to finish the whole batch.
        return selected?.status === 'ready' &&
          await page.locator('.status-bar .status-item').first().innerText() === 'Ready' &&
          !await page.locator('.status-batch').count()
      })
      await step('Reveal generated toolpaths with Translucent display mode', () => shading('translucent'),
        async () => { await page.getByRole('button', { name: 'Display mode', exact: true }).click()
          const checked = await page.getByTestId('shading-translucent').isChecked()
          await page.locator('.planes-flyout-close').click(); return checked })
      await page.mouse.move(1910, 1070); await page.waitForTimeout(2000)
      await page.screenshot({ path: path.join(out, 'generate.png') })
      await step('Open Simulation', () => page.getByTestId('mode-tab-simulation').click(), () => page.getByRole('slider', { name: 'Simulation position' }).isVisible())
      const slider = page.getByRole('slider', { name: 'Simulation position' })
      await step('Enable production stock removal', async () => {
        await page.getByLabel('Simulate Stock Removal', { exact: true }).check()
        await page.getByTestId('sim-hide-toolpath').uncheck()
        await page.getByTestId('sim-display-compare').click()
        await shading('shaded-edges')
        await page.locator('.sim-res-select').selectOption('0.5')
      }, () => page.getByLabel('Simulate Stock Removal', { exact: true }).isChecked())
      await step('Seek to the uncut beginning and wait for exact stock', async () => {
        await wait(async () => Number(await slider.getAttribute('max')) > 0)
        await slider.fill('0')
      }, async () => await page.locator('.sim-panel').getAttribute('data-stock-sync') === 'exact' &&
        Math.abs(Number(await page.locator('.sim-panel').getAttribute('data-stock-ms')) - Number(await slider.inputValue())) <= 1)
      await step('Set playback speed through the speed control', async () => {
        await page.getByTestId('sim-speed-chip').click()
        await page.getByTestId('sim-speed-flyout').getByRole('button', { name: scene.playbackSpeed, exact: true }).click()
      }, async () => (await page.getByTestId('sim-speed-chip').innerText()).includes(scene.playbackSpeed))
      await step('Fade stock to reveal toolpaths at Generate to Simulate transition', () => fadeStock(0.15),
        async () => await page.getByTestId('sim-stock-opacity').inputValue() === '0.15' && !await page.getByTestId('sim-hide-toolpath').isChecked(), true)
      await page.mouse.move(1910, 1070); await page.waitForTimeout(900)
      await page.screenshot({ path: path.join(out, 'toolpaths-through-stock.png') })
      result.stages.push({ id: 'generate', start: generateStart, end: time(), seconds: scene.stages[1].seconds })
      const simulateStart = time()
      await step('Restore solid stock through the opacity control before cutting', () => fadeStock(1),
        async () => await page.getByTestId('sim-stock-opacity').inputValue() === '1', true)
      await step('Show solid Cut Stock and hide path lines for the carve', async () => {
        await page.getByTestId('sim-display-stock').click()
        await page.getByTestId('sim-hide-toolpath').check()
      }, async () => await page.getByTestId('sim-display-stock').getAttribute('aria-pressed') === 'true' && await page.getByTestId('sim-hide-toolpath').isChecked(), true)
      await page.screenshot({ path: path.join(out, 'stock-before.png') })
      const initialPosition = Number(await slider.inputValue())
      await step('Play production simulation', () => page.getByRole('button', { name: 'Play', exact: true }).click(), () => page.getByRole('button', { name: 'Pause', exact: true }).isVisible(), true)
      await page.mouse.move(1910, 1070)
      await step('Smoothly orbit from top to three-quarter view while letters are cut', async () => {
        const samples = [await cameraSample()]
        // Preset view buttons snap. The built-in left-drag orbit is the live
        // production camera control; no synthetic camera frames or writes.
        await page.mouse.move(1260, 730); await page.mouse.down()
        const start = performance.now(), rawStart = time()
        try {
          // WO-2631: twenty 1.4 s holds survived the edit as visible camera
          // jumps. Follow wall time with sub-frame drags, as V01 does; never
          // queue catch-up input or alter the production OrbitControls camera.
          while (performance.now() - start < ORBIT_MS) {
            const t = Math.min(1, (performance.now() - start) / ORBIT_MS)
            // Settle into the final view gradually: its stronger foreshortening
            // otherwise concentrates visible movement near the end of the turn.
            const u = t * (2 - t)
            await page.mouse.move(1260 - 55 * u, 730 - 180 * u)
            await page.waitForTimeout(Math.max(0, Math.min(1000 / 120, start + ORBIT_MS - performance.now())))
          }
          await page.mouse.move(1205, 550)
          samples.push(await cameraSample())
        } finally { await page.mouse.up() }
        await page.mouse.move(1910, 1070)
        result.transitions.push({ kind: 'camera-orbit', rawStart, rawEnd: time(), samples })
      }, async () => {
        const samples = result.transitions.find(t => t.kind === 'camera-orbit').samples
        return Math.abs(samples.at(-1).quaternion[0] - samples[0].quaternion[0]) > 0.1
      }, true)
      let playbackEnd
      await step('Read back advancing simulation and finished lettering', async () => {
        // The production range has step=1 while totalMs can be fractional.
        // Its last representable value is within 1 ms of the frame duration.
        await wait(async () => Math.abs(Number(await slider.inputValue()) - Number(await slider.getAttribute('max'))) <= 1 &&
          await page.getByRole('button', { name: 'Play', exact: true }).isVisible(), 180_000)
      }, async () => {
        const exact = Number(await slider.inputValue()) > initialPosition &&
          await page.locator('.sim-panel').getAttribute('data-stock-sync') === 'exact' && !await page.getByTestId('sim-frame-error').isVisible()
        if (exact) playbackEnd = time()
        return exact
      }, true)
      // Give the exact stock a rendered frame, then hold the finished part
      // in the edited loop so its last 1 fps samples contain all seven letters.
      await page.waitForTimeout(400)
      await page.screenshot({ path: fileFor('S01.png') })
      await page.screenshot({ path: path.join(out, 'finished-tilted.png') })
      result.stages.push({ id: 'simulate', start: simulateStart, end: time(), playbackEnd, seconds: scene.stages[2].seconds, finishedHoldSeconds: scene.stages[2].finishedHoldSeconds })
      if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`)
      if (session) {
        await session.send('Page.stopScreencast')
        await Promise.all(writes)
        if (diskErrors.length) throw new Error(`Capture writes failed: ${diskErrors.join('; ')}`)
        const concat = frames.map((frame, i) => `file '${frame.name}'\noption framerate 1000\nduration ${Math.max(.001, (frames[i + 1]?.timestamp ?? frame.timestamp + 1 / 60) - frame.timestamp).toFixed(6)}\n`).join('') + `file '${frames.at(-1).name}'\noption framerate 1000\n`
        writeFileSync(path.join(out, 'raw/frames.txt'), concat)
        result.captureFrames = frames
        result.videoEpochSeconds = frames[0].timestamp - epoch / 1000
        result.recording = 'raw/frames.txt'
      }
      const video = page.video()
      await context.close(); context = null
      if (video) result.recording = path.basename(await video.path())
      } catch (error) {
        await page?.screenshot({ path: path.join(out, 'failed.png') }).catch(() => {})
        // Close the page before the build server waits for its open requests.
        // Otherwise a failed state check can deadlock server cleanup.
        await context?.close(); context = null
        throw error
      }
    })
    const raw = path.join(out, result.recording)
    // Each segment contains only the recorded production page. Compress wait
    // time explicitly instead of substituting engine renders or test images.
    const filters = result.stages.map((s, i) => {
      const end = s.playbackEnd || s.end
      const movingSeconds = s.seconds - (s.finishedHoldSeconds || 0)
      const offset = result.videoEpochSeconds || 0
      return `[0:v]trim=start=${s.start - offset}:end=${end - offset},setpts=${movingSeconds / (end - s.start)}*(PTS-STARTPTS),fps=${scene.fps},tpad=stop_mode=clone:stop_duration=${(s.finishedHoldSeconds || 0) + 1},trim=duration=${s.seconds},setsar=1[v${i}]`
    }).join(';') + ';[v0][v1][v2]concat=n=3:v=1:a=0[out]'
    ffmpeg([...(frozenCommit ? ['-f', 'concat', '-safe', '0'] : []), '-i', raw, '-filter_complex', filters, '-map', '[out]', '-an', '-c:v', 'libx264', '-threads', '2', '-preset', 'medium', '-crf', '22', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-metadata', 'title=S01 hero-loop', '-metadata', `comment=${JSON.stringify(provenance)}`, path.join(output, 'S01.mp4')])
    // WO-3091: q90 - at q65 libwebp_anim (no keyframes after frame 1) left ghost streaks on the stock.
    ffmpeg(['-i', path.join(output, 'S01.mp4'), '-vf', 'fps=12,scale=1280:720', '-an', '-c:v', 'libwebp_anim', '-quality', '90', '-compression_level', '4', '-loop', '0', fileFor('S01.webp')])
    embedProvenance(fileFor('S01.webp'), provenance)
    embedProvenance(fileFor('S01.png'), provenance)
    if (statSync(fileFor('S01.webp')).size >= 8_000_000) throw new Error('Animated WebP must be under 8 MB')
    execFileSync(process.env.FFMPEG_BIN || 'ffmpeg', ['-hide_banner', '-i', path.join(output, 'S01.mp4'), '-f', 'null', '-'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    result.decodePassed = true
    for (const name of names) {
      const file = fileFor(name), bytes = readFileSync(file)
      result.files[name] = { bytes: bytes.length, sha256: hash(bytes), previousMtimeMs: previous[name], mtimeMs: statSync(file).mtimeMs }
      result.files[name].replaced = previous[name] === null || result.files[name].mtimeMs > previous[name]
    }
    ffmpeg(['-i', path.join(output, 'S01.mp4'), '-vf', 'fps=1,scale=480:270', '-frames:v', String(HERO_SECONDS), path.join(out, 'frame-%02d.png')])
    const sketchEnd = scene.stages[0].seconds, generateEnd = sketchEnd + scene.stages[1].seconds
    const cards = Array.from({ length: HERO_SECONDS }, (_, i) => `<figure><img src="data:image/png;base64,${readFileSync(path.join(out, `frame-${String(i + 1).padStart(2, '0')}.png`)).toString('base64')}"><figcaption>${i}s - ${i < sketchEnd ? 'Sketch' : i < generateEnd ? 'Generate' : 'Simulate'}</figcaption></figure>`).join('')
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;padding:16px;background:#12161c;color:#eee;font:16px Arial}h1{font-size:22px}main{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}figure{margin:0}img{width:100%}figcaption{padding:4px}</style></head><body><h1>S01 hero loop - ${HERO_SECONDS} seconds - 1 fps frame strip</h1><p>Build ${receipt.commit} | Current kit: ${scene.project} | Architect: compare with the live app before the operator's picture verdict.</p><main>${cards}</main></body></html>`
    writeFileSync(path.join(out, 'frame-strip.html'), html)
    const strip = await browser.newPage({ viewport: { width: 1920, height: 1020 } })
    await strip.setContent(html)
    await strip.locator('img').evaluateAll(images => Promise.all(images.map(image => image.decode())))
    await strip.screenshot({ path: path.join(out, 'frame-strip.png'), fullPage: true })
    await strip.close()
    result.status = 'passed'
    json(path.join(out, 'run.json'), result)
    return result
  } catch (error) {
    result.status = 'failed'; result.error = error.stack || error.message
    await page?.screenshot({ path: path.join(out, 'failed.png') }).catch(() => {})
    // Failed runs never leave previous or partly encoded masters publishable.
    for (const name of names) rmSync(fileFor(name), { force: true })
    json(path.join(out, 'run.json'), result)
    throw error
  } finally {
    if (context) await context.close()
    await browser.close()
  }
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2)
  try {
    if (!args[0]) throw new Error('Usage: node tools/capture/lib/hero-loop.mjs <build-directory> [--evidence src/tests/evidence/WO-2395/run-N]')
    await runHeroLoop({ build: path.resolve(args[0]), evidence: args.includes('--evidence') ? args[args.indexOf('--evidence') + 1] : undefined,
      frozenCommit: args.includes('--frozen-commit') ? args[args.indexOf('--frozen-commit') + 1] : undefined })
  } catch (error) { console.error(error.stack || error); process.exitCode = 1 }
}
