// Form: Pipe along 3D paths - sketch curves joined end to end across planes, and a closed loop that is not flat.

import { describe, expect, it } from 'vitest'
import type { Cage, Vec3 } from '../../form/cage'
import { joinPaths, pipeCage, type SketchPath } from '../../form/pipe'
import { validateCage } from '../../form/halfEdge'

const open = (pts: Vec3[]): SketchPath => ({ points: pts, closed: false })
const line = (a: Vec3, b: Vec3, n = 10): SketchPath => open(Array.from({ length: n + 1 }, (_, i) => [0, 1, 2].map((c) => a[c] + ((b[c] - a[c]) * i) / n) as Vec3))

describe('joinPaths', () => {
  it('end to start, end to end (turned round), start to end, start to start: one chain, the joint once', () => {
    const a = line([0, 0, 0], [40, 0, 0], 4)
    const up = line([40, 0, 0], [40, 0, 40], 4)
    const down = line([40, 0, 40], [40, 0, 0], 4)
    for (const b of [up, down]) {
      const j = joinPaths(a, b)!
      expect(j.closed).toBe(false)
      expect(j.points).toHaveLength(9)
      expect(j.points[0]).toEqual([0, 0, 0])
      expect(j.points[8]).toEqual([40, 0, 40])
    }
    const before = line([0, 0, -40], [0, 0, 0], 4)
    expect(joinPaths(a, before)!.points[0]).toEqual([0, 0, -40])
    expect(joinPaths(a, line([0, 0, 0], [0, 0, -40], 4))!.points[0]).toEqual([0, 0, -40])
  })

  it('closes when the far ends meet too; null when no ends meet or either is closed', () => {
    const a = open([[0, 0, 0], [40, 0, 0], [40, 40, 20]])
    const b = open([[40, 40, 20], [0, 40, 0], [0, 0, 0]])
    const j = joinPaths(a, b)!
    expect(j.closed).toBe(true)
    expect(j.points).toHaveLength(4)
    expect(joinPaths(a, line([100, 0, 0], [140, 0, 0]))).toBeNull()
    expect(joinPaths(a, { ...b, closed: true })).toBeNull()
  })
})

/** how far each ring turns from the one before about the path: the angle between point 0's offsets */
function ringTurns(c: Cage, rings: number, n: number): number[] {
  const centre = (i: number) => [0, 1, 2].map((k) => c.positions.slice(i * n, i * n + n).reduce((s, p) => s + p[k], 0) / n) as Vec3
  const out: number[] = []
  for (let i = 0; i < rings; i++) {
    const j = (i + 1) % rings
    const ci = centre(i), cj = centre(j)
    const t = [0, 1, 2].map((k) => cj[k] - ci[k]) as Vec3
    const tl = Math.hypot(...t)
    const off = (r: number, cr: Vec3) => { const p = c.positions[r * n]; const v = [0, 1, 2].map((k) => p[k] - cr[k]) as Vec3; const d = (v[0] * t[0] + v[1] * t[1] + v[2] * t[2]) / (tl * tl); return [0, 1, 2].map((k) => v[k] - t[k] * d) as Vec3 }
    const a = off(i, ci), b = off(j, cj)
    const cos = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(...a) * Math.hypot(...b))
    out.push(Math.acos(Math.max(-1, Math.min(1, cos))))
  }
  return out
}

describe('pipeCage on 3D paths', () => {
  it('an L on XY carried up along XZ: one valid tube round the corner, capped at both ends', () => {
    const path = joinPaths(line([0, 0, 0], [40, 0, 0]), line([40, 0, 0], [40, 0, 40]))!
    const c = pipeCage(path, { radius: 4 })
    expect(validateCage(c, true).problems).toEqual([])
  })

  it('a closed trefoil knot (a loop that is far from flat): the last ring meets the first untwisted - no bigger a turn than between neighbours', () => {
    // rotation-minimising frames come back round a trefoil turned about 2.6 rad; the fix spreads that out
    const N = 360
    const loop: SketchPath = { points: Array.from({ length: N }, (_, i) => { const t = (2 * Math.PI * i) / N; return [10 * (Math.sin(t) + 2 * Math.sin(2 * t)), 10 * (Math.cos(t) - 2 * Math.cos(2 * t)), -10 * Math.sin(3 * t)] as Vec3 }), closed: true }
    const n = 8
    const c = pipeCage(loop, { radius: 2, sides: n })
    expect(validateCage(c, true).problems).toEqual([])
    const rings = c.positions.length / n
    const turns = ringTurns(c, rings, n)
    const seam = turns[rings - 1]
    const others = turns.slice(0, rings - 1)
    expect(seam).toBeLessThan(Math.max(...others) * 1.5 + 1e-3)
  })
})
