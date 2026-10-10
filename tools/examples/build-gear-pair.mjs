import assert from 'node:assert/strict'
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { portableSnapshot, withExampleDriver } from './lib/drive.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
export const gears = [
  { teeth: 16, module: 4, center: { x: 40, y: 60 }, angle: 0 },
  { teeth: 24, module: 4, center: { x: 120, y: 60 }, angle: Math.PI / 24 },
]
const folder = 'examples/08-gear-pair'
const evidence = 'src/tests/evidence/WO-2549'
const holdingNote = 'Apply masking tape to the spoilboard and underside of the full 200 x 120 x 6 mm sheet. Bond the taped faces with superglue and let it cure. Run both setups on this same sheet without moving it. Both outlines cut 0.5 mm below the stock bottom, through the tape and slightly into the sacrificial spoilboard, to ensure breakthrough. Both gears stay glued in place. Pry off both gears and deburr. Tabs are off to keep nubs off the tooth flanks.'

async function recordHolding(d, setupIndex) {
  await d.page.getByTestId('mode-tab-setup').click()
  await d.page.locator('.tree-setup-header').nth(setupIndex).click()
  await d.step(`Record tape and glue for setup ${setupIndex + 1}`, async p => {
    await p.getByTestId('setup-holding-method').selectOption('tape_glue')
    await p.getByTestId('setup-holding-note').fill(holdingNote)
    await p.getByTestId('setup-holding-note').press('Tab')
  }, s => s.project.setups[setupIndex].holdingMethod === 'tape_glue' && s.project.setups[setupIndex].notes === holdingNote)
}

export async function nameProject(d) {
  await d.step('Name project 08 Gear pair', async p => {
    await p.getByTestId('tree-name-project').dblclick()
    await p.locator('.panel-project-rename').fill('08 Gear pair')
    await p.locator('.panel-project-rename').press('Enter')
  }, state => state.project.name === '08 Gear pair')
}

export async function placeMachiningParts(d) {
  await d.page.getByTestId('mode-tab-setup').click()
  for (let i = 3; i < 6; i++) {
    const geo = (await d.readState()).project.geometry[i]
    if (geo.position.x === 16) continue
    await d.step(`Place gear 2 geometry ${i + 1} with 8 mm tip clearance`, async p => {
      await p.getByTestId('tree-name-geometry').nth(i).click()
      await p.getByTestId('props-group-geo-info').getByText(geo.name, { exact: true }).waitFor()
      const group = p.getByTestId('props-group-geo-position').locator('..')
      if (!await group.locator('input').count()) await p.getByTestId('props-group-geo-position').click()
      const x = group.locator('input').first()
      for (let attempt = 0; Number(await x.inputValue()) !== geo.position.x; attempt++) {
        if (attempt === 50) throw new Error(`Position input did not settle for ${geo.name}`)
        await p.waitForTimeout(100)
      }
      await x.fill('16'); await x.press('Enter')
    }, state => state.project.geometry[i].position.x === 16)
  }
}

async function clickWorld(page, point) {
  const pos = await page.evaluate(pt => {
    const r = document.querySelector('.viewport-canvas').getBoundingClientRect()
    const s = window.__cncViewport.worldToScreen(pt.x, pt.y, 0)
    return { x: r.left + s.x, y: r.top + s.y }
  }, point)
  await page.mouse.click(pos.x, pos.y)
}
async function number(page, label, value) {
  const input = page.getByRole('textbox', { name: label, exact: true })
  await input.fill(String(value)); await input.press('Tab')
}
async function contextAction(page, name) {
  const canvas = page.locator('.viewport-canvas')
  await canvas.click({ button: 'right', position: { x: 300, y: 200 } })
  await page.getByText(name, { exact: true }).last().click()
}

async function frame(page, top = false) {
  if (top) await contextAction(page, 'Top view')
  await contextAction(page, 'Fit all')
  const canvas = await page.locator('.viewport-canvas').boundingBox()
  await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2)
  await page.mouse.wheel(0, 550)
  await page.waitForTimeout(350)
}

async function generateAll(d, label) {
  await d.page.getByTestId('mode-tab-toolpath').click()
  return d.step(label, async p => {
    await p.locator('.tree-section-regen-btn').click()
    await p.waitForTimeout(2000)
    await p.waitForFunction(() => !document.querySelector('.tree-op-progress') &&
      !document.querySelector('.tree-op-status .status-computing'), null, { timeout: 180_000 })
  }, state => {
    const ops = state.project.setups.flatMap(s => s.operations)
    for (const op of ops) assert.notEqual(op.status, 'error', `${op.name}: ${op.errorMessage}`)
    return ops.length === 6 && ops.every(op => op.status === 'ready')
  }, { timeoutMs: 180_000 })
}

export async function buildGearPair() {
  return withExampleDriver({ outDir: evidence }, async d => {
    // Large sketches can take longer to reach OPFS under concurrent lane load.
    // Keep the same durable predicates, with a bounded autosave allowance.
    const step = d.step.bind(d)
    d.step = (label, action, check, options = {}) => step(label, action, check,
      { ...options, timeoutMs: Math.max(180_000, options.timeoutMs ?? 0) })
    const read = d.readState.bind(d)
    const pagesWithState = new WeakSet()
    d.readState = async () => {
      for (let attempt = 0; attempt < 50; attempt++) {
        const state = await read()
        if (state) { pagesWithState.add(d.page); return state }
        if (!pagesWithState.has(d.page)) return null
        await d.page.waitForTimeout(100)
      }
      throw new Error('No persisted app state after 50 reads')
    }
    for (const name of ['model.png', 'simulation-mid-cut.png', 'simulation-end.png', 'simulation-end-setup-1.png', 'simulation-end-setup-2.png', 'simulation.json', 'app-console.txt', 'failure-dom.txt', 'keyway-debug.png', 'keyway-dom.txt']) d.output(name)
    if (!process.argv.includes('--capture-only')) {
      d.output('toolpaths.png')
      d.output('posts.json')
    }
    const page = d.page
    await page.setViewportSize({ width: 1920, height: 1080 })
    const consoleLog = []
    const attach = p => { p.on('console', msg => consoleLog.push({ type: msg.type(), text: msg.text() })); p.on('pageerror', err => consoleLog.push({ type: 'error', text: err.message })) }
    attach(page)
    try {
      if (process.argv.includes('--from-project')) {
        await d.step('Reopen completed machining checkpoint', async p => {
          const chooser = p.waitForEvent('filechooser')
          await p.getByRole('button', { name: 'Open project', exact: true }).click()
          await (await chooser).setFiles(path.join(root, folder, 'gear-pair.camproject'))
        }, state => state.project.setups.length === 2)
        await nameProject(d)
        const saved = JSON.parse(readFileSync(path.join(root, folder, 'gear-pair.camproject'), 'utf8'))
        const state = await d.readState()
        const expected = portableSnapshot(saved)
        const actual = portableSnapshot(state.project, state.toolLibrary)
        assert.deepEqual(actual, expected)
        writeFileSync(d.output('round-trip.json'), JSON.stringify({ saved: expected, reopened: actual }, null, 2))
        if (process.argv.includes('--capture-only')) {
          await d.step('Save reopened current project without recompute', async p => {
            const download = p.waitForEvent('download', { timeout: 120_000 })
            await p.getByRole('button', { name: 'Save project', exact: true }).click()
            await (await download).saveAs(d.output('reopened-current.json'))
          }, s => s.project.setups.every(setup => setup.operations.every(op => op.status === 'ready')))
        }
        if (!process.argv.includes('--capture-only')) {
        assert.equal(state.project.sceneStock.fixedStocks.length, 1, 'Rebuild legacy two-stock projects without --from-project')
        for (let i = 0; i < 2; i++) await recordHolding(d, i)
        await placeMachiningParts(d)
        for (let i = 0; i < 2; i++) {
          const setup = d.page.locator('.tree-setup').nth(i)
          if (await setup.getByTestId('tree-name-op').count() < 3) await setup.locator('.tree-setup-header').click()
          await setup.getByTestId('tree-name-op').nth(2).click()
          await d.page.getByTestId('props-contour-edit-height').click()
          await d.page.locator('.op-modal-tab').filter({ hasText: 'Heights' }).click()
          const expand = d.page.getByRole('button', { name: /^Expand Bottom.*height$/i })
          if (await expand.count()) await expand.click()
          await d.page.getByTestId('contour-height-mode').selectOption('through_stock')
          const allowance = d.page.locator('.op-field-row').filter({ hasText: 'Past stock bottom' }).locator('input')
          await allowance.fill('0.5'); await allowance.press('Tab')
          await d.step(`Set outline ${i + 1} breakthrough to 0.5 mm`, p => p.getByTestId('op-create').click(),
            s => s.project.setups[i].operations[2].smartHeight.intent.machining.end.value.allowanceMm === 0.5)
        }
        await generateAll(d, 'Generate all six operations from the shipped project')
        await d.page.getByTestId('mode-tab-toolpath').click()
        await frame(d.page)
        await d.page.screenshot({ timeout: 120_000, path: d.output('toolpaths.png') })
        await d.saveAndReopen('gear-pair.camproject')
        await d.page.setViewportSize({ width: 1920, height: 1080 })
        attach(d.page)
        await generateAll(d, 'Reopened project: Generate all six operations')
        writeFileSync(d.output('generated-readback.json'), JSON.stringify((await d.readState()).project, null, 2))
        copyFileSync(path.join(root, evidence, 'gear-pair.camproject'), path.join(root, folder, 'gear-pair.camproject'))
        }
      } else {
      // Keep the original app-made gear/bore/keyway geometry exactly. Only the
      // stock, setups and machining plan are rebuilt by this work order.
      if (!process.argv.includes('--new-sketches')) {
        await d.step('Open app-made sketch checkpoint', async p => {
          const chooser = p.waitForEvent('filechooser')
          await p.getByRole('button', { name: 'Open project', exact: true }).click()
          await (await chooser).setFiles(path.join(root, folder, 'sketches.camproject'))
        }, state => state.project.geometry.length === 6)
        await nameProject(d)
        await d.importTools('examples/08-gear-pair/starter-tool.json')
      } else {
      await d.newProject()
      await nameProject(d)
      await d.setStock({ width: 200, height: 120, depth: 6 })
      await d.importTools('examples/08-gear-pair/starter-tool.json')
      await contextAction(page, 'Fit all')
      for (const [index, gear] of gears.entries()) {
        for (const shape of ['gear', 'bore', 'keyway']) {
          const before = (await d.readState()).project.geometry.length
          await d.step(`Start ${shape} ${index + 1} sketch`, async p => {
            await p.getByTestId('mode-tab-sketch').click()
            await p.getByRole('button', { name: 'New sketch', exact: true }).click()
          }, s => s.project.geometry.length === before + 1)
          await page.waitForTimeout(250)
          for (const label of ['Entity snaps', 'Grid snap', 'Inference']) {
            const toggle = page.getByRole('button', { name: label, exact: true })
            if ((await toggle.getAttribute('class')).includes('toggle-on')) await toggle.click()
          }
          if (shape === 'gear') {
            await page.getByRole('button', { name: /^Gear/ }).first().click()
            await number(page, 'Gear teeth', gear.teeth)
            await number(page, 'Gear module', gear.module)
            await number(page, 'Gear root fillet', 1.5)
          } else await page.getByRole('button', { name: shape === 'bore' ? /^Circle/ : /^Rectangle/ }).first().click()
          if (shape === 'keyway') {
            const c = await page.locator('.viewport-canvas').boundingBox()
            await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2)
            await page.mouse.wheel(0, -700)
            await page.waitForTimeout(400)
          }
          await d.step(`Draw ${shape} ${index + 1}`, async () => {
            if (shape === 'gear') {
              await clickWorld(page, gear.center)
              await clickWorld(page, { x: gear.center.x + 20 * Math.cos(gear.angle), y: gear.center.y + 20 * Math.sin(gear.angle) })
            } else if (shape === 'bore') {
              await clickWorld(page, gear.center)
              await clickWorld(page, { x: gear.center.x + 5, y: gear.center.y })
            } else {
              await clickWorld(page, { x: gear.center.x - 2, y: gear.center.y + 3 })
              await clickWorld(page, { x: gear.center.x + 2, y: gear.center.y + 8 })
            }
          }, async s => s.project.geometry.length === before + 1 && await page.getByRole('button', { name: 'Finish sketch', exact: true }).isEnabled())
          await d.step(`Bake ${shape} ${index + 1}`, p => p.getByRole('button', { name: 'Finish sketch', exact: true }).click(),
            s => {
              const geo = s.project.geometry[before]
              if (s.project.geometry.length !== before + 1 || geo.loops.length !== 1) return false
              const entities = geo.sketches[0].entities
              if (shape === 'gear') return entities.some(e => e.kind === 'circle' && e.construction &&
                e.radius === gear.teeth * gear.module / 2 && Math.hypot(e.center.x - gear.center.x, e.center.y - gear.center.y) < 0.01)
              if (shape === 'bore') return entities.some(e => e.kind === 'circle' && !e.construction && Math.abs(e.radius - 5) < 0.01)
              return entities.filter(e => e.kind === 'line' && !e.construction).length === 4
            })
          await contextAction(page, 'Fit all')
        }
      }
      await contextAction(page, 'Fit all')
      await frame(page, true)
      await page.screenshot({ timeout: 120_000, path: d.output('model.png') })
      writeFileSync(d.output('geometry.json'), JSON.stringify((await d.readState()).project.geometry, null, 2))
      if (process.argv.includes('--sketch-only')) { await d.saveAndReopen('sketches.camproject'); return }
      }
      await placeMachiningParts(d)
      const stocks = (await d.readState()).project.sceneStock.fixedStocks
      const stockNode = page.locator('.fixed-stock-node').last()
      if (!await stockNode.locator('.stock-number-input').count()) await stockNode.locator('.fixed-stock-header').click()
      await d.step('Use one 200 mm sheet for both gears', async () => {
        const width = stockNode.locator('.stock-field-row').filter({ hasText: 'Width (X)' }).locator('input')
        await width.fill('200'); await width.press('Enter')
      }, s => s.project.sceneStock.fixedStocks.length === 1 && s.project.sceneStock.fixedStocks[0].width === 200)
      for (let i = 0; i < 6; i++) await d.step(`Assign geometry ${i + 1} to the shared sheet`,
        p => p.locator('.tree-geo-stock-select').nth(i).selectOption(stocks[0].id),
        state => state.project.geometry[i].stockId === stocks[0].id)
      const geometry = (await d.readState()).project.geometry
      for (let setupIndex = 0; setupIndex < 2; setupIndex++) {
        const stock = stocks[0]
        await page.getByRole('button', { name: 'Add setup', exact: true }).click()
        await page.locator('.wcs-stock-select').selectOption(stock.id)
        await d.step(`Create setup ${setupIndex + 1} on the shared sheet`, p => p.getByRole('button', { name: 'Create Setup', exact: true }).click(),
          state => state.project.setups.length === setupIndex + 1 && state.project.setups[setupIndex].wcs.stockId === stock.id)
        await recordHolding(d, setupIndex)
        for (const geoIndex of [1, 2, 0].map(i => i + setupIndex * 3)) {
        const kind = geoIndex % 3
        const type = ['contour_2d', 'bore', 'pocket_2d'][kind]
        const title = ['2D Contour', 'Bore', '2D Pocket'][kind]
        await page.locator('.tree-setup').nth(setupIndex).getByRole('button', { name: 'Add operation', exact: true }).click()
        await page.locator('.op-type-card').filter({ hasText: title }).click()
        await page.locator('.op-modal-tab').filter({ hasText: 'Tool' }).click()
        await page.locator('.op-tool-row').filter({ hasText: '3 mm flat end mill' }).click()
        await page.locator('.op-modal-tab').filter({ hasText: 'Geometry' }).click()
        await page.getByTestId('op-geometry-select').selectOption(geometry[geoIndex].id)
        await page.locator('.op-loop-check input[type=checkbox]').first().check()
        await page.locator('.op-modal-tab').filter({ hasText: 'Passes' }).click()
        const stepdown = page.locator('.op-field-row').filter({ hasText: kind === 1 ? /^Maximum stepdown/ : /^Stepdown/ }).locator('input').first()
        await stepdown.fill('0.5'); await stepdown.press('Tab')
        await page.locator('.op-modal-tab').filter({ hasText: 'Heights' }).click()
        await page.getByRole('button', { name: /^Expand Bottom.*height$/i }).click()
        if (kind === 0) {
          await page.getByTestId('contour-height-mode').selectOption('through_stock')
          const allowance = page.locator('.op-field-row').filter({ hasText: 'Past stock bottom' }).locator('input')
          await allowance.fill('0.5'); await allowance.press('Tab')
        }
        else if (kind === 1) {
          await page.getByTestId('drill-bore-height-mode').selectOption('explicit_depth')
          const end = page.getByTestId('drill-bore-explicit-depth').locator('.op-field-row').filter({ hasText: 'Target End (WCS)' }).locator('input')
          await end.fill('-6'); await end.press('Tab')
        } else {
          await page.getByTestId('standard-height-bottom-source-control').selectOption('stock_bottom')
          const offset = page.getByTestId('standard-height-bottom-offset-control').locator('input')
          await offset.fill('0'); await offset.press('Tab')
        }
        const before = (await d.readState()).project.setups[setupIndex].operations.length
        await d.step(`Create ${title} for geometry ${geoIndex + 1}`, p => p.getByTestId('op-create').click(),
          s => s.project.setups[setupIndex].operations.length === before + 1 &&
            s.project.setups[setupIndex].operations.at(-1).type === type &&
            s.project.setups[setupIndex].operations.at(-1).status === 'ready', { timeoutMs: 180_000 })
        writeFileSync(d.output('machining-readback.json'), JSON.stringify((await d.readState()).project.setups, null, 2))
      }
      }
      await page.getByTestId('mode-tab-toolpath').click()
      await frame(page)
      await page.screenshot({ timeout: 120_000, path: d.output('toolpaths.png') })
      await d.saveAndReopen('gear-pair.camproject')
      await d.page.setViewportSize({ width: 1920, height: 1080 })
      attach(d.page)
      assert((await d.readState()).project.setups.every(s => s.operations.every(op => op.status === 'ready')), 'Every operation must be current on Open before recompute')
      await d.step('Save reopened current project before recompute', async p => {
        const download = p.waitForEvent('download', { timeout: 120_000 })
        await p.getByRole('button', { name: 'Save project', exact: true }).click()
        await (await download).saveAs(d.output('reopened-current.json'))
      }, s => s.project.setups.every(setup => setup.operations.every(op => op.status === 'ready')))
      // Open retains the six current production results; recomputing here would
      // mask stale-on-open defects and needlessly repeat the long gear cuts.
      await frame(d.page)
      await d.page.screenshot({ timeout: 120_000, path: d.output('reopened.png') })
      copyFileSync(path.join(root, evidence, 'gear-pair.camproject'), path.join(root, folder, 'gear-pair.camproject'))
      copyFileSync(path.join(root, evidence, 'reopened.png'), path.join(root, folder, 'reopened.png'))
      }
      await frame(d.page, true)
      await d.page.screenshot({ timeout: 120_000, path: d.output('model.png') })
      await contextAction(d.page, 'Isometric view')
      await frame(d.page)
      await d.page.screenshot({ timeout: 120_000, path: d.output('reopened.png') })
      const reopened = d.page
      await reopened.getByRole('button', { name: 'Application settings', exact: true }).click()
      await d.step('Select 2.5D stock simulation for flat gears', async () => {
        await reopened.getByTestId('settings-sim-engine').click()
        await reopened.getByRole('option', { name: '2.5D - fast (low-end GPUs)', exact: true }).click()
      }, state => state.appSettings.simulationEngine === 'heightmap')
      await reopened.locator('.settings-modal .modal-close-btn').click()
      const simulations = []
      const machining = JSON.parse(readFileSync(path.join(root, folder, 'gear-pair.camproject'), 'utf8'))
      for (let setupIndex = 0; setupIndex < 2; setupIndex++) {
      await reopened.getByTestId('mode-tab-setup').click()
      await reopened.locator('.tree-setup-header').nth(setupIndex).click()
      await reopened.getByTestId('mode-tab-simulation').click()
      await reopened.getByLabel('Simulate Stock Removal', { exact: true }).check()
      const slider = reopened.getByRole('slider', { name: 'Simulation position', exact: true })
      await reopened.getByRole('button', { name: 'Play', exact: true }).waitFor()
      const sliderBox = await slider.boundingBox()
      await reopened.mouse.click(sliderBox.x + sliderBox.width / 2, sliderBox.y + sliderBox.height / 2)
      await reopened.waitForFunction(() => document.querySelector('.sim-panel')?.getAttribute('data-stock-sync') === 'exact', null, { timeout: 120_000 })
      await reopened.screenshot({ timeout: 120_000, path: d.output('simulation-mid-cut.png') })
      await d.step('Simulate through the end', p => p.getByRole('button', { name: 'Skip to end', exact: true }).click(), async () =>
        Number(await slider.getAttribute('max')) > 0 && Number(await slider.inputValue()) >= Number(await slider.getAttribute('max')) - 1,
        { timeoutMs: 120_000 })
      await reopened.waitForFunction(() => document.querySelector('.sim-panel')?.getAttribute('data-stock-sync') === 'exact', null, { timeout: 120_000 })
      const outline = machining.setups[setupIndex].operations.find(op => op.type === 'contour_2d')
      const bottom = machining.sceneStock.fixedStocks[0].position.z
      const finalCuts = outline.toolpathMoves.filter(m => m.role === 'cut' && Math.abs(m.z - (bottom - 0.5)) < 1e-6)
      assert(finalCuts.length > 100, 'The whole tooth outline must reach into the tape')
      const center = { x: gears[setupIndex].center.x + (setupIndex === 1 ? 16 : 0), y: 60 }
      const simulation = await reopened.evaluate(({ finalCuts, center, bottom }) => {
        const layout = window.__cncViewport.stockSimLayout
        if (!layout) throw new Error('No production heightmap readback')
        let removedVolumeMm3 = 0
        for (let i = 0; i < layout.topPositions.length; i += 12) {
          // Integral of the two actual rendered top triangles per grid cell.
          const p = layout.topPositions
          const z = (2 * p[i + 2] + p[i + 5] + 2 * p[i + 8] + p[i + 11]) / 6
          removedVolumeMm3 += (6 - z) * layout.csx * layout.csy
        }
        const at = (x, y) => {
          const ix = Math.floor((x - layout.x0) / layout.csx), iy = Math.floor((y - layout.y0) / layout.csy)
          if (ix < 0 || iy < 0 || ix >= layout.nx || iy >= layout.ny) throw new Error('Readback sample outside sheet')
          const offset = (iy * layout.nx + ix) * 12
          return Math.max(...[2, 5, 8, 11].map(i => layout.topPositions[offset + i]))
        }
        const gaps = finalCuts.map(m => ({ x: m.x, y: m.y, topZ: at(m.x, m.y) }))
        const retained = { x: center.x, y: center.y - 15, topZ: at(center.x, center.y - 15) }
        return { removedVolumeMm3, method: 'Read actual production rendered heightmap; samples along the complete final tooth outline and inside the retained gear',
          bottom, gaps, retained, resolutionMm: layout.csx, position: document.querySelector('[aria-label="Simulation position"]').value }
      }, { finalCuts, center, bottom })
      assert.ok(simulation.removedVolumeMm3 > 0)
      assert(simulation.gaps.every(p => p.topZ <= bottom + 0.001), 'Every final tooth-outline sample is cut through')
      assert(simulation.retained.topZ > bottom + 5.9, 'The gear remains at its original sheet position')
      simulations.push({ setupIndex, ...simulation })
      await reopened.getByTestId('sim-display-stock').click()
      await reopened.getByTestId('sim-hide-toolpath').check()
      await contextAction(reopened, 'Isometric view')
      await frame(reopened)
      await reopened.mouse.wheel(0, -1200)
      await reopened.waitForTimeout(350)
      // Fit all can frame the selected gear instead of the whole simulated sheet.
      // Check the actual projected sheet corners before publishing either setup.
      for (let attempt = 0; ; attempt++) {
        const fits = await reopened.evaluate(stock => {
          const canvas = document.querySelector('.viewport-canvas')
          return [0, stock.width].every(dx => [0, stock.height].every(dy => {
            const p = window.__cncViewport.worldToScreen(stock.position.x + dx, stock.position.y + dy, stock.position.z + stock.depth)
            return p.x >= 24 && p.y >= 24 && p.x <= canvas.clientWidth - 24 && p.y <= canvas.clientHeight - 24
          }))
        }, machining.sceneStock.fixedStocks[0])
        if (fits) break
        assert(attempt < 20, 'The complete simulated sheet must fit in the capture')
        await reopened.mouse.wheel(0, 200)
        await reopened.waitForTimeout(350)
      }
      await reopened.screenshot({ timeout: 120_000, path: d.output(`simulation-end-setup-${setupIndex + 1}.png`) })
      copyFileSync(path.join(root, evidence, `simulation-end-setup-${setupIndex + 1}.png`),
        path.join(root, folder, `simulation-end-setup-${setupIndex + 1}.png`))
      }
      writeFileSync(d.output('simulation.json'), JSON.stringify(simulations, null, 2))
      // Production playback is setup-scoped. Show both genuine end captures,
      // explicitly labelled, rather than claiming one cumulative app state.
      const comparison = await reopened.context().newPage()
      await comparison.setViewportSize({ width: 1920, height: 1080 })
      await comparison.setContent(`<html><body style="margin:0;background:#17191d;color:white;font:24px sans-serif"><h1 style="margin:24px">08 Gear pair - one taped and glued sheet</h1><p style="margin:24px">Production Cut Stock at each setup's end. The app simulates one setup at a time.</p><main style="display:flex">${[1, 2].map(i => `<section style="width:50%"><h2 style="margin:24px">Setup ${i}: ${i === 1 ? 16 : 24} teeth - cut free, retained in place</h2><img style="width:100%" src="data:image/png;base64,${readFileSync(path.join(root, evidence, `simulation-end-setup-${i}.png`)).toString('base64')}"></section>`).join('')}</main><p style="margin:24px">Run both setups without moving the sheet. Pry off both gears and deburr.</p></body></html>`)
      await comparison.screenshot({ timeout: 120_000, path: d.output('simulation-end.png') })
      await comparison.close()
      await reopened.getByTestId('mode-tab-postprocess').click()
      const posts = []
      await reopened.getByTestId('post-definition-select').click()
      const dialects = await reopened.getByRole('listbox').getByRole('option').allTextContents()
      await reopened.keyboard.press('Escape')
      // A capture resume owes pictures and job sheets, not repeated post previews.
      for (const dialect of process.argv.includes('--capture-only') ? [] : dialects) {
        await reopened.getByTestId('post-definition-select').click()
        await reopened.getByRole('listbox').getByRole('option', { name: dialect, exact: true }).click()
        const scope = reopened.locator('.scope-setup-cb')
        assert.equal(await scope.count(), 2)
        for (let i = 0; i < 2; i++) await scope.nth(i).check()
        const separate = reopened.getByRole('button', { name: 'Separate files (one per setup)', exact: true })
        if (await separate.count()) await separate.click()
        await reopened.getByRole('button', { name: 'Preview', exact: true }).click()
        const selector = reopened.getByTestId('post-preview-file-select')
        await selector.waitFor()
        await selector.click()
        const filenames = await reopened.getByRole('listbox').getByRole('option').allTextContents()
        await reopened.keyboard.press('Escape')
        assert.equal(filenames.length, 2)
        const files = []
        for (const filename of filenames) {
          await d.step(`Preview ${dialect}: ${filename}`, async () => {
            await selector.click()
            await reopened.getByRole('listbox').getByRole('option', { name: filename, exact: true }).click()
          }, async state => state.project.setups.every(setup => setup.operations.every(op => op.status === 'ready')) &&
            (await selector.innerText()).includes(filename) && /G0?[0123]/.test(await reopened.getByTestId('post-gcode-preview').innerText()))
          const code = await reopened.getByTestId('post-gcode-preview').innerText()
          assert.doesNotMatch(code, /\bERROR\b/)
          files.push({ filename, lines: code.split('\n').length })
        }
        posts.push({ dialect, files })
        await reopened.getByRole('button', { name: 'Properties', exact: true }).click()
      }
      if (!process.argv.includes('--capture-only')) writeFileSync(d.output('posts.json'), JSON.stringify(posts, null, 2))
      const sheetScope = reopened.locator('.scope-setup-cb')
      assert.equal(await sheetScope.count(), 2)
      for (let i = 0; i < 2; i++) await sheetScope.nth(i).check()
      // One combined sheet records both setups and avoids identical G54 names
      // overwriting one another when downloading separate setup sheets.
      await reopened.getByRole('button', { name: 'Combined (one file)', exact: true }).click()
      const downloads = []
      const onDownload = download => downloads.push(download)
      reopened.on('download', onDownload)
      await d.step('Download tape and glue job sheet', p => p.getByTestId('post-download-setup-sheet').click(),
        () => downloads.length === 2, { timeoutMs: 120_000 })
      reopened.off('download', onDownload)
      for (const download of downloads) {
        const name = download.suggestedFilename().endsWith('.pdf') ? 'gear-pair.setup.pdf' : 'gear-pair.setup.txt'
        await download.saveAs(d.output(name))
        copyFileSync(path.join(root, evidence, name), path.join(root, folder, name))
      }
      await reopened.getByRole('button', { name: 'Close', exact: true }).click()
      await reopened.getByTestId('console-strip').click()
      const errors = await reopened.locator('.console-event.console-severity-error').allTextContents()
      assert.deepEqual(errors, [])
      writeFileSync(d.output('app-console.txt'), await reopened.getByTestId('console-timeline').innerText())
      copyFileSync(path.join(root, evidence, 'reopened.png'), path.join(root, folder, 'reopened.png'))

    } catch (error) {
      writeFileSync(d.output('failure-dom.txt'), await d.page.locator('body').innerText())
      throw error
    } finally {
      writeFileSync(d.output('console.json'), JSON.stringify(consoleLog, null, 2))
    }
  })
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildGearPair()
