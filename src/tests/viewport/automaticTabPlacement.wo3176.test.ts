import { describe, expect, it } from 'vitest'
import { closestArcPosition, isTabFractionFree, pointAtFraction, polylineCumulative, suggestTabFractions,
  type Pt2, type TabSuggestionInput, type TabSuggestions } from '../../lib/viewport/tabPlacement'
import { planTabs } from '../../kernel/workholding/tabs'

const rectangle = (x: number, y: number, w: number, h: number): Pt2[] => [
  { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
]
const circle = (r: number, n: number, x = 0, y = 0) => Array.from({ length: n }, (_, i) => ({
  x: x + r * Math.cos(2 * Math.PI * i / n), y: y + r * Math.sin(2 * Math.PI * i / n),
}))
const input = (path = rectangle(0, 0, 100, 20), overrides: Partial<TabSuggestionInput> = {}): TabSuggestionInput => ({
  path, loopId: 'outline', count: 6, width: 8, cutterRadius: 3,
  sourceRings: [{ loopId: 'outline', kind: 'boundary', path }],
  fixtures: { obstacles: [], omissions: [] }, cuttingBand: { bottomZ: -2, topZ: 10, allowanceMm: 0 },
  ...overrides,
})
const selected = (r: TabSuggestions) => r.candidates.filter(c => c.selected)
const circular = (a: number, b: number, l: number) => Math.min(Math.abs(a - b), l - Math.abs(a - b))
const world = (r: TabSuggestions) => selected(r).map(c => c.point).sort((a, b) => a.x - b.x || a.y - b.y)

// These are pure geometry controls. Application preview/emission integration is
// WO-3220, and these tests do not claim to measure an application's drawn tabs.
describe('WO-3219 automatic tab geometry', () => {
  it('places six centers on a 100 x 20 rectangle at least 7.25 mm from hard corners', () => {
    const request = input(), before = structuredClone(request)
    const r = suggestTabFractions(request)
    expect(r.found).toBe(6)
    expect(r.message).toBe('found 6 of 6 suggestions')
    for (const c of selected(r)) {
      expect(c.cornerClearance).toBeGreaterThanOrEqual(7.25 - 1e-8)
      expect(c.reasons).toEqual([])
      expect(c.tangentTurn).toBe(0)
      for (const other of selected(r).filter(o => o !== c)) expect(circular(c.distance, other.distance, 240)).toBeGreaterThanOrEqual(8 - 1e-8)
    }
    expect(request).toEqual(before)
  })

  it('excludes a sharp-bounded 10 mm span and confines 20 mm centers to [7.25,12.75]', () => {
    for (const height of [10, 20]) {
      const r = suggestTabFractions(input(rectangle(0, 0, 100, height)))
      const shortSide = r.candidates.filter(c => c.point.x === 100 && c.point.y > 0 && c.point.y < height)
      expect(shortSide.length).toBeGreaterThan(0)
      const feasible = shortSide.filter(c => !c.reasons.includes('sharp-corner-or-short-span'))
      if (height === 10) expect(feasible).toHaveLength(0)
      else {
        expect(feasible.length).toBeGreaterThan(0)
        feasible.forEach(c => {
          expect(c.point.y).toBeGreaterThanOrEqual(7.25 - 1e-8)
          expect(c.point.y).toBeLessThanOrEqual(12.75 + 1e-8)
        })
      }
    }
  })

  it('integrates smooth curvature as W/r without adding exclusions on refinement', () => {
    for (const radius of [20, 100]) for (const n of [64, 128]) {
      const r = suggestTabFractions(input(circle(radius, n), { count: 2 }))
      expect(r.found).toBe(2)
      expect(r.candidates.every(c => !c.reasons.includes('sharp-corner-or-short-span'))).toBe(true)
      selected(r).forEach(c => expect(c.tangentTurn).toBeCloseTo(8 / radius, 2))
    }
  })

  it('ranks flatter smooth spans first', () => {
    // Convex stadium: radius-20 ends joined by long zero-curvature straights.
    const path = [...Array.from({ length: 33 }, (_, i) => ({ x: 100 + 20 * Math.cos(-Math.PI / 2 + i * Math.PI / 32), y: 20 * Math.sin(-Math.PI / 2 + i * Math.PI / 32) })),
      ...Array.from({ length: 33 }, (_, i) => ({ x: 20 * Math.cos(Math.PI / 2 + i * Math.PI / 32), y: 20 * Math.sin(Math.PI / 2 + i * Math.PI / 32) }))]
    const r = suggestTabFractions(input(path, { count: 2 }))
    expect(r.found).toBe(2)
    selected(r).forEach(c => expect(c.tangentTurn).toBeLessThan(0.01))
    expect(Math.max(...r.candidates.map(c => c.tangentTurn))).toBeGreaterThan(0.39)
  })

  it('tests the whole corridor against a small hole between clear center/endpoints', () => {
    const request = input(rectangle(0, 0, 100, 30), { cutterRadius: 1, width: 16 })
    // On y=0 the interval centered at x=50 is [42,58]. Center and
    // endpoints clear this radius-0.4 hole by >1.25, but its interior does not.
    request.sourceRings.push({ loopId: 'hole', kind: 'hole', path: circle(0.4, 32, 54, 1) })
    const r = suggestTabFractions(request)
    const c = r.candidates.find(c => Math.abs(c.point.x - 50) < 1e-8 && c.point.y === 0)!
    expect(c).toBeDefined()
    for (const x of [42, 50, 58]) expect(Math.hypot(x - 54, 1) - 0.4).toBeGreaterThan(1.25)
    expect(c.reasons).toContain('source-ring:hole')
    expect(c.selected).toBe(false)
    // Analytic circle distance from y=0 is 1-0.4, inside the 1.25 corridor.
    expect(c.clearance).toBeLessThan(0.25)
  })

  it('rejects nonadjacent walls of a concave notch along the interior of a span', () => {
    const path = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 30 }, { x: 54.5, y: 30 },
      { x: 54.5, y: 1 }, { x: 53.5, y: 1 }, { x: 53.5, y: 30 }, { x: 0, y: 30 }]
    const r = suggestTabFractions(input(path, { width: 16, cutterRadius: 1 }))
    const c = r.candidates.find(c => Math.abs(c.point.x - 50) < 1e-8 && c.point.y === 0)!
    expect(c.reasons).toContain('opposite-wall')
    expect(c.selected).toBe(false)
    for (const x of [42, 50, 58]) expect(Math.hypot(Math.max(53.5 - x, 0, x - 54.5), 1)).toBeGreaterThan(1.25)
  })

  it('checks nested islands and requires enclosing material evidence for inner contours', () => {
    const hole = rectangle(0, 0, 100, 30)
    const request = input(hole, { sourceRings: [{ loopId: 'outline', path: hole, kind: 'hole' }] })
    expect(suggestTabFractions(request).found).toBe(0)
    request.sourceRings.push({ loopId: 'stock', path: rectangle(-20, -20, 140, 70), kind: 'stock' })
    expect(suggestTabFractions(request).found).toBe(6)
    request.sourceRings.push({ loopId: 'island', path: rectangle(45, 0.5, 10, 10), kind: 'hole' })
    const r = suggestTabFractions(request)
    expect(r.candidates.some(c => c.reasons.includes('source-ring:island'))).toBe(true)
    selected(r).forEach(c => expect(c.reasons).toEqual([]))
  })

  it('includes only fixture Z bands meeting cutter/holder reach and records unknown evidence', () => {
    const fixture = { id: 'clamp', name: 'clamp', kind: 'clamp' as const,
      footprint: { minX: 45, maxX: 55, minY: -1, maxY: 1 }, bottomZ: 0, topZ: 5 }
    const request = input(undefined, { fixtures: { obstacles: [fixture], omissions: [{ id: 'unknown', reason: 'no-mesh', line: 'omitted' }] } })
    const r = suggestTabFractions(request)
    const c = r.candidates.find(c => c.point.x === 50 && c.point.y === 0)!
    expect(c.reasons).toContain('fixture:clamp')
    expect(r.omissions).toContain('unknown: no-mesh')
    expect(r.omissions).toContain('holder: geometry absent')
    fixture.bottomZ = 11; fixture.topZ = 12
    expect(suggestTabFractions(request).candidates.some(c => c.reasons.includes('fixture:clamp'))).toBe(false)
    request.holder = { radius: 6, band: { bottomZ: 10, topZ: 20, allowanceMm: 0 } }
    expect(suggestTabFractions(request).candidates.some(c => c.reasons.includes('fixture:clamp'))).toBe(true)
    request.fixtures = undefined
    expect(suggestTabFractions(request).omissions).toContain('fixtures: evidence absent')
    request.fixtures = { obstacles: [], omissions: [] }; request.cuttingBand = undefined
    expect(suggestTabFractions(request).omissions).toContain('fixture cutting/reach band: absent')
  })

  it('preserves world suggestions under seam rotation, reversal, duplicates and collinear refinement', () => {
    const path = rectangle(0, 0, 100, 20), baseline = world(suggestTabFractions(input(path)))
    for (const variant of [[...path.slice(2), ...path.slice(0, 2)], [...path].reverse(),
      [{ x: 30, y: 0 }, path[1], path[1], path[2], path[3], path[0], { x: 30, y: 0 }]]) {
      const r = suggestTabFractions(input(variant))
      const points = world(r)
      expect(points).toHaveLength(baseline.length)
      points.forEach((p, i) => expect(Math.hypot(p.x - baseline[i].x, p.y - baseline[i].y)).toBeLessThan(0.25))
      selected(r).forEach(c => expect(Math.hypot(pointAtFraction(variant, c.fraction).x - c.point.x,
        pointAtFraction(variant, c.fraction).y - c.point.y)).toBeLessThan(1e-8))
    }
  })

  it('splits [197,205] at L=200 and round-trips seam centers through authoritative reseaming', () => {
    // Seam lies inside the bottom straight; canonical integer grid includes s=1.
    const path = [{ x: 39, y: 0 }, { x: 80, y: 0 }, { x: 80, y: 20 }, { x: 0, y: 20 }, { x: 0, y: 0 }]
    const r = suggestTabFractions(input(path))
    expect(polylineCumulative(path).perimeter).toBe(200)
    const seam = r.candidates.find(c => Math.abs(c.distance - 1) < 1e-8)!
    expect(seam.intervals).toEqual([{ start: 197, end: 200 }, { start: 0, end: 5 }])
    expect(isTabFractionFree([1 / 200], null, 198 / 200, 8 / 200)).toBe(false)
    const fractions = [1 / 200, ...r.fractions.filter(f => isTabFractionFree([1 / 200], null, f, 8 / 200))]
    const plan = planTabs(path, { width: 8, count: fractions.length, shape: 'box', tabTopZ: 1, stockBottomZ: 0 }, fractions)
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    const centers = plan.value.intervals.map(i => pointAtFraction(plan.value.path, (i.start + i.end) / 2 / plan.value.perimeter))
    fractions.forEach(f => expect(centers.some(p => Math.hypot(p.x - pointAtFraction(path, f).x, p.y - pointAtFraction(path, f).y) < 1e-8)).toBe(true))
    expect(closestArcPosition(path, seam.point)!.fraction).toBeCloseTo(1 / 200, 10)
  })

  it('reserves directed entry/exit spans across the seam and after reversal', () => {
    const path = rectangle(0, 0, 100, 20)
    for (const variant of [path, [...path].reverse()]) {
      const r = suggestTabFractions(input(variant, { exclusions: [{ start: 20, end: 70 }, { start: 235, end: 245 }] }))
      selected(r).forEach(c => c.intervals.forEach(i => {
        expect(i.end <= 20 || i.start >= 70).toBe(true)
        expect(i.end <= 235 && i.start >= 5).toBe(true)
      }))
      expect(r.candidates.some(c => c.reasons.includes('entry-exit'))).toBe(true)
    }
  })

  it.each(['forward', 'reverse'] as const)('anchors fixed exclusions to a removed interior-edge seam: %s', direction => {
    // Audit counterexample: cleanup removes (39,0), but directed distances
    // still start there, as they do in buildContourTabPlan / planTabs.
    const path = [{ x: 39, y: 0 }, { x: 80, y: 0 }, { x: 80, y: 20 }, { x: 0, y: 20 }, { x: 0, y: 0 }]
    const directed = direction === 'forward' ? path : [path[0], ...path.slice(1).reverse()]
    const cases = [
      { exclusion: { start: 0, end: 20 }, reserved: [{ start: 0, end: 20 }] },
      { exclusion: { start: 180, end: 200 }, reserved: [{ start: 180, end: 200 }] },
      { exclusion: { start: 195, end: 205 }, reserved: [{ start: 195, end: 200 }, { start: 0, end: 5 }] },
    ]
    for (const variant of [directed, [directed[0], ...directed, directed[0]]]) {
      for (const { exclusion, reserved } of cases) {
        const r = suggestTabFractions(input(variant, { exclusions: [exclusion] }))
        const overlaps = (c: TabSuggestions['candidates'][number]) => c.intervals.some(i =>
          reserved.some(e => Math.min(i.end, e.end) - Math.max(i.start, e.start) > 1e-8))
        expect(r.found).toBe(6)
        const blocked = r.candidates.filter(overlaps)
        expect(blocked.length).toBeGreaterThan(0)
        blocked.forEach(c => expect(c.reasons).toContain('entry-exit'))
        expect(selected(r).filter(overlaps)).toEqual([])
        // Reject exactly the reserved production interval, not an interval
        // accidentally shifted to the first retained corner.
        r.candidates.filter(c => !overlaps(c)).forEach(c => expect(c.reasons).not.toContain('entry-exit'))
        selected(r).forEach(c => {
          const mapped = closestArcPosition(variant, c.point)!
          expect(c.distance).toBeCloseTo(mapped.distance, 8)
          expect(c.fraction).toBeCloseTo(mapped.fraction, 8)
          expect(c.intervals.reduce((sum, i) => sum + i.end - i.start, 0)).toBeCloseTo(8, 8)
        })
      }
    }
  })

  it('reports partial/zero plans and physical limitations without widening W', () => {
    const r = suggestTabFractions(input(undefined, { count: 100 }))
    expect(r.found).toBeGreaterThan(0)
    expect(r.found).toBeLessThan(100)
    expect(r.message).toBe(`found ${r.found} of 100 suggestions`)
    expect(r.diagnostics).toContain('partial-greedy-packing: not proof that no other packing exists')
    const limited = suggestTabFractions(input(undefined, { cutterRadius: 5 }))
    expect(limited.centralWeb).toBe(0)
    expect(limited.diagnostics.some(d => d.startsWith('zero-central-web'))).toBe(true)
    selected(limited).forEach(c => expect(c.intervals.reduce((n, i) => n + i.end - i.start, 0)).toBeCloseTo(8, 8))
    const zero = suggestTabFractions(input(rectangle(0, 0, 10, 10)))
    expect(zero.found).toBe(0)
    expect(zero.candidates.every(c => c.reasons.length > 0)).toBe(true)
  })

  it('accepts real cutter-offset source geometry and rejects mismatched identity geometry', () => {
    const path = rectangle(-3, -3, 106, 26)
    const request = input(path, { sourceRings: [{ loopId: 'outline', path: rectangle(0, 0, 100, 20), kind: 'boundary' }] })
    expect(suggestTabFractions(request).found).toBe(6)
    request.sourceRings[0].path = rectangle(1000, 1000, 100, 20)
    const mismatch = suggestTabFractions(request)
    expect(mismatch.found).toBe(0)
    expect(mismatch.candidates.every(c => c.reasons.includes('source-path-mismatch'))).toBe(true)
  })

  it('records invalid fixture geometry as omitted and never silently widens an impractical grid', () => {
    const request = input(undefined, { fixtures: { omissions: [], obstacles: [{ id: 'flat', name: 'flat', kind: 'clamp',
      bottomZ: 0, topZ: 2, footprint: { minX: 5, maxX: 5, minY: 0, maxY: 10 } }] } })
    const r = suggestTabFractions(request)
    expect(r.omissions).toContain('flat: unreadable footprint/band')
    expect(r.candidates.some(c => c.reasons.includes('fixture:flat'))).toBe(false)
    const dense = suggestTabFractions(input(undefined, { width: 0.0001 }))
    expect(dense.found).toBe(0)
    expect(dense.diagnostics).toContain('candidate-resolution-limit: no grid was widened')
  })

  it('returns explicit diagnostics for invalid and degenerate geometry', () => {
    for (const request of [input([{ x: 1, y: 1 }, { x: 1, y: 1 }]), input([{ x: NaN, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }]),
      input(undefined, { count: NaN }), input(undefined, { width: 0 }), input(undefined, { sourceRings: [] }),
      input(undefined, { cutterRadius: NaN }), input(undefined, { exclusions: [{ start: 9, end: 2 }] })]) {
      const r = suggestTabFractions(request)
      expect(r.fractions).toEqual([])
      expect(r.diagnostics.length).toBeGreaterThan(0)
    }
  })
})
