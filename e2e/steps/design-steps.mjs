// Step 4: a part drawn in Sketch and built in Model, and the three import routes.
import path from 'node:path'
import { assert, clickAt, inputAfterLabel, waitUntil } from '../lib/harness.mjs'
import { answerMachineChoice, camConsole, discardIfAsked, geometryNames, importGeometry, modelConsole, waitForConsole } from '../lib/app.mjs'

// The drawn part: a 100 x 60 plate with a 20 mm hole, extruded 15, plus a 6 x 5 blind hole.
export const PLATE = { width: 100, height: 60, circle: 20, thickness: 15, hole: { diameter: 6, depth: 5 } }
export const PLATE_VOLUME = PLATE.width * PLATE.height * PLATE.thickness - Math.PI * (PLATE.circle / 2) ** 2 * PLATE.thickness
export const HOLED_VOLUME = PLATE_VOLUME - Math.PI * (PLATE.hole.diameter / 2) ** 2 * PLATE.hole.depth

export const IMPORTS = [
  { file: 'fix_freeform.step', name: 'fix_freeform', kind: 'STEP' },
  { file: 'Contour-Test-A-InsideCorner-Notch.dxf', name: 'Contour-Test-A-InsideCorner-Notch', kind: 'DXF' },
  { file: 'Leadscrew_Stepper_Mount.svg', name: 'Leadscrew_Stepper_Mount', kind: 'SVG' },
]

async function camCanvasBox(page) {
  const box = await page.getByTestId('cam-workspace-host').locator('canvas:not(.view-cube-canvas)').first().boundingBox()
  assert(box, 'the CAM viewport canvas is not on screen')
  return box
}

/** Type a value into the sketch's dimension box, which opens after a dimension is placed. */
async function typeDimension(page, value) {
  const input = page.locator('.sketch-dim-input')
  await input.waitFor({ timeout: 5_000 })
  const before = Number(await input.inputValue())
  await input.fill(String(value))
  await input.press('Enter')
  await input.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => {})
  await page.waitForTimeout(400)
  return before
}

async function dofChip(page) {
  return (await page.getByTestId('cam-sketch-dof-chip').innerText()).trim()
}

/** STEP 4a - New project, then Sketch: a circle and a rectangle, each dimensioned. */
export async function sketchPart(journey) {
  const page = journey.page
  await page.getByRole('button', { name: 'New project' }).click()
  await discardIfAsked(journey)
  await page.waitForTimeout(1_000)
  await answerMachineChoice(journey)
  assert(/GEOMETRY\s*0/.test(await page.getByTestId('geometry-section').innerText()), 'New project did not start empty')
  await page.getByTestId('mode-tab-sketch').click()
  const newSketch = page.getByRole('button', { name: 'New sketch' })
  await newSketch.waitFor({ timeout: 5_000 }).catch(async () => {
    journey.note('The first click on the Sketch tab did not open the new-sketch choice; clicked it again.')
    await page.getByTestId('mode-tab-sketch').click()
    await newSketch.waitFor({ timeout: 5_000 })
  })
  await newSketch.click()
  await page.getByTestId('cam-sketch-dof-chip').waitFor({ timeout: 15_000 })
  await page.waitForTimeout(800)
  // The hint card over the canvas would catch clicks meant for the sketch.
  const hintClose = page.getByTestId('cam-workspace-host').locator('[class*=hint] button, [class*=shortcut] button').first()
  if (await hintClose.isVisible().catch(() => false)) await hintClose.click().catch(() => {})

  const box = await camCanvasBox(page)
  const cx = box.x + box.width / 2 // the new sketch opens centred on its origin
  const cy = box.y + box.height / 2
  // A first guess at the zoom; the circle's dimension box reports the truth, and every later pick uses it.
  let s = box.height / 500
  const px = (mmX, mmY) => [cx + mmX * s, cy - mmY * s]

  // Circle: centre (-25, 0), radius drawn about 10 mm.
  await page.getByRole('button', { name: 'Circle', exact: true }).click()
  await clickAt(page, ...px(-25, 0))
  await clickAt(page, ...px(-15, 0))
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: 'Smart Dim.' }).click()
  await clickAt(page, ...px(-25, 10))
  await clickAt(page, ...px(-25 - 30, 25))
  const drawnDiameter = await typeDimension(page, PLATE.circle)
  assert(drawnDiameter > 0, 'the circle dimension box opened without a value')
  s = s * 20 / drawnDiameter // the circle was drawn 20 px-at-the-guess wide
  journey.log(`SKETCH zoom ${s.toFixed(4)} px/mm (circle drawn ${drawnDiameter.toFixed(3)} mm)`)

  // Rectangle: corners (-50, -30) and (50, 30) at the measured zoom.
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Rectangle', exact: true }).click()
  await clickAt(page, ...px(-50, -30))
  await clickAt(page, ...px(50, 30))
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: 'Smart Dim.' }).click()
  await clickAt(page, ...px(25, 30))
  await clickAt(page, ...px(25, 30 + 22))
  const drawnWidth = await typeDimension(page, PLATE.width)
  await clickAt(page, ...px(-50, -12))
  await clickAt(page, ...px(-50 - 22, -12))
  const drawnHeight = await typeDimension(page, PLATE.height)
  journey.log(`SKETCH rectangle drawn ${drawnWidth} x ${drawnHeight}, dimensioned ${PLATE.width} x ${PLATE.height}`)
  await page.keyboard.press('Escape')
  const dof = await dofChip(page)
  journey.log(`SKETCH ${dof}`)
  await journey.scene('sketch')
  await journey.shot('step-04a-sketch')
  // The sketch header's Finish (WO-2450 made it compact: the button reads "Finish").
  await page.locator('.sketch-finish-btn').click()
  const said = await waitForConsole(page, /Sketch baked to layer/)
  assert(/2 loops \(2 closed\)/.test(said), `finishing the sketch reported "${said}", not 2 closed loops`)
}

/** STEP 4b - Model: convert the sketch, extrude it, add a hole; the body's volume proves every dimension. */
export async function modelPart(journey) {
  const page = journey.page
  await page.getByTestId('mode-tab-setup').click()
  await page.locator('[data-testid^=layer-convert-model-]').first().click()
  const confirm = page.getByTestId('confirm-dialog-confirm')
  if (await confirm.isVisible({ timeout: 3_000 }).catch(() => false)) await confirm.click()
  await page.getByTestId('workbench-extrude').waitFor({ timeout: 60_000 })
  await waitUntil(() => page.getByTestId('workbench-extrude').isEnabled(), { what: 'Extrude to be available', timeout: 30_000 })
  const extrude = page.locator('div').filter({ has: page.getByText('Extrude', { exact: true }) }).filter({ has: page.getByRole('button', { name: 'Apply', exact: true }) }).last()
  const apply = extrude.getByRole('button', { name: 'Apply', exact: true })
  // What a person does when Apply stays grey: wait, type the distance again, then close the
  // panel and open Extrude again. Each try is recorded; three greyed tries fail the step.
  let refusal = ''
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.getByTestId('workbench-extrude').click()
    await extrude.waitFor({ timeout: 15_000 })
    const distance = inputAfterLabel(extrude, 'Distance')
    await distance.fill(String(PLATE.thickness))
    if (await waitUntil(() => apply.isEnabled(), { timeout: 15_000, what: 'Extrude Apply' }).then(() => true, () => false)) break
    const said = (await extrude.innerText()).replace(/\s+/g, ' ')
    refusal = (said.match(/Extrude preview refused.*?(?=Cancel|$)/) ?? [said.slice(-160)])[0].trim()
    journey.note(`Extrude try ${attempt}: Apply stayed greyed for 15 s - "${refusal}".`)
    await distance.fill(String(PLATE.thickness + 1))
    await page.waitForTimeout(500)
    await distance.fill(String(PLATE.thickness))
    if (await waitUntil(() => apply.isEnabled(), { timeout: 15_000, what: 'Extrude Apply' }).then(() => true, () => false)) break
    if (attempt === 3) throw new Error(`Extrude never became applicable after three tries: ${refusal}`)
    await extrude.getByRole('button', { name: 'Cancel', exact: true }).click()
    await extrude.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {})
    await page.waitForTimeout(10_000)
  }
  await apply.click()
  await waitForConsole(page, /Extrude F1 applied/, { locator: modelConsole(page), timeout: 60_000 })
  const volume = await readBodyVolume(page)
  journey.log(`MODEL Extrude F1 volume ${volume}`)
  assert(Math.abs(volume - PLATE_VOLUME) < 0.05, `the extruded plate is ${volume} mm^3; 100 x 60 x 15 less the 20 mm hole is ${PLATE_VOLUME.toFixed(2)}`)

  await page.getByTestId('workbench-hole').click()
  const canvas = await page.getByTestId('solids-workbench-canvas').boundingBox()
  assert(canvas, 'the Model canvas is not on screen')
  // Pick the plate's top face to the right of the drawn hole; try a few points near there.
  const hole = page.locator('div').filter({ has: page.getByText('Hole', { exact: true }) }).filter({ has: page.getByRole('button', { name: 'Apply', exact: true }) }).last()
  let picked = false
  for (const [fx, fy] of [[0.64, 0.46], [0.6, 0.44], [0.68, 0.48], [0.56, 0.5], [0.62, 0.52]]) {
    await clickAt(page, canvas.x + canvas.width * fx, canvas.y + canvas.height * fy)
    if (await hole.isVisible({ timeout: 1_500 }).catch(() => false)) { picked = true; break }
  }
  assert(picked, 'clicking the plate top face did not open the Hole panel')
  await inputAfterLabel(hole, 'Diameter').fill(String(PLATE.hole.diameter))
  await inputAfterLabel(hole, 'Depth (mm)').fill(String(PLATE.hole.depth))
  const holeApply = hole.getByRole('button', { name: 'Apply', exact: true })
  await waitUntil(() => holeApply.isEnabled(), { timeout: 60_000, what: 'Hole Apply' }).catch(async () => {
    throw new Error(`Hole never became applicable: ${(await hole.innerText()).replace(/\s+/g, ' ').slice(-200)}`)
  })
  await holeApply.click()
  await waitForConsole(page, /Hole F2 applied/, { locator: modelConsole(page), timeout: 60_000 })
  const holed = await readBodyVolume(page)
  journey.log(`MODEL after Hole F2 volume ${holed}`)
  assert(Math.abs(holed - HOLED_VOLUME) < 0.05, `after the 6 x 5 hole the body is ${holed} mm^3; expected ${HOLED_VOLUME.toFixed(2)}`)
  await journey.scene('model')
  await journey.shot('step-04b-model')
  await page.getByTestId('model-item-finish-btn').click()
  await page.getByTestId('cam-workspace-host').waitFor()
  await waitUntil(async () => (await geometryNames(page)).some((n) => /Extrude F1/.test(n)), { what: 'the modelled body to appear in the CAM geometry list' })
}

async function readBodyVolume(page) {
  // The one body's row; its id follows the latest feature (F1, then F2 after the hole).
  const text = await page.locator('[data-testid^="body-volume-"]').first().innerText()
  return Number(text.replace(/[^0-9.]/g, ''))
}

/** STEP 4c - the import route: a STEP, a DXF and an SVG from Sample Parts. */
export async function importParts(journey, samplesDir) {
  const page = journey.page
  for (const part of IMPORTS) {
    await importGeometry(journey, path.join(samplesDir, part.file))
    const said = await camConsole(page).innerText()
    journey.log(`IMPORT ${part.file}: ${said}`)
    const names = await geometryNames(page)
    assert(names.includes(part.name), `after importing ${part.file} the geometry list is [${names.join(', ')}]`)
  }
  await journey.shot('step-04c-imports')
}
