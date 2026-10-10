// GEO-2 architect ruling #2 — the exact FaceSurfaceKind -> SurfaceType
// collapse table (bezier/offset/revolution/extrusion -> bspline-if-spline-
// else-other). Pure, kernel-free.
import { describe, it, expect } from 'vitest'
import { toSurfaceType } from '../../geom/worker/geom-engine.ts'

describe('toSurfaceType (ICR-1 boundary collapse)', () => {
  it('passes contract-native kinds through unchanged', () => {
    expect(toSurfaceType('plane')).toBe('plane')
    expect(toSurfaceType('cylinder')).toBe('cylinder')
    expect(toSurfaceType('cone')).toBe('cone')
    expect(toSurfaceType('sphere')).toBe('sphere')
    expect(toSurfaceType('torus')).toBe('torus')
    expect(toSurfaceType('bspline')).toBe('bspline')
  })

  it('collapses bezier (spline-like) to bspline', () => {
    expect(toSurfaceType('bezier')).toBe('bspline')
  })

  it('collapses offset/revolution/extrusion (not spline-like) to other', () => {
    expect(toSurfaceType('offset')).toBe('other')
    expect(toSurfaceType('revolution')).toBe('other')
    expect(toSurfaceType('extrusion')).toBe('other')
  })

  it('collapses any unrecognized kind to other', () => {
    expect(toSurfaceType('other')).toBe('other')
  })
})
