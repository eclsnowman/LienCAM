import { beforeAll, describe, expect, it } from 'vitest'
import {
  ensureEngineClipperReady,
  type Loop,
  type Loops,
  type Pt,
} from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import {
  getB8GateStats,
  processFeature,
  type AdaptivePass,
  type FeatureResult,
  type ProcessParams,
} from '../../../lib/cam/adaptiveClearing2d/engine/processFeature'
import { emitFeature, type EmitContext } from '../../../lib/cam/adaptiveClearing2d/engine/emit'
import { getEngagePoint } from '../../../lib/cam/adaptiveClearing2d/engine/engagePoint'
import { createToolGeometry } from '../../../lib/cam/adaptiveClearing2d/engine/toolGeometry'
import {
  encodeAdaptiveMillingDirection,
  resolveAdaptiveMillingDirection,
  type AdaptiveMillingDirection,
} from '../../../lib/cam/types'

const square: Loop = [
  { x: 0, y: 0 },
  { x: 60, y: 0 },
  { x: 60, y: 60 },
  { x: 0, y: 60 },
]

function circle(cx: number, cy: number, r: number, n = 80): Loop {
  return Array.from({ length: n }, (_, i) => {
    const a = 2 * Math.PI * i / n
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }
  })
}

const baseParams: ProcessParams = {
  toolRadius: 2,
  stepOver: 0.25,
  tolerance: 0.1,
  helixDiameter: 3,
  stockToLeave: 0.5,
}

function signedPathArea(points: Pt[]): number {
  let twiceArea = 0
  for (let i = 1; i < points.length; i++) {
    twiceArea += points[i - 1].x * points[i].y - points[i].x * points[i - 1].y
  }
  return twiceArea / 2
}

function endpoint(pass: AdaptivePass, end: 'first' | 'last'): Pt | null {
  if (pass.type === 'entry') return null
  const points = pass.points
  return points[end === 'first' ? 0 : points.length - 1] ?? null
}

function expectSamePoint(a: Pt, b: Pt): void {
  expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(1e-8)
}

function emitContext(millingDirection?: AdaptiveMillingDirection): EmitContext {
  return {
    heights: { clearanceZ: 10, retractZ: 3, feedZ: 1, topZ: 0, bottomZ: -2 },
    feeds: {
      feedRate: 1000,
      plungeRate: 300,
      rampRate: 450,
      leadInRate: 500,
      leadOutRate: 500,
      fastTraverseRate: 5000,
      finishRate: 800,
    },
    stepdown: 2,
    helixAngleDeg: 3,
    millingDirection,
  }
}

function result(passes: AdaptivePass[]): FeatureResult {
  return {
    startPoint: { x: 0, y: 0 },
    entries: [],
    passes,
    cleared: [],
    cutRegion: [],
    residual: [],
    stats: {
      passes: 0,
      points: 0,
      cacheHits: 0,
      cacheMisses: 0,
      residualArea: 0,
      residualMaxInscribedR: 0,
    },
  }
}

function pointInRing(p: Pt, ring: Pt[]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j]
    if ((a.y > p.y) !== (b.y > p.y)
      && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside
    }
  }
  return inside
}

function expectTravelMaterialSide(
  travel: Pt[],
  boundary: Pt[],
  clearedRegion: 'inside' | 'outside',
  materialSide: 'left' | 'right',
  context = 'travel',
): void {
  let segment: [Pt, Pt] | null = null
  for (let i = 1; i < travel.length; i++) {
    const a = travel[i - 1], b = travel[i]
    if (Math.hypot(b.x - a.x, b.y - a.y) > 1e-6) {
      segment = [a, b]
      break
    }
  }
  expect(segment).not.toBeNull()
  const [a, b] = segment!
  const dx = b.x - a.x, dy = b.y - a.y
  const length = Math.hypot(dx, dy)
  const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  const leftProbe = {
    x: midpoint.x - 1e-3 * dy / length,
    y: midpoint.y + 1e-3 * dx / length,
  }
  const leftInside = pointInRing(leftProbe, boundary)
  const leftIsCleared = clearedRegion === 'inside' ? leftInside : !leftInside
  expect(
    leftIsCleared,
    `${context}: expected material ${materialSide}, cleared region ${clearedRegion}`,
  ).toBe(materialSide === 'right')
}

function expectMaterialSide(
  points: Pt[],
  clearedRegion: 'inside' | 'outside',
  materialSide: 'left' | 'right',
): void {
  const ring = points.length > 1
    && points[0].x === points[points.length - 1].x
    && points[0].y === points[points.length - 1].y
    ? points.slice(0, -1)
    : points
  expectTravelMaterialSide(points, ring, clearedRegion, materialSide)
}

function signedRingArea(points: Pt[]): number {
  let twiceArea = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length]
    twiceArea += a.x * b.y - b.x * a.y
  }
  return twiceArea / 2
}

/**
 * WO-1061: material side of a CLOSED wall-cut lap, taken from its WINDING.
 *
 * The 1e-3 side probe in expectTravelMaterialSide measures the emitted travel against a
 * SEPARATE reference ring, so it only reports the truth while both polylines are sampled
 * alike. On the island lap they are not: since WO-453 (8bf8b358) the emitted wall cut is
 * chord-fitted to 82 points where cutRegion keeps 160, and the pass chord's sagitta is
 * 0.0082mm -- eight times the probe's 1e-3 step, and far inside the 0.1mm tolerance the
 * fit is entitled to. The outward probe therefore never escapes the reference ring and the
 * check reported "material left" for a lap that is demonstrably CW, i.e. correct
 * conventional travel. (Measured: src/tests/evidence/WO-1061/_probe-conv2.test.ts --
 * ring r 10.548438..10.548603, pass r identical, pass signed area -349.21 = CW.)
 *
 * For a closed lap the side needs no probe at all: it is the winding. Cleared INSIDE the
 * lap + CCW travel puts the standing material on the right; cleared OUTSIDE the lap (an
 * island wrap) + CW travel does the same. This is exact at any sampling density.
 *
 * The winding only means that ABOUT THE REAL MATERIAL BOUNDARY once the lap is known to be
 * the boundary's lap, so every caller must first pass the lap through expectLapIsRegionLap.
 */
function expectRingMaterialSide(
  points: Pt[],
  clearedRegion: 'inside' | 'outside',
  materialSide: 'left' | 'right',
  context: string,
): void {
  const closed = points.length > 2
    && Math.hypot(points[0].x - points[points.length - 1].x, points[0].y - points[points.length - 1].y) < 1e-6
  expect(closed, `${context}: wall cut is not a closed lap`).toBe(true)
  const ring = points.slice(0, -1)
  const area = signedRingArea(ring)
  expect(Math.abs(area), `${context}: degenerate wall cut lap`).toBeGreaterThan(1e-6)
  const materialIsRight = clearedRegion === 'inside' ? area > 0 : area < 0
  expect(
    materialIsRight,
    `${context}: expected material ${materialSide}, cleared region ${clearedRegion}, `
    + `lap signed area ${area.toFixed(3)} (${area > 0 ? 'CCW' : 'CW'})`,
  ).toBe(materialSide === 'right')
}

function distanceToLoop(pt: Pt, loop: Pt[]): number {
  let best = Infinity
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length]
    const dx = b.x - a.x, dy = b.y - a.y
    const lengthSq = dx * dx + dy * dy
    const t = lengthSq > 1e-12
      ? Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / lengthSq))
      : 0
    best = Math.min(best, Math.hypot(pt.x - (a.x + t * dx), pt.y - (a.y + t * dy)))
  }
  return best
}

function closestLoop(pt: Pt, loops: Loops): Loop {
  return [...loops].sort((a, b) => distanceToLoop(pt, a) - distanceToLoop(pt, b))[0]
}

/** Two-sided (symmetric) Hausdorff distance between two closed rings, in mm. */
function ringHausdorff(a: Pt[], b: Pt[]): number {
  let worst = 0
  for (const pt of a) worst = Math.max(worst, distanceToLoop(pt, b))
  for (const pt of b) worst = Math.max(worst, distanceToLoop(pt, a))
  return worst
}

/**
 * WO-1061 FIX ROUND: the emitted lap must BE this region's lap, proved geometrically.
 *
 * Winding only establishes the material side relative to the ACTUAL material boundary, so
 * the winding check below is worthless unless the lap is first tied to the region it claims
 * to walk. Equal enclosed area is not that tie -- a translated lap, a same-area sibling
 * region or any other same-area loop all pass an area comparison.
 *
 * The tie asserted here is a two-sided Hausdorff distance: every emitted lap vertex lies on
 * the region ring and every region vertex lies on the emitted lap, both within the fit's own
 * entitlement (params.tolerance, 0.1mm). That tolerates chord fitting -- the island lap is
 * chord-fitted to 81 points where cutRegion keeps 160 -- while ruling out substitution.
 *
 * Measured (src/tests/evidence/WO-1061/_probe-correspondence.test.ts, both directions):
 *   region 0 (outer, 4 pts):   hausdorff(lap, own) 0.000000mm   vs region 1: 28.272038mm
 *   region 1 (island, 160 pts): hausdorff(lap, own) 0.006014mm  vs region 0: 28.272217mm
 *   the same lap translated 0.5mm in x scores 0.500000 / 0.505757mm against its own region
 * So the 0.1mm bar passes with 16x margin on the real pairing and fails every substitution
 * by two to three orders of magnitude.
 */
function expectLapIsRegionLap(lapPoints: Pt[], region: Pt[], context: string): Pt[] {
  const closed = lapPoints.length > 2
    && Math.hypot(
      lapPoints[0].x - lapPoints[lapPoints.length - 1].x,
      lapPoints[0].y - lapPoints[lapPoints.length - 1].y,
    ) < 1e-6
  expect(closed, `${context}: wall cut is not a closed lap`).toBe(true)
  const lap = lapPoints.slice(0, -1)

  const drift = ringHausdorff(lap, region)
  expect(
    drift,
    `${context}: emitted lap is not the lap of its cut region `
    + `(two-sided Hausdorff ${drift.toFixed(6)}mm > the ${baseParams.tolerance}mm fit tolerance)`,
  ).toBeLessThanOrEqual(baseParams.tolerance)

  const lapArea = signedRingArea(lap)
  const regionArea = signedRingArea(region)
  expect(
    Math.abs(Math.abs(lapArea) - Math.abs(regionArea)) / Math.abs(regionArea),
    `${context}: lap encloses ${Math.abs(lapArea).toFixed(3)}mm2 against region `
    + `${Math.abs(regionArea).toFixed(3)}mm2`,
  ).toBeLessThan(0.01)

  return lap
}

function expectRadialMaterialSide(
  travel: Pt[],
  center: Pt,
  materialSide: 'left' | 'right',
): void {
  for (let i = 1; i < travel.length; i++) {
    const a = travel[i - 1], b = travel[i]
    const dx = b.x - a.x, dy = b.y - a.y
    if (Math.hypot(dx, dy) <= 1e-6) continue
    const radial = {
      x: (a.x + b.x) / 2 - center.x,
      y: (a.y + b.y) / 2 - center.y,
    }
    const cross = dx * radial.y - dy * radial.x
    expect(Math.sign(cross)).toBe(materialSide === 'left' ? 1 : -1)
    return
  }
  throw new Error('helix travel has no non-zero XY segment')
}

// WO-1896: this file used to pin the reversed belief that climb keeps the material on the
// cutter's LEFT. For a clockwise (M3) spindle climb keeps it on the RIGHT: the tooth enters
// the wall at full chip thickness (G41 with M3 = climb). Every material-side expectation
// below is re-pinned to that rule (src/lib/cam/millingDirection.ts). The engine's historical
// canonical-forward stream (material right) is therefore CLIMB, and a missing direction now
// resolves to climb so that stream stays byte-stable.
describe('Adaptive Clearing physical milling direction', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })

  it('translates the legacy stored bit; an omitted direction is the historical climb stream', () => {
    expect(resolveAdaptiveMillingDirection(undefined)).toBe('conventional')
    expect(resolveAdaptiveMillingDirection(true)).toBe('conventional')
    expect(resolveAdaptiveMillingDirection(false)).toBe('climb')
    expect(encodeAdaptiveMillingDirection('conventional')).toBe(true)
    expect(encodeAdaptiveMillingDirection('climb')).toBe(false)

    const omitted = processFeature({ boundary: square }, baseParams)
    const explicit = processFeature(
      { boundary: square },
      { ...baseParams, millingDirection: 'climb' },
    )
    expect(JSON.stringify(omitted)).toBe(JSON.stringify(explicit))
  }, 60_000)

  it('keeps material right for climb and material left for conventional (WO-1896)', () => {
    const conventional = processFeature(
      { boundary: square },
      { ...baseParams, millingDirection: 'conventional', wallFinish: true },
    )
    const climb = processFeature(
      { boundary: square },
      { ...baseParams, millingDirection: 'climb', wallFinish: true },
    )

    expect(conventional.cutRegion).toEqual(climb.cutRegion)
    expect(conventional.stats.aborted).toBe(climb.stats.aborted)
    expect(conventional.stats.residualMaxInscribedR).toBe(climb.stats.residualMaxInscribedR)
    expect(conventional.residual).toHaveLength(climb.residual.length)
    expect(Math.abs(conventional.stats.residualArea - climb.stats.residualArea)).toBeLessThan(0.01)

    const climbCuts = climb.passes.filter(
      (p): p is Extract<AdaptivePass, { type: 'cut' }> => p.type === 'cut',
    )
    const conventionalCuts = conventional.passes.filter(
      (p): p is Extract<AdaptivePass, { type: 'cut' }> => p.type === 'cut',
    )
    const climbCut = climbCuts[climbCuts.length - 1]
    const conventionalCut = conventionalCuts[conventionalCuts.length - 1]
    expect(signedPathArea(climbCut.points)).toBeGreaterThan(0)
    expect(signedPathArea(conventionalCut.points)).toBeLessThan(0)
    expectMaterialSide(climbCut.points, 'inside', 'right')
    expectMaterialSide(conventionalCut.points, 'inside', 'left')

    const climbFinish = climb.passes.find(
      (p): p is Extract<AdaptivePass, { type: 'finish' }> => p.type === 'finish',
    )!
    const conventionalFinish = conventional.passes.find(
      (p): p is Extract<AdaptivePass, { type: 'finish' }> => p.type === 'finish',
    )!
    expect(conventional.finishClearedRegions).toEqual(climb.finishClearedRegions)
    expect(signedPathArea(climbFinish.points))
      .toBeCloseTo(-signedPathArea(conventionalFinish.points), 9)
    expectMaterialSide(climbFinish.points, 'inside', 'right')
    expectMaterialSide(conventionalFinish.points, 'inside', 'left')
  }, 60_000)

  it('orients outer and island wall cuts from the physical material side', () => {
    const island = circle(30, 30, 8)
    for (const millingDirection of ['conventional', 'climb'] as const) {
      const run = processFeature(
        { boundary: square, holes: [island] },
        { ...baseParams, millingDirection, wallFinish: true },
      )
      const materialSide = millingDirection === 'climb' ? 'right' : 'left'
      const cuts = run.passes.filter(
        (p): p is Extract<AdaptivePass, { type: 'cut' }> => p.type === 'cut',
      )
      const boundaryCuts = cuts.slice(-run.cutRegion.length)
      expect(boundaryCuts).toHaveLength(run.cutRegion.length)
      for (let i = 0; i < run.cutRegion.length; i++) {
        const regionArea = signedRingArea(run.cutRegion[i])
        const clearedRegion = regionArea > 0 ? 'inside' : 'outside'
        // The lap has to BE the region's lap before its winding can say anything about the
        // material side: vertex-for-vertex correspondence with cutRegion[i], to within the
        // chord fit's own 0.1mm entitlement. See expectLapIsRegionLap.
        expectLapIsRegionLap(
          boundaryCuts[i].points,
          run.cutRegion[i],
          `${millingDirection} wall cut ${i} / cutRegion[${i}]`,
        )
        // ...and it must not be some OTHER region's lap that happens to land near this one:
        // the pairing is unique at this bar (nearest sibling measured 28.27mm away).
        for (let j = 0; j < run.cutRegion.length; j++) {
          if (j === i) continue
          const cross = ringHausdorff(boundaryCuts[i].points.slice(0, -1), run.cutRegion[j])
          expect(
            cross,
            `${millingDirection} wall cut ${i} is ambiguous: it matches cutRegion[${j}] `
            + `to ${cross.toFixed(6)}mm as well`,
          ).toBeGreaterThan(baseParams.tolerance)
        }
        expectRingMaterialSide(
          boundaryCuts[i].points,
          clearedRegion,
          materialSide,
          `${millingDirection} wall cut ${i}`,
        )
      }

      const finishes = run.passes.filter(
        (p): p is Extract<AdaptivePass, { type: 'finish' }> => p.type === 'finish',
      )
      expect(finishes).toHaveLength(run.finishClearedRegions?.length ?? 0)
      for (let i = 0; i < finishes.length; i++) {
        expectMaterialSide(
          finishes[i].points,
          run.finishClearedRegions![i],
          materialSide,
        )
      }
    }
  }, 60_000)

  it('selects side-entry tangents from the requested material side', () => {
    const clearedSeed: Loops = [[
      { x: -20, y: -20 }, { x: 80, y: -20 },
      { x: 80, y: 15 }, { x: -20, y: 15 },
    ]]
    const tool = createToolGeometry(2, 0.25, 0.025)

    for (const millingDirection of ['climb', 'conventional'] as const) {
      const engage = getEngagePoint(
        clearedSeed,
        tool,
        2,
        tool.optimalCutAreaPerDist,
        0.1,
        0.25,
        [square],
        0.025,
        millingDirection,
      )
      expect(engage).not.toBeNull()
      const { pt, dir } = engage!
      const cut = tool.cutArea(pt, { x: pt.x + .1 * dir.x, y: pt.y + .1 * dir.y }, clearedSeed)
      // WO-2752: the footprint is a machining limit, not the fresh stock frontier.
      // Measure the actual cut against the known cleared half-plane (y <= 15).
      expect(cut.area).toBeGreaterThan(0)
      expect(Math.sign(cut.sideBalance)).toBe(millingDirection === 'climb' ? -1 : 1)
    }
  })

  it('uses CCW climb and CW conventional helices while preserving their final XY', () => {
    const passes: AdaptivePass[] = [
      { type: 'entry', point: { x: 0, y: 0 }, radius: 2, mode: 'helix' },
      { type: 'cut', points: [{ x: 0, y: -2 }, { x: 2, y: 0 }] },
      {
        type: 'link',
        points: [{ x: 2, y: 0 }, { x: 12, y: 10 }],
        jumpType: 2,
        helixDescent: { center: { x: 10, y: 10 }, radius: 2 },
      },
      { type: 'cut', points: [{ x: 12, y: 10 }, { x: 14, y: 10 }] },
    ]
    const helixGroups = (millingDirection: AdaptiveMillingDirection) => {
      const groups: ReturnType<typeof emitFeature>[] = []
      let current: ReturnType<typeof emitFeature> | null = null
      for (const move of emitFeature(result(passes), emitContext(millingDirection))) {
        if (move.role !== 'helix') {
          current = null
          continue
        }
        if (!current) {
          current = []
          groups.push(current)
        }
        current.push(move)
      }
      return groups
    }
    const conventional = helixGroups('conventional')
    const climb = helixGroups('climb')

    const turnSign = (moves: typeof climb[number]): number => {
      let sum = 0
      for (let i = 1; i + 1 < moves.length; i++) {
        const ax = moves[i].x - moves[i - 1].x
        const ay = moves[i].y - moves[i - 1].y
        const bx = moves[i + 1].x - moves[i].x
        const by = moves[i + 1].y - moves[i].y
        sum += ax * by - ay * bx
      }
      return Math.sign(sum)
    }
    expect(climb).toHaveLength(2)
    expect(conventional).toHaveLength(2)
    const centers = [{ x: 0, y: 0 }, { x: 10, y: 10 }]
    for (let i = 0; i < climb.length; i++) {
      expect(turnSign(climb[i])).toBe(1)
      expect(turnSign(conventional[i])).toBe(-1)
      expectRadialMaterialSide(climb[i], centers[i], 'right')
      expectRadialMaterialSide(conventional[i], centers[i], 'left')
      expectSamePoint(
        climb[i][climb[i].length - 1],
        conventional[i][conventional[i].length - 1],
      )
    }
  })

  it('keeps cleanup wall-follows connected, B8-gated, and on the requested material side', () => {
    const island = circle(30, 30, 8)
    for (const millingDirection of ['conventional', 'climb'] as const) {
      const run = processFeature(
        { boundary: square, holes: [island] },
        {
          ...baseParams,
          millingDirection,
          integralWallFollow: true,
          wallCleanupAsWeGo: true,
        },
      )
      expect(run.stats.aborted).toBeUndefined()
      expect(run.passes.some(p => p.type === 'wallfollow')).toBe(true)
      expect(run.passes.some(p => p.type === 'loopback')).toBe(true)

      let prior: Pt | null = null
      for (let passIndex = 0; passIndex < run.passes.length; passIndex++) {
        const pass = run.passes[passIndex]
        const first = endpoint(pass, 'first')
        const last = endpoint(pass, 'last')
        if (first && prior) expectSamePoint(prior, first)
        if (last) prior = last
        if (pass.type === 'entry') prior = null
        if (pass.type === 'wallfollow') {
          const boundary = closestLoop(pass.points[0], run.cutRegion)
          const clearedRegion = signedRingArea(boundary) > 0 ? 'inside' : 'outside'
          expectTravelMaterialSide(
            pass.points,
            boundary,
            clearedRegion,
            millingDirection === 'climb' ? 'right' : 'left',
            `${millingDirection} wallfollow pass ${passIndex} `
              + `(${run.passes[passIndex - 1]?.type ?? 'start'} -> `
              + `${run.passes[passIndex + 1]?.type ?? 'end'})`,
          )
        }
      }

      const b8 = getB8GateStats()
      const b8Events = b8.rejections + b8.routedAround + b8.routedAroundChord
      if (b8Events === 0) {
        // A direction-correct wall route can avoid the overload substitution
        // gate entirely. In that case the emitted wall/loopback checks above
        // are the controlling proof; no wrong-way shortcut was considered.
        expect(run.passes.some(p => p.type === 'wallfollow')).toBe(true)
      }

      // WO-1896: this probe check was written for the reversed (material-left) stream,
      // which the rule now names conventional. It keeps checking that same stream. The
      // climb stream's island lap is chord-fitted, where the 1e-3 probe cannot read the
      // side (WO-1061, expectRingMaterialSide above); its wall laps are proved by winding
      // in 'orients outer and island wall cuts from the physical material side'.
      if (millingDirection === 'conventional') {
        const cuts = run.passes.filter(
          (p): p is Extract<AdaptivePass, { type: 'cut' }> => p.type === 'cut',
        )
        const finalCleanup = cuts.slice(-run.cutRegion.length)
        expect(finalCleanup).toHaveLength(run.cutRegion.length)
        for (let i = 0; i < finalCleanup.length; i++) {
          const clearedRegion = signedRingArea(run.cutRegion[i]) > 0 ? 'inside' : 'outside'
          expectTravelMaterialSide(
            finalCleanup[i].points,
            run.cutRegion[i],
            clearedRegion,
            'left',
            `conventional final cleanup loop ${i}`,
          )
        }
      }
    }
  }, 60_000)

  it('keeps finish leads tangent, cleared-side safe, and material-side correct', () => {
    // Climb inside a cleared pocket keeps the wall material right: CCW (WO-1896).
    const climbOuter: Pt[] = [
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 },
      { x: 0, y: 10 }, { x: 0, y: 0 },
    ]
    const climbIsland: Pt[] = [...climbOuter].reverse()

    for (const [climbPoints, clearedRegion] of [
      [climbOuter, 'inside'],
      [climbIsland, 'outside'],
    ] as const) {
      for (const millingDirection of ['climb', 'conventional'] as const) {
        const points = millingDirection === 'climb'
          ? [...climbPoints]
          : [...climbPoints].reverse()
        const finishResult = result([{ type: 'finish', points }])
        finishResult.finishClearedRegions = [clearedRegion]
        const moves = emitFeature(finishResult, {
          ...emitContext(millingDirection),
          finishLeadInRadius: 2,
          finishLeadOutRadius: 2,
        })
        // The lead arcs in from the cleared side, which is left of climb travel.
        const arcType = millingDirection === 'climb' ? 'arc_ccw' : 'arc_cw'
        const leadStart = moves.find(m => m.role === 'lead_in' && m.type === 'feed')!
        const leadArc = moves.find(m => m.role === 'lead_in' && m.type === arcType)!
        const firstFinish = moves.find(m => m.role === 'finish')!
        expect(leadArc).toBeDefined()
        expect(pointInRing(leadStart, points)).toBe(clearedRegion === 'inside')
        expectMaterialSide(
          points,
          clearedRegion,
          millingDirection === 'climb' ? 'right' : 'left',
        )

        const radius = { x: leadArc.x - leadArc.cx!, y: leadArc.y - leadArc.cy! }
        const tangent = { x: firstFinish.x - leadArc.x, y: firstFinish.y - leadArc.y }
        expect(Math.abs(radius.x * tangent.x + radius.y * tangent.y)).toBeLessThan(1e-8)
      }
    }
  })
})
