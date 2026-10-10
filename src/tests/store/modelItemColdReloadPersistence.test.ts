import { beforeEach, describe, expect, it } from 'vitest'
import { FeatureDag } from '../../doc/dag'
import {
  documentIdForProject,
  documentCheckpointStorageKey,
  collectDocumentArchive,
  getAutosaveController,
  getDocumentGeneration,
  hydrateDocumentCheckpoint,
  registerLiveDocument,
  markDocumentDirty,
  removeDocumentCheckpoint,
  resetDocumentHolder,
  setDocumentStorage,
  stashLoadedDocument,
  startDocumentAutosave,
  storeDocumentCheckpointBytes,
  takePendingDocumentSeed,
} from '../../doc/documentHolder'
import {
  autosaveDataKey,
  autosaveStateKey,
  createDocumentArchive,
  InMemoryDocumentStorage,
  loadDocumentArchive,
  readAutosaveSnapshot,
  writeAutosaveSnapshot,
  type BinaryDocumentStorage,
} from '../../doc/persist'
import { arrayBufferToBase64 } from '../../lib/projectBinaries'
import { persistPartialize, useCamStore } from '../../store'

function archive(featureId: string): Uint8Array {
  const dag = new FeatureDag()
  dag.insertNode({
    id: featureId,
    kind: 'feature',
    payload: { opType: 'extrude', height: featureId === 'FEATURE_A' ? 10 : 20 },
  })
  return createDocumentArchive({ dag, elementMapDeltas: [] })
}

function resetStore(): void {
  resetDocumentHolder()
  useCamStore.setState((s) => ({
    project: {
      ...s.project,
      id: 'cold-project',
      geometry: [],
      modelItems: [],
      modelItemPlacements: [],
    },
    workspace: 'cam',
    activeModelItemId: null,
    consoleEvents: [],
  }))
}

class DeferredStorage implements BinaryDocumentStorage {
  private readonly inner = new InMemoryDocumentStorage()
  private gate:
    | {
        op: 'read' | 'write' | 'remove'
        key: string
        started: Promise<void>
        signalStarted: () => void
        blocked: Promise<void>
        release: () => void
      }
    | undefined

  defer(op: 'read' | 'write' | 'remove', key: string) {
    let signalStarted!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => { signalStarted = resolve })
    const blocked = new Promise<void>((resolve) => { release = resolve })
    this.gate = { op, key, started, signalStarted, blocked, release }
    return { started, release }
  }

  private async pause(op: 'read' | 'write' | 'remove', key: string): Promise<void> {
    const gate = this.gate
    if (!gate || gate.op !== op || gate.key !== key) return
    this.gate = undefined
    gate.signalStarted()
    await gate.blocked
  }

  async read(key: string): Promise<Uint8Array | undefined> {
    await this.pause('read', key)
    return this.inner.read(key)
  }

  async write(key: string, bytes: Uint8Array): Promise<void> {
    await this.pause('write', key)
    return this.inner.write(key, bytes)
  }

  async remove(key: string): Promise<void> {
    await this.pause('remove', key)
    return this.inner.remove(key)
  }
}

class FailingWriteStorage implements BinaryDocumentStorage {
  async read(): Promise<Uint8Array | undefined> { return undefined }
  async write(): Promise<void> { throw new Error('injected checkpoint failure') }
  async remove(): Promise<void> {}
}

describe('Model Item browser-reload acquisition gate', () => {
  beforeEach(resetStore)

  it('rehydrates the exact authored A document before committing Model navigation', async () => {
    const storage = new InMemoryDocumentStorage()
    setDocumentStorage(storage)
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        modelItems: [{
          id: 'item-a',
          name: 'Model A',
          documentState: 'authored',
          documentStorageKey: documentCheckpointStorageKey(s.project.id, 'item-a'),
        }],
      },
    }))
    stashLoadedDocument(archive('FEATURE_A'), 'item-a')
    expect(await useCamStore.getState().flushModelItemDocument('item-a')).toBe(true)
    const savedManifest = useCamStore.getState().project.modelItems![0]

    // Simulate a real page reload: Zustand metadata survives, holder module
    // memory does not, and the same durable binary backend remains available.
    resetDocumentHolder()
    setDocumentStorage(storage)
    useCamStore.setState((s) => ({
      project: { ...s.project, modelItems: [savedManifest] },
      workspace: 'cam',
      activeModelItemId: null,
    }))

    await useCamStore.getState().openModelItem('item-a')

    expect(useCamStore.getState().workspace).toBe('part')
    expect(useCamStore.getState().activeModelItemId).toBe('item-a')
    const seed = takePendingDocumentSeed('item-a')
    expect(seed?.dag.getNode('FEATURE_A')).toBeDefined()
    expect(seed?.dag.nodeIds()).toEqual(['FEATURE_A'])
  })

  it('keeps CAM and its rows intact when an authored checkpoint is missing', async () => {
    const storage = new InMemoryDocumentStorage()
    setDocumentStorage(storage)
    const geometry = [{ id: 'cam-row-survives' }] as never
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        geometry,
        modelItems: [{
          id: 'item-a',
          name: 'Model A',
          documentState: 'authored',
          documentStorageKey: documentCheckpointStorageKey(s.project.id, 'item-a'),
          documentRevision: 7,
        }],
      },
      workspace: 'cam',
      activeModelItemId: null,
    }))

    await useCamStore.getState().openModelItem('item-a')

    expect(useCamStore.getState().workspace).toBe('cam')
    expect(useCamStore.getState().activeModelItemId).toBeNull()
    expect(useCamStore.getState().project.geometry).toBe(geometry)
    expect(useCamStore.getState().consoleEvents.at(-1)?.message).toMatch(/checkpoint is missing/i)
  })

  it('allows genesis only for an item explicitly marked empty', async () => {
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        modelItems: [{ id: 'item-empty', name: 'Empty Model', documentState: 'empty' }],
      },
    }))

    await useCamStore.getState().openModelItem('item-empty')

    expect(useCamStore.getState().workspace).toBe('part')
    expect(useCamStore.getState().activeModelItemId).toBe('item-empty')
    expect(takePendingDocumentSeed('item-empty')).toBeNull()
  })

  it('a delayed A hydrate cannot override a newer B navigation', async () => {
    const storage = new DeferredStorage()
    const projectId = 'cold-project'
    const aDocumentId = documentIdForProject(projectId, 'item-a')
    const bDocumentId = documentIdForProject(projectId, 'item-b')
    await writeAutosaveSnapshot(storage, aDocumentId, archive('FEATURE_A'), 1)
    await writeAutosaveSnapshot(storage, bDocumentId, archive('FEATURE_B'), 1)
    setDocumentStorage(storage)
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        modelItems: [
          {
            id: 'item-a', name: 'A', documentState: 'authored',
            documentStorageKey: documentCheckpointStorageKey(projectId, 'item-a'),
            documentRevision: 1,
          },
          {
            id: 'item-b', name: 'B', documentState: 'authored',
            documentStorageKey: documentCheckpointStorageKey(projectId, 'item-b'),
            documentRevision: 1,
          },
        ],
      },
    }))
    const delayed = storage.defer('read', autosaveStateKey(aDocumentId))
    const openingA = useCamStore.getState().openModelItem('item-a') as Promise<void>
    await delayed.started
    await useCamStore.getState().openModelItem('item-b')
    delayed.release()
    await openingA

    expect(useCamStore.getState().workspace).toBe('part')
    expect(useCamStore.getState().activeModelItemId).toBe('item-b')
    expect(takePendingDocumentSeed('item-a')).toBeNull()
    expect(takePendingDocumentSeed('item-b')?.dag.has('FEATURE_B')).toBe(true)
  })

  it('File Open waits for its checkpoint before installing the project manifest', async () => {
    const storage = new DeferredStorage()
    setDocumentStorage(storage)
    const bytes = archive('FEATURE_A')
    const incoming = {
      ...structuredClone(useCamStore.getState().project),
      id: 'incoming-project',
      name: 'Incoming',
      modelItems: [{ id: 'item-a', name: 'A', documentState: 'authored' }],
      modelItemDocuments: {
        'item-a': arrayBufferToBase64(bytes.buffer as ArrayBuffer),
      },
    }
    const documentId = documentIdForProject(incoming.id, 'item-a')
    const delayed = storage.defer('write', autosaveDataKey(documentId))
    const opening = useCamStore.getState().loadProjectFromFile(
      JSON.stringify(incoming),
    ) as Promise<void>
    await delayed.started
    expect(useCamStore.getState().project.id).toBe('cold-project')
    delayed.release()
    await opening

    expect(useCamStore.getState().project.id).toBe('incoming-project')
    expect(useCamStore.getState().project.modelItems?.[0]).toMatchObject({
      id: 'item-a',
      documentState: 'authored',
      documentStorageKey: documentCheckpointStorageKey('incoming-project', 'item-a'),
      documentRevision: 1,
    })
  })

  it('a failed same-id File Open preserves the old holder and its live autosave controller', async () => {
    const oldBytes = archive('FEATURE_B')
    stashLoadedDocument(oldBytes, 'item-a')
    registerLiveDocument(
      () => ({ dag: loadDocumentArchive(oldBytes).dag, elementMapDeltas: [] }),
      'item-a',
    )
    const oldStorage = new InMemoryDocumentStorage()
    const oldDocumentId = documentIdForProject('cold-project', 'item-a')
    const controller = startDocumentAutosave(
      { documentId: oldDocumentId, storage: oldStorage, debounceMs: 60_000 },
      'item-a',
    )
    const oldGeneration = getDocumentGeneration('item-a')
    const oldProject = useCamStore.getState().project
    setDocumentStorage(new FailingWriteStorage())
    const incoming = {
      ...structuredClone(oldProject),
      id: 'cold-project',
      name: 'Incoming Fails',
      modelItems: [{ id: 'item-a', name: 'A', documentState: 'authored' }],
      modelItemDocuments: {
        'item-a': arrayBufferToBase64(archive('FEATURE_A').buffer as ArrayBuffer),
      },
    }

    await useCamStore.getState().loadProjectFromFile(JSON.stringify(incoming))

    expect(useCamStore.getState().project).toBe(oldProject)
    expect(getDocumentGeneration('item-a')).toBe(oldGeneration)
    const stillHeld = collectDocumentArchive('item-a')
    expect(stillHeld).toBeDefined()
    expect(loadDocumentArchive(stillHeld!).dag.has('FEATURE_B')).toBe(true)
    expect(getAutosaveController('item-a')).toBe(controller)

    markDocumentDirty('item-a')
    await controller.flush()
    const autosaved = await readAutosaveSnapshot(oldStorage, oldDocumentId)
    expect(autosaved).toBeDefined()
    expect(loadDocumentArchive(autosaved!.bytes).dag.has('FEATURE_B')).toBe(true)
  })

  it('a delayed old autosave cannot overwrite newly opened bytes for the same key', async () => {
    const storage = new DeferredStorage()
    setDocumentStorage(storage)
    registerLiveDocument(
      () => ({ dag: loadDocumentArchive(archive('FEATURE_A')).dag, elementMapDeltas: [] }),
      'item-a',
    )
    const documentId = documentIdForProject('cold-project', 'item-a')
    const controller = startDocumentAutosave(
      { documentId, storage, debounceMs: 60_000 },
      'item-a',
    )
    const delayed = storage.defer('write', autosaveDataKey(documentId))
    controller.markDirty()
    const oldFlush = controller.flush()
    await delayed.started
    const replacement = storeDocumentCheckpointBytes(
      'cold-project',
      'item-a',
      archive('FEATURE_B'),
    )
    delayed.release()
    await Promise.all([oldFlush, replacement])

    const restored = await hydrateDocumentCheckpoint(
      'cold-project',
      'item-a',
      documentCheckpointStorageKey('cold-project', 'item-a'),
      1,
    )
    expect(loadDocumentArchive(restored.bytes).dag.has('FEATURE_B')).toBe(true)
    expect(loadDocumentArchive(restored.bytes).dag.has('FEATURE_A')).toBe(false)
  })

  it('a delayed delete cannot remove a same-id replacement checkpoint', async () => {
    const storage = new DeferredStorage()
    setDocumentStorage(storage)
    const documentId = documentIdForProject('cold-project', 'item-a')
    await writeAutosaveSnapshot(storage, documentId, archive('FEATURE_A'), 1)
    const delayed = storage.defer('remove', autosaveDataKey(documentId))
    const deleting = removeDocumentCheckpoint('cold-project', 'item-a')
    await delayed.started
    const replacement = storeDocumentCheckpointBytes(
      'cold-project',
      'item-a',
      archive('FEATURE_B'),
    )
    delayed.release()
    await Promise.all([deleting, replacement])

    const restored = await hydrateDocumentCheckpoint(
      'cold-project',
      'item-a',
      documentCheckpointStorageKey('cold-project', 'item-a'),
      1,
    )
    expect(loadDocumentArchive(restored.bytes).dag.has('FEATURE_B')).toBe(true)
  })

  it('persistPartialize strips both file-only modeling archive fields', () => {
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        document: 'legacy-file-bytes',
        modelItemDocuments: { 'item-a': 'item-file-bytes' },
      },
    }))

    const persisted = persistPartialize(useCamStore.getState()).project

    expect('document' in persisted).toBe(false)
    expect('modelItemDocuments' in persisted).toBe(false)
  })
})
