// WO-2058 - Boss and Rect boss start over the middle.
//
// docs/design/PROBING-PAINT-BY-NUMBERS.md 4.2 / build order 4 (Operator approved
// on card Q-PROBING-SCREEN-ROUND-2, 2026-09-26): the operator starts over the
// middle of the boss, by eye, at any height above it. The cycle touches the top
// there; each face is touched from a start stepped out nominal half-size + tip
// radius + clearance from the middle, after a guarded descent to top - depth;
// every move between faces runs at top + clearance - the top it touched, never
// a height taken from the start Z. Until 2026-09-27 the start was outside the X
// max face at probing depth and each cross-over ran at start Z + 10 (WO-2035
// raised it to clear the top), which a low start drove through the boss.
//
// The native route (UccncController over the fake bridge board, with a round
// boss and a rect boss) is pinned in probingRunThrough.wo2034.test.ts. This
// file pins the planner's contract, and that the beside-the-face plan (the
// pendant, and a text route with no G38.3) keeps WO-2035's cross-over.

import { describe, expect, it } from 'vitest'
import { planFeatureProbeCycle, type ProbeCycleTouchStep } from '../../lib/machine/probeFeatureCycle'
import { DEFAULT_ZPROBE_CONFIG, resolveProbeConfig } from '../../lib/machine/toolTable'
import { deriveMachineEnvelopeFromConvention } from '../../lib/machine/machineEnvelope'

type PlanInput = Parameters<typeof planFeatureProbeCycle>[0]

const CONFIG = resolveProbeConfig(null, DEFAULT_ZPROBE_CONFIG)
const TIP_R = 1.5
/** X 0..738, Y 0..724.5, Z 0..128.9 (the run-through's envelope). */
const ENVELOPE = deriveMachineEnvelopeFromConvention(
  {
    x: { homesToward: 'min', machineZeroAt: 'min' },
    y: { homesToward: 'min', machineZeroAt: 'min' },
    z: { homesToward: 'min', machineZeroAt: 'min' },
  },
  { x: 738, y: 724.5, z: 128.9 },
)
const MIDDLE = { x: 500, y: 150, z: 35 }

function planned(input: Partial<PlanInput> & Pick<PlanInput, 'kind'>) {
  const result = planFeatureProbeCycle({
    start: MIDDLE,
    envelope: ENVELOPE,
    config: CONFIG,
    tipRadiusMm: TIP_R,
    nominalSizeXmm: 25,
    nominalSizeYmm: 25,
    ...input,
  } as PlanInput)
  if (!result.ok) throw new Error(result.reason)
  return result.plan
}

const touches = (plan: ReturnType<typeof planned>) =>
  plan.steps.filter((s): s is ProbeCycleTouchStep => s.kind === 'touch')

describe('WO-2058 planner: Boss and Rect boss start over the middle and work from the top', () => {
  for (const kind of ['boss', 'rectBoss'] as const) {
    it(`${kind}: touches the top where it stands, then each face from nominal radius + tip + clearance out, from the top`, () => {
      const plan = planned({ kind })
      expect(plan.fromTop).toMatchObject({
        topTouch: { label: 'Touch the top', at: MIDDLE, travelMm: CONFIG.maxTravel },
        clearanceMm: 5,
        depthMm: 5,
        stepOutMm: 19, // 12.5 + 1.5 + 5
      })
      expect(plan.expectedCenter).toEqual(MIDDLE)
      // X- first from the X+ side, X+ from the X- side, then Y the same way.
      expect(touches(plan).map((t) => [t.key, t.axis, t.direction, t.expectedStart.x, t.expectedStart.y, t.descendFromTop])).toEqual([
        ['xNegative', 'X', '-', 519, 150, true],
        ['xPositive', 'X', '+', 481, 150, true],
        ['yNegative', 'Y', '-', 500, 169, true],
        ['yPositive', 'Y', '+', 500, 131, true],
      ])
      // The search reaches the stand-off plus overtravel past where the face should be (WO-2036).
      expect(touches(plan).every((t) => t.travelMm === CONFIG.surfaceClearance + CONFIG.overtravel)).toBe(true)
      // Nothing moves Z by a planned height: every height comes from the touched top.
      const positions = plan.steps.filter((s) => s.kind === 'position')
      expect(positions).toEqual([
        { kind: 'position', label: 'Finish above nominal boss center', target: MIDDLE, axes: ['X', 'Y'] },
      ])
      expect(plan.review.clearMotion).toEqual({ kind: 'boss-from-top', center: MIDDLE, clearanceMm: 5, depthMm: 5 })
      expect(plan.review.touchOrder.map((t) => t.key)).toEqual(['xNegative', 'xPositive', 'yNegative', 'yPositive'])
    })
  }

  it('Rect boss steps out by each axis\'s own half-size', () => {
    const plan = planned({ kind: 'rectBoss', nominalSizeXmm: 40, nominalSizeYmm: 20 })
    expect(touches(plan).map((t) => [t.expectedStart.x, t.expectedStart.y])).toEqual([
      [526.5, 150], // 20 + 1.5 + 5
      [473.5, 150],
      [500, 166.5], // 10 + 1.5 + 5
      [500, 133.5],
    ])
  })

  it('the start height changes nothing but the top touch: the same steps from 2 mm or 90 mm above the top', () => {
    const low = planned({ kind: 'boss', start: { ...MIDDLE, z: 22 } })
    const high = planned({ kind: 'boss', start: { ...MIDDLE, z: 110 } })
    const xy = (plan: ReturnType<typeof planned>) => plan.steps.map((s) =>
      s.kind === 'touch' ? [s.key, s.expectedStart.x, s.expectedStart.y] : s.kind === 'position' ? [s.label, s.target.x, s.target.y] : [s.kind])
    expect(xy(low)).toEqual(xy(high))
    expect({ ...low.fromTop, topTouch: null, besideTheFace: null }).toEqual({ ...high.fromTop, topTouch: null, besideTheFace: null })
  })

  it('the probing depth comes from the caller; no depth refusal (Operator 2026-09-27)', () => {
    expect(planned({ kind: 'boss', depthBelowTopMm: 3 }).fromTop).toMatchObject({ depthMm: 3, clearanceMm: 5 })
    expect(planned({ kind: 'boss', depthBelowTopMm: 3 }).summary).toContain('top - 3 mm')
  })

  it('a step-out outside the machine is still refused before anything moves', () => {
    const result = planFeatureProbeCycle({
      kind: 'boss',
      start: { x: 730, y: 150, z: 35 },
      envelope: ENVELOPE,
      config: CONFIG,
      tipRadiusMm: TIP_R,
      nominalSizeXmm: 25,
      nominalSizeYmm: 25,
    })
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.reason).toContain('machine envelope')
  })
})

describe('WO-2058: the beside-the-face boss plan keeps WO-2035\'s cross-over (the pendant; a text route with no G38.3)', () => {
  // The pendant's screen still says start outside the X max face at probing
  // depth, so it plans with approachFromTop: false.
  const TOP = 20
  const outside = (z: number) => ({ x: 500 + 12.5 + TIP_R + 5, y: 150, z })
  const crossHeights = (plan: ReturnType<typeof planned>) => [...new Set(plan.steps
    .filter((s) => s.kind === 'position' && s.axes.includes('X'))
    .map((s) => (s.kind === 'position' ? s.target.z : NaN)))]

  for (const below of [15, 2]) {
    it(`started ${below} mm below the top, it crosses above the top: at the known top + 5, else the declared Safe Z`, () => {
      for (const kind of ['boss', 'rectBoss'] as const) {
        const known = planned({ kind, start: outside(TOP - below), approachFromTop: false, bossTopMachineZMm: TOP })
        expect(known.fromTop ?? null).toBeNull()
        expect(crossHeights(known)[0]).toBeGreaterThanOrEqual(TOP + 5)
        const safe = planned({ kind, start: outside(TOP - below), approachFromTop: false, safeZMachineMm: 120 })
        expect(crossHeights(safe)).toEqual([120])
      }
    })
  }

  it('the over-the-middle plan carries it as its fallback, planned from the same start', () => {
    const plan = planned({ kind: 'boss', safeZMachineMm: 120 })
    const beside = planFeatureProbeCycle({
      start: MIDDLE,
      envelope: ENVELOPE,
      config: CONFIG,
      tipRadiusMm: TIP_R,
      nominalSizeXmm: 25,
      nominalSizeYmm: 25,
      kind: 'boss',
      safeZMachineMm: 120,
      approachFromTop: false,
    })
    expect(plan.fromTop?.besideTheFace).toEqual(beside)
  })
})
