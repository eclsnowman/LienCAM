// WO-3036 -- the measuring stick sees link spikes and reads arcs as arcs.
//
// operator, 2026-10-21 16:52 UTC, on the form-torus picture: "Yes those toolpaths
// absolutely are a problem. They are not good or clean toolpaths. And there would
// be no reason a part of this smooth geometry would have spikes in the toolpath
// that look like this." The stick could not see those spikes: its flip rate breaks
// its runs on link moves, so a keep-down ride that feeds out into cleared space
// and turns back 125-180 deg scored nothing. And it read every arc as its chord
// (WO-3029 cause D), so arc joins counted as steering.
//
// Every expected number below is worked by hand from the fixture's coordinates
// (the working is in the comment beside it), never read back off the code.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ToolpathMove } from '../../types'
import { LINK_SHARP_TURN_DEG, linkTurnMetrics, pathMetrics } from './metrics'
import { METRIC_SPECS } from './metricRegistry'

const Z = -2

function cut(x: number, y: number): ToolpathMove {
  return { type: 'feed', role: 'cut', x, y, z: Z }
}
function ride(x: number, y: number, z = Z): ToolpathMove {
  return { type: 'feed', role: 'stepover', x, y, z }
}
function arc(clockwise: boolean, x: number, y: number, cx: number, cy: number, role: ToolpathMove['role'] = 'cut'): ToolpathMove {
  return { type: clockwise ? 'arc_cw' : 'arc_ccw', role, x, y, z: Z, cx, cy }
}
const park: ToolpathMove = { type: 'rapid', role: 'rapid', x: -10, y: 0, z: Z }

describe('WO-3036 link turns: sharp corners in the motion between passes', () => {
  it('a straight hop between two passes is not a spike', () => {
    // Pass along +x to (10,0), a stepover straight up to (10,3), pass back along -x.
    const moves = [park, cut(10, 0), ride(10, 3), cut(0, 3)]
    const m = linkTurnMetrics(moves)
    expect(m).toEqual({
      linkSharpTurns: 0, linkSpikeRides: 0, linkSpikeFeedMm: 0, linkSpikeHopMm: 0,
      linkSpikeExtraMm: 0, linkSpikeFeedSharePct: 0,
    })
  })

  it('a 2.5 mm out-and-back V detour is one spike, with its extra feed and share', () => {
    // Pass along +x ends at (0,0). The ride feeds OUT to (1,2.5) and turns BACK to
    // (2,0), where the next pass starts along +x to (12,0).
    //   leg out  (1, 2.5), leg back (1,-2.5); cos = (1 - 6.25) / 7.25 = -0.7241,
    //   turn = 180 - acos(-0.7241)... the heading change is acos(-0.7241) = 136.4 deg > 90.
    //   ride feed = 2 * sqrt(1 + 6.25) = 5.38516 mm; straight hop (0,0)->(2,0) = 2 mm.
    //   all feed = 10 (first pass, from (-10,0)) + 5.38516 + 10 = 25.38516 mm.
    const moves = [park, cut(0, 0), ride(1, 2.5), ride(2, 0), cut(12, 0)]
    const m = linkTurnMetrics(moves)
    const rideMm = 2 * Math.sqrt(7.25)
    expect(m.linkSharpTurns).toBe(1)
    expect(m.linkSpikeRides).toBe(1)
    expect(m.linkSpikeFeedMm).toBeCloseTo(rideMm, 9)
    expect(m.linkSpikeHopMm).toBeCloseTo(2, 9)
    expect(m.linkSpikeExtraMm).toBeCloseTo(rideMm - 2, 9)
    // The park move is a rapid from the tool's unknown start: no length, no feed.
    expect(m.linkSpikeFeedSharePct).toBeCloseTo((rideMm / (10 + rideMm + 10)) * 100, 9)
  })

  it('two V detours and a straight hop: two rides, the hop adds nothing', () => {
    const moves = [
      park, cut(0, 0), ride(1, 2.5), ride(2, 0), // spike 1: 136.4 deg
      cut(12, 0), ride(12, 3), // straight hop, no interior corner
      cut(2, 3), ride(1, 0.5), ride(0, 3), // spike 2: legs (-1,-2.5), (-1,2.5), 136.4 deg
      cut(-8, 3),
    ]
    const m = linkTurnMetrics(moves)
    expect(m.linkSharpTurns).toBe(2)
    expect(m.linkSpikeRides).toBe(2)
    expect(m.linkSpikeFeedMm).toBeCloseTo(4 * Math.sqrt(7.25), 9)
    expect(m.linkSpikeHopMm).toBeCloseTo(4, 9)
  })

  it('a rounded detour of the same reach is no spike: an arc is not a corner', () => {
    // Out straight up to (0,2), a G2 half circle about (1,2) to (2,2), straight back
    // down to (2,0). Every join is tangent: up -> the arc starts heading up (radius
    // (-1,0), clockwise tangent (0,1)) -> it ends heading down -> the leg goes down.
    // Read as a CHORD the arc would turn 90 deg at each end; read as an arc, 0.
    const moves = [park, cut(0, 0), ride(0, 2), arc(true, 2, 2, 1, 2, 'stepover'), ride(2, 0), cut(12, 0)]
    const m = linkTurnMetrics(moves)
    expect(m.linkSharpTurns).toBe(0)
    expect(m.linkSpikeRides).toBe(0)
    expect(m.linkSpikeExtraMm).toBe(0)
  })

  it('a peck inside the ride carries the heading through; a rapid breaks it', () => {
    // The V again, with a pure-Z peck at its apex: the heading out and the heading
    // back still meet at 136.4 deg.
    const pecked = [park, cut(0, 0), ride(1, 2.5), ride(1, 2.5, Z + 0.5), ride(1, 2.5), ride(2, 0), cut(12, 0)]
    expect(linkTurnMetrics(pecked).linkSharpTurns).toBe(1)
    // A rapid in the middle is air, not a ride turning on the work.
    const lifted: ToolpathMove[] = [park, cut(0, 0), ride(1, 2.5),
      { type: 'rapid', role: 'rapid', x: 1.5, y: 1.25, z: Z }, ride(2, 0), cut(12, 0)]
    expect(linkTurnMetrics(lifted).linkSharpTurns).toBe(0)
  })

  it('a ride that doubles back along the pass it leaves is caught at both junctions', () => {
    // Pass along +x to (10,0); the ride runs back to (4,1), heading (-6,1): it turns
    // 180 - atan(1/6) = 170.5 deg off the pass. The next pass leaves (4,1) along +x,
    // another 170.5 deg. The ride itself is straight: feed = hop = sqrt(37) = 6.083 mm.
    const moves = [park, cut(10, 0), ride(4, 1), cut(14, 1)]
    const m = linkTurnMetrics(moves)
    expect(m.linkSharpTurns).toBe(2)
    expect(m.linkSpikeRides).toBe(1)
    expect(m.linkSpikeFeedMm).toBeCloseTo(Math.sqrt(37), 9)
    expect(m.linkSpikeHopMm).toBeCloseTo(Math.sqrt(37), 9)
    expect(m.linkSpikeExtraMm).toBeCloseTo(0, 9)
  })

  it('a corner of exactly the stated angle is not sharper than it', () => {
    // Out (0,1), then (1,0): a 90 deg turn exactly.
    expect(LINK_SHARP_TURN_DEG).toBe(90)
    const moves = [park, cut(0, 0), ride(0, 1), ride(1, 1), cut(11, 1)]
    expect(linkTurnMetrics(moves).linkSharpTurns).toBe(0)
  })

  it('every row carries the link-turn cells, registered soft (no landing verdict)', () => {
    const m = pathMetrics([park, cut(0, 0), ride(1, 2.5), ride(2, 0), cut(12, 0)])
    expect(m.linkSharpTurns).toBe(1)
    expect(m.linkSpikeRides).toBe(1)
    for (const name of ['linkSharpTurns', 'linkSpikeRides', 'linkSpikeFeedMm', 'linkSpikeHopMm',
      'linkSpikeExtraMm', 'linkSpikeFeedSharePct']) {
      const spec = METRIC_SPECS[name]
      expect(spec, name).toBeDefined()
      expect(spec.direction).toBe('lower')
      expect(spec.hard).toBeFalsy()
      expect(spec.timing).toBeFalsy()
      expect(spec.informational).toBe(true)
    }
  })
})

describe('WO-3036 flip rate reads arcs as arcs', () => {
  it('a rounded rectangle of tangent G3 corners is four left turns, not eight chord kinks', () => {
    // 10 x 10 square with r=2 corners, all counter-clockwise, tangent at every join.
    // As arcs: four turns of +90 deg, no flip. Read as chords, each quarter arc becomes
    // +45 deg kinks at its two ends instead (the starter's reading scores 7 turns on this
    // ring; feature-proof.json).
    const moves = [
      park,
      cut(2, 0), cut(8, 0), arc(false, 10, 2, 8, 2),
      cut(10, 8), arc(false, 8, 10, 8, 8),
      cut(2, 10), arc(false, 0, 8, 2, 8),
      cut(0, 2), arc(false, 2, 0, 2, 2),
    ]
    const m = pathMetrics(moves.slice(1), { x: 2, y: 0, z: Z })
    expect(m.turns).toBe(4)
    expect(m.flips).toBe(0)
  })

  it('an arc followed by a right-hand corner is a flip the chord hid', () => {
    // Line +x to (0,0); G3 quarter about (0,2) to (2,2) (turns +90, ends heading +y);
    // then a line to (2+sin30*4... ) heading 30 deg RIGHT of +y: to (4, 2+4*cos30).
    //   As arcs: +90 then -30 -> 2 turns, 1 flip of 30 deg.
    //   As chords: chord (2,2) heads 45 deg -> +45, then 60 -> 75... the exit leg heads
    //   60 deg, the chord 45 deg, so +15: 2 turns, 0 flips, and a lie about the shape.
    const moves = [
      cut(0, 0), arc(false, 2, 2, 0, 2), cut(2 + 4 * Math.sin(Math.PI / 6), 2 + 4 * Math.cos(Math.PI / 6)),
    ]
    const m = pathMetrics(moves, { x: -5, y: 0, z: Z })
    expect(m.turns).toBe(2)
    expect(m.flips).toBe(1)
    expect(m.maxFlipDeg).toBeCloseTo(30, 6)
  })

  it('a path with no arcs reads exactly as it always did', () => {
    // collectorTruth's zigzag, verbatim: 4 turns, 2 flips.
    const zigzag: ToolpathMove[] = [
      park, cut(0, 0), cut(10, 0), cut(10, 2), cut(20, 2), ride(20, 8), cut(30, 8), cut(30, 10), cut(40, 10),
    ]
    const m = pathMetrics(zigzag)
    expect(m.turns).toBe(4)
    expect(m.flips).toBe(2)
  })
})

describe('WO-3036 the committed record', () => {
  const record = (): StickRecord => JSON.parse(readFileSync('src/tests/evidence/WO-3036/stick-record.json', 'utf8')) as StickRecord
  type StickRecord = {
    torus: { key: string; linkSpikeRides: number; linkSpikeFeedMm: number; linkSpikeHopMm: number; linkSpikeFeedSharePct: number }
    rows: { key: string; before: { flipRatePct: number }; after: { flipRatePct: number } }[]
  }

  it('the form-torus row carries the spike rides WO-3027 measured', () => {
    // WO-3027 worker, by hand off the same moves: 46 rides, ~900 mm of feed where the
    // straight hops are 623 mm, ~11% of all feed. The stick's own count is in the record.
    // Held to that measurement within a stated band: the two readings differ in
    // where a ride's ends are taken, so the totals agree to ~15%, not to the mm.
    const torus = record().torus
    expect(torus.key).toBe('form-torus/top-default/adaptive_3d/starter-metric-2/whole')
    expect(Math.abs(torus.linkSpikeRides - 46)).toBeLessThanOrEqual(8)
    expect(Math.abs(torus.linkSpikeFeedMm - 900) / 900).toBeLessThanOrEqual(0.15)
    expect(Math.abs(torus.linkSpikeHopMm - 623) / 623).toBeLessThanOrEqual(0.15)
    expect(torus.linkSpikeFeedSharePct).toBeGreaterThan(8)
    expect(torus.linkSpikeFeedSharePct).toBeLessThan(12)
  })

  it('lists every arc row with its flip rate before and after', () => {
    expect(record().rows.length).toBeGreaterThan(0)
    for (const row of record().rows) {
      expect(Number.isFinite(row.before.flipRatePct), row.key).toBe(true)
      expect(Number.isFinite(row.after.flipRatePct), row.key).toBe(true)
    }
  })
})
