import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { captureSourceProvenance, captureProvenancedScreenshot } from './provenance.mjs'
import { CHROMIUM_CAPTURE_ARGS, persistCaptureProvenance } from './harness.mjs'
import { readAppState } from '../../examples/lib/drive.mjs'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const RECEIPT = 'liencam-build.json'
const BUILD_SOURCE = ['src', 'index.html', 'vite.config.mts', 'package.json', 'package-lock.json']
const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)

export function loadScenes(file = path.join(ROOT, 'tools/capture/scenes.json')) {
  const list = JSON.parse(readFileSync(file, 'utf8'))
  const expected = [...Array.from({ length: 15 }, (_, n) => `S${String(n + 2).padStart(2, '0')}`), 'SP']
  if (list.version !== 1 || list.uiScale !== 1 || list.theme !== 'dark' ||
      list.viewport?.width !== 1920 || list.viewport?.height !== 1080 ||
      JSON.stringify(list.scenes?.map(s => s.id)) !== JSON.stringify(expected)) {
    throw new Error('Scene list must declare S02..S16 and SP, 1920x1080, dark, scale 100%')
  }
  for (const scene of list.scenes) {
    if (!scene.name || !scene.view) throw new Error(`${scene.id}: name and view required`)
    for (const relative of [scene.project, scene.image, scene.tools].filter(Boolean)) {
      if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..') || /tests[\\/]evidence/.test(relative)) {
        throw new Error(`${scene.id}: scene input must be a repository example or brand asset, never evidence`)
      }
    }
    const size = scene.viewport || list.viewport
    if (size.width !== (scene.id === 'SP' ? 1280 : 1920) || size.height !== (scene.id === 'SP' ? 640 : 1080)) {
      throw new Error(`${scene.id}: invalid capture size`)
    }
  }
  return list
}

export function buildHash(build) {
  const digest = createHash('sha256')
  const visit = relative => {
    for (const entry of readdirSync(path.join(build, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.join(relative, entry.name)
      if (name === RECEIPT) continue
      if (entry.isSymbolicLink()) throw new Error('Build must contain regular files, not symlinks')
      if (entry.isDirectory()) visit(name)
      else {
        const bytes = readFileSync(path.join(build, name))
        digest.update(`${name.split(path.sep).join('/')}\0${bytes.length}\0`).update(bytes)
      }
    }
  }
  visit('')
  return digest.digest('hex')
}

// Called at the END of npm run build:media, while source and output are known to
// belong together. A later capture refuses changed source or changed bundles.
export function stampBuild(build, repoRoot = ROOT) {
  if (!existsSync(path.join(build, 'index.html'))) throw new Error(`No release build at ${build}`)
  const receipt = { schemaVersion: 1, ...captureSourceProvenance({ repoRoot, sourcePaths: BUILD_SOURCE }),
    buildHash: buildHash(build), demoBuild: process.env.VITE_DEMO_BUILD === 'true' }
  if (receipt.workingTreeDirty) throw new Error('Build identity requires committed application source')
  writeJson(path.join(build, RECEIPT), receipt)
  console.log(`Release build stamped: ${receipt.commit} ${receipt.buildHash}`)
  return receipt
}

export function verifyBuild(build, repoRoot = ROOT) {
  const receipt = JSON.parse(readFileSync(path.join(build, RECEIPT), 'utf8'))
  const source = captureSourceProvenance({ repoRoot, sourcePaths: BUILD_SOURCE })
  if (receipt.schemaVersion !== 1 || receipt.workingTreeDirty || !/^[a-f0-9]{40}$/.test(receipt.commit) ||
      receipt.sourceHash !== source.sourceHash || source.workingTreeDirty || receipt.buildHash !== buildHash(build)) {
    throw new Error('Release build identity differs from its receipt. Run npm run build:media again.')
  }
  return receipt
}

export async function withBuildServer(build, run) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' }
  const server = createServer((req, res) => {
    try {
      const relative = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).replace(/^\/+/, '') || 'index.html'
      const file = path.resolve(build, relative)
      if (!file.startsWith(`${build}${path.sep}`) || !existsSync(file) || !statSync(file).isFile()) {
        res.writeHead(404).end(); return
      }
      res.setHeader('content-type', types[path.extname(file)] || 'application/octet-stream')
      res.end(readFileSync(file))
    } catch { res.writeHead(400).end() }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  try { return await run(`http://127.0.0.1:${server.address().port}/`) }
  finally { await new Promise(resolve => server.close(resolve)) }
}

async function waitCheck(page, check, timeout = 30_000) {
  const deadline = Date.now() + timeout
  do {
    if (await check()) return true
    await page.waitForTimeout(150)
  } while (Date.now() < deadline)
  throw new Error('State check timed out after 30 seconds')
}

async function prepareScene(page, scene, log) {
  const step = async (action, act, check) => {
    const entry = { action, passed: false }
    log.push(entry)
    console.log(`[${scene.id}] ${action}`)
    await act()
    await waitCheck(page, check)
    entry.passed = true
    const snapshot = await readAppState(page)
    entry.readback = { projectId: snapshot?.project.id, projectName: snapshot?.project.name,
      machine: snapshot?.project.machine?.name,
      activeOperationId: snapshot?.project.activeOperationId,
      operations: snapshot?.project.setups.flatMap(s => s.operations.map(o => ({ name: o.name, type: o.type, status: o.status }))) }
    if (scene.view === 'control' && await page.getByTestId('control-dro-work-x').first().isVisible()) {
      entry.simulatorReadback = await page.evaluate(() => ({
        state: document.querySelector('[data-testid="control-state-chip"]')?.textContent,
        homed: document.querySelector('[data-testid="control-homed-led"]')?.classList.contains('control-led-ok'),
        work: ['x', 'y', 'z'].map(axis => document.querySelector(`[data-testid="control-dro-work-${axis}"]`)?.value),
        machine: ['x', 'y', 'z'].map(axis => document.querySelector(`[data-testid="control-dro-machine-${axis}"]`)?.value),
        progress: document.querySelector('[data-testid="control-progress-text"]')?.textContent,
      }))
    }
    console.log(`[${scene.id}] state check passed`)
  }
  const visible = id => page.getByTestId(id).isVisible()
  const tab = async (id, check) => step(`Open ${id}`, () => page.getByTestId(`mode-tab-${id}`).click(), check)
  // WO-2700: the plain Model tab now offers a NEW model. Every scene here
  // pictures the kit's own model, so open it the operator's way: the
  // "Edit model" button on its design-tree row.
  const editModel = async check => {
    await step('Edit model from its design-tree row', () => page.locator('[data-testid^="model-edit-btn-"]').first().click(), check)
    // Opening the model regenerates it; picture the finished bodies, not a
    // half-built tree (no feature dirty or running, at least one body).
    await step('Wait for the kit model to finish regenerating', async () => {}, async () =>
      await page.locator('[data-testid="feature-status-badge"][data-status="dirty"], [data-testid="feature-status-badge"][data-status="running"]').count() === 0 &&
      await page.locator('[data-testid^="body-volume-"]').count() > 0)
  }
  const state = () => readAppState(page)
  const picker = page.getByRole('dialog', { name: 'Try an example' })
  await picker.waitFor()
  await page.locator('#liencam-splash').waitFor({ state: 'hidden' })
  if (scene.view === 'demo') {
    const predicate = async () => await picker.isVisible() &&
      await page.locator('.app-shell').getAttribute('data-ui-scale') === '1' &&
      await page.locator('html').getAttribute('data-color-mode') !== 'light'
    await waitCheck(page, predicate)
    log.push({ action: 'Production demo first-open picker, dark theme, 100% scale', passed: true })
    return predicate
  }
  await step('Start with an empty project', () => page.getByRole('button', { name: 'Start with an empty project' }).click(), async () => !await picker.count())
  await step('Set interface scale to 100% and color mode', async () => {
    await page.getByRole('button', { name: 'Application settings', exact: true }).click()
    await page.getByTestId('settings-interface-scale').click()
    await page.getByRole('option', { name: '100%', exact: true }).click()
    await page.getByTestId('settings-light-mode').setChecked(scene.theme === 'light')
    await page.locator('.settings-modal .modal-close-btn').click()
  }, async () => await page.locator('.app-shell').getAttribute('data-ui-scale') === '1' &&
      (await page.locator('html').getAttribute('data-color-mode') === 'light') === (scene.theme === 'light'))
  if (scene.project) {
    const project = JSON.parse(readFileSync(path.join(ROOT, scene.project), 'utf8'))
    await step(`Open kit example ${scene.project}`, async () => {
      const chooser = page.waitForEvent('filechooser')
      await page.getByRole('button', { name: 'Open project', exact: true }).click()
      await (await chooser).setFiles(path.join(ROOT, scene.project))
    }, async () => (await state())?.project.id === project.id && !await page.getByTestId('project-open-indicator').count())
    const machine = page.getByRole('button', { name: 'Use this machine', exact: true })
    if (await machine.isVisible()) {
      await step('Choose sample hobby router', async () => {
        await page.locator('.machine-choice-item').filter({ hasText: 'Sample hobby router' }).click()
        await machine.click()
      }, async () => !await machine.count())
    }
    await step('Verify generic starter machine', async () => {}, async () => (await state())?.project.machine.name === 'Sample hobby router (GRBL)')
  }
  if (['toolpath', 'toolpath3d', 'simulate', 'post', 'control', 'social'].includes(scene.view)) {
    await tab('toolpath', async () => page.getByTestId('mode-tab-toolpath').getAttribute('class').then(s => s.includes('mode-tab-active')))
    await step('Wait for production toolpaths', async () => {}, async () => {
      const ops = (await state())?.project.setups.flatMap(s => s.operations) || []
      if (ops.some(o => o.status === 'error')) throw new Error('Kit operation failed to compute')
      return ops.length > 0 && ops.every(o => o.status === 'ready')
    })
    await step('Show the complete setup, not one operation', async () => {
      await page.locator('.tree-setup-header').first().click()
      if (await page.locator('.tree-op').count() === 0) await page.locator('.tree-setup-header').first().click()
    }, async () => (await state())?.project.activeOperationId === null)
  }
  switch (scene.view) {
    case 'toolpath': case 'toolpath3d':
      return async () => (await page.getByTestId('mode-tab-toolpath').getAttribute('class')).includes('mode-tab-active')
    case 'model': case 'social':
      await editModel(() => visible('feature-tree'))
      if (scene.view === 'social') {
        await step('Wait for the finished knob body, not only its feature tree', async () => {}, async () => {
          const volume = page.getByTestId('body-volume-RIMF')
          return await volume.isVisible() && parseFloat(await volume.innerText()) > 0
        })
        log.at(-1).bodyVolumeMm3 = parseFloat(await page.getByTestId('body-volume-RIMF').innerText())
        return async () => parseFloat(await page.getByTestId('body-volume-RIMF').innerText()) > 0
      }
      return () => visible('feature-tree')
    case 'sketch':
      await editModel(() => visible('feature-tree'))
      await step('Edit kit profile sketch', async () => {
        await page.getByTestId('feature-row-sketch3d:SK1').click({ button: 'right' })
        await page.getByTestId('tree-context-menu-edit').click()
      }, () => visible('workbench-package-sketch-tools'))
      return () => visible('workbench-package-sketch-tools')
    case 'form':
      await editModel(() => visible('feature-tree'))
      await step('Edit knob Form cage', async () => {
        await page.getByTestId('feature-row-FRM1').click({ button: 'right' })
        await page.getByTestId('tree-context-menu-edit').click()
      }, () => visible('form-palette'))
      return () => visible('form-palette')
    case 'relief':
      await editModel(() => visible('workbench-modeling-toolbar'))
      await step('Open Relief', () => page.getByTestId('workbench-relief').click(), () => visible('relief-palette'))
      await step('Open approved brand picture', async () => {
        const raster = await page.context().newPage()
        try {
          await raster.setViewportSize({ width: 256, height: 256 })
          const svg = readFileSync(path.join(ROOT, scene.image)).toString('base64')
          await raster.setContent(`<body style="margin:0;background:black"><img width="256" height="256" src="data:image/svg+xml;base64,${svg}"></body>`)
          await raster.locator('img').evaluate(image => image.decode())
          await page.getByTestId('relief-file-input').setInputFiles({ name: 'LienCAM-mark.png', mimeType: 'image/png', buffer: await raster.screenshot() })
        } finally { await raster.close() }
      }, () => visible('relief-file-name'))
      await step('Lay picture on flat jaw face', async () => {
        // WO-2708: a fixed pixel stopped landing on the jaw once the Model
        // layout moved. Ask the live viewport where each kit body's top face
        // is and click real points on it until the Relief takes a face.
        const ids = await page.locator('[data-testid^="body-volume-"]').evaluateAll(els => els.map(e => e.dataset.testid.slice('body-volume-'.length)))
        const points = await page.evaluate(ids => {
          const h = window.__solidsWorkbenchHooks, r = document.querySelector('[data-testid="solids-workbench-canvas"]').getBoundingClientRect(), out = []
          for (const id of ids) {
            const top = h.getBodyTopPoint(id); if (!top) continue
            for (const [dx, dy] of [[0, 0], [-25, 0], [25, 0], [0, -6], [0, 6], [-35, 0], [35, 0], [-15, 0], [15, 0]]) {
              const p = h.projectToCanvas({ x: top.x + dx, y: top.y + dy, z: top.z - 0.01 })
              if (p) out.push({ id, dx, dy, x: r.left + p.x, y: r.top + p.y })
            }
          }
          return out
        }, ids)
        for (const p of points) {
          await page.mouse.click(p.x, p.y)
          if (await page.getByTestId('relief-apply').isEnabled({ timeout: 1500 }).catch(() => false)) { log.at(-1).facePoint = p; break }
          await page.waitForTimeout(400)
          if (await page.getByTestId('relief-apply').isEnabled()) { log.at(-1).facePoint = p; break }
        }
      }, () => page.getByTestId('relief-apply').isEnabled())
      return () => page.getByTestId('relief-apply').isEnabled()
    case 'setup':
      await tab('setup', async () => page.getByTestId('mode-tab-setup').getAttribute('class').then(s => s.includes('mode-tab-active')))
      return async () => (await state())?.project.geometry.filter(g => g.workholding).length >= 2
    case 'simulate': {
      await tab('simulation', () => page.getByRole('slider', { name: 'Simulation position' }).isVisible())
      const slider = page.getByRole('slider', { name: 'Simulation position' })
      await step('Enable production stock removal', async () => {
        await page.getByLabel('Simulate Stock Removal', { exact: true }).check()
        await page.getByTestId('sim-hide-toolpath').check()
        await page.getByTestId('sim-display-stock').click()
      }, () => page.getByLabel('Simulate Stock Removal', { exact: true }).isChecked())
      await step('Seek to middle of real cut', async () => {
        await slider.focus()
        await waitCheck(page, async () => Number(await slider.getAttribute('max')) > 0)
        const max = Number(await slider.getAttribute('max'))
        await slider.fill(String(Math.round(max * 0.55)))
      }, async () => {
        const value = Number(await slider.inputValue()), max = Number(await slider.getAttribute('max'))
        const panel = page.locator('.sim-panel')
        return value > 0 && value < max && !await visible('sim-frame-error') &&
          await panel.getAttribute('data-stock-sync') === 'exact' && Math.abs(Number(await panel.getAttribute('data-stock-ms')) - value) <= 1
      })
      await page.waitForTimeout(2000)
      return async () => Number(await slider.inputValue()) > 0 && await page.locator('.sim-panel').getAttribute('data-stock-sync') === 'exact' && !await visible('sim-frame-error')
    }
    case 'post':
      await tab('postprocess', () => visible('post-gcode-preview'))
      return async () => /G0|G1/.test(await page.getByTestId('post-gcode-preview').innerText())
    case 'tools':
      await tab('toollibrary', async () => page.locator('.tool-modal').isVisible())
      await step('Import starter end mills, drills and V-bit through Tool Library', async () => {
        const chooser = page.waitForEvent('filechooser')
        await page.locator('.tool-modal').getByRole('button', { name: 'Import', exact: true }).click()
        await (await chooser).setFiles(path.join(ROOT, scene.tools))
      }, async () => {
        const types = (await state())?.toolLibrary.map(t => t.type) || []
        return ['flat_end_mill', 'drill', 'v_bit'].every(type => types.includes(type))
      })
      return async () => page.locator('.tool-modal').isVisible() &&
        await page.locator('.tool-modal').getByText('6 mm 60 deg V-bit', { exact: true }).isVisible()
    case 'machine': case 'probing': case 'control': {
      await tab('control', () => visible('control-page'))
      if (scene.view !== 'probing') {
        await step('Define the sample router using its existing travel', async () => {
          await page.getByTestId('control-view-machine').click()
          await page.getByTestId('machine-def-panel-define').click()
          await page.getByTestId('machine-def-panel-save').click()
        }, async () => Boolean((await state())?.project.machine.controllerDefinition))
      }
      if (scene.view === 'machine') {
        await step('Show travels and spindle in definition overview', () => page.getByTestId('machine-def-tab-overview').click(), () => visible('machine-definition-panel'))
        return () => visible('machine-definition-panel')
      }
      await step('Return to Control main', () => page.getByTestId('control-view-main').click(), () => visible('control-kind-select'))
      if (scene.view === 'probing') {
        await step('Open probing', () => page.getByTestId('control-view-probing').click(), () => visible('control-probing-panel'))
        await step('Select inside corner preview', () => page.getByTestId('control-work-probe-routine-insideCorner').click(), () => visible('probing-picture-box'))
        return () => visible('probing-picture-box')
      }
      await step('Connect exclusively to simulator', async () => {
        await page.getByTestId('control-kind-select').selectOption('simulator')
        await page.getByTestId('control-connect').click()
      }, async () => await visible('control-disconnect') &&
        await page.getByTestId('control-kind-select').inputValue() === 'simulator' &&
        await page.getByText('LienCAM Simulated Controller', { exact: true }).isVisible())
      await step('Clear simulator software stop', async () => {
        const clear = page.getByRole('button', { name: 'CLEAR', exact: true })
        if (await clear.isVisible()) await clear.click()
      }, async () => !await page.getByRole('button', { name: 'CLEAR', exact: true }).isVisible())
      await step('Home the simulator and read back its datum', () => page.getByTestId('control-home').click(),
        async () => !await page.getByTestId('control-datum-chip').isVisible() && /[0-9]/.test(await page.getByTestId('control-dro-x').innerText()))
      await step('Set simulator G54 inside sample travel through MDI', async () => {
        const mdi = page.getByTestId('control-mdi-input')
        await mdi.fill('G10 L2 P1 X-150 Y-150 Z-25')
        await mdi.press('Enter')
      }, async () => Number(await page.getByTestId('control-dro-work-x').inputValue()) === 150)
      await step('Load fixture plate through Control', async () => {
        await page.getByTestId('control-load-menu').click()
        await page.locator('[data-testid^="control-load-setup-item-"]').first().click()
      }, async () => (await page.getByTestId('control-program-context').innerText()).includes('Setup 1') && await visible('control-gcode-list'))
      await step('Cycle start in simulator', () => page.getByTestId('control-cyclestart').click(), async () => /Run|Running/.test(await page.getByTestId('control-state-chip').innerText()))
      await step('Read back execution inside the program', async () => {}, async () => {
        const match = (await page.getByTestId('control-progress-text').innerText()).replace(/\s/g, '').match(/(\d+)\/(\d+)/)
        return Boolean(match && Number(match[1]) > 0 && Number(match[1]) < Number(match[2]))
      })
      await step('Feed hold for repeatable mid-run picture', () => page.getByTestId('control-feedhold').click(), async () => /Hold|Held/.test(await page.getByTestId('control-state-chip').innerText()))
      return async () => /Hold|Held/.test(await page.getByTestId('control-state-chip').innerText())
    }
    default: throw new Error(`Unknown view ${scene.view}`)
  }
}

export async function runScenes({ build, only, evidence = 'src/tests/evidence/WO-2391', repoRoot = ROOT }) {
  const list = loadScenes()
  const receipt = verifyBuild(build, repoRoot)
  if (!receipt.demoBuild) throw new Error('S16 requires the release browser demo. Build with VITE_DEMO_BUILD=true npm run build:media.')
  if (only?.some(id => !list.scenes.some(s => s.id === id))) throw new Error('Unknown scene in --only')
  const scenes = list.scenes.filter(s => !only || only.includes(s.id))
  const output = path.join(repoRoot, 'docs/media')
  const evidencePath = path.resolve(repoRoot, evidence)
  mkdirSync(output, { recursive: true }); mkdirSync(evidencePath, { recursive: true })
  const previous = Object.fromEntries(scenes.map(s => [s.id, existsSync(path.join(output, `${s.id}.png`)) ? statSync(path.join(output, `${s.id}.png`)).mtimeMs : null]))
  for (const s of scenes) for (const extension of ['png', 'json']) rmSync(path.join(output, `${s.id}.${extension}`), { force: true })
  const result = { buildCommit: receipt.commit, buildHash: receipt.buildHash, startedAt: new Date().toISOString(), scenes: [] }
  const browser = await chromium.launch({ headless: true, args: CHROMIUM_CAPTURE_ARGS })
  try {
    await withBuildServer(build, async baseUrl => {
      // Menus and face-picking depend on the active page. Keep native UI
      // interactions serial even though the storage contexts are isolated.
      for (const scene of scenes) {
        const entry = { id: scene.id, actions: [], status: 'running' }
        result.scenes.push(entry)
        const context = await browser.newContext({ viewport: list.viewport, deviceScaleFactor: 1 })
        const page = await context.newPage()
        page.setDefaultTimeout(30_000)
        const errors = []
        page.on('pageerror', error => errors.push(error.message))
        try {
          await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 })
          const predicate = await prepareScene(page, scene, entry.actions)
          await page.mouse.move(1910, 1070)
          await page.waitForTimeout(600)
          if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`)
          if (scene.view === 'social') {
            // CAM stays mounted but hidden while Model is active. Select the
            // largest VISIBLE canvas, never the suspended CAM canvas or cube.
            const canvases = await page.locator('canvas:visible').all()
            let largest, area = 0
            for (const canvas of canvases) {
              const box = await canvas.boundingBox()
              if (box && box.width * box.height > area) { largest = canvas; area = box.width * box.height }
            }
            if (!largest || area < 100_000) throw new Error('No visible production part canvas')
            const part = await largest.screenshot()
            const logo = readFileSync(path.join(repoRoot, 'site/media/wordmark.svg'))
            await page.setViewportSize(scene.viewport)
            await page.setContent(`<html><body style="margin:0;background:#12161c;color:#eef0f3;font:28px Arial;display:flex;align-items:center;height:640px"><div style="padding:48px;width:450px"><img alt="LienCAM" width="420" src="data:image/svg+xml;base64,${logo.toString('base64')}"><p>Design. Cut. Control.</p><p style="font-size:20px;color:#b6bbc3">Free, open source CNC CAM</p></div><img alt="Knob made in LienCAM" style="width:680px;height:560px;object-fit:contain" src="data:image/png;base64,${part.toString('base64')}"></body></html>`)
            await page.locator('img').evaluateAll(images => Promise.all(images.map(image => image.decode())))
          }
          const size = scene.viewport || list.viewport
          const shot = await captureProvenancedScreenshot({ page, outputPath: path.join(output, `${scene.id}.png`), repoRoot,
            sourcePaths: [path.relative(repoRoot, build).split(path.sep).join('/')], sourceExcludePaths: [],
            provenance: scene.view === 'social' ? async () => page.locator('img').count().then(count => count === 2) : predicate })
          const record = { ...shot, sourceProvenance: { ...shot.sourceProvenance, captureCommit: shot.sourceProvenance.commit,
            commit: receipt.commit, buildCommit: receipt.commit, buildHash: receipt.buildHash, sceneId: scene.id, width: size.width, height: size.height } }
          persistCaptureProvenance({ provenancePath: path.join(output, `${scene.id}.json`), shots: { [`${scene.id}.png`]: record } })
          entry.status = 'passed'; entry.bytes = shot.bytes; entry.sha256 = shot.hash
          entry.previousMtimeMs = previous[scene.id]; entry.mtimeMs = statSync(shot.outputPath).mtimeMs
          entry.replaced = previous[scene.id] === null || entry.mtimeMs > previous[scene.id]
        } catch (error) {
          entry.status = 'failed'; entry.error = `${scene.id}: ${error.message}`
          await page.screenshot({ path: path.join(evidencePath, `${scene.id}-failed.png`) }).catch(() => {})
          console.error(entry.error)
        } finally {
          await context.close()
          writeJson(path.join(evidencePath, 'run.json'), result)
        }
      }
    })
  } finally { await browser.close() }
  const failed = result.scenes.filter(s => s.status !== 'passed')
  if (failed.length) throw new Error(`Scene run failed: ${failed.map(s => s.error).join('\n')}`)
  if (!only) await makeContactSheet(list, output, evidencePath, receipt)
  return result
}

async function makeContactSheet(list, output, evidencePath, receipt) {
  const cards = list.scenes.map(scene => `<figure><img src="data:image/png;base64,${readFileSync(path.join(output, `${scene.id}.png`)).toString('base64')}"><figcaption>${scene.id} ${scene.name}</figcaption></figure>`).join('')
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>WO-2391 release scenes</title><style>body{margin:0;padding:20px;background:#12161c;color:#eee;font:16px Arial}h1{font-size:22px}main{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}figure{margin:0}img{width:100%;aspect-ratio:16/9;object-fit:contain;background:#090c10}figcaption{padding:5px}p{font-size:14px}</style></head><body><h1>Release scenes - WO-2391</h1><p>Build ${receipt.commit}. Architect: compare each scene to the live app and request the operator's picture verdict before publication.</p><main>${cards}</main></body></html>`
  writeFileSync(path.join(evidencePath, 'contact-sheet.html'), html)
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1250 } })
    await page.setContent(html)
    await page.locator('img').evaluateAll(images => Promise.all(images.map(image => image.decode())))
    await page.screenshot({ path: path.join(evidencePath, 'contact-sheet.png'), fullPage: true })
  } finally { await browser.close() }
}
