// Unit gate for STEP/B-rep import seating: an imported part must land FLAT ON
// THE FLOOR the same way STL does -- XY centre over the origin, bottom face on
// world z = 0 -- with the seat expressed as the part's group position (native
// mesh coords are preserved for the OCCT face/edge derivation).

import { describe, it, expect } from 'vitest'
import { seatedPositionFromBounds } from '../../lib/import/seatGeometry'

describe('seatedPositionFromBounds', () => {
  it('drops a part whose model sits ABOVE the floor down onto z=0', () => {
    // Tray-like: model bottom at z=+5 (hangs above the table before seating).
    const pos = seatedPositionFromBounds({ x: 0, y: 0, z: 5 }, { x: 100, y: 50, z: 15 })
    expect(pos.z).toBe(-5) // world bottom = min.z + pos.z = 0
    expect(pos.x).toBe(-50) // world XY centre = center + pos = origin
    expect(pos.y).toBe(-25)
  })

  it('raises a part whose model sits BELOW the floor up onto z=0 (the STEP bug)', () => {
    // The reported failure: native model origin near the top, body below z=0.
    const pos = seatedPositionFromBounds({ x: -10, y: -10, z: -30 }, { x: 10, y: 10, z: 0 })
    expect(pos.z).toBe(30) // world bottom = -30 + 30 = 0
    expect(pos.x).toBe(0) // already centred in XY
    expect(pos.y).toBe(0)
  })

  it('lands the world bottom on z=0 and the world XY centre on the origin for any box', () => {
    const min = { x: 3, y: -7, z: -2.5 }
    const max = { x: 23, y: 13, z: 40 }
    const pos = seatedPositionFromBounds(min, max)
    // World-space extents after applying the seat position.
    const worldMinZ = min.z + pos.z
    const worldCenterX = (min.x + max.x) / 2 + pos.x
    const worldCenterY = (min.y + max.y) / 2 + pos.y
    expect(worldMinZ).toBeCloseTo(0, 9)
    expect(worldCenterX).toBeCloseTo(0, 9)
    expect(worldCenterY).toBeCloseTo(0, 9)
  })
})
