import { describe, it, expect } from 'vitest'
import {
  buildToolProfile,
  buildHolderProfile,
  radiusAtZ,
  isCutting,
  tipOffsetAtRadius,
  toolReachWarnings,
  maxImmersionDepth,
} from '../../lib/tool/toolProfile'
import type { Tool, ToolType, ToolHolder } from '../../types'

const DEG = Math.PI / 180

// Minimal Tool factory: every required field present, overridable.
function makeTool(over: Partial<Tool> & { type: ToolType }): Tool {
  return {
    id: 't',
    name: 'test',
    diameter: 6,
    fluteLength: 20,
    shankDiameter: 6,
    overallLength: 60,
    numberOfFlutes: 2,
    material: 'carbide',
    coating: 'none',
    notes: '',
    feedsAndSpeeds: {},
    ...over,
  }
}

describe('buildToolProfile', () => {
  it('flat: mid-flute radius == dia/2; cuttingMaxZ == fluteLength', () => {
    const p = buildToolProfile(makeTool({ type: 'flat_end_mill', diameter: 6, fluteLength: 20 }))
    expect(radiusAtZ(p, 10)).toBeCloseTo(3, 10)
    expect(p.cuttingMaxZ).toBe(20)
    expect(isCutting(p, 20)).toBe(true)
    expect(isCutting(p, 20.5)).toBe(false)
  })

  it('ball: r(0)==0, r(R)==R, monotonic up to equator', () => {
    const p = buildToolProfile(makeTool({ type: 'ball_end_mill', diameter: 6, fluteLength: 20 }))
    const R = 3
    expect(radiusAtZ(p, 0)).toBeCloseTo(0, 10)
    expect(radiusAtZ(p, R)).toBeCloseTo(R, 6)
    // monotonic non-decreasing across the hemisphere
    let prev = -1
    for (let z = 0; z <= R; z += R / 20) {
      const r = radiusAtZ(p, z)
      expect(r).toBeGreaterThanOrEqual(prev - 1e-9)
      prev = r
    }
  })

  it('bull: r(0)==R-RE; r(RE)==R', () => {
    const RE = 1.5
    const R = 3
    const p = buildToolProfile(makeTool({ type: 'bull_nose', diameter: 6, cornerRadius: RE, fluteLength: 20 }))
    expect(radiusAtZ(p, 0)).toBeCloseTo(R - RE, 6)
    expect(radiusAtZ(p, RE)).toBeCloseTo(R, 6)
  })

  it('cone (chamfer dia10 incl90 -> a=45, tip0): hc==5, r(0)==0, r(5)==5', () => {
    // included 90 -> stored half-angle 45
    const p = buildToolProfile(
      makeTool({ type: 'chamfer_mill', diameter: 10, angleFromAxisDeg: 45, tipDiameter: 0, fluteLength: 14 })
    )
    // hc = (R - Rt)/tan(a) = (5 - 0)/tan(45) = 5
    expect(radiusAtZ(p, 0)).toBeCloseTo(0, 10)
    expect(radiusAtZ(p, 5)).toBeCloseTo(5, 6)
    // confirm the cone reaches full radius at z=5 (hc)
    expect(radiusAtZ(p, 5)).toBeCloseTo(5, 6)
  })

  it('frustum (OPERATOR repro dia9.15 L18 perSide5): tip radius 3.00, r(L)==dia/2, linear taper, cuttingMaxZ 18', () => {
    // perSide angle stored as-is = 5
    const p = buildToolProfile(
      makeTool({ type: 'tapered_endmill', diameter: 9.15, fluteLength: 18, angleFromAxisDeg: 5 })
    )
    // derived tip dia = 9.15 - 2*18*tan(5) ~ 6.0 -> radius ~3.00
    expect(radiusAtZ(p, 0)).toBeCloseTo(3.0, 2)
    expect(radiusAtZ(p, 18)).toBeCloseTo(9.15 / 2, 6)
    expect(p.cuttingMaxZ).toBe(18)
    // linear taper: midpoint radius == average of ends
    const rMid = radiusAtZ(p, 9)
    expect(rMid).toBeCloseTo((radiusAtZ(p, 0) + radiusAtZ(p, 18)) / 2, 6)

    // the taper RESPONDS to fluteLength: a SHORTER flute gives a LARGER tip
    // (less material removed), so radius at a fixed z differs.
    const pShort = buildToolProfile(
      makeTool({ type: 'tapered_endmill', diameter: 9.15, fluteLength: 9, angleFromAxisDeg: 5 })
    )
    const tipLong = radiusAtZ(p, 0)
    const tipShort = radiusAtZ(pShort, 0)
    expect(tipShort).toBeGreaterThan(tipLong) // shorter flute -> bigger tip
    // explicit different radius at a fixed shared z (z=5)
    expect(radiusAtZ(pShort, 5)).not.toBeCloseTo(radiusAtZ(p, 5), 3)
  })

  it('drillpoint (dia6 incl118 -> a=59): r(0)==0, r(hp)==3, hp==3/tan(59)', () => {
    const a = 59
    const p = buildToolProfile(
      makeTool({ type: 'drill', diameter: 6, angleFromAxisDeg: a, fluteLength: 30 })
    )
    const hp = 3 / Math.tan(a * DEG)
    expect(radiusAtZ(p, 0)).toBeCloseTo(0, 10)
    expect(radiusAtZ(p, hp)).toBeCloseTo(3, 6)
    // hp value sanity
    expect(hp).toBeCloseTo(3 / Math.tan(59 * DEG), 10)
  })

  it('dovetail (dia12 incl60 -> a=30, L4): r(0)==6 wide, r(4)~3.69 narrower, narrows upward', () => {
    const a = 30
    const p = buildToolProfile(
      makeTool({
        type: 'dovetail_mill',
        diameter: 12,
        angleFromAxisDeg: a,
        fluteLength: 4,
        neckDiameter: 6,
        shoulderLength: 6,
        shankDiameter: 8,
      })
    )
    expect(radiusAtZ(p, 0)).toBeCloseTo(6, 6)
    const rTop = 6 - 4 * Math.tan(a * DEG)
    expect(rTop).toBeCloseTo(3.6906, 3)
    expect(radiusAtZ(p, 4)).toBeCloseTo(rTop, 6)
    // narrows upward within the cutting region
    expect(radiusAtZ(p, 4)).toBeLessThan(radiusAtZ(p, 0))
  })

  it('disc (slitting_saw dia40 L2): radius over [0,2] == 20', () => {
    const p = buildToolProfile(
      makeTool({
        type: 'slitting_saw',
        diameter: 40,
        fluteLength: 2,
        neckDiameter: 10,
        shankDiameter: 10,
        shoulderLength: 8,
        overallLength: 30,
      })
    )
    expect(radiusAtZ(p, 0)).toBeCloseTo(20, 6)
    expect(radiusAtZ(p, 1)).toBeCloseTo(20, 6)
    expect(radiusAtZ(p, 2)).toBeCloseTo(20, 6)
  })

  it('lollipop (dia6 neck3): maxRadius==3 (=R), passes equator at z==3 then narrows, neck radius==1.5', () => {
    const p = buildToolProfile(
      makeTool({ type: 'lollipop_mill', diameter: 6, neckDiameter: 3, shoulderLength: 10 })
    )
    const R = 3
    // max radius over the profile is R (sphere equator)
    const maxR = p.vertices.reduce((m, v) => Math.max(m, v.r), 0)
    expect(maxR).toBeCloseTo(R, 6)
    // equator radius reached at z == R (arc is polyline-sampled; the exact
    // equator vertex may fall between samples so interpolation undershoots R by
    // a tiny chord error -> 2-decimal tolerance. The true geometric max == R is
    // asserted at 6 decimals via maxR above.)
    expect(radiusAtZ(p, R)).toBeCloseTo(R, 2)
    // after the equator the sphere narrows (undercut) -> r < R for R < z < zNeck
    const zNeck = R + Math.sqrt(R * R - 1.5 * 1.5)
    const rAfter = radiusAtZ(p, (R + zNeck) / 2)
    expect(rAfter).toBeLessThan(R)
    // neck radius == 1.5 (just above the sphere/neck join)
    expect(radiusAtZ(p, zNeck + 1)).toBeCloseTo(1.5, 6)
  })
})

describe('radiusAtZ', () => {
  it('linear interpolation between two vertices; returns 0 above the top vertex', () => {
    // simple cone: r=0 at z=0, r=10 at z=10
    const profile = { vertices: [{ z: 0, r: 0 }, { z: 10, r: 10 }], cuttingMaxZ: 10, fluteTopZ: 10 }
    expect(radiusAtZ(profile, 0)).toBeCloseTo(0, 10)
    expect(radiusAtZ(profile, 2.5)).toBeCloseTo(2.5, 10)
    expect(radiusAtZ(profile, 7)).toBeCloseTo(7, 10)
    expect(radiusAtZ(profile, 10)).toBeCloseTo(10, 10)
    expect(radiusAtZ(profile, 11)).toBe(0) // above the top vertex
    expect(radiusAtZ(profile, -1)).toBeCloseTo(0, 10) // clamp at/below 0 -> first vertex
  })
})

describe('tipOffsetAtRadius (byte-equivalence with the legacy carve formulas)', () => {
  it('flat: 0 for every d in [0, R] (matches the old () => 0 branch)', () => {
    const p = buildToolProfile(makeTool({ type: 'flat_end_mill', diameter: 6, fluteLength: 20 }))
    for (const d of [0, 0.5, 1, 2, 2.999, 3]) {
      expect(tipOffsetAtRadius(p, d)).toBeCloseTo(0, 10)
    }
    // d beyond the cutting radius clamps to maxR -> still 0 for a flat mill.
    expect(tipOffsetAtRadius(p, 5)).toBeCloseTo(0, 10)
  })

  it('ball dia6: equals R - sqrt(R^2 - d^2) (the old ball branch) within polyline error', () => {
    const R = 3
    const p = buildToolProfile(makeTool({ type: 'ball_end_mill', diameter: 6, fluteLength: 20 }))
    for (const d of [0, 1, 1.5, 2.25]) {
      const analytic = R - Math.sqrt(R * R - d * d)
      // 40-segment hemisphere polyline -> small chord error; 2-decimal tolerance.
      expect(tipOffsetAtRadius(p, d)).toBeCloseTo(analytic, 2)
    }
    // tip is exact.
    expect(tipOffsetAtRadius(p, 0)).toBeCloseTo(0, 10)
  })

  it('v_bit incl60 (a=30 from axis), tip0: equals d / tan(30deg) (the old cone branch)', () => {
    // included 60 -> stored half-angle 30. cone tip flat = 0.
    const p = buildToolProfile(
      makeTool({ type: 'v_bit', diameter: 6, angleFromAxisDeg: 30, tipDiameter: 0, fluteLength: 20 })
    )
    const tan30 = Math.tan(30 * DEG)
    for (const d of [0, 0.5, 1, 2, 3]) {
      expect(tipOffsetAtRadius(p, d)).toBeCloseTo(d / tan30, 6)
    }
  })

  it('clamps d: negative -> 0; beyond maxR -> height at maxR', () => {
    const R = 3
    const p = buildToolProfile(makeTool({ type: 'ball_end_mill', diameter: 6, fluteLength: 20 }))
    expect(tipOffsetAtRadius(p, -1)).toBeCloseTo(0, 10)
    // d > R -> clamp to R; ball height at the equator is R.
    expect(tipOffsetAtRadius(p, 10)).toBeCloseTo(R, 2)
  })
})

describe('buildHolderProfile', () => {
  it('3-segment stack -> z monotonic increasing by segment heights; radii from lower/upper dias', () => {
    const holder: ToolHolder = {
      id: 'h',
      name: 'collet',
      segments: [
        { height: 10, lowerDiameter: 20, upperDiameter: 20 }, // cylinder
        { height: 30, lowerDiameter: 20, upperDiameter: 40 }, // cone
        { height: 20, lowerDiameter: 40, upperDiameter: 40 }, // cylinder
      ],
    }
    const v = buildHolderProfile(holder)
    expect(v).toHaveLength(6)
    // z values: 0,10 | 10,40 | 40,60
    expect(v.map(p => p.z)).toEqual([0, 10, 10, 40, 40, 60])
    // monotonic non-decreasing z
    for (let i = 1; i < v.length; i++) {
      expect(v[i].z).toBeGreaterThanOrEqual(v[i - 1].z)
    }
    // radii from lower/upper diameters
    expect(v[0].r).toBeCloseTo(10, 10) // 20/2
    expect(v[1].r).toBeCloseTo(10, 10)
    expect(v[2].r).toBeCloseTo(10, 10)
    expect(v[3].r).toBeCloseTo(20, 10) // 40/2
    expect(v[4].r).toBeCloseTo(20, 10)
    expect(v[5].r).toBeCloseTo(20, 10)
  })
})

describe('toolReachWarnings (passive rub check)', () => {
  it('depth < flute length -> no warning', () => {
    const t = makeTool({ type: 'flat_end_mill', fluteLength: 20 })
    expect(toolReachWarnings(t, 10)).toEqual([])
  })

  it('depth == flute length (within epsilon) -> no warning', () => {
    const t = makeTool({ type: 'flat_end_mill', fluteLength: 20 })
    expect(toolReachWarnings(t, 20)).toEqual([])
  })

  it('depth > flute length -> one shank-rub warning with correct limit', () => {
    const t = makeTool({ type: 'flat_end_mill', fluteLength: 20, lengthBelowHolder: undefined })
    const w = toolReachWarnings(t, 25)
    expect(w).toHaveLength(1)
    expect(w[0].kind).toBe('shank-rub')
    expect(w[0].limitMm).toBe(20)
    expect(w[0].depthMm).toBe(25)
  })

  it('depth > lengthBelowHolder but < flute -> holder-rub only', () => {
    const t = makeTool({ type: 'flat_end_mill', fluteLength: 40, lengthBelowHolder: 15 })
    const w = toolReachWarnings(t, 20)
    expect(w).toHaveLength(1)
    expect(w[0].kind).toBe('holder-rub')
    expect(w[0].limitMm).toBe(15)
  })

  it('depth > both flute and stickout -> both warnings', () => {
    const t = makeTool({ type: 'flat_end_mill', fluteLength: 20, lengthBelowHolder: 25 })
    const w = toolReachWarnings(t, 30)
    expect(w.map((x) => x.kind).sort()).toEqual(['holder-rub', 'shank-rub'])
  })

  it('fluteLength 0 / unknown -> no shank warning', () => {
    expect(toolReachWarnings(makeTool({ type: 'flat_end_mill', fluteLength: 0 }), 30)).toEqual([])
  })

  it('non-positive / non-finite depth -> none', () => {
    const t = makeTool({ type: 'flat_end_mill', fluteLength: 20, lengthBelowHolder: 10 })
    expect(toolReachWarnings(t, 0)).toEqual([])
    expect(toolReachWarnings(t, -5)).toEqual([])
    expect(toolReachWarnings(t, NaN)).toEqual([])
  })

  it('messages are plain ASCII (no unicode)', () => {
    const t = makeTool({ type: 'flat_end_mill', fluteLength: 20, lengthBelowHolder: 10 })
    for (const w of toolReachWarnings(t, 30)) {
      // eslint-disable-next-line no-control-regex
      expect(/^[\x00-\x7F]*$/.test(w.message)).toBe(true)
    }
  })
})

describe('maxImmersionDepth (toolpath-derived cut depth)', () => {
  // Engrave / depth-from-width regression: top of cut at abs Z=5, the tool tip
  // only reaches z=4.70 (a ~0.3mm engrave), even though the bottom PLANE is far
  // below. The immersion must be the shallow 0.30 -- NOT the top-to-bottom span
  // (which falsely read 5mm and tripped the rub warning).
  it('uses the deepest cut, not the bottom plane (engrave case)', () => {
    const moves = [
      { type: 'rapid', z: 15 },     // travel at clearance, ignored
      { type: 'feed', z: 5.5 },     // plunge approach above the surface
      { type: 'feed', z: 4.6996 },  // deepest engraving cut
      { type: 'rapid', z: 15 },     // retract, ignored
    ]
    expect(maxImmersionDepth(5, moves)).toBeCloseTo(0.3004, 3)
  })

  it('reports the full depth for a genuine deep pocket', () => {
    // top abs Z=5, pocket floor at abs Z=0 -> 5mm immersion (would warn vs a
    // short flute). Proves the fix did not just suppress all warnings.
    const moves = [
      { type: 'rapid', z: 15 },
      { type: 'feed', z: 0 },
    ]
    expect(maxImmersionDepth(5, moves)).toBe(5)
  })

  it('rapids never set the depth, and above-top stays 0', () => {
    expect(maxImmersionDepth(5, [{ type: 'rapid', z: -100 }])).toBe(0) // rapid ignored
    expect(maxImmersionDepth(5, [{ type: 'feed', z: 6 }])).toBe(0)     // never below top
    expect(maxImmersionDepth(5, [])).toBe(0)                            // no toolpath
  })
})
