import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore } from 'zustand/vanilla'
import { createJSONStorage, persist } from 'zustand/middleware'
import {
  createUserSpaceStateStorage,
  DurableUserSpaceStateStorage,
  installUserSpaceUnloadJournal,
  resetUserSpaceStateStorage,
  type LegacyStorage,
  type UserSpaceStateStorage,
  type UserSpaceStorage,
} from '../../store/userSpaceStorage'

// WO-1505 / BUG-423: the persisted project writes through an async OPFS chain.
// A browser does not wait for that chain when the page unloads, so these tests
// model an unload as "every async storage call after pagehide is abandoned"
// and a reload as a fresh page reading the same files.

const STORAGE_KEY = 'cnc-cam-project'

type ProjectState = { finishDepth: number }

class PageFiles implements UserSpaceStorage {
  readonly files: Map<string, string>
  gate: Promise<void> | null = null
  unloaded = false
  failWrites = false

  constructor(files = new Map<string, string>()) {
    this.files = files
  }

  async readText(path: string): Promise<string | null> {
    await this.gate
    this.assertAlive()
    return this.files.get(path) ?? null
  }

  async writeText(path: string, value: string): Promise<void> {
    await this.gate
    this.assertAlive()
    if (this.failWrites) throw new DOMException('quota', 'QuotaExceededError')
    this.files.set(path, value)
  }

  async remove(path: string): Promise<void> {
    await this.gate
    this.assertAlive()
    this.files.delete(path)
  }

  /** Holds every async storage call until the returned release runs. */
  hold(): () => void {
    let release!: () => void
    this.gate = new Promise<void>((resolve) => { release = resolve })
    return () => {
      this.gate = null
      release()
    }
  }

  private assertAlive(): void {
    if (this.unloaded) throw new Error('page unloaded: in-flight write abandoned')
  }
}

class MemoryLegacyStorage implements LegacyStorage {
  readonly values = new Map<string, string>()
  getItem(name: string): string | null { return this.values.get(name) ?? null }
  setItem(name: string, value: string): void { this.values.set(name, value) }
  removeItem(name: string): void { this.values.delete(name) }
}

async function openPage(files: UserSpaceStorage, legacy: LegacyStorage): Promise<{
  store: ReturnType<typeof makeStore>
  storage: UserSpaceStateStorage
  pageEvents: EventTarget
}> {
  const storage = createUserSpaceStateStorage({
    durableStorage: files,
    legacyStorage: legacy,
    onWarning: () => {},
  })
  const store = makeStore(storage)
  if (!store.persist.hasHydrated()) {
    await new Promise<void>((resolve) => { store.persist.onFinishHydration(() => resolve()) })
  }
  const pageEvents = new EventTarget()
  installUserSpaceUnloadJournal(storage, pageEvents)
  return { store, storage, pageEvents }
}

function makeStore(storage: UserSpaceStateStorage) {
  return createStore<ProjectState>()(persist<ProjectState>(
    () => ({ finishDepth: 0 }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage<ProjectState>(() => storage),
      onRehydrateStorage: () => () => storage.finishInitialHydration(),
    },
  ))
}

function write(store: ReturnType<typeof makeStore>, finishDepth: number): Promise<void> {
  return (store.setState({ finishDepth }) as unknown as Promise<void>).catch(() => {})
}

async function durableFinishDepth(files: Map<string, string>): Promise<number | null> {
  const raw = await new DurableUserSpaceStateStorage(new PageFiles(files), null, () => {})
    .getItem(STORAGE_KEY)
  return raw === null ? null : (JSON.parse(raw) as { state: ProjectState }).state.finishDepth
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('WO-1505 the last project write survives a page unload', () => {
  let files: Map<string, string>
  let legacy: MemoryLegacyStorage

  beforeEach(async () => {
    files = new Map()
    legacy = new MemoryLegacyStorage()
    await new DurableUserSpaceStateStorage(new PageFiles(files), legacy, () => {})
      .setItem(STORAGE_KEY, JSON.stringify({ state: { finishDepth: 1 }, version: 0 }))
  })

  it('control: without the pagehide journal an unload mid-write restores the older project', async () => {
    const page1 = new PageFiles(files)
    const { store } = await openPage(page1, legacy)
    const release = page1.hold()
    const pending = [write(store, 2), write(store, 3)]

    page1.unloaded = true // unload with no pagehide listener run
    release()
    await Promise.all(pending)

    const reloaded = await openPage(new PageFiles(files), legacy)
    expect(reloaded.store.getState().finishDepth).toBe(1)
  })

  it('reloads the latest state when pagehide fires before the durable write settles', async () => {
    const page1 = new PageFiles(files)
    const { store, pageEvents } = await openPage(page1, legacy)
    expect(store.getState().finishDepth).toBe(1)

    const release = page1.hold()
    const pending = [write(store, 2), write(store, 3)]
    pageEvents.dispatchEvent(new Event('pagehide'))
    page1.unloaded = true
    release()
    await Promise.all(pending)
    expect(await durableFinishDepth(files)).toBe(1)

    const page2 = new PageFiles(files)
    const reloaded = await openPage(page2, legacy)
    expect(reloaded.store.getState().finishDepth).toBe(3)
    // The replay commits to durable storage and retires the journal, so a
    // second reload reads the same state from OPFS alone.
    expect(await durableFinishDepth(files)).toBe(3)
    expect(reloaded.storage.journalPendingWrites()).toBe(0)
    const third = await openPage(new PageFiles(files), legacy)
    expect(third.store.getState().finishDepth).toBe(3)
  })

  it('leaves ordinary writes unchanged: serialized, settled, nothing journaled', async () => {
    const page = new PageFiles(files)
    const { store, storage } = await openPage(page, legacy)
    const legacyKeysBefore = [...legacy.values.keys()].sort()

    await Promise.all([write(store, 2), write(store, 3), write(store, 4)])

    expect(storage.journalPendingWrites()).toBe(0)
    expect([...legacy.values.keys()].sort()).toEqual(legacyKeysBefore)
    expect(await durableFinishDepth(files)).toBe(4)
    const reloaded = await openPage(new PageFiles(files), legacy)
    expect(reloaded.store.getState().finishDepth).toBe(4)
  })

  it('retires the journal when a page hidden into the back-forward cache returns and commits newer work', async () => {
    const page = new PageFiles(files)
    const { store, pageEvents } = await openPage(page, legacy)
    const legacyKeysBefore = [...legacy.values.keys()].sort()

    const release = page.hold()
    const pending = [write(store, 2), write(store, 3)]
    pageEvents.dispatchEvent(new Event('pagehide'))
    expect([...legacy.values.keys()].length).toBeGreaterThan(legacyKeysBefore.length)
    // The page comes back instead of unloading and keeps editing.
    pending.push(write(store, 4))
    release()
    await Promise.all(pending)
    await settle()

    expect([...legacy.values.keys()].sort()).toEqual(legacyKeysBefore)
    const reloaded = await openPage(new PageFiles(files), legacy)
    expect(reloaded.store.getState().finishDepth).toBe(4)
  })

  it('does not replay a journal after the project data is reset', async () => {
    const page1 = new PageFiles(files)
    const { store, pageEvents } = await openPage(page1, legacy)
    const release = page1.hold()
    const pending = [write(store, 3)]
    pageEvents.dispatchEvent(new Event('pagehide'))
    page1.unloaded = true
    release()
    await Promise.all(pending)

    await expect(resetUserSpaceStateStorage(STORAGE_KEY, {
      durableStorage: new PageFiles(files),
      legacyStorage: legacy,
      onWarning: () => {},
    })).resolves.toBe(true)

    const reloaded = await openPage(new PageFiles(files), legacy)
    expect(reloaded.store.getState().finishDepth).toBe(0)
  })

  it('keeps the journaled state when its replay cannot commit, until a later write does', async () => {
    const page1 = new PageFiles(files)
    const { store, pageEvents } = await openPage(page1, legacy)
    const release = page1.hold()
    const pending = [write(store, 3)]
    pageEvents.dispatchEvent(new Event('pagehide'))
    page1.unloaded = true
    release()
    await Promise.all(pending)

    const failingPage = new PageFiles(files)
    failingPage.failWrites = true
    const failed = await openPage(failingPage, legacy)
    expect(failed.store.getState().finishDepth).toBe(3)

    const retryPage = new PageFiles(files)
    const retried = await openPage(retryPage, legacy)
    expect(retried.store.getState().finishDepth).toBe(3)
    await write(retried.store, 5)
    await settle()
    const final = await openPage(new PageFiles(files), legacy)
    expect(final.store.getState().finishDepth).toBe(5)
    expect(await durableFinishDepth(files)).toBe(5)
  })

  it('removes its pagehide listener when disposed', () => {
    const target = new EventTarget()
    const storage = { journalPendingWrites: vi.fn(() => 0) }
    const dispose = installUserSpaceUnloadJournal(storage, target)
    target.dispatchEvent(new Event('pagehide'))
    target.dispatchEvent(new Event('pagehide'))
    dispose()
    target.dispatchEvent(new Event('pagehide'))
    expect(storage.journalPendingWrites).toHaveBeenCalledTimes(2)
  })

  it('wires the app store to pagehide', async () => {
    const { installPersistedStateUnloadJournal } = await import('../../store/index')
    const target = new EventTarget()
    const add = vi.spyOn(target, 'addEventListener')
    const remove = vi.spyOn(target, 'removeEventListener')
    const dispose = installPersistedStateUnloadJournal(target)
    expect(add).toHaveBeenCalledWith('pagehide', expect.any(Function))
    dispose()
    expect(remove).toHaveBeenCalledWith('pagehide', add.mock.calls[0][1])
  }, 60_000)
})
