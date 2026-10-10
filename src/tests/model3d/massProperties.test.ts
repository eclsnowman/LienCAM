// WO UI-4 acceptance #6 (BK-49 rider): mass + CoM. Mass is checked against
// analytic density x volume; CoM against the box fixture's exact analytic
// center, within 1e-6 relative -- valid because a box's tessellation is
// flat-faced/exact (no curve deflection error), so the mesh-derived
// divergence-theorem centroid is exact to floating-point precision, not
// merely "close" the way a curved body's would be.

import { describe, it, expect } from 'vitest'
import { GeometryCache } from '../../viewport3d'
import { makeBoxTessBuffers } from '../../viewport3d/fixtures'
import { computeMassGrams, computeMassProperties, meshVolumeCentroid } from '../../components/model3d/massProperties'

const SIZE = { x: 40, y: 20, z: 10 }
const CENTER = { x: 5, y: -3, z: 2 } // off-origin, so this isn't accidentally trivial

function ingestBox() {
  const cache = new GeometryCache()
  return cache.ingest('box1', makeBoxTessBuffers({ size: SIZE, center: CENTER, featureId: 'F1' }))
}

describe('meshVolumeCentroid (divergence-theorem, exact for a flat-faced box)', () => {
  it('volume matches the analytic L*W*H within 1e-6 relative', () => {
    const body = ingestBox()
    const { volume } = meshVolumeCentroid(body)
    const expected = SIZE.x * SIZE.y * SIZE.z
    expect(Math.abs(volume - expected) / expected).toBeLessThan(1e-6)
  })

  it('centroid matches the box\'s analytic center within 1e-6 relative to the bbox diagonal', () => {
    const body = ingestBox()
    const { centroid } = meshVolumeCentroid(body)
    const diag = Math.hypot(SIZE.x, SIZE.y, SIZE.z)
    expect(Math.abs(centroid.x - CENTER.x) / diag).toBeLessThan(1e-6)
    expect(Math.abs(centroid.y - CENTER.y) / diag).toBeLessThan(1e-6)
    expect(Math.abs(centroid.z - CENTER.z) / diag).toBeLessThan(1e-6)
  })
})

describe('computeMassGrams', () => {
  it('mass = density(g/cm^3 -> g/mm^3) * volume(mm^3), exact arithmetic', () => {
    const volumeMm3 = 40 * 20 * 10 // 8000 mm^3 = 8 cm^3
    const densityGPerCm3 = 2.7 // aluminum 6061
    const mass = computeMassGrams(volumeMm3, densityGPerCm3)
    expect(mass).toBeCloseTo(8 * 2.7, 9) // 8 cm^3 * 2.7 g/cm^3 = 21.6 g
  })
})

describe('computeMassProperties', () => {
  it('mass comes from the supplied EXACT volume, never the mesh-derived one, and CoM matches analytic within 1e-6 relative', () => {
    const body = ingestBox()
    const exactVolume = SIZE.x * SIZE.y * SIZE.z
    const density = 7.87 // steel 1018
    const props = computeMassProperties(body, exactVolume, density, /* hasCurvedFaces */ false)

    expect(props.massGrams).toBeCloseTo(computeMassGrams(exactVolume, density), 9)
    expect(props.volumeMm3).toBe(exactVolume)
    expect(props.centerOfMassApprox).toBe(false)

    const diag = Math.hypot(SIZE.x, SIZE.y, SIZE.z)
    expect(Math.abs(props.centerOfMass.x - CENTER.x) / diag).toBeLessThan(1e-6)
    expect(Math.abs(props.centerOfMass.y - CENTER.y) / diag).toBeLessThan(1e-6)
    expect(Math.abs(props.centerOfMass.z - CENTER.z) / diag).toBeLessThan(1e-6)
  })

  it('labels CoM approx when the caller reports curved faces', () => {
    const body = ingestBox()
    const props = computeMassProperties(body, SIZE.x * SIZE.y * SIZE.z, 2.7, /* hasCurvedFaces */ true)
    expect(props.centerOfMassApprox).toBe(true)
  })
})
