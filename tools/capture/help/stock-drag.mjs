import fs from 'node:fs'
import sharp from 'sharp'
import { chromium } from 'playwright'
import { withViteCaptureServer, dismissMachineModal, CHROMIUM_CAPTURE_ARGS } from '../lib/harness.mjs'
import { HELP_EVIDENCE } from './evidence-root.mjs'
const dir = HELP_EVIDENCE + '/stock-drag'
fs.mkdirSync(dir, { recursive: true })
await withViteCaptureServer({ port: 62498, repoRoot: process.cwd(), timeoutMs: 120000 }, async ({ baseUrl }) => {
  const browser = await chromium.launch({ headless: true, args: CHROMIUM_CAPTURE_ARGS })
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => !!window.__camStore)
    await dismissMachineModal(page)
    await page.getByTestId('stock-add-fixed').click()
    await page.waitForTimeout(600)
    await page.getByTestId('fixed-stock-gizmo-btn').first().click()
    await page.evaluate(() => window.__cncViewport.fitAll())
    await page.waitForTimeout(1200)
    const facts = await page.evaluate(() => {
      const s = window.__camStore.getState(), stock = s.project.stocks.find(st => st.mode === 'explicit')
      const rect = document.querySelector('.viewport-canvas').getBoundingClientRect()
      const p = window.__cncViewport.worldToScreen(stock.position.x, stock.position.y, stock.position.z)
      const q = window.__cncViewport.worldToScreen(stock.position.x + 10, stock.position.y, stock.position.z)
      return { stock, center: { x: rect.left + p.x, y: rect.top + p.y }, xAxis: { x: q.x - p.x, y: q.y - p.y } }
    })
    const len = Math.hypot(facts.xAxis.x, facts.xAxis.y)
    let moved = false
    for (const distance of [30, 45, 60, 75]) {
      const dx = facts.xAxis.x / len, dy = facts.xAxis.y / len
      await page.mouse.move(facts.center.x + dx * distance, facts.center.y + dy * distance)
      await page.mouse.down()
      await page.mouse.move(facts.center.x + dx * (distance + 35), facts.center.y + dy * (distance + 35), { steps: 6 })
      await page.waitForTimeout(300)
      const position = await page.evaluate(id => window.__camStore.getState().project.stocks.find(st => st.id === id)?.position, facts.stock.id)
      if (position && JSON.stringify(position) !== JSON.stringify(facts.stock.position)) {
        const png = `${dir}/stock-gizmo-drag.png`
        await page.screenshot({ path: png, animations: 'disabled' })
        await sharp(png).webp({ quality: 88 }).toFile('public/help/stocks-auto-fixed/stock-gizmo-drag.webp')
        fs.writeFileSync(`${dir}/readback.json`, JSON.stringify({ capturedAt: new Date().toISOString(), before: facts.stock.position, duringDrag: position, pointerHeld: true }, null, 2))
        moved = true
      }
      await page.mouse.up()
      if (moved) break
    }
    if (!moved) { await page.screenshot({ path: `${dir}/FAILED.png` }); throw new Error('No stock position change read back during gizmo drag') }
  } finally { await browser.close() }
})
