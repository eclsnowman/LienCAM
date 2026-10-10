import { describe, it, expect } from 'vitest'
import { buildPocketToolpath } from '../../lib/cam/pocket2d'
import { ensureClipperReady, offsetLoop } from '../../lib/cam/face2d/clipperOffset'
import { ensureCCW, pointInPolygon } from '../../lib/cam/geometry'
import type { PocketParams, PocketWorkerPayload, LoopData } from '../../lib/cam/types'
import type { Tool, HeightParams, PassParams, LinkingParams } from '../../types'

await ensureClipperReady()

// ── Fixtures ───────────────────────────────────────────────────────────────────
// Annular pocket mirroring test_fixtures/brep/fix_block_pocket.step: outer rect
// 50x30 (x10..60, y10..40) with an island hole 12x8 (x34..46, y23..31). Tool Ø6
// (R3), so the island keep-out for the tool centre is the island offset by 3 mm.
// The pre-fix defect: inside-out entry centroid landed ON the island and the
// helix (or its silent plunge downgrade) gouged it (~810 helix points at
// distance 0 from the island).

type Pt2 = { x: number; y: number }

const TOOL_R = 3

function makeTool(): Tool {
  return {
    id: 't1', name: 'O6 flat', type: 'flat_end_mill',
    diameter: TOOL_R * 2, fluteLength: 20, shankDiameter: 6, overallLength: 60,
    numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
    feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, depthOfCut: 2, stepover: 1.5 } },
  } as Tool
}

function makeHeights(bottom = -2): HeightParams {
  return {
    clearanceHeight: 10, clearanceHeightMode: 'absolute',
    retractHeight: 5, feedHeight: 1,
    topHeight: 0, topHeightMode: 'absolute',
    bottomHeight: bottom, bottomHeightMode: 'absolute',
  }
}

const passes: PassParams = {
  stepdown: 5, stepover: 1.5, stockToLeave: 0.5, finishPasses: 0, springPasses: 0,
}

const linking: LinkingParams = {
  entryType: 'ramp_helical', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
}

function makePocketParams(over: Partial<PocketParams> = {}): PocketParams {
  return {
    geometryId: 'g', loopIds: [],
    direction: 'climb', orderStrategy: 'by_depth', fillStrategy: 'inside_out',
    floorStockToLeave: 0, finishContour: false,
    helixDiameter: 90, overlapMm: 0, stepoverLeadIn: 'none',
    stayDown: false, stayDownLift: 1.0,
    ...over,
  }
}

function rectLoop(id: string, type: string, x0: number, y0: number, x1: number, y1: number): LoopData {
  return { id, closed: true, type,
    points: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }] }
}

const OUTER  = rectLoop('outer',  'contour', 10, 10, 60, 40)
const ISLAND = rectLoop('island', 'hole',    34, 23, 46, 31)

// Alias retained for the parameterized outside-in cases.
const ISLAND_LOW = ISLAND

function makePayload(params: PocketParams, loops: LoopData[]): PocketWorkerPayload {
  return {
    opId: 'op', setupId: 'su', params, heights: makeHeights(), passes, linking,
    tool: makeTool(), loops, wcsOrigin: { x: 0, y: 0, z: 0 },
  }
}

// Keep-out for the tool centre: island grown by the tool radius plus the wall
// stock-to-leave in effect, built with the same robust round offset primitive.
// Shrunk by 0.01 mm because legitimate island-bridge moves ride exactly on the offset
// boundary — pointInPolygon on exact boundary points is a numeric coin-flip,
// while the defects under test sit well inside.
function islandKeepOut(island: LoopData = ISLAND, wallStock = 0): Pt2[] {
  const loops = offsetLoop(ensureCCW(island.points as Pt2[]) as Pt2[], TOOL_R + wallStock - 0.01, 0)
  if (loops.length === 0 || loops[0].length < 3) throw new Error('test setup: keep-out offset failed')
  return loops[0] as Pt2[]
}

// Every point the tool centre visits while it could be engaged: all feed moves
// (cut/helix/ramp/plunge/stepover — the helix starts above stock top but its XY
// circle is identical at depth), plus any rapid at or below stock top.
function engagedPoints(moves: ReturnType<typeof buildPocketToolpath>): Pt2[] {
  return moves
    .filter(m => m.type === 'feed' || m.z < 1e-9)
    .map(m => ({ x: m.x, y: m.y }))
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('Pocket 2D — inside-out entry on an annular pocket (island keep-out)', () => {
  const moves   = buildPocketToolpath(makePayload(makePocketParams(), [OUTER, ISLAND]))
  // passes.stockToLeave is 0.5 — the keep-out must include the island wall stock.
  const keepOut = islandKeepOut(ISLAND, passes.stockToLeave ?? 0)

  it('produces a toolpath', () => {
    expect(moves.length).toBeGreaterThan(0)
  })

  it('emits a helical entry without a silent plunge downgrade', () => {
    expect(moves.some(m => m.role === 'helix')).toBe(true)
  })

  it('no engaged point — including every helix/entry point — enters the island keep-out', () => {
    const bad = engagedPoints(moves).filter(p => pointInPolygon(p, keepOut))
    expect(bad.length).toBe(0)
  })

  it('helix points specifically stay clear of the island keep-out at any Z', () => {
    const helixPts = moves.filter(m => m.role === 'helix' || m.role === 'plunge')
    expect(helixPts.length).toBeGreaterThan(0)
    for (const m of helixPts) expect(pointInPolygon({ x: m.x, y: m.y }, keepOut)).toBe(false)
  })
})

// ── Outside-in half ────────────────────────────────────────────────────────────
// Mirrors the live gate run (_stage4_check_moves.py outside-in case): ramp_linear
// entry along the outermost ring, overlap past the ring seam, and the arc
// (quintic Bezier) stepover lead-in — the three emitters that produced the six
// outside-in keep-out endpoints pre-fix (stepToRing plunge targets, overlap tail
// interpolation, Bezier samples). Run at wallStock = 0 (live-gate parity) and
// wallStock > 0 (covers the stock-aware island expansion).

function makeOutsideInPayload(wallStock: number, island: LoopData): PocketWorkerPayload {
  return {
    opId: 'op', setupId: 'su',
    params: makePocketParams({ fillStrategy: 'outside_in', overlapMm: 2, stepoverLeadIn: 'arc' }),
    heights: makeHeights(),
    passes: { ...passes, stockToLeave: wallStock },
    linking: { ...linking, entryType: 'ramp_linear' },
    tool: makeTool(), loops: [OUTER, island], wcsOrigin: { x: 0, y: 0, z: 0 },
  }
}

describe.each([
  { label: 'wallStock = 0',   wallStock: 0,   island: ISLAND },
  { label: 'wallStock = 0.5', wallStock: 0.5, island: ISLAND_LOW },
])('Pocket 2D — outside-in on an annular pocket, $label (island keep-out)', ({ wallStock, island }) => {
  const moves   = buildPocketToolpath(makeOutsideInPayload(wallStock, island))
  const keepOut = islandKeepOut(island, wallStock)

  it('produces a toolpath with cut moves', () => {
    expect(moves.length).toBeGreaterThan(0)
    expect(moves.some(m => m.role === 'cut')).toBe(true)
  })

  it('no engaged point — every feed endpoint incl. plunge, stepover and overlap — enters the keep-out', () => {
    const bad = engagedPoints(moves).filter(p => pointInPolygon(p, keepOut))
    expect(bad.length).toBe(0)
  })

  it('plunge and stepover targets specifically are island-clear', () => {
    const targets = moves.filter(m => m.role === 'plunge' || m.role === 'stepover')
    expect(targets.length).toBeGreaterThan(0)
    for (const m of targets) expect(pointInPolygon({ x: m.x, y: m.y }, keepOut)).toBe(false)
  })
})

// ── Outside-in helical entry (C3b) ─────────────────────────────────────────────
// The outside-in ramp_helical entry centre — centroid of the OUTER boundary —
// lands inside the island keep-out on the annular fixture, exactly the defect
// class the inside-out fix closed. Pre-fix the helix circled (35, 25) on top of
// the island (or silently downgraded to a plunge into it).

function makeOutsideInHelicalPayload(wallStock: number, loops: LoopData[]): PocketWorkerPayload {
  return {
    opId: 'op', setupId: 'su',
    params: makePocketParams({ fillStrategy: 'outside_in' }),
    heights: makeHeights(),
    passes: { ...passes, stockToLeave: wallStock },
    linking,   // entryType: 'ramp_helical'
    tool: makeTool(), loops, wcsOrigin: { x: 0, y: 0, z: 0 },
  }
}

describe.each([
  { label: 'wallStock = 0',   wallStock: 0,   island: ISLAND },
  { label: 'wallStock = 0.5', wallStock: 0.5, island: ISLAND_LOW },
])('Pocket 2D — outside-in helical entry on an annular pocket, $label (island keep-out)', ({ wallStock, island }) => {
  const build = () => buildPocketToolpath(makeOutsideInHelicalPayload(wallStock, [OUTER, island]))

  it('rejects the incompatible entry instead of silently downgrading it', () => {
    expect(build).toThrowError(/entry type.*ramp_helical.*not compatible.*outside_in/i)
  })

  it('reports the two compatible outside-in alternatives', () => {
    expect(build).toThrowError(/Choose Profile Ramp or Plunge/i)
  })

  it('fails at the worker boundary for every wall-stock setting', () => {
    expect(build).toThrowError(/Pocket 2D/i)
  })
})

// ── boundarySource is store-resolved, worker is source-agnostic ─────────────────
// The new PocketParams.boundarySource ('geometry' | 'stock') selects WHICH loops
// the store resolves into the payload (geometry loops vs the stock footprint);
// the worker itself never branches on it. These guards prove the additive field
// is behavior-neutral at the worker boundary: an absent boundarySource (older
// projects) and an explicit 'geometry' produce byte-identical toolpaths, and
// 'stock' is likewise ignored by the algorithm (the store, not the worker, swaps
// the loops). This is the "default 'geometry' === zero behavior change" contract.
describe('Pocket 2D — boundarySource is store-resolved (worker source-agnostic)', () => {
  const base   = buildPocketToolpath(makePayload(makePocketParams(), [OUTER, ISLAND]))
  const asGeo  = buildPocketToolpath(makePayload(makePocketParams({ boundarySource: 'geometry' }), [OUTER, ISLAND]))
  const asStk  = buildPocketToolpath(makePayload(makePocketParams({ boundarySource: 'stock' }), [OUTER, ISLAND]))

  it('absent boundarySource is byte-identical to explicit geometry', () => {
    expect(asGeo).toEqual(base)
  })

  it('worker ignores boundarySource (stock given the SAME loops matches geometry)', () => {
    // With identical input loops the worker output must not change — proving the
    // source decision lives in the store, never here.
    expect(asStk).toEqual(base)
  })
})

describe('Pocket 2D — outside-in Helix compatibility rejection (no island)', () => {
  const build = () => buildPocketToolpath(makeOutsideInHelicalPayload(0, [OUTER]))

  it('rejects outside-in Helix even without an island', () => {
    expect(build).toThrowError(/entry type.*ramp_helical.*not compatible.*outside_in/i)
  })

  it('reports the compatible alternatives', () => {
    // Centroid of the plain 50x30 rect outer boundary is (35, 25).
    expect(build).toThrowError(/Choose Profile Ramp or Plunge/i)
  })
})

describe('Pocket 2D — inside-out control (no island): behaviour unchanged', () => {
  const moves = buildPocketToolpath(makePayload(makePocketParams(), [OUTER]))

  it('emits an entry and a toolpath without failure', () => {
    expect(moves.length).toBeGreaterThan(0)
    expect(moves.some(m => m.role === 'helix')).toBe(true)
  })

  it('helix is centred at the pocket centre (legacy centroid entry)', () => {
    // Innermost-ring centroid of the plain 50x30 rect is the pocket centre (35, 25).
    // WO-1972: every helix point is equidistant from the centre. (Averaging the
    // points only found the centre while the helix ran whole turns from retract;
    // a helix that starts at the material ends part-way round.)
    const helix = moves.filter(m => m.role === 'helix')
    const radii = helix.map(m => Math.hypot(m.x - 35, m.y - 25))
    expect(Math.min(...radii)).toBeGreaterThan(0.1)
    expect(Math.max(...radii) - Math.min(...radii)).toBeLessThan(1e-6)
  })
})
