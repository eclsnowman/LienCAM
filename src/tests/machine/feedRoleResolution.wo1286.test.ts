import { describe, expect, it } from 'vitest'
import { applyResolvedMoveFeed, resolveFeedrates } from '../../lib/cam/feedrates'
import { emitProgram } from '../../lib/post/emit'
import { UCCNC_CONFIG } from '../../lib/post/dialects/uccnc'
import { resolveCoolant, resolveSpindle } from '../../lib/post/resolve'
import type { PostInput, PostOperation } from '../../lib/post/types'
import { makeMachine, makeOp, makeTool, makeWcs, move } from '../post/helpers'

function postOp(): PostOperation {
  const machine = makeMachine()
  const tool = makeTool()
  const op = makeOp({
    toolpathMoves: [
      move({ type: 'rapid', x: 0, y: 0, z: 0, role: 'rapid' }),
      move({ type: 'feed', x: 50, y: 0, z: 0, role: 'fast_traverse' }),
      move({ type: 'feed', x: 60, y: 0, z: 0, role: 'finish' }),
    ],
  })
  return {
    op,
    tool,
    feeds: resolveFeedrates(tool, op.feedrateOverride, machine.rapidRate),
    spindle: resolveSpindle(op, tool, machine),
    coolant: resolveCoolant(tool, machine),
    moves: op.toolpathMoves ?? [],
  }
}

describe('WO-1286 deferred feed roles', () => {
  const tool = makeTool({
    feedsAndSpeeds: {
      default: {
        rpm: 10000,
        feedRate: 1000,
        plungeRate: 200,
        fastTraverseFeedrate: 8000,
        finishFeedrate: 700,
        depthOfCut: 3,
        stepover: 2,
      },
    },
  })
  const feeds = resolveFeedrates(tool, undefined, 5000)

  it('resolves deferred traverse and finish roles without weakening refusal', () => {
    expect(applyResolvedMoveFeed(
      { type: 'feed', x: 1, y: 2, z: -1, role: 'fast_traverse' },
      feeds,
    ).feed).toBe(5000)
    expect(applyResolvedMoveFeed(
      { type: 'feed', x: 1, y: 2, z: -1, role: 'finish' },
      feeds,
    ).feed).toBe(700)

    const explicit = { type: 'feed' as const, x: 1, y: 2, z: -1, role: 'finish' as const, feed: 321 }
    expect(applyResolvedMoveFeed(explicit, feeds)).toBe(explicit)
    const malformed = { type: 'feed' as const, x: 1, y: 2, z: -1, role: 'cut' as const }
    expect(applyResolvedMoveFeed(malformed, feeds)).toBe(malformed)
  })

  it('makes both deferred roles explicit in post output from the same table', () => {
    const input: PostInput = {
      machine: makeMachine(),
      setup: { wcs: makeWcs(), operations: [postOp()] },
    }
    const { lines } = emitProgram(input, UCCNC_CONFIG)
    expect(lines.find((line) => line.includes('X50'))).toBe('G1 X50 F5000')
    expect(lines.find((line) => line.includes('X60'))).toBe('X60 F2000')
  })
})
