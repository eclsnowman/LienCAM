// WO-2848 (alpha.2 G8): for each WO-2709 / WO-2710 / WO-2714 Help picture that
// g8-compare.mjs kept as visibly changed, point its manifest capture record at
// this run's candidate and sidecar (source identity, route, viewport, app
// state), with the published bytes' hash. The order that first published the
// picture stays its owner; the approval says the re-shoot awaits the architect.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

// p2.mjs shot the WO-2710 / WO-2714 gaps; desktop.mjs shot WO-2709's G02.
const EVIDENCE = { 'WO-2709': 'src/tests/evidence/WO-2848/g02', 'WO-2710': 'src/tests/evidence/WO-2848/p2', 'WO-2714': 'src/tests/evidence/WO-2848/p2' }
const scores = JSON.parse(fs.readFileSync('src/tests/evidence/WO-2848/scores.json', 'utf8'))
const reshot = new Set(scores.images.filter(r => r.status === 're-shot').map(r => r.file))
const manifestPath = 'public/help/capture-manifest.json'
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const NOTE = 're-shot on the frozen alpha.2 tree by WO-2848 (G8); architect before/after verdict pending'
let updated = 0
for (const entry of manifest.images) {
  const old = entry.captureRecord
  if (!EVIDENCE[old?.order] || !reshot.has(old.file)) continue
  const candidate = path.posix.join(EVIDENCE[old.order], 'candidates', path.basename(old.candidate))
  const sidecar = JSON.parse(fs.readFileSync(candidate.replace(/\.png$/, '.json'), 'utf8'))
  const { gap, picture, bytes, ...fields } = sidecar
  // desktop.mjs records its route without the leading `node `; the manifest names commands.
  const route = sidecar.route.startsWith('node ') ? sidecar.route : `node ${sidecar.route}`
  entry.generatorCmd = route
  entry.captureRecord = {
    // As WO-2714 published: the sidecar first, then the record's own identity.
    ...old, ...fields, order: old.order, topic: old.topic, slot: old.slot, file: old.file, status: 'captured', candidate, route,
    sha256: createHash('sha256').update(fs.readFileSync(old.file)).digest('hex'),
    approval: old.approval.includes(NOTE) ? old.approval : `${old.approval}; ${NOTE}`,
    reshotBy: 'WO-2848', previousCandidate: old.previousCandidate ?? old.candidate,
  }
  void gap; void picture; void bytes
  updated++
}
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
console.log('re-pointed', updated, 'WO-2709/WO-2710/WO-2714 records')
