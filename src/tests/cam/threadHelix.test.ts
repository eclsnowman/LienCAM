import { describe, it, expect } from 'vitest'
import {
  HELIX_FI_STEP,
  threadOrbitSense,
  threadTravelUp,
  generateThreadHelix,
  generateLeadArc,
} from '../../lib/cam/threadHelix'

describe('threadOrbitSense', () => {
  // Sanity rows (spindle = +1 standard right-hand cutter):
  //   internal + climb        -> s = +1
  //   internal + conventional -> s = -1
  //   external + climb        -> s = -1
  //   external + conventional -> s = +1
  it('internal + climb -> +1', () => {
    expect(threadOrbitSense('internal', 'climb', 1)).toBe(1)
  })
  it('internal + conventional -> -1', () => {
    expect(threadOrbitSense('internal', 'conventional', 1)).toBe(-1)
  })
  it('external + climb -> -1', () => {
    expect(threadOrbitSense('external', 'climb', 1)).toBe(-1)
  })
  it('external + conventional -> +1', () => {
    expect(threadOrbitSense('external', 'conventional', 1)).toBe(1)
  })

  it('does not depend on hand (no hand parameter); spindle flips the sense', () => {
    // spindle = -1 mirrors every row.
    expect(threadOrbitSense('internal', 'climb', -1)).toBe(-1)
    expect(threadOrbitSense('external', 'climb', -1)).toBe(1)
  })

  it('throws on invalid kind / cut / spindle', () => {
    // @ts-expect-error invalid enum
    expect(() => threadOrbitSense('bad', 'climb', 1)).toThrow(/thread/)
    // @ts-expect-error invalid enum
    expect(() => threadOrbitSense('internal', 'bad', 1)).toThrow(/thread/)
    // @ts-expect-error invalid spindle
    expect(() => threadOrbitSense('internal', 'climb', 2)).toThrow(/thread/)
  })
})

describe('threadTravelUp', () => {
  // travelUp = (orbitSense * handSign) > 0; right=+1, left=-1.
  it('orbitSense +1 + right -> ascend (true)', () => {
    expect(threadTravelUp(1, 'right')).toBe(true)
  })
  it('orbitSense -1 + right -> descend (false)', () => {
    expect(threadTravelUp(-1, 'right')).toBe(false)
  })
  it('orbitSense +1 + left -> descend (false)', () => {
    expect(threadTravelUp(1, 'left')).toBe(false)
  })
  it('orbitSense -1 + left -> ascend (true)', () => {
    expect(threadTravelUp(-1, 'left')).toBe(true)
  })

  it('combined sanity rows (internal/external x right x climb/conventional)', () => {
    // internal + right + climb        -> s=+1 -> ascend (today's default).
    expect(threadTravelUp(threadOrbitSense('internal', 'climb', 1), 'right')).toBe(true)
    // internal + right + conventional -> s=-1 -> descend.
    expect(threadTravelUp(threadOrbitSense('internal', 'conventional', 1), 'right')).toBe(false)
    // external + right + climb        -> s=-1 -> descend.
    expect(threadTravelUp(threadOrbitSense('external', 'climb', 1), 'right')).toBe(false)
    // external + right + conventional -> s=+1 -> ascend (today's external).
    expect(threadTravelUp(threadOrbitSense('external', 'conventional', 1), 'right')).toBe(true)
  })

  it('throws on invalid orbitSense / hand', () => {
    // @ts-expect-error invalid sense
    expect(() => threadTravelUp(0, 'right')).toThrow(/thread/)
    // @ts-expect-error invalid hand
    expect(() => threadTravelUp(1, 'bad')).toThrow(/thread/)
  })
})

describe('generateThreadHelix', () => {
  const base = {
    cx: 0,
    cy: 0,
    radius: 4,
    pitch: 2,
    bottomZ: -10,
    topZ: 0,
    dir: 1 as 1 | -1,
    feed: 200,
  }

  it('exposes HELIX_FI_STEP = pi/16', () => {
    expect(HELIX_FI_STEP).toBeCloseTo(Math.PI / 16, 12)
  })

  it('revolutions count and Z advance ~pitch per full turn', () => {
    expect((base.topZ - base.bottomZ) / base.pitch).toBe(5)

    const moves = generateThreadHelix(base)

    // Total signed angle swept (track unwrapped) ~= dir * revs * 2pi.
    let total = 0
    for (let i = 1; i < moves.length; i++) {
      const prev = Math.atan2(moves[i - 1].y, moves[i - 1].x)
      const cur = Math.atan2(moves[i].y, moves[i].x)
      let d = cur - prev
      while (d > Math.PI) d -= 2 * Math.PI
      while (d < -Math.PI) d += 2 * Math.PI
      total += d
    }
    expect(total).toBeCloseTo(base.dir * 5 * 2 * Math.PI, 6)

    // A point one full revolution in should be ~bottomZ + pitch.
    // One rev = 2pi of absolute angle; sample the move nearest a = 2pi.
    // z = bottomZ + (a/totalAngleAbs)*dz, totalAngleAbs = 5*2pi, dz = 10.
    // At a = 2pi -> z = -10 + (1/5)*10 = -8 = bottomZ + pitch.
    // Find move whose z is closest to -8.
    let best = moves[0]
    for (const m of moves) {
      if (Math.abs(m.z - -8) < Math.abs(best.z - -8)) best = m
    }
    expect(best.z).toBeCloseTo(base.bottomZ + base.pitch, 1)
  })

  it('every point lies at radius from center', () => {
    const moves = generateThreadHelix(base)
    for (const m of moves) {
      const r = Math.hypot(m.x - base.cx, m.y - base.cy)
      expect(Math.abs(r - base.radius)).toBeLessThan(1e-9)
    }
  })

  it('first z is bottomZ and last z is topZ exactly', () => {
    const moves = generateThreadHelix(base)
    expect(moves[0].z).toBe(base.bottomZ)
    expect(moves[moves.length - 1].z).toBe(0)
  })

  it('Z strictly increasing across consecutive points', () => {
    const moves = generateThreadHelix(base)
    for (let i = 1; i < moves.length; i++) {
      expect(moves[i].z).toBeGreaterThan(moves[i - 1].z)
    }
  })

  it('all moves are feed/helix with the given feed', () => {
    const moves = generateThreadHelix(base)
    for (const m of moves) {
      expect(m.type).toBe('feed')
      expect(m.role).toBe('helix')
      expect(m.feed).toBe(200)
    }
  })

  it('dir = -1 orbits clockwise (angle decreases)', () => {
    const moves = generateThreadHelix({ ...base, dir: -1 })
    // With phi0 = 0, the second point's angle should be negative (CW).
    const ang1 = Math.atan2(moves[1].y, moves[1].x)
    expect(ang1).toBeLessThan(0)
  })

  it('fails loud on radius <= 0', () => {
    expect(() => generateThreadHelix({ ...base, radius: 0 })).toThrow()
    expect(() => generateThreadHelix({ ...base, radius: -1 })).toThrow()
  })

  it('fails loud on pitch <= 0', () => {
    expect(() => generateThreadHelix({ ...base, pitch: 0 })).toThrow()
    expect(() => generateThreadHelix({ ...base, pitch: -1 })).toThrow()
  })

  it('fails loud on topZ <= bottomZ', () => {
    expect(() => generateThreadHelix({ ...base, topZ: -10 })).toThrow()
    expect(() => generateThreadHelix({ ...base, topZ: -11 })).toThrow()
  })

  it('descend=true: first z is topZ, last z is bottomZ exactly, Z strictly decreasing', () => {
    const moves = generateThreadHelix({ ...base, descend: true })
    expect(moves[0].z).toBe(base.topZ)              // 0
    expect(moves[moves.length - 1].z).toBe(base.bottomZ) // -10
    for (let i = 1; i < moves.length; i++) {
      expect(moves[i].z).toBeLessThan(moves[i - 1].z)
    }
    // XY orbit (dir sense) unchanged: every point at radius, same start angle.
    for (const m of moves) {
      const r = Math.hypot(m.x - base.cx, m.y - base.cy)
      expect(Math.abs(r - base.radius)).toBeLessThan(1e-9)
    }
    expect(moves[0].x).toBeCloseTo(base.cx + base.radius, 9) // phi0 = 0 -> (+R, 0)
  })

  it('descend=false default is byte-identical to omitting descend', () => {
    const a = generateThreadHelix(base)
    const b = generateThreadHelix({ ...base, descend: false })
    expect(b).toEqual(a)
  })

  it('non-integer revs: last point exactly topZ, strictly increasing', () => {
    // pitch=3, bottomZ=-10, topZ=0 -> revs = 10/3 = 3.333...
    const moves = generateThreadHelix({ ...base, pitch: 3 })
    expect(moves[0].z).toBe(-10)
    expect(moves[moves.length - 1].z).toBe(0)
    for (let i = 1; i < moves.length; i++) {
      expect(moves[i].z).toBeGreaterThan(moves[i - 1].z)
    }
  })
})

describe('generateLeadArc', () => {
  const base = {
    cx: 3,
    cy: -2,
    radius: 4,
    angle: 0,
    dir: 1 as 1 | -1,
    z: -5,
    feed: 150,
  }

  // Orbit point Q = O + R*u.
  function qOf(angle: number, radius: number, cx: number, cy: number) {
    return { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) }
  }

  it('lead_in: starts at center O, ends one step before Q, tangent (no cusp)', () => {
    const moves = generateLeadArc({ ...base, kindRole: 'lead_in' })
    expect(moves.length).toBeGreaterThanOrEqual(2)

    // First point is exactly the center O.
    expect(moves[0].x).toBeCloseTo(base.cx, 9)
    expect(moves[0].y).toBeCloseTo(base.cy, 9)

    // All points at the given z, role lead_in.
    for (const m of moves) {
      expect(m.z).toBe(base.z)
      expect(m.role).toBe('lead_in')
    }

    // Last lead-in point is NOT Q (Q dropped — the helix emits it).
    const q = qOf(base.angle, base.radius, base.cx, base.cy)
    const last = moves[moves.length - 1]
    expect(Math.hypot(last.x - q.x, last.y - q.y)).toBeGreaterThan(1e-6)

    // Tangency: direction from last lead-in point toward Q, normalized, dotted
    // with the orbit tangent t = dir*(-sin angle, cos angle) is > 0.9.
    const dx = q.x - last.x
    const dy = q.y - last.y
    const len = Math.hypot(dx, dy)
    const tx = base.dir * -Math.sin(base.angle)
    const ty = base.dir * Math.cos(base.angle)
    const dot = (dx / len) * tx + (dy / len) * ty
    expect(dot).toBeGreaterThan(0.9)
  })

  it('lead_out: ends at center O, starts after Q (Q dropped)', () => {
    const moves = generateLeadArc({ ...base, kindRole: 'lead_out' })
    expect(moves.length).toBeGreaterThanOrEqual(2)

    // Last point is exactly center O.
    const last = moves[moves.length - 1]
    expect(last.x).toBeCloseTo(base.cx, 9)
    expect(last.y).toBeCloseTo(base.cy, 9)

    for (const m of moves) {
      expect(m.role).toBe('lead_out')
    }

    // First lead-out point is NOT Q (Q dropped — the helix already emitted it).
    const q = qOf(base.angle, base.radius, base.cx, base.cy)
    const first = moves[0]
    expect(Math.hypot(first.x - q.x, first.y - q.y)).toBeGreaterThan(1e-6)
  })

  it('dir = +1 and dir = -1 both produce a sane arc (>= 2 points)', () => {
    const a = generateLeadArc({ ...base, dir: 1, kindRole: 'lead_in' })
    const b = generateLeadArc({ ...base, dir: -1, kindRole: 'lead_in' })
    expect(a.length).toBeGreaterThanOrEqual(2)
    expect(b.length).toBeGreaterThanOrEqual(2)
  })

  it('fails loud on radius <= 0', () => {
    expect(() => generateLeadArc({ ...base, radius: 0, kindRole: 'lead_in' })).toThrow()
    expect(() => generateLeadArc({ ...base, radius: -1, kindRole: 'lead_in' })).toThrow()
  })
})
