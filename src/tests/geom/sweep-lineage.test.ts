// GEO-3 — PURE unit tests for the constructed-lineage helpers (kernel-free, so
// the ID grammar + geometric math are pinned without the wasm kernel).
import { describe, it, expect } from 'vitest'
import {
  planeBasis, lift, segRep2d, rotateAboutAxis, canonicalAxis,
  axisFromThreeCirclePoints, extrudeSideId, extrudeCapId, revolveSurfId,
  revolveCapId, capOrderRefs, capOrderScore, dot, len, sub, scale, normalize,
  cross, type Vec3T,
} from '../../geom/worker/sweep-lineage.ts'

describe('sweep-lineage pure helpers', () => {
  it('planeBasis is orthonormal + right-handed, even for a slightly skew input', () => {
    const b = planeBasis({ origin: { x: 1, y: 2, z: 3 }, normal: { x: 0, y: 0, z: 2 }, xDir: { x: 3, y: 0, z: 1 } })
    expect(len(b.normal)).toBeCloseTo(1, 12)
    expect(len(b.xDir)).toBeCloseTo(1, 12)
    expect(len(b.yDir)).toBeCloseTo(1, 12)
    expect(dot(b.normal, b.xDir)).toBeCloseTo(0, 12) // xDir re-orthonormalized
    expect(dot(b.xDir, b.yDir)).toBeCloseTo(0, 12)
    expect(dot(b.normal, b.yDir)).toBeCloseTo(0, 12)
  })

  it('lift maps 2D sketch coords to 3D through the plane', () => {
    const b = planeBasis({ origin: { x: 0, y: 0, z: 5 }, normal: { x: 0, y: 0, z: 1 }, xDir: { x: 1, y: 0, z: 0 } })
    expect(lift(b, [3, 4])).toEqual([3, 4, 5])
  })

  it('segRep2d returns the line midpoint and the arc mid-angle point', () => {
    expect(segRep2d({ kind: 'line', a: [0, 0], b: [10, 4], srcId: 'x' })).toEqual([5, 2])
    const arc = segRep2d({ kind: 'arc', c: [0, 0], r: 2, a0: 0, a1: Math.PI, ccw: true, srcId: 'x' })
    expect(arc[0]).toBeCloseTo(0, 12) // mid-angle pi/2 -> (0, 2)
    expect(arc[1]).toBeCloseTo(2, 12)
  })

  it('rotateAboutAxis rotates about the Z axis correctly', () => {
    const p = rotateAboutAxis([1, 0, 0], [0, 0, 0], [0, 0, 1], Math.PI / 2)
    expect(p[0]).toBeCloseTo(0, 12)
    expect(p[1]).toBeCloseTo(1, 12)
    expect(p[2]).toBeCloseTo(0, 12)
  })

  it('canonicalAxis makes a line direction sign-stable (antiparallel collapses)', () => {
    expect(canonicalAxis([0, 0, -1])).toEqual([0, 0, 1])
    expect(canonicalAxis([0, 0, 1])).toEqual([0, 0, 1])
    // largest-magnitude component drives the sign.
    const a = canonicalAxis([-0.9, 0.1, -0.2])
    expect(a[0]).toBeGreaterThan(0)
  })

  it('axisFromThreeCirclePoints recovers the circle plane normal (= axis)', () => {
    // three points on the unit circle in the XY plane -> axis is Z.
    const ax = axisFromThreeCirclePoints([1, 0, 0], [-0.5, Math.sqrt(3) / 2, 0], [-0.5, -Math.sqrt(3) / 2, 0])!
    expect(Math.abs(ax[2])).toBeCloseTo(1, 10)
    expect(ax[0]).toBeCloseTo(0, 10)
    expect(ax[1]).toBeCloseTo(0, 10)
    // collinear points -> undefined (degenerate, never a garbage direction).
    expect(axisFromThreeCirclePoints([0, 0, 0], [1, 1, 1], [2, 2, 2])).toBeUndefined()
  })

  it('ID grammar matches docs/stable-id-spec.md + this WO ruling 2', () => {
    expect(extrudeSideId('F12', 'S3.e7')).toBe('F12:XTR:S3.e7:side')
    expect(extrudeCapId('F12', 'S3', 'start')).toBe('F12:XTR:S3:capStart')
    expect(extrudeCapId('F12', 'S3', 'end')).toBe('F12:XTR:S3:capEnd')
    expect(revolveSurfId('F14', 'S3.e2')).toBe('F14:REV:S3.e2:surf')
    expect(revolveCapId('F14', 'S3', 'start')).toBe('F14:REV:S3:capStart')
  })

  it('sub is exact', () => {
    const d: Vec3T = sub([3, 5, 9], [1, 2, 4])
    expect(d).toEqual([2, 3, 5])
  })

  // GEO-3 R1 (audit finding): partial-revolve cap ordering must come from the
  // PROFILE geometry, not the profile-plane origin. This pins the fix + is a
  // deterministic, kernel-free FAILS-IF for the exact committed bug.
  describe('capOrderRefs/capOrderScore order start<end even for an on-axis plane origin', () => {
    // Canonical xzPlane revolve fixture: rect (x 10..20, z 0..5, y=0) revolved
    // +90deg about Z. The profile-plane origin (0,0,0) is ON the Z axis.
    const axisOrigin: Vec3T = [0, 0, 0]
    const axisDir: Vec3T = [0, 0, 1]
    const theta = Math.PI / 2
    // theta=0 profile centroid (mean of the four lifted edge midpoints) — the
    // reference the fixed makeRevolve derives; guaranteed OFF the axis.
    const profileRep: Vec3T = [15, 0, 2.5]
    // cap face centroids: start ~ the theta=0 profile; end ~ it rotated +90deg.
    const startCap: Vec3T = [15, 0, 2.5]
    const endCap: Vec3T = [0, 15, 2.5]

    it('the profile-derived score separates the caps (start negative, end positive)', () => {
      const { startRef, endRef } = capOrderRefs(profileRep, axisOrigin, axisDir, theta)
      expect(capOrderScore(startCap, startRef, endRef)).toBeLessThan(0)
      expect(capOrderScore(endCap, startRef, endRef)).toBeGreaterThan(0)
    })

    it('FAILS-IF: the pre-R1 origin-based azimuth reference ties both caps at 0', () => {
      // The committed bug: derive the reference from (basis.origin - axisOrigin).
      // For an on-axis plane origin that difference has a ZERO perpendicular, so
      // refPerp/refPerp2 are zero and every cap azimuth is atan2(0,0)=0 — both
      // caps tie, and only kernel face enumeration decides start/end.
      const rel = sub(/* basis.origin */[0, 0, 0], axisOrigin)
      const refPerp = normalize(sub(rel, scale(axisDir, dot(rel, axisDir))))
      const refPerp2 = normalize(cross(axisDir, refPerp))
      const oldScore = (c: Vec3T): number => {
        const r = sub(c, axisOrigin)
        const perp = sub(r, scale(axisDir, dot(r, axisDir)))
        const a = Math.atan2(dot(perp, refPerp2), dot(perp, refPerp))
        return ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)
      }
      expect(refPerp).toEqual([0, 0, 0])
      expect(oldScore(startCap)).toBe(0)
      expect(oldScore(endCap)).toBe(0) // degenerate tie -> enumeration-order caps
    })
  })
})
