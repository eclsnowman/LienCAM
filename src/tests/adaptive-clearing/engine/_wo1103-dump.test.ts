// WO-1103 PATH DUMP (evidence tooling; skipped unless WO1103_DUMP names an output path).
//
// Writes Bar's whole corpus plan -- entries, passes, cutRegion, boundary -- as JSON. This is
// how src/tests/evidence/WO-1103/before-bar-path.json was made: check the engine file out at
// the pre-WO-1103 revision, run this, put the engine file back. The picture test reads that
// dump for its BEFORE panel, because a branch cannot replan a path its engine no longer
// produces.
//
//   git checkout <pre-WO-1103 rev> -- src/lib/cam/adaptiveClearing2d/engine/processFeature.ts
//   WO1103_DUMP=src/tests/evidence/WO-1103/before-bar-path.json \
//     npx vitest run src/tests/adaptive-clearing/engine/_wo1103-dump.test.ts
//   git checkout HEAD -- src/lib/cam/adaptiveClearing2d/engine/processFeature.ts
import { describe, it, beforeAll } from 'vitest'
import * as fs from 'fs'
import { ensureEngineClipperReady, type Loop } from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { processFeature, type ProcessParams } from '../../../lib/cam/adaptiveClearing2d/engine/processFeature'

const CORPUS: ProcessParams = {
  toolRadius: 2.0, stepOver: 0.4, tolerance: 0.1, helixDiameter: 3.8, stockToLeave: 0.5,
  integralWallFollow: true, integralWallFollowLengthFactor: 2, wallCleanupAsWeGo: true,
  loopbackFilletPct: 25, wallFinish: true, millingDirection: 'climb',
}

describe('WO-1103 path dump', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })
  it.skipIf(!process.env.WO1103_DUMP)('writes Bar\'s corpus plan', () => {
    const d = JSON.parse(fs.readFileSync('test_fixtures/adaptive-clearing/spirals/_cmp/_gt/gt_fix4.json', 'utf8'))
    const boundary: Loop = (d.boundary as number[][]).map(([x, y]: number[]) => ({ x, y }))
    const warn = console.warn
    console.warn = () => {}
    let res
    try { res = processFeature({ boundary, holes: [] }, CORPUS) } finally { console.warn = warn }
    fs.writeFileSync(process.env.WO1103_DUMP!, JSON.stringify({
      entries: res.entries, passes: res.passes, cutRegion: res.cutRegion, boundary: d.boundary,
    }))
    console.log(`wrote ${process.env.WO1103_DUMP} -- ${res.passes.length} passes, `
      + `entry (${res.entries[0].point.x.toFixed(2)}, ${res.entries[0].point.y.toFixed(2)})`)
  }, 900000)
})
