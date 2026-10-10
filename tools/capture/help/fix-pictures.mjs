// Correct only the architect's named crops, using recorded production screenshots.
import sharp from 'sharp'
import fs from 'node:fs'
const root = 'src/tests/evidence/WO-2491/routes'
const only = new Set(process.argv.slice(2))
const crop = (lane, file, box) => sharp(`${root}/${lane}/screens/${file}.png`).extract(box).png().toBuffer()
const area = { left: 590, top: 280, width: 850, height: 710 }
const rows = [
  ['provenance-badges', 'badge-crops', async () => {
    const a = await crop('WO-2130', 'badges-02-edited', { left: 0, top: 185, width: 279, height: 50 })
    const b = await crop('WO-2130', 'boolean-02-result-row', { left: 0, top: 288, width: 279, height: 52 })
    return sharp({ create: { width: 570, height: 52, channels: 3, background: '#101217' } }).composite([{ input: a, left: 0, top: 0 }, { input: b, left: 291, top: 0 }]).png().toBuffer()
  }],
  ['stock-simulation', 'carved-stock', () => sharp(`${root}/WO-2135/screens/sim-09-3d-end.png`).png().toBuffer()],
  ['simulation-playback', 'playback-bar', () => sharp(`${root}/WO-2135/screens/sim-02-speed-flyout.png`).png().toBuffer()],
  ['sketch-constraints', 'constraint-buttons', () => crop('WO-2131', 'constraint-buttons', { left: 280, top: 46, width: 1640, height: 980 })],
  ['section-at-z', 'scrub-preview', () => crop('WO-2130', 'step-02-section-scrub', area)],
  ['face-edge-selection', 'face-pick', () => crop('WO-2130', 'ops-02-pick-face', { left: 590, top: 280, width: 850, height: 800 })],
  ['geometry-cleanup', 'compare-view', () => crop('WO-2130', 'cleanup-03-stl-projection-after', { left: 280, top: 280, width: 1380, height: 800 })],
  ['boolean-mesh-model', 'boolean-dialog', () => crop('WO-2130', 'boolean-01-dialog', { left: 1550, top: 60, width: 365, height: 375 })],
  ['import-stl', 'projection-picker', async () => {
    const a = await crop('WO-2130', 'stl-01-slice-plane', area)
    const b = await crop('WO-2130', 'stl-02-target-plane', { left: 590, top: 130, width: 1320, height: 860 })
    return sharp({ create: { width: 2182, height: 860, channels: 3, background: '#101217' } }).composite([{ input: a, left: 0, top: 0 }, { input: b, left: 862, top: 0 }]).png().toBuffer()
  }],
  ['stock-membership', 'membership-dropdown', () => sharp(`${root}/WO-2133/pictures/stock-membership__membership-dropdown.png`).png().toBuffer()],
  ['sim-engines', 'engine-comparison', async () => {
    const a = await crop('WO-2135', 'sim-09-3d-end', { left: 280, top: 46, width: 1380, height: 980 })
    const b = await crop('WO-2135', 'sim-07-heightmap', { left: 280, top: 46, width: 1380, height: 980 })
    const dd = await crop('WO-2135', 'sim-06-settings-engine', { left: 650, top: 485, width: 625, height: 185 })
    const cells = await Promise.all([a, b].map(buf => sharp(buf).resize(800, 568).png().toBuffer()))
    return sharp({ create: { width: 1612, height: 765, channels: 3, background: '#101217' } }).composite([
      { input: cells[0], left: 0, top: 0 }, { input: cells[1], left: 812, top: 0 },
      { input: dd, left: 493, top: 580 },
    ]).png().toBuffer()
  }],
]
for (const [topic, slot, build] of rows) {
  if (only.size && !only.has(topic)) continue
  const file = `public/help/${topic}/${slot}.webp`
  const buffer = await build()
  fs.rmSync(file, { force: true })
  await sharp(buffer).webp({ quality: 88 }).toFile(file)
  console.log(file, (await sharp(file).metadata()).width, (await sharp(file).metadata()).height)
}
