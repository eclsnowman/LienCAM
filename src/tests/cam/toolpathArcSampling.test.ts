import { describe, expect, it } from 'vitest'
import { sampleArcMovesForLinearConsumers } from '../../lib/cam/toolpathArcSampling'
import type { ToolpathMove } from '../../types'

function move(over: Partial<ToolpathMove>): ToolpathMove {
  return { type: 'feed', x: 0, y: 0, z: 0, ...over }
}

function maxSegmentLen(moves: ToolpathMove[]): number {
  let max = 0
  for (let i = 1; i < moves.length; i++) {
    max = Math.max(max, Math.hypot(
      moves[i].x - moves[i - 1].x,
      moves[i].y - moves[i - 1].y,
      moves[i].z - moves[i - 1].z,
    ))
  }
  return max
}

describe('sampleArcMovesForLinearConsumers', () => {
  it('linearizes a 180 degree bore arc instead of leaving a diameter chord', () => {
    const moves = [
      move({ x: 3, y: 0, z: -2, role: 'finish' }),
      move({ type: 'arc_cw', x: -3, y: 0, z: -2, cx: 0, cy: 0, role: 'finish', feed: 700 }),
    ]
    const sampled = sampleArcMovesForLinearConsumers(moves, { maxChordMm: 0.35 })

    expect(sampled.length).toBeGreaterThan(2)
    expect(sampled[sampled.length - 1]).toMatchObject({ x: -3, y: 0, z: -2, role: 'finish', type: 'feed' })
    expect(maxSegmentLen(sampled)).toBeLessThanOrEqual(0.36)
    for (const m of sampled) expect(Math.hypot(m.x, m.y)).toBeCloseTo(3, 6)
  })

  it('preserves non-arc moves byte-for-byte', () => {
    const moves = [
      move({ type: 'rapid', x: 0, y: 0, z: 5, role: 'rapid' }),
      move({ type: 'feed', x: 1, y: 0, z: 0, role: 'plunge', feed: 200 }),
    ]
    expect(sampleArcMovesForLinearConsumers(moves)).toEqual(moves)
  })

  // PP-MOVE-PICK: the optional originIndices out-array lets a consumer that
  // raycasts a SAMPLED segment recover which ORIGINAL move produced it.
  describe('originIndices out-array (PP-MOVE-PICK move-pick attribution)', () => {
    it('maps every expanded arc point back to the arc source index', () => {
      const moves = [
        move({ x: 3, y: 0, z: -2, role: 'finish' }),                                   // src 0
        move({ type: 'arc_cw', x: -3, y: 0, z: -2, cx: 0, cy: 0, role: 'finish' }),    // src 1 -> many
      ]
      const origins: number[] = []
      const sampled = sampleArcMovesForLinearConsumers(moves, { maxChordMm: 0.35 }, origins)

      // one origin per output move, aligned 1:1
      expect(origins.length).toBe(sampled.length)
      // the seed point comes from move 0; every sampled arc point from move 1
      expect(origins[0]).toBe(0)
      for (let i = 1; i < origins.length; i++) expect(origins[i]).toBe(1)
      // the final expanded point is the true arc endpoint (source move 1)
      expect(origins[origins.length - 1]).toBe(1)
    })

    it('maps non-arc moves 1:1 and resets a reused array', () => {
      const moves = [
        move({ type: 'rapid', x: 0, y: 0, z: 5, role: 'rapid' }),  // src 0
        move({ type: 'feed', x: 1, y: 0, z: 0, role: 'plunge' }),  // src 1
        move({ type: 'feed', x: 2, y: 0, z: 0, role: 'cut' }),     // src 2
      ]
      const origins = [99, 99, 99, 99] // pre-dirtied: must be cleared, not appended
      const sampled = sampleArcMovesForLinearConsumers(moves, {}, origins)
      expect(sampled.length).toBe(3)
      expect(origins).toEqual([0, 1, 2])
    })

    it('fills origins for the short-circuit (<2 moves) path', () => {
      const origins: number[] = [7]
      const out = sampleArcMovesForLinearConsumers([move({ x: 1, y: 2, z: 3 })], {}, origins)
      expect(out).toHaveLength(1)
      expect(origins).toEqual([0])
    })
  })
})
