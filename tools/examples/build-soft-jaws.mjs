// WO-2442: rebuild the preserved modeled jaws through production controls.
// npm run build; node tools/examples/build-soft-jaws.mjs
import assert from 'node:assert/strict'
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { withExampleDriver } from './lib/drive.mjs'

const out = 'src/tests/evidence/WO-2442/rebuild'
const part = 'examples/03-soft-jaws'
const seed = 'src/tests/evidence/WO-2442/build-seed.camproject'

await withExampleDriver({ outDir: out }, async d => {
  let page = d.page
  const errors = []
  const listen = () => page.on('pageerror', error => errors.push(error.message))
  listen()
  for (const name of ['readback.json', 'toolpaths.png', 'simulation-end.png', 'simulation-end-jaw-2.png', 'posts.json']) d.output(name)
  const source = process.argv.includes('--verify-only') ? path.join(out, 'soft-jaws.camproject') : seed
  await d.step('Open the preserved modeled jaw pair and demonstration vise', async () => {
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: 'Open project', exact: true }).click()
    await (await chooser).setFiles(path.resolve(source))
  }, s => s.project.id === JSON.parse(readFileSync(source, 'utf8')).id)
  await page.setViewportSize({ width: 1920, height: 1080 })
  async function view() {
    for (const name of ['Isometric view', 'Fit all']) {
      await page.locator('.viewport-canvas').click({ button: 'right', position: { x: 60, y: 60 } })
      await page.getByRole('menuitem', { name, exact: true }).click()
      await page.waitForTimeout(700)
    }
  }
  async function selectSetup(i) { await page.locator('.tree-setup-header').nth(i).click() }
  if (!process.argv.includes('--verify-only')) {
  const original = (await d.readState()).project
  await view()
  await page.screenshot({ path: d.output('before.png') })
  for (const op of original.setups[0].operations) {
    await page.getByTestId('tree-name-op').filter({ hasText: op.name }).locator('..')
      .getByRole('button', { name: 'Delete', exact: true }).click()
  }
  const first = page.locator('.fixed-stock-node').filter({ has: page.getByTestId('fixed-stock-gizmo-btn') }).first()
  if (!await first.locator('.stock-number-input').count()) await first.locator('.fixed-stock-header').click()
  for (const [label, key, value] of [['Width (X)', 'width', 80], ['Height (Y)', 'height', 18], ['Depth (Z)', 'depth', 16], ['Pos X', 'x', 0], ['Pos Y', 'y', 0]]) {
    await d.step(`First jaw blank ${label} = ${value}`, async () => {
      const input = first.locator('.stock-field-row').filter({ hasText: label }).locator('input')
      await input.fill(String(value)); await input.press('Enter')
    }, s => (label.startsWith('Pos') ? s.project.sceneStock.fixedStocks[0].position[key] : s.project.sceneStock.fixedStocks[0][key]) === value)
  }
  await d.setStock({ width: 80, height: 18, depth: 16 })
  const second = page.locator('.fixed-stock-node').filter({ has: page.getByTestId('fixed-stock-gizmo-btn') }).last()
  await d.step('Seat jaw 2 at Y 38 mm', async () => {
    const input = second.locator('.stock-field-row').filter({ hasText: 'Pos Y' }).locator('input')
    await input.fill('38'); await input.press('Enter')
  }, s => s.project.sceneStock.fixedStocks[1].position.y === 38)
  const stocks = (await d.readState()).project.sceneStock.fixedStocks
  // The old setup's stock-corner origin tracks the resized blank. Edit through
  // the setup modal so the durable binding and the displayed work offset agree.
  await page.getByRole('button', { name: 'Edit setup', exact: true }).first().click()
  await page.getByTestId('setup-modal-basics').locator('input').first().fill('Jaw 1 - G54')
  await page.getByTestId('stock-work-offset-select').selectOption('54')
  await d.step('Bind jaw 1 setup to G54', () => page.getByRole('button', { name: 'Save Setup', exact: true }).click(),
    s => s.project.setups[0].name === 'Jaw 1 - G54' && s.project.setups[0].wcs.fixtureOffset === 54)
  await page.getByRole('button', { name: 'Add setup', exact: true }).click()
  await page.locator('.wcs-stock-select').selectOption(stocks[1].id)
  await page.getByTestId('setup-modal-basics').locator('input').first().fill('Jaw 2 - G55')
  await page.getByTestId('stock-work-offset-select').selectOption('55')
  await d.step('Bind jaw 2 setup to its blank and G55', () => page.getByRole('button', { name: 'Create Setup', exact: true }).click(),
    s => s.project.setups.length === 2 && s.project.setups[1].wcs.stockId === stocks[1].id && s.project.setups[1].wcs.fixtureOffset === 55)
  for (let i = 0; i < 2; i++) {
    await page.locator('.tree-geo-stock-select').nth(i).selectOption(stocks[i].id)
  }
  await page.getByTestId('mode-tab-toollibrary').click()
  await d.step('Import the starter tools, retaining the existing facing tool', async () => {
    const chooser = page.waitForEvent('filechooser')
    await page.locator('.tool-modal').getByRole('button', { name: 'Import', exact: true }).click()
    await (await chooser).setFiles(path.resolve('examples/tools/starter-tools-metric.json'))
  }, s => ['3 mm drill', '3 mm flat end mill', '6 mm flat end mill'].every(name => s.toolLibrary.some(t => t.name === name)))
  await page.locator('.tool-modal .modal-close-btn').click()
  async function importProfile(name, svg, i, position) {
    const file = path.resolve(part, `${name}.svg`)
    writeFileSync(file, svg)
    await d.step(`Import ${name} for jaw ${i + 1}`, async () => {
      const chooser = page.waitForEvent('filechooser')
      await page.getByRole('button', { name: 'Import geometry', exact: true }).click()
      await (await chooser).setFiles(file)
      await page.getByTestId(`import-stock-choice-stock-${stocks[i].id}`).click()
    }, s => s.project.geometry.some(g => g.name === name && g.stockId === stocks[i].id))
    const geo = (await d.readState()).project.geometry.find(g => g.name === name)
    await page.getByTestId('tree-name-geometry').filter({ hasText: new RegExp(`^${name}$`) }).click()
    for (const [axis, value] of Object.entries(position)) {
      const input = page.locator('.props-transform-row').first().locator('.props-transform-cell')
        .filter({ hasText: new RegExp(`^${axis.toUpperCase()}$`) }).locator('input')
      await d.step(`Place ${name} ${axis}`, async () => { await input.fill(String(value)); await input.press('Enter') },
        s => s.project.geometry.find(g => g.id === geo.id).position[axis] === value)
    }
    return geo.id
  }
  async function tab(name) { await page.locator('.op-modal-tab').filter({ hasText: new RegExp(`^${name}$`) }).click() }
  async function field(label, value) {
    const input = page.locator('.op-field-row').filter({ has: page.locator('.op-field-label').getByText(label, { exact: true }) }).locator('input').first()
    await input.fill(String(value)); await input.press('Tab')
  }
  async function operation(i, type, title, tool, geoId) {
    await selectSetup(i)
    const count = (await d.readState()).project.setups[i].operations.length
    await page.locator('.tree-setup').nth(i).getByRole('button', { name: 'Add operation', exact: true }).click()
    await page.locator('.op-type-card').filter({ hasText: new RegExp(`^${title}$`) }).click()
    await tab('Tool')
    await page.locator('.op-tool-row').filter({ hasText: new RegExp(`^${tool}`) }).first().click()
    if (geoId) {
      await tab('Geometry')
      await page.getByTestId('op-geometry-select').selectOption(geoId)
      for (const checkbox of await page.locator('.op-loop-check input[type=checkbox]').all()) await checkbox.check()
      if (type === 'pocket_2d') await page.getByTestId('pocket-geometry-smart-height').click()
    }
    await tab('Heights')
    await page.getByRole('button', { name: /^Expand Bottom.*height$/i }).click()
    if (type === 'face') {
      await page.getByTestId('face-height-mode').selectOption('explicit_depth')
      const input = page.getByTestId('face-explicit-target').locator('input')
      await input.fill('-0.5'); await input.press('Tab')
    } else if (type === 'pocket_2d') {
      await page.getByTestId('standard-height-bottom-source-control').selectOption('wcs_plane')
      await page.getByTestId('standard-height-bottom-operator-control').selectOption('-')
      const input = page.getByTestId('standard-height-bottom-offset-control').locator('input')
      await input.fill('8'); await input.press('Tab')
    } else {
      await page.getByTestId('drill-bore-height-mode').selectOption('explicit_depth')
      await field('Material Start (WCS)', -0.5)
      await field('Target End (WCS)', type === 'drill' ? -16 : -3.5)
    }
    await d.step(`Create jaw ${i + 1} ${type}`, () => page.getByTestId('op-create').click(),
      s => s.project.setups[i].operations.length === count + 1 && s.project.setups[i].operations.at(-1).type === type)
  }
  for (let i = 0; i < 2; i++) {
    await selectSetup(i)
    await d.step(`Record vise and spacer for jaw ${i + 1}`, async () => {
      await page.getByTestId('setup-holding-method').selectOption('vise')
      await page.getByTestId('setup-holding-note').fill(`Starter demonstration vise: jaw ${i + 1}, 80 x 18 x 16 mm blank at Y ${i * 38} mm, ${i ? 'G55' : 'G54'}. Close the vise on a 20 mm spacer below Z 8 mm. Secure both jaw blanks in place of the hard jaws before facing and cutting the grip recess. Mounting features: two 3 mm holes at local X 20 and 60, Y 3 mm, and 6 mm counterbores, 3 mm deep below the faced top. The holes clear the support ledge; vertical bolts span the gap to the vise base. Use temporary clamps clear of the paths while machining mounting features; spindle stopped and parked before fitting bolts. This demonstration vise uses vertical mounting; adapt hole locations to the actual vise. Keep bolts, clamps and spacer below the cutter paths.`)
      await page.getByTestId('setup-holding-note').press('Tab')
    }, s => s.project.setups[i].holdingMethod === 'vise' && /20 mm spacer/.test(s.project.setups[i].notes))
    const grip = await importProfile(`grip-jaw-${i + 1}`, readFileSync(path.join(part, 'grip-profile.svg'), 'utf8'), i, { x: 40, y: 28, z: 8 })
    const holes = await importProfile(`mounting-jaw-${i + 1}`, '<svg xmlns="http://www.w3.org/2000/svg" width="80mm" height="18mm" viewBox="0 0 80 18"><g fill="none" stroke="black"><circle cx="20" cy="3" r="3"/><circle cx="60" cy="3" r="3"/></g></svg>\n', i, { x: 40, y: 3 + i * 38, z: 15.5 })
    await operation(i, 'face', '2D Face', '6 mm flat end mill')
    await operation(i, 'pocket_2d', '2D Pocket', '6 mm flat end mill', grip)
    await operation(i, 'drill', 'Drill', '3 mm drill', holes)
    await operation(i, 'bore', 'Bore', '3 mm flat end mill', holes)
  }
  }
  // --adjust-mounting resumes the completed construction checkpoint. The first
  // trial put drill centers over the support ledge: the production clearance
  // trim correctly left 0.25 mm of material. Move the holes into the free lip,
  // keeping all clearance checks in force and the existing vise unchanged.
  if (process.argv.includes('--adjust-mounting')) {
    for (let i = 0; i < 2; i++) {
      await page.getByTestId('tree-name-geometry').filter({ hasText: new RegExp(`^mounting-jaw-${i + 1}$`) }).click()
      const input = page.locator('.props-transform-row').first().locator('.props-transform-cell').filter({ hasText: /^Y$/ }).locator('input')
      await d.step(`Move jaw ${i + 1} mounting holes clear of vise ledge`, async () => {
        await input.fill(String(3 + i * 38)); await input.press('Enter')
      }, s => s.project.geometry.find(g => g.name === `mounting-jaw-${i + 1}`).position.y === 3 + i * 38)
      await selectSetup(i)
      const notes = (await d.readState()).project.setups[i].notes
      await page.getByTestId('setup-holding-note').fill(notes.replace('two 3 mm holes and', 'two 3 mm holes at local X 20 and 60, Y 3 mm, and').replace('Use temporary clamps', 'The holes clear the support ledge; vertical bolts span the gap to the vise base. Use temporary clamps'))
      await page.getByTestId('setup-holding-note').press('Tab')
    }
  }
  const beforePlacement = (await d.readState()).project
  const setup2Id = beforePlacement.setups[1].id
  if (!beforePlacement.workholding.instances.some(instance => instance.setupScope.kind === 'all' || instance.setupScope.setupIds.includes(setup2Id))) {
    const sourceVise = beforePlacement.workholding.instances[0]
    await selectSetup(1)
    await page.getByTestId('tree-vise-row').first().click()
    await d.step('Reuse the saved vise in the G55 setup', () => page.getByTestId('vise-place-another').click(),
      s => s.project.workholding.instances.some(instance => instance.setupScope.kind === 'setups' && instance.setupScope.setupIds.includes(setup2Id)))
    for (const axis of ['x', 'y', 'z']) {
      const value = sourceVise.worldPose.position[axis]
      const input = page.getByTestId(`vise-position-${axis}`)
      await d.step(`Seat the G55 vise at the same ${axis} coordinate`, async () => {
        await input.fill(String(value)); await input.press('Enter')
      }, s => s.project.workholding.instances.at(-1).worldPose.position[axis] === value)
    }
  }
  async function regenerate(label) {
    await d.step(label, async () => {
      await page.locator('.tree-section-regen-btn').click()
      await page.waitForTimeout(1200)
      await page.locator('.status-batch').waitFor({ state: 'hidden', timeout: 120000 })
    }, s => {
      const ops = s.project.setups.flatMap(x => x.operations)
      for (const op of ops) assert.notEqual(op.status, 'error', `${op.name}: ${op.error}`)
      return ops.length === 8 && ops.every(op => op.status === 'ready')
    }, { timeoutMs: 120000 })
  }
  await regenerate('Compute both jaw programs')
  await selectSetup(0)
  await page.getByTestId('mode-tab-toolpath').click()
  await view()
  await page.screenshot({ path: d.output('toolpaths.png') })
  const saved = await d.saveAndReopen('soft-jaws.camproject')
  page = d.page
  listen()
  await page.setViewportSize({ width: 1920, height: 1080 })
  await regenerate('Recompute both jaw programs after fresh reopen')
  const reopened = (await d.readState()).project
  assert.deepEqual(reopened.workholding, saved.workholding)
  await view()
  await page.screenshot({ path: d.output('reopened.png') })
  const posts = []
  const simulations = []
  for (let i = 0; i < 2; i++) {
    await selectSetup(i)
    await page.getByTestId('mode-tab-postprocess').click()
    await page.getByTestId('post-definition-select').click()
    await page.getByTestId('post-definition-select-option-uccnc').click()
    await page.waitForFunction(() => ![...document.querySelectorAll('.post-modal .diag-err')].some(el => /OP_COMPUTING/.test(el.textContent)), undefined, { timeout: 120000 })
    await page.waitForTimeout(1200)
    const diagnostics = await page.locator('.post-modal .diag-err').allTextContents()
    assert.deepEqual(diagnostics, [])
    const code = await page.getByTestId('post-gcode-preview').innerText()
    assert.match(code, new RegExp(`G${54 + i}\\b`))
    const download = page.waitForEvent('download')
    await page.locator('.post-modal').getByRole('button', { name: /^Export / }).click()
    const nc = `jaw-${i + 1}.nc`
    await (await download).saveAs(d.output(nc))
    posts.push({ setupId: reopened.setups[i].id, offset: `G${54 + i}`, file: nc, diagnostics, bytes: readFileSync(path.join(out, nc)).length })
    const sheets = []
    const listener = download => sheets.push(download)
    page.on('download', listener)
    await page.getByTestId('post-download-setup-sheet').click()
    for (let n = 0; n < 120 && sheets.length < 2; n++) await page.waitForTimeout(500)
    page.off('download', listener)
    assert.equal(sheets.length, 2)
    for (const sheet of sheets) await sheet.saveAs(d.output(`jaw-${i + 1}.setup.${sheet.suggestedFilename().endsWith('.pdf') ? 'pdf' : 'txt'}`))
    await page.locator('.post-modal .modal-close-btn').first().click()
    await page.getByTestId('mode-tab-simulation').click()
    const removal = page.getByLabel('Simulate Stock Removal', { exact: true })
    await removal.check()
    await page.getByRole('button', { name: 'Rewind to start', exact: true }).click()
    await page.waitForTimeout(1000)
    async function material() {
      return page.evaluate(jawIndex => {
        const vp = window.__cncViewport
        const uniforms = vp.voxelSimMaterial?.uniforms
        if (!uniforms) throw new Error('Expected production voxel stock field')
        const min = uniforms.uFieldMin.value, max = uniforms.uFieldMax.value
        const image = vp.voxelSimTexture.texture.image
        const data = image.data
        let solid = 0
        for (const value of data) if (value >= 0) solid++
        const cell = uniforms.uVoxelSize.value
        const sample = (x, y, z) => {
          const ix = Math.floor((x - min.x) / cell), iy = Math.floor((y - min.y) / cell), iz = Math.floor((z - min.z) / cell)
          if (ix < 0 || iy < 0 || iz < 0 || ix >= image.width || iy >= image.height || iz >= image.depth) throw new Error('Sample outside stock field')
          return data[iz * image.width * image.height + iy * image.width + ix]
        }
        return { x0: min.x, x1: max.x, y0: min.y, y1: max.y, z0: min.z, z1: max.z, solid, cell, volumeMm3: solid * cell ** 3,
          samples: { grip: sample(40, jawIndex ? 40 : 16, 12), retained: sample(10, 9 + jawIndex * 38, 10), hole: sample(20, 3 + jawIndex * 38, 0.25), counterbore: sample(22, 3 + jawIndex * 38, 14) } }
      }, i)
    }
    const initial = await material()
    await page.getByRole('button', { name: 'Skip to end', exact: true }).click()
    await page.locator('.sim-carve-progress').waitFor({ state: 'hidden', timeout: 120000 })
    await page.waitForTimeout(1200)
    await page.getByRole('button', { name: 'Cut Stock', exact: true }).click()
    const final = await material()
    assert(initial.volumeMm3 > final.volumeMm3, `Jaw ${i + 1} must remove material`)
    const slider = page.getByRole('slider', { name: 'Simulation position', exact: true })
    const positionMs = Number(await slider.inputValue()), totalMs = Number(await slider.getAttribute('max'))
    assert(Math.abs(positionMs - totalMs) <= 1)
    simulations.push({ setupId: reopened.setups[i].id, initial, final, positionMs, totalMs })
    await page.getByLabel('Hide Toolpath', { exact: true }).check()
    await view()
    await page.locator('.viewport-canvas').click({ button: 'right', position: { x: 60, y: 60 } })
    await page.getByRole('menuitem', { name: 'Top view', exact: true }).click()
    await page.waitForTimeout(700)
    await page.screenshot({ path: d.output(i ? 'simulation-end-jaw-2.png' : 'simulation-end.png') })
    await page.getByTestId('console-strip').click()
    writeFileSync(d.output(`jaw-${i + 1}-console.txt`), await page.getByTestId('console-timeline').innerText())
    await page.getByTestId('console-strip').click()
    await page.getByLabel('Hide Toolpath', { exact: true }).uncheck()
    await removal.uncheck()
    await page.getByTestId('mode-tab-toolpath').click()
  }
  await page.getByTestId('mode-tab-postprocess').click()
  await page.getByLabel('All operations', { exact: true }).check()
  await page.waitForTimeout(1200)
  const sheets = []
  const listener = download => sheets.push(download)
  page.on('download', listener)
  await page.getByTestId('post-download-setup-sheet').click()
  for (let n = 0; n < 120 && sheets.length < 2; n++) await page.waitForTimeout(500)
  page.off('download', listener)
  assert.equal(sheets.length, 2)
  for (const sheet of sheets) await sheet.saveAs(d.output(`soft-jaws.setup.${sheet.suggestedFilename().endsWith('.pdf') ? 'pdf' : 'txt'}`))
  const download = page.waitForEvent('download')
  await page.locator('.post-modal').getByRole('button', { name: /^Export / }).click()
  await (await download).saveAs(d.output('soft-jaws.nc'))
  assert.deepEqual(errors, [])
  writeFileSync(d.output('posts.json'), JSON.stringify(posts, null, 2))
  writeFileSync(d.output('readback.json'), JSON.stringify({ seed, savedStocks: saved.sceneStock.fixedStocks, reopenedStocks: reopened.sceneStock.fixedStocks, setups: reopened.setups, geometry: reopened.geometry.map(({ id, name, stockId, position, loops }) => ({ id, name, stockId, position, loops })), workholding: reopened.workholding, simulations, posts, errors }, null, 2))
  for (const file of ['soft-jaws.camproject', 'reopened.png', 'toolpaths.png', 'simulation-end.png', 'simulation-end-jaw-2.png', 'jaw-1.nc', 'jaw-2.nc', 'jaw-1.setup.pdf', 'jaw-1.setup.txt', 'jaw-2.setup.pdf', 'jaw-2.setup.txt', 'soft-jaws.nc', 'soft-jaws.setup.pdf', 'soft-jaws.setup.txt']) copyFileSync(path.resolve(out, file), path.resolve(part, file))
})
