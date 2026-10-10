import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { GeometryCache } from '../../viewport3d/GeometryCache'
import { PickEngine } from '../../viewport3d/PickEngine'
import {
  MODEL_EDGE_PICK_TOLERANCE_PX,
  screenSpaceEdgePickThresholds,
} from '../../viewport3d/screenSpacePick'
import type { RayLike } from '../../viewport3d/types'
import { makeBoxFixture } from './fixtures'
import { makeFilletedStepEdgeFixture } from '../../viewport3d/fixtures'

const BODY_ID = 'screen-space-box'
const VIEWPORT_HEIGHT = 800

function downwardRay(x: number, y: number, z: number): RayLike {
  return {
    origin: { x, y, z },
    direction: { x: 0, y: 0, z: -1 },
  }
}

function topEdgeMissRay(distance: number, worldOffset: number): RayLike {
  const direction = new THREE.Vector3(0, -worldOffset, -distance).normalize()
  return {
    origin: { x: 20, y: 0, z: 10 + distance },
    direction: { x: direction.x, y: direction.y, z: direction.z },
  }
}

function perspectiveAt(x: number, y: number, z: number): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000)
  camera.position.set(x, y, z)
  camera.lookAt(x, y, 0)
  camera.updateMatrixWorld(true)
  return camera
}

describe('screen-space Model edge picking', () => {
  it('keeps the target at 10 CSS px as perspective distance changes', () => {
    for (const distance of [10, 100]) {
      const camera = perspectiveAt(20, 0, 10 + distance)
      const ray = downwardRay(20, 0, 10 + distance)
      const thresholds = screenSpaceEdgePickThresholds(camera, VIEWPORT_HEIGHT, ray)
      const worldAtTenPixels = thresholds.edgeAtDistance?.(distance)
      expect(worldAtTenPixels).toBeCloseTo(
        (2 * distance * Math.tan(THREE.MathUtils.degToRad(45) / 2) / VIEWPORT_HEIGHT)
          * MODEL_EDGE_PICK_TOLERANCE_PX,
        8,
      )
    }
  })

  it('selects the same edge from an 8 px miss at near and far zoom while the old fixed threshold misses far', () => {
    const fixture = makeBoxFixture()
    const cache = new GeometryCache()
    cache.ingest(BODY_ID, fixture.buffers)
    const picker = new PickEngine(cache)
    const expected = `E:${fixture.faceIds.negY}|${fixture.faceIds.posZ}`

    for (const distance of [10, 100]) {
      const worldPerPixel = 2 * distance * Math.tan(THREE.MathUtils.degToRad(45) / 2) / VIEWPORT_HEIGHT
      const worldOffset = 8 * worldPerPixel
      const z = 10 + distance
      const ray = topEdgeMissRay(distance, worldOffset)
      const camera = perspectiveAt(20, 0, z)
      const thresholds = screenSpaceEdgePickThresholds(camera, VIEWPORT_HEIGHT, ray)
      const hit = picker.pick(BODY_ID, ray, 'edge', thresholds)
      expect(hit?.kind).toBe('edge')
      expect(hit?.id).toBe(expected)
      if (distance === 100) {
        expect(picker.pick(BODY_ID, ray, 'edge')).toBeNull()
      }
    }
  })

  it('uses a zoom-aware constant world tolerance for orthographic cameras', () => {
    const camera = new THREE.OrthographicCamera(-50, 50, 50, -50, 0.1, 2000)
    camera.zoom = 2
    camera.position.set(0, 0, 100)
    camera.lookAt(0, 0, 0)
    camera.updateMatrixWorld(true)
    const thresholds = screenSpaceEdgePickThresholds(
      camera,
      500,
      downwardRay(0, 0, 100),
    )
    expect(thresholds.edgeAtDistance).toBeUndefined()
    expect(thresholds.edge).toBeCloseTo(1, 8)
  })

  it('preserves and picks every group in the supplied-shape-equivalent 27-edge filleted step', () => {
    const { buffers, samples } = makeFilletedStepEdgeFixture()
    const cache = new GeometryCache()
    cache.ingest(BODY_ID, buffers)
    const body = cache.get(BODY_ID)
    const picker = new PickEngine(cache)
    expect(body?.edgeIds).toHaveLength(27)
    expect(body?.edgeOffsets).toHaveLength(28)
    expect(buffers.edgePositions).toHaveLength(168 * 3)
    // 21 straight segments plus 6 curved groups x 20 segments = 141.
    const renderedPosition = body?.edgeGeometry.getAttribute('position')
    expect(renderedPosition?.count).toBe(141 * 2)

    // Every adjacent source point pair must survive as one exact rendered
    // segment, with no cross-polyline join and no endpoint dropped. This pins
    // the supplied filleted-step failure shape independently of picking.
    const rendered = renderedPosition?.array as Float32Array
    let renderedPoint = 0
    for (let edge = 0; edge < buffers.edgeIds.length; edge += 1) {
      const sourceStart = buffers.edgeOffsets[edge]
      const sourceEnd = buffers.edgeOffsets[edge + 1]
      for (let sourcePoint = sourceStart; sourcePoint + 1 < sourceEnd; sourcePoint += 1) {
        expect(
          [...rendered.slice(renderedPoint * 3, (renderedPoint + 2) * 3)],
          `rendered endpoints for edge group ${edge}, segment ${sourcePoint - sourceStart}`,
        ).toEqual([
          ...buffers.edgePositions.slice(sourcePoint * 3, (sourcePoint + 2) * 3),
        ])
        renderedPoint += 2
      }
    }
    expect(renderedPoint).toBe(141 * 2)

    for (let edge = 0; edge < buffers.edgeIds.length; edge += 1) {
      const sample = samples[edge]
      const hit = picker.pick(
        BODY_ID,
        downwardRay(sample[0], sample[1], 100),
        'edge',
      )
      expect(hit?.id, `edge group ${edge}`).toBe(buffers.edgeIds[edge])
    }
  })
})
