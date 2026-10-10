// @vitest-environment jsdom
/**
 * WO-2627: Settings > User data > Restore bundle on a clean profile, then the
 * page reload, must leave the RUNNING app with exactly what the backup holds.
 *
 * Everything here goes through production code: the real persisted CAM store
 * (its module-scope storage, its hydration barrier, its unload journal), the
 * real backup service, the real Restore bundle button in UserDataStoragePanel
 * with its default (OPFS + localStorage) access, and a reload simulated the
 * way a browser does one - `pagehide` on the old page, then a fresh module
 * graph booting against the same origin storage. Only the OPFS directory is a
 * stand-in (an in-memory FileSystemDirectoryHandle), because jsdom has none.
 *
 * Two findings, both pinned here:
 * - The machine seat's kit read the reloaded app as holding only the starter
 *   machine while storage held the backup. That was an early read: the kit's
 *   dump imports the store and reads it before the reloaded page's async OPFS
 *   hydration has finished (the last case). Hydrated, the page holds the shop.
 * - A real loss: the old page is still alive between the restore and its
 *   teardown, and Zustand persists each store's WHOLE pre-restore snapshot on
 *   every `set`. An ordinary change there - a console line - replaced the
 *   restored data with the clean profile's defaults (reproduced in headless
 *   Chromium too: src/tests/evidence/WO-2627/result-main-busy.json). The race
 *   cases below fail on main.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

class NotFound extends DOMException {
  constructor() { super('not found', 'NotFoundError') }
}

/** In-memory OPFS root: one directory of files, enough for userSpaceStorage. */
class MemoryOpfsDirectory {
  readonly kind = 'directory'
  readonly name = ''
  readonly files = new Map<string, Uint8Array>()
  /** Fail the next committed write whose path matches (one shot). */
  failNextWrite: ((path: string) => boolean) | null = null

  async getFileHandle(path: string, options: { create?: boolean } = {}) {
    if (!this.files.has(path)) {
      if (!options.create) throw new NotFound()
      this.files.set(path, new Uint8Array())
    }
    const files = this.files
    const directory = this
    return {
      kind: 'file' as const,
      name: path,
      async getFile() {
        const bytes = files.get(path)
        if (bytes === undefined) throw new NotFound()
        const copy = new Uint8Array(bytes)
        return {
          text: async () => new TextDecoder().decode(copy),
          arrayBuffer: async () => copy.buffer,
        }
      },
      async createWritable() {
        let next: Uint8Array = new Uint8Array()
        return {
          async write(value: string | ArrayBuffer | Uint8Array) {
            next = typeof value === 'string'
              ? new TextEncoder().encode(value)
              : new Uint8Array(value instanceof ArrayBuffer ? value : value.buffer)
          },
          async close() {
            if (directory.failNextWrite?.(path)) {
              directory.failNextWrite = null
              throw new DOMException('simulated write failure', 'NoModificationAllowedError')
            }
            files.set(path, next)
          },
          async abort() {},
        }
      },
    }
  }

  async removeEntry(path: string): Promise<void> {
    if (!this.files.delete(path)) throw new NotFound()
  }

  async *entries(): AsyncIterableIterator<[string, unknown]> {
    for (const path of [...this.files.keys()]) {
      yield [path, await this.getFileHandle(path)]
    }
  }
}

/** One browser profile: its own OPFS root (null = none) and localStorage. */
interface Profile {
  opfs: MemoryOpfsDirectory | null
  local: Map<string, string>
}

function newProfile(withOpfs = true): Profile {
  return { opfs: withOpfs ? new MemoryOpfsDirectory() : null, local: new Map() }
}

let pagehideListeners: Array<() => void> = []

function installProfile(profile: Profile): void {
  const local = profile.local
  const storage = {
    get length() { return local.size },
    key: (index: number) => [...local.keys()][index] ?? null,
    getItem: (name: string) => local.get(name) ?? null,
    setItem: (name: string, value: string) => { local.set(name, String(value)) },
    removeItem: (name: string) => { local.delete(name) },
    clear: () => { local.clear() },
  }
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true })
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true, writable: true })
  const opfs = profile.opfs
  Object.defineProperty(globalThis.navigator, 'storage', {
    configurable: true,
    value: opfs === null ? {} : { getDirectory: async () => opfs },
  })
}

type StoreModule = typeof import('../../store')

/** The page's localStorage-persisted stores, from the same module graph. */
let pageLocalStores: {
  uiPrefs: typeof import('../../store/uiPrefs')
  actions: typeof import('../../store/machineActionsStore')
  probe: typeof import('../../store/probeRoutineStore')
} | null = null

/** Boot the app's store graph fresh against the installed profile. */
async function bootApp(): Promise<StoreModule> {
  cleanup()
  vi.resetModules()
  const store = await import('../../store')
  pageLocalStores = {
    uiPrefs: await import('../../store/uiPrefs'),
    actions: await import('../../store/machineActionsStore'),
    probe: await import('../../store/probeRoutineStore'),
  }
  pagehideListeners = []
  store.installPersistedStateUnloadJournal({
    addEventListener: (_type: string, listener: unknown) => {
      pagehideListeners.push(listener as () => void)
    },
    removeEventListener: () => {},
  })
  if (!store.useCamStore.persist.hasHydrated()) {
    await new Promise<void>((resolve) => {
      const off = store.useCamStore.persist.onFinishHydration(() => { off(); resolve() })
    })
  }
  return store
}

/** What a browser does on reload: pagehide on the old page, then a new boot. */
async function reloadApp(): Promise<StoreModule> {
  for (const listener of pagehideListeners) listener()
  return bootApp()
}

/** Ordinary store changes on the page - a console line, a panel nudge.
 *  Each persisted store writes its whole snapshot on any `set`. */
function liveActivity(app: StoreModule): void {
  app.useCamStore.setState({ consoleEvents: [] } as never)
  pageLocalStores!.uiPrefs.useUiPrefs.setState({})
  pageLocalStores!.actions.useMachineActions.setState({})
  pageLocalStores!.probe.useProbeRoutineStore.setState({})
}

const LOCAL_KEYS = {
  posts: 'liencam.userPosts',
  macros: 'liencam-machine-actions',
  probe: 'liencam-probe-routine-library',
} as const

/** Profile A: a shop with its own machines, tools, settings and offsets. */
async function seedShop(app: StoreModule): Promise<void> {
  const { useCamStore, projectStoreDurability } = app
  const base = useCamStore.getState()
  const sample = base.machineLibrary[0]
  const machines = ['m-router', 'm-mill', 'm-laser', 'm-lathe'].map((id, index) => ({
    ...sample,
    id,
    name: `Shop machine ${index + 1}`,
  }))
  const libraries = Array.from({ length: 3 }, (_, index) => ({
    ...base.toolLibraries[0],
    id: `lib-${index + 1}`,
    name: `Shop library ${index + 1}`,
  }))
  const tools = Array.from({ length: 5 }, (_, index) => ({
    id: `tool-${index + 1}`,
    name: `Shop tool ${index + 1}`,
    type: 'flat',
    diameter: 3 + index,
    libraryId: `lib-${(index % 3) + 1}`,
  }))
  useCamStore.setState({
    machineLibrary: machines,
    control: { ...base.control, activeMachineId: 'm-mill' },
    toolLibraries: libraries,
    toolLibrary: tools as unknown as typeof base.toolLibrary,
    holders: [{ id: 'holder-er20', name: 'ER20' }] as unknown as typeof base.holders,
    appSettings: { ...base.appSettings, invertZoom: true, defaultMachineId: 'm-mill' },
    machineWorkOffsets: {
      'm-mill': { G54: { x: 12.5, y: -40, z: 7.25 } },
    } as unknown as typeof base.machineWorkOffsets,
    project: { ...base.project, machine: machines[1] },
  })
  expect(await projectStoreDurability.writesCommitted()).toBe(true)

  const { useUiPrefs } = await import('../../store/uiPrefs')
  useUiPrefs.setState({ panelLeftWidthCustomized: true })
  localStorage.setItem(LOCAL_KEYS.posts, JSON.stringify([{ id: 'post-shop', name: 'Shop post' }]))
  localStorage.setItem(LOCAL_KEYS.macros, JSON.stringify({
    state: { byMachine: { 'm-mill': { custom: [], parks: [{ id: 'park-1', x: 1, y: 2 }] } } },
    version: 0,
  }))
  localStorage.setItem(LOCAL_KEYS.probe, JSON.stringify({
    state: { userRoutines: [{ id: 'probe-shop', name: 'Shop probe' }] }, version: 0,
  }))
}

/** Every category the bundle carries, as the running app holds it. */
async function liveShop(app: StoreModule) {
  const s = app.useCamStore.getState()
  const { useUiPrefs } = await import('../../store/uiPrefs')
  return {
    machineLibrary: s.machineLibrary,
    activeMachineId: s.control.activeMachineId,
    projectMachineId: s.project.machine.id,
    toolLibraries: s.toolLibraries,
    toolLibrary: s.toolLibrary,
    holders: s.holders,
    appSettings: s.appSettings,
    machineWorkOffsets: s.machineWorkOffsets,
    uiPrefsPanelLeftWidthCustomized: useUiPrefs.getState().panelLeftWidthCustomized,
    localRecords: Object.fromEntries(
      Object.entries(LOCAL_KEYS).map(([name, key]) => [name, localStorage.getItem(key)]),
    ),
  }
}

type Shop = Awaited<ReturnType<typeof liveShop>>

function expectSameShop(actual: Shop, expected: Shop): void {
  expect(actual.machineLibrary).toEqual(expected.machineLibrary)
  expect(actual.activeMachineId).toBe(expected.activeMachineId)
  expect(actual.projectMachineId).toBe(expected.projectMachineId)
  expect(actual.toolLibraries).toEqual(expected.toolLibraries)
  expect(actual.toolLibrary).toEqual(expected.toolLibrary)
  expect(actual.holders).toEqual(expected.holders)
  expect(actual.appSettings).toEqual(expected.appSettings)
  expect(actual.machineWorkOffsets).toEqual(expected.machineWorkOffsets)
  expect(actual.uiPrefsPanelLeftWidthCustomized).toBe(expected.uiPrefsPanelLeftWidthCustomized)
  expect(actual.localRecords).toEqual(expected.localRecords)
}

/** Settings > User data > Inspect backup -> preview -> Confirm restore. */
async function restoreThroughPanel(
  backupText: string,
  beforeConfirm: () => void = () => {},
): Promise<void> {
  const { UserDataStoragePanel } = await import('../../components/modals/UserDataStoragePanel')
  const reloadPage = vi.fn()
  render(createElement(UserDataStoragePanel, { reloadPage }))
  const file = new File([backupText], 'LienCAM-shop-data-backup.json', { type: 'application/json' })
  fireEvent.change(screen.getByTestId('user-data-import-input'), { target: { files: [file] } })
  const confirm = await screen.findByRole('button', { name: 'Confirm restore' })
  beforeConfirm()
  fireEvent.click(confirm)
  await waitFor(() => expect(reloadPage).toHaveBeenCalledTimes(1), { timeout: 10_000 })
}

let backupText = ''
let expected: Shop

beforeAll(async () => {
  // Profile A: the shop, saved, then reloaded once like any session.
  installProfile(newProfile())
  let app = await bootApp()
  await seedShop(app)
  app = await reloadApp()
  expected = await liveShop(app)
  expect(expected.machineLibrary.map((m) => m.id)).toEqual(['m-router', 'm-mill', 'm-laser', 'm-lathe'])
  expect(expected.activeMachineId).toBe('m-mill')
  expect(expected.toolLibrary).toHaveLength(5)
  expect(expected.appSettings.invertZoom).toBe(true)
  expect(expected.uiPrefsPanelLeftWidthCustomized).toBe(true)
  const { createShopDataBackup } = await import('../../store/userSpaceStorage')
  backupText = (await createShopDataBackup()).text
}, 120_000)

afterEach(() => {
  cleanup()
})

/** A clean install booted on the starter. */
async function cleanInstall(withOpfs = true): Promise<{ app: StoreModule; profile: Profile }> {
  const profile = newProfile(withOpfs)
  installProfile(profile)
  const app = await bootApp()
  expect(app.useCamStore.getState().machineLibrary).toHaveLength(1)
  expect(app.useCamStore.getState().appSettings.invertZoom).toBe(false)
  return { app, profile }
}

function generationFiles(profile: Profile): string[] {
  return [...(profile.opfs?.files.keys() ?? [])].filter((path) => path.includes('--generation--'))
}

describe('WO-2627 Restore bundle loads everything after the reload', () => {
  it('restore before the first save: a profile that never wrote a generation loads the whole backup', async () => {
    const { profile } = await cleanInstall()
    expect(generationFiles(profile)).toEqual([])
    await restoreThroughPanel(backupText)
    expectSameShop(await liveShop(await reloadApp()), expected)
  }, 60_000)

  it('restore after first open: a profile that already saved its own data loads the whole backup', async () => {
    const { app, profile } = await cleanInstall()
    app.useCamStore.setState((s) => ({
      appSettings: { ...s.appSettings, defaultMachineId: s.machineLibrary[0].id },
    }))
    expect(await app.projectStoreDurability.writesCommitted()).toBe(true)
    expect(generationFiles(profile)).toHaveLength(1)
    await restoreThroughPanel(backupText)
    expectSameShop(await liveShop(await reloadApp()), expected)
  }, 60_000)

  it('a browser without OPFS (localStorage only) restores the same way', async () => {
    await cleanInstall(false)
    await restoreThroughPanel(backupText)
    expectSameShop(await liveShop(await reloadApp()), expected)
  }, 60_000)

  it('a store change on the old page after the restore cannot erase what was restored', async () => {
    const { app } = await cleanInstall()
    await restoreThroughPanel(backupText)
    liveActivity(app)
    await app.projectStoreDurability.writesCommitted()
    expectSameShop(await liveShop(await reloadApp()), expected)
  }, 60_000)

  it('a write still in flight when the old page hides does not land over the restore', async () => {
    const { app } = await cleanInstall()
    await restoreThroughPanel(backupText)
    liveActivity(app)
    expectSameShop(await liveShop(await reloadApp()), expected)
  }, 60_000)

  it('a write in flight when Confirm is pressed settles before the restore, never after it', async () => {
    const { app } = await cleanInstall()
    await restoreThroughPanel(backupText, () => liveActivity(app))
    expectSameShop(await liveShop(await reloadApp()), expected)
  }, 60_000)

  it('a browser without OPFS is not erased by the old page either', async () => {
    const { app } = await cleanInstall(false)
    await restoreThroughPanel(backupText)
    liveActivity(app)
    expectSameShop(await liveShop(await reloadApp()), expected)
  }, 60_000)

  it('Recover previous generation is not erased by the old page either', async () => {
    installProfile(newProfile())
    let app = await bootApp()
    app.useCamStore.setState((s) => ({ appSettings: { ...s.appSettings, invertZoom: true } }))
    expect(await app.projectStoreDurability.writesCommitted()).toBe(true)
    app.useCamStore.setState((s) => ({ appSettings: { ...s.appSettings, invertZoom: false } }))
    expect(await app.projectStoreDurability.writesCommitted()).toBe(true)
    const { recoverPreviousUserSpaceGeneration } = await import('../../store/userSpaceStorage')
    await recoverPreviousUserSpaceGeneration()
    liveActivity(app)
    await app.projectStoreDurability.writesCommitted()
    app = await reloadApp()
    expect(app.useCamStore.getState().appSettings.invertZoom).toBe(true)
  }, 60_000)

  it('a restore that fails part-way leaves the page persisting normally', async () => {
    const { app, profile } = await cleanInstall()
    profile.opfs!.failNextWrite = (path) => path.includes('--generation--')
    const { restoreShopDataBackup } = await import('../../store/userSpaceStorage')
    await expect(restoreShopDataBackup(backupText)).rejects.toThrow()
    app.useCamStore.setState((s) => ({ appSettings: { ...s.appSettings, invertZoom: true } }))
    expect(await app.projectStoreDurability.writesCommitted()).toBe(true)
    const reloaded = await reloadApp()
    expect(reloaded.useCamStore.getState().appSettings.invertZoom).toBe(true)
    expect(reloaded.useCamStore.getState().machineLibrary).toHaveLength(1)
  }, 60_000)

  it('the reloaded page holds the starter only until its hydration finishes, then the restored shop', async () => {
    await cleanInstall()
    await restoreThroughPanel(backupText)
    for (const listener of pagehideListeners) listener()
    cleanup()
    vi.resetModules()
    const app = await import('../../store')
    // The kit's reading: storage already holds the shop, the store not yet.
    expect(app.useCamStore.persist.hasHydrated()).toBe(false)
    expect(app.useCamStore.getState().machineLibrary.map((m) => m.id)).toEqual(['default-machine'])
    await new Promise<void>((resolve) => {
      const off = app.useCamStore.persist.onFinishHydration(() => { off(); resolve() })
    })
    expectSameShop(await liveShop(app), expected)
  }, 60_000)
})
