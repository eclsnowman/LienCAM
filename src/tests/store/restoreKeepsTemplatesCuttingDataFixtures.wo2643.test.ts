// @vitest-environment jsdom
/**
 * WO-2643: Settings > User data lists recipe templates, cutting-data presets
 * and fixtures. Restore bundle accepted them and showed the item counts, then
 * the app's next save threw them away: the persisted CAM store neither merged
 * nor wrote those catalogued keys (WO-2640 evidence: fresh/seed and
 * upgrade/result.json, seedKeptByN).
 *
 * The values are WO-2640's every-category seed, verbatim: 13 recipe-template,
 * 9 cutting-data and 12 fixture values. Everything runs through production
 * code - the real persisted store, the real backup service, the real Restore
 * bundle button in UserDataStoragePanel, and a reload the way a browser does
 * one (pagehide on the old page, a fresh module graph on the same origin
 * storage). Only the OPFS directory is an in-memory stand-in (jsdom has none).
 * The keep cases fail on main.
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

  async getFileHandle(path: string, options: { create?: boolean } = {}) {
    if (!this.files.has(path)) {
      if (!options.create) throw new NotFound()
      this.files.set(path, new Uint8Array())
    }
    const files = this.files
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
          async close() { files.set(path, next) },
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

/** Boot the app's store graph fresh against the installed profile. */
async function bootApp(): Promise<StoreModule> {
  cleanup()
  vi.resetModules()
  const store = await import('../../store')
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

/** WO-2640's every-category seed for the three categories, verbatim
 *  (src/tests/evidence/WO-2640/upgrade/configure/seed-bundle.json). */
const SEED = {
  operationTemplates: [{ id: 'optpl-wo2640-pocket', name: 'WO-2640 6 mm adaptive pocket', operationType: 'adaptive', toolDiameter: 6, stepdown: 1.5, stepover: 2.4 }],
  setupTemplates: [{ id: 'setpl-wo2640-vise', name: 'WO-2640 vise setup', wcs: 'G55', stockOffset: 1 }],
  recipeTemplates: [{ id: 'recipe-wo2640-plate', name: 'WO-2640 plate recipe', operations: ['optpl-wo2640-pocket'] }],
  materialPresets: [{ id: 'mat-wo2640-6061', name: 'WO-2640 6061-T6', surfaceSpeed: 250, chipLoad: 0.04 }],
  cuttingDataPresets: [{ id: 'cut-wo2640-6mm-alu', name: 'WO-2640 6 mm in aluminium', rpm: 18000, feedRate: 1500, plungeRate: 300 }],
  fixtures: [{ id: 'fix-wo2640-plate', name: 'WO-2640 fixture plate', x: 300, y: 200, z: 12.7 }],
  spoilboards: [{ id: 'spoil-wo2640', name: 'WO-2640 MDF spoilboard', thickness: 18 }],
  vises: [{ id: 'vise-wo2640-kurt', name: 'WO-2640 4 in vise', jawWidth: 100, maxOpening: 150 }],
} as const

const CATEGORY_KEYS = {
  'recipe-templates': ['operationTemplates', 'setupTemplates', 'recipeTemplates'],
  'cutting-data': ['materialPresets', 'cuttingDataPresets'],
  fixtures: ['fixtures', 'spoilboards', 'vises'],
} as const

/** Leaf values in a category: every field of every record (WO-2640's count). */
function leafValues(state: Record<string, unknown>, keys: readonly string[]): number {
  return keys.reduce((total, key) => {
    const records = state[key]
    if (!Array.isArray(records)) return total
    return total + records.reduce<number>((n, r) => n + Object.keys(r as object).length, 0)
  }, 0)
}

function stateOf(backupText: string): Record<string, unknown> {
  const bundle = JSON.parse(backupText) as { content: { primaryPayload: string } }
  return (JSON.parse(bundle.content.primaryPayload) as { state: Record<string, unknown> }).state
}

/** Settings > User data > Inspect backup -> preview -> Confirm restore. */
async function restoreThroughPanel(text: string): Promise<void> {
  const { UserDataStoragePanel } = await import('../../components/modals/UserDataStoragePanel')
  const reloadPage = vi.fn()
  render(createElement(UserDataStoragePanel, { reloadPage }))
  const file = new File([text], 'LienCAM-shop-data-backup.json', { type: 'application/json' })
  fireEvent.change(screen.getByTestId('user-data-import-input'), { target: { files: [file] } })
  const confirm = await screen.findByRole('button', { name: 'Confirm restore' })
  fireEvent.click(confirm)
  await waitFor(() => expect(reloadPage).toHaveBeenCalledTimes(1), { timeout: 10_000 })
}

/** Settings > User data > Download backup, as the reopened app writes it. */
async function downloadBackup(): Promise<string> {
  const { createShopDataBackup } = await import('../../store/userSpaceStorage')
  return (await createShopDataBackup()).text
}

/** An ordinary store write: flip one preference and wait for it to land. */
async function storeWrite(app: StoreModule): Promise<void> {
  app.useCamStore.setState((s) => ({ appSettings: { ...s.appSettings, invertZoom: !s.appSettings.invertZoom } }))
  expect(await app.projectStoreDurability.writesCommitted()).toBe(true)
}

let seedText = ''

beforeAll(async () => {
  // The seed bundle: a real backup of a saved profile whose stored record also
  // carries WO-2640's three-category values (the shape WO-2640 restored).
  installProfile(newProfile())
  const app = await bootApp()
  app.useCamStore.setState((s) => ({ appSettings: { ...s.appSettings, defaultMachineId: s.machineLibrary[0].id } }))
  expect(await app.projectStoreDurability.writesCommitted()).toBe(true)
  const { createShopDataBackup, DEFAULT_USER_SPACE_STORAGE_KEY } = await import('../../store/userSpaceStorage')
  const saved = JSON.parse(JSON.parse((await createShopDataBackup()).text).content.primaryPayload) as {
    state: Record<string, unknown>
  }
  const seededPayload = JSON.stringify({ ...saved, state: { ...saved.state, ...SEED } })
  seedText = (await createShopDataBackup({
    durableStorage: null,
    legacyStorage: {
      getItem: (name) => name === DEFAULT_USER_SPACE_STORAGE_KEY ? seededPayload : localStorage.getItem(name),
      setItem: () => {},
      removeItem: () => {},
    },
  })).text
  const seeded = stateOf(seedText)
  expect(leafValues(seeded, CATEGORY_KEYS['recipe-templates'])).toBe(13)
  expect(leafValues(seeded, CATEGORY_KEYS['cutting-data'])).toBe(9)
  expect(leafValues(seeded, CATEGORY_KEYS.fixtures)).toBe(12)
}, 120_000)

afterEach(() => {
  cleanup()
})

function expectSeedKept(state: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(SEED)) expect(state[key], key).toEqual(value)
  expect(leafValues(state, CATEGORY_KEYS['recipe-templates'])).toBe(13)
  expect(leafValues(state, CATEGORY_KEYS['cutting-data'])).toBe(9)
  expect(leafValues(state, CATEGORY_KEYS.fixtures)).toBe(12)
}

describe('WO-2643 restore keeps recipe templates, cutting data and fixtures', () => {
  it('restore -> store write -> reopen -> Download backup holds every value', async () => {
    installProfile(newProfile())
    await bootApp()
    await restoreThroughPanel(seedText)
    await storeWrite(await reloadApp())
    await reloadApp()
    expectSeedKept(stateOf(await downloadBackup()))
  }, 60_000)

  it('a browser without OPFS (localStorage only) keeps them the same way', async () => {
    installProfile(newProfile(false))
    await bootApp()
    await restoreThroughPanel(seedText)
    await storeWrite(await reloadApp())
    await reloadApp()
    expectSeedKept(stateOf(await downloadBackup()))
  }, 60_000)

  it('New Project keeps them: they belong to the installation, not the document', async () => {
    installProfile(newProfile())
    await bootApp()
    await restoreThroughPanel(seedText)
    const app = await reloadApp()
    app.useCamStore.getState().newProject()
    expect(await app.projectStoreDurability.writesCommitted()).toBe(true)
    await reloadApp()
    expectSeedKept(stateOf(await downloadBackup()))
  }, 60_000)

  it('the other categories come back unchanged beside them', async () => {
    installProfile(newProfile())
    await bootApp()
    await restoreThroughPanel(seedText)
    await storeWrite(await reloadApp())
    await storeWrite(await reloadApp())
    await reloadApp()
    const after = stateOf(await downloadBackup())
    const before = stateOf(seedText)
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort())
    for (const key of ['machineLibrary', 'control', 'machineWorkOffsets', 'toolLibrary', 'toolLibraries', 'holders', 'importedFonts', 'appSettings']) {
      expect(after[key], key).toEqual(before[key])
    }
  }, 60_000)

  it('a profile that never had them gains no empty records', async () => {
    installProfile(newProfile())
    const app = await bootApp()
    await storeWrite(app)
    await reloadApp()
    const state = stateOf(await downloadBackup())
    for (const key of Object.keys(SEED)) expect(key in state, key).toBe(false)
  }, 60_000)
})
