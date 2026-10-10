// Replacement routes for pictures whose original LienCNC capture tool is absent.
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { chromium } from 'playwright'
import { withViteCaptureServer, dismissMachineModal, CHROMIUM_CAPTURE_ARGS } from '../lib/harness.mjs'
import { demoProject } from './demo-project.mjs'
const dir = 'src/tests/evidence/WO-2491/additional'
fs.mkdirSync(dir, { recursive: true })
const results = []
const contourOnly = process.argv.includes('--contour-only')
await withViteCaptureServer({ port: Number(process.env.CAPTURE_PORT_BASE ? Number(process.env.CAPTURE_PORT_BASE) + 4 : 62496), repoRoot: process.cwd(), timeoutMs: 120000 }, async ({ baseUrl }) => {
  const browser = await chromium.launch({ headless: true, args: CHROMIUM_CAPTURE_ARGS })
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })
    const shot = async (topic, slot) => {
      const png = `${dir}/${topic}--${slot}.png`
      fs.rmSync(png, { force: true })
      await page.mouse.move(1, 1)
      await page.screenshot({ path: png, animations: 'disabled' })
      let image = sharp(png)
      if (['adaptive-clearing', 'contour', 'chamfer-op', 'adaptive-linking'].includes(topic)) {
        image = image.extract({ left: 280, top: 46, width: 1380, height: 980 })
      }
      if (topic === 'adaptive-linking') {
        const wide = await image.resize(800, 568).png().toBuffer()
        const detail = await sharp(png).extract({ left: 650, top: 300, width: 620, height: 500 }).resize(800, 568).png().toBuffer()
        image = sharp({ create: { width: 1612, height: 568, channels: 3, background: '#101217' } }).composite([{ input: wide, left: 0, top: 0 }, { input: detail, left: 812, top: 0 }])
      }
      await image.webp({ quality: 88 }).toFile(`public/help/${topic}/${slot}.webp`)
      results.push({ topic, slot, capturedAt: new Date().toISOString(), scene: await page.evaluate(() => { const s = window.__camStore.getState(); return { mode: s.viewer.mode, setup: s.activeSetupId, operation: s.activeOperationId } }) })
      console.log('captured', topic, slot)
    }
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => !!window.__camStore)
    await page.evaluate(() => {
      const s = window.__camStore.getState()
      s.addMachineToLibrary({ ...s.project.machine, id: 'help-demo-machine', name: 'Help demo router' })
      s.setMachineChoiceRequired(true)
    })
    await page.locator('.modal-backdrop').first().waitFor()
    if (!contourOnly) await shot('machine-choice', 'machine-prompt')
    await dismissMachineModal(page)
    await page.setInputFiles('input[type="file"][accept=".camproject"]', path.resolve(demoProject))
    // WO-2698: choosing the prompt's machine left unsaved work, so Open asks
    // Save / Discard / Cancel first. The operator discards the empty project.
    const discard = page.getByTestId('confirm-dialog-alt')
    await discard.waitFor({ timeout: 5000 }).then(() => discard.click(), () => {})
    await page.waitForTimeout(500)
    await page.getByTestId('project-open-indicator').waitFor({ state: 'detached', timeout: 300000 })
    const opened = await page.evaluate(() => window.__camStore.getState().project.setups.length)
    if (!opened) throw new Error('Demo project did not open')
    await dismissMachineModal(page)
    const toolpathScenes = contourOnly ? [['contour','toolpath','contour_2d']] : process.argv.includes('--extras') ? [] : [['contour','toolpath','contour_2d'], ['pocket','toolpath','pocket_2d'], ['face-op','toolpath','face'], ['adaptive-clearing','engagement','adaptive_clearing_2d'], ['adaptive-linking','links','adaptive_clearing_2d']]
    for (const [topic, slot, type] of toolpathScenes) {
      try {
        const facts = await page.evaluate(async (type) => {
          const s = window.__camStore.getState()
          const setup = s.project.setups.find(st => st.operations.some(o => o.type === type))
          const op = setup?.operations.find(o => o.type === type)
          if (!op) throw new Error('No example operation: ' + type)
          s.setActiveSetup(setup.id)
          s.setViewerMode('toolpath')
          s.setActiveOperation(op.id)
          await s.computeOperationToolpath(setup.id, op.id)
          const fresh = window.__camStore.getState().project.setups.find(st => st.id === setup.id).operations.find(o => o.id === op.id)
          window.__camStore.getState().setActiveOperation(op.id)
          return { status: fresh.status, moves: fresh.toolpathMoves?.length ?? 0, type: fresh.type, name: fresh.name, activeOperationId: window.__camStore.getState().project.activeOperationId }
        }, type)
        if (facts.status !== 'ready' || facts.moves === 0) throw new Error('Toolpath not ready: ' + JSON.stringify(facts))
        await page.evaluate(() => window.__cncViewport?.fitToolpathPreservingView?.())
        await page.waitForTimeout(1200)
        await shot(topic, slot)
        results.at(-1).facts = facts
      } catch (error) { results.push({ topic, slot, error: String(error) }); console.log('FAILED', topic, String(error)) }
    }
    if (contourOnly) {
      if (results.some(r => r.error)) throw new Error(JSON.stringify(results))
      return
    }
    // Retain the source-picker's own selected loop highlight in the app.
    try {
      await page.evaluate(() => { const s = window.__camStore.getState(); s.setViewerMode('setup'); const st = s.project.setups.find(st => st.operations.some(o => o.type === 'contour_2d')); const op = st.operations.find(o => o.type === 'contour_2d'); s.setActiveSetup(st.id); s.openEditOperation(st.id, op.id) })
      await page.getByTestId('op-modal-panel').waitFor({ timeout: 10000 })
      await page.getByRole('button', { name: 'Geometry', exact: true }).click()
      await page.getByTestId('op-loop-pick-toggle').click()
      await page.getByTestId('op-loop-pick-banner').waitFor()
      await shot('operation-sources', 'loop-pick-highlight')
    } catch (error) { results.push({ topic: 'operation-sources', slot: 'loop-pick-highlight', error: String(error) }); console.log('FAILED', 'operation-sources', String(error)) }
    await page.evaluate(() => window.__camStore.getState().closeModal())
    await page.keyboard.press('Escape')
    // A single pre-drilled circular profile avoids the unrelated outside loops
    // in the large example project. It enters through the production DXF input.
    await page.getByTestId('geo-file-input').setInputFiles({ name: 'ThreadDemo.dxf', mimeType: 'application/dxf', buffer: Buffer.from('0\nSECTION\n2\nENTITIES\n0\nCIRCLE\n8\nThread hole\n10\n20\n20\n20\n40\n2.5\n0\nENDSEC\n0\nEOF\n') })
    await page.waitForTimeout(2000)
    const importedStock = page.getByTestId('import-stock-choice-auto')
    if (await importedStock.count()) await importedStock.click()
    await page.evaluate(() => window.__camStore.getState().closeModal())
    for (const [topic, slot, type] of [['thread-milling', 'helix', 'thread_mill'], ['chamfer-op', 'result', 'chamfer']]) {
      try {
        await page.evaluate(async (type) => {
          const s = window.__camStore.getState(), st = s.project.setups[0]
          const tool = { ...s.toolLibrary.find(t => t.id === 't-flat'), id: 'help-' + type, name: type === 'thread_mill' ? 'Help thread mill' : 'Help 90 deg V-bit', type: type === 'thread_mill' ? 'thread_mill' : 'v_bit', diameter: type === 'thread_mill' ? 3 : 6, angleFromAxisDeg: 45, threadPitch: 1.5, neckDiameter: 2, threadToothHeight: 1 }
          s.addTool(tool)
          s.setActiveSetup(st.id); s.setViewerMode('setup'); s.openModal('new-operation')
        }, type)
        await page.getByTestId('op-modal-panel').waitFor()
        const tab = name => page.locator('.op-modal-tab').filter({ hasText: new RegExp('^' + name + '$') }).click()
        await tab('Type & Name')
        await page.locator('.op-type-card').filter({ has: page.locator('.op-type-name', { hasText: type === 'thread_mill' ? /^Thread Mill$/ : /^2D Chamfer$/ }) }).click()
        await tab('Tool')
        await page.locator('.op-tool-row').filter({ hasText: type === 'thread_mill' ? 'Help thread mill' : 'Help 90 deg V-bit' }).click()
        await tab('Geometry')
        const geo = page.getByTestId('op-geometry-select').first()
        const value = await geo.evaluate((el, text) => [...el.options].find(o => o.textContent.includes(text))?.value, type === 'thread_mill' ? 'ThreadDemo' : 'BootL')
        if (!value) throw new Error('Example geometry missing')
        await geo.selectOption(value)
        const all = page.getByRole('button', { name: /^All loops/ }).first()
        if (await all.count()) await all.click()
        if (type === 'thread_mill' && !await geo.evaluate(el => el.selectedOptions[0].textContent.includes('ThreadDemo'))) {
          await page.getByTestId('op-loops-clear').click()
          const holes = page.locator('.op-loop-check').filter({ has: page.locator('.tree-loop-type-hole') })
          const index = await holes.evaluateAll(rows => rows.map((r, i) => ({ i, area: parseFloat(r.querySelector('.op-loop-area').textContent.replaceAll(',', '')) })).filter(r => r.area > 10).sort((a, b) => a.area - b.area)[0]?.i)
          if (index === undefined) throw new Error('No suitable small pre-cleared hole')
          await holes.nth(index).locator('input[type="checkbox"]').check()
        }
        await tab('Passes')
        await page.locator('.modal-footer button').filter({ hasText: /Create Operation/ }).last().click({ timeout: 10000 })
        await page.getByTestId('op-modal-panel').waitFor({ state: 'detached' })
        const facts = await page.evaluate(async (type) => {
          const s = window.__camStore.getState(), st = s.project.setups.find(st => st.operations.some(o => o.type === type && o.toolId === 'help-' + type)), op = st.operations.findLast(o => o.type === type && o.toolId === 'help-' + type)
          s.setActiveOperation(op.id); s.setViewerMode('toolpath')
          await s.computeOperationToolpath(st.id, op.id)
          const fresh = window.__camStore.getState().project.setups.find(x => x.id === st.id).operations.find(o => o.id === op.id)
          return { status: fresh.status, moves: fresh.toolpathMoves?.length ?? 0, error: fresh.error }
        }, type)
        if (facts.status !== 'ready' || !facts.moves) throw new Error(JSON.stringify(facts))
        await page.evaluate(() => window.__cncViewport?.fitToolpathPreservingView?.())
        await page.waitForTimeout(1200)
        await shot(topic, slot)
        results.at(-1).facts = facts
      } catch (error) {
        results.push({ topic, slot, error: String(error) }); console.log('FAILED', topic, String(error))
        await page.screenshot({ path: `${dir}/${topic}-FAILED.png` })
        await page.evaluate(() => window.__camStore.getState().closeModal())
      }
    }
  } finally { await browser.close(); fs.writeFileSync(`${dir}/results${contourOnly ? '-contour' : process.argv.includes('--extras') ? '-extras' : ''}.json`, JSON.stringify(results, null, 2) + '\n') }
})
