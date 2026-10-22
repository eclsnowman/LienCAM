// Release stills, never test-evidence copies. Usage and build identity live in
// the runner so imports are also usable by the focused contract test.
import { isMain } from '../lib/is-main.mjs';
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runScenes, stampBuild, verifyBuild, withBuildServer } from './lib/scene-runner.mjs'
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { chromium } from 'playwright'
import { runCaptureHarness, persistCaptureProvenance, captureProvenancedScreenshot, CHROMIUM_CAPTURE_ARGS } from './lib/harness.mjs'
import { readAppState } from '../examples/lib/drive.mjs'

// Walkthroughs use the same capture boundary as shoot.mjs. Keep their manifest
// separate: the release runner's S02..S16/SP contract remains unchanged.
export async function runWalkthroughScenes({ port = 2481, only, build, evidenceDir = 'src/tests/evidence/WO-2481' } = {}) {
  const manifest = JSON.parse(readFileSync('tools/capture/scenes.json', 'utf8'))
  const scenes = manifest.walkthroughScenes.filter(s => !only || only.includes(s.id))
  if (!scenes.length || only?.some(id => !scenes.some(s => s.id === id))) throw new Error('Unknown walkthrough scene')
  const output = resolve('docs/media/walkthroughs')
  const evidence = resolve(evidenceDir)
  mkdirSync(output, { recursive: true }); mkdirSync(evidence, { recursive: true })
  for (const s of scenes) for (const ext of ['png', 'json']) rmSync(resolve(output, `${s.id}.${ext}`), { force: true })
  const readbackFile = resolve(evidence, 'scenes-readback.json')
  const readbacks = existsSync(readbackFile) ? JSON.parse(readFileSync(readbackFile, 'utf8')).filter(s => !scenes.some(next => next.id === s.id)) : []
  const wait = async (page, check) => {
    for (let i = 0; i < 120; i++) {
      if (await check()) return
      await page.waitForTimeout(500)
    }
    throw new Error('Walkthrough state check timed out')
  }
  // One foreground Vite/Chromium lifetime. Projects are opened through the
  // normal file picker and each scene's state is checked before its picture.
  const capturePages = async ({ page }) => {
    page.setDefaultTimeout(30_000)
    page.on('pageerror', error => console.log('PAGE ERROR:', error.message))
    for (const scene of scenes) {
      try {
      console.log(`[${scene.id}] ${scene.name}`)
      const close = page.locator('.modal-backdrop .modal-close-btn').first()
      if (await close.isVisible()) await close.click()
      await page.getByRole('button', { name: 'Open project', exact: true }).waitFor()
      const picker = page.getByRole('button', { name: 'Start with an empty project', exact: true })
      await page.locator('#liencam-splash').waitFor({ state: 'hidden' })
      if (scene === scenes[0]) await picker.waitFor({ timeout: 5000 }).catch(() => {})
      if (await picker.isVisible()) await picker.click()
      await page.getByRole('button', { name: 'Application settings', exact: true }).click()
      await page.getByTestId('settings-interface-scale').click()
      await page.getByRole('option', { name: '100%', exact: true }).click()
      await page.getByTestId('settings-light-mode').setChecked(false)
      await page.locator('.settings-modal .modal-close-btn').click()
      console.log(`[${scene.id}] interface ready`)
      const project = JSON.parse(readFileSync(scene.project, 'utf8'))
      const chooser = page.waitForEvent('filechooser')
      await page.getByRole('button', { name: 'Open project', exact: true }).click()
      await (await chooser).setFiles(resolve(scene.project))
      await wait(page, async () => (await readAppState(page))?.project.id === project.id && !await page.getByTestId('project-open-indicator').count())
      const machine = page.getByRole('button', { name: 'Use this machine', exact: true })
      if (await machine.isVisible()) await machine.click()
      console.log(`[${scene.id}] project opened`)
      const tab = async id => page.getByTestId(`mode-tab-${id}`).click()
      const setup = project.setups[scene.setup || 0]
      if (scene.view !== 'form') {
      await tab('toolpath')
      await wait(page, async () => {
        const ops = (await readAppState(page))?.project.setups.flatMap(s => s.operations) || []
        if (ops.some(o => o.status === 'error')) throw new Error(`${scene.id}: operation computation failed`)
        return ops.length > 0 && ops.every(o => o.status === 'ready')
      })
      const setupHeader = page.locator('.tree-setup-header').filter({ hasText: setup.name })
      await setupHeader.click()
      if (!await setupHeader.locator('..').locator('.tree-op').count()) await setupHeader.click()
      console.log(`[${scene.id}] paths ready, setup selected`)
      }
      let predicate
      switch (scene.view) {
        case 'form': {
          await tab('part')
          await page.getByTestId('feature-row-FRM1').click({ button: 'right' })
          await page.getByTestId('tree-context-menu-edit').click()
          await page.getByTestId('form-palette').waitFor()
          const copies = page.getByRole('textbox', { name: 'Circular copies', exact: true })
          if (!await copies.isVisible()) await page.getByRole('button', { name: 'Circular', exact: true }).click()
          await copies.fill('4')
          await copies.press('Enter')
          predicate = async () => await page.getByTestId('form-palette').isVisible() &&
            await copies.inputValue() === '4' && await page.getByTestId('form-circular').getAttribute('aria-pressed') === 'true'
          break
        }
        case 'setup-overview':
          await tab('setup')
          predicate = async () => (await readAppState(page))?.project.activeSetupId === setup.id &&
            (await page.getByTestId('mode-tab-setup').getAttribute('class')).includes('mode-tab-active')
          break
        case 'setup':
          await tab('setup')
          await page.getByRole('button', { name: 'Edit setup', exact: true }).first().click()
          predicate = () => page.getByTestId('setup-modal-panel').isVisible()
          break
        case 'second-side':
          await tab('setup')
          await page.getByRole('button', { name: 'Add setup', exact: true }).click()
          await page.getByTestId('setup-second-side-of').selectOption(project.setups[0].id)
          await page.getByTestId('setup-second-side-axis').selectOption('y')
          predicate = async () => await page.getByTestId('setup-second-side-of').inputValue() === project.setups[0].id && await page.getByTestId('setup-second-side-axis').inputValue() === 'y'
          break
        case 'toolpath':
          predicate = async () => {
            // OPFS rotates the durable snapshot during setup changes. A missing
            // generation means wait for readback, not a product/capture failure.
            const state = await readAppState(page)
            return state?.project.activeSetupId === setup.id && state?.project.activeOperationId === null
          }
          break
        case 'simulate': {
          await tab('simulation')
          await page.getByLabel('Simulate Stock Removal', { exact: true }).check()
          await page.getByTestId('sim-hide-toolpath').check()
          await page.getByTestId(`sim-display-${scene.simulationDisplay || 'stock'}`).click()
          if (scene.simulationDisplay === 'compare') await page.getByTestId('sim-stock-opacity').fill('0.5')
          if (scene.simulationResolution) await page.locator('.sim-res-select').selectOption(String(scene.simulationResolution))
          const slider = page.getByRole('slider', { name: 'Simulation position' })
          await wait(page, async () => Number(await slider.getAttribute('max')) > 0)
          const duration = Number(await slider.getAttribute('max'))
          // The range has millisecond steps but a fractional max. Rounding the
          // end up puts the requested value outside the real control's range.
          const position = Math.min(Math.round(duration * (scene.simulationFraction ?? 0.7)), Math.floor(duration))
          await slider.fill(String(position))
          predicate = async () => Number(await slider.inputValue()) > 0 &&
            Math.abs(Number(await slider.inputValue()) - position) <= 1 &&
            await page.getByTestId(`sim-display-${scene.simulationDisplay || 'stock'}`).getAttribute('aria-pressed') === 'true' &&
            await page.locator('.sim-panel').getAttribute('data-stock-sync') === 'exact' &&
            Math.abs(Number(await page.locator('.sim-panel').getAttribute('data-stock-ms')) - Number(await slider.inputValue())) <= 1 &&
            !await page.getByTestId('sim-frame-error').isVisible()
          await wait(page, predicate)
          break
        }
        case 'post':
          await tab('postprocess')
          await page.getByTestId('post-definition-select').click()
          await page.getByRole('option', { name: scene.post, exact: true }).click()
          await page.getByLabel('All operations', { exact: true }).check()
          await page.getByRole('button', { name: scene.output === 'combined' ? 'Combined (one file)' : 'Separate files (one per setup)', exact: true }).click()
          if (scene.pause) {
            const pause = page.locator('.mform-row').filter({ hasText: 'Pause between setups (M0)' })
            if (!await pause.locator('input').isChecked()) await pause.locator('label.toggle').click()
            if (!await pause.locator('input').isChecked()) throw new Error('Between-setup pause did not enable')
          }
          predicate = async () => {
            const code = await page.getByTestId('post-gcode-preview').innerText()
            return /G0|G1/.test(code) && (scene.post !== 'UCCNC' || code.includes('G64')) &&
              (!scene.pause || /M0[\s\S]*G55/.test(code))
          }
          break
        case 'relief': {
          // Reopen the example's own relief row: Edit puts its picture and every value back in the palette.
          await tab('part')
          await page.getByTestId('feature-tree').waitFor()
          await page.locator('[data-testid^="feature-row-"]').filter({ hasText: /^Relief 1/ }).first().click({ button: 'right' })
          await page.getByTestId('tree-context-menu-edit').click()
          await page.getByTestId('relief-palette').waitFor()
          predicate = async () => await page.getByTestId('relief-palette').isVisible() && await page.getByTestId('relief-file-name').isVisible()
          break
        }
        case 'tools':
          await tab('toollibrary')
          predicate = () => page.locator('.tool-modal').isVisible()
          break
        case 'control':
          await tab('control')
          await page.getByTestId('control-load-menu').click()
          await page.locator('[data-testid^="control-load-setup-item-"]').first().click()
          predicate = () => page.getByTestId('control-gcode-list').isVisible()
          break
        case 'probing':
          await tab('control')
          await page.getByTestId('control-view-probing').click()
          await page.getByTestId('control-work-probe-routine-insideCorner').click()
          predicate = () => page.getByTestId('probing-picture-box').isVisible()
          break
        case 'sketch':
          await tab('sketch')
          if (await page.locator('.sketch-entry-row').first().isVisible()) await page.locator('.sketch-entry-row').first().click()
          predicate = () => page.getByTestId('cam-sketch-compact').isVisible()
          await wait(page, predicate)
          // Saved cameras can crop the neighbouring gear or the sign's letters.
          // A normal wheel gesture leaves the complete example in the frame.
          await page.locator('canvas').first().hover()
          await page.mouse.wheel(0, 400)
          break
        case 'model':
          // Promote the example's own gear sketch via the real selection and
          // Model buttons, never fabricate a model or substitute another part.
          await tab('setup')
          await page.getByTestId('tree-name-geometry').first().click()
          await tab('part')
          await page.getByTestId('feature-tree').waitFor()
          // Promotion installs the model archive asynchronously; the first tree
          // paint can still be replaced before its context menu is used.
          await page.waitForTimeout(2000)
          await page.locator('[data-testid^="feature-row-sketch3d:"]').first().click({ button: 'right' })
          await page.getByTestId('tree-context-menu-edit').click()
          predicate = () => page.getByTestId('workbench-package-sketch-tools').isVisible()
          await wait(page, predicate)
          // The suspended CAM canvas remains mounted behind Model.
          await page.locator('canvas[data-engine]:visible').first().hover()
          await page.mouse.wheel(0, 1600)
          break
        default: throw new Error(`Unknown walkthrough view ${scene.view}`)
      }
      await wait(page, predicate)
      if (scene.fitFrame) {
        // Fit through the same viewport context menu an operator uses. Saved
        // gear cameras centre the first blank and crop the neighbouring gear.
        const canvas = page.locator('canvas:visible').first()
        await canvas.click({ button: 'right', position: { x: 30, y: 120 } })
        await page.locator('[role="menuitem"][data-action="fit-all"]').click()
        if (scene.cameraView) {
          await canvas.click({ button: 'right', position: { x: 30, y: 120 } })
          await page.locator(`[role="menuitem"][data-action="view-${scene.cameraView}"]`).click()
        }
        await canvas.hover()
        await page.mouse.wheel(0, scene.zoomWheel || 0)
      }
      if (scene.view === 'post' && scene.scrollTo) {
        // Bring a line the operator reads (the operator stop) into the preview by scrolling it with the mouse.
        const preview = page.getByTestId('post-gcode-preview')
        const distance = await preview.evaluate((el, text) => {
          const line = el.textContent.split('\n').findIndex(t => t.includes(text))
          if (line < 0) throw new Error(`No ${text} line in preview`)
          return Math.max(0, line - 6) * parseFloat(getComputedStyle(el).lineHeight) - el.scrollTop
        }, scene.scrollTo)
        await preview.hover()
        await page.mouse.wheel(0, distance)
      }
      if (scene.view === 'post' && scene.pause) {
        // Put the actual flip boundary in the frame, not the earlier tool-change
        // M0. Scroll the app's preview with the mouse; leave its code untouched.
        const preview = page.getByTestId('post-gcode-preview')
        const distance = await preview.evaluate(el => {
          const line = el.textContent.split('\n').findIndex(text => text.trim() === 'G55')
          if (line < 0) throw new Error('No bottom-setup boundary in preview')
          return Math.max(0, line - 6) * parseFloat(getComputedStyle(el).lineHeight) - el.scrollTop
        })
        await preview.hover()
        await page.mouse.wheel(0, distance)
      }
      await page.waitForTimeout(2000)
      const state = await readAppState(page)
      const shot = await captureProvenancedScreenshot({
        page, outputPath: resolve(output, `${scene.id}.png`),
        sourcePaths: ['src', 'tools/capture/scenes.mjs', 'tools/capture/scenes.json', scene.project],
        sourceExcludePaths: ['src/tests/evidence'],
        provenance: async () => (await readAppState(page))?.project.id === project.id && await predicate() &&
          await page.locator('.app-shell').getAttribute('data-ui-scale') === '1' && await page.locator('html').getAttribute('data-color-mode') !== 'light',
      })
      persistCaptureProvenance({ provenancePath: resolve(output, `${scene.id}.json`), shots: { [`${scene.id}.png`]: shot } })
      readbacks.push({ ...scene, projectId: state.project.id, projectName: state.project.name, activeSetupId: state.project.activeSetupId,
        holdingMethods: state.project.setups.map(s => ({ id: s.id, holdingMethod: s.holdingMethod ?? 'none' })),
        ...(scene.view === 'form' ? { circularCopies: Number(await page.getByRole('textbox', { name: 'Circular copies', exact: true }).inputValue()) } : {}),
        bytes: shot.bytes, sha256: shot.hash })
      writeFileSync(resolve(evidence, 'scenes-readback.json'), `${JSON.stringify(readbacks, null, 2)}\n`)
      } catch (error) {
        await page.screenshot({ path: resolve(evidence, `${scene.id}-failed.png`) }).catch(() => {})
        writeFileSync(resolve(evidence, `${scene.id}-failed.txt`), `${error.stack}\n${await page.locator('body').innerText().catch(() => '')}`)
        throw error
      }
    }
  }
  if (build) {
    const receipt = verifyBuild(resolve(build))
    await withBuildServer(resolve(build), async url => {
      const browser = await chromium.launch({ headless: true, args: CHROMIUM_CAPTURE_ARGS })
      try {
        const page = await browser.newPage({ viewport: manifest.viewport })
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 })
        await capturePages({ page })
      } finally { await browser.close() }
    })
    writeFileSync(resolve(evidence, 'build-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
  } else {
    await runCaptureHarness({ port, outDir: evidence, viewport: manifest.viewport, timeoutMs: 300_000 }, capturePages)
  }
  if (manifest.walkthroughScenes.every(s => existsSync(resolve(output, `${s.id}.png`)))) {
    await walkthroughContactSheets(manifest.walkthroughScenes, output, evidence)
  }
}

async function walkthroughContactSheets(scenes, output, evidence) {
  const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;')
  const browser = await chromium.launch({ headless: true })
  try {
    for (const pageName of new Set(scenes.map(s => s.page))) {
      const pageScenes = scenes.filter(s => s.page === pageName)
      const html = `<!doctype html><meta charset="utf-8"><title>${pageName}</title><style>body{background:#12161c;color:#eee;font:18px Arial;margin:24px}main{display:grid;grid-template-columns:1fr 1fr;gap:20px}figure{margin:0}img{width:100%}figcaption{padding:8px}</style><h1>${pageName}</h1><main>${pageScenes.map(s => `<figure><img src="data:image/png;base64,${readFileSync(resolve(output, `${s.id}.png`)).toString('base64')}"><figcaption>${s.id}: ${escape(s.name)}</figcaption></figure>`).join('')}</main>`
      writeFileSync(resolve(evidence, `${pageName}.html`), html)
      const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
      await page.setContent(html)
      await page.locator('img').evaluateAll(images => Promise.all(images.map(img => img.decode())))
      await page.screenshot({ path: resolve(evidence, `${pageName}.png`), fullPage: true })
      await page.close()
    }
  } finally { await browser.close() }
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2)
  try {
    if (args[0] === '--walkthroughs') {
      const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined
      await runWalkthroughScenes({ port: Number(option('--port') || 2481), only: option('--only')?.split(','), build: option('--build'), evidenceDir: option('--evidence') })
    }
    else if (args[0] === '--stamp') stampBuild(resolve(args[1] || 'dist'))
    else {
      if (!args[0]) throw new Error('Usage: node tools/capture/scenes.mjs <build-directory> [--only S02,S03] [--evidence directory]. Build with VITE_DEMO_BUILD=true npm run build:media for S16.')
      const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined
      await runScenes({ build: resolve(args[0]), only: option('--only')?.split(','), evidence: option('--evidence') })
    }
  } catch (error) {
    console.error(error.stack || error)
    process.exitCode = 1
  }
}
