// WO INT-14, criterion 0 (preflight amendment 1): THE DOCUMENT HOLDER.
//
// The holder exists because of one concrete, user-visible failure the WO was cut
// to stop: open a .camproject that carries a model, never enter the Model
// workspace, save -> the model is silently gone. The workbench that owns the live
// document mounts LAZILY (App.tsx:273-283), so at save time there may be no
// component to ask. Every test below is aimed at that class of hole rather than
// at the holder's getters.
//
// The three interleaves amendment 1 names each have a test here:
//   1. save during an active edit                 -> 'live document wins ...'
//   2. load while the workbench is mounted        -> 'a load while mounted ...'
//   3. load while unmounted, then first mount     -> 'seeds the first mount ...'
//
// These drive the holder module directly. The REAL store save/load path is driven
// in src/tests/store/int14ProjectDocument.test.ts, and the REAL workbench mount in
// src/tests/model3d/SolidsWorkbenchPage.documentPersist.test.tsx -- this file is
// the seam's own unit layer, not a substitute for either.

import { describe, it, expect, beforeEach } from 'vitest'
import { FeatureDag } from '../../doc/dag'
import {
  createDocumentArchive,
  loadDocumentArchive,
  InMemoryDocumentStorage,
  FutureSchemaVersionError,
} from '../../doc/persist'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import type { ZipOptions, Zippable } from 'fflate'
import {
  acknowledgePendingDocumentSeed,
  clearLoadedDocument,
  collectDocumentArchive,
  disposeDocumentAutosave,
  disposeModelItem,
  documentCheckpointStorageKey,
  documentIdForProject,
  flushDocumentCheckpoint,
  getAutosaveController,
  getDocumentGeneration,
  hasLiveDocument,
  hydrateDocumentCheckpoint,
  isEmptyDocument,
  markDocumentDirty,
  peekPendingDocumentSeed,
  readDocumentAutosaveRecovery,
  acceptDocumentAutosaveRecovery,
  setDocumentStorage,
  registerLiveDocument,
  resetDocumentHolder,
  stashLoadedDocument,
  startDocumentAutosave,
  subscribeDocumentGeneration,
  takePendingDocumentSeed,
} from '../../doc/documentHolder'
import { ORIGIN_NODE_ID } from '../../doc/genesis'

const ZIP_OPTIONS: ZipOptions = { level: 0, mtime: new Date(1980, 0, 1, 0, 0, 0), os: 0, attrs: 0 }

/** A document with one real (non-genesis) feature -- i.e. a model a user would
 *  be upset to lose. */
function makeDag(featureId = 'F1', height = 5): FeatureDag {
  const dag = new FeatureDag()
  dag.insertNode({ id: featureId, kind: 'feature', payload: { opType: 'extrude', height } })
  return dag
}

function makeArchive(featureId = 'F1', height = 5): Uint8Array {
  return createDocumentArchive({ dag: makeDag(featureId, height), elementMapDeltas: [] })
}

/** Rewrite a real archive's manifest schemaVersion (the persist.test.ts /
 *  params/persistence.test.ts rewriteArchive precedent) so the fail-loud test
 *  exercises a GENUINELY newer-stamped document, not one this build wrote. */
function restampArchive(archive: Uint8Array, schemaVersion: number): Uint8Array {
  const files = unzipSync(archive)
  const manifest = JSON.parse(strFromU8(files['manifest.json'])) as Record<string, unknown>
  manifest.schemaVersion = schemaVersion
  files['manifest.json'] = strToU8(JSON.stringify(manifest))
  const zippable: Zippable = {}
  for (const path of Object.keys(files).sort()) zippable[path] = [files[path], ZIP_OPTIONS]
  return zipSync(zippable, ZIP_OPTIONS)
}

beforeEach(() => {
  resetDocumentHolder()
})

describe('INT-14 criterion 0: the document holder', () => {
  it('collects nothing when there is no document at all (a 2D-only project omits the field)', () => {
    expect(collectDocumentArchive()).toBeUndefined()
  })

  // THE KILLER CASE the holder exists for (amendment 1's own wording): load a
  // model-bearing project, never enter the Model workspace, save. With no
  // pass-through the field would be omitted and the model silently dropped.
  it('re-emits the loaded document when the workbench NEVER mounted (load -> save pass-through)', () => {
    const archive = makeArchive()
    stashLoadedDocument(archive)
    expect(hasLiveDocument()).toBe(false)

    const saved = collectDocumentArchive()
    expect(saved).toBeDefined()
    // Byte-identical: nothing touched the model, so nothing re-encodes it.
    expect(new Uint8Array(saved as Uint8Array)).toEqual(new Uint8Array(archive))
    // ...and it is genuinely the same model, not merely the same length.
    expect(loadDocumentArchive(saved as Uint8Array).dag.serialize()).toBe(
      loadDocumentArchive(archive).dag.serialize(),
    )
  })

  it('the pass-through survives a seed being taken but no workbench registering', () => {
    // Reproduces the ugly middle state: the workbench began mounting (consumed
    // the seed) and then failed/never registered. The bytes must still be there.
    const archive = makeArchive()
    stashLoadedDocument(archive)
    expect(takePendingDocumentSeed()).not.toBeNull()
    expect(new Uint8Array(collectDocumentArchive() as Uint8Array)).toEqual(new Uint8Array(archive))
  })

  // INTERLEAVE 1 (amendment 1): save during an active edit.
  it('live document wins over the loaded bytes -- a save mid-edit captures the EDIT, not the file', () => {
    const archive = makeArchive('F1', 5)
    stashLoadedDocument(archive)
    const seed = takePendingDocumentSeed()
    expect(seed).not.toBeNull()

    const liveDag = (seed as NonNullable<typeof seed>).dag
    registerLiveDocument(() => ({ dag: liveDag, elementMapDeltas: [] }))
    // The user edits mid-session (what an open dialog / drag commit does).
    liveDag.setPayload('F1', { opType: 'extrude', height: 99 })

    const saved = collectDocumentArchive()
    expect(saved).toBeDefined()
    const reloaded = loadDocumentArchive(saved as Uint8Array)
    expect((reloaded.dag.getNode('F1') as unknown as { payload: { height: number } }).payload.height).toBe(99)
    // Explicitly NOT the stale pass-through bytes.
    expect(new Uint8Array(saved as Uint8Array)).not.toEqual(new Uint8Array(archive))
  })

  // INTERLEAVE 2 (amendment 1): load while the workbench is mounted.
  it('a load while mounted publishes a new generation (the remount that re-seats paramTable/history/caches)', () => {
    registerLiveDocument(() => ({ dag: makeDag('OLD'), elementMapDeltas: [] }))
    const before = getDocumentGeneration()

    const seen: number[] = []
    const unsubscribe = subscribeDocumentGeneration(() => seen.push(getDocumentGeneration()))
    stashLoadedDocument(makeArchive('NEW'))
    unsubscribe()

    // The generation MUST move: it is the only thing that tells the mounted
    // workbench to rebuild from the seed. Without it the page would keep showing
    // the previous project's model -- the silent partial ADR-0003 forbids.
    expect(getDocumentGeneration()).toBeGreaterThan(before)
    expect(seen).toHaveLength(1)
    // ...and the incoming document is waiting for that remount to take it.
    expect(takePendingDocumentSeed()?.dag.has('NEW')).toBe(true)
  })

  // INTERLEAVE 3 (amendment 1): load while unmounted, then the first mount seeds.
  it('seeds the first mount from the holder even though the load happened while unmounted', () => {
    stashLoadedDocument(makeArchive('F_LOADED'))
    expect(hasLiveDocument()).toBe(false)

    // ...the user finally opens the Model workspace; the mount takes the seed.
    const seed = takePendingDocumentSeed()
    expect(seed).not.toBeNull()
    expect((seed as NonNullable<typeof seed>).dag.has('F_LOADED')).toBe(true)
    // Consumed exactly once -- a second mount must not resurrect a stale seed
    // over the live document the first mount now owns.
    expect(takePendingDocumentSeed()).toBeNull()
  })

  it('a speculative render can peek without consuming; only its committed exact lease consumes', () => {
    stashLoadedDocument(makeArchive('F_STRICT'))

    const speculative = peekPendingDocumentSeed()
    expect(speculative?.seed.dag.has('F_STRICT')).toBe(true)
    // StrictMode's discarded render sees the same immutable lease and leaves
    // it available for the render React actually commits.
    expect(peekPendingDocumentSeed()).toBe(speculative)

    expect(acknowledgePendingDocumentSeed(speculative!)).toBe(true)
    expect(peekPendingDocumentSeed()).toBeNull()
    expect(acknowledgePendingDocumentSeed(speculative!)).toBe(false)
  })

  it('a late acknowledgement cannot consume a newer seed for the same model item', () => {
    stashLoadedDocument(makeArchive('F_OLD'), 'item-a')
    const oldLease = peekPendingDocumentSeed('item-a')!

    stashLoadedDocument(makeArchive('F_NEW'), 'item-a')
    const newLease = peekPendingDocumentSeed('item-a')!
    expect(newLease.revision).not.toBe(oldLease.revision)

    expect(acknowledgePendingDocumentSeed(oldLease, 'item-a')).toBe(false)
    expect(peekPendingDocumentSeed('item-a')).toBe(newLease)
    expect(takePendingDocumentSeed('item-a')?.dag.has('F_NEW')).toBe(true)
  })

  it('acknowledging one model item never consumes another item seed', () => {
    stashLoadedDocument(makeArchive('F_A'), 'item-a')
    stashLoadedDocument(makeArchive('F_B'), 'item-b')
    const leaseA = peekPendingDocumentSeed('item-a')!

    expect(acknowledgePendingDocumentSeed(leaseA, 'item-a')).toBe(true)
    expect(peekPendingDocumentSeed('item-a')).toBeNull()
    expect(peekPendingDocumentSeed('item-b')?.seed.dag.has('F_B')).toBe(true)
  })

  it('an unchanged committed document parks a future seed on unmount without a generation bump', () => {
    stashLoadedDocument(makeArchive('F_UNCHANGED'), 'item-a')
    const lease = peekPendingDocumentSeed('item-a')!
    expect(acknowledgePendingDocumentSeed(lease, 'item-a')).toBe(true)
    const generationBeforeUnmount = getDocumentGeneration('item-a')

    const unregister = registerLiveDocument(
      () => ({ dag: lease.seed.dag, elementMapDeltas: lease.seed.elementMapDeltas }),
      'item-a',
    )
    unregister()

    expect(getDocumentGeneration('item-a')).toBe(generationBeforeUnmount)
    expect(peekPendingDocumentSeed('item-a')?.seed.dag.has('F_UNCHANGED')).toBe(true)
  })

  it('the unregister is identity-guarded, so a remount cannot be un-registered by the OLD tree', () => {
    // React can mount the replacement BEFORE unmounting the old tree. An
    // unguarded cleanup would then null the NEW collector and every later save
    // would silently fall back to stale pass-through bytes.
    const unregisterOld = registerLiveDocument(() => ({ dag: makeDag('OLD'), elementMapDeltas: [] }))
    registerLiveDocument(() => ({ dag: makeDag('NEW'), elementMapDeltas: [] })) // new tree mounts
    unregisterOld() // old tree unmounts, LATE

    expect(hasLiveDocument()).toBe(true)
    expect(loadDocumentArchive(collectDocumentArchive() as Uint8Array).dag.has('NEW')).toBe(true)
  })

  it('opening a project with NO document drops the previous model (no ghost document)', () => {
    stashLoadedDocument(makeArchive())
    expect(collectDocumentArchive()).toBeDefined()

    clearLoadedDocument()

    // Without this the next save would write the PREVIOUS project's model into
    // the new file -- the same ghost-document class loadProjectFromFile already
    // guards for the active sketch (store/index.ts:3958).
    expect(collectDocumentArchive()).toBeUndefined()
    expect(takePendingDocumentSeed()).toBeNull()
  })

  it('a live document holding only genesis fixtures is EMPTY (visiting the Model tab does not perturb a 2D project)', () => {
    expect(isEmptyDocument(new FeatureDag())).toBe(true)
    expect(isEmptyDocument(makeDag())).toBe(false)

    // A collector returning null (what the workbench does for an untouched
    // document) must omit the field, not write an empty archive.
    registerLiveDocument(() => null)
    expect(collectDocumentArchive()).toBeUndefined()
  })

  it('refuses a NEWER document archive by name and stashes NOTHING (ADR-0003)', () => {
    const good = makeArchive()
    stashLoadedDocument(good)
    takePendingDocumentSeed()

    const future = restampArchive(makeArchive('F_FUTURE'), 99)
    expect(() => stashLoadedDocument(future)).toThrow(FutureSchemaVersionError)

    // The holder kept the state it had -- no half-stashed future document for a
    // later save to re-emit, and no new seed pending.
    expect(takePendingDocumentSeed()).toBeNull()
    expect(new Uint8Array(collectDocumentArchive() as Uint8Array)).toEqual(new Uint8Array(good))
  })

  it('refuses CORRUPTED archive bytes and stashes nothing', () => {
    expect(() => stashLoadedDocument(new Uint8Array([1, 2, 3, 4, 5]))).toThrow()
    expect(takePendingDocumentSeed()).toBeNull()
    expect(collectDocumentArchive()).toBeUndefined()
  })
})

describe('INT-14 AC7: autosave parity (the SHIPPED controller, wired -- not a new engine)', () => {
  it('the save callback feeds createDocumentArchive bytes into the DOC-3 controller + storage', async () => {
    const storage = new InMemoryDocumentStorage()
    const dag = makeDag('F_AUTO', 12)
    registerLiveDocument(() => ({ dag, elementMapDeltas: [] }))
    const controller = startDocumentAutosave({
      documentId: documentIdForProject('proj-1'),
      storage,
      debounceMs: 0,
    })

    markDocumentDirty()
    await controller.flush()

    // The blob the controller wrote is a REAL document archive carrying the real
    // model -- proving the callback is createDocumentArchive over the live
    // document, not a placeholder.
    const recovered = await readDocumentAutosaveRecovery('proj-1')
    expect(recovered).toBeDefined()
    const loaded = loadDocumentArchive((recovered as NonNullable<typeof recovered>).bytes)
    expect((loaded.dag.getNode('F_AUTO') as unknown as { payload: { height: number } }).payload.height).toBe(12)
  })

  it('recovery round trip: an autosaved document restores through the SAME holder/seed path a file open uses', async () => {
    const storage = new InMemoryDocumentStorage()
    const dag = makeDag('F_CRASH', 7)
    const unregister = registerLiveDocument(() => ({ dag, elementMapDeltas: [] }))
    const controller = startDocumentAutosave({
      documentId: documentIdForProject('proj-2'),
      storage,
      debounceMs: 0,
    })
    markDocumentDirty()
    await controller.flush()

    // ---- the crash: the page dies with the document unsaved to file ----
    unregister()
    resetDocumentHolder()
    // resetDocumentHolder drops the storage override back to the OPFS default,
    // so re-point it: this stands in for a fresh page load reaching the SAME
    // backing store the dead session autosaved into.
    setDocumentStorage(storage)
    expect(collectDocumentArchive()).toBeUndefined()

    // ---- next open: accept the recovery ----
    // WO INT-14-R1: `acceptDocumentAutosaveRecovery` is the PRODUCT function
    // that validates and stashes (documentHolder.ts) -- this test previously
    // called stashLoadedDocument by hand right here, which is exactly why it
    // passed while no product code routed recovery anywhere at all. The
    // store-level entry point that decides to call this is covered by
    // int14ProjectDocument.test.ts's production-entry test.
    const recovered = await readDocumentAutosaveRecovery('proj-2')
    expect(recovered).toBeDefined()
    acceptDocumentAutosaveRecovery(recovered as NonNullable<typeof recovered>)

    const seed = takePendingDocumentSeed()
    expect(seed).not.toBeNull()
    // Parsed, not string-compared: the archive CANONICALIZES payload key order
    // (format.ts:97's stableStringify), so a recovered document's serialization
    // is key-sorted while the in-memory original keeps insertion order. Same
    // structural comparison the shipped round-trip test uses (persist.test.ts:183)
    // -- the contract is the document, not the byte order of its keys.
    expect(JSON.parse((seed as NonNullable<typeof seed>).dag.serialize())).toEqual(
      JSON.parse(dag.serialize()),
    )
  })

  it('markDirty is inert with no live document -- an unmounted workbench never autosaves over the file bytes', async () => {
    const storage = new InMemoryDocumentStorage()
    stashLoadedDocument(makeArchive())
    const controller = startDocumentAutosave({
      documentId: documentIdForProject('proj-3'),
      storage,
      debounceMs: 0,
    })

    markDocumentDirty() // nothing is editing: no workbench is mounted
    await controller.flush()

    expect(await readDocumentAutosaveRecovery('proj-3')).toBeUndefined()
    expect(storage.keys()).toHaveLength(0)
  })

  it('a clean autosave state offers NO recovery (no false "restore your work?" on every open)', async () => {
    setDocumentStorage(new InMemoryDocumentStorage())
    expect(await readDocumentAutosaveRecovery('never-saved')).toBeUndefined()
  })
})

describe('Model Item durable checkpoints across a cold browser reload', () => {
  it('keeps A and B in independent project+item storage keys and restores their exact DAGs', async () => {
    const storage = new InMemoryDocumentStorage()
    setDocumentStorage(storage)
    const unregisterA = registerLiveDocument(
      () => ({ dag: makeDag('FEATURE_A', 11), elementMapDeltas: [] }),
      'item-a',
    )
    const unregisterB = registerLiveDocument(
      () => ({ dag: makeDag('FEATURE_B', 22), elementMapDeltas: [] }),
      'item-b',
    )

    const checkpointA = await flushDocumentCheckpoint('project-cold', 'item-a')
    const checkpointB = await flushDocumentCheckpoint('project-cold', 'item-b')
    expect(checkpointA?.storageKey).toBe(documentCheckpointStorageKey('project-cold', 'item-a'))
    expect(checkpointB?.storageKey).toBe(documentCheckpointStorageKey('project-cold', 'item-b'))
    expect(checkpointA?.storageKey).not.toBe(checkpointB?.storageKey)
    unregisterA()
    unregisterB()

    // Full page death: all module-memory collectors, pass-through bytes, and
    // pending seeds disappear; only the injected durable backend survives.
    resetDocumentHolder()
    setDocumentStorage(storage)

    const restoredCheckpointA = await hydrateDocumentCheckpoint(
      'project-cold',
      'item-a',
      checkpointA!.storageKey,
      checkpointA!.revision,
    )
    stashLoadedDocument(restoredCheckpointA.bytes, 'item-a')
    const restoredA = takePendingDocumentSeed('item-a')
    expect(restoredA?.dag.getNode('FEATURE_A')).toBeDefined()
    expect(restoredA?.dag.getNode('FEATURE_B')).toBeUndefined()

    const restoredCheckpointB = await hydrateDocumentCheckpoint(
      'project-cold',
      'item-b',
      checkpointB!.storageKey,
      checkpointB!.revision,
    )
    stashLoadedDocument(restoredCheckpointB.bytes, 'item-b')
    const restoredB = takePendingDocumentSeed('item-b')
    expect(restoredB?.dag.getNode('FEATURE_B')).toBeDefined()
    expect(restoredB?.dag.getNode('FEATURE_A')).toBeUndefined()
  })

  it('refuses missing and cross-item checkpoints, but RECOVERS a wrong-revision one (WO-348)', async () => {
    const storage = new InMemoryDocumentStorage()
    setDocumentStorage(storage)
    await expect(hydrateDocumentCheckpoint(
      'project-cold',
      'item-a',
      documentCheckpointStorageKey('project-cold', 'item-a'),
    )).rejects.toThrow(/missing/i)

    registerLiveDocument(
      () => ({ dag: makeDag('FEATURE_A'), elementMapDeltas: [] }),
      'item-a',
    )
    const checkpoint = await flushDocumentCheckpoint('project-cold', 'item-a')
    await expect(hydrateDocumentCheckpoint(
      'project-cold',
      'item-a',
      documentCheckpointStorageKey('project-cold', 'item-b'),
      checkpoint!.revision,
    )).rejects.toThrow(/identity mismatch/i)

    // WO-348: the caller's cached revision expectation drifting from the
    // durable checkpoint no longer hard-refuses (see documentHolder.ts's own
    // hydrateDocumentCheckpoint doc comment) -- the disk bytes decoded fine
    // above, so this recovers and opens rather than locking the item out.
    // src/tests/doc/revisionMismatchRecovery.wo348.test.ts is this
    // behavior's own dedicated coverage; this assertion just keeps this
    // file's pre-existing "refuses ..." case honest about the new contract.
    const recovered = await hydrateDocumentCheckpoint(
      'project-cold',
      'item-a',
      checkpoint!.storageKey,
      checkpoint!.revision + 1,
    )
    expect(recovered.revision).toBe(checkpoint!.revision)
    expect(recovered.recoveryNotice).toMatch(/recovered from a saved checkpoint/i)
  })
})

describe('INT-14: genesis-only documents', () => {
  it('a dag holding ONLY the Origin genesis fixture is empty', () => {
    const dag = new FeatureDag()
    dag.installGenesisNode({ id: ORIGIN_NODE_ID, kind: 'datum', payload: { datumType: 'origin' } })
    expect(isEmptyDocument(dag)).toBe(true)

    dag.insertNode({ id: 'F1', kind: 'feature', payload: { opType: 'extrude' } })
    expect(isEmptyDocument(dag)).toBe(false)
  })
})

// WO INT-17C Stage C3: disposeModelItem is the scoped, per-item sibling of
// resetDocumentHolder used above -- the store's removeModelItem action calls
// it so deleting ONE Model Item tears down exactly that item's live/pending/
// autosave state and never a different item's (the exact isolation
// resetDocumentHolder's own full-teardown contract does not need to make,
// since it clears everything unconditionally).
describe('INT-17C Stage C3: disposeModelItem (per-item teardown on delete)', () => {
  it('clears the live collector, pending seed, and pass-through bytes for ONLY the given id', () => {
    registerLiveDocument(() => null, 'item-a')
    stashLoadedDocument(makeArchive(), 'item-b')
    expect(hasLiveDocument('item-a')).toBe(true)
    expect(takePendingDocumentSeed('item-a')).toBeNull() // registerLiveDocument alone stashes no seed

    disposeModelItem('item-a')

    expect(hasLiveDocument('item-a')).toBe(false)
    // item-b, a DIFFERENT id, is untouched -- its pending seed is still there.
    expect(takePendingDocumentSeed('item-b')).not.toBeNull()
  })

  it('disposes the autosave controller for that id (getAutosaveController -> null)', () => {
    setDocumentStorage(new InMemoryDocumentStorage())
    startDocumentAutosave({ documentId: 'doc-a' }, 'item-a')
    startDocumentAutosave({ documentId: 'doc-b' }, 'item-b')
    expect(getAutosaveController('item-a')).not.toBeNull()

    disposeModelItem('item-a')

    expect(getAutosaveController('item-a')).toBeNull()
    // item-b's own controller must survive item-a's disposal.
    expect(getAutosaveController('item-b')).not.toBeNull()
    disposeDocumentAutosave('item-b')
  })

  it('bumps the generation for that id so a still-subscribed listener is notified', () => {
    stashLoadedDocument(makeArchive(), 'item-a')
    const before = getDocumentGeneration('item-a')
    let notified = false
    const unsubscribe = subscribeDocumentGeneration(() => { notified = true }, 'item-a')

    disposeModelItem('item-a')

    expect(getDocumentGeneration('item-a')).toBeGreaterThan(before)
    expect(notified).toBe(true)
    unsubscribe()
  })
})
