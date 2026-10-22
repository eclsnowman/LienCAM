import { describe, expect, it } from 'vitest'
import { createGeometryService, scriptAdapter, faceAdapter, profiles, parityTolerance,
  signedArea, locatePoint, containsRegion, selfIntersects } from '../../kernel/geometry'
import type { Loop, Path } from '../../kernel/geometry'
import * as script from '../../lib/cam/geometry'
import { CHORD_LEN_MM } from '../../lib/import/dxfCurves'
import { HELIX_FI_STEP } from '../../lib/cam/threadHelix'

const square: Loop = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]
const path = (points = square, closed = true, id = 'outer'): Path => ({ id, closed, points })
const service = createGeometryService(scriptAdapter(script))

describe('WO-2931 geometry service contract without DOM or store', () => {
  it('runs headlessly and preserves signed area in either orientation', () => {
    expect(typeof document).toBe('undefined')
    expect(signedArea(square)).toBe(100)
    expect(signedArea([...square].reverse())).toBe(-100)
    expect(signedArea([])).toBe(0)
  })
  it('reports exact boundary independently from the legacy edge-dependent raycast', () => {
    for (const point of [{ x: 0, y: 5 }, { x: 10, y: 5 }, ...square]) {
      expect(service.predicate(point, path()).value).toEqual({ location: 'boundary', legacyMembership: script.pointInPolygon(point, square) })
    }
    expect(service.predicate({ x: 0, y: 5 }, path()).value?.legacyMembership).toBe(true)
    expect(service.predicate({ x: 10, y: 5 }, path()).value?.legacyMembership).toBe(false)
    expect(service.predicate({ x: 5, y: 5 }, path()).value?.location).toBe('inside')
    expect(service.predicate({ x: 10 + 1e-10, y: 5 }, path()).value?.location).toBe('outside')
    expect(service.predicate({ x: 10 - 1e-10, y: 5 }, path()).value?.location).toBe('inside')
  })
  it('makes island fill and boundary membership explicit', () => {
    const hole = square.map(p => ({ x: p.x / 2 + 2, y: p.y / 2 + 2 })).reverse()
    expect(locatePoint({ x: 3, y: 3 }, [square, hole], 'NonZero')).toBe('outside')
    expect(locatePoint({ x: 3, y: 3 }, [square, [...hole].reverse()], 'NonZero')).toBe('inside')
    expect(locatePoint({ x: 3, y: 3 }, [square, [...hole].reverse()], 'EvenOdd')).toBe('outside')
    expect(containsRegion({ x: 0, y: 5 }, [square], 'NonZero', 'include')).toBe(true)
    expect(containsRegion({ x: 0, y: 5 }, [square], 'NonZero', 'exclude')).toBe(false)
  })
  it.each([[], [path([])], [path([{ x: NaN, y: 1 }])], [path([{ x: 1, y: Infinity }])]].map(paths => ({ paths })))('rejects empty/nonfinite input: $paths', ({ paths }) => {
    expect(service.offset(paths, 1).status).toBe('rejected')
    expect(service.offset(paths, 1).diagnostics[0].code).toBe('invalid-input')
  })
  it('validates parameters and predicate geometry', () => {
    expect(service.offset([path()], NaN).status).toBe('rejected')
    expect(service.offset([path()], 1, { arcTolerance: 0 }).status).toBe('rejected')
    expect(service.offset([path()], 1, { minArea: -1 }).status).toBe('rejected')
    expect(service.predicate({ x: Infinity, y: 0 }, path()).status).toBe('rejected')
    expect(service.predicate({ x: 1, y: 0 }, path(square, false)).status).toBe('unsupported')
  })
  it('does not substitute a closed-region or round-corridor method for signed-side offsets', () => {
    expect(service.offset([path()], 1).status).toBe('unsupported')
    expect(service.offset([path(square, false)], 1, { mode: 'open-round' }).status).toBe('unsupported')
    expect(service.boolean([path()], [], 'union').status).toBe('unsupported')
    const chain = square.slice(0, 3)
    for (const delta of [-1, 0, 1]) {
      expect(service.offset([path(chain, false)], delta, { mode: 'open-side' }).value)
        .toEqual([script.offsetOpenChain(chain, delta, 4)])
    }
    expect(service.offset([path(chain, false)], 1, { mode: 'open-side' }).value?.[0])
      .toEqual([{ x: 0, y: -1 }, { x: 11, y: -1 }, { x: 11, y: 10 }])
  })
  it('recognises crossing, touch, overlap, and explicit closing vertices without normalising', () => {
    expect(selfIntersects(square)).toBe(false)
    expect(selfIntersects([...square, square[0]])).toBe(false)
    expect(selfIntersects([square[0], square[2], square[1], square[3]])).toBe(true)
    expect(selfIntersects([square[0], square[1], { x: 5, y: 0 }, square[3]])).toBe(true)
  })
  it('does not hide backend failure or silently fall back', () => {
    const broken = createGeometryService(faceAdapter({ offsetLoop: () => { throw new Error('not ready') } }))
    expect(broken.offset([path()], 1)).toMatchObject({ status: 'rejected', value: null, diagnostics: [{ code: 'backend-error', message: 'not ready' }] })
  })
  it('retains fixed face precision, fidelity split and unsupported settings', () => {
    expect(profiles.face).toMatchObject({ precision: 6, arcTolerance: 0.0025, decimation: 0.0025 })
    expect(profiles.adaptive.precision).toBe(4)
    expect(profiles.cam3d.precision).toBe(6)
    expect(Object.isFrozen(profiles.face)).toBe(true)
    const face = createGeometryService(faceAdapter({ offsetLoop: loop => [loop] }))
    expect(face.offset([path()], 1, { arcTolerance: 0.02 }).status).toBe('unsupported')
    expect(face.offset([path()], 1, { join: 'miter' }).status).toBe('unsupported')
  })
  it('exposes actual tolerance origins, overrides and no selectable new budget', () => {
    const t = parityTolerance({ camTolerance: 0.04, inputResolutionMm: 0.1 })
    expect(t.policy).toBe('parity')
    expect(t.budget).toBeNull()
    expect(t.importChord).toMatchObject({ value: CHORD_LEN_MM, unit: 'mm' })
    expect(t.tessellationDeflection.value).toBe(0.01)
    expect(t.postArcFit.value).toBe(0.05)
    expect(t.displayChord.value).toBe(0.35)
    expect(t.displayAngle.value).toBe(7.5)
    expect(t.helixAdaptive.value).toBe(HELIX_FI_STEP)
    expect(t.helixThread.value).toBe(HELIX_FI_STEP)
    expect(t.helix2d.value).toBe(36)
    expect(t.helix3d.value).toBe(24)
    expect(t.adaptivePrefit.value).toBe(0.01)
    expect(t.diagnostics).toHaveLength(1)
    expect(parityTolerance({ camTolerance: 0.1, postArcFitTolerance: 0.08 }).postArcFit.value).toBe(0.08)
    for (const item of Object.values(t).filter(v => typeof v === 'object' && v !== null && 'origin' in v)) expect(item.origin).toMatch(/src\//)
    expect(() => parityTolerance({ camTolerance: 0 })).toThrow()
    expect(() => parityTolerance({ camTolerance: NaN })).toThrow()
    expect(() => parityTolerance({ camTolerance: 1, postArcFitTolerance: Infinity })).toThrow()
  })
})
