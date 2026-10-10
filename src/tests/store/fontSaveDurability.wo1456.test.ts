// WO-1456 (Codex audit BUG-505): the imported font and the project that uses it
// were written to durable user-space storage on an async schedule that project
// Save never waited for, so an immediate reload after Finish + Save could race
// an unflushed write. Save now awaits the state storage's pending writes, and
// the font rides inside the persisted project itself.
//
// The store-level case runs the REAL store against a fake OPFS root (the same
// OpfsUserSpaceStorage -> DurableUserSpaceStateStorage path the browser uses)
// whose writes the test can hold open, then "reloads" by building a fresh store
// over the same files.

import { afterEach, describe, expect, it, vi } from 'vitest'
import helvetikerData from 'three/examples/fonts/helvetiker_regular.typeface.json'
import type { SketchTextEntity } from '../../lib/sketch/types'
import {
  createUserSpaceStateStorage,
  DurableUserSpaceStateStorage,
  type UserSpaceStorage,
} from '../../store/userSpaceStorage'
import { typedMock } from '../support/typedMock'

vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}),
  loadCachedSTL: vi.fn(async () => null),
  removeCachedSTL: vi.fn(async () => {}),
}))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async () => {}),
  loadCachedStep: vi.fn(async () => null),
  removeCachedStep: vi.fn(async () => {}),
}))

// TRIAGE 10-09: the stand-in document needs a root element. A fresh module graph
// imports src/i18n (sets documentElement.lang) and uiPrefs -> applyUiTheme
// (set/removeAttribute); without a root both threw after the tests finished
// ("Cannot set properties of undefined (setting 'lang')", src/i18n/index.ts:94).
const STUB_ROOT = { lang: '', setAttribute: () => {}, removeAttribute: () => {} }
class StubWorker {
  onmessage: ((e: unknown) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  postMessage(): void {}
  terminate(): void {}
}

/** Writes commit only while the gate is open. */
class Gate {
  private open: Promise<void> = Promise.resolve()
  private release: (() => void) | null = null
  hold(): void { this.open = new Promise((r) => { this.release = r }) }
  releaseAll(): void { this.release?.(); this.release = null; this.open = Promise.resolve() }
  wait(): Promise<void> { return this.open }
}

class GatedMemoryStorage implements UserSpaceStorage {
  readonly files = new Map<string, string>()
  private readonly gate: Gate
  constructor(gate: Gate) { this.gate = gate }
  async readText(path: string) { return this.files.get(path) ?? null }
  async writeText(path: string, value: string) { await this.gate.wait(); this.files.set(path, value) }
  async remove(path: string) { this.files.delete(path) }
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))

describe('WO-1456: state storage exposes a flush Save can await', () => {
  it('flushPendingWrites resolves only after every queued write commits', async () => {
    const gate = new Gate()
    const files = new GatedMemoryStorage(gate)
    const storage = new DurableUserSpaceStateStorage(files, null, () => {})
    gate.hold()
    void storage.setItem('k', JSON.stringify({ state: { n: 1 }, version: 0 }))
    void storage.setItem('k', JSON.stringify({ state: { n: 2 }, version: 0 }))
    let flushed = false
    const flush = storage.flushPendingWrites().then(() => { flushed = true })
    await tick()
    expect(flushed).toBe(false)
    gate.releaseAll()
    await flush
    expect(JSON.parse((await new DurableUserSpaceStateStorage(files, null, () => {}).getItem('k'))!).state.n).toBe(2)
  })

  it('the app-facing storage (hydration barrier) forwards the flush', async () => {
    const gate = new Gate()
    const files = new GatedMemoryStorage(gate)
    const storage = createUserSpaceStateStorage({ durableStorage: files, legacyStorage: null, onWarning: () => {} })
    storage.finishInitialHydration()
    gate.hold()
    void storage.setItem('k', '{"state":{},"version":0}')
    let flushed = false
    const flush = storage.flushPendingWrites().then(() => { flushed = true })
    await tick()
    expect(flushed).toBe(false)
    gate.releaseAll()
    await flush
    expect(flushed).toBe(true)
  })
})

// ---- the real store over a fake OPFS root ---------------------------------

function fakeOpfsRoot(files: Map<string, string>, gate: Gate): FileSystemDirectoryHandle {
  const notFound = () => new DOMException('missing', 'NotFoundError')
  return {
    async getFileHandle(path: string, opts?: { create?: boolean }) {
      if (!files.has(path) && !opts?.create) throw notFound()
      return {
        async getFile() {
          if (!files.has(path)) throw notFound()
          const text = files.get(path)!
          return { text: async () => text }
        },
        async createWritable() {
          let buffer = ''
          return {
            async write(v: string) { buffer = v },
            async close() { await gate.wait(); files.set(path, buffer) },
            async abort() {},
          }
        },
      }
    },
    async removeEntry(path: string) { files.delete(path) },
  } as unknown as FileSystemDirectoryHandle
}

type Store = typeof import('../../store').useCamStore

async function bootStore(files: Map<string, string>, gate: Gate): Promise<Store> {
  vi.resetModules()
  const legacy = new Map<string, string>()
  vi.stubGlobal('Worker', StubWorker)
  vi.stubGlobal('alert', vi.fn())
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => legacy.get(k) ?? null,
    setItem: (k: string, v: string) => { legacy.set(k, v) },
    removeItem: (k: string) => { legacy.delete(k) },
  })
  vi.stubGlobal('navigator', { userAgent: 'node', storage: { getDirectory: async () => fakeOpfsRoot(files, gate) } })
  const { useCamStore } = await import('../../store')
  for (let i = 0; i < 200 && !useCamStore.persist.hasHydrated(); i++) await tick(10)
  expect(useCamStore.persist.hasHydrated()).toBe(true)
  return useCamStore
}

const FAMILY = 'WO1456 Durable'
const face = { ...JSON.parse(JSON.stringify(helvetikerData)), familyName: FAMILY }

function layerLoops(store: Store, layerId: string) {
  return store.getState().project.geometry
    .flatMap((g) => g.loops ?? [])
    .filter((l) => l.layerId === layerId)
    .map((l) => ({ closed: l.closed, points: l.points }))
}

afterEach(() => { vi.unstubAllGlobals() })

describe('WO-1456: Finish + Save + immediate reload keeps the imported font (BUG-505)', () => {
  it('Save does not hand over the file while the state write is still in flight, and a reload reproduces the geometry', async () => {
    const files = new Map<string, string>()
    const gate = new Gate()
    const store = await bootStore(files, gate)
    store.setState((s) => ({
      viewer: { ...s.viewer, mode: 'setup' as const, selectedGeometryId: null },
      lastNonSketchMode: 'setup' as const,
      project: { ...s.project, geometry: [], stocks: [] },
    }))

    // Import a font, place outline text, Finish -- with durable writes held.
    gate.hold()
    store.getState().setViewerMode('sketch')
    store.getState().addEntity({
      id: 'tx', kind: 'text', construction: false, at: { x: 0, y: 0 }, text: 'HIT', height: 10, rotation: 0,
      fontStyle: 'outline',
    } as SketchTextEntity)
    store.getState().beginSketchTextEdit('tx')
    await store.getState().importSketchFont(new File([JSON.stringify(face)], 'durable.json'))
    store.getState().commitSketchTextEdit()
    const layerId = store.getState().activeSketch!.layerId
    store.getState().finishSketch()
    const saved = layerLoops(store, layerId)
    expect(saved.length).toBeGreaterThan(0)

    const click = vi.fn()
    vi.stubGlobal('document', { documentElement: STUB_ROOT, createElement: () => ({ click }) })
    const create = URL.createObjectURL
    const revoke = URL.revokeObjectURL
    URL.createObjectURL = (() => 'blob:wo1456') as typeof URL.createObjectURL
    URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL
    try {
      const saving = store.getState().saveProjectToFile()
      await tick(80)
      expect(click, 'Save completed with an unflushed state write behind it').not.toHaveBeenCalled()
      gate.releaseAll()
      await saving
      expect(click).toHaveBeenCalledTimes(1)
    } finally {
      URL.createObjectURL = create
      URL.revokeObjectURL = revoke
    }

    // Immediate reload of the SAME context: a fresh store over the same files.
    const reloaded = await bootStore(files, gate)
    expect(layerLoops(reloaded, layerId)).toEqual(saved)
    const owner = reloaded.getState().project.geometry.find((g) => g.sketches?.some((s) => s.layerId === layerId))!
    expect(reloaded.getState().openSketchForLayer(layerId, owner.id)).toBe(true)
    reloaded.getState().setViewerMode('sketch')
    reloaded.getState().finishSketch()
    expect(reloaded.getState().activeSketch).toBeNull()
    expect(layerLoops(reloaded, layerId)).toEqual(saved)
  })
})
