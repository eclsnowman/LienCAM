import { beforeEach, describe, expect, it, vi } from 'vitest'
// Imported BEFORE the doc/store imports below on purpose: they transitively
// (and projectBinaries directly) trigger this file's mock factories during
// THEIR static-import resolution. A `typedMock` import placed after them left
// a factory closing over a binding not yet initialized - "Cannot access
// '__vi_import_N__' before initialization" (see holderClearance3d.wo278.test.ts).
import { typedMock } from '../support/typedMock'
import { FeatureDag } from '../../doc/dag'
import {
  autosaveDataKey,
  createDocumentArchive,
  InMemoryDocumentStorage,
  type BinaryDocumentStorage,
} from '../../doc/persist'
import {
  documentIdForProject,
  resetDocumentHolder,
  setDocumentStorage,
} from '../../doc/documentHolder'
import { arrayBufferToBase64 } from '../../lib/projectBinaries'

const asyncSeams = vi.hoisted(() => {
  type Gate = {
    promise: Promise<void>
    started: Promise<void>
    release: () => void
    signalStarted: () => void
  }
  const hydrate: Gate[] = []
  const scene: Gate[] = []
  const sceneFailures: Error[] = []
  const makeGate = (): Gate => {
    let release!: () => void
    let signalStarted!: () => void
    return {
      promise: new Promise<void>((resolve) => { release = resolve }),
      started: new Promise<void>((resolve) => { signalStarted = resolve }),
      release: () => release(),
      signalStarted: () => signalStarted(),
    }
  }
  const hold = (queue: Gate[]) => {
    const gate = makeGate()
    queue.push(gate)
    return { started: gate.started, release: gate.release }
  }
  const run = (queue: Gate[]) => {
    const gate = queue.shift()
    if (!gate) return Promise.resolve()
    gate.signalStarted()
    return gate.promise
  }
  return {
    holdHydrate: () => hold(hydrate),
    runHydrate: () => run(hydrate),
    holdScene: () => hold(scene),
    runScene: () => {
      const failure = sceneFailures.shift()
      return failure ? Promise.reject(failure) : run(scene)
    },
    failScene: (error: Error) => { sceneFailures.push(error) },
  }
})

vi.mock('../../lib/projectBinaries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/projectBinaries')>()
  return typedMock<typeof import('../../lib/projectBinaries')>({
    ...actual, hydrateCachesFromBinaries: vi.fn(() => asyncSeams.runHydrate()),
  })
})

vi.mock('../../lib/viewport/restoreScene', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/viewport/restoreScene')>()
  return typedMock<typeof import('../../lib/viewport/restoreScene')>({
    ...actual, reloadProjectScene: vi.fn(() => asyncSeams.runScene()),
  })
})

const { CURRENT_PROJECT_SCHEMA_VERSION } = await import('../../store/migrations/projectMigrations')
const { useCamStore, persistMerge, persistPartialize } = await import('../../store')

function projectFile(id: string, extra: Record<string, unknown> = {}): string {
  const current = structuredClone(useCamStore.getState().project)
  return JSON.stringify({
    ...current,
    id,
    name: `Project ${id}`,
    geometry: [],
    setups: [],
    modelItems: [],
    modelItemPlacements: [],
    ...extra,
  })
}

function archive(): Uint8Array {
  const dag = new FeatureDag()
  dag.insertNode({ id: 'F1', kind: 'feature', payload: { opType: 'extrude', height: 5 } })
  return createDocumentArchive({ dag, elementMapDeltas: [] })
}

function authoredProjectFile(id: string): string {
  const bytes = archive()
  return projectFile(id, {
    modelItems: [{ id: 'item-a', name: 'Model A', documentState: 'authored' }],
    modelItemDocuments: {
      'item-a': arrayBufferToBase64(bytes.buffer as ArrayBuffer),
    },
  })
}

class DeferredStorage implements BinaryDocumentStorage {
  private readonly inner = new InMemoryDocumentStorage()
  private blockedWrite:
    | { key: string; started: Promise<void>; signal: () => void; wait: Promise<void>; release: () => void }
    | undefined

  deferWrite(key: string) {
    let signal!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => { signal = resolve })
    const wait = new Promise<void>((resolve) => { release = resolve })
    this.blockedWrite = { key, started, signal, wait, release }
    return { started, release }
  }

  async read(key: string): Promise<Uint8Array | undefined> { return this.inner.read(key) }
  async write(key: string, bytes: Uint8Array): Promise<void> {
    const blocked = this.blockedWrite
    if (blocked?.key === key) {
      this.blockedWrite = undefined
      blocked.signal()
      await blocked.wait
    }
    await this.inner.write(key, bytes)
  }
  async remove(key: string): Promise<void> { await this.inner.remove(key) }
}

class FailingStorage implements BinaryDocumentStorage {
  async read(): Promise<Uint8Array | undefined> { return undefined }
  async write(): Promise<void> { throw new Error('injected storage failure') }
  async remove(): Promise<void> {}
}

beforeEach(() => {
  resetDocumentHolder()
  setDocumentStorage(new InMemoryDocumentStorage())
  useCamStore.setState((s) => ({
    project: { ...s.project, id: 'baseline', name: 'Baseline', geometry: [], setups: [], modelItems: [] },
    projectOpen: null,
    workspace: 'cam',
    consoleEvents: [],
    consoleReadThroughId: 0,
  }))
  vi.stubGlobal('window', { confirm: () => false, __cncViewport: {} })
})

describe('UI-85 project-open progress ownership', () => {
  it('drops legacy localStorage binaries while merging persisted state', () => {
    const current = useCamStore.getState()
    const persistedProject = {
      ...structuredClone(current.project),
      binaries: { version: 1 as const, files: {} },
    }

    const merged = persistMerge({ project: persistedProject }, current)

    expect(merged.project.binaries).toBeUndefined()
  })

  it('reports honest phases and stays busy through cache hydration and scene restoration', async () => {
    const phases: string[] = []
    const unsubscribe = useCamStore.subscribe((s) => {
      const phase = s.projectOpen?.phase
      if (phase && phases.at(-1) !== phase) phases.push(phase)
    })
    const hydrate = asyncSeams.holdHydrate()
    const scene = asyncSeams.holdScene()
    const opening = useCamStore.getState().loadProjectFromFile(
      projectFile('success', { binaries: {} }),
    )

    await hydrate.started
    expect(useCamStore.getState().projectOpen?.phase).toBe('restoring-scene')
    expect(useCamStore.getState().project.id).toBe('success')
    hydrate.release()

    await scene.started
    expect(useCamStore.getState().projectOpen?.phase).toBe('restoring-scene')
    scene.release()
    await opening
    unsubscribe()

    expect(phases).toEqual([
      'validating-project',
      'validating-model-documents',
      'restoring-checkpoints',
      'installing-project',
      'restoring-scene',
    ])
    expect(useCamStore.getState().projectOpen).toBeNull()
    expect(useCamStore.getState().project.binaries).toBeUndefined()
    expect('binaries' in persistPartialize(useCamStore.getState()).project).toBe(false)
    expect(useCamStore.getState().consoleEvents.at(-1)).toMatchObject({
      severity: 'success', source: 'project', message: 'Project opened: Project success',
    })
  })

  it.each([
    ['invalid JSON', 'not-json'],
    ['invalid shape', JSON.stringify({ nope: true })],
    ['newer schema', projectFile('future', { schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION + 1 })],
  ])('%s clears its own busy state', async (_label, file) => {
    await useCamStore.getState().loadProjectFromFile(file)
    expect(useCamStore.getState().projectOpen).toBeNull()
    expect(useCamStore.getState().project.id).toBe('baseline')
  })

  it('checkpoint storage failure clears busy without installing a partial project', async () => {
    setDocumentStorage(new FailingStorage())
    await useCamStore.getState().loadProjectFromFile(authoredProjectFile('storage-fails'))
    expect(useCamStore.getState().projectOpen).toBeNull()
    expect(useCamStore.getState().project.id).toBe('baseline')
    expect(useCamStore.getState().consoleEvents.at(-1)?.message).toMatch(/could not be stored safely/i)
  })

  it('a post-commit scene failure is named, non-blocking, and clears busy', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    asyncSeams.failScene(new Error('injected scene failure'))
    await useCamStore.getState().loadProjectFromFile(projectFile('scene-warning'))

    expect(useCamStore.getState().project.id).toBe('scene-warning')
    expect(useCamStore.getState().projectOpen).toBeNull()
    expect(useCamStore.getState().consoleEvents).toContainEqual(expect.objectContaining({
      severity: 'warning',
      source: 'project',
      message: expect.stringMatching(/opened.*scene.*injected scene failure/i),
    }))
    expect(errorSpy).toHaveBeenCalledWith(
      'Project open: scene restoration failed:',
      expect.any(Error),
    )
  })

  it('an older load cannot overwrite the newer project or clear its progress', async () => {
    const storage = new DeferredStorage()
    setDocumentStorage(storage)
    const oldId = 'old-delayed'
    const write = storage.deferWrite(autosaveDataKey(documentIdForProject(oldId, 'item-a')))
    const oldOpening = useCamStore.getState().loadProjectFromFile(authoredProjectFile(oldId))
    await write.started
    expect(useCamStore.getState().projectOpen?.phase).toBe('restoring-checkpoints')

    const newerScene = asyncSeams.holdScene()
    const newOpening = useCamStore.getState().loadProjectFromFile(projectFile('new-wins'))
    await newerScene.started
    expect(useCamStore.getState().project.id).toBe('new-wins')
    const newerRequest = useCamStore.getState().projectOpen?.requestId

    write.release()
    await oldOpening
    expect(useCamStore.getState().projectOpen?.requestId).toBe(newerRequest)
    expect(useCamStore.getState().projectOpen?.phase).toBe('restoring-scene')
    expect(useCamStore.getState().project.id).toBe('new-wins')

    newerScene.release()
    await newOpening
    expect(useCamStore.getState().projectOpen).toBeNull()
    expect(useCamStore.getState().project.id).toBe('new-wins')
  })

  it('New Project invalidates an in-flight load and keeps the fresh project', async () => {
    const storage = new DeferredStorage()
    setDocumentStorage(storage)
    const oldId = 'old-before-new'
    const write = storage.deferWrite(autosaveDataKey(documentIdForProject(oldId, 'item-a')))
    const opening = useCamStore.getState().loadProjectFromFile(authoredProjectFile(oldId))
    await write.started

    useCamStore.getState().newProject()
    const freshId = useCamStore.getState().project.id
    expect(useCamStore.getState().projectOpen).toBeNull()
    write.release()
    await opening

    expect(useCamStore.getState().project.id).toBe(freshId)
    expect(useCamStore.getState().project.id).not.toBe(oldId)
    expect(useCamStore.getState().projectOpen).toBeNull()
  })
})
