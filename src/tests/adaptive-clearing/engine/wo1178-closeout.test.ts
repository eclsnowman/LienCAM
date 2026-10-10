// WO-1178: the adaptive clearing close-out, one focused regression per item, at the GOOD
// corpus project's own settings (4 mm tool, 0.4D stepover, climb, 0.5 mm radial stock, wall
// finish on) through the engine's production parameter mapping. Diagnosis and census:
// src/tests/evidence/WO-1178/.
//
//   item 0  WO-1141B  the routed landing enters under the configured engagement, measured
//   item 1  WO-1177   corners are nibbled by the rings, progressively, under the cap
//   item 2  WO-439    pass counts sit within 1.2x Fusion's on every fixture, one entry each
//   item 3  WO-438    every fixture is inside the T1 retract budget (why the +10000 bias is moot)
//   item 4  WO-430    no credit without motion; no fed move over the 0.75-slot gate
//   item 5  WO-431    an exterior seed starts a side entry that clears its region
//
// Run: npx vitest run src/tests/adaptive-clearing/engine/wo1178-closeout.test.ts

import { describe, it, expect, beforeAll } from 'vitest'
import * as fs from 'fs'
import {
  ensureEngineClipperReady, diskPath, offsetOpenRound, union, difference, intersection, netArea, totalArea,
  type Loop, type Loops, type Pt,
} from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import {
  processFeature, contourOverCap, rideOverloadsUncut,
  type AdaptivePass, type ProcessParams, type FeatureResult,
} from '../../../lib/cam/adaptiveClearing2d/engine/processFeature'
import { createToolGeometry } from '../../../lib/cam/adaptiveClearing2d/engine/toolGeometry'
import { buildSideEntrySeed } from '../../../cam3d/rough/sideSeed'
import { ensureGeom2dReady, type Ring } from '../../../cam3d/geom2d'

const PROJECT = 'Example Projects/Adaptive Clearing Shapes.camproject'
const SHAPES = ['CommaSpiral', 'Kidney', 'SquareIsland', 'Tee', 'Bar', 'BootL', 'Triangle', 'Barbell', 'Boomerang']
// Fusion's recorded pass counts (GOOD-SPEC section 5, gt-census.md), same order.
const FUSION_PASSES: Record<string, number> = {
  CommaSpiral: 63, Kidney: 79, SquareIsland: 102, Tee: 59, Bar: 38, BootL: 107, Triangle: 60, Barbell: 54, Boomerang: 84,
}
// AC-SPEC section G region counts (_goodspec-helpers.ts FIXTURE_META), for the T1 budget.
const SPEC_REGIONS: Record<string, number> = {
  CommaSpiral: 1, Kidney: 2, SquareIsland: 4, Tee: 4, Bar: 1, BootL: 5, Triangle: 2, Barbell: 1, Boomerang: 2,
}
const T1_ALLOWANCE = 4

interface Fixture { boundary: Loop; holes: Loop[]; params: ProcessParams }

/** The project's own settings, or (canonical) the tripwire bank on the same geometry:
 *  0.2D stepover, wall finish off -- the second bank the census is measured at. */
function projectFixture(name: string, canonical = false): Fixture {
  const fx = projectFixtureAtProjectSettings(name)
  return canonical ? { ...fx, params: { ...fx.params, stepOver: 0.2, wallFinish: false } } : fx
}

function projectFixtureAtProjectSettings(name: string): Fixture {
  const project = JSON.parse(fs.readFileSync(PROJECT, 'utf8'))
  const operation = project.setups[0].operations.find((c: { name: string }) => c.name === `Adaptive Clearing - ${name}`)
  const geometry = project.geometry.find((c: { id: string }) => c.id === operation.params.geometryId)
  const tool = project.toolLibrary.find((c: { id: string }) => c.id === operation.toolId)
  const loops: Loop[] = geometry.loops.map((l: { points: Pt[] }) => l.points.map((p: Pt) => ({ x: p.x, y: p.y })))
  return {
    boundary: loops[0],
    holes: loops.slice(1),
    params: {
      toolRadius: tool.diameter / 2,
      stepOver: operation.passes.stepover / tool.diameter,
      tolerance: operation.params.tolerance,
      helixDiameter: tool.diameter * operation.params.helixDiameter / 100,
      // WO-1896: the corpus was measured on the stream each project's persisted bit selected
      // before climb was fixed to keep material right; the rule now names that stream the
      // other way round, so the census keeps measuring the same physical paths.
      millingDirection: operation.params.climb === false ? 'conventional' : 'climb',
      stockToLeave: operation.passes.stockToLeave,
      integralWallFollow: operation.params.integralWallFollow,
      integralWallFollowLengthFactor: operation.params.integralWallFollowLengthFactor,
      wallCleanupAsWeGo: operation.params.wallCleanupAsWeGo,
      loopbackFilletPct: operation.params.loopbackFilletPct,
      wallFinish: operation.params.wallFinish,
    },
  }
}

const plans = new Map<string, { fx: Fixture; res: FeatureResult; warnings: string[] }>()
function plan(name: string, canonical = false): { fx: Fixture; res: FeatureResult; warnings: string[] } {
  const key = canonical ? `${name}@canonical` : name
  const cached = plans.get(key)
  if (cached) return cached
  const fx = projectFixture(name, canonical)
  const warnings: string[] = []
  const warn = console.warn
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
  let res: FeatureResult
  try { res = processFeature({ boundary: fx.boundary, holes: fx.holes }, fx.params) } finally { console.warn = warn }
  const entry = { fx, res, warnings }
  plans.set(key, entry)
  return entry
}

/** Distance from `p` to the nearest edge of `loops`. */
function distToLoops(p: Pt, loops: Loops): number {
  let best = Infinity
  for (const loop of loops) {
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i], b = loop[(i + 1) % loop.length]
      const abx = b.x - a.x, aby = b.y - a.y
      const l2 = abx * abx + aby * aby
      let t = l2 > 1e-12 ? ((p.x - a.x) * abx + (p.y - a.y) * aby) / l2 : 0
      t = Math.max(0, Math.min(1, t))
      best = Math.min(best, Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t)))
    }
  }
  return best
}

const atDepth = (pass: AdaptivePass): pass is Exclude<AdaptivePass, { type: 'entry' }> =>
  pass.type !== 'entry' && !(pass.type === 'link' && pass.jumpType === 2)

/** Walk the emitted stream with the PHYSICAL belief (every at-depth motion sweeps its
 *  capsule, every entry opens its disk) and hand each pass to `visit` with the stock that
 *  stood when it executed. */
function replay(res: FeatureResult, R: number, arcTol: number, visit: (pass: AdaptivePass, index: number, before: Loops) => void): Loops {
  let cleared: Loops = []
  res.passes.forEach((pass, index) => {
    visit(pass, index, cleared)
    if (pass.type === 'entry') cleared = union(cleared, diskPath(pass.point, R + pass.radius, arcTol))
    else if (atDepth(pass) && pass.points.length >= 2) cleared = union(cleared, offsetOpenRound(pass.points, R, arcTol))
  })
  return cleared
}

describe('WO-1178 adaptive close-out', () => {
  beforeAll(async () => { await ensureEngineClipperReady(); await ensureGeom2dReady() })

  it('item 1 (WO-1177): the Bar\'s corners are nibbled by the rings, progressively deeper, every move under its cap', () => {
    const { fx, res } = plan('Bar')
    const R = fx.params.toolRadius
    const arcTol = Math.max(fx.params.tolerance * 0.25, 0.01)
    const tool = createToolGeometry(R, fx.params.stepOver, arcTol)
    const optimal = tool.optimalCutAreaPerDist
    const stepOverDistance = 2 * R * fx.params.stepOver
    const rideCap = 1.5 * stepOverDistance
    const cutCeiling = Math.min(2 * optimal, 0.75 * 2 * R)
    expect(res.stats.aborted).toBeUndefined()

    const xs = fx.boundary.map(p => p.x), ys = fx.boundary.map(p => p.y)
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys)
    const side = 3 * R
    const corners: Record<string, { apex: Pt; x0: number; x1: number; y0: number; y1: number }> = {
      topLeft: { apex: { x: minX, y: maxY }, x0: minX, x1: minX + side, y0: maxY - side, y1: maxY },
      topRight: { apex: { x: maxX, y: maxY }, x0: maxX - side, x1: maxX, y0: maxY - side, y1: maxY },
      bottomLeft: { apex: { x: minX, y: minY }, x0: minX, x1: minX + side, y0: minY, y1: minY + side },
      bottomRight: { apex: { x: maxX, y: minY }, x0: maxX - side, x1: maxX, y0: minY, y1: minY + side },
    }
    const inSquare = (p: Pt, c: typeof corners[string]) => p.x >= c.x0 && p.x <= c.x1 && p.y >= c.y0 && p.y <= c.y1
    const entersSquare = (pts: Pt[], c: typeof corners[string]) => {
      for (let i = 1; i < pts.length; i++) {
        const n = Math.max(2, Math.ceil(Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y) / 0.1))
        for (let k = 0; k <= n; k++) {
          const t = k / n
          if (inSquare({ x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t }, c)) return true
        }
      }
      return false
    }

    const offenders: string[] = []
    const cornerKinds: Record<string, Set<string>> = {}
    const cornerNibbles: Record<string, number[]> = {}
    replay(res, R, arcTol, (pass, index, before) => {
      if (!atDepth(pass) || pass.points.length < 2) return
      for (const [cname, c] of Object.entries(corners)) {
        if (!entersSquare(pass.points, c)) continue
        const kind = pass.type === 'link' ? 'link' : pass.type
        ;(cornerKinds[cname] ??= new Set()).add(kind)
        if (pass.type === 'cut') {
          const load = contourOverCap(pass.points, before, R, cutCeiling, arcTol, true)
          if (load.overLen > 0) offenders.push(`${cname} cut #${index} sustains ${load.peak.toFixed(2)} > ${cutCeiling.toFixed(2)}`)
          // The corner census: where each ring's arc ends, measured from the apex. Only passes
          // that START or END inside the square are nibbles; a rung that merely crosses the
          // square's edge on its way across the channel is not one.
          const end = pass.points[pass.points.length - 1]
          const start = pass.points[0]
          if (!inSquare(end, c) && !inSquare(start, c)) continue
          const nearer = Math.min(Math.hypot(end.x - c.apex.x, end.y - c.apex.y), Math.hypot(start.x - c.apex.x, start.y - c.apex.y))
          ;(cornerNibbles[cname] ??= []).push(nearer)
        } else {
          const trip = rideOverloadsUncut(pass.points, before, R, rideCap, arcTol)
          if (trip) offenders.push(`${cname} ${pass.type} #${index} sustains ${trip.width.toFixed(2)} > ride cap ${rideCap.toFixed(2)}`)
        }
      }
    })
    expect(offenders, offenders.join('\n')).toEqual([])

    // The signature Operator asked for: the corner is eaten by the rings themselves, progressively.
    // In every corner at least three cut passes enter the 3R square, and the closest point
    // each brings to the apex never retreats -- the arcs run deeper into the corner each time.
    // The same kinds of motion serve every corner (cuts, wall rides, loopbacks, keep-down
    // links) and no corner is reached by a retract.
    for (const [cname, nibbles] of Object.entries(cornerNibbles)) {
      expect(nibbles.length, `${cname}: cut passes entering the corner square`).toBeGreaterThanOrEqual(3)
      // Ignore the opening spiral (the first cut): the spiral touches the top corners once
      // before the ring sequence begins.
      const seq = nibbles.slice(nibbles.length >= 4 ? 1 : 0)
      for (let i = 1; i < seq.length; i++) {
        expect(seq[i], `${cname}: ring ${i} ends ${seq[i].toFixed(2)} mm from the apex after ${seq[i - 1].toFixed(2)} mm`).toBeLessThanOrEqual(seq[i - 1] + 0.5)
      }
      expect(seq[seq.length - 1], `${cname}: the last ring reaches the corner`).toBeLessThan(side)
    }
    for (const [cname, kinds] of Object.entries(cornerKinds)) {
      expect(kinds.has('cut'), `${cname} is cut by the rings`).toBe(true)
      expect(res.passes.filter(p => p.type === 'link' && p.jumpType === 2 && entersSquare(p.points, corners[cname])),
        `${cname} is never reached by a retract`).toHaveLength(0)
    }
    expect(Object.keys(cornerKinds).sort()).toEqual(['bottomLeft', 'bottomRight', 'topLeft', 'topRight'])
  }, 120_000)

  it('item 2 (WO-439): every corpus shape roughs in one entry and within 1.2x Fusion\'s pass count', () => {
    const rows: string[] = []
    for (const name of SHAPES) {
      const { res } = plan(name)
      const cuts = res.passes.filter(p => p.type === 'cut').length
      const ratio = cuts / FUSION_PASSES[name]
      rows.push(`${name} ${cuts}/${FUSION_PASSES[name]} = ${ratio.toFixed(3)} entries ${res.entries.length}`)
      expect(res.stats.aborted, `${name} aborted`).toBeUndefined()
      expect(res.entries, `${name} entries`).toHaveLength(1)
      // Before WO-1178 the corpus sat at 0.94-1.19x here (corner triangles ridden, not cut);
      // measured after: 0.95-1.16x. The bar is the round number just above both.
      expect(ratio, `${name}: ${cuts} cuts vs Fusion ${FUSION_PASSES[name]}`).toBeLessThanOrEqual(1.2)
    }
    console.log('[wo1178] passes vs Fusion:\n  ' + rows.join('\n  '))
  }, 600_000)

  it('item 3 (WO-438 residue): every shape is inside the T1 retract budget, and why the ancestor\'s link-cost bias has nothing to buy', () => {
    // FreeCAD's +10000 retract bias (Adaptive.cpp:4053) ranks a SET of candidate engage points
    // its multi-candidate search produced. This walker has no set to rank: it plants the next
    // start at the first rising in-band bite ahead of the previous start, in the cutting
    // direction, so the next engage point is adjacent to the pass that just ended by
    // construction and its connection is a tier-0/1 move whenever the ground between is
    // cleared. Three attempts to bolt a cost onto this first-hit walk each broke a binding
    // constraint (WO-438 record). The measured consequence of planting starts ahead of stock
    // instead: tier-3 lifts per shape here are 0-2 against budgets of 5-11, and 2 corpus-wide
    // at the tripwire settings (goodspec-tripwires.test.ts). There is no retract left for a
    // link-cost preference to remove; this pins that it stays so.
    for (const name of SHAPES) {
      const { res } = plan(name)
      const clearance = res.passes.filter(p => p.type === 'link' && p.jumpType === 2 && !p.microLift).length
      const budget = res.entries.length + (SPEC_REGIONS[name] - 1) + T1_ALLOWANCE
      expect(clearance, `${name}: ${clearance} full-clearance retracts against a budget of ${budget}`).toBeLessThanOrEqual(budget)
      expect(clearance, `${name}: full-clearance retracts`).toBeLessThanOrEqual(2)
    }
  }, 600_000)

  it('item 4 (WO-430): no credit without motion, and no fed move over the 0.75-slot gate', () => {
    for (const name of SHAPES) {
      const { fx, res } = plan(name)
      const R = fx.params.toolRadius
      const arcTol = Math.max(fx.params.tolerance * 0.25, 0.01)
      const gate = 0.75 * 2 * R
      const fed: string[] = []
      const swept = replay(res, R, arcTol, (pass, index, before) => {
        if (pass.type !== 'cut' && pass.type !== 'lead') return
        if (pass.points.length < 2) return
        const load = contourOverCap(pass.points, before, R, gate, arcTol, true)
        if (load.overLen > 0) fed.push(`${name} ${pass.type} #${index} sustains ${load.peak.toFixed(2)} > ${gate.toFixed(2)}`)
      })
      expect(fed, fed.join('\n')).toEqual([])
      // HONESTY: the engine's belief may not claim stock that no emitted motion removed. The
      // physical sweep above (entries' disks + every at-depth motion's capsule) must cover the
      // whole belief; the phantom seed disks WO-430 measured (182.8 mm2 on the tray) were belief
      // with no motion under it. Faceting between the engine's fold and this one is well under
      // a square millimetre on any corpus shape.
      const phantom = totalArea(difference(res.cleared, swept))
      expect(phantom, `${name}: ${phantom.toFixed(3)} mm2 of belief with no motion under it`).toBeLessThan(1.0)
      // And every entry the plan emits is a real entry: its disk is inside the belief.
      for (const e of res.entries) {
        if (e.mode === 'side') continue
        const disk = diskPath(e.point, R + e.radius, arcTol)
        expect(totalArea(difference(disk, res.cleared)), `${name}: entry at (${e.point.x.toFixed(2)}, ${e.point.y.toFixed(2)}) is credited`).toBeLessThan(0.05)
      }
    }
  }, 600_000)

  it('item 4b (WO-430): a seed whose default heading faces cleared ground still opens, and an orphaned seed is never credited', () => {
    // A square pocket with a slot to one side: the interior entry is planted where the slot's
    // width holds the helix and the default start (bottom of the disk, heading +x) faces the
    // already-cleared square. Before WO-1178 that pass cut nothing, the entry stayed pending
    // and the disk stayed credited.
    const boundary: Loop = [
      { x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 },
    ]
    const params: ProcessParams = {
      toolRadius: 2, stepOver: 0.4, tolerance: 0.1, helixDiameter: 3.8, stockToLeave: 0.5,
      millingDirection: 'climb', integralWallFollow: true, wallCleanupAsWeGo: true, loopbackFilletPct: 25,
    }
    const warn = console.warn; console.warn = () => {}
    let res: FeatureResult
    try { res = processFeature({ boundary }, params) } finally { console.warn = warn }
    const R = params.toolRadius
    const arcTol = Math.max(params.tolerance * 0.25, 0.01)
    const swept = replay(res, R, arcTol, () => {})
    expect(totalArea(difference(res.cleared, swept))).toBeLessThan(1.0)
    expect(res.entries.length).toBeGreaterThanOrEqual(1)
    for (const e of res.entries) expect(e.mode).toBe('helix')
  }, 120_000)

  it('item 0 (WO-1141B): Tee starts once and drills no second helix; every routed keep-down landing lead on the corpus, at both banks, is measured under the configured engagement', () => {
    const tee = plan('Tee')
    expect(tee.res.entries.filter(e => e.mode === 'helix')).toHaveLength(1)
    expect(tee.res.passes.filter(p => p.type === 'link' && p.helixDescent), 'no lift landing drills a helix').toHaveLength(0)
    expect(tee.warnings.filter(w => w.includes('descending via HELIX'))).toEqual([])

    // The routed keep-down landing rung (planGatedLanding: a landing disk with uncut stock,
    // whole-cutter-clear air beside it, no legal tangent lead) was reached on the corpus at
    // the project's settings by Boomerang's one lift, so the bound EXECUTED here (WO-1178
    // audit finding 2). Attempt 3 (tangent wall joins) removed that lift with the rest:
    // measured at the project's settings, at the tripwire bank and in the conventional
    // direction, no corpus shape lifts onto a landing that needs the rung any more, so this
    // case now walks BOTH banks and holds every routed lead that exists -- and reports how
    // many it found. The rung's OWN fixture -- the one that reaches the all-gouge admission
    // by construction and asserts the bound on an executing lead, admitted and refused -- is
    // wo1178-routed-landing-bound.test.ts (audit round 3). Every lead that follows a routed
    // traverse here is held to
    // the configured radial engagement on both the windowed peak (sentinel bypassed) and the
    // deepest 0.75 mm sub-step bite, against the PHYSICAL stock that stood when it ran. No
    // sentinel, no padding.
    let leads = 0
    let routedLines = 0
    for (const canonical of [false, true]) for (const name of SHAPES) {
      const { fx, res, warnings } = plan(name, canonical)
      const R = fx.params.toolRadius
      const arcTol = Math.max(fx.params.tolerance * 0.25, 0.01)
      const stepOverDistance = 2 * R * fx.params.stepOver
      const routed = new Set(res.routedLoopbackPassIndices ?? [])
      replay(res, R, arcTol, (pass, index, before) => {
        if (pass.type !== 'lead' || !routed.has(index - 1)) return
        leads++
        const load = contourOverCap(pass.points, before, R, stepOverDistance, arcTol, true)
        expect(load.maxStep, `${name} routed lead #${index} deepest sub-step bite`).toBeLessThanOrEqual(stepOverDistance + 0.05)
        expect(load.peak, `${name} routed lead #${index} windowed peak`).toBeLessThanOrEqual(stepOverDistance + 0.05)
        expect(load.maxStep, `${name} routed lead #${index} really cuts`).toBeGreaterThan(0)
      })
      // The routed-landing console line names a measured peak and the bound it met, and the
      // bound is the configured engagement whenever no tangent lead was refused on load alone.
      for (const w of warnings.filter(w => w.includes('STAYING DOWN via'))) {
        routedLines++
        const m = w.match(/measuring ([\d.]+)mm2\/mm over the window and ([\d.]+)mm2\/mm at its deepest sub-step, both <= the ([\d.]+)mm2\/mm (configured radial engagement|0\.75-slot ceiling)/)
        expect(m, w).not.toBeNull()
        expect(Number(m![1])).toBeGreaterThan(0)
        expect(Number(m![2])).toBeLessThanOrEqual(Number(m![3]) + 1e-6)
        if (m![4] === 'configured radial engagement') expect(Number(m![3])).toBeCloseTo(stepOverDistance, 6)
      }
    }
    expect(routedLines).toBe(leads)
    console.log(`[wo1178] routed keep-down landing leads measured on the corpus (both banks): ${leads}`)
  }, 600_000)

  it('item 6 (Operator\'s Bar finding, attempt 3): the path meets and leaves every wall on a tangent -- no join on a wall turns by 20 degrees or more, away from the apexes', () => {
    // Measured on the gated head (attempt 2): joins on the Bar's walls turned by up to 71.4
    // degrees (three over 20) -- a ring clipped at the wall and rode off along the tangent, a
    // planted start left on the stepper's 45-degree first step. After the fillet and the
    // curvature-limited lead: max 11.5 degrees, none over 20 (src/tests/evidence/WO-1178/
    // _probe/wall-joins.mjs). Apexes are excluded: a corner vertex has no single wall to
    // blend into and the last nibble there is a fraction of a millimetre long.
    const { fx, res } = plan('Bar')
    const R = fx.params.toolRadius
    const region = res.cutRegion
    const vertices = region.flat()
    const nearApex = (p: Pt) => vertices.some(v => Math.hypot(v.x - p.x, v.y - p.y) < R / 2)
    const onWall = (p: Pt) => distToLoops(p, region) <= 0.05
    const verts: { q: Pt; pass: number }[] = []
    res.passes.forEach((p, k) => {
      if (!atDepth(p)) { verts.push({ q: { x: NaN, y: NaN }, pass: -1 }); return }
      for (const q of p.points) verts.push({ q, pass: k })
    })
    const turns: { deg: number; at: Pt; passes: string }[] = []
    for (let n = 1; n + 1 < verts.length; n++) {
      const a = verts[n - 1], b = verts[n], c = verts[n + 1]
      if (a.pass < 0 || b.pass < 0 || c.pass < 0) continue
      if (!onWall(b.q) || nearApex(b.q)) continue
      const u = { x: b.q.x - a.q.x, y: b.q.y - a.q.y }, v = { x: c.q.x - b.q.x, y: c.q.y - b.q.y }
      const lu = Math.hypot(u.x, u.y), lv = Math.hypot(v.x, v.y)
      if (lu < 1e-9 || lv < 1e-9) continue
      const deg = Math.acos(Math.max(-1, Math.min(1, (u.x * v.x + u.y * v.y) / (lu * lv)))) * 180 / Math.PI
      turns.push({ deg, at: b.q, passes: `${res.passes[a.pass].type}#${a.pass}->${res.passes[c.pass].type}#${c.pass}` })
    }
    expect(turns.length, 'wall joins measured').toBeGreaterThan(100)
    const sharp = turns.filter(t => t.deg >= 20).map(t => `${t.deg.toFixed(1)}deg at (${t.at.x.toFixed(2)}, ${t.at.y.toFixed(2)}) ${t.passes}`)
    expect(sharp, sharp.join('\n')).toEqual([])
    const worst = Math.max(...turns.map(t => t.deg))
    console.log(`[wo1178] Bar wall joins: ${turns.length}, worst ${worst.toFixed(1)} degrees`)
  }, 120_000)

  it('item 7 (Operator\'s Tee finding, attempt 3): the rounded inside corners where the stem meets the base are followed by one forward wall ride, never hopped', () => {
    // Measured on the gated head: a 3.2 mm tier-2 micro-lift across the right-hand fillet
    // (129.53, -131.61) -> (127.02, -129.56), attributed 'gouge + arc-too-long + detour over
    // budget + stop-short refused' -- the exit and entry cusp rides had overlapped on the arc
    // and the connection between their far ends ran backward along it. After: one forward
    // wall ride from the spiral's end to the next cut's start, no link, no loopback, no lift.
    const { fx, res } = plan('Tee')
    const R = fx.params.toolRadius
    // The inside corners: the boundary's reflex vertices (the turn there opposes the loop).
    const b = fx.boundary
    let twice = 0
    for (let i = 0; i < b.length; i++) { const p = b[i], q = b[(i + 1) % b.length]; twice += p.x * q.y - q.x * p.y }
    const ccw = twice > 0
    const reflex: { v: Pt; inward: Pt }[] = []
    for (let i = 0; i < b.length; i++) {
      const p = b[(i - 1 + b.length) % b.length], v = b[i], n = b[(i + 1) % b.length]
      const cross = (v.x - p.x) * (n.y - v.y) - (v.y - p.y) * (n.x - v.x)
      if ((cross < 0) !== ccw) continue
      // The bisector pointing into the pocket: opposite the sum of the two edge directions.
      const u1 = { x: p.x - v.x, y: p.y - v.y }, u2 = { x: n.x - v.x, y: n.y - v.y }
      const l1 = Math.hypot(u1.x, u1.y), l2 = Math.hypot(u2.x, u2.y)
      const s = { x: -(u1.x / l1 + u2.x / l2), y: -(u1.y / l1 + u2.y / l2) }
      const ls = Math.hypot(s.x, s.y)
      reflex.push({ v, inward: { x: s.x / ls, y: s.y / ls } })
    }
    expect(reflex, 'the Tee has two inside corners').toHaveLength(2)
    const near = (p: Pt, v: Pt) => Math.hypot(p.x - v.x, p.y - v.y) <= 2 * R
    for (const { v, inward } of reflex) {
      const label = `inside corner (${v.x.toFixed(2)}, ${v.y.toFixed(2)})`
      // A 'lead' is a fed engage (the departure fillet off the ride's end), not a hop.
      const isHop = (p: AdaptivePass): p is Extract<AdaptivePass, { type: 'link' | 'loopback' }> => p.type === 'link' || p.type === 'loopback'
      const hops = res.passes.filter(isHop).filter(p => p.points.length >= 2 && near(p.points[0], v) && near(p.points[p.points.length - 1], v))
      expect(hops.map(p => `${p.type}${p.type === 'link' ? p.jumpType : ''} (${p.points[0].x.toFixed(2)}, ${p.points[0].y.toFixed(2)}) -> (${p.points[p.points.length - 1].x.toFixed(2)}, ${p.points[p.points.length - 1].y.toFixed(2)})`),
        `${label}: no link or loopback crosses the fillet`).toEqual([])
      const lifts = res.passes.filter(p => p.type === 'link' && p.jumpType === 2 && (near(p.points[0], v) || near(p.points[1], v)))
      expect(lifts, `${label}: no lift starts or lands at the fillet`).toHaveLength(0)
      // The corner is ridden: a wall-follow pass runs round the fillet arc -- its tool centre
      // passes the arc's midpoint (R + stock from the vertex on the inward bisector).
      const arcR = R + (fx.params.stockToLeave ?? 0)
      const mid = { x: v.x + inward.x * arcR, y: v.y + inward.y * arcR }
      const withPoints = (p: AdaptivePass): p is Exclude<AdaptivePass, { type: 'entry' }> => p.type !== 'entry'
      const rides = res.passes.filter(withPoints).filter(p => p.type === 'wallfollow'
        && p.points.some(q => Math.hypot(q.x - mid.x, q.y - mid.y) <= 0.3))
      expect(rides.length, `${label}: a wall ride passes the fillet's midpoint (${mid.x.toFixed(2)}, ${mid.y.toFixed(2)})`).toBeGreaterThan(0)
    }
  }, 120_000)

  it('item 5 (WO-431): an exterior seed opens the stock edge, the roll-in stands inside the tool-centre region, and the region clears from the outside in', () => {
    const footprint: Ring[] = [new Float64Array([-30, -30, 30, -30, 30, 30, -30, 30])]
    const toolRadius = 3
    const feat = {
      boundary: [{ x: -30, y: -30 }, { x: 30, y: -30 }, { x: 30, y: 30 }, { x: -30, y: 30 }] as Loop,
      holes: [[{ x: -5, y: -5 }, { x: -5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: -5 }] as Loop],
    }
    const params: ProcessParams = {
      toolRadius, stepOver: 0.4, tolerance: 0.1, helixDiameter: 3, stockToLeave: 0,
      integralWallFollow: true, integralWallFollowLengthFactor: 2,
    }
    const seed: Loops = buildSideEntrySeed(footprint, toolRadius)
    const warn = console.warn; console.warn = () => {}
    let res: FeatureResult
    try { res = processFeature(feat, { ...params, clearedSeed: seed }) } finally { console.warn = warn }
    expect(res.stats.aborted).toBeUndefined()
    expect(res.entries.length).toBeGreaterThanOrEqual(1)
    expect(res.entries.every(e => e.mode === 'side'), 'every entry rolls in from the air').toBe(true)
    // The stock part of the region is cleared: the tool-centre region minus the seed's air.
    const stockRegion = difference(res.cutRegion, seed)
    const covered = netArea(intersection(res.cleared, stockRegion))
    const total = Math.abs(netArea(stockRegion))
    expect(covered).toBeGreaterThanOrEqual(0.95 * total)
    // The roll-in centre is a legal tool position: inside the region (the seed's air is part of
    // it now), never in the part -- its cutter would pass the finish skin otherwise.
    for (const e of res.entries) {
      const inside = res.cutRegion.some(loop => {
        let c = false
        for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
          if ((loop[i].y > e.point.y) !== (loop[j].y > e.point.y)
            && e.point.x < (loop[j].x - loop[i].x) * (e.point.y - loop[i].y) / (loop[j].y - loop[i].y) + loop[i].x) c = !c
        }
        return c
      })
      expect(inside, `roll-in at (${e.point.x.toFixed(2)}, ${e.point.y.toFixed(2)}) stands in the tool-centre region`).toBe(true)
    }
    // The island's walls keep their finish stock: no at-depth motion's cutter enters the island.
    const islandKeepOut = offsetOpenRound([...feat.holes[0], feat.holes[0][0]], 0, arcTolOf(params))
    void islandKeepOut
    const island: Loops = [feat.holes[0]]
    for (const pass of res.passes) {
      if (!atDepth(pass) || pass.points.length < 2) continue
      const sweep = offsetOpenRound(pass.points, toolRadius - (params.tolerance / 2), arcTolOf(params))
      expect(totalArea(intersection(sweep, island)), `${pass.type} enters the island`).toBeLessThan(0.05)
    }
  }, 120_000)
})

function arcTolOf(params: ProcessParams): number { return Math.max(params.tolerance * 0.25, 0.01) }
