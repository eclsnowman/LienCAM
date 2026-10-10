import { describe, expect, it } from 'vitest'
import { makeArcEntity, makeCircleEntity, makeLineEntity } from '../../components/sketch3dlab/draftEntities'
import { isAngleOnArcSweep } from '../../components/sketch3d-shared/draftEntities'

const TWO_PI = Math.PI * 2

// WO SKC-12: canonical-CCW arcs always sweep CCW via norm(endAngle - startAngle) -- the RAW sign
// of (endAngle - startAngle) carries no meaning on its own (major/minor is expressed by a
// start/end SWAP, not a signed/out-of-range delta). Tests that need "how many degrees does this
// arc actually sweep" must go through this, never a plain subtraction.
function sweepOf(arc: { startAngle: number; endAngle: number }): number {
  return (((arc.endAngle - arc.startAngle) % TWO_PI) + TWO_PI) % TWO_PI
}

describe('sketch3dlab draftEntities (re-export shim over sketch3d-shared)', () => {
  it('makeLineEntity builds a line entity from two clicked points', () => {
    const line = makeLineEntity('l1', { x: 0, y: 0 }, { x: 10, y: 5 })
    expect(line).toEqual({ id: 'l1', kind: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 5 } })
  })

  it('makeCircleEntity derives radius from the center + radius-point click', () => {
    const circle = makeCircleEntity('c1', { x: 0, y: 0 }, { x: 3, y: 4 })
    expect(circle.kind).toBe('circle')
    expect(circle.center).toEqual({ x: 0, y: 0 })
    expect(circle.radius).toBeCloseTo(5, 9)
  })

  // WO SKC-8 (A2/A6, Operator's rejection rider): 3-point arc construction is now start, end,
  // through-point (industry order), replacing the old center-start-end order he rejected.
  describe('makeArcEntity (WO SKC-8: start, end, through-point)', () => {
    it('derives center/radius from the circumcircle of all 3 points', () => {
      // A quarter circle of radius 5 centered at the origin: start=(5,0), end=(0,5), through the
      // 45deg point on the minor arc between them.
      const through = { x: 5 * Math.SQRT1_2, y: 5 * Math.SQRT1_2 }
      const arc = makeArcEntity('a1', { x: 5, y: 0 }, { x: 0, y: 5 }, through)
      expect(arc.kind).toBe('arc')
      expect(arc.center.x).toBeCloseTo(0, 9)
      expect(arc.center.y).toBeCloseTo(0, 9)
      expect(arc.radius).toBeCloseTo(5, 9)
      expect(arc.startAngle).toBeCloseTo(0, 9)
    })

    it('all three input points land exactly on the constructed circle, regardless of the through point (A6)', () => {
      const start = { x: 0, y: 0 }
      const end = { x: 10, y: 0 }
      const through = { x: 3, y: 7 } // NOT equidistant from a naive center guess -- must resolve via circumcircle
      const arc = makeArcEntity('a2', start, end, through)
      const onCircle = (p: { x: number; y: number }): number => Math.hypot(p.x - arc.center.x, p.y - arc.center.y)
      expect(onCircle(start)).toBeCloseTo(arc.radius, 9)
      expect(onCircle(end)).toBeCloseTo(arc.radius, 9)
      expect(onCircle(through)).toBeCloseTo(arc.radius, 9)
    })

    it('the through point lies ON the constructed sweep (not just the full circle) when it is the minor arc', () => {
      const start = { x: 5, y: 0 }
      const end = { x: 0, y: 5 }
      const through = { x: 5 * Math.SQRT1_2, y: 5 * Math.SQRT1_2 } // 45deg -- the SHORT way from start to end
      const arc = makeArcEntity('a3', start, end, through)
      const throughAngle = Math.atan2(through.y - arc.center.y, through.x - arc.center.x)
      expect(isAngleOnArcSweep(arc.startAngle, arc.endAngle, throughAngle)).toBe(true)
    })

    it('the through point lies ON the constructed sweep when it forces the MAJOR arc (through on the far side)', () => {
      const start = { x: 5, y: 0 }
      const end = { x: 0, y: 5 }
      // A point on the SAME circle at 200deg -- well outside the minor [0,90] sweep, on the
      // opposite side of the start-end chord from the minor arc's 45deg point -- forces the long
      // way around (270deg sweep) to be the constructed arc.
      const majorThrough = { x: 5 * Math.cos((200 * Math.PI) / 180), y: 5 * Math.sin((200 * Math.PI) / 180) }
      const arc = makeArcEntity('a4', start, end, majorThrough)
      const throughAngle = Math.atan2(majorThrough.y - arc.center.y, majorThrough.x - arc.center.x)
      expect(isAngleOnArcSweep(arc.startAngle, arc.endAngle, throughAngle)).toBe(true)
      // Sanity: this really did pick the LONG way (sweep magnitude > 180deg = pi), proving the
      // through point genuinely disambiguated minor vs major, not just landing on whichever
      // sweep the raw atan2 values happened to produce. WO SKC-12: the canonical encoding
      // expresses major/minor via a start/end SWAP, so the NORMALIZED sweep (never the raw
      // endAngle - startAngle, which is no longer a reliable major/minor signal) is what proves it.
      expect(sweepOf(arc)).toBeGreaterThan(Math.PI)
    })

    it('throws on collinear (or coincident) start/end/through points', () => {
      expect(() => makeArcEntity('a5', { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 0 })).toThrow()
    })
  })
})
