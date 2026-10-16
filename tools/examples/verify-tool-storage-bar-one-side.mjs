// WO-2547: exercise the shipped recipe through production Open, REGEN ALL,
// Save/reopen, Setup Sheet export and stock-removal controls in one lifetime.
import assert from 'node:assert/strict'
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { withExampleDriver } from './lib/drive.mjs'
import { frameHolding, postAll, simulate, specifyLongFluteMill } from './build-tool-storage-bar.mjs'

const part = path.resolve('examples/04-tool-storage-bar')
const file = path.join(part, 'tool-storage-bar.camproject')
const evidence = 'src/tests/evidence/WO-2547'
const saved = JSON.parse(readFileSync(file, 'utf8'))

await withExampleDriver({ outDir: evidence }, async driver => {
  try {
    await driver.page.setViewportSize({ width: 1920, height: 1080 })
    await driver.step('Open shipped recipe', async page => {
      const chooser = page.waitForEvent('filechooser')
      await page.getByRole('button', { name: 'Open project', exact: true }).click()
      await (await chooser).setFiles(file)
    }, s => s.project.id === saved.id)
    if (process.argv.includes('--fix-round')) {
      await specifyLongFluteMill(driver)
      await driver.page.getByTestId('mode-tab-toolpath').click()
      for (const type of ['drill', 'bore']) {
        const op = saved.setups[0].operations.find(o => o.type === type)
        if (type === 'drill' ? op.params.cycleType === 'peck' && op.params.peckDepth === 3
          : op.smartHeight.intent.machining.end.value.plane.offsetMm === -12.5 && op.params.clearanceAllowanceMm === 0.25) continue
        await driver.page.locator('.tree-op').filter({ hasText: op.name }).first().click()
        await driver.page.getByTestId('props-drill-bore-edit-height').click()
        if (type === 'drill') {
          await driver.page.locator('.op-modal-tab').filter({ hasText: 'Passes' }).click()
          await driver.page.getByRole('button', { name: 'Peck (G83)', exact: true }).click()
          const input = driver.page.locator('.op-field-row').filter({ hasText: 'Peck depth' }).locator('input').first()
          await input.fill('3'); await input.press('Tab')
        } else {
          await driver.page.locator('.op-modal-tab').filter({ hasText: 'Passes' }).click()
          await driver.page.getByTestId('op-shank-clearance').locator('input').fill('0.25')
          await driver.page.getByTestId('op-shank-clearance').locator('input').press('Tab')
          await driver.page.locator('.op-modal-tab').filter({ hasText: 'Heights' }).click()
          await driver.page.getByRole('button', { name: /^Expand Bottom.*height$/i }).click()
          const input = driver.page.locator('.op-field-row').filter({ hasText: 'Target End (WCS)' }).locator('input').first()
          await input.fill('-12.5'); await input.press('Tab')
        }
        await driver.step(`Save fix-round ${type} recipe`, p => p.getByTestId('op-create').click(),
          s => {
            const current = s.project.setups[0].operations.find(o => o.type === type)
            return type === 'drill' ? current.params.cycleType === 'peck' && current.params.peckDepth === 3
              : current.smartHeight.intent.machining.end.value.plane.offsetMm === -12.5
          })
      }
      await driver.page.getByTestId('tree-name-setup').getByText(saved.setups[0].name, { exact: true }).click()
      const note = driver.page.getByTestId('setup-holding-note')
      await note.fill(saved.setups[0].notes.split('G54 makes')[0] +
        'G54 makes all three holes completely: peck-drill pilots in 3 mm increments (G83 Q3) to Z-13 into the sacrificial spoilboard. ' +
        'Bore each finished diameter to Z-12.5, breaking through the 12 mm bar by 0.5 mm. ' +
        'Specify the same 3 mm flat end mill with 15 mm flutes, rather than the starter 12 mm flute version, ' +
        'so the cut clears the bottom while retaining the default 0.25 mm shank clearance allowance. ' +
        'The kit still uses three tools. Chamfer the top rims. One-sided bores avoid flip mismatch; G55 only chamfers the underside rims.')
      await note.press('Tab')
    }
    await driver.page.getByTestId('mode-tab-toolpath').click()
    const compute = async label => driver.step(label, async page => {
      await page.locator('.tree-section-regen-btn').click()
      await page.waitForTimeout(2000)
    }, s => {
      const ops = s.project.setups.flatMap(setup => setup.operations)
      for (const op of ops) assert.notEqual(op.status, 'error', `${op.name}: ${op.error}`)
      return ops.length === 4 && ops.every(op => op.status === 'ready')
    }, { timeoutMs: 120_000 })
    await compute('Generate all four operations')
    await driver.page.mouse.click(1450, 300)
    for (const [i, setup] of saved.setups.entries()) {
      await driver.page.getByTestId('tree-name-setup').getByText(setup.name, { exact: true }).click()
      await frameHolding(driver.page)
      await driver.page.screenshot({ path: driver.output(`toolpaths-${i + 1}.png`) })
      copyFileSync(path.join(driver.outDir, `toolpaths-${i + 1}.png`), path.join(part, i ? 'toolpaths-bottom.png' : 'toolpaths.png'))
    }
    await driver.page.getByTestId('tree-name-setup').getByText(saved.setups[0].name, { exact: true }).click()
    const current = await driver.saveAndReopen('tool-storage-bar.camproject')
    const bore = current.setups[0].operations.find(o => o.type === 'bore')
    assert.equal(Math.min(...bore.toolpathMoves.map(m => m.z)), -12.5,
      'Requested depth is insufficient proof: the tool-reach trim must let the bore break through the bottom face by 0.5 mm')
    copyFileSync(path.join(driver.outDir, 'tool-storage-bar.camproject'), file)
    await driver.page.setViewportSize({ width: 1920, height: 1080 })
    await driver.page.getByTestId('mode-tab-toolpath').click()
    const state = await compute('Reopened recipe: Generate all')
    assert.equal(state.toolLibrary.find(t => t.name === '3 mm flat end mill, 15 mm flutes').fluteLength, 15)
    assert.equal(state.project.setups[0].operations[0].params.cycleType, 'peck')
    assert.equal(state.project.setups[0].operations[0].params.peckDepth, 3)
    assert.deepEqual(state.project.workholding, saved.workholding)
    assert.deepEqual(state.project.sceneStock, saved.sceneStock)
    assert.deepEqual(state.project.setups.map(s => s.wcs), saved.setups.map(s => s.wcs))
    for (const op of state.project.setups[0].operations.filter(o => ['drill', 'bore'].includes(o.type))) {
      assert.equal(op.resolvedHeightPlan.machining.cutterCenterEnd.wcsMm, op.type === 'drill' ? -13 : -12.5)
    }
    assert.deepEqual(state.project.setups[1].operations.map(o => o.type), ['chamfer'])
    await frameHolding(driver.page)
    await driver.page.screenshot({ path: driver.output('reopened.png') })
    copyFileSync(path.join(driver.outDir, 'reopened.png'), path.join(part, 'reopened.png'))
    writeFileSync(driver.output('readback.json'), JSON.stringify(state, null, 2))
    const programs = await postAll(driver)
    const simulations = await simulate(driver)
    for (const [i, setup] of current.setups.entries()) {
      const name = `simulation-${i + 1}-end.png`
      copyFileSync(path.join(driver.outDir, name), path.join(part, i ? 'simulation-end.png' : 'simulation-top-end.png'))
    }
    writeFileSync(driver.output('verification.json'), JSON.stringify({ projectId: current.id, programs, simulations }, null, 2))
  } catch (error) {
    writeFileSync(driver.output('debug-state.json'), JSON.stringify(await driver.readState(), null, 2))
    writeFileSync(driver.output('debug-ui.txt'), await driver.page.locator('body').innerText())
    throw error
  }
})
