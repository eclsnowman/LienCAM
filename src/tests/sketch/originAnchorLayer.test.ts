import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  SKETCH_COLORS,
  SketchLayer,
} from '../../lib/sketch/sketcher/sketchLayer'
import type { Sketch, SketchEntity, SketchViewState } from '../../lib/sketch/sketcher'

const ORIGIN_ID = '__workbench_origin_anchor__'
const ORIGIN_FIX_ID = '__workbench_origin_anchor_fix__'
const ORIGIN: SketchEntity = {
  id: ORIGIN_ID,
  kind: 'point',
  construction: true,
  at: { x: 0, y: 0 },
}
const ORDINARY_POINT: SketchEntity = {
  id: 'ordinary-point',
  kind: 'point',
  construction: false,
  at: { x: 20, y: 10 },
}

function sketch(entities: SketchEntity[] = [ORIGIN, ORDINARY_POINT]): Sketch {
  return {
    id: 'sketch',
    layerId: 'layer',
    entities,
    constraints: [],
    dimensions: [],
    solveStatus: null,
  }
}

function view(
  selected: string[] = [],
  originAnchorId?: string,
  originAnchorEntity?: Extract<SketchEntity, { kind: 'point' }>,
  originAnchorFixId?: string,
): SketchViewState {
  return {
    selectedIds: new Set(selected),
    glyphsVisible: false,
    editingId: null,
    ...(originAnchorId === undefined ? {} : { originAnchorId }),
    ...(originAnchorEntity === undefined ? {} : { originAnchorEntity }),
    ...(originAnchorFixId === undefined ? {} : { originAnchorFixId }),
  }
}

function namedPoints(layer: SketchLayer, name: string): THREE.Points[] {
  return layer.group.children.filter((child) => child.name === name) as THREE.Points[]
}

function originMarker(layer: SketchLayer): THREE.Points {
  const matches = namedPoints(layer, '__sketch_origin_anchor__')
  expect(matches).toHaveLength(1)
  return matches[0]
}

function expectMaterialColor(marker: THREE.Points, expected: number): void {
  const material = marker.material as THREE.PointsMaterial
  expect(material.color.getHex()).toBe(expected)
}

describe('SketchLayer projected origin anchor', () => {
  it('uses one distinct screen-stable marker without changing the absent-field point cloud', () => {
    const layer = new SketchLayer()
    const raw = sketch([ORDINARY_POINT])
    layer.update(raw, view([], ORIGIN_ID, ORIGIN))

    const marker = originMarker(layer)
    const positions = marker.geometry.getAttribute('position')
    expect(positions.count).toBe(1)
    expect([positions.getX(0), positions.getY(0), positions.getZ(0)]).toEqual([0, 0, 0])
    const material = marker.material as THREE.PointsMaterial
    expect(material.size).toBe(15)
    expect(material.sizeAttenuation).toBe(false)
    expect(material.depthTest).toBe(false)
    expect(material.toneMapped).toBe(false)

    const ordinaryClouds = namedPoints(layer, '__sketch_points__')
    expect(ordinaryClouds).toHaveLength(1)
    expect(ordinaryClouds[0].geometry.getAttribute('position').count).toBe(1)
    expect(raw.entities).toEqual([ORDINARY_POINT])

    // CAM omits originAnchorId. The exact same document then follows the
    // existing path: no reserved marker and both points share the normal cloud.
    layer.update(sketch(), view())
    expect(namedPoints(layer, '__sketch_origin_anchor__')).toHaveLength(0)
    const genericCloud = namedPoints(layer, '__sketch_points__')
    expect(genericCloud).toHaveLength(1)
    expect(genericCloud[0].geometry.getAttribute('position').count).toBe(2)
    layer.dispose()
  })

  it('paints distinct rest, hover, and selected states with selection priority', () => {
    const layer = new SketchLayer()
    const raw = sketch([ORDINARY_POINT])
    layer.update(raw, view([], ORIGIN_ID, ORIGIN))
    expectMaterialColor(originMarker(layer), SKETCH_COLORS.fullyDefined)

    layer.setHover(ORIGIN_ID)
    expectMaterialColor(originMarker(layer), SKETCH_COLORS.hover)

    layer.update(raw, view([ORIGIN_ID], ORIGIN_ID, ORIGIN))
    expectMaterialColor(originMarker(layer), SKETCH_COLORS.selected)
    layer.dispose()
  })

  it('excludes only the reserved anchor from marquee while retaining analytic click pick', () => {
    const layer = new SketchLayer()
    const raw = sketch([ORDINARY_POINT])
    layer.update(raw, view([], ORIGIN_ID, ORIGIN))

    expect(layer.entitiesInRect(-2, -2, 2, 2, true)).toEqual([])
    expect(layer.entitiesInRect(-5, -5, 25, 15, true)).toEqual(['ordinary-point'])

    layer.group.visible = true
    layer.onFrame(0.25)
    const camera = new THREE.OrthographicCamera(-100, 100, 75, -75, 0.1, 1000)
    camera.position.set(0, 0, 10)
    camera.updateMatrixWorld(true)
    const hit = layer.pick(400, 300, camera, 800, 600)
    expect(hit).toEqual({ id: ORIGIN_ID, type: 'entity' })
    layer.dispose()
  })

  it('suppresses only the reserved fix badge so it cannot steal the origin click', () => {
    const layer = new SketchLayer()
    const fixed = sketch()
    fixed.constraints = [{
      id: ORIGIN_FIX_ID,
      kind: 'fix',
      point: { entityId: ORIGIN_ID, site: 'self' },
    }]
    layer.update(fixed, {
      ...view([], ORIGIN_ID, ORIGIN, ORIGIN_FIX_ID),
      glyphsVisible: true,
    })

    expect(layer.group.children.some((child) => child.name === ORIGIN_FIX_ID)).toBe(false)
    layer.group.visible = true
    const camera = new THREE.OrthographicCamera(-100, 100, 75, -75, 0.1, 1000)
    camera.position.set(0, 0, 10)
    camera.updateMatrixWorld(true)
    expect(layer.pick(400, 300, camera, 800, 600)).toEqual({ id: ORIGIN_ID, type: 'entity' })
    layer.dispose()
  })
})
