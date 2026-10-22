import { isMain } from '../../lib/is-main.mjs';
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export const CHANNEL_THRESHOLD = 24
export const AREA_THRESHOLD = 0.001
export function measurePixels(before, after, channels = 3) {
  if (before.length !== after.length || before.length % channels) throw new Error('Mismatched raster buffers')
  let changed = 0, sum = 0
  const mask = Buffer.alloc(before.length)
  for (let i = 0; i < before.length; i += channels) {
    let max = 0
    for (let c = 0; c < channels; c++) { const d = Math.abs(before[i + c] - after[i + c]); sum += d; max = Math.max(max, d) }
    if (max > CHANNEL_THRESHOLD) { changed++; mask[i] = 255; if (channels > 2) mask[i + 2] = 120 }
  }
  return { changedPixels: changed, changedFraction: changed / (before.length / channels), meanAbsoluteDifference: sum / before.length, mask }
}
const hash = p => createHash('sha256').update(fs.readFileSync(p)).digest('hex')
const esc = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;')

export async function compareAll() {
  const root = 'src/tests/evidence/WO-2491'
  const run = JSON.parse(fs.readFileSync(`${root}/run.json`, 'utf8'))
  const manifestPath = 'public/help/capture-manifest.json'
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const sourceCommit = run.sourceCommit
  const topics = new Map(), results = []
  const selected = new Set(process.argv.slice(2).filter(arg => arg !== '--only'))
  fs.mkdirSync(`${root}/sheets`, { recursive: true })
  fs.mkdirSync(`${root}/difference`, { recursive: true })
  fs.mkdirSync(`${root}/after`, { recursive: true })
  for (const entry of manifest.images) {
    if (process.argv.includes('--only') && !selected.has(entry.topic + '/' + entry.slot)) {
      const record = { ...entry.captureRecord }
      const rows = topics.get(entry.topic) ?? []
      if (record.changed) rows.push(record)
      topics.set(entry.topic, rows)
      results.push(record)
      continue
    }
    const file = entry.path + entry.slot + '.webp'
    const originalRoute = entry.generatorCmd
    const routes = {
      'stock-gizmo-drag': 'node tools/capture/help/stock-drag.mjs',
      'control-overview': 'node tools/capture/help/control.mjs --trace-only',
      'connect-flow': 'node tools/capture/help/control.mjs',
      'jog-zero': 'node tools/capture/help/control.mjs',
      'run-job': 'node tools/capture/help/control.mjs --trace-only',
      'tree-folders': 'node tools/capture/help/folder.mjs',
      'scrub-preview': 'node tools/capture/help/route.mjs WO-2130 walk.mjs step && node tools/capture/help/fix-pictures.mjs section-at-z',
      'face-pick': 'node tools/capture/help/route.mjs WO-2130 walk.mjs ops && node tools/capture/help/fix-pictures.mjs face-edge-selection',
      'compare-view': 'node tools/capture/help/route.mjs WO-2130 walk.mjs cleanup && node tools/capture/help/fix-pictures.mjs geometry-cleanup',
      'boolean-dialog': 'node tools/capture/help/route.mjs WO-2130 walk.mjs model && node tools/capture/help/fix-pictures.mjs boolean-mesh-model',
      'projection-picker': 'node tools/capture/help/route.mjs WO-2130 walk.mjs stl && node tools/capture/help/fix-pictures.mjs import-stl',
      'badge-crops': 'node tools/capture/help/route.mjs WO-2130 walk.mjs badges model && node tools/capture/help/fix-pictures.mjs provenance-badges',
      'engine-comparison': 'node tools/capture/help/route.mjs WO-2135 walk.mjs 62502 --only sim && node tools/capture/help/fix-pictures.mjs sim-engines',
      'carved-stock': 'node tools/capture/help/route.mjs WO-2135 walk.mjs 62502 --only sim && node tools/capture/help/fix-pictures.mjs stock-simulation',
      'playback-bar': 'node tools/capture/help/route.mjs WO-2135 walk.mjs 62502 --only sim && node tools/capture/help/fix-pictures.mjs simulation-playback',
      'constraint-buttons': 'node tools/capture/help/route.mjs WO-2131 capture.mjs constraint-buttons && node tools/capture/help/fix-pictures.mjs sketch-constraints',
    }
    const route = (entry.topic === 'contour' ? 'node tools/capture/help/missing-routes.mjs --contour-only' : entry.topic === 'chamfer-op' ? 'node tools/capture/help/missing-routes.mjs --extras' : routes[entry.slot]) ?? (/none in this repository|sharp extract/.test(originalRoute)
      ? 'node tools/capture/help/missing-routes.mjs' + (['contour', 'pocket', 'face-op', 'adaptive-clearing', 'adaptive-linking'].includes(entry.topic) ? '' : ' --extras')
      : originalRoute.replace(/node src\/tests\/evidence\/(WO-\d+)\/([\w-]+\.mjs)/g, 'node tools/capture/help/route.mjs $1 $2').replaceAll('<port>', '62492'))
    const before = `${root}/before/${entry.topic}/${entry.slot}.webp`
    const after = `${root}/after/${entry.topic}/${entry.slot}.webp`
    const fresh = fs.existsSync(file) && fs.statSync(file).mtimeMs >= Date.parse(run.startedAt)
    const previous = entry.captureRecord?.status === 'captured' && entry.captureRecord.sourceCommit === sourceCommit && fs.existsSync(after)
    const recaptured = fresh || previous
    const record = { topic: entry.topic, slot: entry.slot, file, status: recaptured ? 'captured' : 'route-failed', sourceCommit, route, capturedAt: fresh ? fs.statSync(file).mtime.toISOString() : previous ? entry.captureRecord.capturedAt : null }
    if (!recaptured) {
      // A route may delete its output before failing. Keep Help usable and mark
      // the missing capture explicitly; restoration is never counted as a shot.
      fs.copyFileSync(before, file)
      const oldTime = new Date(Date.parse(run.startedAt) - 1000)
      fs.utimesSync(file, oldTime, oldTime)
      entry.captureRecord = { ...record, attemptedAt: run.startedAt }
      results.push(record)
      continue
    }
    fs.mkdirSync(path.dirname(after), { recursive: true })
    if (fresh) fs.copyFileSync(file, after)
    const a = await sharp(before).metadata(), b = await sharp(after).metadata()
    // Contain BOTH complete frames on a common canvas; never extract a crop.
    const width = Math.max(a.width, b.width), height = Math.max(a.height, b.height)
    const raster = p => sharp(p).resize(width, height, { fit: 'contain', background: '#000' }).removeAlpha().raw().toBuffer()
    const score = measurePixels(await raster(before), await raster(after))
    Object.assign(record, { beforeDimensions: [a.width, a.height], afterDimensions: [b.width, b.height], sha256: hash(after), changedPixels: score.changedPixels, changedFraction: score.changedFraction, meanAbsoluteDifference: score.meanAbsoluteDifference, changed: a.width !== b.width || a.height !== b.height || score.changedFraction > AREA_THRESHOLD })
    const diff = `${root}/difference/${entry.topic}--${entry.slot}.png`
    await sharp(score.mask, { raw: { width, height, channels: 3 } }).png().toFile(diff)
    record.difference = diff
    record.before = before
    record.after = after
    if (record.changed && !fresh) fs.copyFileSync(after, file)
    if (!record.changed) {
      fs.copyFileSync(before, file)
      const oldTime = new Date(Date.parse(run.startedAt) - 1000)
      fs.utimesSync(file, oldTime, oldTime)
    }
    entry.captureRecord = { ...record, viewport: [1920, 1080], deviceScaleFactor: originalRoute.includes('--dpr=2') ? 2 : 1, theme: run.theme, scale: run.scale, approval: 'reviewed: whole-frame QA, WO-2491', retained: record.changed ? 'new capture' : 'committed picture (below threshold)' }
    entry.generatorCmd = route
    const rows = topics.get(entry.topic) ?? []
    if (record.changed) rows.push(record)
    topics.set(entry.topic, rows)
    results.push(record)
  }
  manifest.refresh = { workOrder: 'WO-2491', sourceCommit, startedAt: run.startedAt, channelThreshold: CHANNEL_THRESHOLD, areaThreshold: AREA_THRESHOLD, comparison: 'whole frame, both contained on common canvas; dimension changes always reviewed', approval: 'reviewed: whole-frame QA, WO-2491' }
  manifest.generated = run.startedAt.slice(0, 10)
  manifest.commit = sourceCommit
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  const order = [...topics.keys()].sort((a, b) => Number(b.startsWith('control-')) - Number(a.startsWith('control-')) || a.localeCompare(b))
  let html = '<!doctype html><meta charset="utf-8"><title>WO-2491 Help picture review</title><style>body{background:#12151b;color:#eee;font:16px Arial;margin:24px}img{width:100%}table{width:100%;table-layout:fixed}td{vertical-align:top}a{color:#8cf}details{margin:20px 0}p{max-width:1000px}</style><h1>WO-2491: Help pictures - verdict pending</h1><p>Control first. Each row shows the entire before and after picture and a magenta difference mask. Click a picture for full resolution. Threshold: max channel delta &gt;24/255 across &gt;0.1% of pixels. Dimension changes always require review. No approval is implied by this report.</p>'
  for (const topic of order) {
    const rows = topics.get(topic)
    if (!rows.length) continue
    const cells = []
    const cellW = 480, cellH = 270, labelH = 42
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]
      const label = Buffer.from(`<svg width="1440" height="42"><rect width="1440" height="42" fill="#202734"/><text x="8" y="27" font-size="17" font-family="Arial" fill="white">${esc(r.slot)}: BEFORE | AFTER | DIFFERENCE - ${(100 * r.changedFraction).toFixed(3)}% changed</text></svg>`)
      const top = i * (cellH + labelH)
      cells.push({ input: label, left: 0, top })
      for (const [c, p] of [r.before, r.after, r.difference].entries()) cells.push({ input: await sharp(p).resize(cellW, cellH, { fit: 'contain', background: '#101217' }).png().toBuffer(), left: c * cellW, top: top + labelH })
    }
    const sheet = `${root}/sheets/${topic}.png`
    await sharp({ create: { width: 1440, height: rows.length * (cellH + labelH), channels: 3, background: '#101217' } }).composite(cells).png().toFile(sheet)
    html += `<details open><summary>${esc(topic)} (${rows.length} changed)</summary><img src="sheets/${topic}.png"><table><tr><th>Before</th><th>After</th><th>Difference</th></tr>`
    for (const r of rows) html += '<tr>' + [r.before, r.after, r.difference].map(p => `<td><a href="${p.slice(root.length + 1)}"><img src="${p.slice(root.length + 1)}"></a></td>`).join('') + '</tr>'
    html += '</table></details>'
  }
  html += '<h2>Unchanged</h2><p>' + results.filter(r => r.status === 'captured' && !r.changed).map(r => esc(r.topic + '/' + r.slot)).join(', ') + '</p><h2>Routes needing repair</h2><ul>' + results.filter(r => r.status !== 'captured').map(r => `<li>${esc(r.topic + '/' + r.slot)}</li>`).join('') + '</ul>'
  fs.writeFileSync(`${root}/review.html`, html)
  fs.writeFileSync(`${root}/scores.json`, JSON.stringify({ ...manifest.refresh, images: results }, null, 2) + '\n')
  console.log(JSON.stringify({ total: results.length, captured: results.filter(r => r.status === 'captured').length, changed: results.filter(r => r.changed).length, unchanged: results.filter(r => r.status === 'captured' && !r.changed).length, failed: results.filter(r => r.status !== 'captured').map(r => r.topic + '/' + r.slot) }, null, 2))
}
if (isMain(import.meta.url)) await compareAll()
