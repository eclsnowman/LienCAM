import { isMain } from '../lib/is-main.mjs';
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { withExampleDriver } from './lib/drive.mjs'
import { scanDirectory } from '../release/scan.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const PART = 'examples/02-toe-clamps'
const EVIDENCE = 'src/tests/evidence/WO-2441'
export const TAB_COUNT = 4
const HOLDING_NOTE = 'Apply masking tape to the spoilboard and underside of the whole blank; superglue the tape faces together and let the glue cure. The profiles cut 0.2 mm into the tape. Keep 4 triangular tabs per clamp (8 tabs total) as backup if the glue lets go. After machining, release the tape, flush-cut the 8 tabs and file smooth.'

// Original release geometry, in mm. Layers keep the three machining roles
// identifiable after the production DXF importer names the resulting loops.
export function toeClampsDxf() {
  const records = ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES']
  const poly = (layer, points) => {
    records.push('0', 'LWPOLYLINE', '8', layer, '90', String(points.length), '70', '1')
    for (const [x, y] of points) records.push('10', String(x), '20', String(y))
  }
  for (const y of [9, 39]) {
    poly('CLAMP_PROFILE', [[8,y], [64,y], [68,y+4], [68,y+18], [64,y+22], [8,y+22]])
    poly('TOE_RECESS', [[52,y+5], [62,y+5], [62,y+17], [52,y+17]])
    records.push('0', 'CIRCLE', '8', 'SCREW_HOLE', '10', '32', '20', String(y+11), '40', '1.5')
  }
  records.push('0', 'ENDSEC', '0', 'EOF')
  return `${records.join('\n')}\n`
}

async function number(page, label, value) {
  const input = page.locator('.op-field-row').filter({ has: page.locator('.op-field-label').filter({ hasText: new RegExp(`^${label.replace(/[()]/g, '\\$&')}$`) }) }).locator('input').first()
  await input.fill(String(value))
  await input.press('Tab')
}

async function createOperation(driver, { type, card, name, tool, layer }) {
  const page = driver.page
  await page.getByRole('button', { name: 'Add operation', exact: true }).click()
  await page.locator('.op-type-card').filter({ hasText: card }).click()
  await page.locator('.op-modal-tab').filter({ hasText: 'Tool' }).click()
  await page.locator('.op-tool-row').filter({ hasText: tool }).click()
  await page.locator('.op-modal-tab').filter({ hasText: 'Geometry' }).click()
  const state = await driver.readState()
  const geo = state.project.geometry.find(g => g.filename === 'toe-clamps.dxf')
  await page.getByTestId('op-geometry-select').selectOption(geo.id)
  if (await page.getByTestId('op-loops-clear').isEnabled()) await page.getByTestId('op-loops-clear').click()
  const wanted = geo.loops.filter(loop => geo.layers2d.find(l => l.id === loop.layerId)?.name === layer)
  assert.equal(wanted.length, 2, `Two ${layer} loops must come from DXF`)
  // The loop list is the production selection control; its order follows the
  // imported geometry's loops (Drill offers only eligible circular loops).
  const rows = page.locator('.op-loop-check')
  assert.equal(await rows.count(), geo.loops.length)
  for (let i = 0; i < geo.loops.length; i++) {
    if (wanted.some(loop => loop.id === geo.loops[i].id)) await rows.nth(i).locator('input[type="checkbox"]').check()
  }
  await page.locator('.op-modal-tab').filter({ hasText: 'Heights' }).click()
  await page.getByRole('button', { name: /^Expand Bottom.*height$/i }).click()
  if (type === 'contour_2d') {
    await page.getByTestId('contour-height-mode').selectOption('through_stock')
    await number(page, 'Past stock bottom', 0.2)
  } else if (type === 'drill') {
    await page.getByTestId('drill-bore-height-mode').selectOption('explicit_depth')
    await number(page, 'Material Start (WCS)', 0)
    await number(page, 'Target End (WCS)', -8)
  } else {
    await page.getByTestId('standard-height-bottom-offset-control').locator('input').fill('2')
    await page.getByTestId('standard-height-bottom-offset-control').locator('input').press('Tab')
  }
  if (type === 'contour_2d') {
    await page.locator('.op-modal-tab').filter({ hasText: 'Linking' }).click()
    await page.getByTestId('contour-tabs-enabled').check()
    await number(page, 'Tab count', TAB_COUNT)
    await number(page, 'Tab width', 5)
    await number(page, 'Tab height', 1)
    await page.getByTestId('contour-tab-shape').selectOption('triangular')
  }
  // Set the operation name on the Type tab after its family is selected.
  await page.locator('.op-modal-tab').filter({ hasText: 'Type' }).click()
  await page.locator('.op-tab-content input.mform-input').fill(name)
  return driver.step(`Create ${name}`, p => p.getByTestId('op-create').click(), s => {
    const op = s.project.setups[0].operations.find(o => o.name === name)
    return op?.type === type && wanted.every(l => op.params.loopIds.includes(l.id)) && op.params.loopIds.length === 2 &&
      (type !== 'contour_2d' || op.params.tabs && op.params.tabCount === TAB_COUNT && op.params.tabShape === 'triangular')
  })
}

async function compute(driver, prefix) {
  await driver.page.getByTestId('mode-tab-toolpath').click()
  if (!await driver.page.getByRole('button', { name: 'Compute toolpath', exact: true }).count()) {
    await driver.page.locator('.tree-setup-header').click()
  }
  const operations = (await driver.readState()).project.setups[0].operations
  for (let i = 0; i < operations.length; i++) {
    await driver.step(`${prefix}: compute ${operations[i].name}`, page => page.getByRole('button', { name: 'Compute toolpath', exact: true }).nth(i).click(), async s => {
      const op = s.project.setups[0].operations[i]
      if (op.status === 'error') throw new Error(JSON.stringify(op))
      // Autosave intentionally strips moves. Read its compute status and claim;
      // Save's production archive retains moves and is checked separately.
      return op.status === 'ready' && !!op.generationFingerprint && op.computeTimeMs >= 0 &&
        await driver.page.getByRole('button', { name: /^Computing/ }).count() === 0
    }, { timeoutMs: 120000 })
    driver.steps.at(-1).uiComputingButtons = await driver.page.getByRole('button', { name: /^Computing/ }).count()
  }
}

// Read the actual rendered simulation field, never run a second simulator.
async function simulationField(page) {
  return page.evaluate(() => {
    const vp = window.__cncViewport
    const texture = vp?.voxelSimTexture?.texture
    if (texture) {
      const data = texture.image.data
      let solid = 0
      for (const value of data) if (value >= 0) solid++
      const voxelSize = vp.voxelSimMaterial.uniforms.uVoxelSize.value
      return { engine: 'voxel', solid, voxelSize, materialMm3: solid * voxelSize ** 3 }
    }
    const layout = vp?.stockSimLayout
    if (layout) {
      let topSum = 0
      for (let i = 2; i < layout.topPositions.length; i += 3) topSum += layout.topPositions[i]
      return { engine: 'heightmap', cells: layout.nx * layout.ny,
        materialMm3: topSum / 4 * layout.csx * layout.csy,
        measurement: 'integral of the rendered heightmap top surface relative to Z=0' }
    }
    throw new Error('Production simulation has no rendered stock field')
  })
}

async function simulate(driver) {
  const page = driver.page
  await driver.step('Select the complete setup for simulation', p => p.locator('.tree-setup-header').click(),
    s => s.project.activeOperationId === null)
  await driver.step('Enable production stock simulation', async p => {
    await p.getByTestId('mode-tab-simulation').click()
    await p.getByLabel('Simulate Stock Removal').check()
    await p.getByRole('button', { name: 'Cut Stock', exact: true }).click()
  }, async s => s.project.setups[0].operations.every(op => op.status === 'ready') &&
    await page.getByTestId('sim-display-stock').getAttribute('aria-pressed') === 'true' &&
    await page.locator('.sim-panel[data-stock-sync="exact"]').count() === 1)
  const baseline = await simulationField(page)
  const slider = page.getByRole('slider', { name: 'Simulation position' })
  const durationMs = Number(await slider.getAttribute('max'))
  assert(durationMs > 0)
  const box = await slider.boundingBox()
  await driver.step('Simulate to mid-cut', () => slider.click({ position: { x: box.width / 2, y: box.height / 2 } }),
    async () => Number(await slider.inputValue()) > durationMs * 0.4 &&
      await page.locator('.sim-panel[data-stock-sync="exact"]').count() === 1, { timeoutMs: 120000 })
  await page.screenshot({ path: driver.output('simulation-mid-cut.png') })
  await driver.step('Simulate the complete setup to the end', p => p.getByRole('button', { name: 'Skip to end', exact: true }).click(),
    async () => Math.abs(Number(await slider.inputValue()) - durationMs) <= 1 &&
      await page.locator('.sim-panel[data-stock-sync="exact"]').count() === 1 &&
      Math.abs(Number(await page.locator('.sim-panel').getAttribute('data-stock-ms')) - durationMs) <= 1,
    { timeoutMs: 120000 })
  const end = await simulationField(page)
  const saved = JSON.parse(readFileSync(path.join(ROOT, EVIDENCE, 'toe-clamps.camproject'), 'utf8'))
  const profile = saved.setups[0].operations.find(op => op.type === 'contour_2d')
  // Final-pass runs come from the production compute, not a second planner.
  const runs = []
  let run = []
  for (const move of profile.toolpathMoves) {
    if (move.role === 'cut') run.push(move)
    else if (run.length) { runs.push(run); run = [] }
  }
  if (run.length) runs.push(run)
  const bottom = saved.sceneStock.fixedStocks[0].position.z
  const finalRuns = runs.filter(moves => Math.abs(Math.min(...moves.map(m => m.z)) - (bottom - 0.2)) < 1e-6)
  assert.equal(finalRuns.length, 2, 'One final profile pass per clamp')
  const samples = []
  const contours = finalRuns.map((moves, contour) => {
    let tabs = 0
    for (let i = 1; i < moves.length; i++) {
      const a = moves[i - 1], b = moves[i]
      if (a.z < bottom + 1 - 1e-6 && Math.abs(b.z - (bottom + 1)) < 1e-6) tabs++
      if (Math.hypot(b.x - a.x, b.y - a.y) < 0.5 || Math.abs(a.z - b.z) > 1e-6) continue
      const tab = Math.abs(b.z - (bottom + 1)) < 1e-6
      const gap = Math.abs(b.z - (bottom - 0.2)) < 1e-6
      if (tab || gap) samples.push({ contour, tab, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: bottom + 0.25 })
    }
    assert.equal(tabs, TAB_COUNT, 'Four triangular rises per final contour')
    return { contour, tabs, lowestZ: Math.min(...moves.map(m => m.z)) }
  })
  const stockReadback = await page.evaluate(samples => {
    const vp = window.__cncViewport
    const tex = vp.voxelSimTexture.texture.image
    const min = vp.voxelSimMaterial.uniforms.uFieldMin.value
    const size = vp.voxelSimMaterial.uniforms.uVoxelSize.value
    return samples.map(sample => {
      const ix = Math.floor((sample.x - min.x) / size)
      const iy = Math.floor((sample.y - min.y) / size)
      const iz = Math.floor((sample.z - min.z) / size)
      if (ix < 0 || iy < 0 || iz < 0 || ix >= tex.width || iy >= tex.height || iz >= tex.depth) throw new Error('Sample outside stock field')
      return { ...sample, value: tex.data[iz * tex.width * tex.height + iy * tex.width + ix] }
    })
  }, samples)
  assert(stockReadback.some(s => s.tab) && stockReadback.some(s => !s.tab))
  assert(stockReadback.every(s => (s.value >= 0) === s.tab), 'Rendered stock retains bridges at tabs and clears the intervening profile cuts')
  writeFileSync(driver.output('tab-stock-readback.json'), `${JSON.stringify({ contours, samples: stockReadback }, null, 2)}\n`)
  const removedVolumeMm3 = baseline.materialMm3 - end.materialMm3
  assert(removedVolumeMm3 > 0, 'The real simulation must remove material')
  writeFileSync(driver.output('simulation.json'), `${JSON.stringify({ durationMs, baseline, end, removedVolumeMm3 }, null, 2)}\n`)
  await page.screenshot({ path: driver.output('simulation-end.png') })
}

async function postAll(driver) {
  const page = driver.page
  await page.getByTestId('mode-tab-postprocess').click()
  await page.getByTestId('post-definition-select').click()
  const choices = await page.locator('[data-testid^="post-definition-select-option-"]').evaluateAll(nodes => nodes.map(node => ({
    testId: node.getAttribute('data-testid'), label: node.textContent.trim(),
  })))
  assert.equal(choices.length, 5, 'Check every shipping built-in dialect')
  await page.keyboard.press('Escape')
  const results = []
  for (const choice of choices) {
    await driver.step(`Post ${choice.label}`, async p => {
      await p.getByRole('button', { name: 'Properties', exact: true }).click()
      await p.getByTestId('post-definition-select').click()
      await p.getByTestId(choice.testId).click()
      await p.getByRole('button', { name: 'Preview', exact: true }).click()
    }, async s => s.project.setups[0].operations.every(op => op.status === 'ready') &&
      /\bG0?[123]\b/.test(await page.getByTestId('post-gcode-preview').innerText()))
    const gcode = await page.getByTestId('post-gcode-preview').innerText()
    assert(!/error|no output|not generated/i.test(gcode), choice.label)
    results.push({ dialect: choice.label, lines: gcode.split('\n').length,
      operationNames: sNames(await driver.readState()).filter(name => gcode.includes(name)) })
    assert.equal(results.at(-1).operationNames.length, 3, 'Every operation must appear in each post')
  }
  writeFileSync(driver.output('posts.json'), `${JSON.stringify(results, null, 2)}\n`)
  // Download both real job-sheet formats from the same control used by an operator.
  const downloads = []
  const onDownload = download => downloads.push(download)
  page.on('download', onDownload)
  await driver.step('Download workholding job sheet', p => p.getByTestId('post-download-setup-sheet').click(),
    async () => downloads.length === 2, { timeoutMs: 120000 })
  page.off('download', onDownload)
  for (const download of downloads) {
    const name = download.suggestedFilename().endsWith('.pdf') ? 'toe-clamps.setup.pdf' : 'toe-clamps.setup.txt'
    await download.saveAs(driver.output(name))
  }
  const sheet = readFileSync(path.join(ROOT, EVIDENCE, 'toe-clamps.setup.txt'), 'utf8')
  assert(sheet.includes('Tape and glue') && sheet.includes('8 tabs') && sheet.includes('flush-cut') && sheet.includes('file smooth'))
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByTestId('console-strip').click()
  const consoleText = await page.getByTestId('console-timeline').innerText()
  writeFileSync(driver.output('application-console.txt'), `${consoleText}\n`)
  assert.equal(await page.locator('.console-event.console-severity-error').count(), 0)
  await page.getByTestId('console-strip').click()
}
const sNames = state => state.project.setups[0].operations.map(op => op.name)

export async function buildToeClamps() {
  mkdirSync(path.join(ROOT, PART), { recursive: true })
  writeFileSync(path.join(ROOT, PART, 'toe-clamps.dxf'), toeClampsDxf())
  return withExampleDriver({ outDir: EVIDENCE }, async driver => {
    for (const name of ['console.json', 'state.json', 'scan.json', 'simulation.json', 'posts.json',
      'application-console.txt', 'model.png', 'toolpaths.png', 'simulation-mid-cut.png', 'simulation-end.png',
      'toe-clamps.setup.txt', 'toe-clamps.setup.pdf', 'reopened-current.json', 'tab-stock-readback.json']) driver.output(name)
    // The shared reader can return null during an OPFS generation rotation.
    // Bound the retry here, in the owned script; never change or seed app state.
    const read = driver.readState.bind(driver)
    const pagesWithState = new WeakSet()
    driver.readState = async () => {
      for (let attempt = 0; attempt < 50; attempt++) {
        const state = await read()
        if (state) { pagesWithState.add(driver.page); return state }
        // A brand-new page legitimately has no autosave before New/Open.
        if (!pagesWithState.has(driver.page)) return null
        await driver.page.waitForTimeout(100)
      }
      throw new Error('No persisted app state after 50 reads')
    }
    const consoleLog = []
    const attach = page => {
      page.on('console', message => consoleLog.push({ type: message.type(), text: message.text() }))
      page.on('pageerror', error => consoleLog.push({ type: 'pageerror', text: error.message }))
    }
    attach(driver.page)
    await driver.page.setViewportSize({ width: 1920, height: 1080 })
    await driver.newProject()
    await driver.step('Name the starter-kit project 02 Toe clamps', async page => {
      await page.getByTestId('tree-name-project').dblclick()
      const name = page.locator('.panel-project-rename')
      await name.fill('02 Toe clamps')
      await name.press('Enter')
    }, state => state.project.name === '02 Toe clamps')
    await driver.setStock({ width: 76, height: 70, depth: 8 })
    // DXF import centers its XY bounding box. Put the stock around that origin,
    // with its top on the imported sketch plane; no store injection is used.
    const stockNode = driver.page.locator('.fixed-stock-node').filter({ has: driver.page.getByTestId('fixed-stock-gizmo-btn') })
    for (const [axis, value] of [['X', -38], ['Y', -35], ['Z', -8]]) {
      await driver.step(`Position stock ${axis}`, async () => {
        const input = stockNode.locator('.stock-field-row').filter({ hasText: `Pos ${axis}` }).locator('input')
        await input.fill(String(value))
        await input.press('Enter')
      }, s => s.project.sceneStock.fixedStocks[0].position[axis.toLowerCase()] === value)
    }
    await driver.importTools('examples/tools/starter-tools-metric.json')
    await driver.step('Import original toe-clamps.dxf', async page => {
      const chooser = page.waitForEvent('filechooser')
      await page.getByRole('button', { name: 'Import geometry', exact: true }).click()
      await (await chooser).setFiles(path.join(ROOT, PART, 'toe-clamps.dxf'))
    }, state => state.project.geometry.some(g => g.filename === 'toe-clamps.dxf' && g.format === 'dxf' && g.loops.length === 6))
    const stockId = (await driver.readState()).project.sceneStock.fixedStocks[0].id
    await driver.step('Assign DXF to fixed stock', page => page.getByTestId('import-stock-choice-backdrop').getByRole('button', { name: /Stock 1/ }).click(),
      s => s.project.geometry[0].stockId === stockId)
    await driver.page.getByTestId('mode-tab-toolpath').click()
    await driver.page.waitForTimeout(1000)
    await driver.page.screenshot({ path: driver.output('model.png') })
    const stock = (await driver.readState()).project.sceneStock.fixedStocks[0]
    await driver.page.getByRole('button', { name: 'Add setup', exact: true }).click()
    await driver.page.locator('.wcs-stock-select').selectOption(stock.id)
    await driver.step('Create setup on generic starter stock', p => p.getByRole('button', { name: 'Create Setup', exact: true }).click(), s => s.project.setups.length === 1 && s.project.setups[0].wcs.stockId === stock.id)
    await driver.page.locator('.tree-setup-header').click()
    await driver.step('Record tape and glue holding plan', async page => {
      await page.getByTestId('setup-holding-method').selectOption('tape_glue')
      await page.getByTestId('setup-holding-note').fill(HOLDING_NOTE)
      await page.getByTestId('setup-holding-note').press('Tab')
    }, s => s.project.setups[0].holdingMethod === 'tape_glue' && s.project.setups[0].notes === HOLDING_NOTE)
    await createOperation(driver, { type: 'pocket_2d', card: '2D Pocket', name: 'Toe recesses - 2 mm', tool: '3 mm flat end mill', layer: 'TOE_RECESS' })
    await createOperation(driver, { type: 'drill', card: 'Drill', name: 'Clamp screw holes - 3 mm', tool: '3 mm drill', layer: 'SCREW_HOLE' })
    await createOperation(driver, { type: 'contour_2d', card: '2D Contour', name: 'Clamp profiles - four tabs each', tool: '3 mm flat end mill', layer: 'CLAMP_PROFILE' })
    await compute(driver, 'Built project')
    await driver.page.screenshot({ path: driver.output('toolpaths.png') })
    const saved = await driver.saveAndReopen('toe-clamps.camproject')
    attach(driver.page)
    await driver.page.setViewportSize({ width: 1920, height: 1080 })
    const reopened = (await driver.readState()).project
    assert.equal(reopened.setups[0].holdingMethod, 'tape_glue')
    assert.equal(reopened.setups[0].notes, HOLDING_NOTE)
    assert(reopened.setups[0].operations.every(op => op.status === 'ready'), 'Open must retain current operations')
    // Autosave omits moves and transfers tools to the live library. Save is the
    // production entry point that retains both for a genuine freshness check.
    await driver.step('Save reopened current project before recompute', async page => {
      const download = page.waitForEvent('download', { timeout: 120000 })
      await page.getByRole('button', { name: 'Save project', exact: true }).click()
      await (await download).saveAs(driver.output('reopened-current.json'))
    }, s => s.project.setups[0].operations.every(op => op.status === 'ready'))
    await compute(driver, 'Reopened project')
    await driver.page.screenshot({ path: driver.output('reopened.png') })
    assert(saved.setups[0].operations.every(op => op.status === 'ready' && op.toolpathMoves.length > 0))
    await simulate(driver)
    await postAll(driver)
    copyFileSync(path.join(ROOT, EVIDENCE, 'toe-clamps.camproject'), path.join(ROOT, PART, 'toe-clamps.camproject'))
    copyFileSync(path.join(ROOT, EVIDENCE, 'reopened.png'), path.join(ROOT, PART, 'reopened.png'))
    writeFileSync(driver.output('console.json'), `${JSON.stringify(consoleLog, null, 2)}\n`)
    writeFileSync(driver.output('state.json'), `${JSON.stringify(await driver.readState(), null, 2)}\n`)
    const report = scanDirectory(path.join(ROOT, PART))
    writeFileSync(driver.output('scan.json'), `${JSON.stringify(report, null, 2)}\n`)
    assert.equal(report.hits.length, 0)
    return saved
  })
}
if (isMain(import.meta.url)) await buildToeClamps()



