import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { FeatureDag, ElementMap, RegenScheduler } from '../../doc'
import type { DagNodeSnapshot } from '../../doc'
import type { BodyHandle, OpResult, ProfileRegion, ResolvedExtrudeTarget } from '../../geom/geom-service'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'
import {
  bodyFeatureIds,
  liveBodyFeatureIds,
  resolveBodyTargetLineage,
} from '../../components/model3d/bodyLineage'
import { buildExtrudeRequest, type ExtrudeParamsInput } from '../../components/model3d/workbench/extrudeParams'
import { rectLoop, xyPlane } from '../geom/fixtures/profiles.ts'

const MODEL_ITEM = 'MODEL-1'

function profile(sketchId: string, z: number, x0: number, y0: number, x1: number, y1: number): ProfileRegion {
  return { sketchId, plane: xyPlane(z), loops: [rectLoop(sketchId, x0, y0, x1, y1)] }
}

function refusal(reason: string): OpResult {
  return {
    ok: false,
    diagnostics: [{ code: 'KERNEL_OP_FAILED', severity: 'error', params: { op: 'extrude', reason } }],
  }
}

interface Harness {
  dag: FeatureDag
  scheduler: RegenScheduler
  handles: Map<string, BodyHandle>
  resolvedEndTargetIds: Map<string, string[]>
  runFrom: (roots: readonly string[]) => Promise<string[]>
}

function createHarness(engine: GeomEngine): Harness {
  const dag = new FeatureDag()
  const scheduler = new RegenScheduler(dag, new ElementMap())
  const handles = new Map<string, BodyHandle>()
  const resolvedEndTargetIds = new Map<string, string[]>()

  const currentBodyIds = (): string[] => liveBodyFeatureIds(dag, (id) => handles.has(id))
  const lookupLiveBody = (id: string): BodyHandle | undefined => (
    currentBodyIds().includes(id) ? handles.get(id) : undefined
  )
  const resolveBodyTarget = (id: string) => resolveBodyTargetLineage(
    dag,
    bodyFeatureIds(dag),
    currentBodyIds(),
    id,
  )

  const execute = async (node: DagNodeSnapshot): Promise<OpResult> => {
    if (node.kind === 'sketch') return { ok: true, diagnostics: [] }
    if (node.kind !== 'feature') return { ok: true, diagnostics: [] }

    const prior = handles.get(node.id)
    if (prior !== undefined) {
      await engine.dispose(prior)
      handles.delete(node.id)
    }

    const role = node.payload.testRole
    let result: OpResult
    if (role === 'seed') {
      result = await engine.makeExtrude({
        featureId: node.id,
        profiles: [node.payload.profile as ProfileRegion],
        end: { kind: 'blind', distance: node.payload.distance as number },
        op: 'newBody',
      })
    } else if (role === 'end') {
      resolvedEndTargetIds.delete(node.id)
      const candidates: ResolvedExtrudeTarget[] = currentBodyIds()
        .filter((id) => id !== node.id)
        .map((id) => ({ identity: { modelItemId: MODEL_ITEM, bodyFeatureId: id }, body: handles.get(id)! }))
      const build = buildExtrudeRequest({
        featureId: node.id,
        payload: node.payload.params as ExtrudeParamsInput,
        profiles: [node.payload.profile as ProfileRegion],
        distance: 1,
        modelItemId: MODEL_ITEM,
        lookupTarget: lookupLiveBody,
        candidateTargets: candidates,
        resolveBodyTarget,
      })
      if (build.ok) {
        const { end } = build.req
        const targetIds = end.kind === 'throughAll'
          ? end.targets.map((target) => target.identity.bodyFeatureId)
          : end.kind === 'toPart' && 'bodyFeatureId' in end.target.identity
            ? [end.target.identity.bodyFeatureId]
            : []
        resolvedEndTargetIds.set(node.id, targetIds)
      }
      result = build.ok ? await engine.makeExtrude(build.req) : refusal(build.reason)
    } else if (role === 'boolean') {
      const targetId = node.payload.targetFeatureId as string
      const toolId = node.payload.toolFeatureId as string
      const boolOp = node.payload.boolOp
      if (boolOp !== 'fuse' && boolOp !== 'cut' && boolOp !== 'intersect') {
        return refusal(`unknown boolean op '${String(boolOp)}'`)
      }
      result = await engine.applyBoolean({
        featureId: node.id,
        op: boolOp,
        target: handles.get(targetId)!,
        tools: [handles.get(toolId)!],
      })
    } else if (role === 'add') {
      result = await engine.makeExtrude({
        featureId: node.id,
        profiles: [node.payload.profile as ProfileRegion],
        end: { kind: 'blind', distance: node.payload.distance as number },
        op: 'add',
        target: handles.get(node.payload.targetFeatureId as string),
      })
    } else {
      return refusal(`unknown test role '${String(role)}'`)
    }

    if (result.ok && result.body !== undefined) handles.set(node.id, result.body)
    return result
  }

  return {
    dag,
    scheduler,
    handles,
    resolvedEndTargetIds,
    runFrom: async (roots) => {
      for (const root of roots) scheduler.markDirty(root)
      return (await scheduler.run(execute)).executed
    },
  }
}

function addSketch(dag: FeatureDag, id: string): void {
  dag.insertNode({ id, kind: 'sketch', payload: {} })
}

describe('WO-241 persisted extrude targets survive later features', () => {
  let engine: GeomEngine

  beforeAll(async () => {
    engine = new GeomEngine()
    await engine.init()
  }, 60_000)

  afterEach(async () => {
    await engine.disposeAll()
  })

  afterAll(async () => {
    await engine.disposeKernel()
  })

  it('keeps Through all green when a later merge consumes its non-carrier target', async () => {
    const h = createHarness(engine)
    addSketch(h.dag, 'SK1')
    addSketch(h.dag, 'SK2')
    addSketch(h.dag, 'SK3')
    addSketch(h.dag, 'SK4')
    h.dag.insertNode({
      id: 'F1', kind: 'feature', consumes: ['SK1'],
      payload: { opType: 'extrude', testRole: 'seed', profile: profile('SK1', 10, 0, 0, 20, 20), distance: 10 },
    })
    h.dag.insertNode({
      id: 'F2', kind: 'feature', consumes: ['SK2'],
      payload: { opType: 'extrude', testRole: 'seed', profile: profile('SK2', 15, 10, 0, 30, 20), distance: 10 },
    })
    h.dag.insertNode({
      id: 'F3', kind: 'feature', consumes: ['SK3'],
      payload: {
        opType: 'extrude',
        testRole: 'end',
        profile: profile('SK3', 0, 2, 2, 4, 4),
        params: {
          direction: 'up', boolMode: 'newBody', endCondition: 'throughAll',
          resolvedEndTargets: [
            { modelItemId: MODEL_ITEM, bodyFeatureId: 'F1' },
            { modelItemId: MODEL_ITEM, bodyFeatureId: 'F2' },
          ],
        },
      },
    })
    const initial = await h.runFrom(['SK1', 'SK2', 'SK3'])
    expect(initial).toContain('F3')
    expect(h.scheduler.statusOf('F3')).toBe('ok')
    expect(h.resolvedEndTargetIds.get('F3')).toEqual(['F1', 'F2'])

    h.dag.insertNode({
      id: 'F4', kind: 'feature', consumes: ['F1', 'F2'],
      payload: { opType: 'boolean', testRole: 'boolean', boolOp: 'fuse', targetFeatureId: 'F1', toolFeatureId: 'F2' },
    })
    expect(await h.runFrom(['F4'])).toEqual(['F4'])
    h.dag.insertNode({
      id: 'F5', kind: 'feature', consumes: ['SK4'],
      payload: { opType: 'extrude', testRole: 'seed', profile: profile('SK4', 0, 100, 100, 110, 110), distance: 10 },
    })
    expect(await h.runFrom(['F5'])).toEqual(['F5'])
    expect(resolveBodyTargetLineage(h.dag, bodyFeatureIds(h.dag), ['F3', 'F4'], 'F2'))
      .toEqual({ ok: true, bodyId: 'F4' })

    expect(await h.runFrom(['SK3'])).toEqual(['SK3', 'F3'])
    expect(h.scheduler.statusOf('F3')).toBe('ok')
    expect(h.scheduler.diagnosticsOf('F3')).toEqual([])
    expect(h.handles.has('F3')).toBe(true)
    expect(h.resolvedEndTargetIds.get('F3')).toEqual(['F4'])
  }, 60_000)

  it('keeps an explicit Up to part pick green after a later Add consumes that part, then fails by name when it is truly gone', async () => {
    const h = createHarness(engine)
    addSketch(h.dag, 'SK1')
    addSketch(h.dag, 'SK2')
    addSketch(h.dag, 'SK3')
    h.dag.insertNode({
      id: 'F1', kind: 'feature', consumes: ['SK1'],
      payload: { opType: 'extrude', testRole: 'seed', profile: profile('SK1', 10, 0, 0, 20, 20), distance: 10 },
    })
    h.dag.insertNode({
      id: 'F2', kind: 'feature', consumes: ['SK2'],
      payload: {
        opType: 'extrude',
        testRole: 'end',
        profile: profile('SK2', 0, 2, 2, 4, 4),
        params: {
          direction: 'up', boolMode: 'newBody', endCondition: 'toPart',
          endTarget: { modelItemId: MODEL_ITEM, bodyFeatureId: 'F1' },
        },
      },
    })
    h.dag.insertNode({
      id: 'F3', kind: 'feature', consumes: ['SK3', 'F1'],
      payload: {
        opType: 'extrude', testRole: 'add', boolMode: 'add', targetFeatureId: 'F1',
        profile: profile('SK3', 20, 5, 5, 10, 10), distance: 5,
      },
    })

    await h.runFrom(['SK1', 'SK2', 'SK3'])
    expect(h.scheduler.statusOf('F2')).toBe('ok')
    expect(h.resolvedEndTargetIds.get('F2')).toEqual(['F1'])
    expect(await h.runFrom(['SK2'])).toEqual(['SK2', 'F2'])
    expect(h.scheduler.statusOf('F2')).toBe('ok')
    expect(h.resolvedEndTargetIds.get('F2')).toEqual(['F3'])

    await engine.dispose(h.handles.get('F1')!)
    await engine.dispose(h.handles.get('F3')!)
    h.handles.delete('F1')
    h.handles.delete('F3')
    await h.runFrom(['SK2'])
    expect(h.scheduler.statusOf('F2')).toBe('failed')
    expect(h.scheduler.diagnosticsOf('F2')).toEqual([
      expect.objectContaining({
        code: 'KERNEL_OP_FAILED',
        params: expect.objectContaining({ reason: "extrude end target body 'F1' is lost (no live descendant)" }),
      }),
    ])
  }, 60_000)

  it('refuses an Up to part target by name after a later Boolean cut consumes it as the tool', async () => {
    const h = createHarness(engine)
    for (const id of ['SK-A', 'SK-B', 'SK-END']) addSketch(h.dag, id)
    h.dag.insertNode({
      id: 'A', kind: 'feature', consumes: ['SK-A'],
      payload: { opType: 'extrude', testRole: 'seed', profile: profile('SK-A', 10, 0, 0, 20, 20), distance: 10 },
    })
    h.dag.insertNode({
      id: 'B', kind: 'feature', consumes: ['SK-B'],
      payload: { opType: 'extrude', testRole: 'seed', profile: profile('SK-B', 0, -5, -5, 25, 25), distance: 30 },
    })
    h.dag.insertNode({
      id: 'END', kind: 'feature', consumes: ['SK-END'],
      payload: {
        opType: 'extrude', testRole: 'end', profile: profile('SK-END', 0, 2, 2, 4, 4),
        params: {
          direction: 'up', boolMode: 'newBody', endCondition: 'toPart',
          endTarget: { modelItemId: MODEL_ITEM, bodyFeatureId: 'A' },
        },
      },
    })

    await h.runFrom(['SK-A', 'SK-B', 'SK-END'])
    expect(h.scheduler.statusOf('END')).toBe('ok')
    expect(h.resolvedEndTargetIds.get('END')).toEqual(['A'])

    h.dag.insertNode({
      id: 'CUT', kind: 'feature', consumes: ['B', 'A'],
      payload: {
        opType: 'boolean', testRole: 'boolean', boolOp: 'cut',
        targetFeatureId: 'B', toolFeatureId: 'A',
      },
    })
    await h.runFrom(['CUT'])
    expect(h.scheduler.statusOf('CUT')).toBe('ok')
    expect(resolveBodyTargetLineage(h.dag, bodyFeatureIds(h.dag), ['END', 'CUT'], 'A'))
      .toEqual({ ok: false, reason: 'lost', candidates: [] })

    await h.runFrom(['SK-END'])
    expect(h.scheduler.statusOf('END')).toBe('failed')
    expect(h.scheduler.diagnosticsOf('END')).toEqual([
      expect.objectContaining({
        code: 'KERNEL_OP_FAILED',
        params: expect.objectContaining({ reason: "extrude end target body 'A' is lost (no live descendant)" }),
      }),
    ])
  }, 60_000)

  it('refuses a Through all set by member name after a later Boolean cut consumes that member as the tool', async () => {
    const h = createHarness(engine)
    for (const id of ['SK-A', 'SK-B', 'SK-END']) addSketch(h.dag, id)
    h.dag.insertNode({
      id: 'A', kind: 'feature', consumes: ['SK-A'],
      payload: { opType: 'extrude', testRole: 'seed', profile: profile('SK-A', 10, 0, 0, 20, 20), distance: 10 },
    })
    h.dag.insertNode({
      id: 'B', kind: 'feature', consumes: ['SK-B'],
      payload: { opType: 'extrude', testRole: 'seed', profile: profile('SK-B', 0, -5, -5, 25, 25), distance: 30 },
    })
    h.dag.insertNode({
      id: 'END', kind: 'feature', consumes: ['SK-END'],
      payload: {
        opType: 'extrude', testRole: 'end', profile: profile('SK-END', 0, 2, 2, 4, 4),
        params: {
          direction: 'up', boolMode: 'newBody', endCondition: 'throughAll',
          resolvedEndTargets: [
            { modelItemId: MODEL_ITEM, bodyFeatureId: 'A' },
            { modelItemId: MODEL_ITEM, bodyFeatureId: 'B' },
          ],
        },
      },
    })

    await h.runFrom(['SK-A', 'SK-B', 'SK-END'])
    expect(h.scheduler.statusOf('END')).toBe('ok')
    expect(h.resolvedEndTargetIds.get('END')).toEqual(['A', 'B'])

    h.dag.insertNode({
      id: 'CUT', kind: 'feature', consumes: ['B', 'A'],
      payload: {
        opType: 'boolean', testRole: 'boolean', boolOp: 'cut',
        targetFeatureId: 'B', toolFeatureId: 'A',
      },
    })
    await h.runFrom(['CUT'])
    expect(h.scheduler.statusOf('CUT')).toBe('ok')

    await h.runFrom(['SK-END'])
    expect(h.scheduler.statusOf('END')).toBe('failed')
    expect(h.scheduler.diagnosticsOf('END')).toEqual([
      expect.objectContaining({
        code: 'KERNEL_OP_FAILED',
        params: expect.objectContaining({ reason: "extrude throughAll persisted target body 'A' is lost (no live descendant)" }),
      }),
    ])
  }, 60_000)

  it('keeps both members of a two-body Remove lineage but refuses a consumed boolean target by name', async () => {
    const dag = new FeatureDag()
    for (const id of ['SK-A', 'SK-B', 'SK-C', 'SK-R']) addSketch(dag, id)
    for (const [id, sketchId] of [['A', 'SK-A'], ['B', 'SK-B'], ['C', 'SK-C']] as const) {
      dag.insertNode({ id, kind: 'feature', consumes: [sketchId], payload: { opType: 'extrude' } })
    }
    dag.insertNode({
      id: 'REMOVE', kind: 'feature', consumes: ['SK-R', 'A', 'B'],
      payload: { opType: 'extrude', boolMode: 'remove', targetFeatureIds: ['A', 'B'] },
    })
    dag.insertNode({
      id: 'MERGED-B', kind: 'feature', consumes: ['B', 'C'],
      payload: { opType: 'boolean', boolOp: 'fuse', targetFeatureId: 'B', toolFeatureId: 'C' },
    })

    const a = await engine.makeExtrude({
      featureId: 'A', profiles: [profile('SK-A', 0, 0, 0, 20, 20)],
      end: { kind: 'blind', distance: 20 }, op: 'newBody',
    })
    const b = await engine.makeExtrude({
      featureId: 'B', profiles: [profile('SK-B', 0, 10, 0, 30, 20)],
      end: { kind: 'blind', distance: 20 }, op: 'newBody',
    })
    const c = await engine.makeExtrude({
      featureId: 'C', profiles: [profile('SK-C', 0, 20, 0, 40, 20)],
      end: { kind: 'blind', distance: 20 }, op: 'newBody',
    })
    expect(a.ok && b.ok && c.ok).toBe(true)
    const merged = await engine.applyBoolean({ featureId: 'MERGED-B', op: 'fuse', target: b.body!, tools: [c.body!] })
    expect(merged.ok).toBe(true)
    const handles = new Map<string, BodyHandle>([['A', a.body!], ['MERGED-B', merged.body!]])
    const census = bodyFeatureIds(dag)
    const live = ['A', 'MERGED-B']
    const resolvedIds = ['A', 'B'].map((id) => {
      const resolved = resolveBodyTargetLineage(dag, census, live, id)
      expect(resolved.ok).toBe(true)
      return resolved.ok ? resolved.bodyId : 'unreachable'
    })
    expect(resolvedIds).toEqual(['A', 'MERGED-B'])

    let resolverCalls = 0
    const build = buildExtrudeRequest({
      featureId: 'REMOVE',
      payload: { direction: 'up', boolMode: 'remove', targetFeatureIds: ['A', 'B'] },
      profiles: [profile('SK-R', 0, 12, 5, 18, 15)],
      distance: 20,
      lookupTarget: (id) => handles.get(id),
      resolveBodyTarget: (id) => {
        resolverCalls += 1
        return resolveBodyTargetLineage(dag, census, live, id)
      },
    })
    expect(build).toEqual({
      ok: false,
      reason: "extrude remove target 'B' has no live body (missing or already consumed)",
    })
    expect(resolverCalls).toBe(0)
  }, 60_000)

  it('refuses an ambiguous explicit target by its persisted body name', () => {
    const dag = new FeatureDag()
    addSketch(dag, 'SK-ROOT')
    addSketch(dag, 'SK-END')
    dag.insertNode({ id: 'ROOT', kind: 'feature', consumes: ['SK-ROOT'], payload: { opType: 'extrude' } })
    dag.insertNode({ id: 'LEFT', kind: 'feature', consumes: ['ROOT'], payload: { opType: 'fillet' } })
    dag.insertNode({ id: 'RIGHT', kind: 'feature', consumes: ['ROOT'], payload: { opType: 'chamfer' } })
    const census = bodyFeatureIds(dag)

    const build = buildExtrudeRequest({
      featureId: 'END',
      payload: {
        direction: 'up', boolMode: 'newBody', endCondition: 'toPart',
        endTarget: { modelItemId: MODEL_ITEM, bodyFeatureId: 'ROOT' },
      },
      profiles: [profile('SK-END', 0, 2, 2, 4, 4)],
      distance: 1,
      modelItemId: MODEL_ITEM,
      lookupTarget: () => undefined,
      resolveBodyTarget: (id) => resolveBodyTargetLineage(dag, census, ['LEFT', 'RIGHT'], id),
    })

    expect(build).toEqual({
      ok: false,
      reason: "extrude end target body 'ROOT' is ambiguous between live bodies: LEFT, RIGHT",
    })
  })
})
