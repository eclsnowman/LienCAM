import type { StateStorage } from 'zustand/middleware'
import type { Project } from '../types'
import type { ReferenceImage2d } from '../referenceImage/referenceImage'

const DB_NAME = 'lien-cam-reference-image-cache'
const STORE = 'original-images'
const pending = new WeakMap<object, Set<string>>()
const keyFor = (projectId: string, imageId: string) => JSON.stringify([projectId, imageId])

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function cacheReferenceImage(projectId: string, imageId: string, dataUrl: string): Promise<void> {
  const db = await openDB()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(dataUrl, keyFor(projectId, imageId))
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

export async function loadCachedReferenceImage(projectId: string, imageId: string): Promise<string | null> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const request = tx.objectStore(STORE).get(keyFor(projectId, imageId))
    request.onsuccess = () => resolve(typeof request.result === 'string' ? request.result : null)
    request.onerror = () => reject(request.error)
  })
}

/** Like model-body display persistence, cache writes never block live edits.
 * Image bytes are immutable for an id. Avoid rewriting a phone photo on every
 * pointer/console update; a rejected write remains eligible for retry.
 * Keep removed/undone entries: redo can still own their original bytes. */
export function persistReferenceImages(projectId: string, images: readonly ReferenceImage2d[]): void {
  for (const { id, payload } of images) {
    const image = payload.image
    if (!image.dataUrl) continue
    const key = keyFor(projectId, id)
    const keys = pending.get(image) ?? new Set<string>()
    if (keys.has(key)) continue
    keys.add(key)
    pending.set(image, keys)
    void cacheReferenceImage(projectId, id, image.dataUrl).catch(() => keys.delete(key))
  }
}

/** Recover bytes before Zustand merges the refresh snapshot. A cache miss
 * retains the authored metadata with empty bytes, never another image's data.
 * The 2D scene omits these entries until bytes are available. */
export function referenceImageStateStorage(storage: StateStorage): StateStorage {
  return {
    setItem: (name, value) => storage.setItem(name, value),
    removeItem: (name) => storage.removeItem(name),
    getItem: async (name) => {
      const raw = await storage.getItem(name)
      if (raw === null) return null
      const envelope = JSON.parse(raw) as { state?: { project?: Project } }
      const project = envelope.state?.project
      if (!project?.referenceImages2d?.some((entry) => !entry.payload.image.dataUrl)) return raw
      project.referenceImages2d = await Promise.all(project.referenceImages2d.map(async (entry) => {
        if (entry.payload.image.dataUrl) return entry
        const dataUrl = await loadCachedReferenceImage(project.id, entry.id).catch(() => null)
        return dataUrl ? { ...entry, payload: { ...entry.payload, image: { ...entry.payload.image, dataUrl } } } : entry
      }))
      return JSON.stringify(envelope)
    },
  }
}
