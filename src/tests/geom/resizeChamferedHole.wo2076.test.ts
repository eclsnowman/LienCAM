// WO-2076 - Resize every hole in the imported Sample Parts STEP while keeping
// its entry cone. This is Tier 2 behavior through the production GeomEngine
// import/recognize/edit/export path, backed by the real occt-wasm kernel.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { OcctKernel, type ShapeHandle } from 'occt-wasm'
import { resolveSamplePartPath } from '../../cam3d/input/fixturePaths.ts'
import type { BodyHandle, FeatureVerdict } from '../../geom/geom-service.ts'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'

const FIXTURE = 'Step Test With Holes.step'
const OLD_DIAMETER = 5
const NEW_DIAMETER = 7

function fixtureBytes(): ArrayBuffer {
  const bytes = readFileSync(resolveSamplePartPath(FIXTURE))
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

function holeLocationPrefix(hole: FeatureVerdict): string {
  return `${hole.featureKey.split(':').slice(0, 4).join(':')}:`
}

function matchingHole(verdicts: FeatureVerdict[], original: FeatureVerdict): FeatureVerdict | undefined {
  const prefix = holeLocationPrefix(original)
  return verdicts.find((v) => v.featureKey.startsWith(prefix))
}

function volume(engine: GeomEngine, body: BodyHandle): Promise<number> {
  return engine.measure(body, 'volume').then((measurement) => measurement.value)
}

type ConeMetric = { centerX: number; centerY: number; area: number; halfAngleDeg: number; axialDepth: number }

function coneMetrics(kernel: OcctKernel, shape: ShapeHandle): ConeMetric[] {
  const faces = kernel.getSubShapes(shape, 'face')
  const metrics: ConeMetric[] = []
  try {
    for (const face of faces) {
      if (kernel.surfaceType(face) !== 'cone') continue
      const uv = kernel.uvBounds(face)
      const normal = kernel.surfaceNormal(face, (uv.uMin + uv.uMax) / 2, (uv.vMin + uv.vMax) / 2)
      const normalLength = Math.hypot(normal.x, normal.y, normal.z)
      const halfAngleDeg = Math.asin(Math.min(1, Math.abs(normal.z) / normalLength)) * 180 / Math.PI
      const center = kernel.getSurfaceCenterOfMass(face)
      const vertices = kernel.getSubShapes(face, 'vertex')
      try {
        const z = vertices.map((vertex) => kernel.vertexPosition(vertex).z)
        metrics.push({
          centerX: center.x,
          centerY: center.y,
          area: kernel.getSurfaceArea(face),
          halfAngleDeg,
          axialDepth: Math.max(...z) - Math.min(...z),
        })
      } finally {
        for (const vertex of vertices) kernel.release(vertex)
      }
    }
  } finally {
    for (const face of faces) kernel.release(face)
  }
  return metrics.sort((a, b) => a.centerX - b.centerX || a.centerY - b.centerY)
}

function targetConeMetrics(metrics: ConeMetric[], holes: FeatureVerdict[]): ConeMetric[] {
  const centers = holes.map((hole) => {
    const [, x, y] = hole.featureKey.split(':')
    return { x: Number(x), y: Number(y) }
  })
  return metrics.filter((cone) => centers.some((center) => Math.hypot(cone.centerX - center.x, cone.centerY - center.y) < 0.01))
}

describe('WO-2076 imported STEP chamfered-hole resize (real occt-wasm kernel)', () => {
  let engine: GeomEngine

  beforeAll(async () => {
    engine = new GeomEngine()
    await engine.init()
  }, 60_000)

  afterAll(async () => {
    await engine.disposeKernel()
  })

  it('resizes all 12 holes from 5 mm to 7 mm and preserves the 0.5 mm x 45 deg entry cones', async () => {
    const source = fixtureBytes()
    const imported = await engine.importStep(source, 'WO2076')
    expect(imported.bodies).toHaveLength(1)
    const original = imported.bodies[0].handle
    const originalVolume = await volume(engine, original)
    const holes = (await engine.recognizeFeatures(original)).filter(
      (feature) => feature.featureClass === 'counterboreStack' &&
        Math.abs(Number(feature.params.diameter) - OLD_DIAMETER) < 0.05,
    )
    expect(holes, 'the named STEP must expose all 12 editable 5 mm hole stacks').toHaveLength(12)

    let representativeStep: ArrayBuffer | undefined
    for (const [index, hole] of holes.entries()) {
      const edited = await engine.editFeature({
        featureId: `WO2076-E${index}`,
        body: original,
        featureKey: hole.featureKey,
        delta: NEW_DIAMETER - OLD_DIAMETER,
        kind: 'holeDiameter',
      })
      expect(edited.ok, `hole ${index + 1} ${hole.featureKey}: ${JSON.stringify(edited.diagnostics)}`).toBe(true)
      const editedBody = edited.body!
      expect(await volume(engine, editedBody), `hole ${index + 1} must change part volume`).toBeLessThan(originalVolume)
      const resized = matchingHole(await engine.recognizeFeatures(editedBody), hole)
      expect(resized, `hole ${index + 1} must remain recognized after resize`).toBeDefined()
      expect(Number(resized!.params.diameter), `hole ${index + 1} diameter`).toBeCloseTo(NEW_DIAMETER, 2)
      if (index === 0) representativeStep = await engine.exportStep([editedBody])
      await engine.dispose(editedBody)
    }

    // editFeature is non-destructive. The original body is the replay target used
    // by Undo, so it must still carry the exact original volume and diameters.
    expect(await volume(engine, original)).toBe(originalVolume)
    const restoredHoles = (await engine.recognizeFeatures(original)).filter(
      (feature) => feature.featureClass === 'counterboreStack' &&
        Math.abs(Number(feature.params.diameter) - OLD_DIAMETER) < 0.05,
    )
    expect(restoredHoles, 'the unchanged source body must still contain all 12 original holes').toHaveLength(12)

    const kernel = await OcctKernel.init()
    let sourceShape: ShapeHandle | undefined
    let editedShape: ShapeHandle | undefined
    try {
      sourceShape = kernel.importStep(source)
      editedShape = kernel.importStep(representativeStep!)
      const before = targetConeMetrics(coneMetrics(kernel, sourceShape), holes)
      const after = targetConeMetrics(coneMetrics(kernel, editedShape), holes)
      expect(before, 'fixture cone census').toHaveLength(12)
      expect(after, 'edited cone census').toHaveLength(12)
      for (const [index, cone] of before.entries()) {
        expect(cone.halfAngleDeg, `source cone ${index + 1} half-angle`).toBeCloseTo(45, 3)
        expect(cone.axialDepth, `source cone ${index + 1} axial depth`).toBeCloseTo(0.5, 3)
        expect(after[index].halfAngleDeg, `edited cone ${index + 1} half-angle`).toBeCloseTo(cone.halfAngleDeg, 3)
        expect(after[index].axialDepth, `edited cone ${index + 1} axial depth`).toBeCloseTo(cone.axialDepth, 3)
      }
      const firstCenter = { x: Number(holes[0].featureKey.split(':')[1]), y: Number(holes[0].featureKey.split(':')[2]) }
      const originalEditedCone = before.find((cone) => Math.hypot(cone.centerX - firstCenter.x, cone.centerY - firstCenter.y) < 0.01)!
      const resizedCone = after.find((cone) => Math.hypot(cone.centerX - firstCenter.x, cone.centerY - firstCenter.y) < 0.01)!
      expect(resizedCone.area, 'the preserved cone must be carried outward to the resized bore edge').toBeGreaterThan(originalEditedCone.area)
    } finally {
      if (sourceShape !== undefined) kernel.release(sourceShape)
      if (editedShape !== undefined) kernel.release(editedShape)
      kernel[Symbol.dispose]()
      await engine.disposeAll()
    }
  }, 300_000)
})
