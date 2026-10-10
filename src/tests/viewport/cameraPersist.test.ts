// Pure round-trip tests for the camera-pose (de)serialization helper used by
// refresh-persistence (Viewport.tsx mount restore). serializeCamera converts a
// live pose (THREE.Vector3-like) into a JSON-safe shape; deserializeCamera parses
// it back and rejects malformed/non-finite data so a stale localStorage value
// falls back to the default framing instead of crashing.

import { describe, it, expect } from 'vitest'
import {
  serializeCamera, deserializeCamera, type CameraPose,
} from '../../lib/viewport/cameraPersist'

const pose: CameraPose = {
  position: { x: 123.5, y: -400, z: 350.25 },
  target: { x: 1, y: 2, z: 3 },
  zoom: 1.75,
}

describe('cameraPersist round-trip', () => {
  it('serializes a pose into JSON-safe arrays + zoom', () => {
    expect(serializeCamera(pose)).toEqual({
      position: [123.5, -400, 350.25],
      target: [1, 2, 3],
      zoom: 1.75,
    })
  })

  it('round-trips serialize -> deserialize back to the same pose', () => {
    const out = deserializeCamera(serializeCamera(pose))
    expect(out).toEqual(pose)
  })

  it('round-trips through a JSON string (the real localStorage path)', () => {
    const raw = JSON.parse(JSON.stringify(serializeCamera(pose)))
    expect(deserializeCamera(raw)).toEqual(pose)
  })
})

describe('cameraPersist rejects malformed input', () => {
  it('returns null for null / non-object', () => {
    expect(deserializeCamera(null)).toBeNull()
    expect(deserializeCamera(undefined)).toBeNull()
    expect(deserializeCamera(42)).toBeNull()
  })

  it('returns null for a wrong-length or non-finite vector', () => {
    expect(deserializeCamera({ position: [1, 2], target: [1, 2, 3], zoom: 1 })).toBeNull()
    expect(deserializeCamera({ position: [1, 2, NaN], target: [1, 2, 3], zoom: 1 })).toBeNull()
    expect(deserializeCamera({ position: [1, 2, 3], target: [1, 2, 3], zoom: NaN })).toBeNull()
  })

  it('returns null for a non-positive zoom', () => {
    expect(deserializeCamera({ position: [1, 2, 3], target: [1, 2, 3], zoom: 0 })).toBeNull()
    expect(deserializeCamera({ position: [1, 2, 3], target: [1, 2, 3], zoom: -1 })).toBeNull()
  })
})

// frustumSize is the SCALE half of the persisted view (see cameraPersist header):
// without it a refresh restores position/target/zoom onto the constructor-default
// frustumSize, so the apparent size of the saved view is wrong. It is OPTIONAL so
// pre-frustumSize localStorage data still restores.
describe('cameraPersist frustumSize round-trip + old-data fallback', () => {
  const withFrustum: CameraPose = { ...pose, frustumSize: 340 }

  it('serializes and round-trips frustumSize', () => {
    expect(serializeCamera(withFrustum).frustumSize).toBe(340)
    const out = deserializeCamera(serializeCamera(withFrustum))
    expect(out).not.toBeNull()
    expect(out!.frustumSize).toBe(340)
    expect(out).toEqual(withFrustum)
  })

  it('OMITS frustumSize when the live pose has none / a bad value (never writes junk)', () => {
    expect(serializeCamera(pose).frustumSize).toBeUndefined()
    expect(serializeCamera({ ...pose, frustumSize: NaN }).frustumSize).toBeUndefined()
    expect(serializeCamera({ ...pose, frustumSize: 0 }).frustumSize).toBeUndefined()
    expect(serializeCamera({ ...pose, frustumSize: -5 }).frustumSize).toBeUndefined()
  })

  it('GRACEFUL FALLBACK: old data with NO frustumSize still deserializes (pose kept)', () => {
    const out = deserializeCamera({ position: [1, 1, 1], target: [0, 0, 0], zoom: 2 })
    expect(out).not.toBeNull()
    expect(out!.frustumSize).toBeUndefined()
    expect(out!.zoom).toBe(2)
  })

  it('drops a non-finite / non-positive stored frustumSize but KEEPS the rest of the pose', () => {
    const out = deserializeCamera({ position: [1, 1, 1], target: [0, 0, 0], zoom: 2, frustumSize: -3 })
    expect(out).not.toBeNull()
    expect(out!.frustumSize).toBeUndefined()
  })
})
