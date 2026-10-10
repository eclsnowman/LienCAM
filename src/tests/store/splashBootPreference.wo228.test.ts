import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import {
  DurableUserSpaceStateStorage,
  USER_SPACE_BOOT_PREFERENCES_KEY,
  type LegacyStorage,
  type UserSpaceStorage,
} from '../../store/userSpaceStorage'

const STORAGE_KEY = 'cnc-cam-project'

class MemoryUserSpaceStorage implements UserSpaceStorage {
  readonly files = new Map<string, string>()

  async readText(path: string): Promise<string | null> {
    return this.files.get(path) ?? null
  }

  async writeText(path: string, value: string): Promise<void> {
    this.files.set(path, value)
  }

  async remove(path: string): Promise<void> {
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

describe('WO-228 synchronous splash preference after OPFS migration', () => {
  it('suppresses the splash from the boot-only mirror after the legacy payload is gone', async () => {
    const durable = new MemoryUserSpaceStorage()
    const localStorage = new MemoryLegacyStorage()
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      state: { appSettings: { showSplash: false } },
      version: 5,
    }))

    await new DurableUserSpaceStateStorage(durable, localStorage).getItem(STORAGE_KEY)

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(JSON.parse(localStorage.getItem(USER_SPACE_BOOT_PREFERENCES_KEY)!)).toEqual({
      showSplash: false,
    })

    const html = readFileSync(new URL('../../../index.html', import.meta.url), 'utf8')
    const bootScript = html.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1]
    expect(bootScript).toBeTruthy()
    const splashRoot = { remove: vi.fn() }

    runInNewContext(bootScript!, {
      localStorage,
      document: { getElementById: () => splashRoot },
    })

    expect(splashRoot.remove).toHaveBeenCalledTimes(1)
  })
})
