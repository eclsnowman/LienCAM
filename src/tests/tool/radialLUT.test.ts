import { describe, it, expect } from 'vitest'
import {
  buildToolProfile,
  buildRadialLUT,
  evalRadialLUT,
  tipOffsetAtRadius,
  type ToolProfile,
} from '../../lib/tool/toolProfile'
import type { Tool, ToolType } from '../../types'

// PERF-RECON finding #2: the voxel carve's per-voxel profile evaluation
// (src/lib/simulation/voxel/carve.ts) now reads a precomputed radial LUT
// instead of calling tipOffsetAtRadius directly. tipOffsetAtRadius itself is
// UNCHANGED and is the oracle here: for every profileKind buildToolProfile can
// emit, evalRadialLUT(buildRadialLUT(profile), d) must equal
// tipOffsetAtRadius(profile, d) BIT FOR BIT (toBe, not toBeCloseTo) across a
// fine sweep of d -- not merely "close", per the material-safety bar on the
// carved field.

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

// Exhaustively compare the LUT against the oracle across a fine sweep of d,
// including exact profile-vertex radii (breakpoints), negative d (clamp-low),
// and d well beyond the tool radius (clamp-high).
function assertLutMatchesOracle(profile: ToolProfile, R: number, label: string): void {
  const lut = buildRadialLUT(profile)
  const samples = new Set<number>()
  samples.add(-1)
  samples.add(0)
  const STEPS = 500
  for (let i = 0; i <= STEPS; i++) samples.add((R * i) / STEPS)
  for (const p of profile.vertices) samples.add(p.r) // exact breakpoints
  samples.add(R + 0.5)
  samples.add(R * 2)

  let checked = 0
  for (const d of samples) {
    const oracle = tipOffsetAtRadius(profile, d)
    const lutVal = evalRadialLUT(lut, d)
    expect(lutVal, `${label} @ d=${d}: LUT=${lutVal} oracle=${oracle}`).toBe(oracle)
    checked++
  }
  expect(checked).toBeGreaterThan(400)
}

describe('radial LUT (buildRadialLUT/evalRadialLUT) matches tipOffsetAtRadius oracle exactly', () => {
  it('flat end mill', () => {
    const R = 3
    const p = buildToolProfile(makeTool({ type: 'flat_end_mill', diameter: 6, fluteLength: 20 }))
    assertLutMatchesOracle(p, R, 'flat')
  })

  it('ball end mill', () => {
    const R = 3
    const p = buildToolProfile(makeTool({ type: 'ball_end_mill', diameter: 6, fluteLength: 20 }))
    assertLutMatchesOracle(p, R, 'ball')
  })

  it('bull nose, small corner radius', () => {
    const R = 4
    const p = buildToolProfile(
      makeTool({ type: 'bull_nose', diameter: 8, cornerRadius: 1, fluteLength: 20 }),
    )
    assertLutMatchesOracle(p, R, 'bull-small-corner')
  })

  it('bull nose, full corner radius (== ball)', () => {
    const R = 3
    const p = buildToolProfile(
      makeTool({ type: 'bull_nose', diameter: 6, cornerRadius: 3, fluteLength: 20 }),
    )
    assertLutMatchesOracle(p, R, 'bull-full-corner')
  })

  it('v_bit / chamfer, several included angles', () => {
    for (const halfAngle of [15, 30, 45, 60]) {
      const R = 3
      const p = buildToolProfile(
        makeTool({ type: 'v_bit', diameter: 6, angleFromAxisDeg: halfAngle, tipDiameter: 0, fluteLength: 20 }),
      )
      assertLutMatchesOracle(p, R, `v_bit-${halfAngle}`)
    }
  })

  it('tapered endmill (frustum)', () => {
    const R = 9.15 / 2
    const p = buildToolProfile(
      makeTool({ type: 'tapered_endmill', diameter: 9.15, fluteLength: 18, angleFromAxisDeg: 5 }),
    )
    assertLutMatchesOracle(p, R, 'frustum')
  })

  it('drill point', () => {
    const R = 3
    const p = buildToolProfile(
      makeTool({ type: 'drill', diameter: 6, angleFromAxisDeg: 59, fluteLength: 30 }),
    )
    assertLutMatchesOracle(p, R, 'drillpoint')
  })

  it('dovetail mill (INVERTED taper -- r decreases tip-up, the non-monotonic case)', () => {
    const R = 6
    const p = buildToolProfile(
      makeTool({
        type: 'dovetail_mill',
        diameter: 12,
        angleFromAxisDeg: 30,
        fluteLength: 4,
        neckDiameter: 6,
        shoulderLength: 6,
        shankDiameter: 8,
      }),
    )
    assertLutMatchesOracle(p, R, 'dovetail')
  })

  it('disc / slitting saw', () => {
    const R = 20
    const p = buildToolProfile(
      makeTool({
        type: 'slitting_saw',
        diameter: 40,
        fluteLength: 2,
        neckDiameter: 10,
        shankDiameter: 10,
        shoulderLength: 8,
        overallLength: 30,
      }),
    )
    assertLutMatchesOracle(p, R, 'disc')
  })

  it('lollipop mill (SHADOWED tail -- arc rises past equator then narrows, non-monotonic)', () => {
    const R = 3
    const p = buildToolProfile(
      makeTool({ type: 'lollipop_mill', diameter: 6, neckDiameter: 3, shoulderLength: 10 }),
    )
    assertLutMatchesOracle(p, R, 'lollipop')
  })

  it('thread mill, multi-tooth (ZIGZAG root/crest/root, the most non-monotonic case)', () => {
    const R = 3
    const p = buildToolProfile(
      makeTool({
        type: 'thread_mill',
        diameter: 6,
        threadPitch: 1,
        threadTeethCount: 5,
        threadFormAngleDeg: 60,
        neckDiameter: 4,
        shoulderLength: 8,
        neckTransitionAngleDeg: 30,
      }),
    )
    assertLutMatchesOracle(p, R, 'thread-multi-tooth')
  })

  it('thread mill, no pitch set (legacy plain-cylinder fallback == flat)', () => {
    const R = 3
    const p = buildToolProfile(makeTool({ type: 'thread_mill', diameter: 6, fluteLength: 20 }))
    assertLutMatchesOracle(p, R, 'thread-no-pitch')
  })

  it('degenerate profile (single vertex, cuttingMaxZ 0) falls through safely', () => {
    const p: ToolProfile = { vertices: [{ z: 0, r: 0 }], cuttingMaxZ: 0, fluteTopZ: 0 }
    assertLutMatchesOracle(p, 1, 'degenerate')
  })

  it('empty-vertices profile: both LUT and oracle return 0 everywhere', () => {
    const p: ToolProfile = { vertices: [], cuttingMaxZ: 0, fluteTopZ: 0 }
    const lut = buildRadialLUT(p)
    for (const d of [-1, 0, 1, 5]) {
      expect(evalRadialLUT(lut, d)).toBe(0)
      expect(tipOffsetAtRadius(p, d)).toBe(0)
    }
  })
})
