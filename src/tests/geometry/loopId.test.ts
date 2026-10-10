import { describe, it, expect } from 'vitest'
import { computeLoopContentId, assignStableLoopIds } from '../../lib/geometry/loopId'

// Unit coverage for the stable content-derived loop-id helper
// (docs/planning/STABLE-LOOP-ID-PLAN.md, Item 1). The id MUST be a pure function
// of (layerId, geometry-within-quantum) so it survives a tolerance-stable
// re-derive and changes only when the loop genuinely changes -> fail SAFE.

type TestLoop = { id: string; layerId: string; points: { x: number; y: number }[] }

const SQUARE = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
]

describe('computeLoopContentId / assignStableLoopIds', () => {
  // (i) same input -> same id
  it('is deterministic: identical input yields an identical id', () => {
    const a = computeLoopContentId('L', SQUARE)
    const b = computeLoopContentId('L', SQUARE)
    expect(a).toBe(b)
    expect(a.length).toBeGreaterThan(0)
  })

  // (ii) sub-quantum perturbation -> same id
  it('is stable under a sub-quantum (<0.01) perturbation of the points', () => {
    const base = computeLoopContentId('L', SQUARE)
    const wobbled = SQUARE.map(p => ({ x: p.x + 0.001, y: p.y - 0.002 }))
    expect(computeLoopContentId('L', wobbled)).toBe(base)
  })

  // (iii) genuinely different loop -> different id
  it('changes when the loop genuinely changes (area / centroid past the quantum)', () => {
    const base = computeLoopContentId('L', SQUARE)
    const bigger = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 20 },
      { x: 0, y: 20 },
    ]
    expect(computeLoopContentId('L', bigger)).not.toBe(base)

    // Same shape/size, different location -> different centroid -> different id.
    const shifted = SQUARE.map(p => ({ x: p.x + 5, y: p.y + 5 }))
    expect(computeLoopContentId('L', shifted)).not.toBe(base)
  })

  // (iv) two coincident loops -> distinct disambiguated ids
  it('deterministically disambiguates coincident loops with #n suffixes', () => {
    const loops: TestLoop[] = [
      { id: 'a', layerId: 'L', points: SQUARE },
      { id: 'b', layerId: 'L', points: SQUARE },
      { id: 'c', layerId: 'L', points: SQUARE },
    ]
    const out = assignStableLoopIds(loops)
    const ids = out.map(l => l.id)
    expect(new Set(ids).size).toBe(3) // all distinct
    expect(ids[0]).not.toContain('#')
    expect(ids[1]).toBe(`${ids[0]}#1`)
    expect(ids[2]).toBe(`${ids[0]}#2`)
    // Deterministic: a second run produces the identical disambiguation.
    expect(assignStableLoopIds(loops).map(l => l.id)).toEqual(ids)
  })

  // (v) same content under two namespaces -> different ids
  it('namespaces by geoId: same content under different namespaces differs', () => {
    const loops: TestLoop[] = [{ id: 'x', layerId: 'L', points: SQUARE }]
    const g1 = assignStableLoopIds(loops, 'geoA')[0].id
    const g2 = assignStableLoopIds(loops, 'geoB')[0].id
    expect(g1).not.toBe(g2)
    expect(g1.startsWith('geoA~')).toBe(true)
    expect(g2.startsWith('geoB~')).toBe(true)
    // No namespace -> bare content id, no '~'.
    expect(assignStableLoopIds(loops)[0].id).not.toContain('~')
  })

  it('recomputes from points and ignores the incoming id (idempotent)', () => {
    const loops: TestLoop[] = [{ id: 'garbage-uuid', layerId: 'L', points: SQUARE }]
    const once = assignStableLoopIds(loops, 'g')
    const twice = assignStableLoopIds(once, 'g') // feed its own output back in
    expect(twice[0].id).toBe(once[0].id)
  })

  it('returns new objects without mutating the input', () => {
    const loops: TestLoop[] = [{ id: 'orig', layerId: 'L', points: SQUARE }]
    const out = assignStableLoopIds(loops, 'g')
    expect(loops[0].id).toBe('orig')
    expect(out[0]).not.toBe(loops[0])
  })
})
