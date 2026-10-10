import { describe, expect, it, vi } from 'vitest'
import { resetProjectDataAndReload } from '../../components/ErrorBoundary'
import {
  DurableUserSpaceStateStorage,
  resetUserSpaceStateStorage,
  type LegacyStorage,
  type UserSpaceStorage,
} from '../../store/userSpaceStorage'

const STORAGE_KEY = 'cnc-cam-project'

class MemoryUserSpaceStorage implements UserSpaceStorage {
  readonly files = new Map<string, string>()
  failRemove = false

  async readText(path: string): Promise<string | null> {
    return this.files.get(path) ?? null
  }

  async writeText(path: string, value: string): Promise<void> {
    this.files.set(path, value)
  }

  async remove(path: string): Promise<void> {
    if (this.failRemove) throw new Error('simulated OPFS remove failure')
    this.files.delete(path)
  }
}

class MemoryLegacyStorage implements LegacyStorage {
  readonly values = new Map<string, string>()

  getItem(name: string): string | null {
    return this.values.get(name) ?? null
  }

  setItem(name: string, value: string): void {
    this.values.set(name, value)
  }

  removeItem(name: string): void {
    this.values.delete(name)
  }
}

describe('WO-228 ErrorBoundary durable reset', () => {
  it('clears real durable project data before reloading', async () => {
    const durable = new MemoryUserSpaceStorage()
    const legacy = new MemoryLegacyStorage()
    await new DurableUserSpaceStateStorage(durable, legacy).setItem(
      STORAGE_KEY,
      JSON.stringify({ state: { project: { id: 'broken-project' } }, version: 5 }),
    )
    const clearProjectData = vi.fn(() => resetUserSpaceStateStorage(STORAGE_KEY, {
      durableStorage: durable,
      legacyStorage: legacy,
    }))
    const reload = vi.fn()

    await resetProjectDataAndReload(clearProjectData, reload)

    expect(clearProjectData).toHaveBeenCalledTimes(1)
    expect([...durable.files.keys()]).toEqual([])
    expect(legacy.getItem(STORAGE_KEY)).toBeNull()
    expect(reload).toHaveBeenCalledTimes(1)
    expect(clearProjectData.mock.invocationCallOrder[0]).toBeLessThan(
      reload.mock.invocationCallOrder[0],
    )
  })

  it('still reloads and suppresses stale hydration when OPFS removal fails', async () => {
    const durable = new MemoryUserSpaceStorage()
    const legacy = new MemoryLegacyStorage()
    const warnings: string[] = []
    await new DurableUserSpaceStateStorage(durable, legacy).setItem(
      STORAGE_KEY,
      JSON.stringify({ state: { project: { id: 'broken-project' } }, version: 5 }),
    )
    durable.failRemove = true
    const clearProjectData = vi.fn(() => resetUserSpaceStateStorage(STORAGE_KEY, {
      durableStorage: durable,
      legacyStorage: legacy,
      onWarning: (warning) => warnings.push(warning.code),
    }))
    const reload = vi.fn()

    await expect(resetProjectDataAndReload(clearProjectData, reload)).resolves.toBeUndefined()

    expect(reload).toHaveBeenCalledTimes(1)
    expect(legacy.getItem(STORAGE_KEY)).toBeNull()
    expect(await new DurableUserSpaceStateStorage(
      durable,
      legacy,
      (warning) => warnings.push(warning.code),
    ).getItem(STORAGE_KEY)).toBeNull()
    expect(warnings).toContain('USER_SPACE_RESET_DEFERRED')
  })
})
