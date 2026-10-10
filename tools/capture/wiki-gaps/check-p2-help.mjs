// WO-2710 / WO-2714 integration proof: render the accepted pictures in production Help.
// Reuses dist; does not re-shoot or publish any candidate picture.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { preview, launch, openApp, EVIDENCE, buildIdentity } from './p2-lib.mjs'
import { captureProvenancedScreenshot } from '../lib/provenance.mjs'

const control = process.argv.includes('--controls')
const order = control ? 'WO-2714' : 'WO-2710'
const selected = control ? ['machine-definition-catalog', 'control-jog-zero', 'control-run-job',
  'probing-tab', 'control-tool-setter', 'control-simulator'] : ['adaptive-3d', 'parallel-3d', 'probe-tool', 'vcarve',
  'reference-image-calibration', 'settings-user-data']
const titles = {
  'machine-definition-catalog': 'The Machine definition page',
  'control-jog-zero': 'Jogging and setting zero', 'control-run-job': 'Running a job',
  'probing-tab': 'The Probing tab', 'control-tool-setter': 'The fixed tool setter',
  'control-simulator': 'The in-app machine simulator',
  'adaptive-3d': '3D adaptive roughing', 'parallel-3d': '3D parallel finish',
  'probe-tool': 'Probe tools', vcarve: 'V-carving',
  'reference-image-calibration': 'Calibrating a reference image',
  'settings-user-data': 'Backing up your data',
}
const manifest = JSON.parse(fs.readFileSync('public/help/capture-manifest.json', 'utf8'))
const records = manifest.images.filter(e => e.captureRecord?.order === order)
assert.equal(records.length, 10)
const output = path.join(control ? 'src/tests/evidence/WO-2714' : EVIDENCE, 'help-rendered')
fs.mkdirSync(output, { recursive: true })
const buildId = buildIdentity('dist')
const server = await preview({ outDir: 'dist', port: 47219 })
let browser
const topics = []
try {
  browser = await launch()
  const h = await openApp(browser, server.baseUrl, {
    gap: 'Help integration', runId: order + '-help', buildId,
    route: 'node tools/capture/wiki-gaps/check-p2-help.mjs',
  })
  await h.goto()
  await h.chooseStarterMachine()
  await h.page.getByRole('button', { name: 'Help and troubleshooting', exact: true }).click()
  const article = h.tid('help-topic-content')
  for (const topic of selected) {
    const expected = records.filter(e => e.topic === topic)
    // Search the actual Help navigation; no app-store writes or hooks.
    await h.tid('help-search').fill(titles[topic])
    const button = h.tid(`help-topic-${topic}`)
    await button.click()
    await article.getByRole('heading', { name: titles[topic], exact: true }).waitFor()
    const images = article.locator('img')
    await images.first().waitFor({ state: 'attached' })
    assert.equal(await images.count(), manifest.images.filter(e => e.topic === topic).length, topic)
    const loaded = article.locator(expected.map(e => `img[src$="help/${topic}/${e.slot}.webp"]`).join(','))
    assert.equal(await loaded.count(), expected.length, topic)
    const figures = []
    for (const entry of expected) {
      const src = `/help/${topic}/${entry.slot}.webp`
      const image = article.locator(`img[src$="${src.slice(1)}"]`)
      await image.scrollIntoViewIfNeeded()
      await h.page.waitForFunction(src => {
        const image = document.querySelector(`[data-testid="help-topic-content"] img[src$="${src.slice(1)}"]`)
        return image?.complete && image.naturalWidth > 0
      }, src)
      const response = await h.page.request.get(server.baseUrl + src.slice(1))
      assert.equal(response.status(), 200, src)
      assert.equal(createHash('sha256').update(await response.body()).digest('hex'),
        entry.captureRecord.sha256, src)
      const alt = await image.getAttribute('alt')
      assert.ok(alt?.length > 0, src + ' alt')
      assert.equal(await image.locator('xpath=ancestor::figure').locator('figcaption').innerText(), alt)
      await image.locator('xpath=ancestor::figure').locator('figcaption').scrollIntoViewIfNeeded()
      const figureShot = await captureProvenancedScreenshot({
        page: h.page, outputPath: path.join(output, `${topic}-${entry.slot}.png`),
        provenance: () => image.evaluate(e => e.complete && e.naturalWidth > 0),
      })
      figures.push({ src, alt, screenshot: path.relative(process.cwd(), figureShot.outputPath),
        screenshotSha256: figureShot.hash, ...figureShot.sourceProvenance,
        dimensions: await image.evaluate(e => [e.naturalWidth, e.naturalHeight]) })
    }
    topics.push({ topic, figures, screenshot: figures[0].screenshot,
      screenshotSha256: figures[0].screenshotSha256 })
  }
  assert.deepEqual(h.errors, [])
  fs.writeFileSync(path.join(output, 'proof.json'), JSON.stringify({
    command: 'node tools/capture/wiki-gaps/check-p2-help.mjs' + (control ? ' --controls' : ''),
    served: 'Vite preview of npm run build output', buildId,
    viewport: [1920, 1080], topics, topicCount: topics.length,
    figureCount: topics.reduce((sum, t) => sum + t.figures.length, 0),
  }, null, 2) + '\n')
  console.log('PASS: 6 production Help topics; 10 loaded figures match their manifest hashes.')
} finally {
  await browser?.close()
  server.stop()
}
