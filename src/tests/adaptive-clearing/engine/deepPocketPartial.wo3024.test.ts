// WO-3024 (A): the declared H-pocket row (6 mm and 3 mm flats, 1 mm stepover, plunge entry,
// 16 -> 4 in 2 mm levels) planned through the app's own chain runner (planChain = the store's
// computeOperationToolpath). Before this order both adaptive steps came back status Ready
// with 0 moves and empty operator text. A plunge opens a hole one tool wide and every first
// pass out of it is a slot the load limit refuses, so nothing is cut; the operation must say
// that in one line and never read Ready with an empty program (rule 11).
import { describe, expect, it } from 'vitest'
import { planChain } from '../../benchmark/chainRunner'
import { alpha3Chains } from '../../benchmark/registry'

describe('WO-3024 declared H-pocket: an adaptive op that cuts nothing says why', () => {
  it('each adaptive step either cuts or ends non-Ready naming the plunge entry', async () => {
    const chain = alpha3Chains().find(c => c.id === 'engagement-pocket-adaptive_clearing_2d-declared')!
    expect(chain.steps.map(step => step.id)).toEqual(['adaptive_clearing_2d', 'adaptive_clearing_2d-tool2'])
    const planned = await planChain(chain)
    for (const step of planned.steps) {
      const outcome = { step: step.stepId, status: step.status, moves: step.moves.length, text: step.operatorText }
      if (step.moves.length > 0) continue
      expect(outcome, 'the declared H-pocket has cutting moves / a non-Ready notice').toMatchObject({
        status: 'error',
        text: expect.stringMatching(/^Adaptive Clearing cut nothing because every first pass out of the plunge entry's tool-wide hole would overload the (6|3) mm tool at a 1 mm stepover\.$/),
      })
    }
  }, 120_000)
})
