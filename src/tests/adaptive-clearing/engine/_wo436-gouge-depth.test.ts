// WO-436 GOUGE-DEPTH PROBE (diagnostic; underscore = not CI). Every tier-0 cut-through
// candidate on the corpus was rejected by the gouge veto (tool centre exits cutRegion).
// This measures HOW FAR outside cutRegion those chords stray: microns = a knife-edge
// notch eating invisibly into the 0.5mm stock-to-leave; tenths of mm = a real wall clip
// and the veto is obviously right. Input to Operator's morning tier-0 question.
//
// Run: npx vitest run src/tests/adaptive-clearing/engine/_wo436-gouge-depth.test.ts
import { describe, it, beforeAll } from 'vitest'
import { ensureEngineClipperReady, type Loops, type Pt } from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { processFeature } from '../../../lib/cam/adaptiveClearing2d/engine/processFeature'
import { CANONICAL_PARAMS, loadGtFixture } from './_goodspec-helpers'

// Signed distance of p to the region: 0 if inside any outer loop and outside every hole
// is handled by even-odd containment across ALL loops (cutRegion loops are outer+holes
// mixed); when OUTSIDE, distance to the nearest edge of any loop.
function pointInLoopsEvenOdd(p: Pt, loops: Loops): boolean {
  let inside = false
  for (const loop of loops) {
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
      const a = loop[i], b = loop[j]
      if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
    }
  }
  return inside
}
function distToEdges(p: Pt, loops: Loops): number {
  let best = Infinity
  for (const loop of loops) {
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
      const a = loop[i], b = loop[j]
      const dx = b.x - a.x, dy = b.y - a.y
      const L2 = dx * dx + dy * dy
      const t = L2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2)) : 0
      const qx = a.x + t * dx, qy = a.y + t * dy
      const d = Math.hypot(p.x - qx, p.y - qy)
      if (d < best) best = d
    }
  }
  return best
}

describe('WO-436 gouge-depth probe', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })
  it('measures how far gouge-vetoed cut-through chords exit cutRegion', () => {
    const results: string[] = []
    for (let fix = 0; fix <= 8; fix++) {
      const { boundary, holes, helixDiameter, name } = loadGtFixture(fix)
      const rejected: { a: Pt; b: Pt }[] = []
      const warn = console.warn
      console.warn = (...args: unknown[]) => {
        const s = args.map(String).join(' ')
        const m = s.match(/\[cutthrough\] rejected \(gouge\): chord [\d.]+mm from \((-?[\d.]+), (-?[\d.]+)\) to \((-?[\d.]+), (-?[\d.]+)\)/)
        if (m) rejected.push({ a: { x: +m[1], y: +m[2] }, b: { x: +m[3], y: +m[4] } })
      }
      let res
      try { res = processFeature({ boundary, holes }, { ...CANONICAL_PARAMS, helixDiameter }) } finally { console.warn = warn }
      if (!rejected.length) { results.push(`fix${fix} ${name}: no gouge-vetoed cut-through candidates`); continue }
      const region = res.cutRegion
      for (const { a, b } of rejected) {
        let worst = 0
        const N = 200
        for (let i = 0; i <= N; i++) {
          const p = { x: a.x + (i / N) * (b.x - a.x), y: a.y + (i / N) * (b.y - a.y) }
          if (!pointInLoopsEvenOdd(p, region)) {
            const d = distToEdges(p, region)
            if (d > worst) worst = d
          }
        }
        const chord = Math.hypot(b.x - a.x, b.y - a.y)
        results.push(`fix${fix} ${name}: chord ${chord.toFixed(2)}mm @(${a.x.toFixed(1)},${a.y.toFixed(1)}) exits cutRegion by max ${(worst * 1000).toFixed(1)} microns`)
      }
    }
    for (const r of results) console.log('[gouge-depth] ' + r)
  }, 900000)
})
