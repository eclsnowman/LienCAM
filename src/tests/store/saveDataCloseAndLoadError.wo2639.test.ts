// @vitest-environment jsdom
/**
 * WO-2639: two save-data defects found while fixing Restore (WO-2627).
 *
 * 1. A change still being saved when the app closes was lost: the WO-1505
 *    unload journal was written under a name the registered localStorage
 *    adapter refuses, so every pagehide with a pending write logged
 *    `[USER_SPACE_WRITE_FAILED] ... key is not registered` and kept nothing.
 * 2. A load that throws left the store on its defaults with writes open, so
 *    the next ordinary `set` saved those defaults over the stored data.
 *
 * Everything runs through production code: the real persisted stores, their
 * module-scope storage, the real unload-journal install, and a reload the way
 * a browser does one (pagehide on the old page, a fresh module graph on the
 * same origin storage). Only the OPFS directory is an in-memory stand-in,
 * because jsdom has none. Both cases fail on main.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

class NotFound extends DOMException {
  constructor() { super('not found', 'NotFoundError') }
}

/** In-memory OPFS root. `holdWrites` parks every commit forever - a page that
 *  closes before its async write lands. */
class MemoryOpfsDirectory {
  readonly kind = 'directory'
  readonly name = ''
  readonly files = new Map<string, Uint8Array>()
  holdWrites = false

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
            if (directory.holdWrites) await new Promise<never>(() => {})
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

interface Profile {
  opfs: MemoryOpfsDirectory | null
  local: Map<string, string>
}

function newProfile(withOpfs = true): Profile {
  return { opfs: withOpfs ? new MemoryOpfsDirectory() : null, local: new Map() }
}

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

let pagehideListeners: Array<() => void> = []

/** Boot the store graph fresh; resolves once hydration has settled either way. */
async function bootApp(): Promise<StoreModule> {
  vi.resetModules()
  const store = await import('../../store')
  pagehideListeners = []
  store.installPersistedStateUnloadJournal({
    addEventListener: (_type: string, listener: unknown) => {
      pagehideListeners.push(listener as () => void)
    },
    removeEventListener: () => {},
  })
  // A failed hydration never reports finished, so wait for either outcome
  // without asserting one: the cases below judge what happened.
  const settled = () => store.useCamStore.persist.hasHydrated()
    || store.useCamStore.getState().consoleEvents.some((event) => event.severity === 'error')
  for (let waited = 0; !settled() && waited < 3_000; waited += 25) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return store
}

/** Every byte of the project's stored record (its localStorage copy and its
 *  durable OPFS files), for byte-identical comparison. */
function snapshot(profile: Profile): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of profile.local) if (key.includes(PROJECT_KEY)) out[`local:${key}`] = value
  for (const [path, bytes] of profile.opfs?.files ?? []) out[`opfs:${path}`] = new TextDecoder().decode(bytes)
  return out
}

/** Ordinary store changes - a console line, a panel nudge. Each persisted
 *  store writes its whole snapshot on any `set`. */
async function liveActivity(app: StoreModule): Promise<void> {
  app.useCamStore.setState({ consoleEvents: [...app.useCamStore.getState().consoleEvents] } as never)
  app.useCamStore.setState((s) => ({ appSettings: { ...s.appSettings, invertZoom: !s.appSettings.invertZoom } }))
  app.useCamStore.getState().addConsoleEvent({ severity: 'info', source: 'app', message: 'busy' })
  const { useMachineActions } = await import('../../store/machineActionsStore')
  useMachineActions.setState({})
  await app.projectStoreDurability.writesCommitted()
  await new Promise((resolve) => setTimeout(resolve, 50))
}

const PROJECT_KEY = 'cnc-cam-project'
const MACHINE_ACTIONS_KEY = 'liencam-machine-actions'
/** Parses as JSON, but its project cannot be migrated: the load throws. */
const UNLOADABLE_PROJECT = JSON.stringify({ state: { project: 'not a project' }, version: 1 })

const warnings: string[] = []

function captureConsole(): void {
  warnings.length = 0
  const keep = (...args: unknown[]) => {
    warnings.push(args.map((arg) => arg instanceof Error ? arg.message : String(arg)).join(' '))
  }
  vi.spyOn(console, 'warn').mockImplementation(keep)
  vi.spyOn(console, 'error').mockImplementation(keep)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('WO-2639 a change still saving at close is kept', () => {
  it('a write still in flight at pagehide is present after relaunch, with no journal write failure', async () => {
    const profile = newProfile()
    installProfile(profile)
    captureConsole()
    let app = await bootApp()
    expect(app.useCamStore.getState().appSettings.invertZoom).toBe(false)

    // The page closes before its async write lands.
    profile.opfs!.holdWrites = true
    app.useCamStore.setState((s) => ({ appSettings: { ...s.appSettings, invertZoom: true } }))
    // The write reaches durable storage and parks there, uncommitted.
    await new Promise((resolve) => setTimeout(resolve, 50))
    for (const listener of pagehideListeners) listener()

    expect(warnings.filter((line) => line.includes('USER_SPACE_WRITE_FAILED'))).toEqual([])
    expect([...profile.local.keys()].some((key) => key.includes('unload-journal'))).toBe(true)

    profile.opfs!.holdWrites = false
    app = await bootApp()
    expect(app.useCamStore.getState().appSettings.invertZoom).toBe(true)
    // Replayed into durable storage, the journal is gone.
    expect(await app.projectStoreDurability.writesCommitted()).toBe(true)
    expect([...profile.local.keys()].some((key) => key.includes('unload-journal'))).toBe(false)
    app = await bootApp()
    expect(app.useCamStore.getState().appSettings.invertZoom).toBe(true)
  }, 60_000)
})

describe('WO-2639 a failed load never saves defaults over your data', () => {
  for (const withOpfs of [true, false]) {
    it(`project record that cannot load stays byte-identical (${withOpfs ? 'OPFS' : 'localStorage only'})`, async () => {
      const profile = newProfile(withOpfs)
      profile.local.set(PROJECT_KEY, UNLOADABLE_PROJECT)
      installProfile(profile)
      captureConsole()
      const app = await bootApp()
      expect(app.useCamStore.persist.hasHydrated()).toBe(false)
      const before = snapshot(profile)

      await liveActivity(app)

      expect(snapshot(profile)).toEqual(before)
      expect(await app.projectStoreDurability.writesCommitted()).toBe(false)
      const told = app.useCamStore.getState().consoleEvents
        .filter((event) => event.severity === 'error')
        .map((event) => event.message)
      expect(told).toHaveLength(1)
      expect(told[0]).toMatch(/^Your saved project, machines, tools and settings could not be loaded \(.+\)\. .*will not save over your stored copy/)
      expect(warnings.some((line) => line.includes('[USER_SPACE_LOAD_FAILED]'))).toBe(true)
    }, 60_000)
  }

  it('a localStorage-record store that cannot load keeps its record byte-identical too', async () => {
    const profile = newProfile()
    profile.local.set(MACHINE_ACTIONS_KEY, '{"state": {"byMachine": ')
    installProfile(profile)
    captureConsole()
    const app = await bootApp()
    expect(app.useCamStore.persist.hasHydrated()).toBe(true)

    await liveActivity(app)

    expect(profile.local.get(MACHINE_ACTIONS_KEY)).toBe('{"state": {"byMachine": ')
    expect(app.useCamStore.getState().consoleEvents.some((event) =>
      event.severity === 'error' && event.message.startsWith('Your saved machine macros and park positions could not be loaded'),
    )).toBe(true)
  }, 60_000)

  it('a load that succeeds still saves normally', async () => {
    const profile = newProfile()
    installProfile(profile)
    let app = await bootApp()
    app.useCamStore.setState((s) => ({ appSettings: { ...s.appSettings, invertZoom: true } }))
    expect(await app.projectStoreDurability.writesCommitted()).toBe(true)
    app = await bootApp()
    expect(app.useCamStore.getState().appSettings.invertZoom).toBe(true)
    expect(app.useCamStore.getState().consoleEvents.filter((event) => event.severity === 'error')).toEqual([])
  }, 60_000)
})
