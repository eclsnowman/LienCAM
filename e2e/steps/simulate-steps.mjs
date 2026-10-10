// Step 6: simulate the whole setup, stock removal on, to the end of the timeline.
import { assert, waitUntil } from '../lib/harness.mjs'

/** STEP 6 */
export async function simulateToEnd(ctx) {
  const { journey } = ctx
  const page = journey.page
  await page.getByTestId('mode-tab-simulation').click()
  // The setup row simulates every operation in it.
  await page.getByTestId('tree-name-setup').first().click()
  const removal = page.getByLabel('Simulate Stock Removal')
  await removal.waitFor({ timeout: 30_000 })
  if (!(await removal.isChecked())) await removal.check()
  const speed = page.getByTestId('sim-speed-chip')
  if (!/100x/.test(await speed.innerText())) {
    await speed.click()
    await page.getByText('100x', { exact: true }).click()
  }
  const slider = page.getByLabel('Simulation position')
  const max = Number(await slider.evaluate((e) => e.max))
  assert(max > 0, `the simulation timeline is empty (max ${max})`)
  journey.log(`SIMULATE timeline ${(max / 1000).toFixed(1)} s`)
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  let tookMid = false
  await waitUntil(async () => {
    const value = Number(await slider.evaluate((e) => e.value))
    if (!tookMid && value > max / 2) {
      tookMid = true
      await journey.scene('simulate-mid-cut')
      await journey.shot('step-06a-simulate-mid-cut')
    }
    return value >= max - 1
  }, { timeout: 600_000, interval: 500, what: 'the simulation to reach the end of its timeline' })
  await page.waitForTimeout(1_500)
  const readout = await page.getByTestId('sim-position-readout').innerText()
  journey.log(`SIMULATE ended at ${readout}`)
  ctx.data.simulationSeconds = max / 1000
}
