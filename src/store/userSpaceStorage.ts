import { operatorText } from '../i18n/locales/en/console-and-operator-messages'
import type { StateStorage } from 'zustand/middleware'
import {
  BACKED_UP_LOCAL_STORAGE_RECORDS,
  PERSISTED_USER_DATA_REGISTRY,
  backedUpLocalRecordsFor,
  registeredBrowserStateStorage,
  sealRegisteredStoreWrites,
  type PersistedLocalRecordCount,
} from './persistedKeys'

const GENERATION_SCHEMA = 'liencam-user-space-generation'
const POINTER_SCHEMA = 'liencam-user-space-pointer'
const STORAGE_SCHEMA_VERSION = 1

export const USER_SPACE_BOOT_PREFERENCES_KEY =
  PERSISTED_USER_DATA_REGISTRY.bootPreferences.key

export const USER_SPACE_STORAGE_WARNING = {
  limitedDurability: 'USER_SPACE_STORAGE_LIMITED',
  recoveryFallback: 'USER_SPACE_RECOVERY_FALLBACK',
  writeFailed: 'USER_SPACE_WRITE_FAILED',
  migrationFailed: 'USER_SPACE_MIGRATION_FAILED',
  migrationDiverged: 'USER_SPACE_MIGRATION_DIVERGED',
  resetDeferred: 'USER_SPACE_RESET_DEFERRED',
} as const

export type UserSpaceStorageWarningCode =
  typeof USER_SPACE_STORAGE_WARNING[keyof typeof USER_SPACE_STORAGE_WARNING]

export interface UserSpaceStorageWarning {
  code: UserSpaceStorageWarningCode
  message: string
  cause?: unknown
}

export interface UserSpaceStorage {
  readText(path: string): Promise<string | null>
  writeText(path: string, value: string): Promise<void>
  remove(path: string): Promise<void>
  /** Optional binary/listing capabilities used by the user-data backup surface. */
  listPaths?(): Promise<string[]>
  readBytes?(path: string): Promise<Uint8Array | null>
  writeBytes?(path: string, value: Uint8Array): Promise<void>
}

export interface LegacyStorage {
  getItem(name: string): string | null
  setItem(name: string, value: string): void
  removeItem(name: string): void
}

interface GenerationEnvelope {
  schema: typeof GENERATION_SCHEMA
  schemaVersion: typeof STORAGE_SCHEMA_VERSION
  storageKey: string
  generation: string
  createdAt: string
  checksum: string
  payload: string
}

interface GenerationPointer {
  schema: typeof POINTER_SCHEMA
  schemaVersion: typeof STORAGE_SCHEMA_VERSION
  storageKey: string
  current: string
  previous: string | null
}

interface UserSpaceStoragePaths {
  pointer: string
  pointerBackup: string
  generation: (generation: string) => string
}

type GenerationReadResult =
  | { kind: 'found'; payload: string }
  | { kind: 'missing' }
  | { kind: 'unreadable'; cause: unknown }

type DurableReadResult =
  | { kind: 'found'; payload: string }
  | { kind: 'empty' }
  | { kind: 'unreadable'; cause?: unknown }

interface HydrationSafetyStateStorage extends StateStorage<Promise<void> | void> {
  canFinishInitialHydration?: () => boolean
  journalPendingWrites?: () => number
  flushPendingWrites?: () => Promise<void>
  /** WO-1707: a requested write has not (yet) committed - still in flight, or failed. */
  hasUncommittedWrites?: () => boolean
}

export interface CreateUserSpaceStateStorageOptions {
  /** Inject a durable implementation. `null` deliberately selects fallback. */
  durableStorage?: UserSpaceStorage | null
  legacyStorage?: LegacyStorage | null
  onWarning?: (warning: UserSpaceStorageWarning) => void
}

export interface UserSpaceStateStorage extends StateStorage<Promise<void> | void> {
  /** Opens persistence writes after Zustand's initial hydration callback. */
  finishInitialHydration(): void
  /**
   * WO-2639: hydration threw, so the store holds defaults rather than the
   * stored data. Writes stay closed for the session (and report uncommitted)
   * so nothing replaces what storage still holds.
   */
  failInitialHydration(): void
  /**
   * Synchronously records every write still in flight so a page that unloads
   * before it commits reloads with that latest state. Returns how many
   * storage keys are journaled.
   */
  journalPendingWrites(): number
  /**
   * WO-1456: resolves once every write requested so far has committed (or
   * failed, which writeGeneration already reports). Project Save awaits it so
   * a completed Save never has an unflushed state write sitting behind it.
   */
  flushPendingWrites(): Promise<void>
  /**
   * WO-1707: has every write requested so far actually been KEPT by durable
   * storage? `false` while the initial-hydration barrier is still dropping
   * writes (or never opened, because the durable read was unreadable) and
   * after a write that failed. A synchronous store answers at once; an async
   * one waits for its writes to settle first. A caller that must not lose
   * data (the one-time custom-button move) deletes its source copy only on
   * `true`.
   */
  writesCommitted(): boolean | Promise<boolean>
}

let generationOrdinal = 0

function pathsFor(storageKey: string): UserSpaceStoragePaths {
  const safeKey = encodeURIComponent(storageKey)
  return {
    pointer: `liencam-user-space--${safeKey}--pointer.json`,
    pointerBackup: `liencam-user-space--${safeKey}--pointer-backup.json`,
    generation: (generation) =>
      `liencam-user-space--${safeKey}--generation--${encodeURIComponent(generation)}.json`,
  }
}

function makeGenerationId(): string {
  generationOrdinal += 1
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)
  return `${Date.now().toString(36)}-${generationOrdinal.toString(36)}-${random}`
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parsePointer(raw: string | null, storageKey: string): GenerationPointer | null {
  if (raw === null) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (
      !isRecord(value) ||
      value.schema !== POINTER_SCHEMA ||
      value.schemaVersion !== STORAGE_SCHEMA_VERSION ||
      value.storageKey !== storageKey ||
      typeof value.current !== 'string' ||
      !(typeof value.previous === 'string' || value.previous === null)
    ) return null
    return value as unknown as GenerationPointer
  } catch {
    return null
  }
}

async function readGeneration(
  storage: UserSpaceStorage,
  storageKey: string,
  generation: string,
): Promise<GenerationReadResult> {
  let raw: string | null
  try {
    raw = await storage.readText(pathsFor(storageKey).generation(generation))
  } catch (cause) {
    return { kind: 'unreadable', cause }
  }
  if (raw === null) return { kind: 'missing' }
  try {
    const value: unknown = JSON.parse(raw)
    if (
      !isRecord(value) ||
      value.schema !== GENERATION_SCHEMA ||
      value.schemaVersion !== STORAGE_SCHEMA_VERSION ||
      value.storageKey !== storageKey ||
      value.generation !== generation ||
      typeof value.createdAt !== 'string' ||
      typeof value.checksum !== 'string' ||
      typeof value.payload !== 'string'
    ) return { kind: 'unreadable', cause: new Error(operatorText('userSpaceStorage1')) }
    if (await sha256(value.payload) !== value.checksum) {
      return { kind: 'unreadable', cause: new Error(operatorText('userSpaceStorage2')) }
    }
    JSON.parse(value.payload)
    return { kind: 'found', payload: value.payload }
  } catch (cause) {
    return { kind: 'unreadable', cause }
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function semanticallyEqualJson(left: string, right: string): boolean {
  try {
    return canonicalJson(JSON.parse(left)) === canonicalJson(JSON.parse(right))
  } catch {
    return false
  }
}

function defaultWarningReporter(warning: UserSpaceStorageWarning): void {
  console.warn(`[${warning.code}] ${warning.message}`, warning.cause ?? '')
}

/**
 * A generation store for Zustand's serialized state. Writes are serialized so
 * two rapid store mutations cannot advance the pointer out of order.
 */
export class DurableUserSpaceStateStorage implements StateStorage<Promise<void>> {
  private writeChain: Promise<void> = Promise.resolve()
  private hydrationWritesSafe = true
  private writeSequence = 0
  /** The newest requested payload per key that has not yet committed. */
  private readonly uncommitted = new Map<string, { sequence: number; payload: string }>()
  /** The write sequence whose payload currently sits in each key's unload journal. */
  private readonly journaledSequence = new Map<string, number>
  private readonly storage: UserSpaceStorage
  private readonly legacyStorage: LegacyStorage | null
  private readonly onWarning: (warning: UserSpaceStorageWarning) => void

  constructor(
    storage: UserSpaceStorage,
    legacyStorage: LegacyStorage | null = null,
    onWarning: (warning: UserSpaceStorageWarning) => void = defaultWarningReporter,
  ) {
    this.storage = storage
    this.legacyStorage = legacyStorage
    this.onWarning = onWarning
  }

  async getItem(name: string): Promise<string | null> {
    if (hasPendingReset(this.legacyStorage, name)) {
      try {
        await this.removeItem(name)
      } catch (cause) {
        this.warn(
          USER_SPACE_STORAGE_WARNING.resetDeferred,
          operatorText('userSpaceStorage3', { value1: String(name) }),
          cause,
        )
      }
      return null
    }

    // A journal survives only when the previous page unloaded before its last
    // write committed, so it is newer than anything durable storage holds.
    const journal = readUnloadJournal(this.legacyStorage, name)
    if (journal !== null) {
      this.journaledSequence.set(name, this.writeSequence + 1)
      try {
        await this.setItem(name, journal)
      } catch {
        // writeGeneration already reported the failure. The journal stays
        // until a later write commits, so this payload is not lost.
        syncBootPreferences(this.legacyStorage, journal)
      }
      return journal
    }

    const durable = await this.readDurable(name)
    const legacy = this.readLegacy(name)

    if (durable.kind === 'found') {
      syncBootPreferences(this.legacyStorage, durable.payload)
      if (legacy !== null) {
        if (semanticallyEqualJson(durable.payload, legacy)) this.removeLegacy(name)
        else this.warn(
          USER_SPACE_STORAGE_WARNING.migrationDiverged,
          operatorText('userSpaceStorage4', { value1: String(name) }),
        )
      }
      return durable.payload
    }
    if (durable.kind === 'unreadable') {
      this.hydrationWritesSafe = false
      if (legacy !== null) return legacy
      const error = new Error(operatorText('userSpaceStorage5', { value1: String(name) }))
      ;(error as Error & { cause?: unknown }).cause = durable.cause
      throw error
    }
    if (legacy === null) return null

    try {
      await this.setItem(name, legacy)
      const reread = await this.readDurable(name)
      if (reread.kind === 'found' && semanticallyEqualJson(reread.payload, legacy)) {
        syncBootPreferences(this.legacyStorage, reread.payload)
        this.removeLegacy(name)
        return reread.payload
      }
      if (reread.kind === 'unreadable') this.hydrationWritesSafe = false
      this.warn(
        USER_SPACE_STORAGE_WARNING.migrationDiverged,
        operatorText('userSpaceStorage6', { value1: String(name) }),
      )
    } catch (cause) {
      this.warn(
        USER_SPACE_STORAGE_WARNING.migrationFailed,
        operatorText('userSpaceStorage7', { value1: String(name) }),
        cause,
      )
    }
    return legacy
  }

  canFinishInitialHydration(): boolean {
    return this.hydrationWritesSafe
  }

  /** A failed write keeps its `uncommitted` entry (markCommitted runs only on
   *  success), so this stays true until a later write for that key commits. */
  hasUncommittedWrites(): boolean {
    return this.uncommitted.size > 0
  }

  setItem(name: string, value: string): Promise<void> {
    const sequence = ++this.writeSequence
    this.uncommitted.set(name, { sequence, payload: value })
    const write = this.writeChain.then(async () => {
      await this.writeGeneration(name, value)
      syncBootPreferences(this.legacyStorage, value)
      this.markCommitted(name, sequence)
    })
    this.writeChain = write.catch(() => {})
    return write
  }

  /** Resolves when every write queued so far (including any queued while
   *  waiting) has settled. Never rejects: a failed write already warned. */
  async flushPendingWrites(): Promise<void> {
    let chain: Promise<void>
    do {
      chain = this.writeChain
      await chain
    } while (chain !== this.writeChain)
  }

  /**
   * A pagehide listener cannot hold the page open for the async OPFS chain, so
   * the newest uncommitted payload goes to synchronous local storage instead.
   * The next boot replays it; a commit that catches up first deletes it.
   */
  journalPendingWrites(): number {
    let journaled = 0
    for (const [name, pending] of this.uncommitted) {
      if (this.legacyStorage === null) break
      if (this.journaledSequence.get(name) === pending.sequence) {
        journaled += 1
        continue
      }
      try {
        writeUnloadJournal(this.legacyStorage, name, pending.payload)
        this.journaledSequence.set(name, pending.sequence)
        journaled += 1
      } catch (cause) {
        this.warn(
          USER_SPACE_STORAGE_WARNING.writeFailed,
          operatorText('userSpaceStorage8', { value1: String(name) }),
          cause,
        )
      }
    }
    return journaled
  }

  removeItem(name: string): Promise<void> {
    this.writeSequence += 1
    this.uncommitted.delete(name)
    this.journaledSequence.delete(name)
    removeUnloadJournal(this.legacyStorage, name)
    const remove = this.writeChain.then(async () => {
      const paths = pathsFor(name)
      const pointer = parsePointer(await this.storage.readText(paths.pointer), name)
      const backup = parsePointer(await this.storage.readText(paths.pointerBackup), name)
      const generations = [
        pointer?.current,
        pointer?.previous,
        backup?.current,
        backup?.previous,
      ].filter((candidate, index, all): candidate is string =>
        typeof candidate === 'string' && all.indexOf(candidate) === index)
      await Promise.all([
        ...generations.map((generation) => this.storage.remove(paths.generation(generation))),
        this.storage.remove(paths.pointer),
        this.storage.remove(paths.pointerBackup),
      ])
      this.removeLegacy(name)
      clearBootPreferences(this.legacyStorage)
      clearPendingReset(this.legacyStorage, name)
    })
    this.writeChain = remove.catch(() => {})
    return remove
  }

  private async readDurable(name: string): Promise<DurableReadResult> {
    const paths = pathsFor(name)
    let pointerReadCause: unknown
    let backupReadCause: unknown
    let generationReadCause: unknown
    let pointerRaw: string | null = null
    let backupRaw: string | null = null
    try { pointerRaw = await this.storage.readText(paths.pointer) } catch (cause) {
      pointerReadCause = cause
    }
    const pointer = parsePointer(pointerRaw, name)
    try { backupRaw = await this.storage.readText(paths.pointerBackup) } catch (cause) {
      backupReadCause = cause
    }
    const backup = parsePointer(backupRaw, name)
    const candidates = [
      pointer?.current,
      pointer?.previous,
      backup?.current,
      backup?.previous,
    ].filter((candidate, index, all): candidate is string =>
      typeof candidate === 'string' && all.indexOf(candidate) === index)

    for (let index = 0; index < candidates.length; index += 1) {
      const generation = await readGeneration(this.storage, name, candidates[index])
      if (generation.kind === 'found') {
        if (index > 0 || pointerReadCause !== undefined || (pointerRaw !== null && pointer === null)) {
          this.warn(
            USER_SPACE_STORAGE_WARNING.recoveryFallback,
            operatorText('userSpaceStorage9', { value1: String(name) }),
            pointerReadCause ?? generationReadCause,
          )
        }
        return { kind: 'found', payload: generation.payload }
      }
      if (generation.kind === 'unreadable' && generationReadCause === undefined) {
        generationReadCause = generation.cause
      }
    }

    if (
      pointerRaw !== null || backupRaw !== null || candidates.length > 0 ||
      pointerReadCause !== undefined || backupReadCause !== undefined ||
      generationReadCause !== undefined
    ) {
      const cause = pointerReadCause ?? backupReadCause ?? generationReadCause
      this.warn(
        USER_SPACE_STORAGE_WARNING.recoveryFallback,
        operatorText('userSpaceStorage10', { value1: String(name) }),
        cause,
      )
      return { kind: 'unreadable', cause }
    }
    return { kind: 'empty' }
  }

  private async writeGeneration(name: string, payload: string): Promise<void> {
    const paths = pathsFor(name)
    const generation = makeGenerationId()
    const envelope: GenerationEnvelope = {
      schema: GENERATION_SCHEMA,
      schemaVersion: STORAGE_SCHEMA_VERSION,
      storageKey: name,
      generation,
      createdAt: new Date().toISOString(),
      checksum: await sha256(payload),
      payload,
    }

    try {
      await this.storage.writeText(paths.generation(generation), JSON.stringify(envelope))
      const verified = await readGeneration(this.storage, name, generation)
      if (verified.kind !== 'found' || !semanticallyEqualJson(verified.payload, payload)) {
        throw new Error(operatorText('userSpaceStorage11'))
      }

      const currentRaw = await this.storage.readText(paths.pointer)
      const current = parsePointer(currentRaw, name)
      if (current !== null) {
        const backupRaw = JSON.stringify(current)
        await this.storage.writeText(paths.pointerBackup, backupRaw)
        if (parsePointer(await this.storage.readText(paths.pointerBackup), name) === null) {
          throw new Error(operatorText('userSpaceStorage12'))
        }
      }

      const next: GenerationPointer = {
        schema: POINTER_SCHEMA,
        schemaVersion: STORAGE_SCHEMA_VERSION,
        storageKey: name,
        current: generation,
        previous: current?.current ?? null,
      }
      await this.storage.writeText(paths.pointer, JSON.stringify(next))
      const committed = parsePointer(await this.storage.readText(paths.pointer), name)
      if (committed?.current !== generation) throw new Error(operatorText('userSpaceStorage13'))

      // The new pointer now protects `generation` and `current.current`.
      // Anything older is no longer a recovery candidate and would otherwise
      // turn ordinary Zustand updates into unbounded OPFS growth.
      if (current?.previous && current.previous !== current.current) {
        try { await this.storage.remove(paths.generation(current.previous)) } catch {
          // Cleanup is opportunistic. The verified pointer commit remains valid.
        }
      }
    } catch (cause) {
      this.warn(
        USER_SPACE_STORAGE_WARNING.writeFailed,
        operatorText('userSpaceStorage14', { value1: String(name) }),
        cause,
      )
      throw cause
    }
  }

  private markCommitted(name: string, sequence: number): void {
    const pending = this.uncommitted.get(name)
    if (pending !== undefined && pending.sequence <= sequence) this.uncommitted.delete(name)
    const journaled = this.journaledSequence.get(name)
    if (journaled !== undefined && journaled <= sequence) {
      this.journaledSequence.delete(name)
      removeUnloadJournal(this.legacyStorage, name)
    }
  }

  private readLegacy(name: string): string | null {
    try {
      return this.legacyStorage?.getItem(name) ?? null
    } catch {
      return null
    }
  }

  private removeLegacy(name: string): void {
    try { this.legacyStorage?.removeItem(name) } catch { /* retain on failure */ }
  }

  private warn(code: UserSpaceStorageWarningCode, message: string, cause?: unknown): void {
    this.onWarning({ code, message, cause })
  }
}

export class OpfsUserSpaceStorage implements UserSpaceStorage {
  private readonly root: FileSystemDirectoryHandle

  constructor(root: FileSystemDirectoryHandle) {
    this.root = root
  }

  async readText(path: string): Promise<string | null> {
    let handle: FileSystemFileHandle
    try {
      handle = await this.root.getFileHandle(path)
    } catch (error) {
      if (isNotFoundError(error)) return null
      throw error
    }
    return await (await handle.getFile()).text()
  }

  async writeText(path: string, value: string): Promise<void> {
    const handle = await this.root.getFileHandle(path, { create: true })
    const writable = await handle.createWritable()
    try {
      await writable.write(value)
      await writable.close()
    } catch (error) {
      try { await writable.abort(error) } catch { /* preserve original failure */ }
      throw error
    }
  }

  async remove(path: string): Promise<void> {
    try {
      await this.root.removeEntry(path)
    } catch (error) {
      if (!isNotFoundError(error)) throw error
    }
  }

  async listPaths(): Promise<string[]> {
    const paths: string[] = []
    const visit = async (directory: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
      const iterable = directory as FileSystemDirectoryHandle & {
        entries(): AsyncIterableIterator<[string, FileSystemHandle]>
      }
      for await (const [name, handle] of iterable.entries()) {
        const path = prefix === '' ? name : `${prefix}/${name}`
        if (handle.kind === 'file') paths.push(path)
        else await visit(handle as FileSystemDirectoryHandle, path)
      }
    }
    await visit(this.root, '')
    return paths.sort()
  }

  async readBytes(path: string): Promise<Uint8Array | null> {
    let handle: FileSystemFileHandle
    try {
      handle = await this.root.getFileHandle(path)
    } catch (error) {
      if (isNotFoundError(error)) return null
      throw error
    }
    return new Uint8Array(await (await handle.getFile()).arrayBuffer())
  }

  async writeBytes(path: string, value: Uint8Array): Promise<void> {
    const handle = await this.root.getFileHandle(path, { create: true })
    const writable = await handle.createWritable()
    try {
      const copy = new Uint8Array(value.byteLength)
      copy.set(value)
      await writable.write(copy.buffer)
      await writable.close()
    } catch (error) {
      try { await writable.abort(error) } catch { /* preserve original failure */ }
      throw error
    }
  }
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotFoundError'
}

function globalLegacyStorage(): LegacyStorage | null {
  return registeredBrowserStateStorage()
}

function opfsDirectory(): Promise<FileSystemDirectoryHandle> | null {
  const storage = (globalThis.navigator as Navigator | undefined)?.storage as
    | (StorageManager & { getDirectory?: () => Promise<FileSystemDirectoryHandle> })
    | undefined
  return typeof storage?.getDirectory === 'function' ? storage.getDirectory() : null
}

/**
 * Last-resort reset is fail-closed against stale durable data. The marker is
 * written before OPFS is touched, so a broken filesystem cannot turn reload
 * into another hydration of the payload the user explicitly asked to clear.
 */
export async function resetUserSpaceStateStorage(
  storageKey: string,
  options: CreateUserSpaceStateStorageOptions = {},
): Promise<boolean> {
  const onWarning = options.onWarning ?? defaultWarningReporter
  const legacyStorage = options.legacyStorage === undefined
    ? globalLegacyStorage()
    : options.legacyStorage

  setPendingReset(legacyStorage, storageKey)
  removeUnloadJournal(legacyStorage, storageKey)
  try { legacyStorage?.removeItem(storageKey) } catch { /* reset marker remains */ }
  clearBootPreferences(legacyStorage)

  let durableStorage = options.durableStorage
  if (durableStorage === undefined) {
    const directory = opfsDirectory()
    if (directory === null) {
      clearPendingReset(legacyStorage, storageKey)
      return true
    }
    try {
      durableStorage = new OpfsUserSpaceStorage(await directory)
    } catch (cause) {
      onWarning({
        code: USER_SPACE_STORAGE_WARNING.resetDeferred,
        message: operatorText('userSpaceStorage15', { value1: String(storageKey) }),
        cause,
      })
      return false
    }
  }

  if (durableStorage === null) {
    clearPendingReset(legacyStorage, storageKey)
    return true
  }

  try {
    await new DurableUserSpaceStateStorage(durableStorage, legacyStorage, onWarning)
      .removeItem(storageKey)
    return true
  } catch (cause) {
    onWarning({
      code: USER_SPACE_STORAGE_WARNING.resetDeferred,
      message: operatorText('userSpaceStorage16', { value1: String(storageKey) }),
      cause,
    })
    return false
  }
}

function limitedLocalStorage(
  legacyStorage: LegacyStorage | null,
  onWarning: (warning: UserSpaceStorageWarning) => void,
): StateStorage<void> {
  let warned = false
  const warnOnce = () => {
    if (warned) return
    warned = true
    onWarning({
      code: USER_SPACE_STORAGE_WARNING.limitedDurability,
      message: operatorText('userSpaceStorage17'),
    })
  }
  return {
    getItem: (name) => { warnOnce(); return legacyStorage?.getItem(name) ?? null },
    setItem: (name, value) => {
      warnOnce()
      legacyStorage?.setItem(name, value)
      syncBootPreferences(legacyStorage, value)
    },
    removeItem: (name) => {
      warnOnce()
      legacyStorage?.removeItem(name)
      clearBootPreferences(legacyStorage)
    },
  }
}

function resetPendingKey(storageKey: string): string {
  return `${PERSISTED_USER_DATA_REGISTRY.pendingProjectReset.key}${encodeURIComponent(storageKey)}`
}

function hasPendingReset(storage: LegacyStorage | null, storageKey: string): boolean {
  try { return storage?.getItem(resetPendingKey(storageKey)) === '1' } catch { return false }
}

function setPendingReset(storage: LegacyStorage | null, storageKey: string): void {
  try { storage?.setItem(resetPendingKey(storageKey), '1') } catch { /* best effort */ }
}

function clearPendingReset(storage: LegacyStorage | null, storageKey: string): void {
  try { storage?.removeItem(resetPendingKey(storageKey)) } catch { /* retry next boot */ }
}

const UNLOAD_JOURNAL_SCHEMA = 'liencam-user-space-unload-journal'

function unloadJournalKey(storageKey: string): string {
  return `${PERSISTED_USER_DATA_REGISTRY.unloadJournal.key}${encodeURIComponent(storageKey)}`
}

/** Throws when local storage refuses the payload (quota); the caller reports it. */
function writeUnloadJournal(storage: LegacyStorage, storageKey: string, payload: string): void {
  storage.setItem(unloadJournalKey(storageKey), JSON.stringify({
    schema: UNLOAD_JOURNAL_SCHEMA,
    schemaVersion: STORAGE_SCHEMA_VERSION,
    storageKey,
    payload,
  }))
}

function readUnloadJournal(storage: LegacyStorage | null, storageKey: string): string | null {
  let raw: string | null
  try { raw = storage?.getItem(unloadJournalKey(storageKey)) ?? null } catch { return null }
  if (raw === null) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (
      isRecord(value) &&
      value.schema === UNLOAD_JOURNAL_SCHEMA &&
      value.schemaVersion === STORAGE_SCHEMA_VERSION &&
      value.storageKey === storageKey &&
      typeof value.payload === 'string'
    ) {
      JSON.parse(value.payload)
      return value.payload
    }
  } catch { /* unreadable journal is discarded below */ }
  removeUnloadJournal(storage, storageKey)
  return null
}

function removeUnloadJournal(storage: LegacyStorage | null, storageKey: string): void {
  try { storage?.removeItem(unloadJournalKey(storageKey)) } catch { /* retry on next commit */ }
}

/**
 * Journals the persisted store's in-flight writes on every `pagehide` (not
 * once: a back-forward-cached page can hide again). Returns the disposer.
 */
export function installUserSpaceUnloadJournal(
  storage: Pick<UserSpaceStateStorage, 'journalPendingWrites'>,
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>,
): () => void {
  const journal = () => { storage.journalPendingWrites() }
  target.addEventListener('pagehide', journal)
  return () => target.removeEventListener('pagehide', journal)
}

function syncBootPreferences(storage: LegacyStorage | null, payload: string): void {
  try {
    const parsed: unknown = JSON.parse(payload)
    const showSplash = isRecord(parsed) && isRecord(parsed.state) &&
      isRecord(parsed.state.appSettings) && parsed.state.appSettings.showSplash === false
      ? false
      : true
    storage?.setItem(USER_SPACE_BOOT_PREFERENCES_KEY, JSON.stringify({ showSplash }))
  } catch {
    try { storage?.removeItem(USER_SPACE_BOOT_PREFERENCES_KEY) } catch { /* fall open */ }
  }
}

function clearBootPreferences(storage: LegacyStorage | null): void {
  try { storage?.removeItem(USER_SPACE_BOOT_PREFERENCES_KEY) } catch { /* fall open */ }
}

/**
 * Async hydration must win the startup race against Zustand mutations. A
 * pre-hydration write contains defaults captured before durable state merges,
 * so it must be discarded rather than replayed after the read completes.
 */
class InitialHydrationWriteBarrier implements UserSpaceStateStorage {
  private hydrationFinished = false
  private hydrationFailed = false
  private readonly storage: HydrationSafetyStateStorage

  constructor(storage: HydrationSafetyStateStorage) {
    this.storage = storage
  }

  getItem(name: string): string | null | Promise<string | null> {
    return this.storage.getItem(name)
  }

  setItem(name: string, value: string): Promise<void> | void {
    if (!this.hydrationFinished) return Promise.resolve()
    return this.storage.setItem(name, value)
  }

  removeItem(name: string): Promise<void> | void {
    if (!this.hydrationFinished) return Promise.resolve()
    return this.storage.removeItem(name)
  }

  finishInitialHydration(): void {
    if (this.hydrationFailed) return
    if (this.storage.canFinishInitialHydration?.() ?? true) {
      this.hydrationFinished = true
    }
  }

  failInitialHydration(): void {
    this.hydrationFailed = true
    this.hydrationFinished = false
  }

  journalPendingWrites(): number {
    return this.storage.journalPendingWrites?.() ?? 0
  }

  async flushPendingWrites(): Promise<void> {
    await this.storage.flushPendingWrites?.()
  }

  writesCommitted(): boolean | Promise<boolean> {
    // Closed barrier: every write so far was dropped, and one that never
    // opens (unreadable durable read) drops them for the whole session.
    if (!this.hydrationFinished) return false
    return (async () => {
      await this.storage.flushPendingWrites?.()
      return !(this.storage.hasUncommittedWrites?.() ?? false)
    })()
  }
}

function hydrationReadyStorage(storage: StateStorage<void>): UserSpaceStateStorage {
  // localStorage writes are synchronous: a write either landed or threw.
  let lastWriteFailed = false
  let hydrationFailed = false
  return {
    getItem: (name) => storage.getItem(name),
    setItem: (name, value) => {
      if (hydrationFailed) return
      try {
        storage.setItem(name, value)
        lastWriteFailed = false
      } catch (cause) {
        lastWriteFailed = true
        throw cause
      }
    },
    removeItem: (name) => {
      if (hydrationFailed) return
      storage.removeItem(name)
    },
    finishInitialHydration: () => {},
    failInitialHydration: () => { hydrationFailed = true },
    // localStorage writes are synchronous; nothing is ever in flight.
    journalPendingWrites: () => 0,
    flushPendingWrites: () => Promise.resolve(),
    writesCommitted: () => !hydrationFailed && !lastWriteFailed,
  }
}

class LazyOpfsStateStorage implements StateStorage<Promise<void>> {
  private resolved: Promise<HydrationSafetyStateStorage> | null = null
  private active: HydrationSafetyStateStorage | null = null
  private readonly directory: Promise<FileSystemDirectoryHandle>
  private readonly legacyStorage: LegacyStorage | null
  private readonly onWarning: (warning: UserSpaceStorageWarning) => void

  constructor(
    directory: Promise<FileSystemDirectoryHandle>,
    legacyStorage: LegacyStorage | null,
    onWarning: (warning: UserSpaceStorageWarning) => void,
  ) {
    this.directory = directory
    this.legacyStorage = legacyStorage
    this.onWarning = onWarning
  }

  async getItem(name: string): Promise<string | null> {
    return (await this.resolve()).getItem(name)
  }

  async setItem(name: string, value: string): Promise<void> {
    await this.track((async () => { await (await this.resolve()).setItem(name, value) })())
  }

  async removeItem(name: string): Promise<void> {
    await this.track((async () => { await (await this.resolve()).removeItem(name) })())
  }

  canFinishInitialHydration(): boolean {
    return this.active?.canFinishInitialHydration?.() ?? true
  }

  hasUncommittedWrites(): boolean {
    return this.inFlight.size > 0 || (this.active?.hasUncommittedWrites?.() ?? false)
  }

  journalPendingWrites(): number {
    return this.active?.journalPendingWrites?.() ?? 0
  }

  /** A write requested before OPFS resolved is not yet in the durable chain,
   *  so wait for those requests first, then for the chain itself. */
  async flushPendingWrites(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight])
    await this.active?.flushPendingWrites?.()
  }

  private readonly inFlight = new Set<Promise<void>>()

  private track(request: Promise<void>): Promise<void> {
    this.inFlight.add(request)
    const done = () => { this.inFlight.delete(request) }
    request.then(done, done)
    return request
  }

  private remember(storage: HydrationSafetyStateStorage): HydrationSafetyStateStorage {
    this.active = storage
    return storage
  }

  private resolve(): Promise<HydrationSafetyStateStorage> {
    this.resolved ??= this.directory
      .then((root) => this.remember(new DurableUserSpaceStateStorage(
        new OpfsUserSpaceStorage(root),
        this.legacyStorage,
        this.onWarning,
      )))
      .catch((cause) => {
        this.onWarning({
          code: USER_SPACE_STORAGE_WARNING.limitedDurability,
          message: operatorText('userSpaceStorage18'),
          cause,
        })
        return this.remember(limitedLocalStorage(this.legacyStorage, () => {}))
      })
    return this.resolved
  }
}

/**
 * WO-2627: the page's own persisted store is still alive after Restore bundle
 * (or Recover previous generation) has written the replacement, and Zustand
 * persists its WHOLE pre-restore snapshot on every `set` - a console line, a
 * modal closing, anything. One such write after the restore replaced the
 * restored generation with the clean profile's defaults; one still in flight
 * at `pagehide` was journaled and won over it at the next boot. So a restore
 * seals the live storage first: in-flight writes settle BEFORE the
 * replacement is written, and from then until the reload nothing it is asked
 * to write - durably or into the unload journal - reaches storage.
 */
class ReplaceableStateStorage implements UserSpaceStateStorage {
  private sealed = false
  /** The newest write refused while sealed, replayed if the restore fails. */
  private refused: { name: string; value: string | null } | null = null
  private readonly storage: UserSpaceStateStorage

  constructor(storage: UserSpaceStateStorage) {
    this.storage = storage
  }

  getItem(name: string): string | null | Promise<string | null> {
    return this.storage.getItem(name)
  }

  setItem(name: string, value: string): Promise<void> | void {
    if (this.sealed) {
      this.refused = { name, value }
      return Promise.resolve()
    }
    return this.storage.setItem(name, value)
  }

  removeItem(name: string): Promise<void> | void {
    if (this.sealed) {
      this.refused = { name, value: null }
      return Promise.resolve()
    }
    return this.storage.removeItem(name)
  }

  finishInitialHydration(): void {
    this.storage.finishInitialHydration()
  }

  failInitialHydration(): void {
    this.storage.failInitialHydration()
  }

  journalPendingWrites(): number {
    return this.sealed ? 0 : this.storage.journalPendingWrites()
  }

  flushPendingWrites(): Promise<void> {
    return this.storage.flushPendingWrites()
  }

  writesCommitted(): boolean | Promise<boolean> {
    return this.sealed ? false : this.storage.writesCommitted()
  }

  async seal(): Promise<void> {
    this.sealed = true
    await this.storage.flushPendingWrites()
  }

  async unseal(): Promise<void> {
    this.sealed = false
    const refused = this.refused
    this.refused = null
    if (refused === null) return
    if (refused.value === null) await this.storage.removeItem(refused.name)
    else await this.storage.setItem(refused.name, refused.value)
  }
}

/** The page's live persisted-store storages (the production auto-detect path). */
const liveStateStorages = new Set<ReplaceableStateStorage>()

/**
 * Seal every live persisted-store storage of this page - the durable project
 * store and the localStorage-record stores - before a restore writes the
 * replacement. Returns the undo for a restore that fails; a successful one
 * stays sealed until the reload loads what it wrote.
 */
async function sealLiveStateStorages(): Promise<() => Promise<void>> {
  const unsealStores = sealRegisteredStoreWrites()
  const sealed = [...liveStateStorages]
  await Promise.all(sealed.map((storage) => storage.seal()))
  return async () => {
    unsealStores()
    await Promise.all(sealed.map((storage) => storage.unseal()))
  }
}

export function createUserSpaceStateStorage(
  options: CreateUserSpaceStateStorageOptions = {},
): UserSpaceStateStorage {
  const onWarning = options.onWarning ?? defaultWarningReporter
  const legacyStorage = options.legacyStorage === undefined
    ? globalLegacyStorage()
    : options.legacyStorage

  if (options.durableStorage !== undefined) {
    return options.durableStorage === null
      ? hydrationReadyStorage(limitedLocalStorage(legacyStorage, onWarning))
      : new InitialHydrationWriteBarrier(
        new DurableUserSpaceStateStorage(options.durableStorage, legacyStorage, onWarning),
      )
  }

  const directory = opfsDirectory()
  const live = new ReplaceableStateStorage(directory === null
    ? hydrationReadyStorage(limitedLocalStorage(legacyStorage, onWarning))
    : new InitialHydrationWriteBarrier(
      new LazyOpfsStateStorage(directory, legacyStorage, onWarning),
    ))
  liveStateStorages.add(live)
  return live
}

// ---- Settings > User Data inventory, backup, restore, and recovery ----

export const DEFAULT_USER_SPACE_STORAGE_KEY = PERSISTED_USER_DATA_REGISTRY.activeProject.key
export const SHOP_DATA_BACKUP_FILENAME = 'LienCAM-shop-data-backup.json'

const SHOP_DATA_BUNDLE_SCHEMA = 'liencam-shop-data-bundle'
const SHOP_DATA_BUNDLE_VERSION = 2
const RECOVERY_FILE_PATTERN = /^autosave-[^/\\]+\.(?:json|zip)$/

export type ShopDataHealth =
  | 'healthy'
  | 'recovered'
  | 'limited'
  | 'empty'
  | 'reserved'
  | 'unavailable'

export interface ShopDataCollectionInventory {
  id: string
  label: string
  itemCount: number
  lastSuccessfulWrite: string | null
  currentGeneration: string | null
  backupGeneration: string | null
  health: ShopDataHealth
  estimatedBytes: number
  note?: string
}

export interface ShopDataInventory {
  collections: ShopDataCollectionInventory[]
  storageMode: 'opfs' | 'localStorage'
  health: ShopDataHealth
}

export interface ShopDataServiceOptions {
  /** `undefined` opens OPFS; `null` deliberately selects localStorage only. */
  durableStorage?: UserSpaceStorage | null
  legacyStorage?: LegacyStorage | null
  storageKey?: string
  now?: () => Date
}

interface ShopDataBundleContent {
  primaryPayload: string | null
  localRecords: Record<string, string>
  recoveryFiles: Array<{ path: string; bytesBase64: string }>
  manifest: ShopDataCollectionManifestEntry[]
}

interface ShopDataCollectionManifestEntry {
  id: string
  label: string
  itemCount: number
}

interface ShopDataBundleUnsigned {
  schema: typeof SHOP_DATA_BUNDLE_SCHEMA
  schemaVersion: typeof SHOP_DATA_BUNDLE_VERSION
  createdAt: string
  storageKey: string
  content: ShopDataBundleContent
}

interface ShopDataBundle extends ShopDataBundleUnsigned {
  checksum: string
}

export interface ShopDataBackup {
  text: string
  checksum: string
  createdAt: string
  recoveryFileCount: number
}

export interface ShopDataRestoreDiff {
  id: string
  label: string
  currentCount: number
  incomingCount: number
}

export interface ShopDataRestorePreview {
  createdAt: string
  checksum: string
  storageKey: string
  collectionCount: number
  recoveryFileCount: number
  differences: ShopDataRestoreDiff[]
}

export interface ShopDataRestoreResult {
  checksum: string
  restoredAt: string
  recoveryFileCount: number
}

interface ResolvedShopDataAccess {
  durableStorage: UserSpaceStorage | null
  legacyStorage: LegacyStorage | null
  storageKey: string
  now: () => Date
}

interface InspectedPrimary {
  payload: string | null
  lastSuccessfulWrite: string | null
  currentGeneration: string | null
  backupGeneration: string | null
  health: ShopDataHealth
}

interface PersistedCollectionDefinition {
  id: string
  label: string
  primaryKeys?: readonly string[]
  primaryCount?: 'items' | 'presence'
  localRecords?: ReadonlyArray<{
    key: string
    count: PersistedLocalRecordCount
  }>
  recovery?: true
  reserved?: boolean
  note?: string
}

/**
 * This catalog is the disclosure boundary for every record in a shop-data
 * bundle. Export, inventory, manifest validation, and restore preview all walk
 * it, so adding a persisted root key without naming its user-facing collection
 * fails closed instead of silently widening what restore can replace.
 */
const PERSISTED_COLLECTIONS: readonly PersistedCollectionDefinition[] = [
  {
    id: 'active-project',
    label: operatorText('userSpaceStorage19'),
    primaryKeys: ['project'],
    primaryCount: 'presence',
    note: operatorText('userSpaceStorage20'),
  },
  { id: 'preferences', label: operatorText('userSpaceStorage21'), primaryKeys: ['appSettings'] },
  {
    id: 'machines',
    label: operatorText('userSpaceStorage22'),
    primaryKeys: ['machineLibrary', 'control', 'machineWorkOffsets', 'machineDatumRevokedAxes'],
    note: operatorText('userSpaceStorage23'),
  },
  {
    id: 'tool-libraries',
    label: operatorText('userSpaceStorage24'),
    primaryKeys: ['toolLibraries', 'toolLibrary'],
  },
  { id: 'holders', label: operatorText('userSpaceStorage25'), primaryKeys: ['holders'] },
  { id: 'imported-fonts', label: operatorText('userSpaceStorage26'), primaryKeys: ['importedFonts'] },
  {
    id: 'recipe-templates',
    label: operatorText('userSpaceStorage27'),
    primaryKeys: ['operationTemplates', 'setupTemplates', 'recipeTemplates'],
  },
  {
    id: 'ui-customization',
    label: operatorText('userSpaceStorage28'),
    localRecords: backedUpLocalRecordsFor('ui-customization'),
    note: operatorText('userSpaceStorage29'),
  },
  {
    id: 'post-profiles',
    label: operatorText('userSpaceStorage30'),
    primaryKeys: ['postProfiles'],
    localRecords: backedUpLocalRecordsFor('post-profiles'),
    note: operatorText('userSpaceStorage31'),
  },
  {
    id: 'cutting-data',
    label: operatorText('userSpaceStorage32'),
    primaryKeys: ['materialPresets', 'cuttingDataPresets'],
    reserved: true,
  },
  {
    id: 'fixtures',
    label: operatorText('userSpaceStorage33'),
    primaryKeys: ['fixtures', 'spoilboards', 'vises'],
    reserved: true,
  },
  {
    id: 'probing',
    label: operatorText('userSpaceStorage34'),
    primaryKeys: ['probingRoutines'],
    localRecords: backedUpLocalRecordsFor('probing'),
    reserved: true,
    note: operatorText('userSpaceStorage35'),
  },
  {
    id: 'controller-macros',
    label: operatorText('userSpaceStorage36'),
    primaryKeys: ['controllerProfiles', 'controllerMacros', 'macros'],
    localRecords: backedUpLocalRecordsFor('controller-macros'),
    note: operatorText('userSpaceStorage37'),
  },
  {
    id: 'machine-tool-tables',
    label: operatorText('userSpaceStorage38'),
    localRecords: backedUpLocalRecordsFor('machine-tool-tables'),
    note: operatorText('userSpaceStorage39'),
  },
  {
    id: 'active-project-recovery',
    label: operatorText('userSpaceStorage40'),
    recovery: true,
  },
]

const SHOP_DATA_LOCAL_KEYS = BACKED_UP_LOCAL_STORAGE_RECORDS.map((record) => record.key)
const DISCLOSED_PRIMARY_KEYS = new Set(PERSISTED_COLLECTIONS.flatMap((definition) =>
  definition.primaryKeys ?? [],
))

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function countValue(value: unknown): number {
  if (Array.isArray(value)) return value.length
  if (isRecord(value)) return Object.keys(value).length
  return value === null || value === undefined ? 0 : 1
}

function stateFromPayload(payload: string | null): Record<string, unknown> {
  if (payload === null) return {}
  try {
    const parsed: unknown = JSON.parse(payload)
    if (!isRecord(parsed)) return {}
    return isRecord(parsed.state) ? parsed.state : parsed
  } catch {
    return {}
  }
}

function persistedByMachineCount(payload: string | null): number {
  const state = stateFromPayload(payload)
  return countValue(state.byMachine)
}

function persistedValueCount(payload: string | null): number {
  if (payload === null) return 0
  try {
    return countValue(JSON.parse(payload))
  } catch {
    return 1
  }
}

function assertPrimaryCollectionsDisclosed(payload: string | null): void {
  const undisclosed = Object.keys(stateFromPayload(payload))
    .filter((key) => !DISCLOSED_PRIMARY_KEYS.has(key))
  if (undisclosed.length > 0) {
    throw new Error(
      operatorText('userSpaceStorage41', { value1: String(undisclosed.sort().join(', ')) }),
    )
  }
}

function collectionRows(
  payload: string | null,
  primary: InspectedPrimary,
  localRecords: Readonly<Record<string, string | null>>,
  recovery: ReadonlyArray<{ path: string; bytes: Uint8Array }> | null,
): ShopDataCollectionInventory[] {
  assertPrimaryCollectionsDisclosed(payload)
  const state = stateFromPayload(payload)
  return PERSISTED_COLLECTIONS.map((definition) => {
    const values = (definition.primaryKeys ?? []).map((key) => state[key])
    const primaryCount = values.reduce<number>((total, value) => (
      total + (definition.primaryCount === 'presence'
        ? value === null || value === undefined ? 0 : 1
        : countValue(value))
    ), 0)
    const primaryBytes = values.reduce<number>((total, value) => {
      if (value === undefined) return total
      try { return total + byteLength(JSON.stringify(value)) } catch { return total }
    }, 0)
    const local = (definition.localRecords ?? []).map((record) => ({
      ...record,
      payload: localRecords[record.key] ?? null,
    }))
    const localCount = local.reduce((total, record) => total + (
      record.count === 'byMachine'
        ? persistedByMachineCount(record.payload)
        : record.count === 'state'
          ? countValue(stateFromPayload(record.payload))
          : record.count === 'entries'
            ? Object.values(stateFromPayload(record.payload)).reduce<number>((n, v) => n + countValue(v), 0)
            : persistedValueCount(record.payload)
    ), 0)
    const localBytes = local.reduce(
      (total, record) => total + (record.payload === null ? 0 : byteLength(record.payload)),
      0,
    )
    const recoveryCount = definition.recovery
      ? recovery?.filter((file) => file.path.endsWith('.zip')).length ?? 0
      : 0
    const recoveryBytes = definition.recovery
      ? recovery?.reduce((total, file) => total + file.bytes.byteLength, 0) ?? 0
      : 0
    const itemCount = primaryCount + localCount + recoveryCount
    const hasLocalData = local.some((record) => record.payload !== null)
    const reserved = definition.reserved === true && itemCount === 0
    const localOnly = values.length === 0 && local.length > 0
    const health: ShopDataHealth = definition.recovery
      ? recovery === null ? 'unavailable' : recovery.length === 0 ? 'empty' : 'healthy'
      : reserved ? 'reserved'
      : hasLocalData ? 'limited'
      : localOnly ? 'empty'
      : primary.health
    return {
      id: definition.id,
      label: definition.label,
      itemCount,
      lastSuccessfulWrite: reserved || definition.recovery || hasLocalData || localOnly
        ? null
        : primary.lastSuccessfulWrite,
      currentGeneration: definition.recovery
        ? recovery !== null && recovery.length > 0 ? operatorText('userSpaceStorage42') : null
        : hasLocalData ? 'localStorage'
        : localOnly ? null
        : primary.currentGeneration,
      backupGeneration: definition.recovery || hasLocalData || localOnly
        ? null
        : primary.backupGeneration,
      health,
      estimatedBytes: primaryBytes + localBytes + recoveryBytes,
      ...(reserved
        ? { note: operatorText('userSpaceStorage43') }
        : definition.note ? { note: definition.note } : {}),
    }
  })
}

function manifestFromRows(
  rows: ReadonlyArray<ShopDataCollectionInventory>,
): ShopDataCollectionManifestEntry[] {
  return rows.map(({ id, label, itemCount }) => ({ id, label, itemCount }))
}

async function resolveShopDataAccess(
  options: ShopDataServiceOptions = {},
): Promise<ResolvedShopDataAccess> {
  const legacyStorage = options.legacyStorage === undefined
    ? globalLegacyStorage()
    : options.legacyStorage
  let durableStorage = options.durableStorage
  if (durableStorage === undefined) {
    const directory = opfsDirectory()
    if (directory === null) durableStorage = null
    else {
      try { durableStorage = new OpfsUserSpaceStorage(await directory) } catch { durableStorage = null }
    }
  }
  return {
    durableStorage,
    legacyStorage,
    storageKey: options.storageKey ?? DEFAULT_USER_SPACE_STORAGE_KEY,
    now: options.now ?? (() => new Date()),
  }
}

async function validatedEnvelope(
  storage: UserSpaceStorage,
  storageKey: string,
  generation: string,
): Promise<GenerationEnvelope | null> {
  const raw = await storage.readText(pathsFor(storageKey).generation(generation))
  if (raw === null) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (
      !isRecord(value) ||
      value.schema !== GENERATION_SCHEMA ||
      value.schemaVersion !== STORAGE_SCHEMA_VERSION ||
      value.storageKey !== storageKey ||
      value.generation !== generation ||
      typeof value.createdAt !== 'string' ||
      typeof value.checksum !== 'string' ||
      typeof value.payload !== 'string' ||
      await sha256(value.payload) !== value.checksum
    ) return null
    JSON.parse(value.payload)
    return value as unknown as GenerationEnvelope
  } catch {
    return null
  }
}

async function inspectPrimary(access: ResolvedShopDataAccess): Promise<InspectedPrimary> {
  if (access.durableStorage === null) {
    const payload = access.legacyStorage?.getItem(access.storageKey) ?? null
    return {
      payload,
      lastSuccessfulWrite: null,
      currentGeneration: payload === null ? null : 'localStorage',
      backupGeneration: null,
      health: payload === null ? 'empty' : 'limited',
    }
  }

  const paths = pathsFor(access.storageKey)
  let pointer: GenerationPointer | null = null
  try { pointer = parsePointer(await access.durableStorage.readText(paths.pointer), access.storageKey) } catch {
    return {
      payload: null,
      lastSuccessfulWrite: null,
      currentGeneration: null,
      backupGeneration: null,
      health: 'unavailable',
    }
  }
  if (pointer === null) {
    const legacy = access.legacyStorage?.getItem(access.storageKey) ?? null
    return {
      payload: legacy,
      lastSuccessfulWrite: null,
      currentGeneration: legacy === null ? null : 'localStorage',
      backupGeneration: null,
      health: legacy === null ? 'empty' : 'limited',
    }
  }

  const current = await validatedEnvelope(access.durableStorage, access.storageKey, pointer.current)
  if (current !== null) {
    return {
      payload: current.payload,
      lastSuccessfulWrite: current.createdAt,
      currentGeneration: pointer.current,
      backupGeneration: pointer.previous,
      health: 'healthy',
    }
  }
  const previous = pointer.previous === null
    ? null
    : await validatedEnvelope(access.durableStorage, access.storageKey, pointer.previous)
  return {
    payload: previous?.payload ?? null,
    lastSuccessfulWrite: previous?.createdAt ?? null,
    currentGeneration: pointer.current,
    backupGeneration: pointer.previous,
    health: previous === null ? 'unavailable' : 'recovered',
  }
}

function readLegacyRecord(storage: LegacyStorage | null, key: string): string | null {
  try { return storage?.getItem(key) ?? null } catch { return null }
}

async function recoveryFiles(storage: UserSpaceStorage | null): Promise<Array<{
  path: string
  bytes: Uint8Array
}>> {
  if (!storage?.listPaths || !storage.readBytes) return []
  const paths = (await storage.listPaths()).filter((path) => RECOVERY_FILE_PATTERN.test(path))
  const files: Array<{ path: string; bytes: Uint8Array }> = []
  for (const path of paths) {
    const bytes = await storage.readBytes(path)
    if (bytes !== null) files.push({ path, bytes })
  }
  return files
}

export async function inspectShopData(
  options: ShopDataServiceOptions = {},
): Promise<ShopDataInventory> {
  const access = await resolveShopDataAccess(options)
  const primary = await inspectPrimary(access)
  const localRecords = Object.fromEntries(SHOP_DATA_LOCAL_KEYS.map((key) => [
    key,
    readLegacyRecord(access.legacyStorage, key),
  ]))
  let recovery: Array<{ path: string; bytes: Uint8Array }> | null = null
  if (access.durableStorage !== null) {
    try { recovery = await recoveryFiles(access.durableStorage) } catch { /* row reports unavailable */ }
  }
  const rows = collectionRows(primary.payload, primary, localRecords, recovery)

  return {
    collections: rows,
    storageMode: access.durableStorage === null ? 'localStorage' : 'opfs',
    health: primary.health,
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

async function signBundle(unsigned: ShopDataBundleUnsigned): Promise<ShopDataBundle> {
  return { ...unsigned, checksum: await sha256(canonicalJson(unsigned)) }
}

async function parseShopDataBundle(text: string): Promise<ShopDataBundle> {
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error(operatorText('userSpaceStorage44')) }
  if (
    !isRecord(value) ||
    value.schema !== SHOP_DATA_BUNDLE_SCHEMA ||
    value.schemaVersion !== SHOP_DATA_BUNDLE_VERSION ||
    typeof value.createdAt !== 'string' ||
    typeof value.storageKey !== 'string' ||
    !isRecord(value.content) ||
    !(typeof value.content.primaryPayload === 'string' || value.content.primaryPayload === null) ||
    !isRecord(value.content.localRecords) ||
    !Array.isArray(value.content.recoveryFiles) ||
    !Array.isArray(value.content.manifest) ||
    typeof value.checksum !== 'string'
  ) throw new Error(operatorText('userSpaceStorage45'))

  const localRecords: Record<string, string> = {}
  for (const [key, record] of Object.entries(value.content.localRecords)) {
    if (!(SHOP_DATA_LOCAL_KEYS as readonly string[]).includes(key)) {
      throw new Error(operatorText('userSpaceStorage46', { value1: String(key) }))
    }
    if (typeof record !== 'string') throw new Error(operatorText('userSpaceStorage47', { value1: String(key) }))
    localRecords[key] = record
  }
  const decodedFiles: Array<{ path: string; bytes: Uint8Array }> = []
  const files = value.content.recoveryFiles.map((record, index) => {
    if (!isRecord(record) || typeof record.path !== 'string' || typeof record.bytesBase64 !== 'string') {
      throw new Error(operatorText('userSpaceStorage48', { value1: String(index + 1) }))
    }
    if (!RECOVERY_FILE_PATTERN.test(record.path)) {
      throw new Error(operatorText('userSpaceStorage49', { value1: String(record.path) }))
    }
    let bytes: Uint8Array
    try { bytes = base64ToBytes(record.bytesBase64) } catch {
      throw new Error(operatorText('userSpaceStorage50', { value1: String(record.path) }))
    }
    decodedFiles.push({ path: record.path, bytes })
    return { path: record.path, bytesBase64: record.bytesBase64 }
  })
  if (typeof value.content.primaryPayload === 'string') {
    try { JSON.parse(value.content.primaryPayload) } catch {
      throw new Error(operatorText('userSpaceStorage51'))
    }
  }

  const incomingPrimary: InspectedPrimary = {
    payload: value.content.primaryPayload,
    lastSuccessfulWrite: value.createdAt,
    currentGeneration: 'bundle',
    backupGeneration: null,
    health: value.content.primaryPayload === null ? 'empty' : 'healthy',
  }
  const incomingLocalRecords = Object.fromEntries(SHOP_DATA_LOCAL_KEYS.map((key) => [
    key,
    localRecords[key] ?? null,
  ]))
  const expectedManifest = manifestFromRows(collectionRows(
    value.content.primaryPayload,
    incomingPrimary,
    incomingLocalRecords,
    decodedFiles,
  ))
  const manifest = value.content.manifest.map((entry, index) => {
    if (
      !isRecord(entry) ||
      typeof entry.id !== 'string' ||
      typeof entry.label !== 'string' ||
      typeof entry.itemCount !== 'number' ||
      !Number.isSafeInteger(entry.itemCount) ||
      entry.itemCount < 0
    ) throw new Error(operatorText('userSpaceStorage52', { value1: String(index + 1) }))
    return { id: entry.id, label: entry.label, itemCount: entry.itemCount }
  })
  if (canonicalJson(manifest) !== canonicalJson(expectedManifest)) {
    throw new Error(operatorText('userSpaceStorage53'))
  }

  const unsigned: ShopDataBundleUnsigned = {
    schema: SHOP_DATA_BUNDLE_SCHEMA,
    schemaVersion: SHOP_DATA_BUNDLE_VERSION,
    createdAt: value.createdAt,
    storageKey: value.storageKey,
    content: {
      primaryPayload: value.content.primaryPayload,
      localRecords,
      recoveryFiles: files,
      manifest,
    },
  }
  const expected = await sha256(canonicalJson(unsigned))
  if (expected !== value.checksum) throw new Error(operatorText('userSpaceStorage54'))
  return { ...unsigned, checksum: value.checksum }
}

export async function createShopDataBackup(
  options: ShopDataServiceOptions = {},
): Promise<ShopDataBackup> {
  const access = await resolveShopDataAccess(options)
  const primary = await inspectPrimary(access)
  const localRecords: Record<string, string> = {}
  const localSnapshot: Record<string, string | null> = {}
  for (const key of SHOP_DATA_LOCAL_KEYS) {
    const record = readLegacyRecord(access.legacyStorage, key)
    localSnapshot[key] = record
    if (record !== null) localRecords[key] = record
  }
  const recovery = await recoveryFiles(access.durableStorage)
  const manifest = manifestFromRows(collectionRows(
    primary.payload,
    primary,
    localSnapshot,
    recovery,
  ))
  const bundle = await signBundle({
    schema: SHOP_DATA_BUNDLE_SCHEMA,
    schemaVersion: SHOP_DATA_BUNDLE_VERSION,
    createdAt: access.now().toISOString(),
    storageKey: access.storageKey,
    content: {
      primaryPayload: primary.payload,
      localRecords,
      recoveryFiles: recovery.map((file) => ({
        path: file.path,
        bytesBase64: bytesToBase64(file.bytes),
      })),
      manifest,
    },
  })
  return {
    text: JSON.stringify(bundle, null, 2),
    checksum: bundle.checksum,
    createdAt: bundle.createdAt,
    recoveryFileCount: bundle.content.recoveryFiles.length,
  }
}

export async function previewShopDataRestore(
  text: string,
  options: ShopDataServiceOptions = {},
): Promise<ShopDataRestorePreview> {
  const bundle = await parseShopDataBundle(text)
  const current = await inspectShopData(options)
  const currentById = new Map(current.collections.map((row) => [row.id, row]))
  const differences = bundle.content.manifest.map((row) => ({
    id: row.id,
    label: row.label,
    currentCount: currentById.get(row.id)?.itemCount ?? 0,
    incomingCount: row.itemCount,
  }))
  return {
    createdAt: bundle.createdAt,
    checksum: bundle.checksum,
    storageKey: bundle.storageKey,
    collectionCount: bundle.content.manifest.length,
    recoveryFileCount: bundle.content.recoveryFiles.length,
    differences,
  }
}

function writeLegacyRecord(storage: LegacyStorage, key: string, value: string | null): void {
  if (value === null) storage.removeItem(key)
  else storage.setItem(key, value)
}

function sameBytes(left: Uint8Array | null, right: Uint8Array): boolean {
  if (left === null || left.byteLength !== right.byteLength) return false
  return left.every((byte, index) => byte === right[index])
}

export async function restoreShopDataBackup(
  text: string,
  options: ShopDataServiceOptions = {},
): Promise<ShopDataRestoreResult> {
  const bundle = await parseShopDataBundle(text)
  const expectedStorageKey = options.storageKey ?? DEFAULT_USER_SPACE_STORAGE_KEY
  if (bundle.storageKey !== expectedStorageKey) {
    throw new Error(operatorText('userSpaceStorage55', { value1: String(bundle.storageKey), value2: String(expectedStorageKey) }))
  }
  const access = await resolveShopDataAccess({ ...options, storageKey: bundle.storageKey })
  const incomingFiles = bundle.content.recoveryFiles.map((file) => ({
    path: file.path,
    bytes: base64ToBytes(file.bytesBase64),
  }))

  if (bundle.content.primaryPayload !== null && access.durableStorage === null && access.legacyStorage === null) {
    throw new Error(operatorText('userSpaceStorage56'))
  }
  if (Object.keys(bundle.content.localRecords).length > 0 && access.legacyStorage === null) {
    throw new Error(operatorText('userSpaceStorage57'))
  }
  if (
    (incomingFiles.length > 0 && access.durableStorage === null) ||
    (access.durableStorage !== null && (
      !access.durableStorage.listPaths ||
      !access.durableStorage.readBytes ||
      !access.durableStorage.writeBytes
    ))
  ) {
    throw new Error(operatorText('userSpaceStorage58'))
  }

  // WO-2627: nothing this page still holds may land after the restore.
  const unseal = await sealLiveStateStorages()
  try {
    return await writeVerifiedRestore(bundle, access, incomingFiles)
  } catch (cause) {
    await unseal()
    throw cause
  }
}

async function writeVerifiedRestore(
  bundle: ShopDataBundle,
  access: ResolvedShopDataAccess,
  incomingFiles: Array<{ path: string; bytes: Uint8Array }>,
): Promise<ShopDataRestoreResult> {
  const beforePrimary = await inspectPrimary(access)
  const localKeys = [...new Set([...SHOP_DATA_LOCAL_KEYS, ...Object.keys(bundle.content.localRecords)])]
  const beforeLocal = new Map(localKeys.map((key) => [key, readLegacyRecord(access.legacyStorage, key)]))
  const currentFiles = await recoveryFiles(access.durableStorage)
  const incomingPaths = new Set(incomingFiles.map((file) => file.path))
  const stalePaths = currentFiles
    .map((file) => file.path)
    .filter((path) => !incomingPaths.has(path))
  const beforeFiles = new Map<string, Uint8Array | null>(
    currentFiles.map((file) => [file.path, file.bytes]),
  )
  for (const file of incomingFiles) {
    if (!beforeFiles.has(file.path)) {
      beforeFiles.set(file.path, await access.durableStorage!.readBytes!(file.path))
    }
  }
  const durable = access.durableStorage === null
    ? null
    : new DurableUserSpaceStateStorage(access.durableStorage, access.legacyStorage, () => {})

  const rollback = async (): Promise<void> => {
    if (durable !== null) {
      if (beforePrimary.payload === null) await durable.removeItem(access.storageKey)
      else await durable.setItem(access.storageKey, beforePrimary.payload)
    } else if (access.legacyStorage !== null) {
      writeLegacyRecord(access.legacyStorage, access.storageKey, beforePrimary.payload)
    }
    if (access.legacyStorage !== null) {
      for (const [key, value] of beforeLocal) writeLegacyRecord(access.legacyStorage, key, value)
    }
    if (access.durableStorage?.writeBytes) {
      for (const [path, bytes] of beforeFiles) {
        if (bytes === null) await access.durableStorage.remove(path)
        else await access.durableStorage.writeBytes(path, bytes)
      }
    }
  }

  try {
    // An unload journal is read BEFORE durable storage at boot (getItem), so
    // one this profile left behind would replace the restored payload.
    removeUnloadJournal(access.legacyStorage, access.storageKey)
    if (durable !== null) {
      if (bundle.content.primaryPayload === null) await durable.removeItem(access.storageKey)
      else await durable.setItem(access.storageKey, bundle.content.primaryPayload)
    } else if (access.legacyStorage !== null) {
      writeLegacyRecord(access.legacyStorage, access.storageKey, bundle.content.primaryPayload)
    }
    if (access.legacyStorage !== null) {
      for (const key of SHOP_DATA_LOCAL_KEYS) {
        writeLegacyRecord(access.legacyStorage, key, bundle.content.localRecords[key] ?? null)
      }
    }
    for (const path of stalePaths) await access.durableStorage!.remove(path)
    for (const file of incomingFiles) await access.durableStorage!.writeBytes!(file.path, file.bytes)

    const afterPrimary = await inspectPrimary(access)
    if (!semanticallyEqualJson(afterPrimary.payload ?? 'null', bundle.content.primaryPayload ?? 'null')) {
      throw new Error(operatorText('userSpaceStorage59'))
    }
    for (const [key, value] of Object.entries(bundle.content.localRecords)) {
      if (readLegacyRecord(access.legacyStorage, key) !== value) {
        throw new Error(operatorText('userSpaceStorage60', { value1: String(key) }))
      }
    }
    const restoredFiles = await recoveryFiles(access.durableStorage)
    if (restoredFiles.length !== incomingFiles.length) {
      throw new Error(operatorText('userSpaceStorage61'))
    }
    const restoredByPath = new Map(restoredFiles.map((file) => [file.path, file.bytes]))
    for (const file of incomingFiles) {
      if (!sameBytes(restoredByPath.get(file.path) ?? null, file.bytes)) {
        throw new Error(operatorText('userSpaceStorage62', { value1: String(file.path) }))
      }
    }
  } catch (cause) {
    try { await rollback() } catch (rollbackCause) {
      const error = new Error(operatorText('userSpaceStorage63'))
      ;(error as Error & { cause?: unknown }).cause = { restore: cause, rollback: rollbackCause }
      throw error
    }
    const error = new Error(operatorText('userSpaceStorage64'))
    ;(error as Error & { cause?: unknown }).cause = cause
    throw error
  }

  return {
    checksum: bundle.checksum,
    restoredAt: access.now().toISOString(),
    recoveryFileCount: incomingFiles.length,
  }
}

export async function recoverPreviousUserSpaceGeneration(
  options: ShopDataServiceOptions = {},
): Promise<{ recoveredGeneration: string; newGeneration: string | null }> {
  const access = await resolveShopDataAccess(options)
  if (access.durableStorage === null) throw new Error(operatorText('userSpaceStorage65'))
  const pointer = parsePointer(
    await access.durableStorage.readText(pathsFor(access.storageKey).pointer),
    access.storageKey,
  )
  if (pointer?.previous === null || pointer?.previous === undefined) {
    throw new Error(operatorText('userSpaceStorage66'))
  }
  const previous = await validatedEnvelope(access.durableStorage, access.storageKey, pointer.previous)
  if (previous === null) throw new Error(operatorText('userSpaceStorage67'))
  const recoveredGeneration = pointer.previous
  // WO-2627: the same stale-live-store window as bundle restore.
  const unseal = await sealLiveStateStorages()
  try {
    removeUnloadJournal(access.legacyStorage, access.storageKey)
    const durable = new DurableUserSpaceStateStorage(access.durableStorage, access.legacyStorage, () => {})
    await durable.setItem(access.storageKey, previous.payload)
    const updated = await inspectPrimary(access)
    if (!semanticallyEqualJson(updated.payload ?? 'null', previous.payload)) {
      throw new Error(operatorText('userSpaceStorage68'))
    }
    return { recoveredGeneration, newGeneration: updated.currentGeneration }
  } catch (cause) {
    await unseal()
    throw cause
  }
}

type PermissionAwareDirectoryHandle = FileSystemDirectoryHandle & {
  queryPermission?: (descriptor: { mode: 'readwrite' }) => Promise<PermissionState>
  requestPermission?: (descriptor: { mode: 'readwrite' }) => Promise<PermissionState>
}

export async function syncShopDataBackupToFolder(
  directory: FileSystemDirectoryHandle,
  backup: ShopDataBackup,
  filename = SHOP_DATA_BACKUP_FILENAME,
): Promise<{ filename: string; bytes: number }> {
  const permissionHandle = directory as PermissionAwareDirectoryHandle
  let permission = await permissionHandle.queryPermission?.({ mode: 'readwrite' }) ?? 'prompt'
  if (permission !== 'granted') {
    permission = await permissionHandle.requestPermission?.({ mode: 'readwrite' }) ?? 'denied'
  }
  if (permission !== 'granted') {
    throw new Error(operatorText('userSpaceStorage69'))
  }
  const handle = await directory.getFileHandle(filename, { create: true })
  const writable = await handle.createWritable()
  try {
    await writable.write(backup.text)
    await writable.close()
  } catch (error) {
    try { await writable.abort(error) } catch { /* preserve original failure */ }
    throw error
  }
  const verifiedText = await (await handle.getFile()).text()
  const verified = await parseShopDataBundle(verifiedText)
  if (verified.checksum !== backup.checksum) throw new Error(operatorText('userSpaceStorage70'))
  return { filename, bytes: byteLength(verifiedText) }
}
