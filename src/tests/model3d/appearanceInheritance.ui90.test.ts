import { describe, expect, it } from 'vitest'
import { FeatureDag } from '../../doc'
import { AppearanceStore, inheritBodyAppearanceAtPublication } from '../../components/model3d/appearance'

function addBody(
  dag: FeatureDag,
  id: string,
  opType: string,
  consumes: string[] = [],
  payload: Record<string, unknown> = {},
): void {
  dag.insertNode({ id, kind: 'feature', consumes, payload: { opType, name: `${opType} ${id}`, ...payload } })
}

function publishAppearance(store: AppearanceStore, dag: FeatureDag, id: string): string | undefined {
  const result = dag.getNode(id)
  if (result === undefined) throw new Error(`missing result '${id}'`)
  return inheritBodyAppearanceAtPublication(store, dag, result)
}

describe('UI-90 body appearance result-publication inheritance', () => {
  it('carries one assigned body appearance through Extrude, Boolean, Fillet, Shell, Draft, and Hole', () => {
    const dag = new FeatureDag()
    addBody(dag, 'BASE', 'extrude')
    addBody(dag, 'TOOL', 'revolve')
    addBody(dag, 'EXTRUDE-ADD', 'extrude', ['BASE'], { targetFeatureId: 'BASE' })
    addBody(dag, 'BOOLEAN', 'boolean', ['EXTRUDE-ADD', 'TOOL'], { targetFeatureId: 'EXTRUDE-ADD' })
    addBody(dag, 'FILLET', 'fillet', ['BOOLEAN'])
    addBody(dag, 'SHELL', 'shell', ['FILLET'])
    addBody(dag, 'DRAFT', 'draft', ['SHELL'])
    addBody(dag, 'HOLE', 'hole', ['DRAFT'])

    const store = new AppearanceStore()
    const assigned = [0.15, 0.45, 0.85] as const
    store.setBodyColor('BASE', assigned)
    store.setBodyColor('TOOL', [0.9, 0.1, 0.1])

    expect(publishAppearance(store, dag, 'BASE')).toBeUndefined()
    expect(publishAppearance(store, dag, 'EXTRUDE-ADD')).toBe('BASE')
    expect(publishAppearance(store, dag, 'BOOLEAN')).toBe('EXTRUDE-ADD')
    expect(publishAppearance(store, dag, 'FILLET')).toBe('BOOLEAN')
    expect(publishAppearance(store, dag, 'SHELL')).toBe('FILLET')
    expect(publishAppearance(store, dag, 'DRAFT')).toBe('SHELL')
    expect(publishAppearance(store, dag, 'HOLE')).toBe('DRAFT')

    for (const id of ['EXTRUDE-ADD', 'BOOLEAN', 'FILLET', 'SHELL', 'DRAFT', 'HOLE']) {
      expect(store.bodyColor(id)).toEqual(assigned)
    }
  })

  it('keeps an explicitly changed result appearance through edit/regenerate publication', () => {
    const dag = new FeatureDag()
    addBody(dag, 'BASE', 'extrude')
    addBody(dag, 'FILLET', 'fillet', ['BASE'])
    const store = new AppearanceStore()
    store.setBodyColor('BASE', [0.15, 0.45, 0.85])

    expect(publishAppearance(store, dag, 'FILLET')).toBe('BASE')
    const userOverride = [0.75, 0.2, 0.6] as const
    store.setBodyColor('FILLET', userOverride)
    store.setBodyColor('BASE', [0.1, 0.8, 0.3])

    expect(publishAppearance(store, dag, 'FILLET')).toBeUndefined()
    expect(store.bodyColor('FILLET')).toEqual(userOverride)
  })
})
