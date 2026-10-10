import type { Loop2D, Layer2D } from '../types'

const DB_NAME = 'lien-cam-stl-cache'
const STORE   = 'geometry2d'
const VERSION = 2   // bump from v1 (stl-buffers only)

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION)
    req.onupgradeneeded = (e) => {
      const db = req.result
      if (!db.objectStoreNames.contains('stl-buffers')) db.createObjectStore('stl-buffers')
      if (!db.objectStoreNames.contains(STORE))         db.createObjectStore(STORE)
      void e
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror   = () => reject(req.error)
  })
}

interface Cached2D { loops: Loop2D[]; layers: Layer2D[] }

export async function cache2DGeometry(id: string, loops: Loop2D[], layers: Layer2D[]): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(JSON.stringify({ loops, layers } satisfies Cached2D), id)
    tx.oncomplete = () => resolve()
    tx.onerror    = () => reject(tx.error)
  })
}

export async function load2DGeometry(id: string): Promise<Cached2D | null> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(id)
    req.onsuccess = () => {
      if (!req.result) { resolve(null); return }
      try { resolve(JSON.parse(req.result as string) as Cached2D) }
      catch { resolve(null) }
    }
    req.onerror = () => reject(req.error)
  })
}

export async function remove2DGeometry(id: string): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(id)
    tx.oncomplete = () => resolve()
    tx.onerror    = () => reject(tx.error)
  })
}
