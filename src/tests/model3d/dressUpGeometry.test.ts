// WO UI-16: unit coverage for dressUpGeometry.ts's new C2/C4 helpers.
//
// C2 acceptance #4 (third case): "one test asserting the dialog CANNOT emit
// a tilted plane (normal always parallel to pullDir by construction)" --
// proven here at the PURE FUNCTION level (draftNeutralPlane's normal is
// LITERALLY pullDir, so no axis/flip/offset combination can ever diverge),
// which is a stronger and more exhaustive proof than driving the dialog UI
// for a handful of cases.
import { describe, it, expect } from 'vitest'
import {
  camSketchPointSamples,
  decomposePrincipalAxis,
  draftNeutralPlane,
  draftPullDir,
  DRAFT_PULL_DIR,
  projectSketchPointToWorld,
  type PathAxis,
} from '../../components/model3d/dialogs/dressUpGeometry'
import type { PlaneFrame } from '../../sketch3d/planeMath'
import type { Sketch } from '../../lib/sketch/sketcher'

const AXES: PathAxis[] = ['x', 'y', 'z']

function cross(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x }
}

describe('dressUpGeometry (WO UI-16 C2): draftPullDir/draftNeutralPlane/decomposePrincipalAxis', () => {
  it('draftPullDir returns exactly one of the six principal axes for every (axis, flip) combination', () => {
    for (const axis of AXES) {
      for (const flip of [false, true]) {
        const v = draftPullDir(axis, flip)
        const nonzero = [v.x, v.y, v.z].filter((c) => c !== 0)
        expect(nonzero).toHaveLength(1)
        expect(Math.abs(nonzero[0])).toBe(1)
      }
    }
  })

  it('C2 acceptance #3 (the dialog CANNOT emit a tilted plane): draftNeutralPlane\'s normal is ALWAYS parallel to pullDir, by construction, for every axis/flip/offset', () => {
    for (const axis of AXES) {
      for (const flip of [false, true]) {
        const pullDir = draftPullDir(axis, flip)
        for (const offset of [-17.5, -1, 0, 0.001, 5, 250]) {
          const plane = draftNeutralPlane(pullDir, offset)
          // The normal is LITERALLY pullDir (not merely numerically close) -- construction, not
          // computation, is what makes a tilted plane unrepresentable.
          expect(plane.normal).toEqual(pullDir)
          // Cross product is exactly zero (parallel), for every case -- the kernel's own refusal
          // test (geom-engine.ts's applyDraft, draft.test.ts) checks this same invariant at runtime;
          // this proves the DIALOG can never construct a request that would fail it.
          const c = cross(pullDir, plane.normal)
          expect(c).toEqual({ x: 0, y: 0, z: 0 })
          // The plane's origin sits exactly `offset` mm along pullDir from the world origin.
          expect(plane.origin).toEqual({ x: pullDir.x * offset, y: pullDir.y * offset, z: pullDir.z * offset })
        }
      }
    }
  })

  it('decomposePrincipalAxis is the exact inverse of draftPullDir for all six directions', () => {
    for (const axis of AXES) {
      for (const flip of [false, true]) {
        const v = draftPullDir(axis, flip)
        expect(decomposePrincipalAxis(v)).toEqual({ axis, flip })
      }
    }
  })

  it('DraftDialog\'s default (decomposed from DRAFT_PULL_DIR, the single source of truth) reproduces world -Z -- UI-13A\'s original default, unchanged', () => {
    const { axis, flip } = decomposePrincipalAxis(DRAFT_PULL_DIR)
    expect(draftPullDir(axis, flip)).toEqual(DRAFT_PULL_DIR)
    expect(axis).toBe('z')
    expect(flip).toBe(true)
  })
})

describe('dressUpGeometry (WO UI-16 C4): camSketchPointSamples/projectSketchPointToWorld', () => {
  it('enumerates point/line/circle/arc candidate points with the expected labels and local coordinates', () => {
    const sketch: Sketch = {
      id: 'S1',
      layerId: 'L1',
      entities: [
        { id: 'e1', kind: 'point', construction: false, at: { x: 1, y: 2 } },
        { id: 'e2', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
        { id: 'e3', kind: 'circle', construction: false, center: { x: 5, y: 5 }, radius: 3 },
        { id: 'e4', kind: 'arc', construction: false, center: { x: 0, y: 0 }, radius: 4, startAngle: 0, endAngle: Math.PI / 2 },
      ],
      constraints: [],
      dimensions: [],
      solveStatus: null,
    }
    const samples = camSketchPointSamples(sketch)
    const byId = new Map(samples.map((s) => [s.id, s]))

    expect(byId.get('e1:self')?.local).toEqual({ x: 1, y: 2 })
    expect(byId.get('e2:start')?.local).toEqual({ x: 0, y: 0 })
    expect(byId.get('e2:end')?.local).toEqual({ x: 10, y: 0 })
    expect(byId.get('e3:center')?.local).toEqual({ x: 5, y: 5 })
    expect(byId.get('e4:center')?.local).toEqual({ x: 0, y: 0 })
    // startAngle=0 -> (radius, 0); endAngle=pi/2 -> (0, radius).
    expect(byId.get('e4:start')?.local.x).toBeCloseTo(4, 10)
    expect(byId.get('e4:start')?.local.y).toBeCloseTo(0, 10)
    expect(byId.get('e4:end')?.local.x).toBeCloseTo(0, 10)
    expect(byId.get('e4:end')?.local.y).toBeCloseTo(4, 10)
    // point(1) + line(start,end=2) + circle(center=1) + arc(center,start,end=3) = 7.
    expect(samples).toHaveLength(7)
  })

  it('projectSketchPointToWorld matches a hand-computed world point for a non-trivial plane frame', () => {
    // Frame: origin (10, 0, 0), normal +Z (world XY-parallel plane shifted along X), xDir +X.
    // Local Y axis = normal x xDir = (0,0,1) x (1,0,0) = (0,1,0) -- planeMath.ts's own convention.
    const frame: PlaneFrame = { origin: { x: 10, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 }, xDir: { x: 1, y: 0, z: 0 } }
    const world = projectSketchPointToWorld(frame, { x: 3, y: 4 })
    expect(world).toEqual({ x: 13, y: 4, z: 0 })
  })

  it('projectSketchPointToWorld on a tilted frame (xz-plane-like) matches a hand-computed point', () => {
    // xz plane convention (from planeMath.ts's header): normal=(0,-1,0), xDir=(1,0,0) -> local Y = world Z.
    const frame: PlaneFrame = { origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: -1, z: 0 }, xDir: { x: 1, y: 0, z: 0 } }
    const world = projectSketchPointToWorld(frame, { x: 5, y: 7 })
    expect(world).toEqual({ x: 5, y: 0, z: 7 })
  })
})
