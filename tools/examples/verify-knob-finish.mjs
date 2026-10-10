import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { BufferGeometry, Float32BufferAttribute, Vector3 } from 'three'
import { MeshBVH } from 'three-mesh-bvh'
import { createHash } from 'node:crypto'
import { withExampleDriver } from './lib/drive.mjs'
import { captureSourceProvenance } from '../capture/lib/provenance.mjs'

const folder = path.resolve('examples/06-knob-handwheel')
const file = process.env.WO2548_PROJECT || path.join(folder, 'knob-handwheel.camproject')
const source = JSON.parse(readFileSync(file, 'utf8'))
const baseline = process.argv.includes('--baseline')
// WO2548_OUT_DIR: where a TEST run writes (an ignored folder), so a gate never dirties the committed evidence.
const outDir = process.env.WO2548_OUT_DIR
  ? path.join(process.env.WO2548_OUT_DIR, baseline ? 'main' : 'finish')
  : `src/tests/evidence/WO-2548/${baseline ? 'main' : 'finish'}`

async function publishWalkthrough(driver) {
  const report = JSON.parse(readFileSync(path.join(driver.outDir, 'verification.json'), 'utf8'))
  assert(report.generated && report.completed && report.deviation.maxMm <= 0.25, 'Requires the passing production end-stock measurement')
  assert.equal(report.projectSha256, createHash('sha256').update(readFileSync(file)).digest('hex'))
  const page = driver.page
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.getByTestId('mode-tab-postprocess').click()
  await page.getByTestId('post-definition-select').click()
  await page.getByRole('option', { name: 'GRBL', exact: true }).click()
  await page.getByLabel('All operations', { exact: true }).check()
  await page.getByRole('button', { name: 'Separate files (one per setup)', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('[data-testid="post-download-setup-sheet"]')?.disabled === false)
  const code = await page.getByTestId('post-gcode-preview').innerText()
  for (const op of source.setups[0].operations) assert(code.includes(op.name), `Post preview omitted ${op.name}`)
  assert(/\bT5\b/.test(code), 'Post preview must use the ball cutter')
  assert(/\bT6\b/.test(code), 'Post preview must use the wall-finishing cutter')
  await page.screenshot({ path: driver.output('post-preview.png') })
  const downloads = []
  const receive = download => downloads.push(download)
  page.on('download', receive)
  await page.getByTestId('post-download-setup-sheet').click()
  const deadline = Date.now() + 120_000
  while (downloads.length < 2 && Date.now() < deadline) await page.waitForTimeout(100)
  page.off('download', receive)
  assert.equal(downloads.length, 2, 'Production setup sheet must download text and PDF')
  for (const download of downloads) await download.saveAs(path.join(folder, download.suggestedFilename().endsWith('.pdf') ? 'knob-handwheel.setup.pdf' : 'knob-handwheel.setup.txt'))
  const provenance = captureSourceProvenance({ sourcePaths: ['src', 'tools/capture/scenes.json', 'examples/06-knob-handwheel/knob-handwheel.camproject'] })
  for (const [id, name] of [['W4-1', 'model.png'], ['W4-2', 'toolpaths.png'], ['W4-3', 'simulation-with-vise.png'], ['W4-4', 'post-preview.png']]) {
    const bytes = readFileSync(path.join(driver.outDir, name))
    const receipt = { schemaVersion: 1, shots: { [`${id}.png`]: { ...provenance,
      sourceProjectSha256: report.projectSha256, screenshotBytes: bytes.length,
      screenshotSha256: createHash('sha256').update(bytes).digest('hex'),
      productionEvidence: `src/tests/evidence/WO-2548/finish/${name}`, completedStock: id === 'W4-3' ? report.deviation : undefined } } }
    for (const output of ['docs/media/walkthroughs', 'docs/wiki/images/walkthroughs']) {
      mkdirSync(output, { recursive: true })
      const destination = path.join(output, `${id}.png`)
      rmSync(destination, { force: true })
      copyFileSync(path.join(driver.outDir, name), destination)
      if (output.startsWith('docs/media')) writeFileSync(path.join(output, `${id}.json`), JSON.stringify(receipt, null, 2) + '\n')
    }
  }
  writeFileSync(driver.output('walkthrough-readback.json'), JSON.stringify({ projectSha256: report.projectSha256, operations: report.operations, post: 'GRBL', output: 'separate', pictures: ['W4-1', 'W4-2', 'W4-3', 'W4-4'] }, null, 2))
}

export function surfaceDeviation(model, surface, floor) {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(model.positions, 3))
  if (model.indices) geometry.setIndex(model.indices)
  const bvh = new MeshBVH(geometry)
  const point = new Vector3()
  const errors = []
  let worstSample
  // Every fourth corner (one per cell) over the machined grip. The retained
  // base and its floor are intentional workholding, not a failed underside cut.
  for (let i = 0; i < surface.positions.length; i += 12) {
    const z = surface.positions[i + 2]
    if (z <= floor + 0.5) continue
    point.set(surface.positions[i], surface.positions[i + 1], z)
    const nearest = bvh.closestPointToPoint(point)
    errors.push(nearest.distance)
    if (!worstSample || nearest.distance > worstSample.distanceMm) worstSample = {
      distanceMm: nearest.distance, stockPoint: point.toArray(), modelPoint: nearest.point.toArray(),
    }
  }
  assert(errors.length > 100, 'Must measure the machined grip, not an empty surface')
  errors.sort((a, b) => a - b)
  return { samples: errors.length, maxMm: errors.at(-1), p95Mm: errors[Math.floor(errors.length * 0.95)],
    rmsMm: Math.sqrt(errors.reduce((sum, e) => sum + e * e, 0) / errors.length), floorMachineMm: floor, worstSample }
}

export async function verifyKnobFinish() {
  return withExampleDriver({ outDir }, async driver => {
    try {
      if (!process.argv.includes('--walkthrough')) for (const name of ['model.png', 'toolpaths.png', 'simulation-end.png', 'simulation-with-vise.png', 'rough-only.png',
        'model-beside-finished-stock.png', 'model-beside-finished-stock.html', 'verification.json', 'error.txt', 'debug-ui.txt']) driver.output(name)
      const page = driver.page
      // Simulation builds frames and checks holding for the actual dense finish
      // stream before the click returns. A 30 s capture deadline is too short.
      page.setDefaultTimeout(900_000)
      page.on('crash', () => console.error('Production browser page crashed'))
      page.on('pageerror', error => console.error(`Production page error: ${error.message}`))
      // Keep software-rendering cost down during CAM compute on the shared
      // desk; restore the required whole-frame viewport before every capture.
      await page.setViewportSize({ width: 1280, height: 720 })
      await driver.step('Open shipped knob', async p => {
        const chooser = p.waitForEvent('filechooser')
        await p.getByRole('button', { name: 'Open project', exact: true }).click()
        await (await chooser).setFiles(file)
      }, s => s.project.id === source.id && s.project.setups[0].operations.every(o => o.status === 'ready'), { timeoutMs: 120_000 })
      await page.getByTestId('mode-tab-toolpath').click()
      await page.locator('.tree-setup-header').click()
      if (!await page.locator('.tree-op').count()) await page.locator('.tree-setup-header').click()
      if (process.argv.includes('--walkthrough')) return publishWalkthrough(driver)
      if (process.argv.includes('--author')) {
        if (!(await driver.readState()).toolLibrary.some(t => t.name === '3 mm wall-finishing end mill')) await driver.importTools('examples/06-knob-handwheel/finish-tools.json')
        await page.getByTestId('mode-tab-toolpath').click()
        for (const op of source.setups[0].operations.filter(o => o.type !== 'adaptive_3d')) {
          const toolName = op.type === 'parallel_3d' ? '3 mm ball end mill' : '3 mm wall-finishing end mill'
          const state = await driver.readState()
          const desired = { [op.type === 'parallel_3d' ? 'stepover' : 'stepdown']: 0.2, tolerance: op.type === 'parallel_3d' ? 0.05 : 0.025, finishDepth: 16.5,
            ...(op.type === 'waterline_3d' ? { minSlopeDeg: 0, flatAreaDetection: false } : {}) }
          if (state.toolLibrary.find(t => t.id === op.toolId)?.name === toolName &&
            Object.entries(desired).every(([key, value]) => op.params[key] === value)) continue
          await page.locator('.tree-op').filter({ hasText: op.name }).first().click()
          if (state.toolLibrary.find(t => t.id === op.toolId)?.name !== toolName) {
            await page.getByTestId('quickedit-change-tool').click()
            await driver.step(`Use ${toolName} for ${op.type}`, p => p.getByTestId('quickedit-tool-list').locator('.op-tool-row').filter({ hasText: toolName }).first().click(),
              s => s.toolLibrary.find(t => t.id === s.project.setups[0].operations.find(o => o.id === op.id).toolId)?.name === toolName)
          }
          const edit = page.getByTestId(op.type === 'parallel_3d' ? 'props-parallel3d-edit' : 'props-waterline3d-edit')
          for (const [label, value] of [[op.type === 'parallel_3d' ? 'Stepover' : 'Stepdown', 0.2], ['Tolerance', desired.tolerance], ['Finish depth limit', 16.5], ...(op.type === 'waterline_3d' ? [['Steep areas only', 0]] : [])]) {
            const input = edit.locator('.props-group').filter({ has: page.locator('.props-label').filter({ hasText: new RegExp(`^${label}$`) }) }).locator('input').first()
            await input.fill(String(value)); await input.press('Tab')
          }
          if (op.type === 'waterline_3d') await edit.locator('.props-group').filter({ has: page.locator('.props-label').filter({ hasText: /^Flat areas$/ }) }).locator('input').uncheck()
        }
        await page.locator('.tree-setup-header').click()
      }
      // Selecting the setup also toggles its disclosure. Expand it before
      // asking Playwright for operation buttons; otherwise it waits on no row.
      if (process.argv.includes('--changed-only') && !await page.locator('.tree-op').count()) await page.locator('.tree-setup-header').click()
      if (process.argv.includes('--changed-only')) for (const index of [1, 2]) {
        if ((await driver.readState()).project.setups[0].operations[index].status === 'ready') continue
        let lastProgress = 0
        await driver.step(`Compute revised finish ${index + 1}`, async p => {
          await p.locator('.tree-op').nth(index).getByRole('button', { name: 'Compute toolpath', exact: true }).click()
          await p.waitForTimeout(1500)
        }, s => {
          const op = s.project.setups[0].operations[index]
          assert.notEqual(op.status, 'error', `${op.name}: ${op.errorMessage}`)
          if (Date.now() - lastProgress >= 30_000) {
            lastProgress = Date.now()
            console.log(`Revised finish: ${JSON.stringify({ name: op.name, status: op.status, progress: op.progress })}`)
          }
          return op.status === 'ready'
        }, { timeoutMs: 1_200_000 })
      }
      if (process.argv.includes('--generate')) {
        let lastProgress = 0
        await driver.step('Reopened project: Generate all', async p => {
          await p.locator('.tree-section-regen-btn').click()
          await p.waitForTimeout(2000)
        }, s => {
          if (Date.now() - lastProgress >= 30_000) {
            lastProgress = Date.now()
            const progress = s.project.setups[0].operations.map(o => ({ name: o.name, status: o.status, progress: o.progress }))
            console.log(`Generate all: ${JSON.stringify(progress)}`)
            writeFileSync(path.join(driver.outDir, 'compute-progress.json'), JSON.stringify(progress, null, 2))
          }
          for (const op of s.project.setups[0].operations) assert.notEqual(op.status, 'error', `${op.name}: ${op.errorMessage}`)
          return s.project.setups[0].operations.every(o => o.status === 'ready')
        }, { timeoutMs: 1_200_000 })
      }
      await page.setViewportSize({ width: 1920, height: 1080 })
      for (const action of ['Isometric view', 'Fit all']) {
        await page.locator('.viewport-canvas').click({ button: 'right', position: { x: 60, y: 60 } })
        await page.getByRole('menuitem', { name: action, exact: true }).click()
      }
      if (process.argv.includes('--author')) {
        const saved = await driver.saveAndReopen('knob-handwheel.camproject')
        assert.deepEqual(saved.stocks, source.stocks)
        assert.deepEqual(saved.sceneStock, source.sceneStock)
        assert.deepEqual(saved.workholding, source.workholding)
        assert.deepEqual(saved.geometry, source.geometry)
        assert.deepEqual(saved.setups[0].wcs, source.setups[0].wcs)
        copyFileSync(path.join(driver.outDir, 'knob-handwheel.camproject'), file)
        console.log('Saved finish recipe; run again to verify reopened Generate all and simulation')
        return
      }
      await page.screenshot({ path: driver.output('toolpaths.png') })
      await page.getByTestId('mode-tab-setup').click()
      await page.screenshot({ path: driver.output('model.png') })
      const model = await page.evaluate(() => {
        const meshes = []
        window.__cncViewport.workpieceGroup.traverse(m => {
          if (!m.isMesh || !m.userData.isModelBodyMesh) return
          m.updateWorldMatrix(true, false)
          const g = m.geometry.clone().applyMatrix4(m.matrixWorld)
          meshes.push({ positions: Array.from(g.attributes.position.array), indices: g.index ? Array.from(g.index.array) : null })
        })
        if (meshes.length !== 1) throw new Error(`Expected one model body, got ${meshes.length}`)
        return meshes[0]
      })
      await page.getByRole('button', { name: 'Application settings', exact: true }).click()
      await page.getByTestId('settings-sim-engine').click()
      await page.getByRole('option', { name: '2.5D - fast (low-end GPUs)', exact: true }).click()
      await page.getByRole('button', { name: 'Done', exact: true }).click()
      if (!baseline) await page.locator('.tree-op').first().click()
      await page.getByTestId('mode-tab-simulation').click()
      await page.getByLabel('Simulate Stock Removal', { exact: true }).check()
      await page.getByTestId('sim-hide-toolpath').check()
      await page.getByTestId('sim-display-stock').click()
      await page.locator('.sim-res-select').selectOption('0.25')
      const floor = source.stocks[0].bounds.max.z - 17.5
      const readSurface = () => page.evaluate(() => {
        const layout = window.__cncViewport.stockSimLayout
        if (!layout) throw new Error('Production stock surface missing')
        return { positions: Array.from(layout.topPositions), indices: Array.from(layout.topIndices), cellMm: layout.csx }
      })
      const seekEnd = async () => {
      await page.waitForFunction(() => Number(document.querySelector('[aria-label="Simulation position"]')?.max) > 0 &&
        window.__cncViewport?.stockSimLayout?.csx <= 0.251 && document.querySelector('.sim-panel')?.dataset.stockSync === 'exact')
      console.log('Production stock simulation initialized at 0.25 mm')
      await page.getByRole('button', { name: 'Skip to end', exact: true }).click()
      await page.waitForFunction(() => {
        const slider = document.querySelector('[aria-label="Simulation position"]')
        const panel = document.querySelector('.sim-panel[data-stock-sync="exact"]')
        return panel && slider && Math.abs(Number(slider.value) - Number(slider.max)) <= 1 && Math.abs(Number(panel.dataset.stockMs) - Number(slider.max)) <= 1
      }, null, { timeout: 900_000 })
      console.log('Production stock simulation completed')
      }
      let roughDeviation
      if (!baseline) {
        await page.waitForTimeout(1000)
        await seekEnd()
        roughDeviation = surfaceDeviation(model, await readSurface(), floor)
        await page.screenshot({ path: driver.output('rough-only.png') })
        console.log(`Rough-only deviation: ${JSON.stringify(roughDeviation)}`)
        await page.locator('.tree-setup-header').click()
        await page.waitForTimeout(1000)
      }
      await seekEnd()
      await page.screenshot({ path: driver.output('simulation-end.png') })
      const surface = await readSurface()
      console.log(`Measuring ${surface.positions.length / 12} stock cells against ${model.positions.length / 3} model vertices`)
      const deviation = surfaceDeviation(model, surface, floor)
      await page.screenshot({ path: driver.output('simulation-end.png') })
      const state = await driver.readState()
      const report = { deviation, roughDeviation, projectSha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
        generated: process.argv.includes('--generate'), completed: true,
        operations: state.project.setups[0].operations.map(o => ({ type: o.type, status: o.status, params: o.params })), cellMm: surface.cellMm }
      writeFileSync(driver.output('verification.json'), JSON.stringify(report, null, 2))
      if (!baseline) {
        // Preserve the measured Cut Stock verdict, then show the same carved
        // stock with its real holding through the production Compare controls.
        await page.getByTestId('sim-display-compare').click()
        await page.getByTestId('sim-stock-opacity').press('End')
        await page.locator('.tree-geo-block').filter({ has: page.getByTestId('tree-name-geometry').filter({ hasText: /^Lobed knob$/ }) })
          .getByRole('button', { name: 'Hide model', exact: true }).click()
        await page.screenshot({ path: driver.output('simulation-with-vise.png') })
        const compare = await driver.browser.newPage({ viewport: { width: 1920, height: 610 } })
        const images = ['model.png', 'simulation-with-vise.png'].map(name => readFileSync(path.join(driver.outDir, name)).toString('base64'))
        const html = `<!doctype html><title>WO-2548: model and finished stock</title><style>body{margin:0;background:#121820;color:#eee;font:18px Arial}header{padding:12px}main{display:flex}figure{width:50%;margin:0}figcaption{padding:8px}img{width:100%}</style><header>WO-2548 - top-side grip; holding base retained. Measured maximum deviation ${deviation.maxMm.toFixed(3)} mm at ${surface.cellMm.toFixed(3)} mm simulation resolution.</header><main><figure><figcaption>Imported knob model and unchanged vise</figcaption><img src="data:image/png;base64,${images[0]}"></figure><figure><figcaption>Completed stock after roughing and both finishes</figcaption><img src="data:image/png;base64,${images[1]}"></figure></main>`
        writeFileSync(driver.output('model-beside-finished-stock.html'), html)
        await compare.setContent(html)
        await compare.locator('img').evaluateAll(images => Promise.all(images.map(img => img.decode())))
        await compare.screenshot({ path: driver.output('model-beside-finished-stock.png'), fullPage: true })
        await compare.close()
      }
      if (process.argv.includes('--deliver')) {
        assert(deviation.maxMm <= 0.25, `Finish deviation ${deviation.maxMm} mm exceeds 0.25 mm`)
        for (const name of ['toolpaths.png', 'model.png']) copyFileSync(path.join(driver.outDir, name), path.join(folder, name))
        copyFileSync(path.join(driver.outDir, 'toolpaths.png'), path.join(folder, 'reopened.png'))
        copyFileSync(path.join(driver.outDir, 'simulation-with-vise.png'), path.join(folder, 'simulation-end.png'))
        // Hide Model was used only for the Compare picture. Reopen the saved
        // recipe before Post so that display edit cannot invalidate CAM paths.
        await page.context().close()
        await driver.open()
        await driver.step('Reopen unchanged recipe for Post', async p => {
          const chooser = p.waitForEvent('filechooser')
          await p.getByRole('button', { name: 'Open project', exact: true }).click()
          await (await chooser).setFiles(file)
        }, s => s.project.id === source.id && s.project.setups[0].operations.every(o => o.status === 'ready'), { timeoutMs: 120_000 })
        await publishWalkthrough(driver)
      }
      console.log(JSON.stringify(report, null, 2))
      return report
    } catch (error) {
      console.error(error)
      writeFileSync(driver.output('error.txt'), error.stack || String(error))
      await driver.page.locator('body').innerText({ timeout: 5000 }).then(text => writeFileSync(driver.output('debug-ui.txt'), text)).catch(() => {})
      throw error
    }
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('tools/examples/verify-knob-finish.mjs')) await verifyKnobFinish()
