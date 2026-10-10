// @vitest-environment jsdom

import { answerPendingConfirm } from './confirmDialog.support'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UserDataStoragePanel } from '../../components/modals/UserDataStoragePanel'
import {
  createShopDataBackup,
  DurableUserSpaceStateStorage,
  inspectShopData,
  previewShopDataRestore,
  restoreShopDataBackup,
  type LegacyStorage,
  type ShopDataServiceOptions,
  type UserSpaceStorage,
} from '../../store/userSpaceStorage'

class MemoryLegacyStorage implements LegacyStorage {
  readonly records = new Map<string, string>()

  getItem(name: string): string | null { return this.records.get(name) ?? null }
  setItem(name: string, value: string): void { this.records.set(name, value) }
  removeItem(name: string): void { this.records.delete(name) }
}

class MemoryDurableStorage implements UserSpaceStorage {
  readonly text = new Map<string, string>()
  readonly binary = new Map<string, Uint8Array>()
  failNextBinaryWrite = false

  async readText(path: string): Promise<string | null> { return this.text.get(path) ?? null }
  async writeText(path: string, value: string): Promise<void> { this.text.set(path, value) }
  async remove(path: string): Promise<void> {
    this.text.delete(path)
    this.binary.delete(path)
  }
  async listPaths(): Promise<string[]> {
    return [...new Set([...this.text.keys(), ...this.binary.keys()])].sort()
  }
  async readBytes(path: string): Promise<Uint8Array | null> {
    const value = this.binary.get(path)
    return value ? new Uint8Array(value) : null
  }
  async writeBytes(path: string, value: Uint8Array): Promise<void> {
    if (this.failNextBinaryWrite) {
      this.failNextBinaryWrite = false
      throw new Error('simulated recovery-file write failure')
    }
    this.binary.set(path, new Uint8Array(value))
  }
}

const STORAGE_KEY = 'cnc-cam-project'
const FIXED_NOW = new Date('2026-08-11T16:30:00.000Z')

function payload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    state: {
      appSettings: { showSplash: true, defaultMachineId: 'machine-1' },
      machineLibrary: [{ id: 'machine-1' }, { id: 'machine-2' }],
      toolLibraries: [{ id: 'library-1' }],
      toolLibrary: [{ id: 'tool-1' }, { id: 'tool-2' }],
      holders: [{ id: 'holder-1' }],
      importedFonts: [{ family: 'Shop Sans' }],
      operationTemplates: [{ id: 'roughing' }],
      project: { id: 'active-project', name: 'Bracket setup' },
      ...overrides,
    },
    version: 5,
  })
}

function options(
  durableStorage: MemoryDurableStorage,
  legacyStorage = new MemoryLegacyStorage(),
): ShopDataServiceOptions {
  return { durableStorage, legacyStorage, storageKey: STORAGE_KEY, now: () => FIXED_NOW }
}

async function seed(storage: MemoryDurableStorage, value: string): Promise<void> {
  await new DurableUserSpaceStateStorage(storage, null, () => {}).setItem(STORAGE_KEY, value)
}

async function currentPayload(storage: MemoryDurableStorage): Promise<string | null> {
  return new DurableUserSpaceStateStorage(storage, null, () => {}).getItem(STORAGE_KEY)
}

// WO-246 collapsed every inventory row to a one-line summary, so per-key detail
// (notes, generations, last write) is only in the DOM once its row is expanded.
// Assertions that read that detail expand the row first instead of asserting on
// collapsed text - the guarantee is unchanged, the reach is one click longer.
function expandRow(testId: string): HTMLElement {
  const row = screen.getByTestId(testId)
  fireEvent.click(within(row).getByRole('button'))
  const body = row.querySelector('.disclosure-body')
  if (body === null) throw new Error(`row ${testId} did not expand`)
  return body as HTMLElement
}

async function uploadBundle(text: string): Promise<void> {
  const file = new File([text], 'shop-data.json', { type: 'application/json' })
  if (typeof file.text !== 'function') {
    Object.defineProperty(file, 'text', { value: async () => text })
  }
  fireEvent.change(screen.getByTestId('user-data-import-input'), { target: { files: [file] } })
}

beforeEach(() => {
  Object.defineProperty(window, 'showDirectoryPicker', { value: undefined, configurable: true })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Object.defineProperty(window, 'showDirectoryPicker', { value: undefined, configurable: true })
})

describe('WO-226 Settings > User Data', () => {
  it('mounts an honest collection inventory with live and reserved categories', async () => {
    const durable = new MemoryDurableStorage()
    const legacy = new MemoryLegacyStorage()
    legacy.setItem('liencam-ui-prefs', JSON.stringify({ state: { panelLeftWidth: 300, uiTheme: 'default' } }))
    legacy.setItem('liencam.machine.programPreviewGrid', 'G55')
    legacy.setItem('liencam.userPosts', JSON.stringify([{ id: 'mill-post' }, { id: 'router-post' }]))
    legacy.setItem('liencam-machine-actions', JSON.stringify({ state: { byMachine: { mill: { custom: [] } } } }))
    legacy.setItem('liencam-tool-table', JSON.stringify({ state: { byMachine: { mill: { table: { tools: [] } } } } }))
    durable.binary.set('autosave-project-1.zip', new Uint8Array([1, 2, 3, 4]))
    durable.binary.set('autosave-project-1.json', new TextEncoder().encode('{"unclean":true}'))
    await seed(durable, payload())

    render(<UserDataStoragePanel serviceOptions={options(durable, legacy)} />)

    expect((await screen.findByTestId('user-data-row-machines')).textContent).toContain('2 items')
    expect(screen.getByTestId('user-data-row-tool-libraries').textContent).toContain('3 items')
    expect(screen.getByTestId('user-data-row-holders').textContent).toContain('1 item')
    expect(screen.getByTestId('user-data-row-imported-fonts').textContent).toContain('1 item')
    expect(screen.getByTestId('user-data-row-recipe-templates').textContent).toContain('1 item')
    expect(screen.getByTestId('user-data-row-active-project').textContent).toContain('1 item')
    expect(screen.getByTestId('user-data-row-ui-customization').textContent).toContain('3 items')
    expect(screen.getByTestId('user-data-row-active-project-recovery').textContent).toContain('1 item')
    expect(screen.getByTestId('user-data-row-post-profiles').textContent).toContain('2 items')
    expect(screen.getByTestId('user-data-row-controller-macros').textContent).toContain('1 item')
    expect(screen.getByTestId('user-data-row-controller-macros').textContent).toContain('limited')
    expect(screen.getByTestId('user-data-row-machine-tool-tables').textContent).toContain('1 item')
    expect(screen.getByTestId('user-data-storage-status').textContent).toContain('Durable browser storage is available')

    const fixturesDetail = expandRow('user-data-row-fixtures')
    const postProfilesDetail = expandRow('user-data-row-post-profiles')
    expect(fixturesDetail.textContent).toContain('Reserved for records')
    expect(postProfilesDetail.textContent).not.toContain('Reserved for records')
    expect(expandRow('user-data-row-machines').textContent).toMatch(/Current: .+ \| Backup: none/)
    expect(postProfilesDetail.textContent).toContain('Last write: -')
  })

  it('reports lost folder permission and never relabels a browser temporary location as backup', async () => {
    const durable = new MemoryDurableStorage()
    await seed(durable, payload())
    let savedBundle = ''
    const writable = {
      write: vi.fn(async (value: string) => { savedBundle = value }),
      close: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    }
    const fileHandle = {
      createWritable: vi.fn(async () => writable),
      getFile: vi.fn(async () => ({ text: async () => savedBundle })),
    }
    const getFileHandle = vi.fn(async () => fileHandle)
    const folder = {
      queryPermission: vi.fn()
        .mockResolvedValueOnce('granted' as PermissionState)
        .mockResolvedValueOnce('denied' as PermissionState),
      requestPermission: vi.fn(async () => 'denied' as PermissionState),
      getFileHandle,
    } as unknown as FileSystemDirectoryHandle
    Object.defineProperty(window, 'showDirectoryPicker', {
      value: vi.fn(async () => folder),
      configurable: true,
    })
    render(<UserDataStoragePanel serviceOptions={options(durable)} />)
    await screen.findByTestId('user-data-row-preferences')

    fireEvent.click(screen.getByRole('button', { name: 'Choose folder and sync' }))
    expect(await screen.findByText(/Verified LienCAM-shop-data-backup.json/)).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }))

    expect(await screen.findByText(/Backup folder permission was not granted/)).not.toBeNull()
    expect(getFileHandle).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(/temporary directory/i)).toBeNull()
  })

  it('uses one bundle manifest for every exported, inventoried, and previewed collection', async () => {
    const source = new MemoryDurableStorage()
    const sourceLegacy = new MemoryLegacyStorage()
    sourceLegacy.setItem('liencam-ui-prefs', '{"state":{"uiTheme":"high-contrast"}}')
    sourceLegacy.setItem('liencam.machine.programPreviewGrid', 'G56')
    sourceLegacy.setItem('liencam.userPosts', '[{"id":"shop-post"}]')
    sourceLegacy.setItem('liencam-machine-actions', '{"state":{"byMachine":{"mill":{}}}}')
    source.binary.set('autosave-source.zip', new Uint8Array([9, 8, 7]))
    await seed(source, payload())

    const backup = await createShopDataBackup(options(source, sourceLegacy))
    const bundle = JSON.parse(backup.text) as {
      content: {
        localRecords: Record<string, string>
        manifest: Array<{ id: string; label: string; itemCount: number }>
      }
    }
    const manifestIds = bundle.content.manifest.map((collection) => collection.id)
    const inventory = await inspectShopData(options(source, sourceLegacy))

    const target = new MemoryDurableStorage()
    await seed(target, payload({ project: undefined, machineLibrary: [] }))
    const preview = await previewShopDataRestore(backup.text, options(target))

    expect(inventory.collections.map((collection) => collection.id)).toEqual(manifestIds)
    expect(preview.differences.map((difference) => difference.id)).toEqual(manifestIds)
    expect(new Set(manifestIds).size).toBe(manifestIds.length)
    expect(bundle.content.manifest.find((collection) => collection.id === 'active-project')?.itemCount).toBe(1)
    expect(bundle.content.manifest.find((collection) => collection.id === 'post-profiles')?.itemCount).toBe(1)
    expect(bundle.content.localRecords).toMatchObject({
      'liencam.machine.programPreviewGrid': 'G56',
      'liencam.userPosts': '[{"id":"shop-post"}]',
    })
    expect(preview.differences.find((difference) => difference.id === 'active-project')).toMatchObject({
      currentCount: 0,
      incomingCount: 1,
    })

    const emptyProject = new MemoryDurableStorage()
    await seed(emptyProject, payload({ project: undefined }))
    const emptyBundle = JSON.parse((await createShopDataBackup(options(emptyProject))).text) as {
      content: { manifest: Array<{ id: string; itemCount: number }> }
    }
    expect(emptyBundle.content.manifest.find((collection) => collection.id === 'active-project')?.itemCount).toBe(0)
    const emptyInventory = await inspectShopData(options(emptyProject))
    expect(emptyInventory.collections.find((collection) => collection.id === 'post-profiles')?.health)
      .not.toBe('reserved')
    expect(emptyInventory.collections.find((collection) => collection.id === 'controller-macros')?.health)
      .not.toBe('reserved')

    const undisclosed = new MemoryDurableStorage()
    await seed(undisclosed, payload({ futurePersistedCollection: [{ id: 'must-be-disclosed' }] }))
    await expect(createShopDataBackup(options(undisclosed))).rejects.toThrow(
      'undisclosed persisted collections: futurePersistedCollection',
    )
  })

  it('exports a versioned bundle, restores only after confirmation, and reloads before stale state can persist', async () => {
    const source = new MemoryDurableStorage()
    const sourceLegacy = new MemoryLegacyStorage()
    sourceLegacy.setItem('liencam-ui-prefs', JSON.stringify({ state: { uiTheme: 'high-contrast' } }))
    sourceLegacy.setItem('liencam.machine.programPreviewGrid', 'G56')
    sourceLegacy.setItem('liencam.userPosts', '[{"id":"shop-post"}]')
    source.binary.set('autosave-source.zip', new Uint8Array([9, 8, 7]))
    await seed(source, payload({ machineLibrary: [{ id: 'source-machine' }] }))
    const backup = await createShopDataBackup(options(source, sourceLegacy))

    const target = new MemoryDurableStorage()
    const targetLegacy = new MemoryLegacyStorage()
    const reloadPage = vi.fn()
    await seed(target, payload({ machineLibrary: [] }))
    render(
      <UserDataStoragePanel
        serviceOptions={options(target, targetLegacy)}
        reloadPage={reloadPage}
      />,
    )
    await screen.findByTestId('user-data-row-machines')

    await uploadBundle(backup.text)
    const preview = await screen.findByTestId('user-data-restore-preview')
    expect(preview.textContent).toContain('0 current -> 1 incoming')
    expect(preview.textContent).toContain('Active project')
    expect(within(preview).getByText('Post profiles').parentElement?.textContent)
      .toContain('0 current -> 1 incoming')
    expect(within(preview).getByText('UI and control-panel customization').parentElement?.textContent)
      .toContain('0 current -> 2 incoming')
    expect(await currentPayload(target)).toContain('"machineLibrary":[]')
    expect(reloadPage).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Confirm restore' }))

    expect(await screen.findByText(/Restore verified/)).not.toBeNull()
    expect(await currentPayload(target)).toContain('source-machine')
    expect(targetLegacy.getItem('liencam-ui-prefs')).toContain('high-contrast')
    expect(targetLegacy.getItem('liencam.machine.programPreviewGrid')).toBe('G56')
    expect(targetLegacy.getItem('liencam.userPosts')).toBe('[{"id":"shop-post"}]')
    expect([...target.binary.get('autosave-source.zip') ?? []]).toEqual([9, 8, 7])
    expect(reloadPage).toHaveBeenCalledTimes(1)
  })

  it('removes recovery snapshots absent from the verified bundle after previewing the exact change', async () => {
    const source = new MemoryDurableStorage()
    await seed(source, payload({ machineLibrary: [{ id: 'source-machine' }] }))
    const backup = await createShopDataBackup(options(source))

    const target = new MemoryDurableStorage()
    const reloadPage = vi.fn()
    target.binary.set('autosave-stale.zip', new Uint8Array([1, 2, 3]))
    target.binary.set('autosave-stale.json', new TextEncoder().encode('{"unclean":true}'))
    await seed(target, payload({ machineLibrary: [] }))
    render(<UserDataStoragePanel serviceOptions={options(target)} reloadPage={reloadPage} />)
    await screen.findByTestId('user-data-row-machines')

    await uploadBundle(backup.text)
    expect((await screen.findByTestId('user-data-restore-preview')).textContent).toContain(
      '1 current -> 0 incoming',
    )

    fireEvent.click(screen.getByRole('button', { name: 'Confirm restore' }))

    expect(await screen.findByText(/Restore verified/)).not.toBeNull()
    expect(target.binary.has('autosave-stale.zip')).toBe(false)
    expect(target.binary.has('autosave-stale.json')).toBe(false)
    expect(reloadPage).toHaveBeenCalledTimes(1)
  })

  it('refuses a checksum-tampered import before showing confirmation or changing data', async () => {
    const durable = new MemoryDurableStorage()
    const original = payload({ machineLibrary: [{ id: 'original' }] })
    await seed(durable, original)
    const backup = await createShopDataBackup(options(durable))
    const tampered = backup.text.replace('2026-08-11T16:30:00.000Z', '2026-08-12T16:30:00.000Z')
    render(<UserDataStoragePanel serviceOptions={options(durable)} />)
    await screen.findByTestId('user-data-row-machines')

    await uploadBundle(tampered)

    expect(await screen.findByText(/Bundle checksum verification failed/)).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Confirm restore' })).toBeNull()
    expect(await currentPayload(durable)).toBe(original)
  })

  it('rolls primary data and local records back when a later recovery-file write fails', async () => {
    const source = new MemoryDurableStorage()
    const sourceLegacy = new MemoryLegacyStorage()
    sourceLegacy.setItem('liencam-ui-prefs', '{"state":{"uiTheme":"incoming"}}')
    source.binary.set('autosave-source.zip', new Uint8Array([4, 5, 6]))
    await seed(source, payload({ machineLibrary: [{ id: 'incoming' }] }))
    const backup = await createShopDataBackup(options(source, sourceLegacy))

    const target = new MemoryDurableStorage()
    const targetLegacy = new MemoryLegacyStorage()
    const original = payload({ machineLibrary: [{ id: 'original' }] })
    targetLegacy.setItem('liencam-ui-prefs', '{"state":{"uiTheme":"original"}}')
    target.binary.set('autosave-original.zip', new Uint8Array([7, 8, 9]))
    target.binary.set('autosave-original.json', new TextEncoder().encode('{"unclean":true}'))
    await seed(target, original)
    target.failNextBinaryWrite = true

    await expect(restoreShopDataBackup(backup.text, options(target, targetLegacy)))
      .rejects.toThrow('prior shop data was restored without partial changes')
    expect(await currentPayload(target)).toBe(original)
    expect(targetLegacy.getItem('liencam-ui-prefs')).toBe('{"state":{"uiTheme":"original"}}')
    expect(target.binary.has('autosave-source.zip')).toBe(false)
    expect([...target.binary.get('autosave-original.zip') ?? []]).toEqual([7, 8, 9])
    expect(new TextDecoder().decode(target.binary.get('autosave-original.json'))).toBe('{"unclean":true}')
  })

  it('recovers the previous checksum-verified generation and immediately reloads the mounted action', async () => {
    const durable = new MemoryDurableStorage()
    const previous = payload({ machineLibrary: [{ id: 'known-good' }] })
    const current = payload({ machineLibrary: [{ id: 'current' }, { id: 'current-2' }] })
    await seed(durable, previous)
    await seed(durable, current)
    const reloadPage = vi.fn()
    render(<UserDataStoragePanel serviceOptions={options(durable)} reloadPage={reloadPage} />)
    await screen.findByTestId('user-data-row-machines')

    fireEvent.click(screen.getByRole('button', { name: 'Recover previous generation' }))
    await answerPendingConfirm(true)  // WO-1268: the themed confirm, via the store seam

    await waitFor(() => expect(screen.getByTestId('user-data-storage-status').textContent).toContain('Recovered generation'))
    expect(await currentPayload(durable)).toBe(previous)
    expect(reloadPage).toHaveBeenCalledTimes(1)
  })

  it('shows the download/import limitation when folder sync is unsupported', async () => {
    const durable = new MemoryDurableStorage()
    await seed(durable, payload())
    render(<UserDataStoragePanel serviceOptions={options(durable)} />)

    expect((await screen.findByTestId('user-data-folder-limitation')).textContent).toContain(
      'cannot sync to a chosen local folder',
    )
    expect((screen.getByRole('button', { name: 'Download backup' }) as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByText('Inspect backup...')).not.toBeNull()
  })
})
