import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { withExampleDriver } from './lib/drive.mjs'
import { scanDirectory } from '../release/scan.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const PART = path.join(ROOT, 'examples/05-name-sign')
const EVIDENCE = 'src/tests/evidence/WO-2444'
export const CARVE_DEPTH = 1
export const HOLDING_NOTE = 'Apply masking tape to the spoilboard and the underside of the whole blank; bond the taped faces with superglue. After machining, release the tape and glue, cut the 4 tabs and sand the stubs.'

export function postedDepths(gcode) {
  const carve = gcode.split('( V-carve 1 )')[1]?.split('( Contour 2 )')[0]
  const contour = gcode.split('( Contour 2 )')[1]
  assert.ok(carve && contour, 'Both operations must be posted')
  const minimum = text => Math.min(...Array.from(text.matchAll(/\bZ(-?\d+(?:\.\d+)?)/g), match => Number(match[1])))
  return { carve: minimum(carve), contour: minimum(contour) }
}

// Original block lettering, not font outlines. SVG paths are the actual inputs
// imported by the app; the A counter teaches carving around an island.
export function sourceFiles() {
  const glyphs = [
    'M0 0H3V21H14V24H0Z',
    'M0 0H14V3H8.5V21H14V24H0V21H5.5V3H0Z',
    'M0 0H14V3H3V10.5H12V13.5H3V21H14V24H0Z',
    'M0 24V0H3L11 17V0H14V24H11L3 7V24Z',
    'M14 0V3H3V21H14V24H0V0Z',
    'M0 24L5 0H9L14 24H11L9.5 17H4.5L3 24Z M5.2 14H8.8L7 5Z',
    'M0 24V0H3L7 10L11 0H14V24H11V7L7 17L3 7V24Z',
  ]
  const svg = body => `<svg xmlns="http://www.w3.org/2000/svg" width="160mm" height="52mm" viewBox="0 0 160 52"><title>LIENCAM name sign - original release artwork</title><desc>Apache-2.0. Made for the release. All dimensions in mm.</desc>${body}</svg>\n`
  return {
    'lettering.svg': svg(glyphs.map((d, i) => `<path transform="translate(${15 + i * 18} 14)" fill-rule="evenodd" d="${d}"/>`).join('')),
    'profile.svg': svg('<path d="M0 6L6 0H154L160 6V46L154 52H6L0 46Z"/>'),
  }
}

async function field(page, label, value) {
  const row = page.locator('.op-field-row').filter({ has: page.locator('.op-field-label').filter({ hasText: new RegExp(`^${label.replace(/[()]/g, '\\$&')}$`) }) })
  const input = row.locator('input')
  await input.fill(String(value))
  await input.press('Tab')
}

async function tab(page, name) { await page.locator('.op-modal-tab').filter({ hasText: new RegExp(`^${name}$`) }).click() }

async function view(page, name) {
  await page.locator('.viewport-canvas canvas').first().click({ button: 'right', position: { x: 400, y: 250 } })
  await page.getByRole('menuitem', { name, exact: true }).click()
}

async function capture(driver, name) {
  const page = driver.page
  await view(page, 'Fit all')
  await view(page, name.startsWith('simulation') ? 'Isometric view' : 'Top view')
  await page.waitForTimeout(500)
  await page.screenshot({ path: driver.output(name) })
}

async function consoleReadback(driver, name) {
  const page = driver.page
  if (await page.getByTestId('console-strip').getAttribute('aria-expanded') !== 'true') await page.getByTestId('console-strip').click()
  await page.getByTestId('console-filter-all').click()
  const events = await page.locator('.console-event').evaluateAll(nodes => nodes.map(n => ({ text: n.textContent, error: n.classList.contains('console-severity-error') })))
  writeFileSync(driver.output(name), `${JSON.stringify(events, null, 2)}\n`)
  assert.equal(events.filter(e => e.error).length, 0, 'Application console must contain no error events')
  await page.getByTestId('console-strip').click()
  return events
}

async function operation(driver, type, geometryName, toolName) {
  const page = driver.page
  await page.getByRole('button', { name: 'Add operation', exact: true }).click()
  await page.locator('.op-type-card').filter({ hasText: type === 'vcarve' ? /^V-Carve/ : /^2D Contour/ }).click()
  await tab(page, 'Tool')
  await page.locator('.op-tool-row').filter({ hasText: toolName }).click()
  await tab(page, 'Geometry')
  const geometry = (await driver.readState()).project.geometry.find(g => g.name.includes(geometryName))
  assert.ok(geometry)
  await page.getByTestId('op-geometry-select').selectOption(geometry.id)
  await page.getByRole('button', { name: /^All loops/ }).click()
  await tab(page, 'Passes')
  if (type === 'vcarve') {
    await page.getByTestId('vcarve-depth-flat').click()
    await field(page, 'Flat depth', CARVE_DEPTH)
    await field(page, 'Stepdown', 0.5)
    await page.getByTestId('vcarve-clear-vbit').click()
    await field(page, 'Floor stepover', 0.3)
  } else {
    await field(page, 'Stepdown', 0.5)
    await tab(page, 'Linking')
    await page.getByTestId('contour-tabs-enabled').check()
    await field(page, 'Tab width', 6)
    await field(page, 'Tab height', 1.5)
    await field(page, 'Tab count', 4)
    await page.getByTestId('contour-tab-shape').selectOption('triangular')
    await tab(page, 'Heights')
    const expand = page.getByRole('button', { name: /^Expand Bottom.*height$/i })
    if (await expand.count()) await expand.click()
    await page.getByTestId('contour-height-mode').selectOption('through_stock')
    await field(page, 'Past stock bottom', 0.2)
  }
  return driver.step(`Create ${type} using ${toolName}`, p => p.getByTestId('op-create').click(), state => {
    const op = state.project.setups[0].operations.find(o => o.type === type)
    return op?.params.geometryId === geometry.id && state.toolLibrary.find(t => t.id === op.toolId)?.name === toolName &&
      (type !== 'vcarve' || op.params.flatDepthMm === CARVE_DEPTH) &&
      (type !== 'contour_2d' || (op.params.tabs === true && op.params.tabShape === 'triangular'))
  })
}

async function regenerate(driver, label) {
  const state = await driver.step(label, page => page.getByRole('button', { name: 'REGEN ALL' }).click(), state =>
    state.project.setups[0].operations.length === 2 && state.project.setups[0].operations.every(o => o.status === 'ready'), { timeoutMs: 120_000 })
  await consoleReadback(driver, `${label.startsWith('Reopen') ? 'reopened' : 'built'}-console.json`)
  return state
}

// Sample the actual application's Cut Stock texture around the cutter's closed
// outline. Four solid runs at the bottom, and none above the tab tops, distinguish
// retained bridges from an uncut perimeter. Never seed a second simulation.
async function tabReadback(driver, project) {
  const setup = project.setups[0]
  const op = setup.operations.find(o => o.type === 'contour_2d')
  const tool = project.toolLibrary.find(t => t.id === op.toolId)
  const points = project.geometry.find(g => g.id === op.params.geometryId).loops[0].points
  return driver.page.evaluate(({ points, radius, tabHeight }) => {
    const vp = window.__cncViewport, image = vp.voxelSimTexture.texture.image
    const uniforms = vp.voxelSimMaterial.uniforms, min = uniforms.uFieldMin.value, cell = uniforms.uVoxelSize.value
    const area = points.reduce((sum, p, i) => { const q = points[(i + 1) % points.length]; return sum + p.x * q.y - q.x * p.y }, 0)
    const edges = points.map((p, i) => {
      const q = points[(i + 1) % points.length], dx = q.x - p.x, dy = q.y - p.y, len = Math.hypot(dx, dy)
      const n = area > 0 ? { x: dy / len, y: -dx / len } : { x: -dy / len, y: dx / len }
      return { x: p.x + radius * n.x, y: p.y + radius * n.y, dx, dy, n }
    })
    const outline = edges.map((b, i) => {
      const a = edges[(i + edges.length - 1) % edges.length]
      const cross = a.dx * b.dy - a.dy * b.dx
      const t = ((b.x - a.x) * b.dy - (b.y - a.y) * b.dx) / cross
      return { x: a.x + t * a.dx, y: a.y + t * a.dy }
    })
    const solid = (x, y, z) => {
      const ix = Math.floor((x - min.x) / cell), iy = Math.floor((y - min.y) / cell), iz = Math.floor((z - min.z) / cell)
      if (ix < 0 || iy < 0 || iz < 0 || ix >= image.width || iy >= image.height || iz >= image.depth) throw new Error('Tab probe outside live field')
      return image.data[iz * image.width * image.height + iy * image.width + ix] >= 0
    }
    const bottom = [], above = [], bridges = []
    for (let i = 0; i < outline.length; i++) {
      const p = outline[i], q = outline[(i + 1) % outline.length], n = edges[i].n
      const samples = Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / (cell / 2))
      for (let j = 0; j < samples; j++) {
        const x = p.x + (q.x - p.x) * j / samples, y = p.y + (q.y - p.y) * j / samples
        bottom.push(solid(x, y, min.z + cell / 2))
        above.push(solid(x, y, min.z + tabHeight + cell / 2))
        bridges.push([-radius, 0, radius].every(d => solid(x + n.x * d, y + n.y * d, min.z + cell / 2)))
      }
    }
    const runs = values => values.reduce((count, v, i) => count + (v && !values[(i + values.length - 1) % values.length] ? 1 : 0), 0)
    return { source: 'Live app Cut Stock voxel texture, full offset outline', cellMm: cell, samples: bottom.length,
      bottomSolidRuns: runs(bottom), bottomBridgeRuns: runs(bridges), aboveTabSolidSamples: above.filter(Boolean).length,
      bottomSolidSamples: bottom.filter(Boolean).length, display: document.querySelector('[data-testid="sim-display-stock"]')?.getAttribute('aria-pressed') }
  }, { points, radius: tool.diameter / 2, tabHeight: op.params.tabHeight })
}

export async function buildNameSign() {
  mkdirSync(PART, { recursive: true })
  for (const name of ['name-sign.camproject', 'reopened.png']) rmSync(path.join(PART, name), { force: true })
  for (const [name, text] of Object.entries(sourceFiles())) writeFileSync(path.join(PART, name), text)
  return withExampleDriver({ outDir: EVIDENCE }, async driver => {
    for (const name of ['model.png', 'toolpaths.png', 'simulation-mid-cut.png', 'simulation-end.png', 'verification.json',
      'browser-console.json', 'built-console.json', 'reopened-console.json', 'posted-console.json', 'simulation-console.json',
      'scan.json', 'name-sign.camproject', 'name-sign.nc', 'name-sign.setup.txt', 'name-sign.setup.pdf']) driver.output(name)
    const browserEvents = []
    const watch = page => {
      page.on('console', msg => browserEvents.push({ type: msg.type(), text: msg.text() }))
      page.on('pageerror', error => browserEvents.push({ type: 'pageerror', text: error.message }))
    }
    watch(driver.page)
    await driver.page.setViewportSize({ width: 1920, height: 1080 })
    await driver.newProject()
    await driver.step('Name the release project', async page => {
      await page.getByTestId('tree-name-project').dblclick()
      await page.getByTestId('tree-rename-input').fill('05 Name sign')
      await page.getByTestId('tree-rename-input').press('Enter')
    }, state => state.project.name === '05 Name sign' && state.project.machine.id === 'default-machine')
    await driver.setStock({ width: 176, height: 68, depth: 6 })
    // Imported SVG outlines are centered by the production importer. Fixed
    // stock positions specify a lower corner, so put that corner around them.
    for (const [label, axis, value] of [['Pos X', 'x', -88], ['Pos Y', 'y', -34]]) {
      await driver.step(`Center stock ${axis}`, async page => {
        const input = page.locator('.fixed-stock-node .stock-field-row').filter({ hasText: label }).locator('input')
        await input.fill(String(value))
        await input.press('Enter')
      }, state => state.project.sceneStock.fixedStocks[0].position[axis] === value)
    }
    await driver.importTools('examples/tools/starter-tools-metric.json')
    for (const name of ['lettering.svg', 'profile.svg']) {
      const before = (await driver.readState()).project.geometry.length
      await driver.step(`Import ${name}`, async page => {
        const chooser = page.waitForEvent('filechooser')
        await page.getByRole('button', { name: 'Import geometry', exact: true }).click()
        await (await chooser).setFiles(path.join(PART, name))
      }, state => state.project.geometry.length === before + 1 && state.project.geometry.at(-1).loops?.length > 0)
      const stockId = (await driver.readState()).project.sceneStock.fixedStocks[0].id
      await driver.step(`Bind ${name} to sign stock`, page => page.getByTestId(`import-stock-choice-stock-${stockId}`).click(),
        state => state.project.geometry.at(-1).stockId === stockId)
    }
    await capture(driver, 'model.png')
    const stock = (await driver.readState()).project.sceneStock.fixedStocks[0]
    await driver.page.getByRole('button', { name: 'Add setup', exact: true }).click()
    await driver.page.locator('.wcs-stock-select').selectOption(stock.id)
    await driver.step('Create setup bound to sign stock', page => page.getByRole('button', { name: 'Create Setup', exact: true }).click(),
      state => state.project.setups[0]?.wcs.stockId === stock.id)
    await driver.page.locator('.tree-setup-name').first().click()
    await driver.step('Record tape and glue under the whole blank', async page => {
      await page.getByTestId('setup-holding-method').selectOption('tape_glue')
      await page.getByTestId('setup-holding-note').fill(HOLDING_NOTE)
      await page.getByTestId('setup-holding-note').press('Tab')
    }, state => state.project.setups[0].holdingMethod === 'tape_glue' && state.project.setups[0].notes === HOLDING_NOTE)
    await operation(driver, 'vcarve', 'lettering', '6 mm 60 deg V-bit')
    await operation(driver, 'contour_2d', 'profile', '3 mm flat end mill')
    await regenerate(driver, 'Compute built operations')
    await driver.page.locator('.tree-setup-name').first().click()
    if (!await driver.page.getByRole('button', { name: 'Compute toolpath', exact: true }).count()) await driver.page.locator('.tree-setup-name').first().click()
    await driver.page.getByTestId('mode-tab-toolpath').click()
    await capture(driver, 'toolpaths.png')
    const saved = await driver.saveAndReopen('name-sign.camproject')
    watch(driver.page)
    await driver.page.setViewportSize({ width: 1920, height: 1080 })
    const reopened = await regenerate(driver, 'Reopen and compute operations')
    assert.equal(saved.setups[0].holdingMethod, 'tape_glue')
    assert.equal(reopened.project.setups[0].holdingMethod, saved.setups[0].holdingMethod)
    assert.equal(reopened.project.setups[0].notes, HOLDING_NOTE)
    assert.deepEqual(reopened.project.setups[0].operations.find(o => o.type === 'contour_2d').params, saved.setups[0].operations.find(o => o.type === 'contour_2d').params)
    await driver.page.locator('.tree-setup-name').first().click()
    if (!await driver.page.getByRole('button', { name: 'Compute toolpath', exact: true }).count()) await driver.page.locator('.tree-setup-name').first().click()
    await driver.page.getByTestId('mode-tab-toolpath').click()
    await capture(driver, 'reopened.png')
    await driver.page.getByTestId('mode-tab-postprocess').click()
    const downloadPromise = driver.page.waitForEvent('download')
    await driver.page.getByRole('button', { name: /^Export \./ }).click()
    const gcodeFile = driver.output('name-sign.nc')
    await (await downloadPromise).saveAs(gcodeFile)
    const gcode = readFileSync(gcodeFile, 'utf8')
    const depths = postedDepths(gcode)
    assert.equal(depths.carve, -CARVE_DEPTH)
    assert.equal(depths.contour, -6.2)
    // The production control downloads both formats for the freshly posted NC.
    const sheetDownloads = []
    const collectSheet = download => sheetDownloads.push(download)
    driver.page.on('download', collectSheet)
    try {
      await driver.page.getByTestId('post-download-setup-sheet').click()
      const deadline = Date.now() + 120_000
      while (sheetDownloads.length < 2 && Date.now() < deadline) await driver.page.waitForTimeout(100)
      assert.equal(sheetDownloads.length, 2, 'Setup Sheet must download text and PDF')
      for (const download of sheetDownloads) {
        const ext = download.suggestedFilename().endsWith('.pdf') ? 'pdf' : 'txt'
        await download.saveAs(driver.output(`name-sign.setup.${ext}`))
      }
    } finally { driver.page.off('download', collectSheet) }
    const sheet = readFileSync(path.join(driver.outDir, 'name-sign.setup.txt'), 'utf8')
    assert.match(sheet, /Method: Tape and glue/)
    assert.match(sheet, /4 tabs/)
    assert.match(sheet, /6(?:\.0+)?mm wide x 1\.5(?:0+)?mm high, triangular/)
    assert.match(sheet, /cut the 4 tabs and sand the stubs/)
    await driver.page.locator('.post-modal').getByRole('button', { name: 'Cancel', exact: true }).click()
    await consoleReadback(driver, 'posted-console.json')
    await driver.page.getByTestId('mode-tab-simulation').click()
    await driver.page.getByLabel('Simulate Stock Removal').check()
    await driver.page.getByRole('button', { name: 'Cut Stock', exact: true }).click()
    await driver.page.getByTestId('sim-hide-toolpath').check()
    await driver.page.waitForFunction(() => window.__cncViewport?.voxelSimTexture?.texture.image.data.length > 0)
    const baseline = await driver.page.evaluate(() => {
      const vp = window.__cncViewport, image = vp.voxelSimTexture.texture.image
      return { solidSamples: Array.from(image.data).filter(v => v >= 0).length, cell: vp.voxelSimMaterial.uniforms.uVoxelSize.value }
    })
    const scrubber = driver.page.getByRole('slider', { name: 'Simulation position' })
    const totalMs = Number(await scrubber.getAttribute('max'))
    assert.ok(totalMs > 0)
    await scrubber.fill(String(Math.round(totalMs * 0.4)))
    await driver.page.waitForFunction(() => document.querySelector('.sim-panel')?.getAttribute('data-stock-sync') === 'exact', null, { timeout: 120_000 })
    await capture(driver, 'simulation-mid-cut.png')
    await driver.step('Simulate the complete setup to the end', page => page.getByRole('button', { name: 'Skip to end', exact: true }).click(), async state =>
      state.project.setups[0].operations.every(o => o.status === 'ready') && !state.project.activeOperationId && await driver.page.evaluate(() => {
        const slider = document.querySelector('.sim-scrubber'), panel = document.querySelector('.sim-panel')
        // Native step=1 rounds slider values; the panel publishes rounded ms,
        // while the actual duration retains fractional move timing.
        return document.querySelector('[data-testid="mode-tab-simulation"]')?.classList.contains('mode-tab-active') &&
          slider && Math.abs(Number(slider.value) - Number(slider.max)) <= 1 && panel?.getAttribute('data-stock-sync') === 'exact' && Number(panel.getAttribute('data-stock-ms')) === Math.round(Number(slider.max))
      }), { timeoutMs: 120_000 })
    const simulation = await driver.page.evaluate(() => {
      const vp = window.__cncViewport
      const image = vp.voxelSimTexture?.texture.image
      if (!image) throw new Error('Expected live voxel simulation texture')
      const cell = vp.voxelSimMaterial.uniforms.uVoxelSize.value
      const panel = document.querySelector('.sim-panel'), slider = document.querySelector('.sim-scrubber')
      return { engine: 'voxel', solidSamples: Array.from(image.data).filter(v => v >= 0).length, cell,
        markerMs: Number(slider.value), stockMs: Number(panel.getAttribute('data-stock-ms')), stockSync: panel.getAttribute('data-stock-sync') }
    })
    simulation.initialSolidSamples = baseline.solidSamples
    simulation.removedVolumeMm3 = (baseline.solidSamples - simulation.solidSamples) * simulation.cell ** 3
    simulation.measurement = 'Live app voxel texture: change in solid sample count x cell^3 (resolution estimate)'
    assert.ok(simulation.removedVolumeMm3 > 0)
    simulation.tabs = await tabReadback(driver, saved)
    assert.equal(simulation.tabs.display, 'true')
    assert.equal(simulation.tabs.bottomSolidRuns, 4, 'Only four tab regions may join the frame')
    assert.equal(simulation.tabs.bottomBridgeRuns, 4, 'Each tab must bridge the full cutter slot')
    assert.equal(simulation.tabs.aboveTabSolidSamples, 0, 'Perimeter above the tabs must be cut through')
    await capture(driver, 'simulation-end.png')
    await consoleReadback(driver, 'simulation-console.json')
    writeFileSync(driver.output('browser-console.json'), `${JSON.stringify(browserEvents, null, 2)}\n`)
    assert.equal(browserEvents.filter(e => e.type === 'pageerror' || e.type === 'error').length, 0)
    const report = { holdingMethod: reopened.project.setups[0].holdingMethod, notes: reopened.project.setups[0].notes,
      contourParams: reopened.project.setups[0].operations.find(o => o.type === 'contour_2d').params,
      operations: reopened.project.setups[0].operations.map(o => ({ name: o.name, type: o.type, status: o.status, moveCount: saved.setups[0].operations.find(s => s.id === o.id).toolpathMoves.length })), postedDepths: depths, simulation, totalMs, sourceRevision: (await import('node:child_process')).execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim() }
    writeFileSync(driver.output('verification.json'), `${JSON.stringify(report, null, 2)}\n`)
    copyFileSync(path.join(driver.outDir, 'name-sign.camproject'), path.join(PART, 'name-sign.camproject'))
    copyFileSync(path.join(driver.outDir, 'reopened.png'), path.join(PART, 'reopened.png'))
    const scan = scanDirectory(PART)
    writeFileSync(driver.output('scan.json'), `${JSON.stringify(scan, null, 2)}\n`)
    assert.deepEqual(scan.hits, [])
    return saved
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildNameSign()
