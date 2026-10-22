import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { createGeometryService, faceAdapter, adaptiveAdapter, vcarveAdapter, cam3dAdapter,
  fromRings, toRings, signedArea, locatePoint } from '../../kernel/geometry'
import type { Backend, Loop, Loops, Path } from '../../kernel/geometry'
import * as face from '../../lib/cam/face2d/clipperOffset'
import * as adaptive from '../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import * as vcarve from '../../lib/cam/vcarve2d/clipper'
import * as geom3d from '../../cam3d/geom2d'
import * as script from '../../lib/cam/geometry'
import { pocketBox } from '../../cam3d/fixtures'
import { sliceAtZ, buildLoops } from '../../lib/geometry/stlProjection'

const square: Loop = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]
const paths = (loops: Loops, closed = true): Path[] => loops.map((points, i) => ({ id: `loop-${i}`, points, closed }))
const netArea = (loops: Loops) => loops.reduce((sum, loop) => sum + signedArea(loop), 0)
interface Fixture { pockets: { boundary: Loop; islands: Loops }[] }
const fixture = (name: string): Loops => {
  const data = JSON.parse(readFileSync(`test_fixtures/adaptive-clearing/prepared/${name}.json`, 'utf8')) as Fixture
  return data.pockets.flatMap(p => [p.boundary, ...p.islands])
}
const cases = [
  { name: 'face', backend: faceAdapter(face, script.pointInPolygon), old: (loops: Loops, d: number) => loops.flatMap(l => face.offsetLoop(l, d)) },
  { name: 'adaptive', backend: adaptiveAdapter(adaptive), old: adaptive.offsetClosed },
  { name: 'vcarve', backend: vcarveAdapter(vcarve), old: vcarve.offsetLoops },
  { name: 'cam3d', backend: cam3dAdapter(geom3d), old: (loops: Loops, d: number) => fromRings(geom3d.offset(toRings(loops), d)) },
]
beforeAll(async () => {
  await Promise.all([face.ensureClipperReady(), adaptive.ensureEngineClipperReady(), vcarve.ensureVCarveClipperReady(), geom3d.ensureGeom2dReady()])
})

describe('WO-2931 real existing backend parity (exact vertex order and topology)', () => {
  for (const { name, backend, old } of cases) {
    for (const corpus of ['BootL', 'Barbell', 'SquareIsland', 'Triangle']) {
      it(`${name}: BL-282 ${corpus} inward/outward/zero vertex identity`, () => {
        const loops = fixture(corpus)
        const before = JSON.stringify(loops)
        const service = createGeometryService(backend)
        for (const delta of [-0.5, 0, 0.5]) {
          const expected = old(loops, delta)
          const actual = service.offset(paths(loops), delta)
          expect(actual.status).toBe('supported')
          // Exact arrays imply identical topology, winding, start index and 0 mm
          // vertex error, tighter than one 1e-4/1e-6 precision unit.
          expect(actual.value).toEqual(expected)
          expect(actual.value?.map(l => Math.sign(signedArea(l)))).toEqual(expected.map(l => Math.sign(signedArea(l))))
        }
        expect(JSON.stringify(loops)).toBe(before)
      })
    }
    it(`${name}: BL-281 real pocketBox section through existing slicer`, () => {
      const mesh = pocketBox()
      const loops = buildLoops(sliceAtZ(mesh.positions, mesh.indices, 20))
      expect(loops).toHaveLength(2)
      // Slicer orientation is not normalised by this new service; preserve its
      // native loops and compare to exactly the same wrapper input.
      expect(loops.map(l => Math.abs(signedArea(l))).sort((a, b) => a - b)).toEqual([1200, 4800])
      const actual = createGeometryService(backend).offset(paths(loops), -1)
      expect(actual.status).toBe('supported')
      expect(actual.value).toEqual(old(loops, -1))
    })
    it(`${name}: collapse and clockwise input match the native wrapper`, () => {
      const service = createGeometryService(backend)
      expect(service.offset(paths([square]), -20)).toMatchObject({ status: 'supported', value: [], diagnostics: [{ code: 'collapsed' }] })
      for (const d of [-1, 1]) expect(service.offset(paths([[...square].reverse()]), d).value).toEqual(old([[...square].reverse()], d))
      // V-carve final Positive union discards the isolated CW contour.
      // The owner ordered legacy parity, not the draft's future normalisation.
      expect(Math.abs(netArea(service.offset(paths([square]), -1).value!))).toBeCloseTo(64, 6)
      expect(Math.abs(netArea(service.offset(paths([[...square].reverse()]), -1).value!))).toBeCloseTo(name === 'vcarve' ? 0 : 64, 6)
    })
    it(`${name}: self intersection proceeds with a named diagnostic and native result`, () => {
      const bowtie = [square[0], square[2], square[1], square[3]]
      const actual = createGeometryService(backend).offset(paths([bowtie]), 0.5)
      expect(actual.status).toBe('supported')
      expect(actual.diagnostics.some(d => d.code === 'self-intersection' && d.pathId === 'loop-0')).toBe(true)
      expect(actual.value).toEqual(old([bowtie], 0.5))
    })
    it(`${name}: open chains are named and skipped in a closed operation`, () => {
      const service = createGeometryService(backend)
      const input = [...paths([square]), { id: 'open-wire', closed: false, points: square.slice(0, 2) }]
      const actual = service.offset(input, -1)
      expect(actual.status).toBe('degraded')
      expect(actual.diagnostics).toContainEqual({ code: 'open-skipped', pathId: 'open-wire', message: 'open chain open-wire skipped - this operation needs closed loops' })
      expect(actual.value).toEqual(old([square], -1))
      expect(service.offset([input[1]], -1)).toMatchObject({ status: 'degraded', value: [] })
    })
  }
  it('preserves face zero-distance bypass and minArea filtering', () => {
    const service = createGeometryService(faceAdapter(face))
    expect(service.offset(paths([square]), 0, { minArea: 1000 }).value).toEqual([square])
    expect(service.offset(paths([square]), -1, { minArea: 1000 }).value).toEqual([])
    expect(service.offset(paths([square]), -1, { minArea: 60 }).value).toEqual(face.offsetLoop(square, -1, 60))
  })
  it('supports adaptive open-round corridors but skips inward open requests', () => {
    const service = createGeometryService(adaptiveAdapter(adaptive))
    const chain = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }]
    expect(service.offset(paths([chain], false), 1, { mode: 'open-round' }).value).toEqual(adaptive.offsetOpenRound(chain, 1))
    const negative = service.offset(paths([chain], false), -1, { mode: 'open-round' })
    expect(negative).toMatchObject({ status: 'degraded', value: [] })
    expect(negative.diagnostics[0].pathId).toBe('loop-0')
  })
  it('preserves actual wrapper precision differences rather than rounding every profile', () => {
    const fractional = square.map(p => ({ x: p.x + 0.000037, y: p.y + 0.000037 }))
    const a = createGeometryService(adaptiveAdapter(adaptive)).offset(paths([fractional]), -1).value!
    const b = createGeometryService(cam3dAdapter(geom3d)).offset(paths([fractional]), -1).value!
    expect(a).toEqual(adaptive.offsetClosed([fractional], -1))
    expect(b).toEqual(fromRings(geom3d.offset(toRings([fractional]), -1)))
    expect(a).not.toEqual(b)
    expect(Math.min(...a[0].map(p => p.x))).toBeCloseTo(1, 8)
    expect(Math.min(...b[0].map(p => p.x))).toBeCloseTo(1.000037, 8)
  })
  it('carries real per-operation arc tolerance and join choices through adapters', () => {
    const loops = fixture('Barbell')
    expect(createGeometryService(adaptiveAdapter(adaptive)).offset(paths(loops), 1, { arcTolerance: 0.007 }).value)
      .toEqual(adaptive.offsetClosed(loops, 1, 0.007))
    expect(createGeometryService(vcarveAdapter(vcarve)).offset(paths(loops), 1, { arcTolerance: 0.007 }).value)
      .toEqual(vcarve.offsetLoops(loops, 1, 0.007))
    expect(createGeometryService(cam3dAdapter(geom3d)).offset(paths(loops), 1, { join: 'miter', arcTolerance: 0.007 }).value)
      .toEqual(fromRings(geom3d.offset(toRings(loops), 1, { joinType: 'miter', arcTolerance: 0.007 })))
  })
  it('checks round-offset area against independent closed-form truth', () => {
    for (const { backend } of cases) {
      const output = createGeometryService(backend).offset(paths([square]), 1).value!
      const expected = 100 + 40 + Math.PI
      // Each wrapper has a different arc/decimation policy. The finite vertex
      // polygon area deficit is bounded by perimeter times its own fidelity.
      const bound = 2 * Math.PI * (backend.profile.arcTolerance! + (backend.profile.decimation ?? 0))
      expect(Math.abs(Math.abs(netArea(output)) - expected)).toBeLessThan(bound)
    }
  })
  it('preserves native adaptive exact-boundary membership', () => {
    const service = createGeometryService(adaptiveAdapter(adaptive))
    for (const point of [{ x: 0, y: 5 }, { x: 10, y: 5 }, { x: 5, y: 5 }, { x: -1, y: 5 }]) {
      expect(service.predicate(point, paths([square])[0]).value?.legacyMembership).toBe(adaptive.pointInPolygon(point, square))
    }
    expect(service.predicate({ x: 10, y: 5 }, paths([square])[0]).value).toEqual({ location: 'boundary', legacyMembership: 0 })
  })
})

describe('WO-2931 boolean fill, islands and topology controls', () => {
  const hole = square.map(p => ({ x: p.x / 2 + 2, y: p.y / 2 + 2 })).reverse()
  const clip = square.map(p => ({ x: p.x + 5, y: p.y }))
  const booleanCases: { backend: Backend; old: (a: Loops, b: Loops, op: 'union' | 'difference' | 'intersect') => Loops }[] = [
    { backend: adaptiveAdapter(adaptive), old: (a, b, op) => op === 'union' ? adaptive.union(a, b) : op === 'difference' ? adaptive.difference(a, b) : adaptive.intersection(a, b) },
    { backend: vcarveAdapter(vcarve), old: (a, b, op) => vcarve.treeToOrientedLoops(op === 'union' ? vcarve.unionNonZeroTree([...a, ...b]) : vcarve.differenceTree(a, b)) },
    { backend: cam3dAdapter(geom3d), old: (a, b, op) => fromRings(geom3d.boolean(toRings(a), toRings(b), op)) },
  ]
  for (const { backend, old } of booleanCases) {
    it(`${backend.profile.id}: real booleans preserve vertices, topology and hole winding`, () => {
      const service = createGeometryService(backend)
      for (const op of ['union', 'difference', 'intersect'] as const) {
        if (!backend.booleans.includes(op)) continue
        const a = [square, hole]
        expect(service.boolean(paths(a), paths([clip]), op).value).toEqual(old(a, [clip], op))
      }
      const cut = service.boolean(paths([square]), paths([[...hole].reverse()]), 'difference').value!
      expect(cut).toHaveLength(2)
      expect(cut.map(l => Math.sign(signedArea(l))).sort()).toEqual([-1, 1])
      expect(netArea(cut)).toBe(75)
      expect(locatePoint({ x: 3, y: 3 }, cut)).toBe('outside')
      expect(service.boolean(paths([square]), paths([clip]), 'union').value).toEqual(old([square], [clip], 'union'))
      expect(netArea(service.boolean(paths([square]), paths([clip]), 'union').value!)).toBe(150)
    })
  }
  it('retains EvenOdd vs NonZero union differences on overlapping loops in one operand', () => {
    const a = createGeometryService(adaptiveAdapter(adaptive)).boolean(paths([square, clip]), [], 'union').value!
    const b = createGeometryService(vcarveAdapter(vcarve)).boolean(paths([square, clip]), [], 'union').value!
    expect(netArea(a)).toBe(100)
    expect(netArea(b)).toBe(150)
    expect(locatePoint({ x: 7, y: 5 }, a)).toBe('outside')
    expect(locatePoint({ x: 7, y: 5 }, b)).toBe('inside')
  })
  it('reports unsupported geom2d empty operands without fabricating a fallback', () => {
    expect(createGeometryService(cam3dAdapter(geom3d)).boolean(paths([square]), [], 'union').status).toBe('unsupported')
    expect(createGeometryService(vcarveAdapter(vcarve)).boolean(paths([square]), [], 'intersect').status).toBe('unsupported')
    const xor = createGeometryService(cam3dAdapter(geom3d)).boolean(paths([square]), paths([clip]), 'xor')
    expect(xor.value).toEqual(fromRings(geom3d.boolean(toRings([square]), toRings([clip]), 'xor')))
    expect(netArea(xor.value!)).toBe(100)
  })
})
