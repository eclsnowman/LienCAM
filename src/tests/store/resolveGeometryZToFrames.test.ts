// H0 locked-seam converter: resolveGeometryZToFrames expresses a GEOMETRY-LOCAL
// model Z in the WORLD and WCS frames in one call, so the dispatch, the modal
// preview, and the properties panel all agree (ADR-0020 rule 5). Asserts the
// world/WCS math, the undefined-geo verbatim fallback, function-level
// byte-identity with the legacy selectedFaceWorldZ for a step source, and the
// universalized position.z add (escape-hatch E2).

import { describe, it, expect } from 'vitest'
import {
  resolveGeometryZToFrames, isGeometryLocalSource, selectedFaceWorldZ,
} from '../../store/dispatchGeo'
import type { ImportedGeometry } from '../../types'

function makeGeo(over: Partial<ImportedGeometry> = {}): ImportedGeometry {
  return {
    id: 'geo-1', name: 'Part', filename: 'part.step', type: 'brep', format: 'step',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 },
      size: { x: 10, y: 10, z: 10 }, center: { x: 5, y: 5, z: 5 },
    },
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
    ...over,
  }
}

const setupAt = (z: number) => ({ wcs: { origin: { z } } })

describe('resolveGeometryZToFrames', () => {
  it('adds position.z for world, subtracts wcs.origin.z for WCS (both non-zero)', () => {
    // localZ 10, geo at position.z 1 -> world 11; WCS origin 5 -> wcsZ +6.
    const geo = makeGeo({ position: { x: 0, y: 0, z: 1 } })
    const r = resolveGeometryZToFrames(10, geo, setupAt(5))
    expect(r.worldZ).toBeCloseTo(11, 9)
    expect(r.wcsZ).toBeCloseTo(6, 9)
  })

  it('handles a negative position.z and negative wcs origin', () => {
    const geo = makeGeo({ position: { x: 0, y: 0, z: -4 } })
    const r = resolveGeometryZToFrames(10, geo, setupAt(-2))
    expect(r.worldZ).toBeCloseTo(6, 9)   // 10 + (-4)
    expect(r.wcsZ).toBeCloseTo(8, 9)     // 6 - (-2)
  })

  it('undefined geo: worldZ is the local value verbatim (deleted / __all__)', () => {
    const r = resolveGeometryZToFrames(10, undefined, setupAt(3))
    expect(r.worldZ).toBe(10)
    expect(r.wcsZ).toBeCloseTo(7, 9)     // 10 - 3
  })

  it('worldZ is independent of the setup (wcs only affects wcsZ)', () => {
    const geo = makeGeo({ position: { x: 0, y: 0, z: 2.5 } })
    expect(resolveGeometryZToFrames(4, geo, setupAt(0)).worldZ)
      .toBeCloseTo(resolveGeometryZToFrames(4, geo, setupAt(99)).worldZ, 9)
  })

  it('worldZ equals the legacy selectedFaceWorldZ for a STEP source (byte-identical)', () => {
    // selectedFaceWorldZ delegates to the converter; proving they agree at the
    // function level is the byte-identity proof for the only reachable producer.
    const geo = makeGeo({ format: 'step', position: { x: 0, y: 0, z: -4 } })
    expect(resolveGeometryZToFrames(10, geo, setupAt(0)).worldZ)
      .toBeCloseTo(selectedFaceWorldZ(10, geo), 9)
    expect(selectedFaceWorldZ(10, geo)).toBeCloseTo(6, 9)
  })

  it('universal position.z add: a NON-step defined source also gets the offset (E2 fix)', () => {
    // Forward-compat: a non-step geometry-local source (none reachable today)
    // adds position.z just like step, unifying with layerPlaneWorldZ /
    // holeBottomWorldZ (which key on frame === geometry_local, not format).
    const geo = makeGeo({ format: 'dxf', type: 'curves_2d', position: { x: 0, y: 0, z: 3 } })
    expect(resolveGeometryZToFrames(10, geo, setupAt(0)).worldZ).toBeCloseTo(13, 9)
  })
})

describe('isGeometryLocalSource', () => {
  it('true for any defined source geometry (step or otherwise)', () => {
    expect(isGeometryLocalSource(makeGeo({ format: 'step' }))).toBe(true)
    expect(isGeometryLocalSource(makeGeo({ format: 'dxf' }))).toBe(true)
  })

  it('false for a missing source geometry', () => {
    expect(isGeometryLocalSource(undefined)).toBe(false)
  })
})
