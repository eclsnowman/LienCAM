import { describe, it, expect } from 'vitest'
import {
  placementToScenePose,
  applyPlacementTransform,
  resolveLoopPickGeoId,
} from '../../lib/viewport/nestRender'

const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps

describe('nestRender pure pose math (P3.2, ADR 0024)', () => {
  it('placementToScenePose lifts to the Z2D plane and converts degrees to radians', () => {
    const pose = placementToScenePose({ x: 10, y: 20, rotationDeg: 90 }, 0.3)
    expect(pose.position).toEqual({ x: 10, y: 20, z: 0.3 })
    expect(close(pose.rotationZ, Math.PI / 2)).toBe(true)
  })

  it('zero rotation is identity (only translation)', () => {
    const out = applyPlacementTransform({ x: 3, y: 4 }, { x: 100, y: 50, rotationDeg: 0 })
    expect(close(out.x, 103)).toBe(true)
    expect(close(out.y, 54)).toBe(true)
  })

  it('90deg rotation maps local +X to sheet +Y (translate . rotate convention)', () => {
    // local (1,0) rotated 90deg -> (0,1), then translated by (5,5) -> (5,6)
    const out = applyPlacementTransform({ x: 1, y: 0 }, { x: 5, y: 5, rotationDeg: 90 })
    expect(close(out.x, 5)).toBe(true)
    expect(close(out.y, 6)).toBe(true)
  })

  it('180deg rotation negates the local point before translating', () => {
    const out = applyPlacementTransform({ x: 2, y: 3 }, { x: 0, y: 0, rotationDeg: 180 })
    expect(close(out.x, -2)).toBe(true)
    expect(close(out.y, -3)).toBe(true)
  })

  it('rotation is about the placement origin, not the part centroid (composition order)', () => {
    // translate THEN the same local point under a different translation differ
    // only by the translation delta - confirms rotate happens in local frame first.
    const local = { x: 4, y: 0 }
    const r0 = applyPlacementTransform(local, { x: 0, y: 0, rotationDeg: 90 })
    const r1 = applyPlacementTransform(local, { x: 7, y: -2, rotationDeg: 90 })
    expect(close(r1.x - r0.x, 7)).toBe(true)
    expect(close(r1.y - r0.y, -2)).toBe(true)
  })
})

describe('resolveLoopPickGeoId — loop-pick geoId gating (seed-slot picking)', () => {
  it('standalone 2D loop: geoId is the parent group name', () => {
    expect(resolveLoopPickGeoId({ parentName: 'geo-123' })).toBe('geo-123')
  })

  it('__proj__ group: geoId is the grandparent name', () => {
    expect(
      resolveLoopPickGeoId({ parentName: '__proj__', grandparentName: 'geo-part' }),
    ).toBe('geo-part')
  })

  it('__wplane_<geoId> group: geoId is the suffix of the parent name', () => {
    expect(resolveLoopPickGeoId({ parentName: '__wplane_geo-xyz' })).toBe('geo-xyz')
  })

  it('__wplane_local_<geoId> group (B-rep derived holes/sections): geoId is the suffix AFTER the local_ marker', () => {
    // Regression 2026-06-25: B-rep geometry-local derived loops (drill holes) live in
    // `__wplane_local_<geoId>`. The generic `__wplane_` branch used to return
    // "local_geo-xyz", so the loop-pick geo-gate rejected every hit and holes were
    // unselectable in the viewport. The more-specific prefix must win.
    expect(resolveLoopPickGeoId({ parentName: '__wplane_local_geo-xyz' })).toBe('geo-xyz')
    // A geoId that itself contains 'local' is not mangled.
    expect(resolveLoopPickGeoId({ parentName: '__wplane_local_local-part-7' })).toBe('local-part-7')
  })

  it('seed-slot loop line: geoId comes from userData (parent group is unnamed)', () => {
    // The seed-slot line sits under the unnamed placement child group, so the
    // parent name is empty; the owned-seed geoId rides on userData instead.
    expect(
      resolveLoopPickGeoId({
        userData: { geometryId: 'owned-seed-1', seedPlacement: true },
        parentName: '',
        grandparentName: 'nest:n1',
      }),
    ).toBe('owned-seed-1')
  })

  it('seed userData takes precedence over a non-empty parent name', () => {
    expect(
      resolveLoopPickGeoId({
        userData: { geometryId: 'owned-seed-2', seedPlacement: true },
        parentName: 'some-group',
      }),
    ).toBe('owned-seed-2')
  })

  it('a geometryId present WITHOUT seedPlacement is ignored (falls back to parent name)', () => {
    // Guards standalone picking: only true seed placements use the userData path.
    expect(
      resolveLoopPickGeoId({
        userData: { geometryId: 'stray' },
        parentName: 'geo-real',
      }),
    ).toBe('geo-real')
  })

  it('no parent name and no seed userData => null (no match)', () => {
    expect(resolveLoopPickGeoId({})).toBeNull()
    expect(resolveLoopPickGeoId({ parentName: '' })).toBeNull()
  })
})
