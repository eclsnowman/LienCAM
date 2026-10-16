// WO-2848 (alpha.2 G8): turn this run's P2 candidates (WIKI_GAPS_EVIDENCE) into
// the Help pictures the WO-2710 / WO-2714 manifest records name, at native
// size, WebP q88 - the same conversion those orders published with. Only a
// candidate written after run.json's startedAt is used. g8-compare.mjs then
// keeps the visibly changed ones; g8-records.mjs re-points their records.
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'

const evidence = process.env.WIKI_GAPS_EVIDENCE || 'src/tests/evidence/WO-2848/p2'
const run = JSON.parse(fs.readFileSync('src/tests/evidence/WO-2848/run.json', 'utf8'))
const manifest = JSON.parse(fs.readFileSync('public/help/capture-manifest.json', 'utf8'))
let failed = 0
for (const entry of manifest.images) {
  const record = entry.captureRecord
  if (!['WO-2710', 'WO-2714'].includes(record?.order)) continue
  const candidate = path.join(evidence, 'candidates', path.basename(record.candidate))
  if (!fs.existsSync(candidate) || fs.statSync(candidate).mtimeMs < Date.parse(run.startedAt)) {
    console.error('NOT SHOT IN THIS RUN:', candidate)
    failed++
    continue
  }
  fs.writeFileSync(record.file, await sharp(candidate).webp({ quality: 88 }).toBuffer())
  console.log(candidate, '->', record.file)
}
process.exitCode = failed ? 1 : 0
