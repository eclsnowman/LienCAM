// Step 5: stock, a setup with its work offset, six operations, generate all.
import { assert, waitUntil } from '../lib/harness.mjs'
import { camConsole } from '../lib/app.mjs'

export const STOCK = { offsetXY: 5, offsetTop: 1 }

// Each operation: its card in the New Operation dialog, its tool, its source, and any
// choice the dialog needs before it will create.
export const OPERATIONS = [
  { name: 'Journey Face', type: '2D Face', tool: 'Journey 6mm end mill', face: { targetWcs: -1 } },
  { name: 'Journey Adaptive', type: '2D Adaptive Clearing', tool: 'Journey 6mm end mill', source: 'Extrude F1' },
  { name: 'Journey Contour', type: '2D Contour', tool: 'Journey 6mm end mill', source: 'Extrude F1' },
  { name: 'Journey Drill', type: 'Drill', tool: 'Journey 5mm drill', source: 'Extrude F1', detectHoles: true },
  { name: 'Journey Pocket', type: '2D Pocket', tool: 'Journey 6mm end mill', source: 'Contour-Test-A-InsideCorner-Notch' },
  { name: 'Journey 3D Finish', type: 'Parallel Finish (3D)', tool: 'Journey 6mm end mill', source: 'fix_freeform' },
]

async function setStock(journey) {
  const page = journey.page
  await page.getByTestId('mode-tab-setup').click()
  await page.getByTestId('tree-name-stock-auto').first().click()
  const xy = page.getByLabel('Offset XY (mm)')
  await xy.waitFor({ timeout: 10_000 })
  await xy.fill(String(STOCK.offsetXY))
  await xy.press('Tab')
  const top = page.getByLabel('Offset Z top (mm)')
  await top.fill(String(STOCK.offsetTop))
  await top.press('Tab')
  await page.waitForTimeout(500)
  assert(Number(await page.getByLabel('Offset Z top (mm)').inputValue()) === STOCK.offsetTop, 'the auto stock Z-top offset did not keep the value typed')
}

async function createSetup(journey) {
  const page = journey.page
  await page.getByRole('button', { name: 'Add setup' }).first().click()
  const m = page.getByTestId('setup-modal-panel')
  await m.waitFor()
  const stockSelect = m.locator('select').filter({ has: page.locator('option', { hasText: 'Auto Stock 1' }) }).first()
  await stockSelect.selectOption({ label: 'Auto Stock 1 (auto)' })
  await m.getByRole('button', { name: 'Top (Z+)' }).click()
  await m.getByRole('button', { name: 'Front Left' }).click()
  await m.getByTestId('stock-work-offset-select').selectOption('54')
  await journey.scene('setup')
  await journey.shot('step-05a-setup-dialog')
  await m.getByRole('button', { name: 'Create Setup' }).click()
  await m.waitFor({ state: 'detached' })
  await page.getByTestId('tree-name-setup').first().click()
  const origin = await page.getByTestId('setup-wcs-origin-bound').innerText({ timeout: 10_000 }).catch(() => '(not shown)')
  journey.log(`SETUP 1 origin ${origin}`)
  assert((await page.getByTestId('tree-name-setup').allInnerTexts()).some((n) => /Setup 1/.test(n)), 'Setup 1 is not in the tree after Create Setup')
}

export async function createOperation(journey, op) {
  const page = journey.page
  await page.getByTestId('mode-tab-toolpath').click()
  await page.getByRole('button', { name: 'Add operation' }).first().click()
  const m = page.getByTestId('op-modal-panel')
  await m.waitFor()
  await m.getByText(op.type, { exact: true }).click()
  const nameBox = m.locator('input').last()
  await nameBox.fill(op.name)
  await m.getByRole('button', { name: 'Tool', exact: true }).click()
  await m.getByText(op.tool, { exact: true }).click()
  await m.getByRole('button', { name: 'Geometry', exact: true }).click()
  if (op.face) {
    await m.getByRole('button', { name: 'Stock', exact: true }).click()
    // The Face card will not create until the finished surface is chosen; that choice sits
    // under Heights > Bottom Height, and the greyed button says nothing about it.
    const create = page.getByTestId('op-create')
    if (await create.isDisabled()) {
      journey.note(`New Operation / 2D Face: Create Operation stays greyed with no tooltip until Heights > Bottom Height is expanded and "Finished face" is chosen (tooltip: ${await create.getAttribute('data-tooltip')}).`)
    }
    await m.getByRole('button', { name: 'Heights', exact: true }).click()
    await m.getByRole('button', { name: /^Expand Bottom( Height)? height$/ }).click()
    await page.getByTestId('face-height-mode').selectOption('explicit_depth')
    const target = page.getByTestId('face-explicit-target').locator('input')
    await target.fill(String(op.face.targetWcs))
    await target.press('Tab')
  }
  if (op.source) {
    const select = m.locator('select').filter({ has: page.locator('option', { hasText: op.source }) }).first()
    const value = await select.locator('option').filter({ hasText: op.source }).first().getAttribute('value')
    await select.selectOption(value)
    await page.waitForTimeout(800)
  }
  if (op.detectHoles) {
    await m.getByRole('button', { name: /Detect holes/ }).click()
    await waitUntil(async () => /LOOPS TO MACHINE/i.test(await m.innerText()), { what: 'Detect holes to list the holes', timeout: 30_000 })
  }
  const create = page.getByTestId('op-create')
  await page.waitForTimeout(1_000)
  const allLoops = m.getByRole('button', { name: /^All loops/ })
  if (await create.isDisabled() && /No loops are selected/.test(await create.getAttribute('data-tooltip') ?? '') && await allLoops.count()) {
    journey.note(`New Operation / ${op.type}: opened with no loops selected after choosing ${op.source}; clicked "All loops".`)
    await allLoops.first().click()
  }
  await waitUntil(() => create.isEnabled(), { timeout: 60_000, what: `Create Operation to enable for ${op.type}` }).catch(async (error) => {
    throw new Error(`${op.type}: Create Operation stayed disabled (tooltip: ${await create.getAttribute('data-tooltip')}) - ${error.message}`)
  })
  await create.click()
  await m.waitFor({ state: 'detached', timeout: 30_000 })
}

/** The operation rows in the toolpath tree, with their status as the tree shows it. */
export async function operationStatuses(page) {
  return page.getByTestId('tree-name-op').evaluateAll((labels) => labels.map((label) => {
    const row = label.closest('.tree-op')
    const status = row?.querySelector('.tree-op-status')
    // The badge inside carries the state: status-ready / -computing / -error / -outdated /
    // -degraded / -pending / -unsupported (a ring with no class while computing with progress).
    const badge = status?.querySelector('[class*="status-"]')
    const match = (badge?.getAttribute('class') ?? '').match(/status-([a-z]+)/)
    return {
      name: label.textContent.trim(),
      state: match ? match[1] : 'computing',
      message: status?.getAttribute('data-tooltip') ?? '',
    }
  }))
}

/**
 * Press REGEN ALL and wait until nothing is computing and the status bar no
 * longer says "Compute pending". Returns the operation rows.
 */
export async function regenerateAll(journey, expectedCount = 1) {
  const page = journey.page
  await page.getByTestId('mode-tab-toolpath').click()
  await page.getByRole('button', { name: /regen all/i }).first().click()
  return settleOperations(journey, expectedCount)
}

/** Wait until no operation is computing; then give the status bar 30 s to stop saying "Compute pending". */
export async function settleOperations(journey, expectedCount = 1) {
  const page = journey.page
  await expandSetups(page)
  let statuses = []
  let quietSince = 0
  await waitUntil(async () => {
    statuses = await operationStatuses(page)
    const busy = statuses.length < expectedCount || statuses.some((s) => s.state === 'computing' || s.state === 'pending')
    if (busy) { quietSince = 0; return false }
    quietSince ||= Date.now()
    return Date.now() - quietSince > 3_000
  }, { timeout: 300_000, interval: 1_000, what: 'every operation to finish computing' })
  const pending = await waitUntil(async () => !/Compute pending/i.test(await page.locator('body').innerText()), { timeout: 30_000, what: 'the status bar to clear' })
    .then(() => false, () => true)
  if (pending) {
    journey.note(`The status bar still says "Compute pending" 30 s after every operation stopped computing (${statuses.map((s) => `${s.name}: ${s.state}`).join(', ')}).`)
  }
  return operationStatuses(page)
}

/**
 * REGEN ALL, then - because REGEN ALL can leave operations "outdated" - press
 * Compute toolpath on each still-outdated operation in tree order, up to three
 * rounds (computing one can mark the ones after it outdated). Every extra
 * round is recorded as a note.
 */
export async function bringAllReady(journey, expectedCount = 1) {
  let statuses = await regenerateAll(journey, expectedCount)
  for (let round = 1; round <= 3; round++) {
    const outdated = statuses.filter((s) => s.state === 'outdated').map((s) => s.name)
    if (!outdated.length) break
    journey.note(`After ${round === 1 ? 'REGEN ALL' : `Compute toolpath round ${round - 1}`} settled, ${outdated.join(', ')} still read "outdated"; pressed Compute toolpath on each.`)
    for (const name of outdated) {
      await computeOperation(journey, name).catch((error) => journey.log(`Compute toolpath on ${name}: ${firstLine(error)}`))
      await settleOperations(journey, expectedCount)
    }
    statuses = await operationStatuses(journey.page)
  }
  return statuses
}

/** Press an operation row's own "Compute toolpath" button. */
export async function computeOperation(journey, name) {
  const page = journey.page
  const row = page.locator('.tree-op').filter({ has: page.getByTestId('tree-name-op').filter({ hasText: new RegExp(`^${name}$`) }) }).first()
  await row.hover()
  await row.getByRole('button', { name: 'Compute toolpath' }).click()
}

export async function expandSetups(page) {
  const expand = page.getByTestId('tree-expand-all')
  if (await expand.isVisible().catch(() => false)) await expand.click()
}

/** STEP 5 */
export async function setupAndToolpaths(ctx) {
  const { journey } = ctx
  const page = journey.page
  await setStock(journey)
  await createSetup(journey)
  const failures = []
  for (const op of OPERATIONS) {
    try {
      await createOperation(journey, op)
      journey.log(`OPERATION created ${op.name}`)
    } catch (error) {
      failures.push(`${op.name}: ${error.message.split('\n')[0]}`)
      journey.log(`OPERATION ${op.name} could not be created: ${error.stack ?? error}`)
      const m = page.getByTestId('op-modal-panel')
      if (await m.count()) {
        await journey.shot(`step-05-${op.name.toLowerCase().replace(/\W+/g, '-')}-refused`)
        await m.getByRole('button', { name: 'Cancel' }).click().catch(() => {})
      }
    }
  }
  await page.getByTestId('mode-tab-toolpath').click()
  // Generate all: the Setups section's REGEN ALL.
  const statuses = await bringAllReady(journey, OPERATIONS.length - failures.length).catch((error) => {
    failures.push(error.message)
    return []
  })
  journey.log(`OPERATIONS ${JSON.stringify(statuses)}`)
  ctx.data.operations = statuses
  for (const s of statuses.filter((x) => x.state !== 'ready')) failures.push(`${s.name} is ${s.state}: ${s.message}`)
  journey.log(`CONSOLE ${await camConsole(page).innerText()}`)
  await journey.scene('hero-toolpaths')
  assert(!failures.length, failures.join(' | '))
}

function firstLine(error) {
  return String(error?.message ?? error).split(/\r?\n/)[0]
}
