// WO-3270: an Adaptive 2D helix entry follows its rapid with a descending move, so the entry
// classifier counts it. 4e4d9f2d98 (WO-3083) moved the helix start to material + 1, reached by
// rapid; the spiral's first point is that same point, so a zero-length feed stood between the
// rapid and the descent and entrySpans counted no helix entry at all.

import { describe, expect, it } from 'vitest'
import type { ToolpathMove } from '../../types'
import { circleLoop, installRealToolpathWorker, rectLoop, runHeightScenario } from '../helpers/heightScenario'
import { entrySpans } from '../../kernel/entry'

installRealToolpathWorker()

const EPS = 1e-6
const zeroLength = (a: ToolpathMove, b: ToolpathMove) =>
  Math.abs(a.x - b.x) <= EPS && Math.abs(a.y - b.y) <= EPS && Math.abs(a.z - b.z) <= EPS

describe('WO-3270 Adaptive 2D entry is counted', () => {
  it('no zero-length feed follows a rapid, and every helix entry is counted as a helix', async () => {
    const reading = await runHeightScenario({
      part: { kind: 'sketch_2d', loops: [rectLoop('outline', 0, 0, 60, 40), rectLoop('pocket', 15, 10, 35, 30), circleLoop('hole', 48, 20, 4)], z: 50 },
      stock: { kind: 'auto', offsetXY: 5, offsetZTop: 12, offsetZBottom: 0 },
      operation: 'adaptive_clearing_2d', loopIds: ['pocket'],
    })
    expect(reading.status).toBe('ready')
    const moves = reading.moves
    const helixStarts: number[] = []
    const zeroAfterRapid: number[] = []
    for (let i = 1; i < moves.length; i++) {
      if (moves[i - 1].type !== 'rapid' || moves[i].type === 'rapid') continue
      if (moves[i].role === 'helix') helixStarts.push(i)
      if (zeroLength(moves[i - 1], moves[i])) zeroAfterRapid.push(i)
    }
    expect(helixStarts.length).toBeGreaterThan(0)
    expect(zeroAfterRapid).toEqual([])
    const spans = entrySpans(moves)
    const helixSpans = spans.filter(s => s.entryClass === 'helix').map(s => s.start)
    expect(helixSpans).toEqual(helixStarts)
  })
})
