// WO-2291: the engagement estimate the Pocket slot feed is built on, on
// LienCAM's Y-up frame (PureCutCNC, where it comes from, is Y-down inside).
import { describe, expect, it } from 'vitest'
import {
  EngagementFeedQuantizer, SweptMaterialIndex, engagementFeedRungs, engagementFeedScale, nominalEngagement,
} from '../../lib/cam/engagement2d'

const R = 3

/** A prior straight pass along y = 0 from x -50 to 50 (Y up). */
function priorAlongX(): SweptMaterialIndex {
  const index = new SweptMaterialIndex(R)
  for (let x = -50; x < 50; x += 1.2) index.addSweptSegment(x, 0, Math.min(50, x + 1.2), 0)
  return index
}

describe('WO-2291: engagement of a pass beside a prior pass', () => {
  const depths = [0, 0.3, 0.8, 1.5, 2.4, 3, 4, 4.5, 5.5, 6]

  it('reads arccos(1 - a/r) for radial depth a, moving either way along X, on the +Y side', () => {
    const index = priorAlongX()
    for (const a of depths) {
      const expected = Math.acos(1 - a / R)
      // The cutter centre is a above the prior pass: its +Y edge reaches a into uncut stock.
      expect(index.engagementAt(0, a, 1, 0)).toBeCloseTo(expected, 9)
      expect(index.engagementAt(7.3, a, -1, 0)).toBeCloseTo(expected, 9)
    }
  })

  it('reads the same on the -Y side (frame independence)', () => {
    const index = priorAlongX()
    for (const a of depths) {
      expect(index.engagementAt(0, -a, 1, 0)).toBeCloseTo(Math.acos(1 - a / R), 9)
    }
  })

  it('reads the same for a pass along Y beside a prior pass along Y', () => {
    const index = new SweptMaterialIndex(R)
    for (let y = -40; y < 40; y += 2) index.addSweptSegment(10, y, 10, y + 2)
    for (const a of depths) {
      expect(index.engagementAt(10 - a, 0, 0, 1)).toBeCloseTo(Math.acos(1 - a / R), 9)
      expect(index.engagementAt(10 + a, 0, 0, -1)).toBeCloseTo(Math.acos(1 - a / R), 9)
    }
  })

  it('gives the landmarks: 0 at a = 0, pi/2 at a = r, pi at a = 2r', () => {
    const index = priorAlongX()
    expect(index.engagementAt(0, 0, 1, 0)).toBeCloseTo(0, 9)
    expect(index.engagementAt(0, R, 1, 0)).toBeCloseTo(Math.PI / 2, 9)
    expect(index.engagementAt(0, 2 * R, 1, 0)).toBeCloseTo(Math.PI, 9)
  })

  it('reads virgin stock as pi: an empty index, and a sweep far away', () => {
    expect(new SweptMaterialIndex(R).engagementAt(5, 5, 1, 0)).toBe(Math.PI)
    const far = new SweptMaterialIndex(R)
    far.addSweptSegment(100, 100, 120, 100)
    expect(far.engagementAt(0, 0, 1, 0)).toBe(Math.PI)
  })

  it('reads material only ahead: a pass following its own trail is a full slot', () => {
    const index = new SweptMaterialIndex(R)
    index.addSweptSegment(-20, 0, 0, 0)
    // Just past the trail's end the leading half is (all but a sliver) uncut.
    expect(index.engagementAt(0.01, 0, 1, 0)).toBeGreaterThan(Math.PI - 0.01)
    expect(index.engagementAt(1, 0, 1, 0)).toBeCloseTo(Math.PI, 9)
    // Turned back along its own trail the cutter is in cut space.
    expect(index.engagementAt(-1, 0, -1, 0)).toBeCloseTo(0, 9)
  })

  it('nominal engagement is the same closed form', () => {
    expect(nominalEngagement(2.4, R)).toBeCloseTo(Math.acos(1 - 2.4 / R), 12)
    expect(nominalEngagement(0, R)).toBe(0)
    expect(nominalEngagement(6, R)).toBeCloseTo(Math.PI, 12)
  })
})

describe('WO-2291: the quantised feed', () => {
  const nominal = nominalEngagement(2.4, R)

  it('is monotone in engagement, never above 100% and never below the slot feed', () => {
    for (const slot of [0.25, 0.5, 0.8, 1]) {
      let previous = Infinity
      for (let i = 0; i <= 2000; i++) {
        const engagement = (Math.PI * i) / 2000
        const scale = engagementFeedScale(engagement, nominal, slot)
        expect(scale).toBeLessThanOrEqual(1)
        expect(scale).toBeGreaterThanOrEqual(slot)
        expect(scale).toBeLessThanOrEqual(previous)
        previous = scale
      }
      expect(engagementFeedScale(Math.PI, nominal, slot)).toBeCloseTo(slot, 12)
      expect(engagementFeedScale(nominal, nominal, slot)).toBe(1)
    }
  })

  it('emits only rung values, so equal-feed runs stay joinable', () => {
    const rungs = engagementFeedRungs(0.5)
    expect(rungs[0]).toBe(1)
    expect(rungs[rungs.length - 1]).toBeCloseTo(0.5, 12)
    for (let i = 0; i <= 200; i++) {
      const scale = engagementFeedScale(nominal + ((Math.PI - nominal) * i) / 200, nominal, 0.5)
      expect(rungs.some(rung => Math.abs(rung - scale) < 1e-12)).toBe(true)
    }
  })

  it('drops at once, rises only after a held stretch', () => {
    const q = new EngagementFeedQuantizer({ nominal, slotScale: 0.5, minStretch: 6 })
    expect(q.push(nominal, 1)).toBe(1)
    expect(q.push(Math.PI, 1)).toBeCloseTo(0.5, 12)
    // A spike's recovery to a mid rung holds the slot feed until the bar is met.
    const mid = nominal + (Math.PI - nominal) * 0.5
    expect(q.push(mid, 0.5)).toBeCloseTo(0.5, 12)
    // Back to nominal: full feed at once.
    expect(q.push(nominal, 1)).toBe(1)
    for (let i = 0; i < 50; i++) {
      const scale = q.push(nominal + (Math.PI - nominal) * Math.random(), 0.3)
      expect(scale).toBeLessThanOrEqual(1)
      expect(scale).toBeGreaterThanOrEqual(0.5 - 1e-12)
    }
  })
})
