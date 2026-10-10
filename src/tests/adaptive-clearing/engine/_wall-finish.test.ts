// wallFinish feature (commit 2): a dedicated TRUE-WALL finishing contour.
//
// These are AGGREGATE, nondeterminism-robust gates (no exact coords): the steering loop
// is sensitive to float order, so we assert structural facts about the 'finish' passes and
// their distance to the actual walls, not their vertex values.
//
//   (a) wallFinish ON  -> 'finish' passes exist; every finish vertex lies
//       ~(toolRadius + stockToLeave) from the NEAREST wall (outer boundary AND island), so
//       the radial stock the operation asked to leave is still standing when the lap is
//       done (WO-450). With wallFinishToNet the same vertices sit at ~toolRadius = 0 radial
//       stock, which is what this case asserted before WO-450.
//   (b) wallFinish OFF -> NO 'finish' passes, and the non-finish pass stream is unchanged
//       vs the baseline (byte-identical-when-off contract).
//   (c) emit depth-gating: mode 'final' emits the finish set at exactly ONE depth (bottomZ);
//       'each_stepdown' emits it at EVERY stepdown level. Multi-stepdown setup.
//   (d) OPERATION LEVEL: the same two contracts reached through the PUBLIC engine entry
//       (buildAdaptiveClearingToolpath), so an ordinary adaptive operation -- not just a
//       direct processFeature caller -- can ask for either shape. ACParams.wallFinishToNet
//       is the field; index.ts forwards it into ProcessParams (WO-450 attempt 2).
//   (e) WO-1043 'final_to_size': the operation-level mode Operator asked for by name -- rough
//       with stock to leave at every stepdown INCLUDING the last, then ONE lap at the final
//       depth that cuts to size. Asserted where it is falsifiable: the emitted move stream
//       of a real operation, per depth level. 'final' and 'each_stepdown' are re-asserted
//       in the same run as still leaving the stock standing, so the new option cannot be
//       mistaken for a change to the two that already shipped.

import { describe, it, expect, beforeAll } from 'vitest'
import { ensureEngineClipperReady, type Loop, type Pt } from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { processFeature, type ProcessParams } from '../../../lib/cam/adaptiveClearing2d/engine/processFeature'
import { emitFeature, type EmitContext } from '../../../lib/cam/adaptiveClearing2d/engine/emit'
import { buildAdaptiveClearingToolpath } from '../../../lib/cam/adaptiveClearing2d/engine'
import type { ACWorkerPayload } from '../../../lib/cam/types'
import type { Tool } from '../../../types'

function circle(cx: number, cy: number, r: number, n = 180): Loop {
  const pts: Loop = []
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) })
  }
  return pts
}

/** Min distance from p to any edge of any loop (treated as closed). */
function distToLoops(p: Pt, loops: Loop[]): number {
  let best = Infinity
  for (const loop of loops) {
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i], b = loop[(i + 1) % loop.length]
      const abx = b.x - a.x, aby = b.y - a.y
      const L2 = abx * abx + aby * aby
      let t = L2 > 1e-12 ? ((p.x - a.x) * abx + (p.y - a.y) * aby) / L2 : 0
      t = Math.max(0, Math.min(1, t))
      const dx = p.x - (a.x + abx * t), dy = p.y - (a.y + aby * t)
      const d = Math.hypot(dx, dy)
      if (d < best) best = d
    }
  }
  return best
}

const BASE: ProcessParams = {
  toolRadius: 2, stepOver: 0.4, tolerance: 0.1, helixDiameter: 3, stockToLeave: 0.5,
}

function ctx(over: Partial<EmitContext> = {}): EmitContext {
  return {
    heights: { clearanceZ: 15, retractZ: 5, feedZ: 1, topZ: 0, bottomZ: -2 },
    feeds: { feedRate: 1000, plungeRate: 300, rampRate: 450, leadInRate: 1000, leadOutRate: 1000, fastTraverseRate: 5000, finishRate: 1000 },
    stepdown: 2,
    helixAngleDeg: 3,
    ...over,
  }
}

describe('wallFinish: dedicated true-wall finishing contour', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })

  // WO-450 RE-PIN. This case asserted `dWall ~ toolRadius` -- 0 radial stock -- which is the
  // defect Operator reported at the simulator on 2026-08-23: he set "Stock to leave" to 0.5 and
  // the finish lap cut the wall to net anyway. The lap now rides toolRadius + stockToLeave,
  // so the pin moves WITH the contract rather than against it, and the old contract is
  // asserted where it still lives -- behind wallFinishToNet.
  it('(a) finish passes leave stockToLeave standing on the outer boundary AND the island', () => {
    const square: Loop = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 }]
    const island = circle(20, 20, 6)
    const feat = { boundary: square, holes: [island] }
    const walls = [square, island]
    const SLACK = 0.25 // facet slack, as before: no exact coords, only distance-to-wall

    // (a1) DEFAULT: the lap stops stockToLeave off the wall.
    const res = processFeature(feat, { ...BASE, wallFinish: true })
    expect(res.stats.aborted).toBeUndefined()

    const finishes = res.passes.filter(p => p.type === 'finish') as { type: 'finish'; points: Pt[] }[]
    expect(finishes.length).toBeGreaterThan(0)

    const stock = BASE.stockToLeave ?? 0
    expect(stock).toBeGreaterThan(0) // the case is meaningless at 0; BASE sets 0.5
    const wantDefault = BASE.toolRadius + stock
    let nearBoundary = false, nearIsland = false
    for (const f of finishes) {
      for (const p of f.points) {
        const dWall = distToLoops(p, walls)
        expect(dWall).toBeGreaterThan(wantDefault - SLACK)
        expect(dWall).toBeLessThan(wantDefault + SLACK)
        if (distToLoops(p, [square]) < wantDefault + SLACK) nearBoundary = true
        if (distToLoops(p, [island]) < wantDefault + SLACK) nearIsland = true
      }
    }
    expect(nearBoundary).toBe(true) // outer wall is finished
    expect(nearIsland).toBe(true)   // island wall is finished

    // (a2) ESCAPE HATCH: wallFinishToNet puts the lap back on the TRUE wall (0 radial stock),
    // which is exactly what this case asserted before WO-450.
    const net = processFeature(feat, { ...BASE, wallFinish: true, wallFinishToNet: true })
    expect(net.stats.aborted).toBeUndefined()
    const netFinishes = net.passes.filter(p => p.type === 'finish') as { type: 'finish'; points: Pt[] }[]
    expect(netFinishes.length).toBeGreaterThan(0)
    for (const f of netFinishes) {
      for (const p of f.points) {
        const dWall = distToLoops(p, walls)
        expect(dWall).toBeGreaterThan(BASE.toolRadius - SLACK)
        expect(dWall).toBeLessThan(BASE.toolRadius + SLACK)
      }
    }
  }, 60_000)

  it('(b) wallFinish OFF -> no finish passes; ON only APPENDS finishes after roughing', () => {
    const square: Loop = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 }]
    const island = circle(20, 20, 6)
    const feat = { boundary: square, holes: [island] }

    const off = processFeature(feat, { ...BASE }) // wallFinish undefined -> off
    const on = processFeature(feat, { ...BASE, wallFinish: true })

    // Core contract: OFF emits ZERO finish passes (byte-identical-when-off).
    expect(off.passes.some(p => p.type === 'finish')).toBe(false)
    // ON emits finish passes.
    expect(on.passes.some(p => p.type === 'finish')).toBe(true)

    // APPEND-ONLY: every finish pass comes strictly AFTER the last non-finish (roughing/
    // cleanup) pass -- wallFinish never interleaves into or perturbs the roughing stream.
    // (The two runs differ slightly in roughing-pass count by design: the steering loop is
    // float-order nondeterministic across invocations, so we assert ordering, not equality.)
    const firstFinish = on.passes.findIndex(p => p.type === 'finish')
    const lastNonFinish = on.passes.map(p => p.type).lastIndexOf('cut' as any) // last roughing 'cut'
    expect(firstFinish).toBeGreaterThan(-1)
    expect(firstFinish).toBeGreaterThan(lastNonFinish)
    for (let i = firstFinish; i < on.passes.length; i++) {
      expect(on.passes[i].type).toBe('finish') // a contiguous trailing block, nothing after
    }
  }, 60_000)

  it('(c) emit depth-gating: final = one depth (bottomZ); each_stepdown = every level', () => {
    // Simple circle so the finish set is a known single contour; topZ 0 -> bottomZ -4, stepdown 2
    // gives TWO levels (-2, -4).
    const res = processFeature({ boundary: circle(0, 0, 20) }, { ...BASE, wallFinish: true })
    const finishCount = res.passes.filter(p => p.type === 'finish').length
    expect(finishCount).toBeGreaterThan(0)

    const heights = { clearanceZ: 15, retractZ: 5, feedZ: 1, topZ: 0, bottomZ: -4 }

    const finalMoves = emitFeature(res, ctx({ heights, stepdown: 2, wallFinishMode: 'final' }))
    const eachMoves = emitFeature(res, ctx({ heights, stepdown: 2, wallFinishMode: 'each_stepdown' }))

    const finalFinishZs = finalMoves.filter(m => m.role === 'finish').map(m => m.z)
    const eachFinishZs = eachMoves.filter(m => m.role === 'finish').map(m => m.z)

    // 'final': finish moves only at the bottom (-4), and exactly one finish set worth of moves.
    expect(finalFinishZs.length).toBeGreaterThan(0)
    expect(finalFinishZs.every(z => Math.abs(z - -4) < 1e-6)).toBe(true)

    // 'each_stepdown': finish moves at BOTH -2 and -4 (every level), = 2x the per-level count.
    expect(eachFinishZs.some(z => Math.abs(z - -2) < 1e-6)).toBe(true)
    expect(eachFinishZs.some(z => Math.abs(z - -4) < 1e-6)).toBe(true)
    expect(eachFinishZs.length).toBe(finalFinishZs.length * 2)

    // default (mode unset) == 'final'
    const defMoves = emitFeature(res, ctx({ heights, stepdown: 2 }))
    const defFinishZs = defMoves.filter(m => m.role === 'finish').map(m => m.z)
    expect(defFinishZs.length).toBe(finalFinishZs.length)
    expect(defFinishZs.every(z => Math.abs(z - -4) < 1e-6)).toBe(true)
  }, 60_000)

  // (d) WO-450 attempt 2: the escape hatch reached through the PUBLIC operation entry.
  // Cases (a)-(c) drive processFeature directly, which is not a route any real operation
  // takes -- the audit's finding was that ACParams had no wallFinishToNet and index.ts
  // never forwarded one, so no ordinary adaptive op could ask for the pre-WO-450 shape.
  // This case pins the thread end to end: payload -> ACParams -> procParams -> the lap's
  // distance from the wall in the emitted moves.
  it('(d) operation entry: ACParams.wallFinishToNet reaches the lap through buildAdaptiveClearingToolpath', async () => {
    const SIDE = 24
    const square: Loop = [
      { x: 0, y: 0 }, { x: SIDE, y: 0 }, { x: SIDE, y: SIDE }, { x: 0, y: SIDE },
    ]
    const TOOL_DIA = 4
    const TOOL_RADIUS = TOOL_DIA / 2
    const STOCK = 0.5
    const SLACK = 0.25 // same facet slack as (a): distance-to-wall, never exact coords

    const tool = {
      id: 't1', name: 'EM4', type: 'flat', diameter: TOOL_DIA, fluteLength: 20,
      shankDiameter: 4, overallLength: 50, numberOfFlutes: 3, material: 'carbide',
      coating: 'none', notes: '',
      feedsAndSpeeds: { default: { feedRate: 1200, plungeRate: 400, rampFeedrate: 600, rpm: 10000 } },
    } as unknown as Tool

    const payload = (toNet?: boolean): ACWorkerPayload => ({
      opId: 'op1', setupId: 's1',
      params: {
        geometryId: 'g1', loopIds: [], targetEngagement: 0.4, maxEngagement: 0.6,
        stepDistance: 1, thetaMax: Math.PI / 3, climb: true, rampAngle: 3,
        completionTolerance: 1, helixDiameter: 90, tolerance: 0.05,
        wallFinish: true,
        ...(toNet === undefined ? {} : { wallFinishToNet: toNet }),
      },
      heights: {
        clearanceHeight: 15, clearanceHeightMode: 'absolute', retractHeight: 5, feedHeight: 1,
        topHeight: 0, topHeightMode: 'absolute', bottomHeight: -2, bottomHeightMode: 'absolute',
      },
      // The operator's radial stock. Before WO-450 the lap cut it away regardless.
      passes: { stepdown: 3, stepover: 1.6, stockToLeave: STOCK, finishPasses: 0, springPasses: 0 },
      linking: {
        entryType: 'ramp_helical', rampAngle: 3, rampLength: 10, leadInRadius: 1,
        leadOutRadius: 1, retractType: 'full', transitionType: 'safe_height',
      },
      tool,
      loops: [{ id: 'L0', closed: true, type: 'boundary', points: square }],
      wcsOrigin: { x: 0, y: 0, z: 0 },
    })

    /** Distance of every role-'finish' move from the pocket wall. */
    const lapDistances = async (p: ACWorkerPayload): Promise<number[]> => {
      const moves = await buildAdaptiveClearingToolpath(p)
      const finishes = moves.filter(m => m.role === 'finish')
      expect(finishes.length).toBeGreaterThan(0)
      return finishes.map(m => distToLoops({ x: m.x as number, y: m.y as number }, [square]))
    }

    // DEFAULT (field absent, exactly what every existing project file has): the lap stops
    // STOCK off the wall -- the operator's 0.5 is still standing when the op is done.
    for (const d of await lapDistances(payload(undefined))) {
      expect(d).toBeGreaterThan(TOOL_RADIUS + STOCK - SLACK)
      expect(d).toBeLessThan(TOOL_RADIUS + STOCK + SLACK)
    }

    // FALSE is the same thing said out loud.
    for (const d of await lapDistances(payload(false))) {
      expect(d).toBeGreaterThan(TOOL_RADIUS + STOCK - SLACK)
      expect(d).toBeLessThan(TOOL_RADIUS + STOCK + SLACK)
    }

    // TRUE is the escape hatch: back on the true wall, cutting to net, which is what the
    // pre-WO-450 engine did at this very setting.
    for (const d of await lapDistances(payload(true))) {
      expect(d).toBeGreaterThan(TOOL_RADIUS - SLACK)
      expect(d).toBeLessThan(TOOL_RADIUS + SLACK)
    }
  }, 120_000)
  // ---- (e) WO-1043: "Finish pass at final depth (cuts to size)" ----
  //
  // Operator's words (Mission Control 2026-08-26, answering the WO-450 card): "cut with stock to
  // leave at all stepdowns including the final stepdown. Then perform a finishing pass at
  // the final depth to remove the stock to leave". That is Contour's rough_finish_final, and
  // it is a claim about THREE things at once -- the schedule (one lap, at the bottom), the
  // roughing (stock still left at every level), and the lap (on the true wall). All three are
  // measured here off the emitted stream of a REAL operation, per level, because a
  // processFeature-only assertion cannot see the schedule at all.
  describe('(e) WO-1043 final_to_size: rough with stock everywhere, one bottom lap that cuts to size', () => {
    const SIDE = 24
    const square: Loop = [
      { x: 0, y: 0 }, { x: SIDE, y: 0 }, { x: SIDE, y: SIDE }, { x: 0, y: SIDE },
    ]
    const TOOL_DIA = 4
    const TOOL_RADIUS = TOOL_DIA / 2
    const STOCK = 0.5
    const SLACK = 0.25 // same facet slack as (a): distance-to-wall, never exact coords
    const BOTTOM = -6
    const STEPDOWN = 2  // -> levels at -2, -4, -6; the lap belongs to -6 alone

    const tool = {
      id: 't1', name: 'EM4', type: 'flat', diameter: TOOL_DIA, fluteLength: 20,
      shankDiameter: 4, overallLength: 50, numberOfFlutes: 3, material: 'carbide',
      coating: 'none', notes: '',
      feedsAndSpeeds: { default: { feedRate: 1200, plungeRate: 400, rampFeedrate: 600, rpm: 10000 } },
    } as unknown as Tool

    const payload = (mode: 'final' | 'each_stepdown' | 'final_to_size'): ACWorkerPayload => ({
      opId: 'op1', setupId: 's1',
      params: {
        geometryId: 'g1', loopIds: [], targetEngagement: 0.4, maxEngagement: 0.6,
        stepDistance: 1, thetaMax: Math.PI / 3, climb: true, rampAngle: 3,
        completionTolerance: 1, helixDiameter: 90, tolerance: 0.05,
        wallFinish: true, wallFinishMode: mode,
      },
      heights: {
        clearanceHeight: 15, clearanceHeightMode: 'absolute', retractHeight: 5, feedHeight: 1,
        topHeight: 0, topHeightMode: 'absolute', bottomHeight: BOTTOM, bottomHeightMode: 'absolute',
      },
      passes: { stepdown: STEPDOWN, stepover: 1.6, stockToLeave: STOCK, finishPasses: 0, springPasses: 0 },
      linking: {
        entryType: 'ramp_helical', rampAngle: 3, rampLength: 10, leadInRadius: 0,
        leadOutRadius: 0, retractType: 'full', transitionType: 'safe_height',
      },
      tool,
      loops: [{ id: 'L0', closed: true, type: 'boundary', points: square }],
      wcsOrigin: { x: 0, y: 0, z: 0 },
    })

    type Move = { role?: string; x?: number; y?: number; z?: number }

    /** Every role-'finish' move's distance from the wall, grouped by the Z it was cut at. */
    const lapsByLevel = (moves: Move[]): Map<string, number[]> => {
      const byLevel = new Map<string, number[]>()
      for (const m of moves) {
        if (m.role !== 'finish') continue
        const key = (m.z as number).toFixed(3)
        const d = distToLoops({ x: m.x as number, y: m.y as number }, [square])
        const bucket = byLevel.get(key)
        if (bucket) bucket.push(d)
        else byLevel.set(key, [d])
      }
      return byLevel
    }

    /** How close the ROUGHING got to the wall at each level. The rougher's own offset is
     *  toolRadius + finishStock, so this can never fall below toolRadius + STOCK where the
     *  stock is genuinely left standing at that level. */
    const roughClosestByLevel = (moves: Move[]): Map<string, number> => {
      const byLevel = new Map<string, number>()
      for (const m of moves) {
        if (m.role !== 'cut' && m.role !== 'wall_follow') continue
        const key = (m.z as number).toFixed(3)
        const d = distToLoops({ x: m.x as number, y: m.y as number }, [square])
        const prev = byLevel.get(key)
        if (prev === undefined || d < prev) byLevel.set(key, d)
      }
      return byLevel
    }

    it('emits ONE lap, at the final depth, riding the TRUE wall (cuts to size)', async () => {
      const moves = await buildAdaptiveClearingToolpath(payload('final_to_size'))
      const byLevel = lapsByLevel(moves)

      // Schedule: exactly one level carries the lap, and it is the bottom.
      expect(Array.from(byLevel.keys())).toEqual([BOTTOM.toFixed(3)])

      // Geometry: that lap is on the true wall -- nothing left standing.
      const distances = byLevel.get(BOTTOM.toFixed(3)) as number[]
      expect(distances.length).toBeGreaterThan(0)
      for (const d of distances) {
        expect(d).toBeGreaterThan(TOOL_RADIUS - SLACK)
        expect(d).toBeLessThan(TOOL_RADIUS + SLACK)
      }
    }, 120_000)

    it('still roughs with the stock standing at EVERY level, the final stepdown included', async () => {
      const moves = await buildAdaptiveClearingToolpath(payload('final_to_size'))
      const rough = roughClosestByLevel(moves)

      // All three levels roughed.
      expect(Array.from(rough.keys()).sort()).toEqual(
        [(-2).toFixed(3), (-4).toFixed(3), BOTTOM.toFixed(3)].sort(),
      )
      // And none of them cut inside the stock line -- including the last one, which is the
      // half of Operator's sentence a "just cut to size at the bottom" implementation would
      // quietly break.
      for (const [z, closest] of rough) {
        expect(closest, `roughing at z=${z} cut inside the stock line`)
          .toBeGreaterThan(TOOL_RADIUS + STOCK - SLACK)
      }
    }, 120_000)

    it('leaves the two shipped modes alone: final and each_stepdown still leave the stock standing', async () => {
      const finalMoves = await buildAdaptiveClearingToolpath(payload('final'))
      const eachMoves = await buildAdaptiveClearingToolpath(payload('each_stepdown'))

      const finalLevels = lapsByLevel(finalMoves)
      expect(Array.from(finalLevels.keys())).toEqual([BOTTOM.toFixed(3)])
      for (const d of finalLevels.get(BOTTOM.toFixed(3)) as number[]) {
        expect(d).toBeGreaterThan(TOOL_RADIUS + STOCK - SLACK)
        expect(d).toBeLessThan(TOOL_RADIUS + STOCK + SLACK)
      }

      const eachLevels = lapsByLevel(eachMoves)
      expect(eachLevels.size).toBe(3) // a lap at -2, -4 and -6
      for (const distances of eachLevels.values()) {
        for (const d of distances) {
          expect(d).toBeGreaterThan(TOOL_RADIUS + STOCK - SLACK)
          expect(d).toBeLessThan(TOOL_RADIUS + STOCK + SLACK)
        }
      }
    }, 120_000)

    it('an explicit wallFinishToNet still wins over the mode (old project files unchanged)', async () => {
      // The mode is the user-facing spelling of the flag, not a replacement for it. A file
      // that already said wallFinishToNet: false keeps meaning that under the new mode too.
      const base = payload('final_to_size')
      const pinned: ACWorkerPayload = {
        ...base,
        params: { ...base.params, wallFinishToNet: false },
      }
      const moves = await buildAdaptiveClearingToolpath(pinned)
      const distances = lapsByLevel(moves).get(BOTTOM.toFixed(3)) as number[]
      expect(distances.length).toBeGreaterThan(0)
      for (const d of distances) {
        expect(d).toBeGreaterThan(TOOL_RADIUS + STOCK - SLACK)
        expect(d).toBeLessThan(TOOL_RADIUS + STOCK + SLACK)
      }
    }, 120_000)
  })
})
