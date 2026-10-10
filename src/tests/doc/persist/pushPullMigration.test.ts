// WO UI-80 (AM2, CF3, R2): the converting LOAD migration that promotes legacy
// push/pull records -- `payload.faceEdits[]` entries of kind 'faceOffset' on an
// owning body feature node -- into first-class sibling `opType: 'pushPull'` DAG
// nodes (visible, deletable, editable). Gates:
//  (1) a genuine pre-UI-80 v3 archive (an extrude with two faceOffset faceEdits)
//      loads with those records REMOVED from the owner and TWO chained pushPull
//      sibling nodes minted in their place (AM2 single-format: no faceEdits
//      faceOffset survives; AM1: the face rides node.refs as a single-face ref);
//  (2) out-of-scope kinds are PRESERVED -- a holeDiameter faceEdit stays on the
//      owner untouched (WO UI-80 scope is faceOffset only);
//  (3) the promoted document round-trips at the current schema (CF3);
//  (4) R2: the same migration runs on a REAL saved archive FILE loaded from disk
//      (coordination/evidence/UI-80/), not only a synthesized in-memory buffer.
//
// FAILS-IF: delete registerMigration(3, migrationV3ToV4) or its faceOffset
// filter (versioning.ts) and (1)/(4) break; change the kind filter to also
// consume holeDiameter and (2) breaks.

import { describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import type { ZipOptions, Zippable } from 'fflate'
import { FeatureDag } from '../../../doc'
import { CURRENT_SCHEMA_VERSION, createDocumentArchive, loadDocumentArchive, stableStringify } from '../../../doc/persist'

const ZIP_OPTIONS: ZipOptions = { level: 0, mtime: new Date(1980, 0, 1, 0, 0, 0), os: 0, attrs: 0 }

function rewriteArchive(
  archive: Uint8Array,
  mutate: (manifest: Record<string, unknown>, document: Record<string, unknown>) => void,
): Uint8Array {
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

/** An extrude body carrying legacy faceEdits: two faceOffset (push/pull) records
 *  plus one holeDiameter (resize-hole) record, in interleaved order. Built at the
 *  current schema, then stamped back to v3 by the caller to simulate a real
 *  pre-UI-80 file. */
function legacyFaceEditsDoc(): FeatureDag {
  const dag = new FeatureDag()
  dag.insertNode({ id: 'SK1', kind: 'sketch', consumes: [], payload: { name: 'Sketch SK1' } })
  dag.insertNode({
    id: 'F1',
    kind: 'feature',
    consumes: ['SK1'],
    payload: {
      opType: 'extrude',
      sketchId: 'SK1',
      distance: 12,
      direction: 'up',
      boolMode: 'newBody',
      name: 'Extrude F1',
      faceEdits: [
        { featureKey: 'F1:BOX:zMax', kind: 'faceOffset', delta: 3 },
        { featureKey: 'F1:BOX:hole', kind: 'holeDiameter', delta: -1 },
        { featureKey: 'F1:BOX:zMax', kind: 'faceOffset', delta: 2 },
      ],
    },
  })
  return dag
}

/** Stamp a current-schema archive back to a genuine pre-UI-80 v3 archive. */
function toLegacyV3(archive: Uint8Array): Uint8Array {
  return rewriteArchive(archive, (manifest) => {
    manifest.schemaVersion = 3
  })
}

interface RawNode {
  id: string
  kind: string
  consumes: string[]
  refs: Array<{ id: string; kind: string }>
  payload: Record<string, unknown>
}

function pushPullNodes(dag: FeatureDag): RawNode[] {
  return dag
    .nodeIds()
    .map((id) => dag.getNode(id)!)
    .filter((n) => n.kind === 'feature' && (n.payload as { opType?: unknown }).opType === 'pushPull')
    .map((n) => ({ id: n.id, kind: n.kind, consumes: n.consumes, refs: n.refs, payload: n.payload })) as RawNode[]
}

describe('WO UI-80 push/pull faceEdits->node migration (versioning.ts v3->v4)', () => {
  it('promotes every faceOffset faceEdit into a chained pushPull sibling node, preserves holeDiameter on the owner', () => {
    const legacy = toLegacyV3(createDocumentArchive({ dag: legacyFaceEditsDoc(), elementMapDeltas: [] }))
    const loaded = loadDocumentArchive(legacy)

    // The v3->v4 migration actually ran (proves the records were genuinely
    // pre-promotion, not synthesized already-migrated).
    expect(loaded.migrationsApplied).toContain(3)
    expect(loaded.manifest.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)

    // AM2: NO faceOffset faceEdit survives on the owner; holeDiameter stays.
    const ownerEdits = (loaded.dag.getNode('F1')!.payload.faceEdits ?? []) as Array<{ kind: string }>
    expect(ownerEdits.some((e) => e.kind === 'faceOffset')).toBe(false)
    expect(ownerEdits.filter((e) => e.kind === 'holeDiameter')).toHaveLength(1)

    // Two chained pushPull sibling nodes were minted (one per faceOffset record).
    const nodes = pushPullNodes(loaded.dag)
    expect(nodes).toHaveLength(2)

    // Each carries the face as a single-face ref (AM1), NOT a raw string in
    // payload; delta migrated from the record; ownerId + consumes form the chain.
    const byDelta = new Map(nodes.map((n) => [n.payload.delta as number, n]))
    const first = byDelta.get(3)!
    const second = byDelta.get(2)!
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(first.refs).toEqual([{ id: 'F1:BOX:zMax', kind: 'single-face' }])
    expect(second.refs).toEqual([{ id: 'F1:BOX:zMax', kind: 'single-face' }])
    // Chain: first consumes the owner F1; second consumes the first.
    expect(first.consumes).toEqual(['F1'])
    expect(second.consumes).toEqual([first.id])
    expect(first.payload.ownerId).toBe('F1')
    expect(second.payload.ownerId).toBe(first.id)
    // No raw faceId string leaked into payload (AM1).
    expect(first.payload.featureKey).toBeUndefined()
  })

  it('round-trips the promoted document at the current schema (CF3)', () => {
    const legacy = toLegacyV3(createDocumentArchive({ dag: legacyFaceEditsDoc(), elementMapDeltas: [] }))
    const migrated = loadDocumentArchive(legacy)
    expect(pushPullNodes(migrated.dag)).toHaveLength(2)

    // Re-serialize the migrated (already v4) document and reload -- the pushPull
    // nodes persist byte-identically, applying NO further migration.
    const reArchive = createDocumentArchive({ dag: migrated.dag, elementMapDeltas: [] })
    const reloaded = loadDocumentArchive(reArchive)
    expect(reloaded.migrationsApplied).toEqual([]) // already current, no migration
    expect(JSON.parse(reloaded.dag.serialize())).toEqual(JSON.parse(migrated.dag.serialize()))
  })

  it('a document with NO faceOffset faceEdits is an identity migration (only holeDiameter)', () => {
    const dag = new FeatureDag()
    dag.insertNode({ id: 'SK1', kind: 'sketch', consumes: [], payload: { name: 'SK1' } })
    dag.insertNode({
      id: 'F1',
      kind: 'feature',
      consumes: ['SK1'],
      payload: { opType: 'extrude', sketchId: 'SK1', distance: 10, direction: 'up', boolMode: 'newBody', name: 'F1', faceEdits: [{ featureKey: 'k', kind: 'holeDiameter', delta: -1 }] },
    })
    const legacy = toLegacyV3(createDocumentArchive({ dag, elementMapDeltas: [] }))
    const loaded = loadDocumentArchive(legacy)
    expect(loaded.migrationsApplied).toContain(3)
    expect(pushPullNodes(loaded.dag)).toHaveLength(0)
    expect((loaded.dag.getNode('F1')!.payload.faceEdits as unknown[]).length).toBe(1)
  })

  // R2: exercise the migration on a REAL saved archive FILE loaded from disk,
  // not only an in-memory buffer. The committed fixture under
  // coordination/evidence/UI-80/ is regenerated by re-running with
  // UI80_WRITE_FIXTURE=1 (the same write-key idiom overlayRuntimeCensus uses);
  // the default run READS it and asserts the promotion, so a fixture that drifts
  // from the loader (or a deleted migration) fails here.
  it('R2: migrates a committed legacy archive file loaded from disk', () => {
    const fixturePath = resolve(process.cwd(), 'test_fixtures/evidence/UI-80/legacy-faceoffset-doc.zip')
    if (process.env.UI80_WRITE_FIXTURE === '1') {
      const legacy = toLegacyV3(createDocumentArchive({ dag: legacyFaceEditsDoc(), elementMapDeltas: [] }))
      mkdirSync(dirname(fixturePath), { recursive: true })
      writeFileSync(fixturePath, legacy)
    }
    expect(existsSync(fixturePath)).toBe(true)
    const bytes = readFileSync(fixturePath)
    const loaded = loadDocumentArchive(bytes)
    expect(loaded.migrationsApplied).toContain(3)
    expect(pushPullNodes(loaded.dag)).toHaveLength(2)
    const ownerEdits = (loaded.dag.getNode('F1')!.payload.faceEdits ?? []) as Array<{ kind: string }>
    expect(ownerEdits.some((e) => e.kind === 'faceOffset')).toBe(false)
  })
})

// ===========================================================================
// WO UI-80-R1 blocker (versioning.ts:migrationV3ToV4): promoting the owner's
// INTRINSIC faceOffset into a sibling chain changes WHO produces the pushed
// body -- so the migration must (a) rewire every pre-existing downstream
// consumer of the owner onto the chain TAIL (else it silently sees the
// un-pushed body), and (b) reconcile the rollback timeline (else the promoted
// edit is appended past a marker that named the owner and silently rolls
// back). These reproduce the auditor's own F1(faceOffset)->F2 + `after F1`
// marker constructions from coordination/reports/UI-80.audit.json as committed
// can-fail gates.
// ===========================================================================
describe('WO UI-80-R1 downstream-consumer rewire + rollback reconciliation (blocker)', () => {
  /** A legacy owner F1 (extrude + ONE faceOffset) with a downstream fillet F2
   *  that consumes F1's (intrinsically pushed) body, and a rollback marker
   *  placed just after the owner. */
  function legacyOwnerWithDownstream(): FeatureDag {
    const dag = new FeatureDag()
    dag.insertNode({ id: 'SK1', kind: 'sketch', consumes: [], payload: { name: 'Sketch SK1' } })
    dag.insertNode({
      id: 'F1',
      kind: 'feature',
      consumes: ['SK1'],
      payload: {
        opType: 'extrude',
        sketchId: 'SK1',
        distance: 12,
        direction: 'up',
        boolMode: 'newBody',
        name: 'Extrude F1',
        faceEdits: [{ featureKey: 'F1:BOX:zMax', kind: 'faceOffset', delta: 3 }],
      },
    })
    // A downstream body consumer of the owner (a fillet on the pushed body).
    dag.insertNode({
      id: 'F2',
      kind: 'feature',
      consumes: ['F1'],
      payload: { opType: 'fillet', ownerId: 'F1', edges: ['F1:BOX:edgeTop'], radius: 1, propagateTangent: true, name: 'Fillet F2' },
    })
    return dag
  }

  function singlePushPullNode(dag: FeatureDag): RawNode {
    const nodes = pushPullNodes(dag)
    expect(nodes).toHaveLength(1)
    return nodes[0]
  }

  it('rewires a downstream consumer of the owner onto the promoted chain TAIL (downstream geometry)', () => {
    const archive = createDocumentArchive({
      dag: legacyOwnerWithDownstream(),
      elementMapDeltas: [],
      rollback: { featureOrder: ['SK1', 'F1', 'F2'], marker: { kind: 'end' } },
    })
    const loaded = loadDocumentArchive(toLegacyV3(archive))
    expect(loaded.migrationsApplied).toContain(3)

    const pp = singlePushPullNode(loaded.dag)
    // The chain head consumes the owner (its un-pushed body)...
    expect(pp.consumes).toEqual(['F1'])
    expect(pp.payload.ownerId).toBe('F1')
    // ...and the pre-existing downstream fillet now consumes the pushPull tail,
    // NOT the owner -- so at regen it evaluates against the PUSHED body. Before
    // the R1 fix F2 still consumed 'F1' (the un-pushed body): this is the
    // can-fail assertion that catches that silent geometry change.
    const f2 = loaded.dag.getNode('F2')!
    expect(f2.consumes).toEqual([pp.id])
    expect(f2.consumes).not.toContain('F1')
  })

  it('rewires a Boolean targetFeatureId identity carrier onto the chain tail', () => {
    const dag = new FeatureDag()
    dag.insertNode({ id: 'SK1', kind: 'sketch', consumes: [], payload: { name: 'SK1' } })
    dag.insertNode({
      id: 'F1',
      kind: 'feature',
      consumes: ['SK1'],
      payload: { opType: 'extrude', sketchId: 'SK1', distance: 12, direction: 'up', boolMode: 'newBody', name: 'F1', faceEdits: [{ featureKey: 'F1:BOX:zMax', kind: 'faceOffset', delta: 3 }] },
    })
    dag.insertNode({ id: 'SK2', kind: 'sketch', consumes: [], payload: { name: 'SK2' } })
    dag.insertNode({ id: 'B1', kind: 'feature', consumes: ['SK2'], payload: { opType: 'extrude', sketchId: 'SK2', distance: 5, direction: 'up', boolMode: 'newBody', name: 'B1' } })
    // A boolean that cuts B1 into the owner body -- its semantic target rides
    // payload.targetFeatureId (bodyLineage.ts), separate from consumes.
    dag.insertNode({
      id: 'F2',
      kind: 'feature',
      consumes: ['F1', 'B1'],
      payload: { opType: 'boolean', boolMode: 'remove', targetFeatureId: 'F1', name: 'Boolean F2' },
    })
    const loaded = loadDocumentArchive(toLegacyV3(createDocumentArchive({ dag, elementMapDeltas: [] })))
    const pp = singlePushPullNode(loaded.dag)
    const f2 = loaded.dag.getNode('F2')!
    // Both the consumes edge AND the targetFeatureId carrier retarget the tail.
    expect(f2.consumes).toContain(pp.id)
    expect(f2.consumes).not.toContain('F1')
    expect(f2.payload.targetFeatureId).toBe(pp.id)
  })

  it('reconciles the rollback timeline: chain spliced after the owner, `after owner` marker remapped to the tail', () => {
    const archive = createDocumentArchive({
      dag: legacyOwnerWithDownstream(),
      elementMapDeltas: [],
      // Timeline rolled to JUST AFTER the owner: legacy semantics show F1 WITH
      // its committed push/pull and everything below (F2) rolled back.
      rollback: { featureOrder: ['SK1', 'F1', 'F2'], marker: { kind: 'after', nodeId: 'F1' } },
    })
    const loaded = loadDocumentArchive(toLegacyV3(archive))
    const pp = singlePushPullNode(loaded.dag)

    // The promoted chain is spliced at the owner's former post-op position.
    expect(loaded.dag.featureOrder()).toEqual(['SK1', 'F1', pp.id, 'F2'])
    // The marker that named the owner now names the chain tail, so the
    // committed push/pull stays APPLIED (not rolled back) while the true
    // downstream (F2) is rolled back -- exactly the legacy owner-intrinsic
    // faceEdit behavior. Before the R1 fix the pushPull was appended past the
    // `after F1` marker and rolled back with F2.
    expect(loaded.dag.getRollbackMarker()).toEqual({ kind: 'after', nodeId: pp.id })
    expect(loaded.dag.isRolledBack(pp.id)).toBe(false)
    expect(loaded.dag.isRolledBack('F1')).toBe(false)
    expect(loaded.dag.rolledBackIds()).toEqual(['F2'])
  })

  it('a marker ABOVE the owner rolls the promoted chain back with the owner', () => {
    const archive = createDocumentArchive({
      dag: legacyOwnerWithDownstream(),
      elementMapDeltas: [],
      // Marker before the owner: the owner (and its intrinsic edit) is rolled back.
      rollback: { featureOrder: ['SK1', 'F1', 'F2'], marker: { kind: 'after', nodeId: 'SK1' } },
    })
    const loaded = loadDocumentArchive(toLegacyV3(archive))
    const pp = singlePushPullNode(loaded.dag)
    // Owner rolled back -> its promoted edit rolls back too (never materializes
    // above the marker). Marker unchanged (it did not name the owner).
    expect(loaded.dag.getRollbackMarker()).toEqual({ kind: 'after', nodeId: 'SK1' })
    expect(loaded.dag.isRolledBack('F1')).toBe(true)
    expect(loaded.dag.isRolledBack(pp.id)).toBe(true)
  })
})

// ===========================================================================
// WO UI-80-R3 criterion 1 (CARRIER CENSUS can-fail cases): the R2 blocker was
// that the migration rewired only `consumes` + `targetFeatureId`, leaving
// `payload.ownerId` (read by fillet/chamfer/shell/draft/hole/defeature/pushPull)
// and `payload.toolFeatureId` (read by boolean) pointed at the superseded owner --
// two live instances of the SAME "has no live body" class. These two fixtures are
// the auditor's ownerId probe and the preflight's confirmed toolFeatureId second
// carrier, committed as can-fail DAG-rewire gates. The census that DERIVES this
// carrier set from the executor read-set lives in carrierCensus.test.ts; these
// prove the migration actually rewires each row.
//
// FAILS-IF: drop 'ownerId' (resp. 'toolFeatureId') from
// BODY_IDENTITY_PAYLOAD_CARRIERS in versioning.ts and the matching assertion
// below refuses -- the downstream consumer keeps naming the dead owner 'F1'.
// ===========================================================================
describe('WO UI-80-R3 carrier census can-fail: v3->v4 rewires ownerId AND toolFeatureId onto the chain tail', () => {
  it('a downstream fillet whose payload.ownerId names a promoted owner retargets the chain TAIL (ownerId carrier)', () => {
    const dag = new FeatureDag()
    dag.insertNode({ id: 'SK1', kind: 'sketch', consumes: [], payload: { name: 'SK1' } })
    dag.insertNode({
      id: 'F1',
      kind: 'feature',
      consumes: ['SK1'],
      payload: { opType: 'extrude', sketchId: 'SK1', distance: 12, direction: 'up', boolMode: 'newBody', name: 'F1', faceEdits: [{ featureKey: 'F1:BOX:zMax', kind: 'faceOffset', delta: 3 }] },
    })
    // A downstream fillet consuming the owner's (intrinsically pushed) body: its
    // body identity rides payload.ownerId, read by lookupLiveBody(p.ownerId).
    dag.insertNode({
      id: 'F2',
      kind: 'feature',
      consumes: ['F1'],
      payload: { opType: 'fillet', ownerId: 'F1', edges: ['F1:BOX:edgeTop'], radius: 1, propagateTangent: true, name: 'Fillet F2' },
    })
    const loaded = loadDocumentArchive(toLegacyV3(createDocumentArchive({ dag, elementMapDeltas: [] })))
    const pp = pushPullNodes(loaded.dag)
    expect(pp).toHaveLength(1)
    const tail = pp[0]
    const f2 = loaded.dag.getNode('F2')!
    // consumes AND the ownerId identity carrier both retarget the tail. Before the
    // R3 fix ownerId stayed 'F1' (the superseded owner) -> the executor's
    // lookupLiveBody(p.ownerId) returns undefined -> "fillet owner F1 has no live body".
    expect(f2.consumes).toEqual([tail.id])
    expect(f2.payload.ownerId).toBe(tail.id)
    expect(f2.payload.ownerId).not.toBe('F1')
  })

  it('a downstream boolean whose payload.toolFeatureId names a promoted owner retargets the chain TAIL (toolFeatureId carrier)', () => {
    const dag = new FeatureDag()
    dag.insertNode({ id: 'SK1', kind: 'sketch', consumes: [], payload: { name: 'SK1' } })
    // F1 is the promotable OWNER carrying a faceOffset, used here as the boolean TOOL.
    dag.insertNode({
      id: 'F1',
      kind: 'feature',
      consumes: ['SK1'],
      payload: { opType: 'extrude', sketchId: 'SK1', distance: 12, direction: 'up', boolMode: 'newBody', name: 'F1', faceEdits: [{ featureKey: 'F1:BOX:zMax', kind: 'faceOffset', delta: 3 }] },
    })
    // A separate target body TB (no faceEdits -> never promoted).
    dag.insertNode({ id: 'SK2', kind: 'sketch', consumes: [], payload: { name: 'SK2' } })
    dag.insertNode({ id: 'TB', kind: 'feature', consumes: ['SK2'], payload: { opType: 'extrude', sketchId: 'SK2', distance: 8, direction: 'up', boolMode: 'newBody', name: 'TB' } })
    // A boolean subtracting the F1 tool from the TB target: TOOL identity rides
    // payload.toolFeatureId, read by the executor at lookupLiveBody(p.toolFeatureId).
    dag.insertNode({
      id: 'F2',
      kind: 'feature',
      consumes: ['TB', 'F1'],
      payload: { opType: 'boolean', boolOp: 'remove', targetFeatureId: 'TB', toolFeatureId: 'F1', name: 'Boolean F2' },
    })
    const loaded = loadDocumentArchive(toLegacyV3(createDocumentArchive({ dag, elementMapDeltas: [] })))
    const pp = pushPullNodes(loaded.dag)
    expect(pp).toHaveLength(1)
    const tail = pp[0]
    const f2 = loaded.dag.getNode('F2')!
    // consumes AND the toolFeatureId carrier retarget the tail; the target (TB, not
    // promoted) is untouched. Before the R3 fix toolFeatureId stayed 'F1' -> the
    // boolean executor's lookupLiveBody(p.toolFeatureId) fails "tool F1 has no live body".
    expect(f2.consumes).toContain(tail.id)
    expect(f2.consumes).not.toContain('F1')
    expect(f2.payload.toolFeatureId).toBe(tail.id)
    expect(f2.payload.toolFeatureId).not.toBe('F1')
    expect(f2.payload.targetFeatureId).toBe('TB')
  })
})

// ===========================================================================
// WO UI-80-R1 MAJOR 2 (CF3/AM2/R2): a GENUINE pre-UI-80 .camproject, exported by
// the pre-UI-80 build at base commit 05c53df8 (that tree's CURRENT_SCHEMA_VERSION
// was 3 -- no UI-80 code, no back-stamping), loaded through the REAL project-open
// boundary (loadDocumentArchive). Provenance recorded here so the fixture can
// never silently drift into a current-code synthesis:
//   generating tree : 05c53df8 (pre-UI-80 main; base of wo/UI-80)
//   file            : test_fixtures/evidence/UI-80/legacy-pushpull-real.camproject
//   sha256          : 5ae8dacaafcba917878ace627d8ae851ce45a65a91a23313b27293b2e81420d5
// The archive carries a real body cache (bodies/F1.brep), element-map history,
// a downstream fillet consuming the owner, and a rollback marker mid-chain. The
// test asserts geometry-determining topology AND rollback AND body-cache survival
// after migration -- the auditor's full list.
// ===========================================================================
describe('WO UI-80-R1 MAJOR 2: real pre-UI-80 .camproject through the load boundary', () => {
  it('migrates a genuine v3 archive: promotes push/pull, rewires downstream, reconciles rollback, keeps body cache', () => {
    const fixturePath = resolve(process.cwd(), 'test_fixtures/evidence/UI-80/legacy-pushpull-real.camproject')
    expect(existsSync(fixturePath)).toBe(true)
    const loaded = loadDocumentArchive(readFileSync(fixturePath))

    // The migration genuinely ran (the file was authentically pre-promotion v3).
    expect(loaded.migrationsApplied).toContain(3)
    expect(loaded.manifest.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)

    // AM2: the two faceOffset records are promoted; the out-of-scope holeDiameter
    // stays on the owner.
    const ownerEdits = (loaded.dag.getNode('F1')!.payload.faceEdits ?? []) as Array<{ kind: string }>
    expect(ownerEdits.some((e) => e.kind === 'faceOffset')).toBe(false)
    expect(ownerEdits.filter((e) => e.kind === 'holeDiameter')).toHaveLength(1)

    // Two chained pushPull siblings (deltas 3 then 2), head consumes owner.
    const pp = pushPullNodes(loaded.dag)
    expect(pp).toHaveLength(2)
    const byDelta = new Map(pp.map((n) => [n.payload.delta as number, n]))
    const head = byDelta.get(3)!
    const tail = byDelta.get(2)!
    expect(head.consumes).toEqual(['F1'])
    expect(tail.consumes).toEqual([head.id])
    // AM1: face rides node.refs, no raw string in payload.
    expect(head.refs).toEqual([{ id: 'F1:BOX:zMax', kind: 'single-face' }])
    expect(head.payload.featureKey).toBeUndefined()

    // Downstream geometry: the pre-existing fillet now consumes the chain TAIL
    // (the pushed body), not the un-pushed owner.
    const fillet = loaded.dag.getNode('F2')!
    expect(fillet.payload.opType).toBe('fillet')
    expect(fillet.consumes).toEqual([tail.id])

    // Rollback reconciled: chain spliced after the owner, `after F1` marker
    // remapped to the tail so the committed push/pull stays applied and only the
    // true downstream is rolled back.
    expect(loaded.dag.featureOrder()).toEqual(['SK1', 'F1', head.id, tail.id, 'F2'])
    expect(loaded.dag.getRollbackMarker()).toEqual({ kind: 'after', nodeId: tail.id })
    expect(loaded.dag.rolledBackIds()).toEqual(['F2'])

    // Geometry resolution: the promoted face ref resolves live in the loaded
    // element map (element-map history survived), so regen produces real
    // geometry rather than a lost reference.
    const res = loaded.elementMap.resolve('F1:BOX:zMax', 'single-face')
    expect(res.status).toBe('exact')
    expect(res.boundTo).toContain('F1:BOX:zMax')

    // The real body cache survived the load boundary.
    expect(loaded.bodyCaches.map((c) => c.bodyId)).toContain('F1')
  })
})
