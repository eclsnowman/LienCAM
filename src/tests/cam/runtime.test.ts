import { describe, it, expect } from 'vitest'
import { estimateRuntimeMs, estimateRuntimeMsOrError } from '../../lib/cam/runtime'
import type { ToolpathMove } from '../../types'

const RAPID = 5000 // mm/min

describe('estimateRuntimeMs', () => {
  it('returns 0 for empty or single-point paths', () => {
    expect(estimateRuntimeMs([], RAPID)).toBe(0)
    expect(estimateRuntimeMs([{ type: 'rapid', x: 0, y: 0, z: 0 }], RAPID)).toBe(0)
  })

  it('times a straight feed move at its feed rate', () => {
    const moves: ToolpathMove[] = [
      { type: 'feed', x: 0,   y: 0, z: 0, feed: 1000 },
      { type: 'feed', x: 100, y: 0, z: 0, feed: 1000 },
    ]
    // 100 mm / 1000 mm/min = 0.1 min = 6000 ms
    expect(estimateRuntimeMs(moves, RAPID)).toBeCloseTo(6000, 6)
  })

  it('times a rapid move at the machine rapid rate', () => {
    const moves: ToolpathMove[] = [
      { type: 'rapid', x: 0,   y: 0, z: 0 },
      { type: 'rapid', x: 100, y: 0, z: 0 },
    ]
    // 100 mm / 5000 mm/min = 0.02 min = 1200 ms
    expect(estimateRuntimeMs(moves, RAPID)).toBeCloseTo(1200, 6)
  })

  it('refuses by name (never a silent rapid-rate guess) when a cutting move is missing its feed', () => {
    // BK-137: this used to fall back to RAPID silently while the simulation
    // frame builder (buildFrames) already throws on the identical move --
    // an ADR-0003 half-application. The estimate must refuse THE SAME WAY.
    for (const invalidFeed of [undefined, Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
      const moves: ToolpathMove[] = [
        { type: 'feed', x: 0,   y: 0, z: 0, ...(invalidFeed === undefined ? {} : { feed: invalidFeed }) },
        { type: 'feed', x: 100, y: 0, z: 0, ...(invalidFeed === undefined ? {} : { feed: invalidFeed }) },
      ]
      expect(
        () => estimateRuntimeMs(moves, RAPID),
        `invalid feed ${String(invalidFeed)} must be refused`,
      ).toThrow(/move 1 \(cut\).*finite positive feed/i)
    }
  })

  it('still returns a number (no throw) for a legitimately feedless rapid move', () => {
    const moves: ToolpathMove[] = [
      { type: 'rapid', x: 0,   y: 0, z: 0 },
      { type: 'rapid', x: 100, y: 0, z: 0 },
    ]
    expect(estimateRuntimeMs(moves, RAPID)).toBeCloseTo(1200, 6)
  })

  it('times a fast_traverse move at the supplied fast-traverse rate, not its (absent) feed', () => {
    const moves: ToolpathMove[] = [
      { type: 'feed', x: 0,   y: 0, z: -2, role: 'fast_traverse' },
      { type: 'feed', x: 100, y: 0, z: -2, role: 'fast_traverse' },
    ]
    // 100 mm / 4000 mm/min = 0.025 min = 1500 ms (uses the fast-traverse rate, not RAPID)
    expect(estimateRuntimeMs(moves, RAPID, 4000)).toBeCloseTo(1500, 6)
    // With no fast-traverse rate given it defaults to the machine rapid rate.
    expect(estimateRuntimeMs(moves, RAPID)).toBeCloseTo(1200, 6)
  })

  it('includes the Z component in segment length (plunge)', () => {
    const moves: ToolpathMove[] = [
      { type: 'feed', x: 0, y: 0, z: 0,  feed: 600 },
      { type: 'feed', x: 0, y: 0, z: -3, feed: 600 },
    ]
    // 3 mm / 600 mm/min = 0.005 min = 300 ms
    expect(estimateRuntimeMs(moves, RAPID)).toBeCloseTo(300, 6)
  })

  it('uses true arc length for an arc move', () => {
    // Quarter circle, r = 10, CCW from (10,0) to (0,10) about origin.
    const moves: ToolpathMove[] = [
      { type: 'feed',    x: 10, y: 0,  z: 0, feed: 1000 },
      { type: 'arc_ccw', x: 0,  y: 10, z: 0, feed: 1000, cx: 0, cy: 0 },
    ]
    const arcLen = 10 * (Math.PI / 2)            // ~15.707 mm
    expect(estimateRuntimeMs(moves, RAPID)).toBeCloseTo((arcLen / 1000) * 60000, 6)
  })

  it('sums a multi-move path', () => {
    const moves: ToolpathMove[] = [
      { type: 'rapid', x: 0,   y: 0, z: 0 },             // start
      { type: 'feed',  x: 100, y: 0, z: 0, feed: 1000 }, // 6000 ms
      { type: 'rapid', x: 0,   y: 0, z: 0 },             // 100mm @ rapid = 1200 ms
    ]
    expect(estimateRuntimeMs(moves, RAPID)).toBeCloseTo(7200, 6)
  })
})

describe('estimateRuntimeMsOrError', () => {
  it('returns { ms } for a normal path, with no error field', () => {
    const moves: ToolpathMove[] = [
      { type: 'feed', x: 0,   y: 0, z: 0, feed: 1000 },
      { type: 'feed', x: 100, y: 0, z: 0, feed: 1000 },
    ]
    const result = estimateRuntimeMsOrError(moves, RAPID)
    expect(result.ms).toBeCloseTo(6000, 6)
    expect(result.error).toBeUndefined()
  })

  it('catches the refusal and returns { error } instead of throwing, with no ms field', () => {
    const moves: ToolpathMove[] = [
      { type: 'feed', x: 0,   y: 0, z: 0 },
      { type: 'feed', x: 100, y: 0, z: 0 },
    ]
    const result = estimateRuntimeMsOrError(moves, RAPID)
    expect(result.ms).toBeUndefined()
    expect(result.error).toMatch(/move 1 \(cut\).*finite positive feed/i)
  })
})
