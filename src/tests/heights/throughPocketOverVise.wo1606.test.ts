// WO-1606, carried from WO-1605's results: a through Pocket 2D whose vise sits
// UNDER the pocket came out 'ready' with 0 moves. Two questions, both answered
// on the real compute path: does the console say why, and is removing every
// move the right answer?
//
// Hand-worked expectation (docs/testing/SMART-HEIGHTS-CAMPAIGN.md, slice 3):
// the pocket (X 15..35, Y 10..30) is cut through the 12 mm auto stock, Bottom
// row = stock bottom - 0.5 = WCS -12.5. The vise top is the stock bottom, WCS
// -12. Only the last 0.5 mm of the cut would enter the vise; everything above
// it is ordinary pocketing the software can do. So the pocket is cut, and it
// stops at the vise top (WCS -12) instead of going 0.5 mm into it; the console
// names the vise.

import { describe, expect, it } from 'vitest'
import { useCamStore } from '../../store'
import {
  circleLoop, installRealToolpathWorker, isCutting, movesEnteringBox, rectLoop, runHeightScenario,
  type HeightScenario,
} from '../helpers/heightScenario'

installRealToolpathWorker()

const RAISE = 50
const TOL = 0.01

const scenario: HeightScenario = {
  part: {
    kind: 'sketch_2d', z: RAISE,
    loops: [rectLoop('outline', 0, 0, 60, 40), rectLoop('pocket', 15, 10, 35, 30), circleLoop('hole', 48, 20, 4)],
  },
  stock: { kind: 'auto', offsetXY: 5, offsetZTop: 12, offsetZBottom: 0 },
  operation: 'pocket_2d',
  loopIds: ['pocket'],
  bottomRow: { reference: 'stock_bottom', offsetMm: -0.5 },
  // The WO-1605 probe's vise: under the pocket.
  workholding: { name: 'Vise', min: { x: 10, y: 5, z: 0 }, max: { x: 40, y: 35, z: RAISE } },
}

async function run() {
  const reading = await runHeightScenario(scenario)
  const consoleLines = (useCamStore.getState() as unknown as { consoleEvents?: Array<{ message: string }> })
    .consoleEvents?.map(event => event.message) ?? []
  return { reading, consoleLines }
}

let runOnce: ReturnType<typeof run> | undefined

describe('WO-1606 Smart Heights: through Pocket 2D with the vise under the pocket', () => {
  it('case 89: the compute lands ready and the console says what the vise did to the path', async () => {
    const { reading, consoleLines } = await (runOnce ??= run())
    console.log(`[WO-1606 through pocket over vise] status ${reading.status}, ${reading.moves.length} moves; ` +
      `console: ${JSON.stringify(consoleLines.filter(line => /vise|workholding/i.test(line)))}`)
    expect(reading.status, reading.errorMessage).toBe('ready')
    expect(consoleLines.some(line => /Vise/.test(line)), 'a console line names the vise').toBe(true)
  }, 60_000)

  it.fails('case 90: the pocket is cut down to the vise top (WCS -12), not removed [SH-9]', async () => {
    const { reading } = await (runOnce ??= run())
    const cutting = reading.moves.filter(m => isCutting(m, 'pocket_2d'))
    expect(cutting.length, 'cutting moves').toBeGreaterThan(0)
    expect(Math.abs(reading.deepestCutZ - -12), `deepest cut ${reading.deepestCutZ}`).toBeLessThanOrEqual(TOL)
    expect(movesEnteringBox(reading.moves, reading.workholdingWcs!, 3).length, 'moves entering the vise').toBe(0)
  }, 60_000)
})
