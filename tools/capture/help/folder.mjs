import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { runCaptureHarness } from '../lib/harness.mjs'
import { demoProject } from './demo-project.mjs'
import { HELP_EVIDENCE } from './evidence-root.mjs'
const out = HELP_EVIDENCE + '/folder'
await runCaptureHarness({ port: Number(process.env.CAPTURE_PORT || 62499), outDir: out, viewport: { width: 1920, height: 1080 }, projectFile: path.resolve(demoProject) }, async ({ page, capture }) => {
  await page.evaluate(() => { const s = window.__camStore.getState(); s.setViewerMode('setup'); s.setActiveSetup(s.project.setups[0].id) })
  const setup = page.locator('.tree-setup').filter({ has: page.locator('.tree-setup-name', { hasText: /^Setup 1$/ }) }).first()
  await setup.getByRole('button', { name: 'New operation folder' }).click({ force: true })
  await page.keyboard.press('Enter')
  await page.waitForTimeout(500)
  const facts = await page.evaluate(() => {
    const s = window.__camStore.getState(), st = s.project.setups[0], f = st.operationFolders.at(-1), op = st.operations[1]
    s.setOperationFolderId(st.id, op.id, f.id)
    return { setupId: st.id, folderId: f.id, operationId: op.id }
  })
  await page.waitForTimeout(500)
  await capture('tree-folders.png', { provenance: p => p.evaluate(f => window.__camStore.getState().project.setups.find(st => st.id === f.setupId).operations.some(o => o.id === f.operationId && o.folderId === f.folderId), facts) })
  await sharp(`${out}/tree-folders.png`).webp({ quality: 88 }).toFile('public/help/operation-folders/tree-folders.webp')
  fs.writeFileSync(`${out}/facts.json`, JSON.stringify(facts, null, 2))
})
