// WO-1432: Undo of a Model Item deletion must restore not just the record but
// the ability to read its durable document checkpoint.
//
// THE DEFECT (BUG-480): `removeModelItem` (store/index.ts) called `pushHistory()`
// (snapshotting `project`, which `modelItems`/`modelItemDocuments` are part of)
// and then, in the SAME action, fired `removeDocumentCheckpoint` synchronously --
// an irreversible IndexedDB delete of the item's durable autosave bytes, entirely
// outside the history snapshot. Undo brought the `modelItems` record back;
// `hydrateDocumentCheckpoint` found the bytes already gone and threw "Durable
// checkpoint is missing".
//
// THE SHARED CAUSE: this is the exact defect shape WO-1283 already fixed for
// deleted geometry bytes (src/tests/store/undoAfterDeleteRestoresPart.wo1283.test.tsx)
// -- the byte-purge had to become DEFERRED, running only once the item is
// genuinely unreachable from the current project or any undo/redo snapshot,
// not synchronously with the delete. This file proves `removeModelItem`'s
// document-checkpoint teardown now goes through that SAME seam
// (`reapDeferredGeometryPurges`, widened rather than forked).

import { describe, it, expect, beforeEach } from 'vitest'
import { createDocumentArchive, InMemoryDocumentStorage } from '../../doc/persist'
import { FeatureDag } from '../../doc/dag'
import {
  documentCheckpointStorageKey,
  hydrateDocumentCheckpoint,
  resetDocumentHolder,
  setDocumentStorage,
  storeDocumentCheckpointBytes,
} from '../../doc/documentHolder'
import { useCamStore, pendingDocumentCheckpointPurgeIds } from '../../store'
import type { ModelItemRecord } from '../../types'

/** The reap's actual `removeDocumentCheckpoint` call is fire-and-forget (the
 *  store must never let a cache purge block or fail the action that triggered
 *  it); drain the microtask queue before asserting storage state, same
 *  precedent as the WO-1283 geometry test's `flushCacheIo`. */
const flushCacheIo = () => new Promise((resolve) => setTimeout(resolve, 0))

/** `storeDocumentCheckpointBytes` decode-validates real zip bytes (mirrors
 *  documentHolder.test.ts's own makeArchive helper), so a placeholder byte
 *  array throws before this file's own assertions ever run. Distinguishable
 *  per id via its one feature's height, so "THIS item's bytes came back" is
 *  provable rather than "some bytes came back". */
function bytesFor(id: string): Uint8Array {
  const dag = new FeatureDag()
  dag.insertNode({ id: 'F1', kind: 'feature', payload: { opType: 'extrude', height: id.charCodeAt(id.length - 1) } })
  return createDocumentArchive({ dag, elementMapDeltas: [] })
}

/** Seed one Model Item exactly as an authored Save leaves it: a store record
 *  naming a storage key, plus real bytes sitting behind that key. */
async function seedItemWithCheckpoint(itemId: string): Promise<{ projectId: string; storageKey: string }> {
  const projectId = useCamStore.getState().project.id
  const storageKey = documentCheckpointStorageKey(projectId, itemId)
  await storeDocumentCheckpointBytes(projectId, itemId, bytesFor(itemId))
  const record: ModelItemRecord = {
    id: itemId, name: itemId, documentState: 'authored', documentStorageKey: storageKey, documentRevision: 1,
  }
  useCamStore.setState((s) => ({
    project: { ...s.project, modelItems: [...(s.project.modelItems ?? []), record] },
  }))
  return { projectId, storageKey }
}

// Every test below uses the SAME Model Item id. The deferred-purge registry
// (store/index.ts) is module-private and outlives any one test in this file
// (same precedent as WO-1283's own test file reusing 'g1' throughout); keying
// every test's registration on the one id means each delete's registration
// REPLACES the previous one instead of leaving a stale entry behind, so
// `pendingDocumentCheckpointPurgeIds()` never accumulates zombies across tests.
const ITEM_ID = 'item-a'

beforeEach(() => {
  resetDocumentHolder()
  setDocumentStorage(new InMemoryDocumentStorage())
  useCamStore.setState((s) => ({
    project: { ...s.project, modelItems: [] },
    projectHistory: [], projectFuture: [], canUndo: false,
  }))
})

describe('WO-1432: delete a Model Item, undo, its durable checkpoint is still there', () => {
  it('on main this throws "missing" after undo; the fix leaves it hydratable', async () => {
    const itemId = ITEM_ID
    const { projectId, storageKey } = await seedItemWithCheckpoint(itemId)

    useCamStore.getState().removeModelItem(itemId)
    expect(useCamStore.getState().project.modelItems).toHaveLength(0)
    // The affordance is honest: the bytes an undo would need are still held,
    // not yet actually deleted.
    expect(pendingDocumentCheckpointPurgeIds()).toContain(itemId)
    await flushCacheIo()

    useCamStore.getState().undo()
    expect(useCamStore.getState().project.modelItems?.map((m) => m.id)).toEqual([itemId])

    // THE ACCEPTANCE QUESTION: can Save (via hydrate) still find the checkpoint?
    const restored = await hydrateDocumentCheckpoint(projectId, itemId, storageKey, 1)
    expect(restored.bytes).toEqual(bytesFor(itemId))
  })

  it('delete -> undo -> redo -> undo still hydrates (bytes held for the whole stack)', async () => {
    const itemId = ITEM_ID
    const { projectId, storageKey } = await seedItemWithCheckpoint(itemId)

    useCamStore.getState().removeModelItem(itemId)
    useCamStore.getState().undo()
    useCamStore.getState().redo()
    expect(useCamStore.getState().project.modelItems).toHaveLength(0)
    await flushCacheIo()

    useCamStore.getState().undo()
    expect(useCamStore.getState().project.modelItems?.map((m) => m.id)).toEqual([itemId])
    const restored = await hydrateDocumentCheckpoint(projectId, itemId, storageKey, 1)
    expect(restored.bytes).toEqual(bytesFor(itemId))
  })
})

describe('WO-1432 memory policy: retention is bounded by the undo depth, mirroring WO-1283', () => {
  it('the checkpoint IS eventually actually removed once no history entry can restore the record', async () => {
    const itemId = ITEM_ID
    const { projectId, storageKey } = await seedItemWithCheckpoint(itemId)

    useCamStore.getState().removeModelItem(itemId)
    expect(pendingDocumentCheckpointPurgeIds()).toContain(itemId)

    // WO-1893: 52 further undoable actions -- the undo stack now holds fifty
    // snapshots (PROJECT_UNDO_DEPTH), so this is enough to drop the pre-delete
    // entry and make the item unreachable.
    for (let i = 0; i < 52; i++) useCamStore.getState().addGeometryFolder(`F${i}`)
    await flushCacheIo()

    expect(pendingDocumentCheckpointPurgeIds()).not.toContain(itemId)
    await expect(hydrateDocumentCheckpoint(projectId, itemId, storageKey, 1)).rejects.toThrow(/missing/i)
  })

  it('repeated delete/undo cycles do not grow what is retained (keyed registry, one id)', async () => {
    const itemId = ITEM_ID
    const { projectId, storageKey } = await seedItemWithCheckpoint(itemId)

    for (let i = 0; i < 6; i++) {
      useCamStore.getState().removeModelItem(itemId)
      useCamStore.getState().undo()
    }
    await flushCacheIo()

    expect(pendingDocumentCheckpointPurgeIds()).toEqual([itemId])
    const restored = await hydrateDocumentCheckpoint(projectId, itemId, storageKey, 1)
    expect(restored.bytes).toEqual(bytesFor(itemId))
  })
})
