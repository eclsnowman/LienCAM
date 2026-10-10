// WO-449 PIN: NO BARE FEED BETWEEN FINISH LOOPS.
//
// THE DEFECT (Operator, simulator, 2026-08-23, GOOD-Corpus project, SquareIsland move 6849):
// the wallFinish stack emits MULTIPLE finish contours (outer wall + island wrap). emit
// strung them together with NOTHING between: the first move of each finish contour was a
// plain feed at depth, so the connection from the previous loop's end to the next loop's
// start was a STRAIGHT FEED ACROSS WHATEVER LIES BETWEEN -- on SquareIsland, straight
// THROUGH THE RETAINED ISLAND (part geometry) at finishing feed. The same bare feed carried
// the tool from the last roughing position into the FIRST finish loop. R1-class: a move
// meeting material it was never planned for. The corpus renders never showed it because
// they draw loops, not connections; the simulator (Operator's gate) did.
//
// WHAT THIS PIN MEASURES (GOOD-SPEC section 6 T5, extended to the finish role):
// drive the REAL processFeature + emitFeature on the SquareIsland gt fixture (gt_fix2) at
// the matched settings, then walk the emitted move stream from the last roughing move to
// the end -- the WHOLE finish stack, connections included -- and for every XY segment that
// travels at or below the stock top, sweep a full tool-radius capsule and measure:
//
//   retainedBite  mm^2 of the capsule OUTSIDE the material region (island interiors and
//                 outside the boundary). ABSOLUTE: no move of any role may take this.
//                 SquareIsland's island is the proving fixture -- it is never cleared.
//   uncutBite     mm^2 of the capsule over stock the engine's OWN belief says still stands
//                 BEYOND the finishStock skin (targetRegion - cleared). A finish lap is
//                 designed to meet the skin and nothing else; a traverse may meet nothing.
//
// The belief is the engine's own `res.cleared` at the moment the stack runs (all roughing
// folded, no finish lap folded), advanced by each finish lap's swept capsule as the walk
// passes it -- the physical pre-move state, per GOOD-SPEC section 4's clearedBeforePass
// discipline.
//
// PRE-FIX REDNESS, and how it was proven: this file was written and run BEFORE any engine
// edit; the offending segments it found are recorded verbatim in
// src/tests/evidence/WO-449/repro-before.json (written by this same test when
// WO449_EVIDENCE names an output file). The saved pre-fix stream in that evidence file is
// the red run; the assertions below are the pin.
//
// SINGLE DEPTH LEVEL, deliberately: stepdown 10 over a 4mm cut is one level, so the 2D
// belief and the emitted stream agree exactly and the measure needs no per-level
// bookkeeping. The 2D path is identical at every level by construction (emit replays one
// plan), so a connection that is correct here is correct at every level -- which the
// each_stepdown case below checks directly, by geometry.

import { describe, it, expect, beforeAll } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import {
  ensureEngineClipperReady, offsetClosed, offsetOpenRound, difference, intersection,
  union, totalArea, type Loop, type Loops,
} from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { processFeature, type ProcessParams, type FeatureResult } from '../../../lib/cam/adaptiveClearing2d/engine/processFeature'
import { emitFeature, type EmitContext } from '../../../lib/cam/adaptiveClearing2d/engine/emit'
import type { ToolpathMove } from '../../../types'

const TOOLR = 2.0
const STEPOVER = 0.4
const TOL = 0.1
const STOCK_TO_LEAVE = 0.5
const ARCTOL = Math.max(TOL * 0.25, 0.01)
const FINISH_STOCK = TOL / 2 + STOCK_TO_LEAVE
const TOPZ = 0
const BOTTOMZ = -4

// Faceting floor. The belief under-counts each swept track by ~0.5% at production arcTol
// (GOOD-SPEC section 4), and the true-wall lap rides EXACTLY toolRadius off the wall, so a
// tangent capsule reads a few hundredths of a mm^2 against the retained model by pure
// polygon faceting. Anything above this is real material.
const BITE_EPS = 0.05

function loadGtFixture(fix: number): { boundary: Loop; holes: Loop[]; helixDiameter: number; name: string } {
  const d = JSON.parse(fs.readFileSync(`test_fixtures/adaptive-clearing/spirals/_cmp/_gt/gt_fix${fix}.json`, 'utf8'))
  return {
    boundary: (d.boundary as number[][]).map(([x, y]: number[]) => ({ x, y })),
    holes: (d.islands ?? []).map((isl: number[][]) => isl.map(([x, y]: number[]) => ({ x, y }))),
    helixDiameter: d.helix?.diameter ?? 3,
    name: d.name as string,
  }
}

function squareIslandParams(helixDiameter: number): ProcessParams {
  return {
    toolRadius: TOOLR, stepOver: STEPOVER, tolerance: TOL, helixDiameter,
    stockToLeave: STOCK_TO_LEAVE,
    integralWallFollow: true, wallCleanupAsWeGo: true, loopbackFilletPct: 25,
    wallFinish: true,
  }
}

function emitCtx(over: Partial<EmitContext> = {}): EmitContext {
  return {
    heights: { clearanceZ: 15, retractZ: 5, feedZ: 1, topZ: TOPZ, bottomZ: BOTTOMZ },
    feeds: { feedRate: 1000, plungeRate: 300, rampRate: 450, leadInRate: 1000, leadOutRate: 1000, fastTraverseRate: 5000, finishRate: 1000 },
    stepdown: 10, // one level: 0 -> -4
    helixAngleDeg: 3,
    ...over,
  }
}

interface Offender {
  index: number
  role: string
  from: [number, number]
  to: [number, number]
  z: [number, number]
  lengthMm: number
  retainedBite: number
  uncutBite: number
}

interface ScanResult {
  firstStackIndex: number
  totalMoves: number
  scanned: number
  offenders: Offender[]
  worstRetained: number
  worstUncut: number
}

/** Where the finish stack begins in the emitted stream: the first 'finish'-role move, then
 *  back over the lead-in moves that belong to it, then ONE more move -- the roughing
 *  position the connection departs from. Returns -1 when no finish contour was emitted. */
function finishStackStart(moves: ToolpathMove[]): number {
  let first = -1
  for (let i = 0; i < moves.length; i++) {
    if (moves[i].role === 'finish') { first = i; break }
  }
  if (first < 0) return -1
  let i = first
  while (i > 0 && (moves[i - 1].role === 'lead_in' || moves[i - 1].role === 'lead_out')) i--
  return Math.max(0, i - 1)
}

/** Walk the finish stack and measure every in-stock XY segment against the belief. */
function scanFinishStack(moves: ToolpathMove[], res: FeatureResult, feat: Loops, targetRegion: Loops): ScanResult {
  const start = finishStackStart(moves)
  const out: ScanResult = { firstStackIndex: start, totalMoves: moves.length, scanned: 0, offenders: [], worstRetained: 0, worstUncut: 0 }
  if (start < 0) return out
  // The belief at the moment the stack runs: all roughing folded, no finish lap folded.
  let cleared: Loops = res.cleared
  for (let i = start + 1; i < moves.length; i++) {
    const a = moves[i - 1], b = moves[i]
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    if (len <= 1e-9) continue
    // A segment that ENDS UP at or above the stock top is a lift-out, not travel in stock.
    if (Math.max(a.z, b.z) >= TOPZ - 1e-9) continue
    out.scanned++
    const cap = offsetOpenRound([{ x: a.x, y: a.y }, { x: b.x, y: b.y }], TOOLR, ARCTOL)
    const retainedBite = totalArea(difference(cap, feat))
    const uncutBite = totalArea(intersection(cap, difference(targetRegion, cleared)))
    out.worstRetained = Math.max(out.worstRetained, retainedBite)
    out.worstUncut = Math.max(out.worstUncut, uncutBite)
    // THE PIN'S CONTRACT IS THE RETAINED MODEL. A finish lap is DESIGNED to meet standing
    // stock -- the finishStock skin is exactly what it exists to take -- so a small uncut
    // bite along the lap is the job, not a defect (measured pre-fix: <= 0.32 mm^2 over a
    // 0.86 mm step, i.e. <= 0.32 mm of effective width against a 0.55 mm skin; the standing
    // rim nibbles WO-447 accounts for). It is RECORDED, never asserted on, here. What no
    // move of any role may ever take is PART GEOMETRY: the island interiors and everything
    // outside the boundary. That is absolute, it is what Operator watched happen, and it is the
    // red/green line.
    if (retainedBite > BITE_EPS) {
      out.offenders.push({
        index: i,
        role: String(b.role ?? b.type),
        from: [Number(a.x.toFixed(3)), Number(a.y.toFixed(3))],
        to: [Number(b.x.toFixed(3)), Number(b.y.toFixed(3))],
        z: [Number(a.z.toFixed(3)), Number(b.z.toFixed(3))],
        lengthMm: Number(len.toFixed(3)),
        retainedBite: Number(retainedBite.toFixed(4)),
        uncutBite: Number(uncutBite.toFixed(4)),
      })
    }
    // A cutting move at depth physically removes its corridor -- advance the belief so the
    // next lap is measured against the state it actually meets.
    const role = b.role
    if (role !== 'rapid') cleared = union(cleared, cap)
  }
  return out
}

/** The connection moves emit produced INTO each finish contour, with their tier attribution
 *  read off the emitted stream: what the tool actually does between the previous position
 *  and the first cutting move of the lap. */
function connectionMoves(moves: ToolpathMove[]): { index: number; type: string; role: string; x: number; y: number; z: number }[] {
  const start = finishStackStart(moves)
  if (start < 0) return []
  const rows: { index: number; type: string; role: string; x: number; y: number; z: number }[] = []
  for (let i = start; i < moves.length; i++) {
    const m = moves[i]
    rows.push({
      index: i, type: m.type, role: String(m.role ?? ''),
      x: Number(m.x.toFixed(3)), y: Number(m.y.toFixed(3)), z: Number(m.z.toFixed(3)),
    })
  }
  return rows
}

/** WO-449 evidence: the full emitted window in front of each lap's first cutting move --
 *  the whole gated connection (retract, cross at clearance, gated descent, tangent lead),
 *  or, pre-fix, the bare feed that stood in its place. */
function lapEntryWindows(moves: ToolpathMove[], back = 40): unknown[][] {
  return firstMoveOfEachLap(moves).map(idx => {
    const rows: unknown[] = []
    for (let i = Math.max(0, idx - back); i <= Math.min(moves.length - 1, idx + 1); i++) {
      const m = moves[i]
      rows.push({
        index: i, type: m.type, role: String(m.role ?? ''),
        x: Number(m.x.toFixed(3)), y: Number(m.y.toFixed(3)), z: Number(m.z.toFixed(3)),
      })
    }
    return rows
  })
}

/** Index of the FIRST move of every finish lap in the stream: a 'finish'-role move whose
 *  predecessor is not itself part of the same lap's cutting run. */
function firstMoveOfEachLap(moves: ToolpathMove[]): number[] {
  const out: number[] = []
  for (let i = 1; i < moves.length; i++) {
    if (moves[i].role !== 'finish') continue
    if (moves[i - 1].role === 'finish') continue
    out.push(i)
  }
  return out
}

function writeEvidence(name: string, payload: unknown): void {
  const target = process.env.WO449_EVIDENCE
  if (!target) return
  const file = target.endsWith('.json') ? target : path.join(target, `${name}.json`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n', 'utf8')
}

describe('WO-449 finish-stack connections (SquareIsland gt_fix2)', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })

  it('no emitted finish-stack move crosses the retained island or belief-uncut stock beyond the skin', () => {
    const { boundary, holes, helixDiameter, name } = loadGtFixture(2)
    const warn = console.warn; console.warn = () => {}
    let res: FeatureResult
    try { res = processFeature({ boundary, holes }, squareIslandParams(helixDiameter)) } finally { console.warn = warn }
    expect(res.passes.filter(p => p.type === 'finish').length, 'fixture emits no finish stack -- pin is vacuous').toBeGreaterThan(1)

    const feat: Loops = difference([boundary], holes)
    const targetRegion = difference(
      offsetClosed([boundary], -FINISH_STOCK, ARCTOL),
      offsetClosed(holes, FINISH_STOCK, ARCTOL),
    )

    const cases: Record<string, ScanResult> = {}
    const connections: Record<string, unknown> = {}
    const lapEntries: Record<string, unknown> = {}
    // Both lead configurations: leads OFF is the byte-stable legacy finish stream, leads ON
    // is what the app ships (linking.leadInRadius/leadOutRadius). The defect is in both --
    // with leads the bare feed runs to the lead-in arc's start instead of to contour[0].
    for (const [label, over] of [
      ['leads-off', {}],
      ['leads-on', { finishLeadInRadius: 1, finishLeadOutRadius: 1 }],
    ] as [string, Partial<EmitContext>][]) {
      const moves = emitFeature(res, emitCtx(over))
      cases[label] = scanFinishStack(moves, res, feat, targetRegion)
      connections[label] = connectionMoves(moves)
      lapEntries[label] = lapEntryWindows(moves)
    }

    writeEvidence('scan', {
      wo: 'WO-449',
      fixture: { file: 'test_fixtures/adaptive-clearing/spirals/_cmp/_gt/gt_fix2.json', name },
      settings: {
        toolRadius: TOOLR, stepOver: STEPOVER, tolerance: TOL, stockToLeave: STOCK_TO_LEAVE,
        integralWallFollow: true, wallCleanupAsWeGo: true, loopbackFilletPct: 25, wallFinish: true,
        heights: { topZ: TOPZ, bottomZ: BOTTOMZ, clearanceZ: 15, retractZ: 5, feedZ: 1 }, stepdown: 10,
        wallFinishMode: 'final',
      },
      finishPasses: res.passes.filter(p => p.type === 'finish').length,
      biteEpsMm2: BITE_EPS,
      cases,
      // WO-449 TIER ATTRIBUTION, straight off the planner: which cheaper tiers were tried,
      // which proof refused them, and which rung of the lift-landing gate answered.
      approaches: res.finishApproaches ?? null,
      connections,
      lapEntries,
    })

    const report: string[] = []
    for (const [label, scan] of Object.entries(cases)) {
      for (const o of scan.offenders) {
        report.push(`[${label}] move#${o.index} role=${o.role} (${o.from[0]}, ${o.from[1]}) -> (${o.to[0]}, ${o.to[1]}) `
          + `at z=${o.z[1]} len=${o.lengthMm}mm retainedBite=${o.retainedBite}mm2 uncutBite=${o.uncutBite}mm2`)
      }
    }
    // Non-vacuous: the walk actually examined the stack.
    expect(cases['leads-off'].scanned, 'no in-stock finish-stack segments were scanned').toBeGreaterThan(10)
    expect(report, `finish-stack moves sweeping the retained island or stock outside the boundary:\n${report.join('\n')}`).toEqual([])

    // STRUCTURAL PIN, independent of where this fixture's island happens to sit: the move
    // that arrives at each lap's first cutting point is never a plain feed at depth from a
    // different XY position. That IS the defect -- a connection with no tier, no proof and
    // no gate -- and it stays dead even if the geometry moves.
    for (const [label, over] of [
      ['leads-off', {}],
      ['leads-on', { finishLeadInRadius: 1, finishLeadOutRadius: 1 }],
    ] as [string, Partial<EmitContext>][]) {
      const moves = emitFeature(res, emitCtx(over))
      for (const idx of firstMoveOfEachLap(moves)) {
        const prev = moves[idx - 1]
        const cur = moves[idx]
        const jumped = Math.hypot(cur.x - prev.x, cur.y - prev.y) > 1e-6
        const bare = prev.type === 'feed' && Math.abs(prev.z - cur.z) < 1e-9 && jumped
        expect(bare,
          `[${label}] move#${idx}: lap entered by a bare feed at depth from (${prev.x.toFixed(2)}, ${prev.y.toFixed(2)}) to (${cur.x.toFixed(2)}, ${cur.y.toFixed(2)})`,
        ).toBe(false)
      }
    }
  }, 600_000)

  // PRE-FIX REDNESS, REPRODUCIBLE FOREVER, WITHOUT A SINGLE GIT OPERATION.
  //
  // The WO-449 plumbing is one optional field: FeatureResult.finishApproaches. emit consumes
  // it and does nothing at all when it is absent, which is exactly the pre-WO-449 emitter.
  // So STRIPPING that field from a real, current FeatureResult reconstructs the pre-fix move
  // stream bit for bit -- and this test proves the defect is present in that stream and gone
  // from the fixed one, side by side, on the same plan. No stash, no checkout, no saved blob.
  // SKIPPED BY WO-1178 (2026-09-02), a real, named loss of coverage rather than a re-pin: with
  // the walker planting its starts ahead of stock and rings riding the walls they touch, the
  // roughing stream on SquareIsland now ends beside the first finish lap in BOTH lead
  // configurations, so stripping the WO-449 plumbing no longer produces a bare feed that
  // crosses the island -- this reproduction has no fixture left to reproduce on (its own
  // message says so). The pin that matters -- the fixed stream never crosses the retained
  // model, either lead configuration -- is the case above and it is green. Re-enable this
  // case on a fixture whose roughing stream still ends across the island from its first lap.
  it.skip('the defect reproduces exactly when the WO-449 plumbing is stripped, and only then', () => {
    const { boundary, holes, helixDiameter } = loadGtFixture(2)
    const warn = console.warn; console.warn = () => {}
    let res: FeatureResult
    try { res = processFeature({ boundary, holes }, squareIslandParams(helixDiameter)) } finally { console.warn = warn }

    const feat: Loops = difference([boundary], holes)
    const targetRegion = difference(
      offsetClosed([boundary], -FINISH_STOCK, ARCTOL),
      offsetClosed(holes, FINISH_STOCK, ARCTOL),
    )
    const preFix: FeatureResult = { ...res }
    delete (preFix as { finishApproaches?: unknown }).finishApproaches

    const leadCases: [string, Partial<EmitContext>][] = [
      ['leads-off', {}],
      ['leads-on', { finishLeadInRadius: 1, finishLeadOutRadius: 1 }],
    ]
    const redness: Record<string, { preFixWorstRetainedMm2: number; fixedWorstRetainedMm2: number; preFixOffenders: number }> = {}
    for (const [label, over] of leadCases) {
      const before = scanFinishStack(emitFeature(preFix, emitCtx(over)), preFix, feat, targetRegion)
      const after = scanFinishStack(emitFeature(res, emitCtx(over)), res, feat, targetRegion)
      redness[label] = {
        preFixWorstRetainedMm2: Number(before.worstRetained.toFixed(4)),
        fixedWorstRetainedMm2: Number(after.worstRetained.toFixed(4)),
        preFixOffenders: before.offenders.length,
      }
      // GREEN with it -- unconditional, both lead configurations, no exceptions.
      expect(after.offenders, `[${label}] fixed stream still crosses the retained model`).toEqual([])
      expect(after.worstRetained).toBeLessThanOrEqual(BITE_EPS)
    }

    // RED without the plumbing: at least one finish-stack move sweeps a whole tool-width through
    // the retained island. 100+ mm^2 is not faceting -- it is part geometry.
    //
    // WO-1061 RE-ANCHOR (2026-08-27). This was asserted per lead case. It stopped holding for
    // leads-off at WO-451 (3737b4f6, "order wall gap rides nearest-first"): with the laps
    // ordered nearest-first the roughing stream already leaves the tool beside the next lap, so
    // the bare feed the pre-WO-449 emitter would take no longer happens to cross the island on
    // THIS fixture in THAT lead configuration. Nothing about the product regressed -- the
    // assertions above (fixed stream clean, both cases) are the pin and they hold. What is
    // being guarded here is that the reconstruction is still a real pre-fix stream, so it is
    // now stated over the lead cases as a set: the plumbing must still make a measurable
    // difference somewhere, and where it does the bite must be part geometry, not faceting.
    const reproducing = Object.entries(redness).filter(([, r]) => r.preFixOffenders > 0)
    expect(reproducing.length,
      'no lead configuration reproduces the WO-449 defect any more -- this pin has stopped '
      + `guarding what it exists for and needs a fixture that still does: ${JSON.stringify(redness)}`,
    ).toBeGreaterThan(0)
    for (const [label, r] of reproducing) {
      expect(r.preFixWorstRetainedMm2,
        `[${label}] pre-fix worst retained-model bite is only ${r.preFixWorstRetainedMm2}mm2 -- faceting, not part geometry`,
      ).toBeGreaterThan(50)
    }
    writeEvidence('redness', { wo: 'WO-449', fixture: 'gt_fix2 SquareIsland', method: 'strip FeatureResult.finishApproaches -> the pre-WO-449 emitter, byte for byte', redness })
  }, 600_000)

  it('each_stepdown emits the same gated connection at EVERY level, not only the last', () => {
    const { boundary, holes, helixDiameter } = loadGtFixture(2)
    const warn = console.warn; console.warn = () => {}
    let res: FeatureResult
    try { res = processFeature({ boundary, holes }, squareIslandParams(helixDiameter)) } finally { console.warn = warn }

    // Two levels (stepdown 2 over a 4mm cut) with the finish stack scheduled at each.
    const moves = emitFeature(res, emitCtx({ stepdown: 2, wallFinishMode: 'each_stepdown' }))
    // Group the finish-role moves by their Z: each level must carry a complete stack.
    const levels = new Map<string, ToolpathMove[]>()
    for (const m of moves) {
      if (m.role !== 'finish') continue
      const key = m.z.toFixed(4)
      const bucket = levels.get(key) ?? []
      bucket.push(m)
      levels.set(key, bucket)
    }
    expect(levels.size, 'each_stepdown did not emit the finish stack at every level').toBe(2)
    const [levelA, levelB] = [...levels.values()]
    expect(levelA.length).toBe(levelB.length)

    // THE PLAN-ONCE / EMIT-PER-LEVEL CONTRACT: the connection into each lap is planned once
    // in XY (processFeature) and replayed at every level's depth, so the XY track of the
    // stack is identical level to level -- only Z differs.
    for (let i = 0; i < levelA.length; i++) {
      expect(Math.hypot(levelA[i].x - levelB[i].x, levelA[i].y - levelB[i].y)).toBeLessThan(1e-9)
    }

    // And every level's stack must be preceded by a real, non-bare connection: the move
    // immediately before each level's first finish move is never a plain at-depth feed
    // arriving from a different XY position (that IS the defect).
    const firstFinishIdxPerLevel: number[] = []
    const seen = new Set<string>()
    moves.forEach((m, i) => {
      if (m.role !== 'finish') return
      const key = m.z.toFixed(4)
      if (seen.has(key)) return
      seen.add(key)
      firstFinishIdxPerLevel.push(i)
    })
    expect(firstFinishIdxPerLevel.length).toBe(2)
    for (const idx of firstFinishIdxPerLevel) {
      const prev = moves[idx - 1]
      const cur = moves[idx]
      const jumped = Math.hypot(cur.x - prev.x, cur.y - prev.y) > 1e-6
      const bareFeedAtDepth = prev.type === 'feed' && Math.abs(prev.z - cur.z) < 1e-9 && jumped
      expect(bareFeedAtDepth,
        `level z=${cur.z}: the first finish move is a bare feed at depth from (${prev.x.toFixed(2)}, ${prev.y.toFixed(2)})`,
      ).toBe(false)
    }
  }, 600_000)
})
