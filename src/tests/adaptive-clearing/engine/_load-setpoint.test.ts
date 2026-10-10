// Pinning test for the load setpoint (ProcessParams.loadSetpoint / StepperOptions.loadSetpoint).
//
// The steering search aims at a SYMMETRIC accept band around the target load. Aiming the band
// exactly at optimal lets ~40% of accepted steps land ABOVE optimal (the upper half of the band).
// The setpoint shift scales the search's target to 0.95*optimal -- keeping the symmetric search
// untouched -- so realized load holds AT/under optimal.
//
// These assertions are ROBUST to engine nondeterminism: they assert an AGGREGATE property
// (fraction of accepted cutting steps whose areaPerDist exceeds optimal), never exact
// coordinates. The synthetic cleared half-plane gives many independent steering steps with a
// well-defined "optimal" load (the straight-ahead full-edge bite), so the over-optimal fraction
// is meaningful.

import { describe, it, expect, beforeAll } from 'vitest'
import { ensureEngineClipperReady, type Loops } from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { createToolGeometry } from '../../../lib/cam/adaptiveClearing2d/engine/toolGeometry'
import { createStepper } from '../../../lib/cam/adaptiveClearing2d/engine/steering'

// cleared = a big half-plane below y=0; the tool rides the edge. Straight-ahead motion takes a
// full-edge bite (the "optimal" load here); deflecting up reduces it, deflecting down raises it.
const cleared: Loops = [[{ x: -500, y: -500 }, { x: 500, y: -500 }, { x: 500, y: 0 }, { x: -500, y: 0 }]]

/** Run many independent steering steps holding `optimal` as the target load, from a spread of
 *  start positions, and aggregate the ACCEPTED cutting moves: fraction whose realized load
 *  exceeds optimal, the count, and the mean realized load. `setpoint` is the loadSetpoint the
 *  stepper is built with. Each start resets momentum so the steps are independent samples. */
function aggregate(setpoint: number, optimal: number): { overFrac: number; n: number; meanLoad: number } {
  const tool = createToolGeometry(2.0, 0.4)
  const stepper = createStepper(tool, { maxErrorRel: 0.05, loadSetpoint: setpoint })
  const step = 0.5
  let over = 0
  let n = 0
  let sumLoad = 0
  for (let xi = 0; xi < 20; xi++) {
    stepper.resetHistory()
    let pos = { x: -50 + xi * 5, y: 0 }
    let dir = { x: 1, y: 0 }
    for (let k = 0; k < 8; k++) {
      const r = stepper.findNextPoint(cleared, pos, dir, step, optimal)
      if (r.area > 0) {
        n++
        sumLoad += r.areaPerDist
        if (r.areaPerDist > optimal + 1e-9) over++
        pos = r.toolPos
        dir = r.toolDir
      } else break
    }
  }
  return { overFrac: n > 0 ? over / n : 0, n, meanLoad: n > 0 ? sumLoad / n : 0 }
}

describe('load setpoint holds realized cutting load at/under optimal', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })

  it('with loadSetpoint=0.95 essentially no accepted cut step exceeds optimal', () => {
    const tool = createToolGeometry(2.0, 0.4)
    const optimal = tool.cutArea({ x: 0, y: 0 }, { x: 0.5, y: 0 }, cleared).areaPerDist
    expect(optimal).toBeGreaterThan(0)

    const { overFrac, n } = aggregate(0.95, optimal)
    expect(n).toBeGreaterThan(20) // enough samples for the fraction to mean something
    expect(overFrac).toBeLessThan(0.02) // ~0% over optimal (tiny epsilon for facet noise)
  }, 60_000)

  it('the setpoint is wired and not a no-op: 0.95 holds the mean load strictly below optimal '
    + 'and strictly below the unshifted (=1.0) mean', () => {
    const tool = createToolGeometry(2.0, 0.4)
    const optimal = tool.cutArea({ x: 0, y: 0 }, { x: 0.5, y: 0 }, cleared).areaPerDist

    const shifted = aggregate(0.95, optimal)
    const unshifted = aggregate(1.0, optimal)

    // The shift actually lowers the realized load (guards against loadSetpoint silently
    // becoming a no-op), and 0.95 keeps the mean realized load under optimal.
    expect(shifted.meanLoad).toBeLessThan(optimal)
    expect(shifted.meanLoad).toBeLessThan(unshifted.meanLoad)
  }, 60_000)
})
