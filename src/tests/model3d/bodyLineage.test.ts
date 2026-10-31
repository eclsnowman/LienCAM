import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { FeatureDag } from '../../doc'
import {
  WORKBENCH_BODY_OP_TYPES,
  projectBodyLineages,
  resolveBodyTargetLineage,
} from '../../components/model3d/bodyLineage'

const WORKBENCH_SOURCE = new URL('../../components/model3d/SolidsWorkbenchPage.tsx', import.meta.url)

function executorOpTypes(source: string): string[] {
  const start = source.indexOf('const opType = payload.opType')
  const end = source.indexOf('const unhandledOpType: never = opType', start)
  expect(start, 'executor opType declaration moved or disappeared').toBeGreaterThanOrEqual(0)
  expect(end, 'executor exhaustive tail moved or disappeared').toBeGreaterThan(start)
  return [...source.slice(start, end).matchAll(/if \(opType === '([^']+)'\)/g)].map((match) => match[1])
}

function addSketch(dag: FeatureDag, id: string): void {
  dag.insertNode({ id, kind: 'sketch', payload: {} })
}

function addFeature(dag: FeatureDag, id: string, opType: string, consumes: string[]): void {
  const payload: Record<string, unknown> = { opType, name: `${opType} ${id}` }
  if (opType === 'extrude' && consumes.length > 0) {
    payload.boolMode = 'add'
    payload.targetFeatureId = consumes[0]
  } else if (opType === 'bodyTransform' && consumes.length > 0) {
    payload.sourceBodyId = consumes[0]
  } else if (opType === 'boolean' && consumes.length > 0) {
    payload.boolOp = 'fuse'
    payload.targetFeatureId = consumes[0]
    payload.toolFeatureId = consumes[1]
  }
  dag.insertNode({ id, kind: 'feature', consumes, payload })
}

describe('WO UI-28 body-lineage projection', () => {
  const sourceTypes = executorOpTypes(readFileSync(WORKBENCH_SOURCE, 'utf8'))

  it('derives the complete opType census from the executor and matches the runtime type source', () => {
    expect(sourceTypes.length, 'a zero/small result means the source slice or regex became vacuous').toBeGreaterThan(5)
    expect(new Set(sourceTypes).size, 'executor opType branches must be unique').toBe(sourceTypes.length)
    expect(sourceTypes).toEqual([...WORKBENCH_BODY_OP_TYPES])
  })

  it.each(WORKBENCH_BODY_OP_TYPES)('%s follows DAG structure: create adds a lineage, modify retains one', (opType) => {
    const createDag = new FeatureDag()
    addSketch(createDag, 'SK-A')
    addSketch(createDag, 'SK-B')
    addFeature(createDag, 'ROOT', 'extrude', ['SK-A'])
    addFeature(createDag, 'NEW', opType, ['SK-B'])
    expect(projectBodyLineages(createDag, ['ROOT', 'NEW'], ['ROOT', 'NEW'])).toEqual([
      { bodyId: 'ROOT', lineageId: 'ROOT' },
      { bodyId: 'NEW', lineageId: 'NEW' },
    ])

    const modifyDag = new FeatureDag()
    addSketch(modifyDag, 'SK-A')
    addFeature(modifyDag, 'ROOT', 'extrude', ['SK-A'])
    addFeature(modifyDag, 'LEAF', opType, ['ROOT'])
    expect(projectBodyLineages(modifyDag, ['ROOT', 'LEAF'], ['LEAF'])).toEqual([
      { bodyId: 'LEAF', lineageId: 'ROOT' },
    ])
  })

  it('WO-3244: a Mirror (replace original) carries its source identity; its plane carries none', () => {
    const dag = new FeatureDag()
    addSketch(dag, 'SK-A')
    addSketch(dag, 'SK-B')
    addFeature(dag, 'ROOT', 'extrude', ['SK-A'])
    addFeature(dag, 'OTHER', 'extrude', ['SK-B'])
    dag.insertNode({ id: 'PLANE', kind: 'datum', consumes: [], payload: { datumType: 'plane' } })
    dag.insertNode({
      id: 'MIRROR',
      kind: 'feature',
      consumes: ['ROOT', 'PLANE'],
      payload: { opType: 'bodyTransform', version: 1, sourceBodyId: 'ROOT', transform: { kind: 'mirror', planeNodeId: 'PLANE' }, result: 'replace', name: 'Mirror' },
    })
    const bodies = ['ROOT', 'OTHER', 'MIRROR']
    expect(projectBodyLineages(dag, bodies, ['OTHER', 'MIRROR'])).toEqual([
      { bodyId: 'OTHER', lineageId: 'OTHER' },
      { bodyId: 'MIRROR', lineageId: 'ROOT' },
    ])
    // a persisted reference to the source follows its material to the mirror
    expect(resolveBodyTargetLineage(dag, bodies, ['OTHER', 'MIRROR'], 'ROOT')).toEqual({ ok: true, bodyId: 'MIRROR' })
    // a payload naming another body as its source carries no material from ROOT
    dag.setPayload('MIRROR', { ...dag.getNode('MIRROR')!.payload, sourceBodyId: 'OTHER' })
    expect(resolveBodyTargetLineage(dag, bodies, ['OTHER', 'MIRROR'], 'ROOT')).toEqual({ ok: false, reason: 'lost', candidates: [] })
  })

  it('keeps two independently modified bodies as two rows addressing their own leaves', () => {
    const dag = new FeatureDag()
    addSketch(dag, 'SK-A')
    addSketch(dag, 'SK-B')
    addFeature(dag, 'BODY-A', 'extrude', ['SK-A'])
    addFeature(dag, 'BODY-B', 'revolve', ['SK-B'])
    addFeature(dag, 'LEAF-A', 'fillet', ['BODY-A'])
    addFeature(dag, 'LEAF-B', 'chamfer', ['BODY-B'])

    expect(projectBodyLineages(dag, ['BODY-A', 'BODY-B', 'LEAF-A', 'LEAF-B'], ['LEAF-A', 'LEAF-B'])).toEqual([
      { bodyId: 'LEAF-A', lineageId: 'BODY-A' },
      { bodyId: 'LEAF-B', lineageId: 'BODY-B' },
    ])
  })

  it('uses the Boolean target lineage as identity while the Boolean result stays the live leaf', () => {
    const dag = new FeatureDag()
    addSketch(dag, 'SK-A')
    addSketch(dag, 'SK-B')
    addFeature(dag, 'TARGET', 'extrude', ['SK-A'])
    addFeature(dag, 'TOOL', 'revolve', ['SK-B'])
    dag.insertNode({
      id: 'BOOLEAN-LEAF',
      kind: 'feature',
      consumes: ['TARGET', 'TOOL'],
      payload: { opType: 'boolean', boolOp: 'fuse', targetFeatureId: 'TARGET', toolFeatureId: 'TOOL', name: 'Boolean BOOLEAN-LEAF' },
    })

    expect(projectBodyLineages(dag, ['TARGET', 'TOOL', 'BOOLEAN-LEAF'], ['BOOLEAN-LEAF'])).toEqual([
      { bodyId: 'BOOLEAN-LEAF', lineageId: 'TARGET' },
    ])
  })

  it('keeps Boolean target identity after serialize/restore sorts consumes', () => {
    const dag = new FeatureDag()
    addSketch(dag, 'SK-A')
    addSketch(dag, 'SK-Z')
    addFeature(dag, 'A-TOOL', 'revolve', ['SK-A'])
    addFeature(dag, 'Z-TARGET', 'extrude', ['SK-Z'])
    dag.insertNode({
      id: 'BOOLEAN-LEAF',
      kind: 'feature',
      consumes: ['Z-TARGET', 'A-TOOL'],
      payload: { opType: 'boolean', boolOp: 'fuse', targetFeatureId: 'Z-TARGET', toolFeatureId: 'A-TOOL', name: 'Boolean BOOLEAN-LEAF' },
    })

    const restored = FeatureDag.restore(dag.serialize())
    expect(restored.getNode('BOOLEAN-LEAF')?.consumes).toEqual(['A-TOOL', 'Z-TARGET'])
    expect(projectBodyLineages(restored, ['A-TOOL', 'Z-TARGET', 'BOOLEAN-LEAF'], ['BOOLEAN-LEAF'])).toEqual([
      { bodyId: 'BOOLEAN-LEAF', lineageId: 'Z-TARGET' },
    ])
  })

  it('keeps the first persisted Extrude target as carrier while an end-reference parent remains declared', () => {
    const dag = new FeatureDag()
    addSketch(dag, 'SK-A')
    addSketch(dag, 'SK-END')
    addSketch(dag, 'SK-Z')
    addFeature(dag, 'A-SECONDARY', 'extrude', ['SK-A'])
    addFeature(dag, 'END-REFERENCE', 'extrude', ['SK-END'])
    addFeature(dag, 'Z-CARRIER', 'revolve', ['SK-Z'])
    dag.insertNode({
      id: 'EXTRUDE-LEAF',
      kind: 'feature',
      consumes: ['Z-CARRIER', 'A-SECONDARY', 'END-REFERENCE'],
      payload: {
        opType: 'extrude',
        boolMode: 'remove',
        targetFeatureIds: ['Z-CARRIER', 'A-SECONDARY'],
        endCondition: 'toPart',
        endTarget: { modelItemId: 'MODEL-1', bodyFeatureId: 'END-REFERENCE' },
      },
    })

    const restored = FeatureDag.restore(dag.serialize())
    expect(restored.getNode('EXTRUDE-LEAF')?.consumes).toEqual(['A-SECONDARY', 'END-REFERENCE', 'Z-CARRIER'])
    expect(projectBodyLineages(
      restored,
      ['A-SECONDARY', 'END-REFERENCE', 'Z-CARRIER', 'EXTRUDE-LEAF'],
      ['EXTRUDE-LEAF'],
    ))
      .toEqual([{ bodyId: 'EXTRUDE-LEAF', lineageId: 'Z-CARRIER' }])
  })

  it('isolates an Extrude with a malformed carrier set instead of throwing or guessing', () => {
    const dag = new FeatureDag()
    addSketch(dag, 'SK-A')
    addSketch(dag, 'SK-B')
    addFeature(dag, 'BODY-A', 'extrude', ['SK-A'])
    addFeature(dag, 'BODY-B', 'revolve', ['SK-B'])
    dag.insertNode({
      id: 'BROKEN',
      kind: 'feature',
      consumes: ['BODY-A', 'BODY-B'],
      payload: { opType: 'extrude', boolMode: 'remove', targetFeatureIds: ['BODY-A', 'GHOST'] },
    })

    expect(projectBodyLineages(dag, ['BODY-A', 'BODY-B', 'BROKEN'], ['BROKEN']))
      .toEqual([{ bodyId: 'BROKEN', lineageId: 'BROKEN' }])
  })

  it('follows carrier and non-carrier parents forward to one live merge result', () => {
    const dag = new FeatureDag()
    addSketch(dag, 'SK-A')
    addSketch(dag, 'SK-B')
    addFeature(dag, 'BODY-A', 'extrude', ['SK-A'])
    addFeature(dag, 'BODY-B', 'extrude', ['SK-B'])
    dag.insertNode({
      id: 'MERGED',
      kind: 'feature',
      consumes: ['BODY-A', 'BODY-B'],
      payload: { opType: 'boolean', boolOp: 'fuse', targetFeatureId: 'BODY-A', toolFeatureId: 'BODY-B' },
    })
    const census = ['BODY-A', 'BODY-B', 'MERGED']

    expect(resolveBodyTargetLineage(dag, census, ['MERGED'], 'BODY-A')).toEqual({ ok: true, bodyId: 'MERGED' })
    expect(resolveBodyTargetLineage(dag, census, ['MERGED'], 'BODY-B')).toEqual({ ok: true, bodyId: 'MERGED' })
  })

  it('stops forward target resolution at non-body consumers', () => {
    const dag = new FeatureDag()
    addSketch(dag, 'SK-A')
    addSketch(dag, 'SK-B')
    addFeature(dag, 'BODY-A', 'extrude', ['SK-A'])
    addFeature(dag, 'BODY-B', 'extrude', ['SK-B'])
    dag.insertNode({ id: 'DATUM-A', kind: 'datum', consumes: ['BODY-A'], payload: {} })
    dag.insertNode({ id: 'SK-NEW', kind: 'sketch', consumes: ['DATUM-A'], payload: {} })
    addFeature(dag, 'NEW-BODY', 'extrude', ['SK-NEW'])
    dag.insertNode({
      id: 'MERGED',
      kind: 'feature',
      consumes: ['BODY-A', 'BODY-B'],
      payload: { opType: 'boolean', boolOp: 'fuse', targetFeatureId: 'BODY-A', toolFeatureId: 'BODY-B' },
    })
    const census = ['BODY-A', 'BODY-B', 'NEW-BODY', 'MERGED']

    expect(resolveBodyTargetLineage(dag, census, ['MERGED', 'NEW-BODY'], 'BODY-A'))
      .toEqual({ ok: true, bodyId: 'MERGED' })
    expect(resolveBodyTargetLineage(dag, census, ['NEW-BODY'], 'BODY-A'))
      .toEqual({ ok: false, reason: 'lost', candidates: [] })
  })

  it('distinguishes a lost target from two equally plausible live descendants', () => {
    const dag = new FeatureDag()
    addSketch(dag, 'SK-A')
    addFeature(dag, 'ROOT', 'extrude', ['SK-A'])
    addFeature(dag, 'LEFT', 'fillet', ['ROOT'])
    addFeature(dag, 'RIGHT', 'chamfer', ['ROOT'])
    const census = ['ROOT', 'LEFT', 'RIGHT']

    expect(resolveBodyTargetLineage(dag, census, [], 'ROOT')).toEqual({ ok: false, reason: 'lost', candidates: [] })
    expect(resolveBodyTargetLineage(dag, census, ['LEFT', 'RIGHT'], 'ROOT')).toEqual({
      ok: false,
      reason: 'ambiguous',
      candidates: ['LEFT', 'RIGHT'],
    })
  })

  it('classifies Boolean target and tool material edges for fuse, cut, and intersect', () => {
    const expected = {
      fuse: { target: true, tool: true },
      cut: { target: true, tool: false },
      intersect: { target: true, tool: true },
      futureBoolean: { target: false, tool: false },
    } as const

    for (const [boolOp, carries] of Object.entries(expected)) {
      const dag = new FeatureDag()
      addSketch(dag, 'SK-TARGET')
      addSketch(dag, 'SK-TOOL')
      addFeature(dag, 'TARGET', 'extrude', ['SK-TARGET'])
      addFeature(dag, 'TOOL', 'extrude', ['SK-TOOL'])
      dag.insertNode({
        id: 'RESULT',
        kind: 'feature',
        consumes: ['TARGET', 'TOOL'],
        payload: { opType: 'boolean', boolOp, targetFeatureId: 'TARGET', toolFeatureId: 'TOOL' },
      })
      const census = ['TARGET', 'TOOL', 'RESULT']
      expect(resolveBodyTargetLineage(dag, census, ['RESULT'], 'TARGET').ok, `${boolOp} target`).toBe(carries.target)
      expect(resolveBodyTargetLineage(dag, census, ['RESULT'], 'TOOL').ok, `${boolOp} tool`).toBe(carries.tool)
    }
  })

  it('fails closed for reference-only Extrude edges and unrecognized body operations', () => {
    const dag = new FeatureDag()
    addSketch(dag, 'SK-ROOT')
    addFeature(dag, 'ROOT', 'extrude', ['SK-ROOT'])
    dag.insertNode({
      id: 'MEASURED',
      kind: 'feature',
      consumes: ['ROOT'],
      payload: {
        opType: 'extrude',
        boolMode: 'newBody',
        endCondition: 'toPart',
        endTarget: { modelItemId: 'MODEL-1', bodyFeatureId: 'ROOT' },
      },
    })
    dag.insertNode({ id: 'FUTURE', kind: 'feature', consumes: ['ROOT'], payload: { opType: 'futureBodyOp' } })
    const census = ['ROOT', 'MEASURED', 'FUTURE']

    expect(resolveBodyTargetLineage(dag, census, ['MEASURED'], 'ROOT'))
      .toEqual({ ok: false, reason: 'lost', candidates: [] })
    expect(resolveBodyTargetLineage(dag, census, ['FUTURE'], 'ROOT'))
      .toEqual({ ok: false, reason: 'lost', candidates: [] })
  })

  it('isolates ambiguous multi-body ancestry without a validated identity carrier', () => {
    const dag = new FeatureDag()
    addSketch(dag, 'SK-A')
    addSketch(dag, 'SK-B')
    addFeature(dag, 'BODY-A', 'extrude', ['SK-A'])
    addFeature(dag, 'BODY-B', 'revolve', ['SK-B'])
    dag.insertNode({
      id: 'BROKEN',
      kind: 'feature',
      consumes: ['BODY-A', 'BODY-B'],
      payload: { opType: 'boolean', boolOp: 'futureBoolean', targetFeatureId: 'BODY-A', toolFeatureId: 'BODY-B' },
    })

    expect(projectBodyLineages(dag, ['BODY-A', 'BODY-B', 'BROKEN'], ['BROKEN']))
      .toEqual([{ bodyId: 'BROKEN', lineageId: 'BROKEN' }])
  })

  it('treats an import as a lineage root without a parallel opType allowlist', () => {
    const dag = new FeatureDag()
    dag.insertNode({ id: 'IMP1', kind: 'import', payload: { name: 'Imported bracket' } })
    addFeature(dag, 'F1', 'defeature', ['IMP1'])
    expect(projectBodyLineages(dag, ['IMP1', 'F1'], ['F1'])).toEqual([{ bodyId: 'F1', lineageId: 'IMP1' }])
  })
})
