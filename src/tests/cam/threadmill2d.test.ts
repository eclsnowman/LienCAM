import { describe, it, expect } from 'vitest'
import { buildThreadMillToolpath } from '../../lib/cam/threadmill2d'
import { HELIX_FI_STEP } from '../../lib/cam/threadHelix'
import { estimateRuntimeMs } from '../../lib/cam/runtime'
import type { ThreadMillParams, ThreadMillWorkerPayload, LoopData } from '../../lib/cam/types'
import type { Tool, HeightParams, PassParams, LinkingParams, ToolpathMove } from '../../types'

// ── Fixtures ──────────────────────────────────────────────────────────────────
// A single circular pre-drilled hole of 8.5mm diameter (the standard M10x1.5 tap
// drill), sampled as a polygon, centered at the origin (plus extra holes for
// multi-hole tests). Threading an M10x1.5 internal thread with a 6mm thread mill
// -> R_final = 10/2 - 6/2 = 2.0 mm. Real radial span per hole =
// (majorDiameter - holeDia)/2 = (10 - 8.5)/2 = 0.75 mm (R_start 1.25 -> R_final 2.0).

function makeTool(diameter = 6): Tool {
  return {
    id: 't1', name: `O${diameter} thread mill`, type: 'thread_mill',
    diameter, fluteLength: 30, shankDiameter: diameter, overallLength: 60,
    numberOfFlutes: 3, material: 'carbide', coating: 'none', notes: '',
    feedsAndSpeeds: { default: { rpm: 6000, feedRate: 400, plungeRate: 120, depthOfCut: 5, stepover: 1 } },
  } as Tool
}

function makeHeights(top = 0, bottom = -9): HeightParams {
  return {
    clearanceHeight: 10, clearanceHeightMode: 'absolute',
    retractHeight: 5, feedHeight: 1,
    topHeight: top, topHeightMode: 'absolute',
    bottomHeight: bottom, bottomHeightMode: 'absolute',
  }
}

const passes: PassParams = {
  stepdown: 5, stepover: 1, stockToLeave: 0, finishPasses: 0, springPasses: 0,
}

const linking: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
}

// Circular hole loop sampled as an N-gon centered on (cx, cy).
function holeLoop(id: string, dia = 8.5, cx = 0, cy = 0, n = 64): LoopData {
  const r = dia / 2
  const points = []
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * Math.PI
    points.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) })
  }
  return { id, closed: true, type: 'contour', points }
}

function makeParams(over: Partial<ThreadMillParams> = {}): ThreadMillParams {
  return {
    geometryId: 'g1', loopIds: [],
    threadKind: 'internal', majorDiameter: 10, pitch: 1.5,
    handedness: 'right', cutDirection: 'climb',
    roughingPasses: 1, springPasses: 0,
    leadInOut: 'arc', compensation: 'computer',
    ...over,
  }
}

function makePayload(
  params: ThreadMillParams,
  loops: LoopData[] = [holeLoop('h1')],
  heights: HeightParams = makeHeights(),
  tool: Tool = makeTool(),
): ThreadMillWorkerPayload {
  return {
    opId: 'op', setupId: 'su', params, heights, passes, linking,
    tool, loops, wcsOrigin: { x: 0, y: 0, z: 0 },
  }
}

const R_FINAL = 10 / 2 - 6 / 2  // 2.0 mm

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('buildThreadMillToolpath — emission', () => {
  it('returns a non-empty ToolpathMove[] containing all expected roles', () => {
    const moves = buildThreadMillToolpath(makePayload(makeParams()))
    expect(moves.length).toBeGreaterThan(0)
    const roles = new Set(moves.map(m => m.role))
    for (const r of ['plunge', 'lead_in', 'helix', 'lead_out', 'rapid']) {
      expect(roles.has(r as ToolpathMove['role'])).toBe(true)
    }
  })

  it('helix: rev count, endpoints (thread top reached, exit climb to feed), and orbit radius', () => {
    const moves = buildThreadMillToolpath(makePayload(makeParams()))
    const helix = moves.filter(m => m.role === 'helix')
    expect(helix.length).toBeGreaterThan(0)

    // The helix climbs bottomZ(-9) -> topZ(0) [the thread] -> feedZ(+1) [the exit
    // climb that lifts the cutter fully out of the hole before lead-out/retract].
    // revs over the FULL climb = (feedZ - bottomZ)/pitch = 10/1.5 = 6.667.
    const revs = (1 - (-9)) / 1.5
    const expected = revs * (2 * Math.PI / HELIX_FI_STEP)
    expect(Math.abs(helix.length - expected)).toBeLessThan(6)

    // First point at bottomZ; the thread top (topZ = 0) is reached; the last
    // point lands on the feed plane (exit climb fully out of the hole).
    expect(helix[0].z).toBe(-9)
    expect(helix.some(m => Math.abs(m.z - 0) < 1e-9)).toBe(true)
    expect(helix[helix.length - 1].z).toBeCloseTo(1, 9)

    // Every helix point (thread + exit climb) at R_final from the hole center.
    for (const m of helix) {
      const r = Math.hypot(m.x - 0, m.y - 0)
      expect(Math.abs(r - R_FINAL)).toBeLessThan(1e-6)
    }
  })

  it('exit climb: the lead-out happens at the feed plane (tool clear of the hole), not at the thread top', () => {
    const moves = buildThreadMillToolpath(makePayload(makeParams()))
    const leadOut = moves.filter(m => m.role === 'lead_out')
    expect(leadOut.length).toBeGreaterThan(0)
    // Every lead-out move is at the feed plane (+1), above the thread top (0).
    for (const m of leadOut) expect(m.z).toBeCloseTo(1, 9)
  })

  it('helix Z is strictly increasing', () => {
    const moves = buildThreadMillToolpath(makePayload(makeParams()))
    const helix = moves.filter(m => m.role === 'helix')
    for (let i = 1; i < helix.length; i++) {
      expect(helix[i].z).toBeGreaterThan(helix[i - 1].z)
    }
  })

  it('estimateRuntimeMs returns a finite number > 0', () => {
    const moves = buildThreadMillToolpath(makePayload(makeParams()))
    const ms = estimateRuntimeMs(moves, 5000)
    expect(Number.isFinite(ms)).toBe(true)
    expect(ms).toBeGreaterThan(0)
  })

  it('multiple holes: one entry (plunge) per hole and each hole gets a helix', () => {
    const loops = [holeLoop('h1', 8.5, 0, 0), holeLoop('h2', 8.5, 30, 0)]
    const moves = buildThreadMillToolpath(makePayload(makeParams(), loops))

    // One pass per hole -> exactly 2 plunge moves.
    const plunges = moves.filter(m => m.role === 'plunge')
    expect(plunges.length).toBe(2)

    // Both holes get a helix (helix points exist around both centers).
    const helix = moves.filter(m => m.role === 'helix')
    const nearH1 = helix.some(m => Math.hypot(m.x - 0, m.y - 0) < R_FINAL + 1e-6)
    const nearH2 = helix.some(m => Math.hypot(m.x - 30, m.y - 0) < R_FINAL + 1e-6)
    expect(nearH1).toBe(true)
    expect(nearH2).toBe(true)
  })

  it('roughingPasses=3 + springPasses=2 -> 5 plunge moves for one hole', () => {
    const moves = buildThreadMillToolpath(
      makePayload(makeParams({ roughingPasses: 3, springPasses: 2 })),
    )
    const plunges = moves.filter(m => m.role === 'plunge')
    expect(plunges.length).toBe(5)
  })

  it('radialStepover drives the infeed pass count (and overrides roughingPasses)', () => {
    // REAL span = (majorDiameter - holeDia)/2 = (10 - 8.5)/2 = 0.75 mm
    // (R_final 2.0 -> R_start 1.25). stepover 0.3 -> ceil(0.75/0.3) = ceil(2.5) = 3
    // rough passes. roughingPasses is ignored when stepover set.
    const moves = buildThreadMillToolpath(
      makePayload(makeParams({ radialStepover: 0.3, roughingPasses: 99 })),
    )
    expect(moves.filter(m => m.role === 'plunge').length).toBe(3)

    // A bigger bite than the whole span (0.75) -> a single pass.
    const coarse = buildThreadMillToolpath(
      makePayload(makeParams({ radialStepover: 5, roughingPasses: 99 })),
    )
    expect(coarse.filter(m => m.role === 'plunge').length).toBe(1)

    // No stepover -> legacy roughingPasses count still applies.
    const legacy = buildThreadMillToolpath(
      makePayload(makeParams({ radialStepover: undefined, roughingPasses: 4 })),
    )
    expect(legacy.filter(m => m.role === 'plunge').length).toBe(4)
  })

  it('per-hole schedule: different hole diameters -> different plunge counts (narrower hole = more passes)', () => {
    // REAL geometry is computed PER HOLE. majorDiameter 10, radialStepover 0.3:
    //  - Hole A (dia 8.0): spanReal = (10 - 8.0)/2 = 1.0 -> ceil(1.0/0.3) = 4 passes
    //  - Hole B (dia 9.0): spanReal = (10 - 9.0)/2 = 0.5 -> ceil(0.5/0.3) = 2 passes
    // The narrower pre-drilled hole has a larger radial span, so it gets MORE
    // infeed passes. A shared approximate span could never produce this.
    const loops = [holeLoop('hA', 8.0, 0, 0), holeLoop('hB', 9.0, 30, 0)]
    const moves = buildThreadMillToolpath(
      makePayload(makeParams({ radialStepover: 0.3, roughingPasses: 99 }), loops),
    )
    const plunges = moves.filter(m => m.role === 'plunge')
    const plungesA = plunges.filter(m => Math.abs((m.x ?? 0) - 0) < 1e-6).length
    const plungesB = plunges.filter(m => Math.abs((m.x ?? 0) - 30) < 1e-6).length
    expect(plungesA).toBe(4)
    expect(plungesB).toBe(2)
    expect(plunges.length).toBe(6)
  })
})

describe('buildThreadMillToolpath — external (mechanical mirror)', () => {
  // External M10x1.5 with a 6mm thread mill. R_final now reaches the thread ROOT:
  // majorDiameter/2 + toolR - 0.6*pitch = 5 + 3 - 0.9 = 7.1 mm (the crest orbit
  // radius would be 8.0; stopping there under-cuts the thread). The cutter orbits
  // OUTSIDE the solid boss and must never touch its center.
  const R_FINAL_EXT = 10 / 2 + 6 / 2 - 0.6 * 1.5  // 7.1 mm (root)

  function helixSense(moves: ToolpathMove[], cx = 0, cy = 0): number {
    const helix = moves.filter(m => m.role === 'helix')
    const a0 = Math.atan2((helix[0].y ?? 0) - cy, (helix[0].x ?? 0) - cx)
    const a1 = Math.atan2((helix[1].y ?? 0) - cy, (helix[1].x ?? 0) - cx)
    let d = a1 - a0
    while (d > Math.PI) d -= 2 * Math.PI
    while (d < -Math.PI) d += 2 * Math.PI
    return Math.sign(d)
  }

  it('external orbit radius == majorDiameter/2 + toolR - 0.6*pitch (the thread root)', () => {
    const moves = buildThreadMillToolpath(makePayload(makeParams({ threadKind: 'external' })))
    const helix = moves.filter(m => m.role === 'helix')
    expect(helix.length).toBeGreaterThan(0)
    for (const m of helix) {
      const r = Math.hypot((m.x ?? 0) - 0, (m.y ?? 0) - 0)
      expect(Math.abs(r - R_FINAL_EXT)).toBeLessThan(1e-6)
    }
  })

  it('external never emits a cutting move at the boss center; plunge is in air at the orbit start', () => {
    const moves = buildThreadMillToolpath(makePayload(makeParams({ threadKind: 'external' })))
    const plunges = moves.filter(m => m.role === 'plunge')
    expect(plunges.length).toBeGreaterThan(0)
    for (const m of plunges) {
      const atCenter = Math.abs((m.x ?? 0) - 0) < 1e-9 && Math.abs((m.y ?? 0) - 0) < 1e-9
      expect(atCenter).toBe(false)
      // The plunge sits outside the boss (radius >= R_final).
      expect(Math.hypot((m.x ?? 0) - 0, (m.y ?? 0) - 0)).toBeGreaterThan(R_FINAL_EXT - 1e-9)
    }
    // No NON-rapid move anywhere lands on the center at cutting depth.
    for (const m of moves) {
      if (m.type === 'rapid') continue
      const atCenter = Math.abs((m.x ?? 0) - 0) < 1e-9 && Math.abs((m.y ?? 0) - 0) < 1e-9
      expect(atCenter).toBe(false)
    }
  })

  it('external orbit sense follows kind x cut (chip-load model), NOT hand', () => {
    // New model: s = c*e*p. internal and external (e flips) have OPPOSITE orbit
    // sense for the SAME cut; hand does NOT change the orbit sense (it only sets
    // the axial travel direction). Both default to climb here.
    const ext = buildThreadMillToolpath(makePayload(makeParams({ threadKind: 'external' })))
    const intl = buildThreadMillToolpath(makePayload(makeParams({ threadKind: 'internal' })))
    expect(helixSense(ext)).toBe(-helixSense(intl))
    // Hand does not change the orbit sense (same cut, both hands -> same sense).
    const extL = buildThreadMillToolpath(makePayload(makeParams({ threadKind: 'external', handedness: 'left' })))
    expect(helixSense(extL)).toBe(helixSense(ext))
    // Flipping the CUT flips the orbit sense.
    const extConv = buildThreadMillToolpath(makePayload(makeParams({ threadKind: 'external', cutDirection: 'conventional' })))
    expect(helixSense(extConv)).toBe(-helixSense(ext))
  })

  it('external emits NO exit climb above the thread top (helix stays at/below topZ; lead-out never returns to center)', () => {
    // Internal climbs above topZ to feedZ (+1); external must NOT (it is already
    // radially clear of the boss).
    const ext = buildThreadMillToolpath(makePayload(makeParams({ threadKind: 'external' })))
    const helix = ext.filter(m => m.role === 'helix')
    const maxZ = Math.max(...helix.map(m => m.z ?? -Infinity))
    expect(maxZ).toBeLessThanOrEqual(0 + 1e-9)   // topZ = 0, no exit climb to feedZ
    // Lead-out stays outside the boss (away from center).
    const leadOut = ext.filter(m => m.role === 'lead_out')
    expect(leadOut.length).toBeGreaterThan(0)
    for (const m of leadOut) {
      const atCenter = Math.abs((m.x ?? 0) - 0) < 1e-9 && Math.abs((m.y ?? 0) - 0) < 1e-9
      expect(atCenter).toBe(false)
    }
  })

  it('external ARC lead-out is tangent-continuous at the helix top (no cusp), both hands', () => {
    // Direction of travel from the last two points of a same-role segment.
    const dirOf = (a: ToolpathMove, b: ToolpathMove): [number, number] => {
      const dx = (b.x ?? 0) - (a.x ?? 0)
      const dy = (b.y ?? 0) - (a.y ?? 0)
      const n = Math.hypot(dx, dy) || 1
      return [dx / n, dy / n]
    }
    const dot = (u: [number, number], v: [number, number]) => u[0] * v[0] + u[1] * v[1]

    for (const handedness of ['right', 'left'] as const) {
      const moves = buildThreadMillToolpath(
        makePayload(makeParams({ threadKind: 'external', leadInOut: 'arc', handedness })),
      )
      const helix = moves.filter(m => m.role === 'helix')
      const leadOut = moves.filter(m => m.role === 'lead_out')
      const leadIn = moves.filter(m => m.role === 'lead_in')
      expect(helix.length).toBeGreaterThan(2)
      expect(leadOut.length).toBeGreaterThan(1)
      expect(leadIn.length).toBeGreaterThan(1)

      // LEAD-OUT continuity: helix-end direction A vs lead-out-start direction B.
      // Before the fix (double-reversed dir) this dot was ~ -0.92 (a ~169deg cusp);
      // after the fix it must be strongly positive (same general heading).
      const A = dirOf(helix[helix.length - 2], helix[helix.length - 1])
      const B = dirOf(leadOut[0], leadOut[1])
      expect(dot(A, B)).toBeGreaterThan(0.9)

      // LEAD-IN continuity guard (the good arc must not regress): lead-in-end
      // direction vs helix-start direction point the same general way.
      const C = dirOf(leadIn[leadIn.length - 2], leadIn[leadIn.length - 1])
      const D = dirOf(helix[0], helix[1])
      expect(dot(C, D)).toBeGreaterThan(0.9)

      // Lead-out points all stay OUTSIDE the boss (>= majorDiameter/2).
      for (const m of leadOut) {
        const r = Math.hypot((m.x ?? 0) - 0, (m.y ?? 0) - 0)
        expect(r).toBeGreaterThanOrEqual(10 / 2 - 1e-6)
      }
    }
  })

  it('external straight lead (no arc) plunges at the safe crest radius and leads OUTWARD, never to center', () => {
    const moves = buildThreadMillToolpath(
      makePayload(makeParams({ threadKind: 'external', leadInOut: 'none' })),
    )
    const plunges = moves.filter(m => m.role === 'plunge')
    // Plunge at the SAFE crest orbit radius (majorDiameter/2 + toolR = 8.0) on the
    // +x axis -- grazing in air beside the boss, NOT at the deeper root pass radius
    // Q (whose tool body would gouge the solid boss).
    const rSafe = 10 / 2 + 6 / 2  // 8.0 mm (crest)
    expect(plunges.length).toBe(1)
    expect(plunges[0].x).toBeCloseTo(rSafe, 9)
    expect(plunges[0].y).toBeCloseTo(0, 9)
    const leadOut = moves.filter(m => m.role === 'lead_out')
    expect(leadOut.length).toBeGreaterThan(0)
    for (const m of leadOut) {
      // Outward beyond R_final, not at center.
      expect(Math.hypot((m.x ?? 0) - 0, (m.y ?? 0) - 0)).toBeGreaterThan(R_FINAL_EXT - 1e-9)
    }
  })
})

describe('buildThreadMillToolpath — external radial depth + entry safety', () => {
  // A solid boss outer profile for external threading (centroid at origin). The
  // boss OD is irrelevant to external guards (no hole-fit check); only its
  // centroid matters as the orbit center.
  const boss = () => [holeLoop('boss', 10)]

  it('external helix reaches the thread ROOT, not the crest (under-cut regression)', () => {
    // M10x1.5, 6mm tool, arc, climb. The deepest (MIN) helix orbit radius minus
    // toolR is the cut radius; it must land at the root (majorDiameter/2 -
    // 0.6134*pitch ~ 4.08mm), NOT at the crest (majorDiameter/2 = 5.0mm).
    const moves = buildThreadMillToolpath(makePayload(
      makeParams({ threadKind: 'external', leadInOut: 'arc', cutDirection: 'climb' }),
      boss(),
    ))
    const helix = moves.filter(m => m.role === 'helix')
    expect(helix.length).toBeGreaterThan(0)
    const toolR = 6 / 2
    const minOrbitR = Math.min(...helix.map(m => Math.hypot((m.x ?? 0) - 0, (m.y ?? 0) - 0)))
    const cutR = minOrbitR - toolR
    const root = 10 / 2 - 0.6134 * 1.5   // ~4.08 mm
    const crest = 10 / 2                  // 5.0 mm
    expect(Math.abs(cutR - root)).toBeLessThan(0.12)
    expect(Math.abs(cutR - crest)).toBeGreaterThan(0.12)
  })

  it('external plunge: tool inner edge never enters the boss (both lead modes, both cuts)', () => {
    const toolR = 6 / 2
    for (const leadInOut of ['arc', 'none'] as const) {
      for (const cutDirection of ['climb', 'conventional'] as const) {
        const moves = buildThreadMillToolpath(makePayload(
          makeParams({ threadKind: 'external', leadInOut, cutDirection }),
          boss(),
        ))
        const plunges = moves.filter(m => m.role === 'plunge')
        expect(plunges.length).toBeGreaterThan(0)
        for (const m of plunges) {
          // tool inner edge = orbit radius - toolR; must be at/outside the crest
          // (majorDiameter/2), i.e. never plunging into the solid boss.
          const innerEdge = Math.hypot((m.x ?? 0) - 0, (m.y ?? 0) - 0) - toolR
          expect(innerEdge).toBeGreaterThanOrEqual(10 / 2 - 1e-6)
        }
      }
    }
  })

  it('climb/conventional agree with cross(heading, materialNormal) rule (both kinds)', () => {
    // ARCHITECTURE.md universal rule: cross(heading, materialNormal) < 0 = climb.
    // materialNormal is OUTWARD (P0 - center) for internal, INWARD (center - P0)
    // for external. heading = P1 - P0 from the first two helix points.
    const firstCross = (
      kind: ThreadMillParams['threadKind'],
      cut: ThreadMillParams['cutDirection'],
    ): number => {
      const loops = kind === 'internal' ? [holeLoop('h1')] : boss()
      const moves = buildThreadMillToolpath(makePayload(
        makeParams({ threadKind: kind, cutDirection: cut, leadInOut: 'none' }),
        loops,
      ))
      const helix = moves.filter(m => m.role === 'helix')
      expect(helix.length).toBeGreaterThan(1)
      const p0 = helix[0], p1 = helix[1]
      const hx = (p1.x ?? 0) - (p0.x ?? 0)
      const hy = (p1.y ?? 0) - (p0.y ?? 0)
      let mx = (p0.x ?? 0) - 0, my = (p0.y ?? 0) - 0     // outward (internal)
      if (kind === 'external') { mx = -mx; my = -my }     // inward (external)
      const mn = Math.hypot(mx, my) || 1
      mx /= mn; my /= mn
      return hx * my - hy * mx
    }
    for (const kind of ['internal', 'external'] as const) {
      expect(firstCross(kind, 'climb')).toBeLessThan(0)
      expect(firstCross(kind, 'conventional')).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('buildThreadMillToolpath — climb/conventional direction model', () => {
  // Heights: feedZ = +1, topZ = 0, bottomZ = -9, clearanceZ = 10.
  // Right-hand spindle = +1. Sense s = c*e*p; travelUp = (s*h)>0 (right h=+1).
  //   internal + climb        -> s=+1 -> ascend  (today's default)
  //   internal + conventional -> s=-1 -> descend
  //   external + climb        -> s=-1 -> descend
  //   external + conventional -> s=+1 -> ascend  (today's external)

  it('internal + right + climb: ASCENDS (default, byte-identical invariants)', () => {
    const moves = buildThreadMillToolpath(makePayload(makeParams({
      threadKind: 'internal', handedness: 'right', cutDirection: 'climb',
    })))
    const helix = moves.filter(m => m.role === 'helix')
    // Helix Z strictly increasing, first cut at bottomZ.
    expect(helix[0].z).toBe(-9)
    for (let i = 1; i < helix.length; i++) {
      expect(helix[i].z).toBeGreaterThan(helix[i - 1].z)
    }
    // Plunge to bottomZ; lead_out at the feed plane (+1, exit climb out of hole).
    const plunges = moves.filter(m => m.role === 'plunge')
    expect(plunges.length).toBe(1)
    expect(plunges[0].z).toBe(-9)
    const leadOut = moves.filter(m => m.role === 'lead_out')
    for (const m of leadOut) expect(m.z).toBeCloseTo(1, 9)
  })

  it('internal + right + conventional: DESCENDS, enters at top, retracts from bottom', () => {
    const moves = buildThreadMillToolpath(makePayload(makeParams({
      threadKind: 'internal', handedness: 'right', cutDirection: 'conventional',
    })))
    const helix = moves.filter(m => m.role === 'helix')
    // Helix Z strictly decreasing.
    for (let i = 1; i < helix.length; i++) {
      expect(helix[i].z).toBeLessThan(helix[i - 1].z)
    }
    // The MAIN thread reaches the thread top (0) and ends at the bottom (-9).
    expect(helix.some(m => Math.abs(m.z - 0) < 1e-9)).toBe(true)
    expect(helix[helix.length - 1].z).toBeCloseTo(-9, 9)
    // Lead-out at bottomZ; final retract straight up the open hole at center.
    const leadOut = moves.filter(m => m.role === 'lead_out')
    expect(leadOut.length).toBeGreaterThan(0)
    for (const m of leadOut) expect(m.z).toBeCloseTo(-9, 9)
    const last = moves[moves.length - 1]
    expect(last.type).toBe('rapid')
    expect(last.z).toBe(10)
    expect(last.x).toBeCloseTo(0, 9)
    expect(last.y).toBeCloseTo(0, 9)
  })

  it('external + right + climb: DESCENDS, plunge in air to the thread top', () => {
    const moves = buildThreadMillToolpath(makePayload(makeParams({
      threadKind: 'external', handedness: 'right', cutDirection: 'climb',
    })))
    const helix = moves.filter(m => m.role === 'helix')
    for (let i = 1; i < helix.length; i++) {
      expect(helix[i].z).toBeLessThan(helix[i - 1].z)
    }
    expect(helix[helix.length - 1].z).toBeCloseTo(-9, 9)
    // Plunge lands at the thread top (0) in air beside the boss (off-center).
    const plunges = moves.filter(m => m.role === 'plunge')
    expect(plunges.length).toBe(1)
    expect(plunges[0].z).toBeCloseTo(0, 9)
    const atCenter = Math.abs((plunges[0].x ?? 0)) < 1e-9 && Math.abs((plunges[0].y ?? 0)) < 1e-9
    expect(atCenter).toBe(false)
  })

  it('external + right + conventional: ASCENDS (== today external behavior)', () => {
    const moves = buildThreadMillToolpath(makePayload(makeParams({
      threadKind: 'external', handedness: 'right', cutDirection: 'conventional',
    })))
    const helix = moves.filter(m => m.role === 'helix')
    for (let i = 1; i < helix.length; i++) {
      expect(helix[i].z).toBeGreaterThan(helix[i - 1].z)
    }
    // Plunge at the thread bottom (-9), helix ends at the thread top (0).
    const plunges = moves.filter(m => m.role === 'plunge')
    expect(plunges[0].z).toBeCloseTo(-9, 9)
    expect(helix[helix.length - 1].z).toBeCloseTo(0, 9)
  })
})

describe('buildThreadMillToolpath — internal lead-out tangency (no cusp)', () => {
  // The internal arc lead-out must leave the helix end tangentially (smooth),
  // not reverse direction. Regression for the ~172deg cusp (ADR 0031 A7 / round
  // 6): junctionAngle ~0 = tangent, ~180 = reversal cusp.
  function junctionAngleDeg(moves: ToolpathMove[]): number {
    let lastHelix = -1
    for (let i = 0; i < moves.length; i++) if (moves[i].role === 'helix') lastHelix = i
    const firstLeadOut = moves.findIndex((m, i) => i > lastHelix && m.role === 'lead_out')
    const p = (m: ToolpathMove) => ({ x: m.x ?? 0, y: m.y ?? 0, z: m.z ?? 0 })
    const sub = (a: {x:number;y:number;z:number}, b: typeof a) => ({ x: a.x-b.x, y: a.y-b.y, z: a.z-b.z })
    const inV = sub(p(moves[lastHelix]), p(moves[lastHelix - 1]))
    const outV = sub(p(moves[firstLeadOut]), p(moves[lastHelix]))
    const du = Math.hypot(inV.x, inV.y, inV.z), dw = Math.hypot(outV.x, outV.y, outV.z)
    let c = (inV.x*outV.x + inV.y*outV.y + inV.z*outV.z) / (du*dw)
    c = Math.max(-1, Math.min(1, c))
    return Math.acos(c) * 180 / Math.PI
  }

  it('internal climb (ascending) lead-out is tangent, not a reversal cusp', () => {
    const moves = buildThreadMillToolpath(makePayload(makeParams({
      threadKind: 'internal', cutDirection: 'climb', leadInOut: 'arc',
    })))
    expect(junctionAngleDeg(moves)).toBeLessThan(45)  // pre-fix was ~172
  })

  it('internal conventional (descending) lead-out is tangent, not a reversal cusp', () => {
    const moves = buildThreadMillToolpath(makePayload(makeParams({
      threadKind: 'internal', cutDirection: 'conventional', leadInOut: 'arc',
    })))
    expect(junctionAngleDeg(moves)).toBeLessThan(45)  // pre-fix was ~173
  })
})

describe('buildThreadMillToolpath — fail-loud guards', () => {
  it('pitch <= 0 throws (pitch 0, no tpi)', () => {
    expect(() => buildThreadMillToolpath(makePayload(makeParams({ pitch: 0, tpi: undefined })))).toThrow(/pitch/)
  })

  it('topZ <= bottomZ throws (top below bottom)', () => {
    const moves = () => buildThreadMillToolpath(
      makePayload(makeParams(), [holeLoop('h1')], makeHeights(-1, 0)),
    )
    expect(moves).toThrow(/top/)
  })

  it('orphaned loopId throws when loops are non-empty', () => {
    expect(() => buildThreadMillToolpath(
      makePayload(makeParams({ loopIds: ['nope'] }), [holeLoop('h1')]),
    )).toThrow(/no longer exist/)
  })

  it('tool too big (R_final <= 0) throws', () => {
    expect(() => buildThreadMillToolpath(
      makePayload(makeParams(), [holeLoop('h1')], makeHeights(), makeTool(20)),
    )).toThrow(/orbit radius/)
  })

  it('hole >= major diameter throws (no material to thread / wrong hole picked)', () => {
    // A 12mm pre-drilled hole for an M10 (major 10) thread: the hole is already
    // bigger than the thread major diameter, so spanReal = (10 - 12)/2 < 0. With a
    // 6mm tool the hole-fit guard passes (6 < 12), so this distinct span guard must
    // fire. (Tool 6mm also keeps R_final = 10/2 - 3 = 2 > 0, past the radius guard.)
    expect(() => buildThreadMillToolpath(
      makePayload(makeParams(), [holeLoop('h1', 12)]),
    )).toThrow(/at or larger than the thread major diameter/)
  })

  it('tool fits R_final but not the pre-cleared hole throws (distinct guard)', () => {
    // tool 14mm: R_final = 30/2 - 14/2 = 8 > 0 (passes the radius guard), but the
    // selected hole is only 12mm -> the explicit hole-fit guard must fire.
    expect(() => buildThreadMillToolpath(
      makePayload(makeParams({ majorDiameter: 30 }), [holeLoop('h1', 12)], makeHeights(), makeTool(14)),
    )).toThrow(/does not fit the pre-cleared hole/)
  })
})
