import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  SKETCH_COLORS,
  SketchLayer,
} from '../../lib/sketch/sketcher/sketchLayer'
import {
  centerSelectionIdForEntity,
  decodeCenterSelectionRef,
  encodeEndpointSelectionRef,
} from '../../lib/sketch/centerReferences'
import { findSnap } from '../../lib/sketch/snap'
import { dimToolClick } from '../../lib/sketch/tools/dimTool'
import { planConstraintForSelection } from '../../lib/sketch/constraintActions'
import { deleteFromSketch } from '../../lib/sketch/deleteSelection'
import { patternEntities } from '../../lib/sketch/tools/patternTools'
import type {
  Sketch,
  SketchConstraint,
  SketchDimension,
  SketchEntity,
} from '../../lib/sketch/types'

const CIRCLE: SketchEntity = {
  id: 'circle', kind: 'circle', construction: false,
  center: { x: 20, y: 10 }, radius: 5,
}
const CIRCLE_B: SketchEntity = {
  id: 'circle-b', kind: 'circle', construction: false,
  center: { x: 40, y: 10 }, radius: 7,
}
const LINE: SketchEntity = {
  id: 'line', kind: 'line', construction: false,
  start: { x: 0, y: 0 }, end: { x: 10, y: 0 },
}

function sketch(
  entities: SketchEntity[],
  constraints: SketchConstraint[] = [],
  dimensions: SketchDimension[] = [],
): Sketch {
  return {
    id: 'sk', layerId: 'layer', entities, constraints, dimensions,
    solveStatus: null,
  }
}

function camera(): THREE.OrthographicCamera {
  const cam = new THREE.OrthographicCamera(-50, 50, 37.5, -37.5, 0.1, 1000)
  cam.position.set(0, 0, 10)
  cam.updateMatrixWorld(true)
  return cam
}

function toPx(p: { x: number; y: number }): { x: number; y: number } {
  return { x: 400 + p.x * 8, y: 300 - p.y * 8 }
}

function centerCloud(layer: SketchLayer): THREE.Points {
  const matches = layer.group.children.filter((child) => child.name === '__sketch_centers__')
  expect(matches).toHaveLength(1)
  return matches[0] as THREE.Points
}

function endpointCloud(layer: SketchLayer): THREE.Points {
  const matches = layer.group.children.filter((child) => child.name === '__sketch_endpoints__')
  expect(matches).toHaveLength(1)
  return matches[0] as THREE.Points
}

function colorAt(cloud: THREE.Points, index: number): THREE.Color {
  const colors = cloud.geometry.getAttribute('color')
  return new THREE.Color(colors.getX(index), colors.getY(index), colors.getZ(index))
}

describe('SKC-62 visible and selectable center nodes', () => {
  it('renders canonical centers at rest and transitions hover -> selected', () => {
    const layer = new SketchLayer()
    const doc = sketch([CIRCLE])
    const centerId = centerSelectionIdForEntity(CIRCLE)!
    layer.update(doc, { selectedIds: new Set(), glyphsVisible: false })

    let cloud = centerCloud(layer)
    const positions = cloud.geometry.getAttribute('position')
    expect(positions.count).toBe(1)
    expect([positions.getX(0), positions.getY(0)]).toEqual([20, 10])
    expect((cloud.material as THREE.PointsMaterial).size).toBe(10)
    expect((cloud.material as THREE.PointsMaterial).sizeAttenuation).toBe(false)

    const rest = new THREE.Color(SKETCH_COLORS.underDefined)
      .lerp(new THREE.Color(SKETCH_COLORS.background), 0.45)
    expect(colorAt(cloud, 0).getHex()).toBe(rest.getHex())

    layer.setHover(centerId)
    cloud = centerCloud(layer)
    expect(colorAt(cloud, 0).getHex()).toBe(SKETCH_COLORS.hover)
    layer.update(doc, { selectedIds: new Set([centerId]), glyphsVisible: false })
    cloud = centerCloud(layer)
    expect(colorAt(cloud, 0).getHex()).toBe(SKETCH_COLORS.selected)
    layer.dispose()
  })

  it('click-picks and small-marquee-selects the typed circle center', () => {
    const layer = new SketchLayer()
    const centerId = centerSelectionIdForEntity(CIRCLE)!
    layer.update(sketch([CIRCLE]), { selectedIds: new Set(), glyphsVisible: false })
    layer.group.visible = true
    layer.onFrame(0.125)
    const px = toPx(CIRCLE.center)
    expect(layer.pick(px.x, px.y, camera(), 800, 600, 8))
      .toEqual({ id: centerId, type: 'entity' })
    expect(layer.entitiesInRect(19.5, 9.5, 20.5, 10.5, true)).toEqual([centerId])
    expect(layer.entitiesInRect(10, 0, 30, 20, true)).toEqual(['circle'])
    layer.dispose()
  })

  it('keeps a coincident ordinary point ahead of the virtual center tier', () => {
    const point: SketchEntity = {
      id: 'point', kind: 'point', construction: false, at: CIRCLE.center,
    }
    const layer = new SketchLayer()
    layer.update(sketch([CIRCLE, point]), { selectedIds: new Set(), glyphsVisible: false })
    layer.group.visible = true
    layer.onFrame(0.125)
    const px = toPx(CIRCLE.center)
    expect(layer.pick(px.x, px.y, camera(), 800, 600, 8))
      .toEqual({ id: 'point', type: 'entity' })
    layer.dispose()
  })
})

describe('SKC-62 center point semantics', () => {
  it('wakes a line midpoint as a stable center PointRef', () => {
    const snap = findSnap({
      cursor: { x: 5.1, y: 0 },
      entities: [LINE],
      worldPerPixel: 0.1,
      gridSpacing: 10,
    })
    expect(snap?.kind).toBe('midpoint')
    expect(snap?.wake?.ref).toEqual({ entityId: 'line', site: 'center' })
  })

  it('Smart Dimension directly picks a visible center with snap disabled', () => {
    let seq = 0
    const newId = () => `dim-${++seq}`
    const entities = [LINE, CIRCLE]
    const first = dimToolClick(null, CIRCLE.center, 0.5, entities, newId)
    expect(first.chain?.operandIds).toEqual([
      { entityId: 'circle', site: 'center' },
    ])
    const second = dimToolClick(
      first.chain,
      LINE.start,
      0.5,
      entities,
      newId,
      { point: LINE.start, ref: { entityId: 'line', site: 'start' } },
    )
    expect(second.chain?.operandIds).toEqual([
      { entityId: 'circle', site: 'center' },
      { entityId: 'line', site: 'start' },
    ])
  })

  it('plans point constraints and concentric from explicit center selections', () => {
    const doc = sketch([LINE, CIRCLE, CIRCLE_B])
    const lineCenter = centerSelectionIdForEntity(LINE)!
    const circleCenter = centerSelectionIdForEntity(CIRCLE)!
    const circleBCenter = centerSelectionIdForEntity(CIRCLE_B)!

    const coincident = planConstraintForSelection(
      doc, [lineCenter, circleCenter], 'coincident',
    )
    expect(coincident.ok).toBe(true)
    if (coincident.ok && coincident.constraints[0].kind === 'coincident') {
      expect(coincident.constraints[0].a)
        .toEqual({ entityId: 'line', site: 'center' })
      expect(coincident.constraints[0].b)
        .toEqual({ entityId: 'circle', site: 'center' })
    }
    for (const kind of ['horizontal', 'vertical'] as const) {
      const plan = planConstraintForSelection(doc, [circleCenter, circleBCenter], kind)
      expect(plan.ok, kind).toBe(true)
    }
    const fix = planConstraintForSelection(doc, [circleCenter], 'fix')
    expect(fix.ok).toBe(true)
    if (fix.ok && fix.constraints[0].kind === 'fix') {
      expect(fix.constraints[0].point)
        .toEqual({ entityId: 'circle', site: 'center' })
      expect(fix.constraints[0].entityId).toBeUndefined()
    }
    const concentric = planConstraintForSelection(
      doc, [circleCenter, circleBCenter], 'concentric',
    )
    expect(concentric.ok).toBe(true)
    if (concentric.ok && concentric.constraints[0].kind === 'concentric') {
      expect([concentric.constraints[0].a, concentric.constraints[0].b])
        .toEqual(['circle', 'circle-b'])
    }
  })

  it('deleting a selected center deletes its owner and dependent refs', () => {
    const centerId = centerSelectionIdForEntity(CIRCLE)!
    expect(decodeCenterSelectionRef(centerId))
      .toEqual({ entityId: 'circle', site: 'center' })
    const doc = sketch(
      [LINE, CIRCLE],
      [{
        id: 'co', kind: 'coincident',
        a: { entityId: 'circle', site: 'center' },
        b: { entityId: 'line', site: 'start' },
      }],
      [{
        id: 'dx', kind: 'distanceX', driving: true, value: 20,
        a: { entityId: 'circle', site: 'center' },
        b: { entityId: 'line', site: 'end' },
      }],
    )
    const result = deleteFromSketch(doc, [centerId])
    expect(result?.removedEntityIds).toEqual(['circle'])
    expect(result?.entities.map((entity) => entity.id)).toEqual(['line'])
    expect(result?.constraints).toEqual([])
    expect(result?.dimensions).toEqual([])
  })

  it('transform-copy remaps owner ids while preserving the center site', () => {
    const result = patternEntities(
      [CIRCLE, LINE],
      [{
        id: 'co', kind: 'coincident',
        a: { entityId: 'circle', site: 'center' },
        b: { entityId: 'line', site: 'center' },
      }],
      ['circle', 'line'],
      2,
      () => ({ map: (p) => ({ x: p.x + 100, y: p.y }), dTheta: 0 }),
      (() => {
        const ids = ['circle-copy', 'line-copy', 'constraint-copy']
        return () => ids.shift() ?? 'unexpected-id'
      })(),
    )
    expect(typeof result).not.toBe('string')
    if (typeof result === 'string') return
    expect(result.entities.map((entity) => entity.id))
      .toEqual(['circle-copy', 'line-copy'])
    expect(result.constraints).toEqual([{
      id: 'constraint-copy',
      kind: 'coincident',
      a: { entityId: 'circle-copy', site: 'center' },
      b: { entityId: 'line-copy', site: 'center' },
    }])
  })
})

describe('SKC-72 endpoint selection semantics', () => {
  const startId = encodeEndpointSelectionRef({ entityId: 'line', site: 'start' })
  const endId = encodeEndpointSelectionRef({ entityId: 'line', site: 'end' })

  it('picks an endpoint before its owning line and keeps body picking away from the end', () => {
    const layer = new SketchLayer()
    layer.update(sketch([LINE]), { selectedIds: new Set(), glyphsVisible: false })
    layer.group.visible = true
    layer.onFrame(0.125)
    const endpoint = toPx(LINE.start)
    const body = toPx({ x: 3, y: 0 })
    expect(layer.pick(endpoint.x, endpoint.y, camera(), 800, 600, 8))
      .toEqual({ id: startId, type: 'entity' })
    expect(layer.pick(body.x, body.y, camera(), 800, 600, 8))
      .toEqual({ id: 'line', type: 'entity' })
    layer.dispose()
  })

  it('paints endpoint hover and selection independently from the line body', () => {
    const layer = new SketchLayer()
    const doc = sketch([LINE])
    layer.update(doc, { selectedIds: new Set(), glyphsVisible: false })
    layer.setHover(startId)
    expect(colorAt(endpointCloud(layer), 0).getHex()).toBe(SKETCH_COLORS.hover)
    expect(colorAt(endpointCloud(layer), 1).getHex()).not.toBe(SKETCH_COLORS.hover)
    layer.update(doc, { selectedIds: new Set([endId]), glyphsVisible: false })
    expect(colorAt(endpointCloud(layer), 0).getHex()).not.toBe(SKETCH_COLORS.selected)
    expect(colorAt(endpointCloud(layer), 1).getHex()).toBe(SKETCH_COLORS.selected)
    layer.dispose()
  })

  it('plans endpoint pairs and point-to-curve coincidence in either order', () => {
    const other: SketchEntity = {
      id: 'other', kind: 'line', construction: false,
      start: { x: 20, y: 0 }, end: { x: 20, y: 10 },
    }
    const doc = sketch([LINE, other])
    const otherStart = encodeEndpointSelectionRef({ entityId: 'other', site: 'start' })
    for (const kind of ['horizontal', 'vertical', 'coincident'] as const) {
      expect(planConstraintForSelection(doc, [startId, otherStart], kind).ok, kind).toBe(true)
    }
    for (const selection of [[startId, 'other'], ['other', startId]]) {
      const plan = planConstraintForSelection(doc, selection, 'coincident')
      expect(plan.ok).toBe(true)
      if (plan.ok) {
        expect(plan.constraints[0]).toMatchObject({
          kind: 'point_on_object',
          point: { entityId: 'line', site: 'start' },
          object: 'other',
        })
      }
    }
  })
})
