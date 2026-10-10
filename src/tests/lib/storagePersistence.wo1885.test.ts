// WO-1885: focused tests for the boot-time persistent-storage request.
//
// Acceptance:
//  1. stub returns true -> persist() called once at boot, line says persistent.
//  2. stub returns false -> best-effort line; no throw.
//  3. API absent -> a line saying it is unavailable; no throw.

import { describe, it, expect, vi } from 'vitest'
import {
  requestStoragePersistence,
  STORAGE_PERSISTENT_LINE,
  STORAGE_BEST_EFFORT_LINE,
  STORAGE_UNAVAILABLE_LINE,
  type PersistentStorageManager,
} from '../../lib/storagePersistence'

function navWith(storage: PersistentStorageManager | undefined): Navigator {
  return { storage } as unknown as Navigator
}

describe('requestStoragePersistence', () => {
  it('calls persist() once when not yet persisted and reports persistent', async () => {
    const persisted = vi.fn(async () => false)
    const persist = vi.fn(async () => true)
    const lines: string[] = []

    const line = await requestStoragePersistence(navWith({ persisted, persist }), (m) =>
      lines.push(m),
    )

    expect(persist).toHaveBeenCalledTimes(1)
    expect(line).toBe(STORAGE_PERSISTENT_LINE)
    expect(lines).toEqual([STORAGE_PERSISTENT_LINE])
  })

  it('reports best-effort when the browser denies the request, without throwing', async () => {
    const persist = vi.fn(async () => false)
    const lines: string[] = []

    const line = await requestStoragePersistence(
      navWith({ persisted: async () => false, persist }),
      (m) => lines.push(m),
    )

    expect(persist).toHaveBeenCalledTimes(1)
    expect(line).toBe(STORAGE_BEST_EFFORT_LINE)
    expect(lines).toEqual([STORAGE_BEST_EFFORT_LINE])
  })

  it('does not ask again when storage is already persistent', async () => {
    const persist = vi.fn(async () => true)
    const lines: string[] = []

    const line = await requestStoragePersistence(
      navWith({ persisted: async () => true, persist }),
      (m) => lines.push(m),
    )

    expect(persist).not.toHaveBeenCalled()
    expect(line).toBe(STORAGE_PERSISTENT_LINE)
  })

  it('says the API is unavailable and carries on when navigator.storage is absent', async () => {
    const lines: string[] = []

    const line = await requestStoragePersistence(navWith(undefined), (m) => lines.push(m))

    expect(line).toBe(STORAGE_UNAVAILABLE_LINE)
    expect(lines).toEqual([STORAGE_UNAVAILABLE_LINE])
  })

  it('says the API is unavailable when storage exists but persist is not a function', async () => {
    const lines: string[] = []

    const line = await requestStoragePersistence(navWith({}), (m) => lines.push(m))

    expect(line).toBe(STORAGE_UNAVAILABLE_LINE)
    expect(lines).toEqual([STORAGE_UNAVAILABLE_LINE])
  })

  it('reports best-effort, not a throw, when the request rejects', async () => {
    const persist = vi.fn(async () => {
      throw new Error('denied')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const lines: string[] = []

    const line = await requestStoragePersistence(
      navWith({ persisted: async () => false, persist }),
      (m) => lines.push(m),
    )

    expect(line).toBe(STORAGE_BEST_EFFORT_LINE)
    expect(lines).toEqual([STORAGE_BEST_EFFORT_LINE])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
