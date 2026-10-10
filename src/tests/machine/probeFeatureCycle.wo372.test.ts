import { describe, expect, it } from 'vitest'
import { deriveMachineEnvelopeFromConvention } from '../../lib/machine/machineEnvelope'
import {
  planFeatureProbeCycle,
  type ProbeCyclePositionStep,
  type ProbeCycleStep,
  type ProbeCycleTouchStep,
} from '../../lib/machine/probeFeatureCycle'
import { resolveProbeConfig } from '../../lib/machine/toolTable'

const envelope = deriveMachineEnvelopeFromConvention(
  {
    x: { homesToward: 'min', machineZeroAt: 'min' },
    y: { homesToward: 'min', machineZeroAt: 'min' },
    z: { homesToward: 'min', machineZeroAt: 'min' },
  },
  { x: 300, y: 300, z: 100 },
)

const config = resolveProbeConfig(null, {
  positioningFeed: 1200,
  fastFeed: 300,
  slowFeed: 40,
  retract: 2,
  maxTravel: 30,
  surfaceClearance: 5,
  overtravel: 5,
  crossOverLift: 10,
  padThickness: 10,
})

function positions(plan: { steps: ProbeCycleStep[] }) {
  return plan.steps.filter((step): step is ProbeCyclePositionStep => step.kind === 'position')
}

function touches(plan: { steps: ProbeCycleStep[] }) {
  return plan.steps.filter((step): step is ProbeCycleTouchStep => step.kind === 'touch')
}

describe('WO-372 feature-aware probe cycle planning', () => {
  it('plans a bore from nominal center with bounded searches and clear center returns', () => {
    const result = planFeatureProbeCycle({
      kind: 'bore',
      start: { x: 100, y: 100, z: 20 },
      envelope,
      config,
      tipRadiusMm: 1.5,
      nominalSizeXmm: 40,
      nominalSizeYmm: 30,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.expectedCenter).toEqual({ x: 100, y: 100, z: 20 })
    expect(touches(result.plan)).toEqual([
      expect.objectContaining({ key: 'xNegative', axis: 'X', direction: '-', travelMm: 30 }),
      expect.objectContaining({ key: 'xPositive', axis: 'X', direction: '+', travelMm: 30 }),
      expect.objectContaining({ key: 'yNegative', axis: 'Y', direction: '-', travelMm: 30 }),
      expect.objectContaining({ key: 'yPositive', axis: 'Y', direction: '+', travelMm: 30 }),
    ])
    // Each touch parks on the NEAR side of the wall it probes (fixed 2026-08-20: the
    // boss rule had been applied to the bore, parking every touch on the far wall).
    const starts = touches(result.plan).map((t) => [t.key, t.expectedStart.x, t.expectedStart.y])
    expect(starts).toEqual([
      ['xNegative', 100, 100],
      ['xPositive', 100, 100],
      ['yNegative', 100, 100],
      ['yPositive', 100, 100],
    ])
    expect(positions(result.plan).map((step) => step.target)).toContainEqual({ x: 100, y: 100, z: 20 })
    expect(positions(result.plan).map((step) => step.target)).toContainEqual({ x: 100, y: 100, z: 20 })
    expect(positions(result.plan).at(-1)?.target).toEqual({ x: 100, y: 100, z: 20 })
    expect(result.plan.review).toEqual({
      touchOrder: [
        { key: 'xNegative', axis: 'X', direction: '-' },
        { key: 'xPositive', axis: 'X', direction: '+' },
        { key: 'yNegative', axis: 'Y', direction: '-' },
        { key: 'yPositive', axis: 'Y', direction: '+' },
      ],
      approachClearanceMm: 5,
      positioningFeedMmMin: 1200,
      searchFeedMmMin: 300,
      probeFeedMmMin: 40,
      clearMotion: { kind: 'bore-center', center: { x: 100, y: 100, z: 20 } },
    })
  })

  it('plans a boss from the outside X-max start and lifts before every cross-over', () => {
    const result = planFeatureProbeCycle({
      kind: 'boss',
      start: { x: 126.5, y: 100, z: 20 },
      envelope,
      config,
      tipRadiusMm: 1.5,
      nominalSizeXmm: 40,
      nominalSizeYmm: 30,
      // WO-2035: the top 5 mm above the start keeps the start + lift crossing.
      bossTopMachineZMm: 25,
      // WO-2058: the beside-the-face plan (the pendant's). The Probing panel's
      // boss starts over the middle: bossStartOverMiddle.wo2058.test.ts.
      approachFromTop: false,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.expectedCenter).toEqual({ x: 100, y: 100, z: 20 })
    const moves = positions(result.plan)
    const loweredMoves = moves.filter((step) => step.target.z === 20)
    expect(loweredMoves).toHaveLength(3)
    expect(moves.filter((step) => step.target.z === 30).length).toBeGreaterThanOrEqual(4)
    expect(moves.at(-1)?.target).toEqual({ x: 100, y: 100, z: 30 })
    expect(touches(result.plan)).toHaveLength(4)
    expect(result.plan.review.clearMotion).toEqual({
      kind: 'boss-cross-over',
      center: { x: 100, y: 100, z: 20 },
      liftMm: 10,
      crossOverZMm: 30,
    })
  })

  it('uses retract as the step-off between the two corner touches', () => {
    const result = planFeatureProbeCycle({
      kind: 'corner',
      start: { x: 100, y: 100, z: 20 },
      envelope,
      config,
      tipRadiusMm: 1.5,
      cornerXDirection: '-',
      cornerYDirection: '+',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.stepOffMm).toBe(2)
    expect(positions(result.plan)).toHaveLength(0)
    expect(touches(result.plan).map((step) => [step.axis, step.direction])).toEqual([
      ['X', '-'],
      ['Y', '+'],
    ])
  })

  it('keeps an edge as one bounded touch', () => {
    const result = planFeatureProbeCycle({
      kind: 'edge',
      start: { x: 100, y: 100, z: 20 },
      envelope,
      config,
      tipRadiusMm: 1.5,
      edgeAxis: 'Y',
      edgeDirection: '-',
      // WO-2055: the from-top Edge is pinned in edgeAngleFromTop.wo2055.
      approachFromTop: false,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // WO-2569: the one seek retains the expected-face distance plus overtravel.
    expect(touches(result.plan)).toEqual([
      expect.objectContaining({ key: 'edge', axis: 'Y', direction: '-', travelMm: 10 }),
    ])
  })

  // WO-2265 (Operator 2026-09-30): the approach clearance no longer refuses a bore.
  // A 10 mm side with a 1.5 mm tip and Clearance 5 probes from the middle; its
  // search ends at the nominal wall (5 - 1.5) + overtravel 5. Only a bore not
  // larger than the tip still stops, naming the numbers and the field.
  it('probes a bore narrower than tip + clearance from the middle; refuses only one the tip does not fit', () => {
    const result = planFeatureProbeCycle({
      kind: 'bore',
      start: { x: 100, y: 100, z: 20 },
      envelope,
      config,
      tipRadiusMm: 1.5,
      nominalSizeXmm: 10,
      nominalSizeYmm: 30,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(touches(result.plan).map((t) => [t.axis, t.travelMm])).toEqual([
      ['X', 30], ['X', 30], ['Y', 30], ['Y', 30],
    ])

    const tooSmall = planFeatureProbeCycle({
      kind: 'bore',
      start: { x: 100, y: 100, z: 20 },
      envelope,
      config,
      tipRadiusMm: 1.5,
      nominalSizeXmm: 2.5,
      nominalSizeYmm: 30,
    })
    expect(tooSmall).toEqual({
      ok: false,
      reason: 'Nominal diameter 2.5 mm is not larger than the probe tip (radius 1.5 mm, 3 mm across) - check Nominal diameter or Tip radius.',
    })
  })

  it('refuses feature search allowance beyond the configured maximum travel', () => {
    const result = planFeatureProbeCycle({
      kind: 'bore',
      start: { x: 100, y: 100, z: 20 },
      envelope,
      config: { ...config, maxTravel: 9 },
      tipRadiusMm: 1.5,
      nominalSizeXmm: 40,
      nominalSizeYmm: 40,
    })
    expect(result).toEqual(expect.objectContaining({ ok: false }))
    if (!result.ok) expect(result.reason).toContain('maximum travel')
  })

  it('refuses any planned positioning or search endpoint outside the machine envelope', () => {
    const result = planFeatureProbeCycle({
      kind: 'boss',
      start: { x: 296.5, y: 150, z: 95 },
      envelope,
      config,
      tipRadiusMm: 1.5,
      nominalSizeXmm: 40,
      nominalSizeYmm: 30,
    })
    expect(result).toEqual(expect.objectContaining({ ok: false }))
    if (!result.ok) expect(result.reason).toContain('machine envelope')
  })

  it('refuses automatic planning when any axis envelope is unknown', () => {
    const result = planFeatureProbeCycle({
      kind: 'edge',
      start: { x: 100, y: 100, z: 20 },
      envelope: { ...envelope, y: null },
      config,
      tipRadiusMm: 1.5,
      edgeAxis: 'X',
      edgeDirection: '+',
    })
    expect(result).toEqual(expect.objectContaining({ ok: false }))
    if (!result.ok) expect(result.reason).toContain('complete machine envelope')
  })

  it('reuses the proven inside and outside four-side paths for rectangular features', () => {
    const pocket = planFeatureProbeCycle({
      kind: 'rectPocket',
      start: { x: 100, y: 100, z: 20 },
      envelope,
      config,
      tipRadiusMm: 1.5,
      nominalSizeXmm: 40,
      nominalSizeYmm: 30,
    })
    const boss = planFeatureProbeCycle({
      kind: 'rectBoss',
      start: { x: 126.5, y: 100, z: 20 },
      envelope,
      config,
      tipRadiusMm: 1.5,
      nominalSizeXmm: 40,
      nominalSizeYmm: 30,
      approachFromTop: false, // WO-2058: the beside-the-face plan
    })

    expect(pocket.ok && pocket.plan.review.clearMotion.kind).toBe('bore-center')
    expect(boss.ok && boss.plan.review.clearMotion.kind).toBe('boss-cross-over')
    if (pocket.ok) expect(touches(pocket.plan)).toHaveLength(4)
    if (boss.ok) expect(touches(boss.plan)).toHaveLength(4)
  })

  it('plans a bounded two-point angle cycle at an exact along-face spacing', () => {
    const result = planFeatureProbeCycle({
      kind: 'angle',
      start: { x: 100, y: 100, z: 20 },
      envelope,
      config,
      tipRadiusMm: 1.5,
      angleNominalAxis: 'X',
      angleProbeDirection: '-',
      angleAlongDirection: '+',
      angleSpacingMm: 35,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(touches(result.plan)).toEqual([
      expect.objectContaining({ key: 'angleFirst', axis: 'Y', direction: '-' }),
      expect.objectContaining({ key: 'angleSecond', axis: 'Y', direction: '-' }),
    ])
    expect(positions(result.plan)).toEqual([
      expect.objectContaining({ axes: ['X'], target: { x: 135, y: 100, z: 20 } }),
    ])
    expect(result.plan.review.clearMotion).toEqual({
      kind: 'angle-two-point',
      nominalAxis: 'X',
      spacingMm: 35,
    })
  })

  it('refuses an angle second point outside the machine envelope', () => {
    const result = planFeatureProbeCycle({
      kind: 'angle',
      start: { x: 290, y: 100, z: 20 },
      envelope,
      config,
      tipRadiusMm: 1.5,
      angleNominalAxis: 'X',
      angleProbeDirection: '-',
      angleAlongDirection: '+',
      angleSpacingMm: 35,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('machine envelope')
  })
})
