// WO-2265: a bore started roughly in the middle with a nominal size probes
// whatever the Clearance setting says (Operator 2026-09-30 at the machine, finding
// C-1: Bore 12.5 mm, tip radius 1.5, Clearance 5 refused with "The bore is too
// small for the probe tip plus the requested surface clearance."). The search
// still ends overtravel past the nominal wall and no further (WO-2036). Bores
// main already probes plan byte-identical moves (src/tests/evidence/WO-2265/
// plans.main.json, written from main's probeFeatureCycle.ts with
// WO2265_WRITE_MAIN=1).

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { calibrationFeatureKind } from '../../lib/machine/probeCalibration'
import { deriveMachineEnvelopeFromConvention } from '../../lib/machine/machineEnvelope'
import {
  planFeatureProbeCycle,
  type PlanFeatureProbeCycleInput,
  type ProbeCycleTouchStep,
} from '../../lib/machine/probeFeatureCycle'
import {
  describeExpandedRoutine,
  expandProbeRoutine,
  listExpandedSteps,
  type ExpandedTouchStep,
} from '../../lib/machine/probeRoutineExpand'
import { FACTORY_BORE_CENTRE } from '../../lib/machine/probeRoutineFactory'
import { resolveProbeConfig } from '../../lib/machine/toolTable'

const envelope = deriveMachineEnvelopeFromConvention(
  {
    x: { homesToward: 'min', machineZeroAt: 'min' },
    y: { homesToward: 'min', machineZeroAt: 'min' },
    z: { homesToward: 'min', machineZeroAt: 'min' },
  },
  { x: 300, y: 300, z: 100 },
)
// The shipped defaults: Clearance 5, overtravel 5, maximum travel 50.
const config = resolveProbeConfig(null, null)
const start = { x: 150, y: 150, z: 60 }
const TIP = 1.5
const OVERTRAVEL = config.overtravel

/** The inputs the Probing screen passes (ProbingPanel.tsx guidedPlan). */
function screenInput(
  kind: PlanFeatureProbeCycleInput['kind'],
  sizeX: number,
  sizeY: number,
  extra: Partial<PlanFeatureProbeCycleInput> = {},
): PlanFeatureProbeCycleInput {
  return {
    kind,
    start,
    envelope,
    config,
    tipRadiusMm: TIP,
    nominalSizeXmm: sizeX,
    nominalSizeYmm: sizeY,
    depthBelowTopMm: 5,
    topSearchMm: 20,
    safeZMachineMm: null,
    ...extra,
  }
}

function touchesOf(input: PlanFeatureProbeCycleInput): ProbeCycleTouchStep[] {
  const planned = planFeatureProbeCycle(input)
  if (!planned.ok) throw new Error(planned.reason)
  return planned.plan.steps.filter((s): s is ProbeCycleTouchStep => s.kind === 'touch')
}

/** Where a touch's search ends, measured from the start along its axis. */
function reachFromStart(t: ProbeCycleTouchStep): number {
  const key = t.axis === 'X' ? 'x' : 'y'
  const sign = t.direction === '+' ? 1 : -1
  return Number(((t.expectedStart[key] + sign * t.travelMm) - start[key]).toFixed(4)) * sign
}

describe('WO-2265: Bore 12.5 / tip 1.5 / Clearance 5 probes from the middle', () => {
  it('the Probing screen plan is ok and each of four touches uses maximum search independent of nominal size (WO-2554)', () => {
    const touches = touchesOf(screenInput('bore', 12.5, 12.5))
    expect(touches.map((t) => [t.axis, t.direction])).toEqual([['X', '-'], ['X', '+'], ['Y', '-'], ['Y', '+']])
    for (const t of touches) {
      // touched from where he stands - the middle
      expect([t.expectedStart.x, t.expectedStart.y]).toEqual([start.x, start.y])
      expect(t.travelMm).toBe(config.maxTravel)
      expect(reachFromStart(t)).toBe(config.maxTravel)
    }
  })

  it('the plan the screen draws starts with the descent at the middle and ends with the rise', () => {
    const planned = planFeatureProbeCycle(screenInput('bore', 12.5, 12.5))
    if (!planned.ok) throw new Error(planned.reason)
    expect(planned.plan.steps[0]).toMatchObject({ kind: 'descend', target: start })
    expect(planned.plan.steps.at(-1)).toMatchObject({ kind: 'rise' })
    expect(planned.plan.expectedCenter).toEqual(start)
  })

  it('Rect pocket 12.5 x 12.5 (motionKind bore) probes the same way', () => {
    for (const t of touchesOf(screenInput('rectPocket', 12.5, 12.5))) {
      expect([t.expectedStart.x, t.expectedStart.y]).toEqual([start.x, start.y])
      expect(reachFromStart(t)).toBe(config.maxTravel)
    }
  })

  it('Rect pocket 12.5 x 40: the narrow walls from the middle, all walls sought from the starting line (WO-2554)', () => {
    const [xm, xp, ym, yp] = touchesOf(screenInput('rectPocket', 12.5, 40))
    expect([xm.expectedStart.x, xp.expectedStart.x]).toEqual([start.x, start.x])
    expect([reachFromStart(xm), reachFromStart(xp)]).toEqual([config.maxTravel, config.maxTravel])
    expect([ym.expectedStart.y, yp.expectedStart.y]).toEqual([start.y, start.y])
    expect([ym.travelMm, yp.travelMm]).toEqual([config.maxTravel, config.maxTravel])
    expect([reachFromStart(ym), reachFromStart(yp)]).toEqual([config.maxTravel, config.maxTravel])
  })

  it('Calibrate on an inside reference (its feature kind is bore) probes a 12.5 mm ring', () => {
    expect(calibrationFeatureKind('inside')).toBe('bore')
    for (const t of touchesOf(screenInput(calibrationFeatureKind('inside'), 12.5, 12.5))) {
      expect(reachFromStart(t)).toBe(config.maxTravel)
    }
  })

  it('whatever Clearance says (1, 4.75, 5, 20, 45), the 12.5 mm bore probes; maximum search is independent of Clearance (WO-2554)', () => {
    for (const surfaceClearance of [1, 4.75, 5, 20, 45]) {
      const cfg = { ...config, surfaceClearance }
      const touches = touchesOf({ ...screenInput('bore', 12.5, 12.5), config: cfg })
      for (const t of touches) expect(reachFromStart(t)).toBe(config.maxTravel)
    }
  })

  it('the factory Bore centre routine expands 12.5 mm and each touch uses maximum search from the starting line (WO-2554)', () => {
    const result = expandProbeRoutine(FACTORY_BORE_CENTRE, { diameter: 12.5, topZ: 40 }, { start, envelope, probe: config, tipRadiusMm: TIP })
    if (!result.ok) throw new Error(result.errors.map((e) => e.sentence).join('\n'))
    const touches = listExpandedSteps(result.expanded.steps).filter((s): s is ExpandedTouchStep => s.kind === 'touch')
    expect(touches).toHaveLength(4)
    for (const t of touches) {
      const key = t.axis === 'X' ? 'x' : 'y'
      const sign = t.direction === '+' ? 1 : -1
      expect(Number(((t.farEnd[key] - start[key]) * sign).toFixed(4))).toBe(config.maxTravel)
      expect(Number(((t.nominalContact[key] - start[key]) * sign).toFixed(4))).toBe(config.maxTravel - OVERTRAVEL)
      // its start (Clearance in from the wall) is inside the hole: 0.25 mm past the middle
      expect(Number(((t.expectedStart[key] - start[key]) * sign).toFixed(4))).toBe(0)
    }
  })
})

describe('WO-2265: the one refusal left - the tip does not fit', () => {
  it('Bore names the numbers and the field', () => {
    const planned = planFeatureProbeCycle(screenInput('bore', 2.5, 2.5))
    expect(planned.ok ? null : planned.reason).toBe(
      'Nominal diameter 2.5 mm is not larger than the probe tip (radius 1.5 mm, 3 mm across) - check Nominal diameter or Tip radius.',
    )
  })

  it('Rect pocket names the width that does not fit', () => {
    const planned = planFeatureProbeCycle(screenInput('rectPocket', 20, 3))
    expect(planned.ok ? null : planned.reason).toBe(
      'Width Y 3 mm is not larger than the probe tip (radius 1.5 mm, 3 mm across) - check Width Y or Tip radius.',
    )
  })

  it('a bore just wider than the tip probes (no clearance refusal)', () => {
    for (const t of touchesOf(screenInput('bore', 3.2, 3.2))) expect(reachFromStart(t)).toBe(config.maxTravel)
  })
})

// --- byte-identical for bores main already probes ---------------------------------

const MAIN_FILE = join(process.cwd(), 'src', 'tests', 'evidence', 'WO-2554', 'plans.repin.json')

function mainCases(): Record<string, unknown> {
  const plans: Record<string, unknown> = {}
  const cases: Array<[string, PlanFeatureProbeCycleInput]> = [
    ['bore 20 / 1.5 / 5 from the top', screenInput('bore', 20, 20)],
    ['bore 40 / 1.5 / 5 from the top', screenInput('bore', 40, 40)],
    ['bore 25.4 / 1.588 / 5 rim top', { ...screenInput('bore', 25.4, 25.4), tipRadiusMm: 1.588, rimTopMachineZMm: 40 }],
    ['bore 12.5 / 1.5 / 2 from the top', { ...screenInput('bore', 12.5, 12.5), config: { ...config, surfaceClearance: 2 } }],
    ['bore 20 / 1.5 / 5 beside the face', screenInput('bore', 20, 20, { approachFromTop: false })],
    ['rectPocket 20 x 40 from the top', screenInput('rectPocket', 20, 40)],
    ['rectPocket 40 x 30 beside the face', screenInput('rectPocket', 40, 30, { approachFromTop: false })],
    ['calibrate inside 25 / 1.5 / 5', screenInput(calibrationFeatureKind('inside'), 25, 25)],
    ['boss 20 / 1.5 / 5 from the top', screenInput('boss', 20, 20)],
    ['rectBoss 20 x 30 beside the face', screenInput('rectBoss', 20, 30, { approachFromTop: false })],
  ]
  for (const [name, input] of cases) plans[name] = planFeatureProbeCycle(input)
  for (const diameter of [20, 40]) {
    const result = expandProbeRoutine(FACTORY_BORE_CENTRE, { diameter, topZ: 40 }, { start, envelope, probe: config, tipRadiusMm: TIP })
    // Step 1 is the check whose wording this order changes; every move after it is pinned.
    plans[`factory Bore centre ${diameter}`] = result.ok ? describeExpandedRoutine(result.expanded).slice(1) : result.errors
  }
  return JSON.parse(JSON.stringify(plans)) as Record<string, unknown>
}

describe('WO-2554: seek-only repin (outside plans separately match main)', () => {
  it('every case matches the seek-only baseline (plans.repin.json)', () => {
    const mine = mainCases()
    if (process.env.WO2265_WRITE_MAIN === '1') writeFileSync(MAIN_FILE, `${JSON.stringify(mine, null, 2)}\n`)
    expect(existsSync(MAIN_FILE)).toBe(true)
    const main = JSON.parse(readFileSync(MAIN_FILE, 'utf8')) as Record<string, unknown>
    expect(Object.keys(main).sort()).toEqual(Object.keys(mine).sort())
    for (const name of Object.keys(main)) expect(mine[name], name).toEqual(main[name])
  })
})
