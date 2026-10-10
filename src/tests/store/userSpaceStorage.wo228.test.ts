import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore } from 'zustand/vanilla'
import { createJSONStorage, persist } from 'zustand/middleware'
import {
  createUserSpaceStateStorage,
  DurableUserSpaceStateStorage,
  OpfsUserSpaceStorage,
  resetUserSpaceStateStorage,
  USER_SPACE_BOOT_PREFERENCES_KEY,
  USER_SPACE_STORAGE_WARNING,
  type LegacyStorage,
  type UserSpaceStorage,
  type UserSpaceStorageWarning,
} from '../../store/userSpaceStorage'

const STORAGE_KEY = 'cnc-cam-project'

class MemoryUserSpaceStorage implements UserSpaceStorage {
  readonly files = new Map<string, string>()
  writes = 0
  failRead: ((path: string) => unknown) | null = null
  failWrite: ((path: string) => unknown) | null = null
  failRemove: ((path: string) => unknown) | null = null
  readBarrier: Promise<void> | null = null

  async readText(path: string): Promise<string | null> {
    await this.readBarrier
    const failure = this.failRead?.(path)
    if (failure !== undefined && failure !== null) throw failure
    return this.files.get(path) ?? null
  }

  async writeText(path: string, value: string): Promise<void> {
    const failure = this.failWrite?.(path)
    if (failure !== undefined && failure !== null) throw failure
    this.writes += 1
    this.files.set(path, value)
  }

  async remove(path: string): Promise<void> {
    const failure = this.failRemove?.(path)
    if (failure !== undefined && failure !== null) throw failure
    this.files.delete(path)
  }

  pathEnding(suffix: string): string {
    const path = [...this.files.keys()].find((candidate) => candidate.endsWith(suffix))
    if (!path) throw new Error(`missing in-memory path ending ${suffix}`)
    return path
  }
}

class MemoryLegacyStorage implements LegacyStorage {
  readonly values = new Map<string, string>()
  readonly removeItem = vi.fn((name: string) => { this.values.delete(name) })

  getItem(name: string): string | null {
    return this.values.get(name) ?? null
  }

  setItem(name: string, value: string): void {
    this.values.set(name, value)
  }
}

function persistedPayload(marker: string): string {
  return JSON.stringify({
    state: {
      toolLibrary: [{ id: `tool-${marker}`, name: 'Rougher' }],
      toolLibraries: [
        { id: 'library-mill', name: 'Mill' },
        { id: 'library-router', name: 'Router' },
      ],
      holders: [
        { id: 'holder-er32', name: 'ER32' },
        { id: 'holder-hsk', name: 'HSK' },
      ],
      machineLibrary: [
        { id: 'machine-mill', name: 'Mill' },
        { id: 'machine-router', name: 'Router' },
      ],
      appSettings: { defaultMachineId: 'machine-mill', units: 'metric' },
      importedFonts: [{ family: 'Shop Marking', typeface: { glyphs: {} } }],
      project: { id: `project-${marker}`, name: 'Recovery snapshot', geometry: [], setups: [] },
    },
    version: 5,
  })
}

describe('WO-228 durable user-space storage', () => {
  let files: MemoryUserSpaceStorage
  let legacy: MemoryLegacyStorage
  let warnings: UserSpaceStorageWarning[]

  beforeEach(() => {
    files = new MemoryUserSpaceStorage()
    legacy = new MemoryLegacyStorage()
    warnings = []
  })

  const open = () => new DurableUserSpaceStateStorage(
    files,
    legacy,
    (warning) => warnings.push(warning),
  )

  it('returns empty only when OPFS cannot find a file handle', async () => {
    const missing = new DOMException('missing pointer', 'NotFoundError')
    const root = {
      getFileHandle: vi.fn().mockRejectedValue(missing),
    } as unknown as FileSystemDirectoryHandle

    await expect(new OpfsUserSpaceStorage(root).readText('pointer.json')).resolves.toBeNull()
  })

  it('propagates read failures after OPFS returns an existing file handle', async () => {
    const disappeared = new DOMException('pointer disappeared', 'NotFoundError')
    const unreadable = new DOMException('pointer text unreadable', 'NotFoundError')
    const getFile = vi.fn()
      .mockRejectedValueOnce(disappeared)
      .mockResolvedValueOnce({ text: vi.fn().mockRejectedValue(unreadable) })
    const root = {
      getFileHandle: vi.fn().mockResolvedValue({ getFile }),
    } as unknown as FileSystemDirectoryHandle
    const storage = new OpfsUserSpaceStorage(root)

    await expect(storage.readText('pointer.json')).rejects.toBe(disappeared)
    await expect(storage.readText('pointer.json')).rejects.toBe(unreadable)
  })

  it('reloads multiple libraries, holders, machines, settings, fonts, and the active-project snapshot', async () => {
    const firstSession = open()
    await firstSession.setItem(STORAGE_KEY, persistedPayload('saved'))

    const reloaded = JSON.parse((await open().getItem(STORAGE_KEY))!) as {
      state: Record<string, unknown>
    }
    expect(reloaded.state.toolLibraries).toHaveLength(2)
    expect(reloaded.state.holders).toHaveLength(2)
    expect(reloaded.state.machineLibrary).toHaveLength(2)
    expect(reloaded.state.appSettings).toEqual({ defaultMachineId: 'machine-mill', units: 'metric' })
    expect(reloaded.state.importedFonts).toHaveLength(1)
    expect(reloaded.state.project).toMatchObject({ id: 'project-saved', name: 'Recovery snapshot' })
  })

  it('does not overwrite durable shop data when the store mutates before async hydration finishes', async () => {
    const saved = JSON.stringify({
      state: { toolLibraries: ['saved-library'] },
      version: 0,
    })
    await open().setItem(STORAGE_KEY, saved)

    let releaseRead!: () => void
    files.readBarrier = new Promise<void>((resolve) => { releaseRead = resolve })
    const stateStorage = createUserSpaceStateStorage({
      durableStorage: files,
      legacyStorage: legacy,
      onWarning: (warning) => warnings.push(warning),
    })
    type RaceState = {
      toolLibraries: string[]
      startupMutations: number
    }
    const store = createStore<RaceState>()(persist<RaceState, [], [], Pick<RaceState, 'toolLibraries'>>(
      () => ({ toolLibraries: [], startupMutations: 0 }),
      {
        name: STORAGE_KEY,
        storage: createJSONStorage<Pick<RaceState, 'toolLibraries'>>(() => stateStorage),
        partialize: (state) => ({ toolLibraries: state.toolLibraries }),
        onRehydrateStorage: () => () => stateStorage.finishInitialHydration(),
      },
    ))
    const hydrationFinished = new Promise<void>((resolve) => {
      store.persist.onFinishHydration(() => resolve())
    })

    const startupWrite = store.setState({ startupMutations: 1 }) as unknown as Promise<void>
    releaseRead()
    await Promise.all([hydrationFinished, startupWrite])

    expect(store.getState().toolLibraries).toEqual(['saved-library'])
    const durableAfterHydration = JSON.parse((await open().getItem(STORAGE_KEY))!) as {
      state: { toolLibraries: string[] }
    }
    expect(durableAfterHydration.state.toolLibraries).toEqual(['saved-library'])

    const postHydrationWrite = store.setState({
      toolLibraries: ['after-hydration'],
    }) as unknown as Promise<void>
    await postHydrationWrite
    const durableAfterLiveWrite = JSON.parse((await open().getItem(STORAGE_KEY))!) as {
      state: { toolLibraries: string[] }
    }
    expect(durableAfterLiveWrite.state.toolLibraries).toEqual(['after-hydration'])
  })

  it('keeps the previous generation when an interrupted pointer write cannot commit', async () => {
    const storage = open()
    const knownGood = persistedPayload('known-good')
    await storage.setItem(STORAGE_KEY, knownGood)

    const pointerPath = files.pathEnding('--pointer.json')
    files.failWrite = (path) => path === pointerPath ? new Error('simulated interruption') : null
    await expect(storage.setItem(STORAGE_KEY, persistedPayload('interrupted')))
      .rejects.toThrow('simulated interruption')
    files.failWrite = null

    expect(await open().getItem(STORAGE_KEY)).toBe(knownGood)
  })

  it('falls back with a named recovery warning when the current generation is corrupt', async () => {
    const storage = open()
    const previous = persistedPayload('previous')
    await storage.setItem(STORAGE_KEY, previous)
    await storage.setItem(STORAGE_KEY, persistedPayload('current'))

    const pointer = JSON.parse(files.files.get(files.pathEnding('--pointer.json'))!) as { current: string }
    const currentPath = [...files.files.keys()].find((path) =>
      path.includes('--generation--') && path.includes(encodeURIComponent(pointer.current)))!
    files.files.set(currentPath, '{"partial":')

    expect(await open().getItem(STORAGE_KEY)).toBe(previous)
    expect(warnings.map((warning) => warning.code)).toContain(
      USER_SPACE_STORAGE_WARNING.recoveryFallback,
    )
  })

  it('recovers from a transient durable read error without losing good data on the next write', async () => {
    const storage = open()
    const previous = persistedPayload('previous-read-error')
    await storage.setItem(STORAGE_KEY, previous)
    await storage.setItem(STORAGE_KEY, persistedPayload('current-read-error'))

    const pointerPath = files.pathEnding('--pointer.json')
    let pointerReadFailures = 0
    files.failRead = (path) => path === pointerPath && pointerReadFailures++ === 0
      ? new DOMException('pointer temporarily unreadable', 'NoModificationAllowedError')
      : null
    warnings = []

    const recovered = await open().getItem(STORAGE_KEY)
    expect(recovered).toBe(previous)
    expect(warnings.map((warning) => warning.code)).toContain(
      USER_SPACE_STORAGE_WARNING.recoveryFallback,
    )

    files.failRead = null
    const afterMutation = JSON.parse(recovered!) as {
      state: { appSettings: Record<string, unknown>; toolLibrary: Array<{ id: string }> }
    }
    afterMutation.state.appSettings.units = 'imperial'
    await open().setItem(STORAGE_KEY, JSON.stringify(afterMutation))

    const durableAfterMutation = JSON.parse((await open().getItem(STORAGE_KEY))!) as {
      state: { appSettings: Record<string, unknown>; toolLibrary: Array<{ id: string }> }
    }
    expect(durableAfterMutation.state.toolLibrary[0].id).toBe('tool-previous-read-error')
    expect(durableAfterMutation.state.appSettings.units).toBe('imperial')
  })

  it('does not replace good data when a quota failure rejects a new generation', async () => {
    const storage = open()
    const knownGood = persistedPayload('before-quota')
    await storage.setItem(STORAGE_KEY, knownGood)

    files.failWrite = (path) => path.includes('--generation--')
      ? new DOMException('quota exhausted', 'QuotaExceededError')
      : null
    await expect(storage.setItem(STORAGE_KEY, persistedPayload('too-large')))
      .rejects.toMatchObject({ name: 'QuotaExceededError' })
    files.failWrite = null

    expect(await open().getItem(STORAGE_KEY)).toBe(knownGood)
    expect(warnings.map((warning) => warning.code)).toContain(USER_SPACE_STORAGE_WARNING.writeFailed)
  })

  it('retains only the current and previous known-good generations', async () => {
    const storage = open()
    await storage.setItem(STORAGE_KEY, persistedPayload('one'))
    await storage.setItem(STORAGE_KEY, persistedPayload('two'))
    await storage.setItem(STORAGE_KEY, persistedPayload('three'))

    expect([...files.files.keys()].filter((path) => path.includes('--generation--'))).toHaveLength(2)
    expect(await open().getItem(STORAGE_KEY)).toBe(persistedPayload('three'))
  })

  it('migrates localStorage once and deletes it only after an equivalent durable reread', async () => {
    const legacyPayload = JSON.stringify(JSON.parse(persistedPayload('legacy')), null, 2)
    legacy.setItem(STORAGE_KEY, legacyPayload)
    const storage = open()

    expect(JSON.parse((await storage.getItem(STORAGE_KEY))!)).toEqual(JSON.parse(legacyPayload))
    expect(legacy.getItem(STORAGE_KEY)).toBeNull()
    expect(legacy.removeItem).toHaveBeenCalledTimes(1)
    const writesAfterMigration = files.writes

    expect(JSON.parse((await open().getItem(STORAGE_KEY))!)).toEqual(JSON.parse(legacyPayload))
    expect(files.writes).toBe(writesAfterMigration)
    expect(legacy.removeItem).toHaveBeenCalledTimes(1)
  })

  it('keeps post-migration writes blocked when one pointer read cannot distinguish stored data from empty', async () => {
    const migratedPayload = persistedPayload('erics-whole-tool-library')
    legacy.setItem(STORAGE_KEY, migratedPayload)
    await open().getItem(STORAGE_KEY)

    expect(legacy.getItem(STORAGE_KEY)).toBeNull()
    const generationPath = [...files.files.keys()].find((path) => path.includes('--generation--'))
    if (!generationPath) throw new Error('migration did not write a durable generation')
    const generationBytes = files.files.get(generationPath)
    expect(generationBytes).toBeDefined()
    expect([...files.files.keys()].some((path) => path.endsWith('--pointer-backup.json'))).toBe(false)

    const pointerPath = files.pathEnding('--pointer.json')
    let pointerReadFailures = 0
    files.failRead = (path) => path === pointerPath && pointerReadFailures++ === 0
      ? new DOMException('pointer temporarily unreadable', 'NoModificationAllowedError')
      : null
    warnings = []

    type ReloadState = {
      toolLibraries: Array<{ id: string; name: string }>
      mutationCount: number
    }
    const stateStorage = createUserSpaceStateStorage({
      durableStorage: files,
      legacyStorage: legacy,
      onWarning: (warning) => warnings.push(warning),
    })
    const store = createStore<ReloadState>()(persist<ReloadState>(
      () => ({ toolLibraries: [], mutationCount: 0 }),
      {
        name: STORAGE_KEY,
        storage: createJSONStorage(() => stateStorage),
        skipHydration: true,
        onRehydrateStorage: () => () => stateStorage.finishInitialHydration(),
      },
    ))

    await store.persist.rehydrate()
    store.setState({ mutationCount: 1 })
    store.setState({ mutationCount: 2 })

    expect(pointerReadFailures).toBe(1)
    expect(warnings.map((warning) => warning.code)).toContain(
      USER_SPACE_STORAGE_WARNING.recoveryFallback,
    )
    expect(files.files.get(generationPath)).toBe(generationBytes)
    expect([...files.files.keys()].filter((path) => path.includes('--generation--'))).toEqual([
      generationPath,
    ])
  })

  it('mirrors the committed splash preference before deleting the migrated payload', async () => {
    const payload = JSON.parse(persistedPayload('no-splash')) as {
      state: { appSettings: Record<string, unknown> }
    }
    payload.state.appSettings.showSplash = false
    legacy.setItem(STORAGE_KEY, JSON.stringify(payload))

    await open().getItem(STORAGE_KEY)

    expect(legacy.getItem(STORAGE_KEY)).toBeNull()
    expect(JSON.parse(legacy.getItem(USER_SPACE_BOOT_PREFERENCES_KEY)!)).toEqual({
      showSplash: false,
    })
  })

  it('clears durable state and defers stale hydration when OPFS reset removal fails', async () => {
    await open().setItem(STORAGE_KEY, persistedPayload('reset-me'))
    expect(await open().getItem(STORAGE_KEY)).not.toBeNull()

    files.failRemove = () => new Error('simulated broken OPFS remove')
    await expect(resetUserSpaceStateStorage(STORAGE_KEY, {
      durableStorage: files,
      legacyStorage: legacy,
      onWarning: (warning) => warnings.push(warning),
    })).resolves.toBe(false)

    expect(legacy.getItem(STORAGE_KEY)).toBeNull()
    expect(legacy.getItem(USER_SPACE_BOOT_PREFERENCES_KEY)).toBeNull()
    expect(await open().getItem(STORAGE_KEY)).toBeNull()
    expect(warnings.map((warning) => warning.code)).toContain(
      USER_SPACE_STORAGE_WARNING.resetDeferred,
    )

    files.failRemove = null
    expect(await open().getItem(STORAGE_KEY)).toBeNull()
    expect([...files.files.keys()]).toEqual([])
    expect([...legacy.values.keys()].some((key) => key.includes('reset-pending'))).toBe(false)
  })

  it('retains localStorage and boots from it when durable migration fails', async () => {
    const legacyPayload = persistedPayload('migration-quota')
    legacy.setItem(STORAGE_KEY, legacyPayload)
    files.failWrite = () => new DOMException('quota exhausted', 'QuotaExceededError')

    expect(await open().getItem(STORAGE_KEY)).toBe(legacyPayload)
    expect(legacy.getItem(STORAGE_KEY)).toBe(legacyPayload)
    expect(legacy.removeItem).not.toHaveBeenCalled()
    expect(warnings.map((warning) => warning.code)).toContain(
      USER_SPACE_STORAGE_WARNING.migrationFailed,
    )
  })

  it('uses the existing localStorage path with an explicit warning when OPFS is unsupported', async () => {
    const payload = persistedPayload('fallback')
    legacy.setItem(STORAGE_KEY, payload)
    const fallbackWarnings: UserSpaceStorageWarning[] = []
    const storage = createUserSpaceStateStorage({
      durableStorage: null,
      legacyStorage: legacy,
      onWarning: (warning) => fallbackWarnings.push(warning),
    })

    expect(await storage.getItem(STORAGE_KEY)).toBe(payload)
    await storage.setItem(STORAGE_KEY, persistedPayload('fallback-updated'))
    expect(legacy.getItem(STORAGE_KEY)).toBe(persistedPayload('fallback-updated'))
    expect(fallbackWarnings.map((warning) => warning.code)).toEqual([
      USER_SPACE_STORAGE_WARNING.limitedDurability,
    ])
  })
})
