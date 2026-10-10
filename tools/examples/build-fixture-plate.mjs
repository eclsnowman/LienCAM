// Original release example. Run after npm run build, from the repository root.
// All project construction, computation, saving and posting use production UI.
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, writeFileSync, statSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Shape, Path, ExtrudeGeometry, Mesh } from 'three'
import { STLExporter } from 'three/addons/exporters/STLExporter.js'
import { withExampleDriver } from './lib/drive.mjs'
import { captureProvenancedScreenshot, persistCaptureProvenance } from '../capture/lib/harness.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const PART = 'examples/01-fixture-plate'
const EVIDENCE = 'src/tests/evidence/WO-2515'
const HOLDING_NOTE = 'Apply masking tape to the spoilboard and the underside of the whole plate blank. Apply superglue between the taped faces, glue the blank down, and press one minute. Keep the plate and offcuts bonded through all operations; pry off with a putty knife after the program ends.'
export const grid = Array.from({ length: 12 }, (_, i) => [25 + (i % 4) * 25, 20 + Math.floor(i / 4) * 25])
export const pins = [[12, 45], [113, 45]]
// Eight beveled corners leave cutter-access relief, with no sharp internal slot.
const outline = [[5, 2], [120, 2], [123, 5], [123, 85], [120, 88], [5, 88], [2, 85], [2, 5]]

export function makeInputs() {
  mkdirSync(path.join(ROOT, PART), { recursive: true })
  const circles = [...grid, ...pins].map(([x, y], i) => `<circle id="${i < 12 ? `M6-${i + 1}` : `pin-${i - 11}`}" cx="${x}" cy="${y}" r="2.5"/>`).join('\n')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="125mm" height="90mm" viewBox="0 0 125 90"><g fill="none" stroke="black"><polygon id="plate" points="${outline.map(p => p.join(',')).join(' ')}"/>\n${circles}</g></svg>\n`
  writeFileSync(path.join(ROOT, PART, 'fixture-plate.svg'), svg)
  const shape = new Shape(outline.map(([x, y]) => ({ x: x - 62.5, y: 45 - y })))
  for (const [x, y] of [...grid, ...pins]) {
    const hole = new Path()
    hole.absarc(x - 62.5, 45 - y, 2.5, 0, 2 * Math.PI, false)
    shape.holes.push(hole)
  }
  const geometry = new ExtrudeGeometry(shape, { depth: 7.5, bevelEnabled: false, curveSegments: 32 })
  geometry.translate(0, 0, -8)
  const stl = new STLExporter().parse(new Mesh(geometry), { binary: true })
  writeFileSync(path.join(ROOT, PART, 'fixture-plate.stl'), Buffer.from(stl.buffer))
  geometry.dispose()
}

async function number(page, label, value, selector = '.op-field-row') {
  const row = page.locator(selector).filter({ has: page.locator(selector === '.mform-row' ? '.mform-label' : '.op-field-label', { hasText: new RegExp(`^${label.replace(/[()]/g, '\\$&')}$`) }) })
  const input = row.locator('input').first()
  await input.fill(String(value)); await input.press('Tab')
}
async function tab(page, name) { await page.locator('.op-modal-tab').filter({ hasText: new RegExp(`^${name}$`) }).click() }
async function bottom(page) { await page.getByRole('button', { name: /^Expand Bottom.*height$/i }).click() }
async function importGeometry(driver, file, expected) {
  await driver.step(`Import ${file}`, async page => {
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: 'Import geometry', exact: true }).click()
    await (await chooser).setFiles(path.join(ROOT, PART, file))
  }, state => state.project.geometry.length === expected)
  const stock = (await driver.readState()).project.sceneStock.fixedStocks[0]
  await driver.step(`Assign ${file} to fixed stock`, page => page.getByRole('button', { name: /^Stock 1 Pin this part/ }).click(),
    state => state.project.geometry.at(-1).stockId === stock.id)
  const geometry = (await driver.readState()).project.geometry.at(-1)
  await driver.page.locator('.tree-item-geo').filter({ has: driver.page.getByTestId(`rename-geo-btn-${geometry.id}`) }).getByTestId('tree-name-geometry').click()
  const position = driver.page.locator('[data-group="geo-position"]').locator('..')
  if (!await position.locator('.props-transform-cell').count()) await driver.page.getByTestId('props-group-geo-position').click()
  const targetZ = file.endsWith('.stl') ? -8 : -0.5
  await driver.step(`Place ${file} at Z ${targetZ}`, async page => {
    const input = position.locator('.props-transform-cell').filter({ hasText: /^Z$/ }).locator('input')
    await input.fill(String(targetZ)); await input.press('Enter')
  }, state => state.project.geometry.find(g => g.id === geometry.id).position.z === targetZ)
}
async function operation(driver, { type, title, tool, loops, configure }) {
  const page = driver.page
  const before = (await driver.readState()).project.setups[0].operations.length
  await page.getByRole('button', { name: 'Add operation', exact: true }).click()
  await page.locator('.op-type-card').filter({ hasText: new RegExp(`^${title}$`) }).click()
  await tab(page, 'Tool')
  await page.locator('.op-tool-row').filter({ hasText: tool }).click()
  await tab(page, 'Geometry')
  const state = await driver.readState()
  const svg = state.project.geometry.find(g => g.format === 'svg')
  await page.getByTestId('op-geometry-select').selectOption(svg.id)
  if (await page.getByTestId('op-loops-clear').isEnabled()) await page.getByTestId('op-loops-clear').click()
  for (const i of loops) await page.locator('.op-loop-check input[type=checkbox]').nth(i).check()
  if (configure) await configure(page)
  return driver.step(`Create ${title}`, p => p.getByTestId('op-create').click(),
    s => s.project.setups[0].operations.length === before + 1 && s.project.setups[0].operations.at(-1).type === type)
}
async function compute(driver, label) {
  const count = (await driver.readState()).project.setups[0].operations.length
  if (!await driver.page.getByRole('button', { name: 'Compute toolpath', exact: true }).count()) await driver.page.getByTestId('tree-name-setup').click()
  for (let i = 0; i < count; i++) {
    await driver.step(`${label}: compute operation ${i + 1}`, async page => {
      await page.getByRole('button', { name: 'Compute toolpath', exact: true }).nth(i).click()
      await page.waitForFunction(() => !document.querySelector('.tree-icon-btn-compute:disabled'), undefined, { timeout: 120_000 })
    },
      state => state.project.setups[0].operations[i].status === 'ready', { timeoutMs: 120_000 })
  }
}

export async function build({ captureOnly = false, walkthroughOnly = false } = {}) {
  // Retry walkthroughs without replacing a completed production build's steps,
  // posts, round-trip or stock readback with a shorter capture-only run.
  if (walkthroughOnly) return withExampleDriver({ outDir: `${EVIDENCE}/walkthroughs` }, async driver => {
    const file = path.join(ROOT, PART, 'fixture-plate.camproject')
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    await driver.page.setViewportSize({ width: 1920, height: 1080 })
    await driver.step('Open built project for walkthrough retry', async page => {
      const chooser = page.waitForEvent('filechooser')
      await page.getByRole('button', { name: 'Open project', exact: true }).click()
      await (await chooser).setFiles(file)
    }, s => s.project.id === saved.id && s.project.setups[0].operations.every(op => op.status === 'ready' && !op.reachShortfall), { timeoutMs: 120_000 })
    await driver.page.getByTestId('tree-name-setup').click()
    await walkthroughs(driver, saved)
  })
  // Keep the released application's pictures as the before evidence. Subsequent
  // runs replace only the after captures, never the comparison baseline.
  mkdirSync(path.join(ROOT, EVIDENCE), { recursive: true })
  for (const name of ['toolpaths.png', 'simulation-end.png']) {
    const before = path.join(ROOT, EVIDENCE, `before-${name}`)
    if (!existsSync(before)) copyFileSync(path.join(ROOT, PART, name), before)
  }
  if (!captureOnly) makeInputs()
  return withExampleDriver({ outDir: EVIDENCE }, async driver => {
    for (const name of captureOnly
      ? ['simulation-mid-cut.png', 'simulation-end.png', 'simulation.json', 'capture-manifest.json', 'app-console.json', 'console.json', 'page.txt']
      : ['model.png', 'toolpaths.png', 'simulation-mid-cut.png', 'simulation-end.png', 'ready.json', 'simulation.json', 'capture-manifest.json', 'app-console.json', 'console.json', 'page.txt']) driver.output(name)
    let page = driver.page
    await page.setViewportSize({ width: 1920, height: 1080 })
    const consoleLines = []
    const listen = p => {
      p.on('console', msg => consoleLines.push({ type: msg.type(), text: msg.text() }))
      p.on('pageerror', error => consoleLines.push({ type: 'pageerror', text: error.message }))
    }
    listen(page)
    let saved
    try {
      if (!captureOnly) {
      await driver.newProject()
      await driver.step('Name fixture plate project', async p => {
        await p.getByTestId('tree-name-project').dblclick()
        await p.getByTestId('tree-rename-input').fill('01 Fixture plate - M6 x 1')
        await p.getByTestId('tree-rename-input').press('Enter')
      }, s => s.project.name === '01 Fixture plate - M6 x 1')
      await driver.setStock({ width: 125, height: 90, depth: 8 })
      for (const [axis, value] of [['X', -62.5], ['Y', -45], ['Z', -8]]) {
        await driver.step(`Center stock position ${axis}`, async p => {
          const input = p.locator('.fixed-stock-node').last().locator('.stock-field-row').filter({ hasText: `Pos ${axis}` }).locator('input')
          await input.fill(String(value)); await input.press('Enter')
        }, s => s.project.sceneStock.fixedStocks[0].position[axis.toLowerCase()] === value)
      }
      await driver.importTools('examples/tools/starter-tools-metric.json')
      // M6 x 1 needs a 5 mm pilot. Customize a project copy, never the shared kit.
      await page.getByTestId('mode-tab-toollibrary').click()
      await page.locator('.tool-list-item').filter({ hasText: '3 mm drill' }).click()
      await page.locator('.tool-tab').filter({ hasText: /^General$/ }).click()
      await number(page, 'Name', '5 mm drill - M6 pilot', '.mform-row')
      await page.locator('.tool-tab').filter({ hasText: /^Cutter$/ }).click()
      await number(page, 'Diameter', 5, '.mform-row')
      await driver.step('Customize starter drill to 5 mm M6 pilot', p => p.getByRole('button', { name: 'Save Changes', exact: true }).click(),
        s => s.toolLibrary.some(t => t.type === 'drill' && t.diameter === 5 && t.name === '5 mm drill - M6 pilot'))
      // A single-point cutter needs neck reach, not longer cutting teeth. The
      // shared starter has no relieved shoulder and defaults to 6 mm stickout.
      await page.locator('.tool-list-item').filter({ hasText: '3 mm single-point thread mill' }).click()
      await page.locator('.tool-tab').filter({ hasText: /^General$/ }).click()
      await number(page, 'Name', '3 mm single-point thread mill - 8 mm neck', '.mform-row')
      await page.locator('.tool-tab').filter({ hasText: /^Cutter$/ }).click()
      await number(page, 'Neck diameter', 1.2, '.mform-row')
      await number(page, 'Shoulder length (from tip)', 8, '.mform-row')
      await number(page, 'Length below holder', 12, '.mform-row')
      await driver.step('Customize thread mill with 8 mm relieved neck and 12 mm stickout', p => p.getByRole('button', { name: 'Save Changes', exact: true }).click(),
        s => s.toolLibrary.some(t => t.type === 'thread_mill' && t.neckDiameter === 1.2 && t.shoulderLength === 8 && t.lengthBelowHolder === 12))
      await page.locator('.tool-modal .modal-close-btn').click()
      await importGeometry(driver, 'fixture-plate.svg', 1)
      await importGeometry(driver, 'fixture-plate.stl', 2)
      await page.keyboard.press('Escape')
      await page.keyboard.press('f')
      await page.screenshot({ path: driver.output('model.png') })
      await driver.addFacingOperation('6 mm flat end mill')
      await page.getByTestId('tree-name-setup').click()
      await driver.step('Record tape and glue holding method', p => p.getByTestId('setup-holding-method').selectOption('tape_glue'),
        s => s.project.setups[0].holdingMethod === 'tape_glue')
      await driver.step('Record tape and glue instructions', async p => {
        await p.getByTestId('setup-holding-note').fill(HOLDING_NOTE)
        await p.getByTestId('setup-holding-note').press('Tab')
      }, s => s.project.setups[0].notes === HOLDING_NOTE)
      await operation(driver, { type: 'drill', title: 'Drill', tool: '5 mm drill - M6 pilot', loops: Array.from({ length: 14 }, (_, i) => i + 1), configure: async p => {
        await tab(p, 'Heights'); await bottom(p)
        await p.getByTestId('drill-bore-height-mode').selectOption('explicit_depth')
        await number(p, 'Material Start (WCS)', -0.5)
        // WO-2514 adds the 118 deg drill point below the full-diameter bottom.
        await number(p, 'Target End (WCS)', -8)
        await number(p, 'Breakthrough past floor', 0.5)
      } })
      await operation(driver, { type: 'thread_mill', title: 'Thread Mill', tool: '3 mm single-point thread mill', loops: Array.from({ length: 12 }, (_, i) => i + 1), configure: async p => {
        await tab(p, 'Passes'); await number(p, 'Major diameter', 6); await number(p, 'Pitch', 1)
        await tab(p, 'Heights'); await bottom(p); await number(p, 'Thread depth', 7.5)
      } })
      // Complete the holes before freeing the outline. Tape and glue retain
      // both the plate and offcuts; the tool passes 0.2 mm into the spoilboard.
      await operation(driver, { type: 'contour_2d', title: '2D Contour', tool: '6 mm flat end mill', loops: [0], configure: async p => {
        await tab(p, 'Heights'); await bottom(p)
        await p.getByTestId('contour-height-mode').selectOption('explicit_depth')
        await number(p, 'Target End (WCS)', -8.2)
        await tab(p, 'Passes'); await number(p, 'Stepdown', 0.5)
      } })
      await operation(driver, { type: 'chamfer', title: '2D Chamfer', tool: '6 mm 90 deg chamfer mill', loops: Array.from({ length: 15 }, (_, i) => i), configure: async p => {
        await tab(p, 'Passes'); await number(p, 'Chamfer width', 0.3)
        await tab(p, 'Heights'); await bottom(p)
        await p.locator('select').filter({ has: p.locator('option[value="stock_top"]') }).last().selectOption('stock_top')
        await number(p, 'Z offset from plane', -0.5)
      } })
      await compute(driver, 'Build')
      await page.getByTestId('mode-tab-toolpath').click()
      await page.keyboard.press('f')
      await page.screenshot({ path: driver.output('toolpaths.png') })
      saved = await driver.saveAndReopen('fixture-plate.camproject')
      copyFileSync(path.join(ROOT, EVIDENCE, 'fixture-plate.camproject'), path.join(ROOT, PART, 'fixture-plate.camproject'))
      page = driver.page; listen(page)
      await page.setViewportSize({ width: 1920, height: 1080 })
      const reopened = (await driver.readState()).project
      assert.ok(reopened.setups[0].operations.every(op => op.status === 'ready'), 'Reopen must preserve current operations without recompute')
      assert.ok(reopened.setups[0].operations.every(op => !op.reachShortfall), 'No operation may skip unreachable moves')
      assert.equal(reopened.setups[0].holdingMethod, 'tape_glue')
      assert.equal(reopened.setups[0].notes, HOLDING_NOTE)
      await page.getByTestId('mode-tab-toolpath').click(); await page.keyboard.press('f')
      await page.screenshot({ path: driver.output('reopened.png') })
      copyFileSync(path.join(ROOT, EVIDENCE, 'reopened.png'), path.join(ROOT, PART, 'reopened.png'))
      const ready = await driver.readState()
      writeFileSync(driver.output('ready.json'), JSON.stringify(ready.project, null, 2))
      await page.getByTestId('mode-tab-postprocess').click()
      for (const dialect of ['linuxcnc', 'uccnc', 'grbl', 'grblhal', 'generic']) {
        await page.getByTestId('post-definition-select').click()
        await page.getByTestId(`post-definition-select-option-${dialect}`).click()
        const file = driver.output(dialect === 'linuxcnc' ? 'fixture-plate.nc' : `${dialect}.nc`)
        await driver.step(`Post ${dialect} through Export`, async p => {
          const download = p.waitForEvent('download', { timeout: 120_000 })
          await p.getByRole('button', { name: /^Export \./ }).click()
          await (await download).saveAs(file)
        }, state => state.project.id === saved.id && statSync(file).size > 0)
        // Check actual exported operation blocks, including canned and expanded drills.
        const code = readFileSync(file, 'utf8')
        const drillBlock = code.split(/(?:; |\(\s*)Drill 2\s*\)?/)[1]?.split(/(?:; |\(\s*)Thread Mill 3/)[0]
        const threadBlock = code.split(/(?:; |\(\s*)Thread Mill 3\s*\)?/)[1]?.split(/(?:; |\(\s*)Contour 4/)[0]
        assert.ok(drillBlock && /Z-10\.002(?:2)?(?:\s|$)/m.test(drillBlock), `${dialect}: drill tip must include point + 0.5 mm breakthrough`)
        assert.ok(threadBlock && /Z-8(?:\.0+)?(?:\s|$)/m.test(threadBlock), `${dialect}: thread must reach plate bottom`)
        copyFileSync(file, path.join(ROOT, PART, path.basename(file)))
        if (dialect === 'linuxcnc') {
          const downloads = []
          const capture = download => downloads.push(download)
          page.on('download', capture)
          try {
            await page.getByTestId('post-download-setup-sheet').click()
            const deadline = Date.now() + 120_000
            while (downloads.length < 2 && Date.now() < deadline) await page.waitForTimeout(100)
            assert.equal(downloads.length, 2, 'Setup Sheet must download text and PDF')
            for (const download of downloads) {
              const ext = path.extname(download.suggestedFilename())
              const target = driver.output(`fixture-plate.setup${ext}`)
              await download.saveAs(target)
              copyFileSync(target, path.join(ROOT, PART, path.basename(target)))
            }
            const sheet = readFileSync(path.join(ROOT, PART, 'fixture-plate.setup.txt'), 'utf8')
            assert.ok(sheet.includes('Method: Tape and glue') && sheet.includes(HOLDING_NOTE))
          } finally { page.off('download', capture) }
        }
      }
      await page.locator('.post-modal .modal-close-btn').click()
      } else {
        const file = path.join(ROOT, PART, 'fixture-plate.camproject')
        saved = JSON.parse(readFileSync(file, 'utf8'))
        await driver.step('Reopen built project for capture retry', async p => {
          const chooser = p.waitForEvent('filechooser')
          await p.getByRole('button', { name: 'Open project', exact: true }).click()
          await (await chooser).setFiles(file)
        }, s => s.project.id === saved.id && s.project.setups[0].operations.every(op => op.status === 'ready'), { timeoutMs: 120_000 })
        await page.getByTestId('mode-tab-toolpath').click(); await page.keyboard.press('f')
        await page.screenshot({ path: driver.output('reopened.png') })
      }
      await driver.step('Select entire setup for simulation', p => p.getByTestId('tree-name-setup').click(), s => s.project.activeOperationId === null)
      await page.getByTestId('console-strip').click()
      const appConsole = { text: await page.locator('.console-panel').innerText(), errors: await page.locator('.console-event.console-severity-error').allTextContents() }
      writeFileSync(driver.output('app-console.json'), JSON.stringify(appConsole, null, 2))
      assert.deepEqual(appConsole.errors, [])
      await page.getByTestId('console-strip').click()
      // Observe the real simulation's renderer-bound stock, without seeding or
      // computing another simulator. This also works when auto chooses voxels.
      await page.evaluate(() => {
        const vp = window.__cncViewport
        window.__exampleVolume = { removedVolumeMm3: 0 }
        const init = vp.initStockSim.bind(vp)
        let bounds
        vp.initStockSim = (...args) => (bounds = init(...args))
        const update = vp.updateStockSimHeights.bind(vp)
        vp.updateStockSimHeights = heights => {
          if (bounds) window.__exampleVolume = { engine: 'heightmap', removedVolumeMm3: Array.from(heights).reduce((v, z) => v + Math.max(0, bounds.stockTop - z), 0) * bounds.cellSize ** 2 }
          return update(heights)
        }
        const initVoxel = vp.initVoxelSim.bind(vp)
        const syncVoxel = vp.syncVoxelSim.bind(vp)
        let initial
        vp.initVoxelSim = field => { initial = field.data.slice(); window.__exampleField = field; return initVoxel(field) }
        vp.syncVoxelSim = field => {
          let removed = 0
          for (let i = 0; i < field.data.length; i++) if (initial[i] > 0 && field.data[i] <= 0) removed++
          window.__exampleVolume = { engine: 'voxel', removedVolumeMm3: removed * field.dims.voxelSize ** 3, voxelSize: field.dims.voxelSize }
          window.__exampleField = field
          return syncVoxel(field)
        }
      })
      await page.getByTestId('mode-tab-simulation').click()
      await page.getByLabel('Simulate Stock Removal').check()
      const scrub = page.locator('.sim-scrubber')
      await scrub.waitFor()
      await scrub.evaluate(input => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, String(Math.floor(Number(input.max) / 2))); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })) })
      await page.waitForFunction(() => document.querySelector('.sim-carve-progress')?.style.display === 'none', undefined, { timeout: 360_000 })
      await page.getByRole('button', { name: 'Play', exact: true }).click()
      await page.waitForFunction(() => {
        const role = document.querySelector('.sim-move-readout')?.textContent ?? ''
        const position = document.querySelector('.sim-position-readout')?.textContent ?? ''
        const z = Number(position.match(/Z (-?\d+(?:\.\d+)?)/)?.[1])
        return /^(CUT|HELIX|PLUNGE|FINISH)\b/.test(role) && z < -0.5
      }, undefined, { timeout: 60_000 })
      await page.getByRole('button', { name: 'Pause', exact: true }).click()
      await page.getByTestId('sim-display-stock').click()
      await page.getByTestId('sim-hide-toolpath').check()
      const midCut = { role: await page.locator('.sim-move-readout').innerText(), position: await page.getByTestId('sim-position-readout').innerText(), progress: await scrub.inputValue() }
      writeFileSync(driver.output('simulation-mid-cut.json'), JSON.stringify(midCut, null, 2))
      await page.screenshot({ path: driver.output('simulation-mid-cut.png') })
      await page.getByRole('button', { name: 'Skip to end', exact: true }).click()
      await page.waitForFunction(() => {
        const scrub = document.querySelector('.sim-scrubber')
        return scrub && Math.abs(Number(scrub.value) - Number(scrub.max)) <= 1 && document.querySelector('.sim-carve-progress')?.style.display === 'none'
      }, undefined, { timeout: 360_000 })
      await page.waitForTimeout(1500)
      const simulation = await page.evaluate(centers => {
        const field = window.__exampleField
        let bottomExteriorSamples = 0, bottomExteriorSolid = 0
        const bottomHoles = centers.map(center => ({ center, samples: 0, solid: 0, sampledRadiusMm: 0 }))
        if (field) {
          const { nx, ny, nz, voxelSize, x0, y0, z0 } = field.dims
          // The octagon is centered at the origin, like the imported SVG.
          // Exclude one voxel at its boundary to avoid classifying the SDF's
          // interpolated surface as a lip. Read the application's live field.
          for (let iz = 0; iz < nz; iz++) {
            const z = z0 + (iz + 0.5) * voxelSize
            if (z < -8 || z >= -7.5) continue
            for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) {
              const px = x0 + (ix + 0.5) * voxelSize, py = y0 + (iy + 0.5) * voxelSize
              for (const hole of bottomHoles) {
                const radius = Math.hypot(px - hole.center[0], py - hole.center[1])
                // Exclude one surface voxel, but sample near the 5 mm bore wall.
                if (radius <= 2.5 - voxelSize) {
                  hole.samples++
                  hole.sampledRadiusMm = Math.max(hole.sampledRadiusMm, radius)
                  if (field.data[iz * nx * ny + iy * nx + ix] > 0) hole.solid++
                }
              }
              const x = Math.abs(px)
              const y = Math.abs(y0 + (iy + 0.5) * voxelSize)
              const outside = Math.max(x - 60.5, y - 43, (x + y - 100.5) / Math.SQRT2)
              if (x >= 62.5 || y >= 45 || outside <= voxelSize) continue
              bottomExteriorSamples++
              if (field.data[iz * nx * ny + iy * nx + ix] > 0) bottomExteriorSolid++
            }
          }
        }
        return { ...window.__exampleVolume, bottomExteriorSamples, bottomExteriorSolid, bottomHoles,
          progress: document.querySelector('.sim-scrubber').value, end: document.querySelector('.sim-scrubber').max }
      }, [...grid, ...pins].map(([x, y]) => [x - 62.5, 45 - y]))
      assert.ok(Math.abs(Number(simulation.progress) - Number(simulation.end)) <= 1)
      assert.ok(simulation.removedVolumeMm3 > 0)
      assert.ok(simulation.bottomExteriorSamples > 0, 'Read the bottom exterior from Cut Stock')
      assert.equal(simulation.bottomExteriorSolid, 0, 'No lip may remain in the bottom 0.5 mm outside the outline')
      assert.equal(simulation.bottomHoles.length, 14)
      for (const hole of simulation.bottomHoles) {
        assert.ok(hole.samples > 0 && hole.sampledRadiusMm > 2, 'Sample full bore near its wall, not just the point')
        assert.equal(hole.solid, 0, `Hole ${hole.center} must be open at the underside`)
      }
      writeFileSync(driver.output('simulation.json'), JSON.stringify(simulation, null, 2))
      await page.screenshot({ path: driver.output('simulation-end.png') })
      await page.getByTestId('sim-hide-toolpath').check()
      await page.getByTestId('sim-display-stock').click()
      const canvas = page.locator('canvas:visible').first()
      await canvas.click({ button: 'right', position: { x: 30, y: 120 } })
      await page.locator('[role="menuitem"][data-action="fit-all"]').click()
      // Bottom is a production camera preset, absent from the small context menu.
      await page.evaluate(() => window.__cncViewport.setCameraView('bottom'))
      await page.waitForTimeout(1500)
      await page.screenshot({ path: driver.output('simulation-bottom.png') })
      for (const name of ['toolpaths.png', 'simulation-end.png', 'simulation-bottom.png']) copyFileSync(path.join(ROOT, EVIDENCE, name), path.join(ROOT, PART, name))
      writeFileSync(driver.output('capture-manifest.json'), JSON.stringify(['model.png', 'toolpaths.png', 'simulation-mid-cut.png', 'simulation-end.png', 'simulation-bottom.png', 'reopened.png'].map(name => ({ name, bytes: statSync(path.join(ROOT, EVIDENCE, name)).size, modifiedAt: statSync(path.join(ROOT, EVIDENCE, name)).mtime.toISOString(), viewport: [1920, 1080] })), null, 2))
      await walkthroughs(driver, saved)
      return saved
    } finally {
      writeFileSync(driver.output('console.json'), JSON.stringify(consoleLines, null, 2))
      writeFileSync(driver.output('page.txt'), await driver.page.locator('body').innerText())
    }
  })
}

// Keep W2 captures tied to this production-built project, inside this order's paths.
async function walkthroughs(driver, saved) {
  const page = driver.page
  const shot = async (id, predicate) => {
    await page.waitForTimeout(1500)
    const outputPath = path.join(ROOT, 'docs/media/walkthroughs', `${id}.png`)
    const result = await captureProvenancedScreenshot({ page, outputPath,
      sourcePaths: ['src', 'tools/examples/build-fixture-plate.mjs', `${PART}/fixture-plate.camproject`],
      sourceExcludePaths: ['src/tests/evidence'],
      provenance: async () => (await driver.readState()).project.id === saved.id && await predicate(),
    })
    persistCaptureProvenance({ provenancePath: outputPath.replace('.png', '.json'), shots: { [`${id}.png`]: result } })
  }
  await page.getByTestId('mode-tab-toollibrary').click()
  await shot('W2-1', () => page.locator('.tool-modal').isVisible())
  await page.locator('.tool-modal .modal-close-btn').click()
  await page.getByTestId('mode-tab-toolpath').click()
  if (!await page.getByRole('button', { name: 'Compute toolpath', exact: true }).count()) await page.getByTestId('tree-name-setup').click()
  await page.keyboard.press('f')
  await shot('W2-2', async () => (await driver.readState()).project.setups[0].operations.every(op => op.status === 'ready') &&
    await page.getByRole('button', { name: 'Compute toolpath', exact: true }).count() === 5)
  await page.getByTestId('mode-tab-simulation').click()
  // B9 rebuilds playback at time zero when Simulate is re-entered. Seek the
  // real simulation again; an exact baseline is not the finished cut.
  await page.getByLabel('Simulate Stock Removal').check()
  await page.waitForFunction(() => Number(document.querySelector('.sim-scrubber')?.max) > 0 &&
    document.querySelector('.sim-panel')?.getAttribute('data-stock-sync') === 'exact', undefined, { timeout: 360_000 })
  await page.getByRole('button', { name: 'Skip to end', exact: true }).click()
  await page.waitForFunction(() => {
    const scrub = document.querySelector('.sim-scrubber')
    return scrub && Number(scrub.max) > 0 && Math.abs(Number(scrub.value) - Number(scrub.max)) <= 1 &&
      document.querySelector('.sim-panel')?.getAttribute('data-stock-sync') === 'exact'
  }, undefined, { timeout: 360_000 })
  await page.getByTestId('sim-display-compare').click()
  await page.getByTestId('sim-hide-toolpath').check()
  await page.getByTestId('sim-stock-opacity').fill('0.5')
  const canvas = page.locator('canvas:visible').first()
  await canvas.click({ button: 'right', position: { x: 30, y: 120 } })
  await page.locator('[role="menuitem"][data-action="view-top"]').click()
  await shot('W2-3', async () => await page.locator('.sim-panel').getAttribute('data-stock-sync') === 'exact' &&
    Math.abs(Number(await page.locator('.sim-scrubber').inputValue()) - Number(await page.locator('.sim-scrubber').getAttribute('max'))) <= 1)
  await page.getByTestId('mode-tab-postprocess').click()
  await page.getByTestId('post-definition-select').click()
  await page.getByTestId('post-definition-select-option-uccnc').click()
  // Show the changed drill depth in the real preview, rather than the face's
  // unchanged prefix. Scrolling changes only the view, never the posted text.
  await page.getByTestId('post-gcode-preview').evaluate(pre => {
    const index = pre.textContent.split('\n').findIndex(line => /\(\s*Drill 2\s*\)/.test(line))
    if (index < 0) throw new Error('Drill operation missing from UCCNC preview')
    pre.scrollTop = index * parseFloat(getComputedStyle(pre).lineHeight)
  })
  await shot('W2-4', async () => /Z-10\.002/.test(await page.getByTestId('post-gcode-preview').innerText()))
  await page.locator('.post-modal .modal-close-btn').click()
  // Offline Control preview only: never connect, send, or execute machine motion.
  await page.getByTestId('mode-tab-control').click()
  await page.getByTestId('control-load-menu').click()
  await page.locator('[data-testid^="control-load-setup-item-"]').first().click()
  await shot('W2-5', () => page.getByTestId('control-gcode-list').isVisible())
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await build({ captureOnly: process.argv.includes('--capture-only'), walkthroughOnly: process.argv.includes('--walkthrough-only') })
