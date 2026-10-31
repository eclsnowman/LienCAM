import { describe, it, expect, vi } from 'vitest'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import type { ZipOptions, Zippable } from 'fflate'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ElementMap, FeatureDag, applyFeatureDelta } from '../../../doc'
import {
  AutosaveController,
  CURRENT_SCHEMA_VERSION,
  FutureSchemaVersionError,
  InMemoryDocumentStorage,
  createDocumentArchive,
  loadDocumentArchive,
  replaceArchiveDrawings,
  stableStringify,
  recoverAutosave,
  type DocumentSaveInput,
} from '../../../doc/persist'
import type { ElementMapDelta, GeometrySnapshot } from '../../../geom/geom-service'

const TOP = 'F1:BOX:zmax'
const ZMIN = 'F1:BOX:zmin'
const SIDE = 'F1:BOX:xmax'
const FRAG0 = 'F2:CUT:(' + TOP + ')#0'
const FRAG1 = 'F2:CUT:(' + TOP + ')#1'
const CUT_WALL = 'F2:CUT:new#0'
const FILLET = 'F3:FIL:(' + FRAG0 + ')'
const ZIP_OPTIONS: ZipOptions = { level: 0, mtime: new Date(1980, 0, 1, 0, 0, 0), os: 0, attrs: 0 }

interface ScriptedOptions {
  reversed?: boolean
  parameterWidth?: number
}

interface ScriptedDocument {
  input: DocumentSaveInput
  dag: FeatureDag
  elementMap: ElementMap
  splitWinner: string
}

const plane = (
  centroid: GeometrySnapshot['centroid'],
  area: number,
  normal = { x: 0, y: 0, z: 1 },
): GeometrySnapshot => ({
  surfaceType: 'plane',
  centroid,
  area,
  normal,
})

const topSnap = plane({ x: 0, y: 0, z: 10 }, 100)
const zminSnap = plane({ x: 0, y: 0, z: -10 }, 100, { x: 0, y: 0, z: -1 })
const sideSnap = plane({ x: 20, y: 0, z: 0 }, 200, { x: 1, y: 0, z: 0 })
const frag0Snap = plane({ x: 0.02, y: 0, z: 10 }, 62)
const frag1Snap = plane({ x: 5, y: 5, z: 10 }, 38)
const cutWallSnap = plane({ x: 1, y: 1, z: 6 }, 25, { x: 0, y: 1, z: 0 })
const filletSnap = plane({ x: 0.2, y: 0, z: 9.8 }, 12, { x: 0, y: 1, z: 0 })

function scriptedDocument(options: ScriptedOptions = {}): ScriptedDocument {
  const reversed = options.reversed ?? false
  const width = options.parameterWidth ?? 40
  const dag = new FeatureDag()
  const boxPayload = reversed
    ? { size: { z: 10, y: 20, x: width }, op: 'box' }
    : { op: 'box', size: { x: width, y: 20, z: 10 } }
  const cutPayload = reversed
    ? { through: true, diameter: 6, op: 'cut' }
    : { op: 'cut', diameter: 6, through: true }
  const filletPayload = reversed ? { radius: 1.5, op: 'fillet' } : { op: 'fillet', radius: 1.5 }

  if (reversed) {
    dag.insertNode({ id: 'F3', kind: 'feature', consumes: ['F2'], refs: [{ id: FRAG0, kind: 'face-set' }], payload: filletPayload })
    dag.insertNode({ id: 'F2', kind: 'feature', consumes: ['F1'], refs: [{ id: TOP, kind: 'single-face' }], payload: cutPayload })
    dag.insertNode({ id: 'F1', kind: 'feature', consumes: [], refs: [], payload: boxPayload })
  } else {
    dag.insertNode({ id: 'F1', kind: 'feature', consumes: [], refs: [], payload: boxPayload })
    dag.insertNode({ id: 'F2', kind: 'feature', consumes: ['F1'], refs: [{ id: TOP, kind: 'single-face' }], payload: cutPayload })
    dag.insertNode({ id: 'F3', kind: 'feature', consumes: ['F2'], refs: [{ id: FRAG0, kind: 'face-set' }], payload: filletPayload })
  }

  const boxDelta: ElementMapDelta = reversed
    ? {
        featureId: 'F1',
        generated: [SIDE, ZMIN, TOP],
        modified: {},
        deleted: [],
        geometry: { [SIDE]: sideSnap, [ZMIN]: zminSnap, [TOP]: topSnap },
      }
    : {
        featureId: 'F1',
        generated: [TOP, ZMIN, SIDE],
        modified: {},
        deleted: [],
        geometry: { [TOP]: topSnap, [ZMIN]: zminSnap, [SIDE]: sideSnap },
      }
  const splitDelta: ElementMapDelta = reversed
    ? {
        featureId: 'F2',
        generated: [CUT_WALL],
        modified: { [TOP]: [FRAG1, FRAG0] },
        deleted: [],
        geometry: { [CUT_WALL]: cutWallSnap, [FRAG1]: frag1Snap, [FRAG0]: frag0Snap },
      }
    : {
        featureId: 'F2',
        generated: [CUT_WALL],
        modified: { [TOP]: [FRAG0, FRAG1] },
        deleted: [],
        geometry: { [FRAG0]: frag0Snap, [FRAG1]: frag1Snap, [CUT_WALL]: cutWallSnap },
      }
  // The fillet consumes ZMIN (deleted) so the round-trip goldens exercise
  // DELETED-id bookkeeping too, not just live ids — the R1 audit's minor:
  // without a deletion in the script, serializeIds() equality could not
  // catch a regression that drops deleted-id/lineage records on load.
  const filletDelta: ElementMapDelta = reversed
    ? {
        featureId: 'F3',
        generated: [FILLET],
        modified: {},
        deleted: [ZMIN],
        geometry: { [FILLET]: filletSnap },
      }
    : {
        featureId: 'F3',
        generated: [FILLET],
        modified: {},
        deleted: [ZMIN],
        geometry: { [FILLET]: filletSnap },
      }

  const elementMap = new ElementMap()
  for (const delta of [boxDelta, splitDelta, filletDelta]) applyFeatureDelta(elementMap, delta)
  dag.regenerate(elementMap)

  return {
    input: {
      dag,
      elementMapDeltas: [boxDelta, splitDelta, filletDelta],
      parameters: reversed ? { units: 'mm', width } : { width, units: 'mm' },
      sketches: reversed ? [{ entities: ['e1', 'e2'], sketchId: 'S1' }] : [{ sketchId: 'S1', entities: ['e1', 'e2'] }],
      camBindings: reversed ? [{ stableIds: [FRAG0], opId: 'CAM1' }] : [{ opId: 'CAM1', stableIds: [FRAG0] }],
      bodyCaches: [
        {
          bodyId: 'body-final',
          bytes: new Uint8Array([7, 1, 7, 3, 0]),
          elementMap: filletDelta,
        },
      ],
    },
    dag,
    elementMap,
    splitWinner: FRAG0,
  }
}

function asArray(bytes: Uint8Array): number[] {
  return [...bytes]
}

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

describe('DOC-3 document archive persistence', () => {
  it('round-trips DAG, element-map snapshots, parameters, and BREP body cache bytes through the zip format', () => {
    const built = scriptedDocument()
    const archive = createDocumentArchive(built.input)
    const loaded = loadDocumentArchive(archive)

    expect(JSON.parse(loaded.dag.serialize())).toEqual(JSON.parse(built.dag.serialize()))
    expect(JSON.parse(loaded.elementMap.serializeIds())).toEqual(JSON.parse(built.elementMap.serializeIds()))
    expect(loaded.elementMap.liveIds()).toEqual(built.elementMap.liveIds())
    expect(loaded.elementMap.resolve(TOP, 'single-face')).toMatchObject({ status: 'exact', via: 'lineage', boundTo: [FRAG0] })
    expect(loaded.elementMap.snapshotOf(TOP)).toEqual(topSnap)
    expect(loaded.elementMap.snapshotOf(FRAG0)).toEqual(frag0Snap)
    expect(loaded.elementMap.snapshotOf(FRAG1)).toEqual(frag1Snap)
    expect(loaded.dag.getNode('F2')!.degraded).toBe(false)
    expect(loaded.dag.getNode('F2')!.lastGoodBoundTo[TOP]).toEqual([built.splitWinner])
    expect(loaded.parameters).toEqual({ units: 'mm', width: 40 })
    expect(loaded.bodyCaches).toHaveLength(1)
    expect(asArray(loaded.bodyCaches[0].bytes)).toEqual([7, 1, 7, 3, 0])
    expect(loaded.bodyCaches[0].elementMap.geometry![FILLET]).toEqual(filletSnap)
  })

  it('is sensitive to dropped inline geometry snapshots on load', () => {
    const archive = createDocumentArchive(scriptedDocument().input)
    const corrupted = rewriteArchive(archive, (_manifest, document) => {
      const deltas = document.elementMapDeltas as Array<{ geometry?: Record<string, unknown> }>
      delete deltas[1].geometry![FRAG0]
    })

    const loaded = loadDocumentArchive(corrupted)
    expect(loaded.elementMap.snapshotOf(FRAG0)).toBeUndefined()
    expect(loaded.elementMap.resolve(TOP, 'single-face').boundTo).toEqual([FRAG1])
    expect(loaded.dag.getNode('F2')!.lastGoodBoundTo[TOP]).toEqual([FRAG1])
    expect(loaded.dag.getNode('F2')!.lastGoodBoundTo[TOP]).not.toEqual([FRAG0])
  })

  it('saves byte-identical zips for repeated saves and insertion-order-equivalent maps', () => {
    const first = createDocumentArchive(scriptedDocument().input)
    const second = createDocumentArchive(scriptedDocument().input)
    expect(asArray(first)).toEqual(asArray(second))

    const forward = createDocumentArchive(scriptedDocument({ reversed: false }).input)
    const reversed = createDocumentArchive(scriptedDocument({ reversed: true }).input)
    expect(asArray(forward)).toEqual(asArray(reversed))
  })

  it('fails loud on future schema versions and migrates v1 archives through the registered seam', () => {
    const archive = createDocumentArchive(scriptedDocument().input)
    const future = rewriteArchive(archive, (manifest) => {
      manifest.schemaVersion = CURRENT_SCHEMA_VERSION + 1
    })

    let thrown: unknown
    try {
      loadDocumentArchive(future)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(FutureSchemaVersionError)
    expect((thrown as FutureSchemaVersionError).fileVersion).toBe(CURRENT_SCHEMA_VERSION + 1)
    expect((thrown as FutureSchemaVersionError).currentVersion).toBe(CURRENT_SCHEMA_VERSION)

    const old = rewriteArchive(archive, (manifest, document) => {
      manifest.schemaVersion = 1
      delete document.documentKind
    })
    const migrated = loadDocumentArchive(old)
    // WO UI-51A: the doc schema is now v3 (extrude direction/boolMode); WO UI-80
    // adds v4 (faceOffset faceEdits -> pushPull nodes); WO-214 adds v5 (extrude
    // endCondition becomes explicit persisted intent, migrationV4ToV5), so a
    // genuine v1 archive walks the full chain 1->2, 2->3, 3->4, 4->5.
    expect(migrated.migrationsApplied).toEqual([1, 2, 3, 4, 6]) // WO-3234 adds the v6->v7 Thin wall-mode step
    expect(migrated.manifest.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
    expect(migrated.document.documentKind).toBe('liencam-3d-document')
  })

  // WO UI-6 (BK-39, mission #4): the suppress flag round-trips through the
  // SAME dag.serialize()/FeatureDag.restore() seam every other node field
  // already uses -- no new document.json top-level field, no schemaVersion
  // bump. It is additive/optional per ADR-0027: a node with no `suppressed`
  // field at all (the second case below) loads exactly as if it were
  // `false`, so a pre-UI-6 archive opens with nothing suppressed.
  it('round-trips the suppressed flag (root and cascade) with no schemaVersion bump', () => {
    const built = scriptedDocument()
    built.dag.setSuppressed('F2', true)
    const archive = createDocumentArchive(built.input)
    const loaded = loadDocumentArchive(archive)

    expect(loaded.dag.getNode('F2')!.suppressed).toBe(true)
    expect(loaded.dag.isSuppressed('F2')).toBe(true)
    expect(loaded.dag.getNode('F3')!.suppressed).toBe(false)
    expect(loaded.dag.isEffectivelySuppressed('F3')).toBe(true) // cascade: F3 consumes F2
    expect(loaded.dag.isEffectivelySuppressed('F1')).toBe(false) // upstream of F2, untouched
    expect(loaded.manifest.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
  })

  it('a pre-UI-6 archive with no `suppressed` field on its dag nodes loads with every node unsuppressed', () => {
    const archive = createDocumentArchive(scriptedDocument().input)
    const stripped = rewriteArchive(archive, (_manifest, document) => {
      const dagJson = document.dag as { nodes: Array<Record<string, unknown>> }
      for (const n of dagJson.nodes) delete n.suppressed
    })

    const loaded = loadDocumentArchive(stripped)
    for (const id of loaded.dag.nodeIds()) {
      expect(loaded.dag.getNode(id)!.suppressed).toBe(false)
      expect(loaded.dag.isEffectivelySuppressed(id)).toBe(false)
    }
  })

  // WO UI-7 (BK-40) acceptance #4: the rollback marker + explicit
  // feature-timeline order round-trip through their OWN top-level
  // `document.rollback` field -- never dag.serialize()'s own blob (that
  // surface must stay insertion-order independent, see dag.ts's
  // RollbackMarker comment). Additive/optional, no schemaVersion bump: a
  // pre-UI-7 archive (no `document.rollback` at all) opens with the marker
  // at 'end' (nothing rolled back) and an id-sorted timeline.
  it('round-trips the rollback marker + feature-timeline order with no schemaVersion bump', () => {
    const built = scriptedDocument()
    built.dag.setRollbackMarker({ kind: 'after', nodeId: 'F2' })
    const archive = createDocumentArchive({
      ...built.input,
      rollback: { featureOrder: built.dag.featureOrder(), marker: built.dag.getRollbackMarker() },
    })
    const loaded = loadDocumentArchive(archive)

    expect(loaded.dag.getRollbackMarker()).toEqual({ kind: 'after', nodeId: 'F2' })
    expect(loaded.dag.featureOrder()).toEqual(built.dag.featureOrder())
    expect(loaded.dag.isRolledBack('F3')).toBe(true)
    expect(loaded.dag.isRolledBack('F1')).toBe(false)
    expect(loaded.dag.isRolledBack('F2')).toBe(false)
    expect(loaded.manifest.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
  })

  it('an archive saved with no explicit `rollback` input (every pre-UI-7 caller) loads with the marker at "end" and an id-sorted timeline -- nothing rolled back', () => {
    const built = scriptedDocument()
    const archive = createDocumentArchive(built.input) // no `rollback` field supplied
    const loaded = loadDocumentArchive(archive)

    expect(loaded.dag.getRollbackMarker()).toEqual({ kind: 'end' })
    expect(loaded.dag.featureOrder()).toEqual(loaded.dag.nodeIds())
    for (const id of loaded.dag.nodeIds()) expect(loaded.dag.isRolledBack(id)).toBe(false)
  })

  it('a stripped archive with no `document.rollback` key at all (a real pre-UI-7 file) loads exactly the same way', () => {
    const archive = createDocumentArchive(scriptedDocument().input)
    const stripped = rewriteArchive(archive, (_manifest, document) => {
      delete document.rollback
    })
    const loaded = loadDocumentArchive(stripped)
    expect(loaded.dag.getRollbackMarker()).toEqual({ kind: 'end' })
    for (const id of loaded.dag.nodeIds()) expect(loaded.dag.isRolledBack(id)).toBe(false)
  })

  it('omitting `rollback` from DocumentSaveInput keeps forward/reversed archives byte-identical (insertion-order independence, unaffected by this WO)', () => {
    const forward = createDocumentArchive(scriptedDocument({ reversed: false }).input)
    const reversed = createDocumentArchive(scriptedDocument({ reversed: true }).input)
    expect(asArray(forward)).toEqual(asArray(reversed))
  })

  // WO UI-8 (BK-42): design-tree folder grouping round-trips through its OWN
  // top-level `document.folders` field -- same pattern as `rollback` above:
  // additive, no schemaVersion bump, absent on a pre-UI-8 archive.
  it('round-trips folders + membership with no schemaVersion bump', () => {
    const built = scriptedDocument()
    const archive = createDocumentArchive({
      ...built.input,
      folders: { folders: [{ id: 'FLD1', name: 'Group' }], membership: { F1: 'FLD1', F2: 'FLD1' } },
    })
    const loaded = loadDocumentArchive(archive)

    expect(loaded.folders.list()).toEqual([{ id: 'FLD1', name: 'Group' }])
    expect(loaded.folders.folderOf('F1')).toBe('FLD1')
    expect(loaded.folders.folderOf('F2')).toBe('FLD1')
    expect(loaded.folders.folderOf('F3')).toBeNull()
    expect(loaded.manifest.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
  })

  it('an archive saved with no explicit `folders` input (every pre-UI-8 caller) loads with an empty folder store', () => {
    const built = scriptedDocument()
    const archive = createDocumentArchive(built.input) // no `folders` field supplied
    const loaded = loadDocumentArchive(archive)
    expect(loaded.folders.list()).toEqual([])
    for (const id of loaded.dag.nodeIds()) expect(loaded.folders.folderOf(id)).toBeNull()
  })

  // WO-2987 (WO-2750 Slice B): technical drawings ride in their own top-level
  // `document.drawings` field -- additive, no schemaVersion bump, key written
  // only when there is at least one drawing.
  it('round-trips drawing documents with no schemaVersion bump and canonical key order', () => {
    const built = scriptedDocument()
    const drawings = { documents: [{ schemaVersion: 1, id: 'D1', zeta: 1, alpha: [3, 2, 1] }] }
    const archive = createDocumentArchive({ ...built.input, drawings })
    const loaded = loadDocumentArchive(archive)
    expect(loaded.drawings).toEqual(drawings)
    expect(loaded.manifest.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
    const again = createDocumentArchive({ ...built.input, drawings: { documents: [{ alpha: [3, 2, 1], id: 'D1', schemaVersion: 1, zeta: 1 }] } })
    expect(asArray(again)).toEqual(asArray(archive))
  })

  it('an archive saved with no drawings (or an empty list) is byte-identical to one saved before the field existed, and loads with none', () => {
    const built = scriptedDocument()
    const plain = createDocumentArchive(built.input)
    expect(asArray(createDocumentArchive({ ...built.input, drawings: { documents: [] } }))).toEqual(asArray(plain))
    expect(loadDocumentArchive(plain).drawings).toEqual({ documents: [] })
    const files = unzipSync(plain)
    expect(JSON.parse(strFromU8(files['document.json'])).drawings).toBeUndefined()
  })

  it('a malformed `document.drawings` reads as no drawings instead of failing the open', () => {
    const built = scriptedDocument()
    const archive = createDocumentArchive({ ...built.input, drawings: { documents: [{ id: 'D1' }] } })
    const files = unzipSync(archive)
    const doc = JSON.parse(strFromU8(files['document.json']))
    doc.drawings = 'nonsense'
    files['document.json'] = strToU8(JSON.stringify(doc))
    const zippable: Zippable = {}
    for (const path of Object.keys(files).sort()) zippable[path] = [files[path], ZIP_OPTIONS]
    expect(loadDocumentArchive(zipSync(zippable, ZIP_OPTIONS)).drawings).toEqual({ documents: [] })
  })

  it('replaceArchiveDrawings changes only the drawings entry and equals a fresh save', () => {
    const built = scriptedDocument()
    const plain = createDocumentArchive(built.input)
    const drawings = { documents: [{ schemaVersion: 1, id: 'D1' }] }
    const patched = replaceArchiveDrawings(plain, drawings)
    expect(asArray(patched)).toEqual(asArray(createDocumentArchive({ ...built.input, drawings })))
    expect(loadDocumentArchive(patched).drawings).toEqual(drawings)
    expect(asArray(replaceArchiveDrawings(patched, undefined))).toEqual(asArray(plain))
  })

  it('a stripped archive with no `document.folders` key at all (a real pre-UI-8 file) loads exactly the same way', () => {
    const archive = createDocumentArchive(scriptedDocument().input)
    const stripped = rewriteArchive(archive, (_manifest, document) => {
      delete document.folders
    })
    const loaded = loadDocumentArchive(stripped)
    expect(loaded.folders.list()).toEqual([])
  })

  it('folders never affect dag.serialize() -- forward/reversed archives stay byte-identical for the dag blob even with folders supplied', () => {
    const forward = scriptedDocument({ reversed: false })
    const reversed = scriptedDocument({ reversed: true })
    const folderInput = { folders: [{ id: 'FLD1', name: 'Group' }], membership: { F1: 'FLD1' } }
    const forwardArchive = createDocumentArchive({ ...forward.input, folders: folderInput })
    const reversedArchive = createDocumentArchive({ ...reversed.input, folders: folderInput })
    expect(loadDocumentArchive(forwardArchive).dag.serialize()).toBe(loadDocumentArchive(reversedArchive).dag.serialize())
  })
})

describe('DOC-3 autosave and storage seam', () => {
  it('debounces dirty saves and recovers the last unclean autosave from storage', async () => {
    const storage = new InMemoryDocumentStorage()
    let currentArchive = createDocumentArchive(scriptedDocument().input)
    const controller = new AutosaveController({
      storage,
      documentId: 'doc-3',
      debounceMs: 25,
      save: async () => currentArchive,
    })

    controller.markDirty()
    expect(await recoverAutosave(storage, 'doc-3')).toBeUndefined()
    await controller.flush()
    let recovered = await recoverAutosave(storage, 'doc-3')
    expect(recovered).toBeDefined()
    expect(asArray(recovered!.bytes)).toEqual(asArray(currentArchive))

    currentArchive = createDocumentArchive(scriptedDocument({ parameterWidth: 41 }).input)
    controller.markDirty()
    await controller.flush()
    recovered = await recoverAutosave(storage, 'doc-3')
    expect(loadDocumentArchive(recovered!.bytes).parameters.width).toBe(41)

    await controller.markClean()
    expect(await recoverAutosave(storage, 'doc-3')).toBeUndefined()
    controller.dispose()
  })

  it('drives an autosave flush through the real debounce timer without a manual flush call', async () => {
    vi.useFakeTimers()
    try {
      const storage = new InMemoryDocumentStorage()
      const archive = createDocumentArchive(scriptedDocument().input)
      const controller = new AutosaveController({
        storage,
        documentId: 'doc-debounce',
        debounceMs: 25,
        save: async () => archive,
      })

      controller.markDirty()
      expect(await recoverAutosave(storage, 'doc-debounce')).toBeUndefined()

      await vi.advanceTimersByTimeAsync(25)

      const recovered = await recoverAutosave(storage, 'doc-debounce')
      expect(recovered).toBeDefined()
      expect(asArray(recovered!.bytes)).toEqual(asArray(archive))
      controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('markClean waits out an in-flight autosave flush so a clean save cannot be reopened as unclean', async () => {
    const storage = new InMemoryDocumentStorage()
    const archive = createDocumentArchive(scriptedDocument().input)
    let releaseSave: (() => void) | undefined
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve
    })

    const controller = new AutosaveController({
      storage,
      documentId: 'doc-race',
      debounceMs: 1000,
      save: async () => {
        await saveGate
        return archive
      },
    })

    controller.markDirty()
    const flushPromise = controller.flush()
    // flushLoop has synchronously cleared dirty and is blocked inside save(); a real
    // "manual save/close" can land its markClean() call in this exact window.
    await Promise.resolve()
    await Promise.resolve()

    const markCleanPromise = controller.markClean()
    releaseSave!()
    await flushPromise
    await markCleanPromise

    const recovered = await recoverAutosave(storage, 'doc-race')
    expect(recovered).toBeUndefined()
    controller.dispose()
  })

  it('an edit arriving WHILE markClean waits survives it: recovery is still offered for the new edit (R2 lost-update race)', async () => {
    // R1's markClean force-cleared `dirty` across its awaits, so an edit
    // that raced in mid-wait was erased: no autosave, no unclean marker, a
    // crash lost the edit silently. FAILS-IF: run against the R1 code
    // (unconditional dirty=false in markClean's wait loop) and the final
    // recoverAutosave() below returns undefined.
    const storage = new InMemoryDocumentStorage()
    const archive = createDocumentArchive(scriptedDocument().input)
    let releaseSave: (() => void) | undefined
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve
    })
    let gated = true

    const controller = new AutosaveController({
      storage,
      documentId: 'doc-race2',
      debounceMs: 1,
      save: async () => {
        if (gated) await saveGate
        return archive
      },
    })

    controller.markDirty()
    const flushPromise = controller.flush()
    await Promise.resolve()
    await Promise.resolve()

    const markCleanPromise = controller.markClean()
    // The user keeps editing while the manual save's clean-marking is
    // blocked behind the in-flight flush.
    controller.markDirty()
    gated = false
    releaseSave!()
    await flushPromise
    await markCleanPromise

    // The newer edit's dirty state must have survived markClean; let its
    // flush run and prove recovery is offered for it.
    await controller.flush()
    const recovered = await recoverAutosave(storage, 'doc-race2')
    expect(recovered).toBeDefined()
    controller.dispose()
  })

  it('a DELAYED clean-state write cannot clobber a newer edits unclean marker (R3 total write order)', async () => {
    // The R2 audit REPRODUCED this: markClean started its clean-state write,
    // a newer markDirty+flush wrote {unclean:true, revision:2}, then the
    // older delayed clean write landed LAST leaving {unclean:false} - and
    // recoverAutosave returned undefined (recovery lost). R3 serializes all
    // autosave writes through one chain. FAILS-IF: against the R2 code
    // (unordered writes) the final recoverAutosave() below is undefined.
    const storage = new InMemoryDocumentStorage()
    const archive = createDocumentArchive(scriptedDocument().input)
    let gateArmed = false
    let releaseGate: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    const gatedStorage = {
      read: (key: string) => storage.read(key),
      write: async (key: string, bytes: Uint8Array) => {
        if (gateArmed && key.endsWith('.json')) {
          gateArmed = false
          await gate
        }
        await storage.write(key, bytes)
      },
      remove: (key: string) => storage.remove(key),
    }

    const controller = new AutosaveController({
      storage: gatedStorage,
      documentId: 'doc-race3',
      debounceMs: 1000,
      save: async () => archive,
    })

    // Settle one normal autosave so state exists.
    controller.markDirty()
    await controller.flush()

    // Arm the gate: the NEXT state write (markClean's clean write) stalls.
    gateArmed = true
    const markCleanPromise = controller.markClean()
    await Promise.resolve()
    await Promise.resolve()

    // A newer edit arrives and flushes while the clean write is stalled.
    controller.markDirty()
    const flushPromise = controller.flush()
    await Promise.resolve()
    await Promise.resolve()

    releaseGate!()
    await markCleanPromise
    await flushPromise

    // The newer edit's unclean marker must be the FINAL state on disk.
    const recovered = await recoverAutosave(storage, 'doc-race3')
    expect(recovered).toBeDefined()
    controller.dispose()
  })

  it('keeps browser navigator references isolated to the OPFS adapter file', () => {
    const root = join('src', 'doc', 'persist')
    const files = listTsFiles(root)
    const opfsFile = join(root, 'opfs-storage.ts')
    expect(readFileSync(opfsFile, 'utf8')).toContain('navigator')
    for (const file of files.filter((path) => path !== opfsFile)) {
      expect(readFileSync(file, 'utf8')).not.toContain('navigator')
    }
  })
})

function listTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listTsFiles(full))
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}
