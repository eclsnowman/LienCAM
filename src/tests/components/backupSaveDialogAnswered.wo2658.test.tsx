// @vitest-environment jsdom

// WO-2658 (operator 10-07: "yes fix before freeze"): Settings > User Data said
// "Backup downloaded" before the operator answered the desktop Save dialog, and said it
// even when he cancelled. The status now waits for the dialog and tells the truth.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UserDataStoragePanel } from '../../components/modals/UserDataStoragePanel'
import { type ShopDataServiceOptions, type UserSpaceStorage } from '../../store/userSpaceStorage'

class MemoryDurableStorage implements UserSpaceStorage {
  readonly text = new Map<string, string>()
  async readText(path: string): Promise<string | null> { return this.text.get(path) ?? null }
  async writeText(path: string, value: string): Promise<void> { this.text.set(path, value) }
  async remove(path: string): Promise<void> { this.text.delete(path) }
  async listPaths(): Promise<string[]> { return [...this.text.keys()].sort() }
  async readBytes(): Promise<Uint8Array | null> { return null }
  async writeBytes(): Promise<void> {}
}

function options(): ShopDataServiceOptions {
  return {
    durableStorage: new MemoryDurableStorage(),
    legacyStorage: null,
    storageKey: 'cnc-cam-project',
    now: () => new Date('2026-10-07T15:30:00.000Z'),
  }
}

/** The desktop host's Save dialog, answered when the test says so. */
function stubHostSave() {
  let answer: (where: string | null) => void = () => {}
  const saveFile = vi.fn(() => new Promise<string | null>((resolve) => { answer = resolve }))
  vi.stubGlobal('liencamHost', { saveFile })
  return { saveFile, answer: (where: string | null) => answer(where) }
}

const status = () => screen.getByTestId('user-data-storage-status').textContent ?? ''

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('WO-2658: the backup status waits for the Save dialog', () => {
  it('says nothing about "downloaded" while the dialog is open, then says it once saved', async () => {
    const host = stubHostSave()
    render(<UserDataStoragePanel serviceOptions={options()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Download backup' }))
    await waitFor(() => expect(host.saveFile).toHaveBeenCalledTimes(1))
    expect(status()).not.toMatch(/downloaded/i)
    await act(async () => host.answer('C:\\Backups\\LienCAM-shop-data-backup.json'))
    await waitFor(() => expect(status()).toMatch(/^Backup downloaded\./))
  })

  it('a cancelled Save dialog says no backup was written', async () => {
    const host = stubHostSave()
    render(<UserDataStoragePanel serviceOptions={options()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Download backup' }))
    await waitFor(() => expect(host.saveFile).toHaveBeenCalledTimes(1))
    await act(async () => host.answer(null))
    await waitFor(() => expect(status()).toBe('Save was canceled; no backup was written.'))
  })
})
