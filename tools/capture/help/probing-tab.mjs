// WO-2708 (staged for WO-2709): the two probing-tab Help pictures, re-shot on
// the app being captured and published only if shot in THIS run.
//   node tools/capture/help/probing-tab.mjs
// Shooting is WO-2709's own route (built-in simulator only, never a board):
//   tools/capture/wiki-gaps/desktop.mjs --only=G01,G02
// It lands with WO-2709; until then this route refuses by name.
// Manifest entries (generatorCmd = this command) belong to the release
// capture run: the manifest is pinned to the WO-2491 run until then.
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { spawnSync } from 'node:child_process'

const root = process.cwd()
const route = path.join(root, 'tools/capture/wiki-gaps/desktop.mjs')
const candidates = path.join(root, 'src/tests/evidence/WO-2709/candidates')
const slots = [
  { gap: 'G01', png: 'G01-probing-tab-outside-corner.png', out: 'public/help/probing-tab/probing-outside-corner.webp' },
  { gap: 'G02', png: 'G02-probe-result-confirm.png', out: 'public/help/probing-tab/probing-result-confirm.webp' },
]
if (!fs.existsSync(route)) {
  console.error('NOT SHOT: tools/capture/wiki-gaps/desktop.mjs is absent (WO-2709 not landed); nothing published')
  process.exit(1)
}
const runStart = Date.now()
const shoot = spawnSync(process.execPath, [route, '--only=' + slots.map(s => s.gap).join(',')], { stdio: 'inherit', cwd: root })
let failed = shoot.status !== 0
for (const s of slots) {
  const src = path.join(candidates, s.png)
  // Same-run guard: a candidate left from an earlier run is never published.
  if (!fs.existsSync(src) || fs.statSync(src).mtimeMs < runStart) {
    console.error(`PUBLISH REFUSED: ${s.png} was not shot in this run`)
    failed = true
    continue
  }
  const out = path.join(root, s.out)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  const info = await sharp(src).webp({ quality: 90 }).toFile(out)
  console.log(`${s.png} -> ${s.out} ${info.width}x${info.height}`)
}
process.exitCode = failed ? 1 : 0
