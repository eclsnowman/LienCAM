import { describe, it, expect, vi, afterEach } from 'vitest'
import { buildDrillToolpath, resolveHoleBottoms } from '../../lib/cam/drill2d'
import type { DrillParams, DrillWorkerPayload, LoopData } from '../../lib/cam/types'
import type { Tool, HeightParams, PassParams, LinkingParams, ToolpathMove } from '../../types'

// ── Fixtures ──────────────────────────────────────────────────────────────────
// Three holes on the X axis (sortStrategy 'by_x' keeps the order deterministic):
//   h1 @ x=0   blind, bottom -4 (WCS-relative)
//   h2 @ x=20  blind, bottom -7
//   h3 @ x=40  through — op-level bottom plane (-10)
// holeBottoms (per-hole depth, D1) carries WCS-RELATIVE heights keyed by loop
// id, same convention as heights.bottomHeight (absolute = value + wcsOrigin.z).

function makeTool(): Tool {
  return {
    id: 't1', name: 'Ø5 drill', type: 'drill',
    diameter: 5, fluteLength: 30, shankDiameter: 5, overallLength: 60,
    numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
    feedsAndSpeeds: { default: { rpm: 8000, feedRate: 600, plungeRate: 150, depthOfCut: 5, stepover: 2 } },
  } as Tool
}

function makeHeights(bottom = -10): HeightParams {
  return {
    clearanceHeight: 10, clearanceHeightMode: 'absolute',
    retractHeight: 5, feedHeight: 1,
    topHeight: 0, topHeightMode: 'absolute',
    bottomHeight: bottom, bottomHeightMode: 'absolute',
  }
}

const passes: PassParams = {
  stepdown: 5, stepover: 2, stockToLeave: 0, finishPasses: 0, springPasses: 0,
}

const linking: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
}

// Small square loop centred on (cx, cy) — drill works off the loop centroid.
function holeLoop(id: string, cx: number, cy = 0): LoopData {
  const s = 2
  return { id, closed: true, type: 'contour', points: [
    { x: cx - s, y: cy - s }, { x: cx + s, y: cy - s },
    { x: cx + s, y: cy + s }, { x: cx - s, y: cy + s },
  ] }
}

const LOOPS = [holeLoop('h1', 0), holeLoop('h2', 20), holeLoop('h3', 40)]

function makeDrillParams(over: Partial<DrillParams> = {}): DrillParams {
  return {
    geometryId: 'g1', loopIds: [],
    cycleType: 'simple', peckDepth: 3, chipBreakRetract: 1, dwell: 0,
    retractMode: 'clearance', sortStrategy: 'by_x',
    ...over,
  }
}

function makePayload(
  params: DrillParams,
  holeBottoms?: { [loopId: string]: number },
  wcsZ = 0,
): DrillWorkerPayload {
  return {
    opId: 'op', setupId: 'su', params, heights: makeHeights(), passes, linking,
    tool: makeTool(), loops: LOOPS, wcsOrigin: { x: 0, y: 0, z: wcsZ },
    ...(holeBottoms ? { holeBottoms } : {}),
  }
}

// Deepest Z reached at a given hole X (feed moves only — the plunges).
function minZAt(moves: ToolpathMove[], x: number): number {
  const zs = moves.filter(m => m.type === 'feed' && Math.abs(m.x - x) < 1e-9).map(m => m.z)
  expect(zs.length).toBeGreaterThan(0)
  return Math.min(...zs)
}

// Plunge-role feed count at a given hole X. For the peck cycle (G83) the
// re-approach is a RAPID (WO-1886), so exactly one plunge feed per peck.
function plungeCountAt(moves: ToolpathMove[], x: number): number {
  return moves.filter(m => m.role === 'plunge' && Math.abs(m.x - x) < 1e-9).length
}

afterEach(() => {
  vi.restoreAllMocks()
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Drill — per-hole bottom depth (holeBottoms)', () => {
  it('simple cycle: each hole plunges to its own bottom; missing entry falls back to op bottom with a structured warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const moves = buildDrillToolpath(makePayload(makeDrillParams(), { h1: -4, h2: -7 }))

    expect(minZAt(moves, 0)).toBe(-4)    // h1 blind bottom
    expect(minZAt(moves, 20)).toBe(-7)   // h2 blind bottom
    expect(minZAt(moves, 40)).toBe(-10)  // h3 missing from map -> op-level bottom

    // ADR 0003: the fallback is loud and names the loop without an entry.
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('h3')
  })

  it('peck cycle: peck count reflects each hole\'s own depth', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const moves = buildDrillToolpath(
      makePayload(makeDrillParams({ cycleType: 'peck' }), { h1: -4, h2: -7 }),
    )

    // peckDepth 3: depth 4 -> 2 pecks; depth 7 -> 3 pecks; depth 10 -> 4 pecks.
    // One plunge feed each (re-approach is a rapid since WO-1886).
    expect(plungeCountAt(moves, 0)).toBe(2)
    expect(plungeCountAt(moves, 20)).toBe(3)
    expect(plungeCountAt(moves, 40)).toBe(4)

    // And each still reaches its own bottom.
    expect(minZAt(moves, 0)).toBe(-4)
    expect(minZAt(moves, 20)).toBe(-7)
    expect(minZAt(moves, 40)).toBe(-10)
  })

  it('peck cycle reaches FULL depth at a clamp-missing depth (DEF-4)', () => {
    // feed 1, top 0, peckDepth 3, bottom -12. The OLD code descended from feedZ(1)
    // but counted pecks from topZ(0), so it stopped at -11 (one peck short) AND
    // emitted a dangling re-approach. The fix measures pecks from topZ -> reaches
    // -12 exactly with no dangling move. (The -10 fixtures above happen to clamp
    // onto bottom, which is why they masked the bug.)
    const params = makeDrillParams({ cycleType: 'peck' })
    const moves = buildDrillToolpath({ ...makePayload(params), heights: makeHeights(-12) })

    // Reaches the true hole bottom (was -11 before the fix).
    expect(minZAt(moves, 0)).toBe(-12)

    // No dangling re-approach: the LAST plunge-role move at the hole is AT bottom,
    // not a shallower re-approach above it (the old bug left a -7 plunge last).
    const plunges = moves.filter(m => m.role === 'plunge' && Math.abs(m.x - 0) < 1e-9)
    expect(plunges[plunges.length - 1].z).toBe(-12)

    // 4 pecks (ceil(12/3)) -> 4 plunge feeds; the re-approach is a rapid since
    // WO-1886 (the old bug produced 8 plunge-role moves: a re-approach feed after
    // the short final peck too).
    expect(plungeCountAt(moves, 0)).toBe(4)
  })

  it('chip-break cycle reaches full depth (guard: emitChipBreak already correct)', () => {
    const params = makeDrillParams({ cycleType: 'chip_break' })
    const moves = buildDrillToolpath({ ...makePayload(params), heights: makeHeights(-12) })
    expect(minZAt(moves, 0)).toBe(-12)
    expect(minZAt(moves, 20)).toBe(-12)
    expect(minZAt(moves, 40)).toBe(-12)
  })

  it('holeBottoms is WCS-relative: absolute Z = value + wcsOrigin.z (mirrors resolveHeights)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const moves = buildDrillToolpath(makePayload(makeDrillParams(), { h1: -4, h2: -7 }, 2))

    expect(minZAt(moves, 0)).toBe(-2)   // -4 + wcsZ 2
    expect(minZAt(moves, 20)).toBe(-5)  // -7 + wcsZ 2
    expect(minZAt(moves, 40)).toBe(-8)  // op bottom -10 + wcsZ 2
  })

  it('regression — no holeBottoms: every hole drills to the op-level bottom, no warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const moves = buildDrillToolpath(makePayload(makeDrillParams()))

    expect(minZAt(moves, 0)).toBe(-10)
    expect(minZAt(moves, 20)).toBe(-10)
    expect(minZAt(moves, 40)).toBe(-10)
    expect(warn).not.toHaveBeenCalled()
  })
})

// ── resolveHoleBottoms (pure merge helper) ──────────────────────────────────────
// Precedence per hole: override > detected > op-level bottom. The result, when
// defined, is COMPLETE over selectedLoopIds. Returns undefined when there is
// neither a detected map nor any override (today's byte-identical no-holeBottoms
// path). All Zs WCS-relative.

describe('resolveHoleBottoms — per-hole bottom merge', () => {
  const SEL = ['h1', 'h2', 'h3']
  const OP_LEVEL = -10

  it('no detected + no overrides -> undefined (byte-identical path)', () => {
    expect(resolveHoleBottoms(SEL, undefined, undefined, OP_LEVEL)).toBeUndefined()
  })

  it('empty overrides object ({}) behaves like undefined when no detected', () => {
    expect(resolveHoleBottoms(SEL, undefined, {}, OP_LEVEL)).toBeUndefined()
    // empty detected {} likewise yields undefined when no overrides
    expect(resolveHoleBottoms(SEL, {}, undefined, OP_LEVEL)).toBeUndefined()
    expect(resolveHoleBottoms(SEL, {}, {}, OP_LEVEL)).toBeUndefined()
  })

  it('overrides only (DXF case): override id gets its value; others get op-level; map complete', () => {
    const result = resolveHoleBottoms(SEL, undefined, { h2: -6.5 }, OP_LEVEL)
    expect(result).toEqual({ h1: -10, h2: -6.5, h3: -10 })
    // complete over the full selection
    expect(Object.keys(result!).sort()).toEqual(['h1', 'h2', 'h3'])
  })

  it('override WINS over a detected value for the same id', () => {
    const result = resolveHoleBottoms(
      SEL,
      { h1: -4, h2: -7, h3: -10 },
      { h2: -2 },          // override beats detected -7 for h2
      OP_LEVEL,
    )
    expect(result).toEqual({ h1: -4, h2: -2, h3: -10 })
  })

  it('detected only (no overrides): detected ids keep their value; undetected selected ids get op-level; complete', () => {
    const result = resolveHoleBottoms(SEL, { h1: -4, h2: -7 }, undefined, OP_LEVEL)
    // h3 was not detected -> filled with op-level, no missing entry
    expect(result).toEqual({ h1: -4, h2: -7, h3: -10 })
    expect(Object.keys(result!).sort()).toEqual(['h1', 'h2', 'h3'])
  })

  it('does not mutate its inputs', () => {
    const detected = { h1: -4 }
    const overrides = { h2: -2 }
    resolveHoleBottoms(SEL, detected, overrides, OP_LEVEL)
    expect(detected).toEqual({ h1: -4 })
    expect(overrides).toEqual({ h2: -2 })
  })

  // -- per-loop owning-geometry fallback (mixed 3D detected + flat 2D loop) -----
  // A 2D (DXF/sketch) hole with NO detected B-rep bottom must take ITS OWN
  // plane-relative fallback, NOT the op-wide model bottom that the 3D model's
  // detected holes imply. Precedence stays override > detected > fallback >
  // op-level. Mirrors the store: detected={h3d:-10} (cylinder base), op-wide
  // bottom -10 (the MODEL bottom), perLoopFallback={h2d:-5} (the 2D plane).
  it('THE FIX: a non-detected 2D loop takes its per-loop fallback (-5), NOT the op-wide model bottom (-10)', () => {
    const result = resolveHoleBottoms(
      ['h3d', 'h2d'],
      { h3d: -10 },          // 3D B-rep detected hole -> own cylinder bottom
      undefined,
      -10,                   // op-wide bottom = the 3D MODEL bottom (the bug source)
      { h2d: -5 },           // 2D loop's OWN 2D-plane-relative bottom
    )
    expect(result).toEqual({ h3d: -10, h2d: -5 })
    // The 2D hole did NOT inherit the model bottom.
    expect(result!['h2d']).not.toBe(-10)
  })

  it('precedence: override > detected > perLoopFallback > op-level (all four in play)', () => {
    const result = resolveHoleBottoms(
      ['a', 'b', 'c', 'd'],
      { b: -7 },             // detected for b
      { a: -2 },             // override for a (beats everything)
      -10,                   // op-level for d (no detected, no fallback)
      { b: -3, c: -5 },      // fallback for b (LOSES to detected) and c (wins)
    )
    expect(result).toEqual({ a: -2, b: -7, c: -5, d: -10 })
  })

  it('perLoopFallback only (no detected, no overrides) still produces a complete map', () => {
    const result = resolveHoleBottoms(SEL, undefined, undefined, OP_LEVEL, { h2: -5 })
    expect(result).toEqual({ h1: -10, h2: -5, h3: -10 })
  })

  it('empty perLoopFallback ({}) with no detected/overrides -> undefined (byte-identical path)', () => {
    expect(resolveHoleBottoms(SEL, undefined, undefined, OP_LEVEL, {})).toBeUndefined()
  })

  it('omitting perLoopFallback is byte-identical to the legacy 4-arg call', () => {
    const legacy = resolveHoleBottoms(SEL, { h1: -4 }, undefined, OP_LEVEL)
    const withUndef = resolveHoleBottoms(SEL, { h1: -4 }, undefined, OP_LEVEL, undefined)
    expect(withUndef).toEqual(legacy)
    expect(legacy).toEqual({ h1: -4, h2: -10, h3: -10 })
  })
})
