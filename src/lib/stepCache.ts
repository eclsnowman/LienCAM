import { operatorText } from '../i18n/locales/en/console-and-operator-messages'
// IndexedDB cache for original STEP bytes plus a separate selection-capable
// display payload, keyed by geometry ID. ADR 0018 D2 still holds: the exact
// B-rep shape lives only in the worker's wasm heap and is recovered from the raw
// STEP source when a kernel derivation needs it. The display store only avoids
// blocking first draw on parse/heal/tessellation.

import type { BrepModelPayload } from './cam/geometry/occt/model/types'

const DB_NAME = 'lien-cam-step-cache'
const RAW_STORE = 'step-buffers'
const DISPLAY_STORE = 'step-displays'
const VERSION = 2
export const STEP_DISPLAY_CONTRACT_VERSION = 1 as const
export const STEP_DISPLAY_AO_VERSION = 1 as const
export const MAX_STEP_DISPLAY_CACHE_ENTRY_BYTES = 256 * 1024 * 1024
export const MAX_STEP_DISPLAY_CACHE_TOTAL_BYTES = 512 * 1024 * 1024

export interface StepDisplayTessellation {
  linearDeflection: number
  angularDeflection: number
}

export interface CachedStepDisplay {
  displayContractVersion: typeof STEP_DISPLAY_CONTRACT_VERSION
  aoVersion?: typeof STEP_DISPLAY_AO_VERSION
  sourceSha256: string
  tessellation: StepDisplayTessellation | null
  payload: BrepModelPayload
  byteLength: number
  updatedAt: number
}

export function brepPayloadByteLength(payload: BrepModelPayload): number {
  return payload.mesh.positions.byteLength
    + payload.mesh.normals.byteLength
    + payload.mesh.indices.byteLength
    + payload.mesh.faceRanges.byteLength
    + (payload.mesh.ao?.byteLength ?? 0)
    + payload.edges.positions.byteLength
    + payload.edges.edgeRanges.byteLength
    + payload.faceTypes.byteLength
}

/** SHA-256 binds a display to exact raw STEP bytes. Without Web Crypto the
 * optional acceleration is disabled; raw persistence and restore still work. */
export async function computeStepSha256(buffer: ArrayBuffer): Promise<string | null> {
  try {
    if (!globalThis.crypto?.subtle) return null
    const hash = await globalThis.crypto.subtle.digest('SHA-256', buffer)
    return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')
  } catch {
    return null
  }
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(RAW_STORE)) db.createObjectStore(RAW_STORE)
      if (!db.objectStoreNames.contains(DISPLAY_STORE)) db.createObjectStore(DISPLAY_STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** Write raw STEP source and decide the fate of any same-id display inside the
 * same transaction. Callers may preserve only a display they can fully prove
 * belongs to the incoming source; all ordinary writes invalidate by default. */
export async function cacheStep(
  id: string,
  buffer: ArrayBuffer,
  preserveDisplay?: (cached: CachedStepDisplay) => boolean,
): Promise<void> {
  const db = await openDB()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([RAW_STORE, DISPLAY_STORE], 'readwrite')
    const rawStore = tx.objectStore(RAW_STORE)
    const displayStore = tx.objectStore(DISPLAY_STORE)
    const existing = displayStore.get(id)
    existing.onsuccess = () => {
      const cached = existing.result as CachedStepDisplay | undefined
      let keep = false
      if (cached && preserveDisplay) {
        try { keep = preserveDisplay(cached) } catch { keep = false }
      }
      rawStore.put(buffer, id)
      if (!keep) displayStore.delete(id)
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function loadCachedStep(id: string): Promise<ArrayBuffer | null> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(RAW_STORE, 'readonly')
    const req = tx.objectStore(RAW_STORE).get(id)
    req.onsuccess = () => resolve((req.result as ArrayBuffer | undefined) ?? null)
    req.onerror = () => reject(req.error)
  })
}

/** Persist a structured-cloned render payload outside Zustand/localStorage. */
export async function cacheStepDisplay(
  id: string,
  payload: BrepModelPayload,
  sourceSha256: string,
  tessellation: StepDisplayTessellation | null,
): Promise<void> {
  const byteLength = brepPayloadByteLength(payload)
  if (byteLength > MAX_STEP_DISPLAY_CACHE_ENTRY_BYTES) {
    throw new Error(
      operatorText('stepCache1', { value1: String(byteLength), value2: String(MAX_STEP_DISPLAY_CACHE_ENTRY_BYTES) }),
    )
  }
  if (!/^[a-f0-9]{64}$/.test(sourceSha256)) {
    throw new Error(operatorText('stepCache2'))
  }
  const record: CachedStepDisplay = {
    displayContractVersion: STEP_DISPLAY_CONTRACT_VERSION,
    ...(payload.mesh.ao ? { aoVersion: STEP_DISPLAY_AO_VERSION } : {}),
    sourceSha256,
    tessellation,
    payload,
    byteLength,
    updatedAt: Date.now(),
  }
  const db = await openDB()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(DISPLAY_STORE, 'readwrite')
    const store = tx.objectStore(DISPLAY_STORE)
    store.put(record, id)

    // Bound enforcement is part of the write contract, so insertion and every
    // required eviction share one transaction. If any eviction fails, IndexedDB
    // rolls the new display back instead of committing an over-budget cache.
    const keys = store.getAllKeys()
    const records = store.getAll()
    records.onsuccess = () => {
      const keyList = keys.result ?? []
      const entries = (records.result as CachedStepDisplay[]).map((cached, index) => ({
        key: keyList[index],
        byteLength: Number.isFinite(cached?.byteLength) && cached.byteLength >= 0
          ? cached.byteLength
          : 0,
        updatedAt: Number.isFinite(cached?.updatedAt) ? cached.updatedAt : 0,
      }))
      let total = entries.reduce((sum, entry) => sum + entry.byteLength, 0)
      if (total <= MAX_STEP_DISPLAY_CACHE_TOTAL_BYTES) return
      entries.sort((a, b) => a.updatedAt !== b.updatedAt
        ? a.updatedAt - b.updatedAt
        : String(a.key).localeCompare(String(b.key)))
      for (const entry of entries) {
        if (total <= MAX_STEP_DISPLAY_CACHE_TOTAL_BYTES) break
        store.delete(entry.key)
        total -= entry.byteLength
      }
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function loadCachedStepDisplay(id: string): Promise<CachedStepDisplay | null> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DISPLAY_STORE, 'readonly')
    const req = tx.objectStore(DISPLAY_STORE).get(id)
    req.onsuccess = () => resolve((req.result as CachedStepDisplay | undefined) ?? null)
    req.onerror = () => reject(req.error)
  })
}

export async function removeCachedStepDisplay(id: string): Promise<void> {
  const db = await openDB()
  await removeFromStore(db, DISPLAY_STORE, id)
}

function removeFromStore(db: IDBDatabase, storeName: string, id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    tx.objectStore(storeName).delete(id)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

/** A STEP geometry owns both cache entries; deletion always removes both. */
export async function removeCachedStep(id: string): Promise<void> {
  const db = await openDB()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([RAW_STORE, DISPLAY_STORE], 'readwrite')
    tx.objectStore(RAW_STORE).delete(id)
    tx.objectStore(DISPLAY_STORE).delete(id)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}
