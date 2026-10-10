import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  SketchLayer,
} from '../../lib/sketch/sketcher/sketchLayer'
import {
  centerSelectionIdForEntity,
} from '../../lib/sketch/centerReferences'
import { dimToolClick } from '../../lib/sketch/tools/dimTool'
import { planConstraintForSelection } from '../../lib/sketch/constraintActions'
import type {
  Sketch,
  SketchConstraintKind,
  SketchEntity,
} from '../../lib/sketch/types'

const CENTER = { x: 20, y: 10 }
const CIRCLE_A: SketchEntity = {
  id: 'circle-a', kind: 'circle', construction: false,
  center: CENTER, radius: 5,
}
const CIRCLE_B: SketchEntity = {
  id: 'circle-b', kind: 'circle', construction: false,
  center: CENTER, radius: 8,
}
const LINE: SketchEntity = {
  id: 'line', kind: 'line', construction: false,
  start: { x: 0, y: 0 }, end: { x: 10, y: 0 },
}

function sketch(entities: SketchEntity[]): Sketch {
  return {
    id: 'sk', layerId: 'layer', entities,
    constraints: [], dimensions: [], solveStatus: null,
  }
}

function camera(): THREE.OrthographicCamera {
  const cam = new THREE.OrthographicCamera(-50, 50, 37.5, -37.5, 0.1, 1000)
  cam.position.set(0, 0, 10)
  cam.updateMatrixWorld(true)
  return cam
}

function toPx(point: { x: number; y: number }): { x: number; y: number } {
  return { x: 400 + point.x * 8, y: 300 - point.y * 8 }
}

function expectNamedRefusal(
  selectedIds: string[],
  kind: SketchConstraintKind,
  reason: string,
): void {
  const result = planConstraintForSelection(sketch([LINE, CIRCLE_A]), selectedIds, kind)
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.reason).toContain(reason)
}

describe('SKC-62-R2 deterministic center ambiguity', () => {
  it('refuses overlapping centers in both picking paths regardless of document order', () => {
    const orders = [
      [CIRCLE_A, CIRCLE_B],
      [CIRCLE_B, CIRCLE_A],
    ]
    const px = toPx(CENTER)

    for (const entities of orders) {
      const layer = new SketchLayer()
      layer.update(sketch(entities), { selectedIds: new Set(), glyphsVisible: false })
      layer.group.visible = true
      layer.onFrame(0.125)
      expect(layer.pick(px.x, px.y, camera(), 800, 600, 8)).toBeNull()
      layer.dispose()

      const dim = dimToolClick(null, CENTER, 0.5, entities, () => 'unused')
      expect(dim.chain).toBeNull()
      expect(dim.dimension).toBeNull()
      expect(dim.notice).toContain('more than one center')
    }
  })
})

describe('SKC-62-R2 logical-owner planner refusals', () => {
  const lineCenter = centerSelectionIdForEntity(LINE)!
  const circleCenter = centerSelectionIdForEntity(CIRCLE_A)!

  it('refuses identical point references by name in either order', () => {
    for (const ids of [[circleCenter, 'circle-a'], ['circle-a', circleCenter]]) {
      expectNamedRefusal(ids, 'coincident', 'same point')
    }
    expectNamedRefusal([circleCenter, circleCenter], 'coincident', 'same point')
  })

  it('refuses a center constrained to its own owner by name in either order', () => {
    for (const ids of [[lineCenter, 'line'], ['line', lineCenter]]) {
      expectNamedRefusal(ids, 'midpoint', 'owning entity')
    }
    for (const ids of [[circleCenter, 'circle-a'], ['circle-a', circleCenter]]) {
      expectNamedRefusal(ids, 'horizontal', 'owning entity')
    }
  })

  it('refuses a same-owner concentric pair by name in either order', () => {
    for (const ids of [[circleCenter, 'circle-a'], ['circle-a', circleCenter]]) {
      expectNamedRefusal(ids, 'concentric', 'concentric with itself')
    }
  })

  it('refuses point-on-self-object by name in either order', () => {
    for (const ids of [[circleCenter, 'circle-a'], ['circle-a', circleCenter]]) {
      expectNamedRefusal(ids, 'point_on_object', 'point on its own object')
    }
  })

  it('refuses duplicate mixed center and whole-entity fix targets by name in either order', () => {
    for (const ids of [[circleCenter, 'circle-a'], ['circle-a', circleCenter]]) {
      expectNamedRefusal(ids, 'fix', 'both a center and its owning entity')
    }
  })
})

describe('SKC-62-R2 snap-off line-center dimension picking', () => {
  it('addresses the visible center marker while preserving line-body semantics away from it', () => {
    const atCenter = dimToolClick(
      null, { x: 5, y: 0 }, 0.5, [LINE], () => 'unused', null,
    )
    expect(atCenter.chain?.operandIds).toEqual([
      { entityId: 'line', site: 'center' },
    ])
    expect(atCenter.notice).toBeNull()

    const onBody = dimToolClick(
      null, { x: 2, y: 0 }, 0.5, [LINE], () => 'unused', null,
    )
    expect(onBody.chain?.operandIds).toEqual(['line'])
    expect(onBody.notice).toBeNull()
  })
})
