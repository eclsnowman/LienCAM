// C0 census: raw wire-prism controls enter consumers via real service STEP import.
// This does not claim native surface-extrude UI or archive replay exists yet.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { OcctKernel, type ShapeHandle } from 'occt-wasm'
import { parseEdgeToFaceMap } from '../../geom/worker/planarAdjacency'
import { createLocalGeomService } from '../../geom'
import type { BodyHandle, ImportedBody } from '../../geom/geom-service'
import { GeometryCache } from '../../viewport3d/GeometryCache'
import { PickEngine } from '../../viewport3d/PickEngine'
import { modelBodyDisplayFromCached } from '../../viewport3d/modelBodyDisplay'
import { buildModelBodyGeometry } from '../../lib/cam/modelBodyAdapter'
import { deriveModelBodySection, deriveModelBodyDrillTargets } from '../../lib/cam/modelBodyDerive'
import { deriveStockBounds } from '../../store/stockAssignment'
import { BvhKernel } from '../../cam3d/kernel/bvhKernel'
import { Cam3dClient, type WorkerLike } from '../../cam3d/worker/client'
import { Cam3dDispatcher } from '../../cam3d/worker/dispatcher'
import type { Cam3dRequest, Cam3dResponse } from '../../cam3d/worker/protocol'
import { computeParallel3dMoves } from '../../cam3d/integration/parallel3dOperation'
import type { Tool } from '../../types'

const svc = createLocalGeomService()
const cache = new GeometryCache()
let k: OcctKernel
const owned: ShapeHandle[] = []
const own = (h: ShapeHandle): ShapeHandle => { owned.push(h); return h }
const observations: Record<string, unknown> = {}
const zero = { x: 0, y: 0, z: 0 }
const placements = [{ modelItemId: 'legacy', position: zero, rotation: zero }]
const sheets = [
  { name: 'open', area: 240, faces: 1, edges: 4, boundary: 4, loops: 0 },
  { name: 'rectangle', area: 960, faces: 4, edges: 12, boundary: 8, loops: 1 },
  { name: 'circles', area: 240 * Math.PI, faces: 2, edges: 6, boundary: 4, loops: 2 },
] as const
const bodies = new Map<string, ImportedBody>()

function line(a: [number, number, number], b: [number, number, number]): ShapeHandle {
  return own(k.makeLineEdge({ x: a[0], y: a[1], z: a[2] }, { x: b[0], y: b[1], z: b[2] }))
}
function prism(edges: ShapeHandle[], vector: [number, number, number] = [0, 0, 8]): ShapeHandle {
  return own(k.extrude(own(k.makeWire(edges)), ...vector))
}
function count(shape: ShapeHandle, type: 'solid' | 'face' | 'edge'): number {
  const handles = k.getSubShapes(shape, type)
  handles.forEach(own)
  return handles.length
}
async function importShape(shape: ShapeHandle, id: string): Promise<ImportedBody> {
  const result = await svc.importStep(new TextEncoder().encode(k.exportStep(shape)).buffer, id)
  expect(result.diagnostics.filter(d => d.severity === 'error')).toEqual([])
  observations[`${id}.stepImportBodies`] = result.bodies.length
  expect(result.bodies).toHaveLength(id === 'circles' ? 2 : 1)
  if (result.bodies.length === 1) return result.bodies[0]
  // XCAF decomposes the two disconnected circular sheets into two leaves.
  // Preserve both, then use the service BREP seam for a single compound body.
  const elementMap = { featureId: id, modified: {}, deleted: [],
    generated: result.bodies.flatMap(b => b.elementMap.generated),
    geometry: Object.assign({}, ...result.bodies.map(b => b.elementMap.geometry)) }
  const handle = await svc.restoreBody(k.toBREPBinary(shape).slice().buffer, elementMap)
  return { ...result.bodies[0], handle, elementMap }
}
async function geometry(name: string, body: BodyHandle) {
  const tess = await svc.tessellate(body, { deflection: 0.05 })
  const cached = cache.ingest(name, tess)
  const display = modelBodyDisplayFromCached(cached)
  return { tess, cached, display, geo: buildModelBodyGeometry(
    { bodyId: name, name }, { bodyId: name, version: 1, stableIds: tess.faceIds, display },
  ) }
}

beforeAll(async () => {
  k = await OcctKernel.init()
  await svc.init()
  const open = prism([line([0, 0, 0], [30, 0, 0])])
  const rectangle = prism([
    line([0, 0, 0], [40, 0, 0]), line([40, 0, 0], [40, 20, 0]),
    line([40, 20, 0], [0, 20, 0]), line([0, 20, 0], [0, 0, 0]),
  ])
  const circles = own(k.makeCompound([10, 5].map(r => prism([
    own(k.makeCircleEdge(zero, { x: 0, y: 0, z: 1 }, r)),
  ]))))
  for (const [index, shape] of [open, rectangle, circles].entries()) {
    const fixture = sheets[index]
    observations[fixture.name] = {
      valid: k.isValid(shape), solids: count(shape, 'solid'), faces: count(shape, 'face'),
      edges: count(shape, 'edge'), area: k.getSurfaceArea(shape),
    }
    expect(k.isValid(shape)).toBe(true)
    expect(count(shape, 'solid')).toBe(0)
    expect(count(shape, 'face')).toBe(fixture.faces)
    expect(count(shape, 'edge')).toBe(fixture.edges)
    const adjacency = parseEdgeToFaceMap(k.edgeToFaceMap(shape, 2147483647))
    const boundaryEdges = [...adjacency.adjacentFaces].filter(([hash, faces]) =>
      faces.size === 1 && adjacency.occurrences.get(hash) === 1).length
    observations[`${fixture.name}.boundaryEdges`] = boundaryEdges
    expect(boundaryEdges).toBe(fixture.boundary)
    expect(k.getSurfaceArea(shape)).toBeCloseTo(fixture.area, 6)
    bodies.set(fixture.name, await importShape(shape, fixture.name))
  }
}, 60_000)
afterAll(async () => {
  if (process.env.WRITE_EVIDENCE === '1') writeFileSync(
    'src/tests/evidence/WO-3238/measurements.json', JSON.stringify(observations, null, 2) + '\n',
  )
  cache.disposeAll()
  await svc.disposeAll()
  for (const h of owned.reverse()) k.release(h)
  k[Symbol.dispose]()
})

for (const fixture of sheets) describe(`C0 ${fixture.name} sheet`, () => {
  const body = () => bodies.get(fixture.name)!
  it('selects body and face from the production tessellation and BVH', async () => {
    const { tess } = await geometry(fixture.name, body().handle)
    expect(tess.faceIds).toHaveLength(fixture.faces)
    expect(tess.edgeIds.length).toBeGreaterThan(0)
    // Shoot through the interior of the first real mesh triangle from both sides.
    const ids = Array.from(tess.index.slice(0, 3))
    const p = ids.map(i => Array.from(tess.position.slice(i * 3, i * 3 + 3)))
    const a = p[1].map((v, i) => v - p[0][i]), b = p[2].map((v, i) => v - p[0][i])
    const n = [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]
    const length = Math.hypot(...n)
    expect(length).toBeGreaterThan(0)
    const center = [0, 1, 2].map(i => p.reduce((s, v) => s + v[i], 0) / 3)
    const picker = new PickEngine(cache)
    for (const sign of [1, -1]) {
      const ray = {
        origin: { x: center[0]+sign*n[0]/length, y: center[1]+sign*n[1]/length, z: center[2]+sign*n[2]/length },
        direction: { x: -sign*n[0], y: -sign*n[1], z: -sign*n[2] },
      }
      expect(picker.pick(fixture.name, ray, 'body')?.kind).toBe('body')
      const hit = picker.pick(fixture.name, ray, 'face')
      expect(hit?.kind).toBe('face')
      if (hit?.kind === 'face') expect(tess.faceIds).toContain(hit.id)
    }
  })
  it('measures analytic area and refuses volume before mass integration', async () => {
    expect((await svc.measure(body().handle, 'area')).value).toBeCloseTo(fixture.area, 5)
    await expect(svc.measure(body().handle, 'volume')).rejects.toThrow(/not a closed solid/)
  })
  it('exports STEP with no caps and no solid', async () => {
    const bytes = await svc.exportStep([body().handle])
    const shape = own(k.importStep(bytes))
    expect(k.isValid(shape)).toBe(true)
    expect(count(shape, 'solid')).toBe(0)
    expect(count(shape, 'face')).toBe(fixture.faces)
    expect(count(shape, 'edge')).toBe(fixture.edges)
    const adjacency = parseEdgeToFaceMap(k.edgeToFaceMap(shape, 2147483647))
    const boundaryEdges = [...adjacency.adjacentFaces].filter(([hash, faces]) =>
      faces.size === 1 && adjacency.occurrences.get(hash) === 1).length
    observations[`${fixture.name}.exportBoundaryEdges`] = boundaryEdges
    expect(boundaryEdges).toBe(fixture.boundary)
    expect(k.getSurfaceArea(shape)).toBeCloseTo(fixture.area, 5)
  })
  it('restores binary body with exact face-map identity (not a STEP round trip)', async () => {
    const restored = await svc.restoreBody(await svc.serializeBody(body().handle), body().elementMap)
    expect((await svc.measure(restored, 'area')).value).toBeCloseTo(fixture.area, 5)
    await expect(svc.measure(restored, 'volume')).rejects.toThrow(/not a closed solid/)
    const original = await svc.tessellate(body().handle, { deflection: 0.05 })
    const replay = await svc.tessellate(restored, { deflection: 0.05 })
    expect([...replay.faceIds].sort()).toEqual([...original.faceIds].sort())
    expect((await svc.resolve(restored, original.faceIds)).map(r => r.status)).toEqual(original.faceIds.map(() => 'exact'))
    for (const id of original.faceIds) {
      expect((await svc.measure(restored, 'area', [id])).value).toBeCloseTo((await svc.measure(body().handle, 'area', [id])).value, 6)
      expect(await svc.classifyFace(restored, id)).toBe(await svc.classifyFace(body().handle, id))
    }
  })
  it('derives stock bounds and measures closed-section CAM capability independently', async () => {
    const { geo } = await geometry(fixture.name, body().handle)
    geo.stockId = 'stock'
    const bounds = deriveStockBounds({ id: 'stock', name: 'stock', mode: 'derived', bounds: geo.boundingBox, position: zero },
      [geo], { autoOffsetXY: 2, autoOffsetZTop: 1, autoOffsetZBottom: 1 }, placements)
    expect(bounds?.min.z).toBeCloseTo(-1)
    expect(bounds?.max.z).toBeCloseTo(9)
    expect(bounds?.min.x).toBeCloseTo(geo.boundingBox.min.x - 2)
    expect(bounds?.max.y).toBeCloseTo(geo.boundingBox.max.y + 2)
    if (fixture.loops === 0) expect(() => deriveModelBodySection(geo, 4, placements)).toThrow(/open profile/)
    else expect(deriveModelBodySection(geo, 4, placements).loops).toHaveLength(fixture.loops)
    const verdicts = await svc.recognizeFeatures(body().handle)
    observations[`${fixture.name}.recognition`] = verdicts.map(v => v.featureClass)
    expect(verdicts).toEqual([])
    expect(() => deriveModelBodyDrillTargets(geo, placements, verdicts)).toThrow(/no drill targets/)
    // Recognition is not proof that a free cylindrical sheet is a drillable solid.
    try { observations[`${fixture.name}.drill`] = deriveModelBodyDrillTargets(geo, placements, verdicts) }
    catch (e) { observations[`${fixture.name}.drill`] = String(e) }
  })
  it('exercises cut, fuse and intersect as a solid-tool consumer without adding a gate', async () => {
    const box = await svc.makeBox(`box-${fixture.name}`, { x: 50, y: 30, z: 12 })
    expect(box.ok).toBe(true)
    const results: Record<string, unknown> = {}
    for (const op of ['cut', 'fuse', 'intersect'] as const) {
      const result = await svc.applyBoolean({ featureId: `${op}-${fixture.name}`, target: box.body!, tools: [body().handle], op })
      results[op] = { ok: result.ok, diagnostics: result.diagnostics }
      expect(result.ok).toBe(false)
      expect(result.ok ? result.body !== undefined : result.diagnostics.some(d => d.severity === 'error')).toBe(true)
      if (result.ok) results[`${op}.volume`] = (await svc.measure(result.body!, 'volume')).value
    }
    observations[`${fixture.name}.boolean`] = results
  })
})

it('Parallel accepts an uncapped horizontal wire-prism mesh target', async () => {
  const sheet = prism([line([0, 0, 5], [30, 0, 5])], [0, 8, 0])
  expect(count(sheet, 'solid')).toBe(0)
  const body = await importShape(sheet, 'horizontal')
  const { tess, display } = await geometry('horizontal', body.handle)
  const worker: WorkerLike = { onmessage: null, onerror: null,
    postMessage(message: unknown) { dispatcher.handle(message as Cam3dRequest) }, terminate() {} }
  const dispatcher = new Cam3dDispatcher(new BvhKernel(), (message: Cam3dResponse) => worker.onmessage?.({ data: message } as MessageEvent))
  const client = new Cam3dClient(worker)
  const tool: Tool = { id: 'flat', name: 'flat', type: 'flat_end_mill', diameter: 2, fluteLength: 20,
    shankDiameter: 2, overallLength: 50, numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '', feedsAndSpeeds: {} }
  try {
    const { moves } = await computeParallel3dMoves({
      partMesh: { positions: tess.position, indices: tess.index, bounds: display.bbox, source: 'model' }, tool, client,
      params: { stepover: 2, angleDeg: 0, tolerance: 0.1, useStockBoundary: false, stockEdgeOvershoot: 0 },
      resolvedHeights: { clearanceZ: 15, retractZ: 10, feedZ: 8, topZ: 5, bottomZ: 0, stockTopZ: 5 },
    })
    const cuts = moves.filter(m => m.role === 'cut')
    expect(cuts.length).toBeGreaterThan(0)
    for (const m of cuts) expect(m.z).toBeCloseTo(5, 5)
    observations.parallel = { cuts: cuts.length, minZ: Math.min(...cuts.map(m => m.z)), maxZ: Math.max(...cuts.map(m => m.z)) }
  } finally { await client.dispose() }
}, 60_000)

it('mixed compound has positive volume AND free sheet faces: volume cannot classify the whole body', async () => {
  const solid = own(k.makeBox(50, 30, 12))
  const sheet = prism([line([60, 0, 0], [90, 0, 0])])
  const mixed = own(k.makeCompound([solid, sheet]))
  expect(count(mixed, 'solid')).toBe(1)
  expect(count(mixed, 'face')).toBe(7)
  expect(k.isSolid(mixed)).toBe(false)
  expect(k.getVolume(mixed)).toBeGreaterThan(0)
  // Use service binary restore: STEP import splits out solids and can omit sheets.
  const solidBody = await svc.makeBox('mixed-map', { x: 2, y: 3, z: 4 })
  const restored = await svc.restoreBody(k.toBREPBinary(mixed).slice().buffer, solidBody.elementMap!)
  const volume = (await svc.measure(restored, 'volume')).value
  expect(volume).toBeGreaterThan(0)
  observations.mixed = { solids: 1, faces: 7, isSolid: false, serviceVolume: volume,
    note: '#isClosedSolid accepts any solid subshape; metadata must distinguish free sheet content' }
})




