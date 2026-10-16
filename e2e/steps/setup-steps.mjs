// Steps 1-3: a new PC's first launch, the operator's settings and machine, the tool library.
import { assert, formRow, waitUntil } from '../lib/harness.mjs'
import {
  answerMachineChoice, choosePicker, closeMachineLibrary, closeSettings, closeToolLibrary,
  openControlMachineDefinition, openMachineLibrary, openSettings, openToolLibrary, startEmptyIfOffered,
} from '../lib/app.mjs'

export const MACHINE = {
  name: 'Journey Router',
  travel: { X: 610, Y: 450, Z: 120 },
  maxRpm: 24000,
  minRpm: 6000,
  rapid: 6000,
  toolChanger: 'manual',
  safeZ: -5,
}

export const TOOLS = [
  { name: 'Journey 6mm end mill', type: 'flat_end_mill', diameter: 6, lengths: { 'Overall length': 75, 'Flute length (from tip)': 32, 'Length below holder': 40 } },
  { name: 'Journey 5mm drill', type: 'drill', diameter: 5 },
  { name: 'Journey 90deg V-bit', type: 'v_bit', diameter: 12 },
]

/** STEP 1 - the app opens on an empty profile and shows nothing left over. */
export async function firstLaunch(journey) {
  const page = journey.page
  // A first start offers the examples (WO-2532); a new user may start empty.
  assert(await startEmptyIfOffered(journey, { timeout: 30_000 }), 'a first start offered neither the "Open a project" picker nor "Try an example"')
  await answerMachineChoice(journey)
  const project = await page.getByTestId('tree-name-project').innerText()
  assert(/untitled/i.test(project), `a fresh profile opened project "${project}", not an untitled one`)
  const geometry = await page.getByTestId('geometry-section').innerText()
  assert(/GEOMETRY\s*0/.test(geometry), `a fresh profile already has geometry: ${geometry.slice(0, 120)}`)
  const settings = await openSettings(page)
  const inventory = await settings.getByTestId('user-data-inventory').innerText()
  journey.log(`USER-DATA ${inventory.replace(/\s+/g, ' ')}`)
  for (const row of ['active-project', 'tool-libraries', 'post-profiles']) {
    const text = await settings.getByTestId(`user-data-row-${row}`).innerText()
    assert(/\b0 items\b/.test(text), `fresh profile: "${text.replace(/\s+/g, ' ')}" is not empty`)
  }
  journey.log(`VERSION ${await settings.getByTestId('settings-app-version').innerText()} build ${await settings.getByTestId('settings-build-info').innerText()}`)
  await closeSettings(page)
}

/** STEP 2a - Settings: units and theme, read back from the status bar and the pickers. */
export async function chooseSettings(journey) {
  const page = journey.page
  await openSettings(page)
  await choosePicker(page, 'settings-display-units', 'inch')
  await closeSettings(page)
  await waitUntil(async () => /Units:\s*in\b/.test(await page.locator('.status-bar, footer').last().innerText().catch(() => '')) || /Units:\s*in\b/.test(await page.locator('body').innerText()),
    { what: 'the status bar to show inches', timeout: 5_000 })
  await openSettings(page)
  await choosePicker(page, 'settings-display-units', 'mm')
  await choosePicker(page, 'settings-theme', 'amber')
  const theme = await page.getByTestId('settings-theme').innerText()
  assert(/amber/i.test(theme), `theme picker reads "${theme}" after choosing Amber`)
  await journey.shot('step-02a-settings-amber')
  await choosePicker(page, 'settings-theme', 'default')
  await closeSettings(page)
  await waitUntil(async () => /Units:\s*mm\b/.test(await page.locator('body').innerText()),
    { what: 'the status bar to show mm', timeout: 5_000 })
}

/** STEP 2b - define a machine from scratch in the Machine Library and the Control page's definition. */
export async function defineMachine(journey) {
  const page = journey.page
  const panel = await openMachineLibrary(page)
  await panel.getByRole('button', { name: 'New', exact: true }).click()
  await page.waitForTimeout(500)
  await answerMachineChoice(journey)
  await formRow(panel, 'Name').fill(MACHINE.name)
  await formRow(panel, 'Controller').selectOption('grbl')
  for (const id of ['travel', 'spindle', 'feeds']) {
    const header = page.getByTestId(`disclosure-machine-${id}`)
    if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click()
  }
  const xyz = panel.locator('.mform-xyz-cell input')
  await xyz.nth(0).fill(String(MACHINE.travel.X))
  await xyz.nth(1).fill(String(MACHINE.travel.Y))
  await xyz.nth(2).fill(String(MACHINE.travel.Z))
  await formRow(panel, 'Max RPM').fill(String(MACHINE.maxRpm))
  await formRow(panel, 'Min RPM').fill(String(MACHINE.minRpm))
  await formRow(panel, 'Rapid / fast-traverse max (mm/min)').fill(String(MACHINE.rapid))
  await formRow(panel, 'Tool changer').selectOption(MACHINE.toolChanger)
  await formRow(panel, 'Name').click()
  await panel.getByRole('button', { name: 'Save Changes' }).click()
  await page.waitForTimeout(400)
  await panel.getByRole('button', { name: 'Set as Default' }).click()
  await page.waitForTimeout(400)
  const use = panel.getByRole('button', { name: /Use for this project|Active machine/ })
  if (/Use for this project/.test(await use.innerText())) await use.click()
  await page.waitForTimeout(400)
  const list = await panel.innerText()
  assert(list.includes(MACHINE.name), `the Machine Library does not list "${MACHINE.name}" after Save Changes`)
  await journey.shot('step-02b-machine-library')
  await closeMachineLibrary(page)

  // The control half: axes, homing, soft limits and safe Z live in the Control page's definition.
  const def = await openControlMachineDefinition(page)
  const defineButton = page.getByTestId('machine-def-panel-define')
  if (await defineButton.count()) await defineButton.click()
  await page.getByTestId('machine-def-tab-machine').click()
  await page.getByLabel('X soft limit minimum').waitFor()
  // Record what the definition started from, so a mismatch with the library is visible in the log.
  const started = {}
  for (const axis of ['X', 'Y', 'Z']) {
    started[axis] = {
      min: await page.getByLabel(`${axis} soft limit minimum`).inputValue(),
      max: await page.getByLabel(`${axis} soft limit maximum`).inputValue(),
      home: await page.getByLabel(`${axis} homing direction`).inputValue(),
    }
  }
  journey.log(`DEFINITION started from ${JSON.stringify(started)}`)
  if (started.X.min === started.X.max) {
    journey.note(`Control > Machine > Definition started with X travel ${started.X.min}..${started.X.max} although the Machine Library says X ${MACHINE.travel.X}; the operator types the travel a second time.`)
  }
  for (const [axis, travel] of Object.entries(MACHINE.travel)) {
    await page.getByLabel(`${axis} soft limit minimum`).fill(String(-travel))
    await page.getByLabel(`${axis} soft limit maximum`).fill('0')
    await page.getByLabel(`${axis} homing direction`).selectOption('positive')
  }
  await page.getByLabel('Safe Z').fill(String(MACHINE.safeZ))
  await page.getByLabel('Safe Z').press('Tab')
  await page.getByTestId('machine-def-panel-save').click()
  await waitUntil(async () => page.getByTestId('machine-def-panel-revert').isDisabled(), { what: 'the definition to save (Revert greys out)', timeout: 10_000 })
  await page.getByTestId('machine-def-tab-overview').click()
  const overview = await def.getByTestId('machine-def-overview-card-machine').innerText()
  journey.log(`DEFINITION overview ${overview.replace(/\s+/g, ' ')}`)
  assert(overview.includes(`X ${MACHINE.travel.X} x Y ${MACHINE.travel.Y} x Z ${MACHINE.travel.Z}`), `definition overview does not show the travel typed: ${overview.replace(/\s+/g, ' ')}`)
}

/** STEP 2c - after a restart on the same profile, the machine is still there. */
export async function machineSurvivesRestart(journey) {
  const page = journey.page
  await answerMachineChoice(journey)
  const chip = await page.locator('.viewport-machine-info').first().innerText()
  assert(chip.includes(MACHINE.name), `after restart the project's machine is "${chip.replace(/\s+/g, ' ')}", not ${MACHINE.name}`)
  const panel = await openMachineLibrary(page)
  await panel.getByText(MACHINE.name, { exact: true }).first().click()
  await page.getByTestId('disclosure-machine-travel').click()
  const xyz = panel.locator('.mform-xyz-cell input')
  const travel = [await xyz.nth(0).inputValue(), await xyz.nth(1).inputValue(), await xyz.nth(2).inputValue()]
  assert(travel.join('/') === `${MACHINE.travel.X}/${MACHINE.travel.Y}/${MACHINE.travel.Z}`, `after restart the library travel is ${travel.join('/')}`)
  await closeMachineLibrary(page)
  await openControlMachineDefinition(page)
  await page.getByTestId('machine-def-tab-machine').click()
  const safeZ = await page.getByLabel('Safe Z').inputValue()
  assert(Number(safeZ) === MACHINE.safeZ, `after restart Safe Z reads "${safeZ}", not ${MACHINE.safeZ}`)
  const xmin = await page.getByLabel('X soft limit minimum').inputValue()
  assert(Number(xmin) === -MACHINE.travel.X, `after restart X soft limit minimum reads "${xmin}"`)
  await page.getByTestId('mode-tab-setup').click()
}

/** STEP 3 - Tool Library: an end mill, a drill and a V-bit, saved and still there on reopen. */
export async function buildToolLibrary(journey) {
  const page = journey.page
  let scope = await openToolLibrary(page)
  for (const [index, tool] of TOOLS.entries()) {
    await scope.getByRole('button', { name: 'New', exact: true }).click()
    await page.waitForTimeout(400)
    await scope.getByRole('button', { name: 'General', exact: true }).click()
    await formRow(scope, 'Name').fill(tool.name)
    await formRow(scope, 'Type').selectOption(tool.type)
    await scope.getByRole('button', { name: 'Cutter', exact: true }).click()
    await formRow(scope, 'Diameter').fill(String(tool.diameter))
    for (const [label, value] of Object.entries(tool.lengths ?? {})) await formRow(scope, label).fill(String(value))
    await scope.getByRole('button', { name: 'Save Changes' }).click()
    await page.waitForTimeout(500)
    assert((await scope.innerText()).includes(tool.name), `tool ${index + 1} "${tool.name}" is not in the list after Save Changes`)
  }
  await journey.scene('tool-library')
  await closeToolLibrary(page)
  scope = await openToolLibrary(page)
  const text = await scope.innerText()
  for (const tool of TOOLS) assert(text.includes(tool.name), `"${tool.name}" is gone after closing and reopening the Tool Library`)
  assert(/My Tools \(3\)/.test(text), `the library count is not 3: ${(text.match(/My Tools \(\d+\)/) ?? ['?'])[0]}`)
  await journey.shot('step-03-tool-library-reopened')
  await closeToolLibrary(page)
}
