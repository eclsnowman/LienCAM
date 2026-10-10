// Regression guard for the large-pocket early-termination bug (fixed 2026-06-11).
//
// Root cause: the engine measured "remaining material" with totalArea(), which sums
// ABSOLUTE loop areas. The remaining region of a large pocket is its outer loop plus
// the HOLES the cleared spirals punch in it, so every hole counted as POSITIVE
// material and "remaining" GREW as material was removed. processFeature's reseed
// no-progress guard then fired and the job terminated silently at ~15% coverage
// (>=400x266mm with a 4mm tool / 1mm stepover; 300x200mm never holds a hole long
// enough to trip it). Experimentally proven by _clipper-large-coord-probe.test.ts
// (probes B and E); fix = netArea() (signed sum, holes subtract) for every material-
// quantity measure. Pure clipper arithmetic here -- no engine march, milliseconds.
import { describe, it, expect, beforeAll } from 'vitest'
import {
  ensureEngineClipperReady, diskPath, difference, union, totalArea, netArea, loopArea,
  type Loops,
} from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'

describe('net signed area (material accounting)', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })

  it('rect minus disk: netArea subtracts the hole, totalArea counts it as material', () => {
    // The probe-B geometry: 600x400 rect minus an r=100 disk at (300,200).
    // Signed loops are [+240000, ~-31407.6] (the faceted disk sits slightly under
    // pi*r^2 = 31415.9), so net ~= 208592.4 while the naive absolute sum reads ~271407.
    const rect: Loops = [[{ x: 0, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 400 }, { x: 0, y: 400 }]]
    const rem = difference(rect, diskPath({ x: 300, y: 200 }, 100, 0.02))

    expect(rem.length).toBe(2)
    const signed = rem.map(l => loopArea(l)).sort((a, b) => b - a)
    expect(signed[0]).toBeCloseTo(240000, 0)          // outer contour, positive
    expect(signed[1]).toBeGreaterThan(-31416)          // hole, negative (~ -31407.6)
    expect(signed[1]).toBeLessThan(-31380)

    expect(netArea(rem)).toBeGreaterThan(208550)       // ~208592.4 net material
    expect(netArea(rem)).toBeLessThan(208650)
    expect(totalArea(rem)).toBeGreaterThan(271000)     // the naive overcount (old bug)
  })

  it('probe-E guard scenario: clearing MORE must never report MORE remaining', () => {
    // Replays the reseed arithmetic for the broken 400x266 pocket: cutRegion = rect
    // inset 2.55mm; cleared = one then two interior disks (the observed spiral spots).
    const inset = 2.55
    const cutRegion: Loops = [[
      { x: inset, y: inset }, { x: 400 - inset, y: inset },
      { x: 400 - inset, y: 266 - inset }, { x: inset, y: 266 - inset },
    ]]
    const disk1 = diskPath({ x: 200, y: 133 }, 65, 0.025)
    const disk2 = diskPath({ x: 74.5, y: 73.1 }, 60, 0.025)
    const rem1 = difference(cutRegion, disk1)
    const rem2 = difference(cutRegion, union(disk1, disk2))

    const MIN_RESEED_AREA = Math.PI * 2 * 2 // tool r=2 -> pi*r^2, as in processFeature

    // NET remaining decreases by ~a disk2-area: the no-progress guard passes and
    // reseeding continues (the fixed behavior).
    expect(netArea(rem2)).toBeLessThan(netArea(rem1) - MIN_RESEED_AREA)

    // The naive absolute sum VIOLATES monotonicity on this exact geometry -- the
    // misfire that killed large pockets. Kept as documentation of why netArea exists.
    expect(totalArea(rem2)).toBeGreaterThan(totalArea(rem1))
  })
})
