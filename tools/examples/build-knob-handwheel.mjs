import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { portableSnapshot, withExampleDriver } from './lib/drive.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const folder = path.join(root, 'examples/06-knob-handwheel')
const evidence = 'src/tests/evidence/WO-2378'
export const PROJECT_NAME = '06 Knob and handwheel'
// The starter 6 mm end mill has 18 mm of flute. With the stock 1 mm above the
// knob, the rough and waterline stop 17.5 mm below stock top, so the grip
// stands on a floor that "Clear all stock" leaves flat out to the stock edge.
// Parallel finishes the dome only, clipped to the stock outline: a stay-down
// connector between pass ends clamped beside the knob wall follows the raw
// surface below its own finish depth, and Post then refuses the op as outdated
// (src/cam3d/pathbuild/index.ts connector sampling, reported in WO-2378).
const STOCK_TOP_OFFSET = 1
// "Clear all stock" plans every Z level over the whole stock; the app stops a
// level that runs 180 s without progress, so keep the margin and tolerance lean.
const STOCK_XY_OFFSET = 3
const FLOOR_WCS = -17.5
const FINISH_DEPTH = { parallel_3d: 12, waterline_3d: -FLOOR_WCS - STOCK_TOP_OFFSET }

export const HOLDING_NOTE = 'Raise the stock on a 36 x 36 x 12 mm undersized support block seated on the vise bed. Vise grips only the bottom 3 mm of the remaining square stock base on the X faces, from Z -10 to Z -7. The base is about 15 mm high; set the jaw opening to the full stock width. Keep jaw tops at Z -7, below every cutting move; the waterline lead exits in -Y. Remove the base in a second setup or with a saw; underside finishing is not part of this example.'

function jawStl(name, boxes) {
  const faces = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],
    [1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]]
  const lines = [`solid ${name}`]
  for (const [x0,x1,y0,y1,z0,z1] of boxes) {
    const vertices = [[x0,y0,z0],[x1,y0,z0],[x1,y1,z0],[x0,y1,z0],
      [x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]]
    for (const face of faces) lines.push('facet normal 0 0 0', 'outer loop',
      ...face.map(i => `vertex ${vertices[i].join(' ')}`), 'endloop', 'endfacet')
  }
  return `${lines.join('\n')}\nendsolid ${name}\n`
}

// WO-2445: retain the CURRENT kit's exact WO-2405 paths. This bounded rebuild
// opens that baseline and authors only its holding through production controls.
export async function rebuildKnobWorkholding() {
  const outDir = 'src/tests/evidence/WO-2445'
  const projectFile = path.join(folder, 'knob-handwheel.camproject')
  const before = JSON.parse(readFileSync(projectFile, 'utf8'))
  const pathHashes = project => project.setups[0].operations.map(op => ({
    type: op.type, moves: op.toolpathMoves.length,
    sha256: createHash('sha256').update(JSON.stringify(op.toolpathMoves)).digest('hex'),
  }))
  return withExampleDriver({ outDir }, async driver => {
    let page = driver.page
    await page.setViewportSize({ width: 1920, height: 1080 })
    for (const name of ['toolpaths.png', 'simulation-end.png', 'simulation-cut-stock-end.png', 'verification.json', 'reopened-state.json', 'simulation-console.txt']) driver.output(name)
    await driver.step('Open current knob baseline', async () => {
      const chooser = page.waitForEvent('filechooser')
      await page.getByRole('button', { name: 'Open project', exact: true }).click()
      await (await chooser).setFiles(projectFile)
    }, state => state.project.id === before.id && operationsReady(state.project), { timeoutMs: 120_000 })
    await page.getByTestId('mode-tab-setup').click()
    const needsSupportBody = !before.workholding?.definitions.some(def => def.components.some(c => c.id === 'support'))
    if (needsSupportBody) {
      // Repair the existing fixture through the same production remove/import
      // controls. Its solid union and every machining coordinate stay unchanged.
      for (const instance of before.workholding?.instances ?? []) {
        await driver.step('Remove old vise assembly before splitting its support',
          () => page.getByTestId(`remove-vise-btn-${instance.id}`).click(),
          state => !state.project.workholding?.instances.some(i => i.id === instance.id))
      }
      for (const geometry of before.geometry.filter(g => g.workholding)) {
        await driver.step(`Remove superseded fixture body ${geometry.name}`, async () => {
          await page.locator('.tree-geo-block').filter({ has: page.getByTestId('tree-name-geometry')
            .filter({ hasText: new RegExp(`^${geometry.name}$`) }) }).getByRole('button', { name: 'Remove geometry', exact: true }).click()
          await page.getByTestId('confirm-dialog-confirm').click()
        }, state => !state.project.geometry.some(g => g.id === geometry.id))
      }
      // The cuts stop above Z 5.1: the full 51.43 mm square stock below that
      // floor remains. "15 mm base" in the review is its HEIGHT, not its width.
      const { min, max } = before.stocks[0].bounds
      const opening = max.x - min.x
      // the operator's 10:18 AM assignment: lift the stock in the vise rather than
      // changing its WCS or paths. Lower the vise 10 mm and seat the unchanged
      // stock on an undersized block; only its bottom 3 mm meets the jaws.
      const fixedBoxes = [[min.x-8,min.x,-30,30,-19,-7],[-45,45,-35,35,-27,-22],
        [min.x-8,min.x,-30,30,-22,-19],[max.x,max.x+8,-30,30,-22,-19]]
      const movingBoxes = [[max.x,max.x+8,-30,30,-19,-7]]
      const fixed = jawStl('knob-fixed-jaw', fixedBoxes)
      const moving = jawStl('knob-moving-jaw', movingBoxes)
      const support = jawStl('knob-support-block', [[-18,18,-18,18,-22,min.z]])
      writeFileSync(path.join(folder, 'knob-fixed-jaw.stl'), fixed)
      writeFileSync(path.join(folder, 'knob-moving-jaw.stl'), moving)
      writeFileSync(path.join(folder, 'knob-support-block.stl'), support)
      // Use the dedicated production import: ordinary STL import can reassign
      // the sole auto stock before its row is marked workholding (WO-2445).
      // STL display frames are centered in XY and seated at min Z. The moving
      // component's X includes T(-opening), matching buildVise's joint contract.
      const zero = { x: 0, y: 0, z: 0 }
      const viseFile = path.join(folder, 'knob-base-vise.workholding.json')
      writeFileSync(viseFile, JSON.stringify({
        format: 'liencam-workholding', version: 1,
        definition: { id: 'knob-base-vise', revision: 2, name: 'Knob base vise', kind: 'vise',
          components: [
            { id: 'fixed', name: 'Fixed body', geometryId: 'fixed', localPose: { position: zero, rotation: zero } },
            { id: 'moving', name: 'Moving jaw', geometryId: 'moving',
              localPose: { position: { x: max.x + 4 - opening, y: 0, z: 8 }, rotation: zero },
              joint: { kind: 'linear', axis: { x: 1, y: 0, z: 0 }, minMm: 0, maxMm: opening + 20, closedAtMm: 0 } },
            { id: 'support', name: '36 x 36 x 12 mm support block', geometryId: 'support',
              localPose: { position: { x: 0, y: 0, z: 5 }, rotation: zero } },
          ] },
        shapes: { fixed: { name: 'knob-fixed-jaw', stl: Buffer.from(fixed).toString('base64') },
          moving: { name: 'knob-moving-jaw', stl: Buffer.from(moving).toString('base64') },
          support: { name: 'knob-support-block', stl: Buffer.from(support).toString('base64') } },
        placedAt: { worldPose: { position: { x: 0, y: 0, z: -27 }, rotation: zero }, jointValuesMm: { moving: opening } },
      }, null, 2) + '\n')
      await driver.step('Import setup-scoped base vise as workholding', async () => {
        const chooser = page.waitForEvent('filechooser')
        await page.getByRole('button', { name: 'Import geometry', exact: true }).click()
        await (await chooser).setFiles(viseFile)
      }, state => state.project.workholding?.instances.length === 1 && state.project.workholding.definitions[0].kind === 'vise' &&
        state.project.workholding.definitions[0].components.some(c => c.id === 'support'))
    }
    await page.locator('.tree-setup-header').click()
    await driver.step('Record vise method', () => page.getByTestId('setup-holding-method').selectOption('vise'),
      state => state.project.setups[0].holdingMethod === 'vise')
    await driver.step('Record grip and base removal instructions', async () => {
      await page.getByTestId('setup-holding-note').fill(HOLDING_NOTE)
      await page.getByTestId('setup-holding-note').press('Tab')
    }, state => state.project.setups[0].notes === HOLDING_NOTE)
    const holdingState = await driver.readState()
    assert.deepEqual(holdingState.project.stocks, before.stocks, 'Workholding must preserve stock')
    assert.deepEqual(holdingState.project.setups[0].wcs, before.setups[0].wcs, 'Workholding must preserve WCS')
    writeFileSync(driver.output('raised-stock-readback.json'), JSON.stringify({
      stocks: holdingState.project.stocks, wcs: holdingState.project.setups[0].wcs,
      holdingMethod: holdingState.project.setups[0].holdingMethod, notes: holdingState.project.setups[0].notes,
      workholding: holdingState.project.workholding,
    }, null, 2) + '\n')
    for (const action of ['Isometric view', 'Fit all']) {
      await page.locator('.viewport-canvas').click({ button: 'right', position: { x: 60, y: 60 } })
      await page.getByRole('menuitem', { name: action, exact: true }).click()
    }
    await page.screenshot({ path: driver.output('raised-stock-input.png') })
    if (!operationsReady((await driver.readState()).project)) {
      // Each 3D worker loads a kernel. Serialize, as the original builder does,
      // instead of Regen All's three concurrent kernels on the shared desk.
      if (await page.locator('.tree-op').count() === 0) await page.locator('.tree-setup-header').click()
      for (let index = 0; index < 3; index++) {
        await driver.step(`Regenerate retained operation ${index + 1} with the vise`,
          () => page.locator('.tree-op').nth(index).getByRole('button', { name: 'Compute toolpath', exact: true }).click(),
          state => {
            const op = state.project.setups[0].operations[index]
            if (op.status === 'error') throw new Error(JSON.stringify(op))
            return op.status === 'ready'
          // The shared desk reached 58% without an engine error at ten minutes
          // on the WO-2489 renderer. Allow the unchanged production compute to
          // finish; a driver deadline is not an engagement verdict.
          }, { timeoutMs: 1_200_000 })
      }
    }
    const current = await driver.readState()
    assert(operationsReady(current.project), 'Adding holding must retain current operations')
    const saved = await driver.saveAndReopen('knob-handwheel.camproject')
    assert.deepEqual(pathHashes(saved), pathHashes(before), 'The toolpaths must not change')
    copyFileSync(path.join(root, outDir, 'knob-handwheel.camproject'), projectFile)
    page = driver.page
    await page.setViewportSize({ width: 1920, height: 1080 })
    const reopened = await driver.step('Read back current operations and holding after fresh Open', async () => {},
      state => operationsReady(state.project) && state.project.setups[0].holdingMethod === 'vise')
    assert.deepEqual(reopened.project.workholding, saved.workholding)
    assert.equal(reopened.project.setups[0].notes, HOLDING_NOTE)
    writeFileSync(driver.output('reopened-state.json'), JSON.stringify({
      projectId: reopened.project.id, workholding: reopened.project.workholding,
      operations: reopened.project.setups[0].operations.map(op => ({ id: op.id, type: op.type, status: op.status })),
    }, null, 2) + '\n')
    await page.getByTestId('mode-tab-setup').click()
    await page.locator('.tree-setup-header').click()
    for (const action of ['Isometric view', 'Fit all']) {
      await page.locator('.viewport-canvas').click({ button: 'right', position: { x: 60, y: 60 } })
      await page.getByRole('menuitem', { name: action, exact: true }).click()
    }
    await page.getByTestId('mode-tab-toolpath').click()
    await page.mouse.move(1400, 400)
    await page.screenshot({ path: driver.output('toolpaths.png') })
    await page.getByTestId('mode-tab-setup').click()
    await page.screenshot({ path: driver.output('setup.png') })
    await page.getByTestId('mode-tab-postprocess').click()
    const downloads = []
    const receive = download => downloads.push(download)
    page.on('download', receive)
    await page.getByTestId('post-download-setup-sheet').click()
    const deadline = Date.now() + 30_000
    while (downloads.length < 2 && Date.now() < deadline) await page.waitForTimeout(100)
    page.off('download', receive)
    assert.equal(downloads.length, 2, 'Production job sheet must download text and PDF')
    for (const download of downloads) await download.saveAs(path.join(folder, download.suggestedFilename().endsWith('.pdf') ? 'knob-handwheel.setup.pdf' : 'knob-handwheel.setup.txt'))
    const sheet = readFileSync(path.join(folder, 'knob-handwheel.setup.txt'), 'utf8')
    assert(sheet.includes('Method: Vise') && sheet.includes('Knob base vise') && sheet.includes(HOLDING_NOTE))
    await page.locator('.post-modal').getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.getByRole('button', { name: 'Application settings', exact: true }).click()
    await page.getByTestId('settings-sim-engine').click()
    await page.getByRole('option', { name: '2.5D - fast (low-end GPUs)', exact: true }).click()
    await page.getByRole('button', { name: 'Done', exact: true }).click()
    await page.getByTestId('mode-tab-simulation').click()
    await page.getByLabel('Simulate Stock Removal').check()
    await page.getByTestId('sim-hide-toolpath').check()
    await page.getByTestId('sim-display-stock').click()
    await page.waitForFunction(() => Number(document.querySelector('[aria-label="Simulation position"]')?.max) > 0)
    await page.getByRole('button', { name: 'Skip to end', exact: true }).click()
    await page.waitForFunction(() => {
      const slider = document.querySelector('[aria-label="Simulation position"]')
      const panel = document.querySelector('.sim-panel[data-stock-sync="exact"]')
      return panel && slider && Number(slider.max) > 0 && Math.abs(Number(slider.value) - Number(slider.max)) <= 1 && Math.abs(Number(panel.dataset.stockMs) - Number(slider.max)) <= 1
    }, null, { timeout: 180_000 })
    await page.screenshot({ path: driver.output('simulation-cut-stock-end.png') })
    // Cut Stock hides the entire workpiece group, including the vise (Viewport
    // visibility sync). Preserve that verdict, then use production Compare at
    // 100% stock opacity with just the target model hidden to show the same
    // completed carved stock and its holding together. No saved geometry edits.
    await page.getByTestId('sim-display-compare').click()
    await page.getByTestId('sim-stock-opacity').press('End')
    await page.locator('.tree-geo-block').filter({ has: page.getByTestId('tree-name-geometry')
      .filter({ hasText: /^Lobed knob$/ }) }).getByRole('button', { name: 'Hide model', exact: true }).click()
    const captureState = await driver.step('Show completed stock with its vise for the final picture', async () => {},
      async state => state.project.geometry.find(g => !g.workholding)?.hidden === true && operationsReady(state.project) &&
        await page.getByTestId('sim-display-compare').getAttribute('aria-pressed') === 'true' &&
        Number(await page.getByTestId('sim-stock-opacity').inputValue()) === 1)
    await page.mouse.move(1400, 400)
    await page.screenshot({ path: driver.output('simulation-end.png') })
    await page.getByTestId('console-strip').click()
    const appConsole = await page.getByTestId('console-timeline').innerText()
    writeFileSync(driver.output('simulation-console.txt'), appConsole)
    assert(!/contacts workholding/i.test(appConsole), appConsole)
    assert.equal(await page.locator('.console-event.console-severity-error').count(), 0, appConsole)
    for (const name of ['toolpaths.png', 'simulation-end.png']) copyFileSync(path.join(root, outDir, name), path.join(folder, name))
    copyFileSync(path.join(root, outDir, 'toolpaths.png'), path.join(folder, 'reopened.png'))
    const report = { source: 'current example with WO-2405 finish-link fix',
      projectSha256: createHash('sha256').update(readFileSync(projectFile)).digest('hex'),
      beforePaths: pathHashes(before), afterPaths: pathHashes(saved),
      operationsCurrent: reopened.project.setups[0].operations.length,
      simulation: { completed: true, engine: 'heightmap', contacts: 0 },
      captureDisplay: { mode: 'compare', stockOpacity: Number(await page.getByTestId('sim-stock-opacity').inputValue()),
        targetHidden: captureState.project.geometry.find(g => !g.workholding)?.hidden === true,
        cutStockVerdict: 'simulation-cut-stock-end.png' },
      holdingNote: HOLDING_NOTE, generatedAt: new Date().toISOString() }
    writeFileSync(driver.output('verification.json'), JSON.stringify(report, null, 2) + '\n')
    rmSync(path.join(root, outDir, 'knob-handwheel.camproject'), { force: true })
    console.log(JSON.stringify(report, null, 2))
  })
}

export function operationsReady(project) {
  const operations = project.setups.flatMap(setup => setup.operations)
  if (operations.some(op => op.status === 'error')) throw new Error('Application operation failed')
  return operations.length === 3 && operations.every(op => op.status === 'ready')
}

// The app re-verifies a saved path against its own resolved floor on open and
// before Post; a move below it reopens as outdated.
export function movesAboveFloor(project) {
  return project.setups.flatMap(setup => setup.operations).every(op =>
    op.toolpathMoves?.every(move => move.z >= op.resolvedHeights.machine.bottom - 1e-6))
}

// Integrate the actual heightmap top triangles read from the application's
// rendered stock. Vertical cliff walls have zero projected area.
export function removedVolume(top, positions, indices) {
  let volume = 0
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3
    const area = Math.abs((positions[b] - positions[a]) * (positions[c + 1] - positions[a + 1]) -
      (positions[c] - positions[a]) * (positions[b + 1] - positions[a + 1])) / 2
    volume += area * (top - (positions[a + 2] + positions[b + 2] + positions[c + 2]) / 3)
  }
  return volume
}

export async function buildKnobHandwheel({ verifyOnly = false, simulationOnly = false } = {}) {
  verifyOnly ||= simulationOnly
  mkdirSync(folder, { recursive: true })
  const source = path.join(folder, 'lobed-knob-source.camproject')
  copyFileSync(path.join(root, 'docs/examples/form/lobed-knob.camproject'), source)
  return withExampleDriver({ outDir: evidence }, async driver => {
    // Several kit lanes share this desk. Cold-page boot needs the same generous
    // readiness deadline as file open, and every capture needs the WO viewport.
    driver.open = async () => {
      const context = await driver.browser.newContext({ viewport: { width: 1920, height: 1080 }, acceptDownloads: true })
      driver.contexts.push(context)
      driver.page = await context.newPage()
      driver.page.setDefaultTimeout(120_000)
      await driver.page.goto(driver.baseUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 })
      await driver.page.getByRole('button', { name: 'New project', exact: true }).waitFor({ timeout: 120_000 })
      return driver.page
    }
    const page = driver.page
    await page.setViewportSize({ width: 1920, height: 1080 })
    const log = []
    const watch = page => {
      page.on('console', message => log.push(`${message.type()}: ${message.text()}`))
      page.on('pageerror', error => log.push(`pageerror: ${error.message}`))
    }
    watch(page)
    for (const name of ['toolpaths.png', 'simulation-mid-cut.png', 'simulation-end.png', 'verification.json', 'console.log']) driver.output(name)
    if (!verifyOnly) driver.output('model.png')
    try {
      await driver.step(verifyOnly ? 'Reopen saved project in a fresh context' : 'Open original Form knob with exact shaft bore', async () => {
        const chooser = page.waitForEvent('filechooser')
        await page.getByRole('button', { name: 'Open project', exact: true }).click()
        await (await chooser).setFiles(verifyOnly ? path.join(folder, 'knob-handwheel.camproject') : source)
      }, state => state.project.geometry.some(g => g.modelBody?.ref.bodyId === 'RIMF'))
      const stepFile = path.join(folder, 'knob.step')
      let volume
      if (!verifyOnly) {
      await page.getByTestId('mode-tab-part').click()
      const bodiesHeader = page.getByTestId('workbench-section-bodies-header')
      if (await bodiesHeader.getAttribute('aria-expanded') === 'false') await bodiesHeader.click()
      await page.getByTestId('body-volume-RIMF').waitFor({ timeout: 180_000 })
      volume = Number((await page.getByTestId('body-volume-RIMF').innerText()).split(' ')[0])
      assert(volume > 0)
      await page.screenshot({ path: driver.output('model.png') })
      await driver.step('Export finished exact solid as STEP', async () => {
        const download = page.waitForEvent('download', { timeout: 180_000 })
        await page.getByTestId('workbench-export-step').click()
        await (await download).saveAs(stepFile)
      }, () => readFileSync(stepFile, 'utf8').includes('ISO-10303-21'))
      writeFileSync(driver.output('model-readback.json'), JSON.stringify({ bodyVolumeMm3: volume, readback: 'body-volume-RIMF', source: 'lobed-knob-source.camproject' }, null, 2) + '\n')
      } else {
        volume = JSON.parse(readFileSync(path.join(root, evidence, 'model-readback.json'), 'utf8')).bodyVolumeMm3
      }
      await page.getByTestId('mode-tab-setup').click()
      if (!verifyOnly) {
      await driver.step('Name the project', async () => {
        await page.getByTestId('tree-name-project').dblclick()
        await page.locator('.panel-project-rename').fill(PROJECT_NAME)
        await page.locator('.panel-project-rename').press('Enter')
      }, state => state.project.name === PROJECT_NAME)
      const modelTop = (await driver.readState()).project.geometry[0].boundingBox.max.z
      if (await page.getByTestId('auto-stock-node').locator('.stock-field-row').count() === 0) await page.getByTestId('auto-stock-chevron').click()
      const stockField = label => page.getByTestId('auto-stock-node').locator('.stock-field-row').filter({ hasText: label }).locator('input')
      await driver.step(`Set auto stock XY margin to ${STOCK_XY_OFFSET} mm`, async () => {
        await stockField('XY offset').fill(String(STOCK_XY_OFFSET))
        await stockField('XY offset').press('Enter')
      }, state => state.project.sceneStock.autoStocks[0].autoOffsetXY === STOCK_XY_OFFSET)
      await driver.step(`Set auto stock top offset to ${STOCK_TOP_OFFSET} mm`, async () => {
        await stockField('Z top').fill(String(STOCK_TOP_OFFSET))
        await stockField('Z top').press('Enter')
      }, state => state.project.sceneStock.autoStocks[0].autoOffsetZTop === STOCK_TOP_OFFSET &&
        Math.abs(state.project.stocks[0].bounds.max.z - (modelTop + STOCK_TOP_OFFSET)) < 1e-6)
      await page.getByTestId('auto-stock-chevron').click()
      await driver.importTools('examples/tools/starter-tools-metric.json')
      const stock = (await driver.readState()).project.stocks[0]
      await page.getByRole('button', { name: 'Add setup', exact: true }).click()
      await page.locator('.wcs-stock-select').selectOption(stock.id)
      await driver.step('Bind setup to the knob stock', () => page.getByRole('button', { name: 'Create Setup', exact: true }).click(),
        state => state.project.setups.length === 1 && state.project.setups[0].wcs.stockId === stock.id)
      for (const [type, label] of [['adaptive_3d', 'Adaptive Rough (3D)'], ['parallel_3d', 'Parallel Finish (3D)'], ['waterline_3d', 'Waterline Finish (3D)']]) {
        await page.getByRole('button', { name: 'Add operation', exact: true }).click()
        await page.locator('.op-type-card').filter({ hasText: label }).click()
        await page.locator('.op-modal-tab').filter({ hasText: /^Tool$/ }).click()
        await page.locator('.op-tool-row').filter({ hasText: '6 mm flat end mill' }).click()
        await page.locator('.op-modal-tab').filter({ hasText: /^Passes$/ }).click()
        const number = async (label, value) => {
          const input = page.locator('.op-field-row').filter({ has: page.locator('.op-field-label', { hasText: new RegExp(`^${label}$`) }) }).locator('input').first()
          await input.fill(String(value))
          await input.press('Tab')
        }
        if (type === 'adaptive_3d') {
          await number('Max stepdown', 2)
          await number('Stepover \\(fraction of tool dia\\)', 0.4)
          await number('Tolerance', 0.1)
          await page.getByTestId('op-adaptive3d-roughing-scope').getByRole('radio', { name: /^Clear all stock/ }).check()
          await page.locator('.op-modal-tab').filter({ hasText: /^Heights$/ }).click()
          await page.getByRole('button', { name: /^Expand Top.*height$/i }).click()
          await page.getByTestId('adaptive3d-material-source').selectOption('bounded_band')
          await number('Band top \\(WCS\\)', 0)
          await number('Band bottom \\(WCS\\)', FLOOR_WCS)
        } else {
          const prefix = type === 'parallel_3d' ? 'parallel3d' : 'waterline3d'
          const input = page.getByTestId(`op-${prefix}-finish-depth`).locator('input')
          await input.fill(String(FINISH_DEPTH[type]))
          await input.press('Tab')
          await number(type === 'parallel_3d' ? 'Stepover' : 'Stepdown', type === 'parallel_3d' ? 0.6 : 0.5)
          if (type === 'parallel_3d') await page.locator('.op-check-label').filter({ hasText: /^Clip to stock outline$/ }).locator('input').check()
        }
        await driver.step(`Create ${type} with starter end mill`, () => page.getByTestId('op-create').click(),
          state => state.project.setups[0].operations.some(op => op.type === type &&
            state.toolLibrary.find(tool => tool.id === op.toolId)?.name === '6 mm flat end mill' &&
            (type === 'adaptive_3d'
              ? op.params.maxStepdown === 2 && op.params.useStockBoundary === true &&
                op.smartHeight?.intent.machining.end.value.plane.offsetMm === FLOOR_WCS
              : op.params.finishDepth === FINISH_DEPTH[type] && op.params.useStockBoundary === (type === 'parallel_3d'))))
        // Create Operation starts the production compute; wait on its status.
        await driver.step(`Compute ${type}`, async () => {},
          state => {
            const op = state.project.setups[0].operations.find(op => op.type === type)
            if (op.status === 'error') throw new Error(JSON.stringify(op))
            return op.status === 'ready'
          }, { timeoutMs: 600_000 })
      }
      }
      await driver.step('Select complete setup for toolpath and simulation', () => page.locator('.tree-setup-header').click(),
        state => state.project.activeOperationId === null && operationsReady(state.project))
      await page.getByTestId('mode-tab-toolpath').click()
      await page.screenshot({ path: driver.output('toolpaths.png') })
      const saved = verifyOnly ? JSON.parse(readFileSync(path.join(folder, 'knob-handwheel.camproject'), 'utf8')) : await driver.saveAndReopen('knob-handwheel.camproject')
      // Autosave holds no moves; the saved file does.
      assert(movesAboveFloor(saved), 'A toolpath dips below its own floor; it would reopen outdated: ' +
        JSON.stringify(saved.setups[0].operations.map(op => ({ type: op.type, bottom: op.resolvedHeights.machine.bottom,
          // A loop, not Math.min(...moves): the waterline holds ~126k moves and a
          // spread of that size overflows the call stack (10-09 verify run).
          minZ: (op.toolpathMoves ?? []).reduce((min, move) => Math.min(min, move.z), Infinity) }))))
      if (!verifyOnly) writeFileSync(driver.output('build-steps.json'), JSON.stringify(driver.steps, null, 2) + '\n')
      const publicProject = path.join(folder, 'knob-handwheel.camproject')
      if (!verifyOnly) copyFileSync(path.join(root, evidence, 'knob-handwheel.camproject'), publicProject)
      else {
        const state = await driver.readState()
        const expected = portableSnapshot(saved)
        const observed = portableSnapshot(state.project, state.toolLibrary)
        assert.deepEqual(observed, expected)
        writeFileSync(driver.output('round-trip.json'), JSON.stringify({ saved: expected, reopened: observed }, null, 2) + '\n')
      }
      const reopened = driver.page
      await reopened.setViewportSize({ width: 1920, height: 1080 })
      watch(reopened)
      await reopened.getByTestId('mode-tab-setup').click()
      // File open restores paths, but recompute each one to prove the references
      // are usable in a fresh kernel session, rather than trusting saved status.
      if (await reopened.locator('.tree-op').count() === 0) await reopened.locator('.tree-setup-header').click()
      if (!simulationOnly) for (let index = 0; index < 3; index++) {
        const row = reopened.locator('.tree-op').nth(index)
        const id = saved.setups[0].operations[index].id
        const beforeComputeMs = (await driver.readState()).project.setups[0].operations[index].computeTimeMs
        await driver.step(`Recompute reopened operation ${index + 1}`, async () => {
          await row.getByRole('button', { name: 'Compute toolpath', exact: true }).click()
        }, async state => {
            const op = state.project.setups[0].operations.find(op => op.id === id)
            if (op.status === 'error') throw new Error(JSON.stringify(op))
            return op.status === 'ready' && op.computeTimeMs !== beforeComputeMs &&
              await row.getByRole('button', { name: 'Compute toolpath', exact: true }).count() > 0
          }, { timeoutMs: 600_000 })
      }
      await driver.step('Select all reopened operations', () => reopened.locator('.tree-setup-header').click(),
        state => state.project.activeOperationId === null && operationsReady(state.project))
      if (await reopened.locator('.tree-op').count() === 0) await reopened.locator('.tree-setup-header').click()
      await reopened.getByTestId('mode-tab-toolpath').click()
      await reopened.screenshot({ path: driver.output('reopened.png') })
      copyFileSync(path.join(root, evidence, 'reopened.png'), path.join(folder, 'reopened.png'))

      const posts = []
      if (!simulationOnly) {
      await reopened.getByTestId('mode-tab-postprocess').click()
      for (const dialect of ['UCCNC', 'GRBL', 'grblHAL', 'LinuxCNC', 'Generic (linear only)']) {
        await reopened.getByTestId('post-definition-select').click()
        await reopened.getByRole('option', { name: dialect, exact: true }).click()
        const button = reopened.locator('.post-modal').getByRole('button', { name: /^Export(?: \.| \d)/ })
        await button.waitFor()
        await driver.step(`Post all operations using ${dialect}`, async () => {
          const download = reopened.waitForEvent('download', { timeout: 120_000 })
          await button.click()
          const file = driver.output(`posts/${dialect.split(' ')[0]}.nc`)
          await (await download).saveAs(file)
          const gcode = readFileSync(file, 'utf8')
          assert(gcode.length > 100)
          posts.push({ dialect, lines: gcode.split(/\r?\n/).length })
        }, state => operationsReady(state.project))
      }
      await reopened.locator('.post-modal').getByRole('button', { name: 'Cancel', exact: true }).click()
      writeFileSync(driver.output('recompute-post-steps.json'), JSON.stringify(driver.steps, null, 2) + '\n')
      } else {
        for (const dialect of ['UCCNC', 'GRBL', 'grblHAL', 'LinuxCNC', 'Generic (linear only)']) {
          const gcode = readFileSync(path.join(root, evidence, 'posts', `${dialect.split(' ')[0]}.nc`), 'utf8')
          posts.push({ dialect, lines: gcode.split(/\r?\n/).length })
        }
      }

      await reopened.getByRole('button', { name: 'Application settings', exact: true }).click()
      await reopened.getByTestId('settings-sim-engine').click()
      await driver.step('Select the app heightmap stock simulation', () => reopened.getByRole('option', { name: '2.5D - fast (low-end GPUs)', exact: true }).click(),
        state => state.appSettings.simulationEngine === 'heightmap')
      await reopened.getByRole('button', { name: 'Done', exact: true }).click()
      // Entering Simulate on this 176k-move project with the exact 3-part vise blocks the page ~85 s in the
      // workholding contact check (workholdingContact.ts columnsHitCylinder, 10-09 profile). Wait it out here;
      // the freeze itself is a product finding (fixed by WO-2706), not a reason for this kit to fail.
      await reopened.getByTestId('mode-tab-simulation').click({ timeout: 300_000 })
      await driver.step('Enable stock removal for complete setup', () => reopened.getByLabel('Simulate Stock Removal').check(),
        async state => await reopened.getByLabel('Simulate Stock Removal').isChecked() && state.project.activeOperationId === null)
      await reopened.getByTestId('sim-hide-toolpath').check()
      await reopened.getByTestId('sim-display-stock').click()
      const slider = reopened.getByRole('slider', { name: 'Simulation position' })
      await reopened.waitForFunction(() => Number(document.querySelector('[aria-label="Simulation position"]')?.max) > 0)
      const durationMs = Number(await slider.getAttribute('max'))
      await slider.evaluate((element, ms) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        setter.call(element, String(ms))
        element.dispatchEvent(new Event('input', { bubbles: true }))
        element.dispatchEvent(new Event('change', { bubbles: true }))
      }, durationMs / 2)
      await reopened.waitForFunction(() => {
        const slider = document.querySelector('[aria-label="Simulation position"]')
        const panel = document.querySelector('.sim-panel[data-stock-sync="exact"]')
        return panel && slider && Math.abs(Number(panel.dataset.stockMs) - Number(slider.value)) <= 1 && Number(slider.value) > 0
      }, null, { timeout: 180_000 })
      await reopened.screenshot({ path: driver.output('simulation-mid-cut.png') })
      await reopened.getByRole('button', { name: 'Skip to end', exact: true }).click()
      await reopened.waitForFunction(() => {
        const slider = document.querySelector('[aria-label="Simulation position"]')
        const panel = document.querySelector('.sim-panel[data-stock-sync="exact"]')
        return panel && slider && Math.abs(Number(slider.value) - Number(slider.max)) <= 1 && Math.abs(Number(panel.dataset.stockMs) - Number(slider.max)) <= 1
      }, null, { timeout: 180_000 })
      const surface = await reopened.evaluate(() => {
        const layout = window.__cncViewport?.stockSimLayout
        if (!layout) throw new Error('App rendered stock surface missing')
        return { positions: Array.from(layout.topPositions), indices: Array.from(layout.topIndices) }
      })
      const removedVolumeMm3 = removedVolume(saved.stocks[0].bounds.max.z, surface.positions, surface.indices)
      assert(Number.isFinite(removedVolumeMm3) && removedVolumeMm3 > 0)
      await reopened.screenshot({ path: driver.output('simulation-end.png') })
      await reopened.getByTestId('console-strip').click()
      const appConsole = await reopened.getByTestId('console-timeline').innerText()
      assert.equal(await reopened.locator('.console-event.console-severity-error').count(), 0, appConsole)
      log.push(`APP CONSOLE\n${appConsole}`)

      await driver.open()
      const importedPage = driver.page
      watch(importedPage)
      await importedPage.setViewportSize({ width: 1920, height: 1080 })
      await importedPage.getByTestId('mode-tab-part').click()
      // WO-2700: the plain Model tab opens the New Model dialog; Create Model is the operator's way in.
      await importedPage.getByTestId('model-entry-new').click()
      await importedPage.getByTestId('workbench-import-step-input').setInputFiles(stepFile)
      const importedVolume = importedPage.getByTestId(/^body-volume-/).first()
      await importedVolume.waitFor({ timeout: 180_000 })
      const stepVolumeMm3 = Number((await importedVolume.innerText()).split(' ')[0])
      assert(Math.abs(stepVolumeMm3 - volume) / volume <= 0.005)
      const report = {
        source: 'docs/examples/form/lobed-knob.camproject',
        projectSha256: createHash('sha256').update(readFileSync(publicProject, 'utf8').replaceAll('\r\n', '\n')).digest('hex'),
        stepSha256: createHash('sha256').update(readFileSync(stepFile, 'utf8').replaceAll('\r\n', '\n')).digest('hex'),
        bodyVolumeMm3: volume, stepVolumeMm3, removedVolumeMm3,
        simulation: { durationMs, completed: true, engine: 'heightmap', operations: 3 },
        posts, consoleErrors: 0,
        machiningScope: `First side: Clear all stock rough and waterline finish stop ${-FLOOR_WCS} mm below stock top (${FINISH_DEPTH.waterline_3d} mm below the knob top), leaving the grip on a flat floor; parallel finishes the top ${FINISH_DEPTH.parallel_3d} mm. Underside and shaft require another setup.`,
        licence: 'Apache-2.0, made for the release',
      }
      writeFileSync(driver.output('verification.json'), JSON.stringify(report, null, 2) + '\n')
      rmSync(path.join(root, evidence, 'knob-handwheel.camproject'), { force: true })
      console.log(JSON.stringify(report, null, 2))
    } finally {
      writeFileSync(driver.output('console.log'), log.join('\n') + '\n')
    }
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Default to the current kit baseline. The historical Form rebuild is kept
  // explicit so routine regeneration cannot discard later kit corrections.
  if (process.argv.includes('--rebuild-model')) {
    await buildKnobHandwheel()
    await rebuildKnobWorkholding()
  } else await rebuildKnobWorkholding()
}
