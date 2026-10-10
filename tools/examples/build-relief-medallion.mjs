// WO-2379, rebuilt by WO-2446: project-made inputs, then production UI only. No store mutations.
// Held the way the operator holds a tabbed part: two clamps start the job, operation 1 drills four
// screw holes in the frame corners, an operator stop parks the machine while the screws go
// in and the clamps come off, then the relief and the tabbed outline are cut.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { OcctKernel } from 'occt-wasm'
import { ExtrudeGeometry, Group, Mesh, MeshBasicMaterial, Path, Shape } from 'three'
import { STLExporter } from 'three/addons/exporters/STLExporter.js'
import { withExampleDriver } from './lib/drive.mjs'
import { scanDirectory } from '../release/scan.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const folder = path.join(root, 'examples/07-relief-medallion')
const evidence = 'src/tests/evidence/WO-2446'
export const CENTRE = { x: 35, y: 35 }
export const DISC_RADIUS = 30
export const RELIEF_DEPTH = 2
/** The 90 x 90 x 8 mm blank: 15 mm of frame past the 60 mm disc on every side. */
export const STOCK_OFFSET_XY = 15
export const STOCK_HALF = DISC_RADIUS + STOCK_OFFSET_XY
/** Screw holes: 4 mm through, 8 mm in from each frame edge (see the WO-2446 result for why not 10). */
export const SCREW_HOLE_DIAMETER = 4
export const SCREW_HOLE_INSET = 8
export const SCREW_HOLES = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => ({
  x: CENTRE.x + sx * (STOCK_HALF - SCREW_HOLE_INSET), y: CENTRE.y + sy * (STOCK_HALF - SCREW_HOLE_INSET),
}))
export const DRILL_END_WCS = -9.5
/** 4 triangular bridges about 5 mm wide and 1.5 mm high for hardwood. The contour's tab width is the
 *  span the cutter centre lifts over, so the 6 mm outline cutter needs 5 + 6 = 11 mm to leave a 5 mm
 *  bridge (a 5 mm setting leaves nothing; see the WO-2446 result). */
export const OUTLINE_CUTTER = 6
export const TABS = { count: 4, bridge: 5, width: 5 + OUTLINE_CUTTER, height: 1.5, shape: 'triangular' }
/** The clamp reaches this far onto the blank; the outline passes 9 mm from the side midpoints. */
export const CLAMP_REACH = 5
export const STOP_MESSAGE = 'Drive 4 screws, remove the 2 clamps, then press Cycle Start'
export const HOLDING_NOTE = [
  'Start: hold the 90 x 90 x 8 mm hardwood blank with the two example 02 toe clamps on the left and right side midpoints, toes 5 mm onto the blank, 8 mm packing under their outer ends.',
  'Operation 1 drills 4 screw holes, 4 mm through, one in each corner of the frame, 8 mm in from both edges.',
  `Then the program retracts and stops at the operator stop (and parks there when the machine has an Operator stop park): ${STOP_MESSAGE}. Use 4 mm wood screws (head 8 mm or less) into the spoilboard.`,
  'The relief is cut next, and the outline last with 4 triangular tabs that leave bridges about 5 mm wide and 1.5 mm high, so the disc stays joined to the screwed-down frame.',
  'After the program: cut the 4 tabs, sand the stubs, then unscrew the frame.',
].join('\n')

// Example 02's finished toe clamp: profile, 3 mm screw hole and 2 mm blind toe recess
// (the same body example 04 holds its bar with).
function toeClampModel() {
  const group = new Group()
  const material = new MeshBasicMaterial()
  for (const [z, depth, recess] of [[0, 6, false], [6, 2, true]]) {
    const shape = new Shape()
    for (const [i, [x, y]] of [[-30, -11], [26, -11], [30, -7], [30, 7], [26, 11], [-30, 11]].entries()) {
      if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y)
    }
    shape.closePath()
    const screw = new Path()
    screw.absarc(-6, 0, 1.5, 0, Math.PI * 2, true)
    shape.holes.push(screw)
    if (recess) {
      const pocket = new Path()
      pocket.moveTo(14, -6); pocket.lineTo(14, 6); pocket.lineTo(24, 6); pocket.lineTo(24, -6); pocket.closePath()
      shape.holes.push(pocket)
    }
    const geometry = new ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 32 })
    geometry.translate(0, 0, z)
    group.add(new Mesh(geometry, material))
  }
  const text = new STLExporter().parse(group)
  group.children.forEach(mesh => mesh.geometry.dispose()); material.dispose()
  return text.replace('solid exported', 'solid example_02_toe_clamp_Apache-2.0_made_for_release')
}

/** The outline circle and the four screw holes, in one drawing laid out on the 90 mm blank. */
function outlineSvg() {
  const at = p => ({ x: p.x - CENTRE.x + STOCK_HALF, y: p.y - CENTRE.y + STOCK_HALF })
  const holes = SCREW_HOLES.map(at).map(h => `<circle cx="${h.x}" cy="${h.y}" r="${SCREW_HOLE_DIAMETER / 2}" fill="none" stroke="black" stroke-width="0.1"/>`)
  const size = 2 * STOCK_HALF
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}mm" height="${size}mm" viewBox="0 0 ${size} ${size}"><title>Relief medallion outline and frame screw holes</title><desc>Apache-2.0. Made for the release. All dimensions in mm.</desc><circle cx="${STOCK_HALF}" cy="${STOCK_HALF}" r="${DISC_RADIUS}" fill="none" stroke="black" stroke-width="0.1"/>${holes.join('')}</svg>\n`
}

async function view(page, name) {
  await page.locator('.viewport-canvas canvas').first().click({ button: 'right', position: { x: 400, y: 250 } })
  await page.getByRole('menuitem', { name, exact: true }).click()
}

// 'default' keeps the camera the app frames the job with (the WO-2379 pictures); 'Top view' shows the
// holes and tabs square on. Never shoot while the status bar still says it is computing.
async function capture(driver, name, camera = 'default') {
  await driver.page.waitForFunction(() => !document.body.innerText.includes('Computing toolpaths'), null, { timeout: 300000 })
  if (camera !== 'default') await view(driver.page, camera)
  await driver.page.waitForTimeout(800)
  await driver.page.screenshot({ path: driver.output(name), timeout: 180000 })
}

async function opField(page, label, value) {
  const row = page.locator('.op-field-row').filter({ has: page.locator('.op-field-label').filter({ hasText: new RegExp(`^${label.replace(/[()]/g, '\\$&')}$`) }) })
  const input = row.locator('input').first()
  await input.fill(String(value)); await input.press('Tab')
}

async function tab(page, name) { await page.locator('.op-modal-tab').filter({ hasText: new RegExp(`^${name}$`) }).click() }

async function expandBottom(page) {
  const expand = page.getByRole('button', { name: /^Expand Bottom.*height$/i })
  if (await expand.count()) await expand.click()
}

async function pickLoops(page, indexes) {
  if (await page.getByTestId('op-loops-clear').isEnabled()) await page.getByTestId('op-loops-clear').click()
  for (const i of indexes) await page.locator('.op-loop-check input[type=checkbox]').nth(i).check()
}

async function consoleReadback(driver, name) {
  // The Part workbench keeps its own console strip mounted after a relief; read the CAM workspace's.
  const page = driver.page.getByTestId('cam-workspace-host')
  if (await page.getByTestId('console-strip').getAttribute('aria-expanded') !== 'true') await page.getByTestId('console-strip').click()
  await page.getByTestId('console-filter-all').click()
  const events = await page.locator('.console-event').evaluateAll(nodes => nodes.map(n => ({ text: n.textContent, error: n.classList.contains('console-severity-error') })))
  writeFileSync(driver.output(name), `${JSON.stringify(events, null, 2)}\n`)
  assert.equal(events.filter(e => e.error).length, 0, `Application console must contain no error events (${name})`)
  await page.getByTestId('console-strip').click()
  return events
}

// Sample the application's own Cut Stock texture (never a second simulation):
// the outline's cutter path at the bottom (solid only at the tabs) and above the
// tab tops (cut through), a square inside the frame (whole), the screw holes
// (drilled through) and the disc centre (kept).
async function stockReadback(driver, project) {
  const setup = project.setups[0]
  const contour = setup.operations.find(o => o.type === 'contour_2d')
  const tool = project.toolLibrary.find(t => t.id === contour.toolId)
  const model = project.geometry.find(g => g.format === 'model').boundingBox
  return driver.page.evaluate(({ centre, pathRadius, radius, tabHeight, holes, frame, top }) => {
    const vp = window.__cncViewport, image = vp.voxelSimTexture.texture.image
    const uniforms = vp.voxelSimMaterial.uniforms, min = uniforms.uFieldMin.value, cell = uniforms.uVoxelSize.value
    const solid = (x, y, z) => {
      const ix = Math.floor((x - min.x) / cell), iy = Math.floor((y - min.y) / cell), iz = Math.floor((z - min.z) / cell)
      if (ix < 0 || iy < 0 || iz < 0 || ix >= image.width || iy >= image.height || iz >= image.depth) throw new Error('Probe outside live field')
      return image.data[iz * image.width * image.height + iy * image.width + ix] >= 0
    }
    const bottomZ = min.z + cell / 2
    const bottom = [], above = [], bridges = []
    const samples = Math.ceil(2 * Math.PI * pathRadius / (cell / 2))
    for (let j = 0; j < samples; j++) {
      const a = 2 * Math.PI * j / samples, c = Math.cos(a), s = Math.sin(a)
      const x = centre.x + pathRadius * c, y = centre.y + pathRadius * s
      bottom.push(solid(x, y, bottomZ))
      above.push(solid(x, y, min.z + tabHeight + cell / 2))
      bridges.push([-radius, 0, radius].every(d => solid(x + c * d, y + s * d, bottomZ)))
    }
    const runs = values => values.reduce((count, v, i) => count + (v && !values[(i + values.length - 1) % values.length] ? 1 : 0), 0)
    // Each solid run's length along the cutter path at the bottom: the bridge width left in the wood.
    const runLengths = values => {
      const start = values.findIndex((v, i) => v && !values[(i + values.length - 1) % values.length])
      if (start < 0) return []
      const lengths = []
      for (let k = 0, n = 0; k < values.length; k++) {
        const v = values[(start + k) % values.length]
        if (v) n++
        if ((!v || k === values.length - 1) && n > 0) { lengths.push(n * 2 * Math.PI * pathRadius / values.length); n = 0 }
      }
      return lengths
    }
    const frameSamples = []
    for (const z of [bottomZ, (min.z + top) / 2, top - cell / 2]) {
      const n = Math.ceil(2 * frame.half / (cell / 2))
      for (let j = 0; j < n; j++) {
        const t = -frame.half + 2 * frame.half * j / n
        for (const [x, y] of [[t, -frame.half], [frame.half, t], [-t, frame.half], [-frame.half, -t]]) frameSamples.push(solid(centre.x + x, centre.y + y, z))
      }
    }
    const holeSamples = holes.map(h => [bottomZ, (min.z + top) / 2, top - cell / 2].map(z => solid(h.x, h.y, z)))
    return { source: 'Live app Cut Stock voxel texture', cellMm: cell, fieldMinZ: min.z,
      outline: { pathRadius, samples: bottom.length, bottomSolidRuns: runs(bottom), bottomBridgeRuns: runs(bridges),
        aboveTabSolidSamples: above.filter(Boolean).length, bottomSolidSamples: bottom.filter(Boolean).length,
        bottomBridgeWidthsMm: runLengths(bottom).map(w => Number(w.toFixed(2))) },
      frame: { insetMm: frame.inset, samples: frameSamples.length, solidSamples: frameSamples.filter(Boolean).length },
      screwHoles: { solidSamples: holeSamples.flat().filter(Boolean).length, samples: holeSamples.flat().length },
      discCentreSolid: [bottomZ, top - 2.5].every(z => solid(centre.x, centre.y, z)),
      display: document.querySelector('[data-testid="sim-display-stock"]')?.getAttribute('aria-pressed') }
  }, {
    centre: { x: (model.min.x + model.max.x) / 2, y: (model.min.y + model.max.y) / 2 },
    pathRadius: DISC_RADIUS + tool.diameter / 2, radius: tool.diameter / 2, tabHeight: contour.params.tabHeight,
    holes: SCREW_HOLES, frame: { half: STOCK_HALF - 4, inset: 4 }, top: model.max.z,
  })
}

/** How far each cutting move of every other operation passes from each screw hole edge (mm, cutter edge). */
export function screwHoleClearance(project) {
  const setup = project.setups[0]
  const out = {}
  for (const op of setup.operations) {
    if (op.type === 'drill') continue
    const tool = project.toolLibrary.find(t => t.id === op.toolId)
    let nearest = Infinity
    for (const m of op.toolpathMoves) {
      if (m.type === 'rapid') continue
      for (const h of SCREW_HOLES) nearest = Math.min(nearest, Math.hypot(m.x - h.x, m.y - h.y) - tool.diameter / 2 - SCREW_HOLE_DIAMETER / 2)
    }
    out[op.name] = Number(nearest.toFixed(3))
  }
  return out
}

mkdirSync(folder, { recursive: true })
for (const name of ['relief-medallion.camproject', 'reopened.png', 'toolpaths.png', 'simulation-end.png', 'outline.svg',
  'relief-medallion.setup.txt', 'relief-medallion.setup.pdf']) rmSync(path.join(folder, name), { force: true })
const kernel = await OcctKernel.init()
const disk = kernel.makeCylinder(DISC_RADIUS, 8)
const positioned = kernel.translate(disk, CENTRE.x, CENTRE.y, 0)
writeFileSync(path.join(folder, 'blank.step'), kernel.exportStep(positioned))
kernel.release(positioned); kernel.release(disk)
writeFileSync(path.join(folder, 'outline-and-screw-holes.svg'), outlineSvg())
writeFileSync(path.join(folder, 'example-02-toe-clamp.stl'), toeClampModel())

await withExampleDriver({ outDir: evidence }, async driver => {
  for (const name of ['model.png', 'height-map.png', 'toolpaths.png', 'toolpaths-top.png', 'simulation-mid-cut.png', 'simulation-end.png',
    'built-state.json', 'verification.json', 'console.json', 'built-console.json', 'reopened-console.json', 'posted-console.json',
    'simulation-console.json', 'simulation-end-top.png', 'simulation.json', 'relief-medallion.camproject', 'relief-medallion.nc', 'relief-medallion.setup.txt',
    'relief-medallion.setup.pdf', 'scan.json']) driver.output(name)
  // Keep the shared driver intact; all pages, including the fresh reopen, use
  // the work order's capture size.
  const open = driver.open.bind(driver)
  driver.open = async () => { const page = await open(); page.setDefaultTimeout(180000); await page.setViewportSize({ width: 1920, height: 1080 }); return page }
  driver.page.setDefaultTimeout(180000)
  await driver.page.setViewportSize({ width: 1920, height: 1080 })
  const consoleLog = []
  const observe = page => {
    page.on('console', message => consoleLog.push({ type: message.type(), text: message.text() }))
    page.on('pageerror', error => consoleLog.push({ type: 'pageerror', text: error.message }))
  }
  observe(driver.page)
  const page = () => driver.page
  // The autosave snapshot is briefly unreadable while it is being rewritten; read again.
  const read = async () => {
    for (let i = 0; i < 100; i++) { const state = await driver.readState(); if (state) return state; await driver.page.waitForTimeout(100) }
    throw new Error('App state unreadable')
  }
  try {
    const input = process.argv.slice(2).find(argument => !argument.startsWith('--'))
    const resumeArg = process.argv.find(argument => argument === '--resume' || argument.startsWith('--resume='))
    const resume = resumeArg !== undefined
    if (input) copyFileSync(path.resolve(input), path.join(folder, 'medallion.png'))
    else if (!resume) {
      const png = await driver.page.evaluate(() => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256
        const context = canvas.getContext('2d'), pixels = context.createImageData(256, 256)
        for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
          const dx = (x - 127.5) / 127.5, dy = (y - 127.5) / 127.5
          const r = Math.hypot(dx, dy), angle = Math.atan2(dy, dx)
          const dome = Math.max(0, 1 - r * r)
          const petals = Math.pow(Math.max(0, Math.cos(6 * angle)), 2) * Math.exp(-Math.pow((r - 0.47) / 0.22, 2))
          const ring = Math.exp(-Math.pow((r - 0.83) / 0.035, 2))
          const grey = Math.round(255 * Math.min(1, 0.35 * dome + 0.6 * petals + 0.5 * ring))
          const i = (y * 256 + x) * 4
          pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = grey; pixels.data[i + 3] = 255
        }
        context.putImageData(pixels, 0, 0); return canvas.toDataURL('image/png').split(',')[1]
      })
      writeFileSync(path.join(folder, 'medallion.png'), Buffer.from(png, 'base64'))
    }
    if (resume) {
      // --resume[=checkpoint]: reopen a saved relief-only project through Open instead of re-running the relief.
      const checkpoint = path.resolve(resumeArg.includes('=') ? resumeArg.slice('--resume='.length) : path.join(root, evidence, 'relief-only.camproject'))
      const saved = JSON.parse(readFileSync(checkpoint, 'utf8'))
      await driver.step('Resume project-made relief checkpoint through Open', async p => {
        const chooser = p.waitForEvent('filechooser')
        await p.getByRole('button', { name: 'Open project', exact: true }).click()
        await (await chooser).setFiles(checkpoint)
      }, state => state.project.id === saved.id, { timeoutMs: 180000 })
    } else {
      await driver.newProject()
      await driver.page.getByTestId('mode-tab-part').click()
      await driver.page.getByTestId('solids-workbench-status').filter({ hasText: /ready/i }).waitFor({ timeout: 120000 })
      await driver.step('Import project-made round blank', p => p.getByTestId('workbench-import-step-input').setInputFiles(path.join(folder, 'blank.step')),
        state => state.project.geometry.some(g => g.format === 'model'), { timeoutMs: 120000 })
      await driver.page.waitForTimeout(1500)
      // The view cube is a production camera control. Its TOP label lies on the
      // top face, and the framed disk is centered in the canvas.
      await driver.page.locator('.view-cube-label').filter({ hasText: /^TOP$/i }).click({ force: true })
      await driver.page.getByTestId('workbench-relief').click()
      const canvas = await driver.page.getByTestId('solids-workbench-canvas').boundingBox()
      await driver.page.mouse.click(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2)
      await driver.page.getByTestId('relief-file-input').setInputFiles(path.join(folder, 'medallion.png'))
      await driver.page.getByTestId('relief-apply').waitFor()
      await driver.page.getByTestId('relief-auto-toggle').locator('input').uncheck()
      await driver.page.getByTestId('relief-dir-emboss').click()
      // 24 mm stays on the exact-face route (241 samples per side). The 42 mm
      // mesh-relief route currently leaves open seams on this cylindrical blank,
      // which the production roughing preflight correctly refuses.
      for (const [label, value] of [['Relief depth', RELIEF_DEPTH], ['Relief width', 24]]) {
        await driver.page.getByRole('textbox', { name: label, exact: true }).fill(String(value))
        await driver.page.getByRole('textbox', { name: label, exact: true }).press('Tab')
      }
      await driver.page.getByTestId('relief-invert').locator('input').uncheck()
      await driver.page.waitForTimeout(1000)
      await driver.page.screenshot({ path: driver.output('height-map.png'), timeout: 180000 })
      const beforeRelief = JSON.stringify((await read()).project.geometry.find(g => g.format === 'model').modelBody.ref)
      await driver.step('Apply embossed picture to the round blank', p => p.getByTestId('relief-apply').click(),
        state => state.project.geometry.some(g => g.format === 'model' && JSON.stringify(g.modelBody.ref) !== beforeRelief), { timeoutMs: 600000 })
      await driver.step('Save relief checkpoint through Save', async p => {
        const download = p.waitForEvent('download', { timeout: 180000 })
        await p.getByRole('button', { name: 'Save project', exact: true }).click()
        await (await download).saveAs(driver.output('relief-only.camproject'))
      }, state => state.project.geometry.some(g => g.format === 'model'))
      await driver.page.screenshot({ path: driver.output('model.png'), timeout: 180000 })
      await driver.page.locator('[data-testid^="body-show-in-cam-"]').last().click()
    }
    await driver.step('Name the project', async p => {
      await p.getByTestId('tree-name-project').dblclick()
      await p.getByTestId('tree-rename-input').fill('07 Relief medallion')
      await p.getByTestId('tree-rename-input').press('Enter')
    }, state => state.project.name === '07 Relief medallion')
    await driver.importTools('examples/tools/starter-tools-metric.json')
    // 4 mm screws need a 4 mm clearance hole. Customize the project's copy, never the shared kit.
    await page().getByTestId('mode-tab-toollibrary').click()
    await page().locator('.tool-list-item').filter({ hasText: '3 mm drill' }).click()
    await page().locator('.tool-tab').filter({ hasText: /^General$/ }).click()
    {
      const row = label => page().locator('.mform-row').filter({ has: page().locator('.mform-label', { hasText: new RegExp(`^${label}$`) }) }).locator('input').first()
      await row('Name').fill('4 mm drill - screw clearance'); await row('Name').press('Tab')
      await page().locator('.tool-tab').filter({ hasText: /^Cutter$/ }).click()
      await row('Diameter').fill('4'); await row('Diameter').press('Tab')
    }
    await driver.step('Customize starter drill to a 4 mm screw clearance drill', p => p.getByRole('button', { name: 'Save Changes', exact: true }).click(),
      s => s.toolLibrary.some(t => t.type === 'drill' && t.diameter === SCREW_HOLE_DIAMETER && t.name === '4 mm drill - screw clearance'))
    await page().locator('.tool-modal .modal-close-btn').click()

    // The real blank is 90 x 90 x 8 mm: a fixed stock 15 mm past the disc on every side, its top on the
    // disc top. The disc is bound to it, so the frame around the disc is real stock and stays one piece.
    const model0 = (await read()).project.geometry.find(g => g.format === 'model')
    const fixed = await driver.setStock({ width: 2 * STOCK_HALF, height: 2 * STOCK_HALF, depth: model0.boundingBox.max.z - model0.boundingBox.min.z })
    for (const [axis, value] of [['x', CENTRE.x - STOCK_HALF], ['y', CENTRE.y - STOCK_HALF], ['z', model0.boundingBox.min.z]]) {
      await driver.step(`Place the blank stock: Pos ${axis.toUpperCase()} ${value}`, async p => {
        const box = p.locator('.fixed-stock-node').last().locator('.stock-field-row').filter({ hasText: `Pos ${axis.toUpperCase()}` }).locator('input')
        await box.fill(String(value)); await box.press('Enter')
      }, state => state.project.sceneStock.fixedStocks.find(s => s.id === fixed.id).position[axis] === value)
    }
    await driver.step('Bind the disc to the blank stock', p => p.locator('.tree-item-geo').filter({ hasText: model0.name }).first().locator('.tree-geo-stock-select').selectOption(fixed.id),
      state => state.project.geometry.find(g => g.id === model0.id).stockId === fixed.id)

    await driver.step('Import project-made outline and screw holes', async p => {
      await p.getByTestId('geo-file-input').setInputFiles(path.join(folder, 'outline-and-screw-holes.svg'))
      await p.getByTestId(`import-stock-choice-stock-${fixed.id}`).click()
    }, state => state.project.geometry.some(g => g.format === 'svg' && g.stockId === fixed.id))
    const outline = (await read()).project.geometry.find(g => g.format === 'svg')
    // The importer centres the SVG on the origin; the blank sits at its own centre. Move the drawing
    // through the Properties position fields so the outline circle and the disc coincide.
    {
      const geos = (await read()).project.geometry
      const centre = box => ({ x: (box.min.x + box.max.x) / 2, y: (box.min.y + box.max.y) / 2 })
      const model = centre(geos.find(g => g.format === 'model').boundingBox)
      const drawing = centre(outline.boundingBox)
      await page().getByText(outline.name, { exact: true }).first().click()
      const row = page().locator('.props-transform-row').first()
      for (const [index, value] of [[0, model.x - drawing.x], [1, model.y - drawing.y]]) {
        const box = row.locator('input').nth(index)
        await box.fill(String(Math.round(value * 100) / 100)); await box.press('Tab')
      }
      // Moving a part can re-home it to another stock; give it back to the stock the setup is bound to.
      await page().getByTestId('geo-stock-select').selectOption(fixed.id)
      await driver.step('Centre the outline on the blank', async () => {},
        state => { const g = state.project.geometry.find(item => item.id === outline.id); return Math.abs(g.position.x - Math.round((model.x - drawing.x) * 100) / 100) < 0.01 && g.stockId === fixed.id })
    }

    // Two hold-down clamps: example 02's toe clamp made into a reusable clamp, one on each side midpoint.
    await driver.step('Import example 02 toe clamp', async p => {
      const chooser = p.waitForEvent('filechooser')
      await p.getByRole('button', { name: 'Import geometry', exact: true }).click()
      await (await chooser).setFiles(path.join(folder, 'example-02-toe-clamp.stl'))
    }, s => s.project.geometry.some(g => g.name === 'example-02-toe-clamp' && g.loaded), { timeoutMs: 60000 })
    const clampBody = (await read()).project.geometry.find(g => g.name === 'example-02-toe-clamp').id
    await driver.step('Keep the clamp outside machinable stock', p => p.getByTestId('import-stock-choice-none').click(),
      s => s.project.geometry.find(g => g.id === clampBody).stockId === undefined)
    await page().getByTestId('tree-name-geometry').getByText('example-02-toe-clamp', { exact: true }).click()
    {
      const group = page().locator('[data-group="geo-position"]').locator('..')
      if (!await group.locator('input').count()) await page().getByTestId('props-group-geo-position').click()
      const spare = { x: CENTRE.x, y: CENTRE.y + STOCK_HALF + 60, z: 0 }
      for (const axis of ['X', 'Y', 'Z']) {
        const box = page().locator('.props-transform-row').first().locator('.props-transform-cell').filter({ hasText: new RegExp(`^${axis}$`) }).locator('input')
        await driver.step(`Set the spare clamp body aside: ${axis}`, async () => { await box.fill(String(spare[axis.toLowerCase()])); await box.press('Enter') },
          s => s.project.geometry.find(g => g.id === clampBody).position[axis.toLowerCase()] === spare[axis.toLowerCase()])
      }
    }
    await driver.step('Mark the toe clamp as workholding', p => p.getByTestId('geo-workholding-toggle').check(),
      s => s.project.geometry.find(g => g.id === clampBody).workholding === true)
    await driver.step('Make a reusable example 02 toe clamp', p => p.getByTestId('make-clamp-btn').click(),
      s => s.project.workholding?.definitions.some(d => d.kind === 'clamp'))
    const stockTop = (await read()).project.geometry.find(g => g.format === 'model').boundingBox.max.z
    for (const side of [-1, 1]) {
      const count = (await read()).project.workholding.instances.length
      await driver.step(`Place a toe clamp on the ${side < 0 ? 'left' : 'right'} side`, async p => {
        const at = await p.evaluate(point => window.__cncViewport.worldPointToScreen(point), { x: CENTRE.x + side * STOCK_HALF, y: CENTRE.y, z: stockTop })
        await p.mouse.click(at.x, at.y)
      }, s => s.project.workholding.instances.length === count + 1)
    }
    await page().getByTestId('clamp-placer-done').click()
    for (const instance of (await read()).project.workholding.instances) {
      // Select this clamp and wait until Properties shows it (its distance along the stock loop).
      const perimeter = 8 * STOCK_HALF
      for (let tries = 0; ; tries++) {
        await page().getByTestId(`tree-clamp-${instance.id}`).click()
        await page().waitForTimeout(300)
        const shown = Number(await page().getByTestId('clamp-along-input').inputValue())
        if (Math.abs(shown - instance.placement.fraction * perimeter) < 0.5) break
        assert(tries < 20, `Properties never showed clamp ${instance.id}`)
      }
      const sideX = instance.worldPose.position.x < CENTRE.x ? -1 : 1
      const along = instance.placement.fraction * perimeter
      // Snap the click to the exact middle of its side: the stock loop's side midpoints are 45 mm + k x 90 mm along.
      const middle = STOCK_HALF + 2 * STOCK_HALF * Math.round((along - STOCK_HALF) / (2 * STOCK_HALF))
      const at = s => s.project.workholding.instances.find(i => i.id === instance.id)
      await driver.step(`Centre clamp on its side: ${instance.id}`, async p => {
        await p.getByTestId('clamp-along-input').fill(String(middle)); await p.getByTestId('clamp-along-input').press('Enter')
      }, s => Math.abs(at(s).worldPose.position.y - CENTRE.y) < 0.05)
      // Turn the 60 mm clamp across the edge and push it out so only its toe sits on the blank.
      for (const [field, value] of [['clamp-turn-input', 90], ['clamp-offset-input', 30 - CLAMP_REACH]]) {
        await driver.step(`Set ${field} for ${instance.id}`, async p => {
          await p.getByTestId(field).fill(String(value)); await p.getByTestId(field).press('Enter')
        }, s => at(s).placement[field === 'clamp-offset-input' ? 'normalOffsetMm' : 'yawOffsetDeg'] === value)
      }
      // The toe (+X of the clamp body) points at the blank.
      const pose = at(await read()).worldPose
      const toe = Math.cos(pose.rotation.z * Math.PI / 180) * -sideX
      if (toe < 0) {
        await driver.step(`Point the toe at the blank: ${instance.id}`, async p => {
          await p.getByTestId('clamp-turn-input').fill('-90'); await p.getByTestId('clamp-turn-input').press('Enter')
        }, s => at(s).placement.yawOffsetDeg === -90)
      }
    }
    await page().mouse.click(1450, 300)

    await driver.page.getByRole('button', { name: 'Add setup', exact: true }).click()
    // The setup must be bound to the stock that OWNS the model body, or Adaptive 3D has no owning-stock evidence.
    await driver.page.locator('.wcs-stock-select').selectOption(fixed.id)
    await driver.step('Create stock-bound setup', p => p.getByRole('button', { name: 'Create Setup', exact: true }).click(),
      state => state.project.setups.length === 1 && state.project.setups[0].wcs.stockId === fixed.id)
    await page().getByTestId('tree-name-setup').first().click()
    await driver.step('Record screws, the clamps and the stop in the setup', async p => {
      await p.getByTestId('setup-holding-method').selectOption('screws')
      await p.getByTestId('setup-holding-note').fill(HOLDING_NOTE)
      await p.getByTestId('setup-holding-note').press('Tab')
    }, state => state.project.setups[0].holdingMethod === 'screws' && state.project.setups[0].notes === HOLDING_NOTE)

    const loops = (await read()).project.geometry.find(g => g.id === outline.id).loops
    const span = loop => Math.max(...loop.points.map(p => p.x)) - Math.min(...loop.points.map(p => p.x))
    const outlineLoop = loops.reduce((best, loop, i) => span(loop) > span(loops[best]) ? i : best, 0)
    const holeLoops = loops.map((_, i) => i).filter(i => i !== outlineLoop)
    assert.equal(holeLoops.length, 4, 'The drawing holds the outline and four screw holes')

    // Operation 1: the screw holes, through the blank, while the clamps hold it.
    await page().getByRole('button', { name: 'Add operation', exact: true }).click()
    await page().locator('.op-type-card').filter({ hasText: /^Drill$/ }).click()
    await tab(page(), 'Tool')
    await page().locator('.op-tool-row').filter({ hasText: '4 mm drill - screw clearance' }).click()
    await tab(page(), 'Geometry')
    await page().getByTestId('op-geometry-select').selectOption(outline.id)
    await pickLoops(page(), holeLoops)
    await tab(page(), 'Heights')
    await expandBottom(page())
    await page().getByTestId('drill-bore-height-mode').selectOption('explicit_depth')
    await opField(page(), 'Material Start (WCS)', 0)
    // A 4 mm, 118 deg drill keeps its full diameter 1.2 mm above its tip: full size through the blank, tip in the spoilboard.
    await opField(page(), 'Target End (WCS)', DRILL_END_WCS)
    const drilled = await driver.step('Create the screw hole drill', p => p.getByTestId('op-create').click(), state => {
      const op = state.project.setups[0].operations[0]
      return op?.type === 'drill' && op.params.geometryId === outline.id && op.params.loopIds?.length === 4 &&
        holeLoops.every(i => op.params.loopIds.includes(loops[i].id))
    })
    const drillId = drilled.project.setups[0].operations[0].id

    // The operator stop: retract, park, wait for the screws and for the clamps to come off.
    await page().getByRole('button', { name: 'Add operation', exact: true }).click()
    await page().getByTestId('op-type-action-operator_stop').click()
    await driver.step('Add the operator stop after the drill', p => p.getByTestId('op-create').click(),
      state => (state.project.setups[0].machineActions ?? []).length === 1 && state.project.setups[0].machineActions[0].afterOpId === drillId)
    await page().getByTestId('tree-machine-action').click()
    await driver.step('Write the operator stop message', async p => {
      await p.getByTestId('operator-stop-message-input').fill(STOP_MESSAGE)
      await p.getByTestId('operator-stop-message-input').press('Enter')
    }, state => state.project.setups[0].machineActions[0].message === STOP_MESSAGE)

    let roughBottomRow
    for (const [type, tool, name] of [['Adaptive Rough (3D)', '6 mm flat end mill', 'adaptive_3d'], ['Parallel Finish (3D)', '3 mm flat end mill', 'parallel_3d']]) {
      await page().getByRole('button', { name: 'Add operation', exact: true }).click()
      await page().getByText(type, { exact: true }).click()
      await tab(page(), 'Tool')
      await page().locator('.op-tool-row').filter({ hasText: tool }).click()
      await tab(page(), 'Geometry')
      const select = page().getByTestId(name === 'adaptive_3d' ? 'op-adaptive3d-part-select' : 'op-parallel3d-part-select')
      const geo = (await read()).project.geometry.find(g => g.format === 'model')
      await select.selectOption(geo.id)
      if (name === 'parallel_3d') {
        await tab(page(), 'Passes')
        const finish = page().getByTestId('op-parallel3d-finish-depth').locator('input')
        await finish.fill(String(RELIEF_DEPTH)); await finish.press('Tab')
      }
      await tab(page(), 'Heights')
      if (name === 'adaptive_3d') {
        // The rough stays in the relief band: its bottom is the disc top minus the relief depth.
        await expandBottom(page())
        await page().getByTestId('standard-height-bottom-source-control').selectOption('top')
        const offset = page().getByTestId('standard-height-bottom-offset-control').locator('input')
        await offset.fill(String(RELIEF_DEPTH)); await offset.press('Tab')
        await page().getByTestId('standard-height-bottom-operator-control').selectOption('-')
        await page().waitForTimeout(1000)
        roughBottomRow = await page().getByTestId('standard-height-bottom-resolved').innerText()
      }
      await driver.step(`Create ${type}`, async p => {
        await p.waitForFunction(() => {
          const create = document.querySelector('[data-testid="op-create"]')
          const preflight = document.querySelector('[data-testid="adaptive3d-height-preflight"]')
          return create && (!create.disabled || preflight?.textContent.includes('resolution_refused'))
        }, null, { timeout: 180000 })
        const preflight = p.getByTestId('adaptive3d-height-preflight')
        if (await preflight.count()) {
          const text = await preflight.innerText()
          assert(!text.includes('resolution_refused'), text)
        }
        await p.getByTestId('op-create').click()
      }, state => state.project.setups[0].operations.some(op => op.type === name), { timeoutMs: 180000 })
    }

    // The outline is last: through the blank, the disc held to the frame by 4 triangular tabs.
    await page().getByRole('button', { name: 'Add operation', exact: true }).click()
    await page().locator('.op-type-card').filter({ hasText: /^2D Contour/ }).click()
    await tab(page(), 'Tool')
    await page().locator('.op-tool-row').filter({ hasText: `${OUTLINE_CUTTER} mm flat end mill` }).click()
    await tab(page(), 'Geometry')
    await page().getByTestId('op-geometry-select').selectOption(outline.id)
    await pickLoops(page(), [outlineLoop])
    await tab(page(), 'Linking')
    await page().getByTestId('contour-tabs-enabled').check()
    await opField(page(), 'Tab width', TABS.width)
    await opField(page(), 'Tab height', TABS.height)
    await opField(page(), 'Tab count', TABS.count)
    await page().getByTestId('contour-tab-shape').selectOption(TABS.shape)
    await tab(page(), 'Heights')
    await expandBottom(page())
    await page().getByTestId('contour-height-mode').selectOption('through_stock')
    await opField(page(), 'Past stock bottom', 0.2)
    await driver.step('Create the tabbed outline contour', p => p.getByTestId('op-create').click(), state => {
      const op = state.project.setups[0].operations.at(-1)
      return op?.type === 'contour_2d' && op.params.tabs === true && op.params.tabShape === TABS.shape && op.params.tabCount === TABS.count &&
        op.params.tabWidth === TABS.width && op.params.tabHeight === TABS.height && op.params.loopIds?.length === 1 && op.params.loopIds[0] === loops[outlineLoop].id
    })

    await page().getByTestId('mode-tab-toolpath').click()
    let lastStatuses = ''
    await driver.step('Compute every operation', p => p.getByText('Regen all', { exact: false }).first().click(), state => {
      const ops = state.project.setups[0].operations
      for (const op of ops) assert.notEqual(op.status, 'error', `${op.name}: ${op.error}`)
      const statuses = ops.map(op => `${op.name}:${op.status}`).join(' ')
      if (statuses !== lastStatuses) { console.log(`  ${new Date().toISOString()} ${statuses}`); lastStatuses = statuses }
      return ops.length === 4 && ops.every(op => op.status === 'ready')
    }, { timeoutMs: Number(process.env.WO2446_COMPUTE_MS ?? 1500000) })
    await consoleReadback(driver, 'built-console.json')
    // Show the operation list with the stop in its place, as the WO-2379 picture did.
    await page().locator('.tree-setup-header').first().click()
    if (!await page().getByTestId('tree-machine-action').isVisible()) await page().locator('.tree-setup-header').first().click()
    await page().getByTestId('tree-machine-action').waitFor()
    await capture(driver, 'toolpaths.png')
    await capture(driver, 'toolpaths-top.png', 'Top view')
    const built = await driver.readState()
    writeFileSync(driver.output('built-state.json'), JSON.stringify(built.project, null, 2))

    const saved = await driver.saveAndReopen('relief-medallion.camproject')
    observe(driver.page)
    await page().getByTestId('mode-tab-toolpath').click()
    const reopened = await driver.step('Reopen: every operation current without recompute', async () => {}, state => {
      const ops = state.project.setups[0].operations
      return ops.length === 4 && ops.every(op => op.status === 'ready')
    }, { timeoutMs: 120000 })
    assert.equal(reopened.project.setups[0].holdingMethod, 'screws')
    assert.equal(reopened.project.setups[0].notes, HOLDING_NOTE)
    assert.deepEqual(reopened.project.setups[0].machineActions, saved.setups[0].machineActions)
    assert.deepEqual(reopened.project.workholding, saved.workholding)
    await consoleReadback(driver, 'reopened-console.json')

    await page().getByTestId('tree-name-setup').first().click()
    await page().getByTestId('mode-tab-postprocess').click()
    const posted = page().waitForEvent('download', { timeout: 180000 })
    await page().getByRole('button', { name: /^Export \./ }).click()
    await (await posted).saveAs(driver.output('relief-medallion.nc'))
    const sheetDownloads = []
    const collectSheet = download => sheetDownloads.push(download)
    page().on('download', collectSheet)
    try {
      await page().getByTestId('post-download-setup-sheet').click()
      const deadline = Date.now() + 120000
      while (sheetDownloads.length < 2 && Date.now() < deadline) await page().waitForTimeout(100)
      assert.equal(sheetDownloads.length, 2, 'Setup Sheet must download text and PDF')
      for (const download of sheetDownloads) {
        const ext = download.suggestedFilename().endsWith('.pdf') ? 'pdf' : 'txt'
        await download.saveAs(driver.output(`relief-medallion.setup.${ext}`))
      }
    } finally { page().off('download', collectSheet) }
    const sheet = readFileSync(path.join(driver.outDir, 'relief-medallion.setup.txt'), 'utf8')
    assert.match(sheet, /Method: Screws/)
    assert.match(sheet, /Clamp: .*example-02-toe-clamp.* x 2/)
    assert.ok(sheet.includes(STOP_MESSAGE), 'The job sheet carries the stop message')
    assert.match(sheet, /4 tabs per contour, 11(?:\.0+)?mm wide x 1\.5(?:0+)?mm high, triangular/)
    await page().locator('.post-modal').getByRole('button', { name: 'Cancel', exact: true }).click()
    await consoleReadback(driver, 'posted-console.json')

    await page().getByTestId('mode-tab-simulation').click()
    await page().getByLabel('Simulate Stock Removal').check()
    await page().getByRole('button', { name: 'Cut Stock', exact: true }).click()
    await page().getByTestId('sim-hide-toolpath').check()
    await page().waitForFunction(() => window.__cncViewport?.voxelSimTexture?.texture.image.data.length > 0, null, { timeout: 120000 })
    const baseline = await page().evaluate(() => {
      const vp = window.__cncViewport, image = vp.voxelSimTexture.texture.image
      return { solidSamples: Array.from(image.data).filter(v => v >= 0).length, cell: vp.voxelSimMaterial.uniforms.uVoxelSize.value }
    })
    const scrubber = page().getByRole('slider', { name: 'Simulation position' })
    const totalMs = Number(await scrubber.getAttribute('max'))
    assert.ok(totalMs > 0)
    await scrubber.fill(String(Math.round(totalMs * 0.5)))
    await page().waitForFunction(() => document.querySelector('.sim-panel')?.getAttribute('data-stock-sync') === 'exact', null, { timeout: 300000 })
    await capture(driver, 'simulation-mid-cut.png')
    await driver.step('Simulate the complete setup to the end', p => p.getByRole('button', { name: 'Skip to end', exact: true }).click(), async state =>
      state.project.setups[0].operations.every(o => o.status === 'ready') && await page().evaluate(() => {
        const slider = document.querySelector('.sim-scrubber'), panel = document.querySelector('.sim-panel')
        return document.querySelector('[data-testid="mode-tab-simulation"]')?.classList.contains('mode-tab-active') &&
          slider && Math.abs(Number(slider.value) - Number(slider.max)) <= 1 && panel?.getAttribute('data-stock-sync') === 'exact' && Number(panel.getAttribute('data-stock-ms')) === Math.round(Number(slider.max))
      }), { timeoutMs: 600000 })
    const simulation = await page().evaluate(() => {
      const vp = window.__cncViewport, image = vp.voxelSimTexture.texture.image
      const panel = document.querySelector('.sim-panel'), slider = document.querySelector('.sim-scrubber')
      return { engine: 'voxel', solidSamples: Array.from(image.data).filter(v => v >= 0).length, cell: vp.voxelSimMaterial.uniforms.uVoxelSize.value,
        markerMs: Number(slider.value), stockMs: Number(panel.getAttribute('data-stock-ms')), stockSync: panel.getAttribute('data-stock-sync') }
    })
    simulation.initialSolidSamples = baseline.solidSamples
    simulation.removedVolumeMm3 = (baseline.solidSamples - simulation.solidSamples) * simulation.cell ** 3
    assert.ok(simulation.removedVolumeMm3 > 0, 'Simulation must remove material')
    simulation.stock = await stockReadback(driver, saved)
    writeFileSync(driver.output('simulation.json'), `${JSON.stringify(simulation, null, 2)}
`)
    await capture(driver, 'simulation-end.png')
    await capture(driver, 'simulation-end-top.png', 'Top view')
    assert.equal(simulation.stock.display, 'true')
    assert.equal(simulation.stock.outline.bottomSolidRuns, TABS.count, 'Only the tabs join the disc to the frame')
    assert.equal(simulation.stock.outline.bottomBridgeRuns, TABS.count, 'Each tab bridges the full cutter slot')
    assert.equal(simulation.stock.outline.aboveTabSolidSamples, 0, 'The outline is cut through above the tabs')
    assert.equal(simulation.stock.frame.solidSamples, simulation.stock.frame.samples, 'The frame is whole')
    assert.equal(simulation.stock.screwHoles.solidSamples, 0, 'The screw holes are drilled through')
    assert.ok(simulation.stock.discCentreSolid, 'The disc is kept')
    await consoleReadback(driver, 'simulation-console.json')

    const project = saved
    const ops = project.setups[0].operations
    const lowest = op => Math.min(...op.toolpathMoves.map(m => m.z))
    const report = {
      sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      machine: { id: project.machine.id, controller: project.machine.controller, operatorStopPark: project.machine.operatorStopPark ?? null },
      stock: project.sceneStock.fixedStocks.find(s => s.id === project.setups[0].wcs.stockId),
      model: project.geometry.find(g => g.format === 'model').boundingBox,
      holdingMethod: project.setups[0].holdingMethod, notes: project.setups[0].notes,
      machineActions: project.setups[0].machineActions,
      clamps: project.workholding.instances.map(i => ({ id: i.id, position: i.worldPose.position, rotation: i.worldPose.rotation, placement: i.placement })),
      operations: ops.map(o => ({ name: o.name, type: o.type, status: o.status, moves: o.toolpathMoves.length, lowestZ: lowest(o) })),
      roughBottomRow,
      screwHoleClearanceMm: screwHoleClearance(project),
      simulation, totalMs,
    }
    writeFileSync(driver.output('verification.json'), `${JSON.stringify(report, null, 2)}\n`)
    for (const name of ['relief-medallion.camproject', 'reopened.png', 'toolpaths.png', 'simulation-end.png', 'relief-medallion.setup.txt']) {
      copyFileSync(path.join(driver.outDir, name), path.join(folder, name))
    }
    assert.equal(consoleLog.filter(event => ['error', 'pageerror'].includes(event.type)).length, 0, 'Browser console must contain no errors')
    const scan = scanDirectory(folder)
    writeFileSync(driver.output('scan.json'), `${JSON.stringify(scan, null, 2)}\n`)
    assert.deepEqual(scan.hits, [])
  } finally {
    writeFileSync(driver.output('console.json'), JSON.stringify(consoleLog, null, 2))
  }
})
