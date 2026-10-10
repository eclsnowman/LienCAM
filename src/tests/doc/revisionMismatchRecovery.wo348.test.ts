// WO-348: a revision mismatch locks you out of your own model.
//
// docs/research/model-edit-refresh-gap.md (WO-334) reproduced a hard lockout:
// hydrateDocumentCheckpoint threw the instant the caller's cached
// item.documentRevision didn't exactly match what autosave had actually
// written durably, refusing to open a model that was genuinely sitting on
// disk. This file is that behavior's own dedicated coverage -- see
// documentHolder.ts's hydrateDocumentCheckpoint doc comment for the fix
// itself. src/tests/doc/documentHolder.test.ts's own
// "refuses missing, cross-item, ... checkpoints" case exercises the same
// function from its existing suite; this file is the acceptance-level proof.

import { describe, it, expect, beforeEach } from 'vitest'
import { FeatureDag } from '../../doc/dag'
import {
  createDocumentArchive,
  loadDocumentArchive,
  InMemoryDocumentStorage,
  writeAutosaveSnapshot,
} from '../../doc/persist'
import {
  documentIdForProject,
  documentCheckpointStorageKey,
  flushDocumentCheckpoint,
  hydrateDocumentCheckpoint,
  registerLiveDocument,
  resetDocumentHolder,
  setDocumentStorage,
} from '../../doc/documentHolder'

function makeDag(featureId = 'F1', height = 5): FeatureDag {
  const dag = new FeatureDag()
  dag.insertNode({ id: featureId, kind: 'feature', payload: { opType: 'extrude', height } })
  return dag
}

beforeEach(() => {
  resetDocumentHolder()
})

describe('WO-348: revision mismatch recovers instead of refusing', () => {
  it('opens the model on a stale (behind-disk) cached revision, where it previously refused', async () => {
    const storage = new InMemoryDocumentStorage()
    setDocumentStorage(storage)
    registerLiveDocument(
      () => ({ dag: makeDag('F1', 20), elementMapDeltas: [] }),
      'item-a',
    )
    const checkpoint = await flushDocumentCheckpoint('project-348', 'item-a')
    expect(checkpoint).toBeDefined()

    // The store's cached expectation is one revision BEHIND what autosave
    // already wrote durably -- e.g. a second flush landed after the store
    // last recorded a checkpoint revision for this item.
    const recovered = await hydrateDocumentCheckpoint(
      'project-348',
      'item-a',
      checkpoint!.storageKey,
      checkpoint!.revision - 1,
    )

    expect(recovered.revision).toBe(checkpoint!.revision)
    expect(loadDocumentArchive(recovered.bytes).dag.getNode('F1')).toBeDefined()
  })

  it('opens the model on a stale (ahead-of-disk) cached revision too -- neither source silently wins, but neither refuses', async () => {
    const storage = new InMemoryDocumentStorage()
    setDocumentStorage(storage)
    registerLiveDocument(
      () => ({ dag: makeDag('F1', 20), elementMapDeltas: [] }),
      'item-a',
    )
    const checkpoint = await flushDocumentCheckpoint('project-348', 'item-a')
    expect(checkpoint).toBeDefined()

    // The store's cached expectation is AHEAD of what is actually durable --
    // the direction the diagnosis worried could "resurrect an older document
    // than the user's last in-session edit". It must still recover, not
    // refuse -- just with the operator told (next test).
    const recovered = await hydrateDocumentCheckpoint(
      'project-348',
      'item-a',
      checkpoint!.storageKey,
      checkpoint!.revision + 1,
    )

    expect(recovered.revision).toBe(checkpoint!.revision)
    expect(loadDocumentArchive(recovered.bytes).dag.getNode('F1')).toBeDefined()
  })

  it('tells the operator plainly what was recovered and that recent edits may be missing', async () => {
    const storage = new InMemoryDocumentStorage()
    setDocumentStorage(storage)
    registerLiveDocument(
      () => ({ dag: makeDag('F1', 20), elementMapDeltas: [] }),
      'item-a',
    )
    const checkpoint = await flushDocumentCheckpoint('project-348', 'item-a')

    const recovered = await hydrateDocumentCheckpoint(
      'project-348',
      'item-a',
      checkpoint!.storageKey,
      checkpoint!.revision + 1,
    )

    expect(recovered.recoveryNotice).toBeDefined()
    expect(recovered.recoveryNotice).toMatch(/recovered from a saved checkpoint/i)
    expect(recovered.recoveryNotice).toMatch(/edits made after that checkpoint may not be included/i)
  })

  it('does NOT attach a recovery notice when the revision genuinely matches (the ordinary, non-mismatched open)', async () => {
    const storage = new InMemoryDocumentStorage()
    setDocumentStorage(storage)
    registerLiveDocument(
      () => ({ dag: makeDag('F1', 20), elementMapDeltas: [] }),
      'item-a',
    )
    const checkpoint = await flushDocumentCheckpoint('project-348', 'item-a')

    const opened = await hydrateDocumentCheckpoint(
      'project-348',
      'item-a',
      checkpoint!.storageKey,
      checkpoint!.revision,
    )

    expect(opened.recoveryNotice).toBeUndefined()
  })

  it('still refuses when no durable checkpoint exists at all, with today\'s message intact', async () => {
    const storage = new InMemoryDocumentStorage()
    setDocumentStorage(storage)

    await expect(hydrateDocumentCheckpoint(
      'project-348',
      'item-a',
      documentCheckpointStorageKey('project-348', 'item-a'),
      3,
    )).rejects.toThrow(/Durable checkpoint is missing for Model Item "item-a"/)
  })

  it('still refuses an on-disk document that cannot be read at all, even when the revision also mismatches', async () => {
    const storage = new InMemoryDocumentStorage()
    setDocumentStorage(storage)
    const documentId = documentIdForProject('project-348', 'item-a')
    // Bytes that are not a valid archive at all (unlike a corrupted-but-real
    // zip, this can never decode) -- written directly to the durable backend,
    // bypassing every validate-on-write path (storeDocumentCheckpointBytes,
    // flushDocumentCheckpoint) so the corruption is genuine, not simulated
    // via a code path that would itself have refused it.
    await writeAutosaveSnapshot(storage, documentId, new TextEncoder().encode('not a zip'), 4)

    await expect(hydrateDocumentCheckpoint(
      'project-348',
      'item-a',
      documentCheckpointStorageKey('project-348', 'item-a'),
      3,
    )).rejects.toThrow()

    // And the archive really is unreadable independent of this function --
    // this is not a false-positive refusal.
    expect(() => loadDocumentArchive(new TextEncoder().encode('not a zip'))).toThrow()
  })

  it('an identity mismatch (wrong item/project) is a different failure and still refuses unchanged', async () => {
    const storage = new InMemoryDocumentStorage()
    setDocumentStorage(storage)
    registerLiveDocument(
      () => ({ dag: makeDag('F1', 20), elementMapDeltas: [] }),
      'item-a',
    )
    const checkpoint = await flushDocumentCheckpoint('project-348', 'item-a')

    await expect(hydrateDocumentCheckpoint(
      'project-348',
      'item-a',
      documentCheckpointStorageKey('project-348', 'item-b'),
      checkpoint!.revision,
    )).rejects.toThrow(/identity mismatch/i)
  })
})

// Keep createDocumentArchive imported honest: used to sanity-check that the
// bytes this suite decodes really are ordinary documents, not a special test
// fixture format.
describe('WO-348 fixture sanity', () => {
  it('makeDag + createDocumentArchive round-trips through the real archive codec', () => {
    const archive = createDocumentArchive({ dag: makeDag('F1', 7), elementMapDeltas: [] })
    const loaded = loadDocumentArchive(archive)
    expect((loaded.dag.getNode('F1') as unknown as { payload: { height: number } }).payload.height).toBe(7)
  })
})
