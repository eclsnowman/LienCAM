// Step 9: the Control page on the built-in simulator - connect, home, set work
// zero, load the posted file, CYCLE START, Feed Hold, jog, resume, run to the end.
import path from 'node:path'
import { assert, waitUntil } from '../lib/harness.mjs'
import { MACHINE } from './setup-steps.mjs'

// Work zero on the table: machine X/Y/Z where G54 0,0,0 goes (the machine homes to 0 at the max end).
const WORK_ZERO = { X: -300, Y: -225, Z: -60 }

const text = (page, id) => page.getByTestId(id).innerText()
const value = (page, id) => page.getByTestId(id).inputValue()

async function dro(page, kind) {
  return Promise.all(['x', 'y', 'z'].map(async (a) => Number(await value(page, `control-dro-${kind}-${a}`))))
}

/** STEP 9 */
export async function runOnSimulator(ctx) {
  const { journey } = ctx
  const page = journey.page
  const file = ctx.data.grblFile
  assert(file, 'no GRBL file was posted in step 8 to load')

  await page.getByTestId('mode-tab-control').click()
  await page.getByTestId('control-view-main').click()
  const kinds = await page.getByTestId('control-kind-select').locator('option').evaluateAll((os) => os.map((o) => o.value))
  assert(kinds.includes('simulator'), `the connection list offers no simulator: ${kinds.join(', ')}`)
  await page.getByTestId('control-kind-select').selectOption('simulator')
  await page.getByTestId('control-connect').click()
  await waitUntil(async () => /Disconnect/i.test(await text(page, 'control-connect').catch(() => '')) || !/Not connected/i.test(await text(page, 'control-state-chip')),
    { timeout: 30_000, what: 'the simulator to connect' })
  journey.log(`CONTROL connected: ${await text(page, 'control-state-chip')} | ${await text(page, 'control-next-action')}`)

  // A fresh connection starts with the software stop latched; CLEAR resets it.
  if (/latched|CLEAR/i.test(await text(page, 'control-next-action'))) {
    await page.getByTestId('control-estop').click()
    await page.waitForTimeout(1_000)
  }
  await waitUntil(() => page.getByTestId('control-home').isEnabled(), { timeout: 15_000, what: 'Home All to be available' })
  await page.getByTestId('control-home').click()
  await waitUntil(async () => (await dro(page, 'machine')).every((v) => Number.isFinite(v)) && !/No machine datum|Not homed/i.test(await text(page, 'control-next-action')),
    { timeout: 120_000, what: 'homing to finish' })
  const homed = await dro(page, 'machine')
  journey.log(`CONTROL homed at machine ${homed.join(', ')}`)
  assert(homed.every((v) => Math.abs(v) < 0.01), `after Home All the machine DRO reads ${homed.join(', ')}; this machine homes to 0 at the max end`)

  // Work zero: move there with MDI, then Zero all (G54).
  const mdi = page.getByTestId('control-mdi-input')
  await mdi.fill(`G53 G0 X${WORK_ZERO.X} Y${WORK_ZERO.Y} Z${WORK_ZERO.Z}`)
  await mdi.press('Enter')
  await waitUntil(async () => {
    const m = await dro(page, 'machine')
    return Math.abs(m[0] - WORK_ZERO.X) < 0.01 && Math.abs(m[1] - WORK_ZERO.Y) < 0.01 && Math.abs(m[2] - WORK_ZERO.Z) < 0.01
  }, { timeout: 120_000, what: 'the MDI move to the work-zero spot' })
  await page.getByTestId('control-zero-all').click()
  await waitUntil(async () => (await dro(page, 'work')).every((v) => Math.abs(v) < 0.01), { timeout: 10_000, what: 'the work DRO to read 0,0,0 after Zero all' })
  journey.log(`CONTROL G54 set at machine ${WORK_ZERO.X}, ${WORK_ZERO.Y}, ${WORK_ZERO.Z}`)

  // Load the posted file through Open file...
  await page.getByTestId('control-load-menu').click()
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 10_000 }),
    page.getByTestId('control-open-file').click(),
  ])
  journey.log(`FILE-DIALOG answer ${file}`)
  await chooser.setFiles(file)
  await waitUntil(async () => /checks passed|CYCLE START begins/i.test(await text(page, 'control-next-action')) || await page.getByTestId('control-cyclestart').isEnabled(),
    { timeout: 120_000, what: `${path.basename(file)} to load and pass its checks` }).catch(async (error) => {
    throw new Error(`loading ${path.basename(file)}: ${await text(page, 'control-next-action')} (${error.message})`)
  })
  const loaded = await text(page, 'control-progress-text')
  journey.log(`CONTROL loaded ${path.basename(file)}: ${loaded} | ${await text(page, 'control-next-action')}`)

  // Run, hold, jog, resume.
  await page.getByTestId('control-cyclestart').click()
  await waitUntil(async () => /Running/i.test(await text(page, 'control-state-chip')), { timeout: 30_000, what: 'the program to start running' })
  // The simulator runs in real time; the operator's Feed override (10-200%) shortens the wait.
  const feedOverride = page.getByLabel('Feed override percent')
  if (await feedOverride.isVisible({ timeout: 10_000 }).catch(() => false)) {
    await feedOverride.fill('200')
    await feedOverride.press('Enter')
    await page.waitForTimeout(1_500)
    journey.log(`CONTROL feed override requested 200, box reads ${await feedOverride.inputValue()}`)
  } else {
    journey.log('CONTROL feed override box not shown; running at 100%')
  }
  await waitUntil(async () => {
    const m = (await text(page, 'control-progress-text')).match(/\((\d+)%\)/)
    return m && Number(m[1]) >= 5
  }, { timeout: 300_000, interval: 500, what: 'the program to get 5% in' })
  await journey.scene('control-mid-run')
  await journey.shot('step-09a-running')
  await page.getByTestId('control-feedhold').click()
  await waitUntil(async () => /Hold/i.test(await text(page, 'control-state-chip')), { timeout: 30_000, what: 'Feed Hold to hold' })
  journey.log(`CONTROL held: ${await text(page, 'control-progress-text')} | ${await text(page, 'control-next-action')}`)
  await journey.shot('step-09b-held')
  const zBefore = (await dro(page, 'machine'))[2]
  assert(await page.getByTestId('control-jog-z-plus').isEnabled(), 'Jog Z+ is not available while the program is held')
  await page.getByTestId('control-jog-z-plus').click()
  await waitUntil(async () => (await dro(page, 'machine'))[2] > zBefore + 0.1, { timeout: 15_000, what: 'Jog Z+ to move Z while held' })
  journey.log(`CONTROL jogged Z ${zBefore} -> ${(await dro(page, 'machine'))[2]}`)
  await page.getByTestId('control-cyclestart').click()
  await waitUntil(async () => /Running/i.test(await text(page, 'control-state-chip')), { timeout: 30_000, what: 'CYCLE START to resume' })
  // The posted program pauses itself (M0) at each tool change; the operator changes the
  // tool and presses CYCLE START. Each such pause is logged with where it stopped.
  let programPauses = 0
  await waitUntil(async () => {
    if (/Cycle complete/i.test(await text(page, 'control-next-action')) || /\(100%\)/.test(await text(page, 'control-progress-text'))) return true
    if (/Hold/i.test(await text(page, 'control-state-chip')) && await page.getByTestId('control-cyclestart').isEnabled()) {
      programPauses += 1
      journey.log(`CONTROL the program held itself (${programPauses}) at ${await text(page, 'control-progress-text')} | ${await text(page, 'control-next-action')}; pressing CYCLE START (tool change)`)
      if (programPauses === 1) await journey.shot('step-09c-tool-change-pause')
      await page.getByTestId('control-cyclestart').click()
      await page.waitForTimeout(2_000)
    }
    return false
  }, { timeout: 2_700_000, interval: 2_000, what: 'the program to run to the end' })
  ctx.data.programPauses = programPauses
  const ended = await text(page, 'control-progress-text')
  journey.log(`CONTROL finished: ${ended} | ${await text(page, 'control-next-action')}`)

  // What the console said, in full, for the record; and the claims it must make.
  const toggle = page.getByTestId('control-console-toggle')
  if (/Expand/i.test((await toggle.getAttribute('aria-label')) ?? await toggle.innerText())) await toggle.click()
  const consoleText = await text(page, 'control-console')
  for (const line of consoleText.split('\n').map((l) => l.trim()).filter(Boolean)) journey.log(`CONTROL console ${line}`)
  assert(new RegExp(`connected to ${MACHINE.name}`).test(consoleText), 'the console never said it connected')
  assert(new RegExp(path.basename(file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(consoleText), 'the console never named the loaded file')
  if (/still running - Feed Hold, then Stop\/Reset, before re-arming/.test(consoleText)) {
    journey.note('Control console printed "The program is still running - Feed Hold, then Stop/Reset, before re-arming" although the operator only pressed Feed Hold and CYCLE START (no re-arm).')
  }
  const pathCheck = consoleText.split('\n').filter((l) => /Path check:/.test(l))
  if (pathCheck.length) journey.note(`Control path check said: ${pathCheck.map((l) => l.trim()).join(' / ')}`)
  if (!/homed|Home/i.test(consoleText.replace(/Not homed[^\n]*/g, ''))) journey.note('The Control console records no line for Home All completing; its last homing line still says "Not homed".')
  ctx.data.control = { file: path.basename(file), loaded, ended }
}
