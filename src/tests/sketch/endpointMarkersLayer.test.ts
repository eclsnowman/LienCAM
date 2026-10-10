import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  SKETCH_COLORS,
  SketchLayer,
} from '../../lib/sketch/sketcher/sketchLayer'
import type { Sketch, SketchEntity, SketchViewState } from '../../lib/sketch/sketcher'

const LINE: SketchEntity = {
  id: 'line', kind: 'line', construction: false,
  start: { x: -2, y: 3 }, end: { x: 8, y: 7 },
}

const ARC: SketchEntity = {
  id: 'arc', kind: 'arc', construction: false,
  center: { x: 10, y: -5 }, radius: 4,
  startAngle: Math.PI / 2, endAngle: Math.PI,
}

function sketchWith(entities: SketchEntity[]): Sketch {
  return {
    id: 'sk', layerId: 'layer', entities,
    constraints: [], dimensions: [], solveStatus: null,
  }
}

function view(selected: string[] = []): SketchViewState {
  return { selectedIds: new Set(selected), glyphsVisible: false, editingId: null }
}

function endpointCloud(layer: SketchLayer): THREE.Points {
  const matches = layer.group.children.filter((c) => c.name === '__sketch_endpoints__')
  expect(matches).toHaveLength(1)
  return matches[0] as THREE.Points
}

function expectVertexColor(
  cloud: THREE.Points, index: number, expected: THREE.Color,
): void {
  const colors = cloud.geometry.getAttribute('color')
  expect(colors.getX(index)).toBeCloseTo(expected.r, 6)
  expect(colors.getY(index)).toBeCloseTo(expected.g, 6)
  expect(colors.getZ(index)).toBeCloseTo(expected.b, 6)
}

describe('SketchLayer line and circular-arc endpoint markers', () => {
  it('batches exactly two aligned endpoints per line and circular arc', () => {
    const layer = new SketchLayer()
    layer.update(sketchWith([LINE, ARC]), view())

    const cloud = endpointCloud(layer)
    const positions = cloud.geometry.getAttribute('position')
    expect(positions.count).toBe(4)
    expect([positions.getX(0), positions.getY(0)]).toEqual([-2, 3])
    expect([positions.getX(1), positions.getY(1)]).toEqual([8, 7])
    // Arc markers reuse the rendered tessellation's first/last points.
    expect(positions.getX(2)).toBeCloseTo(10, 5)
    expect(positions.getY(2)).toBeCloseTo(-1, 5)
    expect(positions.getX(3)).toBeCloseTo(6, 5)
    expect(positions.getY(3)).toBeCloseTo(-5, 5)

    const material = cloud.material as THREE.PointsMaterial
    expect(material.sizeAttenuation).toBe(false)
    expect(material.toneMapped).toBe(false)
    expect(material.vertexColors).toBe(true)
    layer.dispose()
  })

  it('transitions rest -> hover -> selected and preserves hover through updates', () => {
    const layer = new SketchLayer()
    const sketch = sketchWith([LINE, ARC])
    layer.update(sketch, view())

    const rest = new THREE.Color(
      new THREE.Color(SKETCH_COLORS.underDefined)
        .lerp(new THREE.Color(SKETCH_COLORS.background), 0.45)
        .getHex(),
    )
    let cloud = endpointCloud(layer)
    expectVertexColor(cloud, 0, rest)
    expectVertexColor(cloud, 1, rest)

    layer.setHover('line')
    cloud = endpointCloud(layer)
    const hover = new THREE.Color(SKETCH_COLORS.hover)
    expectVertexColor(cloud, 0, hover)
    expectVertexColor(cloud, 1, hover)
    expectVertexColor(cloud, 2, rest)

    const movedLine: SketchEntity = {
      ...LINE, start: { x: 20, y: 30 }, end: { x: 40, y: 50 },
    }
    layer.update(sketchWith([movedLine, ARC]), view())
    cloud = endpointCloud(layer)
    const moved = cloud.geometry.getAttribute('position')
    expect([moved.getX(0), moved.getY(0)]).toEqual([20, 30])
    expect([moved.getX(1), moved.getY(1)]).toEqual([40, 50])
    expectVertexColor(cloud, 0, hover)
    expectVertexColor(cloud, 1, hover)

    // Selection has higher priority than direct hover.
    layer.update(sketchWith([movedLine, ARC]), view(['line']))
    cloud = endpointCloud(layer)
    const selected = new THREE.Color(SKETCH_COLORS.selected)
    expectVertexColor(cloud, 0, selected)
    expectVertexColor(cloud, 1, selected)
    layer.dispose()
  })

  it('renders 200 entities as one finite 400-vertex cloud', () => {
    const entities: SketchEntity[] = []
    for (let i = 0; i < 100; i++) {
      entities.push({
        id: `line-${i}`, kind: 'line', construction: false,
        start: { x: i * 2, y: i }, end: { x: i * 2 + 1, y: i + 0.5 },
      })
      entities.push({
        id: `arc-${i}`, kind: 'arc', construction: false,
        center: { x: i * 3, y: -i }, radius: i + 1,
        startAngle: 0, endAngle: Math.PI / 2,
      })
    }

    const layer = new SketchLayer()
    layer.update(sketchWith(entities), view())
    const cloud = endpointCloud(layer)
    const positions = cloud.geometry.getAttribute('position')
    expect(positions.count).toBe(400)
    for (let i = 0; i < positions.count; i++) {
      expect(Number.isFinite(positions.getX(i))).toBe(true)
      expect(Number.isFinite(positions.getY(i))).toBe(true)
      expect(Number.isFinite(positions.getZ(i))).toBe(true)
    }
    layer.dispose()
  })
})
