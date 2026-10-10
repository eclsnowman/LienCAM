import { operatorText } from '../i18n/locales/en/console-and-operator-messages'
import type { StateCreator, StoreMutatorIdentifier } from 'zustand/vanilla'
import {
  persist,
  type PersistOptions,
  type PersistStorage,
  type StorageValue,
} from 'zustand/middleware'

export type PersistedUserDataStorage =
  | 'durable-state'
  | 'local-storage'
  | 'legacy-drain'
  | 'project-payload-key'
  | 'runtime-scene-marker'

export type PersistedLocalRecordCount = 'state' | 'byMachine' | 'value' | 'entries'

export type PersistedUserDataBackup =
  | false
  | { kind: 'primary' }
  | { kind: 'embedded-primary' }
  | {
    kind: 'local-record'
    collectionId: string
    count: PersistedLocalRecordCount
  }

export interface PersistedUserDataKeyDefinition {
  key: string
  keyKind?: 'exact' | 'prefix'
  holds: string
  storage: PersistedUserDataStorage
  backup: PersistedUserDataBackup
  legacyKeys?: readonly string[]
}

const TOOL_PALETTE_LEGACY_KEYS = ['rail', 'cam-sketch', 'form-palette', 'relief-palette']
  .flatMap((palette) => ['compact', 'collapsed', 'dock-folded'].map((setting) => `liencam.${palette}.${setting}`))

/**
 * The complete registry of stable keys that identify user-owned persisted data
 * or a documented compatibility/runtime marker. A key rename is a data
 * migration, so consumers must select entries from this module instead of
 * spelling storage names or reaching browser persistence APIs directly.
 */
export const PERSISTED_USER_DATA_REGISTRY = {
  activeProject: {
    // WO-268 renamed the product to LienCAM but DELIBERATELY left this key on
    // its original spelling: every existing user's saved project lives under
    // it. Renaming it silently orphans their work. The name is legacy; the
    // data is not.
    key: 'cnc-cam-project',
    holds: 'The active project Zustand payload and its durable OPFS generations.',
    storage: 'durable-state',
    backup: { kind: 'primary' },
  },
  bootPreferences: {
    key: 'liencam-boot-preferences',
    holds: 'A localStorage boot mirror used before the durable project can hydrate.',
    storage: 'local-storage',
    backup: false,
  },
  pendingProjectReset: {
    key: 'liencam-user-space-reset-pending--',
    keyKind: 'prefix',
    holds: 'A fail-closed reset marker suffixed with the encoded active-project key.',
    storage: 'local-storage',
    backup: false,
  },
  unloadJournal: {
    // WO-2639: the WO-1505 journal was written under an unregistered name, so
    // the registered adapter refused every one and a change still saving at
    // close was lost. It is transient (deleted once its write commits), so it
    // is never backed up.
    key: 'liencam-user-space-unload-journal--',
    keyKind: 'prefix',
    holds: 'The newest uncommitted project write, saved synchronously at pagehide and replayed at the next boot.',
    storage: 'local-storage',
    backup: false,
  },
  uiPreferences: {
    key: 'liencam-ui-prefs',
    holds: 'Cross-project UI layout, display, and control-panel preferences.',
    storage: 'local-storage',
    backup: { kind: 'local-record', collectionId: 'ui-customization', count: 'state' },
    // WO-2297: palette layout shares this backed-up record; drain the old
    // standalone keys so reset/restore cannot resurrect a previous layout.
    legacyKeys: TOOL_PALETTE_LEGACY_KEYS,
  },
  programPreviewGrid: {
    key: 'liencam.machine.programPreviewGrid',
    holds: 'The operator-selected machine program-preview coordinate grid.',
    storage: 'local-storage',
    backup: { kind: 'local-record', collectionId: 'ui-customization', count: 'value' },
  },
  userPosts: {
    key: 'liencam.userPosts',
    holds: 'User-saved and imported post-processor profiles.',
    storage: 'local-storage',
    backup: { kind: 'local-record', collectionId: 'post-profiles', count: 'value' },
  },
  machineActions: {
    key: 'liencam-machine-actions',
    // WO-1676: the M-code overrides this cache holds now mirror
    // `MachineConfig.actionOverrides` (the machine definition writes
    // through `setOverride`/`clearOverride`); macros and park positions
    // remain this store's own data.
    holds: 'Per-machine action overrides (a definition mirror), macros, and park positions.',
    storage: 'local-storage',
    backup: { kind: 'local-record', collectionId: 'controller-macros', count: 'byMachine' },
  },
  machineToolTable: {
    key: 'liencam-tool-table',
    // WO-1676: this store stopped persisting on its own - the tool table and
    // probe overrides it cached now live on `MachineConfig.toolTable` /
    // `.probeOverrides` and travel with the project/machine export instead.
    // The key stays registered (never removed - ADR-0040 governs project
    // FORMATS, not a user's already-written localStorage) purely so
    // UserDataStoragePanel can still back up and explain data an install
    // from before this change already wrote here; nothing writes it now.
    holds: 'LEGACY (read-only): per-machine tool tables and Z-probe settings written before WO-1676.',
    storage: 'local-storage',
    backup: { kind: 'local-record', collectionId: 'machine-tool-tables', count: 'byMachine' },
  },
  probeRoutines: {
    key: 'liencam-probe-routine-library',
    holds: 'User-written and imported probe routines, quarantined ones, and hidden factory routine ids (WO-411).',
    storage: 'local-storage',
    backup: { kind: 'local-record', collectionId: 'probing', count: 'entries' },
  },
  modelAppearance: {
    key: 'model3d.appearance',
    holds: 'Per-body and per-face colors embedded in the active project parameters.',
    storage: 'project-payload-key',
    backup: { kind: 'embedded-primary' },
  },
  legacyGlowCandidate: {
    key: 'geo26.glowCandidate',
    holds: 'The retired selection-glow developer preference, read once and removed.',
    storage: 'legacy-drain',
    backup: false,
  },
  stockRemovalBody: {
    key: 'liencamStockRemovalBody',
    holds: 'A runtime THREE.Object3D userData marker for carved-stock bodies.',
    storage: 'runtime-scene-marker',
    backup: false,
  },
} as const satisfies Record<string, PersistedUserDataKeyDefinition>

type PersistedRegistryId = keyof typeof PERSISTED_USER_DATA_REGISTRY
type LocalStorageRegistryId = {
  [K in PersistedRegistryId]:
    typeof PERSISTED_USER_DATA_REGISTRY[K]['storage'] extends 'local-storage' | 'legacy-drain'
      ? K
      : never
}[PersistedRegistryId]
type ZustandRegistryId = 'activeProject' | 'uiPreferences' | 'machineActions' | 'machineToolTable' | 'probeRoutines'

export interface BackedUpLocalStorageRecord {
  key: string
  collectionId: string
  count: PersistedLocalRecordCount
}

export const BACKED_UP_LOCAL_STORAGE_RECORDS: readonly BackedUpLocalStorageRecord[] =
  Object.values(PERSISTED_USER_DATA_REGISTRY).flatMap((definition) => {
    const backup: PersistedUserDataBackup = definition.backup
    return backup !== false && backup.kind === 'local-record'
      ? [{ key: definition.key, collectionId: backup.collectionId, count: backup.count }]
      : []
  })

export function backedUpLocalRecordsFor(
  collectionId: string,
): ReadonlyArray<{ key: string; count: PersistedLocalRecordCount }> {
  return BACKED_UP_LOCAL_STORAGE_RECORDS
    .filter((record) => record.collectionId === collectionId)
    .map(({ key, count }) => ({ key, count }))
}

function browserLocalStorage(): Storage | null {
  try {
    const candidate = (globalThis as { localStorage?: Partial<Storage> }).localStorage
    return candidate
      && typeof candidate.getItem === 'function'
      && typeof candidate.setItem === 'function'
      && typeof candidate.removeItem === 'function'
      ? candidate as Storage
      : null
  } catch {
    return null
  }
}

function registeredLocalKey(registryId: LocalStorageRegistryId): string {
  return PERSISTED_USER_DATA_REGISTRY[registryId].key
}

export function readRegisteredLocalData(registryId: LocalStorageRegistryId): string | null {
  return browserLocalStorage()?.getItem(registeredLocalKey(registryId)) ?? null
}

export function writeRegisteredLocalData(
  registryId: LocalStorageRegistryId,
  value: string,
): void {
  browserLocalStorage()?.setItem(registeredLocalKey(registryId), value)
}

export function removeRegisteredLocalData(registryId: LocalStorageRegistryId): void {
  browserLocalStorage()?.removeItem(registeredLocalKey(registryId))
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function palettePreferenceRecord(storage: Storage): Record<string, unknown> {
  const raw = storage.getItem(registeredLocalKey('uiPreferences'))
  let record: Record<string, unknown>
  try { record = jsonRecord(raw === null ? undefined : JSON.parse(raw)) } catch { record = {} }
  const state = jsonRecord(record.state)
  if (state.toolPaletteLayout !== undefined) return record

  const layout: Record<string, unknown> = {}
  for (const key of PERSISTED_USER_DATA_REGISTRY.uiPreferences.legacyKeys) {
    try {
      const legacy = storage.getItem(key)
      if (legacy !== null) layout[key] = JSON.parse(legacy)
    } catch { /* an unreadable legacy choice leaves the palette's default */ }
  }
  const next = { ...record, state: { ...state, toolPaletteLayout: layout } }
  // Remove only after saving the migrated record. Failed persistence still
  // lets the viewer read their previous layout, and retries on the next read.
  try {
    storage.setItem(registeredLocalKey('uiPreferences'), JSON.stringify(next))
    for (const key of PERSISTED_USER_DATA_REGISTRY.uiPreferences.legacyKeys) storage.removeItem(key)
  } catch { /* leave the readable legacy choices available */ }
  return next
}

export function readRegisteredToolPalettePreference(key: string): unknown {
  const storage = browserLocalStorage()
  if (storage === null) return undefined
  return jsonRecord(jsonRecord(palettePreferenceRecord(storage).state).toolPaletteLayout)[key]
}

export function writeRegisteredToolPalettePreference(key: string, value: unknown): void {
  const storage = browserLocalStorage()
  if (storage === null) return
  const record = palettePreferenceRecord(storage)
  const state = jsonRecord(record.state)
  storage.setItem(registeredLocalKey('uiPreferences'), JSON.stringify({
    ...record,
    state: { ...state, toolPaletteLayout: { ...jsonRecord(state.toolPaletteLayout), [key]: value } },
  }))
}

function isRegisteredBrowserKey(key: string): boolean {
  return Object.values(PERSISTED_USER_DATA_REGISTRY).some((entry) => {
    const definition: PersistedUserDataKeyDefinition = entry
    if (definition.storage === 'project-payload-key' || definition.storage === 'runtime-scene-marker') {
      return false
    }
    return definition.keyKind === 'prefix'
      ? key.startsWith(definition.key)
      : key === definition.key
  })
}

function assertRegisteredBrowserKey(key: string): void {
  if (!isRegisteredBrowserKey(key)) {
    throw new Error(operatorText('persistedKeys1', { value1: String(key) }))
  }
}

/**
 * Browser storage adapter for the durable-state bridge. It preserves the
 * existing StateStorage contract while rejecting any unregistered key at the
 * final sink, including names changed through Zustand's runtime setOptions.
 */
export interface RegisteredBrowserStateStorage {
  getItem(name: string): string | null
  setItem(name: string, value: string): void
  removeItem(name: string): void
}

export function registeredBrowserStateStorage(): RegisteredBrowserStateStorage | null {
  const storage = browserLocalStorage()
  if (storage === null) return null
  return {
    getItem: (name) => {
      assertRegisteredBrowserKey(name)
      return storage.getItem(name)
    },
    setItem: (name, value) => {
      assertRegisteredBrowserKey(name)
      storage.setItem(name, value)
    },
    removeItem: (name) => {
      assertRegisteredBrowserKey(name)
      storage.removeItem(name)
    },
  }
}

/**
 * WO-2627: Restore bundle rewrites these stores' records under a page whose
 * stores still hold the pre-restore state, and Zustand persists a store's
 * whole snapshot on every `set`. While sealed, their writes are held back so
 * none can replace a restored record before the reload; a restore that fails
 * unseals, and the newest held write per record lands then.
 */
let storeWritesSealed = false
const heldStoreWrites = new Map<string, () => void>()

export function sealRegisteredStoreWrites(): () => void {
  storeWritesSealed = true
  return () => {
    storeWritesSealed = false
    const held = [...heldStoreWrites.values()]
    heldStoreWrites.clear()
    for (const write of held) write()
  }
}

function boundJsonStorage<T>(registryId: ZustandRegistryId): PersistStorage<T> {
  const expectedName = PERSISTED_USER_DATA_REGISTRY[registryId].key
  const assertExpectedName = (actualName: string): void => {
    if (actualName !== expectedName) {
      throw new Error(operatorText('persistedKeys2', { value1: String(registryId), value2: String(actualName) }))
    }
  }
  const persistStorage: PersistStorage<T> = {
    getItem: (name) => {
      assertExpectedName(name)
      const storage = browserLocalStorage()
      // Boot hydrates UI preferences even when Form/Relief are never opened.
      // Drain their legacy layout here so backup sees those choices as well.
      if (registryId === 'uiPreferences' && storage !== null) {
        return palettePreferenceRecord(storage) as unknown as StorageValue<T>
      }
      const raw = storage?.getItem(expectedName)
      return raw ? JSON.parse(raw) as StorageValue<T> : null
    },
    setItem: (name, value) => {
      assertExpectedName(name)
      if (storeWritesSealed) {
        heldStoreWrites.set(expectedName, () => persistStorage.setItem(name, value))
        return
      }
      const storage = browserLocalStorage()
      if (storage === null) return
      // Palette writes can happen after Zustand hydrated. Preserve the current
      // layout from storage, rather than an older in-memory preference snapshot.
      const record = registryId === 'uiPreferences'
        ? { ...value, state: {
          ...jsonRecord(value.state),
          toolPaletteLayout: jsonRecord(palettePreferenceRecord(storage).state).toolPaletteLayout,
        } }
        : value
      storage.setItem(expectedName, JSON.stringify(record))
    },
    removeItem: (name) => {
      assertExpectedName(name)
      if (storeWritesSealed) {
        heldStoreWrites.set(expectedName, () => persistStorage.removeItem(name))
        return
      }
      browserLocalStorage()?.removeItem(expectedName)
    },
  }
  return persistStorage
}

function bindPersistStorage<T>(
  registryId: ZustandRegistryId,
  storage: PersistStorage<T>,
): PersistStorage<T> {
  const expectedName = PERSISTED_USER_DATA_REGISTRY[registryId].key
  const assertExpectedName = (actualName: string): void => {
    if (actualName !== expectedName) {
      throw new Error(operatorText('persistedKeys3', { value1: String(registryId), value2: String(actualName) }))
    }
  }
  return {
    getItem: (name) => {
      assertExpectedName(name)
      return storage.getItem(expectedName)
    },
    setItem: (name, value) => {
      assertExpectedName(name)
      return storage.setItem(expectedName, value)
    },
    removeItem: (name) => {
      assertExpectedName(name)
      return storage.removeItem(expectedName)
    },
  }
}

/** WO-2639: what each persisted store holds, in the operator's words. */
const PERSISTED_STORE_LABEL: Record<ZustandRegistryId, string> = {
  activeProject: 'project, machines, tools and settings',
  uiPreferences: 'layout and display preferences',
  machineActions: 'machine macros and park positions',
  machineToolTable: 'older tool tables',
  probeRoutines: 'probe routines',
}

const persistedLoadFailures: string[] = []
const persistedLoadFailureListeners = new Set<(message: string) => void>()

function reportPersistedLoadFailure(registryId: ZustandRegistryId, error: unknown): void {
  const cause = error instanceof Error ? error.message : String(error)
  const message = `Your saved ${PERSISTED_STORE_LABEL[registryId]} could not be loaded (${cause}). `
    + 'LienCAM started with defaults for them and will not save over your stored copy this session, '
    + 'so it is still there. Reload to try again.'
  console.error(`[USER_SPACE_LOAD_FAILED] ${message}`, error)
  persistedLoadFailures.push(message)
  for (const listener of persistedLoadFailureListeners) listener(message)
}

/**
 * WO-2639: hears every persisted-store load failure in plain words, including
 * those reported before it subscribed (a store hydrates as its module loads).
 * Returns the unsubscribe.
 */
export function subscribePersistedLoadFailures(listener: (message: string) => void): () => void {
  for (const message of persistedLoadFailures) listener(message)
  persistedLoadFailureListeners.add(listener)
  return () => { persistedLoadFailureListeners.delete(listener) }
}

/**
 * WO-2639: a hydration that throws (unreadable record, migrate or merge
 * failure) leaves the store on its defaults, and Zustand persists the WHOLE
 * snapshot on the next `set` - which would replace the stored data with those
 * defaults. From that failure until a later hydration succeeds, this store's
 * writes are held back and the operator is told what failed.
 */
function closedOnLoadFailure<T, U>(
  registryId: ZustandRegistryId,
  storage: PersistStorage<U>,
  options: Omit<PersistOptions<T, U>, 'name'>,
): Pick<PersistOptions<T, U>, 'storage' | 'onRehydrateStorage'> {
  let loadFailed = false
  return {
    storage: {
      getItem: (name) => storage.getItem(name),
      setItem: (name, value) => loadFailed ? undefined : storage.setItem(name, value),
      removeItem: (name) => loadFailed ? undefined : storage.removeItem(name),
    },
    onRehydrateStorage: (state) => {
      const after = options.onRehydrateStorage?.(state)
      return (hydrated, error) => {
        loadFailed = error !== undefined
        if (loadFailed) reportPersistedLoadFailure(registryId, error)
        after?.(hydrated, error)
      }
    },
  }
}

/**
 * The sole production entry to Zustand persistence. Callers select a registry
 * id and cannot supply or later retarget an arbitrary storage name.
 */
export function persistRegistered<
  T,
  Mps extends [StoreMutatorIdentifier, unknown][] = [],
  Mcs extends [StoreMutatorIdentifier, unknown][] = [],
  U = T,
>(
  registryId: ZustandRegistryId,
  initializer: StateCreator<T, [...Mps, ['zustand/persist', unknown]], Mcs>,
  options: Omit<PersistOptions<T, U>, 'name'> = {},
): StateCreator<T, Mps, [['zustand/persist', U], ...Mcs]> {
  const storage = options.storage === undefined
    ? boundJsonStorage<U>(registryId)
    : bindPersistStorage(registryId, options.storage)
  return persist(initializer, {
    ...options,
    ...closedOnLoadFailure(registryId, storage, options),
    name: PERSISTED_USER_DATA_REGISTRY[registryId].key,
  })
}
