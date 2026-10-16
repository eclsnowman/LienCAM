import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { withExampleDriver } from './lib/drive.mjs'
import { Shape, Path, ExtrudeGeometry, Mesh, MeshBasicMaterial, Group, BoxGeometry } from 'three'
import { STLExporter } from 'three/addons/exporters/STLExporter.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const PART = 'examples/04-tool-storage-bar'
const EVIDENCE = 'src/tests/evidence/WO-2547'
const LONG_FLUTE_MILL = '3 mm flat end mill, 15 mm flutes'
const HOLES = [{ x: 25, diameter: 6.5 }, { x: 68, diameter: 8.5 }, { x: 121, diameter: 12.5 }]

// The flip relationship describes the fixture, not a transformation of imported
// CAM drawings. Author both views explicitly so the second side's X is mirrored.
function drawing(flipped) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="160mm" height="50mm" viewBox="0 0 160 50">
  <title>Original tool storage bar - ${flipped ? 'bottom after Y-axis flip' : 'top'}</title>
  <desc>Apache-2.0; made for the release. 160 x 50 x 12 mm bar.</desc>
  <rect x="0" y="0" width="160" height="50" fill="none" stroke="#54b9d5"/>
  ${HOLES.map(h => `<circle cx="${flipped ? 160 - h.x : h.x}" cy="25" r="${h.diameter / 2}" fill="none" stroke="#54b9d5"/>`).join('\n  ')}
</svg>\n`
}

function model() {
  const shape = new Shape()
  shape.moveTo(0, 0); shape.lineTo(160, 0); shape.lineTo(160, 50); shape.lineTo(0, 50); shape.closePath()
  for (const hole of HOLES) {
    const path = new Path()
    path.absarc(hole.x, 25, hole.diameter / 2, 0, Math.PI * 2, true)
    shape.holes.push(path)
  }
  const geometry = new ExtrudeGeometry(shape, { depth: 12, bevelEnabled: false, curveSegments: 40 })
  geometry.translate(-80, -25, -12)
  const material = new MeshBasicMaterial()
  const text = new STLExporter().parse(new Mesh(geometry, material))
  geometry.dispose(); material.dispose()
  return text.replace('solid exported', 'solid original_tool_storage_bar_Apache-2.0_made_for_release')
}

// Example 02's finished profile, 3 mm screw hole and 2 mm blind toe recess.
// Use its actual dimensions, rather than an arbitrary obstacle box.
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
  return text
}

function endStopModel() {
  const geometry = new BoxGeometry(8, 7, 12)
  const material = new MeshBasicMaterial()
  const text = new STLExporter().parse(new Mesh(geometry, material))
  geometry.dispose(); material.dispose()
  return text
}

async function importHolder(driver, name, position) {
  await driver.step(`Import ${name}`, async page => {
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: 'Import geometry', exact: true }).click()
    await (await chooser).setFiles(path.join(ROOT, PART, `${name}.stl`))
  }, s => s.project.geometry.some(g => g.name === name && g.loaded))
  const id = (await driver.readState()).project.geometry.find(g => g.name === name).id
  await driver.step(`Keep ${name} outside machinable stock`, p => p.getByTestId('import-stock-choice-none').click(),
    s => s.project.geometry.find(g => g.id === id).stockId === undefined &&
      s.project.geometry.find(g => g.id === id).stockIdLocked === true)
  await driver.page.getByTestId('tree-name-geometry').getByText(name, { exact: true }).click()
  const group = driver.page.locator('[data-group="geo-position"]').locator('..')
  if (!await group.locator('input').count()) await driver.page.getByTestId('props-group-geo-position').click()
  // Imported STL is centred in XY and seated at Z0; author its scene pose
  // only with the production transform fields.
  for (const axis of ['X', 'Y', 'Z']) {
    const input = driver.page.locator('.props-transform-row').first().locator('.props-transform-cell')
      .filter({ hasText: new RegExp(`^${axis}$`) }).locator('input')
    await driver.step(`Seat ${name} ${axis}`, async () => {
      await input.fill(String(position[axis.toLowerCase()])); await input.press('Enter')
    }, s => s.project.geometry.find(g => g.id === id).position[axis.toLowerCase()] === position[axis.toLowerCase()])
  }
  await driver.step(`Mark ${name} as workholding`, p => p.getByTestId('geo-workholding-toggle').check(),
    s => s.project.geometry.find(g => g.id === id).workholding === true)
  return id
}

async function addWorkholding(driver) {
  await driver.page.getByTestId('tree-name-setup').getByText('Top - G54', { exact: true }).click()
  await importHolder(driver, 'fixed-end-stop', { x: -84, y: 21.5, z: -12 })
  await importHolder(driver, 'example-02-toe-clamp', { x: 0, y: 80, z: 0 })
  await driver.step('Make a reusable example 02 toe clamp', p => p.getByTestId('make-clamp-btn').click(),
    s => s.project.workholding?.definitions.some(d => d.kind === 'clamp'))
  for (const x of [-80, 80]) {
    const count = (await driver.readState()).project.workholding.instances.length
    await driver.step(`Place toe clamp on the X ${x} stock end`, async page => {
      const at = await page.evaluate(x => window.__cncViewport.worldPointToScreen({ x, y: 0, z: 0 }), x)
      await page.mouse.click(at.x, at.y)
    }, s => s.project.workholding.instances.length === count + 1)
  }
  await driver.page.getByTestId('clamp-placer-done').click()
  const state = await driver.readState()
  const bottom = state.project.setups[1]
  for (const instance of state.project.workholding.instances) {
    await driver.page.getByTestId(`tree-clamp-${instance.id}`).click()
    // Snap the click's perimeter distance to the exact middle of this end.
    const along = instance.worldPose.position.x < 0 ? 395 : 185
    await driver.step(`Centre clamp on stock end: ${instance.id}`, async page => {
      await page.getByTestId('clamp-along-input').fill(String(along))
      await page.getByTestId('clamp-along-input').press('Enter')
    }, s => Math.abs(s.project.workholding.instances.find(i => i.id === instance.id).worldPose.position.y) < 0.001)
    for (const [field, value] of [['clamp-offset-input', 19], ['clamp-turn-input', 90]]) {
      await driver.step(`Set ${field} for ${instance.id}`, async page => {
        await page.getByTestId(field).fill(String(value)); await page.getByTestId(field).press('Enter')
      }, s => s.project.workholding.instances.find(i => i.id === instance.id).placement[
        field === 'clamp-offset-input' ? 'normalOffsetMm' : 'yawOffsetDeg'] === value)
    }
    await driver.step(`Copy toe clamp to G55: ${instance.id}`,
      p => p.getByTestId('clamp-copy-to-setup').selectOption(bottom.id),
      s => s.project.workholding.instances.length === (instance === state.project.workholding.instances[0] ? 3 : 4))
  }
  for (const setup of state.project.setups) {
    // A setup click changes the active setup but retains a selected clamp.
    // Clear it with the normal empty-viewport click before editing setup fields.
    await driver.page.mouse.click(1450, 300)
    await driver.page.getByTestId('tree-name-setup').getByText(setup.name, { exact: true }).click()
    await driver.step(`Record clamps and flip instruction: ${setup.name}`, async page => {
      await page.getByTestId('setup-holding-method').selectOption('clamps')
      await page.getByTestId('setup-holding-note').fill(
        'Clamp the ends with the two example 02 toe clamps; inner edges at X -69 and +69 mm, outside X +/-62. ' +
        'Bolt clamps to the spoilboard with firm 12 mm packing under their outer ends; seat the bar on the spoilboard against the fixed end stop at X -80. ' +
        'At the M0 pause, flip end-for-end about Y, back against the stop, re-clamp. Keep the bar at the same XY position; use G55 for the second side. ' +
        (setup === state.project.setups[0]
          ? 'G54 makes all three holes: peck-drill pilots in 3 mm increments to Z-13 into the spoilboard, bore to Z-12.5 (0.5 mm break-through) with the same 3 mm end mill specified with 15 mm flutes, and chamfer the top rims. One-sided bores avoid flip mismatch.'
          : 'G55 only chamfers the underside rims; do not drill or bore again. These rims are accessible only after the flip.'))
      await page.getByTestId('setup-holding-note').press('Tab')
    }, s => s.project.setups.find(item => item.id === setup.id).holdingMethod === 'clamps' &&
      s.project.setups.find(item => item.id === setup.id).notes.includes('flip end-for-end about Y'))
  }
}

async function field(page, label, value) {
  const row = page.locator('.op-field-row').filter({ has: page.locator('.op-field-label').getByText(label, { exact: true }) })
  const input = row.locator('input').first()
  await input.fill(String(value))
  await input.press('Tab')
}

async function importDrawing(driver, name) {
  return driver.step(`Import ${name}`, async page => {
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: 'Import geometry', exact: true }).click()
    await (await chooser).setFiles(path.join(ROOT, PART, name))
  }, s => s.project.geometry.some(g => g.name === name.replace('.svg', '') && g.loops.length === 4))
}

async function setup(driver, stockId, secondSide = false) {
  const before = await driver.readState()
  await driver.page.getByRole('button', { name: 'Add setup', exact: true }).click()
  if (secondSide) {
    await driver.page.getByTestId('setup-second-side-of').selectOption(before.project.setups[0].id)
    await driver.page.getByTestId('setup-second-side-axis').selectOption('y')
  } else await driver.page.locator('.wcs-stock-select').selectOption(stockId)
  await driver.page.getByTestId('setup-modal-basics').locator('input').first().fill(secondSide ? 'Bottom - flip about Y - G55' : 'Top - G54')
  await driver.step(`Create ${secondSide ? 'bottom flip' : 'top'} setup`, p => p.getByRole('button', { name: 'Create Setup', exact: true }).click(),
    s => s.project.setups.length === before.project.setups.length + 1 && (!secondSide || s.project.setups[1].flipOf?.axis === 'y'))
  if (secondSide) {
    await driver.page.getByRole('button', { name: 'Edit setup', exact: true }).last().click()
    await driver.page.getByTestId('stock-work-offset-select').selectOption('55')
    await driver.step('Assign G55 to the flipped setup', p => p.getByRole('button', { name: 'Save Setup', exact: true }).click(),
      s => s.project.setups[1].wcs.fixtureOffset === 55 || s.project.setups[1].wcs.label === 'G55')
  }
}

async function operation(driver, side, type) {
  const state = await driver.readState()
  const geo = state.project.geometry.find(g => g.name === side)
  const tool = type === 'drill' ? '3 mm drill' : type === 'bore' ? LONG_FLUTE_MILL : '6 mm 90 deg chamfer mill'
  await driver.page.getByRole('button', { name: 'Add operation', exact: true }).last().click()
  await driver.page.locator('.op-type-card').filter({ hasText: type === 'chamfer' ? '2D Chamfer' : type === 'drill' ? /^Drill$/ : /^Bore$/ }).click()
  if (side === 'bottom') await driver.page.getByPlaceholder(/^Chamfer \d+$/).fill('Chamfer underside')
  await driver.page.locator('.op-modal-tab').filter({ hasText: 'Tool' }).click()
  await driver.page.locator('.op-tool-row').filter({ hasText: tool }).click()
  await driver.page.locator('.op-modal-tab').filter({ hasText: 'Geometry' }).click()
  await driver.page.getByTestId('op-geometry-select').selectOption(geo.id)
  await driver.page.getByRole('button', { name: /^All loops \(/ }).click()
  const loops = driver.page.locator('.op-loop-check')
  const outerIndex = geo.loops.findIndex(l => l.type !== 'hole')
  await loops.nth(outerIndex).locator('input[type=checkbox]').uncheck()
  if (type === 'chamfer') {
    // Only hole rims: the stock exterior needs no contouring in this lesson.
    for (const row of await loops.all()) {
      if (await row.locator('input[type=checkbox]').isChecked()) await row.getByRole('button', { name: 'Inside', exact: true }).click()
    }
    await driver.page.locator('.op-modal-tab').filter({ hasText: 'Passes' }).click()
    await field(driver.page, 'Chamfer width', 0.4)
    await field(driver.page, 'Tip offset', 0.3)
  }
  if (type === 'drill') {
    await driver.page.locator('.op-modal-tab').filter({ hasText: 'Passes' }).click()
    await driver.page.getByRole('button', { name: 'Peck (G83)', exact: true }).click()
    await field(driver.page, 'Peck depth', 3)
  }
  if (type === 'bore') {
    // The 15 mm flutes retain the default clearance above a 12.5 mm cut.
    await driver.page.locator('.op-modal-tab').filter({ hasText: 'Passes' }).click()
    await driver.page.getByTestId('op-shank-clearance').locator('input').fill('0.25')
    await driver.page.getByTestId('op-shank-clearance').locator('input').press('Tab')
  }
  await driver.page.locator('.op-modal-tab').filter({ hasText: 'Heights' }).click()
  await driver.page.getByRole('button', { name: /^Expand Bottom.*height$/i }).click()
  if (type !== 'chamfer') {
    await driver.page.getByTestId('drill-bore-height-mode').selectOption('explicit_depth')
    await field(driver.page, 'Material Start (WCS)', 0)
    // One side makes the entire hole; the second side only breaks its exit rim.
    // Pilot tip clears the stock; the 15 mm end-mill flutes clear the bottom face by 0.5 mm.
    await field(driver.page, 'Target End (WCS)', type === 'drill' ? -13 : -12.5)
  }
  const count = state.project.setups.at(-1).operations.length
  await driver.step(`Create ${side} ${type}`, p => p.getByTestId('op-create').click(),
    s => s.project.setups.at(-1).operations.length === count + 1 && s.project.setups.at(-1).operations.at(-1).type === type)
}

// Customize the existing project tool; the shared starter library stays intact.
export async function specifyLongFluteMill(driver) {
  if ((await driver.readState()).toolLibrary.some(t => t.name === LONG_FLUTE_MILL && t.fluteLength === 15)) return
  const page = driver.page
  await page.getByTestId('mode-tab-toollibrary').click()
  await page.locator('.tool-list-item').filter({ hasText: '3 mm flat end mill' }).click()
  await page.locator('.tool-tab').filter({ hasText: /^General$/ }).click()
  await page.locator('.tool-editor-col .mform-row').filter({ has: page.locator('.mform-label').getByText('Name', { exact: true }) }).locator('input').fill(LONG_FLUTE_MILL)
  await page.locator('.tool-tab').filter({ hasText: /^Cutter$/ }).click()
  const input = page.locator('.mform-row').filter({ hasText: 'Flute length (from tip)' }).locator('input')
  await input.fill('15'); await input.press('Tab')
  await driver.step('Name the 3 mm end mill with 15 mm flutes distinctly',
    p => p.getByRole('button', { name: 'Save Changes', exact: true }).click(),
    s => s.toolLibrary.some(t => t.name === LONG_FLUTE_MILL && t.fluteLength === 15))
  await page.locator('.tool-modal .modal-close-btn').click()
}

export async function computeAll(driver, label) {
  await driver.page.getByRole('button', { name: 'Expand all', exact: true }).click()
  const state = await driver.readState()
  for (let i = 0; i < state.project.setups.flatMap(s => s.operations).length; i++) {
    await driver.step(`${label}: compute operation ${i + 1}`, async p => {
      await p.getByRole('button', { name: 'Compute toolpath', exact: true }).nth(i).click()
      // OPFS is an asynchronous durable snapshot. Allow the newly requested
      // computation to publish instead of accepting the previous ready value.
      await p.waitForTimeout(1500)
    },
      s => {
        const op = s.project.setups.flatMap(s => s.operations)[i]
        assert.notEqual(op.status, 'error', `${op.name}: ${op.error}`)
        return op.status === 'ready'
      }, { timeoutMs: 120_000 })
  }
  return driver.step(`${label}: all four operations ready`, async p => { await p.waitForTimeout(3000) },
    async s => s.project.setups.flatMap(setup => setup.operations).every(op => op.status === 'ready') &&
      await driver.page.locator('.tree-op .status-ready').count() === 4)
}

export async function postAll(driver) {
  await driver.page.getByTestId('mode-tab-postprocess').click()
  for (const box of await driver.page.locator('.scope-setup-cb').all()) await box.check()
  const pause = driver.page.locator('.mform-row').filter({ hasText: 'Pause between setups (M0)' })
  await pause.locator('label.toggle').click()
  assert.equal(await pause.locator('input').isChecked(), true)
  const picker = driver.page.getByRole('combobox', { name: 'Post definition', exact: true })
  await picker.click()
  const dialects = await driver.page.getByRole('listbox').getByRole('option').allTextContents()
  await driver.page.keyboard.press('Escape')
  const programs = []
  for (const [index, dialect] of dialects.entries()) {
    await picker.click()
    await driver.page.getByRole('listbox').getByRole('option', { name: dialect, exact: true }).click()
    await driver.step(`Post ${dialect}`, async page => {
      const event = page.waitForEvent('download', { timeout: 120_000 })
      await page.getByRole('button', { name: /^Export \./ }).click()
      const download = await event
      const file = driver.output(`post-${index + 1}.nc`)
      await download.saveAs(file)
      const text = readFileSync(file, 'utf8')
      assert.match(text, /\bG54\b/)
      assert.match(text, /\bG55\b/)
      assert.match(text, /^\s*(?:N\d+\s+)?M0(?:\s|$)/m)
      programs.push({ dialect, file: path.basename(file), lines: text.split('\n').length })
    }, s => s.project.setups.every(setup => setup.operations.every(op => op.status === 'ready')))
    if (index === 0) {
      const downloads = []
      const onDownload = download => downloads.push(download)
      driver.page.on('download', onDownload)
      try {
        await driver.page.getByTestId('post-download-setup-sheet').click()
        for (let i = 0; i < 120 && downloads.length < 2; i++) await driver.page.waitForTimeout(250)
        assert.equal(downloads.length, 2, 'Production Setup Sheet must download text and PDF')
        for (const download of downloads) {
          const extension = path.extname(download.suggestedFilename())
          await download.saveAs(driver.output(`job-sheet${extension}`))
          copyFileSync(path.join(driver.outDir, `job-sheet${extension}`), path.join(ROOT, PART, `job-sheet${extension}`))
        }
        const text = readFileSync(path.join(driver.outDir, 'job-sheet.txt'), 'utf8')
        assert.match(text, /Method: Clamps/)
        assert.match(text, /Clamp: .*example-02-toe-clamp.* x 2/)
        assert.match(text, /fixed-end-stop/)
        assert.match(text, /flip end-for-end about Y, back against the stop, re-clamp/)
      } finally { driver.page.off('download', onDownload) }
    }
  }
  await driver.page.getByRole('button', { name: 'Close', exact: true }).click()
  return programs
}

// Read the renderer's real simulation texture, not a second simulator seeded by
// this script. Positive signed-distance voxels are remaining solid; this is an
// approximate occupied-cell volume at the recorded simulation resolution.
async function solidVolume(page) {
  return page.evaluate(() => {
    const vp = window.__cncViewport
    const data = vp?.voxelSimTexture?.texture?.image?.data
    const cell = vp?.voxelSimMaterial?.uniforms?.uVoxelSize?.value
    if (!data || !cell) return null
    let occupied = 0
    for (const value of data) if (value > 0) occupied++
    return { occupied, voxelSizeMm: cell, volumeMm3: occupied * cell ** 3 }
  })
}

export async function frameHolding(page) {
  for (const name of ['Fit all', 'Top view']) {
    await page.locator('.viewport-canvas').click({ button: 'right', position: { x: 60, y: 60 } })
    await page.getByRole('menuitem', { name, exact: true }).click()
    await page.waitForTimeout(500)
  }
  await page.mouse.move(1000, 540)
  await page.mouse.wheel(0, -900)
  await page.waitForTimeout(700)
}

export async function simulate(driver) {
  const results = []
  for (const side of ['Top - G54', 'Bottom - flip about Y - G55']) {
    await driver.page.getByTestId('tree-name-setup').getByText(side, { exact: true }).click()
    await driver.page.getByTestId('mode-tab-simulation').click()
    await driver.page.getByLabel('Simulate Stock Removal', { exact: true }).check()
    await driver.page.getByRole('button', { name: 'Rewind to start', exact: true }).click()
    await driver.step(`Initialize simulation: ${side}`, async () => {}, async s =>
      s.project.activeOperationId === null && (await solidVolume(driver.page)) !== null)
    const before = await solidVolume(driver.page)
    const slider = driver.page.getByRole('slider', { name: 'Simulation position', exact: true })
    const box = await slider.boundingBox()
    await slider.click({ position: { x: box.width / 2, y: box.height / 2 } })
    await driver.page.getByRole('button', { name: 'Cut Stock', exact: true }).click()
    await driver.page.waitForTimeout(1500)
    if (results.length === 0) await driver.page.screenshot({ path: driver.output('simulation-mid-cut.png') })
    await driver.step(`Simulate to end: ${side}`, page => page.getByRole('button', { name: 'Skip to end', exact: true }).click(), async () => {
      // Native range inputs quantize to their 1 ms step; the app's duration is
      // fractional milliseconds. Equality would reject a completed timeline.
      const position = await slider.evaluate(el => ({ value: Number(el.value), max: Number(el.max) }))
      const atEnd = Math.abs(position.value - position.max) <= 1 && position.max > 0
      const after = await solidVolume(driver.page)
      const busy = await driver.page.locator('.sim-carve-progress').isVisible()
      writeFileSync(path.join(driver.outDir, 'simulation-readback.json'), JSON.stringify({ side, position, busy, before, after }, null, 2))
      return atEnd && !busy && after.volumeMm3 < before.volumeMm3
    }, { timeoutMs: 120_000 })
    const after = await solidVolume(driver.page)
    const contacts = (await driver.readState()).consoleEvents?.filter(e => /contacts workholding/i.test(e.message)) ?? []
    assert.equal(contacts.length, 0, JSON.stringify(contacts))
    results.push({ side, before, after, removedVolumeMm3: before.volumeMm3 - after.volumeMm3, reachedEnd: true, contacts })
    // Frame the whole holding arrangement, then tilt so the hole walls read.
    await frameHolding(driver.page)
    await driver.page.mouse.move(1000, 540)
    await driver.page.mouse.down()
    await driver.page.mouse.move(1000, 640, { steps: 12 })
    await driver.page.mouse.up()
    await driver.page.getByLabel('Hide Toolpath', { exact: true }).check()
    await driver.page.waitForTimeout(800)
    await driver.page.screenshot({ path: driver.output(`simulation-${results.length}-end.png`) })
    // Undo the framing so the second setup starts from the same camera.
    await driver.page.getByLabel('Hide Toolpath', { exact: true }).uncheck()
    await driver.page.mouse.move(1000, 640)
    await driver.page.mouse.down()
    await driver.page.mouse.move(1000, 540, { steps: 12 })
    await driver.page.mouse.up()
  }
  return results
}

export async function buildToolStorageBar() {
  mkdirSync(path.join(ROOT, PART), { recursive: true })
  for (const [side, flipped] of [['top', false], ['bottom', true]]) writeFileSync(path.join(ROOT, PART, `${side}.svg`), drawing(flipped))
  writeFileSync(path.join(ROOT, PART, 'tool-storage-bar.stl'), model())
  writeFileSync(path.join(ROOT, PART, 'example-02-toe-clamp.stl'), toeClampModel())
  writeFileSync(path.join(ROOT, PART, 'fixed-end-stop.stl'), endStopModel())
  return withExampleDriver({ outDir: EVIDENCE }, async driver => {
    for (const name of ['model.png', 'toolpaths.png', 'simulation-mid-cut.png', 'simulation-1-end.png',
      'simulation-2-end.png', 'readback.json', 'verification.json', 'debug-state.json', 'debug-ui.txt',
      'tool-storage-bar.camproject', ...readdirSync(driver.outDir).filter(name => /^post-\d+\.nc$/.test(name))]) driver.output(name)
    for (const name of ['tool-storage-bar.camproject', 'reopened.png']) rmSync(path.join(ROOT, PART, name), { force: true })
    const consoleLines = []
    const observe = page => {
      page.on('console', msg => consoleLines.push(`${msg.type()}: ${msg.text()}`))
      page.on('pageerror', error => consoleLines.push(`pageerror: ${error.message}`))
    }
    observe(driver.page)
    try {
      await driver.page.setViewportSize({ width: 1920, height: 1080 })
      await driver.newProject()
      const stock = await driver.setStock({ width: 160, height: 50, depth: 12 })
      await driver.step('Name the project', async page => {
        await page.getByTestId('tree-name-project').dblclick()
        const input = page.getByTestId('tree-rename-input')
        await input.fill('04 Tool storage bar'); await input.press('Enter')
      }, s => s.project.name === '04 Tool storage bar')
      const node = driver.page.locator('.fixed-stock-node').last()
      for (const [label, axis, value] of [['Pos X', 'x', -80], ['Pos Y', 'y', -25], ['Pos Z', 'z', -12]]) {
        await driver.step(`Place stock ${axis} at ${value}`, async () => {
          const input = node.locator('.stock-field-row').filter({ hasText: label }).locator('input')
          await input.fill(String(value)); await input.press('Enter')
        }, s => s.project.sceneStock.fixedStocks.at(-1).position[axis] === value)
      }
      await driver.importTools('examples/tools/starter-tools-metric.json')
      await specifyLongFluteMill(driver)
      await importDrawing(driver, 'top.svg')
      await driver.step('Assign top drawing to fixed stock', p => p.getByRole('button', { name: /^Stock 1/ }).click(), s => s.project.geometry.find(g => g.name === 'top')?.stockId === stock.id)
      await importDrawing(driver, 'bottom.svg')
      await driver.step('Assign bottom drawing to fixed stock', p => p.getByRole('button', { name: /^Stock 1/ }).click(), s => s.project.geometry.find(g => g.name === 'bottom')?.stockId === stock.id)
      await driver.step('Import original bar model', async page => {
        const chooser = page.waitForEvent('filechooser')
        await page.getByRole('button', { name: 'Import geometry', exact: true }).click()
        await (await chooser).setFiles(path.join(ROOT, PART, 'tool-storage-bar.stl'))
      }, s => s.project.geometry.some(g => g.name === 'tool-storage-bar' && g.format === 'stl'))
      await driver.step('Assign bar model to fixed stock', p => p.getByRole('button', { name: /^Stock 1/ }).click(), s => s.project.geometry.find(g => g.name === 'tool-storage-bar')?.stockId === stock.id)
      await driver.page.locator('.tree-geo-block').getByText('tool-storage-bar', { exact: true }).click()
      await driver.step('Place model within stock (top at Z0)', async page => {
        const group = page.locator('[data-group="geo-position"]').locator('..')
        if (!await group.locator('input').count()) await page.getByTestId('props-group-geo-position').click()
        const input = group.locator('.props-transform-cell').filter({ hasText: 'Z' }).locator('input')
        await input.fill('-12'); await input.press('Enter')
      }, s => s.project.geometry.find(g => g.name === 'tool-storage-bar')?.position.z === -12)
      for (const side of ['top', 'bottom']) {
        await driver.page.locator('.tree-geo-block').filter({ has: driver.page.getByText(side, { exact: true }) }).getByRole('button', { name: 'Hide all layers', exact: true }).click()
      }
      // Native wheel zoom tightens the real viewport's framing for the picture.
      await driver.page.mouse.move(1000, 540)
      await driver.page.mouse.wheel(0, -400)
      await driver.page.mouse.click(1450, 300)
      await driver.page.getByRole('button', { name: 'Toggle stock', exact: true }).click()
      await driver.page.getByRole('button', { name: 'Toggle grid', exact: true }).click()
      await driver.page.waitForTimeout(500)
      await driver.page.screenshot({ path: driver.output('model.png') })
      await driver.page.getByRole('button', { name: 'Toggle stock', exact: true }).click()
      await setup(driver, stock.id)
      for (const type of ['drill', 'bore', 'chamfer']) await operation(driver, 'top', type)
      await setup(driver, stock.id, true)
      await operation(driver, 'bottom', 'chamfer')
      await addWorkholding(driver)
      await computeAll(driver, 'Built project')
      await driver.page.getByTestId('tree-name-setup').getByText('Top - G54', { exact: true }).click()
      await frameHolding(driver.page)
      await driver.page.getByTestId('mode-tab-toolpath').click()
      await driver.page.screenshot({ path: driver.output('toolpaths.png') })
      const saved = await driver.saveAndReopen('tool-storage-bar.camproject')
      copyFileSync(path.join(ROOT, EVIDENCE, 'tool-storage-bar.camproject'), path.join(ROOT, PART, 'tool-storage-bar.camproject'))
      await driver.page.setViewportSize({ width: 1920, height: 1080 })
      observe(driver.page)
      const readyState = await computeAll(driver, 'Reopened project')
      assert.deepEqual(readyState.project.workholding, saved.workholding)
      for (const [index, setup] of readyState.project.setups.entries()) {
        assert.equal(setup.holdingMethod, 'clamps')
        assert.match(setup.notes, /flip end-for-end about Y/)
        assert.deepEqual(setup.wcs, saved.setups[index].wcs)
      }
      await driver.page.screenshot({ path: driver.output('reopened.png') })
      copyFileSync(path.join(ROOT, EVIDENCE, 'reopened.png'), path.join(ROOT, PART, 'reopened.png'))
      writeFileSync(driver.output('readback.json'), JSON.stringify(readyState, null, 2))
      const programs = await postAll(driver)
      const simulations = await simulate(driver)
      copyFileSync(path.join(driver.outDir, 'simulation-2-end.png'), path.join(ROOT, PART, 'simulation-end.png'))
      copyFileSync(path.join(driver.outDir, 'toolpaths.png'), path.join(ROOT, PART, 'toolpaths.png'))
      copyFileSync(path.join(driver.outDir, 'simulation-2-end.png'), driver.output('simulation-end.png'))
      const state = await driver.readState()
      const errors = state.consoleEvents?.filter(event => event.severity === 'error') ?? []
      assert.equal(errors.length, 0, JSON.stringify(errors))
      assert.equal(consoleLines.filter(line => /^(error|pageerror):/.test(line)).length, 0, consoleLines.join('\n'))
      writeFileSync(driver.output('verification.json'), JSON.stringify({ programs, simulations, errors }, null, 2))
      return saved
    } catch (error) {
      writeFileSync(driver.output('debug-state.json'), JSON.stringify(await driver.readState(), null, 2))
      writeFileSync(driver.output('debug-ui.txt'), await driver.page.locator('body').innerText())
      throw error
    } finally {
      writeFileSync(driver.output('console.txt'), consoleLines.join('\n') + '\n')
    }
  })
}

// Re-shoot a committed project without re-authoring its geometry or plan.
// Open, regenerate and Cut Stock still go through the production controls.
async function captureSaved() {
  return withExampleDriver({ outDir: `${EVIDENCE}/capture` }, async driver => {
    const saved = JSON.parse(readFileSync(path.join(ROOT, PART, 'tool-storage-bar.camproject'), 'utf8'))
    await driver.page.setViewportSize({ width: 1920, height: 1080 })
    await driver.step('Open the committed tool storage bar', async page => {
      const chooser = page.waitForEvent('filechooser')
      await page.getByRole('button', { name: 'Open project', exact: true }).click()
      await (await chooser).setFiles(path.join(ROOT, PART, 'tool-storage-bar.camproject'))
    }, s => s.project.id === saved.id)
    await computeAll(driver, 'Capture project')
    await driver.page.getByTestId('tree-name-setup').getByText('Top - G54', { exact: true }).click()
    await driver.page.getByTestId('mode-tab-toolpath').click()
    await driver.page.getByRole('button', { name: 'Toggle grid', exact: true }).click()
    await frameHolding(driver.page)
    await driver.page.screenshot({ path: driver.output('toolpaths.png') })
    const simulations = await simulate(driver)
    writeFileSync(driver.output('verification.json'), JSON.stringify({ projectId: saved.id, simulations }, null, 2))
    for (const [source, target] of [['toolpaths.png', 'toolpaths.png'], ['simulation-2-end.png', 'simulation-end.png']]) {
      copyFileSync(path.join(driver.outDir, source), path.join(ROOT, PART, target))
      copyFileSync(path.join(driver.outDir, source), path.join(ROOT, EVIDENCE, target))
    }
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--capture-saved')) await captureSaved()
  else if (process.argv.includes('--negative-control')) {
    // Deliberately demand a wrong readback from the real app. Keep this run in
    // its own evidence directory, preserving the successful example artifacts.
    await withExampleDriver({ outDir: `${EVIDENCE}/negative-control` }, async driver => {
      await driver.newProject()
      await driver.setStock({ width: 160, height: 50, depth: 12 }, { expectedWidth: 161 })
    })
  } else await buildToolStorageBar()
}
