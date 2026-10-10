// WO-1574: "Seat in vise" - two face picks produce one rigid transform for
// the workholding body, applied through the REAL store action
// (updateGeometryTransform, the existing transform action) so undo, setup
// snap and stock re-derive all see it exactly like a gizmo drag would.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ImportedGeometry, Vec3 } from '../../types'
import { typedMock } from '../support/typedMock'
import {
  seatFirstFace, seatSecondFace, localBoxFace, worldBoxFace,
  type RigidPose,
} from '../../lib/cam/workholdingSeat'

vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}),
  loadCachedSTL: vi.fn(async () => new ArrayBuffer(84)),
  removeCachedSTL: vi.fn(async () => {}),
}))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async () => {}),
  loadCachedStep: vi.fn(async () => null),
  removeCachedStep: vi.fn(async () => {}),
}))

const { useCamStore } = await import('../../store')

function box(id: string, name: string, min: Vec3, max: Vec3, position: Vec3, rotation: Vec3): ImportedGeometry {
  return {
    id, name, filename: `${id}.stl`, type: 'mesh', format: 'stl',
    boundingBox: {
      min: { ...min }, max: { ...max },
      size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
      center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
    },
    position, rotation, loaded: true,
  }
}

// 50x30x20 part, sitting at the origin, never moved.
const PART_BB = { min: { x: 0, y: 0, z: 0 }, max: { x: 50, y: 30, z: 20 } }
const PART_POSE: RigidPose = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }
const PART = box('part', 'Bracket', PART_BB.min, PART_BB.max, PART_POSE.position, PART_POSE.rotation)

// The vise: jaw face is its local -X face, floor face is its local +Z face.
// Its jaw face is 10mm off the part's +X side and rotated 5deg about Z -
// exactly the order's own acceptance scenario.
const VISE_BB = { min: { x: -30, y: -20, z: 0 }, max: { x: 0, y: 20, z: 60 } }
const VISE_START_POSE: RigidPose = { position: { x: 90, y: -2, z: 5 }, rotation: { x: 0, y: 0, z: 5 } }
const VISE = box('vise', 'Kurt vise', VISE_BB.min, VISE_BB.max, VISE_START_POSE.position, VISE_START_POSE.rotation)

const TOL = 0.001 // mm, the order's own gap tolerance

function dot(a: Vec3, b: Vec3): number { return a.x * b.x + a.y * b.y + a.z * b.z }
function sub(a: Vec3, b: Vec3): Vec3 { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z } }

/** Assert a local face, transformed by `pose`, is coplanar with `target`
 *  (a world FacePick) with normals opposed - the order's own acceptance
 *  wording, checked geometrically rather than against hand-derived numbers. */
function expectSeated(
  bb: { min: Vec3; max: Vec3 }, pose: RigidPose, face: 'px' | 'nx' | 'py' | 'ny' | 'pz' | 'nz',
  target: { point: Vec3; normal: Vec3 },
) {
  const worldFace = worldBoxFace(bb, pose, face)
  expect(dot(worldFace.normal, target.normal)).toBeCloseTo(-1, 6)
  const gap = dot(sub(worldFace.point, target.point), target.normal)
  expect(Math.abs(gap)).toBeLessThan(TOL)
}

function freshProject() {
  useCamStore.getState().newProject()
  useCamStore.getState().addGeometry(PART)
  useCamStore.getState().addGeometry(VISE)
}

beforeEach(() => {
  freshProject()
})

describe('WO-1574: workholdingSeat engine (jaw-to-part-side, then floor-to-part-bottom)', () => {
  const partSideFace = worldBoxFace(PART_BB, PART_POSE, 'px')
  const partBottomFace = worldBoxFace(PART_BB, PART_POSE, 'nz')

  it('seat 1: the jaw face becomes coplanar with the part side, normals opposed, gap 0', () => {
    const jawLocal = localBoxFace(VISE_BB, 'nx')
    const seated = seatFirstFace(VISE_START_POSE, jawLocal, partSideFace)

    expectSeated(VISE_BB, seated, 'nx', partSideFace)
    // The 5deg misalignment was the only defect: the corrected rotation is
    // exactly zero, and Y/Z position (never implicated by an X-face contact)
    // pass through unchanged.
    expect(seated.rotation.x).toBeCloseTo(0, 6)
    expect(seated.rotation.y).toBeCloseTo(0, 6)
    expect(seated.rotation.z).toBeCloseTo(0, 6)
    expect(seated.position.y).toBeCloseTo(VISE_START_POSE.position.y, 9)
    expect(seated.position.z).toBeCloseTo(VISE_START_POSE.position.z, 9)
  })

  it('seat 2 slides along the first contact plane only: the jaw contact holds and the floor touches the part bottom', () => {
    const jawLocal = localBoxFace(VISE_BB, 'nx')
    const seat1 = seatFirstFace(VISE_START_POSE, jawLocal, partSideFace)

    const floorLocal = localBoxFace(VISE_BB, 'pz')
    const firstContactNormalWorld = { x: -1, y: 0, z: 0 } // = -partSideFace.normal, locked by seat 1
    const seat2 = seatSecondFace(seat1, firstContactNormalWorld, floorLocal, partBottomFace)

    expectSeated(VISE_BB, seat2, 'pz', partBottomFace)
    expectSeated(VISE_BB, seat2, 'nx', partSideFace) // jaw contact still holds
    expect(seat2.rotation).toEqual(seat1.rotation) // no rotation in seat 2
  })

  it('refuses a second face whose target is parallel to the first contact (cannot slide to close it)', () => {
    const jawLocal = localBoxFace(VISE_BB, 'nx')
    const seat1 = seatFirstFace(VISE_START_POSE, jawLocal, partSideFace)
    const otherXFace = localBoxFace(VISE_BB, 'px') // also normal along X, like the jaw contact
    const firstContactNormalWorld = { x: -1, y: 0, z: 0 }
    // Target face also normal to X: sliding within the (Y,Z) plane can never
    // change the X gap this face has to the part's own X-normal face.
    expect(() => seatSecondFace(seat1, firstContactNormalWorld, otherXFace, partSideFace)).toThrow(/parallel/)
  })

  it('the part never moves', () => {
    const jawLocal = localBoxFace(VISE_BB, 'nx')
    seatFirstFace(VISE_START_POSE, jawLocal, partSideFace)
    expect(PART_POSE).toEqual({ position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } })
  })
})

describe('WO-1574: seating through the store (updateGeometryTransform, undo)', () => {
  function viseOf(): ImportedGeometry {
    return useCamStore.getState().project.geometry.find((g) => g.id === 'vise')!
  }
  function partOf(): ImportedGeometry {
    return useCamStore.getState().project.geometry.find((g) => g.id === 'part')!
  }

  it('two seat commits are two undo steps; undo twice restores the vise\'s original transform', () => {
    const partSideFace = worldBoxFace(PART_BB, PART_POSE, 'px')
    const partBottomFace = worldBoxFace(PART_BB, PART_POSE, 'nz')

    const seat1 = seatFirstFace(VISE_START_POSE, localBoxFace(VISE_BB, 'nx'), partSideFace)
    useCamStore.getState().updateGeometryTransform('vise', seat1.position, seat1.rotation)
    expect(viseOf().position).toEqual(seat1.position)
    expect(viseOf().rotation).toEqual(seat1.rotation)
    expectSeated(VISE_BB, { position: viseOf().position, rotation: viseOf().rotation }, 'nx', partSideFace)

    const seat2 = seatSecondFace(
      seat1, { x: -1, y: 0, z: 0 }, localBoxFace(VISE_BB, 'pz'), partBottomFace,
    )
    useCamStore.getState().updateGeometryTransform('vise', seat2.position, seat2.rotation)
    expect(viseOf().position).toEqual(seat2.position)
    expectSeated(VISE_BB, { position: viseOf().position, rotation: viseOf().rotation }, 'pz', partBottomFace)
    expectSeated(VISE_BB, { position: viseOf().position, rotation: viseOf().rotation }, 'nx', partSideFace)

    useCamStore.getState().undo()
    expect(viseOf().position).toEqual(seat1.position)
    expect(viseOf().rotation).toEqual(seat1.rotation)

    useCamStore.getState().undo()
    expect(viseOf().position).toEqual(VISE_START_POSE.position)
    expect(viseOf().rotation).toEqual(VISE_START_POSE.rotation)

    // The part's transform was never touched by any of this.
    expect(partOf().position).toEqual(PART_POSE.position)
    expect(partOf().rotation).toEqual(PART_POSE.rotation)
  })
})
