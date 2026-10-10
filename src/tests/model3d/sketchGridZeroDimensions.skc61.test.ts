import { afterEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { buildPlaneGrid } from '../../components/model3d/sceneRuntime'
import { BASE_PLANE_FRAMES } from '../../components/model3d/workbench/basePlanes'
import { sketchSessionStore } from '../../components/model3d/workbench/sketchSessionStore'
import {
  WORKBENCH_AXIS_X_ENTITY_ID,
  WORKBENCH_AXIS_Y_ENTITY_ID,
} from '../../components/model3d/workbench/workbenchOriginAnchor'
import { createBlankSketch } from '../../lib/sketch/blankSketch'

afterEach(() => {
  sketchSessionStore.__reset()
})

describe('SKC-61 zero-dimension Model sketch grid', () => {
  it('keeps the full grid and real axes without two solid accent rays', () => {
    const persisted = createBlankSketch('workbench', () => 'skc61-zero-dimensions')
    expect(persisted.dimensions).toEqual([])

    sketchSessionStore.begin('sketch3d:skc61', BASE_PLANE_FRAMES.xy, persisted)
    const live = sketchSessionStore.getState().sketch
    expect(live?.dimensions).toEqual([])
    expect(live?.entities.map((entity) => entity.id)).toEqual(expect.arrayContaining([
      WORKBENCH_AXIS_X_ENTITY_ID,
      WORKBENCH_AXIS_Y_ENTITY_ID,
    ]))

    const group = buildPlaneGrid(BASE_PLANE_FRAMES.xy, 25, 200)
    const grid = group.children[0] as THREE.GridHelper
    const positions = grid.geometry.getAttribute('position')
    const colors = grid.geometry.getAttribute('color')

    // 8 divisions -> 9 lines per direction -> 18 full-span grid segments.
    expect(positions.count).toBe(36)
    const segmentColors = Array.from({ length: positions.count / 2 }, (_, segment) => {
      const vertex = segment * 2
      return [colors.getX(vertex), colors.getY(vertex), colors.getZ(vertex)]
        .map((value) => Number(value.toFixed(6)))
        .join(',')
    })
    expect(new Set(segmentColors)).toEqual(new Set([segmentColors[0]]))
  })
})
