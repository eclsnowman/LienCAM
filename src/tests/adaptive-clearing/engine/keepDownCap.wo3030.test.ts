// WO-3030 (WO-3019 item 8, card D): the MD-119 keep-down cap, one form at both sites, behind a
// switch that ships OFF (src/kernel/ops/adaptive/policy.ts ADAPTIVE_MOTION_SWITCHES.keepDownCapForm).
// OFF keeps per-site parity: the walker band is S/4 + tolerance, the routed traverse S/4 + 4 x arcTol.
// ON: both are S/4 + 4a. With arcTol = max(tolerance/4, 0.01) the two forms are the same number at
// tolerance >= 0.04 mm, so ON changes nothing at the stick's 0.05; at 0.01 the walker band widens to
// the traverse's and the H-pocket's worst keep-down detour (M-LINK-4) drops from 15.07 x the chord
// (WO-3019 measured) to under MD-119's 3.0 reference target.
// 1. The policy record: OFF is ADAPTIVE_POLICY itself; ON gives S/4 + 4a at both sites, and the
//    walker's number is bit-identical to OFF whenever 4 x arcTol = tolerance.
// 2. The production route (planChain = the store's computeOperationToolpath), H-pocket default row,
//    first adaptive step: ON at tolerance 0.05 plans exactly OFF's moves; ON at 0.01 brings M-LINK-4
//    under 3.0 with M-SAFE-2 no worse than OFF.
import { describe, expect, it, vi } from 'vitest'
import { typedMock } from '../../support/typedMock'
import { ADAPTIVE_POLICY, KEEP_DOWN_CAP_SWITCH_FORM, adaptiveEngageMoveDistance, adaptiveKeepDownCapPolicy } from '../../../kernel/ops/adaptive/policy'
import { planChain, scoreChain } from '../../benchmark/chainRunner'
import { alpha3Chains } from '../../benchmark/registry'

const switchState = vi.hoisted(() => ({ on: true }))
vi.mock('../../../kernel/ops/adaptive/policy', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../kernel/ops/adaptive/policy')>()
  return typedMock<typeof import('../../../kernel/ops/adaptive/policy')>({
    ...real,
    ADAPTIVE_MOTION_SWITCHES: {
      get keepDownCapForm() { return switchState.on },
      steeringSmoothing: false, // WO-3042 switch, OFF here
      keepDownLinksSmooth: false, // WO-3037 switch, OFF here
    },
  })
})

const LINK_TARGET = 3.0 // MD-119 / WO-3019 item 8: the reference target for the worst keep-down detour
const hPocketAt = (tolerance: number) => {
  const chain = alpha3Chains().find(c => c.id === 'engagement-pocket-adaptive_clearing_2d-default')!
  const step = chain.steps.find(s => s.id === 'adaptive_clearing_2d')!
  return { ...chain, id: `${chain.id}-tol${tolerance}`, steps: [{ ...step, params: { ...step.params, tolerance } }] }
}
const planWith = async (on: boolean, tolerance: number) => {
  switchState.on = on
  try {
    const chain = hPocketAt(tolerance)
    const planned = await planChain(chain)
    return { planned, row: (await scoreChain(chain, planned)).rows[0] }
  } finally {
    switchState.on = true
  }
}
const metric = (row: { metrics: Record<string, unknown> }, key: string) => row.metrics[key] as number

describe('WO-3030 keep-down cap: S/4 + 4a at both sites (switch, ships OFF)', () => {
  it('ships OFF', async () => {
    const real = await vi.importActual<typeof import('../../../kernel/ops/adaptive/policy')>('../../../kernel/ops/adaptive/policy')
    expect(real.ADAPTIVE_MOTION_SWITCHES.keepDownCapForm).toBe(false)
    expect(Object.isFrozen(real.ADAPTIVE_MOTION_SWITCHES)).toBe(true)
  })

  it('the record: OFF is today\'s per-site parity, ON is S/4 + 4a at both sites', () => {
    expect(adaptiveKeepDownCapPolicy(false)).toBe(ADAPTIVE_POLICY)
    const on = adaptiveKeepDownCapPolicy(true)
    expect(KEEP_DOWN_CAP_SWITCH_FORM).toBe('S/4 + 4a')
    expect(on.traverseCap.form).toBe('S/4 + 4a')
    expect(Object.isFrozen(on) && Object.isFrozen(on.traverseCap)).toBe(true)
    expect({ ...on, traverseCap: { ...on.traverseCap, form: 'per-site' } }).toEqual(ADAPTIVE_POLICY)
    for (const [stepOver, tolerance] of [[3, 0.01], [1, 0.02], [2.4, 0.05], [1.6, 0.1]]) {
      const arcTol = Math.max(tolerance * ADAPTIVE_POLICY.sampling.arcTolFraction, ADAPTIVE_POLICY.sampling.arcTolFloorMm)
      for (const site of ['walker', 'traverse'] as const) {
        expect(adaptiveEngageMoveDistance(site, stepOver, site === 'walker' ? tolerance : undefined, arcTol, on)).toBe(stepOver / 4 + 4 * arcTol)
      }
      // The traverse never moves; the walker moves only below tolerance 0.04 mm.
      expect(adaptiveEngageMoveDistance('traverse', stepOver, undefined, arcTol, on))
        .toBe(adaptiveEngageMoveDistance('traverse', stepOver, undefined, arcTol, adaptiveKeepDownCapPolicy(false)))
      const walkerOff = adaptiveEngageMoveDistance('walker', stepOver, tolerance, arcTol, adaptiveKeepDownCapPolicy(false))
      const walkerOn = adaptiveEngageMoveDistance('walker', stepOver, tolerance, arcTol, on)
      if (tolerance >= 0.04) expect(walkerOn).toBe(walkerOff)
      else expect(walkerOn).toBeGreaterThan(walkerOff)
    }
  })

  it('switch ON at tolerance 0.05: the H-pocket plans exactly the moves OFF plans', async () => {
    const off = await planWith(false, 0.05)
    const on = await planWith(true, 0.05)
    expect(on.planned.steps[0].status).toBe('ready')
    expect(on.planned.steps[0].moves.length).toBeGreaterThan(0)
    expect(on.planned.steps[0].moves).toEqual(off.planned.steps[0].moves)
  }, 600_000)

  it('switch ON at tolerance 0.01: the worst keep-down detour (M-LINK-4) is under 3.0, M-SAFE-2 no worse', async () => {
    const off = await planWith(false, 0.01)
    const on = await planWith(true, 0.01)
    expect(on.planned.steps[0].status).toBe('ready')
    expect(metric(on.row, 'M-SAFE-2'), 'M-SAFE-2 ON vs OFF').toBeLessThanOrEqual(metric(off.row, 'M-SAFE-2'))
    expect(metric(on.row, 'M-LINK-4'), `M-LINK-4 (OFF ${metric(off.row, 'M-LINK-4')})`).toBeLessThanOrEqual(LINK_TARGET)
  }, 600_000)
})
