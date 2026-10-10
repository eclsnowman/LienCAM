// WO-1204: real-kernel topology classification plus the production display,
// picking, hover, measurement, and face-boundary consumers.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { OcctKernel } from 'occt-wasm'
import * as THREE from 'three'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'
import type { BodyHandle, StableId, TessBuffers } from '../../geom/geom-service.ts'
import { edgeId } from '../../geom/worker/stable-id.ts'
import { GeometryCache } from '../../viewport3d/GeometryCache.ts'
import { PickEngine } from '../../viewport3d/PickEngine.ts'
import { buildEdgeLineGeometry } from '../../viewport3d/tessGeometry.ts'
import { SelectionState } from '../../viewport3d/SelectionState.ts'
import { createCachedBodyInteractionOverlay } from '../../viewport3d/interactionPresentation.ts'
import { edgePolyline } from '../../components/model3d/workbench/faceBoundary.ts'
import {
  isFailure,
  measureSingle,
  type MeasureReadout,
  type SnapshotLookup,
} from '../../components/model3d/measure/measureLogic.ts'
import { stepBody } from './fixtures/healedStep.ts'

function rawSegmentCount(tess: TessBuffers): number {
  let count = 0
  for (let edge = 0; edge < tess.edgeIds.length; edge++) {
    count += Math.max(0, tess.edgeOffsets[edge + 1] - tess.edgeOffsets[edge] - 1)
  }
  return count
}

function drawnSegmentCount(tess: TessBuffers): number {
  const geometry = buildEdgeLineGeometry(tess)
  const position = geometry.getAttribute('position')
  let count = 0
  for (let point = 0; point + 1 < position.count; point += 2) {
    if (
      position.getX(point) !== position.getX(point + 1) ||
      position.getY(point) !== position.getY(point + 1) ||
      position.getZ(point) !== position.getZ(point + 1)
    ) count++
  }
  geometry.dispose()
  return count
}

function classCounts(tess: TessBuffers): { seam: number; regular: number } {
  expect(tess.edgeClasses).toHaveLength(tess.edgeIds.length)
  return {
    seam: tess.edgeClasses!.filter((value) => value === 'seam').length,
    regular: tess.edgeClasses!.filter((value) => value === 'regular').length,
  }
}

describe('WO-1204 seam-edge display classification (real occt-wasm kernel)', () => {
  let engine: GeomEngine
  let sphereKernel: OcctKernel

  beforeAll(async () => {
    engine = new GeomEngine()
    await engine.init()
    sphereKernel = await OcctKernel.init()
  }, 60_000)

  afterAll(async () => {
    await engine.disposeKernel()
    sphereKernel[Symbol.dispose]()
  })

  async function makeSphere(): Promise<BodyHandle> {
    const sphere = sphereKernel.makeSphere(20)
    try {
      const bytes = new TextEncoder().encode(sphereKernel.exportStep(sphere))
      const imported = await engine.importStep(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        'SPHERE',
      )
      expect(imported.bodies).toHaveLength(1)
      return imported.bodies[0].handle
    } finally {
      sphereKernel.release(sphere)
    }
  }

  it('classifies repeated single-face adjacency as seams for cylinder, sphere, and box', async () => {
    const cylinder = (await engine.debugMakeCylinder('CYL', 10, 20)).body!
    const sphere = await makeSphere()
    const box = (await engine.makeBox('BOX', { x: 30, y: 20, z: 10 })).body!
    const cylinderTess = await engine.tessellate(cylinder, { deflection: 0.08 })
    const sphereTess = await engine.tessellate(sphere, { deflection: 0.08 })
    const boxTess = await engine.tessellate(box, { deflection: 0.08 })

    expect(classCounts(cylinderTess)).toEqual({ seam: 1, regular: 2 })
    expect(classCounts(sphereTess)).toEqual({ seam: 1, regular: 2 })
    expect(classCounts(boxTess)).toEqual({ seam: 0, regular: 12 })
    expect(drawnSegmentCount(cylinderTess)).toBeLessThan(rawSegmentCount(cylinderTess))
    expect(drawnSegmentCount(sphereTess)).toBeLessThan(rawSegmentCount(sphereTess))
    expect(drawnSegmentCount(boxTess)).toBe(rawSegmentCount(boxTess))
    await engine.disposeAll()
  }, 60_000)

  it('draws every non-seam segment of a stepped filleted part', async () => {
    // The step helper authors two fused, unequal-height blocks. Fillet one
    // exterior top edge so the no-regression fixture includes both features.
    const stepped = await stepBody(engine)
    const topEdge = edgeId([
      'FA:XTR:SA.e0:side' as StableId,
      'FA:XTR:SA:capEnd' as StableId,
    ], '0')
    const filleted = await engine.applyFillet({
      featureId: 'STEP-FILLET', body: stepped, edges: [topEdge], radius: 1, propagateTangent: true,
    })
    expect(filleted.ok, JSON.stringify(filleted.diagnostics)).toBe(true)
    const tess = await engine.tessellate(filleted.body!, { deflection: 0.08 })

    expect(classCounts(tess).seam).toBe(0)
    expect(drawnSegmentCount(tess)).toBe(rawSegmentCount(tess))
    await engine.disposeAll()
  }, 60_000)

  it('draws every free boundary edge of an imported planar face', async () => {
    const points = [
      { x: 0, y: 0, z: 0 },
      { x: 30, y: 0, z: 0 },
      { x: 30, y: 20, z: 0 },
      { x: 0, y: 20, z: 0 },
    ]
    const edges = points.map((point, index) => (
      sphereKernel.makeLineEdge(point, points[(index + 1) % points.length])
    ))
    const wire = sphereKernel.makeWire(edges)
    const face = sphereKernel.makeFace(wire)
    let step: string
    try {
      step = sphereKernel.exportStep(face)
    } finally {
      sphereKernel.release(face)
      sphereKernel.release(wire)
      for (const edge of edges) sphereKernel.release(edge)
    }

    const bytes = new TextEncoder().encode(step)
    const imported = await engine.importStep(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      'PLANAR-FACE',
    )
    expect(imported.bodies).toHaveLength(1)
    const tess = await engine.tessellate(imported.bodies[0].handle, { deflection: 0.08 })

    expect(tess.edgeIds).toHaveLength(4)
    expect(tess.edgeClasses).toEqual(['regular', 'regular', 'regular', 'regular'])
    expect(rawSegmentCount(tess)).toBeGreaterThan(0)
    expect(drawnSegmentCount(tess)).toBe(rawSegmentCount(tess))
    await engine.disposeAll()
  }, 60_000)

  it('keeps a hidden cylinder seam pickable, hoverable, measurable, and available to edge extraction', async () => {
    const height = 20
    const cylinder = (await engine.debugMakeCylinder('PICK-CYL', 10, height)).body!
    const tess = await engine.tessellate(cylinder, { deflection: 0.08 })
    const seamIndex = tess.edgeClasses!.indexOf('seam')
    expect(seamIndex).toBeGreaterThanOrEqual(0)
    const seamId = tess.edgeIds[seamIndex]
    const start = tess.edgeOffsets[seamIndex]
    const end = tess.edgeOffsets[seamIndex + 1]
    expect(end - start).toBeGreaterThan(1)

    const cache = new GeometryCache()
    const body = cache.ingest('pick-cylinder', tess)
    const picker = new PickEngine(cache)
    const point = new THREE.Vector3(
      tess.edgePositions[start * 3],
      tess.edgePositions[start * 3 + 1],
      tess.edgePositions[start * 3 + 2],
    ).lerp(new THREE.Vector3(
      tess.edgePositions[(start + 1) * 3],
      tess.edgePositions[(start + 1) * 3 + 1],
      tess.edgePositions[(start + 1) * 3 + 2],
    ), 0.5)
    const outward = new THREE.Vector3(point.x, point.y, 0).normalize()
    const origin = point.clone().addScaledVector(outward, 5)
    const hit = picker.pick('pick-cylinder', {
      origin: { x: origin.x, y: origin.y, z: origin.z },
      direction: { x: -outward.x, y: -outward.y, z: 0 },
    }, 'edge', { edge: 1e-4, vertex: 1e-4 })
    expect(hit?.kind).toBe('edge')
    expect(hit?.id).toBe(seamId)
    if (hit?.kind !== 'edge') throw new Error('seam pick did not resolve as an edge')

    const snapshots = engine.snapshotsFor(cylinder) as unknown as SnapshotLookup
    const readouts = (await measureSingle(
      (_bodyId, kind, ids) => engine.measure(cylinder, kind, ids),
      body,
      'pick-cylinder',
      hit,
      snapshots,
    )).filter((value): value is MeasureReadout => !isFailure(value))
    expect(readouts.find((value) => value.kind === 'length')?.value).toBeCloseTo(height, 6)

    const selection = new SelectionState()
    selection.setHover(seamId)
    const hover = createCachedBodyInteractionOverlay({
      body, selection, resolution: { width: 1680, height: 900 },
    })
    const stroke = hover?.children.find((child) => child.userData.interactionKind === 'edge-stroke')
    expect(stroke).toBeDefined()

    const extracted = edgePolyline(body, seamId, ({ x, z }) => ({ x, y: z }))
    expect(extracted.ok).toBe(true)
    if (extracted.ok) expect(extracted.points.length).toBe(end - start)

    hover?.traverse((object) => {
      const disposable = object as THREE.Object3D & { geometry?: THREE.BufferGeometry; material?: THREE.Material }
      disposable.geometry?.dispose()
      disposable.material?.dispose()
    })
    cache.disposeAll()
    await engine.disposeAll()
  }, 60_000)
})
