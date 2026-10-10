// WO-411 slice 2 - the expander, envelope + feed validation, preview model.
// Contract: docs/research/probe-routine-format.md sections 2.4, 2.7, 4, 6.
// Oracle: planFeatureProbeCycle (WO-372) - the data must say what the code says.

import { describe, expect, it } from 'vitest'
import { deriveMachineEnvelopeFromConvention, type MachineEnvelope } from '../../lib/machine/machineEnvelope'
import {
  planFeatureProbeCycle,
  type ProbeCyclePositionStep,
  type ProbeCycleTouchStep,
} from '../../lib/machine/probeFeatureCycle'
import {
  describeExpandedRoutine,
  describeExpandedStep,
  expandProbeRoutine,
  listExpandedSteps,
  pointOutsideEnvelope,
  type ExpandedMoveStep,
  type ExpandedStep,
  type ExpandedTouchStep,
  type ProbeRoutineExpandContext,
} from '../../lib/machine/probeRoutineExpand'
import {
  CONTRACT_INVALID_EXAMPLE_USER_BAD_SLOT,
  FACTORY_BORE_CENTRE,
  FACTORY_BOSS_CENTRE,
  FACTORY_CORNER_INSIDE_X_MINUS_Y_PLUS,
  FACTORY_CORNER_OUTSIDE_X_MINUS_Y_MINUS,
  FACTORY_EDGE_Y_MINUS,
  FACTORY_PROBE_ROUTINES,
  isFactoryHoleRoutineId,
} from '../../lib/machine/probeRoutineFactory'
import { validateProbeRoutine, type ProbeRoutine, type RoutineError } from '../../lib/machine/probeRoutineFormat'
import { resolveProbeConfig } from '../../lib/machine/toolTable'

// --- fixtures: the WO-372 planner's envelope / config / start -------------------

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

const TIP = 1.5

function ctxAt(start: { x: number; y: number; z: number }, extra: Partial<ProbeRoutineExpandContext> = {}): ProbeRoutineExpandContext {
  return { start, envelope, probe: config, tipRadiusMm: TIP, ...extra }
}

// Operator's machine (contract section 3.5): X runs -812.8 to 0, probe at X -400.
const sampleMachineEnvelope = deriveMachineEnvelopeFromConvention(
  {
    x: { homesToward: 'max', machineZeroAt: 'max' },
    y: { homesToward: 'max', machineZeroAt: 'max' },
    z: { homesToward: 'max', machineZeroAt: 'max' },
  },
  { x: 812.8, y: 724.5, z: 128.9 },
)
const sampleMachineConfig = resolveProbeConfig(null, null) // 1000 / 400 / 50, retract 2, maxTravel 50
const sampleMachineCtx: ProbeRoutineExpandContext = {
  start: { x: -400, y: -300, z: -50 },
  envelope: sampleMachineEnvelope,
  probe: sampleMachineConfig,
  tipRadiusMm: 1,
}

function motion(steps: readonly ExpandedStep[]): Array<ExpandedMoveStep | ExpandedTouchStep> {
  return listExpandedSteps(steps).filter(
    (s): s is ExpandedMoveStep | ExpandedTouchStep => s.kind === 'move' || s.kind === 'touch',
  )
}

function codes(errors: readonly RoutineError[]): string[] {
  return errors.map((e) => e.code)
}

function routine(overrides: Partial<ProbeRoutine> & { steps: ProbeRoutine['steps'] }): ProbeRoutine {
  return {
    schemaVersion: 1,
    id: 'user.test',
    name: 'Test',
    version: '0.1.0',
    provenance: { kind: 'user' },
    description: 'test',
    requires: { homed: true, envelope: 'full', probe: 'touch' },
    inputs: [],
    outputs: [],
    ...overrides,
  }
}

/** Every hand-written routine in this file must also pass the static validator
 *  (so the expander is never exercised on something slice 1 would refuse,
 *  except where a test says so). */
function valid(r: ProbeRoutine): ProbeRoutine {
  const v = validateProbeRoutine(r)
  if (!v.ok) throw new Error(`fixture does not validate: ${v.errors.map((e) => e.sentence).join(' | ')}`)
  return r
}

// ---------------------------------------------------------------------------

/** The motion the run takes: a branch contributes the arm its condition picks. */
function takenMotion(steps: readonly ExpandedStep[]): Array<ExpandedMoveStep | ExpandedTouchStep> {
  return steps.flatMap((s): Array<ExpandedMoveStep | ExpandedTouchStep> => {
    if (s.kind === 'branch') return takenMotion(s[s.nominalArm])
    return s.kind === 'move' || s.kind === 'touch' ? [s] : []
  })
}

// WO-2065: the oracle is the Probing panel's plan FROM THE TOP (WO-2055..2058)
// - the factory routines now take the same heights: a hole's top is work Z0 or
// the rim (here the rim, so the planner carries the number), the others touch
// the top where they start. The panel's cycle runs its rise / step-out /
// descent inside each touch; the routine spells them out as steps.

describe('WO-411 slice 2: the factory BORE routine against planFeatureProbeCycle (the oracle)', () => {
  const start = { x: 100, y: 100, z: 40 }
  const TOP = 25
  const oracle = planFeatureProbeCycle({ kind: 'bore', start, envelope, config, tipRadiusMm: TIP, nominalSizeXmm: 40, nominalSizeYmm: 40, rimTopMachineZMm: TOP })
  const result = expandProbeRoutine(FACTORY_BORE_CENTRE, { diameter: 40, topZ: TOP }, ctxAt(start))

  it('both expand clean, from the same top', () => {
    expect(oracle.ok).toBe(true)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.errors.map((e) => e.sentence).join('\n'))
    if (!oracle.ok) return
    expect(oracle.plan.fromTop?.knownTop).toEqual({ source: 'rim', machineZ: TOP })
  })

  it('the ORDERED motion has the same shape: descend, (touch, return) x 4, rise - same touch order, same search travel, same centre returns', () => {
    if (!oracle.ok || !result.ok) return
    const fromTop = oracle.plan.fromTop!
    const mine = takenMotion(result.expanded.steps)
    expect(mine).toHaveLength(oracle.plan.steps.length) // 14
    expect(mine.map((s) => s.kind)).toEqual(oracle.plan.steps.map((s) => (s.kind === 'touch' ? 'touch' : 'move')))
    // the way down is a probe move to top - depth; the way up is top + clearance
    const down = mine[0] as ExpandedMoveStep
    expect([down.stopOnContact, down.axes, down.target.z]).toEqual([true, ['Z'], TOP - fromTop.depthMm])
    expect((mine.at(-1) as ExpandedMoveStep).target.z).toBe(TOP + fromTop.clearanceMm)
    oracle.plan.steps.forEach((o, i) => {
      const m = mine[i]
      if (o.kind === 'touch' && m.kind === 'touch') {
        expect(m.axis).toBe(o.axis)
        expect(m.direction).toBe(o.direction)
        expect(m.searchMm).toBeCloseTo(o.travelMm, 4)
        expect(m.retractMm).toBe(oracle.plan.stepOffMm)
        expect(m.expectedStart.z).toBe(TOP - fromTop.depthMm)
      }
    })
    // every third wall move returns through the nominal centre - identical in XY
    const centreReturns = mine.slice(1, -1).filter((s, i): s is ExpandedMoveStep => s.kind === 'move' && i % 2 === 1)
    const oracleReturns = oracle.plan.steps.slice(1, -1).filter((s, i): s is ProbeCyclePositionStep => s.kind === 'position' && i % 2 === 1)
    expect(centreReturns.map((m) => [m.target.x, m.target.y])).toEqual(oracleReturns.map((o) => [o.target.x, o.target.y]))
    expect(centreReturns).toHaveLength(4)
  })

  it('the approach points: factory routine and planner agree - every bore touch parks on the NEAR side of the wall it probes', () => {
    // Found by this oracle on 2026-08-20: roundApproach applied the boss rule to the
    // bore (X- touch parked at 100 and searched across the bore; with the bounded
    // search it could only miss). Fixed the same day in probeFeatureCycle.ts; this
    // test now pins agreement touch for touch.
    if (!oracle.ok || !result.ok) return
    const mine = takenMotion(result.expanded.steps).filter((s): s is ExpandedTouchStep => s.kind === 'touch')
    const theirs = oracle.plan.steps.filter((s): s is ProbeCycleTouchStep => s.kind === 'touch')
    expect(mine.map((t) => [t.axis, t.direction, t.expectedStart.x, t.expectedStart.y])).toEqual([
      ['X', '-', 100, 100],
      ['X', '+', 100, 100],
      ['Y', '-', 100, 100],
      ['Y', '+', 100, 100],
    ])
    theirs.forEach((o, i) => {
      const m = mine[i]
      expect(m.expectedStart.x).toBeCloseTo(o.expectedStart.x, 4)
      expect(m.expectedStart.y).toBeCloseTo(o.expectedStart.y, 4)
    })
    // and the factory data's far end is INSIDE the bore wall it probes toward (wall at 80 / 120)
    expect(mine[0].farEnd.x).toBe(70) // X- touch: past the wall at 80 by the overtravel
    expect(mine[1].farEnd.x).toBe(130)
    expect(mine[0].nominalContact.x).toBe(75) // wall 80 + tip radius 1.5
  })

  it('the feeds are the profile feeds the oracle reports (no factor, no axis limit); the descent runs at the search feed', () => {
    if (!oracle.ok || !result.ok) return
    const moves = takenMotion(result.expanded.steps).filter((s): s is ExpandedMoveStep => s.kind === 'move')
    const t = takenMotion(result.expanded.steps).find((s): s is ExpandedTouchStep => s.kind === 'touch')!
    expect(moves[0].feedMmMin).toBe(oracle.plan.review.searchFeedMmMin)
    expect(moves[1].feedMmMin).toBe(oracle.plan.review.positioningFeedMmMin)
    expect(t.searchFeedMmMin).toBe(oracle.plan.review.searchFeedMmMin)
    expect(t.finalFeedMmMin).toBe(oracle.plan.review.probeFeedMmMin)
    expect(result.expanded.end).toEqual({ x: oracle.plan.expectedCenter!.x, y: oracle.plan.expectedCenter!.y, z: TOP + oracle.plan.fromTop!.clearanceMm })
  })

  it('the search travel equals the oracle searchTravelMm and the approach is the oracle approach', () => {
    if (!oracle.ok || !result.ok) return
    const touches = takenMotion(result.expanded.steps).filter((s): s is ExpandedTouchStep => s.kind === 'touch')
    expect(touches.every((t) => t.searchMm === oracle.plan.searchTravelMm)).toBe(true)
    expect(touches[0].expectedStart).toEqual({ x: 100, y: 100, z: 20 })
    expect(touches[0].farEnd).toEqual({ x: 70, y: 100, z: 20 })
    expect(touches[0].nominalContact).toEqual({ x: 75, y: 100, z: 20 })
    expect(touches[0].expectedAfter).toEqual({ x: 77, y: 100, z: 20 })
    // the approach distance (centre to touch start) is the oracle's to 4 decimals: d/2 - tip - clearance
    const approach = touches.map((t) => Math.abs(t.expectedStart.x - 100) + Math.abs(t.expectedStart.y - 100))
    expect(approach.every((a) => Math.abs(a - 0) < 0.00005)).toBe(true)
  })

  it('started below safe height it rises there first - never a plain move down', () => {
    const low = expandProbeRoutine(FACTORY_BORE_CENTRE, { diameter: 40, topZ: TOP }, ctxAt({ ...start, z: 22 }))
    if (!low.ok) throw new Error(low.errors.map((e) => e.sentence).join('\n'))
    const [rise, down] = takenMotion(low.expanded.steps) as ExpandedMoveStep[]
    expect([rise.axes, rise.from.z, rise.target.z, rise.stopOnContact]).toEqual([['Z'], 22, 30, undefined])
    expect([down.stopOnContact, down.from.z, down.target.z]).toEqual([true, 30, 20])
  })
})

describe('WO-411 slice 2: the factory BOSS routine against planFeatureProbeCycle', () => {
  // WO-2065: both start over the middle (design 4.2) and touch the top there.
  // The planner touches X- first, the contract's routine X+ first - same
  // centre, same four touches, the order differs (reported in WO-411).
  const centre = { x: 100, y: 100, z: 40 }
  const oracle = planFeatureProbeCycle({ kind: 'boss', start: centre, envelope, config, tipRadiusMm: TIP, nominalSizeXmm: 40, nominalSizeYmm: 40 })
  const result = expandProbeRoutine(FACTORY_BOSS_CENTRE, { diameter: 40 }, ctxAt(centre))
  /** The routine's nominal top: where its top touch is previewed to meet the boss. */
  const nominalTop = () => {
    if (!result.ok) throw new Error('no expansion')
    return (result.expanded.steps.find((s): s is ExpandedTouchStep => s.kind === 'touch' && s.name === 'top')!).nominalContact.z
  }

  it('both expand clean around the same nominal centre; both touch the top first, over the middle', () => {
    expect(oracle.ok).toBe(true)
    expect(result.ok).toBe(true)
    if (!oracle.ok || !result.ok) return
    expect(oracle.plan.expectedCenter).toEqual(centre)
    expect(oracle.plan.fromTop?.topTouch?.at).toEqual(centre)
    const first = takenMotion(result.expanded.steps)[0]
    expect(first.kind === 'touch' && [first.axis, first.direction, first.expectedStart]).toEqual(['Z', '-', centre])
    expect(result.expanded.end).toEqual({ x: 100, y: 100, z: nominalTop() + oracle.plan.fromTop!.clearanceMm })
  })

  it('the four side touches are the same set: axis, direction, stepped-out start, search travel - at top - depth', () => {
    if (!oracle.ok || !result.ok) return
    const key = (t: { axis: string; direction: string; x: number; y: number; search: number }) =>
      `${t.axis}${t.direction}@${t.x.toFixed(4)},${t.y.toFixed(4)}/${t.search.toFixed(4)}`
    const theirs = oracle.plan.steps
      .filter((s): s is ProbeCycleTouchStep => s.kind === 'touch')
      .map((s) => key({ axis: s.axis, direction: s.direction, ...s.expectedStart, search: s.travelMm }))
      .sort()
    const sides = takenMotion(result.expanded.steps).filter((s): s is ExpandedTouchStep => s.kind === 'touch' && s.name !== 'top')
    const mine = sides.map((s) => key({ axis: s.axis, direction: s.direction, ...s.expectedStart, search: s.searchMm })).sort()
    expect(mine).toEqual(theirs)
    expect(mine).toHaveLength(4)
    expect(oracle.plan.steps.filter((s) => s.kind === 'touch').every((s) => s.kind === 'touch' && s.descendFromTop)).toBe(true)
    expect(sides.every((s) => s.expectedStart.z === nominalTop() - oracle.plan.fromTop!.depthMm)).toBe(true)
  })

  it('every XY move runs at top + clearance and every way down is a probe move - it never moves through the boss', () => {
    if (!oracle.ok || !result.ok) return
    const safe = nominalTop() + oracle.plan.fromTop!.clearanceMm
    const depth = nominalTop() - oracle.plan.fromTop!.depthMm
    const moves = takenMotion(result.expanded.steps).filter((s): s is ExpandedMoveStep => s.kind === 'move')
    const xy = moves.filter((m) => m.axes.includes('X') || m.axes.includes('Y'))
    expect(xy).toHaveLength(5) // four step-outs + the finish over the middle
    expect(xy.every((m) => m.from.z === safe && m.target.z === safe)).toBe(true)
    const downs = moves.filter((m) => m.axes.join('') === 'Z' && m.target.z < m.from.z)
    expect(downs).toHaveLength(4)
    expect(downs.every((m) => m.stopOnContact === true && m.target.z === depth)).toBe(true)
    expect(moves.filter((m) => m.axes.join('') === 'Z' && m.target.z === safe)).toHaveLength(5)
    const stepOuts = xy.slice(0, 4).map((m) => [m.target.x, m.target.y])
    expect(stepOuts).toEqual([[73.5, 100], [126.5, 100], [100, 73.5], [100, 126.5]])
    expect(oracle.plan.fromTop!.stepOutMm).toBe(26.5)
  })
})

describe('WO-411 slice 2: factory EDGE, CORNERS against the planner', () => {
  const start = { x: 100, y: 100, z: 40 }
  const nominalTopOf = (steps: readonly ExpandedStep[]) =>
    (steps.find((s): s is ExpandedTouchStep => s.kind === 'touch' && s.name === 'top')!).nominalContact.z

  it('edge Y-: top touch, step out, descent, one touch - same axis / direction / travel / stepped-out start as the panel (WO-2055)', () => {
    const oracle = planFeatureProbeCycle({ kind: 'edge', start, envelope, config, tipRadiusMm: TIP, edgeAxis: 'Y', edgeDirection: '-' })
    const result = expandProbeRoutine(FACTORY_EDGE_Y_MINUS, {}, ctxAt(start))
    expect(oracle.ok && result.ok).toBe(true)
    if (!oracle.ok || !result.ok) return
    const o = oracle.plan.steps[0] as ProbeCycleTouchStep
    expect(o.descendFromTop).toBe(true)
    const touches = takenMotion(result.expanded.steps).filter((s): s is ExpandedTouchStep => s.kind === 'touch')
    expect(touches.map((t) => [t.axis, t.direction])).toEqual([['Z', '-'], ['Y', '-']])
    const m = touches[1]
    expect([m.axis, m.direction, m.searchMm, m.expectedStart.x, m.expectedStart.y]).toEqual([o.axis, o.direction, o.travelMm, o.expectedStart.x, o.expectedStart.y])
    expect(m.expectedStart.y).toBe(100 + oracle.plan.fromTop!.stepOutMm)
    expect(m.expectedStart.z).toBe(nominalTopOf(result.expanded.steps) - oracle.plan.fromTop!.depthMm)
    const moves = takenMotion(result.expanded.steps).filter((s): s is ExpandedMoveStep => s.kind === 'move')
    expect(moves.map((s) => [s.axes.join(''), s.stopOnContact ?? false])).toEqual([['Z', false], ['Y', false], ['Z', true], ['Z', false]])
  })

  it('inside corner X- Y+: one descent from the hole top, then two touches in the same order, same probed-axis start and travel', () => {
    const TOP = 25
    const oracle = planFeatureProbeCycle({ kind: 'insideCorner', start, envelope, config, tipRadiusMm: TIP, cornerXDirection: '-', cornerYDirection: '+', rimTopMachineZMm: TOP })
    const result = expandProbeRoutine(FACTORY_CORNER_INSIDE_X_MINUS_Y_PLUS, { searchMm: config.maxTravel, topZ: TOP }, ctxAt(start))
    expect(oracle.ok && result.ok).toBe(true)
    if (!oracle.ok || !result.ok) return
    const theirs = oracle.plan.steps.filter((s): s is ProbeCycleTouchStep => s.kind === 'touch')
    const all = takenMotion(result.expanded.steps)
    expect(all.map((s) => s.kind)).toEqual(oracle.plan.steps.map((s) => (s.kind === 'touch' ? 'touch' : 'move')))
    const mine = all.filter((s): s is ExpandedTouchStep => s.kind === 'touch')
    expect(mine.map((t) => [t.axis, t.direction, t.searchMm])).toEqual(theirs.map((t) => [t.axis, t.direction, t.travelMm]))
    // The planner keeps `start` as the second touch's expectedStart; the
    // expander tracks the probe's real X after the first touch's back-off
    // (contact + backoff). The Y start - the probed axis - agrees exactly.
    expect(mine[1].expectedStart.y).toBe(theirs[1].expectedStart.y)
    expect(mine[0].expectedStart.z).toBe(TOP - oracle.plan.fromTop!.depthMm)
    expect(mine[0].expectedAfter.x).toBe(100 - (config.maxTravel - 5) + 2)
  })

  it('outside corner back right: goes around the corner like the panel (WO-2056) - X face stepped out in X, Y face stepped out in Y', () => {
    const oracle = planFeatureProbeCycle({ kind: 'outsideCorner', start, envelope, config, tipRadiusMm: TIP, cornerXDirection: '-', cornerYDirection: '-' })
    const result = expandProbeRoutine(FACTORY_CORNER_OUTSIDE_X_MINUS_Y_MINUS, {}, ctxAt(start))
    expect(oracle.ok && result.ok).toBe(true)
    if (!oracle.ok || !result.ok) return
    const theirs = oracle.plan.steps.filter((s): s is ProbeCycleTouchStep => s.kind === 'touch')
    const mine = takenMotion(result.expanded.steps).filter((s): s is ExpandedTouchStep => s.kind === 'touch' && s.name !== 'top')
    expect(mine.map((t) => [t.axis, t.direction, t.searchMm, t.expectedStart.x, t.expectedStart.y]))
      .toEqual(theirs.map((t) => [t.axis, t.direction, t.travelMm, t.expectedStart.x, t.expectedStart.y]))
    const top = nominalTopOf(result.expanded.steps)
    const safe = top + oracle.plan.fromTop!.clearanceMm
    const depth = top - oracle.plan.fromTop!.depthMm
    // WO-2569: stepOut remains 16.5; one bounded 20 mm seek.
    expect(takenMotion(result.expanded.steps).map((s) => (s.kind === 'move'
      ? ['move', s.target.x, s.target.y, s.target.z, s.stopOnContact ?? false]
      : ['touch', s.axis, s.direction, s.searchMm]))).toEqual([
      ['touch', 'Z', '-', 25],
      ['move', 100, 100, safe, false],
      ['move', 116.5, 100, safe, false],
      ['move', 116.5, 100, depth, true],
      ['touch', 'X', '-', 20],
      ['move', 116.5 - 15 + 2, 100, safe, false],
      ['move', 100, 100, safe, false],
      ['move', 100, 116.5, safe, false],
      ['move', 100, 116.5, depth, true],
      ['touch', 'Y', '-', 20],
      ['move', 100, 116.5 - 15 + 2, safe, false],
    ])
  })
})

describe('WO-411 slice 2: every factory routine expands clean on a representative machine', () => {
  // WO-1613: the tool setter routine is planned by planToolSetterMeasure (its
  // descent depends on the tool table), never by this expander - see
  // toolSetterRoutine.wo1613.test.ts.
  for (const r of FACTORY_PROBE_ROUTINES.filter((routine) => routine.requires.probe !== 'toolSetter')) {
    it(`${r.id} expands with its defaults`, () => {
      // Started 40 mm up; a hole's top (the Routines tab fills it from work Z0) at 15.
      const start = r.id === 'factory.boss-centre' ? { x: 100, y: 100, z: 40 } : { x: 150, y: 150, z: 40 }
      const inputs: Record<string, number> = isFactoryHoleRoutineId(r.id) ? { topZ: 15 } : {}
      const result = expandProbeRoutine(r, inputs, ctxAt(start))
      if (!result.ok) throw new Error(result.errors.map((e) => e.sentence).join('\n'))
      expect(result.expanded.steps.length).toBe(r.steps.length)
      expect(result.expanded.proposals.length).toBe(r.outputs.length)
      expect(result.expanded.hash).toMatch(/^[0-9a-f]{64}$/)
      // every motion step sits inside the table
      for (const s of motion(result.expanded.steps)) {
        const p = s.kind === 'move' ? s.target : s.farEnd
        expect(pointOutsideEnvelope(p, envelope)).toBeNull()
      }
      // proposals stay unevaluated expressions
      const wo = result.expanded.proposals.find((p) => p.kind === 'workOffset')
      expect(wo && wo.kind === 'workOffset' && Object.values(wo.axes).every((a) => typeof a?.source === 'string')).toBe(true)
    })
  }
})

// ---------------------------------------------------------------------------

describe('WO-411 slice 2: the contract\'s invalid example (section 3.5) - the expansion errors #3, #4, #5', () => {
  const badSlot = CONTRACT_INVALID_EXAMPLE_USER_BAD_SLOT as ProbeRoutine
  const result = expandProbeRoutine(badSlot, {}, sampleMachineCtx)

  it('yields exactly #3, #4, #5 by code, in step order', () => {
    expect(result.ok).toBe(false)
    expect(codes(result.errors)).toEqual(['E_RAPID_NOT_AT_SAFE_Z', 'E_ENDPOINT_OUTSIDE_ENVELOPE', 'E_SEARCH_OVER_MAX_TRAVEL'])
  })

  it('renders the contract\'s sentences', () => {
    const sentences = result.errors.map((e) => e.sentence)
    expect(sentences[0]).toBe(
      "Step 1 (move 'toLeftWall'): a rapid is allowed only straight up in Z, or in XY at or above the routine's safe Z - this routine declares no safe Z. It will run at the positioning feed or not at all.",
    )
    expect(sentences[1]).toBe(
      "Step 1 (move 'toLeftWall'): machine X -1300.0 is outside the table (X runs -812.8 to 0).",
    )
    expect(sentences[2]).toBe(
      "Step 2 (touch 'left'): a search of 80 mm is more than the machine profile's probe travel limit of 50 mm.",
    )
  })

  it('names its steps and carries paths', () => {
    expect(result.errors.map((e) => e.step?.number)).toEqual([1, 1, 2])
    expect(result.errors.map((e) => e.step?.name)).toEqual(['toLeftWall', 'toLeftWall', 'left'])
    expect(result.errors.map((e) => e.path)).toEqual(['steps[0].feed', 'steps[0]', 'steps[1].searchMm'])
  })

  it('the union with slice 1\'s static errors is the contract\'s full table of 11, by code', () => {
    const statics = validateProbeRoutine(CONTRACT_INVALID_EXAMPLE_USER_BAD_SLOT, { profileFeeds: { searchMmMin: 300 } })
    const all = [...statics.errors, ...result.errors]
    expect(all).toHaveLength(11)
    expect(new Set(codes(all))).toEqual(new Set([
      'E_REQUIRES_HOMED', 'E_INPUT_UNBOUNDED', 'E_RAPID_NOT_AT_SAFE_Z', 'E_ENDPOINT_OUTSIDE_ENVELOPE',
      'E_SEARCH_OVER_MAX_TRAVEL', 'E_FEED_ABOVE_PROFILE', 'E_EXPR_UNBOUNDED', 'E_CALC_NOT_FINITE',
      'E_STEP_KIND', 'E_GCODE_IN_ROUTINE', 'E_EXPR_UNKNOWN_NAME',
    ]))
    // merged by step (routine, input, steps, output) the two lists interleave as the table does
    const place = (e: RoutineError) => e.where === 'routine' ? -2 : e.where === 'input' ? -1 : e.where === 'output' ? 1000 : e.step!.number
    const merged = [...all].sort((a, b) => place(a) - place(b))
    expect(merged.map(place)).toEqual([-2, -1, 1, 1, 2, 2, 5, 5, 6, 6, 1000])
    expect(codes(merged).slice(0, 4)).toEqual(['E_REQUIRES_HOMED', 'E_INPUT_UNBOUNDED', 'E_RAPID_NOT_AT_SAFE_Z', 'E_ENDPOINT_OUTSIDE_ENVELOPE'])
    expect(new Set(codes(merged).slice(4, 6))).toEqual(new Set(['E_SEARCH_OVER_MAX_TRAVEL', 'E_FEED_ABOVE_PROFILE']))
  })
})

// ---------------------------------------------------------------------------

describe('WO-411 slice 2: envelope rule (section 4.2) - on the edge is inside, a hair beyond the slack is outside', () => {
  const start = { x: 100, y: 100, z: 20 }
  const moveTo = (x: number) => valid(routine({ steps: [{ kind: 'move', name: 'm', frame: 'machine', to: { x: String(x) } }] }))

  it('exactly on the table edge (X 300) is accepted', () => {
    expect(expandProbeRoutine(moveTo(300), {}, ctxAt(start)).ok).toBe(true)
  })

  it('within ENVELOPE_FIT_TOLERANCE_MM (0.01 mm) beyond the edge is rounding slack and accepted', () => {
    expect(expandProbeRoutine(moveTo(300.005), {}, ctxAt(start)).ok).toBe(true)
  })

  it('more than the slack beyond the edge is refused, naming the step and the table', () => {
    const result = expandProbeRoutine(moveTo(300.02), {}, ctxAt(start))
    expect(result.ok).toBe(false)
    expect(result.errors[0].code).toBe('E_ENDPOINT_OUTSIDE_ENVELOPE')
    expect(result.errors[0].sentence).toBe("Step 1 (move 'm'): machine X 300.02 is outside the table (X runs 0 to 300).")
  })

  it('an XY touch is bounded at the table edge instead of refusing a reachable wall (WO-2554)', () => {
    const r = valid(routine({ steps: [{ kind: 'touch', name: 't', axis: 'X', direction: '+', searchMm: '20' }] }))
    const result = expandProbeRoutine(r, {}, ctxAt({ x: 290, y: 100, z: 20 }))
    expect(result.errors).toEqual([])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.expanded.steps[0]).toMatchObject({ kind: 'touch', searchMm: 10, farEnd: { x: 300, y: 100, z: 20 } })
    expect(expandProbeRoutine(r, {}, ctxAt({ x: 280, y: 100, z: 20 })).ok).toBe(true)
  })

  it('a start parked off the table is refused at routine level', () => {
    const result = expandProbeRoutine(moveTo(10), {}, ctxAt({ x: -5, y: 100, z: 20 }))
    expect(result.ok).toBe(false)
    expect(result.errors[0]).toMatchObject({ code: 'E_ENDPOINT_OUTSIDE_ENVELOPE', where: 'routine' })
  })

  it('an incomplete envelope with requires.homed is E_ENVELOPE_INCOMPLETE', () => {
    const partial: MachineEnvelope = { ...envelope, z: null }
    const result = expandProbeRoutine(moveTo(10), {}, { ...ctxAt(start), envelope: partial })
    expect(result.ok).toBe(false)
    expect(result.errors[0].code).toBe('E_ENVELOPE_INCOMPLETE')
    expect(result.errors[0].sentence).toContain('the Z range is unknown')
  })

  it('a step whose start is already off the table does not repeat the earlier refusal (one error per cause)', () => {
    const r = valid(routine({
      steps: [
        { kind: 'move', name: 'out', frame: 'machine', to: { x: '400' } },
        { kind: 'touch', name: 't', axis: 'X', direction: '+', searchMm: '10' },
        { kind: 'move', name: 'back', frame: 'machine', to: { x: '100' } },
      ],
    }))
    const result = expandProbeRoutine(r, {}, ctxAt(start))
    expect(codes(result.errors)).toEqual(['E_ENDPOINT_OUTSIDE_ENVELOPE'])
    expect(result.errors[0].step?.name).toBe('out')
  })
})

describe('WO-411 slice 2: search distance vs probe travel (E_SEARCH_OVER_MAX_TRAVEL)', () => {
  it('a search exactly at maxTravel is allowed; above is refused', () => {
    const at = valid(routine({ steps: [{ kind: 'touch', name: 't', axis: 'X', direction: '-', searchMm: 'probe.maxTravelMm' }] }))
    const over = valid(routine({ steps: [{ kind: 'touch', name: 't', axis: 'X', direction: '-', searchMm: 'probe.maxTravelMm + 0.5' }] }))
    expect(expandProbeRoutine(at, {}, ctxAt({ x: 100, y: 100, z: 20 })).ok).toBe(true)
    const result = expandProbeRoutine(over, {}, ctxAt({ x: 100, y: 100, z: 20 }))
    expect(result.ok).toBe(false)
    expect(result.errors[0].sentence).toBe("Step 1 (touch 't'): a search of 30.5 mm is more than the machine profile's probe travel limit of 30 mm.")
  })
})

// ---------------------------------------------------------------------------

describe('WO-411 slice 2: feeds clamp, never raise (section 4.3)', () => {
  const start = { x: 100, y: 100, z: 20 }
  const withFactor = (f: number) => routine({
    steps: [{ kind: 'touch', name: 't', axis: 'X', direction: '-', searchMm: '10', searchFeedFactor: f, finalFeedFactor: f }],
  })
  const touchOf = (r: ReturnType<typeof expandProbeRoutine>) => {
    if (!r.ok) throw new Error(r.errors.map((e) => e.sentence).join('\n'))
    return r.expanded.steps[0] as ExpandedTouchStep
  }

  it('factor 0.5 halves the search feed and the final feed', () => {
    const t = touchOf(expandProbeRoutine(valid(withFactor(0.5)), {}, ctxAt(start)))
    expect(t.searchFeedMmMin).toBe(150)
    expect(t.finalFeedMmMin).toBe(20)
    expect(t.searchFeed).toEqual({ profileMmMin: 300, factor: 0.5, requestedMmMin: 150, appliedMmMin: 150, clampedBy: 'none' })
  })

  it('factor 2.5 (a static error) still expands at the profile feed - never above it', () => {
    const t = touchOf(expandProbeRoutine(withFactor(2.5), {}, ctxAt(start)))
    expect(t.searchFeedMmMin).toBe(300)
    expect(t.finalFeedMmMin).toBe(40)
    expect(t.searchFeed.clampedBy).toBe('factor')
  })

  it('axisLimits.maxCutting below the profile feed wins, for touches and for moves on that axis', () => {
    const limits = { x: { maxCutting: 100, maxRapid: 5000 }, y: { maxCutting: 2000, maxRapid: 5000 }, z: { maxCutting: 2000, maxRapid: 5000 } }
    const t = touchOf(expandProbeRoutine(valid(withFactor(1)), {}, ctxAt(start, { axisLimits: limits })))
    expect(t.searchFeedMmMin).toBe(100)
    expect(t.searchFeed.clampedBy).toBe('axisLimit')
    expect(t.finalFeedMmMin).toBe(40) // already below the ceiling
    const r = valid(routine({
      steps: [
        { kind: 'move', name: 'x', frame: 'start', to: { x: '5' } },
        { kind: 'move', name: 'y', frame: 'start', to: { y: '5' } },
        { kind: 'move', name: 'xy', frame: 'start', to: { x: '0', y: '0' } },
      ],
    }))
    const res = expandProbeRoutine(r, {}, ctxAt(start, { axisLimits: limits }))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.expanded.steps.map((s) => (s as ExpandedMoveStep).feedMmMin)).toEqual([100, 1200, 100])
  })

  it('a Y touch is not clamped by the X ceiling', () => {
    const limits = { x: { maxCutting: 100, maxRapid: 5000 }, y: { maxCutting: 2000, maxRapid: 5000 }, z: { maxCutting: 2000, maxRapid: 5000 } }
    const r = valid(routine({ steps: [{ kind: 'touch', name: 't', axis: 'Y', direction: '-', searchMm: '10' }] }))
    expect(touchOf(expandProbeRoutine(r, {}, ctxAt(start, { axisLimits: limits }))).searchFeedMmMin).toBe(300)
  })
})

// ---------------------------------------------------------------------------

describe('WO-411 slice 2: rapids (section 2.4)', () => {
  const start = { x: 100, y: 100, z: 20 }

  it('an XY rapid at the declared safe Z is accepted and marked rapid', () => {
    const r = valid(routine({
      steps: [
        { kind: 'move', name: 'up', frame: 'start', to: { z: '30' }, safeZ: '30' },
        { kind: 'move', name: 'over', frame: 'start', to: { x: '40', y: '-20' }, feed: 'rapid' },
      ],
    }))
    const result = expandProbeRoutine(r, {}, ctxAt(start))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const [up, over] = result.expanded.steps as ExpandedMoveStep[]
    expect(up.safeZ).toBe(50)
    expect(up.rapid).toBe(false)
    expect(over.rapid).toBe(true)
    expect(over.target).toEqual({ x: 140, y: 80, z: 50 })
  })

  it('an XY rapid below the safe Z is refused, naming both numbers', () => {
    const r = valid(routine({
      steps: [
        { kind: 'move', name: 'up', frame: 'start', to: { z: '10' }, safeZ: '30' },
        { kind: 'move', name: 'over', frame: 'start', to: { x: '40' }, feed: 'rapid' },
      ],
    }))
    const result = expandProbeRoutine(r, {}, ctxAt(start))
    expect(result.ok).toBe(false)
    expect(result.errors[0].code).toBe('E_RAPID_NOT_AT_SAFE_Z')
    expect(result.errors[0].sentence).toBe(
      "Step 2 (move 'over'): a rapid in XY is allowed only at or above the routine's safe Z (machine Z 50.0); this one starts at machine Z 30.0. It will run at the positioning feed or not at all.",
    )
  })

  it('a Z-only rapid upward is accepted; downward is refused', () => {
    const up = valid(routine({
      steps: [
        { kind: 'move', name: 'first', frame: 'start', to: { x: '0' }, safeZ: '30' },
        { kind: 'move', name: 'lift', frame: 'start', to: { z: '30' }, feed: 'rapid' },
      ],
    }))
    expect(expandProbeRoutine(up, {}, ctxAt(start)).ok).toBe(true)
    const down = valid(routine({
      steps: [
        { kind: 'move', name: 'first', frame: 'start', to: { z: '30' }, safeZ: '30' },
        { kind: 'move', name: 'drop', frame: 'start', to: { z: '0' }, feed: 'rapid' },
      ],
    }))
    const result = expandProbeRoutine(down, {}, ctxAt(start))
    expect(result.ok).toBe(false)
    expect(result.errors[0].code).toBe('E_RAPID_NOT_AT_SAFE_Z')
    expect(result.errors[0].sentence).toContain('only upward')
  })

  it('a rapid that moves XY and Z together is refused; without a safe Z no rapid at all', () => {
    const both = valid(routine({
      steps: [
        { kind: 'move', name: 'first', frame: 'start', to: { z: '30' }, safeZ: '30' },
        { kind: 'move', name: 'diag', frame: 'start', to: { x: '5', z: '40' }, feed: 'rapid' },
      ],
    }))
    expect(codes(expandProbeRoutine(both, {}, ctxAt(start)).errors)).toEqual(['E_RAPID_NOT_AT_SAFE_Z'])
    const none = valid(routine({ steps: [{ kind: 'move', name: 'lift', frame: 'start', to: { z: '30' }, feed: 'rapid' }] }))
    expect(codes(expandProbeRoutine(none, {}, ctxAt(start)).errors)).toEqual(['E_RAPID_NOT_AT_SAFE_Z'])
  })
})

// ---------------------------------------------------------------------------

describe('WO-411 slice 2: inputs, nominal calcs, checks, probe config', () => {
  const start = { x: 100, y: 100, z: 20 }

  it('an input outside its range is E_INPUT_OUT_OF_RANGE with the bound named', () => {
    const result = expandProbeRoutine(FACTORY_BORE_CENTRE, { diameter: 500 }, ctxAt(start))
    expect(result.ok).toBe(false)
    expect(result.errors[0]).toMatchObject({ code: 'E_INPUT_OUT_OF_RANGE', where: 'input', index: 1 })
    expect(result.errors[0].sentence).toBe("Input 'diameter': 500 mm is outside the allowed range 3 to 300 mm.")
  })

  it('a missing input takes its default; an unknown input name is refused', () => {
    const ok = expandProbeRoutine(FACTORY_BORE_CENTRE, { topZ: 15 }, ctxAt(start))
    // WO-2074: Bore centre also declares `topZ` (the Routines tab's hole top,
    // filled from work Z0); WO-2065 adds the probing depth below it.
    expect(ok.ok && ok.expanded.inputs).toEqual({ diameter: 20, topZ: 15, depthMm: 5 })
    const bad = expandProbeRoutine(FACTORY_BORE_CENTRE, { diametre: 20 }, ctxAt(start))
    expect(bad.ok).toBe(false)
    expect(bad.errors[0].sentence).toContain("no input named 'diametre'")
  })

  it('an enum input drives a touch axis / direction', () => {
    const r = valid(routine({
      inputs: [
        { name: 'side', label: 'Side', type: 'enum', options: ['X', 'Y'], default: 'X' },
        { name: 'dir', label: 'Direction', type: 'enum', options: ['+', '-'], default: '-' },
      ],
      steps: [{ kind: 'touch', name: 't', axis: '$input.side', direction: '$input.dir', searchMm: '10' }],
    }))
    const result = expandProbeRoutine(r, { side: 'Y', dir: '+' }, ctxAt(start))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const t = result.expanded.steps[0] as ExpandedTouchStep
    expect([t.axis, t.direction, t.farEnd]).toEqual(['Y', '+', { x: 100, y: 110, z: 20 }])
    expect(expandProbeRoutine(r, { side: 'Z' }, ctxAt(start)).errors[0].code).toBe('E_INPUT_OUT_OF_RANGE')
  })

  it('a calc that happens to divide by zero with these inputs is E_CALC_NOT_FINITE at preview', () => {
    const r = valid(routine({
      inputs: [{ name: 'd', label: 'd', type: 'length', unit: 'mm', min: 0, max: 100, default: 20 }],
      steps: [{ kind: 'calc', name: 'k', unit: 'ratio', expr: '1 / (input.d - 20)' }],
    }))
    const result = expandProbeRoutine(r, {}, ctxAt(start))
    expect(result.ok).toBe(false)
    expect(result.errors[0]).toMatchObject({ code: 'E_CALC_NOT_FINITE', step: { number: 1, kind: 'calc', name: 'k' } })
    expect(expandProbeRoutine(r, { d: 21 }, ctxAt(start)).ok).toBe(true)
  })

  it('a check that is false from the inputs alone is refused now, with the message (a touch start past the far wall)', () => {
    // WO-2265: the check used to refuse any bore whose radius was not more than tip + Clearance
    // (12.5 mm / 1.5 / 5 - Operator 2026-09-30). It now stops only when a touch's start, Clearance in
    // from its wall, would lie past the FAR wall: diameter 3 mm, tip 1.5, Clearance 5.
    const result = expandProbeRoutine(FACTORY_BORE_CENTRE, { diameter: 3 }, ctxAt(start))
    expect(result.ok).toBe(false)
    expect(result.errors[0].code).toBe('E_INPUT_OUT_OF_RANGE')
    expect(result.errors[0].sentence).toBe(
      "Step 1 (check): with these inputs the check would stop the routine before it moves: The bore diameter must be larger than the probe tip.",
    )
    // the planner refuses the same 3 mm only because the 3 mm tip does not fit in it, and says so
    const planned = planFeatureProbeCycle({ kind: 'bore', start, envelope, config, tipRadiusMm: TIP, nominalSizeXmm: 3, nominalSizeYmm: 3 })
    expect(planned.ok ? null : planned.reason).toBe(
      'Nominal diameter 3 mm is not larger than the probe tip (radius 1.5 mm, 3 mm across) - check Nominal diameter or Tip radius.',
    )
    // and the factory routine probes 12.5 mm, which it used to refuse here
    expect(expandProbeRoutine(FACTORY_BORE_CENTRE, { diameter: 12.5, topZ: 15 }, ctxAt(start)).ok).toBe(true)
  })

  it('a touch-dependent check is never an expansion error; its nominal result is carried', () => {
    const result = expandProbeRoutine(FACTORY_BORE_CENTRE, { topZ: 15 }, ctxAt(start))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const last = result.expanded.steps.at(-1)
    expect(last?.kind === 'check' && last.touchDependent && last.nominalResult).toBe(true)
    const calcs = listExpandedSteps(result.expanded.steps).filter((s) => s.kind === 'calc')
    const diameterX = calcs.find((c) => c.name === 'diameterX')
    // WO-2554: the generic preview estimates contacts from search reach;
    // only the real runner computes the measured diameter from actual touches.
    expect(diameterX?.kind === 'calc' && diameterX.nominalValue).toBeCloseTo(53, 6)
  })

  it('an unusable probe config is E_PROBE_CONFIG_INVALID; so is a negative tip radius', () => {
    const badConfig = { ...config, slowFeed: 500 }
    const r1 = expandProbeRoutine(FACTORY_BORE_CENTRE, {}, { ...ctxAt(start), probe: badConfig })
    expect(r1.errors.some((e) => e.code === 'E_PROBE_CONFIG_INVALID')).toBe(true)
    const r2 = expandProbeRoutine(FACTORY_BORE_CENTRE, {}, ctxAt(start, { tipRadiusMm: -1 }))
    expect(r2.errors[0].code).toBe('E_PROBE_CONFIG_INVALID')
  })
})

// ---------------------------------------------------------------------------

describe('WO-411 slice 2: touch-dependent moves and branches', () => {
  const start = { x: 100, y: 100, z: 20 }

  it('a move whose endpoint references an earlier touch is expanded at both contact extremes and both are checked', () => {
    const r = valid(routine({
      steps: [
        { kind: 'touch', name: 'left', axis: 'X', direction: '-', searchMm: '10' },
        { kind: 'move', name: 'beside', frame: 'machine', to: { x: 'touch.left.x + 2' } },
      ],
    }))
    const result = expandProbeRoutine(r, {}, ctxAt(start))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const m = result.expanded.steps[1] as ExpandedMoveStep
    expect(m.touchDependent).toBe(true)
    expect(m.target.x).toBe(97) // nominal contact 95 + 2
    expect(m.band).toEqual({ low: { x: 92, y: 100, z: 20 }, high: { x: 102, y: 100, z: 20 } })
    expect(describeExpandedStep(m)).toBe('2. move to machine X 97.0 (between machine X 92.0 and machine X 102.0, depending on the contact) at 1200 mm/min')
  })

  it('a band corner off the table refuses the move even when the nominal endpoint is inside', () => {
    const r = valid(routine({
      steps: [
        { kind: 'touch', name: 'left', axis: 'X', direction: '-', searchMm: '10' },
        { kind: 'move', name: 'beside', frame: 'machine', to: { x: 'touch.left.x - 2' } },
      ],
    }))
    const result = expandProbeRoutine(r, {}, ctxAt({ x: 11, y: 100, z: 20 }))
    expect(result.ok).toBe(false)
    expect(result.errors.map((e) => e.sentence)).toEqual([
      "Step 2 (move 'beside'): the lowest possible endpoint (depending on the contact), machine X -1.0, is outside the table (X runs 0 to 300).",
    ])
  })

  it('both branch arms are expanded, numbered in place, and both must validate', () => {
    const r = valid(routine({
      inputs: [{ name: 'w', label: 'w', type: 'length', unit: 'mm', min: 1, max: 200, default: 50 }],
      steps: [
        {
          kind: 'branch',
          name: 'wide',
          condition: { cmp: '>=', left: 'input.w', right: '40' },
          then: [{ kind: 'move', name: 'far', frame: 'start', to: { x: '30' } }],
          else: [{ kind: 'move', name: 'near', frame: 'start', to: { x: '10' } }, { kind: 'touch', name: 't', axis: 'Z', direction: '-', searchMm: '5' }],
        },
        { kind: 'move', name: 'home', frame: 'start', to: { x: '0' } },
      ],
    }))
    const result = expandProbeRoutine(r, {}, ctxAt(start))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const b = result.expanded.steps[0]
    expect(b.kind).toBe('branch')
    if (b.kind !== 'branch') return
    expect(b.nominalArm).toBe('then')
    expect(b.touchDependent).toBe(false)
    expect(b.then.map((s) => s.number)).toEqual([2])
    expect(b.else.map((s) => s.number)).toEqual([3, 4])
    expect(result.expanded.steps[1].number).toBe(5)
    expect((result.expanded.steps[1] as ExpandedMoveStep).from).toEqual({ x: 130, y: 100, z: 20 })
    expect(describeExpandedStep(b)).toBe('1. if input.w >= 40 then step 2 else steps 3-4 (with these inputs: then)')
    // WO-2554 bounds XY seeks. Use an unreachable Z search to keep proving
    // both arms validate, including the unchosen arm's plain XY move.
    const off = expandProbeRoutine(r, { w: 10 }, ctxAt({ x: 288, y: 100, z: 2 }))
    expect(off.ok).toBe(false)
    // the then arm's move (step 2) is off the table too: both arms are reported
    expect(off.errors.map((e) => e.step)).toEqual([
      { number: 2, kind: 'move', name: 'far' },
      { number: 4, kind: 'touch', name: 't' },
    ])
  })
})

// ---------------------------------------------------------------------------

describe('WO-411 slice 2: the preview hash', () => {
  const start = { x: 100, y: 100, z: 20 }
  const base = () => expandProbeRoutine(FACTORY_BORE_CENTRE, { diameter: 40, topZ: 15 }, ctxAt(start))
  const hashOf = (r: ReturnType<typeof expandProbeRoutine>) => (r.ok ? r.expanded.hash : null)

  it('is stable for equal inputs', () => {
    expect(hashOf(base())).toBe(hashOf(base()))
    expect(hashOf(base())).toMatch(/^[0-9a-f]{64}$/)
  })

  it('changes when an input, the start, the tip radius, a profile value, the axis limits, the envelope or the routine changes', () => {
    const h = hashOf(base())
    expect(hashOf(expandProbeRoutine(FACTORY_BORE_CENTRE, { diameter: 40.1, topZ: 15 }, ctxAt(start)))).not.toBe(h)
    expect(hashOf(expandProbeRoutine(FACTORY_BORE_CENTRE, { diameter: 40, topZ: 15 }, ctxAt({ ...start, x: 101 })))).not.toBe(h)
    expect(hashOf(expandProbeRoutine(FACTORY_BORE_CENTRE, { diameter: 40, topZ: 15 }, ctxAt(start, { tipRadiusMm: 2 })))).not.toBe(h)
    expect(hashOf(expandProbeRoutine(FACTORY_BORE_CENTRE, { diameter: 40, topZ: 15 }, { ...ctxAt(start), probe: { ...config, fastFeed: 250 } }))).not.toBe(h)
    const limits = { x: { maxCutting: 900, maxRapid: 5000 }, y: { maxCutting: 900, maxRapid: 5000 }, z: { maxCutting: 900, maxRapid: 5000 } }
    expect(hashOf(expandProbeRoutine(FACTORY_BORE_CENTRE, { diameter: 40, topZ: 15 }, ctxAt(start, { axisLimits: limits })))).not.toBe(h)
    const bigger = deriveMachineEnvelopeFromConvention(
      { x: { homesToward: 'min', machineZeroAt: 'min' }, y: { homesToward: 'min', machineZeroAt: 'min' }, z: { homesToward: 'min', machineZeroAt: 'min' } },
      { x: 400, y: 300, z: 100 },
    )
    expect(hashOf(expandProbeRoutine(FACTORY_BORE_CENTRE, { diameter: 40, topZ: 15 }, { ...ctxAt(start), envelope: bigger }))).not.toBe(h)
    const edited: ProbeRoutine = { ...FACTORY_BORE_CENTRE, description: 'edited' }
    expect(hashOf(expandProbeRoutine(edited, { diameter: 40, topZ: 15 }, ctxAt(start)))).not.toBe(h)
  })

  it('the same hash when the defaulted input is given explicitly', () => {
    expect(hashOf(expandProbeRoutine(FACTORY_BORE_CENTRE, { topZ: 15 }, ctxAt(start))))
      .toBe(hashOf(expandProbeRoutine(FACTORY_BORE_CENTRE, { diameter: 20, topZ: 15 }, ctxAt(start))))
  })
})

// ---------------------------------------------------------------------------

describe('WO-411 slice 2: the preview sentences (section 6)', () => {
  it('renders the contract\'s move and touch sentences', () => {
    const r = valid(routine({
      steps: [
        { kind: 'calc', name: 'k', unit: 'mm', expr: '2 * 5' },
        { kind: 'move', name: 'a', frame: 'machine', to: { x: '-400', y: '-300' } },
        { kind: 'move', name: 'b', frame: 'machine', to: { x: '-412', y: '-300' } },
        { kind: 'touch', name: 'left', axis: 'X', direction: '-', searchMm: 'calc.k' },
        { kind: 'check', condition: { cmp: '>', left: 'touch.left.x', right: '-800' }, message: 'Too far.' },
      ],
    }))
    const result = expandProbeRoutine(r, {}, sampleMachineCtx)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(describeExpandedRoutine(result.expanded)).toEqual([
      '1. calc k = 2 * 5 (about 10 mm)',
      '2. move to machine X -400.0 Y -300.0 at 1000 mm/min',
      '3. move to machine X -412.0 Y -300.0 at 1000 mm/min',
      '4. probe toward X- up to 10 mm: search 400 then 50 mm/min, back off 2 mm',
      '5. check touch.left.x > -800; otherwise stop: Too far.',
    ])
  })

  it('renders in inches when asked, and names a rapid as a rapid', () => {
    const r = valid(routine({
      steps: [
        { kind: 'move', name: 'up', frame: 'machine', to: { z: '50.8' }, safeZ: '50.8' },
        { kind: 'move', name: 'over', frame: 'machine', to: { x: '127', y: '254' }, feed: 'rapid' },
      ],
    }))
    const result = expandProbeRoutine(r, {}, ctxAt({ x: 100, y: 100, z: 20 }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(describeExpandedRoutine(result.expanded, 'in')).toEqual([
      '1. move to machine Z 2 at 47.24 in/min',
      '2. rapid to machine X 5 Y 10 at 47.24 in/min',
    ])
  })
})
