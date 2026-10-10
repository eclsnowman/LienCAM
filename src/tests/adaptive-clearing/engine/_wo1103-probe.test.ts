// WO-1103 PROBE (measurement only, asserts nothing about the change).
//
// Step 1 caches each gt fixture's tool-centre region + the entry the engine picks, per
// settings bank, into src/tests/evidence/WO-1103/regions.json (the engine runs cost ~100s;
// the cache makes the analysis below re-runnable in a second). Step 2 measures the shape
// facts WO-1103's rule needs: what the saturated disk touches, and what it strands.
//
//   WO1103_PROBE=1 npx vitest run src/tests/adaptive-clearing/engine/_wo1103-probe.test.ts
import { describe, it, beforeAll } from 'vitest'
import * as fs from 'fs'
import {
  ensureEngineClipperReady, offsetClosedTree, difference, diskPath, netArea,
  type Loop, type Loops, type Pt,
} from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { closestPointOnPaths, polyBBoxOf, centroid } from '../../../lib/cam/adaptiveClearing2d/engine/geom'
import { processFeature, type ProcessParams } from '../../../lib/cam/adaptiveClearing2d/engine/processFeature'

const TR = 2.0
const CACHE = 'src/tests/evidence/WO-1103/regions.json'
function loadFixture(fix: number): { boundary: Loop; holes: Loop[]; helixDiameter: number; name: string } {
  const d = JSON.parse(fs.readFileSync(`test_fixtures/adaptive-clearing/spirals/_cmp/_gt/gt_fix${fix}.json`, 'utf8'))
  return {
    boundary: (d.boundary as number[][]).map(([x, y]: number[]) => ({ x, y })),
    holes: (d.islands ?? []).map((isl: number[][]) => isl.map(([x, y]: number[]) => ({ x, y }))),
    helixDiameter: d.helix?.diameter ?? 3,
    name: d.name as string,
  }
}
const paramsFor = (bank: string, helixDiameter: number): ProcessParams => bank === 'corpus'
  ? {
      toolRadius: TR, stepOver: 0.4, tolerance: 0.1, helixDiameter: 3.8, stockToLeave: 0.5,
      integralWallFollow: true, integralWallFollowLengthFactor: 2, wallCleanupAsWeGo: true,
      loopbackFilletPct: 25, wallFinish: true, millingDirection: 'climb',
    }
  : {
      toolRadius: TR, stepOver: 0.2, tolerance: 0.1, helixDiameter, stockToLeave: 0.5,
      integralWallFollow: true, wallCleanupAsWeGo: true, loopbackFilletPct: 25,
    }

describe('WO-1103 elongation probe', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })
  it.skipIf(!process.env.WO1103_PROBE)('measures every gt fixture region', () => {
    if (!fs.existsSync(CACHE)) {
      const warn = console.warn
      const out: Record<string, { name: string; seed: Pt; cutRegion: number[][][] }> = {}
      for (const bank of ['bytestab', 'corpus']) {
        for (let fix = 0; fix <= 8; fix++) {
          const { boundary, holes, helixDiameter, name } = loadFixture(fix)
          console.warn = () => {}
          let res
          try { res = processFeature({ boundary, holes }, paramsFor(bank, helixDiameter)) } finally { console.warn = warn }
          out[`${bank}/${fix}`] = {
            name,
            seed: res.entries[0].point,
            cutRegion: res.cutRegion.map(l => l.map(p => [p.x, p.y])),
          }
          console.log(`cached ${bank}/fix${fix} ${name}`)
        }
      }
      fs.writeFileSync(CACHE, JSON.stringify(out))
    }
    const cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')) as Record<string, { name: string; seed: Pt; cutRegion: number[][][] }>
    const arcTol = 0.025
    for (const bank of ['bytestab', 'corpus']) {
      const stepOverMm = (bank === 'corpus' ? 0.4 : 0.2) * TR * 2
      console.log(`\n=== ${bank}  stepOver=${stepOverMm.toFixed(3)}mm ===`)
      for (let fix = 0; fix <= 8; fix++) {
        const e = cache[`${bank}/${fix}`]
        const cutRegion: Loops = e.cutRegion.map(l => l.map(([x, y]) => ({ x, y })))
        const seed = e.seed
        const bb = polyBBoxOf(cutRegion)
        const clear = closestPointOnPaths(cutRegion, seed).dist
        // Where the saturated disk TOUCHES: every boundary sample within 2% of `clear`,
        // as an angle from the seed. A width-limited (channel) disk has two antipodal
        // contact bands; a length- or corner-limited one does not.
        const contacts: number[] = []
        for (const l of cutRegion) {
          for (let i = 0; i < l.length; i++) {
            const a = l[i], b = l[(i + 1) % l.length]
            const seg = Math.hypot(b.x - a.x, b.y - a.y)
            const n = Math.max(1, Math.ceil(seg / 0.25))
            for (let k = 0; k < n; k++) {
              const p = { x: a.x + (b.x - a.x) * (k / n), y: a.y + (b.y - a.y) * (k / n) }
              const d = Math.hypot(p.x - seed.x, p.y - seed.y)
              if (d <= clear * 1.02 + 0.05) contacts.push(Math.atan2(p.y - seed.y, p.x - seed.x))
            }
          }
        }
        // widest angular gap between consecutive contacts -> if two antipodal bands, the two
        // gaps are each ~180deg and the "spread" of contact directions is ~180deg apart.
        contacts.sort((a, b) => a - b)
        let gaps: number[] = []
        for (let i = 0; i < contacts.length; i++) {
          const nxt = contacts[(i + 1) % contacts.length]
          let g = nxt - contacts[i]
          if (g < 0) g += 2 * Math.PI
          gaps.push(g)
        }
        gaps = gaps.sort((a, b) => b - a).slice(0, 3).map(g => g * 180 / Math.PI)
        // Lobes stranded once the disk grows one stepover past saturation.
        const rest = difference(cutRegion, diskPath(seed, clear + stepOverMm, arcTol))
        const lobes = offsetClosedTree(rest, 0, arcTol).filter(n => !n.isHole)
          .map(n => {
            const loops = [n.contour, ...n.children.filter(c => c.isHole).map(c => c.contour)]
            return { area: Math.abs(netArea(loops)), c: centroid(n.contour) }
          })
          .filter(x => x.area > Math.PI * TR * TR)
          .sort((a, b) => b.area - a.area)
        let dot = NaN
        if (lobes.length >= 2) {
          const u = (p: Pt) => { const d = Math.hypot(p.x - seed.x, p.y - seed.y); return { x: (p.x - seed.x) / d, y: (p.y - seed.y) / d } }
          const a = u(lobes[0].c), b = u(lobes[1].c)
          dot = a.x * b.x + a.y * b.y
        }
        console.log(
          `fix${fix} ${e.name.padEnd(13)} bb=${(bb.maxX - bb.minX).toFixed(2)}x${(bb.maxY - bb.minY).toFixed(2)}`
          + ` seed=(${seed.x.toFixed(2)},${seed.y.toFixed(2)}) clear=${clear.toFixed(2)}`
          + ` contactGaps=[${gaps.map(g => g.toFixed(0)).join(',')}]`
          + ` lobes=[${lobes.map(x => x.area.toFixed(0)).join(',')}] dot=${dot.toFixed(3)}`,
        )
      }
    }
  }, 900000)
})
