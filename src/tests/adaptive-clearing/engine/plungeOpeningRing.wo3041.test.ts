// WO-3041: adaptive with a plunge entry clears the pocket. A plunge opens a hole one tool wide and
// every first pass out of it is a full slot, so the declared H-pocket (plunge entry, 6 mm then
// 3 mm flat, 1 mm stepover) cut nothing (WO-3024 finding). With the switch ON the plunge is kept
// and an opening ring grows the hole at depth to the disk a default helix would open; the walker
// takes over from there. The switch ships OFF (src/kernel/ops/adaptive/policy.ts), and OFF plans
// exactly what main plans.
// 1. The ring itself: starts at the plunge point, ends on the seed's opening point, turns in the
//    milling sense, and its sustained width (the engine's own contourOverCap) stays under the
//    75%-of-slot ceiling.
// 2. The production route (planChain = the store's computeOperationToolpath), switch ON: the
//    declared H-pocket's 6 mm step has cutting moves, its first entry is a straight plunge, and
//    the stick's engagement measure stays under the ceiling. Switch OFF: today's zero-move notice.
// 3. The committed evidence (src/tests/evidence/WO-3041/): every WO-3024 table cell cuts with the
//    switch ON and its opening ring stays under the ceiling, and the whole stick with the switch OFF
//    is the same as main.
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../../support/typedMock'
import { diskPath, ensureEngineClipperReady } from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { contourOverCap, planPlungeOpeningRing } from '../../../lib/cam/adaptiveClearing2d/engine/processFeature'
import { planChain, scoreChain } from '../../benchmark/chainRunner'
import { alpha3Chains } from '../../benchmark/registry'

const switchState = vi.hoisted(() => ({ on: true }))
vi.mock('../../../kernel/ops/adaptive/policy', async (importOriginal) => typedMock<typeof import('../../../kernel/ops/adaptive/policy')>({
  ...(await importOriginal<typeof import('../../../kernel/ops/adaptive/policy')>()),
  ADAPTIVE_MOTION_SWITCHES: { get plungeOpeningRing() { return switchState.on }, keepDownCapForm: false },
}))

const EVIDENCE = 'src/tests/evidence/WO-3041'
const CEILING = 0.75 // AP.caps.slotCeilingDiameters: sustained width as a fraction of a full slot
const declaredStep = (stepId: string) => {
  const chain = alpha3Chains().find(c => c.id === 'engagement-pocket-adaptive_clearing_2d-declared')!
  return { ...chain, steps: chain.steps.filter(step => step.id === stepId) }
}

describe('WO-3041 plunge-entry opening ring (switch, ships OFF)', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })

  it('ships OFF', async () => {
    const real = await vi.importActual<typeof import('../../../kernel/ops/adaptive/policy')>('../../../kernel/ops/adaptive/policy')
    expect(real.ADAPTIVE_MOTION_SWITCHES.plungeOpeningRing).toBe(false)
    expect(Object.isFrozen(real.ADAPTIVE_MOTION_SWITCHES)).toBe(true)
  })

  it('the ring leaves the plunge hole under the slot ceiling and ends where the walk starts', () => {
    const centre = { x: 45, y: 30 }
    const toolRadius = 3
    const arcTol = 0.0125
    const hole = diskPath(centre, toolRadius, arcTol)
    for (const [stepOverDistance, forwardTravel] of [[1, true], [2.4, false], [3, true]] as const) {
      const ring = planPlungeOpeningRing(centre, 2.7, toolRadius, stepOverDistance, forwardTravel, arcTol, hole)
      expect(ring, `stepover ${stepOverDistance}: a ring is planned`).not.toBeNull()
      const path = ring!
      expect(path[0]).toEqual(centre)
      const end = path[path.length - 1]
      expect(end.x).toBeCloseTo(centre.x, 9)
      expect(end.y).toBeCloseTo(centre.y - 2.7, 9)
      // Milling sense: material-right (climb) travel turns counter-clockwise round the hole.
      let turned = 0
      for (let i = 2; i < path.length; i++) {
        const a = Math.atan2(path[i - 1].y - centre.y, path[i - 1].x - centre.x)
        const b = Math.atan2(path[i].y - centre.y, path[i].x - centre.x)
        turned += Math.atan2(Math.sin(b - a), Math.cos(b - a))
      }
      expect(Math.sign(turned)).toBe(forwardTravel ? 1 : -1)
      const measured = contourOverCap(path, hole, toolRadius, CEILING * 2 * toolRadius, arcTol, true)
      expect(measured.overLen, `stepover ${stepOverDistance}: no sustained window over the ceiling`).toBe(0)
      expect(measured.peak / (2 * toolRadius)).toBeLessThanOrEqual(CEILING)
    }
    expect(planPlungeOpeningRing(centre, 0, toolRadius, 1, true, arcTol, hole)).toBeNull()
  })

  it('switch ON: the plunge-entry H-pocket has cutting moves, entered by the operator\'s plunge, under the ceiling', async () => {
    switchState.on = true
    const chain = declaredStep('adaptive_clearing_2d')
    const planned = await planChain(chain)
    const step = planned.steps[0]
    const cutting = step.moves.filter(m => m.role === 'cut').length
    expect(cutting, 'plunge-entry H-pocket has cutting moves').toBeGreaterThan(0)
    expect({ status: step.status, text: step.operatorText }).toEqual({ status: 'ready', text: '' })
    // The first move into the stock is a straight plunge (no helix, no ramp): the entry is kept.
    expect(step.moves.some(m => m.role === 'helix' || m.role === 'ramp')).toBe(false)
    const first = step.moves.findIndex(m => m.role === 'plunge')
    expect(first).toBeGreaterThan(0)
    expect(Math.hypot(step.moves[first].x - step.moves[first - 1].x, step.moves[first].y - step.moves[first - 1].y)).toBeLessThan(1e-9)
    const row = (await scoreChain(chain, planned)).rows[0]
    expect(row.metrics.peakEngagementFraction as number, 'peak sustained engagement').toBeLessThanOrEqual(CEILING)
  }, 600_000)

  it('switch OFF: the same step plans what main plans (nothing, and says why)', async () => {
    switchState.on = false
    try {
      const planned = await planChain(declaredStep('adaptive_clearing_2d'))
      expect({ status: planned.steps[0].status, moves: planned.steps[0].moves.length, text: planned.steps[0].operatorText }).toEqual({
        status: 'error', moves: 0,
        text: 'Adaptive Clearing cut nothing because every first pass out of the plunge entry\'s tool-wide hole would overload the 6 mm tool at a 1 mm stepover.',
      })
    } finally {
      switchState.on = true
    }
  }, 120_000)

  it('committed evidence: every WO-3024 cell cuts with the switch ON, ring under the ceiling; the stick with it OFF is main', () => {
    const cells = JSON.parse(readFileSync(`${EVIDENCE}/cells.json`, 'utf8')) as {
      cells: { tool: string; stepoverMm: number; off: { moves: number; peakEngagementFraction: number | null }
        on: { status: string; cuttingMoves: number; peakEngagementFraction: number; ringPeakEngagementFraction: number } }[]
    }
    expect(cells.cells.length).toBe(10)
    for (const cell of cells.cells) {
      const name = `${cell.tool} @ ${cell.stepoverMm} mm`
      expect(cell.on.status, name).toBe('ready')
      expect(cell.on.cuttingMoves, `${name}: plunge-entry H-pocket has cutting moves`).toBeGreaterThan(0)
      expect(cell.on.ringPeakEngagementFraction, `${name}: the opening ring's peak`).toBeLessThanOrEqual(CEILING)
      const diameter = Number.parseFloat(cell.tool)
      if (cell.stepoverMm <= CEILING * diameter) {
        expect(cell.on.peakEngagementFraction, `${name}: peak`).toBeLessThanOrEqual(CEILING)
      } else {
        // The operator's own stepover is over the ceiling (2.4 and 3 mm on the 3 mm tool), so the walker's
        // passes are too, with or without the switch; the switch adds nothing above what OFF already plans.
        expect(cell.off.peakEngagementFraction, `${name}: OFF already cuts`).not.toBeNull()
        expect(cell.on.peakEngagementFraction - cell.off.peakEngagementFraction!, `${name}: peak vs OFF`).toBeLessThanOrEqual(0.03)
      }
    }
    const identity = JSON.parse(readFileSync(`${EVIDENCE}/stick-off-identity.json`, 'utf8')) as {
      p0: { chains: number; differences: number }; adaptiveRows: { before: unknown; after: unknown }[]
    }
    expect(identity.p0.differences, 'switch OFF: P0 non-timing differences vs main').toBe(0)
    expect(identity.p0.chains).toBe(alpha3Chains().length)
    for (const row of identity.adaptiveRows) expect(row.after).toEqual(row.before)
  })
})
