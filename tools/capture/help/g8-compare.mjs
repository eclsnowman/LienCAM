// Release gate G8 (WO-2848): after the capture routes have re-shot the Help
// pictures and site media in place, keep ONLY the visibly changed ones.
//   node tools/capture/help/g8-compare.mjs [--base <ref>] [--evidence <dir>]
// Before = the file at the base ref (default: merge-base with main). After =
// the working-tree file, counted only if it was written after run.json's
// startedAt. Unchanged pictures (same threshold as WO-2491) get their base
// bytes back, byte-identical; changed ones stay and get a before/after/diff
// triple plus a row in the contact sheet. A picture no route re-shot in this
// run keeps its old bytes and is listed. Re-runnable: earlier verdicts persist.
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { execFileSync } from 'node:child_process'
import { measurePixels, CHANNEL_THRESHOLD, AREA_THRESHOLD } from './compare.mjs'

const argv = process.argv.slice(2)
const opt = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback }
const git = (...args) => execFileSync('git', args, { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 })
const root = opt('--evidence', 'src/tests/evidence/WO-2848')
const base = opt('--base', git('merge-base', 'HEAD', 'main').toString().trim())
const run = JSON.parse(fs.readFileSync(`${root}/run.json`, 'utf8'))
const runStart = Date.parse(run.startedAt)
const scratch = opt('--scratch', null)
const HEADER_ROWS = 45, HEADER_PIXELS = 300
const scoresPath = `${root}/scores.json`
const previous = fs.existsSync(scoresPath) ? Object.fromEntries(JSON.parse(fs.readFileSync(scoresPath, 'utf8')).images.map(r => [r.file, r])) : {}
const pairs = `${root}/pairs`
fs.mkdirSync(pairs, { recursive: true })

const tracked = git('ls-tree', '-r', '--name-only', base, '--', 'public/help', 'docs/media').toString().split('\n')
  .filter(f => /^public\/help\/.+\.webp$/.test(f) || /^docs\/media\/(hero\.webp|S\d+\.(png|webp)|SP\.png)$/.test(f))
const results = []
for (const file of tracked) {
  const before = git('show', `${base}:${file}`)
  const key = file.replace(/^public\/help\//, '').replace(/^docs\/media\//, 'media/').replace(/\.\w+$/, '').replaceAll('/', '--')
  const fresh = fs.existsSync(file) && fs.statSync(file).mtimeMs >= runStart
  if (!fresh) {
    const prior = previous[file]
    if (prior && prior.status !== 'not-reshot') { results.push(prior); continue }
    if (!fs.existsSync(file) || !fs.readFileSync(file).equals(before)) fs.writeFileSync(file, before)
    results.push({ file, key, status: 'not-reshot' })
    continue
  }
  const after = fs.readFileSync(file)
  const a = await sharp(before).metadata(), b = await sharp(after).metadata()
  // Contain BOTH complete frames on a common canvas; never extract a crop.
  const width = Math.max(a.width, b.width), height = Math.max(a.height, b.height)
  const raster = buf => sharp(buf).resize(width, height, { fit: 'contain', background: '#000' }).removeAlpha().raw().toBuffer()
  const score = measurePixels(await raster(before), await raster(after))
  // A whole frame whose header strip changed (e.g. About joined Settings and
  // Help, WO-2831) is a real UI change even when it stays under the area threshold.
  let headerPixels = 0
  if (width === 1920) for (let i = 0; i < HEADER_ROWS * width * 3; i += 3) if (score.mask[i]) headerPixels++
  const headerChanged = headerPixels >= HEADER_PIXELS
  const changed = a.width !== b.width || a.height !== b.height || score.changedFraction > AREA_THRESHOLD || headerChanged
  const record = { file, key, status: changed ? 're-shot' : 'unchanged', capturedAt: fs.statSync(file).mtime.toISOString(), beforeDimensions: [a.width, a.height], afterDimensions: [b.width, b.height], changedPixels: score.changedPixels, changedFraction: score.changedFraction, meanAbsoluteDifference: score.meanAbsoluteDifference, headerPixels, headerOnly: headerChanged && score.changedFraction <= AREA_THRESHOLD && a.width === b.width && a.height === b.height }
  if (changed) {
    record.before = `${pairs}/${key}.before.png`
    record.after = `${pairs}/${key}.after.png`
    record.difference = `${pairs}/${key}.diff.png`
    await sharp(before).png().toFile(record.before)
    await sharp(after).png().toFile(record.after)
    await sharp(score.mask, { raw: { width, height, channels: 3 } }).png().toFile(record.difference)
  } else {
    // Below the noise threshold: the committed picture stays, byte-identical.
    if (scratch) { fs.mkdirSync(scratch, { recursive: true }); fs.writeFileSync(path.join(scratch, key + path.extname(file)), after) }
    fs.writeFileSync(file, before)
    const old = new Date(runStart - 1000)
    fs.utimesSync(file, old, old)
    for (const ext of ['before', 'after', 'diff']) fs.rmSync(`${pairs}/${key}.${ext}.png`, { force: true })
  }
  results.push(record)
}
const changed = results.filter(r => r.status === 're-shot')
fs.writeFileSync(scoresPath, JSON.stringify({ workOrder: 'WO-2848', base, runStartedAt: run.startedAt, channelThreshold: CHANNEL_THRESHOLD, areaThreshold: AREA_THRESHOLD, headerRule: { rows: HEADER_ROWS, minChangedPixels: HEADER_PIXELS, applies: '1920-wide whole frames' }, comparison: 'whole frame, both contained on a common canvas; dimension changes always count; a changed header strip always counts', images: results }, null, 2) + '\n')

// Contact sheet: one PNG grid (BEFORE | AFTER | DIFFERENCE per row) + an HTML page.
const esc = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;')
const cellW = 480, cellH = 270, labelH = 36
if (changed.length) {
  const cells = []
  for (const [i, r] of changed.entries()) {
    const top = i * (cellH + labelH)
    cells.push({ input: Buffer.from(`<svg width="1440" height="${labelH}"><rect width="1440" height="${labelH}" fill="#202734"/><text x="8" y="24" font-size="16" font-family="Arial" fill="white">${esc(r.file)}: BEFORE | AFTER | DIFFERENCE - ${(100 * r.changedFraction).toFixed(2)}% changed, ${r.beforeDimensions.join('x')} -&gt; ${r.afterDimensions.join('x')}</text></svg>`), left: 0, top })
    for (const [c, p] of [r.before, r.after, r.difference].entries()) cells.push({ input: await sharp(p).resize(cellW, cellH, { fit: 'contain', background: '#101217' }).png().toBuffer(), left: c * cellW, top: top + labelH })
  }
  await sharp({ create: { width: 1440, height: changed.length * (cellH + labelH), channels: 3, background: '#101217' }, limitInputPixels: false }).composite(cells).png().toFile(`${root}/contact-sheet.png`)
}
const rel = p => path.relative(root, p).replaceAll('\\', '/')
let html = '<!doctype html><meta charset="utf-8"><title>WO-2848 G8 picture review</title><style>body{background:#12151b;color:#eee;font:15px Arial;margin:24px}img{width:100%}table{width:100%;table-layout:fixed}td{vertical-align:top}a{color:#8cf}h2{margin-top:32px}</style>'
html += `<h1>WO-2848 (alpha.2 G8): changed pictures - architect verdict pending</h1><p>Before = ${esc(base)}; after = frozen product, built-in simulator only. Threshold: max channel delta &gt;${CHANNEL_THRESHOLD}/255 across &gt;${AREA_THRESHOLD * 100}% of pixels; dimension changes always count. Click a picture for full size.</p>`
for (const r of changed.filter(r => !r.headerOnly)) html += `<h2>${esc(r.file)} - ${(100 * r.changedFraction).toFixed(2)}%</h2><table><tr><th>Before</th><th>After</th><th>Difference</th></tr><tr>${[r.before, r.after, r.difference].map(p => `<td><a href="${rel(p)}"><img src="${rel(p)}"></a></td>`).join('')}</tr></table>`
html += `<h2>Header-only changes (${changed.filter(r => r.headerOnly).length}): under the area threshold, header strip changed (About, WO-2831)</h2>`
for (const r of changed.filter(r => r.headerOnly)) html += `<h3>${esc(r.file)} - ${r.headerPixels} header pixels</h3><table><tr>${[r.before, r.after, r.difference].map(p => `<td><a href="${rel(p)}"><img src="${rel(p)}"></a></td>`).join('')}</tr></table>`
html += `<h2>Unchanged (${results.filter(r => r.status === 'unchanged').length})</h2><p>${results.filter(r => r.status === 'unchanged').map(r => esc(r.file)).join(', ')}</p>`
html += `<h2>Not re-shot - old picture kept (${results.filter(r => r.status === 'not-reshot').length})</h2><p>${results.filter(r => r.status === 'not-reshot').map(r => esc(r.file)).join(', ')}</p>`
fs.writeFileSync(`${root}/contact-sheet.html`, html)
console.log(JSON.stringify({ total: results.length, reshot: changed.length, unchanged: results.filter(r => r.status === 'unchanged').length, notReshot: results.filter(r => r.status === 'not-reshot').length, changed: changed.map(r => r.file) }, null, 2))
