import { describe, expect, it } from 'vitest'
import { projectFaceBoundaryToSketch, replaceProjectedConstraints, replaceProjectedEntities } from '../../sketch3d/planeSketch'
import type { PlaneFrame } from '../../sketch3d/planeMath'
import type { Sketch3dConstraint, Sketch3dEntity } from '../../sketch3d/types'

describe('projectFaceBoundaryToSketch', () => {
  const frame: PlaneFrame = { origin: { x: 0, y: 0, z: 10 }, normal: { x: 0, y: 0, z: 1 }, xDir: { x: 1, y: 0, z: 0 } }

  it('projects a world-space square loop into 4 local fixed line entities forming a closed rectangle', () => {
    const worldLoop = [
      { x: -20, y: -10, z: 10 },
      { x: 20, y: -10, z: 10 },
      { x: 20, y: 10, z: 10 },
      { x: -20, y: 10, z: 10 },
    ]
    const { entities, externalRef } = projectFaceBoundaryToSketch(frame, worldLoop, { sketchId: 'SK1', sourceFaceId: 'F1:BOX:zmax' })
    expect(entities.length).toBe(4)
    expect(externalRef).toEqual({ sourceFaceId: 'F1:BOX:zmax', entityIds: entities.map((e) => e.id) })
    expect(entities[0].start).toEqual({ x: -20, y: -10 })
    expect(entities[0].end).toEqual({ x: 20, y: -10 })
    // Closed: last segment's end returns to the first segment's start.
    expect(entities[3].end).toEqual(entities[0].start)
  })

  it('AC #7: every projected line gets its own whole-entity fixed constraint', () => {
    const worldLoop = [
      { x: -20, y: -10, z: 10 },
      { x: 20, y: -10, z: 10 },
      { x: 20, y: 10, z: 10 },
      { x: -20, y: 10, z: 10 },
    ]
    const { entities, constraints } = projectFaceBoundaryToSketch(frame, worldLoop, { sketchId: 'SK1', sourceFaceId: 'F1:BOX:zmax' })
    expect(constraints.length).toBe(entities.length)
    for (const entity of entities) {
      expect(constraints.some((c) => c.kind === 'fixed' && c.entityId === entity.id)).toBe(true)
    }
  })

  it('replaceProjectedEntities drops the prior projection\'s entities but keeps user-drawn ones', () => {
    const priorLoop = [
      { x: 0, y: 0, z: 10 },
      { x: 10, y: 0, z: 10 },
      { x: 10, y: 10, z: 10 },
      { x: 0, y: 10, z: 10 },
    ]
    // A different face's boundary (reattach target) -- same sketchId/prefix
    // so ids collide with the prior projection's, exactly as a real reattach
    // would produce (see this function's own doc comment): the id namespace
    // is keyed by sketchId, not source face, so "replace" means "same ids,
    // new coordinates", not "new ids alongside old ones".
    const freshLoop = [
      { x: 100, y: 0, z: 10 },
      { x: 110, y: 0, z: 10 },
      { x: 110, y: 10, z: 10 },
      { x: 100, y: 10, z: 10 },
    ]
    const priorProjection = projectFaceBoundaryToSketch(frame, priorLoop, { sketchId: 'SK1', sourceFaceId: 'F1:BOX:xmax' })
    const userDrawn: Sketch3dEntity = { id: 'SK1.line1', kind: 'line', start: { x: 1, y: 1 }, end: { x: 2, y: 2 } }
    const existing: Sketch3dEntity[] = [...priorProjection.entities, userDrawn]

    const freshProjection = projectFaceBoundaryToSketch(frame, freshLoop, { sketchId: 'SK1', sourceFaceId: 'F1:BOX:zmax' })
    const merged = replaceProjectedEntities(existing, [priorProjection.externalRef], freshProjection)

    expect(merged).toContainEqual(userDrawn)
    expect(merged.length).toBe(freshProjection.entities.length + 1)
    // The ids are the SAME (sketchId-keyed namespace), but coordinates now
    // reflect the FRESH loop, not the prior one -- proves the stale entries
    // were actually replaced, not merely left in place under the same id.
    expect(merged).toEqual(expect.arrayContaining(freshProjection.entities))
    expect(merged.find((e) => e.id === 'SK1.ext0')).toEqual(freshProjection.entities[0])

    const userConstraint: Sketch3dConstraint = { id: 'c-user', kind: 'horizontal', line: 'SK1.line1' }
    const existingConstraints: Sketch3dConstraint[] = [...priorProjection.constraints, userConstraint]
    const mergedConstraints = replaceProjectedConstraints(existingConstraints, [priorProjection.externalRef], freshProjection)
    expect(mergedConstraints).toContainEqual(userConstraint)
    expect(mergedConstraints.length).toBe(freshProjection.constraints.length + 1)
    expect(mergedConstraints).toEqual(expect.arrayContaining(freshProjection.constraints))
  })
})
