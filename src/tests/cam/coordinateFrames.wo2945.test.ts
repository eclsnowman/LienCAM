import { describe, expect, it } from 'vitest'
import {
  compose, frameRef, inverse, mapPoint, mapVector, pointMm, rigidMap,
  rigidMapFromPose, sameFrame, vectorMm, worldRingsToDisplayLocalMm,
  type FrameKind, type FrameRef,
} from '../../lib/geometry/coordinateFrames'
import { IDENTITY_MAT4 } from '../../lib/workholding/pose'
import type { Vec3 } from '../../types'

const ref = <F extends FrameKind>(kind: F, entityId: string): FrameRef<F> =>
  frameRef({ kind, entityId, projectEpoch: 'open-1', revision: 'pose-1' })
const local = ref('display-local', 'part')
const world = ref('world', 'project')
const work = ref('setup-work', 'setup')
const pose = { position: { x: 40, y: -25, z: 8 }, rotation: { x: 0, y: 0, z: 90 } }
const placed = rigidMapFromPose(local, world, pose)

function near(a: Readonly<Vec3>, b: Readonly<Vec3>): void {
  for (const axis of ['x', 'y', 'z'] as const) {
    const tolerance = Math.max(1e-9, 64 * Number.EPSILON * Math.abs(b[axis]))
    expect(Math.abs(a[axis] - b[axis])).toBeLessThanOrEqual(tolerance)
  }
}

// Pinned legacy arithmetic, read from main's worldRingsToLocalFrame. This is a
// compatibility oracle, not a second production authority or an engine fixture.
function legacy(rings: Float64Array[], position: Vec3, yaw: number): Float64Array[] {
  if (position.x === 0 && position.y === 0 && yaw === 0) return rings
  const c = Math.cos(yaw * Math.PI / 180), s = Math.sin(yaw * Math.PI / 180)
  return rings.map(ring => {
    const out = new Float64Array(ring.length)
    for (let i = 0; i < ring.length; i += 2) {
      const dx = ring[i] - position.x, dy = ring[i + 1] - position.y
      out[i] = dx * c + dy * s
      out[i + 1] = -dx * s + dy * c
    }
    return out
  })
}

describe('WO-2945 typed shared frame authority', () => {
  it('translates points but only rotates vectors, and round-trips world/local', () => {
    const p = pointMm(local, { x: 3, y: 4, z: -2 })
    near(mapPoint(placed, p).value, { x: 36, y: -22, z: 6 })
    near(mapVector(placed, vectorMm(local, p.value)).value, { x: -4, y: 3, z: -2 })
    near(mapPoint(inverse(placed), mapPoint(placed, p)).value, p.value)
  })

  it('composes with explicit direction through a rotated translated setup', () => {
    const workToWorld = rigidMapFromPose(work, world, {
      position: { x: -10, y: 20, z: 5 }, rotation: { x: 0, y: 0, z: -30 },
    })
    const worldToWork = inverse(workToWorld)
    const localToWork = compose(worldToWork, placed)
    const p = pointMm(local, { x: 1, y: 2, z: 3 })
    near(mapPoint(localToWork, p).value, mapPoint(worldToWork, mapPoint(placed, p)).value)
    near(mapPoint(inverse(localToWork), mapPoint(localToWork, p)).value, p.value)
  })

  it('reuses full XYZ/flip math without enabling tilted planar machining', () => {
    for (const rotation of [{ x: 23, y: -17, z: 61 }, { x: 180, y: 0, z: 0 }, { x: 0, y: 180, z: 0 }]) {
      const map = rigidMapFromPose(local, world, { ...pose, rotation })
      const p = pointMm(local, { x: 2, y: 5, z: -3 })
      near(mapPoint(inverse(map), mapPoint(map, p)).value, p.value)
    }
  })

  it('rejects same-kind wrong entity, revision and reopen epoch, including composition', () => {
    for (const changed of [{ entityId: 'other' }, { revision: 'pose-2' }, { projectEpoch: 'open-2' }]) {
      const stale = { ...local, ...changed }
      expect(sameFrame(local, stale)).toBe(false)
      expect(() => mapPoint(placed, pointMm(stale, { x: 0, y: 0, z: 0 }))).toThrow(/mismatch/)
      expect(() => mapVector(placed, vectorMm(stale, { x: 1, y: 0, z: 0 }))).toThrow(/mismatch/)
    }
    const otherWorld = { ...world, revision: 'changed' }
    expect(() => compose(rigidMap(otherWorld, work, IDENTITY_MAT4), placed)).toThrow(/mismatch/)
    expect(() => rigidMap(local, { ...world, projectEpoch: 'open-2' }, IDENTITY_MAT4)).toThrow(/epochs/)
  })

  it('takes immutable copies of frame, point and matrix inputs', () => {
    const input = { ...local }
    const xyz = { x: 1, y: 2, z: 3 }
    const matrix = [...IDENTITY_MAT4]
    const p = pointMm(input, xyz)
    const map = rigidMap(input, world, matrix)
    input.revision = 'edited'; xyz.x = 999; matrix[12] = 999
    expect(p.frame.revision).toBe('pose-1')
    expect(mapPoint(map, p).value).toEqual({ x: 1, y: 2, z: 3 })
    expect(Object.isFrozen(p.value)).toBe(true)
    expect(Object.isFrozen(map.from)).toBe(true)
  })

  it('rejects non-finite values, scale, shear, reflection and non-affine transforms', () => {
    for (const value of [NaN, Infinity, -Infinity]) {
      expect(() => pointMm(local, { x: value, y: 0, z: 0 })).toThrow(/finite/)
      expect(() => vectorMm(local, { x: 0, y: value, z: 0 })).toThrow(/finite/)
    }
    for (const [index, value] of [[0, 2], [0, -1], [4, 0.1], [3, 0.1], [15, 2], [12, Infinity]]) {
      const matrix = [...IDENTITY_MAT4]; matrix[index] = value
      expect(() => rigidMap(local, world, matrix)).toThrow(/rigid/)
    }
    expect(() => rigidMap(local, world, [1])).toThrow(/rigid/)
    expect(() => frameRef({ ...world, revision: '' })).toThrow(/explicit/)
  })

  it('keeps point/vector and frame directions distinct at compile time', () => {
    // This branch is typechecked by the required build, never executed.
    // eslint-disable-next-line no-constant-condition -- compile-time negative assertions only
    if (false) {
      // @ts-expect-error A vector is not a point.
      mapPoint(placed, vectorMm(local, { x: 1, y: 0, z: 0 }))
      // @ts-expect-error A point is not a vector.
      mapVector(placed, pointMm(local, { x: 1, y: 0, z: 0 }))
      // @ts-expect-error World input cannot be consumed as display-local.
      mapPoint(placed, pointMm(world, { x: 1, y: 0, z: 0 }))
      // @ts-expect-error Composition in the wrong direction is not allowed.
      compose(placed, placed)
    }
    expect(true).toBe(true)
  })
})

describe('WO-2945 planar compatibility boundary', () => {
  it('preserves identity array/rings even for nonzero Z and empty rings', () => {
    const rings = [new Float64Array([0, 0, 1, 0, 1, 1]), new Float64Array()]
    expect(worldRingsToDisplayLocalMm(rings, { x: 0, y: 0, z: 400 }, 0)).toBe(rings)
    expect(worldRingsToDisplayLocalMm([], { x: 1, y: 2, z: 3 }, 90)).toEqual([])
  })

  it.each([0, 90, -90, 37, 180, 360, 1e-12, 1e8])('preserves main arithmetic, Float64, winding and input order at yaw %s', yaw => {
    for (const position of [{ x: 40, y: -25, z: 8 }, { x: 1e12, y: -1e12, z: -1e9 }, { x: 1e-9, y: -1e-9, z: 0 }]) {
      const rings = [
        new Float64Array([position.x, position.y, position.x + 2, position.y, position.x + 2, position.y + 1]),
        new Float64Array([position.x + 0.5, position.y + 0.5, position.x + 0.5, position.y + 0.75, position.x + 0.75, position.y + 0.5]),
      ]
      const saved = rings.map(r => r.slice())
      const actual = worldRingsToDisplayLocalMm(rings, position, yaw)
      expect(actual).toEqual(legacy(rings, position, yaw))
      expect(actual.every(r => r instanceof Float64Array)).toBe(true)
      expect(rings).toEqual(saved)
      expect(actual).not.toBe(rings)
    }
  })

  it('retains signed-zero arithmetic at an offset origin', () => {
    const p = { x: 0, y: 1, z: 0 }
    const rings = [new Float64Array([-0, 2, 0, 1])]
    expect(worldRingsToDisplayLocalMm(rings, p, -0)).toEqual(legacy(rings, p, -0))
  })

  it('maps a known translated/yawed footprint exactly once and round-trips its corners', () => {
    const ring = new Float64Array([40, -25, 40, -21, 37, -21, 37, -25])
    const localRing = worldRingsToDisplayLocalMm([ring], pose.position, 90)[0]
    const expected = [0, 0, 4, 0, 4, 3, 0, 3]
    for (let i = 0; i < expected.length; i++) expect(localRing[i]).toBeCloseTo(expected[i], 12)
    for (let i = 0; i < ring.length; i += 2) {
      const p = mapPoint(placed, pointMm(local, { x: localRing[i], y: localRing[i + 1], z: 0 }))
      near(p.value, { x: ring[i], y: ring[i + 1], z: pose.position.z })
    }
  })
})
