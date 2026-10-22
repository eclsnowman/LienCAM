import { isMain } from '../lib/is-main.mjs';
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { portableSnapshot, withExampleDriver } from './lib/drive.mjs'
import { scanDirectory } from '../release/scan.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const PART = path.join(ROOT, 'examples/09-nested-kit-sheet')
const EVIDENCE = 'src/tests/evidence/WO-2381'
const project = name => JSON.parse(readFileSync(path.join(ROOT, `examples/${name}.camproject`), 'utf8'))
const svg = points => {
  const xs = points.map(p => p.x), ys = points.map(p => p.y)
  const x = Math.min(...xs), y = Math.min(...ys), w = Math.max(...xs) - x, h = Math.max(...ys) - y
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="${x} ${y} ${w} ${h}"><desc>Apache-2.0. Kit outline made for the release.</desc><path d="${points.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join(' ')} Z"/></svg>\n`
}

// Extract the current kit's saved production outlines, never invent new gear
// teeth or feed a hand-built project into the app. The jaws' base rectangle is
// the 80 x 18 sketch used by build-soft-jaws, before its 16 mm extrusion.
export function sourceFiles() {
  const clamp = project('02-toe-clamps/toe-clamps').geometry[0].loops[0].points
  const gears = project('08-gear-pair/gear-pair').geometry
  const jaw = [{ x: 0, y: 0 }, { x: 80, y: 0 }, { x: 80, y: 18 }, { x: 0, y: 18 }]
  assert.equal(project('03-soft-jaws/soft-jaws').geometry[0].boundingBox.size.x, 80)
  assert.equal(project('03-soft-jaws/soft-jaws').geometry[0].boundingBox.size.y, 18)
  return { 'toe-clamp.svg': svg(clamp), 'soft-jaw.svg': svg(jaw),
    'gear-16.svg': svg(gears[0].loops[0].points), 'gear-24.svg': svg(gears[3].loops[0].points),
    'sign.svg': readFileSync(path.join(ROOT, 'examples/05-name-sign/profile.svg'), 'utf8') }
}

async function field(page, label, value, selector = '.op-field-row') {
  const input = page.locator(selector).filter({ hasText: new RegExp(`^${label.replace(/[()]/g, '\\$&')}`) }).locator('input').first()
  await input.fill(String(value)); await input.press('Tab')
}
async function tab(page, name) {
  await page.locator('.op-modal-tab').filter({ hasText: new RegExp(`^${name}$`) }).click()
}
async function capture(d, name) {
  for (const action of [name.startsWith('simulation') ? 'Isometric view' : 'Top view', 'Fit all']) {
    await d.page.locator('.viewport-canvas canvas').first().click({ button: 'right', position: { x: 400, y: 250 } })
    await d.page.getByRole('menuitem', { name: action, exact: true }).click()
  }
  await d.page.waitForTimeout(500)
  const bounds = await d.page.locator('.viewport-canvas').boundingBox()
  await d.page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  for (let attempt = 0; ; attempt++) {
    const fits = await d.page.evaluate(() => {
      const canvas = document.querySelector('.viewport-canvas')
      return [0, 290].every(x => [0, 190].every(y => {
        const p = window.__cncViewport.worldToScreen(x, y, 3)
        return p.x >= 24 && p.y >= 24 && p.x <= canvas.clientWidth - 24 && p.y <= canvas.clientHeight - 24
      }))
    })
    if (fits) break
    assert.ok(attempt < 20, 'The whole sheet must fit in the capture')
    await d.page.mouse.wheel(0, 200)
    await d.page.waitForTimeout(350)
  }
  assert.equal(await d.page.evaluate(() => document.documentElement.getAttribute('data-color-mode') ?? 'dark'), 'dark')
  await d.page.screenshot({ timeout: 120_000, path: d.output(name) })
}
async function consoleReadback(d, name) {
  if (await d.page.getByTestId('console-strip').getAttribute('aria-expanded') !== 'true') await d.page.getByTestId('console-strip').click()
  await d.page.getByTestId('console-filter-all').click()
  const events = await d.page.locator('.console-event').evaluateAll(nodes => nodes.map(n => ({ text: n.textContent, error: n.classList.contains('console-severity-error') })))
  writeFileSync(d.output(name), JSON.stringify(events, null, 2))
  assert.equal(events.filter(e => e.error).length, 0, 'Application console must contain no error lines')
  await d.page.getByTestId('console-strip').click()
}
async function regenerate(d, label) {
  return d.step(label, p => p.getByRole('button', { name: 'REGEN ALL' }).click(), s =>
    s.project.setups[0].operations.length === 1 && s.project.setups[0].operations.every(o => o.status === 'ready'), { timeoutMs: 120_000 })
}
async function simulateAndVerify(d, saved, reopened, resultText, posts) {
  const stock = saved.sceneStock.fixedStocks[0]
  await d.page.getByRole('button', { name: 'Application settings', exact: true }).click()
  await d.step('Select 2.5D sheet simulation', async p => {
    await p.getByTestId('settings-sim-engine').click()
    await p.getByRole('option', { name: '2.5D - fast (low-end GPUs)', exact: true }).click()
  }, s => s.appSettings.simulationEngine === 'heightmap')
  await d.page.locator('.settings-modal .modal-close-btn').click()
  await d.page.getByTestId('mode-tab-simulation').click()
  await d.page.getByLabel('Simulate Stock Removal', { exact: true }).check()
  await d.step('Use fast 1 mm sheet simulation resolution', p => p.locator('.sim-res-select').selectOption('1'), async s =>
    s.project.setups[0].operations[0].status === 'ready' && await d.page.locator('.sim-res-select').inputValue() === '1')
  // Software-rendered stock can keep the canvas animating during initialization.
  // Activate the real buttons without Playwright's layout-stability wait, then
  // verify the button's own state rather than accepting a dispatched click.
  await d.step('Show actual Cut Stock', p => p.getByTestId('sim-display-stock').click({ force: true, timeout: 120_000 }), async s =>
    s.project.setups[0].operations[0].status === 'ready' && await d.page.getByTestId('sim-display-stock').getAttribute('aria-pressed') === 'true', { timeoutMs: 120_000 })
  await d.page.getByTestId('sim-hide-toolpath').check({ force: true, timeout: 120_000 })
  const slider = d.page.getByRole('slider', { name: 'Simulation position', exact: true })
  const totalMs = Number(await slider.getAttribute('max'))
  assert.ok(totalMs > 0)
  await slider.fill(String(Math.round(totalMs * 0.5)))
  await d.page.waitForFunction(() => document.querySelector('.sim-panel')?.getAttribute('data-stock-sync') === 'exact', null, { timeout: 360_000 })
  await capture(d, 'simulation-mid-cut.png')
  await d.step('Simulate all seven profiles to the end', p => p.getByRole('button', { name: 'Skip to end', exact: true }).click(), async s =>
    s.project.setups[0].operations[0].status === 'ready' && Number(await slider.inputValue()) >= totalMs - 1 &&
    await d.page.evaluate(() => document.querySelector('.sim-panel')?.getAttribute('data-stock-sync') === 'exact'), { timeoutMs: 360_000 })
  const simulation = await d.page.evaluate(({ stockTop, totalMs }) => {
    const layout = window.__cncViewport.stockSimLayout
    if (!layout) throw new Error('No live app heightmap readback')
    let removedVolumeMm3 = 0
    for (let i = 0; i < layout.topPositions.length; i += 12) {
      const p = layout.topPositions
      const z = (2 * p[i + 2] + p[i + 5] + 2 * p[i + 8] + p[i + 11]) / 6
      removedVolumeMm3 += (stockTop - z) * layout.csx * layout.csy
    }
    return { removedVolumeMm3, resolutionMm: layout.csx, method: 'Integral of live production rendered heightmap top triangles', totalMs,
      markerMs: Number(document.querySelector('.sim-scrubber').value), stockMs: Number(document.querySelector('.sim-panel').getAttribute('data-stock-ms')),
      stockSync: document.querySelector('.sim-panel').getAttribute('data-stock-sync') }
  }, { stockTop: stock.position.z + stock.depth, totalMs })
  assert.ok(simulation.removedVolumeMm3 > 0)
  await capture(d, 'simulation-end.png')
  await consoleReadback(d, 'simulation-console.json')
  const report = { projectName: saved.name, machineId: saved.machine.id, nestResultText: resultText,
    operations: reopened.project.setups[0].operations.map(o => ({ name: o.name, type: o.type, status: o.status, params: o.params, moveCount: saved.setups[0].operations[0].toolpathMoves.length })),
    simulation, posts, sourceRevision: (await import('node:child_process')).execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim() }
  writeFileSync(d.output('verification.json'), JSON.stringify(report, null, 2))
  copyFileSync(path.join(d.outDir, 'nested-kit-sheet.camproject'), path.join(PART, 'nested-kit-sheet.camproject'))
  // The public picture is the reopened project's finished Cut Stock, while
  // evidence/reopened.png also records its ready toolpaths before simulation.
  copyFileSync(path.join(d.outDir, 'simulation-end.png'), path.join(PART, 'reopened.png'))
  const scan = scanDirectory(PART)
  writeFileSync(d.output('scan.json'), JSON.stringify(scan, null, 2))
  assert.deepEqual(scan.hits, [])
  return saved
}
export async function buildNestedKitSheet({ resume = process.argv.includes('--resume-simulation') } = {}) {
  const readEvidence = name => JSON.parse(readFileSync(path.join(ROOT, EVIDENCE, name), 'utf8'))
  const previous = resume ? { saved: readEvidence('nested-kit-sheet.camproject'), steps: readEvidence('steps.json'),
    readback: readEvidence('nest-readback.json'), posts: readEvidence('posts.json'), events: readEvidence('browser-console.json') } : null
  mkdirSync(PART, { recursive: true })
  if (!resume) for (const name of ['nested-kit-sheet.camproject', 'reopened.png']) rmSync(path.join(PART, name), { force: true })
  for (const [name, text] of Object.entries(sourceFiles())) writeFileSync(path.join(PART, name), text)
  return withExampleDriver({ outDir: EVIDENCE }, async d => {
    if (resume) for (const name of ['simulation-mid-cut.png', 'simulation-end.png', 'verification.json', 'scan.json', 'simulation-console.json']) d.output(name)
    if (!resume) for (const name of ['model.png', 'nest-result.png', 'toolpaths.png', 'simulation-mid-cut.png', 'simulation-end.png',
      'verification.json', 'nest-readback.json', 'browser-console.json', 'posts.json', 'scan.json', 'failure-dom.txt',
      'nested-kit-sheet.camproject', 'sheet-export.svg', 'built-console.json', 'reopened-console.json', 'posted-console.json', 'simulation-console.json']) d.output(name)
    const browserEvents = previous?.events ?? []
    const watch = p => {
      p.on('console', msg => browserEvents.push({ type: msg.type(), text: msg.text() }))
      p.on('pageerror', error => browserEvents.push({ type: 'pageerror', text: error.message }))
    }
    watch(d.page)
    try {
      await d.page.setViewportSize({ width: 1920, height: 1080 })
      if (previous) {
        // Resume only from the app's real Save output. Keep successful earlier
        // readbacks; the fresh Open and simulation still run through production UI.
        d.steps = previous.steps.filter(step => step.status === 'passed')
        const expected = portableSnapshot(previous.saved)
        const state = await d.step('Resume saved contour in a fresh context', async p => {
          const chooser = p.waitForEvent('filechooser')
          await p.getByRole('button', { name: 'Open project', exact: true }).click()
          await (await chooser).setFiles(path.join(PART, 'nested-kit-sheet.camproject'))
        }, s => {
          if (s.project.id !== previous.saved.id) return false
          assert.deepEqual(portableSnapshot(s.project, s.toolLibrary), expected)
          return s.project.setups[0].operations[0].status === 'ready'
        }, { timeoutMs: 120_000 })
        writeFileSync(d.output('round-trip.json'), JSON.stringify({ saved: expected, reopened: portableSnapshot(state.project, state.toolLibrary) }, null, 2))
        const reopened = await regenerate(d, 'Reopen and recompute contour')
        await consoleReadback(d, 'reopened-console.json')
        await d.page.locator('.tree-setup-name').first().click()
        await d.page.getByTestId('mode-tab-toolpath').click()
        await capture(d, 'reopened.png')
        return await simulateAndVerify(d, previous.saved, reopened, previous.readback.resultText, previous.posts)
      }
      await d.newProject()
      await d.step('Name project 09 Nested kit sheet', async p => {
        await p.getByTestId('tree-name-project').dblclick()
        await p.getByTestId('tree-rename-input').fill('09 Nested kit sheet')
        await p.getByTestId('tree-rename-input').press('Enter')
      }, s => s.project.name === '09 Nested kit sheet' && s.project.machine.id === 'default-machine')
      await d.page.getByRole('button', { name: 'Application settings', exact: true }).click()
      await d.step('Use exact sheet dimensions without stock padding', async p => {
        const input = p.locator('.settings-modal .mform-row').filter({ hasText: /^Default stock padding/ }).locator('input')
        await input.fill('0'); await input.press('Tab')
      }, s => s.appSettings.defaultStockPaddingXYMm === 0)
      await d.page.locator('.settings-modal .modal-close-btn').click()
      await d.importTools('examples/tools/starter-tools-metric.json')
      await d.page.getByTestId('tree-new-nest-geo').click()
      for (const name of Object.keys(sourceFiles())) {
        const before = (await d.readState()).project.geometry.length
        await d.step(`Add ${name} to Nesting`, async p => {
          const chooser = p.waitForEvent('filechooser')
          await p.getByRole('button', { name: 'Add part...', exact: true }).click()
          await (await chooser).setFiles(path.join(PART, name))
        }, s => s.project.geometry.length === before + 1 && s.project.geometry.at(-1).loops.length === 1)
        if (await d.page.getByTestId('nest-part-pick-done').count()) await d.page.getByTestId('nest-part-pick-done').click()
      }
      await d.page.getByTestId('nest-part-name-fallback').locator('summary').click()
      for (const name of ['toe-clamp', 'soft-jaw']) {
        const row = d.page.locator('.nest-part-row').filter({ hasText: name })
        await row.locator('input[type=checkbox]').check()
        await row.locator('input.nest-part-qty').fill('2'); await row.locator('input.nest-part-qty').press('Tab')
      }
      for (const box of await d.page.locator('.nest-part-check').all()) await box.check()
      while (await d.page.getByRole('button', { name: 'Orientation free', exact: true }).count())
        await d.page.getByRole('button', { name: 'Orientation free', exact: true }).first().click()
      await d.page.locator('.mform-row').filter({ hasText: /^Solver/ }).locator('select').selectOption('fixSheet-exact')
      for (const [label, value] of [['Sheet width', 290], ['Sheet height', 190], ['Thickness (Z)', 3], ['Part gap', 8], ['Sheet margin', 8]])
        await field(d.page, label, value, '.mform-row')
      await d.page.locator('.mform-row').filter({ hasText: /^Rotation/ }).locator('select').selectOption('ninety')
      const packed = await d.step('Calculate seven kit outlines on one sheet', p => p.getByRole('button', { name: 'Calculate', exact: true }).click(),
        s => s.project.nests?.[0]?.placements.length > 0 && s.project.nests[0].computeTimeMs !== undefined && !s.project.nests[0].needsRecompute,
        { timeoutMs: 300_000 })
      const nest = packed.project.nests[0]
      const resultText = await d.page.locator('.nest-result').innerText()
      writeFileSync(d.output('nest-readback.json'), JSON.stringify({ nest, geometry: packed.project.geometry, resultText }, null, 2))
      await d.page.screenshot({ path: d.output('nest-result.png') })
      assert.equal(nest.placements.length, 7, `Incomplete production nest: ${resultText}`)
      assert.deepEqual(nest.unplaced, [])
      await d.step('Accept the complete nest', p => p.getByRole('button', { name: 'Accept', exact: true }).click(), async s =>
        s.project.nests[0].placements.length === 7 && !await d.page.locator('.nest-modal').count())
      await capture(d, 'model.png')
      // All Parts intentionally excludes nest seeds. Explode is the production
      // route to one contour operation on seven independent, baked placements.
      // Keep the original nest readback so its packing remains reviewable.
      const exploded = await d.step('Explode seven placements for one All Parts contour', p => p.getByTestId('nest-explode').click(), s =>
        !s.project.nests?.length && s.project.geometry.length === 7 && s.project.geometry.every(g => !g.ownerNestId && g.stockId === nest.boundStockId))
      const stock = exploded.project.sceneStock.fixedStocks.find(s => s.id === nest.boundStockId)
      assert.ok(stock)
      assert.deepEqual([stock.width, stock.height, stock.depth, stock.position.x, stock.position.y, stock.position.z], [290, 190, 3, 0, 0, 0])
      await d.page.getByRole('button', { name: 'Add setup', exact: true }).click()
      await d.page.locator('.wcs-stock-select').selectOption(stock.id)
      await d.step('Create sheet setup', p => p.getByRole('button', { name: 'Create Setup', exact: true }).click(), s => s.project.setups[0]?.wcs.stockId === stock.id)
      await d.page.locator('.tree-setup-name').first().click()
      const holdingNote = 'Secure the full sheet to a spoilboard with tape and glue. Four tabs per outline retain all seven cutouts. Cut the tabs after machining and sand the stubs; these thin profiles are a nesting lesson, not functional clamps, jaws or gears.'
      await d.step('Record sheet workholding and tab removal', async p => {
        await p.getByTestId('setup-holding-method').selectOption('tape_glue')
        await p.getByTestId('setup-holding-note').fill(holdingNote)
        await p.getByTestId('setup-holding-note').press('Tab')
      }, s => s.project.setups[0].notes === holdingNote && s.project.setups[0].holdingMethod === 'tape_glue')
      await d.page.getByRole('button', { name: 'Add operation', exact: true }).click()
      await d.page.locator('.op-type-card').filter({ hasText: /^2D Contour/ }).click()
      await tab(d.page, 'Tool')
      await d.page.locator('.op-tool-row').filter({ hasText: '3 mm flat end mill' }).click()
      await tab(d.page, 'Geometry')
      await d.page.getByTestId('op-geometry-select').selectOption('__all__')
      await d.page.getByRole('button', { name: /^All loops/ }).click()
      await tab(d.page, 'Passes')
      await field(d.page, 'Stepdown', 1)
      await tab(d.page, 'Linking')
      await d.page.getByTestId('contour-tabs-enabled').check()
      for (const [label, value] of [['Tab width', 4], ['Tab height', 1], ['Tab count', 4]]) await field(d.page, label, value)
      await d.page.getByTestId('contour-tab-shape').selectOption('triangular')
      await tab(d.page, 'Heights')
      const expand = d.page.getByRole('button', { name: /^Expand Bottom.*height$/i })
      if (await expand.count()) await expand.click()
      await d.page.getByTestId('contour-height-mode').selectOption('through_stock')
      await field(d.page, 'Past stock bottom', 0.2)
      await d.step('Create one tabbed contour for all seven outlines', p => p.getByTestId('op-create').click(), s => {
        const op = s.project.setups[0].operations[0]
        return op?.type === 'contour_2d' && op.params.geometryId === '__all__' && op.params.loopIds.length === 7 && op.params.tabs === true
      })
      await regenerate(d, 'Compute built contour')
      await consoleReadback(d, 'built-console.json')
      await d.page.locator('.tree-setup-name').first().click()
      await d.page.getByTestId('mode-tab-toolpath').click()
      await capture(d, 'toolpaths.png')
      const saved = await d.saveAndReopen('nested-kit-sheet.camproject')
      watch(d.page)
      await d.page.setViewportSize({ width: 1920, height: 1080 })
      assert.ok((await d.readState()).project.setups.every(s => s.operations.every(o => o.status === 'ready')), 'Saved toolpaths must be current immediately on Open')
      const reopened = await regenerate(d, 'Reopen and recompute contour')
      await consoleReadback(d, 'reopened-console.json')
      await d.page.locator('.tree-setup-name').first().click()
      await d.page.getByTestId('mode-tab-toolpath').click()
      await capture(d, 'reopened.png')
      await d.page.getByTestId('mode-tab-postprocess').click()
      await d.page.getByTestId('post-definition-select').click()
      const dialects = await d.page.getByRole('listbox').getByRole('option').allTextContents()
      await d.page.keyboard.press('Escape')
      const posts = []
      for (const dialect of dialects) {
        await d.page.getByTestId('post-definition-select').click()
        await d.page.getByRole('listbox').getByRole('option', { name: dialect, exact: true }).click()
        await d.step(`Post ${dialect}`, p => p.getByRole('button', { name: 'Preview', exact: true }).click(), async s =>
          s.project.setups[0].operations[0].status === 'ready' && /G0?[0123]/.test(await d.page.getByTestId('post-gcode-preview').innerText()))
        const code = await d.page.getByTestId('post-gcode-preview').innerText()
        assert.doesNotMatch(code, /\bERROR\b/)
        writeFileSync(d.output(`nested-kit-sheet-${dialect.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.nc`), code)
        posts.push({ dialect, lines: code.split('\n').length })
        await d.page.getByRole('button', { name: 'Properties', exact: true }).click()
      }
      assert.equal(posts.length, 5)
      writeFileSync(d.output('posts.json'), JSON.stringify(posts, null, 2))
      await d.page.locator('.post-modal').getByRole('button', { name: 'Cancel', exact: true }).click()
      await consoleReadback(d, 'posted-console.json')
      return await simulateAndVerify(d, saved, reopened, resultText, posts)
    } catch (error) {
      writeFileSync(d.output('failure-dom.txt'), await d.page.locator('body').innerText())
      throw error
    } finally { writeFileSync(d.output('browser-console.json'), JSON.stringify(browserEvents, null, 2)) }
  })
}
if (isMain(import.meta.url)) await buildNestedKitSheet()
