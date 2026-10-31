// @vitest-environment jsdom
// WO-3202 (WO-3170 Slice B): the revision-bound feature result's edge routes.
// The live half drives a real ModelSession with a counting fake kernel (its
// handles stand for immutable shapes, as the worker's do). The archive half
// replays real held documents through the real in-process kernel, counting
// transient kernel mounts. Every count here is a kernel call or a mount.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createLocalGeomService } from '../../geom'
import type { BodyHandle, FeatureVerdict } from '../../geom/geom-service'
import type { GeometrySnapshot } from '../../geom'
import { createModelSession, ElementMap, FeatureDag, InsertNodeCommand, SetSuppressedCommand, type ModelSession } from '../../doc'
import {
  archiveFeatureResultScope,
  disposeModelItem,
  registerLiveDocument,
  registerModelSession,
  replaceLoadedDocumentArchives,
  resetDocumentHolder,
  stashLoadedDocument,
} from '../../doc/documentHolder'
import { BASE_PLANE_XY_NODE_ID } from '../../doc/genesis'
import { finalizeSeedArchive, newSeededModelDag } from '../../doc/seedModelArchive'
import type { Sketch, SketchEntity } from '../../lib/sketch/sketcher'
import {
  bindModelBodyFeatures,
  FeatureResultMemo,
  FeatureSourceUnavailableError,
  MODEL_FEATURE_BINDER_VERSION,
  readLiveModelBodyFeatures,
  type LiveBodySource,
  type ModelBodyKernel,
  type ModelBodySourceToken,
} from '../../lib/geometry/partFeatureBinding'
import {
  __setModelBodyHeadlessClientFactoryForTests,
  readModelBodyFaceBinding,
  readModelBodyFaceFacts,
  readModelBodyFeatureResult,
  recognizeModelBodyHoles,
} from '../../lib/cam/modelBodyHoleRecognition'
import { deriveModelBodyBoreTarget } from '../../lib/cam/modelBodyDerive'
import type { ImportedGeometry } from '../../types'

// ── Live: a counting fake kernel ─────────────────────────────────────────

function holeVerdict(diameter: number, wall = 'F1:wall'): FeatureVerdict {
  return {
    featureKey: `hole:10:12:10:0:0:1:${diameter / 2}`,
    featureClass: 'blindHole', removable: true, effect: 'add',
    faceIds: [wall], neighbourIds: [],
    params: { diameter, depth: 6, axisX: 0, axisY: 0, axisZ: 1, centerX: 10, centerY: 12, centerZ: 10 },
  } as FeatureVerdict
}

function wallSnapshot(diameter: number): GeometrySnapshot {
  return { type: 'cylinder', centroid: [10, 12, 7], normal: [1, 0, 0], area: 150, axis: [0, 0, 1], axisPoint: [10, 12, 0], radius: diameter / 2 }
}

interface FakeKernel extends ModelBodyKernel {
  calls: BodyHandle[]
  /** diameter of the hole on each handle's shape */
  shapes: Map<BodyHandle, number>
  hold: boolean
  releases: Array<() => void>
  failNext: string | null
}

function fakeKernel(): FakeKernel {
  const kernel: FakeKernel = {
    calls: [], shapes: new Map(), hold: false, releases: [], failNext: null,
    recognizeFeatures(handle) {
      kernel.calls.push(handle)
      if (kernel.failNext !== null) {
        const reason = kernel.failNext
        kernel.failNext = null
        return Promise.reject(new Error(reason))
      }
      const verdicts = [holeVerdict(kernel.shapes.get(handle) ?? 0)]
      if (!kernel.hold) return Promise.resolve(verdicts)
      return new Promise((resolve) => { kernel.releases.push(() => resolve(verdicts)) })
    },
    snapshotsFor(handle) {
      return Promise.resolve({ 'F1:wall': wallSnapshot(kernel.shapes.get(handle) ?? 0) })
    },
  }
  return kernel
}

const h = (n: number) => n as BodyHandle

function liveSession(modelItemId: string, kernel: { current: ModelBodyKernel | null }, handles: Map<string, BodyHandle>): ModelSession {
  const dag = new FeatureDag()
  dag.insertNode({ id: 'F1', kind: 'feature', consumes: [], refs: [], payload: { opType: 'extrude' } })
  const session = createModelSession({ modelItemId, dag, map: new ElementMap() })
  const source: LiveBodySource = { handleOf: (id) => handles.get(id), kernel: () => kernel.current }
  session.setLiveBodySource(source)
  return session
}

const diameters = (verdicts: readonly FeatureVerdict[]) => verdicts.map((v) => v.params.diameter)

beforeEach(() => { resetDocumentHolder() })
afterEach(() => {
  __setModelBodyHeadlessClientFactoryForTests(null)
  resetDocumentHolder()
})

describe('WO-3202 live result: one recognition per committed body revision', () => {
  it('concurrent consumers share one recognition; a failure does not poison the retry', async () => {
    const kernel = fakeKernel()
    kernel.shapes.set(h(1), 6)
    const session = liveSession('legacy', { current: kernel }, new Map([['F1', h(1)]]))

    kernel.failNext = 'kernel busy'
    await expect(readLiveModelBodyFeatures(session, 'F1')).rejects.toThrow('kernel busy')
    expect(session.featureResults.size).toBe(0)

    const [a, b] = await Promise.all([readLiveModelBodyFeatures(session, 'F1'), readLiveModelBodyFeatures(session, 'F1')])
    expect(a).toBe(b)
    expect(kernel.calls).toEqual([h(1), h(1)]) // the failed try + one shared recognition
    expect(a.token).toMatchObject({ route: 'live', modelItemId: 'legacy', bodyId: 'F1', revision: 0, handle: 1 })
    expect(a.features.features.map((f) => f.type)).toEqual(['blindHole'])
    expect(a.features.features[0].references).toEqual(['F1:wall'])
    // A consumer that gives up (cancellation) does not cancel the shared read.
    kernel.calls = []
    expect(await readLiveModelBodyFeatures(session, 'F1')).toBe(a)
    expect(kernel.calls).toEqual([])
  })

  it('an edit, suppress, restore, delete or undo moves the revision: the next read is a NEW result and the old ones are dropped', async () => {
    const kernel = fakeKernel()
    kernel.shapes.set(h(1), 6)
    const handles = new Map([['F1', h(1)]])
    const session = liveSession('legacy', { current: kernel }, handles)
    const first = await readLiveModelBodyFeatures(session, 'F1')

    // Suppress (revision 1) then restore (revision 2): each is a new history entry.
    session.history.execute(new SetSuppressedCommand('F1', true))
    session.history.execute(new SetSuppressedCommand('F1', false))
    kernel.shapes.set(h(2), 8)
    handles.set('F1', h(2))
    const second = await readLiveModelBodyFeatures(session, 'F1')
    expect(second.token.revision).toBe(2)
    expect(diameters(second.verdicts)).toEqual([8])
    expect(session.featureResults.completed(first.token)).toBeUndefined()
    expect(session.featureResults.size).toBe(1)

    // Undo also moves the revision (CommandHistory counts every mutation).
    session.history.undo()
    handles.set('F1', h(1))
    const third = await readLiveModelBodyFeatures(session, 'F1')
    expect(third.token.revision).toBe(3)
    expect(diameters(third.verdicts)).toEqual([6])

    // Delete: no committed body -> the live route says so, nothing is guessed.
    handles.delete('F1')
    await expect(readLiveModelBodyFeatures(session, 'F1')).rejects.toBeInstanceOf(FeatureSourceUnavailableError)
  })

  it('a result whose body was superseded while it ran is never handed out', async () => {
    const kernel = fakeKernel()
    kernel.shapes.set(h(1), 6).set(h(2), 8)
    const handles = new Map([['F1', h(1)]])
    const session = liveSession('legacy', { current: kernel }, handles)
    kernel.hold = true
    const read = readLiveModelBodyFeatures(session, 'F1')
    await Promise.resolve()
    await Promise.resolve()
    // The regeneration publishes a new committed handle mid-read.
    handles.set('F1', h(2))
    kernel.hold = false
    kernel.releases.splice(0).forEach((release) => release())
    const result = await read
    expect(result.token.handle).toBe(2)
    expect(diameters(result.verdicts)).toEqual([8])
  })

  it('a restarted kernel is a new lifetime even when it reissues the same handle number', async () => {
    const first = fakeKernel()
    first.shapes.set(h(1), 6)
    const kernel = { current: first as ModelBodyKernel | null }
    const session = liveSession('legacy', kernel, new Map([['F1', h(1)]]))
    const a = await readLiveModelBodyFeatures(session, 'F1')
    const second = fakeKernel()
    second.shapes.set(h(1), 8)
    kernel.current = second
    const b = await readLiveModelBodyFeatures(session, 'F1')
    expect(b.token.kernel).not.toBe(a.token.kernel)
    expect(diameters(b.verdicts)).toEqual([8])
    expect(second.calls).toEqual([h(1)])
  })

  it('two model items with the same raw body id keep separate results', async () => {
    const kernelA = fakeKernel()
    kernelA.shapes.set(h(1), 6)
    const kernelB = fakeKernel()
    kernelB.shapes.set(h(1), 10)
    const a = liveSession('item-a', { current: kernelA }, new Map([['F1', h(1)]]))
    const b = liveSession('item-b', { current: kernelB }, new Map([['F1', h(1)]]))
    const unregisterA = registerModelSession(a)
    const unregisterB = registerModelSession(b)
    try {
      expect(diameters((await readModelBodyFeatureResult('F1', 'item-a')).verdicts)).toEqual([6])
      expect(diameters((await readModelBodyFeatureResult('F1', 'item-b')).verdicts)).toEqual([10])
      const facts = await readModelBodyFaceBinding('F1', 'F1:wall', 'item-b')
      expect(facts.result?.token.modelItemId).toBe('item-b')
      expect(facts.feature?.id).toBe(b.featureResults.completedResults()[0].features.features[0].id)
      expect(kernelA.calls).toHaveLength(1)
      expect(kernelB.calls).toHaveLength(1)
    } finally {
      unregisterA()
      unregisterB()
    }
  })

  it('a placement-only change re-derives the Bore target from the SAME result', async () => {
    const kernel = fakeKernel()
    kernel.shapes.set(h(1), 8)
    const session = liveSession('legacy', { current: kernel }, new Map([['F1', h(1)]]))
    const unregister = registerModelSession(session)
    try {
      const geo = {
        id: 'modelbody:F1', name: 'Plate', filename: '', type: 'model', format: 'model', loaded: true,
        position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
        boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 30, y: 30, z: 10 } }, modelItemId: 'legacy',
        modelBody: { ref: { bodyId: 'F1', stableIds: ['F1:wall'], version: 1 } },
      } as unknown as ImportedGeometry
      const at = async (x: number) => {
        const { snapshot, verdicts } = await readModelBodyFaceFacts('F1', 'F1:wall', 'legacy')
        return deriveModelBodyBoreTarget(geo, [{ modelItemId: 'legacy', position: { x, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }], 'F1:wall', snapshot, verdicts).target
      }
      expect((await at(0)).centerX).toBeCloseTo(10, 6)
      expect((await at(25)).centerX).toBeCloseTo(35, 6)
      expect(kernel.calls).toHaveLength(1)
    } finally {
      unregister()
    }
  })
})

// ── Model -> Setup handoff: the holder carries only what is still true ────

describe('WO-3202 unmount handoff: completed live evidence rides into the captured archive', () => {
  function mounted(modelItemId = 'legacy') {
    const kernel = fakeKernel()
    kernel.shapes.set(h(1), 8)
    const handles = new Map([['F1', h(1)]])
    const session = liveSession(modelItemId, { current: kernel }, handles)
    const dag = newSeededModelDag()
    const unregisterSession = registerModelSession(session)
    const unregisterCollector = registerLiveDocument(() => ({ dag, elementMapDeltas: [] }), modelItemId, true)
    // The page's cleanup order: collector, then session, then live source.
    const unmount = () => { unregisterCollector(); unregisterSession(); session.setLiveBodySource(null) }
    return { kernel, handles, session, unmount }
  }

  it('Finish carries the committed result: a later Bore read needs no replay', async () => {
    let mounts = 0
    __setModelBodyHeadlessClientFactoryForTests(() => { mounts++; return createLocalGeomService() })
    const { session, unmount } = mounted()
    const live = await readLiveModelBodyFeatures(session, 'F1')
    unmount()
    const scope = archiveFeatureResultScope('legacy')!
    const carried = scope.memo.completedResults()
    expect(carried).toHaveLength(1)
    expect(carried[0].token).toEqual({ binderVersion: MODEL_FEATURE_BINDER_VERSION, route: 'archive', modelItemId: 'legacy', bodyId: 'F1', revision: scope.serial })
    expect(carried[0].features).toEqual(live.features)
    expect(JSON.parse(JSON.stringify(carried[0])).verdicts).toEqual(live.verdicts) // plain data, no handle
    const facts = await readModelBodyFaceBinding('F1', 'F1:wall', 'legacy')
    expect(facts.result?.token.route).toBe('archive')
    expect(facts.feature?.id).toBe(live.features.features[0].id)
    expect(mounts).toBe(0)
  })

  it('a no-op Finish (byte-identical archive) still carries into the held archive', async () => {
    const first = mounted()
    first.unmount()
    const second = mounted()
    await readLiveModelBodyFeatures(second.session, 'F1')
    second.unmount()
    expect(archiveFeatureResultScope('legacy')!.memo.completedResults()).toHaveLength(1)
  })

  it('carries nothing when the revision moved after the read, or a rebuild is pending', async () => {
    const moved = mounted()
    await readLiveModelBodyFeatures(moved.session, 'F1')
    moved.session.history.execute(new InsertNodeCommand({ id: 'F9', kind: 'feature', consumes: [], refs: [], payload: { opType: 'extrude' } }))
    moved.unmount()
    expect(archiveFeatureResultScope('legacy')!.memo.completedResults()).toEqual([])

    resetDocumentHolder()
    const dirty = mounted()
    await readLiveModelBodyFeatures(dirty.session, 'F1')
    dirty.session.scheduler.markDirty('F1')
    dirty.unmount()
    expect(archiveFeatureResultScope('legacy')!.memo.completedResults()).toEqual([])
  })

  it('withdrawing the live source drops live results; the memo never outlives its session', async () => {
    const { session } = mounted()
    await readLiveModelBodyFeatures(session, 'F1')
    session.setLiveBodySource(null)
    expect(session.featureResults.size).toBe(0)
  })
})

// ── Headless archive: one replay per archive, the correct owner ───────────

function sketch(id: string, entities: SketchEntity[]): Sketch {
  return { id, layerId: 'L1', entities, constraints: [], dimensions: [], solveStatus: null }
}
const BODY = 'PLATE-HOLE-CUT'
function plateWithHole(radius: number): Uint8Array {
  const dag = newSeededModelDag()
  const lines: SketchEntity[] = [
    { id: 'p0', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 60, y: 0 } },
    { id: 'p1', kind: 'line', construction: false, start: { x: 60, y: 0 }, end: { x: 60, y: 40 } },
    { id: 'p2', kind: 'line', construction: false, start: { x: 60, y: 40 }, end: { x: 0, y: 40 } },
    { id: 'p3', kind: 'line', construction: false, start: { x: 0, y: 40 }, end: { x: 0, y: 0 } },
  ]
  dag.insertNode({ id: 'sketch3d:PLATE', kind: 'sketch', consumes: [BASE_PLANE_XY_NODE_ID], refs: [], payload: { sketch: sketch('PLATE', lines), planeNodeId: BASE_PLANE_XY_NODE_ID } })
  dag.insertNode({ id: 'PLATE-EXTRUDE', kind: 'feature', consumes: ['sketch3d:PLATE'], refs: [], payload: { opType: 'extrude', sketchId: 'sketch3d:PLATE', profileSelector: { kind: 'whole-sketch' }, distance: 10, direction: 'up', boolMode: 'newBody' } })
  dag.insertNode({ id: 'sketch3d:HOLE', kind: 'sketch', consumes: [BASE_PLANE_XY_NODE_ID], refs: [], payload: { sketch: sketch('HOLE', [{ id: 'h1', kind: 'circle', construction: false, center: { x: 15, y: 20 }, radius }]), planeNodeId: BASE_PLANE_XY_NODE_ID } })
  dag.insertNode({ id: BODY, kind: 'feature', consumes: ['sketch3d:HOLE', 'PLATE-EXTRUDE'], refs: [], payload: { opType: 'extrude', sketchId: 'sketch3d:HOLE', profileSelector: { kind: 'whole-sketch' }, distance: 12, direction: 'up', boolMode: 'remove', targetFeatureId: 'PLATE-EXTRUDE' } })
  return finalizeSeedArchive(dag)
}

const holeDiameters = (verdicts: readonly FeatureVerdict[]) => verdicts
  .filter((v) => v.featureClass === 'throughHole' || v.featureClass === 'blindHole')
  .map((v) => Math.round(Number(v.params.diameter) * 1000) / 1000)

describe('WO-3202 headless archive result', () => {
  let mounts = 0
  beforeEach(() => {
    mounts = 0
    __setModelBodyHeadlessClientFactoryForTests(() => { mounts++; return createLocalGeomService() })
  })

  it('replays once per archive per body, coalesces callers, and reads each item\'s OWN archive', async () => {
    stashLoadedDocument(plateWithHole(3), 'item-a')
    stashLoadedDocument(plateWithHole(5), 'item-b')
    const [a1, a2] = await Promise.all([readModelBodyFeatureResult(BODY, 'item-a'), recognizeModelBodyHoles(BODY, 'item-a')])
    expect(holeDiameters(a1.verdicts)).toEqual([6])
    expect(holeDiameters(a2)).toEqual([6])
    expect(mounts).toBe(1)
    expect(a1.token).toMatchObject({ route: 'archive', modelItemId: 'item-a', bodyId: BODY })
    expect(holeDiameters((await readModelBodyFeatureResult(BODY, 'item-b')).verdicts)).toEqual([10])
    expect(mounts).toBe(2)
    const wall = Object.entries(a1.snapshots).find(([, s]) => s.type === 'cylinder')![0]
    const facts = await readModelBodyFaceBinding(BODY, wall, 'item-a')
    expect(Object.keys(await readModelBodyFaceFacts(BODY, wall, 'item-a')).sort()).toEqual(['snapshot', 'verdicts'])
    expect(facts.result).toBe(a1)
    expect(facts.feature?.references).toContain(wall)
    expect(mounts).toBe(2)
  }, 60_000)

  it('a page\'s hooks for another item never answer for this one (identical raw body ids)', async () => {
    stashLoadedDocument(plateWithHole(5), 'item-b')
    const foreign = [holeVerdict(99)]
    ;(window as unknown as Record<string, unknown>).__solidsWorkbenchHooks = {
      modelItemId: 'item-a',
      getBodyHandle: () => h(1),
      client: { recognizeFeatures: () => Promise.resolve(foreign), snapshotsFor: () => Promise.resolve({}) },
    }
    try {
      expect(holeDiameters(await recognizeModelBodyHoles(BODY, 'item-b'))).toEqual([10])
      expect(diameters(await recognizeModelBodyHoles(BODY, 'item-a'))).toEqual([99])
    } finally {
      delete (window as unknown as Record<string, unknown>).__solidsWorkbenchHooks
    }
  }, 60_000)

  it('a replay that finishes after its archive was replaced (new project, undo-and-stash) is not handed out', async () => {
    stashLoadedDocument(plateWithHole(3), 'legacy')
    const read = readModelBodyFeatureResult(BODY, 'legacy')
    replaceLoadedDocumentArchives(new Map([['legacy', plateWithHole(4)]]))
    const result = await read
    expect(holeDiameters(result.verdicts)).toEqual([8])
    expect(result.token.revision).toBe(archiveFeatureResultScope('legacy')!.serial)
  }, 60_000)

  it('a failed replay does not poison the retry; deleting the item drops its memo', async () => {
    stashLoadedDocument(plateWithHole(3), 'legacy')
    let failOnce = true
    __setModelBodyHeadlessClientFactoryForTests(() => {
      mounts++
      const real = createLocalGeomService()
      if (!failOnce) return real
      failOnce = false
      return { ...real, init: () => Promise.reject(new Error('worker failed to start')) }
    })
    await expect(readModelBodyFeatureResult(BODY, 'legacy')).rejects.toThrow('worker failed to start')
    expect(holeDiameters((await readModelBodyFeatureResult(BODY, 'legacy')).verdicts)).toEqual([6])
    expect(mounts).toBe(2)
    disposeModelItem('legacy')
    expect(archiveFeatureResultScope('legacy')).toBeUndefined()
    await expect(readModelBodyFeatureResult(BODY, 'legacy')).rejects.toThrow(/no 3D model/)
  }, 60_000)
})

describe('WO-3202 memo contract', () => {
  it('install replaces by token; retain bounds by token', () => {
    const memo = new FeatureResultMemo()
    const token = (revision: number): ModelBodySourceToken => ({ binderVersion: MODEL_FEATURE_BINDER_VERSION, route: 'archive', modelItemId: 'm', bodyId: 'F1', revision })
    memo.install(bindModelBodyFeatures(token(1), [holeVerdict(6)], { 'F1:wall': wallSnapshot(6) }))
    memo.install(bindModelBodyFeatures(token(2), [holeVerdict(8)], { 'F1:wall': wallSnapshot(8) }))
    memo.install(bindModelBodyFeatures(token(2), [holeVerdict(9)], { 'F1:wall': wallSnapshot(9) }))
    expect(memo.size).toBe(2)
    expect(diameters(memo.completed(token(2))!.verdicts)).toEqual([9])
    memo.retain((t) => t.revision === 2)
    expect(memo.completed(token(1))).toBeUndefined()
    expect(memo.size).toBe(1)
  })
})
