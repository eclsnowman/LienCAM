// WO-411 slice 5 - the persisted probe routine store: registered key,
// round-trip through localStorage, survives a reload, quarantine on load.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PERSISTED_USER_DATA_REGISTRY } from '../../store/persistedKeys'
import { FACTORY_BORE_CENTRE, FACTORY_PROBE_ROUTINES } from '../../lib/machine/probeRoutineFactory'
import type { ProbeRoutine } from '../../lib/machine/probeRoutineFormat'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (key: string) => (mem.has(key) ? mem.get(key)! : null),
  key: (index: number) => Array.from(mem.keys())[index] ?? null,
  removeItem: (key: string) => { mem.delete(key) },
  setItem: (key: string, value: string) => { mem.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const KEY = PERSISTED_USER_DATA_REGISTRY.probeRoutines.key

async function freshStore() {
  vi.resetModules()
  const mod = await import('../../store/probeRoutineStore')
  return mod.useProbeRoutineStore
}

function userRoutine(id = 'user.my-bore', name = 'My bore'): ProbeRoutine {
  return { ...FACTORY_BORE_CENTRE, id, name, provenance: { kind: 'user' } }
}

describe('WO-411 slice 5 - probeRoutineStore persistence', () => {
  beforeEach(() => { mem.clear() })
  afterEach(() => { mem.clear() })

  it('starts with the factory set only and persists nothing factory', async () => {
    const store = await freshStore()
    const entries = store.getState().listRoutines()
    expect(entries.map((e) => e.routine)).toEqual(FACTORY_PROBE_ROUTINES)
    expect(store.getState().routines).toEqual({})
    const raw = mem.get(KEY)
    if (raw !== undefined) {
      expect(JSON.parse(raw).state.routines).toEqual({})
    }
  })

  it('round-trips a saved user routine, an import with its review, and a hidden factory id through the registered key', async () => {
    const store = await freshStore()
    expect(store.getState().saveRoutine(userRoutine()).ok).toBe(true)
    const exported = store.getState().exportRoutines(['factory.bore-centre', 'user.my-bore'])
    expect(exported.ok).toBe(true)
    if (!exported.ok) return
    expect(exported.fileName).toBe('probe-routines.liencam-probe.json')
    const imported = store.getState().importFromText(exported.text, 'shop.liencam-probe.json', 'keep-both')
    expect(imported.ok).toBe(true)
    expect(imported.accepted.map((r) => r.id).sort()).toEqual(['imported.bore-centre', 'user.my-bore-2'])
    expect(store.getState().getRoutine('imported.bore-centre')?.provenance.kind).toBe('imported')
    expect(store.getState().isReviewed('imported.bore-centre', 'sha256:p1')).toBe(false)
    expect(store.getState().markReviewed('imported.bore-centre', 'sha256:p1').ok).toBe(true)
    expect(store.getState().isReviewed('imported.bore-centre', 'sha256:p1')).toBe(true)
    expect(store.getState().hideFactoryRoutine('factory.edge.x-minus').ok).toBe(true)

    // the bytes went through the registered key and only there
    expect([...mem.keys()]).toEqual([KEY])
    const persisted = JSON.parse(mem.get(KEY)!) as { state: Record<string, unknown> }
    expect(Object.keys(persisted.state).sort()).toEqual(['hidden', 'quarantined', 'routines'])
    expect(Object.keys(persisted.state.routines as object).sort()).toEqual(['imported.bore-centre', 'user.my-bore', 'user.my-bore-2'])

    // a reload: a fresh module instance rehydrates from the same storage
    const reloaded = await freshStore()
    expect(reloaded).not.toBe(store)
    const state = reloaded.getState()
    expect(Object.keys(state.routines).sort()).toEqual(['imported.bore-centre', 'user.my-bore', 'user.my-bore-2'])
    expect(state.getRoutine('user.my-bore')?.name).toBe('My bore')
    expect(state.isReviewed('imported.bore-centre', 'sha256:p1')).toBe(true)
    expect(state.isReviewed('imported.bore-centre', 'sha256:p2')).toBe(false)
    expect(state.hidden).toEqual(['factory.edge.x-minus'])
    expect(state.listRoutines().some((e) => e.routine.id === 'factory.edge.x-minus')).toBe(false)

    // restore factory routines: un-hides, touches nothing of the user's
    state.restoreFactoryRoutines()
    expect(reloaded.getState().hidden).toEqual([])
    expect(Object.keys(reloaded.getState().routines).sort()).toEqual(['imported.bore-centre', 'user.my-bore', 'user.my-bore-2'])
    expect(reloaded.getState().listRoutines().filter((e) => e.kind === 'factory').map((e) => e.routine)).toEqual(FACTORY_PROBE_ROUTINES)
  })

  it('a stored routine that no longer validates is quarantined on load with its reason, never dropped', async () => {
    const bad = { ...userRoutine('user.bad', 'Bad'), steps: [{ kind: 'gcode', line: 'G10 L20 P0 X0' }] }
    mem.set(KEY, JSON.stringify({ state: { routines: { 'user.bad': bad, 'user.good': userRoutine('user.good', 'Good') }, quarantined: {}, hidden: [] }, version: 1 }))
    const store = await freshStore()
    const state = store.getState()
    expect(Object.keys(state.routines)).toEqual(['user.good'])
    expect(Object.keys(state.quarantined)).toEqual(['user.bad'])
    expect(state.quarantined['user.bad'].json).toEqual(bad)
    expect(state.quarantined['user.bad'].errors.some((s) => s.includes("no step kind 'gcode'"))).toBe(true)
    expect(state.deleteRoutine('user.bad').ok).toBe(true)
    expect(store.getState().quarantined).toEqual({})
  })

  it('import with the default policy holds collisions pending; resolveCollision settles them', async () => {
    const store = await freshStore()
    store.getState().saveRoutine(userRoutine())
    const exported = store.getState().exportRoutines(['user.my-bore'])
    if (!exported.ok) throw new Error('export failed')
    const result = store.getState().importFromText(exported.text, 'again.liencam-probe.json')
    expect(result.accepted).toEqual([])
    expect(result.collisions[0].resolution).toBe('pending')
    expect(store.getState().getRoutine('user.my-bore')?.provenance.kind).toBe('user')
    expect(store.getState().resolveCollision(result.collisions[0], 'replace').ok).toBe(true)
    expect(store.getState().getRoutine('user.my-bore')?.provenance.kind).toBe('imported')
    expect(store.getState().resolveCollision(result.collisions[0], 'keep-both').ok).toBe(true)
    expect(store.getState().getRoutine('user.my-bore-2')?.provenance.kind).toBe('imported')
  })

  it('refuses a newer file whole and stores nothing', async () => {
    const store = await freshStore()
    const result = store.getState().importFromText(JSON.stringify({ format: 'liencam-probe-routines', schemaVersion: 2, routines: [userRoutine()] }), 'new.json')
    expect(result.ok).toBe(false)
    expect(result.fileErrors[0]).toBe('This file was saved by a newer LienCAM (format 2); this version reads format 1. Nothing was imported.')
    expect(store.getState().routines).toEqual({})
  })

  it('export refuses an unknown id and an empty selection', async () => {
    const store = await freshStore()
    expect(store.getState().exportRoutines(['nope'])).toEqual({ ok: false, errors: ["There is no routine with id 'nope' to export."] })
    expect(store.getState().exportRoutines([])).toEqual({ ok: false, errors: ['Nothing selected to export.'] })
  })
})
