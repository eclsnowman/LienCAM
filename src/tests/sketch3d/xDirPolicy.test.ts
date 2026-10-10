import { describe, expect, it } from 'vitest'
import { computeXDir } from '../../sketch3d/xDirPolicy'
import type { PlaneFrame } from '../../sketch3d/planeMath'

// WO SKC-5, Q7: deterministic projected-model-X with prior-frame preservation.
// Pure function tests -- no DAG/ElementMap fixture needed.

describe('computeXDir', () => {
  it('projects world +X onto an XY-ish plane (normal = +Z) with no prior frame', () => {
    const xDir = computeXDir({ x: 0, y: 0, z: 1 })
    expect(xDir.x).toBeCloseTo(1, 9)
    expect(xDir.y).toBeCloseTo(0, 9)
    expect(xDir.z).toBeCloseTo(0, 9)
  })

  it('falls back to projected world +Y when the normal is world +X (degenerate X projection)', () => {
    const xDir = computeXDir({ x: 1, y: 0, z: 0 })
    // world Y projected onto a plane whose normal IS world X is just world Y unchanged.
    expect(xDir.x).toBeCloseTo(0, 9)
    expect(xDir.y).toBeCloseTo(1, 9)
    expect(xDir.z).toBeCloseTo(0, 9)
  })

  it('always returns a unit vector perpendicular to the normal', () => {
    const normal = { x: 0.267, y: 0.535, z: 0.802 } // arbitrary non-axis-aligned unit-ish normal
    const xDir = computeXDir(normal)
    const len = Math.sqrt(xDir.x ** 2 + xDir.y ** 2 + xDir.z ** 2)
    expect(len).toBeCloseTo(1, 6)
    const dot = normal.x * xDir.x + normal.y * xDir.y + normal.z * xDir.z
    expect(Math.abs(dot)).toBeLessThan(1e-6)
  })

  it('preserves the prior frame\'s xDir (projected onto the new plane) when the normal is unchanged (AC #2 continuity)', () => {
    const prior: PlaneFrame = { origin: { x: 0, y: 0, z: 10 }, normal: { x: 0, y: 0, z: 1 }, xDir: { x: 0, y: 1, z: 0 } }
    // Same normal, slightly different origin (a parameter edit moved the face) --
    // xDir must stay world Y, NOT re-derive to the fresh projected-model-X policy.
    const xDir = computeXDir({ x: 0, y: 0, z: 1 }, prior)
    expect(xDir.x).toBeCloseTo(0, 9)
    expect(xDir.y).toBeCloseTo(1, 9)
    expect(xDir.z).toBeCloseTo(0, 9)
  })

  it('does NOT preserve the prior xDir when the normal has genuinely changed (different face / flipNormal)', () => {
    const prior: PlaneFrame = { origin: { x: 0, y: 0, z: 10 }, normal: { x: 0, y: 0, z: -1 }, xDir: { x: 0, y: 1, z: 0 } }
    // Normal flipped -> falls back to fresh projected-model-X, not the stale prior xDir.
    const xDir = computeXDir({ x: 0, y: 0, z: 1 }, prior)
    expect(xDir.x).toBeCloseTo(1, 9)
    expect(xDir.y).toBeCloseTo(0, 9)
  })
})
