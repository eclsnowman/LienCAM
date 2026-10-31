// WO-3244: the Mirror (Body Transform) payload persists as plain JSON through
// the modeling archive, which moves to schema 9 by a pure identity migration.
// A schema 8 file opens unchanged and restamped; a file newer than this loader
// is refused, never shown as complete history. Malformed payloads name their
// feature and replay nothing.

import { describe, it, expect, vi } from 'vitest'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import type { ZipOptions, Zippable } from 'fflate'
import type { FeatureDag } from '../../doc'
import { newSeededModelDag } from '../../doc/seedModelArchive'
import {
  CURRENT_SCHEMA_VERSION,
  FutureSchemaVersionError,
  createDocumentArchive,
  loadDocumentArchive,
  stableStringify,
} from '../../doc/persist'
import {
  MirrorReferenceNotCarriedError,
  RewireReplacedBodyConsumersCommand,
  carryReferencesThroughMirror,
  mirroredStableId,
  resolveReferencesThroughMirrors,
  bodyTransformConsumes,
  bodyTransformCyclicChoice,
  mirrorReplacePayload,
  parseBodyTransformPayload,
  replayBodyTransform,
} from '../../doc/features/bodyTransform'
import { bodyTransformRefusalText } from '../../lib/operatorLabels'
import { CommandHistory, CompositeCommand, DagCycleError, FeatureDag as Dag, InsertAtMarkerCommand } from '../../doc'
import { EditFeaturePayloadCommand } from '../../components/model3d/dialogs/EditFeaturePayloadCommand'
import { BODY_IDENTITY_PAYLOAD_CARRIERS } from '../../doc/persist/versioning'
import type { BodyHandle, PlaneDef } from '../../geom/geom-service'

const ZIP_OPTIONS: ZipOptions = { level: 0, mtime: new Date(1980, 0, 1, 0, 0, 0), os: 0, attrs: 0 }

function rewriteArchive(archive: Uint8Array, mutate: (manifest: Record<string, unknown>, document: Record<string, unknown>) => void): Uint8Array {
  const files = unzipSync(archive)
  const manifest = JSON.parse(strFromU8(files['manifest.json'])) as Record<string, unknown>
  const document = JSON.parse(strFromU8(files['document.json'])) as Record<string, unknown>
  mutate(manifest, document)
  files['manifest.json'] = strToU8(stableStringify(manifest))
  files['document.json'] = strToU8(stableStringify(document))
  const zippable: Zippable = {}
  for (const path of Object.keys(files).sort()) zippable[path] = [files[path], ZIP_OPTIONS]
  return zipSync(zippable, ZIP_OPTIONS)
}

function mirrorDoc(withMirror = true): FeatureDag {
  const dag = newSeededModelDag()
  dag.insertNode({ id: 'SK1', kind: 'sketch', consumes: ['datum:XY'], payload: { name: 'Sketch SK1' } })
  dag.insertNode({ id: 'B1', kind: 'feature', consumes: ['SK1'], payload: { opType: 'extrude', sketchId: 'SK1', distance: 10, name: 'Extrude B1' } })
  if (!withMirror) return dag
  const payload = mirrorReplacePayload({ sourceBodyId: 'B1', planeNodeId: 'datum:YZ', name: 'Mirror F2' })
  dag.insertNode({ id: 'F2', kind: 'feature', consumes: bodyTransformConsumes(payload), payload: { ...payload } })
  return dag
}

describe('WO-3244 Body Transform persistence', () => {
  it('the modeling schema is 9', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(9)
  })

  it('round-trips the payload byte-for-byte at schema 9 with no migration applied', () => {
    const dag = mirrorDoc()
    const loaded = loadDocumentArchive(createDocumentArchive({ dag, elementMapDeltas: [] }))
    expect(loaded.manifest.schemaVersion).toBe(9)
    expect(loaded.migrationsApplied).toEqual([])
    const node = loaded.dag.getNode('F2')!
    expect(node.payload).toEqual({
      opType: 'bodyTransform', version: 1, sourceBodyId: 'B1',
      transform: { kind: 'mirror', planeNodeId: 'datum:YZ' }, result: 'replace', name: 'Mirror F2',
    })
    expect([...node.consumes].sort()).toEqual(['B1', 'datum:YZ'])
    expect(parseBodyTransformPayload(node.payload)).toEqual(node.payload)
  })

  it('opens a schema 8 file unchanged, restamped to 9 by the identity step', () => {
    const dag = mirrorDoc(false)
    const current = createDocumentArchive({ dag, elementMapDeltas: [] })
    let v8Document = ''
    const v8 = rewriteArchive(current, (manifest, document) => {
      manifest.schemaVersion = 8
      v8Document = stableStringify(document)
    })
    const loaded = loadDocumentArchive(v8)
    expect(loaded.manifest.schemaVersion).toBe(9)
    // the identity stamp step, like v7 -> v8, records no applied migration
    expect(loaded.migrationsApplied).toEqual([])
    expect(stableStringify(JSON.parse(loaded.dag.serialize()))).toBe(stableStringify((JSON.parse(v8Document) as { dag: unknown }).dag))
  })

  it('refuses a file from a newer loader rather than showing part of its history', () => {
    const newer = rewriteArchive(createDocumentArchive({ dag: mirrorDoc(), elementMapDeltas: [] }), (manifest) => {
      manifest.schemaVersion = 10
    })
    expect(() => loadDocumentArchive(newer)).toThrow(FutureSchemaVersionError)
  })

  it('consumes the source and the plane once each', () => {
    expect(bodyTransformConsumes({ sourceBodyId: 'B1', transform: { kind: 'mirror', planeNodeId: 'datum:YZ' } })).toEqual(['B1', 'datum:YZ'])
    expect(bodyTransformConsumes({ sourceBodyId: 'X', transform: { kind: 'mirror', planeNodeId: 'X' } })).toEqual(['X'])
  })

  it.each([
    ['wrong version', { version: 2 }],
    ['no source', { sourceBodyId: '' }],
    ['no plane', { transform: { kind: 'mirror' } }],
    ['unknown transform', { transform: { kind: 'scale', planeNodeId: 'datum:YZ' } }],
    ['copy result (not in this slice)', { result: 'copy' }],
  ])('a malformed payload (%s) names its feature and calls no kernel', async (_label, patch) => {
    const payload = { ...mirrorReplacePayload({ sourceBodyId: 'B1', planeNodeId: 'datum:YZ', name: 'Mirror F2' }), ...patch }
    expect(parseBodyTransformPayload(payload)).toBeUndefined()
    const transformBody = vi.fn()
    const r = await replayBodyTransform(
      { id: 'F2', kind: 'feature', consumes: ['B1', 'datum:YZ'], refs: [], payload, degraded: false, diagnostics: [], lastGoodBoundTo: {} } as never,
      { client: { transformBody }, lookupLiveBody: () => 1 as BodyHandle, resolvePlane: () => undefined, refusalText: bodyTransformRefusalText },
    )
    expect(r.ok).toBe(false)
    expect(transformBody).not.toHaveBeenCalled()
    expect(String(r.diagnostics[0].params?.reason)).toMatch(/Mirror F2 is missing its body or plane and was not rebuilt/)
  })

  it('replays with the plane frame read at replay time and replace identity', async () => {
    const dag = mirrorDoc()
    const node = dag.getNode('F2')!
    const plane: PlaneDef = { origin: { x: 20, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 }, xDir: { x: 0, y: 1, z: 0 } }
    const transformBody = vi.fn(async () => ({ ok: true, diagnostics: [] }))
    await replayBodyTransform(node, {
      client: { transformBody },
      lookupLiveBody: (id) => (id === 'B1' ? 7 as BodyHandle : undefined),
      resolvePlane: (id) => (id === 'datum:YZ' ? plane : undefined),
      refusalText: bodyTransformRefusalText,
    })
    expect(transformBody).toHaveBeenCalledWith({ featureId: 'F2', body: 7, transform: { kind: 'mirror', plane }, identity: 'replace' })
  })

  it('a consumed source refuses by name', async () => {
    const node = mirrorDoc().getNode('F2')!
    const r = await replayBodyTransform(node, {
      client: { transformBody: vi.fn() },
      lookupLiveBody: () => undefined,
      resolvePlane: () => undefined,
      refusalText: bodyTransformRefusalText,
    })
    expect(String(r.diagnostics[0].params?.reason)).toMatch(/the body it mirrors .* is gone or was already used by a later feature/)
  })

  it('a feature inserted at the rollback marker on the mirrored body carries the rolled-back Mirror onto its new tip', () => {
    expect(BODY_IDENTITY_PAYLOAD_CARRIERS).toContain('sourceBodyId')
    const dag = mirrorDoc()
    const history = new CommandHistory(dag)
    dag.setRollbackMarker({ kind: 'after', nodeId: 'B1' })
    expect(dag.isRolledBack('F2')).toBe(true)
    history.execute(new InsertAtMarkerCommand({ id: 'F3', kind: 'feature', consumes: ['B1'], payload: { opType: 'fillet', ownerId: 'B1', edges: [], radius: 1, name: 'Fillet F3' } }))
    const mirror = dag.getNode('F2')!
    expect(mirror.payload.sourceBodyId).toBe('F3')
    expect([...mirror.consumes].sort()).toEqual(['F3', 'datum:YZ'])
    history.undo()
    expect(dag.getNode('F2')!.payload.sourceBodyId).toBe('B1')
  })

  // Audit fix round, finding 1 (astra's reproduction): B -> fillet F, marker
  // before F; Mirror M inserted at the marker replaces B there, so F moves to M.
  it('a Mirror inserted at the rollback marker carries the later modifiers on its source onto itself', () => {
    const dag = new Dag()
    dag.insertNode({ id: 'B', kind: 'import', payload: {} })
    dag.insertNode({ id: 'P', kind: 'datum', payload: {} })
    dag.insertNode({ id: 'F', kind: 'feature', consumes: ['B'], payload: { opType: 'fillet', ownerId: 'B', edges: [], radius: 1 } })
    dag.insertNode({ id: 'S', kind: 'sketch', consumes: ['B'], payload: { name: 'face sketch' } })
    const later = mirrorReplacePayload({ sourceBodyId: 'B', planeNodeId: 'P', name: 'Mirror L' })
    dag.insertNode({ id: 'L', kind: 'feature', consumes: bodyTransformConsumes(later), payload: { ...later } })
    dag.setRollbackMarker({ kind: 'after', nodeId: 'P' })
    const history = new CommandHistory(dag)
    const p = mirrorReplacePayload({ sourceBodyId: 'B', planeNodeId: 'P', name: 'Mirror' })
    history.execute(new CompositeCommand([
      new InsertAtMarkerCommand({ id: 'M', kind: 'feature', consumes: bodyTransformConsumes(p), payload: { ...p } }),
      new RewireReplacedBodyConsumersCommand('M', 'B'),
    ]))
    expect(dag.featureOrder()).toEqual(['B', 'P', 'M', 'F', 'S', 'L'])
    expect(dag.getNode('F')!.payload.ownerId).toBe('M')
    expect(dag.getNode('F')!.consumes).toEqual(['M'])
    expect(dag.getNode('L')!.payload.sourceBodyId).toBe('M')
    expect([...dag.getNode('L')!.consumes].sort()).toEqual(['M', 'P'])
    // a face sketch names the body by no carrier: it keeps its edge (commands.ts rule)
    expect(dag.getNode('S')!.consumes).toEqual(['B'])
    expect(() => dag.topoOrder()).not.toThrow()
    history.undo()
    expect(dag.getNode('M')).toBeUndefined()
    expect(dag.getNode('F')!.payload.ownerId).toBe('B')
    expect(dag.getNode('F')!.consumes).toEqual(['B'])
    expect(dag.getNode('L')!.payload.sourceBodyId).toBe('B')
    history.redo()
    expect(dag.getNode('F')!.payload.ownerId).toBe('M')
  })

  it('the rewire is all-or-nothing when a later edge would make a cycle', () => {
    const dag = new Dag()
    dag.insertNode({ id: 'B', kind: 'import', payload: {} })
    dag.insertNode({ id: 'P', kind: 'datum', payload: {} })
    const p = mirrorReplacePayload({ sourceBodyId: 'B', planeNodeId: 'P', name: 'Mirror' })
    dag.insertNode({ id: 'M', kind: 'feature', consumes: bodyTransformConsumes(p), payload: { ...p } })
    dag.insertNode({ id: 'F', kind: 'feature', consumes: ['B'], payload: { opType: 'fillet', ownerId: 'B', edges: [], radius: 1 } })
    dag.insertNode({ id: 'G', kind: 'feature', consumes: ['B'], payload: { opType: 'fillet', ownerId: 'B', edges: [], radius: 1 } })
    // make G an ancestor of M, so moving G onto M would loop
    dag.setConsumes('M', ['B', 'P', 'G'])
    expect(() => new RewireReplacedBodyConsumersCommand('M', 'B').do(dag)).toThrow()
    expect(dag.getNode('F')!.payload.ownerId).toBe('B')
    expect(dag.getNode('F')!.consumes).toEqual(['B'])
  })

  // Audit fix round, finding 2: a choice already built from the Mirror's result.
  it('names a plane or body built from the mirror result as a cyclic choice', () => {
    const dag = new Dag()
    dag.insertNode({ id: 'B', kind: 'import', payload: {} })
    dag.insertNode({ id: 'P', kind: 'datum', payload: {} })
    const p = mirrorReplacePayload({ sourceBodyId: 'B', planeNodeId: 'P', name: 'Mirror' })
    dag.insertNode({ id: 'M', kind: 'feature', consumes: bodyTransformConsumes(p), payload: { ...p } })
    dag.insertNode({ id: 'D', kind: 'datum', consumes: ['M'], payload: {} })
    dag.insertNode({ id: 'D2', kind: 'datum', consumes: ['D'], payload: {} })
    expect(bodyTransformCyclicChoice(dag, 'M', ['B', 'P'])).toBeUndefined()
    expect(bodyTransformCyclicChoice(dag, 'M', ['B', 'D'])).toBe('D')
    expect(bodyTransformCyclicChoice(dag, 'M', ['B', 'D2'])).toBe('D2')
    expect(bodyTransformCyclicChoice(dag, 'M', ['M', 'P'])).toBe('M')
    expect(bodyTransformCyclicChoice(dag, 'NOPE', ['B', 'P'])).toBeUndefined()
  })
})

// Audit (astra, both FAIL entries): the two invariants lived only in
// MirrorDialog, so the shared commands still broke them. These run the
// auditor's reproductions on the shared commands alone - every route that
// inserts at the marker or edits a feature's dependencies goes through them.
describe('WO-3244 audit: the shared commands keep the timeline whole', () => {
  it('InsertAtMarkerCommand alone moves a later fillet onto an inserted Mirror (owner M, not B)', () => {
    const dag = new Dag()
    dag.insertNode({ id: 'B', kind: 'import', payload: {} })
    dag.insertNode({ id: 'P', kind: 'datum', payload: {} })
    dag.insertNode({ id: 'F', kind: 'feature', consumes: ['B'], payload: { opType: 'fillet', ownerId: 'B', edges: [], radius: 1 } })
    dag.setRollbackMarker({ kind: 'after', nodeId: 'P' })
    const history = new CommandHistory(dag)
    const p = mirrorReplacePayload({ sourceBodyId: 'B', planeNodeId: 'P', name: 'Mirror' })
    history.execute(new InsertAtMarkerCommand({ id: 'M', kind: 'feature', consumes: bodyTransformConsumes(p), payload: { ...p } }))
    expect({ order: dag.featureOrder(), filletOwner: dag.getNode('F')!.payload.ownerId, filletConsumes: dag.getNode('F')!.consumes })
      .toEqual({ order: ['B', 'P', 'M', 'F'], filletOwner: 'M', filletConsumes: ['M'] })
    expect(() => dag.topoOrder()).not.toThrow()
    history.undo()
    expect(dag.getNode('M')).toBeUndefined()
    expect(dag.getNode('F')!.payload.ownerId).toBe('B')
    expect(dag.getNode('F')!.consumes).toEqual(['B'])
    history.redo()
    expect(dag.getNode('F')!.payload.ownerId).toBe('M')
  })

  it('a transform that keeps its source (not result replace) leaves the later fillet on the source', () => {
    const dag = new Dag()
    dag.insertNode({ id: 'B', kind: 'import', payload: {} })
    dag.insertNode({ id: 'P', kind: 'datum', payload: {} })
    dag.insertNode({ id: 'F', kind: 'feature', consumes: ['B'], payload: { opType: 'fillet', ownerId: 'B', edges: [], radius: 1 } })
    dag.setRollbackMarker({ kind: 'after', nodeId: 'P' })
    const p = { ...mirrorReplacePayload({ sourceBodyId: 'B', planeNodeId: 'P', name: 'Mirror copy' }), result: 'copy' }
    new InsertAtMarkerCommand({ id: 'M', kind: 'feature', consumes: ['B', 'P'], payload: p }).do(dag)
    expect(dag.getNode('F')!.payload.ownerId).toBe('B')
    expect(dag.getNode('F')!.consumes).toEqual(['B'])
  })

  it('the insert-at-marker rewire is all-or-nothing: a looping edge unwinds the insert and every moved carrier', () => {
    const dag = new Dag()
    dag.insertNode({ id: 'B', kind: 'import', payload: {} })
    dag.insertNode({ id: 'P', kind: 'datum', payload: {} })
    dag.insertNode({ id: 'F', kind: 'feature', consumes: ['B'], payload: { opType: 'fillet', ownerId: 'B', edges: [], radius: 1 } })
    dag.insertNode({ id: 'G', kind: 'feature', consumes: ['B'], payload: { opType: 'fillet', ownerId: 'B', edges: [], radius: 1 } })
    // the plane is built from G, so moving G onto a Mirror placed by that plane would loop
    dag.setConsumes('P', ['G'])
    dag.setRollbackMarker({ kind: 'after', nodeId: 'P' })
    const history = new CommandHistory(dag)
    const p = mirrorReplacePayload({ sourceBodyId: 'B', planeNodeId: 'P', name: 'Mirror' })
    expect(() => history.execute(new InsertAtMarkerCommand({ id: 'M', kind: 'feature', consumes: bodyTransformConsumes(p), payload: { ...p } })))
      .toThrow(DagCycleError)
    expect(history.size()).toBe(0)
    expect(dag.getNode('M')).toBeUndefined()
    expect(dag.featureOrder()).toEqual(['B', 'P', 'F', 'G'])
    expect(dag.getNode('F')!.payload.ownerId).toBe('B')
    expect(dag.getNode('F')!.consumes).toEqual(['B'])
    expect(dag.getNode('G')!.consumes).toEqual(['B'])
  })

  it('EditFeaturePayloadCommand refuses a Mirror plane built from the Mirror (DAG_CYCLE) and changes nothing', () => {
    const dag = new Dag()
    dag.insertNode({ id: 'B', kind: 'import', payload: {} })
    dag.insertNode({ id: 'P', kind: 'datum', payload: {} })
    dag.insertNode({ id: 'P2', kind: 'datum', payload: {} })
    const p = mirrorReplacePayload({ sourceBodyId: 'B', planeNodeId: 'P', name: 'Mirror' })
    dag.insertNode({ id: 'M', kind: 'feature', consumes: bodyTransformConsumes(p), payload: { ...p } })
    dag.insertNode({ id: 'D', kind: 'datum', consumes: ['M'], payload: {} })
    dag.insertNode({ id: 'D2', kind: 'datum', consumes: ['D'], payload: {} })
    const history = new CommandHistory(dag)
    for (const plane of ['D', 'D2', 'M']) {
      const next = mirrorReplacePayload({ sourceBodyId: 'B', planeNodeId: plane, name: 'Mirror' })
      let caught: unknown
      try { history.execute(new EditFeaturePayloadCommand('M', { ...next }, bodyTransformConsumes(next))) } catch (err) { caught = err }
      expect({ mirrorConsumes: dag.getNode('M')!.consumes, plane: dag.getNode('M')!.payload.transform }, plane)
        .toEqual({ mirrorConsumes: ['B', 'P'], plane: { kind: 'mirror', planeNodeId: 'P' } })
      expect(() => dag.topoOrder(), plane).not.toThrow()
      expect(caught, plane).toBeInstanceOf(DagCycleError)
      expect((caught as DagCycleError).diagnostic.params, plane).toEqual({ consumer: 'M', producer: plane })
      expect(dag.featureOrder(), plane).toEqual(['B', 'P', 'P2', 'M', 'D', 'D2'])
      expect(history.size(), plane).toBe(0)
    }
    // an independent plane still edits, keeping the id and timeline slot
    const next = mirrorReplacePayload({ sourceBodyId: 'B', planeNodeId: 'P2', name: 'Mirror' })
    history.execute(new EditFeaturePayloadCommand('M', { ...next }, bodyTransformConsumes(next)))
    expect(dag.getNode('M')!.consumes).toEqual(['B', 'P2'])
    expect(dag.featureOrder()).toEqual(['B', 'P', 'P2', 'M', 'D', 'D2'])
    history.undo()
    expect(dag.getNode('M')!.consumes).toEqual(['B', 'P'])
  })
})

// Audit round 2 named the references; audit round 3 found them frozen at the
// insertion. Now a later feature KEEPS its own references and stored world
// positions; the one resolver both replay routes call maps them through each
// Mirror with that Mirror's CURRENT plane, by name. Anything with no named form
// on the reflection refuses the insert by feature and reference, and nothing is
// written.
describe('WO-3244 audit rounds 2-3: references resolved through the mirror', () => {
  const X0: PlaneDef = { origin: { x: 0, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 }, xDir: { x: 0, y: 1, z: 0 } }
  const X20: PlaneDef = { origin: { x: 20, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 }, xDir: { x: 0, y: 1, z: 0 } }
  const OBLIQUE: PlaneDef = { origin: { x: 2, y: 0, z: 0 }, normal: { x: Math.SQRT1_2, y: Math.SQRT1_2, z: 0 }, xDir: { x: 0, y: 0, z: 1 } }
  const round = (v: { x: number; y: number; z: number }) => [v.x, v.y, v.z].map((n) => Math.round(n * 1e9) / 1e9 || 0)

  it('renames faces, edges, seams and vertices onto the mirrored body and reflects an edge disambiguator', () => {
    expect(mirroredStableId('M', 'B:BOX:zMax')).toBe('M:PAT:i1:B:BOX:zMax')
    expect(mirroredStableId('M', '(B:BOX:xMax∧B:BOX:yMax)')).toBe('(M:PAT:i1:B:BOX:xMax∧M:PAT:i1:B:BOX:yMax)')
    // a band face nests its own edge id; the outer split is depth-aware
    expect(mirroredStableId('M', '(F5:FIL:(B:BOX:xMax∧B:BOX:yMax)∧B:BOX:zMax)'))
      .toBe('(M:PAT:i1:B:BOX:zMax∧M:PAT:i1:F5:FIL:(B:BOX:xMax∧B:BOX:yMax))')
    expect(mirroredStableId('M', '(C:XTR:S1.e1:side∧seam#0)')).toBe('(M:PAT:i1:C:XTR:S1.e1:side∧seam#0)')
    expect(mirroredStableId('M', '(A∧B∧C)')).toBe('(M:PAT:i1:A∧M:PAT:i1:B∧M:PAT:i1:C)')
    expect(mirroredStableId('M', '(orphan∧seam#0)')).toBeUndefined()
    // mid (10, 3, 2) reflected in x=20 is (30, 3, 2); the length is kept
    const reflect = (p: { x: number; y: number; z: number }) => ({ x: 40 - p.x, y: p.y, z: p.z })
    expect(mirroredStableId('M', '(A∧B)@m100000000_30000000_20000000_l50000000', { reflectPoint: reflect }))
      .toBe('(M:PAT:i1:A∧M:PAT:i1:B)@m300000000_30000000_20000000_l50000000')
    expect(mirroredStableId('M', '(A∧B)@m100000000_30000000_20000000_l50000000')).toBeUndefined()
  })

  it('an id already on the mirrored result, or on a band a later modifier made from one, renames to itself', () => {
    expect(mirroredStableId('M', 'M:PAT:i1:B:BOX:zMax')).toBe('M:PAT:i1:B:BOX:zMax')
    const onResult = '(M:PAT:i1:B:BOX:xMax∧M:PAT:i1:B:BOX:yMax)@m100000000_30000000_20000000_l50000000'
    expect(mirroredStableId('M', onResult)).toBe(onResult)
    const downstream = new Set(['F'])
    expect(mirroredStableId('M', 'F:FIL:(M:PAT:i1:B:BOX:xMax∧M:PAT:i1:B:BOX:yMax)', undefined, downstream))
      .toBe('F:FIL:(M:PAT:i1:B:BOX:xMax∧M:PAT:i1:B:BOX:yMax)')
    // named before the mirror: the band is renamed through its own edge
    expect(mirroredStableId('M', 'F:FIL:(B:BOX:xMax∧B:BOX:yMax)', undefined, downstream))
      .toBe('F:FIL:(M:PAT:i1:B:BOX:xMax∧M:PAT:i1:B:BOX:yMax)')
    expect(mirroredStableId('M', 'F:SHL:B:BOX:zMax:inner', undefined, downstream)).toBe('F:SHL:M:PAT:i1:B:BOX:zMax:inner')
    // a hole wall names no other face: it keeps its name
    expect(mirroredStableId('M', 'F:HOL:i0:wall', undefined, downstream)).toBe('F:HOL:i0:wall')
    // a modifier upstream of the mirror is just a face of the source
    expect(mirroredStableId('M', 'F:FIL:(B:BOX:xMax∧B:BOX:yMax)')).toBe('M:PAT:i1:F:FIL:(B:BOX:xMax∧B:BOX:yMax)')
  })

  it('a hole keeps its face and lands at the reflected points (the order\'s oblique oracle)', () => {
    const hole = carryReferencesThroughMirror({
      id: 'H', refs: [{ id: 'B:BOX:zMax', kind: 'single-face' }],
      payload: { opType: 'hole', ownerId: 'M', faceId: 'B:BOX:zMax', points: [{ x: 3, y: 4, z: 5 }], seed: { x: 3, y: 4, z: 5 }, normal: { x: 0, y: 0, z: 1 } },
    }, 'M', OBLIQUE)
    expect(hole.payload.faceId).toBe('M:PAT:i1:B:BOX:zMax')
    expect(hole.refs).toEqual([{ id: 'M:PAT:i1:B:BOX:zMax', kind: 'single-face' }])
    // plane (2,0,0), normal (1,1,0)/sqrt2 maps (3,4,5) to (-2,-1,5)
    const [pt] = hole.payload.points as Array<{ x: number; y: number; z: number }>
    expect(round(pt)).toEqual([-2, -1, 5])
    // a hole placed on the mirrored result is already there: nothing moves
    const after = carryReferencesThroughMirror({
      id: 'H', refs: [], payload: { opType: 'hole', ownerId: 'M', faceId: 'M:PAT:i1:B:BOX:zMax', points: [{ x: -3, y: 3, z: 4 }] },
    }, 'M', OBLIQUE)
    expect(after.payload.points).toEqual([{ x: -3, y: 3, z: 4 }])
  })

  it('a draft pull and neutral plane follow ANY mirror plane - in it, along its normal or oblique', () => {
    const draft = (pullAxis: string, pullFlip: boolean, offset: number) => ({
      id: 'D', refs: [], payload: { opType: 'draft', ownerId: 'M', faces: ['B:BOX:xMax'], angleDeg: 3, pullAxis, pullFlip, offset },
    })
    const frame = (plane: PlaneDef, d: ReturnType<typeof draft>) => {
      const out = carryReferencesThroughMirror(d, 'M', plane).payload
      expect(out).toMatchObject({ pullMode: 'face-normal', pullFlip: false, offset: 0, faces: ['M:PAT:i1:B:BOX:xMax'] })
      const f = out.faceFrame as { origin: { x: number; y: number; z: number }; normal: { x: number; y: number; z: number } }
      return { origin: round(f.origin), normal: round(f.normal) }
    }
    // pull +z lies in the plane x=20: unchanged pull, neutral plane z=1 kept
    expect(frame(X20, draft('z', false, 1))).toEqual({ origin: [40, 0, 1], normal: [0, 0, 1] })
    // pull +x along the normal: the pull flips and the neutral plane x=1 lands at x=39
    expect(frame(X20, draft('x', false, 1))).toEqual({ origin: [39, 0, 0], normal: [-1, 0, 0] })
    // oblique (audit round 3): +x reflects to -y and the neutral plane x=1 to y=1
    expect(frame(OBLIQUE, draft('x', false, 1))).toEqual({ origin: [2, 1, 0], normal: [0, -1, 0] })
    // a selected-face draft reflects its own frame
    const faceDraft = { id: 'D', refs: [], payload: { opType: 'draft', ownerId: 'M', faces: ['B:BOX:xMax'], faceFrameSourceId: 'B:BOX:zMin', angleDeg: 3, pullAxis: 'z', pullFlip: true, offset: 2, pullMode: 'face-normal', faceFrame: { origin: { x: 1, y: 1, z: 0 }, normal: { x: 0, y: 0, z: -1 } } } }
    const out = carryReferencesThroughMirror(faceDraft, 'M', X20).payload
    expect(out.faceFrameSourceId).toBe('M:PAT:i1:B:BOX:zMin')
    const f = out.faceFrame as { origin: { x: number; y: number; z: number }; normal: { x: number; y: number; z: number } }
    // pull = -(0,0,-1) = +z, neutral origin (1,1,0)+2z = (1,1,2), reflected in x=20
    expect({ origin: round(f.origin), normal: round(f.normal) }).toEqual({ origin: [39, 1, 2], normal: [0, 0, 1] })
    expect(() => carryReferencesThroughMirror(draft('x', false, 1), 'M', undefined)).toThrow(/noPlane/)
  })

  // Audit round 3, finding 1 at command level: the stored hole never changes;
  // what the replay is given follows the plane where it is NOW.
  it('resolves a later hole through the mirror plane where it is at each replay; the stored node never changes', () => {
    const dag = new Dag()
    dag.insertNode({ id: 'B', kind: 'import', payload: {} })
    dag.insertNode({ id: 'P', kind: 'datum', payload: {} })
    const hole = { opType: 'hole', ownerId: 'B', faceId: 'B:BOX:zMax', points: [{ x: 3, y: 3, z: 4 }], style: { kind: 'simple', diameter: 1 }, depth: { kind: 'blind', distance: 2 } }
    dag.insertNode({ id: 'H', kind: 'feature', consumes: ['B'], refs: [{ id: 'B:BOX:zMax', kind: 'single-face' }], payload: hole })
    dag.setRollbackMarker({ kind: 'after', nodeId: 'P' })
    const p = mirrorReplacePayload({ sourceBodyId: 'B', planeNodeId: 'P', name: 'Mirror' })
    const insert = new CompositeCommand([
      new InsertAtMarkerCommand({ id: 'M', kind: 'feature', consumes: bodyTransformConsumes(p), payload: { ...p } }),
      new RewireReplacedBodyConsumersCommand('M', 'B'),
    ])
    insert.do(dag)
    dag.setRollbackMarker({ kind: 'end' })
    const stored = dag.getNode('H')!
    expect(stored.payload).toEqual({ ...hole, ownerId: 'M' })
    expect(stored.consumes).toEqual(['M'])
    for (const [plane, x] of [[X0, -3], [X20, 37]] as const) {
      const r = resolveReferencesThroughMirrors(dag, dag.getNode('H')!, (id) => (id === 'P' ? plane : undefined))
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.node.payload.faceId).toBe('M:PAT:i1:B:BOX:zMax')
      expect(r.node.refs.map((ref) => ref.id)).toEqual(['M:PAT:i1:B:BOX:zMax'])
      expect((r.node.payload.points as Array<{ x: number }>)[0].x).toBe(x)
      expect(dag.getNode('H')!.payload).toEqual({ ...hole, ownerId: 'M' })
    }
    // the plane does not resolve: the position cannot be reflected, named
    const lost = resolveReferencesThroughMirrors(dag, dag.getNode('H')!, () => undefined)
    expect(lost.ok).toBe(false)
    if (!lost.ok) expect(lost.error).toMatchObject({ featureId: 'H', kind: 'noPlane', mirrorId: 'M' })
    // undoing the insert puts the hole back on B; nothing is resolved any more
    insert.undo(dag)
    const back = resolveReferencesThroughMirrors(dag, dag.getNode('H')!, () => X20)
    expect(back.ok && back.node.payload).toEqual(hole)
  })

  it('resolves through a modifier between the mirror and the feature, and through two mirrors in a row', () => {
    const dag = new Dag()
    dag.insertNode({ id: 'B', kind: 'import', payload: {} })
    dag.insertNode({ id: 'P', kind: 'datum', payload: {} })
    dag.insertNode({ id: 'Q', kind: 'datum', payload: {} })
    const m1 = mirrorReplacePayload({ sourceBodyId: 'B', planeNodeId: 'P', name: 'Mirror 1' })
    dag.insertNode({ id: 'M1', kind: 'feature', consumes: bodyTransformConsumes(m1), payload: { ...m1 } })
    // F and C were authored on B; M1 was inserted before F later
    dag.insertNode({ id: 'F', kind: 'feature', consumes: ['M1'], payload: { opType: 'fillet', ownerId: 'M1', edges: ['(B:BOX:xMax∧B:BOX:yMax)'], radius: 1 } })
    dag.insertNode({ id: 'C', kind: 'feature', consumes: ['F'], payload: { opType: 'chamfer', ownerId: 'F', edges: ['(B:BOX:zMax∧F:FIL:(B:BOX:xMax∧B:BOX:yMax))'], distance: 0.5 } })
    const c = resolveReferencesThroughMirrors(dag, dag.getNode('C')!, () => X20)
    expect(c.ok && c.node.payload.edges).toEqual(['(F:FIL:(M:PAT:i1:B:BOX:xMax∧M:PAT:i1:B:BOX:yMax)∧M:PAT:i1:B:BOX:zMax)'.replace(/M:PAT/g, 'M1:PAT')])
    // a second mirror after M1, then a hole authored on B: reflected twice
    const m2 = mirrorReplacePayload({ sourceBodyId: 'C', planeNodeId: 'Q', name: 'Mirror 2' })
    dag.insertNode({ id: 'M2', kind: 'feature', consumes: bodyTransformConsumes(m2), payload: { ...m2 } })
    dag.insertNode({ id: 'H', kind: 'feature', consumes: ['M2'], payload: { opType: 'hole', ownerId: 'M2', faceId: 'B:BOX:zMax', points: [{ x: 3, y: 3, z: 4 }] } })
    const planes: Record<string, PlaneDef> = { P: X0, Q: X20 }
    const h = resolveReferencesThroughMirrors(dag, dag.getNode('H')!, (id) => planes[id])
    expect(h.ok && h.node.payload.faceId).toBe('M2:PAT:i1:M1:PAT:i1:B:BOX:zMax')
    // x=3 -> x=0 gives -3 -> x=20 gives 43
    expect(h.ok && (h.node.payload.points as Array<{ x: number }>)[0].x).toBe(43)
    // a hole authored on M1's result is reflected by M2 only
    dag.setPayload('H', { ...dag.getNode('H')!.payload, faceId: 'M1:PAT:i1:B:BOX:zMax', points: [{ x: -3, y: 3, z: 4 }] })
    const h1 = resolveReferencesThroughMirrors(dag, dag.getNode('H')!, (id) => planes[id])
    expect(h1.ok && (h1.node.payload.points as Array<{ x: number }>)[0].x).toBe(43)
  })

  it('a later feature the mirror cannot carry refuses the insert by feature and reference, and nothing is written', () => {
    const dag = new Dag()
    dag.insertNode({ id: 'B', kind: 'import', payload: {} })
    dag.insertNode({ id: 'P', kind: 'datum', payload: {} })
    dag.insertNode({ id: 'F', kind: 'feature', consumes: ['B'], payload: { opType: 'fillet', ownerId: 'B', edges: ['(B:BOX:xMax∧B:BOX:yMax)'], radius: 1 } })
    dag.insertNode({ id: 'K', kind: 'feature', consumes: ['F'], payload: { opType: 'defeature', ownerId: 'F', featureKeys: ['hole@1'], name: 'Defeature' } })
    dag.insertNode({ id: 'R', kind: 'feature', consumes: ['B'], payload: { opType: 'defeature', ownerId: 'B', featureKeys: ['hole@2'], name: 'Defeature R' } })
    dag.setRollbackMarker({ kind: 'after', nodeId: 'P' })
    const history = new CommandHistory(dag)
    const p = mirrorReplacePayload({ sourceBodyId: 'B', planeNodeId: 'P', name: 'Mirror' })
    const insert = () => history.execute(new CompositeCommand([
      new InsertAtMarkerCommand({ id: 'M', kind: 'feature', consumes: bodyTransformConsumes(p), payload: { ...p } }),
      new RewireReplacedBodyConsumersCommand('M', 'B'),
    ]))
    let caught: unknown
    try { insert() } catch (err) { caught = err }
    // K sits on F, which moves onto the mirror: its recognized key has no
    // named form on the reflection either (round 2 checked direct consumers only)
    expect(caught).toBeInstanceOf(MirrorReferenceNotCarriedError)
    expect(caught).toMatchObject({ featureId: 'K', reference: 'hole@1', kind: 'notCarried' })
    expect(history.size()).toBe(0)
    expect(dag.getNode('M')).toBeUndefined()
    expect(dag.getNode('F')!.payload).toMatchObject({ ownerId: 'B', edges: ['(B:BOX:xMax∧B:BOX:yMax)'] })
    expect(dag.getNode('F')!.consumes).toEqual(['B'])
    dag.removeNode('K')
    caught = undefined
    try { insert() } catch (err) { caught = err }
    expect(caught).toMatchObject({ featureId: 'R', reference: 'hole@2', kind: 'notCarried' })
    expect(history.size()).toBe(0)
  })

  it('undo moves the later feature back with its own edges; the stored edges are never rewritten', () => {
    const dag = new Dag()
    dag.insertNode({ id: 'B', kind: 'import', payload: {} })
    dag.insertNode({ id: 'P', kind: 'datum', payload: {} })
    const own = '(B:BOX:xMax∧B:BOX:yMax)'
    dag.insertNode({ id: 'F', kind: 'feature', consumes: ['B'], refs: [{ id: own, kind: 'single-edge' }], payload: { opType: 'chamfer', ownerId: 'B', edges: [own], distance: 1 } })
    dag.setRollbackMarker({ kind: 'after', nodeId: 'P' })
    const history = new CommandHistory(dag)
    const p = mirrorReplacePayload({ sourceBodyId: 'B', planeNodeId: 'P', name: 'Mirror' })
    history.execute(new CompositeCommand([
      new InsertAtMarkerCommand({ id: 'M', kind: 'feature', consumes: bodyTransformConsumes(p), payload: { ...p } }),
      new RewireReplacedBodyConsumersCommand('M', 'B'),
    ]))
    const carried = '(M:PAT:i1:B:BOX:xMax∧M:PAT:i1:B:BOX:yMax)'
    expect(dag.getNode('F')!.payload).toMatchObject({ ownerId: 'M', edges: [own] })
    expect(dag.getNode('F')!.refs.map((r) => r.id)).toEqual([own])
    const resolved = resolveReferencesThroughMirrors(dag, dag.getNode('F')!, () => X20)
    expect(resolved.ok && resolved.node.payload.edges).toEqual([carried])
    expect(resolved.ok && resolved.node.refs.map((r) => r.id)).toEqual([carried])
    history.undo()
    expect(dag.getNode('F')!.payload).toMatchObject({ ownerId: 'B', edges: [own] })
    const back = resolveReferencesThroughMirrors(dag, dag.getNode('F')!, () => X20)
    expect(back.ok && back.node.payload.edges).toEqual([own])
    history.redo()
    expect(dag.getNode('F')!.payload).toMatchObject({ ownerId: 'M', edges: [own] })
  })
})
