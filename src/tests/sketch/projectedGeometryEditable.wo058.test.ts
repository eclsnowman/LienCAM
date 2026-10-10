import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { toggleConstructionFlags } from '../../lib/sketch/tools/toolMachine'
import { trimAtPoint, type SketchDoc } from '../../lib/sketch/tools/trimTool'
import { extendClick } from '../../lib/sketch/tools/extendTool'
import { filletLines } from '../../lib/sketch/tools/filletTool'
import { chamferLines } from '../../lib/sketch/tools/chamferTool'
import {
  SKETCH_COLORS,
  SketchLayer,
  type SketchViewState,
} from '../../lib/sketch/sketcher/sketchLayer'
import type {
  Sketch,
  SketchConstraint,
  SketchEntity,
  SketchLineEntity,
} from '../../lib/sketch/types'

function line(
  id: string,
  start: [number, number],
  end: [number, number],
  projected = false,
): SketchLineEntity {
  return {
    id,
    kind: 'line',
    construction: false,
    provenance: projected ? 'projected' : undefined,
    start: { x: start[0], y: start[1] },
    end: { x: end[0], y: end[1] },
  }
}

function fixed(entityId: string): SketchConstraint {
  return {
    id: `fix-${entityId}`,
    kind: 'fix',
    entityId,
    projectionGrounding: true,
  }
}

function legacyFixed(entityId: string): SketchConstraint {
  return { id: `legacy-fix-${entityId}`, kind: 'fix', entityId }
}

function doc(
  entities: SketchEntity[],
  constraints: SketchConstraint[] = [],
): SketchDoc {
  return { entities, constraints, dimensions: [] }
}

function reloaded(source: SketchDoc): SketchDoc {
  return JSON.parse(JSON.stringify(source)) as SketchDoc
}

function ids(prefix: string): () => string {
  let next = 0
  return () => `${prefix}-${next++}`
}

function expectProjectedColor(entities: SketchEntity[], entityIds: string[]): void {
  const sketch: Sketch = {
    id: 'wo-058-style',
    layerId: 'workbench',
    entities,
    constraints: [],
    dimensions: [],
    solveStatus: null,
  }
  const view: SketchViewState = {
    selectedIds: new Set(),
    glyphsVisible: false,
    editingId: null,
  }
  const layer = new SketchLayer()
  layer.update(sketch, view)
  for (const entityId of entityIds) {
    const entity = entities.find((candidate) => candidate.id === entityId)
    expect(entity, `source entity ${entityId}`).toBeDefined()
    const rendered = layer.group.children.find((child) => child.name === entityId)
    expect(rendered, `rendered entity ${entityId}`).toBeInstanceOf(THREE.Line)
    const material = (rendered as THREE.Line).material as THREE.LineBasicMaterial
    const expected = entity!.construction
      ? new THREE.Color(SKETCH_COLORS.reference)
        .lerp(new THREE.Color(SKETCH_COLORS.background), 0.45)
        .getHex()
      : SKETCH_COLORS.reference
    expect(material.color.getHex()).toBe(expected)
  }
  layer.dispose()
}

function expectDetachedProjectedFix(
  constraints: SketchConstraint[],
  entityId: string,
): void {
  expect(constraints).not.toContainEqual(expect.objectContaining({
    kind: 'fix',
    entityId,
  }))
}

describe('WO-058 projected geometry remains editable', () => {
  it('toggles construction without losing projected provenance or color', () => {
    const projected = line('P', [0, 0], [10, 0], true)
    const entities = toggleConstructionFlags([projected], ['P'])!

    expect(entities[0].construction).toBe(true)
    expect(entities[0].provenance).toBe('projected')
    expectProjectedColor(entities, ['P'])
  })

  it('trims a projected line, detaches its projection fix, and colors every kept piece', () => {
    const projected = line('P', [0, 0], [10, 0], true)
    const source = doc([
      projected,
      line('left-cutter', [3, -5], [3, 5]),
      line('right-cutter', [7, -5], [7, 5]),
    ], [fixed('P')])

    const outcome = trimAtPoint(source, { x: 5, y: 0 }, 0.25, ids('trim'))
    expect(outcome.transform).not.toBeNull()
    const transform = outcome.transform!
    const pieces = transform.entities.filter((entity) =>
      entity.id === 'P' || entity.id.startsWith('trim-'))
    expect(pieces).toHaveLength(2)
    expect(pieces.every((entity) => entity.provenance === 'projected')).toBe(true)
    expectDetachedProjectedFix(transform.constraints, 'P')
    expectProjectedColor(transform.entities, pieces.map((entity) => entity.id))
  })

  it('preserves provenance when trim changes projected circle and ellipse entity kinds', () => {
    const cutter = line('cutter', [0, -10], [0, 10])
    const sources: SketchEntity[] = [
      {
        id: 'circle',
        kind: 'circle',
        construction: false,
        provenance: 'projected',
        center: { x: 0, y: 0 },
        radius: 5,
      },
      {
        id: 'ellipse',
        kind: 'ellipse',
        construction: false,
        provenance: 'projected',
        center: { x: 0, y: 0 },
        majorRadius: 5,
        minorRadius: 3,
        rotation: 0,
      },
    ]

    for (const source of sources) {
      const outcome = trimAtPoint(
        doc([source, cutter], [fixed(source.id)]),
        { x: 5, y: 0 },
        0.25,
        ids(`trim-${source.id}`),
      )
      expect(outcome.transform, source.id).not.toBeNull()
      const transform = outcome.transform!
      const results = transform.entities.filter((entity) => entity.provenance === 'projected')
      expect(results.length).toBeGreaterThan(0)
      expect(results.every((entity) => entity.provenance === 'projected')).toBe(true)
      expectDetachedProjectedFix(transform.constraints, source.id)
      expectProjectedColor(transform.entities, results.map((entity) => entity.id))
    }
  })

  it('extends a projected line as a detached static copy and keeps its color', () => {
    const projected = line('P', [0, 0], [5, 0], true)
    const source = doc([
      projected,
      line('boundary', [10, -5], [10, 5]),
    ], [fixed('P')])
    const newId = ids('extend')

    const picked = extendClick(null, source, { x: 2, y: 0 }, 0.25, newId)
    const outcome = extendClick(picked.chain, source, { x: 8, y: 0 }, 0.25, newId)
    expect(outcome.transform).not.toBeNull()
    const transform = outcome.transform!
    const edited = transform.entities.find((entity) => entity.id === 'P') as SketchLineEntity
    expect(edited.end).toEqual({ x: 10, y: 0 })
    expect(edited.provenance).toBe('projected')
    expectDetachedProjectedFix(transform.constraints, 'P')
    expectProjectedColor(transform.entities, ['P'])
  })

  it('migrates a legacy unmarked projection Fix when trimming after reload', () => {
    const projected = { ...line('P', [0, 0], [10, 0], true), construction: true }
    const source = reloaded(doc([
      projected,
      line('left-cutter', [3, -5], [3, 5]),
      line('right-cutter', [7, -5], [7, 5]),
    ], [legacyFixed('P')]))

    const outcome = trimAtPoint(source, { x: 5, y: 0 }, 0.25, ids('legacy-trim'))
    expect(outcome.transform).not.toBeNull()
    const transform = outcome.transform!
    const pieces = transform.entities.filter((entity) =>
      entity.id === 'P' || entity.id.startsWith('legacy-trim-'))
    expect(pieces).toHaveLength(2)
    expect(pieces.every((entity) =>
      entity.provenance === 'projected'
      && entity.construction
      && entity.projectionDetached === true)).toBe(true)
    expectDetachedProjectedFix(transform.constraints, 'P')
    expectProjectedColor(transform.entities, pieces.map((entity) => entity.id))
  })

  it('migrates a legacy unmarked projection Fix when extending after reload', () => {
    const projected = { ...line('P', [0, 0], [5, 0], true), construction: true }
    const source = reloaded(doc([
      projected,
      line('boundary', [10, -5], [10, 5]),
    ], [legacyFixed('P')]))
    const newId = ids('legacy-extend')

    const picked = extendClick(null, source, { x: 2, y: 0 }, 0.25, newId)
    const outcome = extendClick(picked.chain, source, { x: 8, y: 0 }, 0.25, newId)
    expect(outcome.transform).not.toBeNull()
    const transform = outcome.transform!
    const edited = transform.entities.find((entity) => entity.id === 'P')!
    expect(edited).toMatchObject({
      provenance: 'projected',
      construction: true,
      projectionDetached: true,
    })
    expectDetachedProjectedFix(transform.constraints, 'P')
    expectProjectedColor(transform.entities, ['P'])
  })

  it('migrates a legacy unmarked projection Fix when filleting after reload', () => {
    const projected = { ...line('P', [0, 0], [10, 0], true), construction: true }
    const native = { ...line('N', [10, 0], [10, 10]), construction: true }
    const source = reloaded(doc([projected, native], [legacyFixed('P')]))

    const outcome = filletLines(
      source, 'P', 'N', { x: 0, y: 0 }, { x: 10, y: 10 }, 2, ids('legacy-fillet'),
    )
    if (typeof outcome === 'string') throw new Error(outcome)
    const projectedResults = outcome.transform.entities.filter((entity) =>
      entity.id === 'P' || entity.id === outcome.arcId)
    expect(projectedResults.every((entity) =>
      entity.provenance === 'projected'
      && entity.construction
      && entity.projectionDetached === true)).toBe(true)
    expectDetachedProjectedFix(outcome.transform.constraints, 'P')
    expectProjectedColor(outcome.transform.entities, projectedResults.map((entity) => entity.id))
  })

  it('migrates a legacy unmarked projection Fix when chamfering after reload', () => {
    const projected = { ...line('P', [0, 0], [10, 0], true), construction: true }
    const native = { ...line('N', [10, 0], [10, 10]), construction: true }
    const source = reloaded(doc([projected, native], [legacyFixed('P')]))

    const outcome = chamferLines(
      source, 'P', 'N', { x: 0, y: 0 }, { x: 10, y: 10 }, 2, ids('legacy-chamfer'),
    )
    if (typeof outcome === 'string') throw new Error(outcome)
    const projectedResults = outcome.transform.entities.filter((entity) =>
      entity.id === 'P' || entity.id === outcome.lineId)
    expect(projectedResults.every((entity) =>
      entity.provenance === 'projected'
      && entity.construction
      && entity.projectionDetached === true)).toBe(true)
    expectDetachedProjectedFix(outcome.transform.constraints, 'P')
    expectProjectedColor(outcome.transform.entities, projectedResults.map((entity) => entity.id))
  })

  it('preserves a user-authored Fix when detached projected geometry is edited again', () => {
    const projected = line('P', [0, 0], [5, 0], true)
    const source = doc([
      projected,
      line('first-boundary', [10, -5], [10, 5]),
      line('second-boundary', [15, -5], [15, 5]),
    ], [fixed('P')])
    const newId = ids('repeat-extend')

    const firstPick = extendClick(null, source, { x: 2, y: 0 }, 0.25, newId)
    const firstEdit = extendClick(firstPick.chain, source, { x: 8, y: 0 }, 0.25, newId)
    expect(firstEdit.transform).not.toBeNull()
    const detached = firstEdit.transform!
    expectDetachedProjectedFix(detached.constraints, 'P')

    const userFix: SketchConstraint = { id: 'user-fix-P', kind: 'fix', entityId: 'P' }
    const refixed = doc(detached.entities, [...detached.constraints, userFix])
    const secondPick = extendClick(null, refixed, { x: 5, y: 0 }, 0.25, newId)
    const secondEdit = extendClick(secondPick.chain, refixed, { x: 12, y: 0 }, 0.25, newId)
    expect(secondEdit.transform).not.toBeNull()
    const editedAgain = secondEdit.transform!

    expect((editedAgain.entities.find((entity) => entity.id === 'P') as SketchLineEntity).end)
      .toEqual({ x: 15, y: 0 })
    expect(editedAgain.constraints).toContainEqual(userFix)
    expect(editedAgain.entities.find((entity) => entity.id === 'P')?.projectionDetached).toBe(true)
  })

  it('preserves a persisted user Fix through trim, fillet, and chamfer edits', () => {
    const userFix: SketchConstraint = { id: 'user-fix-P', kind: 'fix', entityId: 'P' }
    const detached = (): SketchLineEntity => ({
      ...line('P', [0, 0], [10, 0], true),
      projectionDetached: true,
    })

    const trimSource = reloaded(doc([
      detached(),
      line('left-cutter', [3, -5], [3, 5]),
      line('right-cutter', [7, -5], [7, 5]),
    ], [userFix]))
    const trim = trimAtPoint(trimSource, { x: 5, y: 0 }, 0.25, ids('refix-trim'))
    expect(trim.transform).not.toBeNull()
    expect(trim.transform!.constraints).toContainEqual(userFix)

    for (const edit of ['fillet', 'chamfer'] as const) {
      const source = reloaded(doc([
        detached(),
        line('N', [10, 0], [10, 10]),
      ], [userFix]))
      const outcome = edit === 'fillet'
        ? filletLines(
            source, 'P', 'N', { x: 0, y: 0 }, { x: 10, y: 10 }, 2, ids('refix-fillet'),
          )
        : chamferLines(
            source, 'P', 'N', { x: 0, y: 0 }, { x: 10, y: 10 }, 2, ids('refix-chamfer'),
          )
      if (typeof outcome === 'string') throw new Error(outcome)
      expect(outcome.transform.constraints, edit).toContainEqual(userFix)
    }
  })

  it('fillets a projected line with a native line and keeps the derived arc projected', () => {
    const projected = line('P', [0, 0], [10, 0], true)
    const native = line('N', [10, 0], [10, 10])
    const source = doc([projected, native], [
      fixed('P'),
      {
        id: 'corner',
        kind: 'coincident',
        a: { entityId: 'P', site: 'end' },
        b: { entityId: 'N', site: 'start' },
      },
    ])

    const outcome = filletLines(
      source,
      'P',
      'N',
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      2,
      ids('fillet'),
    )
    if (typeof outcome === 'string') throw new Error(outcome)
    const transform = outcome.transform
    const projectedResultIds = ['P', outcome.arcId]
    expect(transform.entities.find((entity) => entity.id === 'P')?.provenance).toBe('projected')
    expect(transform.entities.find((entity) => entity.id === 'N')?.provenance).toBeUndefined()
    expect(transform.entities.find((entity) => entity.id === outcome.arcId)?.provenance)
      .toBe('projected')
    expectDetachedProjectedFix(transform.constraints, 'P')
    expectProjectedColor(transform.entities, projectedResultIds)
  })

  it('applies the same detach-and-preserve rule to chamfer', () => {
    const projected = line('P', [0, 0], [10, 0], true)
    const native = line('N', [10, 0], [10, 10])
    const source = doc([projected, native], [fixed('P')])

    const outcome = chamferLines(
      source,
      'P',
      'N',
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      2,
      ids('chamfer'),
    )
    if (typeof outcome === 'string') throw new Error(outcome)
    const transform = outcome.transform
    expect(transform.entities.find((entity) => entity.id === outcome.lineId)?.provenance)
      .toBe('projected')
    expectDetachedProjectedFix(transform.constraints, 'P')
    expectProjectedColor(transform.entities, ['P', outcome.lineId])
  })
})
