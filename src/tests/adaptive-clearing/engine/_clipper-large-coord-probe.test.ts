// PROBE TOOL (root-cause investigation, large-area adaptive bug). Isolates the
// clipper2-wasm layer from the engine: does union/difference/area corrupt at large
// coordinates, or is the corruption an engine-logic / area-summation artifact?
//
//   $env:PROBE='1'; npx vitest run src/tests/adaptive-clearing/engine/_clipper-large-coord-probe.test.ts --testTimeout=600000
//
// Probes:
//   A. union of two overlapping r=100 disks at origin vs shifted (450,300) vs (4500,3000)
//   B. difference of a 600x400 rect minus an r=100 disk at (300,200)
//   C. area of a plain 600x400 rect loop (JS shoelace vs totalArea)
//   D. incremental spiral expandCleared simulation (the engine's exact accumulation
//      pattern) at center (150,100) [= the GOOD 300x200 case] vs (300,200) [= the BROKEN
//      600x400 case], reporting loop count / signed areas / net-vs-naive area / a
//      frontier cut-area sample at every 5mm of spiral radius growth.
import { describe, it, beforeAll } from 'vitest'
import {
  ensureEngineClipperReady, union, difference, intersection, totalArea, loopArea,
  diskPath, offsetOpenRound, type Loops, type Pt,
} from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'

function fmtLoops(tag: string, loops: Loops): void {
  const signed = loops.map(l => loopArea(l))
  const net = signed.reduce((a, b) => a + b, 0)
  const naive = totalArea(loops)
  const verts = loops.reduce((a, l) => a + l.length, 0)
  /* eslint-disable-next-line no-console */
  console.log(`${tag}: loops=${loops.length} verts=${verts} naiveTotalArea=${naive.toFixed(1)} netSignedArea=${net.toFixed(1)} signed=[${signed.map(s => s.toFixed(1)).join(', ')}]`)
}

describe.runIf(!!process.env.PROBE)('clipper large-coordinate probe', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })

  it('A: union of two overlapping r=100 disks, small vs large offsets', () => {
    // centers 150 apart, r=100 -> overlap lens ~4532, union ~58300 analytic
    for (const [dx, dy] of [[0, 0], [450, 300], [4500, 3000]] as const) {
      const a = diskPath({ x: 0 + dx, y: 0 + dy }, 100, 0.02)
      const b = diskPath({ x: 150 + dx, y: 0 + dy }, 100, 0.02)
      fmtLoops(`A disk@(${dx},${dy})`, a)
      const u = union(a, b)
      fmtLoops(`A union@(${dx},${dy})`, u)
    }
  })

  it('B: 600x400 rect minus r=100 disk at (300,200)', () => {
    const rect: Loops = [[{ x: 0, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 400 }, { x: 0, y: 400 }]]
    const d = diskPath({ x: 300, y: 200 }, 100, 0.02)
    const res = difference(rect, d)
    fmtLoops('B rect-minus-disk', res) // expect outer 240000 + hole ~-31416; naive 271k, net 208.6k
    const inter = intersection(res, rect)
    fmtLoops('B (rect-disk) INTERSECT rect', inter) // what the repro coverage metric does
  })

  it('C: plain 600x400 rect area', () => {
    const rect: Loops = [[{ x: 0, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 400 }, { x: 0, y: 400 }]]
    fmtLoops('C rect', rect) // expect 240000 both ways
  })

  it('E: reseed no-progress guard arithmetic (totalArea on remaining with holes)', () => {
    // Replays processFeature's reseed math for rect-400x266: cutRegion = rect inset 2.55;
    // cleared = one then two truncated-spiral disks (r~65 at the observed centers).
    // reseed() compares remArea = totalArea(difference(cutRegion, cleared)) against the
    // previous remArea minus MIN_RESEED_AREA (pi*4 = 12.57). If totalArea counts the disk
    // HOLES as positive, remArea GROWS as more is cleared and the guard kills reseeding.
    const inset = 2.55
    const cutRegion: Loops = [[
      { x: inset, y: inset }, { x: 400 - inset, y: inset },
      { x: 400 - inset, y: 266 - inset }, { x: inset, y: 266 - inset },
    ]]
    const disk1 = diskPath({ x: 200, y: 133 }, 65, 0.025)
    const disk2 = diskPath({ x: 74.5, y: 73.1 }, 60, 0.025)
    const rem1 = difference(cutRegion, disk1)
    const rem2 = difference(cutRegion, union(disk1, disk2))
    fmtLoops('E remaining after disk1', rem1)
    fmtLoops('E remaining after disk1+disk2', rem2)
    const MIN_RESEED_AREA = Math.PI * 2 * 2
    /* eslint-disable-next-line no-console */
    console.log(`E guard: remArea2(${totalArea(rem2).toFixed(0)}) > remArea1(${totalArea(rem1).toFixed(0)}) - ${MIN_RESEED_AREA.toFixed(2)} -> reseed returns ${totalArea(rem2) > totalArea(rem1) - MIN_RESEED_AREA ? 'NULL (guard fires, run terminates)' : 'entry (guard ok)'}`)
  })

  it('D: spiral expandCleared accumulation, small-center vs large-center', () => {
    const toolR = 2
    const arcTol = 0.025 // engine: max(tolerance*0.25, 0.01) with tolerance=0.1
    for (const c of [{ x: 150, y: 100 }, { x: 300, y: 200 }]) {
      /* eslint-disable-next-line no-console */
      console.log(`--- D spiral center (${c.x},${c.y}) ---`)
      let cleared: Loops = diskPath(c, 3.5, arcTol) // helix seed disk (helixR 1.5 + toolR 2)
      const pitch = 1 // mm per revolution (= stepover)
      const ds = 1.5  // mm arc-length per sampled point (engine steps 0.2..2mm)
      let theta = 2 * Math.PI * 1.5 / pitch // start at r=1.5
      let chunk: Pt[] = [{ x: c.x + (pitch * theta / (2 * Math.PI)) * Math.cos(theta), y: c.y + (pitch * theta / (2 * Math.PI)) * Math.sin(theta) }]
      let nextReport = 10
      let unions = 0
      let broken = false
      while (!broken) {
        const r = pitch * theta / (2 * Math.PI)
        if (r > 132) break
        theta += ds / Math.max(r, 0.5)
        const rr = pitch * theta / (2 * Math.PI)
        const p = { x: c.x + rr * Math.cos(theta), y: c.y + rr * Math.sin(theta) }
        chunk.push(p)
        if (chunk.length >= 11) { // engine folds every 10 points on the first pass
          const corridor = offsetOpenRound(chunk, toolR, arcTol)
          cleared = union(cleared, corridor)
          unions++
          chunk = [p]
        }
        if (rr >= nextReport) {
          nextReport += 10
          const signed = cleared.map(l => loopArea(l))
          const net = signed.reduce((a, b) => a + b, 0)
          const naive = totalArea(cleared)
          const verts = cleared.reduce((a, l) => a + l.length, 0)
          const expected = Math.PI * (rr + toolR) * (rr + toolR)
          // frontier sample: a virgin-material crescent just OUTSIDE the spiral frontier
          // should be ~fully uncut; the engine's area=0 stop means this reads ~0.
          const outPt = { x: c.x + (rr + toolR + 1.5) * Math.cos(theta), y: c.y + (rr + toolR + 1.5) * Math.sin(theta) }
          const frontierUncut = totalArea(difference(diskPath(outPt, toolR, arcTol), cleared))
          const diskArea = Math.PI * toolR * toolR
          /* eslint-disable-next-line no-console */
          console.log(`D r=${rr.toFixed(1)} unions=${unions} loops=${cleared.length} verts=${verts} net=${net.toFixed(0)} naive=${naive.toFixed(0)} expect~${expected.toFixed(0)} frontierUncut=${frontierUncut.toFixed(2)}/${diskArea.toFixed(2)}`)
          if (cleared.length > 3 || naive > expected * 1.5 || net < expected * 0.5) {
            /* eslint-disable-next-line no-console */
            console.log(`D *** ANOMALY at r=${rr.toFixed(1)} center (${c.x},${c.y}) ***`)
            const top = [...cleared].sort((a, b) => Math.abs(loopArea(b)) - Math.abs(loopArea(a))).slice(0, 6)
            for (const l of top) {
              let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
              for (const p2 of l) { minX = Math.min(minX, p2.x); minY = Math.min(minY, p2.y); maxX = Math.max(maxX, p2.x); maxY = Math.max(maxY, p2.y) }
              /* eslint-disable-next-line no-console */
              console.log(`D    loop area=${loopArea(l).toFixed(1)} verts=${l.length} bbox=[${minX.toFixed(1)},${minY.toFixed(1)}]..[${maxX.toFixed(1)},${maxY.toFixed(1)}]`)
            }
            broken = true
          }
        }
      }
    }
  }, 600000)
})
