// WO-2056 - OUTSIDE CORNER GOES AROUND THE CORNER (docs/design/PROBING-PAINT-BY-NUMBERS.md 4.2).
//
// Until 2026-09-27 the Outside corner plan touched both faces from the same
// point, so it could only land both walls from one exact diagonal. It now
// starts over the stock near the corner, touches the top, and gives each face
// its own step-out: X face, back over the start at safe height, Y face. The
// motion itself is pinned on the fake board in probingRunThrough.wo2034.test.ts;
// this file pins the planner's contract that the runner and the screen read.

import { describe, expect, it } from 'vitest'
import { deriveMachineEnvelopeFromConvention } from '../../lib/machine/machineEnvelope'
import {
  planFeatureProbeCycle,
  type PlanFeatureProbeCycleInput,
  type ProbeCycleTouchStep,
} from '../../lib/machine/probeFeatureCycle'
import { DEFAULT_ZPROBE_CONFIG, resolveProbeConfig } from '../../lib/machine/toolTable'

const CONFIG = resolveProbeConfig(null, DEFAULT_ZPROBE_CONFIG)
const envelope = deriveMachineEnvelopeFromConvention(
  {
    x: { homesToward: 'min', machineZeroAt: 'min' },
    y: { homesToward: 'min', machineZeroAt: 'min' },
    z: { homesToward: 'min', machineZeroAt: 'min' },
  },
  { x: 738, y: 724.5, z: 128.9 },
)
const START = { x: 205, y: 207, z: 40 }

function plan(input: Partial<PlanFeatureProbeCycleInput> & Pick<PlanFeatureProbeCycleInput, 'kind'>) {
  const planned = planFeatureProbeCycle({
    start: START,
    envelope,
    config: CONFIG,
    tipRadiusMm: 1.5,
    cornerXDirection: '+',
    cornerYDirection: '+',
    ...input,
  })
  if (!planned.ok) throw new Error(planned.reason)
  return planned.plan
}

const touches = (steps: ReturnType<typeof plan>['steps']) =>
  steps.filter((step): step is ProbeCycleTouchStep => step.kind === 'touch')

describe('WO-2056 Outside corner: two step-outs from one start over the stock', () => {
  it('front-left (X+ Y+): top touch, X face from 16.5 mm left, back over the start, Y face from 16.5 mm in front', () => {
    const outside = plan({ kind: 'outsideCorner' })
    expect(outside.fromTop).toMatchObject({
      topTouch: { label: 'Touch the top', at: START, travelMm: CONFIG.maxTravel },
      clearanceMm: 5,
      depthMm: 5,
      stepOutMm: 16.5, // start distance 10 + tip 1.5 + clearance 5
    })
    expect(outside.steps).toEqual([
      expect.objectContaining({
        kind: 'touch', key: 'cornerX', axis: 'X', direction: '+', descendFromTop: true,
        expectedStart: { x: 188.5, y: 207, z: 40 },
      }),
      { kind: 'position', label: 'Go back over the stock to the start', target: START, axes: ['X', 'Y'] },
      expect.objectContaining({
        kind: 'touch', key: 'cornerY', axis: 'Y', direction: '+', descendFromTop: true,
        expectedStart: { x: 205, y: 190.5, z: 40 },
      }),
    ])
    // WO-2569: each face gets one seek with the protected expected-face bound.
    expect(touches(outside.steps).map((step) => step.travelMm)).toEqual([20, 20])
    expect(outside.searchTravelMm).toBe(20)
    expect(outside.review.touchOrder).toEqual([
      { key: 'cornerX', axis: 'X', direction: '+' },
      { key: 'cornerY', axis: 'Y', direction: '+' },
    ])
    expect(outside.summary).toMatch(/^Touches the top, rises to top \+ 5 mm, steps out 16\.5 mm .* one bounded touch per face, going back over the start at safe height between them\.$/)
  })

  it('back-right (X- Y-): each step-out goes the other way, past its own face', () => {
    const outside = plan({ kind: 'outsideCorner', cornerXDirection: '-', cornerYDirection: '-', start: { x: 395, y: 345, z: 40 } })
    expect(touches(outside.steps).map((step) => [step.key, step.direction, step.expectedStart])).toEqual([
      ['cornerX', '-', { x: 411.5, y: 345, z: 40 }],
      ['cornerY', '-', { x: 395, y: 361.5, z: 40 }],
    ])
  })

  // Audit 2026-09-27: the fallback used to touch both faces from the start, so
  // the route without G38.3 could not go around the corner. It now goes around
  // at the height where the probe stands (run on the fake board in
  // probingRunThrough.wo2034.test.ts).
  it('carries a beside-the-faces plan that also goes around the corner, at the start height, for a route that cannot guard the descent', () => {
    const outside = plan({ kind: 'outsideCorner' })
    const beside = outside.fromTop!.besideTheFace
    expect(beside.ok).toBe(true)
    if (!beside.ok) return
    expect(beside.plan).toEqual(plan({ kind: 'outsideCorner', approachFromTop: false }))
    expect(beside.plan.fromTop).toBeNull()
    // Around = search 10 + tip 1.5 + clearance 5 past the other face.
    expect(beside.plan.steps).toEqual([
      { kind: 'position', label: 'Go around beside the X face', target: { x: 205, y: 223.5, z: 40 }, axes: ['Y'] },
      expect.objectContaining({ kind: 'touch', key: 'cornerX', axis: 'X', direction: '+', travelMm: 10, expectedStart: { x: 205, y: 223.5, z: 40 } }),
      { kind: 'position', label: 'Go back around to the start', target: START, axes: ['X', 'Y'] },
      { kind: 'position', label: 'Go around beside the Y face', target: { x: 221.5, y: 207, z: 40 }, axes: ['X'] },
      expect.objectContaining({ kind: 'touch', key: 'cornerY', axis: 'Y', direction: '+', travelMm: 10, expectedStart: { x: 221.5, y: 207, z: 40 } }),
    ])
    for (const step of touches(beside.plan.steps)) expect(step.descendFromTop).toBeUndefined()
    // The two touches never share a start: that was the defect.
    const [x, y] = touches(beside.plan.steps)
    expect(x.expectedStart).not.toEqual(y.expectedStart)
    expect(beside.plan.summary).toBe('Goes around the corner at the height where the probe stands: one bounded touch per face, going back to the start between them.')
  })

  it('beside the faces, back-right (X- Y-): each way around goes the other way', () => {
    const planned = plan({ kind: 'outsideCorner', approachFromTop: false, cornerXDirection: '-', cornerYDirection: '-', start: { x: 395, y: 345, z: 40 } })
    expect(touches(planned.steps).map((step) => [step.key, step.expectedStart])).toEqual([
      ['cornerX', { x: 395, y: 328.5, z: 40 }],
      ['cornerY', { x: 378.5, y: 345, z: 40 }],
    ])
  })

  // WO-2057: Inside corner now descends from its top first (pinned in
  // holeDescentFromTop.wo2057). WO-2554 widens its seeks to Maximum search;
  // the pendant's generic corner keeps the clearance + overtravel bound.
  it('Inside corner and pendant corner seek from where the probe stands, with their respective bounds and no top', () => {
    for (const kind of ['insideCorner', 'corner'] as const) {
      const planned = plan({ kind, cornerXDirection: '-', cornerYDirection: '-', approachFromTop: false })
      expect(planned.fromTop, kind).toBeNull()
      expect(planned.steps.map((step) => step.kind), kind).toEqual(['touch', 'touch'])
      for (const step of touches(planned.steps)) {
        expect(step.expectedStart, kind).toEqual(START)
        expect(step.descendFromTop, kind).toBeUndefined()
        expect(step.travelMm, kind).toBe(kind === 'insideCorner' ? CONFIG.maxTravel : 10)
      }
      expect(planned.summary, kind).toBe('Two bounded touches; retract 2 mm before changing axis.')
    }
  })

  it('a step-out past the machine envelope is named before anything moves', () => {
    const planned = planFeatureProbeCycle({
      kind: 'outsideCorner',
      start: { x: 8, y: 207, z: 40 },
      envelope,
      config: CONFIG,
      tipRadiusMm: 1.5,
      cornerXDirection: '+',
      cornerYDirection: '+',
    })
    expect(planned).toEqual({
      ok: false,
      reason: 'Probe corner X face: Planned X -8.5 is outside the machine envelope 0 to 738.',
    })
  })
})
