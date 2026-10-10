// @vitest-environment jsdom
//
// WO-1707 REVIEW (opus, safety path) - a way to lose a custom button.
//
// On a browser boot the project/machine store (`useCamStore`) hydrates
// ASYNCHRONOUSLY from durable storage (OPFS), behind
// `InitialHydrationWriteBarrier`: every write made before hydration finishes
// is DISCARDED (userSpaceStorage.ts, `setItem` returns without writing until
// `finishInitialHydration`, and never finishes when the durable read was
// unreadable). The older custom-button store (`machineActions`) is plain
// synchronous localStorage and is already loaded at that point.
//
// `moveCustomButtonsOntoRecords` runs from the `useCamStore` subscription, so
// it runs INSIDE hydration's own `set`: it writes the buttons onto the machine
// record (a write the barrier drops) and clears the older list (a write
// localStorage keeps). After boot the buttons are only in memory; closing the
// app before some later write to the project store - or any session where the
// durable store could not finish hydration - loses them for good.
//
// The invariant pinned here: once hydration has finished, every button is
// still somewhere durable.

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createJSONStorage, type PersistStorage, type StorageValue } from 'zustand/middleware'
import type { MachineConfig, Project } from '../../types'
import type { CustomAction } from '../../lib/machine/machineActions'
import {
  createUserSpaceStateStorage,
  DurableUserSpaceStateStorage,
  type LegacyStorage,
  type UserSpaceStorage,
} from '../../store/userSpaceStorage'
import { makeMachine } from '../post/helpers'

const { useCamStore, projectStoreDurability } = await import('../../store')
const { useMachineActions } = await import('../../store/machineActionsStore')
const { MacroPanel } = await import('../../components/machine/MacroPanel')

const VACUUM: CustomAction = { id: 'vacuum', label: 'Vacuum', color: 'green', lines: ['M10'] }

let originalProject: Project
let originalLibrary: MachineConfig[]
let originalControl: ReturnType<typeof useCamStore.getState>['control']
let originalOptions: ReturnType<typeof useCamStore.persist.getOptions>

beforeEach(() => {
  originalProject = useCamStore.getState().project
  originalLibrary = useCamStore.getState().machineLibrary
  originalControl = useCamStore.getState().control
  originalOptions = useCamStore.persist.getOptions()
  useMachineActions.setState({ byMachine: {}, macroArrangementByMachine: {} })
})

afterEach(() => {
  useCamStore.persist.setOptions(originalOptions)
  useCamStore.setState({ project: originalProject, machineLibrary: originalLibrary, control: originalControl })
  useMachineActions.setState({ byMachine: {}, macroArrangementByMachine: {} })
})

describe('WO-1707 review: the one-time move must not lose a button on an async (OPFS) boot', () => {
  it('after the project store hydrates behind its write barrier, the moved button is still somewhere durable', async () => {
    // What durable storage holds for the project store: Operator's machine, no macros yet.
    const sampleMachine = makeMachine({ id: 'wo1707-operator', name: 'Operator router', controller: 'uccnc' })
    const base = useCamStore.getState()
    const persistedState = originalOptions.partialize!({
      ...base,
      machineLibrary: [sampleMachine],
      project: { ...base.project, machine: sampleMachine },
      control: { ...base.control, activeMachineId: sampleMachine.id },
    })
    const blob: StorageValue<unknown> = { state: persistedState, version: originalOptions.version ?? 0 }

    // The barrier, as InitialHydrationWriteBarrier behaves: writes before
    // hydration finishes are dropped.
    let hydrationFinished = false
    const durableWrites: string[] = []
    const barrier: PersistStorage<unknown> = {
      getItem: async () => blob,
      setItem: (_name, value) => {
        if (!hydrationFinished) return
        durableWrites.push(JSON.stringify(value))
      },
      removeItem: () => {},
    }
    useCamStore.persist.setOptions({
      storage: barrier as never,
      onRehydrateStorage: () => () => { hydrationFinished = true },
    })

    // Boot, before the async read: the defaults (no record for Operator's
    // machine yet), and the older store already loaded from localStorage
    // with his button. Nothing moves - there is no record.
    const neutral = makeMachine({ id: 'wo1707-starter', name: 'Starter' })
    useCamStore.setState({ machineLibrary: [neutral], project: { ...base.project, machine: neutral } })
    useMachineActions.setState({
      byMachine: { [sampleMachine.id]: { overrides: {}, custom: [VACUUM], parks: [] } },
      macroArrangementByMachine: {},
    })
    expect(useMachineActions.getState().byMachine[sampleMachine.id].custom).toEqual([VACUUM])
    const actionsStorage = useMachineActions.persist.getOptions().storage!
    const actionsName = useMachineActions.persist.getOptions().name!
    // Control: before hydration the button IS durable, in the older store.
    expect(JSON.stringify(await actionsStorage.getItem(actionsName))).toContain('"vacuum"')

    // The durable read completes.
    await useCamStore.persist.rehydrate()
    expect(hydrationFinished).toBe(true)

    // In memory the move happened.
    const inMemory = useCamStore.getState().machineLibrary.find((m) => m.id === sampleMachine.id)
    expect(inMemory?.macros?.map((m) => m.id)).toEqual(['vacuum'])

    // Durable: the older store (localStorage) and the project store's
    // durable writes. The button must be in at least one of them.
    const actionsDurable = JSON.stringify(await actionsStorage.getItem(actionsName))
    const inOlderStore = actionsDurable.includes('"vacuum"')
    const inProjectStore = durableWrites.some((w) => w.includes('"vacuum"'))
    expect({ inOlderStore, inProjectStore }).not.toEqual({ inOlderStore: false, inProjectStore: false })
  })
})

// ---- WO-1707 fix round 2: the move against the REAL durable storage ----
//
// The project store is put behind the real `createUserSpaceStateStorage`
// (the same barrier + generation store the browser's OPFS boot uses), over an
// in-memory file store, and the move's durability question is answered by
// that same storage.

class MemoryFiles implements UserSpaceStorage {
  readonly files = new Map<string, string>()
  failRead = false
  async readText(path: string): Promise<string | null> {
    if (this.failRead) throw new DOMException('durable store unreadable', 'NotReadableError')
    return this.files.get(path) ?? null
  }
  async writeText(path: string, value: string): Promise<void> { this.files.set(path, value) }
  async remove(path: string): Promise<void> { this.files.delete(path) }
  holds(text: string): boolean { return [...this.files.values()].some((v) => v.includes(text)) }
}

class MemoryLegacy implements LegacyStorage {
  readonly values = new Map<string, string>()
  getItem(name: string): string | null { return this.values.get(name) ?? null }
  setItem(name: string, value: string): void { this.values.set(name, value) }
  removeItem(name: string): void { this.values.delete(name) }
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('WO-1707 fix round 2: the move waits for hydration and deletes the older copy only once the record is durable', () => {
  const originalWritesCommitted = projectStoreDurability.writesCommitted
  afterEach(() => {
    projectStoreDurability.writesCommitted = originalWritesCommitted
    cleanup()
  })

  /** Boot the project store from `files`/`legacy` behind the real barrier.
   *  Before the durable read: the starter defaults, and Operator's button in the
   *  older (localStorage) store. Returns once hydration has run. */
  async function bootWithButton(machineId: string, files: MemoryFiles, legacy: MemoryLegacy, seedDurable: 'files' | 'legacy') {
    const sampleMachine = makeMachine({ id: machineId, name: 'Operator router', controller: 'uccnc' })
    const base = useCamStore.getState()
    const name = originalOptions.name!
    const payload = JSON.stringify({
      state: originalOptions.partialize!({
        ...base,
        machineLibrary: [sampleMachine],
        project: { ...base.project, machine: sampleMachine },
        control: { ...base.control, activeMachineId: sampleMachine.id },
      }),
      version: originalOptions.version ?? 0,
    })
    if (seedDurable === 'files') await new DurableUserSpaceStateStorage(files, null, () => {}).setItem(name, payload)
    else legacy.setItem(name, payload)

    const storage = createUserSpaceStateStorage({ durableStorage: files, legacyStorage: legacy, onWarning: () => {} })
    projectStoreDurability.writesCommitted = () => storage.writesCommitted()
    useCamStore.persist.setOptions({
      storage: createJSONStorage(() => storage),
      onRehydrateStorage: () => () => storage.finishInitialHydration(),
    })
    const neutral = makeMachine({ id: `${machineId}-starter`, name: 'Starter' })
    useCamStore.setState({ machineLibrary: [neutral], project: { ...base.project, machine: neutral } })
    useMachineActions.setState({
      byMachine: { [sampleMachine.id]: { overrides: {}, custom: [VACUUM], parks: [] } },
      macroArrangementByMachine: {},
    })
    return { sampleMachine, storage }
  }

  const olderListIds = (machineId: string) => (useMachineActions.getState().byMachine[machineId]?.custom ?? []).map((a) => a.id)
  const recordIds = (machineId: string) => (useCamStore.getState().machineLibrary.find((m) => m.id === machineId)?.macros ?? []).map((m) => m.id)
  const olderStoreDurable = async () => {
    const opts = useMachineActions.persist.getOptions()
    return JSON.stringify(await opts.storage!.getItem(opts.name!))
  }

  it('nothing moves before hydration: the pre-hydration defaults are never written to', async () => {
    const files = new MemoryFiles()
    const legacy = new MemoryLegacy()
    const { sampleMachine } = await bootWithButton('wo1707-r2-early', files, legacy, 'files')
    // A hydration in flight: the store says it has not hydrated, and a record
    // change (the starter machine gaining a record) reaches the move.
    const hasHydrated = vi.spyOn(useCamStore.persist, 'hasHydrated').mockReturnValue(false)
    try {
      useCamStore.setState({ machineLibrary: [...useCamStore.getState().machineLibrary, sampleMachine] })
      expect(recordIds(sampleMachine.id)).toEqual([])
      expect(olderListIds(sampleMachine.id)).toEqual(['vacuum'])
    } finally {
      hasHydrated.mockRestore()
    }
  })

  it('OPFS boot: the button is on the record at once, the older copy stays until the record write commits, then goes - durable at every step, shown throughout', async () => {
    const files = new MemoryFiles()
    const legacy = new MemoryLegacy()
    const { sampleMachine, storage } = await bootWithButton('wo1707-r2-opfs', files, legacy, 'files')

    // Every store change after hydration: is the button on the panel's record?
    let hydrated = false
    const shownAtEveryChange: boolean[] = []
    const watch = () => { if (hydrated) shownAtEveryChange.push(recordIds(sampleMachine.id).includes('vacuum')) }
    const stopCam = useCamStore.subscribe(watch)
    const stopActions = useMachineActions.subscribe(watch)
    const stopFinish = useCamStore.persist.onFinishHydration(() => { hydrated = true })
    try {
      await useCamStore.persist.rehydrate()
      useCamStore.setState((s) => ({ control: { ...s.control, activeMachineId: sampleMachine.id } }))

      // Phase 1, the moment hydration finished: on the record, shown on the
      // panel once; the older copy still there and still durable.
      expect(recordIds(sampleMachine.id)).toEqual(['vacuum'])
      expect(olderListIds(sampleMachine.id)).toEqual(['vacuum'])
      expect(await olderStoreDurable()).toContain('"vacuum"')
      render(<MacroPanel onOpenActions={() => {}} rpm={10000} />)
      expect(screen.getAllByTestId('control-user-macro-vacuum')).toHaveLength(1)

      // Phase 2, once the record write has committed to the durable store.
      await storage.flushPendingWrites()
      await settle()
      expect(files.holds('vacuum')).toBe(true)
      expect(olderListIds(sampleMachine.id)).toEqual([])
      expect(await olderStoreDurable()).not.toContain('"vacuum"')
      expect(screen.getAllByTestId('control-user-macro-vacuum')).toHaveLength(1)

      // Reload from the durable store: still there, not doubled.
      const reread = JSON.parse((await new DurableUserSpaceStateStorage(files, null, () => {}).getItem(originalOptions.name!))!)
      const durableRecord = (reread.state.machineLibrary as MachineConfig[]).find((m) => m.id === sampleMachine.id)
      expect(durableRecord?.macros?.map((m) => m.id)).toEqual(['vacuum'])
    } finally {
      stopCam()
      stopActions()
      stopFinish()
    }
    expect(shownAtEveryChange.length).toBeGreaterThan(0)
    expect(shownAtEveryChange.every(Boolean)).toBe(true)
  })

  it('unreadable durable store (writes dropped all session): nothing is moved durably, the older list stays intact, the button is still shown once', async () => {
    const files = new MemoryFiles()
    files.failRead = true
    const legacy = new MemoryLegacy()
    const { sampleMachine, storage } = await bootWithButton('wo1707-r2-unreadable', files, legacy, 'legacy')

    await useCamStore.persist.rehydrate()
    expect(storage.writesCommitted()).toBe(false)
    useCamStore.setState((s) => ({ control: { ...s.control, activeMachineId: sampleMachine.id } }))
    await storage.flushPendingWrites()
    await settle()

    // The older list: intact in memory and in its own (localStorage) store.
    expect(olderListIds(sampleMachine.id)).toEqual(['vacuum'])
    expect(await olderStoreDurable()).toContain('"vacuum"')
    // Nothing reached the durable project store.
    expect(files.files.size).toBe(0)
    // The panel still shows the button, once.
    render(<MacroPanel onOpenActions={() => {}} rpm={10000} />)
    expect(screen.getAllByTestId('control-user-macro-vacuum')).toHaveLength(1)
  })
})
