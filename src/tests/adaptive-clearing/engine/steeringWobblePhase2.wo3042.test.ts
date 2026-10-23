// WO-3042 (WO-3029 phase 2, card C): the adaptive steering wobble smoothing, behind one switch that
// ships OFF (src/kernel/ops/adaptive/policy.ts ADAPTIVE_MOTION_SWITCHES.steeringSmoothing).
// 1. Ships OFF; OFF is today's stepper to the bit.
// 2. The stepper rules on the real stepper (steering.ts): B, the first guess is corrected toward the
//    load target instead of being kept anywhere in the band; C, a move the caller replaced is what the
//    momentum learns.
// 3. The production route (planChain = the store's computeOperationToolpath), H-pocket 2D default row,
//    every adaptive step: switch ON at least halves the stick's emitted flips, with engagement no higher,
//    M-SAFE-2 no worse and the machined area unchanged within tolerance (net shape). M-SAFE-2 is a
//    keep-down link router number (WO-3037): an earlier ON source raised it 2 -> 5 mm on this row
//    (src/tests/evidence/WO-3042/, Worker result); this pins that the final source does not.
// The six-row measurement (WO-3029's probe, switch ON and OFF) is src/tests/evidence/WO-3042/.
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../../support/typedMock'
import { ensureEngineClipperReady, type Loops } from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { createToolGeometry } from '../../../lib/cam/adaptiveClearing2d/engine/toolGeometry'
import { createStepper, type StepDecision } from '../../../lib/cam/adaptiveClearing2d/engine/steering'
import { STEERING_SMOOTHING } from '../../../kernel/ops/adaptive/policy'
import { planChain, scoreChain } from '../../benchmark/chainRunner'
import { alpha3Chains } from '../../benchmark/registry'

type PolicyModule = typeof import('../../../kernel/ops/adaptive/policy')
const switchState = vi.hoisted(() => ({ on: true }))
vi.mock('../../../kernel/ops/adaptive/policy', async (importOriginal) => {
  const real = await importOriginal<PolicyModule>()
  return typedMock<PolicyModule>({
    ...real,
    ADAPTIVE_MOTION_SWITCHES: {
      ...real.ADAPTIVE_MOTION_SWITCHES,
      get steeringSmoothing() { return switchState.on },
    },
  })
})

const H_POCKET = 'engagement-pocket-adaptive_clearing_2d-default'
type Row = { stepId: string; status: string; metrics: Record<string, unknown> }
const plan = async (on: boolean) => {
  switchState.on = on
  try {
    const chain = alpha3Chains().find(c => c.id === H_POCKET)!
    const planned = await planChain(chain)
    return { planned, rows: (await scoreChain(chain, planned)).rows as Row[] }
  } finally {
    switchState.on = true
  }
}
const metric = (row: Row, key: string) => {
  const m = row.metrics[key] as { value?: number } | number
  return typeof m === 'number' ? m : m.value as number
}

describe('WO-3042 steering smoothing switch', () => {
  it('ships OFF', async () => {
    const real = await vi.importActual<PolicyModule>('../../../kernel/ops/adaptive/policy')
    expect(real.ADAPTIVE_MOTION_SWITCHES.steeringSmoothing).toBe(false)
    expect(Object.isFrozen(real.ADAPTIVE_MOTION_SWITCHES)).toBe(true)
    expect(Object.isFrozen(real.STEERING_SMOOTHING)).toBe(true)
  })
})

describe('WO-3042 the stepper rules (real stepper, half-plane edge fixture of steering.test.ts)', () => {
  // cleared = a half-plane below y=0; the tool rides its edge heading +x.
  const cleared: Loops = [[{ x: -200, y: -200 }, { x: 200, y: -200 }, { x: 200, y: 0 }, { x: -200, y: 0 }]]
  const tool = () => createToolGeometry(2.0, 0.2)
  const smoothing = { gain: STEERING_SMOOTHING.correctionGain, maxCorrection: STEERING_SMOOTHING.maxCorrectionFraction * Math.PI / 4 }
  beforeAll(async () => { await ensureEngineClipperReady() })

  // Two steps: the first searches (it measures this pass's load-per-angle slope), the second starts
  // from a load 4% over the aim - inside the 5% band, so today's stepper keeps that guess as it is.
  const twoSteps = (opts: { smoothing?: typeof smoothing }) => {
    const t = tool()
    const step = 0.5
    const straight = t.cutArea({ x: 0, y: 0 }, { x: step, y: 0 }, cleared).areaPerDist
    const decisions: StepDecision[] = []
    const stepper = createStepper(t, { ...opts, onDecision: d => { decisions.push(d) } })
    stepper.resetHistory()
    // Step 1 aims 20% under straight-ahead: out of band, a search.
    const r1 = stepper.findNextPoint(cleared, { x: 0, y: 0 }, { x: 1, y: 0 }, step, straight * 0.8 / 0.95)
    // Step 2 aims at 1/1.04 of what step 1 measured.
    stepper.findNextPoint(cleared, r1.toolPos, r1.toolDir, step, r1.areaPerDist / 1.04 / 0.95)
    return decisions
  }

  it('OFF (no smoothing option): the in-band first guess is the plain momentum, uncorrected', () => {
    const [d1, d2] = twoSteps({})
    expect(d1.probes.length).toBeGreaterThan(1)
    expect(d2.predictedAngle).toBe(d1.probes[d1.acceptedIndex].angle)
  })

  // A wall ride: 80 steps along the half-plane edge holding a constant target under straight-ahead.
  const ride = (opts: { smoothing?: typeof smoothing }, step: number, frac: number) => {
    const t = tool()
    const straight = t.cutArea({ x: 0, y: 0 }, { x: step, y: 0 }, cleared).areaPerDist
    const decisions: StepDecision[] = []
    const stepper = createStepper(t, { ...opts, onDecision: d => { decisions.push(d) } })
    stepper.resetHistory()
    let pos = { x: 0, y: 0 }, dir = { x: 1, y: 0 }
    for (let i = 0; i < 80; i++) {
      const r = stepper.findNextPoint(cleared, pos, dir, step, straight * frac / 0.95)
      pos = r.toolPos; dir = r.toolDir
    }
    return decisions
  }

  it('B ON: the first guess is corrected toward the load target, by at most maxCorrection', () => {
    const [d1off, d2off] = twoSteps({})
    const [d1, d2] = twoSteps({ smoothing })
    expect(d1.probes).toEqual(d1off.probes) // the search itself is unchanged
    expect(d2.predictedAngle).not.toBe(d2off.predictedAngle)
    expect(Math.abs(d2.predictedAngle - d2off.predictedAngle)).toBeLessThanOrEqual(smoothing.maxCorrection + 1e-12)
  })

  it('B ON: on a wall ride the first guess holds the band, so far fewer steps fall back to a search (a kink)', () => {
    let off = 0, on = 0
    for (const step of [0.1, 0.3]) {
      for (const frac of [0.7, 0.9]) {
        off += ride({}, step, frac).filter(d => d.probes.length > 1).length
        on += ride({ smoothing }, step, frac).filter(d => d.probes.length > 1).length
      }
    }
    expect(on, `searched steps ON vs OFF ${off}`).toBeLessThanOrEqual(off * 0.7)
  })

  it('C ON: a move the caller replaced (departure clamp) is what the momentum learns', () => {
    const t = tool()
    const step = 0.5
    const straight = t.cutArea({ x: 0, y: 0 }, { x: step, y: 0 }, cleared).areaPerDist
    const run = (record: boolean) => {
      const decisions: StepDecision[] = []
      const stepper = createStepper(t, { smoothing, onDecision: d => { decisions.push(d) } })
      stepper.resetHistory()
      const r1 = stepper.findNextPoint(cleared, { x: 0, y: 0 }, { x: 1, y: 0 }, step, straight * 0.8 / 0.95)
      if (record) stepper.recordTakenDeflection(0.01, r1.areaPerDist)
      stepper.findNextPoint(cleared, { x: 0.5, y: 0 }, { x: 1, y: 0 }, step, straight * 0.8 / 0.95)
      return decisions
    }
    const asked = run(false)
    const taken = run(true)
    expect(asked[1].predictedAngle - asked[0].probes[asked[0].acceptedIndex].angle)
      .toBeCloseTo(taken[1].predictedAngle - 0.01, 12)
  })

  it('C ON: after a step that accepted no move, a replaced move changes nothing the stepper learned', () => {
    const t = tool()
    const step = 0.5
    const straight = t.cutArea({ x: 0, y: 0 }, { x: step, y: 0 }, cleared).areaPerDist
    const everywhere: Loops = [[{ x: -500, y: -500 }, { x: 500, y: -500 }, { x: 500, y: 500 }, { x: -500, y: 500 }]]
    const run = (record: boolean) => {
      const decisions: StepDecision[] = []
      const stepper = createStepper(t, { smoothing, onDecision: d => { decisions.push(d) } })
      stepper.resetHistory()
      stepper.findNextPoint(cleared, { x: 0, y: 0 }, { x: 1, y: 0 }, step, straight * 0.8 / 0.95)
      const air = stepper.findNextPoint(everywhere, { x: 0.5, y: 0 }, { x: 1, y: 0 }, step, straight * 0.8 / 0.95)
      expect(air.area).toBe(0)
      if (record) stepper.recordTakenDeflection(0.3, 9)
      stepper.findNextPoint(cleared, { x: 0.5, y: 0 }, { x: 1, y: 0 }, step, straight * 0.8 / 0.95)
      return decisions.at(-1)!.predictedAngle
    }
    expect(run(true)).toBe(run(false))
  })
})

describe('WO-3042 production route, H-pocket 2D default row (switch ON vs OFF)', () => {
  let off: Awaited<ReturnType<typeof plan>>
  let on: Awaited<ReturnType<typeof plan>>
  beforeAll(async () => {
    off = await plan(false)
    on = await plan(true)
  }, 600_000)

  it('every adaptive step plans ready with the switch ON', () => {
    expect(on.rows.length).toBe(off.rows.length)
    for (const row of on.rows) expect(row.status, row.stepId).toBe('ready')
  })

  it('switch ON at least halves the emitted steering flips on every adaptive step, flip rate <= 10%', () => {
    for (const row of on.rows) {
      const before = off.rows.find(r => r.stepId === row.stepId)!
      const flips = metric(row, 'flips')
      expect(flips, `${row.stepId} flips ON vs OFF ${metric(before, 'flips')}`).toBeLessThanOrEqual(metric(before, 'flips') / 2)
      expect(metric(row, 'flipRatePct'), row.stepId).toBeLessThanOrEqual(10)
    }
  })

  it('engagement no higher than OFF (the engine cap, or OFF where OFF already exceeds it), M-SAFE-2 no worse, machined area unchanged within tolerance', () => {
    for (const row of on.rows) {
      const before = off.rows.find(r => r.stepId === row.stepId)!
      const peak = metric(row, 'peakEngagementFraction')
      if (peak !== null) {
        expect(peak, row.stepId).toBeLessThanOrEqual(Math.max(metric(row, 'engagementCapFraction'), metric(before, 'peakEngagementFraction')))
        expect(metric(row, 'engagementOverCapLengthMm'), row.stepId).toBeLessThanOrEqual(metric(before, 'engagementOverCapLengthMm'))
      }
      expect(metric(row, 'M-SAFE-2'), `${row.stepId} M-SAFE-2`).toBeLessThanOrEqual(metric(before, 'M-SAFE-2'))
      const machined = metric(row, 'machinedAreaMm2')
      expect(Math.abs(machined - metric(before, 'machinedAreaMm2')) / metric(before, 'machinedAreaMm2'), row.stepId).toBeLessThan(0.005)
    }
  })
})
