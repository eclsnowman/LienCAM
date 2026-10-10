// Region entries never promise a helix emit cannot make (2026-08-19, Operator's chain on
// Untitled_Project (39): Setup 2 with 0.5 mm stock-to-leave got an entry labelled
// 'helix' with radius 0.108, below the 0.2 floor both emitters honour, so the 3D
// emitter fell into the plunge branch and correctly refused a full-width plunge).
//
// The floor is one constant (MIN_DESCENT_HELIX_RADIUS). A fallback entry that lands
// below it is rescued by planHelixDescent (the lift-landing rescue applied to region
// entries), and the coarse toolRadius/4 clearance search bisects up to the true
// clearance only when its rung landed below the floor.
import { describe, it, expect, beforeAll } from 'vitest'
import { ensureEngineClipperReady, type Loop } from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { processFeature, MIN_DESCENT_HELIX_RADIUS } from '../../../lib/cam/adaptiveClearing2d/engine/processFeature'

function circle(cx: number, cy: number, r: number, n = 180): Loop {
  const out: Loop = []
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n
    out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) })
  }
  return out
}

const TOOL_RADIUS = 4.76
const TOL = 0.05
const params = {
  toolRadius: TOOL_RADIUS,
  stepOver: 0.4,
  tolerance: TOL,
  helixDiameter: 3,
  stockToLeave: 0,
  millingDirection: 'climb' as const,
}

describe('region entry vs the helix floor', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })

  it('never labels an entry helix below the floor', () => {
    // Bore radius toolRadius + 0.30: true clearance 0.30 - tol/2 = 0.275, above the
    // floor - but the coarse search's rung lands far below it. Whatever the entry is,
    // its label must be honest.
    for (const extra of [0.12, 0.30, 0.55, 0.9]) {
      const res = processFeature({ boundary: circle(0, 0, TOOL_RADIUS + extra) }, params)
      for (const e of res.entries) {
        if (e.mode === 'helix') expect(e.radius, `extra ${extra}`).toBeGreaterThanOrEqual(MIN_DESCENT_HELIX_RADIUS - 1e-9)
        if (e.mode === 'plunge') expect(e.radius, `extra ${extra}`).toBeLessThan(MIN_DESCENT_HELIX_RADIUS)
      }
    }
  })

  it('a bore with room for the smallest helix gets a helix, not a plunge (Setup 2 shape)', () => {
    // 0.55 mm of radial room minus tol/2 leaves 0.525 mm: the coarse rung used to
    // report ~0.1 and label it 'helix'; the 3D emitter then had to plunge and refuse.
    const res = processFeature({ boundary: circle(0, 0, TOOL_RADIUS + 0.55) }, params)
    expect(res.entries.length).toBeGreaterThan(0)
    expect(res.entries[0].mode).toBe('helix')
    expect(res.entries[0].radius).toBeGreaterThanOrEqual(MIN_DESCENT_HELIX_RADIUS - 1e-9)
    expect(res.passes.filter(p => p.type === 'cut').length).toBeGreaterThan(0)
  })

  it('a bore too tight for any helix is an honest plunge', () => {
    const res = processFeature({ boundary: circle(0, 0, TOOL_RADIUS + 0.12) }, params)
    if (res.entries.length > 0) {
      expect(res.entries[0].mode).toBe('plunge')
      expect(res.entries[0].radius).toBeLessThan(MIN_DESCENT_HELIX_RADIUS)
    }
  })
})
