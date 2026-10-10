// Small, named moves through LienCAM's own UI that several steps share.
import { waitUntil } from './harness.mjs'

/** The CAM workspace's one-line console (the Model workspace has its own). */
export function camConsole(page) {
  return page.getByTestId('cam-workspace-host').getByTestId('console-strip')
}

export function modelConsole(page) {
  return page.getByTestId('solids-workbench-root').getByTestId('console-strip')
}

/**
 * The app asks "Choose a machine for this project" whenever a project is not
 * bound to one of the operator's machines. A person answers it with the
 * button, so the journey does too - and says so in the log.
 */
/**
 * The desktop app offers "Try an example" when it starts on an empty project
 * (WO-2532). The journey builds its own part, so it answers as a new user
 * who wants to start from scratch would: "Start with an empty project".
 */
export async function startEmptyIfOffered(journey, { timeout = 500 } = {}) {
  const page = journey.page
  const button = page.getByRole('button', { name: /^Start with an empty project$/ })
  try {
    await button.first().waitFor({ state: 'visible', timeout })
  } catch {
    return false
  }
  journey.log('TRY-AN-EXAMPLE answered: Start with an empty project')
  await button.first().click()
  await button.first().waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {})
  return true
}

/**
 * New and Open ask "Save changes to ...?" (Save / Discard / Cancel) when the
 * open project is not saved to a file (WO-2698, WO-2704). The journey has
 * nothing to keep at those points, so it answers Discard, as a person would.
 */
export async function discardIfAsked(journey, { timeout = 2_000 } = {}) {
  const page = journey.page
  const discard = page.getByTestId('confirm-dialog-alt')
  try {
    await discard.waitFor({ state: 'visible', timeout })
  } catch {
    return false
  }
  const text = await page.getByTestId('confirm-dialog').innerText().catch(() => '')
  journey.log(`SAVE-CHANGES question answered Discard: ${text.replace(/\s+/g, ' ').slice(0, 200)}`)
  await discard.click()
  await discard.waitFor({ state: 'detached', timeout: 5_000 }).catch(() => {})
  return true
}

export async function answerMachineChoice(journey, { timeout = 1_500 } = {}) {
  const page = journey.page
  await startEmptyIfOffered(journey)
  const button = page.getByRole('button', { name: /^use this machine$/i })
  try {
    await button.first().waitFor({ state: 'visible', timeout })
  } catch {
    return false
  }
  const text = await page.locator('.modal-backdrop').filter({ has: button }).first().innerText().catch(() => '')
  journey.log(`MACHINE-CHOICE modal answered: ${text.replace(/\s+/g, ' ').slice(0, 200)}`)
  await button.first().click()
  await button.first().waitFor({ state: 'detached', timeout: 5_000 }).catch(() => {})
  return true
}

export async function openSettings(page) {
  if (!(await page.getByTestId('settings-modal-panel').count())) {
    await page.getByRole('button', { name: 'Application settings' }).click()
  }
  await page.getByTestId('settings-modal-panel').waitFor()
  return page.getByTestId('settings-modal-panel')
}

export async function closeSettings(page) {
  await page.getByTestId('settings-modal-panel').getByRole('button', { name: 'Done' }).click()
  await page.getByTestId('settings-modal-panel').waitFor({ state: 'detached' })
}

/** Pick an option in one of the Settings pickers (a button that opens a list). */
export async function choosePicker(page, testId, optionValue) {
  await page.getByTestId(testId).click()
  await page.getByTestId(`${testId}-option-${optionValue}`).click()
  await page.waitForTimeout(250)
}

export async function openMachineLibrary(page) {
  await page.getByTestId('mode-tab-setup').click()
  await page.locator('.viewport-machine-info').first().click()
  const panel = page.getByTestId('machine-modal-panel')
  await panel.waitFor()
  return panel
}

export async function closeMachineLibrary(page) {
  const panel = page.getByTestId('machine-modal-panel')
  await panel.locator('.modal-close-btn').first().click()
  await panel.waitFor({ state: 'detached' })
}

export async function openToolLibrary(page) {
  await page.getByTestId('mode-tab-toollibrary').click()
  const scope = page.locator('.modal-backdrop').filter({ has: page.getByTestId('tool-view-tools') })
  await scope.waitFor()
  return scope
}

export async function closeToolLibrary(page) {
  const scope = page.locator('.modal-backdrop').filter({ has: page.getByTestId('tool-view-tools') })
  await scope.locator('.modal-close-btn').first().click()
  await scope.waitFor({ state: 'detached', timeout: 10_000 })
}

export async function openControlMachineDefinition(page) {
  await page.getByTestId('mode-tab-control').click()
  await page.getByTestId('control-view-machine').click()
  await page.getByTestId('control-machine-tab-definition').click()
  await page.getByTestId('machine-definition-panel').waitFor()
  return page.getByTestId('machine-definition-panel')
}

/** Import a file through the Geometry section's Import button (the OS file dialog answers with `file`). */
export async function importGeometry(journey, file) {
  const page = journey.page
  await page.getByTestId('mode-tab-setup').click()
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 10_000 }),
    page.getByRole('button', { name: 'Import geometry' }).click(),
  ])
  journey.log(`FILE-DIALOG answer ${file}`)
  await chooser.setFiles(file)
  await page.waitForTimeout(1_000)
  await page.getByTestId('geometry-section').filter({ hasText: 'Importing' })
    .waitFor({ state: 'detached', timeout: 180_000 })
  await answerMachineChoice(journey, { timeout: 500 })
}

export async function geometryNames(page) {
  return (await page.getByTestId('tree-name-geometry').allInnerTexts()).map((s) => s.trim())
}

export async function waitForConsole(page, pattern, { timeout = 60_000, locator } = {}) {
  const strip = locator ?? camConsole(page)
  return waitUntil(async () => {
    const text = await strip.innerText()
    return pattern.test(text) ? text : null
  }, { timeout, what: `console to say ${pattern}` })
}

/**
 * A step that failed part-way can leave a dialog open. Close it the way a
 * person would (its X button) so the next step starts from the app itself.
 */
export async function closeLeftoverDialogs(journey) {
  const page = journey.page
  if (!page) return
  for (let i = 0; i < 4; i++) {
    const backdrop = page.locator('.modal-backdrop').first()
    if (!(await backdrop.isVisible().catch(() => false))) return
    const title = (await backdrop.innerText().catch(() => '')).split('\n')[0]
    journey.log(`LEFTOVER dialog closed: ${title}`)
    const close = backdrop.locator('.modal-close-btn').first()
    if (await close.isVisible().catch(() => false)) await close.click().catch(() => {})
    else await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
  }
}

/**
 * Open the Model workspace on the project's model and come back with Finish -
 * what the app's own OP_MODEL_REFS_UNVERIFIED message tells the operator to do.
 */
export async function revisitModel(journey) {
  const page = journey.page
  await page.getByTestId('mode-tab-part').click()
  await page.getByTestId('solids-workbench-root').waitFor({ timeout: 60_000 })
  await waitUntil(async () => /model: ok/i.test(await page.getByTestId('workbench-status-strip').innerText().catch(() => ''))
    && !/\b0 bodies\b/.test(await page.getByTestId('workbench-status-strip').innerText().catch(() => '0 bodies')),
  { timeout: 120_000, what: 'the model to load in the Model workspace' })
  journey.log(`MODEL revisited: ${(await page.getByTestId('workbench-status-strip').innerText()).replace(/\s+/g, ' ')}`)
  await page.getByTestId('model-item-finish-btn').click()
  await page.getByTestId('cam-workspace-host').waitFor({ timeout: 60_000 })
  await page.waitForTimeout(1_000)
}
