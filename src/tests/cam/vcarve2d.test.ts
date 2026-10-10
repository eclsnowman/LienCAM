// WO-1174: the V-carve toolpath builder, proven on physics the operator can
// check with a ruler: the bit's tip sits (inscribed radius - tip radius) /
// tan(half angle) below the surface at every ridge point, never below the
// flat depth, comes up to the surface exactly at convex corners, and every
// cutting move stays inside the drawn region.

import { describe, it, expect, beforeAll } from 'vitest'
import { buildVCarveToolpath, cutsStayInside, ensureVCarveClipperReady, buildRegions } from '../../lib/cam/vcarve2d'
import { ensureClipperReady } from '../../lib/cam/face2d/clipperOffset'
import type { VCarveParams, VCarveWorkerPayload, LoopData } from '../../lib/cam/types'
import type { Tool, HeightParams, PassParams, LinkingParams, ToolpathMove } from '../../types'
import { outlineTextToContours } from '../../lib/sketch/textOutline'

// ── Fixtures ──────────────────────────────────────────────────────────────────

function vbit(over: Partial<Tool> = {}): Tool {
  return {
    id: 'v90', name: '90 deg V-bit', type: 'v_bit',
    diameter: 12, fluteLength: 10, shankDiameter: 6, overallLength: 50,
    angleFromAxisDeg: 45, tipDiameter: 0,
    numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
    feedsAndSpeeds: { default: { rpm: 18000, feedRate: 1200, plungeRate: 300 } },
    ...over,
  } as unknown as Tool
}

function endMill(diameter: number): Tool {
  return {
    id: `em${diameter}`, name: `${diameter} mm end mill`, type: 'flat_end_mill',
    diameter, fluteLength: 12, shankDiameter: diameter, overallLength: 40,
    numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
    feedsAndSpeeds: { default: { rpm: 18000, feedRate: 1500, plungeRate: 400 } },
  } as unknown as Tool
}

function heights(top = 0, maxDepth = 6): HeightParams {
  return {
    clearanceHeight: 15, clearanceHeightMode: 'absolute',
    retractHeight: 5, feedHeight: 2,
    topHeight: top, topHeightMode: 'absolute',
    bottomHeight: top - maxDepth, bottomHeightMode: 'absolute',
  }
}

const passes = (stepdown = 0): PassParams => ({
  stepdown, stepover: 1, stockToLeave: 0, finishPasses: 0, springPasses: 0,
})

const linking: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
}

function params(over: Partial<VCarveParams> = {}): VCarveParams {
  return {
    geometryId: 'g', loopIds: [], role: 'carve',
    flatDepthMm: undefined, startDepthMm: 0, allowanceMm: 0,
    flatClearing: { mode: 'vbit', stepoverMm: 0.5 },
    tolerance: 0.01,
    ...over,
  }
}

const rectLoop = (id: string, w: number, h: number, x0 = 0, y0 = 0): LoopData => ({
  id, closed: true, type: 'closed',
  points: [{ x: x0, y: y0 }, { x: x0 + w, y: y0 }, { x: x0 + w, y: y0 + h }, { x: x0, y: y0 + h }],
})

function payload(over: Partial<VCarveWorkerPayload> = {}): VCarveWorkerPayload {
  return {
    opId: 'op', setupId: 'setup',
    params: params(), heights: heights(), passes: passes(), linking,
    tool: vbit(), loops: [rectLoop('r', 40, 10)], wcsOrigin: { x: 0, y: 0, z: 0 },
    ...over,
  }
}

const cuts = (moves: ToolpathMove[]) => moves.filter(m => m.type === 'feed' && m.role === 'cut')
const minZ = (moves: ToolpathMove[]) => Math.min(...moves.filter(m => m.type === 'feed').map(m => m.z))

/** Segments cut at exactly depth z: consecutive feed moves both at that z. */
function floorSegments(moves: ToolpathMove[], z: number): Array<[ToolpathMove, ToolpathMove]> {
  const segs: Array<[ToolpathMove, ToolpathMove]> = []
  for (let i = 1; i < moves.length; i++) {
    const a = moves[i - 1], b = moves[i]
    if (a.type !== 'feed' || b.type !== 'feed' || b.role !== 'cut') continue
    if (Math.abs(a.z - z) > 1e-9 || Math.abs(b.z - z) > 1e-9) continue
    segs.push([a, b])
  }
  return segs
}
const segLength = (segs: Array<[ToolpathMove, ToolpathMove]>) =>
  segs.reduce((s, [a, b]) => s + Math.hypot(b.x - a.x, b.y - a.y), 0)
function distToSegments(x: number, y: number, segs: Array<[ToolpathMove, ToolpathMove]>): number {
  let best = Infinity
  for (const [a, b] of segs) {
    const dx = b.x - a.x, dy = b.y - a.y
    const l2 = dx * dx + dy * dy
    let t = l2 > 0 ? ((x - a.x) * dx + (y - a.y) * dy) / l2 : 0
    t = t < 0 ? 0 : t > 1 ? 1 : t
    best = Math.min(best, Math.hypot(a.x + t * dx - x, a.y + t * dy - y))
  }
  return best
}

function distToRectBoundary(x: number, y: number, w: number, h: number): number {
  return Math.min(x, w - x, y, h - y)
}

beforeAll(async () => {
  await ensureVCarveClipperReady()
  await ensureClipperReady()
})

// ── Depth physics ─────────────────────────────────────────────────────────────

describe('V-carve ridge depth', () => {
  it('tip depth equals distance to the boundary / tan(half angle) at every ridge point (90 deg bit)', () => {
    const moves = buildVCarveToolpath(payload())
    const ridge = cuts(moves)
    expect(ridge.length).toBeGreaterThan(20)
    for (const m of ridge) {
      const r = distToRectBoundary(m.x, m.y, 40, 10)
      expect(Math.abs(-m.z - r)).toBeLessThan(0.03)
    }
    expect(minZ(moves)).toBeCloseTo(-5, 1)
  })

  it('a 60 deg bit (30 deg per side) cuts deeper for the same width', () => {
    const moves = buildVCarveToolpath(payload({ tool: vbit({ angleFromAxisDeg: 30, fluteLength: 20 }), heights: heights(0, 12) }))
    const tan = Math.tan(Math.PI / 6)
    for (const m of cuts(moves)) {
      const r = distToRectBoundary(m.x, m.y, 40, 10)
      expect(Math.abs(-m.z - r / tan)).toBeLessThan(0.05)
    }
    expect(minZ(moves)).toBeCloseTo(-5 / tan, 1)
  })

  it('a flat tip shifts the formula: depth = (r - tipRadius) / tan', () => {
    const moves = buildVCarveToolpath(payload({ tool: vbit({ tipDiameter: 1 }) }))
    for (const m of cuts(moves)) {
      const r = distToRectBoundary(m.x, m.y, 40, 10)
      const expected = Math.max(0, r - 0.5)
      expect(Math.abs(-m.z - expected)).toBeLessThan(0.03)
    }
    expect(minZ(moves)).toBeCloseTo(-4.5, 1)
  })

  it('comes up to the surface exactly at every convex corner', () => {
    const moves = buildVCarveToolpath(payload())
    const corners = [[0, 0], [40, 0], [40, 10], [0, 10]]
    for (const [cx, cy] of corners) {
      const hit = moves.find(m => m.type === 'feed' && Math.abs(m.x - cx) < 1e-6 && Math.abs(m.y - cy) < 1e-6)
      expect(hit, `corner ${cx},${cy}`).toBeDefined()
      expect(hit!.z).toBeCloseTo(0, 6)
    }
  })

  it('every cutting move stays inside the drawn region', () => {
    const moves = buildVCarveToolpath(payload())
    const regions = buildRegions([rectLoop('r', 40, 10).points])
    expect(cutsStayInside(moves, regions, 1e-6)).toBe(true)
  })

  it('Material Start below the surface shifts every Z (start depth)', () => {
    const moves = buildVCarveToolpath(payload({ heights: heights(-1.5, 6) }))
    for (const m of moves.filter(m => m.type === 'feed')) expect(m.z).toBeLessThanOrEqual(-1.5 + 1e-9)
    const corner = moves.find(m => m.type === 'feed' && Math.abs(m.x) < 1e-6 && Math.abs(m.y) < 1e-6)!
    expect(corner.z).toBeCloseTo(-1.5, 6)
  })
})

// ── Flat depth ────────────────────────────────────────────────────────────────

describe('V-carve flat depth', () => {
  it('never cuts below the flat depth and runs a wall pass along the inset outline', () => {
    const moves = buildVCarveToolpath(payload({ params: params({ flatDepthMm: 2 }), heights: heights(0, 2) }))
    expect(minZ(moves)).toBeCloseTo(-2, 6)
    // The wall pass: cut moves at exactly -2 along the rectangle inset by 2.
    const wall = cuts(moves).filter(m => Math.abs(m.z + 2) < 1e-9 && Math.abs(distToRectBoundary(m.x, m.y, 40, 10) - 2) < 1e-3)
    expect(wall.length).toBeGreaterThanOrEqual(4)
    for (const [cx, cy] of [[2, 2], [38, 2], [38, 8], [2, 8]]) {
      expect(wall.some(m => Math.abs(m.x - cx) < 1e-3 && Math.abs(m.y - cy) < 1e-3), `inset corner ${cx},${cy}`).toBe(true)
    }
  })

  it('clears the floor with rings when the bit does the clearing', () => {
    const vb = buildVCarveToolpath(payload({ params: params({ flatDepthMm: 2, flatClearing: { mode: 'vbit', stepoverMm: 0.5 } }), heights: heights(0, 2) }))
    const none = buildVCarveToolpath(payload({ params: params({ flatDepthMm: 2, flatClearing: { mode: 'none', stepoverMm: 0.5 } }), heights: heights(0, 2) }))
    const floorVb = floorSegments(vb, -2)
    const floorNone = floorSegments(none, -2)
    // Without clearing only the wall pass runs at the floor depth: one 36 x 6 loop.
    expect(segLength(floorNone)).toBeCloseTo(2 * (36 + 6), 3)
    expect(segLength(floorVb)).toBeGreaterThan(segLength(floorNone) * 3)
    // Rings cover the floor: every floor sample is within half a stepover of a ring.
    for (let x = 2.5; x <= 37.5; x += 0.5) for (let y = 2.5; y <= 7.5; y += 0.5) {
      expect(distToSegments(x, y, floorVb), `floor point ${x},${y} uncleared`).toBeLessThanOrEqual(0.25 + 1e-9)
    }
  })

  it('with a separate clearing tool the bit only cleans what that tool cannot reach', () => {
    const full = buildVCarveToolpath(payload({ params: params({ flatDepthMm: 2, flatClearing: { mode: 'vbit', stepoverMm: 0.5 } }), heights: heights(0, 2) }))
    const rest = buildVCarveToolpath(payload({ params: params({ flatDepthMm: 2, flatClearing: { mode: 'tool', clearingToolDiameter: 4, stepoverMm: 0.5 } }), heights: heights(0, 2) }))
    const floorFull = floorSegments(full, -2)
    const floorRest = floorSegments(rest, -2)
    expect(segLength(floorRest)).toBeLessThan(segLength(floorFull) / 2)
    // The rest is the four corners of the flat floor; nothing rings the middle
    // (the wall pass along the inset outline is the only floor-depth cut there).
    const middle = floorRest.filter(([a, b]) =>
      Math.min(a.x, b.x) > 8 && Math.max(a.x, b.x) < 32 &&
      (Math.abs(distToRectBoundary(a.x, a.y, 40, 10) - 2) > 1e-3 || Math.abs(distToRectBoundary(b.x, b.y, 40, 10) - 2) > 1e-3))
    expect(middle.length).toBe(0)
  })

  it('the flat-clearing role pockets the flat floor with the end mill, inside the inset outline', () => {
    const moves = buildVCarveToolpath(payload({
      tool: endMill(4),
      params: params({ role: 'flat_clearing', vbit: { angleFromAxisDeg: 45, tipDiameter: 0 } }),
      heights: heights(0, 2),
    }))
    const floor = cuts(moves)
    expect(floor.length).toBeGreaterThan(10)
    for (const m of floor) {
      expect(m.z).toBeGreaterThanOrEqual(-2 - 1e-9)
      // Cutter centre stays a tool radius inside the 36 x 6 flat floor.
      expect(m.x).toBeGreaterThanOrEqual(2 + 2 - 1e-3)
      expect(m.x).toBeLessThanOrEqual(38 - 2 + 1e-3)
      expect(m.y).toBeGreaterThanOrEqual(2 + 2 - 1e-3)
      expect(m.y).toBeLessThanOrEqual(8 - 2 + 1e-3)
    }
  })

  it('without a flat depth the bit stops at its own physical limit', () => {
    // 8 mm 90 deg bit: full diameter at 4 mm; the 40 x 10 rectangle wants 5.
    const moves = buildVCarveToolpath(payload({ tool: vbit({ diameter: 8 }), heights: heights(0, 4) }))
    expect(minZ(moves)).toBeCloseTo(-4, 6)
  })
})

// ── Multi-depth ───────────────────────────────────────────────────────────────

describe('V-carve stepdown', () => {
  it('with a flat depth, no plunge goes more than one stepdown below what has been cut (audit finding 2)', () => {
    const moves = buildVCarveToolpath(payload({
      params: params({ flatDepthMm: 4, flatClearing: { mode: 'vbit', stepoverMm: 0.5 } }),
      passes: passes(1), heights: heights(0, 4),
    }))
    let deepestSoFar = 0
    for (const m of moves) {
      if (m.type !== 'feed') continue
      if (m.role === 'plunge') expect(m.z, `plunge to ${m.z} after deepest ${deepestSoFar}`).toBeGreaterThanOrEqual(deepestSoFar - 1 - 1e-9)
      deepestSoFar = Math.min(deepestSoFar, m.z)
    }
    // The floor and the wall are still finished at the flat depth.
    expect(segLength(floorSegments(moves, -4))).toBeGreaterThan(2 * (32 + 2))
    expect(minZ(moves)).toBeCloseTo(-4, 6)
  })

  it('refuses a stepdown that would make hundreds of passes', () => {
    expect(() => buildVCarveToolpath(payload({ passes: passes(0.001) }))).toThrow(/stepdown .* passes/)
  })

  it('splits a deep carve into passes clamped at each stepdown, ending at full depth', () => {
    const moves = buildVCarveToolpath(payload({ passes: passes(2) }))
    const zs = cuts(moves).map(m => m.z)
    const plateau = (z: number) => zs.filter(v => Math.abs(v - z) < 1e-9).length
    expect(plateau(-2)).toBeGreaterThan(5)
    expect(plateau(-4)).toBeGreaterThan(5)
    expect(Math.min(...zs)).toBeCloseTo(-5, 1)
    // The last pass reaches the true depth at the centre line.
    expect(zs.some(z => Math.abs(z + 5) < 0.05)).toBe(true)
  })
})

// ── Real letters ──────────────────────────────────────────────────────────────

describe('V-carve on font outlines', () => {
  const asLoops = (text: string, height: number): LoopData[] =>
    outlineTextToContours(text, height).map((c, i) => ({ id: `t${i}`, closed: true, type: 'closed', points: c.points }))

  it('carves the word LienCAM: every cut inside its letter, nothing below the bit limit', () => {
    const loops = asLoops('LienCAM', 25)
    const moves = buildVCarveToolpath(payload({ loops, heights: heights(0, 6) }))
    expect(cuts(moves).length).toBeGreaterThan(200)
    const regions = buildRegions(loops.map(l => l.points))
    expect(cutsStayInside(moves, regions, 0.02)).toBe(true)
    expect(minZ(moves)).toBeGreaterThanOrEqual(-6 - 1e-9)
  })

  it('an O is carved as one continuous ring without retracts in the middle', () => {
    const loops = asLoops('O', 20)
    const moves = buildVCarveToolpath(payload({ loops, heights: heights(0, 6) }))
    const plunges = moves.filter(m => m.role === 'plunge')
    expect(plunges.length).toBe(1)
  })
})

// ── Refusals ──────────────────────────────────────────────────────────────────

describe('V-carve refusals name their cause', () => {
  it('no closed outline', () => {
    const open: LoopData = { id: 'o', closed: false, type: 'open', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] }
    expect(() => buildVCarveToolpath(payload({ loops: [open] }))).toThrow(/no closed outline/)
  })

  it('a tool without a tip angle', () => {
    expect(() => buildVCarveToolpath(payload({ tool: endMill(6) }))).toThrow(/no usable tip angle/)
  })

  it('a flat depth deeper than the bit can cut', () => {
    expect(() => buildVCarveToolpath(payload({ params: params({ flatDepthMm: 9 }), heights: heights(0, 9) })))
      .toThrow(/deeper than tool .* can cut/)
  })

  it('a drawing narrower than the tip flat everywhere', () => {
    expect(() => buildVCarveToolpath(payload({ tool: vbit({ tipDiameter: 1 }), loops: [rectLoop('thin', 40, 0.4)] })))
      .toThrow(/cannot enter/)
  })
})
