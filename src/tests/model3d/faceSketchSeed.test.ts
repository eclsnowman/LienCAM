import { describe, expect, it } from 'vitest'
import { projectedBoundaryToCamSeed } from '../../components/model3d/workbench/faceSketchSeed'
import type { Sketch3dConstraint, Sketch3dEntity } from '../../sketch3d'

describe('projectedBoundaryToCamSeed legacy compatibility converter', () => {
  it('maps projected lines and fixed constraints to real fixed CAM geometry', () => {
    const result = projectedBoundaryToCamSeed(
      [{ id: 'SK2.ext0', kind: 'line', start: { x: 1, y: 2 }, end: { x: 3, y: 4 } }],
      [{ id: 'SK2.ext0.fix', kind: 'fixed', entityId: 'SK2.ext0' }],
    )

    expect(result).toEqual({
      ok: true,
      seed: {
        entities: [{
          id: 'SK2.ext0',
          kind: 'line',
          construction: false,
          start: { x: 1, y: 2 },
          end: { x: 3, y: 4 },
        }],
        constraints: [{ id: 'SK2.ext0.fix', kind: 'fix', entityId: 'SK2.ext0' }],
      },
    })
  })

  it('refuses a non-finite projected coordinate by entity id', () => {
    const result = projectedBoundaryToCamSeed(
      [{ id: 'SK2.ext0', kind: 'line', start: { x: Number.NaN, y: 0 }, end: { x: 1, y: 0 } }],
      [],
    )
    expect(result).toMatchObject({
      ok: false,
      refusal: { code: 'non-finite-coordinate', id: 'SK2.ext0' },
    })
  })

  it('refuses an unsupported projected entity instead of dropping it', () => {
    const unsupported = {
      id: 'SK2.ext0',
      kind: 'future-curve',
    } as unknown as Sketch3dEntity
    const result = projectedBoundaryToCamSeed([unsupported], [])
    expect(result).toMatchObject({
      ok: false,
      refusal: { code: 'unsupported-projected-entity', id: 'SK2.ext0' },
    })
  })

  it('refuses an unsupported projected constraint instead of dropping it', () => {
    const unsupported = {
      id: 'SK2.ext0.future',
      kind: 'future-constraint',
      entityId: 'SK2.ext0',
    } as unknown as Sketch3dConstraint
    const result = projectedBoundaryToCamSeed([], [unsupported])
    expect(result).toMatchObject({
      ok: false,
      refusal: { code: 'unsupported-projected-constraint', id: 'SK2.ext0.future' },
    })
  })
})
