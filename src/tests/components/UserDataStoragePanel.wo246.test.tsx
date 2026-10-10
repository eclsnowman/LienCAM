// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { UserDataStoragePanel } from '../../components/modals/UserDataStoragePanel'
import {
  DurableUserSpaceStateStorage,
  type ShopDataServiceOptions,
  type UserSpaceStorage,
} from '../../store/userSpaceStorage'

class MemoryDurableStorage implements UserSpaceStorage {
  readonly text = new Map<string, string>()
  readonly binary = new Map<string, Uint8Array>()
  failPathListing = false

  async readText(path: string): Promise<string | null> { return this.text.get(path) ?? null }
  async writeText(path: string, value: string): Promise<void> { this.text.set(path, value) }
  async remove(path: string): Promise<void> {
    this.text.delete(path)
    this.binary.delete(path)
  }
  async listPaths(): Promise<string[]> {
    if (this.failPathListing) throw new Error('simulated recovery inventory failure')
    return [...new Set([...this.text.keys(), ...this.binary.keys()])].sort()
  }
  async readBytes(path: string): Promise<Uint8Array | null> {
    const value = this.binary.get(path)
    return value ? new Uint8Array(value) : null
  }
  async writeBytes(path: string, value: Uint8Array): Promise<void> {
    this.binary.set(path, new Uint8Array(value))
  }
}

const STORAGE_KEY = 'cnc-cam-project'

function options(durableStorage: MemoryDurableStorage): ShopDataServiceOptions {
  return {
    durableStorage,
    legacyStorage: null,
    storageKey: STORAGE_KEY,
    now: () => new Date('2026-08-11T16:30:00.000Z'),
  }
}

async function seededStorage(): Promise<MemoryDurableStorage> {
  const durable = new MemoryDurableStorage()
  const payload = JSON.stringify({
    state: {
      appSettings: { showSplash: true },
      machineLibrary: [{ id: 'machine-1' }, { id: 'machine-2' }],
      toolLibraries: [{ id: 'library-1' }],
      toolLibrary: [{ id: 'tool-1' }],
      holders: [{ id: 'holder-1' }],
      importedFonts: [{ family: 'Shop Sans' }],
      operationTemplates: [{ id: 'roughing' }],
      project: { id: 'active-project', name: 'Bracket setup' },
    },
    version: 5,
  })
  await new DurableUserSpaceStateStorage(durable, null, () => {}).setItem(STORAGE_KEY, payload)
  return durable
}

afterEach(() => cleanup())

describe('WO-246 User Data summary rows', () => {
  it('mounts every category collapsed with only count and non-healthy state in its summary', async () => {
    const durable = await seededStorage()
    durable.failPathListing = true
    render(<UserDataStoragePanel serviceOptions={options(durable)} />)

    const rows = await screen.findAllByTestId(/^user-data-row-/)
    expect(rows).toHaveLength(15)
    for (const row of rows) {
      expect(within(row).getByRole('button').getAttribute('aria-expanded')).toBe('false')
      expect(row.querySelector('.disclosure-body')).toBeNull()
    }

    const healthySummary = screen.getByTestId('user-data-row-machines').querySelector('.disclosure-summary')
    expect(healthySummary?.textContent).toBe('2 items')
    expect(healthySummary?.textContent).not.toContain('healthy')

    const attentionSummary = screen.getByTestId('user-data-row-active-project-recovery')
      .querySelector('.disclosure-summary')
    expect(attentionSummary?.textContent).toBe('0 items | unavailable')
  })

  it('expands rows independently and starts collapsed again after a remount', async () => {
    const durable = await seededStorage()
    const mounted = render(<UserDataStoragePanel serviceOptions={options(durable)} />)
    const machines = await screen.findByTestId('user-data-row-machines')
    const holders = screen.getByTestId('user-data-row-holders')

    fireEvent.click(within(machines).getByRole('button'))
    expect(within(machines).getByRole('button').getAttribute('aria-expanded')).toBe('true')
    const machineDetail = machines.querySelector('.disclosure-body') as HTMLElement
    expect(machineDetail.textContent).toContain('Estimated size:')
    expect(machineDetail.textContent).toContain('Last write:')
    expect(machineDetail.textContent).toContain('Current:')
    expect(machineDetail.textContent).toContain('Backup:')
    expect(within(holders).getByRole('button').getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(within(holders).getByRole('button'))
    expect(within(machines).getByRole('button').getAttribute('aria-expanded')).toBe('true')
    expect(within(holders).getByRole('button').getAttribute('aria-expanded')).toBe('true')

    mounted.unmount()
    render(<UserDataStoragePanel serviceOptions={options(durable)} />)
    const remountedMachines = await screen.findByTestId('user-data-row-machines')
    expect(within(remountedMachines).getByRole('button').getAttribute('aria-expanded')).toBe('false')
  })
})
