// @vitest-environment jsdom
/**
 * TRIAGE 10-09 (restoreBundleLoadsEverything.wo2627 flake), reproduction only.
 *
 * Spark /tmp/alone-1120/28.out: the restored "liencam-machine-actions" record
 * came back with an extra `default-machine: {overrides:{}, custom:[], parks:[]}`
 * entry. Cause: src/store/machineActionsStore.ts:496 runs
 * syncActionOverridesFromDefinitions() at import, before useCamStore's async
 * OPFS hydration, so the starter machine of the not-yet-hydrated page is
 * written into the persisted macros record. Whether it happens depends on
 * whether the module evaluates before or after the OPFS read resolves.
 *
 * Here OPFS answers one timer later (as a real browser's async OPFS does);
 * the shop saved has no `default-machine`, and the reload adds one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

class NotFound extends DOMException {
  constructor() { super('not found', 'NotFoundError') }
}

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
        return { text: async () => new TextDecoder().decode(copy), arrayBuffer: async () => copy.buffer }
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
    for (const path of [...this.files.keys()]) yield [path, await this.getFileHandle(path)]
  }
}

function installProfile(opfs: MemoryOpfsDirectory, local: Map<string, string>, opfsDelayMs: number): void {
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
  Object.defineProperty(globalThis.navigator, 'storage', {
    configurable: true,
    value: {
      getDirectory: async () => {
        if (opfsDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, opfsDelayMs))
        return opfs
      },
    },
  })
}

let pagehide: Array<() => void> = []

async function bootPage() {
  vi.resetModules()
  const store = await import('../../store')
  await import('../../store/machineActionsStore')
  pagehide = []
  store.installPersistedStateUnloadJournal({
    addEventListener: (_type: string, listener: unknown) => { pagehide.push(listener as () => void) },
    removeEventListener: () => {},
  })
  if (!store.useCamStore.persist.hasHydrated()) {
    await new Promise<void>((resolve) => {
      const off = store.useCamStore.persist.onFinishHydration(() => { off(); resolve() })
    })
  }
  return store
}

afterEach(() => { vi.resetModules() })

describe('TRIAGE 10-09: a reload must not write the pre-hydration starter machine into the macros record', () => {
  for (const opfsDelayMs of [0, 20]) {
    it(`OPFS answers after ${opfsDelayMs} ms`, async () => {
      const opfs = new MemoryOpfsDirectory()
      const local = new Map<string, string>()
      installProfile(opfs, local, opfsDelayMs)
      const first = await bootPage()
      const base = first.useCamStore.getState()
      const machines = ['m-router', 'm-mill'].map((id, index) => ({ ...base.machineLibrary[0], id, name: `Shop ${index}` }))
      first.useCamStore.setState({
        machineLibrary: machines,
        control: { ...base.control, activeMachineId: 'm-mill' },
        project: { ...base.project, machine: machines[1] },
      })
      expect(await first.projectStoreDurability.writesCommitted()).toBe(true)
      // The shop's own macros record, as a backup restore writes it.
      local.set('liencam-machine-actions', JSON.stringify({
        state: { byMachine: { 'm-router': { overrides: {}, custom: [], parks: [] }, 'm-mill': { overrides: {}, custom: [], parks: [] } }, macroArrangementByMachine: {} },
        version: 1,
      }))
      for (const listener of pagehide) listener()
      const reloaded = await bootPage()
      expect(reloaded.useCamStore.getState().machineLibrary.map((m) => m.id)).toEqual(['m-router', 'm-mill'])
      const record = JSON.parse(local.get('liencam-machine-actions') ?? '{}') as { state: { byMachine: Record<string, unknown> } }
      expect(Object.keys(record.state.byMachine).sort()).toEqual(['m-mill', 'm-router'])
    }, 60_000)
  }
})
