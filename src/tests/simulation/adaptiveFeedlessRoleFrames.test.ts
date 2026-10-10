import { describe, expect, it } from 'vitest'

import { buildFrames } from '../../components/simulation/SimulationPanel'

// ADAPTIVE-VIEW-CRASH regression pin.
//
// The 2D adaptive-clearing engine emits two roles that carry geometry + move type but
// NO baked feed BY DESIGN (ADR-0001): 'fast_traverse' (keep-down reposition through
// cleared stock -- emit.ts emitLink jumpType 1 / emitLoopback) and 'finish' (the
// dedicated wall-finishing contour). The runtime estimate (estimateRuntimeMs) already
// resolves these by role; the simulation frame builder (buildFrames) did NOT, so it
// refused a feedless-by-design fast_traverse move by name --
//   "Simulation frame build refused move N (fast_traverse): expected a finite positive feed"
// -- which, thrown from the frames-rebuild effect, took the WHOLE app down to the
// "Reset Project Data" error screen when Operator clicked an adaptive toolpath.
//
// These pins drive the feedless-role state directly (no timing, no headed run). Before
// the fix the fast_traverse / finish cases throw (RED); after, they resolve by role.

const RAPID = 5000
const FAST_TRAVERSE = 3500
const FINISH = 800

describe('buildFrames resolves feedless-by-design adaptive roles by role (ADR-0001)', () => {
  it('a feedless fast_traverse keep-down move is timed at the fast-traverse rate, not refused', () => {
    const moves = [
      { x: 0, y: 0, z: 5, type: 'feed', role: 'cut', feed: 1000 },
      // Keep-down reposition through cleared stock: geometry + role only, NO feed.
      { x: 10, y: 0, z: 5, type: 'feed', role: 'fast_traverse' },
    ]
    const { frames } = buildFrames(moves, RAPID, 0, 3, undefined, undefined, FAST_TRAVERSE, FINISH)
    expect(frames).toHaveLength(1)
    expect(frames[0].role).toBe('fast_traverse')
    expect(frames[0].speedMmPerMin).toBe(FAST_TRAVERSE)
    expect(Number.isFinite(frames[0].durationMs)).toBe(true)
  })

  it('a feedless finish contour move is timed at the finish rate', () => {
    const moves = [
      { x: 0, y: 0, z: 0, type: 'feed', role: 'cut', feed: 1000 },
      { x: 5, y: 0, z: 0, type: 'feed', role: 'finish' },
    ]
    const { frames } = buildFrames(moves, RAPID, 0, 3, undefined, undefined, FAST_TRAVERSE, FINISH)
    expect(frames[0].role).toBe('finish')
    expect(frames[0].speedMmPerMin).toBe(FINISH)
  })

  it('falls back to the rapid speed when a role rate is missing (degraded 2-arg caller), never NaN', () => {
    const moves = [
      { x: 0, y: 0, z: 0, type: 'feed', role: 'cut', feed: 1000 },
      { x: 5, y: 0, z: 0, type: 'feed', role: 'fast_traverse' },
    ]
    // Only rapidRate supplied: fastTraverseRate/finishRate default to rapidRate.
    const { frames } = buildFrames(moves, RAPID)
    const last = frames[frames.length - 1]
    expect(last.speedMmPerMin).toBe(RAPID)
    expect(Number.isFinite(last.durationMs)).toBe(true)
  })

  it('STILL refuses a genuinely feedless CUT move by name (the SIM-4 contract is intact)', () => {
    const moves = [
      { x: 0, y: 0, z: 0, type: 'rapid', role: 'rapid' },
      { x: 5, y: 0, z: 0, type: 'feed', role: 'cut' }, // no feed on a cut = bad data
    ]
    expect(
      () => buildFrames(moves, RAPID, 0, 3, undefined, undefined, FAST_TRAVERSE, FINISH),
    ).toThrow(/move 1.*cut.*finite positive feed/i)
  })
})
