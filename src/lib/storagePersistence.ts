import { operatorText } from '../i18n/locales/en/console-and-operator-messages'
// WO-1885: ask the browser to keep LienCAM's storage.
//
// The IndexedDB STL/STEP cache and the OPFS project generations are
// "best effort" storage by default: under disk pressure the browser may
// evict them, which loses the source bytes a project needs to replay
// (headlessModelBodyReplay: "Re-import the file"). navigator.storage.persist()
// asks for an exemption; navigator.storage.persisted() tells us whether we
// already have one. No dialog, no banner, no refusal: if the API is missing or
// the request is denied we say so in one console line and carry on.

export const STORAGE_PERSISTENT_LINE = operatorText('storagePersistence1')
export const STORAGE_BEST_EFFORT_LINE =
  operatorText('storagePersistence2')
export const STORAGE_UNAVAILABLE_LINE =
  operatorText('storagePersistence3')

export interface PersistentStorageManager {
  persisted?: () => Promise<boolean>
  persist?: () => Promise<boolean>
}

export type StorageLineLogger = (message: string) => void

type PersistentStorageManagerWithPersist = PersistentStorageManager & {
  persist: () => Promise<boolean>
}

function storageManager(nav: Navigator): PersistentStorageManagerWithPersist | null {
  const storage = (nav as Navigator & { storage?: PersistentStorageManager }).storage
  if (storage === undefined || storage === null) return null
  if (typeof storage.persist !== 'function') return null
  return storage as PersistentStorageManagerWithPersist
}

/**
 * Ask the browser to make LienCAM's storage persistent and return the one line
 * that describes the answer. Never throws: a missing API or a denied request is
 * reported, not raised.
 */
export async function requestStoragePersistence(
  nav: Navigator = navigator,
  log: StorageLineLogger = (message) => console.info(message),
): Promise<string> {
  const storage = storageManager(nav)
  if (storage === null) {
    log(STORAGE_UNAVAILABLE_LINE)
    return STORAGE_UNAVAILABLE_LINE
  }

  try {
    const alreadyPersisted =
      typeof storage.persisted === 'function' ? await storage.persisted() : false
    if (alreadyPersisted) {
      log(STORAGE_PERSISTENT_LINE)
      return STORAGE_PERSISTENT_LINE
    }

    const granted = await storage.persist()
    const line = granted ? STORAGE_PERSISTENT_LINE : STORAGE_BEST_EFFORT_LINE
    log(line)
    return line
  } catch (error) {
    console.warn(operatorText('storagePersistence4'), error)
    log(STORAGE_BEST_EFFORT_LINE)
    return STORAGE_BEST_EFFORT_LINE
  }
}
