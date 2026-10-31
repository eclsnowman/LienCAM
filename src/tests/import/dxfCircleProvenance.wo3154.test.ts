import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { importDXF } from '../../lib/import/dxfImporter'
import { dxfGeometryFingerprint } from './dxfGeometryFingerprint.wo3154'

type Pairs = Array<[number | string, number | string]>
const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../..')

function dxf(pairs: Pairs): string {
  return pairs.map(([code, value]) => `${code}\n${value}`).join('\n') + '\n'
}

function circle(layer: string, x: number, y: number, radius: number): Pairs {
  return [[0, 'CIRCLE'], [8, layer], [10, x], [20, y], [40, radius]]
}

function bounds(loop: ReturnType<typeof importDXF>['loops'][number]) {
  return {
    minX: Math.min(...loop.points.map(point => point.x)),
    maxX: Math.max(...loop.points.map(point => point.x)),
    minY: Math.min(...loop.points.map(point => point.y)),
    maxY: Math.max(...loop.points.map(point => point.y)),
  }
}

function importedCircleDiameter(loop: ReturnType<typeof importDXF>['loops'][number] & { importedCircleDiameter?: number }) {
  return loop.importedCircleDiameter
}

function assertBmgCircleDiameters(facts: readonly number[]) {
  expect(facts).toHaveLength(2)
  for (const fact of facts) expect(fact).toBeCloseTo(2 * 2.55, 10)
}

describe('WO-3154: analytic DXF CIRCLE provenance is separate from geometry fingerprints', () => {
  it('binds the raw CIRCLE diameter to its own loop and converts drawing units', () => {
    // $INSUNITS=1 is inches. The source CIRCLE radius is 0.125 in, so its
    // analytic diameter is exactly 0.25 * 25.4 = 6.35 mm, independently of
    // the sampled points the importer generates.
    const imported = importDXF(dxf([
      [0, 'SECTION'], [2, 'HEADER'], [9, '$INSUNITS'], [70, 1], [0, 'ENDSEC'],
      [0, 'SECTION'], [2, 'ENTITIES'],
      ...circle('analytic', 0, 0, 0.125),
      [0, 'LWPOLYLINE'], [8, 'polygon'], [90, 4], [70, 1],
      [10, 20], [20, 0], [10, 24], [20, 0], [10, 24], [20, 4], [10, 20], [20, 4],
      [0, 'ENDSEC'], [0, 'EOF'],
    ]), { keepOrigin: true })
    const analytic = imported.loops.find(loop => bounds(loop).maxX < 10)!
    const polygon = imported.loops.find(loop => loop !== analytic)!

    expect(imported.unitScale).toBe(25.4)
    expect(importedCircleDiameter(analytic)).toBeCloseTo(0.25 * 25.4, 12)
    expect(importedCircleDiameter(polygon)).toBeUndefined()
  })

  it('retains source-derived facts on existing CIRCLE fixtures, not a fitted value', () => {
    const bmg = importDXF(readFileSync(join(REPO, 'Sample Parts/BMG.dxf'), 'utf8'))
    const bmgFacts = bmg.loops.map(importedCircleDiameter).filter((value): value is number => value !== undefined)
    // The two raw BMG CIRCLE records each declare radius 2.55 mm.
    assertBmgCircleDiameters(bmgFacts)

    const fixture = importDXF(readFileSync(join(REPO, 'src/tests/evidence/WO-1860/fixture.dxf'), 'utf8'))
    // Its one raw CIRCLE declares radius 8 mm; the neighbouring ARC has no fact.
    expect(fixture.loops.filter(loop => importedCircleDiameter(loop) !== undefined))
      .toHaveLength(1)
    expect(fixture.loops.map(importedCircleDiameter)).toContain(2 * 8)
  })

  it('rejects a bad diameter in either BMG fact and missing or extra facts', () => {
    expect(() => assertBmgCircleDiameters([5.1, 99])).toThrow()
    expect(() => assertBmgCircleDiameters([99, 5.1])).toThrow()
    expect(() => assertBmgCircleDiameters([5.1])).toThrow()
    expect(() => assertBmgCircleDiameters([5.1, 5.1, 5.1])).toThrow()
  })

  it('keeps non-circles and provenance-loss transforms unknown', () => {
    const polygon = importDXF(dxf([
      [0, 'SECTION'], [2, 'ENTITIES'], [0, 'LWPOLYLINE'], [8, 'shape'], [90, 4], [70, 1],
      [10, -2], [20, -2], [10, 2], [20, -2], [10, 2], [20, 2], [10, -2], [20, 2],
      [0, 'ENDSEC'], [0, 'EOF'],
    ]), { keepOrigin: true })
    expect(polygon.loops).toHaveLength(1)
    expect(importedCircleDiameter(polygon.loops[0])).toBeUndefined()

    const nonuniformInsert = importDXF(dxf([
      [0, 'SECTION'], [2, 'BLOCKS'], [0, 'BLOCK'], [2, 'circle-block'], [10, 0], [20, 0],
      ...circle('0', 0, 0, 3), [0, 'ENDBLK'], [0, 'ENDSEC'],
      [0, 'SECTION'], [2, 'ENTITIES'],
      [0, 'INSERT'], [2, 'circle-block'], [8, 'holes'], [10, 0], [20, 0], [41, 2], [42, 1],
      [0, 'ENDSEC'], [0, 'EOF'],
    ]), { keepOrigin: true })
    expect(nonuniformInsert.loops).toHaveLength(1)
    expect(importedCircleDiameter(nonuniformInsert.loops[0])).toBeUndefined()
  })

  it('makes altered, missing, and spurious provenance facts fail their independent assertions', () => {
    const imported = importDXF(dxf([
      [0, 'SECTION'], [2, 'ENTITIES'], ...circle('analytic', 0, 0, 4),
      [0, 'LWPOLYLINE'], [8, 'polygon'], [90, 3], [70, 1],
      [10, 20], [20, 0], [10, 24], [20, 0], [10, 22], [20, 4], [0, 'ENDSEC'], [0, 'EOF'],
    ]), { keepOrigin: true })
    const analytic = imported.loops.find(loop => loop.layerId === 'analytic')!
    const polygon = imported.loops.find(loop => loop.layerId === 'polygon')!
    const expected = 2 * 4

    expect(importedCircleDiameter(analytic)).toBe(expected)
    expect(importedCircleDiameter(polygon)).toBeUndefined()
    expect(() => expect(importedCircleDiameter({ ...analytic, importedCircleDiameter: expected + 1 })).toBe(expected)).toThrow()
    expect(() => expect(importedCircleDiameter({ ...analytic, importedCircleDiameter: undefined })).toBe(expected)).toThrow()
    expect(() => expect(importedCircleDiameter({ ...polygon, importedCircleDiameter: expected })).toBeUndefined()).toThrow()
  })

  it('keeps every pre-existing loop field under the original geometry digest', () => {
    const { report: _report, ...geometry } = importDXF(dxf([
      [0, 'SECTION'], [2, 'ENTITIES'], ...circle('analytic', 0, 0, 4), [0, 'ENDSEC'], [0, 'EOF'],
    ]), { keepOrigin: true })
    const loop = geometry.loops[0]
    const baseline = dxfGeometryFingerprint(geometry)

    expect(dxfGeometryFingerprint({ ...geometry, loops: [{ ...loop, importedCircleDiameter: 999 }] })).toBe(baseline)
    expect(dxfGeometryFingerprint({ ...geometry, loops: [{ ...loop, id: `${loop.id}-changed` }] })).not.toBe(baseline)
    expect(dxfGeometryFingerprint({ ...geometry, loops: [{ ...loop, layerId: `${loop.layerId}-changed` }] })).not.toBe(baseline)
    expect(dxfGeometryFingerprint({ ...geometry, loops: [{ ...loop, points: [{ ...loop.points[0], x: loop.points[0].x + 1 }, ...loop.points.slice(1)] }] })).not.toBe(baseline)
    expect(dxfGeometryFingerprint({ ...geometry, loops: [{ ...loop, arbitraryExistingOrFutureField: 'changed' }] })).not.toBe(baseline)
  })
})
