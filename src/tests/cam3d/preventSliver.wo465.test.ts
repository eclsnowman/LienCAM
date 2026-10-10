// WO-465 - Operator's FIRST GOAL: never make the sliver area in the first place.
//
// The diagnosed case (WO-458 item 4, card Q-A-THIN-SLIVER-OF-LEFTOVER-MATERI-1787280589843)
// is restWiring.wo279 op-rough-8's first level. Its tool-centre region is FOUR components:
// 590.9, 101.3, 101.3 and a 0.373 x 1.500 mm lens of 0.273 mm2 at the mouth of the H's
// crossbar. The lens is a pure INSET artefact - it exists only because the dilated island
// wall at x=35.0 and the two crossbar corners at (39,28)/(39,32) miss each other by half a
// millimetre - and the largest entry that fits in it is 0.161 mm against the engine's
// 0.200 mm MIN_DESCENT_HELIX_RADIUS floor.
//
// WO-464's buffer stops that killing the job. This order stops the region being MADE:
// the component is refused at cut-region construction, so nothing walks its boundary and
// no entry is ever planned for it. Its material stays in the honest residual - Operator's
// option (b), leftover for a smaller tool. Option (a), folding it into the region next
// door, is geometrically impossible here: the nearest neighbouring component is 9.4 mm
// away in tool-centre space ACROSS the retained island, so every ride to it gouges.
//
// WO-464's buffer is NOT replaced and NOT weakened - the last test here is its live
// positive control on the very same geometry.

import { beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'fs'

import {
  ensureEngineClipperReady,
  intersection,
  netArea,
  offsetClosed,
  type Loop,
  type Loops,
} from '../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import {
  getDroppedSliverStats,
  MIN_DESCENT_HELIX_RADIUS,
  processFeature,
  type Feature,
  type ProcessParams,
} from '../../lib/cam/adaptiveClearing2d/engine/processFeature'

const BEFORE_DUMP = 'src/tests/evidence/WO-458/sliver-picture/first-level-dump.json'

type SliverDump = {
  params: Feature
  toolParams: ProcessParams
  entries: { point: { x: number; y: number }; radius: number }[]
  cutRegion: Loop[]
  stats: { residualArea: number }
}

function area(loop: Loop): number {
  let twice = 0
  for (let i = 0; i < loop.length; i++) {
    const next = loop[(i + 1) % loop.length]
    twice += loop[i].x * next.y - next.x * loop[i].y
  }
  return Math.abs(twice / 2)
}

function circle(cx: number, cy: number, radius: number): Loop {
  return Array.from({ length: 64 }, (_, i) => {
    const angle = (i / 64) * Math.PI * 2
    return { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius }
  })
}

/** A slot whose tool-centre strip is 0.35 mm wide: narrower than the 0.200 mm descent floor
 *  can enter, and the ONLY component the feature has. */
function narrowSlot(): { feat: Feature; params: ProcessParams } {
  return {
    feat: { boundary: [{ x: 0, y: 0 }, { x: 8.55, y: 0 }, { x: 8.55, y: 40 }, { x: 0, y: 40 }], holes: [] },
    params: { toolRadius: 4, stepOver: 0.4, tolerance: 0.2, helixDiameter: 2, stockToLeave: 0, arcTol: 0.05 },
  }
}

describe('WO-465 the sliver is never made a region', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })

  it('never forms the diagnosed restWiring first-level component', () => {
    const before = JSON.parse(fs.readFileSync(BEFORE_DUMP, 'utf8')) as SliverDump
    // The preserved WO-458 dump is the BEFORE side: four tool-centre components, the
    // fourth 0.273 mm2, and a fourth entry the emitter refuses (a 0.161 mm plunge).
    expect(before.cutRegion).toHaveLength(4)
    expect(before.cutRegion.map(area).sort((a, b) => a - b)[0]).toBeCloseTo(0.2735, 3)
    expect(before.entries.map(entry => entry.radius)).toEqual([1, 1, 1, 0.16077728271484393])

    const result = processFeature(before.params, before.toolParams)
    const dropped = getDroppedSliverStats()

    // THE CLAIM: the region is no longer FORMED, not merely no longer fatal.
    expect(result.cutRegion).toHaveLength(3)
    expect(result.cutRegion.map(loop => Number(area(loop).toFixed(4))).sort((a, b) => b - a))
      .toEqual([590.8597, 101.2949, 101.2949])
    // Nothing survives anywhere near the crossbar mouth (x 35.10..35.47, y 29.26..30.76).
    for (const loop of result.cutRegion) {
      expect(loop.some(point => point.x > 35 && point.x < 36 && point.y > 29 && point.y < 31)).toBe(false)
    }

    // No entry was ever planned for it, and every entry that IS planned is one the
    // emitter will actually make.
    expect(result.entries).toHaveLength(3)
    expect(result.entries.every(entry => entry.radius >= MIN_DESCENT_HELIX_RADIUS)).toBe(true)
    expect(result.entries.every(entry => entry.mode === 'helix')).toBe(true)

    // Declined at the cut-region stage, with the measurement that decided it.
    expect(dropped.regions).toHaveLength(1)
    expect(dropped.regions[0].stage).toBe('cut-region')
    expect(dropped.regions[0].toolCentreArea).toBeCloseTo(0.27348, 4)
    expect(dropped.regions[0].largestEntryRadius).toBeLessThan(MIN_DESCENT_HELIX_RADIUS)
    expect(dropped.regions[0].largestEntryRadius).toBeCloseTo(0.160778, 5)

    // The material is LEFTOVER, not lost: what the cutter would have swept out of the
    // declined component is still standing in the honest residual. Recomputed here from
    // the preserved BEFORE dump, independently of the engine's own record.
    const sliver = before.cutRegion.slice().sort((a, b) => area(a) - area(b))[0]
    const sweptResidual = intersection(
      offsetClosed([sliver], before.toolParams.toolRadius, before.toolParams.arcTol),
      result.residual,
    )
    expect(dropped.regions[0].sweptArea).toBeCloseTo(Math.abs(netArea(sweptResidual)), 6)
    // The line above is the invariant: the engine's own record of the declined
    // component's swept area equals an independent recomputation to 6 dp, so
    // the material is accounted for and not lost. THIS line is only a
    // magnitude guard - it catches the area collapsing towards zero, it does
    // not pin a shape. WO-1178's tangent wall joins moved it 54.0 -> 53.600
    // (0.7%) with the exact cross-check above still passing, so the bound is
    // restated with headroom rather than repinned a hair under each new
    // measurement (architect, 2026-09-03; this file is outside WO-1178's lane).
    expect(dropped.regions[0].sweptArea).toBeGreaterThan(50)
    expect(result.stats.residualArea).toBeGreaterThan(before.stats.residualArea)

    console.log(
      `[WO-465 restWiring level] cut-region components ${before.cutRegion.length}->${result.cutRegion.length}; `
      + `entries ${before.entries.length}->${result.entries.length}; `
      + `cut-passes ${result.passes.filter(pass => pass.type === 'cut').length}; `
      + `residual ${before.stats.residualArea.toFixed(6)}->${result.stats.residualArea.toFixed(6)} mm2; `
      + `declined at ${dropped.regions[0].stage}: tool-centre=${dropped.regions[0].toolCentreArea.toFixed(6)} mm2, `
      + `swept-residual=${dropped.regions[0].sweptArea.toFixed(6)} mm2, `
      + `largest fitting entry=${dropped.regions[0].largestEntryRadius.toFixed(6)} mm`,
    )
  })

  it('leaves a feature whose ONLY component is sub-threshold exactly as it was', () => {
    // Prevention must never empty a feature. A one-component cutRegion is not a sliver
    // problem - it is a tool-too-big problem, and the existing entry path is what says so.
    const { feat, params } = narrowSlot()
    const result = processFeature(feat, params)

    expect(result.cutRegion).toHaveLength(1)
    expect(getDroppedSliverStats().regions).toHaveLength(0)
    expect(result.entries.length).toBeGreaterThan(0)
  })

  it('leaves a feature where EVERY component is sub-threshold exactly as it was', () => {
    // The same guard with the component count above one: a hole splits the 0.35 mm strip in
    // two, both unenterable. Dropping both would delete the feature, so the filter declines
    // to act at all and the pre-WO-465 path stands.
    const { feat, params } = narrowSlot()
    const split: Feature = {
      ...feat,
      holes: [[{ x: 1, y: 19 }, { x: 7.55, y: 19 }, { x: 7.55, y: 21 }, { x: 1, y: 21 }]],
    }
    const result = processFeature(split, params)
    const dropped = getDroppedSliverStats()

    expect(result.cutRegion).toHaveLength(2)
    expect(dropped.regions.some(region => region.stage === 'cut-region')).toBe(false)
    // Pre-WO-465 behaviour stands whole: the first entry is still planted (the loud plunge
    // this geometry has always got), and WO-464's buffer - not this filter - is what
    // declines the second component once the walk reaches it.
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].mode).toBe('plunge')
    expect(dropped.regions.map(region => region.stage)).toEqual(['re-seed'])
  })

  it('keeps WO-464 re-seed buffer live where prevention does not apply', () => {
    // Operator asked for BOTH. Prevention is skipped for an outside-in feature, because such a
    // region enters LATERALLY from pre-cleared air and the descent floor is not the question
    // its components are judged by. Seed the diagnosed level's own geometry that way and the
    // 0.273 mm2 lens survives cut-region construction - and WO-464's buffer takes it,
    // unchanged, at exactly the same measured size.
    const before = JSON.parse(fs.readFileSync(BEFORE_DUMP, 'utf8')) as SliverDump
    const first = before.entries[0].point
    const seed: Loops = [circle(first.x, first.y, before.toolParams.toolRadius + 0.2)]

    const result = processFeature(before.params, { ...before.toolParams, clearedSeed: seed })
    const dropped = getDroppedSliverStats()

    expect(result.cutRegion).toHaveLength(4) // prevention deliberately did not act
    expect(dropped.regions).toHaveLength(1)
    expect(dropped.regions[0].stage).toBe('re-seed')
    expect(dropped.regions[0].toolCentreArea).toBeCloseTo(0.2735, 3)
    expect(dropped.regions[0].largestEntryRadius).toBeLessThan(MIN_DESCENT_HELIX_RADIUS)
    expect(result.entries.every(entry => entry.mode === 'side' || entry.radius >= MIN_DESCENT_HELIX_RADIUS)).toBe(true)

    console.log(
      `[WO-465 buffer still live] entries ${result.entries.map(entry => entry.mode).join(',')}; `
      + `declined at ${dropped.regions[0].stage}: tool-centre=${dropped.regions[0].toolCentreArea.toFixed(6)} mm2, `
      + `largest fitting entry=${dropped.regions[0].largestEntryRadius.toFixed(6)} mm`,
    )
  }, 300_000)
})
