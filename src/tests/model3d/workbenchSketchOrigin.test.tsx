// @vitest-environment jsdom
//
// WO SKC-22: the workbench origin is a session-only, fixed sketch anchor.
// These tests deliberately cross the public seams that consume it: session
// injection, snap/dimension/constraint planning, the real
// planegcs drag solve, rail Delete, CommandHistory undo, and re-entry.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { GcsWrapper } from '@salusoft89/planegcs'

import { CommandHistory, ElementMap, FeatureDag, RegenScheduler } from '../../doc'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import { createBlankSketch } from '../../lib/sketch/blankSketch'
import { planConstraintForSelection } from '../../lib/sketch/constraintActions'
import { SketchLayer } from '../../lib/sketch/sketcher/sketchLayer'
import { findSnap } from '../../lib/sketch/snap'
import { solveSketchOnWrapper } from '../../lib/sketch/solver/gcsMapping'
import { planDimension, pickDimOperand } from '../../lib/sketch/tools/dimTool'
import type { Sketch, SketchEntity } from '../../lib/sketch/types'
import { worldToLocal, type PlaneFrame } from '../../sketch3d/planeMath'
import { WorkbenchToolRail } from '../../components/model3d/workbench/WorkbenchToolRail'
import { BASE_PLANE_FRAMES } from '../../components/model3d/workbench/basePlanes'
import {
  WORKBENCH_ORIGIN_ENTITY_ID,
  WORKBENCH_ORIGIN_FIX_ID,
  WORKBENCH_AXIS_X_ENTITY_ID,
  WORKBENCH_AXIS_X_FIX_ID,
  WORKBENCH_AXIS_Y_ENTITY_ID,
  WORKBENCH_AXIS_Y_FIX_ID,
  injectWorkbenchOrigin,
  stripWorkbenchOrigin,
  workbenchOriginAnchorLocal,
} from '../../components/model3d/workbench/workbenchOriginAnchor'
import { extractSketchProfile } from '../../components/model3d/workbench/sketchProfile'
import { sketchSessionStore } from '../../components/model3d/workbench/sketchSessionStore'
import {
  __resetSketchDocumentPort,
  syncSketchSessionFromDag,
  workbenchSketchDocumentPort,
} from '../../components/model3d/workbench/workbenchSketchDocumentPort'

const SKETCH_NODE_ID = 'sketch3d:origin-test'
const USER_POINT_ID = 'user-point'

let wrapper: GcsWrapper

beforeAll(async () => {
  wrapper = await createGcsWrapper()
}, 60_000)

afterAll(() => {
  wrapper.destroy_gcs_module()
})

beforeEach(() => {
  sketchSessionStore.__reset()
  __resetSketchDocumentPort()
})

afterEach(() => {
  cleanup()
  sketchSessionStore.__reset()
  __resetSketchDocumentPort()
})

function persistedSketch(entities: SketchEntity[] = []): Sketch {
  return {
    id: 'origin-test',
    layerId: 'workbench',
    entities,
    constraints: [],
    dimensions: [],
    // UNKNOWN is intentional: dragBegin must be decided by the origin's fix,
    // not vacuously refused by a stale "fully defined" status.
    solveStatus: null,
  }
}

function originPoint(sketch: Sketch) {
  const point = sketch.entities.find((entity) => entity.id === WORKBENCH_ORIGIN_ENTITY_ID)
  expect(point?.kind).toBe('point')
  if (point?.kind !== 'point') throw new Error('workbench origin point was not injected')
  return point
}

function countOriginEntities(sketch: Sketch): number {
  return sketch.entities.filter((entity) => entity.id === WORKBENCH_ORIGIN_ENTITY_ID).length
}

function countOriginFixes(sketch: Sketch): number {
  return sketch.constraints.filter((constraint) => constraint.id === WORKBENCH_ORIGIN_FIX_ID).length
}

interface PortHarness {
  dag: FeatureDag
  history: CommandHistory
  notices: Array<{ message: string; severity: string }>
  persisted: () => Sketch
  active: () => Sketch
}

function mountPort(sketch: Sketch, frame: PlaneFrame = BASE_PLANE_FRAMES.xy): PortHarness {
  const dag = new FeatureDag()
  const history = new CommandHistory(dag)
  const scheduler = new RegenScheduler(dag, new ElementMap())
  const notices: Array<{ message: string; severity: string }> = []
  dag.insertNode({
    id: SKETCH_NODE_ID,
    kind: 'sketch',
    consumes: [],
    refs: [],
    payload: { sketch, planeNodeId: 'plane:xy', externalRefs: [], dimensionDiagnostics: [] },
  })
  sketchSessionStore.bindDeps({
    dag,
    history,
    scheduler,
    wrapper,
    notice: (message, severity) => { notices.push({ message, severity }) },
    onDocumentChanged: () => {},
    onHistoryStep: () => {},
  })
  sketchSessionStore.begin(SKETCH_NODE_ID, frame, sketch)
  return {
    dag,
    history,
    notices,
    persisted: () => dag.getNode(SKETCH_NODE_ID)!.payload.sketch as Sketch,
    active: () => {
      const active = sketchSessionStore.getState().sketch
      if (active === null) throw new Error('origin test expected an active sketch session')
      return active
    },
  }
}

describe('A1/A4/A6: projection, uniqueness, and session-only lifecycle', () => {
  it('injects one fixed construction point at the projected world origin on base and offset planes', () => {
    const blank = persistedSketch()
    const base = injectWorkbenchOrigin(blank, BASE_PLANE_FRAMES.xy)
    const baseOrigin = originPoint(base)
    expect(baseOrigin.construction).toBe(true)
    expect(baseOrigin.at).toEqual({ x: 0, y: 0 })
    expect(countOriginEntities(base)).toBe(1)
    expect(countOriginFixes(base)).toBe(1)
    expect(base.constraints).toContainEqual({
      id: WORKBENCH_ORIGIN_FIX_ID,
      kind: 'fix',
      point: { entityId: WORKBENCH_ORIGIN_ENTITY_ID, site: 'self' },
    })

    const offset: PlaneFrame = {
      origin: { x: 12, y: -7, z: 30 },
      normal: { x: 0, y: 0, z: 1 },
      xDir: { x: 1, y: 0, z: 0 },
    }
    const projected = worldToLocal(offset, { x: 0, y: 0, z: 0 })
    const offPlane = injectWorkbenchOrigin(blank, offset)
    const offOrigin = originPoint(offPlane)
    expect(Number.isFinite(offOrigin.at.x)).toBe(true)
    expect(Number.isFinite(offOrigin.at.y)).toBe(true)
    expect(offOrigin.at.x).toBeCloseTo(projected.x, 12)
    expect(offOrigin.at.y).toBeCloseTo(projected.y, 12)
    expect(offOrigin.at).toEqual({ x: -12, y: 7 })
  })

  it('refuses a non-finite plane projection before an anchor can enter the session', () => {
    const nonFiniteFrame: PlaneFrame = {
      origin: { x: Number.NaN, y: 0, z: 0 },
      normal: { x: 0, y: 0, z: 1 },
      xDir: { x: 1, y: 0, z: 0 },
    }
    const blank = persistedSketch()

    expect(() => workbenchOriginAnchorLocal(nonFiniteFrame))
      .toThrow('Workbench origin anchor projection is not finite')
    expect(() => injectWorkbenchOrigin(blank, nonFiniteFrame))
      .toThrow('Workbench origin anchor projection is not finite')
    // Both helpers are pure: refusal cannot partially add a reserved object.
    expect(countOriginEntities(blank)).toBe(0)
    expect(countOriginFixes(blank)).toBe(0)
  })

  it('re-injection is idempotent, stripping persists no anchor, and a new session restores exactly one', () => {
    const original = persistedSketch([{
      id: USER_POINT_ID,
      kind: 'point',
      construction: false,
      at: { x: 8, y: 9 },
    }])
    const once = injectWorkbenchOrigin(original, BASE_PLANE_FRAMES.xy)
    const twice = injectWorkbenchOrigin(once, BASE_PLANE_FRAMES.xy)
    expect(countOriginEntities(twice)).toBe(1)
    expect(countOriginFixes(twice)).toBe(1)

    const stripped = stripWorkbenchOrigin(twice)
    expect(stripped).toEqual(original)
    expect(countOriginEntities(stripped)).toBe(0)
    expect(countOriginFixes(stripped)).toBe(0)

    const firstSession = mountPort(stripped)
    expect(countOriginEntities(firstSession.active())).toBe(1)
    expect(countOriginEntities(firstSession.persisted())).toBe(0)
    sketchSessionStore.end()
    sketchSessionStore.begin(SKETCH_NODE_ID, BASE_PLANE_FRAMES.xy, firstSession.persisted())
    expect(countOriginEntities(firstSession.active())).toBe(1)
    expect(countOriginFixes(firstSession.active())).toBe(1)
    expect(countOriginEntities(firstSession.persisted())).toBe(0)
  })

  it('does not change createBlankSketch, preserving the shared CAM model default', () => {
    const blank = createBlankSketch('cam-layer', () => 'stable-id')
    expect(blank.entities).toEqual([])
    expect(blank.constraints).toEqual([])
    expect(blank.dimensions).toEqual([])
    expect(stripWorkbenchOrigin(injectWorkbenchOrigin(blank, BASE_PLANE_FRAMES.xy))).toEqual(blank)
  })

  it('persists user refs to the reserved id, tolerates them while inactive, and resolves them on sync and re-entry', async () => {
    const DIM_POINT_ID = 'dimension-point'
    const COINCIDENT_POINT_ID = 'coincident-point'
    const DIMENSION_ID = 'origin-distance'
    const COINCIDENT_ID = 'origin-coincident'
    const h = mountPort(persistedSketch([
      {
        id: DIM_POINT_ID,
        kind: 'point',
        construction: false,
        at: { x: 3, y: 4 },
      },
      {
        id: COINCIDENT_POINT_ID,
        kind: 'point',
        construction: false,
        at: { x: 0, y: 0 },
      },
    ]))

    workbenchSketchDocumentPort.beginStep()
    workbenchSketchDocumentPort.append(
      {
        entities: [],
        constraints: [],
        dimensions: [{
          id: DIMENSION_ID,
          kind: 'distance',
          driving: true,
          value: 5,
          a: { entityId: WORKBENCH_ORIGIN_ENTITY_ID, site: 'self' },
          b: { entityId: DIM_POINT_ID, site: 'self' },
        }],
      },
      [{
        id: COINCIDENT_ID,
        kind: 'coincident',
        a: { entityId: COINCIDENT_POINT_ID, site: 'self' },
        b: { entityId: WORKBENCH_ORIGIN_ENTITY_ID, site: 'self' },
      }],
    )

    const stored = h.persisted()
    expect(countOriginEntities(stored)).toBe(0)
    expect(countOriginFixes(stored)).toBe(0)
    expect(stored.dimensions).toContainEqual(expect.objectContaining({
      id: DIMENSION_ID,
      a: { entityId: WORKBENCH_ORIGIN_ENTITY_ID, site: 'self' },
    }))
    expect(stored.constraints).toContainEqual(expect.objectContaining({
      id: COINCIDENT_ID,
      b: { entityId: WORKBENCH_ORIGIN_ENTITY_ID, site: 'self' },
    }))

    // Profile production is an inactive payload consumer. Session-only point
    // refs do not make it chase a missing entity or crash outside edit mode.
    const inactiveProfile = await extractSketchProfile(stored, BASE_PLANE_FRAMES.xy, stored.id)
    expect(inactiveProfile).toMatchObject({
      ok: false,
      refusal: { code: 'no-geometry' },
    })

    syncSketchSessionFromDag()
    expect(countOriginEntities(h.active())).toBe(1)
    expect(countOriginFixes(h.active())).toBe(1)
    expect(h.active().dimensions.find((dimension) => dimension.id === DIMENSION_ID))
      .toMatchObject({ a: { entityId: WORKBENCH_ORIGIN_ENTITY_ID, site: 'self' } })
    expect(h.active().constraints.find((constraint) => constraint.id === COINCIDENT_ID))
      .toMatchObject({ b: { entityId: WORKBENCH_ORIGIN_ENTITY_ID, site: 'self' } })
    expect(originPoint(h.active()).at).toEqual({ x: 0, y: 0 })

    sketchSessionStore.end()
    sketchSessionStore.begin(SKETCH_NODE_ID, BASE_PLANE_FRAMES.xy, stored)
    expect(countOriginEntities(h.active())).toBe(1)
    expect(countOriginFixes(h.active())).toBe(1)
    expect(h.active().dimensions.some((dimension) => dimension.id === DIMENSION_ID)).toBe(true)
    expect(h.active().constraints.some((constraint) => constraint.id === COINCIDENT_ID)).toBe(true)
  })
})

describe('A2: normal point semantics plus fixed drag/solve behavior', () => {
  it('participates in snap, dimension, and coincident planning as a point self-site', () => {
    const sketch = injectWorkbenchOrigin(persistedSketch([{
      id: USER_POINT_ID,
      kind: 'point',
      construction: false,
      at: { x: 3, y: 4 },
    }]), BASE_PLANE_FRAMES.xy)
    const origin = originPoint(sketch)

    const snap = findSnap({
      cursor: { ...origin.at },
      entities: sketch.entities,
      gridSpacing: 10,
      worldPerPixel: 0.1,
    })
    expect(snap?.point).toEqual(origin.at)
    expect(snap?.sourceEntityIds).toEqual([WORKBENCH_ORIGIN_ENTITY_ID])
    expect(snap?.inferences).toContainEqual({
      kind: 'coincident',
      to: { entityId: WORKBENCH_ORIGIN_ENTITY_ID, site: 'self' },
    })

    const dimension = planDimension(sketch.entities, [WORKBENCH_ORIGIN_ENTITY_ID, USER_POINT_ID])
    expect(dimension.ok).toBe(true)
    if (dimension.ok) {
      expect(dimension.plan.kind).toBe('distance')
      expect(dimension.plan).toMatchObject({
        a: { entityId: WORKBENCH_ORIGIN_ENTITY_ID, site: 'self' },
        b: { entityId: USER_POINT_ID, site: 'self' },
        value: 5,
      })
    }

    const coincident = planConstraintForSelection(
      sketch,
      [WORKBENCH_ORIGIN_ENTITY_ID, USER_POINT_ID],
      'coincident',
    )
    expect(coincident.ok).toBe(true)
    if (coincident.ok) {
      expect(coincident.constraints[0]).toMatchObject({
        kind: 'coincident',
        a: { entityId: WORKBENCH_ORIGIN_ENTITY_ID, site: 'self' },
        b: { entityId: USER_POINT_ID, site: 'self' },
      })
    }
  })

  it('refuses a direct port drag and a real solver drag against it leaves finite coordinates unchanged', () => {
    const h = mountPort(persistedSketch([{
      id: USER_POINT_ID,
      kind: 'point',
      construction: false,
      at: { x: 0, y: 0 },
    }]))
    let beganMutation = false
    const accepted = workbenchSketchDocumentPort.dragBegin(
      WORKBENCH_ORIGIN_ENTITY_ID,
      { x: 0, y: 0 },
      0.1,
      () => { beganMutation = true },
    )
    expect(accepted).toBe(false)
    expect(beganMutation).toBe(false)

    const active = h.active()
    const constrained: Sketch = {
      ...active,
      constraints: [
        ...active.constraints,
        {
          id: 'user-to-origin',
          kind: 'coincident',
          a: { entityId: USER_POINT_ID, site: 'self' },
          b: { entityId: WORKBENCH_ORIGIN_ENTITY_ID, site: 'self' },
        },
      ],
    }
    const before = { ...originPoint(constrained).at }
    const solved = solveSketchOnWrapper(wrapper, constrained, {
      targets: [{
        point: { entityId: USER_POINT_ID, site: 'self' },
        to: { x: 25, y: -18 },
      }],
    })
    expect(solved.ok).toBe(true)
    if (!solved.ok) return
    const afterEntity = solved.entities.find((entity) => entity.id === WORKBENCH_ORIGIN_ENTITY_ID)
    expect(afterEntity?.kind).toBe('point')
    if (afterEntity?.kind !== 'point') return
    expect(Number.isFinite(afterEntity.at.x)).toBe(true)
    expect(Number.isFinite(afterEntity.at.y)).toBe(true)
    expect(afterEntity.at.x).toBe(before.x)
    expect(afterEntity.at.y).toBe(before.y)
  })
})

describe('A3/A4: rail Delete protection, mixed delete, undo, and persistence boundary', () => {
  it('protects an origin-only selection and deletes only the user entity from a mixed selection', () => {
    const h = mountPort(persistedSketch([{
      id: USER_POINT_ID,
      kind: 'point',
      construction: false,
      at: { x: 6, y: 4 },
    }]))
    render(
      <WorkbenchToolRail
        sketchActive
        modelingSections={[]}
        sketchHistoryTools={[]}
        onFinishSketch={() => {}}
      />,
    )
    const deleteButton = () => screen.getByTestId('workbench-package-delete') as HTMLButtonElement

    act(() => {
      workbenchSketchDocumentPort.setSelection([WORKBENCH_ORIGIN_ENTITY_ID])
    })
    fireEvent.click(deleteButton())
    expect(countOriginEntities(h.active())).toBe(1)
    expect(h.active().entities.some((entity) => entity.id === USER_POINT_ID)).toBe(true)
    expect(h.history.canUndo()).toBe(false)
    expect(countOriginEntities(h.persisted())).toBe(0)
    expect(h.notices).toContainEqual({
      message: 'Origin/axis anchors cannot be deleted.',
      severity: 'warning',
    })

    act(() => {
      workbenchSketchDocumentPort.setSelection([WORKBENCH_ORIGIN_ENTITY_ID, USER_POINT_ID])
    })
    fireEvent.click(deleteButton())
    expect(countOriginEntities(h.active())).toBe(1)
    expect(h.active().entities.some((entity) => entity.id === USER_POINT_ID)).toBe(false)
    expect(countOriginEntities(h.persisted())).toBe(0)
    expect(h.persisted().entities.some((entity) => entity.id === USER_POINT_ID)).toBe(false)
    expect(h.history.canUndo()).toBe(true)
    expect(h.notices).toContainEqual({
      message: 'Origin/axis anchors were excluded from Delete.',
      severity: 'info',
    })

    expect(h.history.undo()).toBe(true)
    syncSketchSessionFromDag()
    expect(countOriginEntities(h.active())).toBe(1)
    expect(countOriginFixes(h.active())).toBe(1)
    expect(h.active().entities.some((entity) => entity.id === USER_POINT_ID)).toBe(true)
    expect(countOriginEntities(h.persisted())).toBe(0)
  })

  it('carries a real SketchLayer marquee through rail Delete and history undo without selecting the origin', () => {
    const h = mountPort(persistedSketch([{
      id: USER_POINT_ID,
      kind: 'point',
      construction: false,
      at: { x: 6, y: 4 },
    }]))
    const layer = new SketchLayer()
    layer.update(h.active(), sketchSessionStore.getViewState())
    try {
      // This rectangle geometrically encloses BOTH points. The layer must
      // return only the ordinary entity because originAnchorId is view policy.
      const marqueeIds = layer.entitiesInRect(-1, -1, 7, 5, true)
      expect(marqueeIds).toEqual([USER_POINT_ID])

      render(
        <WorkbenchToolRail
          sketchActive
          modelingSections={[]}
          sketchHistoryTools={[]}
          onFinishSketch={() => {}}
        />,
      )
      act(() => {
        workbenchSketchDocumentPort.setSelection(marqueeIds)
      })
      const deleteButton = screen.getByTestId('workbench-package-delete') as HTMLButtonElement
      expect(deleteButton.disabled).toBe(false)
      fireEvent.click(deleteButton)

      expect(h.active().entities.some((entity) => entity.id === USER_POINT_ID)).toBe(false)
      expect(countOriginEntities(h.active())).toBe(1)
      expect(countOriginFixes(h.active())).toBe(1)
      expect(countOriginEntities(h.persisted())).toBe(0)
      expect(h.history.canUndo()).toBe(true)

      expect(h.history.undo()).toBe(true)
      syncSketchSessionFromDag()
      expect(h.active().entities.some((entity) => entity.id === USER_POINT_ID)).toBe(true)
      expect(countOriginEntities(h.active())).toBe(1)
      expect(countOriginFixes(h.active())).toBe(1)
      expect(countOriginEntities(h.persisted())).toBe(0)
    } finally {
      layer.dispose()
    }
  })
})

// WO SKC-49 (Operator Q-35): origin AND X/Y axes are first-class dimension pick targets. These tests
// cover the acceptance list's workbench half -- angle/distancePL against an axis flowing through
// dimTool.ts's UNCHANGED planDimension branches, pick-extent === paint-extent, snap suppression,
// marquee/delete protection extended to both axes, and the declared junk-gesture policy.
describe('A7 (WO SKC-49): X/Y axis anchors', () => {
  function axisX(sketch: Sketch) {
    const line = sketch.entities.find((entity) => entity.id === WORKBENCH_AXIS_X_ENTITY_ID)
    expect(line?.kind).toBe('line')
    if (line?.kind !== 'line') throw new Error('workbench X axis was not injected')
    return line
  }
  function axisY(sketch: Sketch) {
    const line = sketch.entities.find((entity) => entity.id === WORKBENCH_AXIS_Y_ENTITY_ID)
    expect(line?.kind).toBe('line')
    if (line?.kind !== 'line') throw new Error('workbench Y axis was not injected')
    return line
  }

  it('injects two fixed construction axis lines through the origin, finite and endpoint-symmetric', () => {
    const blank = persistedSketch()
    const injected = injectWorkbenchOrigin(blank, BASE_PLANE_FRAMES.xy)
    const x = axisX(injected)
    const y = axisY(injected)
    expect(x.construction).toBe(true)
    expect(y.construction).toBe(true)
    expect(x.start.y).toBe(0)
    expect(x.end.y).toBe(0)
    expect(x.start.x).toBeLessThan(0)
    expect(x.end.x).toBeGreaterThan(0)
    expect(y.start.x).toBe(0)
    expect(y.end.x).toBe(0)
    expect(y.start.y).toBeLessThan(0)
    expect(y.end.y).toBeGreaterThan(0)
    // Both axes pass through the SAME projected origin the point anchor uses.
    const origin = originPoint(injected)
    expect((x.start.x + x.end.x) / 2).toBeCloseTo(origin.at.x, 9)
    expect((y.start.y + y.end.y) / 2).toBeCloseTo(origin.at.y, 9)
    expect(injected.constraints).toContainEqual({
      id: WORKBENCH_AXIS_X_FIX_ID, kind: 'fix', entityId: WORKBENCH_AXIS_X_ENTITY_ID,
    })
    expect(injected.constraints).toContainEqual({
      id: WORKBENCH_AXIS_Y_FIX_ID, kind: 'fix', entityId: WORKBENCH_AXIS_Y_ENTITY_ID,
    })
  })

  it('strips both axes on persist and re-injects them idempotently on re-entry', () => {
    const original = persistedSketch()
    const once = injectWorkbenchOrigin(original, BASE_PLANE_FRAMES.xy)
    const twice = injectWorkbenchOrigin(once, BASE_PLANE_FRAMES.xy)
    expect(twice.entities.filter((e) => e.id === WORKBENCH_AXIS_X_ENTITY_ID)).toHaveLength(1)
    expect(twice.entities.filter((e) => e.id === WORKBENCH_AXIS_Y_ENTITY_ID)).toHaveLength(1)
    expect(twice.constraints.filter((c) => c.id === WORKBENCH_AXIS_X_FIX_ID)).toHaveLength(1)
    expect(twice.constraints.filter((c) => c.id === WORKBENCH_AXIS_Y_FIX_ID)).toHaveLength(1)

    const stripped = stripWorkbenchOrigin(twice)
    expect(stripped).toEqual(original)
    expect(stripped.entities.some((e) => e.id === WORKBENCH_AXIS_X_ENTITY_ID)).toBe(false)
    expect(stripped.entities.some((e) => e.id === WORKBENCH_AXIS_Y_ENTITY_ID)).toBe(false)
  })

  it('flows an angle dimension against the X axis and the Y axis through the UNCHANGED angle branch, order-independent', () => {
    const userLine: SketchEntity = {
      id: 'user-line', kind: 'line', construction: false,
      start: { x: 2, y: 2 }, end: { x: 8, y: 6 },
    }
    const sketch = injectWorkbenchOrigin(persistedSketch([userLine]), BASE_PLANE_FRAMES.xy)

    const angleXFirst = planDimension(sketch.entities, [WORKBENCH_AXIS_X_ENTITY_ID, 'user-line'])
    const angleXSecond = planDimension(sketch.entities, ['user-line', WORKBENCH_AXIS_X_ENTITY_ID])
    expect(angleXFirst.ok).toBe(true)
    expect(angleXSecond.ok).toBe(true)
    if (angleXFirst.ok) expect(angleXFirst.plan.kind).toBe('angle')
    if (angleXSecond.ok) expect(angleXSecond.plan.kind).toBe('angle')

    const angleY = planDimension(sketch.entities, ['user-line', WORKBENCH_AXIS_Y_ENTITY_ID])
    expect(angleY.ok).toBe(true)
    if (angleY.ok) {
      expect(angleY.plan).toMatchObject({ kind: 'angle', a: 'user-line', b: WORKBENCH_AXIS_Y_ENTITY_ID })
    }
  })

  it('flows a distancePL from a point to an axis through the UNCHANGED distancePL branch, order-independent', () => {
    const userPoint: SketchEntity = { id: 'user-pt', kind: 'point', construction: false, at: { x: 5, y: 9 } }
    const sketch = injectWorkbenchOrigin(persistedSketch([userPoint]), BASE_PLANE_FRAMES.xy)

    const firstOrder = planDimension(sketch.entities, ['user-pt', WORKBENCH_AXIS_X_ENTITY_ID])
    const secondOrder = planDimension(sketch.entities, [WORKBENCH_AXIS_X_ENTITY_ID, 'user-pt'])
    expect(firstOrder.ok).toBe(true)
    expect(secondOrder.ok).toBe(true)
    if (firstOrder.ok && firstOrder.plan.kind === 'distancePL') {
      expect(firstOrder.plan.line).toBe(WORKBENCH_AXIS_X_ENTITY_ID)
      expect(firstOrder.plan.value).toBeCloseTo(9, 9)
    } else {
      throw new Error('expected distancePL plan (first order)')
    }
    if (secondOrder.ok) expect(secondOrder.plan.kind).toBe('distancePL')
  })

  it('R1: committed BOTH an angle dim (vs X axis) AND a distancePL dim (vs Y axis) survive strip + JSON round trip and re-solve clean through the REAL host seam (begin/ensureSketch)', () => {
    const userLine: SketchEntity = {
      id: 'user-line', kind: 'line', construction: false,
      start: { x: 2, y: 2 }, end: { x: 8, y: 6 },
    }
    const userPoint: SketchEntity = { id: 'user-pt', kind: 'point', construction: false, at: { x: 5, y: 9 } }
    const h = mountPort(persistedSketch([userLine, userPoint]))

    const angleDim = {
      id: 'angle-vs-x-axis', kind: 'angle' as const, driving: true, value: 0,
      a: 'user-line', b: WORKBENCH_AXIS_X_ENTITY_ID,
    }
    const distancePLDim = {
      id: 'distancePL-vs-y-axis', kind: 'distancePL' as const, driving: true, value: 5,
      point: { entityId: 'user-pt', site: 'self' as const }, line: WORKBENCH_AXIS_Y_ENTITY_ID,
    }
    // replace() is the modify-tool commit path -- it strips + persists to the dag payload through
    // the SAME commitSketch() every real gesture uses (workbenchSketchDocumentPort.ts:394).
    workbenchSketchDocumentPort.replace({
      entities: h.active().entities,
      constraints: h.active().constraints,
      dimensions: [...h.active().dimensions, angleDim, distancePLDim],
    })

    const storedBefore = h.persisted()
    expect(storedBefore.entities.some((e) => e.id === WORKBENCH_AXIS_X_ENTITY_ID)).toBe(false) // strip proven
    expect(storedBefore.dimensions).toContainEqual(expect.objectContaining({
      id: 'angle-vs-x-axis', a: 'user-line', b: WORKBENCH_AXIS_X_ENTITY_ID,
    }))
    expect(storedBefore.dimensions).toContainEqual(expect.objectContaining({
      id: 'distancePL-vs-y-axis', line: WORKBENCH_AXIS_Y_ENTITY_ID,
    }))

    // Serialize to JSON and back -- proves the round trip survives a REAL save/load boundary, not
    // just an in-memory reference (finding [1]: "JSON round-trip, not object identity").
    const roundTripped: Sketch = JSON.parse(JSON.stringify(storedBefore))

    // Reopen through the REAL host seam: `sketchSessionStore.begin()` is exactly what
    // `SolidsWorkbenchPage.beginPackageSketch` calls with `node.payload.sketch` on every re-entry
    // (create AND reopen alike) -- not a test-only shortcut.
    sketchSessionStore.begin(SKETCH_NODE_ID, BASE_PLANE_FRAMES.xy, roundTripped)
    const reopened = h.active()
    expect(countOriginEntities(reopened)).toBe(1) // anchors re-injected before anything else runs
    expect(reopened.entities.some((e) => e.id === WORKBENCH_AXIS_X_ENTITY_ID)).toBe(true)
    expect(reopened.entities.some((e) => e.id === WORKBENCH_AXIS_Y_ENTITY_ID)).toBe(true)
    expect(reopened.dimensions.find((d) => d.id === 'angle-vs-x-axis'))
      .toMatchObject({ a: 'user-line', b: WORKBENCH_AXIS_X_ENTITY_ID })
    expect(reopened.dimensions.find((d) => d.id === 'distancePL-vs-y-axis'))
      .toMatchObject({ line: WORKBENCH_AXIS_Y_ENTITY_ID })

    // ensureSketch as its own bypass leg (finding [1] names it explicitly): the workbench port's
    // ensureSketch is a plain passthrough (never re-injects on its own -- begin() above already
    // did), so exercising it here proves it hands back the SAME reopened, anchor-bearing,
    // dimension-bearing document rather than a stale or re-derived one.
    expect(workbenchSketchDocumentPort.ensureSketch()).toBe(reopened)

    // A genuinely NEW solve (not the stale pre-reopen status carried in from JSON) resolves clean:
    // the axis ids the round-tripped dimensions reference are real, grounded entities again.
    const solved = solveSketchOnWrapper(wrapper, reopened)
    expect(solved.ok).toBe(true)
    if (!solved.ok) return
    expect(solved.status.solveFailed).toBeUndefined()
    expect(solved.status.conflicting).toEqual([])
  })

  it('suppresses axis endpoint/midpoint snap spots so a mid-axis click classifies as a LINE operand, not an arbitrary point', () => {
    const sketch = injectWorkbenchOrigin(persistedSketch(), BASE_PLANE_FRAMES.xy)
    // Cursor sits on the X axis BODY, far from its synthetic endpoints/midpoint (the origin).
    const snap = findSnap({
      cursor: { x: 40, y: 0 }, entities: sketch.entities, gridSpacing: 10, worldPerPixel: 0.1,
    })
    expect(snap).toBeNull()
    const hit = pickDimOperand(sketch.entities, { x: 40, y: 0 }, 1)
    expect(hit).toBe(WORKBENCH_AXIS_X_ENTITY_ID)
  })

  it('binds pick extent to paint extent: a click just inside the axis endpoint picks it, just outside misses', () => {
    const sketch = injectWorkbenchOrigin(persistedSketch(), BASE_PLANE_FRAMES.xy)
    const x = axisX(sketch)
    const justInside = { x: x.end.x - 1, y: 0 }
    const justOutside = { x: x.end.x + 10, y: 0 }
    expect(pickDimOperand(sketch.entities, justInside, 1)).toBe(WORKBENCH_AXIS_X_ENTITY_ID)
    expect(pickDimOperand(sketch.entities, justOutside, 1)).toBeNull()
  })

  it('excludes both axes (view POLICY, not geometry) from a crossing marquee that geometrically intersects them', () => {
    const sketch = injectWorkbenchOrigin(persistedSketch([{
      id: USER_POINT_ID, kind: 'point', construction: false, at: { x: 3, y: 3 },
    }]), BASE_PLANE_FRAMES.xy)
    const layer = new SketchLayer()
    layer.update(sketch, sketchSessionStore.getViewState())
    try {
      // Crossing mode (window=false): a small rect straddling the origin DOES intersect both axis
      // lines geometrically (they run straight through it) -- proving the exclusion is deliberate
      // VIEW POLICY, not "the rect happened to miss them" (the earlier window=true origin test).
      const crossing = layer.entitiesInRect(-5, -5, 5, 5, false)
      expect(crossing).not.toContain(WORKBENCH_AXIS_X_ENTITY_ID)
      expect(crossing).not.toContain(WORKBENCH_AXIS_Y_ENTITY_ID)
      expect(crossing).not.toContain(WORKBENCH_ORIGIN_ENTITY_ID)
      expect(crossing).toContain(USER_POINT_ID)
    } finally {
      layer.dispose()
    }
  })

  it('protects both axes from rail Delete alongside the origin, with the renamed notice text', () => {
    const h = mountPort(persistedSketch([{
      id: USER_POINT_ID, kind: 'point', construction: false, at: { x: 6, y: 4 },
    }]))
    render(
      <WorkbenchToolRail
        sketchActive
        modelingSections={[]}
        sketchHistoryTools={[]}
        onFinishSketch={() => {}}
      />,
    )
    const deleteButton = () => screen.getByTestId('workbench-package-delete') as HTMLButtonElement

    act(() => {
      workbenchSketchDocumentPort.setSelection([WORKBENCH_AXIS_X_ENTITY_ID, WORKBENCH_AXIS_Y_ENTITY_ID])
    })
    fireEvent.click(deleteButton())
    expect(h.active().entities.some((e) => e.id === WORKBENCH_AXIS_X_ENTITY_ID)).toBe(true)
    expect(h.active().entities.some((e) => e.id === WORKBENCH_AXIS_Y_ENTITY_ID)).toBe(true)
    expect(h.history.canUndo()).toBe(false)
    expect(h.notices).toContainEqual({
      message: 'Origin/axis anchors cannot be deleted.', severity: 'warning',
    })

    act(() => {
      workbenchSketchDocumentPort.setSelection([WORKBENCH_AXIS_X_ENTITY_ID, USER_POINT_ID])
    })
    fireEvent.click(deleteButton())
    expect(h.active().entities.some((e) => e.id === WORKBENCH_AXIS_X_ENTITY_ID)).toBe(true)
    expect(h.active().entities.some((e) => e.id === USER_POINT_ID)).toBe(false)
    expect(h.notices).toContainEqual({
      message: 'Origin/axis anchors were excluded from Delete.', severity: 'info',
    })
  })

  it('junk-gesture policy: a lone-axis distance dim and an X+Y axis angle dim are DECLARED allowed -- finite, correctly-computed, never silent/NaN/crashing', () => {
    // dimTool.ts is frozen (Reads-never-write, WO's own binding design decision: "the WHOLE POINT
    // is that they need NO changes"), so this is NOT a new BY-NAME refusal. MEASURED (not
    // assumed) against the real solver: a lone axis reaches planDimension's ops.length === 1 line
    // branch -- exactly the SAME unchanged default every lone user line already gets (its own
    // length) -- and an axis-vs-axis pick reaches the SAME unchanged two-line angle branch every
    // ordinary line pair gets. Both axis endpoints are already grounded (whole-entity fix), so
    // planegcs's redundant/conflicting diagnosis runs over the REDUCED (fixed-params-removed)
    // system: a dimension touching only already-grounded points contributes no equation to that
    // reduced system at all, so it registers as neither redundant NOR conflicting (confirmed via
    // an ad-hoc probe this session, coordination/evidence/SKC-49/ -- dof:0, conflicting:[],
    // redundant:[] for BOTH a lone-axis distance dim of 200000 and a deliberately-wrong-value
    // axis-vs-axis angle dim). The junk-gesture policy this WO's item 7 asks for is therefore:
    // ALLOWED, not refused -- because it is provably harmless (a large-but-honest, finite,
    // correctly-computed value; never NaN, never a silent drop, never a crash, never corrupts
    // other geometry) and structurally identical to pre-existing, unremarkable lone-line/two-line
    // defaults. The genuinely dangerous case -- a FREE user entity double-constrained
    // inconsistently against a fixed axis -- is acceptance criterion 5, covered by the next test.
    const h = mountPort(persistedSketch())

    const loneAxisPlan = planDimension(h.active().entities, [WORKBENCH_AXIS_X_ENTITY_ID])
    expect(loneAxisPlan.ok).toBe(true)
    if (!loneAxisPlan.ok || loneAxisPlan.plan.kind !== 'distance') {
      throw new Error('expected a lone-axis distance plan')
    }
    const loneAxisDistancePlan = loneAxisPlan.plan
    // Finite and positive (honest geometry, never NaN/Infinity) -- the accept-point validation
    // charter item 3 demands, applied to this specific "arbitrary but real" value.
    expect(Number.isFinite(loneAxisDistancePlan.value)).toBe(true)
    expect(loneAxisDistancePlan.value).toBeGreaterThan(0)

    const angleBetweenAxesPlan = planDimension(
      h.active().entities, [WORKBENCH_AXIS_X_ENTITY_ID, WORKBENCH_AXIS_Y_ENTITY_ID],
    )
    expect(angleBetweenAxesPlan.ok).toBe(true)
    if (!angleBetweenAxesPlan.ok || angleBetweenAxesPlan.plan.kind !== 'angle') {
      throw new Error('expected an axis-vs-axis angle plan')
    }
    // The axes are perpendicular by construction (local +X / +Y) -- exactly pi/2, finite.
    expect(angleBetweenAxesPlan.plan.value).toBeCloseTo(Math.PI / 2, 12)

    const withBothDims: Sketch = {
      ...h.active(),
      dimensions: [
        ...h.active().dimensions,
        {
          id: 'lone-axis-dim', kind: 'distance', driving: true,
          value: loneAxisDistancePlan.value, a: loneAxisDistancePlan.a, b: loneAxisDistancePlan.b,
        },
        {
          id: 'axis-vs-axis-angle', kind: 'angle', driving: true,
          value: angleBetweenAxesPlan.plan.value,
          a: angleBetweenAxesPlan.plan.a, b: angleBetweenAxesPlan.plan.b,
        },
      ],
    }
    const solved = solveSketchOnWrapper(wrapper, withBothDims)
    // Never silent: committing both junk gestures produces a clean, inspectable solve -- never a
    // crash, never solveFailed, never NaN propagating through dof/conflicting.
    expect(solved.ok).toBe(true)
    if (!solved.ok) return
    expect(solved.status.solveFailed).toBeUndefined()
    expect(solved.status.conflicting).toEqual([])
    expect(Number.isFinite(solved.status.dof)).toBe(true)
  })

  it('acceptance 5: dimensioning a FREE user entity inconsistently against a fixed axis surfaces through the existing fail-loud conflict path', () => {
    // The axes themselves have no free parameters (whole-entity fix), so nothing can conflict
    // over them alone (the previous test's finding). The real over-definition risk this WO's
    // acceptance item 5 names is a user line CONSTRAINED twice, inconsistently, against a fixed
    // axis: 'horizontal' pins it parallel to the X axis (angle 0), and a driving angle dim vs the
    // Y axis then DEMANDS a value other than the resulting 90deg -- unsatisfiable.
    const userLine: SketchEntity = {
      id: 'user-line', kind: 'line', construction: false,
      start: { x: 3, y: 3 }, end: { x: 9, y: 3 },
    }
    const sketch = injectWorkbenchOrigin(persistedSketch([userLine]), BASE_PLANE_FRAMES.xy)
    const withConflict: Sketch = {
      ...sketch,
      constraints: [
        ...sketch.constraints,
        { id: 'user-line-horizontal', kind: 'horizontal', line: 'user-line' },
      ],
      dimensions: [
        {
          id: 'conflicting-angle-vs-y-axis', kind: 'angle', driving: true,
          value: Math.PI / 4, // demands 45deg; horizontal + the fixed Y axis together force 90deg
          a: 'user-line', b: WORKBENCH_AXIS_Y_ENTITY_ID,
        },
      ],
    }
    const solved = solveSketchOnWrapper(wrapper, withConflict)
    // MEASURED (not assumed): a genuinely unsatisfiable conflict against a fixed axis fails the
    // mapping/solve outright (ok:false) rather than returning ok:true with a populated
    // `conflicting` array -- the fail-loud path is `status.solveFailed` + `status.conflicting`
    // NAMING the offending constraint/dimension ids, exactly ADR-0003's guarantee ("the over-
    // defined UX names the offending constraints/dimensions... never silently dropped").
    expect(solved.ok).toBe(false)
    if (solved.ok) return
    expect(solved.reason).toBe('conflicting')
    expect(solved.status.solveFailed).toBe(true)
    expect(solved.status.conflicting).toContain('user-line-horizontal')
    expect(solved.status.conflicting).toContain('conflicting-angle-vs-y-axis')
    // Fail-loud, never a crash: a named, inspectable failure reason and status, not a throw.
    expect(typeof solved.message).toBe('string')
  })
})

describe('WO SKC-49-R2 (tooltip gate 2/4): WorkbenchToolRail Finish tooltip is empty-after-strip', () => {
  // WorkbenchToolRail.tsx:324 used raw `sketch.entities.length` to decide "has geometry" vs
  // "empty" for the shared SketchFinishButton's tooltip. WO SKC-49's origin/axis anchors are
  // always present in the live session document, so that raw count is never 0 anymore -- routed
  // through the shared `sketchHasUserContent` predicate (entities OR dimensions OR constraints,
  // after strip) instead, same as the CAM host (SketchToolbox.tsx).
  it('a truly blank session (three anchors, zero user content) shows the empty-exit tooltip', () => {
    mountPort(persistedSketch())
    render(
      <WorkbenchToolRail
        sketchActive
        modelingSections={[]}
        sketchHistoryTools={[]}
        onFinishSketch={() => {}}
      />,
    )
    const finish = screen.getByTestId('workbench-finish-package-sketch')
    expect(finish.getAttribute('data-tooltip')).toBe('Exit sketch mode (empty sketch is discarded)')
  })

  it('a dimension-only session (zero user entities, one axis dim) shows the bake tooltip', () => {
    const h = mountPort(persistedSketch())
    const loneAxisPlan = planDimension(h.active().entities, [WORKBENCH_AXIS_X_ENTITY_ID])
    expect(loneAxisPlan.ok).toBe(true)
    if (!loneAxisPlan.ok || loneAxisPlan.plan.kind !== 'distance') {
      throw new Error('expected a lone-axis distance plan')
    }
    const loneAxisDistancePlan = loneAxisPlan.plan
    act(() => {
      const current = sketchSessionStore.getState().sketch!
      sketchSessionStore.setState({
        sketch: {
          ...current,
          dimensions: [{
            id: 'lone-axis-dim', kind: 'distance', driving: true,
            value: loneAxisDistancePlan.value, a: loneAxisDistancePlan.a, b: loneAxisDistancePlan.b,
          }],
        },
      })
    })
    render(
      <WorkbenchToolRail
        sketchActive
        modelingSections={[]}
        sketchHistoryTools={[]}
        onFinishSketch={() => {}}
      />,
    )
    const finish = screen.getByTestId('workbench-finish-package-sketch')
    expect(finish.getAttribute('data-tooltip')).toBe('Bake this sketch to its geometry layer and exit sketch mode')
  })
})
